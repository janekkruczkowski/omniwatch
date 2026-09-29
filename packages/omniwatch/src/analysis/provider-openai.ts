/**
 * OpenAI-compatible ModelPort (T1).
 *
 * One `call()` issues one billable HTTP request. There is no retry loop here, on
 * purpose: a 5xx, a timeout, an abort or a stream that stops without a protocol end
 * may already have been billed, so the runtime decides, not the transport (D9).
 *
 * Two exceptions are requests the provider REJECTED before running the model:
 *
 *   - HTTP 400 "The provided URL does not appear to be valid" for an oss:// media URL
 *     (R2-03). Measured 2026-09-23: a temporary oss:// object that already served one
 *     request is later refused this way (4 of 4 reuses after a success), in ~1 s, with
 *     no usage, while a fresh upload of the same file is accepted. With
 *     `resolveMediaUrl` the media is uploaded again and the request is sent once more;
 *     nothing was billed for the refused one.
 *   - HTTP 400 DataInspectionFailed (R6): DashScope's content inspection refuses a
 *     harmless video before the model runs (not billed, deterministic for the same
 *     bytes). The SAME call is handed straight to the Gemini fallback over OpenRouter
 *     (`fallback-openrouter.ts`), which cannot read oss:// and therefore gets the local
 *     bytes inline as base64 data URLs. Without a fallback key the refusal is reported
 *     as `content_filtered`, naming the part and the missing configuration.
 *
 * Error classes:
 *   - `missing_config`    - no key or no base URL; thrown by preflight() before work;
 *   - `rate_limited`      - 429, the provider did not run the request;
 *   - `provider_rejected` - 4xx, and connection-level failures that provably never
 *                           reached the provider (DNS, refused, unreachable);
 *   - `content_filtered`  - 400 DataInspectionFailed, the provider's filter refused the
 *                           material itself (R6);
 *   - `outcome_unknown`   - 5xx, timeout, abort, reset after send, or a stream that
 *                           closed without a completion marker.
 *
 * Completion means the protocol said so: a `data: [DONE]` sentinel or a chunk with a
 * non-null `finish_reason`. A bare socket close is not a completion.
 *
 * Failures carry `transportPhase` so the engine can apply its bounded resend policy
 * (LF2): `not_sent` for a media upload or connection that never reached the provider,
 * `headers` for a provider close before any response header that was not our own
 * deadline or idle abort. The provider itself still never resends.
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
import type { MediaPart } from "../contracts/types.ts";
import { fpsFor } from "../sources/media.ts";
import {
  callOpenRouterFallback,
  fallbackNotConfiguredError,
  fallbackSettingsFromEnv,
  type FallbackSettings,
} from "./fallback-openrouter.ts";
import {
  buildMessagePayload,
  classifyHttpFailure,
  CONTENT_FILTER,
  errorCodeOf,
  mapUsage,
  NOT_SENT_CODES,
  readCompletionStream,
  signalResponseStarted,
  transportDiagnostic,
  type TimerPort,
} from "./openai-transport.ts";

export type { TimerPort } from "./openai-transport.ts";

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
  /**
   * OpenRouter key for the content-filter fallback (R6). Defaults to
   * OMNIWATCH_FALLBACK_API_KEY, then OPENROUTER_API_KEY from the environment.
   * Empty/null disables the fallback: the refusal is then reported as `content_filtered`.
   */
  openRouterApiKey?: string | null;
  /** Fallback model/base; default from OMNIWATCH_FALLBACK_MODEL / OMNIWATCH_FALLBACK_API_BASE. */
  fallback?: Partial<Omit<FallbackSettings, "apiKey">>;
  /** Environment the fallback settings are read from; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Reads a local part's bytes for the fallback's base64 data URL; injected in tests. */
  readMediaBytes?: (localPath: string) => Promise<Uint8Array>;
  /** Host re-encode (ffmpeg) of a part too big to inline for the fallback. */
  shrinkMedia?: (part: MediaPart, maxBytes: number) => Promise<string | null>;
  /** Inline media ceiling for the fallback request; default 18 MB of raw bytes. */
  fallbackMaxInlineBytes?: number;
}

export interface OpenAiModelPort extends ModelPort {
  preflight(): void;
  /** Resolved chat-completions URL; useful in diagnostics and tests. */
  endpoint(): string;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_MS = 120_000;

/** DashScope's refusal of a media URL it cannot (or can no longer) read. */
const INVALID_MEDIA_URL = /does not appear to be valid|InvalidParameter[^"]*URL|url.{0,40}invalid/i;

function missingConfig(message: string, actionLabel: string): OmniWatchError {
  return new OmniWatchError("missing_config", message, {
    action: { label: actionLabel, kind: "fix_config" },
  });
}

/** Accept `/v1`, `/compatible-mode/v1`, a bare host, or a full endpoint. */
export { chatCompletionsUrl };

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
  // Read once, at construction, so a test can pin it and production reads the env.
  const envFallback = fallbackSettingsFromEnv(options.env ?? process.env);
  const fallbackSettings: FallbackSettings = {
    model: options.fallback?.model ?? envFallback.model,
    apiBase: options.fallback?.apiBase ?? envFallback.apiBase,
    apiKey: options.openRouterApiKey === undefined ? envFallback.apiKey : options.openRouterApiKey,
  };

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
      let url: string | null;
      try {
        url = await options.resolveMediaUrl(part, refresh ? { refresh: true } : undefined);
      } catch (error) {
        // The upload failed before any model request was sent: nothing was billed.
        if (error instanceof OmniWatchError) throw error;
        throw new OmniWatchError("provider_rejected", `Nie udalo sie wyslac materialu czesci ${part.index} do providera (${errorCodeOf(error) || "upload"}).`, {
          action: { label: "sprawdz polaczenie", kind: "check_operation" },
          cause: error,
          transportPhase: "not_sent",
        });
      }
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
    return buildMessagePayload(request.messages, media);
  }

  const mapUsageForHost = (raw: unknown) => mapUsage(raw, options.costForUsage);

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

    /**
     * One request on the configured Qwen endpoint. `refresh` asks the host for a fresh
     * upload of the media (R2-03); uploads happen before the clock starts, so
     * `elapsed_ms` in a transport diagnostic is time on the wire, not upload time.
     */
    const send = async (refresh: boolean): Promise<Response> => {
      const body = {
        model: config.modelName,
        ...reasoningParams(config.modelName),
        messages: await contentPayload(request, refresh),
        modalities: ["text"],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.maxOutputTokens ?? options.maxOutputTokens,
      };

      startedAt = Date.now();
      if (timeoutMs) deadline = timers.setTimeout(() => { abortSource = "deadline"; controller.abort(); }, timeoutMs);
      armIdle();
      try {
        return await doFetch(endpoint(), {
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
            transportPhase: "not_sent",
          });
        }
        const detail = transportDiagnostic(error, "headers", abortSource, Date.now() - startedAt);
        throw new OmniWatchError("outcome_unknown", `Polaczenie z modelem przerwane; nie wiadomo, czy wywolanie doszlo do skutku. (${detail})`, {
          action: { label: "sprawdz operacje", kind: "check_operation" },
          cause: error,
          // Only the provider's own close (its ~60 s no-first-token limit) qualifies;
          // our deadline or idle abort does not.
          ...(abortSource === "none" ? { transportPhase: "headers" as const } : {}),
        });
      }
    };

    let response!: Response;
    let rejectedDetail: string | null = null;
    // A single-use resend of a request the provider refused before running the model
    // because it can no longer read an oss:// URL (R2-03): upload the media again.
    let mediaResendUsed = false;
    let refreshNext = false;
    for (;;) {
      const refresh = refreshNext;
      refreshNext = false;
      response = await send(refresh);
      if (response.status !== 400) break;
      const detail = await response.text().catch(() => "");
      rejectedDetail = detail;
      if (!mediaResendUsed && request.mediaParts.length && options.resolveMediaUrl && INVALID_MEDIA_URL.test(detail)) {
        mediaResendUsed = true;
        refreshNext = true;
        rejectedDetail = null;
        clearTimers();
        continue;
      }
      break;
    }

    // Refused by DashScope's content inspection (R6): not billed, and the same bytes are
    // refused again, so this very call goes to the Gemini fallback. Without a key the
    // refusal stands, with a message that names the part and the missing setting.
    if (response.status === 400 && rejectedDetail !== null && CONTENT_FILTER.test(rejectedDetail)) {
      clearTimers();
      const fallback = await callOpenRouterFallback(request, {
        apiKey: fallbackSettings.apiKey,
        model: fallbackSettings.model,
        apiBase: fallbackSettings.apiBase,
        fetchImpl: options.fetchImpl,
        readMediaBytes: options.readMediaBytes,
        shrinkMedia: options.shrinkMedia,
        maxInlineBytes: options.fallbackMaxInlineBytes,
        timers,
        timeoutMs,
        idleTimeoutMs,
        maxOutputTokens: options.maxOutputTokens,
      });
      if (fallback) return fallback;
      throw fallbackNotConfiguredError(request);
    }

    signalResponseStarted(request);

    // Headers arrived: from here on only inactivity ends the call. A long answer
    // that is still streaming must not be cut by the start-up budget (QA 2026-09-23).
    if (deadline) {
      timers.clearTimeout(deadline);
      deadline = null;
    }

    if (!response.ok) {
      clearTimers();
      const detail = rejectedDetail ?? await response.text().catch(() => "");
      throw classifyHttpFailure(response.status, detail);
    }

    return readCompletionStream(response, {
      onActivity: armIdle,
      onSettled: clearTimers,
      abortSource: () => abortSource,
      startedAt: () => startedAt,
      mapUsage: mapUsageForHost,
    });
  }

  return {
    modelName: config.modelName,
    preflight,
    endpoint,
    call,
  };
}
