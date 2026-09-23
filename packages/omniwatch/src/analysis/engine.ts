/**
 * The single analysis engine (T1).
 *
 * Orchestration only: prepare media, split it, call the model for each part (several at
 * a time, see runBounded), merge, produce an AnalysisResult. Storage, delivery and process lifecycle belong to
 * the runtime; this module receives ports and emits events.
 *
 * Cost safety, which is most of what this file is about:
 *   - every paid call gets an `intent` record written BEFORE it is issued;
 *   - a call whose outcome is unknown (timeout, abort, 5xx after send, unterminated
 *     stream) is never retried automatically - the partial text is returned with
 *     `incomplete: true` and `errorClass: "outcome_unknown"`. The one bounded
 *     exception (LF2) is a provider close BEFORE any response header: resent at most
 *     `preHeaderRetries` times (default 2), each resend journaled as its own attempt,
 *     and the run's cost is then reported as unknown;
 *   - a call that never reached the provider (upload/DNS failure) or was rate limited
 *     (429) was not billed and is resent after a short backoff, at most twice;
 *   - any other definite rejection (4xx) is reported as a failure and not retried;
 *   - `costKnown` is false when the provider reported no usage, instead of a fake zero.
 */

import { randomUUID } from "node:crypto";
import { isOmniWatchError, OmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import { computeAnalysisId, computeAnalysisKey, sha256Hex } from "../contracts/keys.ts";
import type {
  AnalysisRequest,
  AnalysisResult,
  AttemptRecord,
  ClockPort,
  ErrorClass,
  Highlight,
  LoggerPort,
  MediaPart,
  ProgressEvent,
  SourceRef,
  Usage,
} from "../contracts/types.ts";
import type {
  AttemptSink,
  ConfigPort,
  ModelCallRequest,
  ModelCallResponse,
  ModelMessage,
  ModelPort,
  SourcePort,
} from "../contracts/ports.ts";
import { buildConversationContext, conversationScopeFor, estimateTokens } from "./context.ts";
import type { ConversationContext, ConversationTurnSource } from "./context.ts";
import { buildMergePrompt, buildPartNotesPrompt, buildWholePrompt, promptDate } from "./prompt.ts";
import { effectiveMaxFramesPerPart, fpsFor, parseTimestamp, shiftTimestamps } from "../sources/media.ts";

/** Default room for conversation history when the host does not declare one. */
export const DEFAULT_CONVERSATION_BUDGET_TOKENS = 12000;

/**
 * Parts of one film in flight at once (LF2). The earlier header gate (start the next
 * part only after every running one got headers) made a 17-part film effectively
 * serial: each ~60 s pre-header close held the whole film for a minute, and the
 * owner's 32-minute film had 4 parts after 460 s. Measured live on 2026-09-23
 * (qa-omniwatch-20260923/LF2-speed): 6, 10 and 17 parts sent at once all answered
 * (33 of 33, headers after 8-48 s; 17 parts of a 32:33 film done in 101 s), while
 * single calls sent alone still hit the provider's random >60 s queueing tail. The
 * close is not caused by our own concurrency, so parts simply run side by side.
 */
export const DEFAULT_PART_CONCURRENCY = 8;

/**
 * Provider closes before headers that are resent automatically, per call (LF2). The
 * close is random per request (the same 2-minute part answered in 13 s and in 44 s
 * minutes after two closes in a row), so a resend usually lands; two bound the cost.
 */
export const DEFAULT_PRE_HEADER_RETRIES = 2;

/** Resends of an unbilled failure (upload/DNS, 429) and the waits before them. */
export const UNBILLED_RETRY_DELAYS_MS = [2000, 5000];

/**
 * Run `work` for every item with at most `limit` in flight. Items are started in
 * order; `stop()` is checked before each start. `work` must not reject.
 */
export async function runBounded<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
  stop: () => boolean = () => false,
): Promise<void> {
  const max = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
  const running = new Set<Promise<void>>();
  let wake: (() => void) | null = null;
  for (const item of items) {
    while (running.size >= max) {
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (stop()) break;
    const task: Promise<void> = Promise.resolve()
      .then(() => work(item))
      .catch(() => undefined)
      .finally(() => {
        running.delete(task);
        const resume = wake;
        wake = null;
        resume?.();
      });
    running.add(task);
  }
  await Promise.all(running);
}

export interface AnalysisDeps {
  clock: ClockPort;
  logger: LoggerPort;
  config: ConfigPort;
  source: SourcePort;
  model: ModelPort;
  attempts: AttemptSink;
  /** Durable responses from an earlier run of this same operation. */
  completedAttempts?: AttemptRecord[];
  /** One explicitly approved pre-fingerprint response from this operation. */
  legacyCheckpointAttemptId?: string | null;
  /** Conversation turns for this source; omit when the caller has no history yet. */
  turns?: ConversationTurnSource;
  /** Receives every progress event, in order. */
  progress?: (event: ProgressEvent) => void;
  operationId?: string;
  conversationBudgetTokens?: number;
  estimateTokens?: (text: string) => number;
  maxHistoryTurns?: number;
}

/**
 * AnalysisResult plus the machine signal the runtime uses to set the operation state.
 * `errorClass === "outcome_unknown"` means a paid call may or may not have completed.
 */
export interface AnalysisOutcome extends AnalysisResult {
  errorClass: ErrorClass | null;
  /** Every event emitted during this run, in order (monotonic `version`). */
  events: ProgressEvent[];
  /** Part indexes whose paid call has an unknown outcome in this run (merge = parts). */
  unknownParts?: number[];
  /** Human-readable reason for an unknown outcome, naming the parts involved. */
  outcomeMessage?: string;
}

/** Optional provider hook so missing configuration fails before media work. */
interface PreflightableModel {
  preflight?: () => void | Promise<void>;
}

type CallOutcome =
  | { kind: "ok"; response: ModelCallResponse }
  | { kind: "unknown"; errorClass: ErrorClass; message: string; partialText: string; preHeader?: boolean };

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Pull the cited timestamps out of the answer, in first-appearance order. */
export function extractHighlights(content: string, limit = 40): Highlight[] {
  const out: Highlight[] = [];
  const seen = new Set<number>();
  const pattern = /\[((?:\d+:)?\d{1,2}:\d{2})\]/g;
  for (const match of content.matchAll(pattern)) {
    const seconds = parseTimestamp(match[1]);
    if (seconds === null || seen.has(seconds)) continue;
    seen.add(seconds);
    out.push({ seconds, label: match[1] });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Sum the confirmed responses. `unknownCalls` counts paid calls of this run whose
 * outcome is unknown: they may have been billed, so the total cannot be known (R2-05:
 * a run with an unknown part used to report `costKnown: true`).
 */
export function aggregateUsage(responses: ModelCallResponse[], unknownCalls = 0): Usage {
  const inputs = responses.map((r) => r.usage?.inputTokens).filter(isNumber);
  const outputs = responses.map((r) => r.usage?.outputTokens).filter(isNumber);
  const costs = responses.map((r) => r.usage?.costUsd).filter(isNumber);
  const costKnown =
    unknownCalls === 0 &&
    responses.length > 0 && responses.every((r) => r.usage?.costKnown === true && isNumber(r.usage?.costUsd));
  return {
    inputTokens: inputs.length ? inputs.reduce((a, b) => a + b, 0) : null,
    outputTokens: outputs.length ? outputs.reduce((a, b) => a + b, 0) : null,
    costUsd: costKnown && costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    costKnown,
  };
}

/** The prompt date a v2 attempt recorded in its request summary, if any. */
function recordedPromptDate(attempt: AttemptRecord): string | null {
  if (typeof attempt.requestSummary !== "string" || !attempt.requestSummary.startsWith("{")) return null;
  try {
    const value = (JSON.parse(attempt.requestSummary) as { promptDate?: unknown }).promptDate;
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The date written into every prompt. A confirmed retry of the same operation keeps the
 * date of its first recorded attempt: the prompt is part of the checkpoint fingerprint,
 * so a retry on the next day must not change it and re-pay for parts already answered.
 *
 * The date the prompt was actually built with is recorded on the attempt and wins over
 * the attempt's `createdAt`: a host may stamp its journal with a different clock than the
 * engine's injected one (the standalone server and CLI use wall time), and a call that
 * starts just before midnight is journalled just after it. `createdAt` is only the
 * fallback for attempts written before the date was recorded.
 */
export function promptDateFor(
  completedAttempts: AttemptRecord[] | undefined,
  operationId: string,
  now: string,
): string {
  const own = (completedAttempts ?? []).filter((attempt) => attempt.operationId === operationId);
  const recorded = own.map(recordedPromptDate).filter((value): value is string => value !== null).sort()[0];
  if (recorded) return recorded;
  const earliest = own
    .map((attempt) => attempt.createdAt)
    .filter((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value))
    .sort()[0];
  return promptDate(earliest ?? now);
}

/** Names the uncertain parts so the user can see what a confirmed retry will pay for. */
export function unknownPartsMessage(unknown: number[], total: number, done: number, lastDetail: string): string {
  const list = unknown.map((index) => index + 1).join(", ");
  const head = unknown.length === 1
    ? `Nie wiadomo, czy czesc ${list}/${total} zostala rozliczona`
    : `Nie wiadomo, czy czesci ${list} (z ${total}) zostaly rozliczone`;
  const reuse = done > 0
    ? ` Gotowe czesci (${done}/${total}) sa zapisane; potwierdzone ponowienie zaplaci tylko za ${unknown.length} ${unknown.length === 1 ? "nieudana czesc" : "nieudane czesci"} i scalenie.`
    : ` Potwierdzone ponowienie zaplaci za ${unknown.length} czesci i scalenie.`;
  return `${head}.${reuse}${lastDetail ? ` Ostatni blad: ${lastDetail}` : ""}`;
}

const INCOMPLETE_NOTE =
  "\n\n_[Analiza niekompletna: odpowiedz modelu nie zostala potwierdzona jako ukonczona. "
  + "Zachowano tekst czesciowy; ponowienie tego wywolania moze kosztowac drugi raz.]_";

export async function analyze(request: AnalysisRequest, deps: AnalysisDeps): Promise<AnalysisOutcome> {
  const sourceRef: SourceRef = request.sourceRef;
  const operationId = deps.operationId ?? `op_${computeAnalysisKey(request, null).slice(0, 16)}`;
  const events: ProgressEvent[] = [];
  let version = 0;
  const emit = (
    state: ProgressEvent["state"],
    stage: string,
    patch: Partial<Omit<ProgressEvent, "version" | "operationId" | "state" | "stage">> = {},
  ): void => {
    version += 1;
    const event: ProgressEvent = { version, operationId, state, stage, ...patch };
    events.push(event);
    try {
      deps.progress?.(event);
    } catch (error) {
      deps.logger.warn("omniwatch.progress listener failed", { message: String(error) });
    }
  };

  emit("running", "preflight", { message: "sprawdzam konfiguracje" });

  const configuredFrames = Number(deps.config.maxFramesPerPart());
  if (!isNumber(configuredFrames) || configuredFrames < 1) {
    throw new OmniWatchError("missing_config", "Brak poprawnego limitu klatek na czesc.", {
      operationId,
      action: { label: "ustaw OMNI_MAX_FRAMES", kind: "fix_config" },
    });
  }
  const concurrencySetting = Number(deps.config.partConcurrency?.() ?? DEFAULT_PART_CONCURRENCY);
  const partConcurrency = isNumber(concurrencySetting) && concurrencySetting >= 1
    ? Math.floor(concurrencySetting)
    : DEFAULT_PART_CONCURRENCY;
  const retrySetting = Number(deps.config.preHeaderRetries?.() ?? DEFAULT_PRE_HEADER_RETRIES);
  const preHeaderRetries = isNumber(retrySetting) && retrySetting >= 0
    ? Math.min(3, Math.floor(retrySetting))
    : DEFAULT_PRE_HEADER_RETRIES;

  // Fail on a missing key or endpoint before a download, an upload or a paid call.
  const preflight = (deps.model as ModelPort & PreflightableModel).preflight;
  if (typeof preflight === "function") {
    try {
      await preflight.call(deps.model);
    } catch (error) {
      throw toOmniWatchError(error, "missing_config");
    }
  }

  const { conversationId, declared } = conversationScopeFor({ ...request, sourceRef });
  const question = normalizeText(request.question);
  let context: ConversationContext;
  try {
    context = buildConversationContext({
      sourceRef,
      conversationId,
      question,
      parentTurnId: request.parentTurnId ?? null,
      declared,
      turns: deps.turns ? deps.turns.listTurns(conversationId, 200) : [],
      budget: {
        inputBudgetTokens: deps.conversationBudgetTokens ?? DEFAULT_CONVERSATION_BUDGET_TOKENS,
        estimateTokens: deps.estimateTokens ?? estimateTokens,
        maxHistoryTurns: deps.maxHistoryTurns,
      },
    });
  } catch (error) {
    throw toOmniWatchError(error, "invalid_input");
  }

  const normalizedFocus = normalizeText(request.focus);
  const analysisKey = computeAnalysisKey(request, context.contextKey);
  const analysisId = computeAnalysisId(analysisKey);
  const parentTurnId = request.parentTurnId ?? null;
  const turnId = `turn_${sha256Hex(analysisKey).slice(0, 16)}`;
  const createdAt = deps.clock.now().toISOString();
  const today = promptDateFor(deps.completedAttempts, operationId, createdAt);

  emit("running", "prepare", {
    message: `przygotowuje material (${sourceRef.platform})`,
  });
  const info = await deps.source.prepare(sourceRef, { force: request.force });

  // One bound for every shell: a host's larger setting must not produce parts the
  // provider closes before answering. The film's length selects the long-film bound.
  const maxFrames = effectiveMaxFramesPerPart(deps.model.modelName, configuredFrames, info.durationSeconds);

  emit("running", "split", {
    message: `dzielenie na czesci (limit ${maxFrames} klatek)`,
  });
  const filmFps = fpsFor(info.durationSeconds);
  // Hosts with their own splitter may not set the film's sampling rate; without it a
  // provider would guess from the part's end and sample early parts of a 3-6 minute
  // film at the short-form 10 fps.
  const parts = (await deps.source.split(info, { maxFramesPerPart: maxFrames }))
    .map((part) => (isNumber(part.fps) ? part : { ...part, fps: filmFps }));
  if (!parts.length) {
    throw new OmniWatchError("source_unavailable", "Nie udalo sie przygotowac zadnej czesci materialu.", {
      operationId,
      action: { label: "sprawdz material", kind: "none" },
    });
  }
  emit("running", "split", {
    itemCount: parts.length,
    message: `${parts.length} czesci`,
  });

  const responses: ModelCallResponse[] = [];
  let attemptCounter = 0;

  const runCall = async (
    partIndex: number,
    messages: ModelMessage[],
    mediaParts: MediaPart[],
    promptVersion: string,
    // What callWithRetry will do with a failure of this send (see there).
    resend: { preHeader: boolean; unbilled: boolean; afterClose: boolean } = { preHeader: false, unbilled: false, afterClose: false },
  ): Promise<CallOutcome> => {
    attemptCounter += 1;
    // A confirmed retry runs the same operation again. Give every paid call a new
    // journal identity so its old unknown/response evidence remains immutable.
    const attemptId = `att_${operationId}_${attemptCounter}_${randomUUID()}`;
    const summaryBase = {
      model: deps.model.modelName,
      promptVersion,
      partIndex,
      parts: parts.length,
      mediaParts: mediaParts.map((part) => part.index),
      characters: messages.reduce((sum, message) => sum + message.text.length, 0),
    };
    const requestSummary = JSON.stringify({
      schema: 2,
      ...summaryBase,
      // The date in the prompt; read back by promptDateFor so a confirmed retry rebuilds
      // the identical prompt. Kept out of summaryBase, which legacy summaries must match.
      promptDate: today,
      contentHash: sha256Hex(JSON.stringify({
        sourceRef,
        messages,
        mediaParts: mediaParts.map((part) => ({
          index: part.index,
          startSeconds: part.startSeconds,
          endSeconds: part.endSeconds,
          localPath: part.localPath,
        })),
      })),
    });
    // A confirmed retry may follow an unknown later part. Reuse only a committed
    // response with the same versioned content fingerprint. Legacy summaries
    // without a digest are deliberately ineligible for automatic reuse.
    const committedV2 = deps.completedAttempts?.findLast((attempt) =>
      attempt.phase === "response" && attempt.partIndex === partIndex &&
      attempt.requestSummary === requestSummary && typeof attempt.responseSummary === "string",
    );
    // An operator can approve ONE old response after inspecting the saved
    // operation and its media. This does not turn the legacy length-only summary
    // into a general cache key; all new responses require the v2 content digest.
    const committedLegacy = deps.legacyCheckpointAttemptId && deps.completedAttempts?.find((attempt) =>
      attempt.id === deps.legacyCheckpointAttemptId && attempt.operationId === operationId &&
      attempt.phase === "response" && attempt.partIndex === partIndex &&
      attempt.requestSummary === JSON.stringify(summaryBase) && typeof attempt.responseSummary === "string",
    );
    const committed = committedV2 ?? committedLegacy;
    if (committed) {
      emit("running", "call_reused", {
        itemIndex: partIndex,
        itemCount: parts.length,
        message: `zapisana odpowiedz modelu ${partIndex + 1}/${parts.length}`,
      });
      return { kind: "ok", response: {
        text: committed.responseSummary!,
        usage: committed.usage ?? { inputTokens: null, outputTokens: null, costUsd: null, costKnown: false },
        completed: true,
      } };
    }
    const intent: Omit<AttemptRecord, "createdAt"> = {
      id: attemptId,
      operationId,
      phase: "intent",
      partIndex,
      model: deps.model.modelName,
      requestSummary,
    };
    // Intent is durable before the call is issued: a crash mid-call must not leave an
    // untracked paid request.
    await deps.attempts.intent(intent);
    await deps.attempts.started(attemptId, { partIndex, partCount: parts.length });
    emit("running", "call", {
      itemIndex: partIndex,
      itemCount: parts.length,
      message: `wywolanie modelu ${partIndex + 1}/${parts.length}`,
    });

    const callRequest: ModelCallRequest = {
      operationId,
      attemptId,
      partIndex,
      messages,
      mediaParts,
      language: request.language,
    };

    let response: ModelCallResponse;
    try {
      response = await deps.model.call(callRequest, deps.attempts);
    } catch (error) {
      const converted = toOmniWatchError(error, "provider_rejected");
      if (converted.errorClass === "outcome_unknown") {
        const preHeader = converted.transportPhase === "headers";
        await deps.attempts.unknown(attemptId, "outcome_unknown", converted.message,
          preHeader && resend.preHeader ? { deferOperationState: true } : undefined);
        return {
          kind: "unknown",
          errorClass: "outcome_unknown",
          message: converted.message,
          partialText: "",
          preHeader,
        };
      }
      const unbilled = converted.errorClass === "rate_limited" || converted.transportPhase === "not_sent";
      await deps.attempts.failed(attemptId, converted.errorClass, converted.message,
        (unbilled && resend.unbilled) || resend.afterClose ? { deferOperationState: true } : undefined);
      throw converted;
    }

    if (!response.completed) {
      const message = response.failureDetail
        ? `Odpowiedz modelu nie zakonczyla sie poprawnie (${response.failureDetail}).`
        : "Odpowiedz modelu nie zakonczyla sie poprawnie (brak znacznika konca).";
      await deps.attempts.unknown(attemptId, "outcome_unknown", message);
      return { kind: "unknown", errorClass: "outcome_unknown", message, partialText: response.text };
    }

    await deps.attempts.response(attemptId, response);
    return { kind: "ok", response };
  };

  // Paid calls of this run whose outcome is unknown, resent ones included: any of them
  // may have been billed, so the run's cost cannot be known (R2-05).
  let unknownCalls = 0;
  let resentCalls = 0;
  const wait = (ms: number): Promise<void> => new Promise((resolve) => { deps.clock.setTimeout(resolve, ms); });

  /**
   * runCall plus the bounded resend policy (LF2). Only two cases are resent:
   *   - not billed for sure: the request never reached the provider (upload or DNS
   *     failure, `transportPhase: "not_sent"`) or was refused with 429 - after a short
   *     backoff, at most UNBILLED_RETRY_DELAYS_MS.length times;
   *   - the provider closed the connection before any response header (its ~60 s
   *     no-first-token limit; no token was generated for us) - at most
   *     `preHeaderRetries` times, immediately. Whether the provider bills such a
   *     closed request could not be verified with an API key (qa LF2-speed report),
   *     so each one still counts as an unknown call and the run's cost is unknown.
   * A stream that broke after headers, a 5xx, or our own timeout is never resent.
   */
  const callWithRetry = async (
    partIndex: number,
    messages: ModelMessage[],
    mediaParts: MediaPart[],
    promptVersion: string,
  ): Promise<CallOutcome> => {
    let unbilledRetries = 0;
    let preHeaderResends = 0;
    let closedMessage = "";
    for (;;) {
      let outcome: CallOutcome;
      try {
        outcome = await runCall(partIndex, messages, mediaParts, promptVersion, {
          preHeader: preHeaderResends < preHeaderRetries,
          unbilled: unbilledRetries < UNBILLED_RETRY_DELAYS_MS.length,
          afterClose: closedMessage !== "",
        });
      } catch (error) {
        const unbilled = isOmniWatchError(error) &&
          (error.errorClass === "rate_limited" || error.transportPhase === "not_sent");
        if (!unbilled || unbilledRetries >= UNBILLED_RETRY_DELAYS_MS.length) {
          // An earlier send of this call was closed before headers and may have been
          // billed: the call as a whole stays unknown (confirmed-retry path), not failed.
          if (closedMessage) {
            const detail = isOmniWatchError(error) ? error.message : String(error);
            return { kind: "unknown", errorClass: "outcome_unknown", message: `${closedMessage} Ponowne wyslanie odrzucone: ${detail}`, partialText: "" };
          }
          throw error;
        }
        const delay = UNBILLED_RETRY_DELAYS_MS[unbilledRetries];
        unbilledRetries += 1;
        resentCalls += 1;
        emit("running", "part_retry", {
          itemIndex: partIndex,
          itemCount: parts.length,
          message: `czesc ${partIndex + 1}/${parts.length}: ponawiam niewyslane wywolanie (${(error as OmniWatchError).errorClass})`,
        });
        await wait(delay);
        continue;
      }
      if (outcome.kind === "unknown") {
        unknownCalls += 1;
        if (outcome.preHeader && preHeaderResends < preHeaderRetries) {
          closedMessage = outcome.message;
          preHeaderResends += 1;
          resentCalls += 1;
          deps.logger.warn("omniwatch.analysis.pre_header_resend", { operationId, partIndex, resend: preHeaderResends });
          emit("running", "part_retry", {
            itemIndex: partIndex,
            itemCount: parts.length,
            errorClass: "outcome_unknown",
            message: `czesc ${partIndex + 1}/${parts.length}: provider zamknal polaczenie przed odpowiedzia, wysylam ponownie`,
          });
          continue;
        }
      }
      return outcome;
    }
  };

  const notes: string[] = [];
  let content = "";
  let incomplete = false;
  let errorClass: ErrorClass | null = null;
  let unknownMessage = "";
  let unknownParts: number[] = [];

  if (parts.length === 1) {
    const prompt = buildWholePrompt({
      mode: request.mode,
      language: request.language,
      info,
      focus: normalizedFocus,
      question,
      history: context.turns,
      today,
    });
    const outcome = await callWithRetry(0, prompt.messages, [parts[0]], prompt.version);
    if (outcome.kind === "ok") {
      responses.push(outcome.response);
      content = outcome.response.text;
    } else {
      incomplete = true;
      errorClass = outcome.errorClass;
      unknownMessage = outcome.message;
      unknownParts = [0];
      content = outcome.partialText;
    }
  } else {
    // Every part is attempted, several at a time (runBounded). An unknown part does not
    // stop the others: they are separate paid calls that the film needs anyway, and a
    // later confirmed retry reuses every committed part and pays only for the missing
    // ones. A definitive failure (4xx, missing config) stops new starts; calls already
    // in flight are awaited so none is left unjournaled.
    const partNotes = new Map<number, string>();
    const partials = new Map<number, string>();
    const unknownMessages = new Map<number, string>();
    let definitive: unknown = null;
    let definitiveSeen = false;
    await runBounded(
      parts,
      partConcurrency,
      async (part) => {
        const prompt = buildPartNotesPrompt({
          mode: request.mode,
          language: request.language,
          info,
          focus: normalizedFocus,
          question,
          partIndex: part.index,
          partCount: parts.length,
          startSeconds: part.startSeconds,
          today,
        });
        let outcome: CallOutcome;
        try {
          outcome = await callWithRetry(part.index, prompt.messages, [part], prompt.version);
        } catch (error) {
          if (!definitiveSeen) {
            definitiveSeen = true;
            definitive = error;
          }
          return;
        }
        const length = part.endSeconds - part.startSeconds;
        if (outcome.kind === "ok") {
          responses.push(outcome.response);
          partNotes.set(part.index, shiftTimestamps(outcome.response.text, part.startSeconds, length));
          emit("running", "part_done", {
            itemIndex: part.index,
            itemCount: parts.length,
            message: `czesc ${part.index + 1}/${parts.length} gotowa`,
          });
        } else {
          unknownMessages.set(part.index, outcome.message);
          if (outcome.partialText) partials.set(part.index, shiftTimestamps(outcome.partialText, part.startSeconds, length));
          emit("running", "part_unknown", {
            itemIndex: part.index,
            itemCount: parts.length,
            errorClass: "outcome_unknown",
            message: `czesc ${part.index + 1}/${parts.length}: wynik nieznany`,
          });
        }
      },
      () => definitiveSeen,
    );
    if (definitiveSeen) throw definitive;

    const ordered = parts.filter((part) => partNotes.has(part.index));
    for (const part of parts) {
      const text = partNotes.get(part.index) ?? partials.get(part.index);
      if (text) notes.push(text);
    }

    if (unknownMessages.size) {
      incomplete = true;
      errorClass = "outcome_unknown";
      unknownParts = [...unknownMessages.keys()].sort((a, b) => a - b);
      const last = unknownMessages.get(unknownParts[unknownParts.length - 1]) ?? "";
      unknownMessage = unknownPartsMessage(unknownParts, parts.length, ordered.length, last);
    } else {
      const mergePrompt = buildMergePrompt({
        mode: request.mode,
        language: request.language,
        info,
        focus: normalizedFocus,
        question,
        notes: ordered.map((part, index) => ({ index, startSeconds: part.startSeconds, text: partNotes.get(part.index)! })),
        history: context.turns,
        today,
      });
      emit("running", "merge", { itemCount: parts.length, message: "scalam notatki" });
      const merged = await callWithRetry(parts.length, mergePrompt.messages, [], mergePrompt.version);
      if (merged.kind === "ok") {
        responses.push(merged.response);
        content = merged.response.text;
      } else {
        incomplete = true;
        errorClass = merged.errorClass;
        unknownParts = [parts.length];
        unknownMessage = `Scalenie notatek: ${merged.message} Wszystkie ${parts.length} czesci sa zapisane; ponowienie zaplaci tylko za scalenie.`;
        content = merged.partialText;
      }
    }

    if (incomplete && (!content || content.trim() === "")) {
      // The notes are still evidence of what was watched; keep them rather than
      // returning an empty document after a paid call.
      content = notes.join("\n\n");
    }
  }

  if (incomplete) content = `${content}${INCOMPLETE_NOTE}`;

  const usage = aggregateUsage(responses, Math.max(unknownCalls, unknownParts.length));
  const result: AnalysisOutcome = {
    analysisId,
    analysisKey,
    mode: request.mode,
    focus: normalizedFocus,
    question,
    language: request.language,
    analysisVersion: request.analysisVersion,
    sourceRef,
    title: info.title,
    content,
    highlights: extractHighlights(content),
    conversationId,
    turnId,
    parentTurnId,
    parts: parts.length,
    usage,
    createdAt,
    incomplete: incomplete || undefined,
    errorClass,
    events,
    ...(unknownParts.length ? { unknownParts, outcomeMessage: unknownMessage } : {}),
  };

  if (errorClass === "outcome_unknown") {
    deps.logger.warn("omniwatch.analysis.outcome_unknown", {
      operationId,
      analysisId,
      message: unknownMessage,
    });
    emit("outcome_unknown", "call", {
      errorClass: "outcome_unknown",
      itemCount: parts.length,
      message: unknownMessage,
      partialText: content,
      usage,
    });
  } else {
    emit("result_ready", "result", { itemCount: parts.length, usage });
  }

  deps.logger.info("omniwatch.analysis.done", {
    operationId,
    analysisId,
    parts: parts.length,
    incomplete,
    unknownParts: unknownParts.length,
    unknownCalls,
    resentCalls,
    costKnown: usage.costKnown,
  });
  return result;
}

/** True when the outcome means a paid call may or may not have completed. */
export function isOutcomeUnknown(value: unknown): boolean {
  if (value && typeof value === "object" && "errorClass" in value) {
    return (value as { errorClass?: unknown }).errorClass === "outcome_unknown";
  }
  return isOmniWatchError(value) && value.errorClass === "outcome_unknown";
}
