/**
 * T11 — durable, incremental enumeration (T5 / D8).
 *
 * Offline: stub listers only, no network, no paid listing. Every test opens a real
 * SQLite file under the OS temp directory and removes it afterwards.
 *
 * Covered: 1201 films across pages with a repeated page, a limited Instagram-style
 * source that is never labelled "whole channel", a YouTube second-tab error that
 * keeps the first tab's results, zero results as `empty` (not `failed`), `complete`
 * only after full enumeration, cursor persistence across calls, stable-id
 * deduplication, and a paid listing refusal that performs zero lister calls.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANALYSIS_VERSION } from "../src/contracts/types.ts";
import { openSqliteStore } from "../src/storage/index.ts";
import { enqueueAnalysis } from "../src/runtime/queue.ts";
import {
  DEFAULT_PAGE_SIZE,
  clampPageSize,
  decideListingCompleteness,
  describeListing,
  enumerateListing,
  loadRunSourceIds,
  readListingCheckpoint,
} from "../src/collections/listing.ts";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omniwatch-t11-listing-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function youtubeRef(id) {
  return {
    platform: "youtube",
    sourceId: id,
    canonicalUrl: `https://youtu.be/${id}`,
    legacyId: id,
  };
}

function item(id, extra = {}) {
  return { sourceRef: youtubeRef(id), title: `Film ${id}`, ...extra };
}

function openWorkspace() {
  const store = openSqliteStore({ path: join(tempDir(), "state.sqlite") });
  const runId = "run_t11";
  store.createRun({
    id: runId,
    collectionId: "col_t11",
    trigger: "manual",
    state: "running",
    settings: { collectionId: "col_t11", mode: "summary", focus: null, question: null, language: "pl", maxNewItems: null, budgetUsd: null },
    completedAt: null,
  });
  return { store, runId };
}

/** Minimal SourcePort stub: capabilities + a scripted lister. */
function stubSource({ capabilities, pages }) {
  const seenCursors = [];
  const calls = [];
  return {
    seenCursors,
    calls,
    capabilities: () => capabilities,
    async list(_ref, options) {
      calls.push(options.cursor ?? null);
      seenCursors.push(options.cursor ?? null);
      const page = pages[Math.min(calls.length - 1, pages.length - 1)];
      if (typeof page === "function") return page(options);
      if (page instanceof Error) throw page;
      return page;
    },
  };
}

function youtubeCapabilities(overrides = {}) {
  return {
    platform: "youtube",
    singleVideo: true,
    listing: "full",
    listingScopeNote: null,
    pagination: true,
    listingCost: "free",
    requiresConfig: [],
    ...overrides,
  };
}

/**
 * The real scan materializer shape: claim the operation (never a paid call) and
 * record the run item. Counts how often it was asked, so a repeated page is visible.
 */
function makeMaterializer(store, runId, overrides = {}) {
  const materialized = [];
  return {
    materialized,
    materialize: (listed) => {
      materialized.push(listed.sourceRef.sourceId);
      const request = {
        sourceRef: listed.sourceRef,
        mode: "summary",
        focus: null,
        question: null,
        language: "pl",
        analysisVersion: ANALYSIS_VERSION,
        ...overrides,
      };
      const enqueued = enqueueAnalysis({ store, request, runId });
      return { operationId: enqueued.operation.id, state: "pending" };
    },
  };
}

/* ---------------------------------------------------------------- helpers -- */

test("page size is capped at the documented 50 metadata rows", () => {
  assert.equal(clampPageSize(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(clampPageSize(0), DEFAULT_PAGE_SIZE);
  assert.equal(clampPageSize(500), 50);
  assert.equal(clampPageSize(10), 10);
});

test("completeness never promotes a batch or an error to a full archive", () => {
  assert.equal(
    decideListingCompleteness({ stopReason: "page_limit", itemsEnumerated: 50, errors: 0, lastPageCompleteness: "partial" }),
    "partial",
  );
  assert.equal(
    decideListingCompleteness({ stopReason: "failed", itemsEnumerated: 0, errors: 1, lastPageCompleteness: "failed" }),
    "failed",
  );
  assert.equal(
    decideListingCompleteness({ stopReason: "failed", itemsEnumerated: 50, errors: 1, lastPageCompleteness: "partial" }),
    "partial",
  );
  assert.equal(
    decideListingCompleteness({ stopReason: "empty", itemsEnumerated: 0, errors: 0, lastPageCompleteness: "empty" }),
    "empty",
  );
  assert.equal(
    decideListingCompleteness({ stopReason: "complete", itemsEnumerated: 1201, errors: 0, lastPageCompleteness: "complete" }),
    "complete",
  );
});

/* --------------------------------------------------- T11: 1201 + repeat --- */

test("1201 films across pages with a repeated page: one row per stable id, complete at the end", async () => {
  const { store, runId } = openWorkspace();
  const total = 1201;
  const ids = Array.from({ length: total }, (_, index) => `V${String(index).padStart(4, "0")}`);
  const pages = [];
  for (let offset = 0; offset < total; offset += 50) {
    const slice = ids.slice(offset, offset + 50);
    pages.push({
      items: slice.map((id) => item(id)),
      cursor: offset + 50 < total ? `c${offset + 50}` : null,
      completeness: offset + 50 < total ? "partial" : "complete",
    });
  }
  // Page 13 repeats page 12 verbatim (same ids, same cursor target), the way a
  // mirror or a second YouTube tab can hand back the previous page again.
  pages.splice(12, 0, { ...pages[11] });

  const source = stubSource({ capabilities: youtubeCapabilities(), pages });
  const { materialize, materialized } = makeMaterializer(store, runId);
  const progress = [];
  const listing = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_channel"),
    runId,
    materialize,
    onPage: (event) => progress.push(event),
  });

  assert.equal(listing.completeness, "complete");
  assert.equal(listing.fullChannel, true);
  assert.equal(listing.stopReason, "complete");
  assert.equal(listing.items.length, total);
  assert.equal(listing.duplicates, 50, "the repeated page is counted, not re-recorded");
  assert.equal(materialized.length, total, "materialize runs once per stable id");
  assert.equal(source.calls.length, 26);

  const stored = store.listRunItems(runId, { limit: 1000 });
  assert.equal(stored.total, total);
  assert.equal(stored.items.length, 1000, "reads are paged, never the whole archive at once");
  assert.equal(new Set(stored.items.map((row) => row.sourceRef.sourceId)).size, 1000);
  assert.equal(progress.length, 26);
  assert.equal(progress[12].duplicates, 50);
  assert.equal(progress[0].items, 50);
  assert.equal(progress[0].elapsedMs >= 0, true);
  assert.equal(loadRunSourceIds(store, runId).size, total);
  assert.match(describeListing(listing), /caly kanal/);
  store.close();
});

test("dedupe uses the stable source id, not the title or the date", async () => {
  const { store, runId } = openWorkspace();
  const source = stubSource({
    capabilities: youtubeCapabilities(),
    pages: [
      {
        items: [
          { sourceRef: youtubeRef("A1"), title: "Ten sam tytul", publishedAt: "2026-01-01T00:00:00.000Z" },
          { sourceRef: youtubeRef("A2"), title: "Ten sam tytul", publishedAt: "2026-01-01T00:00:00.000Z" },
          { sourceRef: youtubeRef("A3"), title: "Ten sam tytul", publishedAt: "2026-01-01T00:00:00.000Z" },
        ],
        cursor: "next",
        completeness: "partial",
      },
      {
        // Same ids, edited titles/dates: still the same materials.
        items: [
          { sourceRef: youtubeRef("A1"), title: "Zmieniony tytul", publishedAt: "2030-01-01T00:00:00.000Z" },
          { sourceRef: youtubeRef("A2"), title: "Inny tytul", publishedAt: null },
        ],
        cursor: null,
        completeness: "complete",
      },
    ],
  });
  const { materialize, materialized } = makeMaterializer(store, runId);
  const listing = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_channel"),
    runId,
    materialize,
  });

  assert.equal(listing.completeness, "complete");
  assert.equal(listing.items.length, 3);
  assert.equal(listing.duplicates, 2);
  assert.deepEqual(materialized, ["A1", "A2", "A3"]);
  assert.equal(store.listRunItems(runId, { limit: 10 }).total, 3);
  store.close();
});

/* ------------------------------------------------- T11: limited source --- */

test("a limited Instagram-style source is never labelled a whole channel", async () => {
  const { store, runId } = openWorkspace();
  const source = stubSource({
    capabilities: {
      platform: "instagram",
      singleVideo: true,
      listing: "limited",
      listingScopeNote: "25 ostatnich",
      pagination: false,
      listingCost: "paid",
      requiresConfig: ["APIFY_TOKEN"],
    },
    pages: [
      {
        items: Array.from({ length: 25 }, (_, index) => ({
          sourceRef: { platform: "instagram", sourceId: `ig_${index}`, canonicalUrl: `https://instagram.com/p/ig_${index}` },
          title: `Rolka ${index}`,
        })),
        cursor: null,
        completeness: "complete",
      },
    ],
  });
  const { materialize } = makeMaterializer(store, runId);
  const listing = await enumerateListing({
    store,
    port: source,
    sourceRef: { platform: "instagram", sourceId: "ig_profile", canonicalUrl: "https://instagram.com/profile" },
    runId,
    materialize,
    confirmPaidListing: true,
  });

  assert.equal(listing.completeness, "complete", "the offered window was fully enumerated");
  assert.equal(listing.scope, "limited");
  assert.equal(listing.scopeNote, "25 ostatnich");
  assert.equal(listing.fullChannel, false, "25 ostatnich is not the whole channel");
  assert.match(describeListing(listing), /ograniczony zakres \(25 ostatnich\)/);
  store.close();
});

test("paid listing without explicit confirmation performs zero lister calls", async () => {
  const { store, runId } = openWorkspace();
  const source = stubSource({
    capabilities: {
      platform: "x",
      singleVideo: true,
      listing: "limited",
      listingScopeNote: "ostatnie posty z materialem wideo; listowanie jest platne i wymaga jawnego startu",
      pagination: true,
      listingCost: "paid",
      requiresConfig: ["APIFY_TOKEN"],
    },
    pages: [{ items: [item("X1")], cursor: null, completeness: "complete" }],
  });
  const { materialize } = makeMaterializer(store, runId);

  await assert.rejects(
    enumerateListing({
      store,
      port: source,
      sourceRef: { platform: "x", sourceId: "x_account", canonicalUrl: "https://x.com/account" },
      runId,
      materialize,
    }),
    (error) => error.errorClass === "invalid_input" && /platne/.test(error.message),
  );
  assert.equal(source.calls.length, 0, "a refusal never reaches the paid lister");
  assert.equal(store.listRunItems(runId, { limit: 10 }).total, 0);
  store.close();
});

/* ------------------------------------------------ T11: error isolation --- */

test("a YouTube second-tab error keeps the first tab's results and reports partial", async () => {
  const { store, runId } = openWorkspace();
  const source = stubSource({
    capabilities: youtubeCapabilities(),
    pages: [
      { items: [item("Y1"), item("Y2")], cursor: "tab2", completeness: "partial" },
      { items: [item("Y3")], cursor: "tab3", completeness: "partial" },
      () => {
        throw new Error("druga zakladka YouTube nie odpowiedziala");
      },
    ],
  });
  const { materialize } = makeMaterializer(store, runId);
  const listing = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_channel"),
    runId,
    materialize,
  });

  assert.equal(listing.completeness, "partial");
  assert.equal(listing.fullChannel, false);
  assert.equal(listing.items.length, 3, "good results survive the failed page");
  assert.equal(listing.errors.length, 1);
  assert.match(listing.errors[0], /druga zakladka/);
  assert.equal(store.listRunItems(runId, { limit: 10 }).total, 3);
  // The cursor lives with the collection, so the next run of this archive resumes.
  const checkpoint = readListingCheckpoint(store.getCollectionSettings("col_t11"), "UC_channel");
  assert.equal(checkpoint.completeness, "partial");
  store.close();
});

test("zero results is empty, not failed", async () => {
  const { store, runId } = openWorkspace();
  const source = stubSource({
    capabilities: youtubeCapabilities(),
    pages: [{ items: [], cursor: null, completeness: "complete" }],
  });
  const { materialize } = makeMaterializer(store, runId);
  const listing = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_empty"),
    runId,
    materialize,
  });

  assert.equal(listing.completeness, "empty");
  assert.equal(listing.stopReason, "empty");
  assert.equal(listing.errors.length, 0);
  assert.equal(listing.items.length, 0);
  assert.equal(listing.fullChannel, false);
  store.close();
});

test("an error on the first page is failed, with the reason kept", async () => {
  const { store, runId } = openWorkspace();
  const source = stubSource({
    capabilities: youtubeCapabilities(),
    pages: [
      () => {
        throw new Error("archiwum niedostepne");
      },
    ],
  });
  const { materialize } = makeMaterializer(store, runId);
  const listing = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_broken"),
    runId,
    materialize,
  });
  assert.equal(listing.completeness, "failed");
  assert.equal(listing.errors.length, 1);
  store.close();
});

/* ------------------------------------------- T11: cursor / resume path --- */

test("a bounded call stops at partial, and the next call resumes from the persisted cursor", async () => {
  const { store, runId } = openWorkspace();
  const total = 1201;
  const ids = Array.from({ length: total }, (_, index) => `R${String(index).padStart(4, "0")}`);
  const pages = [];
  for (let offset = 0; offset < total; offset += 50) {
    const slice = ids.slice(offset, offset + 50);
    pages.push({
      items: slice.map((id) => item(id)),
      cursor: offset + 50 < total ? `c${offset + 50}` : null,
      completeness: offset + 50 < total ? "partial" : "complete",
    });
  }
  const source = stubSource({ capabilities: youtubeCapabilities(), pages });
  const { materialize, materialized } = makeMaterializer(store, runId);

  const first = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_resume"),
    runId,
    materialize,
    maxPages: 2,
  });
  assert.equal(first.completeness, "partial");
  assert.equal(first.items.length, 100);
  assert.equal(first.cursor, "c100");
  assert.equal(store.listRunItems(runId, { limit: 10 }).total, 100);

  const second = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_resume"),
    runId,
    materialize,
  });
  assert.equal(second.startCursor, "c100", "the persisted cursor is reused");
  assert.equal(second.completeness, "complete");
  assert.equal(second.items.length, total - 100);
  assert.equal(store.listRunItems(runId, { limit: 10 }).total, total);
  assert.equal(new Set(materialized).size, total, "no material is materialized twice");
  assert.equal(source.calls[0], null);
  assert.equal(source.calls[2], "c100");
  store.close();
});

test("a source that never advances its cursor stops honestly instead of looping", async () => {
  const { store, runId } = openWorkspace();
  const source = stubSource({
    capabilities: youtubeCapabilities(),
    pages: [
      { items: [item("S1"), item("S2")], cursor: null, completeness: "partial" },
      { items: [item("S1"), item("S2")], cursor: null, completeness: "partial" },
    ],
  });
  const { materialize } = makeMaterializer(store, runId);
  const listing = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_stalled"),
    runId,
    materialize,
    maxPages: 5,
  });
  assert.equal(listing.completeness, "partial");
  assert.equal(listing.stopReason, "stalled");
  assert.equal(listing.fullChannel, false);
  // One repeated page is tolerated (mirror/tab overlap); two in a row stop the loop.
  assert.equal(source.calls.length, 3);
  assert.equal(store.listRunItems(runId, { limit: 10 }).total, 2);
  store.close();
});

test("a store failure while recording stops the enumeration immediately (D3)", async () => {
  const { store, runId } = openWorkspace();
  const source = stubSource({
    capabilities: youtubeCapabilities(),
    pages: [
      { items: [item("F1"), item("F2"), item("F3")], cursor: "c2", completeness: "partial" },
      { items: [item("F4")], cursor: null, completeness: "complete" },
    ],
  });
  let calls = 0;
  const failingMaterialize = (listed) => {
    calls += 1;
    if (calls === 2) {
      const failure = new Error("dysk pelny");
      failure.errorClass = "storage_unavailable";
      throw failure;
    }
    const enqueued = enqueueAnalysis({
      store,
      runId,
      request: {
        sourceRef: listed.sourceRef,
        mode: "summary",
        focus: null,
        question: null,
        language: "pl",
        analysisVersion: ANALYSIS_VERSION,
      },
    });
    return { operationId: enqueued.operation.id, state: "pending" };
  };

  await assert.rejects(
    enumerateListing({
      store,
      port: source,
      sourceRef: youtubeRef("UC_disk"),
      runId,
      materialize: failingMaterialize,
    }),
    /dysk pelny/,
  );
  assert.equal(source.calls.length, 1, "the next page is never requested after a write failure");
  assert.equal(store.listRunItems(runId, { limit: 10 }).total, 1, "the good row written before the failure stays");
  store.close();
});
