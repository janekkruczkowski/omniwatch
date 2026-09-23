/**
 * yt-dlp failures, classified once for every shell (R5).
 *
 * The core still never spawns yt-dlp: the host passes its own `run`. What lives here is
 * the part both shells used to get wrong in the same way - a download that failed was
 * reported as the raw tail of yt-dlp's stderr, and nothing told the person whether the
 * film was downloaded, whether the model was called, or what to do next.
 *
 *   - `classifyYtDlpFailure` turns yt-dlp output into one reason
 *     (rate limit, bot check, private, unavailable, geo block, network);
 *   - `runYtDlpResilient` retries ONCE, after a visible wait, when the reason is a
 *     plain rate limit (HTTP 429). A bot check is never retried: repeating the request
 *     from the same address only makes the block last longer;
 *   - `ytDlpCookieArgs` turns the opt-in cookie setting into yt-dlp flags. Off by
 *     default; nothing here reads a browser profile unless the user configured it.
 *
 * Every error thrown here is `source_unavailable`, raised before any upload or paid
 * model call, and its message keeps the raw yt-dlp text after `SOURCE_DETAIL_MARKER`
 * so a UI can show the friendly reason first and the raw output behind "details".
 */

import { OmniWatchError, isOmniWatchError } from "../contracts/errors.ts";

export const SOURCE_FAILURE_REASONS = [
  "rate_limited_by_youtube",
  "rate_limited",
  "bot_check",
  "private",
  "unavailable",
  "geo_blocked",
  "network",
  "unknown",
] as const;
export type SourceFailureReason = (typeof SOURCE_FAILURE_REASONS)[number];

export interface SourceFailure {
  reason: SourceFailureReason;
  /** True only for a plain rate limit: one delayed retry may succeed. */
  retryable: boolean;
}

/** Separates the friendly message from the raw tool output inside an error message. */
export const SOURCE_DETAIL_MARKER = "\n\n--- yt-dlp ---\n";

/** Default wait before the single retry of a rate-limited download. */
export const DEFAULT_YTDLP_RETRY_SECONDS = 30;

/** Environment names of the opt-in cookie setting (documented in the install README). */
export const YTDLP_COOKIES_FROM_BROWSER_ENV = "OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER";
export const YTDLP_COOKIES_FILE_ENV = "OMNIWATCH_YTDLP_COOKIES";
export const YTDLP_RETRY_SECONDS_ENV = "OMNIWATCH_YTDLP_RETRY_SECONDS";

const ERROR_LINE = /^\s*ERROR:.*$/gim;

function isYouTubeText(text: string, url?: string | null): boolean {
  if (url && /(^|\.|\/\/)(youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(url)) return true;
  return /\[youtube[^\]]*\]|youtube/i.test(text);
}

function reasonFor(text: string, youtube: boolean): SourceFailureReason | null {
  // Order matters: a bot check is the final verdict even when a 429 came first (the
  // live QzTkVaC-da4 failure printed both), and it must never be retried.
  // ("Sign in to confirm your age" is an age gate, i.e. `private`, not a bot check.)
  if (/confirm (?:that )?you(?:'|’)?re not a (?:bot|robot)|captcha/i.test(text)) return "bot_check";
  if (/HTTP Error 429|Too Many Requests|rate[- ]limit(?:ed)?(?: reached)?/i.test(text)) {
    return youtube ? "rate_limited_by_youtube" : "rate_limited";
  }
  if (/private video|video is private|this video is private|members[- ]only|join this channel|login required|requires? (?:a )?log ?in|account (?:is )?private|age[- ]restricted|confirm your age|inappropriate for some users/i.test(text)) {
    return "private";
  }
  if (/not (?:made )?available in your country|geo[- ]?restrict|blocked it in your country|not available from your location|uploader has not made this video available in your/i.test(text)) {
    return "geo_blocked";
  }
  if (/video unavailable|this video (?:is|has been) (?:no longer )?(?:unavailable|removed)|has been removed|terminated|does not exist|HTTP Error 404|HTTP Error 410|Unsupported URL|no video formats found|Requested format is not available|not a valid URL|premieres in|live event will begin/i.test(text)) {
    return "unavailable";
  }
  if (/getaddrinfo|Name or service not known|nodename nor servname|Temporary failure in name resolution|Failed to resolve|Network is unreachable|Connection (?:refused|reset|aborted)|timed out|Read timed out|Unable to connect|SSL: |CERTIFICATE_VERIFY_FAILED|Remote end closed connection|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return "network";
  }
  return null;
}

/**
 * One reason for a yt-dlp failure. The final `ERROR:` lines decide first (yt-dlp may
 * warn about a PO token or a 429 and still fail for another reason); the whole output
 * is the fallback.
 */
export function classifyYtDlpFailure(output: unknown, options: { url?: string | null } = {}): SourceFailure {
  const text = typeof output === "string" ? output : output instanceof Error ? output.message : String(output ?? "");
  const youtube = isYouTubeText(text, options.url);
  const errorLines = (text.match(ERROR_LINE) ?? []).join("\n");
  const reason = (errorLines && reasonFor(errorLines, youtube)) || reasonFor(text, youtube) || "unknown";
  return { reason, retryable: reason === "rate_limited_by_youtube" || reason === "rate_limited" };
}

const NO_COST = "Nic nie zostalo wyslane do modelu i nic nie kosztowalo.";
const COOKIES_HINT =
  `albo wlacz pobieranie z ciasteczkami przegladarki (${YTDLP_COOKIES_FROM_BROWSER_ENV}=chrome lub ${YTDLP_COOKIES_FILE_ENV}=<plik cookies.txt>).`;

/** The core's own (Polish, ASCII) sentence for a reason; UIs translate by `reason`. */
export function sourceFailureMessage(reason: SourceFailureReason): string {
  switch (reason) {
    case "rate_limited_by_youtube":
      return `YouTube ogranicza pobieranie z tego komputera (za duzo zapytan, HTTP 429). ${NO_COST} Sprobuj za kilka-kilkanascie minut ${COOKIES_HINT}`;
    case "bot_check":
      return `YouTube zablokowal pobieranie z tego komputera (weryfikacja "nie jestem botem"). ${NO_COST} Sprobuj za kilka-kilkanascie minut ${COOKIES_HINT}`;
    case "rate_limited":
      return `Serwis ogranicza pobieranie z tego komputera (za duzo zapytan). ${NO_COST} Sprobuj ponownie za kilka-kilkanascie minut.`;
    case "private":
      return `Ten material jest prywatny, dla czlonkow albo z ograniczeniem wieku - wymaga zalogowania. ${NO_COST}`;
    case "unavailable":
      return `Material jest niedostepny (usuniety, zablokowany, jeszcze nieopublikowany albo to nie jest adres filmu). ${NO_COST}`;
    case "geo_blocked":
      return `Material jest niedostepny w regionie tego komputera. ${NO_COST}`;
    case "network":
      return `Nie udalo sie polaczyc z serwisem (siec, DNS albo przekroczony czas). ${NO_COST} Sprawdz polaczenie i sprobuj ponownie.`;
    default:
      return `Nie udalo sie pobrac materialu. ${NO_COST}`;
  }
}

/** Raw tool text without the host's own prefix, trimmed to what a person can read. */
function rawDetail(output: string): string {
  return output.replace(/^yt-dlp (?:failed|zakonczyl sie kodem \d+):\s*/i, "").trim().slice(-2000);
}

/** The classified, user-facing error for a failed yt-dlp run. */
export function sourceFailureError(output: unknown, options: { url?: string | null; cause?: unknown } = {}): OmniWatchError {
  const text = typeof output === "string" ? output : output instanceof Error ? output.message : String(output ?? "");
  const failure = classifyYtDlpFailure(text, options);
  const detail = rawDetail(text);
  return new OmniWatchError(
    "source_unavailable",
    `${sourceFailureMessage(failure.reason)}${detail ? `${SOURCE_DETAIL_MARKER}${detail}` : ""}`,
    {
      action: {
        label: failure.reason === "rate_limited_by_youtube" || failure.reason === "bot_check" || failure.reason === "rate_limited"
          ? "sprobuj za kilka-kilkanascie minut"
          : failure.reason === "network" ? "sprawdz polaczenie" : "sprawdz adres materialu",
        kind: "none",
      },
      cause: options.cause ?? output,
    },
  );
}

/** What the read side (poll, SSE, CLI) says about a stored source failure. */
export interface SourceFailureView extends SourceFailure {
  /** Friendly core sentence (Polish); UIs prefer their own translation of `reason`. */
  message: string;
  /** Raw yt-dlp output, for a "details" toggle. Empty when there is none. */
  detail: string;
}

/**
 * Describe a stored `source_unavailable` failure. Works on messages written by this
 * module (friendly text + marker + raw output) and on older raw-only messages, so an
 * operation that failed before this change is still explained when a card re-opens it.
 * Returns null for any other error class.
 */
export function describeSourceFailure(errorClass: unknown, message: unknown): SourceFailureView | null {
  if (errorClass !== "source_unavailable") return null;
  const text = typeof message === "string" ? message : "";
  const at = text.indexOf(SOURCE_DETAIL_MARKER);
  const detail = at >= 0 ? text.slice(at + SOURCE_DETAIL_MARKER.length).trim() : rawDetail(text);
  const failure = classifyYtDlpFailure(at >= 0 ? detail : text);
  return {
    ...failure,
    message: at >= 0 ? text.slice(0, at).trim() : sourceFailureMessage(failure.reason),
    detail,
  };
}

/** A visible wait before the single retry (the shells show "retrying in N s"). */
export interface SourceWait {
  reason: SourceFailureReason;
  seconds: number;
  /** 1 for the first (and only) retry. */
  attempt: number;
}

/** Shared by the calls of one fetch, so a download never retries more than once overall. */
export interface YtDlpRetryBudget {
  remaining: number;
}

export function createYtDlpRetryBudget(retries = 1): YtDlpRetryBudget {
  return { remaining: Math.max(0, Math.floor(retries)) };
}

export interface YtDlpRunOptions<T> {
  /** Runs yt-dlp with these arguments; rejects with an Error whose message has stderr. */
  run: (args: string[]) => Promise<T>;
  url?: string | null;
  /** Seconds before the retry; defaults to `DEFAULT_YTDLP_RETRY_SECONDS`. */
  retrySeconds?: number;
  budget?: YtDlpRetryBudget;
  onWait?: (wait: SourceWait) => void;
  /** Injectable so tests do not wait for real. */
  sleep?: (ms: number) => Promise<void>;
}

// Deliberately NOT unref'd: the wait is the work. A CLI worker whose only other timer
// is an unref'd heartbeat would otherwise exit in the middle of the wait.
const realSleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Run yt-dlp; on a plain rate limit wait once and try again; otherwise (or when the
 * retry fails too) throw the classified `source_unavailable` error.
 */
export async function runYtDlpResilient<T>(args: string[], options: YtDlpRunOptions<T>): Promise<T> {
  const budget = options.budget ?? createYtDlpRetryBudget(1);
  const sleep = options.sleep ?? realSleep;
  const seconds = Math.max(0, Math.round(options.retrySeconds ?? DEFAULT_YTDLP_RETRY_SECONDS));
  let attempt = 0;
  for (;;) {
    try {
      return await options.run(args);
    } catch (error) {
      if (isOmniWatchError(error)) throw error;
      const failure = classifyYtDlpFailure(error, { url: options.url });
      if (!failure.retryable || budget.remaining <= 0) {
        throw sourceFailureError(error, { url: options.url, cause: error });
      }
      budget.remaining -= 1;
      attempt += 1;
      try {
        options.onWait?.({ reason: failure.reason, seconds, attempt });
      } catch {
        // A progress listener must never turn a retry into a failure.
      }
      await sleep(seconds * 1000);
    }
  }
}

/** Retry wait from the environment, clamped to something a person will wait through. */
export function ytDlpRetrySeconds(env: Record<string, string | undefined> = {}): number {
  const raw = Number(env[YTDLP_RETRY_SECONDS_ENV]);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_YTDLP_RETRY_SECONDS;
  return Math.min(120, Math.round(raw));
}

/**
 * yt-dlp cookie flags from the opt-in setting. Empty unless configured: reading a
 * browser's cookies needs the user's consent, so nothing is inferred or defaulted.
 * `OMNIWATCH_YTDLP_COOKIES` (a Netscape cookies.txt path) wins over the browser form,
 * because it is the narrower permission.
 */
export function ytDlpCookieArgs(env: Record<string, string | undefined> = {}): string[] {
  const file = String(env[YTDLP_COOKIES_FILE_ENV] ?? "").trim();
  if (file && !file.startsWith("-")) return ["--cookies", file];
  const browser = String(env[YTDLP_COOKIES_FROM_BROWSER_ENV] ?? "").trim();
  // yt-dlp's own syntax: BROWSER[+KEYRING][:PROFILE][::CONTAINER]. Arguments are passed
  // as an array (no shell), the pattern only keeps a flag-looking value out.
  if (browser && /^[A-Za-z][\w.-]*(\+[\w.-]+)?(:[^\n]*)?$/.test(browser)) return ["--cookies-from-browser", browser];
  return [];
}
