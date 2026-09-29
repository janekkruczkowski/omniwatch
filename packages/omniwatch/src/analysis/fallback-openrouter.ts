/**
 * Google Gemini fallback over OpenRouter (R6).
 *
 * DashScope's inspection sometimes refuses a harmless video with `DataInspectionFailed`
 * (HTTP 400, code `data_inspection_failed`) before the model runs. That refusal is not
 * billed and is deterministic for the same bytes, so the SAME call (same prompt, same
 * part) is handed straight to Gemini 3.8 Flash through OpenRouter: the same
 * OpenAI-compatible dialect, a different vendor's filter. Other parts stay on Qwen.
 *
 * OpenRouter cannot read DashScope `oss://` uploads, so every media part is inlined as a
 * base64 data URL built from the LOCAL file the split produced
 * (`{"type":"video_url","video_url":{"url":"data:video/mp4;base64,..."}}`, the shape
 * OpenRouter documents for Gemini). An inline request has a practical size ceiling, so a
 * part above `maxInlineBytes` is first shrunk by the host (`shrinkMedia`, ffmpeg: 1 fps,
 * 360p, mono audio - Gemini samples video at 1 fps anyway). A part that is still too big
 * is reported, never silently truncated.
 *
 * Configuration mirrors the primary provider and is env-driven:
 *   - OMNIWATCH_FALLBACK_MODEL     default `google/gemini-3.8-flash`; only Gemini 3.8 or
 *                                  newer is accepted, an older Gemini is replaced by the
 *                                  default (never an older model);
 *   - OMNIWATCH_FALLBACK_API_BASE  default `https://openrouter.ai/api/v1`;
 *   - OMNIWATCH_FALLBACK_API_KEY   falls back to OPENROUTER_API_KEY. No key = no fallback.
 */

import { OmniWatchError } from "../contracts/errors.ts";
import { chatCompletionsUrl } from "../contracts/endpoints.ts";
import type { ModelCallRequest, ModelCallResponse } from "../contracts/ports.ts";
import type { MediaPart } from "../contracts/types.ts";
import {
  buildMessagePayload,
  classifyHttpFailure,
  errorCodeOf,
  mapUsage,
  NOT_SENT_CODES,
  readCompletionStream,
  signalResponseStarted,
  transportDiagnostic,
  type TimerPort,
} from "./openai-transport.ts";

/** The default (and minimum) fallback model; never an older Gemini. */
export const OPENROUTER_FALLBACK_MODEL = "google/gemini-3.8-flash";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export const OPENROUTER_CHAT_URL = `${OPENROUTER_API_BASE}/chat/completions`;
/** Env var holding the OpenRouter key when OMNIWATCH_FALLBACK_API_KEY is not set. */
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
export const FALLBACK_KEY_ENV = "OMNIWATCH_FALLBACK_API_KEY";
export const FALLBACK_MODEL_ENV = "OMNIWATCH_FALLBACK_MODEL";
export const FALLBACK_BASE_ENV = "OMNIWATCH_FALLBACK_API_BASE";
/**
 * Raw bytes of all media in one fallback request. Base64 adds a third, so this keeps
 * the JSON body near 24 MB - inside what OpenRouter/Gemini accept inline.
 */
export const DEFAULT_MAX_INLINE_BYTES = 18 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_MS = 120_000;

export interface FallbackSettings {
  model: string;
  apiBase: string;
  apiKey: string | null;
}

/** The one place that decides whether a part is an image or a video, from its file. */
export function mediaKindFor(localPath: string): "image" | "video" {
  return /\.(?:jpe?g|png|webp|gif|bmp|heic|avif)$/i.test(localPath) ? "image" : "video";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** True only for a Gemini model at version 3.8 or newer (`google/gemini-3.8-flash`, `gemini-4.0-pro`...). */
export function isAllowedFallbackModel(model: string): boolean {
  const match = /(?:^|\/)gemini-(\d+)\.(\d+)/i.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 8);
}

export function openRouterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return nonEmpty(env[FALLBACK_KEY_ENV]) ?? nonEmpty(env[OPENROUTER_KEY_ENV]);
}

export function fallbackSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): FallbackSettings {
  const configured = nonEmpty(env[FALLBACK_MODEL_ENV]);
  return {
    model: configured && isAllowedFallbackModel(configured) ? configured : OPENROUTER_FALLBACK_MODEL,
    apiBase: nonEmpty(env[FALLBACK_BASE_ENV]) ?? OPENROUTER_API_BASE,
    apiKey: openRouterKeyFromEnv(env),
  };
}

export interface OpenRouterFallbackOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Resolved key. A missing key means "do not fall back" and the caller throws instead. */
  apiKey: string | null;
  /** Defaults to OPENROUTER_FALLBACK_MODEL; an older Gemini is never used. */
  model?: string;
  /** Defaults to OPENROUTER_API_BASE. */
  apiBase?: string;
  /** Reads the local part file. Injected in tests so no real media is needed. */
  readMediaBytes?: (localPath: string) => Promise<Uint8Array>;
  /** Size of a local file; defaults to fs.stat. */
  fileSize?: (localPath: string) => Promise<number>;
  /**
   * Host re-encode of a part that is too big to inline (ffmpeg lives in the host, not
   * the core). Returns the path of a smaller file, or null when it cannot shrink.
   */
  shrinkMedia?: (part: MediaPart, maxBytes: number) => Promise<string | null>;
  maxInlineBytes?: number;
  timers: TimerPort;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputTokens?: number;
}

async function defaultReadMediaBytes(localPath: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return readFile(localPath);
}

async function defaultFileSize(localPath: string): Promise<number> {
  const { stat } = await import("node:fs/promises");
  return (await stat(localPath)).size;
}

function partLabel(request: ModelCallRequest): string {
  const indexes = request.mediaParts.map((part) => part.index + 1);
  return indexes.length ? indexes.join(", ") : String(request.partIndex + 1);
}

/**
 * The media parts as base64 data URLs. The sampling rate is NOT sent: OpenRouter's
 * `video_url` part has no `fps` field. Gemini samples the inlined video on its own.
 */
async function dataUrlParts(
  request: ModelCallRequest,
  options: OpenRouterFallbackOptions,
): Promise<Array<Record<string, unknown>>> {
  const read = options.readMediaBytes ?? defaultReadMediaBytes;
  const sizeOf = options.fileSize ?? (options.readMediaBytes ? null : defaultFileSize);
  const budget = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const perPart = Math.floor(budget / Math.max(1, request.mediaParts.length));
  const parts: Array<Record<string, unknown>> = [];
  for (const part of request.mediaParts) {
    let path = part.localPath;
    let bytes: Uint8Array;
    try {
      const size = sizeOf ? await sizeOf(path) : null;
      if (size !== null && size > perPart && mediaKindFor(path) === "video" && options.shrinkMedia) {
        path = (await options.shrinkMedia(part, perPart)) ?? path;
      }
      bytes = await read(path);
      if (bytes.byteLength > perPart && path === part.localPath && mediaKindFor(path) === "video" && options.shrinkMedia) {
        const smaller = await options.shrinkMedia(part, perPart);
        if (smaller) {
          path = smaller;
          bytes = await read(path);
        }
      }
    } catch (error) {
      // The local file could not be read or shrunk: nothing was sent, nothing billed.
      throw new OmniWatchError(
        "source_unavailable",
        `Nie mozna przygotowac czesci ${part.index + 1} dla modelu zapasowego (${errorCodeOf(error) || "read"}).`,
        { action: { label: "sprobuj ponownie", kind: "check_operation" }, cause: error },
      );
    }
    if (bytes.byteLength > perPart) {
      throw new OmniWatchError(
        "content_filtered",
        `Filtr treści Qwen odrzucił część ${part.index + 1}, a jest ona za duża dla modelu zapasowego Gemini `
          + `(${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB > ${(perPart / 1024 / 1024).toFixed(0)} MB).`,
        { action: { label: "sprobuj ponownie", kind: "check_operation" } },
      );
    }
    const kind = mediaKindFor(path);
    const mime = kind === "image" ? "image/jpeg" : "video/mp4";
    const url = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    parts.push(kind === "image"
      ? { type: "image_url", image_url: { url } }
      : { type: "video_url", video_url: { url } });
  }
  return parts;
}

/**
 * One Gemini call for the same request. Returns null only when there is no key — the
 * caller then reports the original refusal with `fallbackNotConfiguredError`.
 */
export async function callOpenRouterFallback(
  request: ModelCallRequest,
  options: OpenRouterFallbackOptions,
): Promise<ModelCallResponse | null> {
  const key = options.apiKey;
  if (!key) return null;

  const model = options.model && isAllowedFallbackModel(options.model) ? options.model : OPENROUTER_FALLBACK_MODEL;
  const url = chatCompletionsUrl(options.apiBase ?? OPENROUTER_API_BASE);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timers = options.timers;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;

  const controller = new AbortController();
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

  const messages = buildMessagePayload(request.messages, await dataUrlParts(request, options));
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // OpenRouter reports the call's real price in `usage.cost` when asked.
    usage: { include: true },
    max_tokens: request.maxOutputTokens ?? options.maxOutputTokens,
  };

  const startedAt = Date.now();
  if (timeoutMs) deadline = timers.setTimeout(() => { abortSource = "deadline"; controller.abort(); }, timeoutMs);
  armIdle();

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // OpenRouter attribution headers; non-secret and documented.
        "HTTP-Referer": "https://omniwatch.local",
        "X-Title": "OmniWatch",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimers();
    const code = errorCodeOf(error);
    if (NOT_SENT_CODES.has(code)) {
      throw new OmniWatchError("provider_rejected", `Nie udalo sie wyslac czesci ${partLabel(request)} do modelu zapasowego (${code}).`, {
        action: { label: "sprawdz polaczenie", kind: "check_operation" },
        cause: error,
        transportPhase: "not_sent",
      });
    }
    const detail = transportDiagnostic(error, "headers", abortSource, Date.now() - startedAt);
    throw new OmniWatchError("outcome_unknown", `Polaczenie z modelem zapasowym przerwane; nie wiadomo, czy wywolanie doszlo do skutku. (${detail})`, {
      action: { label: "sprawdz operacje", kind: "check_operation" },
      cause: error,
      ...(abortSource === "none" ? { transportPhase: "headers" as const } : {}),
    });
  }

  signalResponseStarted(request);

  if (!response.ok) {
    clearTimers();
    const detail = await response.text().catch(() => "");
    const failure = classifyHttpFailure(response.status, detail);
    // Name the fallback in the message: the user must see that Qwen refused the part
    // AND Gemini failed too, not a bare "400".
    throw new OmniWatchError(failure.errorClass,
      `Filtr treści Qwen odrzucił część ${partLabel(request)}; model zapasowy ${model} też nie odpowiedział: ${failure.message}`, {
        action: failure.errorClass === "provider_rejected"
          ? { label: "sprobuj ponownie", kind: "check_operation" }
          : failure.action,
      });
  }

  // Headers arrived: from here on only inactivity ends the call.
  if (deadline) {
    timers.clearTimeout(deadline);
    deadline = null;
  }

  // Gemini answers with the same SSE format. Its cost is whatever OpenRouter reports:
  // the host's DashScope price list must not be applied to another vendor's model, so no
  // `costForUsage` here. No reported cost means an unknown cost, never zero.
  const result = await readCompletionStream(response, {
    onActivity: armIdle,
    onSettled: clearTimers,
    abortSource: () => abortSource,
    startedAt: () => startedAt,
    mapUsage: (raw) => mapUsage(raw),
  });
  return { ...result, model };
}

/** The refusal reported when Qwen's filter refused a part and no fallback key is set. */
export function fallbackNotConfiguredError(request: ModelCallRequest): OmniWatchError {
  return new OmniWatchError(
    "content_filtered",
    `Filtr treści Qwen (DashScope, DataInspectionFailed) odrzucił część ${partLabel(request)} filmu, `
      + `a zapasowy model Gemini nie jest skonfigurowany (ustaw ${OPENROUTER_KEY_ENV} lub ${FALLBACK_KEY_ENV}).`,
    { action: { label: "skonfiguruj model zapasowy", kind: "fix_config" } },
  );
}

/**
 * ffmpeg arguments for a fallback-sized copy of a part: 1 fps (Gemini's own sampling
 * rate), at most `height` px tall, mono speech-grade audio. Timestamps are kept, so the
 * notes still line up with the part.
 */
export function fallbackShrinkArgs(input: string, output: string, height: number, crf: number): string[] {
  return [
    "-y", "-loglevel", "error",
    "-i", input,
    "-vf", `fps=1,scale=-2:'min(${height},ih)'`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ac", "1", "-b:a", "48k",
    "-movflags", "+faststart",
    output,
  ];
}

/**
 * A `shrinkMedia` for hosts that own ffmpeg (the core never spawns it): two steps,
 * 360p then 240p, each written next to the part as `<part>.fallback-<h>p.mp4` and
 * reused if already there. Returns the first copy that fits, or null.
 */
export function createFfmpegShrinker(
  run: (cmd: string, args: string[]) => Promise<unknown>,
  fileSize: (path: string) => Promise<number> = defaultFileSize,
): (part: MediaPart, maxBytes: number) => Promise<string | null> {
  return async (part, maxBytes) => {
    for (const [height, crf] of [[360, 32], [240, 38]] as const) {
      const output = part.localPath.replace(/\.[^./]+$/, "") + `.fallback-${height}p.mp4`;
      let size: number | null = null;
      try {
        size = await fileSize(output);
      } catch {
        await run("ffmpeg", fallbackShrinkArgs(part.localPath, output, height, crf));
        size = await fileSize(output);
      }
      if (size <= maxBytes) return output;
    }
    return null;
  };
}
