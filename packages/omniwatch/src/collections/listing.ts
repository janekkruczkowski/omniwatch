/**
 * T5 / D8: durable, incremental archive enumeration.
 *
 * One enumeration walks an injected `SourcePort.list` in pages of 50 metadata
 * rows, records every material incrementally in SQLite (`run_items`), deduplicates
 * by the *stable source id* (never by title or publish date) and reports an honest
 * `complete` / `partial` / `failed` / `empty` verdict.
 *
 * Honesty rules the rest of the product depends on:
 * - `complete` is only reported after the source itself ended the enumeration
 *   (`ListingPage.completeness === "complete"`) with no error and no early stop;
 * - a source that only offers a window (Instagram "25 ostatnich", TikTok, X,
 *   Meta Ads) never becomes a "whole channel": `fullChannel` stays false and the
 *   capability note travels with the result;
 * - an error on a later page keeps the rows already collected (`partial`); it
 *   never discards good results and never turns into a silent success;
 * - a repeated page (same ids, or a source that does not advance its cursor)
 *   adds no duplicate `run_items` and does not loop forever;
 * - paid listing (X / Meta Ads / Instagram) needs an explicit confirmation; a
 *   refusal produces zero lister calls, so it cannot spend money.
 *
 * The cursor of a source is persisted in the collection settings under the
 * namespaced `_listing` key (`createRun` mirrors a run's snapshot into the
 * collection row), so a resumed enumeration continues where the previous call
 * stopped instead of re-reading the whole archive. The key is additive: the
 * declared `ScanSettings` fields are untouched.
 */

import { OmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import type { SourcePort, StorePort } from "../contracts/ports.ts";
import type {
  ListingCompleteness,
  ListingItem,
  ListingPage,
  RunItemState,
  ScanSettings,
  SourceCapabilities,
  SourceRef,
} from "../contracts/types.ts";

export const LISTING_PROTOCOL = "omniwatch.listing.v1";

/** D11: result lists and listings move in pages of 50 metadata rows. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 50;

/** Reserved, namespaced key inside the run's settings snapshot. */
export const LISTING_CHECKPOINT_KEY = "_listing";

export interface ListingCheckpoint {
  protocol: string;
  sourceId: string;
  cursor: string | null;
  pagesRead: number;
  itemsEnumerated: number;
  completeness: ListingCompleteness;
  scopeNote: string | null;
  updatedAt: string;
}

type SettingsWithCheckpoints = ScanSettings & {
  [LISTING_CHECKPOINT_KEY]?: Record<string, ListingCheckpoint>;
};

export function readListingCheckpoints(settings: ScanSettings): Record<string, ListingCheckpoint> {
  const stored = (settings as SettingsWithCheckpoints)[LISTING_CHECKPOINT_KEY];
  return stored && typeof stored === "object" ? { ...stored } : {};
}

export function readListingCheckpoint(settings: ScanSettings, sourceId: string): ListingCheckpoint | null {
  const found = readListingCheckpoints(settings)[sourceId];
  return found && typeof found.sourceId === "string" ? found : null;
}

/** Immutable: returns a copy of the settings snapshot with the checkpoint applied. */
export function writeListingCheckpoint(
  settings: ScanSettings,
  sourceId: string,
  checkpoint: ListingCheckpoint | null,
): ScanSettings {
  const next = readListingCheckpoints(settings);
  if (checkpoint) next[sourceId] = checkpoint;
  else delete next[sourceId];
  const merged: SettingsWithCheckpoints = { ...settings, [LISTING_CHECKPOINT_KEY]: next };
  return merged;
}

/**
 * Persists the checkpoint on the run. `createRun` upserts the settings snapshot of
 * an existing run, so the enumeration survives a process restart without adding a
 * second store table (the frozen `StorePort` has no cursor column).
 */
export function saveListingCheckpoint(
  store: StorePort,
  runId: string,
  sourceId: string,
  checkpoint: ListingCheckpoint | null,
): void {
  const run = store.getRun(runId);
  if (!run) {
    throw new OmniWatchError("invalid_input", `przebieg ${runId} nie istnieje; nie zapisuje kursora listowania`, {
      action: { label: "odczytaj przebieg ponownie", kind: "check_operation" },
    });
  }
  const current = store.getCollectionSettings(run.collectionId) ?? run.settings;
  store.saveCollectionSettings(writeListingCheckpoint(current, sourceId, checkpoint));
}

/* --------------------------------------------------------------- guards ---- */

/**
 * Refuses listing before a single lister call when the source cannot list, or when
 * a billed listing was not explicitly confirmed (D8/D11: "płatne listowanie wymaga
 * osobnego jawnego startu").
 */
export function assertListingAllowed(
  capabilities: SourceCapabilities,
  confirmPaidListing: boolean | undefined,
): void {
  if (capabilities.listing === "none") {
    throw new OmniWatchError(
      "source_unavailable",
      `Zrodlo ${capabilities.platform} nie potrafi listowac archiwum; wklej pojedynczy URL materialu.`,
      { action: { label: "wklej pojedynczy URL", kind: "none" } },
    );
  }
  if (capabilities.listingCost === "paid" && confirmPaidListing !== true) {
    throw new OmniWatchError(
      "invalid_input",
      `Listowanie ${capabilities.platform} jest platne (${capabilities.listingScopeNote ?? "zakres zalezy od dostawcy"}); wymagane jest jawne potwierdzenie startu, inaczej nie wykonuje ani jednego platnego wywolania.`,
      { action: { label: "potwierdz platne listowanie", kind: "none" } },
    );
  }
  if (capabilities.listingCost === "unknown" && confirmPaidListing !== true) {
    throw new OmniWatchError(
      "invalid_input",
      `Koszt listowania ${capabilities.platform} nie jest znany; automatyczny start jest wstrzymany do jawnego potwierdzenia.`,
      { action: { label: "potwierdz listowanie", kind: "none" } },
    );
  }
}

/* ------------------------------------------------------------ enumeration -- */

/**
 * Maps one enumerated material onto the operation that will analyse it. The
 * callback belongs to the scan layer: it owns the goal (mode/focus/question/
 * language) and the decision "new vs already analysed". Returning `null` means
 * "record nothing for this material"; claiming an operation never performs a paid
 * model call.
 */
export type ListingMaterialize = (
  item: ListingItem,
  /** The run-item ordinal the enumeration will store for this material. */
  ordinal: number,
) => { operationId: string; state: RunItemState } | null;

export interface ListingPageEvent {
  page: number;
  items: number;
  recorded: number;
  duplicates: number;
  cursor: string | null;
  completeness: ListingCompleteness;
  elapsedMs: number;
}

export interface EnumeratedListing {
  protocol: string;
  runId: string;
  sourceRef: SourceRef;
  capabilities: SourceCapabilities;
  /** complete | partial | failed | empty — the enumeration, not the source's claim. */
  completeness: ListingCompleteness;
  /** full | limited | none — taken from capabilities, never inferred from item count. */
  scope: SourceCapabilities["listing"];
  scopeNote: string | null;
  /** True only for a free full-archive source that finished enumerating. */
  fullChannel: boolean;
  /** Materials recorded by this call, in listing order (metadata only, no film text). */
  items: ListingItem[];
  /** Materials already recorded for this run (repeated page / resumed call). */
  duplicates: number;
  privateItems: number;
  skippedUnrecorded: number;
  pagesRead: number;
  startCursor: string | null;
  cursor: string | null;
  stopReason: "complete" | "empty" | "page_limit" | "stopped" | "failed" | "stalled";
  errors: string[];
  elapsedMs: number;
}

export interface EnumerateListingOptions {
  store: StorePort;
  port: SourcePort;
  sourceRef: SourceRef;
  runId: string;
  /** Records the material durably; called only for ids not seen in this run. */
  materialize: ListingMaterialize;
  /** Explicit start cursor; when omitted the persisted checkpoint is used. */
  cursor?: string | null;
  /** Resume from the persisted checkpoint (default true). */
  resume?: boolean;
  pageSize?: number;
  /** Stop after this many pages; null (default) enumerates until the source ends. */
  maxPages?: number | null;
  /** Required for billed listing (X / Meta Ads / Instagram). */
  confirmPaidListing?: boolean;
  onPage?: (event: ListingPageEvent) => void;
  shouldStop?: () => boolean;
  now?: () => string;
}

export function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  const truncated = Math.trunc(value);
  if (truncated <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(truncated, MAX_PAGE_SIZE);
}

/** Every source id already recorded for this run, loaded in bounded pages. */
export function loadRunSourceIds(store: StorePort, runId: string): Set<string> {
  const ids = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = store.listRunItems(runId, { offset, limit: 1000 });
    for (const item of page.items) ids.add(item.sourceRef.sourceId);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return ids;
}

export function nextRunOrdinal(store: StorePort, runId: string): number {
  return store.listRunItems(runId, { limit: 1 }).total;
}

export interface CompletenessInput {
  stopReason: EnumeratedListing["stopReason"];
  itemsEnumerated: number;
  errors: number;
  lastPageCompleteness: ListingCompleteness | null;
}

/**
 * The single place that decides the verdict, so every caller reads the same rule
 * and no adapter can promote a batch to "complete".
 */
export function decideListingCompleteness(input: CompletenessInput): ListingCompleteness {
  if (input.errors > 0) return input.itemsEnumerated > 0 ? "partial" : "failed";
  switch (input.stopReason) {
    case "failed":
      return input.itemsEnumerated > 0 ? "partial" : "failed";
    case "page_limit":
    case "stopped":
    case "stalled":
      return "partial";
    case "empty":
      return "empty";
    default:
      return input.itemsEnumerated > 0 ? "complete" : "empty";
  }
}

/**
 * Enumerates one source into durable run items.
 *
 * The loop is bounded by the source (page completeness / cursor), by `maxPages`
 * and by `shouldStop`. A page error after the first successful page keeps the
 * collected rows and reports `partial`; an error on the very first page reports
 * `failed` with the reason. A store failure inside `materialize` propagates: it
 * stops the enumeration immediately (D3 "awaria zapisu wstrzymuje dalszą płatną
 * pracę") instead of continuing on in-memory state.
 */
export async function enumerateListing(options: EnumerateListingOptions): Promise<EnumeratedListing> {
  const { store, port, sourceRef, runId, materialize } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = Date.now();
  const capabilities = port.capabilities(sourceRef);
  const lister = port.list;

  if (typeof lister !== "function") {
    throw new OmniWatchError(
      "source_unavailable",
      `Adapter ${capabilities.platform} nie udostepnia listowania archiwum.`,
      { action: { label: "wklej pojedynczy URL", kind: "none" } },
    );
  }
  assertListingAllowed(capabilities, options.confirmPaidListing);

  const run = store.getRun(runId);
  if (!run) {
    throw new OmniWatchError("invalid_input", `przebieg ${runId} nie istnieje; nie listuje bez trwalego przebiegu`);
  }

  const pageSize = clampPageSize(options.pageSize);
  const maxPages = options.maxPages ?? null;
  // The cursor lives with the collection (a run snapshot mirrors it), so a later
  // run of the same archive continues instead of re-reading everything.
  const collectionSettings = store.getCollectionSettings(run.collectionId) ?? run.settings;
  const checkpoint =
    options.resume === false ? null : readListingCheckpoint(collectionSettings, sourceRef.sourceId);
  const startCursor = options.cursor !== undefined ? (options.cursor ?? null) : (checkpoint?.cursor ?? null);

  const recorded = loadRunSourceIds(store, runId);
  let nextOrdinal = nextRunOrdinal(store, runId);
  const items: ListingItem[] = [];
  const errors: string[] = [];
  let cursor = startCursor;
  let pagesRead = 0;
  let duplicates = 0;
  let privateItems = 0;
  let skippedUnrecorded = 0;
  let lastPageCompleteness: ListingCompleteness | null = null;
  let stopReason: EnumeratedListing["stopReason"] = "page_limit";
  let consecutiveStalls = 0;

  for (;;) {
    if (maxPages !== null && pagesRead >= maxPages) {
      stopReason = "page_limit";
      break;
    }
    if (options.shouldStop?.()) {
      stopReason = "stopped";
      break;
    }

    const pageStartedAt = Date.now();
    let page: ListingPage;
    try {
      page = await lister.call(port, sourceRef, { cursor, limit: pageSize });
    } catch (error) {
      const failure = toOmniWatchError(error, "source_unavailable");
      errors.push(`${sourceRef.sourceId}: ${failure.message}`);
      stopReason = "failed";
      break;
    }
    pagesRead += 1;

    const pageItems = Array.isArray(page.items) ? page.items : [];
    const pageCompleteness: ListingCompleteness = page.completeness ?? "partial";
    lastPageCompleteness = pageCompleteness;
    let pageRecorded = 0;
    let pageDuplicates = 0;

    for (const item of pageItems) {
      const sourceId = item?.sourceRef?.sourceId;
      if (!sourceId) continue;
      if (recorded.has(sourceId)) {
        duplicates += 1;
        pageDuplicates += 1;
        continue;
      }
      if (item.private === true) privateItems += 1;
      const materialized = materialize(item, nextOrdinal);
      if (!materialized) {
        skippedUnrecorded += 1;
        recorded.add(sourceId);
        continue;
      }
      store.addRunItem({
        runId,
        ordinal: nextOrdinal,
        sourceRef: item.sourceRef,
        operationId: materialized.operationId,
        state: materialized.state,
        title: item.title ?? null,
      });
      nextOrdinal += 1;
      recorded.add(sourceId);
      items.push(item);
      pageRecorded += 1;
    }

    const nextCursor = page.cursor ?? null;
    options.onPage?.({
      page: pagesRead,
      items: pageItems.length,
      recorded: pageRecorded,
      duplicates: pageDuplicates,
      cursor: nextCursor,
      completeness: pageCompleteness,
      elapsedMs: Date.now() - pageStartedAt,
    });

    if (pageCompleteness === "failed") {
      errors.push(`${sourceRef.sourceId}: zrodlo zglosilo niekompletna strone ${pagesRead}`);
      stopReason = "failed";
      break;
    }
    if (pageCompleteness === "empty" || pageCompleteness === "complete") {
      stopReason = recorded.size === 0 ? "empty" : "complete";
      break;
    }

    // A source may legitimately repeat one page (mirror/tab overlap). Two
    // consecutive no-progress pages mean the cursor is not moving, so we stop
    // honestly instead of looping forever or pretending the batch is the archive.
    if (nextCursor === cursor && pageRecorded === 0) {
      consecutiveStalls += 1;
    } else {
      consecutiveStalls = 0;
    }
    if (consecutiveStalls >= 2) {
      errors.push(
        `${sourceRef.sourceId}: zrodlo nie przesuwa kursora (strona ${pagesRead}); koncze bez etykiety "caly kanal"`,
      );
      stopReason = "stalled";
      break;
    }
    cursor = nextCursor;
  }

  const completeness = decideListingCompleteness({
    stopReason,
    itemsEnumerated: recorded.size,
    errors: errors.length,
    lastPageCompleteness,
  });
  const elapsedMs = Date.now() - startedAt;

  saveListingCheckpoint(store, runId, sourceRef.sourceId, {
    protocol: LISTING_PROTOCOL,
    sourceId: sourceRef.sourceId,
    cursor,
    pagesRead,
    itemsEnumerated: recorded.size,
    completeness,
    scopeNote: capabilities.listingScopeNote ?? null,
    updatedAt: now(),
  });

  return {
    protocol: LISTING_PROTOCOL,
    runId,
    sourceRef,
    capabilities,
    completeness,
    scope: capabilities.listing,
    scopeNote: capabilities.listingScopeNote ?? null,
    fullChannel: capabilities.listing === "full" && completeness === "complete",
    items,
    duplicates,
    privateItems,
    skippedUnrecorded,
    pagesRead,
    startCursor,
    cursor,
    stopReason,
    errors,
    elapsedMs,
  };
}

/** Short, non-decorative line for the UI / Hermes summary. */
export function describeListing(listing: EnumeratedListing): string {
  const scope = listing.fullChannel
    ? "caly kanal"
    : listing.scope === "limited"
      ? `ograniczony zakres${listing.scopeNote ? ` (${listing.scopeNote})` : ""}`
      : "brak listowania";
  return `${listing.sourceRef.sourceId}: ${listing.completeness}, ${scope}, stron ${listing.pagesRead}, nowych ${listing.items.length}, duplikatow ${listing.duplicates}`;
}
