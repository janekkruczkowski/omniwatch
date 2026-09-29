/**
 * Shared OpenAI-compatible transport plumbing (R6).
 *
 * The DashScope/Qwen path (`provider-openai.ts`) and the OpenRouter fallback
 * (`fallback-openrouter.ts`) speak the same dialect: an OpenAI-compatible
 * `/chat/completions` endpoint, an SSE stream, and the same failure classification.
 * Everything here is the part that must not drift between them — the SSE reader, the
 * usage mapping, the message/part merge, and the HTTP failure classes.
 */

import { OmniWatchError } from "../contracts/errors.ts";
import type { ModelCallRequest, ModelCallResponse, ModelMessage } from "../contracts/ports.ts";
import type { Usage } from "../contracts/types.ts";

export interface TimerPort {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Codes that mean the bytes never left this machine in any form the provider acted on. */
export const NOT_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

/**
 * DashScope's content-inspection refusal of a harmless video. It is decided before the
 * model runs, so the call provably was not billed; the transport may resend it once and
 * then hand the material to the fallback provider (R6).
 */
export const CONTENT_FILTER = /DataInspectionFailed|data_inspection_failed/i;

export function errorCodeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "";
}

export function transportDiagnostic(error: unknown, phase: "headers" | "stream", abortSource: string, elapsedMs: number): string {
  const rawCode = errorCodeOf(error);
  const code = /^[A-Z][A-Z0-9_]{0,39}$/.test(rawCode) ? rawCode : "none";
  const name = error instanceof Error && ["AbortError", "TimeoutError", "TypeError"].includes(error.name)
    ? error.name : "other";
  return `phase=${phase} code=${code} name=${name} abort=${abortSource} elapsed_ms=${Math.max(0, Math.round(elapsedMs))}`;
}

export function mapUsage(
  raw: unknown,
  costForUsage?: (tokens: { inputTokens: number | null; outputTokens: number | null }) => number | null,
): Usage {
  const record = (raw ?? {}) as Record<string, unknown>;
  const input = typeof record.prompt_tokens === "number" ? record.prompt_tokens : null;
  const output = typeof record.completion_tokens === "number" ? record.completion_tokens : null;
  const reported = typeof record.cost === "number" ? record.cost : typeof record.total_cost === "number" ? record.total_cost : null;
  const computed = costForUsage?.({ inputTokens: input, outputTokens: output }) ?? null;
  const cost = reported ?? computed;
  return {
    inputTokens: input,
    outputTokens: output,
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    // No usage at all means the cost is unknown, never zero.
    costKnown: typeof cost === "number" && Number.isFinite(cost),
  };
}

/**
 * The system message carries the data/instruction boundary and must keep its role; only
 * the user text is merged with the media parts.
 */
export function buildMessagePayload(messages: ModelMessage[], media: Array<Record<string, unknown>>): unknown[] {
  const system = messages.filter((message) => message.role === "system").map((message) => message.text).join("\n\n");
  const text = messages.filter((message) => message.role !== "system").map((message) => message.text).join("\n\n");
  const payload: unknown[] = [];
  if (system) payload.push({ role: "system", content: system });
  payload.push({ role: "user", content: [...media, { type: "text", text }] });
  return payload;
}

/**
 * Classify a non-2xx answer. One place, so the Qwen path and the fallback cannot
 * disagree about what a 400/429/5xx means.
 *
 * `content_filtered` is the one refusal that names a cause rather than a mistake in the
 * input: the provider's inspection refused the material itself (R6). Its message is the
 * class's own Polish sentence, with no raw provider detail appended.
 */
export function classifyHttpFailure(status: number, detail: string): OmniWatchError {
  const safeDetail = detail.slice(0, 300);
  if (status === 400 && CONTENT_FILTER.test(detail)) {
    return new OmniWatchError("content_filtered", "Filtr treści modelu Qwen odrzucił ten materiał.", {
      action: { label: "sprawdz material", kind: "none" },
    });
  }
  if (status === 429) {
    return new OmniWatchError("rate_limited", `Model odrzucil tempo zapytan (429). ${safeDetail}`.trim(), {
      action: { label: "sprobuj pozniej", kind: "check_operation" },
    });
  }
  if (status >= 500) {
    return new OmniWatchError("outcome_unknown", `Model zwrocil blad ${status}; nie wiadomo, czy wywolanie zostalo rozliczone.`, {
      action: { label: "sprawdz operacje", kind: "check_operation" },
    });
  }
  return new OmniWatchError("provider_rejected", `Model odrzucil zadanie (${status}). ${safeDetail}`.trim(), {
    action: { label: "popraw dane wejsciowe", kind: "none" },
  });
}

export interface CompletionStreamOptions {
  /** Called after every chunk that arrived: the caller re-arms its inactivity timer. */
  onActivity(): void;
  /** Called once the stream is finished or has failed. */
  onSettled(): void;
  /** How the abort was triggered ("none", "deadline", "idle"), for the diagnostic. */
  abortSource(): string;
  startedAt(): number;
  mapUsage(raw: unknown): Usage;
}

/**
 * Read an OpenAI-compatible SSE completion.
 *
 * Completion means the protocol said so: a `data: [DONE]` sentinel or a chunk with a
 * non-null `finish_reason`. A bare socket close is not a completion.
 */
export async function readCompletionStream(
  response: Response,
  options: CompletionStreamOptions,
): Promise<ModelCallResponse> {
  const body = response.body;
  if (!body) {
    options.onSettled();
    throw new OmniWatchError("outcome_unknown", "Model nie zwrocil strumienia odpowiedzi.", {
      action: { label: "sprawdz operacje", kind: "check_operation" },
    });
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: Usage = { inputTokens: null, outputTokens: null, costUsd: null, costKnown: false };
  let sawProtocolEnd = false;
  let aborted = false;
  let streamFailure = "";
  let dataEvents = 0;
  const consumeLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    dataEvents += 1;
    if (payload === "[DONE]") {
      sawProtocolEnd = true;
      return;
    }
    let event: {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: unknown;
    };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const choice = event.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta.length) text += delta;
    if (choice && choice.finish_reason) sawProtocolEnd = true;
    if (event.usage) usage = options.mapUsage(event.usage);
  };

  try {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (error) {
        aborted = true;
        streamFailure = transportDiagnostic(error, "stream", options.abortSource(), Date.now() - options.startedAt());
        break;
      }
      if (chunk.done) break;
      options.onActivity();
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
  } finally {
    options.onSettled();
    try {
      reader.releaseLock();
    } catch {
      /* the stream may already be closed */
    }
  }

  // SSE senders may close immediately after their final data line without a trailing
  // newline. That line is still a complete protocol marker/payload.
  buffer += decoder.decode();
  for (const line of buffer.split("\n")) consumeLine(line);
  if (sawProtocolEnd) return { text, usage, completed: true };
  if (aborted) return { text, usage, completed: false, failureDetail: streamFailure };
  return { text, usage, completed: false, failureDetail: `phase=stream code=EOF data_events=${dataEvents} marker=missing` };
}

/** The one hint every transport gives its caller when it has STARTED answering. */
export function signalResponseStarted(request: ModelCallRequest): void {
  try {
    request.onResponseStarted?.();
  } catch {
    /* a scheduling hint must never break the call */
  }
}
