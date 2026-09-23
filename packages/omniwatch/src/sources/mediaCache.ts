/**
 * Media cache quota + disk-space pause (T18, QA gap: cache quota + active-file
 * protection, and "no space -> pause, active data intact").
 *
 * Same injected-adapter shape as the rest of `sources/` (T1): the core never
 * touches the filesystem directly. A `MediaCachePort` lists what a host's media
 * cache holds on disk and removes an entry; a `DiskSpacePort` reports free bytes
 * for a directory (a thin wrapper around `statfs`). This keeps both the eviction
 * policy and the disk-space gate testable with stub sizes, never real large files.
 *
 * TECHNICAL.md's D3 (durable state, 48h-class retention) motivates a size-bounded
 * cache instead of an unbounded one: the retention window keeps entries fresh long
 * enough to be reused, but nothing here assumes disk is infinite. Two rules only:
 *   1. quota eviction always removes the oldest-unused entry first;
 *   2. an entry an in-flight operation is actively using (leased) is never
 *      evicted, even if that means staying over quota.
 */

import { OmniWatchError } from "../contracts/errors.ts";

export interface MediaCacheEntry {
  /** Cache identity key; typically the local file path. */
  path: string;
  sizeBytes: number;
  /** Last time this entry was used for anything other than eviction bookkeeping, ms epoch. */
  lastUsedAt: number;
}

/** What the core needs from the host's media cache directory. */
export interface MediaCachePort {
  list(): Promise<MediaCacheEntry[]> | MediaCacheEntry[];
  remove(path: string): Promise<void> | void;
}

/** What the core needs from the host's filesystem to gate on free space. */
export interface DiskSpacePort {
  /** Free bytes on the filesystem backing `dir` (a `statfs`-style read). */
  freeBytes(dir: string): Promise<number> | number;
}

/** Generous single-user default: a cache under this size is never touched. */
export const DEFAULT_CACHE_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;

/** Default minimum free space required before a fetch/prepare that writes to disk. */
export const DEFAULT_MIN_FREE_BYTES = 1 * 1024 * 1024 * 1024;

/**
 * Lease/refcount registry: paths an in-flight prepare/fetch is actively reading or
 * writing. Quota eviction consults this before removing anything, so an active
 * operation's file is never pulled out from under it, no matter its age.
 */
export class MediaLeaseRegistry {
  private readonly counts = new Map<string, number>();

  acquire(path: string): void {
    if (!path) return;
    this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
  }

  release(path: string): void {
    if (!path) return;
    const next = (this.counts.get(path) ?? 0) - 1;
    if (next <= 0) this.counts.delete(path);
    else this.counts.set(path, next);
  }

  isLeased(path: string): boolean {
    return (this.counts.get(path) ?? 0) > 0;
  }

  /** Hold a lease on `path` for the duration of `fn`, releasing it even on throw. */
  async withLease<T>(path: string | null | undefined, fn: () => Promise<T>): Promise<T> {
    if (!path) return fn();
    this.acquire(path);
    try {
      return await fn();
    } finally {
      this.release(path);
    }
  }
}

export interface QuotaPlan {
  /** Paths to remove, oldest-unused first, to bring the cache back under quota. */
  evict: string[];
  /** Paths kept: either already under quota or protected by an active lease. */
  keep: string[];
  totalBytesBefore: number;
  totalBytesAfter: number;
}

/**
 * Pure eviction policy, no I/O: oldest `lastUsedAt` first, but a leased path is
 * never evicted, even when leaving it in place means the cache stays over quota.
 */
export function planEviction(
  entries: MediaCacheEntry[],
  quotaBytes: number,
  isLeased: (path: string) => boolean,
): QuotaPlan {
  const totalBytesBefore = entries.reduce((sum, entry) => sum + Math.max(0, entry.sizeBytes), 0);
  const oldestFirst = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  let total = totalBytesBefore;
  const evict: string[] = [];
  const keep: string[] = [];

  for (const entry of oldestFirst) {
    if (total <= quotaBytes || isLeased(entry.path)) {
      keep.push(entry.path);
      continue;
    }
    evict.push(entry.path);
    total -= Math.max(0, entry.sizeBytes);
  }

  return { evict, keep, totalBytesBefore, totalBytesAfter: total };
}

/**
 * Compute and apply an eviction plan against a real (or stub) cache port. Never
 * calls `remove` for a leased path; safe to call after every successful fetch.
 */
export async function enforceMediaCacheQuota(
  cache: MediaCachePort,
  quotaBytes: number,
  leases: MediaLeaseRegistry,
): Promise<QuotaPlan> {
  const entries = await cache.list();
  const plan = planEviction(entries, quotaBytes, (path) => leases.isLeased(path));
  for (const path of plan.evict) {
    if (leases.isLeased(path)) continue; // belt-and-braces: re-check right before removal
    await cache.remove(path);
  }
  return plan;
}

function diskSpacePausedError(dir: string, freeBytesValue: number, minFreeBytes: number): OmniWatchError {
  return new OmniWatchError(
    "budget_paused",
    `Za malo wolnego miejsca na dysku dla ${dir}: wolne ${freeBytesValue} B, wymagane min. ${minFreeBytes} B.`,
    { action: { label: "zwolnij miejsce na dysku i wznow", kind: "check_operation" } },
  );
}

/**
 * Disk-space gate: check free space on the directory a fetch/prepare is about to
 * write into, *before* making any paid call. Insufficient space becomes a
 * `budget_paused` `OmniWatchError` instead of a paid call or a terminal failure —
 * the operation-state machine already allows `budget_paused -> pending/running`
 * (storage/sqlite-store.ts), so the caller resumes once space frees up.
 */
export async function assertDiskSpace(disk: DiskSpacePort, dir: string, minFreeBytes: number): Promise<void> {
  const free = await disk.freeBytes(dir);
  if (!Number.isFinite(free) || free < minFreeBytes) {
    throw diskSpacePausedError(dir, Number.isFinite(free) ? free : -1, minFreeBytes);
  }
}

const ENOSPC_CODE = "ENOSPC";

/** Node's own "no space left on device" signal, however it surfaces from a media tool. */
export function isDiskSpaceError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === ENOSPC_CODE) return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /ENOSPC|no space left on device/i.test(message);
}

/**
 * Turn a raw fetch/prepare failure into a `budget_paused` error when it looks like
 * an out-of-disk-space condition, otherwise return null so the caller falls back
 * to its normal error classification.
 */
export function toDiskSpacePausedError(error: unknown): OmniWatchError | null {
  if (!isDiskSpaceError(error)) return null;
  const message = error instanceof Error ? error.message : String(error);
  return new OmniWatchError("budget_paused", `Brak miejsca na dysku podczas przygotowania materialu: ${message}`, {
    action: { label: "zwolnij miejsce na dysku i wznow", kind: "check_operation" },
    cause: error,
  });
}
