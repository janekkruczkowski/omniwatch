/**
 * OpenAI-compatible ModelPort (T1).
 *
 * One `call()` issues one billable HTTP request. There is no retry loop here, on
 * purpose: a 5xx, a timeout, an abort or a stream that stops without a protocol end
 * may already have been billed, so the runtime decides, not the transport (D9).
 *
 * The single exception is a request the provider REJECTED before running the model:
 * HTTP 400 "The provided URL does not appear to be valid" for an oss:// media URL
 * (R2-03). Measured 2026-09-23: a temporary oss:// object that already served one
 * request is later refused this way (4 of 4 reuses after a success), in ~1 s, with no
 * usage, while a fresh upload of the same file is accepted. With `resolveMediaUrl`
 * the media is uploaded again and the request is sent once more; nothing was billed
 * for the refused one.
 *
 * Error classes:
 *   - `missing_config`    - no key or no base URL; thrown by preflight() before work;
 *   - `rate_limited`      - 429, the provider did not run the request;
 *   - `provider_rejected` - 4xx, and connection-level failures that provably never
 *                           reached the provider (DNS, refused, unreachable);
 *   - `outcome_unknown`   - 5xx, timeout, abort, reset after send, or a stream that
 *                           closed without a completion marker.
 *
 * Completion means the protocol said so: a `data: [DONE]` sentinel or a chunk with a
 * non-null `finish_reason`. A bare socket close is not a completion.
 */

import { OmniWatchError } from "../contracts/errors.ts";
import { chatCompletionsUrl } from "../contracts/endpoints.ts";
import type {
  AttemptSink,
  ConfigPort,
  ModelCallRequest,
  ModelCallResponse,
  ModelPort,
} from "../contracts/ports.ts";
import type { MediaPart, Usage } from "../contracts/types.ts";
import { fpsFor } from "../sources/media.ts";

export interface TimerPort {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OpenAiModelPortOptions {
  config: ConfigPort;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Budget in ms for the provider to START answering (response headers). It is
   * cleared as soon as headers arrive: a stream that keeps delivering bytes is never
   * cut by a wall-clock limit, only `idleTimeoutMs` ends a stalled one. 0 disables.
   * Default 600000.
   */
  timeoutMs?: number;
  /** No bytes for this long (before or after headers) means a stall. 0 disables. Default 120000. */
  idleTimeoutMs?: number;
  /** Timer source; defaults to the global timers. */
  timers?: TimerPort;
  maxOutputTokens?: number;
  /**
   * Maps a prepared local part to a provider-readable URL (for the host pipeline the
   * oss:// upload). Without it, media parts cannot be sent and the call fails loudly
   * rather than silently analysing nothing.
   */
  resolveMediaUrl?: (part: MediaPart, options?: { refresh?: boolean }) => Promise<string | null>;
  /** Sampling rate per part; defaults to the length-based short/long rule. */
  fpsForPart?: (part: MediaPart) => number;
  /** Host-side pricing (the core never hard-codes a price list). */
  costForUsage?: (tokens: { inputTokens: number | null; outputTokens: number | null }) => number | null;
}

export interface OpenAiModelPort extends ModelPort {
  preflight(): void;
  /** Resolved chat-completions URL; useful in diagnostics and tests. */
  endpoint(): string;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_MS = 120_000;

function missingConfig(message: string, actionLabel: string): OmniWatchError {
  return new OmniWatchError("missing_config", message, {
    action: { label: actionLabel, kind: "fix_config" },
  });
}

/** Accept `/v1`, `/compatible-mode/v1`, a bare host, or a full endpoint. */
export { chatCompletionsUrl };

function errorCodeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "";
}

function transportDiagnostic(error: unknown, phase: "headers" | "stream", abortSource: string, elapsedMs: number): string {
  const rawCode = errorCodeOf(error);
  const code = /^[A-Z][A-Z0-9_]{0,39}$/.test(rawCode) ? rawCode : "none";
  const name = error instanceof Error && ["AbortError", "TimeoutError", "TypeError"].includes(error.name)
    ? error.name : "other";
  return `phase=${phase} code=${code} name=${name} abort=${abortSource} elapsed_ms=${Math.max(0, Math.round(elapsedMs))}`;
}

/**
 * Codes that mean the bytes never left this machine in any form the provider could
 * have acted on. Everything else is treated as possibly delivered.
 */
const NOT_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

/** DashScope's refusal of a media URL it cannot (or can no longer) read. */
const INVALID_MEDIA_URL = /does not appear to be valid|InvalidParameter[^"]*URL|url.{0,40}invalid/i;

/**
 * Reasoning control for the shared OpenAI-compatible endpoint, as request fields.
 *
 * Qwen3.8-Omni-Flash defaults to xhigh thinking. On video parts that can leave the
 * first response byte behind the provider's ~60 s idle close; on the library's
 * keyword-expansion call (R3-02) it burned 360-1290 output tokens on a 4-8 word
 * answer, which `max_tokens` does not bound because reasoning is not the completion.
 * The documented low setting keeps reasoning while shortening both waits, so it is
 * one rule in one place rather than a private copy per caller. Empty for any other
 * model: nothing is sent that the provider did not document.
 */
export function reasoningParams(modelName: string): { reasoning_effort: "low" } | Record<string, never> {
  return /^qwen3\.8-omni-flash(?:$|-)/i.test(modelName) ? { reasoning_effort: "low" } : {};
}

export function createOpenAiModelPort(options: OpenAiModelPortOptions): OpenAiModelPort {
  const { config } = options;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timers: TimerPort = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;

  const endpoint = (): string => chatCompletionsUrl(config.apiBaseUrl() ?? "");

  const preflight = (): void => {
    const key = config.apiKey();
    if (!key || key.trim() === "") {
      throw missingConfig("Brak klucza API dla modelu analizy.", "ustaw klucz API");
    }
    const base = config.apiBaseUrl();
    if (!base || base.trim() === "") {
      throw missingConfig("Brak adresu API modelu analizy.", "ustaw adres API");
    }
    if (!config.modelName || config.modelName.trim() === "") {
      throw missingConfig("Brak nazwy modelu analizy.", "ustaw nazwe modelu");
    }
  };

  async function contentPayload(request: ModelCallRequest, refresh = false): Promise<unknown> {
    if (!request.mediaParts.length) {
      return request.messages.map((message) => ({ role: message.role, content: message.text }));
    }
    if (!options.resolveMediaUrl) {
      throw missingConfig(
        "Provider nie ma zmapowanych materialow wideo (brak resolveMediaUrl).",
        "skonfiguruj upload materialow",
      );
    }
    const media: Array<Record<string, unknown>> = [];
    for (const part of request.mediaParts) {
      const url = await options.resolveMediaUrl(part, refresh ? { refresh: true } : undefined);
      if (!url) {
        throw new OmniWatchError("source_unavailable", `Nie ma adresu providera dla czesci ${part.index}.`, {
          action: { label: "przygotuj material ponownie", kind: "none" },
        });
      }
      media.push({
        type: "video_url",
        video_url: { url },
        // The film's rate fixed at split time; the part's end is only a legacy guess.
        fps: (options.fpsForPart ?? ((p: MediaPart) => p.fps ?? fpsFor(p.endSeconds)))(part),
      });
    }
    // The system message carries the data/instruction boundary and must keep its role;
    // only the user text is merged with the video parts.
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.text).join("\n\n");
    const text = request.messages.filter((message) => message.role !== "system").map((message) => message.text).join("\n\n");
    const payload: unknown[] = [];
    if (system) payload.push({ role: "system", content: system });
    payload.push({ role: "user", content: [...media, { type: "text", text }] });
    return payload;
  }

  function mapUsage(raw: unknown): Usage {
    const record = (raw ?? {}) as Record<string, unknown>;
    const input = typeof record.prompt_tokens === "number" ? record.prompt_tokens : null;
    const output = typeof record.completion_tokens === "number" ? record.completion_tokens : null;
    const reported = typeof record.cost === "number" ? record.cost : typeof record.total_cost === "number" ? record.total_cost : null;
    const computed = options.costForUsage?.({ inputTokens: input, outputTokens: output }) ?? null;
    const cost = reported ?? computed;
    return {
      inputTokens: input,
      outputTokens: output,
      costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
      // No usage at all means the cost is unknown, never zero.
      costKnown: typeof cost === "number" && Number.isFinite(cost),
    };
  }

  async function call(request: ModelCallRequest, _sink: AttemptSink): Promise<ModelCallResponse> {
    const key = config.apiKey();
    if (!key) throw missingConfig("Brak klucza API dla modelu analizy.", "ustaw klucz API");
    const base = config.apiBaseUrl();
    if (!base) throw missingConfig("Brak adresu API modelu analizy.", "ustaw adres API");

    const controller = new AbortController();
    let startedAt = Date.now();
    let abortSource = "none";
    let deadline: unknown = null;
    let idle: unknown = null;
    const clearTimers = (): void => {
      if (deadline) timers.clearTimeout(deadline);
      if (idle) timers.clearTimeout(idle);
      deadline = null;
      idle = null;
    };
    const armIdle = (): void => {
      if (!idleTimeoutMs) return;
      if (idle) timers.clearTimeout(idle);
      idle = timers.setTimeout(() => { abortSource = "idle"; controller.abort(); }, idleTimeoutMs);
    };

    let response!: Response;
    let rejectedDetail: string | null = null;
    for (let round = 0; round < 2; round += 1) {
      const body = {
        model: config.modelName,
        ...reasoningParams(config.modelName),
        // Uploads happen here, before the clock below starts: `elapsed_ms` in a
        // transport diagnostic is time on the wire, not upload time.
        messages: await contentPayload(request, round > 0),
        modalities: ["text"],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.maxOutputTokens ?? options.maxOutputTokens,
      };

      startedAt = Date.now();
      if (timeoutMs) deadline = timers.setTimeout(() => { abortSource = "deadline"; controller.abort(); }, timeoutMs);
      armIdle();
      try {
        response = await doFetch(endpoint(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "X-DashScope-OssResourceResolve": "enable",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimers();
        const code = errorCodeOf(error);
        if (NOT_SENT_CODES.has(code)) {
          throw new OmniWatchError("provider_rejected", `Nie udalo sie wyslac zadania do modelu (${code}).`, {
            action: { label: "sprawdz polaczenie", kind: "check_operation" },
            cause: error,
          });
        }
        const detail = transportDiagnostic(error, "headers", abortSource, Date.now() - startedAt);
        throw new OmniWatchError("outcome_unknown", `Polaczenie z modelem przerwane; nie wiadomo, czy wywolanie doszlo do skutku. (${detail})`, {
          action: { label: "sprawdz operacje", kind: "check_operation" },
          cause: error,
        });
      }
      if (response.status !== 400 || round > 0 || !request.mediaParts.length || !options.resolveMediaUrl) break;
      rejectedDetail = await response.text().catch(() => "");
      if (!INVALID_MEDIA_URL.test(rejectedDetail)) break;
      // Refused before the model ran (R2-03): upload the media again and resend once.
      clearTimers();
      rejectedDetail = null;
    }
    try {
      request.onResponseStarted?.();
    } catch {
      /* a scheduling hint must never break the call */
    }

    // Headers arrived: from here on only inactivity ends the call. A long answer
    // that is still streaming must not be cut by the start-up budget (QA 2026-09-23).
    if (deadline) {
      timers.clearTimeout(deadline);
      deadline = null;
    }

    if (!response.ok) {
      clearTimers();
      const detail = rejectedDetail ?? await response.text().catch(() => "");
      const safeDetail = detail.slice(0, 300);
      if (response.status === 429) {
        throw new OmniWatchError("rate_limited", `Model odrzucil tempo zapytan (429). ${safeDetail}`.trim(), {
          action: { label: "sprobuj pozniej", kind: "check_operation" },
        });
      }
      if (response.status >= 500) {
        throw new OmniWatchError("outcome_unknown", `Model zwrocil blad ${response.status}; nie wiadomo, czy wywolanie zostalo rozliczone.`, {
          action: { label: "sprawdz operacje", kind: "check_operation" },
        });
      }
      throw new OmniWatchError("provider_rejected", `Model odrzucil zadanie (${response.status}). ${safeDetail}`.trim(), {
        action: { label: "popraw dane wejsciowe", kind: "none" },
      });
    }

    if (!response.body) {
      clearTimers();
      throw new OmniWatchError("outcome_unknown", "Model nie zwrocil strumienia odpowiedzi.", {
        action: { label: "sprawdz operacje", kind: "check_operation" },
      });
    }

    const reader = response.body.getReader();
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
      if (event.usage) usage = mapUsage(event.usage);
    };

    try {
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch (error) {
          aborted = true;
          streamFailure = transportDiagnostic(error, "stream", abortSource, Date.now() - startedAt);
          break;
        }
        if (chunk.done) break;
        armIdle();
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
    } finally {
      clearTimers();
      try {
        reader.releaseLock();
      } catch {
        /* the stream may already be closed */
      }
    }

    // SSE senders may close immediately after their final data line without a
    // trailing newline. That line is still a complete protocol marker/payload.
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) consumeLine(line);
    if (sawProtocolEnd) return { text, usage, completed: true };
    if (aborted) return { text, usage, completed: false, failureDetail: streamFailure };
    return { text, usage, completed: false, failureDetail: `phase=stream code=EOF data_events=${dataEvents} marker=missing` };
  }

  return {
    modelName: config.modelName,
    preflight,
    endpoint,
    call,
  };
}
