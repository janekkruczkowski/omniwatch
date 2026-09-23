/**
 * On-demand worker (T3, D5).
 *
 * One worker owns one data directory at a time. It drains the queue, keeps a
 * heartbeat, hands finished results to the knowledge adapter and exits when there
 * is nothing left. It never starts a second paid call for an operation whose
 * outcome is unknown (D3) and it never writes a result without ownership.
 *
 * Flow (see TECHNICAL "D5: wykonanie i cykl życia"):
 *   acquire owner -> recover unfinished work -> claim/start -> analyze (paid)
 *   -> durable buffer -> memory write -> confirm delivery -> delivered -> exit
 */

import { randomUUID } from "node:crypto";

import { analyze } from "../analysis/engine.ts";
import { buildContextFromStore, conversationIdForSource, estimateTokens } from "../analysis/context.ts";
import { DEFAULT_CONVERSATION_BUDGET_TOKENS } from "../analysis/engine.ts";
import { OmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import { computeAnalysisKey } from "../contracts/keys.ts";
import type { MemoryRef, OperationState, ProgressEvent } from "../contracts/types.ts";
import type { RuntimeDeps } from "../contracts/ports.ts";
import { deliverOperation } from "../storage/delivery.ts";
import {
  OperationJournal,
  OWNER_STALE_AFTER_MS,
  assertPaidWorkAllowed,
  classifyOperationRecovery,
  listRecoveryItems,
} from "../storage/operations.ts";

export const DEFAULT_HEARTBEAT_MS = 5_000;
export { OWNER_STALE_AFTER_MS };

export interface WorkerOperationSummary {
  operationId: string;
  analysisKey: string;
  state: OperationState;
  analysisId?: string;
  memoryRef?: MemoryRef | null;
  errorClass?: string | null;
  message?: string | null;
  reused?: boolean;
  /** Number of paid model calls actually started for this operation. */
  modelCalls: number;
}

export interface WorkerRunOptions {
  deps: RuntimeDeps;
  /** Explicit work list; when omitted the worker drains the durable queue. */
  operationIds?: string[] | null;
  /** Stop after this many operations (a run limit, not a queue limit). */
  maxOperations?: number | null;
  /** Reuse an already-acquired owner token (the spawning parent owns it). */
  ownerToken?: string | null;
  heartbeatMs?: number;
  ownerStaleAfterMs?: number;
  onProgress?: (event: ProgressEvent) => void;
  onOperation?: (summary: WorkerOperationSummary) => void;
  /** Cooperative cancellation (pause/cancel from the shell). */
  shouldStop?: () => boolean;
}

export interface WorkerRunResult {
  ownerToken: string;
  stopped: "drained" | "limit" | "cancelled" | "lost_ownership";
  processed: number;
  delivered: number;
  failed: number;
  unknown: number;
  operations: WorkerOperationSummary[];
}

function countStartedAttempts(deps: RuntimeDeps, operationId: string): number {
  return deps.store
    .listAttempts(operationId)
    .filter((attempt) => attempt.phase === "started" || attempt.phase === "response").length;
}

/**
 * Recover what a previous process left behind, before any new paid work:
 * - a finished result in the buffer is delivered (no model call);
 * - work that provably never reached the provider returns to `pending`;
 * - an unconfirmed call is marked `outcome_unknown` and waits for a user decision.
 */
export async function recoverPendingWork(
  deps: RuntimeDeps,
  journal: OperationJournal,
): Promise<WorkerOperationSummary[]> {
  const summaries: WorkerOperationSummary[] = [];
  for (const item of listRecoveryItems(deps.store, { limit: 200 })) {
    const { operation, classification, action } = item;
    // An explicit user pause or cancel is a decision, not an interrupted process.
    // Recovery must never resurrect it and spend money the user stopped.
    if (operation.state === "budget_paused" || operation.state === "failed") continue;
    try {
      if (classification === "delivery_only" || classification === "response_committed") {
        if (classification === "response_committed") {
          // The provider answer is durable but the buffer was not built. We do not
          // re-call the model; we surface the state so the user can decide.
          journal.markOutcomeUnknown(
            operation.id,
            "Odpowiedz modelu jest zapisana, ale wynik nie zostal zbudowany; wymagane jest jawne wznowienie bez ponownego platnego wywolania.",
          );
          summaries.push({
            operationId: operation.id,
            analysisKey: operation.analysisKey,
            state: "outcome_unknown",
            errorClass: "outcome_unknown",
            message: "zapisana odpowiedz bez zbudowanego wyniku",
            modelCalls: countStartedAttempts(deps, operation.id),
          });
          continue;
        }
        const delivery = await deliverOperation({ store: deps.store, memory: deps.memory }, operation.id);
        deps.store.setOperationState(operation.id, "delivered");
        summaries.push({
          operationId: operation.id,
          analysisKey: operation.analysisKey,
          state: "delivered",
          analysisId: delivery.delivery.analysisId,
          memoryRef: delivery.memoryRef,
          reused: delivery.reused,
          modelCalls: countStartedAttempts(deps, operation.id),
        });
        continue;
      }
      if (classification === "unpaid_retryable") {
        deps.store.setOperationState(operation.id, "pending", { errorClass: null, errorMessage: null });
        continue;
      }
      // unconfirmed_call -> outcome_unknown, never an automatic repeat
      journal.markOutcomeUnknown(
        operation.id,
        "Proces zakonczyl sie podczas wywolania modelu; wynik jest nieznany i wymaga jawnej decyzji uzytkownika.",
      );
      summaries.push({
        operationId: operation.id,
        analysisKey: operation.analysisKey,
        state: "outcome_unknown",
        errorClass: "outcome_unknown",
        message: action === "ask_user" ? "wynik wywolania nieznany" : null,
        modelCalls: countStartedAttempts(deps, operation.id),
      });
    } catch (error) {
      const failure = toOmniWatchError(error, "storage_unavailable");
      summaries.push({
        operationId: operation.id,
        analysisKey: operation.analysisKey,
        state: operation.state,
        errorClass: failure.errorClass,
        message: failure.message,
        modelCalls: countStartedAttempts(deps, operation.id),
      });
    }
  }
  return summaries;
}

/** Run one already-claimed operation to completion (or to a terminal error). */
export async function runOperation(
  deps: RuntimeDeps,
  journal: OperationJournal,
  operationId: string,
  options: { onProgress?: (event: ProgressEvent) => void; legacyCheckpointAttemptId?: string | null } = {},
): Promise<WorkerOperationSummary> {
  const started = journal.start(operationId);
  const request = started.request;
  const turns = {
    listTurns: (conversationId: string, limit?: number) => deps.store.listTurns(conversationId, limit),
    getTurn: (turnId: string) => deps.store.getTurn(turnId),
  };

  // The key must match the one the operation was claimed with, so compute the same
  // conversation context the engine will compute.
  const conversationId = request.conversationId ?? conversationIdForSource(request.sourceRef);
  const context = buildContextFromStore(turns, {
    sourceRef: request.sourceRef,
    conversationId,
    question: request.question ?? null,
    parentTurnId: request.parentTurnId ?? null,
    budget: { inputBudgetTokens: DEFAULT_CONVERSATION_BUDGET_TOKENS, estimateTokens },
  });
  const analysisKey = computeAnalysisKey(request, context.contextKey);
  if (analysisKey !== started.analysisKey) {
    const failure = new OmniWatchError(
      "invalid_input",
      `Klucz analizy zmienil sie po przyjeciu pracy (${started.analysisKey.slice(0, 12)} -> ${analysisKey.slice(0, 12)}); operacja wymaga nowego zlecenia zamiast cichej zmiany zakresu.`,
      { operationId, action: { label: "zlecenie ponownie", kind: "check_operation" } },
    );
    journal.markFailed(operationId, "invalid_input", failure.message);
    return {
      operationId,
      analysisKey,
      state: "failed",
      errorClass: "invalid_input",
      message: failure.message,
      modelCalls: countStartedAttempts(deps, operationId),
    };
  }

  deps.store.ensureConversation(conversationId, request.sourceRef);
  assertPaidWorkAllowed(deps.store);

  let outcome;
  try {
    outcome = await analyze(request, {
      clock: deps.clock,
      logger: deps.logger,
      config: deps.config,
      source: deps.source,
      model: deps.model,
      attempts: journal.sinkFor(operationId, deps.model.modelName),
      completedAttempts: deps.store.listAttempts(operationId),
      legacyCheckpointAttemptId: options.legacyCheckpointAttemptId,
      turns,
      progress: options.onProgress,
      operationId,
    });
  } catch (error) {
    const failure = toOmniWatchError(error, "provider_rejected");
    if (failure.errorClass === "outcome_unknown") {
      journal.markOutcomeUnknown(operationId, failure.message);
      return {
        operationId,
        analysisKey,
        state: "outcome_unknown",
        errorClass: "outcome_unknown",
        message: failure.message,
        modelCalls: countStartedAttempts(deps, operationId),
      };
    }
    if (failure.errorClass === "budget_paused") {
      journal.markBudgetPaused(operationId, failure.message);
      return {
        operationId,
        analysisKey,
        state: "budget_paused",
        errorClass: "budget_paused",
        message: failure.message,
        modelCalls: countStartedAttempts(deps, operationId),
      };
    }
    journal.markFailed(operationId, failure.errorClass, failure.message);
    return {
      operationId,
      analysisKey,
      state: "failed",
      errorClass: failure.errorClass,
      message: failure.message,
      modelCalls: countStartedAttempts(deps, operationId),
    };
  }

  if (outcome.errorClass === "outcome_unknown") {
    journal.markOutcomeUnknown(operationId, "Model nie potwierdzil zakonczenia odpowiedzi; wynik jest nieznany.");
    return {
      operationId,
      analysisKey,
      state: "outcome_unknown",
      errorClass: "outcome_unknown",
      message: "wynik wywolania nieznany",
      modelCalls: countStartedAttempts(deps, operationId),
    };
  }

  journal.completeWithResult(operationId, outcome);
  const delivery = await deliverOperation({ store: deps.store, memory: deps.memory }, operationId);
  deps.store.setOperationState(operationId, "delivered");

  // Persist the conversation so a later follow-up can reference this answer. The
  // knowledge library holds the content; these rows only replay the active thread.
  const userText =
    request.question?.trim() ||
    request.focus?.trim() ||
    (request.mode === "teardown" ? "teardown" : "streszczenie");
  const userTurnId = `turn_user_${outcome.turnId}`;
  try {
    deps.store.appendTurn({
      turnId: userTurnId,
      conversationId,
      parentTurnId: request.parentTurnId ?? null,
      role: "user",
      mode: request.mode,
      text: userText,
      createdAt: outcome.createdAt,
    });
    deps.store.appendTurn({
      turnId: outcome.turnId,
      conversationId,
      parentTurnId: userTurnId,
      role: "assistant",
      mode: request.mode,
      text: outcome.content,
      createdAt: deps.clock.now().toISOString(),
    });
  } catch (error) {
    // The answer is already delivered; failing to replay the thread must not look
    // like a failed analysis, but it is reported instead of being swallowed.
    deps.logger.warn("omniwatch.worker.conversation_persist_failed", {
      operationId,
      message: String(error),
    });
  }

  return {
    operationId,
    analysisKey,
    state: "delivered",
    analysisId: outcome.analysisId,
    memoryRef: delivery.memoryRef,
    reused: delivery.reused,
    modelCalls: countStartedAttempts(deps, operationId),
  };
}

/**
 * Run the worker until the queue is drained, the run limit is hit, or the shell
 * asks it to stop. Ownership is released in every exit path.
 */
export async function runWorker(options: WorkerRunOptions): Promise<WorkerRunResult> {
  const { deps } = options;
  const token = options.ownerToken ?? `worker_${process.pid}_${randomUUID()}`;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = () => deps.clock.now().toISOString();

  const acquired = deps.store.acquireOwner(token, process.pid, now());
  if (!acquired) {
    throw new OmniWatchError(
      "runtime_unavailable",
      "Inny proces jest wlascicielem tego katalogu danych OmniWatch; nie uruchamiam drugiego konsumenta.",
      { action: { label: "poczekaj na zakonczenie procesu roboczego", kind: "check_operation" } },
    );
  }

  const journal = new OperationJournal({ store: deps.store, ownerToken: token, now });
  let heartbeatHandle: unknown = null;
  const beat = (): void => {
    try {
      if (!deps.store.heartbeat(token, now())) {
        deps.logger.warn("omniwatch.worker.ownership_lost", { token });
      }
    } catch (error) {
      deps.logger.warn("omniwatch.worker.heartbeat_failed", { message: String(error) });
    }
    heartbeatHandle = deps.clock.setTimeout(beat, heartbeatMs);
  };
  heartbeatHandle = deps.clock.setTimeout(beat, heartbeatMs);

  const operations: WorkerOperationSummary[] = [];
  let stopped: WorkerRunResult["stopped"] = "drained";

  try {
    operations.push(...(await recoverPendingWork(deps, journal)));

    const limit = options.maxOperations ?? null;
    let processed = 0;

    for (;;) {
      if (options.shouldStop?.()) {
        stopped = "cancelled";
        break;
      }
      if (limit !== null && processed >= limit) {
        stopped = "limit";
        break;
      }
      const next = options.operationIds
        ? options.operationIds
            .map((id) => deps.store.getOperation(id))
            .find((operation) => operation !== null && (operation.state === "pending" || operation.state === "failed"))
        : deps.store.listOperations({ state: "pending", limit: 1 })[0];
      if (!next) break;

      const summary = await runOperation(deps, journal, next.id, { onProgress: options.onProgress });
      operations.push(summary);
      options.onOperation?.(summary);
      processed += 1;
      if (!journal.hasOwnership()) {
        stopped = "lost_ownership";
        break;
      }
    }
  } finally {
    if (heartbeatHandle !== null) deps.clock.clearTimeout(heartbeatHandle);
    try {
      deps.store.releaseOwner(token);
    } catch (error) {
      deps.logger.warn("omniwatch.worker.release_failed", { message: String(error) });
    }
  }

  const own = operations.filter((summary) => summary.analysisKey !== "");
  return {
    ownerToken: token,
    stopped,
    processed: own.length,
    delivered: own.filter((summary) => summary.state === "delivered").length,
    failed: own.filter((summary) => summary.state === "failed").length,
    unknown: own.filter((summary) => summary.state === "outcome_unknown").length,
    operations,
  };
}

export { classifyOperationRecovery };
