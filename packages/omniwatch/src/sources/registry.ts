/**
 * SourcePort implementation with injected adapters (T1).
 *
 * The core never spawns yt-dlp, ffmpeg or an Apify actor itself: it receives a
 * `MediaToolPort` (download, probe, slice) and per-platform `ListerPort`s. Tests pass
 * stubs, so a source test needs no network, no ffmpeg and no API key.
 *
 * `capabilities()` is the honesty surface: YouTube enumerates a whole channel for
 * free, Instagram is the "25 ostatnich" window and nothing more, X and Meta Ads
 * listing is billed and needs an explicit start, TikTok is a recent-items list.
 */

import { OmniWatchError, isOmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import type {
  ListingPage,
  MediaInfo,
  MediaPart,
  Platform,
  SourceCapabilities,
  SourceRef,
} from "../contracts/types.ts";
import type { SourcePort } from "../contracts/ports.ts";
import { BETA_OSS_TTL_HOURS, evaluateUploadFreshness } from "./legacy.ts";
import type { LegacyUploadEntry } from "./legacy.ts";
import { splitParts } from "./media.ts";
import { parseSourceUrl } from "./url.ts";
import {
  DEFAULT_CACHE_QUOTA_BYTES,
  DEFAULT_MIN_FREE_BYTES,
  MediaLeaseRegistry,
  assertDiskSpace,
  enforceMediaCacheQuota,
  toDiskSpacePausedError,
} from "./mediaCache.ts";
import type { DiskSpacePort, MediaCachePort } from "./mediaCache.ts";

export interface PreparedMedia {
  localPath: string;
  title?: string | null;
  channel?: string | null;
  durationSeconds?: number | null;
  extractor?: string | null;
  publishedAt?: string | null;
}

export interface MediaSliceInput {
  localPath: string;
  startSeconds: number;
  endSeconds: number;
  index: number;
  count: number;
}

/**
 * Everything the core needs from the host's media tooling. Implementations may use
 * yt-dlp/ffmpeg, a prepared fixture or a stub; the contract is the same.
 */
export interface MediaToolPort {
  /** Cached media without touching the network; null when nothing is cached. */
  cached(source: SourceRef): Promise<PreparedMedia | null>;
  /** Download + probe. Must not call a paid model provider. */
  fetch(source: SourceRef): Promise<PreparedMedia>;
  /** ffprobe-style fallback when the extractor reported no duration. */
  probeDuration?(localPath: string): Promise<number>;
  /** Raw beta upload metadata (`oss.json`) for the prepared file. */
  readUploads?(source: SourceRef): Promise<Record<string, LegacyUploadEntry> | null>;
  /** ffmpeg-style slice; only called when the plan has more than one part. */
  slice(input: MediaSliceInput): Promise<string>;
}

export interface ListerPort {
  list(source: SourceRef, options: { cursor?: string | null; limit?: number }): Promise<ListingPage>;
}

export interface SourceAdapterBundle {
  media: MediaToolPort;
  listers?: Partial<Record<Platform, ListerPort>>;
  /**
   * Local media cache window in hours (`OMNI_CACHE_HOURS`). It does NOT drive the
   * `oss://` upload TTL: the provider keeps an upload for 48 h and the beta refreshed
   * it an hour early, so upload freshness is the fixed `BETA_OSS_TTL_HOURS` (QA R2 M2).
   */
  cacheHours?: () => number;
  /** Seconds since epoch; injectable so freshness tests are deterministic. */
  now?: () => number;
  defaultCacheHours?: number;
  /** Media cache directory listing/removal (T18); omit to skip quota eviction entirely. */
  mediaCache?: MediaCachePort;
  /** Size budget for `mediaCache`; defaults to `DEFAULT_CACHE_QUOTA_BYTES`. */
  cacheQuotaBytes?: number;
  /** `statfs`-style free-space reader (T18); omit to skip the pre-fetch disk gate. */
  diskSpace?: DiskSpacePort;
  /** Directory a fetch writes into, for the disk-space gate. Required with `diskSpace`. */
  cacheDir?: (source: SourceRef) => string | null;
  /** Minimum free bytes required before a fetch; defaults to `DEFAULT_MIN_FREE_BYTES`. */
  minFreeBytes?: number;
}

/** Honest, per-platform capability matrix (D8). */
export function capabilitiesFor(platform: Platform): SourceCapabilities {
  switch (platform) {
    case "youtube":
      return {
        platform,
        singleVideo: true,
        listing: "full",
        listingScopeNote: null,
        pagination: true,
        listingCost: "free",
        requiresConfig: [],
      };
    case "tiktok":
      return {
        platform,
        singleVideo: true,
        listing: "limited",
        listingScopeNote: "ostatnie materialy z profilu (bez pelnego archiwum)",
        pagination: false,
        listingCost: "free",
        requiresConfig: [],
      };
    case "instagram":
      return {
        platform,
        singleVideo: true,
        listing: "limited",
        listingScopeNote: "25 ostatnich",
        pagination: false,
        listingCost: "paid",
        requiresConfig: ["APIFY_TOKEN"],
      };
    case "x":
      return {
        platform,
        singleVideo: true,
        listing: "limited",
        listingScopeNote: "ostatnie posty z materialem wideo; listowanie jest platne i wymaga jawnego startu",
        pagination: true,
        listingCost: "paid",
        requiresConfig: ["APIFY_TOKEN"],
      };
    case "meta-ads":
      return {
        platform,
        singleVideo: true,
        listing: "limited",
        listingScopeNote: "Ad Library; listowanie jest platne i wymaga jawnego startu",
        pagination: true,
        listingCost: "paid",
        requiresConfig: ["APIFY_TOKEN"],
      };
    default:
      return {
        platform,
        singleVideo: true,
        listing: "none",
        listingScopeNote: null,
        pagination: false,
        listingCost: "free",
        requiresConfig: [],
      };
  }
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

export function createSourceRegistry(adapters: SourceAdapterBundle): SourcePort {
  // Tracks the local path a `prepare()` is currently reading/writing, so a quota
  // sweep triggered by another call in the same process never evicts it (T18).
  const leases = new MediaLeaseRegistry();
  const cacheQuotaBytes = adapters.cacheQuotaBytes ?? DEFAULT_CACHE_QUOTA_BYTES;
  const minFreeBytes = adapters.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;

  /** Best-effort quota sweep after a successful fetch; never throws into the caller. */
  async function sweepCacheQuota(): Promise<void> {
    if (!adapters.mediaCache) return;
    try {
      await enforceMediaCacheQuota(adapters.mediaCache, cacheQuotaBytes, leases);
    } catch {
      // Housekeeping failure must not fail the operation that just succeeded; the
      // next successful fetch retries the sweep.
    }
  }

  const nowSeconds = (): number => {
    const value = adapters.now?.();
    return typeof value === "number" && Number.isFinite(value) ? value : Math.floor(Date.now() / 1000);
  };

  /**
   * Reuse an upload only inside the provider's own lifetime: the fixed 47 h beta TTL.
   * A longer `OMNI_CACHE_HOURS` keeps the local file longer, but must never send an
   * `oss://` URL the provider has already expired (QA R2 M2).
   */
  async function applyUploadState(source: SourceRef, info: MediaInfo): Promise<MediaInfo> {
    if (!adapters.media.readUploads || !info.localPath) return info;
    const uploads = await adapters.media.readUploads(source);
    const entry = uploads?.[baseName(info.localPath)];
    const verdict = evaluateUploadFreshness(entry ?? null, BETA_OSS_TTL_HOURS, nowSeconds());
    const url = entry && typeof entry.url === "string" ? entry.url : null;
    if (verdict.valid && url) {
      return { ...info, uploadedUrl: url, reusedUpload: true };
    }
    return { ...info, uploadedUrl: null, reusedUpload: false };
  }

  async function mediaInfoFor(source: SourceRef, prepared: PreparedMedia): Promise<MediaInfo> {
    let duration = typeof prepared.durationSeconds === "number" && Number.isFinite(prepared.durationSeconds)
      ? Math.max(0, Math.round(prepared.durationSeconds))
      : 0;
    if (!duration && adapters.media.probeDuration) {
      const probed = await adapters.media.probeDuration(prepared.localPath);
      if (typeof probed === "number" && Number.isFinite(probed) && probed > 0) {
        duration = Math.max(0, Math.round(probed));
      }
    }
    const info: MediaInfo = {
      sourceRef: source,
      title: prepared.title || source.sourceId,
      channel: prepared.channel ?? null,
      durationSeconds: duration,
      extractor: prepared.extractor || "generic",
      publishedAt: prepared.publishedAt ?? null,
      localPath: prepared.localPath,
      uploadedUrl: null,
      reusedUpload: false,
    };
    return applyUploadState(source, info);
  }

  return {
    capabilities(source: SourceRef): SourceCapabilities {
      return capabilitiesFor(source.platform);
    },

    async resolve(input: { url: string }): Promise<SourceRef> {
      return parseSourceUrl(input.url);
    },

    async prepare(source: SourceRef, options?: { force?: boolean }): Promise<MediaInfo> {
      try {
        if (!options?.force) {
          const cached = await adapters.media.cached(source);
          if (cached) {
            // Lease the cached path while reading it, so a concurrent quota sweep
            // (triggered by another `prepare()` finishing at the same time) never
            // evicts the file this call is actively returning (T18).
            return await leases.withLease(cached.localPath, () => mediaInfoFor(source, cached));
          }
        }

        // Disk-space gate (T18): refuse to start a fetch that would write into a
        // full disk. This runs before any paid call and never touches existing
        // cache files; it only decides whether the fetch may start.
        if (adapters.diskSpace) {
          const dir = adapters.cacheDir?.(source) ?? null;
          if (dir) await assertDiskSpace(adapters.diskSpace, dir, minFreeBytes);
        }

        const fetched = await adapters.media.fetch(source);
        const info = await leases.withLease(fetched.localPath, () => mediaInfoFor(source, fetched));
        await sweepCacheQuota();
        return info;
      } catch (error) {
        const diskPaused = toDiskSpacePausedError(error);
        if (diskPaused) throw diskPaused;
        throw toOmniWatchError(error, "source_unavailable");
      }
    },

    async split(info: MediaInfo, options: { maxFramesPerPart: number }): Promise<MediaPart[]> {
      try {
        return await splitParts(info, { maxFramesPerPart: options.maxFramesPerPart }, (request) =>
          adapters.media.slice(request),
        );
      } catch (error) {
        throw toOmniWatchError(error, "source_unavailable");
      }
    },

    async list(source: SourceRef, options: { cursor?: string | null; limit?: number }): Promise<ListingPage> {
      const caps = capabilitiesFor(source.platform);
      const lister = adapters.listers?.[source.platform];
      if (!lister || caps.listing === "none") {
        throw new OmniWatchError("invalid_input", `Zrodlo ${source.platform} nie udostepnia listowania.`, {
          action: { label: "wybierz pojedynczy material", kind: "none" },
        });
      }
      try {
        return await lister.list(source, options);
      } catch (error) {
        throw toOmniWatchError(error, "incomplete_listing");
      }
    },
  };
}

export type PrepareOutcome =
  | { ok: true; source: SourceRef; info: MediaInfo }
  | { ok: false; source: SourceRef; error: OmniWatchError };

/**
 * Prepare a batch without letting one bad material destroy the others (F9/A7).
 * Listing-level failures still stop the caller; per-item failures are values here.
 */
export async function prepareMany(
  source: SourcePort,
  sources: SourceRef[],
  options?: { force?: boolean },
): Promise<PrepareOutcome[]> {
  const results: PrepareOutcome[] = [];
  for (const ref of sources) {
    try {
      results.push({ ok: true, source: ref, info: await source.prepare(ref, options) });
    } catch (error) {
      // An already-classified failure (e.g. registry.prepare's own budget_paused)
      // is kept as-is. Otherwise, an out-of-disk-space failure — however the
      // SourcePort implementation surfaces it — is a pause, not a per-item
      // failure: it says nothing about this particular material and will not be
      // fixed by moving on to the next one (T18). Every other error keeps the
      // existing per-item fallback.
      if (isOmniWatchError(error)) {
        results.push({ ok: false, source: ref, error });
        continue;
      }
      const diskPaused = toDiskSpacePausedError(error);
      results.push({ ok: false, source: ref, error: diskPaused ?? toOmniWatchError(error, "source_unavailable") });
    }
  }
  return results;
}
