/**
 * T18 — 10 000 metadata rows through the durable enumeration (T5 / D11).
 *
 * Offline: a stub lister serves pages of 50 rows, the store is a real SQLite file
 * and no model or network is involved. The test reports the measured numbers
 * instead of hiding them:
 *
 * - page time for the full cycle (list + dedupe + durable write) with the plan's
 *   target `p95 < 250 ms` for a local page read;
 * - process RSS growth across the whole 10k-row walk, against the plan's
 *   `< 100 MiB` queue growth budget;
 * - bounded payload: a page event and a run item carry metadata only, never the
 *   text of every film, and reads are paged in 50s.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANALYSIS_VERSION } from "../src/contracts/types.ts";
import { openSqliteStore } from "../src/storage/index.ts";
import { enqueueAnalysis } from "../src/runtime/queue.ts";
import { DEFAULT_PAGE_SIZE, enumerateListing } from "../src/collections/listing.ts";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omniwatch-t18-perf-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const TOTAL = 10_000;
const PAGE_SIZE = DEFAULT_PAGE_SIZE;

function youtubeRef(id) {
  return { platform: "youtube", sourceId: id, canonicalUrl: `https://youtu.be/${id}`, legacyId: id };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function rssMiB() {
  return process.memoryUsage().rss / (1024 * 1024);
}

test("10 000 metadata rows: pages of 50, bounded payload, paged reads and measured cost", async () => {
  const store = openSqliteStore({ path: join(tempDir(), "state.sqlite") });
  const runId = "run_t18";
  store.createRun({
    id: runId,
    collectionId: "col_t18",
    trigger: "manual",
    state: "running",
    settings: { collectionId: "col_t18", mode: "summary", focus: null, question: null, language: "pl", maxNewItems: 0, budgetUsd: null },
    completedAt: null,
  });

  const ids = Array.from({ length: TOTAL }, (_, index) => `P${String(index).padStart(5, "0")}`);
  const listerCalls = [];
  const source = {
    capabilities: () => ({
      platform: "youtube",
      singleVideo: true,
      listing: "full",
      listingScopeNote: null,
      pagination: true,
      listingCost: "free",
      requiresConfig: [],
    }),
    async list(_ref, options) {
      listerCalls.push(options.limit);
      const offset = options.cursor === null || options.cursor === undefined ? 0 : Number(options.cursor);
      const slice = ids.slice(offset, offset + options.limit);
      const next = offset + options.limit;
      return {
        items: slice.map((id) => ({
          sourceRef: youtubeRef(id),
          title: `Film ${id}`,
          durationSeconds: 600,
          publishedAt: "2026-09-01T00:00:00.000Z",
        })),
        cursor: next < TOTAL ? String(next) : null,
        completeness: next < TOTAL ? "partial" : "complete",
      };
    },
  };

  const beforeRss = rssMiB();
  const pageEvents = [];
  const listing = await enumerateListing({
    store,
    port: source,
    sourceRef: youtubeRef("UC_10k"),
    runId,
    materialize: (item) => {
      const enqueued = enqueueAnalysis({
        store,
        runId,
        request: {
          sourceRef: item.sourceRef,
          mode: "summary",
          focus: null,
          question: null,
          language: "pl",
          analysisVersion: ANALYSIS_VERSION,
        },
      });
      return { operationId: enqueued.operation.id, state: "pending" };
    },
    onPage: (event) => pageEvents.push(event),
  });
  const afterRss = rssMiB();

  const pageTimes = pageEvents.map((event) => event.elapsedMs);
  const p50 = percentile(pageTimes, 50);
  const p95 = percentile(pageTimes, 95);
  const max = Math.max(...pageTimes);
  const rssGrowth = afterRss - beforeRss;

  // Bounded payload: the page event and one durable row carry metadata only.
  const pageEventBytes = Buffer.byteLength(JSON.stringify(pageEvents[0]));
  const firstRow = store.listRunItems(runId, { limit: PAGE_SIZE });
  const rowBytes = Buffer.byteLength(JSON.stringify(firstRow.items[0]));

  console.log(
    `[T18] rows=${TOTAL} pages=${pageEvents.length} pageSize=${PAGE_SIZE} ` +
      `pageMs p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} max=${max.toFixed(1)} ` +
      `rssBefore=${beforeRss.toFixed(1)}MiB rssAfter=${afterRss.toFixed(1)}MiB growth=${rssGrowth.toFixed(1)}MiB ` +
      `pageEventBytes=${pageEventBytes} runItemBytes=${rowBytes} listingMs=${listing.elapsedMs}`,
  );

  assert.equal(listing.completeness, "complete");
  assert.equal(listing.items.length, TOTAL);
  assert.equal(listing.pagesRead, TOTAL / PAGE_SIZE);
  assert.equal(pageEvents.length, TOTAL / PAGE_SIZE);
  assert.equal(listerCalls.every((limit) => limit === PAGE_SIZE), true, "every page requests 50 rows");
  assert.equal(pageEvents.every((event) => event.items <= PAGE_SIZE), true, "no page is larger than 50 rows");
  assert.equal(pageEvents.every((event) => event.recorded <= PAGE_SIZE), true);
  assert.equal(pageEvents[pageEvents.length - 1].completeness, "complete");
  assert.equal(listerCalls.length, TOTAL / PAGE_SIZE, "progress is reported per page");

  // Paged reads: never the whole archive at once (D11).
  assert.equal(firstRow.total, TOTAL);
  assert.equal(firstRow.items.length, PAGE_SIZE);
  const secondPage = store.listRunItems(runId, { offset: PAGE_SIZE, limit: PAGE_SIZE });
  assert.equal(secondPage.items.length, PAGE_SIZE);
  assert.notEqual(secondPage.items[0].sourceRef.sourceId, firstRow.items[0].sourceRef.sourceId);

  // Bounded payload: metadata only, no film text and no analysis body.
  assert.equal(pageEventBytes < 512, true, `page event payload is ${pageEventBytes} bytes`);
  assert.equal(rowBytes < 1024, true, `one run item row is ${rowBytes} bytes`);
  assert.equal("content" in firstRow.items[0], false);
  assert.equal(JSON.stringify(firstRow.items[0]).includes("Film "), true, "title metadata only");

  // The plan's targets, measured here rather than assumed.
  assert.equal(p95 < 250, true, `page p95 must stay under 250 ms (measured ${p95.toFixed(1)} ms)`);
  assert.equal(rssGrowth < 100, true, `RSS growth must stay under 100 MiB (measured ${rssGrowth.toFixed(1)} MiB)`);

  store.close();
});
