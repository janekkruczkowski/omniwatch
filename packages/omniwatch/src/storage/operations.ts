/**
 * D3 operation flow: claim -> pending -> running -> result_ready -> delivered,
 * with the failed / outcome_unknown / budget_paused branches.
 *
 *   claim (deduplikacja) -> pending
 *          |
 *   trwaly zapis zamiaru wywolania (intent)     <-- before any paid call
 *          |
 *   wywolanie modelu -> response (COMMIT)       <-- ambiguous failure = unknown
 *          |
 *   bufor wyniku + dostarczenie oczekujace -> result_ready
 *          |
 *   potwierdzony zapis w bibliotece wiedzy -> delivered
 *
 * The journal is the only writer the runtime should use for operation state:
 * every mutation first proves the process still owns the data directory
 * (D5 owner token). A stale token cannot write a result.
 *
 * Gate rule (D3/TEST-PLAN T07): while a finished result sits in the durable
 * buffer and delivery is not confirmed, no new paid work may start. The gate
 * never falls back to in-memory state: if the store raises, the paid work stops.
 */

import { randomUUID } from "node:crypto";

import { OmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import type {
  AttemptSink,
  BufferPayload,
  ClaimOperationInput,
  ClaimOperationResult,
  ModelCallRequest,
  ModelCallResponse,
  ModelPort,
  StorePort,
} from "../contracts/ports.ts";
import type {
  AnalysisResult,
  AttemptPhase,
  AttemptRecord,
  DeliveryRecord,
  ErrorClass,
  MediaPart,
  Operation,
  Usage,
} from "../contracts/types.ts";

/** D5: heartbeat every 5 s, UI shows a problem after 30 s without a signal. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const OWNER_STALE_AFTER_MS = 30_000;

/** Shown before an explicit retry of a call whose outcome is unknown. */
export const UNKNOWN_RETRY_WARNING =
  "Wywołanie modelu ma nieznany wynik; ponowienie moze oznaczac drugi koszt u dostawcy.";

const REQUEST_SUMMARY_LIMIT = 4_000;

/** Error classes that prove the paid call was not executed (safe to repeat). */
const SAFE_TO_RETRY: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  "missing_config",
  "invalid_input",
  "provider_rejected",
  // The provider's inspection refused the material before the model ran (R6), so the
  // call was not billed; a confirmed retry pays for its own attempt only.
  "content_filtered",
]);

export function isSafeProviderFailure(errorClass: ErrorClass): boolean {
  return SAFE_TO_RETRY.has(errorClass);
}

export interface PaidCallHooks {
  /** After the durable intent row is committed, before the request is issued. */
  afterIntent?(attemptId: string): void;
  /** After the provider answered, before that answer is committed durably. */
  beforeResponseCommit?(response: ModelCallResponse): void;
  /** After the response row is committed. */
  afterResponse?(response: ModelCallResponse): void;
}

export interface OperationJournalOptions {
  store: StorePort;
  /**
   * Owner token from `store.acquireOwner`. When set, every mutation verifies
   * the token; a process that lost ownership can no longer write state.
   */
  ownerToken?: string | null;
  now?: () => string;
}

export class OperationJournal {
  private readonly store: StorePort;
  private readonly ownerToken: string | null;
  private readonly nowFn: () => string;

  constructor(options: OperationJournalOptions) {
    this.store = options.store;
    this.ownerToken = options.ownerToken ?? null;
    this.nowFn = options.now ?? (() => new Date().toISOString());
  }

  get ownedStore(): StorePort {
    return this.store;
  }

  now(): string {
    return this.nowFn();
  }

  /** False when another process took ownership of this data directory. */
  hasOwnership(): boolean {
    if (!this.ownerToken) return true;
    return this.store.heartbeat(this.ownerToken, this.nowFn());
  }

  assertOwnership(operationId?: string): void {
    if (!this.ownerToken) return;
    if (!this.store.heartbeat(this.ownerToken, this.nowFn())) {
      throw new OmniWatchError(
        "runtime_unavailable",
        "Ten proces nie jest juz wlascicielem katalogu danych OmniWatch; inny proces przejal prace, wiec wynik nie zostal zapisany",
        {
          operationId,
          action: { label: "uruchom proces roboczy ponownie", kind: "check_operation" },
        },
      );
    }
  }

  requireOperation(operationId: string): Operation {
    const operation = this.store.getOperation(operationId);
    if (!operation) {
      throw new OmniWatchError("invalid_input", `operacja ${operationId} nie istnieje`, { operationId });
    }
    return operation;
  }

  /* ------------------------------------------------------------ claim/start -- */

  claim(input: ClaimOperationInput): ClaimOperationResult {
    this.assertOwnership();
    return this.store.claimOperation(input);
  }

  /** pending|failed|budget_paused -> running. `outcome_unknown` needs a decision. */
  start(operationId: string): Operation {
    this.assertOwnership(operationId);
    const operation = this.requireOperation(operationId);
    if (operation.state === "outcome_unknown") {
      throw new OmniWatchError(
        "outcome_unknown",
        `operacja ${operationId} ma nieznany wynik wywolania modelu; najpierw wymagana jest jawna decyzja uzytkownika. ${UNKNOWN_RETRY_WARNING}`,
        { operationId, action: { label: "sprawdz operacje i zdecyduj", kind: "check_operation" } },
      );
    }
    if (operation.state === "delivered" || operation.state === "result_ready") {
      throw new OmniWatchError(
        "invalid_input",
        `operacja ${operationId} jest w stanie "${operation.state}"; nie uruchamiamy ponownie pracy, ktora ma juz wynik`,
        { operationId, action: { label: "odczytaj gotowy wynik", kind: "check_operation" } },
      );
    }
    assertPaidWorkAllowed(this.store);
    this.store.setOperationState(operationId, "running");
    return this.requireOperation(operationId);
  }

  /**
   * Explicit user decision for a call whose outcome is unknown. `retry` moves
   * the operation back to `pending` (the caller warned about the second cost);
   * `abandon` closes it as failed. Nothing here repeats a call automatically.
   */
  resolveUnknownOutcome(operationId: string, decision: "retry" | "abandon", note?: string): Operation {
    this.assertOwnership(operationId);
    const operation = this.requireOperation(operationId);
    if (operation.state !== "outcome_unknown") {
      throw new OmniWatchError(
        "invalid_input",
        `operacja ${operationId} nie jest w stanie outcome_unknown (jest "${operation.state}")`,
        { operationId },
      );
    }
    if (decision === "retry") {
      this.store.setOperationState(operationId, "pending", {
        errorClass: null,
        errorMessage: note ?? UNKNOWN_RETRY_WARNING,
      });
    } else {
      this.store.setOperationState(operationId, "failed", {
        errorClass: "outcome_unknown",
        errorMessage: note ?? "uzytkownik zamknal operacje o nieznanym wyniku bez ponowienia",
      });
    }
    return this.requireOperation(operationId);
  }

  /**
   * The user's "try again" on a definitively FAILED operation. A failure is only ever
   * recorded for a call that was provably not billed or never started (a 4xx, a
   * content-filter refusal, missing config), so no cost warning is needed: the
   * operation goes back to `pending` and the next run reuses every committed part and
   * pays only for the missing ones. Anything not `failed` is left alone.
   */
  requeueFailed(operationId: string): Operation {
    this.assertOwnership(operationId);
    const operation = this.requireOperation(operationId);
    if (operation.state !== "failed") {
      throw new OmniWatchError(
        "invalid_input",
        `operacja ${operationId} nie jest w stanie failed (jest "${operation.state}")`,
        { operationId },
      );
    }
    this.store.setOperationState(operationId, "pending", { errorClass: null, errorMessage: null });
    return this.requireOperation(operationId);
  }

  /* ------------------------------------------------------------- attempts --- */

  newAttemptId(): string {
    return `att_${randomUUID()}`;
  }

  buildModelRequest(input: {
    operationId: string;
    partIndex: number;
    messages: ModelCallRequest["messages"];
    mediaParts: MediaPart[];
    language: string;
    maxOutputTokens?: number;
  }): ModelCallRequest {
    return {
      operationId: input.operationId,
      attemptId: this.newAttemptId(),
      partIndex: input.partIndex,
      messages: input.messages,
      mediaParts: input.mediaParts,
      language: input.language,
      maxOutputTokens: input.maxOutputTokens,
    };
  }

  /** Durable intent. Must be committed before the provider request goes out. */
  recordIntent(input: {
    operationId: string;
    attemptId: string;
    partIndex: number;
    model?: string | null;
    requestSummary?: string | null;
  }): string {
    this.assertOwnership(input.operationId);
    this.store.recordAttempt({
      id: input.attemptId,
      operationId: input.operationId,
      phase: "intent",
      partIndex: input.partIndex,
      model: input.model ?? null,
      requestSummary: input.requestSummary ?? null,
      responseSummary: null,
      usage: null,
    });
    return input.attemptId;
  }

  /** AttemptSink handed to the provider port. */
  sinkFor(operationId: string, model?: string | null): AttemptSink {
    return {
      intent: async (record) => {
        this.assertOwnership(operationId);
        this.store.recordAttempt({
          id: record.id,
          operationId,
          phase: "intent",
          partIndex: record.partIndex,
          model: record.model ?? model ?? null,
          requestSummary: record.requestSummary ?? null,
          responseSummary: record.responseSummary ?? null,
          usage: record.usage ?? null,
        });
      },
      started: async (attemptId, meta) => {
        this.assertOwnership(operationId);
        const requestSummary =
          meta && typeof meta.requestSummary === "string" ? meta.requestSummary : null;
        this.writeAttempt(operationId, attemptId, "started", {
          model,
          requestSummary,
        });
      },
      response: async (attemptId, response) => {
        this.assertOwnership(operationId);
        this.writeAttempt(operationId, attemptId, "response", {
          // A response answered by another model (R6: the Gemini fallback after a Qwen
          // content-filter refusal) records the model that actually answered.
          model: response.model ?? model,
          responseSummary: response.text,
          usage: response.usage,
        });
      },
      unknown: async (attemptId, errorClass, message, options) => {
        this.assertOwnership(operationId);
        this.writeAttempt(operationId, attemptId, "unknown", { model, responseSummary: message });
        // A call the engine resends at once (LF2) does not decide the operation; the
        // run's final outcome does. The journal row above is the durable evidence.
        if (options?.deferOperationState) return;
        this.markOutcomeUnknown(operationId, `${errorClass}: ${message}`);
      },
      failed: async (attemptId, errorClass, message, options) => {
        this.assertOwnership(operationId);
        this.writeAttempt(operationId, attemptId, "failed", { model, responseSummary: message });
        if (options?.deferOperationState) return;
        this.markFailed(operationId, errorClass, message);
      },
    };
  }

  private writeAttempt(
    operationId: string,
    attemptId: string,
    phase: AttemptPhase,
    extra: {
      model?: string | null;
      requestSummary?: string | null;
      responseSummary?: string | null;
      usage?: Usage | null;
    },
  ): void {
    const existing = this.store.listAttempts(operationId).find((attempt) => attempt.id === attemptId);
    this.store.recordAttempt({
      id: attemptId,
      operationId,
      phase,
      partIndex: existing?.partIndex ?? 0,
      model: extra.model ?? existing?.model ?? null,
      requestSummary: extra.requestSummary ?? existing?.requestSummary ?? null,
      responseSummary: extra.responseSummary ?? existing?.responseSummary ?? null,
      usage: extra.usage ?? existing?.usage ?? null,
    });
  }

  /**
   * One paid model call with the D3 journal around it: intent committed first,
   * response committed after the provider answered, unknown outcome recorded
   * when the call cannot be confirmed. Nothing is retried automatically.
   */
  async runPaidCall(
    model: ModelPort,
    request: ModelCallRequest,
    hooks: PaidCallHooks = {},
  ): Promise<ModelCallResponse> {
    const operationId = request.operationId;
    this.assertOwnership(operationId);
    const operation = this.requireOperation(operationId);
    if (operation.state !== "running" && operation.state !== "pending") {
      throw new OmniWatchError(
        "invalid_input",
        `operacja ${operationId} jest w stanie "${operation.state}"; platne wywolanie jest dozwolone tylko dla pending/running`,
        { operationId },
      );
    }
    assertPaidWorkAllowed(this.store);

    const attemptId = request.attemptId;
    this.recordIntent({
      operationId,
      attemptId,
      partIndex: request.partIndex,
      model: model.modelName,
      requestSummary: summarizeMessages(request.messages),
    });
    hooks.afterIntent?.(attemptId);
    // Mark the call as started before the request can leave the process. The
    // provider may publish this again through its sink; the journal never
    // downgrades a phase. This is what makes a crash after the HTTP request
    // "outcome unknown" instead of "safe to repeat".
    this.writeAttempt(operationId, attemptId, "started", { model: model.modelName });

    let response: ModelCallResponse;
    try {
      response = await model.call(request, this.sinkFor(operationId, model.modelName));
    } catch (error) {
      const failure = toOmniWatchError(error, "outcome_unknown");
      const journalled = this.store
        .listAttempts(operationId)
        .find((attempt) => attempt.id === attemptId);
      if (journalled && (journalled.phase === "unknown" || journalled.phase === "failed")) {
        throw failure;
      }
      if (isSafeProviderFailure(failure.errorClass)) {
        this.writeAttempt(operationId, attemptId, "failed", {
          model: model.modelName,
          responseSummary: failure.message,
        });
        this.markFailed(operationId, failure.errorClass, failure.message);
      } else {
        this.writeAttempt(operationId, attemptId, "unknown", {
          model: model.modelName,
          responseSummary: failure.message,
        });
        this.markOutcomeUnknown(operationId, failure.message);
      }
      throw failure;
    }

    try {
      hooks.beforeResponseCommit?.(response);
      this.writeAttempt(operationId, attemptId, "response", {
        // The model that actually answered: the fallback provider may differ from the
        // configured one (R6).
        model: response.model ?? model.modelName,
        responseSummary: response.text,
        usage: response.usage,
      });
    } catch (error) {
      const failure = toOmniWatchError(error, "storage_unavailable");
      this.writeAttempt(operationId, attemptId, "unknown", {
        model: model.modelName,
        responseSummary: `odpowiedz nie zostala utrwalona: ${failure.message}`,
      });
      this.markOutcomeUnknown(operationId, `odpowiedz nie zostala utrwalona: ${failure.message}`);
      throw failure;
    }
    hooks.afterResponse?.(response);

    if (response.completed !== true) {
      // Partial text is kept and marked incomplete; without a validated end
      // marker the call is not confirmed, so no automatic repeat happens.
      this.writeAttempt(operationId, attemptId, "unknown", {
        model: model.modelName,
        responseSummary: markIncomplete(response.text),
        usage: response.usage,
      });
      this.markOutcomeUnknown(
        operationId,
        "model zakonczyl odpowiedz bez potwierdzonego znacznika konca (urwany stream)",
      );
      throw new OmniWatchError(
        "outcome_unknown",
        "Odpowiedz modelu jest niekompletna (brak potwierdzonego znacznika konca); czesciowy tekst zostal zachowany, ale wynik wymaga sprawdzenia.",
        { operationId, action: { label: "sprawdz operacje", kind: "check_operation" } },
      );
    }
    return response;
  }

  /* --------------------------------------------------------------- states --- */

  markFailed(operationId: string, errorClass: ErrorClass, message: string): void {
    this.assertOwnership(operationId);
    const operation = this.requireOperation(operationId);
    // outcome_unknown and delivered are stronger facts than a late failure
    // callback; never downgrade them.
    if (operation.state === "outcome_unknown" || operation.state === "delivered") {
      return;
    }
    this.store.setOperationState(operationId, "failed", { errorClass, errorMessage: message });
  }

  markOutcomeUnknown(operationId: string, message: string, options: { replaceMessage?: boolean } = {}): void {
    this.assertOwnership(operationId);
    const operation = this.requireOperation(operationId);
    if (operation.state === "outcome_unknown" && options.replaceMessage) {
      // The run's summary (which parts are uncertain) replaces the first part's raw
      // transport detail, so a later visit explains what a retry would pay for.
      this.store.setOperationState(operationId, "outcome_unknown", {
        errorClass: "outcome_unknown",
        errorMessage: message,
      });
      return;
    }
    if (operation.state === "outcome_unknown" || operation.state === "delivered") {
      return;
    }
    if (operation.state === "result_ready") {
      // The finished result is already durable; a late unconfirmed callback
      // must not discard it.
      return;
    }
    this.store.setOperationState(operationId, "outcome_unknown", {
      errorClass: "outcome_unknown",
      errorMessage: message,
    });
  }

  markBudgetPaused(operationId: string, message: string): void {
    this.assertOwnership(operationId);
    this.store.setOperationState(operationId, "budget_paused", {
      errorClass: "budget_paused",
      errorMessage: message,
    });
  }

  /**
   * Durably store the finished result and mark it ready for delivery.
   * The buffer row *is* the pending delivery, so a crash right after this call
   * leaves recoverable work without re-running the model.
   */
  completeWithResult(
    operationId: string,
    result: AnalysisResult,
  ): { delivery: DeliveryRecord; buffer: BufferPayload } {
    this.assertOwnership(operationId);
    const operation = this.requireOperation(operationId);
    if (result.analysisKey !== operation.analysisKey) {
      throw new OmniWatchError(
        "invalid_input",
        `wynik ma inny analysisKey niz operacja ${operationId}; zapis odrzucony`,
        { operationId },
      );
    }
    const buffer: BufferPayload = { result, writtenAt: this.nowFn() };
    this.store.saveBuffer(operationId, buffer);
    this.store.setOperationState(operationId, "result_ready");
    const delivery = this.store.getDeliveryForOperation(operationId);
    if (!delivery) {
      throw new OmniWatchError(
        "storage_unavailable",
        `bufor operacji ${operationId} nie ma rekordu dostarczenia; wynik nie zostal uznany za gotowy`,
        { operationId, action: { label: "sprawdz magazyn stanu", kind: "check_operation" } },
      );
    }
    return { delivery, buffer };
  }
}

function summarizeMessages(messages: ModelCallRequest["messages"]): string {
  const text = messages.map((message) => `${message.role}: ${message.text}`).join("\n");
  return text.length > REQUEST_SUMMARY_LIMIT ? `${text.slice(0, REQUEST_SUMMARY_LIMIT)}...` : text;
}

function markIncomplete(text: string): string {
  return `${text}\n[niekompletna odpowiedz modelu: brak potwierdzonego znacznika konca]`;
}

/* ------------------------------------------------------------------ gates --- */

export interface PaidWorkGate {
  allowed: boolean;
  operationId?: string;
  deliveryState?: DeliveryRecord["state"];
  errorClass?: ErrorClass;
  message?: string;
}

/**
 * A ready result that has not been confirmed in the knowledge library blocks
 * every new paid call (D3 failure table: Vault error, full disk, busy DB).
 * Read-only and honest: it asks the store, never a RAM cache.
 */
export function checkPaidWorkGate(store: StorePort): PaidWorkGate {
  const ready = store.listOperations({ state: "result_ready", limit: 1 });
  if (ready.length === 0) return { allowed: true };
  const operation = ready[0];
  const delivery = store.getDeliveryForOperation(operation.id);
  const conflicted = delivery?.state === "conflict";
  return {
    allowed: false,
    operationId: operation.id,
    deliveryState: delivery?.state,
    errorClass: conflicted ? "delivery_conflict" : "storage_unavailable",
    message: conflicted
      ? `Notatka operacji ${operation.id} zostala zmieniona poza OmniWatchem; wymagane jest rozstrzygniecie konfliktu zamiast nadpisania pliku.`
      : `Wynik operacji ${operation.id} czeka w trwalym buforze i nie zostal potwierdzony w bibliotece wiedzy; nowa platna praca jest wstrzymana do czasu ponowienia samego dostarczenia.`,
  };
}

export function assertPaidWorkAllowed(store: StorePort): void {
  const gate = checkPaidWorkGate(store);
  if (gate.allowed) return;
  throw new OmniWatchError(gate.errorClass ?? "storage_unavailable", gate.message ?? "platna praca jest wstrzymana", {
    operationId: gate.operationId,
    action: { label: "ponow dostarczenie wyniku", kind: "retry_delivery" },
  });
}

/* -------------------------------------------------------------- recovery ---- */

export type RecoveryClass =
  | "delivery_only"
  | "response_committed"
  | "unpaid_retryable"
  | "unconfirmed_call";

export type RecoveryAction = "deliver" | "rebuild_result" | "retry_paid_call" | "ask_user";

export interface RecoveryItem {
  operation: Operation;
  classification: RecoveryClass;
  action: RecoveryAction;
  requiresUserDecision: boolean;
  lastAttempt: AttemptRecord | null;
  delivery: DeliveryRecord | null;
}

/**
 * What may happen after a restart for one operation:
 * - `delivery_only`: a finished result is in the buffer; deliver it, no model.
 * - `response_committed`: the provider answer is durable; rebuild the result.
 * - `unpaid_retryable`: only the intent row exists, the call never went out.
 * - `unconfirmed_call`: the call may have been executed; explicit decision only.
 */
export function classifyOperationRecovery(store: StorePort, operationId: string): RecoveryItem | null {
  const operation = store.getOperation(operationId);
  if (!operation || operation.state === "delivered") return null;
  const attempts = store.listAttempts(operationId);
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const delivery = store.getDeliveryForOperation(operationId);
  const buffer = store.getBuffer(operationId);

  if (buffer) {
    return {
      operation,
      classification: "delivery_only",
      action: "deliver",
      requiresUserDecision: false,
      lastAttempt,
      delivery,
    };
  }
  if (operation.state === "outcome_unknown") {
    return {
      operation,
      classification: "unconfirmed_call",
      action: "ask_user",
      requiresUserDecision: true,
      lastAttempt,
      delivery,
    };
  }
  if (operation.state === "pending" && lastAttempt?.phase === "unknown") {
    // The uncertain call was already recorded as `unknown` and the user explicitly
    // chose to retry it (`resolveUnknownOutcome(..., "retry")` is the only path that
    // puts such an operation back to pending). The new call has not started - if it
    // had, its own `started` attempt would be the last one - so this is admitted
    // work, not an interrupted call. Without this, any worker's recovery pass turned
    // the user's confirmed retry straight back into outcome_unknown (QA FAIL-A).
    return {
      operation,
      classification: "unpaid_retryable",
      action: "retry_paid_call",
      requiresUserDecision: false,
      lastAttempt,
      delivery,
    };
  }
  if (lastAttempt && (lastAttempt.phase === "started" || lastAttempt.phase === "unknown")) {
    return {
      operation,
      classification: "unconfirmed_call",
      action: "ask_user",
      requiresUserDecision: true,
      lastAttempt,
      delivery,
    };
  }
  if (lastAttempt && lastAttempt.phase === "response") {
    return {
      operation,
      classification: "response_committed",
      action: "rebuild_result",
      requiresUserDecision: false,
      lastAttempt,
      delivery,
    };
  }
  return {
    operation,
    classification: "unpaid_retryable",
    action: "retry_paid_call",
    requiresUserDecision: false,
    lastAttempt,
    delivery,
  };
}

/** Every unfinished operation, classified for the recovery pass after a restart. */
export function listRecoveryItems(store: StorePort, options: { limit?: number } = {}): RecoveryItem[] {
  const limit = options.limit ?? 200;
  const openStates: Array<Operation["state"]> = [
    "pending",
    "running",
    "result_ready",
    "outcome_unknown",
    "failed",
    "budget_paused",
  ];
  const items: RecoveryItem[] = [];
  for (const state of openStates) {
    for (const operation of store.listOperations({ state, limit })) {
      const item = classifyOperationRecovery(store, operation.id);
      if (item) items.push(item);
    }
  }
  return items;
}

/**
 * D5 preflight: every unfinished operation must be resumed by a runtime that
 * still honours its recorded analysis/prompt contract. Incompatible operations
 * block the upgrade instead of being silently re-analysed with new prompts.
 */
export function preflightSnapshotCompatibility(
  store: StorePort,
  options: { supportedAnalysisVersions: string[]; limit?: number },
): { compatible: boolean; operations: Operation[] } {
  const supported = new Set(options.supportedAnalysisVersions);
  const incompatible: Operation[] = [];
  for (const item of listRecoveryItems(store, { limit: options.limit })) {
    if (!supported.has(item.operation.request.analysisVersion)) {
      incompatible.push(item.operation);
    }
  }
  return { compatible: incompatible.length === 0, operations: incompatible };
}
