/**
 * The single analysis engine (T1).
 *
 * Orchestration only: prepare media, split it, call the model for each part (a few at
 * a time, see runGated), merge, produce an AnalysisResult. Storage, delivery and process lifecycle belong to
 * the runtime; this module receives ports and emits events.
 *
 * Cost safety, which is most of what this file is about:
 *   - every paid call gets an `intent` record written BEFORE it is issued;
 *   - a call whose outcome is unknown (timeout, abort, 5xx after send, unterminated
 *     stream) is never retried automatically - the partial text is returned with
 *     `incomplete: true` and `errorClass: "outcome_unknown"`;
 *   - a call that was definitely rejected (4xx) or rate limited (429) is reported as a
 *     failure and also not retried here;
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
 * Parts of one film in flight at once. The limit alone is not what protects the
 * provider: runGated also holds every new part until all running ones have started
 * answering. Measured live (2026-09-23): three ~46k-token parts sent together got
 * headers after 30/36/45 s instead of ~16 s alone, nine together lost five to the
 * ~60 s pre-header close. DashScope evidently prefills one account's requests one
 * after another, so overlap is only useful while an earlier part is generating.
 */
export const DEFAULT_PART_CONCURRENCY = 3;

/**
 * Run `work` for every item with at most `limit` in flight, starting the next item
 * only when every running one has called `started` (or settled). Items are started in
 * order; `stop()` is checked before each start. `work` must not reject.
 */
export async function runGated<T>(
  items: T[],
  limit: number,
  work: (item: T, started: () => void) => Promise<void>,
  stop: () => boolean = () => false,
): Promise<void> {
  const max = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
  const running = new Set<Promise<void>>();
  let notStarted = 0;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  for (const item of items) {
    while (running.size >= max || notStarted > 0) {
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (stop()) break;
    let marked = false;
    notStarted += 1;
    const started = (): void => {
      if (marked) return;
      marked = true;
      notStarted -= 1;
      signal();
    };
    const task: Promise<void> = Promise.resolve()
      .then(() => work(item, started))
      .catch(() => undefined)
      .finally(() => {
        started();
        running.delete(task);
        signal();
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

/**
 * Paid calls of this operation that were started but never confirmed, across every run.
 *
 * The engine only sees the calls it made, so the earlier runs are read back from the
 * journal. An attempt counts as unconfirmed when it reached the provider and no
 * `response` followed:
 *
 *   - `unknown` — the provider may or may not have billed it (a 5xx, a timeout, a
 *     stream that ended without a completion marker);
 *   - `started` — the process died mid-call, so nothing was ever written after it;
 *   - `intent` is not counted: the request never left the process;
 *   - `failed` is not counted: a definitive rejection that provably was not billed.
 *
 * An attempt confirmed by a later `response` is never counted, even if an earlier
 * phase of it was `unknown`: that is the same call, now accounted for.
 */
export function countUnknownCostCalls(attempts: AttemptRecord[] | undefined): number {
  // One attempt can appear more than once in a journal (intent, then started, then
  // unknown); the LAST phase written for an id is what it ended as. The store already
  // keeps one row per id, but a caller may hand over the raw journal, so the fold
  // happens here rather than being assumed.
  const finalPhase = new Map<string, AttemptRecord["phase"]>();
  for (const attempt of attempts ?? []) finalPhase.set(attempt.id, attempt.phase);
  let count = 0;
  for (const phase of finalPhase.values()) {
    if (phase === "unknown" || phase === "started") count += 1;
  }
  return count;
}

/** Optional provider hook so missing configuration fails before media work. */
interface PreflightableModel {
  preflight?: () => void | Promise<void>;
}

type CallOutcome =
  | { kind: "ok"; response: ModelCallResponse }
  | { kind: "unknown"; errorClass: ErrorClass; message: string; partialText: string };

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
 *
 * `unconfirmedCalls` is the same count across the WHOLE operation, earlier runs
 * included (R3-03). It does not change `costKnown`, which answers "is this result's
 * total complete?"; it answers a different question the UI has to be able to ask —
 * "was this operation ever charged for something that is not in that total?" — and is
 * carried on the usage so the answer survives into the note and the panel.
 */
export function aggregateUsage(
  responses: ModelCallResponse[],
  unknownCalls = 0,
  unconfirmedCalls = unknownCalls,
): Usage {
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
    // Only when there is something to report: a run that confirmed every call keeps
    // the exact shape it had before this field existed.
    ...(unconfirmedCalls > 0 ? { unknownCostCalls: unconfirmedCalls } : {}),
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
  // One bound for every shell: a host's larger setting must not produce parts the
  // provider closes before answering.
  const maxFrames = effectiveMaxFramesPerPart(deps.model.modelName, configuredFrames);
  const concurrencySetting = Number(deps.config.partConcurrency?.() ?? DEFAULT_PART_CONCURRENCY);
  const partConcurrency = isNumber(concurrencySetting) && concurrencySetting >= 1
    ? Math.floor(concurrencySetting)
    : DEFAULT_PART_CONCURRENCY;

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
    onResponseStarted?: () => void,
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
      ...(onResponseStarted ? { onResponseStarted } : {}),
    };

    let response: ModelCallResponse;
    try {
      response = await deps.model.call(callRequest, deps.attempts);
    } catch (error) {
      const converted = toOmniWatchError(error, "provider_rejected");
      if (converted.errorClass === "outcome_unknown") {
        await deps.attempts.unknown(attemptId, "outcome_unknown", converted.message);
        return { kind: "unknown", errorClass: "outcome_unknown", message: converted.message, partialText: "" };
      }
      await deps.attempts.failed(attemptId, converted.errorClass, converted.message);
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
    const outcome = await runCall(0, prompt.messages, [parts[0]], prompt.version);
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
    // Every part is attempted, a few at a time (runGated). An unknown part does not
    // stop the others: they are separate paid calls that the film needs anyway, and a
    // later confirmed retry reuses every committed part and pays only for the missing
    // ones. A definitive failure (4xx, missing config) stops new starts; calls already
    // in flight are awaited so none is left unjournaled.
    const partNotes = new Map<number, string>();
    const partials = new Map<number, string>();
    const unknownMessages = new Map<number, string>();
    let definitive: unknown = null;
    let definitiveSeen = false;
    await runGated(
      parts,
      partConcurrency,
      async (part, started) => {
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
          outcome = await runCall(part.index, prompt.messages, [part], prompt.version, started);
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
      const merged = await runCall(parts.length, mergePrompt.messages, [], mergePrompt.version);
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

  // R3-03: the earlier runs of this same operation are part of the picture. A
  // conscious retry only sees the calls it made, so without the journal it reports a
  // complete-looking total while an earlier attempt may also have been billed.
  const unknownCostCalls = countUnknownCostCalls(deps.completedAttempts) + unknownParts.length;
  const usage = aggregateUsage(responses, unknownParts.length, unknownCostCalls);
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
