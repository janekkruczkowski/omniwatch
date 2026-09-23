/**
 * Compatibility with the released Python beta (T1).
 *
 * Three jobs, all of them about reading beta data without rewriting it:
 *   - `info.json` metadata normalisation (the beta wrote yt-dlp field names);
 *   - the legacy non-YouTube identity (SHA-1 of the canonical URL, first 16 hex);
 *   - `oss.json` upload freshness, where `at` is in SECONDS, not milliseconds.
 *
 * Nothing here mutates a legacy file. The adapter decides what to do with a verdict.
 */

import { OmniWatchError } from "../contracts/errors.ts";
import { legacyHashId } from "../contracts/keys.ts";
import type { SourceRef } from "../contracts/types.ts";
import { parseSourceUrl } from "./url.ts";

/**
 * The `oss://` upload TTL of the released Python beta (`OSS_TTL = 47 * 3600`): the
 * provider keeps an upload for 48 h and the beta refreshed it an hour early. It is a
 * property of the provider, not of the local cache, so `OMNI_CACHE_HOURS` (the local
 * video cache window) never changes it - a longer cache must not send an expired
 * `oss://` URL to the model (QA R2 M2).
 */
export const BETA_OSS_TTL_HOURS = 47;

/** yt-dlp's metadata keys and the TypeScript names the core uses. */
export interface LegacyVideoInfo {
  id: string;
  title: string;
  /** yt-dlp `channel`, falling back to `uploader`. */
  channel: string;
  duration: number;
  /** yt-dlp `extractor_key`. */
  extractor: string;
  publishedAt?: string | null;
  /** Preserved raw value so a re-written file can keep the beta's own field. */
  uploader?: string | null;
  /** Preserved raw value so a re-written file can keep the beta's own field. */
  extractorKey?: string | null;
}

export interface LegacyUploadEntry {
  url?: unknown;
  at?: unknown;
}

export type UploadFreshnessReason = "fresh" | "expired" | "future" | "malformed";

export interface UploadFreshness {
  valid: boolean;
  reason: UploadFreshnessReason;
  /** Age in seconds; null when `at` could not be read. */
  ageSeconds: number | null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Normalise beta `info.json`. `channel` wins over `uploader`; `extractor_key` becomes
 * `extractor`. Missing values degrade to safe defaults instead of throwing, because a
 * half-written cache entry must not destroy neighbouring analyses.
 */
export function normalizeLegacyInfo(raw: unknown): LegacyVideoInfo {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OmniWatchError("invalid_input", "Nieczytelny wpis info.json w cache bety.", {
      action: { label: "sprawdz katalog cache", kind: "none" },
    });
  }
  const record = raw as Record<string, unknown>;
  const channel = str(record.channel) ?? str(record.uploader) ?? "";
  const extractor = str(record.extractor_key) ?? str(record.extractor) ?? "";
  const duration = num(record.duration) ?? 0;
  const publishedAt = str(record.upload_date) ?? str(record.publishedAt) ?? null;
  const id = str(record.id) ?? "";
  const title = str(record.title) ?? (id || "?");
  return {
    id,
    title,
    channel,
    duration: Math.max(0, Math.round(duration)),
    extractor,
    publishedAt,
    uploader: str(record.uploader),
    extractorKey: str(record.extractor_key),
  };
}

/** Non-throwing variant for scanning a cache directory with mixed contents. */
export function tryNormalizeLegacyInfo(raw: unknown): LegacyVideoInfo | null {
  try {
    return normalizeLegacyInfo(raw);
  } catch {
    return null;
  }
}

export function parseLegacyInfoJson(text: string): LegacyVideoInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OmniWatchError("invalid_input", "Plik info.json bety nie jest poprawnym JSON.", {
      action: { label: "sprawdz katalog cache", kind: "none" },
    });
  }
  return normalizeLegacyInfo(parsed);
}

/**
 * The id the beta would have used for this material: the YouTube video id, or the
 * first 16 hex characters of SHA-1 over the canonical URL (beta `cacheKey`).
 * Accepts a URL or an already-resolved SourceRef.
 */
export function resolveLegacyId(input: string | SourceRef): string {
  if (typeof input !== "string") {
    return input.legacyId ?? legacyHashId(input.canonicalUrl);
  }
  const source = parseSourceUrl(input);
  return source.legacyId ?? legacyHashId(source.canonicalUrl);
}

/**
 * Is a beta `oss.json` upload entry still reusable?
 *
 * `at` is in SECONDS (the beta wrote `Date.now()`-style millisecond values nowhere in
 * this file, but a value in the millions of millions is a millisecond value that leaked
 * into a seconds field; it is treated as malformed rather than silently reinterpreted).
 * The TTL is an explicit argument so the rule stays testable; every runtime caller
 * passes `BETA_OSS_TTL_HOURS` (47 h, the beta's `OSS_TTL`) and never the local
 * `OMNI_CACHE_HOURS` window, which describes the local files, not the provider copy.
 *
 * A timestamp in the future is never fresh: a clock skew or a corrupted file must not
 * pin a stale upload for as long as the clock is wrong.
 */
export function evaluateUploadFreshness(
  entry: LegacyUploadEntry | null | undefined,
  /** Upload TTL in hours; null/undefined means the beta constant `BETA_OSS_TTL_HOURS`. */
  cacheHours: number | null | undefined,
  nowSeconds: number,
): UploadFreshness {
  if (!entry || typeof entry !== "object") {
    return { valid: false, reason: "malformed", ageSeconds: null };
  }
  const at = num(entry.at);
  const ttlHours = num(cacheHours) ?? BETA_OSS_TTL_HOURS;
  if (at === null || ttlHours === null || ttlHours <= 0 || !Number.isFinite(nowSeconds)) {
    return { valid: false, reason: "malformed", ageSeconds: null };
  }
  const ageSeconds = nowSeconds - at;
  if (ageSeconds < 0) return { valid: false, reason: "future", ageSeconds };
  const ttlSeconds = ttlHours * 3600;
  // Strictly less than the TTL: the boundary itself is stale.
  return ageSeconds < ttlSeconds
    ? { valid: true, reason: "fresh", ageSeconds }
    : { valid: false, reason: "expired", ageSeconds };
}

export function isUploadFresh(
  entry: LegacyUploadEntry | null | undefined,
  cacheHours: number | null | undefined,
  nowSeconds: number,
): boolean {
  return evaluateUploadFreshness(entry, cacheHours, nowSeconds).valid;
}
