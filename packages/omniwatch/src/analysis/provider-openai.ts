/**
 * OpenAI-compatible ModelPort (T1).
 *
 * One `call()` issues exactly one HTTP request. There is no retry loop here, on
 * purpose: a 5xx, a timeout, an abort or a stream that stops without a protocol end
 * may already have been billed, so the runtime decides, not the transport (D9).
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
  /** Overall request budget in ms. 0 disables the deadline. Default 600000. */
  timeoutMs?: number;
  /** No bytes for this long means the stream stalled. 0 disables. Default 120000. */
  idleTimeoutMs?: number;
  /** Timer source; defaults to the global timers. */
  timers?: TimerPort;
  maxOutputTokens?: number;
  /**
   * Maps a prepared local part to a provider-readable URL (for the host pipeline the
   * oss:// upload). Without it, media parts cannot be sent and the call fails loudly
   * rather than silently analysing nothing.
   */
  resolveMediaUrl?: (part: MediaPart) => Promise<string | null>;
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

  async function contentPayload(request: ModelCallRequest): Promise<unknown> {
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
      const url = await options.resolveMediaUrl(part);
      if (!url) {
        throw new OmniWatchError("source_unavailable", `Nie ma adresu providera dla czesci ${part.index}.`, {
          action: { label: "przygotuj material ponownie", kind: "none" },
        });
      }
      media.push({
        type: "video_url",
        video_url: { url },
        fps: (options.fpsForPart ?? ((p: MediaPart) => fpsFor(p.endSeconds)))(part),
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
    const startedAt = Date.now();
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
    if (timeoutMs) deadline = timers.setTimeout(() => { abortSource = "deadline"; controller.abort(); }, timeoutMs);
    armIdle();

    const body = {
      model: config.modelName,
      // Qwen3.8-Omni-Flash defaults to xhigh thinking. On video parts that can
      // leave the first response byte behind the provider's ~60 s idle close.
      // The documented low setting keeps reasoning while shortening that wait.
      ...(/^qwen3\.8-omni-flash(?:$|-)/i.test(config.modelName) ? { reasoning_effort: "low" } : {}),
      messages: await contentPayload(request),
      modalities: ["text"],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxOutputTokens ?? options.maxOutputTokens,
    };

    let response: Response;
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

    if (!response.ok) {
      clearTimers();
      const detail = await response.text().catch(() => "");
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
