/**
 * URL -> SourceRef (T1).
 *
 * Shared by the CLI, both host adapters and the scan runtime, so every entry point
 * validates the same way: allowed platforms and protocols only, no local/loopback/
 * link-local targets and no path traversal. A rejected input throws before any
 * process is spawned or any paid model call is issued.
 *
 * Nothing here reads configuration, the Vault or the network.
 */

import { OmniWatchError } from "../contracts/errors.ts";
import { legacyHashId } from "../contracts/keys.ts";
import type { Platform, SourceRef } from "../contracts/types.ts";

/** Anything longer is not a URL a person pastes; the cap runs before any regex. */
export const MAX_INPUT_LENGTH = 2048;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TRAILING_SLASHES = /\/+$/;

function invalid(message: string): OmniWatchError {
  return new OmniWatchError("invalid_input", message, {
    action: { label: "sprawdz adres URL", kind: "none" },
  });
}

function isHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function hostName(url: URL): string {
  return url.hostname.toLowerCase().replace(TRAILING_SLASHES, "").replace(/\.$/, "");
}

/**
 * Hosts a local, single-user tool must never fetch: loopback, private ranges,
 * link-local, CGNAT, multicast and unresolved single-label names. A pasted URL is
 * data from the user, and the same string is handed to yt-dlp and ffmpeg later.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map((part) => Number(part));
    if (octets.some((n) => n > 255)) return true;
    const [a, b, c] = octets;
    if (octets.every((n) => n === 0)) return true; // 0.0.0.0/8
    if (a === 10 || a === 127) return true; // private, loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    return a >= 224; // multicast and reserved
  }

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (/^f[cd]/.test(host)) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
    if (host.startsWith("::ffff:")) return isBlockedHost(host.slice(7));
    return false;
  }

  // A single label without a dot is an intranet name, not a public host.
  return !host.includes(".");
}

/** `..` anywhere in the decoded path, including percent-encoded and Windows forms. */
export function hasPathTraversal(pathname: string): boolean {
  let decoded = pathname;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return true; // malformed escape sequence: refuse rather than guess
    }
  }
  if (decoded.includes("\0")) return true;
  return decoded.split(/[/\\]/).some((segment) => segment === ".." || segment === ".");
}

function parseTimeParam(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const [, h, m, s] = match;
  return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
}

/**
 * Platform detection. Facebook/Meta video links are `generic` because the union has
 * no facebook member; only the Ad Library is `meta-ads`, since it names an ad (which
 * then resolves to a material) rather than a playable file.
 */
export function platformFor(url: URL): Platform {
  const host = hostName(url);
  const path = url.pathname.toLowerCase();

  if (isHost(host, "youtube.com") || isHost(host, "youtube-nocookie.com") || host === "youtu.be") {
    return "youtube";
  }
  if (isHost(host, "tiktok.com")) return "tiktok";
  if (isHost(host, "instagram.com") || host === "instagr.am" || isHost(host, "instagr.am")) {
    return "instagram";
  }
  if (isHost(host, "x.com") || isHost(host, "twitter.com")) return "x";
  if ((isHost(host, "facebook.com") || isHost(host, "fb.com") || isHost(host, "meta.com")) && path.includes("/ads/library")) {
    return "meta-ads";
  }
  return "generic";
}

function youTubeId(url: URL): string | null {
  const host = hostName(url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") {
    const id = segments[0] || "";
    return YOUTUBE_ID.test(id) ? id : null;
  }
  const fromQuery = url.searchParams.get("v");
  if (fromQuery && YOUTUBE_ID.test(fromQuery)) return fromQuery;
  const [head, second] = segments;
  if (head && second && ["shorts", "live", "embed", "v", "watch"].includes(head.toLowerCase())) {
    return YOUTUBE_ID.test(second) ? second : null;
  }
  return null;
}

function youTubeCanonical(id: string, url: URL): string {
  const seconds = parseTimeParam(url.searchParams.get("t")) ?? parseTimeParam(url.searchParams.get("start"));
  return seconds === null
    ? `https://www.youtube.com/watch?v=${id}`
    : `https://www.youtube.com/watch?v=${id}&t=${seconds}`;
}

function tiktokId(url: URL): string | null {
  const match = url.pathname.match(/\/(?:video|photo)\/(\d+)/);
  return match ? match[1] : null;
}

function tiktokCanonical(id: string, url: URL): string {
  const handle = url.pathname.match(/^\/(@[\w.-]+)\//)?.[1] ?? "";
  const kind = url.pathname.includes("/photo/") ? "photo" : "video";
  const path = handle ? `/${handle}/${kind}/${id}` : `/${kind}/${id}`;
  // Built via new URL() rather than string concatenation so a missing/extra slash
  // between the host and the path can never collapse the handle into the hostname
  // (that bug sent yt-dlp `https://www.tiktok.com@handle/...`, which resolves the
  // handle as a userinfo/host component and fails DNS resolution).
  return new URL(path, "https://www.tiktok.com").toString();
}

function instagramId(url: URL): string | null {
  const match = url.pathname.match(/\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function instagramCanonical(id: string, url: URL): string {
  const kind = /\/(?:reels?)\//.test(url.pathname) ? "reel" : /\/tv\//.test(url.pathname) ? "tv" : "p";
  return `https://www.instagram.com/${kind}/${id}/`;
}

function xId(url: URL): string | null {
  const match = url.pathname.match(/\/status(?:es)?\/(\d+)/);
  return match ? match[1] : null;
}

function xCanonical(id: string, url: URL): string {
  const handle = url.pathname.split("/").filter(Boolean)[0] || "i";
  return `https://x.com/${handle}/status/${id}`;
}

function metaAdId(url: URL): string | null {
  const id = url.searchParams.get("id");
  if (id && /^\d+$/.test(id)) return id;
  const fromPath = url.pathname.match(/\/(\d{6,})(?:\/|$)/);
  return fromPath ? fromPath[1] : null;
}

/** Origin + path, query and fragment removed, trailing slash trimmed. */
function stripQuery(url: URL): string {
  const path = url.pathname === "/" ? "/" : url.pathname.replace(TRAILING_SLASHES, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Canonical URL: fragments always dropped, trailing slashes normalised, and only the
 * parameters that identify the material kept (YouTube keeps `t`, the Ad Library keeps
 * `id`, the other platforms are identified by their path). Non-YouTube keeps the
 * beta's identity rule (SHA-1 of the canonical URL, first 16 hex chars) so released
 * cache directories stay addressable.
 */
function canonicalUrl(platform: Platform, url: URL, providerId: string | null): string {
  switch (platform) {
    case "youtube":
      return youTubeCanonical(providerId as string, url);
    case "tiktok":
      return providerId ? tiktokCanonical(providerId, url) : stripQuery(url);
    case "instagram":
      return providerId ? instagramCanonical(providerId, url) : stripQuery(url);
    case "x":
      return providerId ? xCanonical(providerId, url) : stripQuery(url);
    case "meta-ads":
      return `https://www.facebook.com/ads/library/?id=${providerId as string}`;
    default:
      return stripQuery(url);
  }
}

function providerIdFor(platform: Platform, url: URL): string | null {
  switch (platform) {
    case "youtube":
      return youTubeId(url);
    case "tiktok":
      return tiktokId(url);
    case "instagram":
      return instagramId(url);
    case "x":
      return xId(url);
    case "meta-ads":
      return metaAdId(url);
    default:
      return null;
  }
}

/**
 * Validate one pasted input and turn it into a stable SourceRef.
 * Throws OmniWatchError("invalid_input") for absent, oversized, non-http,
 * local/private or traversal input.
 */
export function parseSourceUrl(input: unknown): SourceRef {
  if (typeof input !== "string" || input.trim() === "") {
    throw invalid("Podaj adres URL materialu.");
  }
  const raw = input.trim();
  if (raw.length > MAX_INPUT_LENGTH) {
    throw invalid(`Adres URL jest za dlugi (limit ${MAX_INPUT_LENGTH} znakow).`);
  }
  // Checked on the raw text first: the WHATWG parser silently collapses a literal
  // `../` before it reaches the pathname, so the traversal would otherwise be erased
  // rather than rejected.
  if (hasPathTraversal(raw.split(/[?#]/)[0])) {
    throw invalid("Adres zawiera przejscie po sciezce.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("To nie jest poprawny adres URL (oczekiwany http lub https).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid(`Nieobslugiwany protokol: ${url.protocol.replace(":", "")}.`);
  }
  if (isBlockedHost(url.hostname)) {
    throw invalid("Adresy lokalne i prywatne nie sa obslugiwane.");
  }
  if (hasPathTraversal(url.pathname)) {
    throw invalid("Adres zawiera przejscie po sciezce.");
  }

  const platform = platformFor(url);
  const providerId = providerIdFor(platform, url);
  if (platform === "youtube" && !providerId) {
    throw invalid("To nie jest adres pojedynczego filmu YouTube.");
  }
  if (platform === "meta-ads" && !providerId) {
    throw invalid("Brak identyfikatora reklamy w adresie Ad Library.");
  }

  const canonical = canonicalUrl(platform, url, providerId);
  const legacyId = platform === "youtube" ? (providerId as string) : legacyHashId(canonical);
  return {
    platform,
    sourceId: providerId ?? legacyHashId(canonical),
    canonicalUrl: canonical,
    legacyId,
  };
}

/** Non-throwing variant for callers that render their own message. */
export function tryParseSourceUrl(input: unknown): SourceRef | null {
  try {
    return parseSourceUrl(input);
  } catch {
    return null;
  }
}

export function isSupportedSourceUrl(input: unknown): boolean {
  return tryParseSourceUrl(input) !== null;
}
