/**
 * The single analysis engine (T1).
 *
 * Orchestration only: prepare media, split it, call the model ONE part at a time,
 * merge, produce an AnalysisResult. Storage, delivery and process lifecycle belong to
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
import { buildConversationContext, conversationIdForSource, estimateTokens } from "./context.ts";
import type { ConversationContext, ConversationTurnSource } from "./context.ts";
import { buildMergePrompt, buildPartNotesPrompt, buildWholePrompt } from "./prompt.ts";
import { parseTimestamp, shiftTimestamps } from "../sources/media.ts";

/** Default room for conversation history when the host does not declare one. */
export const DEFAULT_CONVERSATION_BUDGET_TOKENS = 12000;

export interface AnalysisDeps {
  clock: ClockPort;
  logger: LoggerPort;
  config: ConfigPort;
  source: SourcePort;
  model: ModelPort;
  attempts: AttemptSink;
  /** Durable responses from an earlier run of this same operation. */
  completedAttempts?: AttemptRecord[];
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

function aggregateUsage(responses: ModelCallResponse[]): Usage {
  const inputs = responses.map((r) => r.usage?.inputTokens).filter(isNumber);
  const outputs = responses.map((r) => r.usage?.outputTokens).filter(isNumber);
  const costs = responses.map((r) => r.usage?.costUsd).filter(isNumber);
  const costKnown =
    responses.length > 0 && responses.every((r) => r.usage?.costKnown === true && isNumber(r.usage?.costUsd));
  return {
    inputTokens: inputs.length ? inputs.reduce((a, b) => a + b, 0) : null,
    outputTokens: outputs.length ? outputs.reduce((a, b) => a + b, 0) : null,
    costUsd: costKnown && costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    costKnown,
  };
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

  const maxFrames = Number(deps.config.maxFramesPerPart());
  if (!isNumber(maxFrames) || maxFrames < 1) {
    throw new OmniWatchError("missing_config", "Brak poprawnego limitu klatek na czesc.", {
      operationId,
      action: { label: "ustaw OMNI_MAX_FRAMES", kind: "fix_config" },
    });
  }

  // Fail on a missing key or endpoint before a download, an upload or a paid call.
  const preflight = (deps.model as ModelPort & PreflightableModel).preflight;
  if (typeof preflight === "function") {
    try {
      await preflight.call(deps.model);
    } catch (error) {
      throw toOmniWatchError(error, "missing_config");
    }
  }

  const conversationId = request.conversationId ?? conversationIdForSource(sourceRef);
  const question = normalizeText(request.question);
  let context: ConversationContext;
  try {
    context = buildConversationContext({
      sourceRef,
      conversationId,
      question,
      parentTurnId: request.parentTurnId ?? null,
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

  emit("running", "prepare", {
    message: `przygotowuje material (${sourceRef.platform})`,
  });
  const info = await deps.source.prepare(sourceRef, { force: request.force });

  emit("running", "split", {
    message: `dzielenie na czesci (limit ${maxFrames} klatek)`,
  });
  const parts = await deps.source.split(info, { maxFramesPerPart: maxFrames });
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
  ): Promise<CallOutcome> => {
    attemptCounter += 1;
    // A confirmed retry runs the same operation again. Give every paid call a new
    // journal identity so its old unknown/response evidence remains immutable.
    const attemptId = `att_${operationId}_${attemptCounter}_${randomUUID()}`;
    const requestSummary = JSON.stringify({
      model: deps.model.modelName,
      promptVersion,
      partIndex,
      parts: parts.length,
      mediaParts: mediaParts.map((part) => part.index),
      characters: messages.reduce((sum, message) => sum + message.text.length, 0),
    });
    // A confirmed retry may follow an unknown later part. Reuse only a committed
    // response whose complete request shape matches this call; a changed split,
    // model, or prompt must be paid for afresh, never silently grafted together.
    const committed = deps.completedAttempts?.findLast((attempt) =>
      attempt.phase === "response" && attempt.partIndex === partIndex &&
      attempt.requestSummary === requestSummary && typeof attempt.responseSummary === "string",
    );
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

  if (parts.length === 1) {
    const prompt = buildWholePrompt({
      mode: request.mode,
      language: request.language,
      info,
      focus: normalizedFocus,
      question,
      history: context.turns,
    });
    const outcome = await runCall(0, prompt.messages, [parts[0]], prompt.version);
    if (outcome.kind === "ok") {
      responses.push(outcome.response);
      content = outcome.response.text;
    } else {
      incomplete = true;
      errorClass = outcome.errorClass;
      unknownMessage = outcome.message;
      content = outcome.partialText;
    }
  } else {
    let failed = false;
    for (const part of parts) {
      const prompt = buildPartNotesPrompt({
        mode: request.mode,
        language: request.language,
        info,
        focus: normalizedFocus,
        question,
        partIndex: part.index,
        partCount: parts.length,
        startSeconds: part.startSeconds,
      });
      const outcome = await runCall(part.index, prompt.messages, [part], prompt.version);
      if (outcome.kind === "ok") {
        responses.push(outcome.response);
        notes.push(shiftTimestamps(outcome.response.text, part.startSeconds, part.endSeconds - part.startSeconds));
        emit("running", "part_done", {
          itemIndex: part.index,
          itemCount: parts.length,
          message: `czesc ${part.index + 1}/${parts.length} gotowa`,
        });
      } else {
        incomplete = true;
        errorClass = outcome.errorClass;
        unknownMessage = outcome.message;
        if (outcome.partialText) notes.push(shiftTimestamps(outcome.partialText, part.startSeconds, 0));
        failed = true;
        break;
      }
    }

    if (!failed) {
      const mergePrompt = buildMergePrompt({
        mode: request.mode,
        language: request.language,
        info,
        focus: normalizedFocus,
        question,
        notes: notes.map((text, index) => ({ index, startSeconds: parts[index].startSeconds, text })),
        history: context.turns,
      });
      emit("running", "merge", { itemCount: parts.length, message: "scalam notatki" });
      const merged = await runCall(parts.length, mergePrompt.messages, [], mergePrompt.version);
      if (merged.kind === "ok") {
        responses.push(merged.response);
        content = merged.response.text;
      } else {
        incomplete = true;
        errorClass = merged.errorClass;
        unknownMessage = merged.message;
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

  const usage = aggregateUsage(responses);
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
