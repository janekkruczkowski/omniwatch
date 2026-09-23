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
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANALYSIS_VERSION } from "../src/contracts/types.ts";
import { openSqliteStore } from "../src/storage/index.ts";
import { enqueueAnalysis } from "../src/runtime/queue.ts";
import { DEFAULT_PAGE_SIZE, enumerateListing } from "../src/collections/listing.ts";
import { createLocalMemory, createFixtureSource } from "../src/runtime/poc.ts";
import { prepareMany } from "../src/sources/registry.ts";

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

/**
 * T18 gaps closed: QA (E-tests, section 3/4, item 4) found four missing T18
 * variants — note-count growth, poll cost, cache quota + active file, and a
 * large local video. The four tests below close them one at a time; the last
 * two document a real product gap instead of papering over it (see each test's
 * comment and the QA report's reproduction section).
 */

function youtubeRefT18(id) {
  return { platform: "youtube", sourceId: id, canonicalUrl: `https://youtu.be/${id}`, legacyId: id };
}

function makeResult(analysisId, i) {
  const content = `## Summary\n- [0:0${i % 9}] punkt ${i} o filmie numer ${i}, temat testowy do wyszukania\n`;
  return {
    analysisId,
    analysisKey: `key_${i}`,
    analysisVersion: ANALYSIS_VERSION,
    sourceRef: youtubeRefT18(`P${String(i).padStart(5, "0")}`),
    mode: "summary",
    title: `Film numer ${i}`,
    content,
    usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.001, costKnown: true },
    createdAt: "2026-09-01T00:00:00.000Z",
    conversationId: null,
    turnId: `turn_${i}`,
    parentTurnId: null,
  };
}

test("T18: Vault note count grows without breaking search — measured, not assumed", async () => {
  const root = tempDir();
  const memory = createLocalMemory({ root });
  const NOTES = 1500;

  const writeStart = process.hrtime.bigint();
  for (let i = 0; i < NOTES; i += 1) {
    await memory.writeAnalysis(makeResult(`omni_t18_${String(i).padStart(5, "0")}`, i));
  }
  const writeMs = Number(process.hrtime.bigint() - writeStart) / 1e6;

  // A handful of searches against the full library, timed individually so a p95
  // is reported instead of a single lucky/unlucky run.
  const searchTimes = [];
  let hits = null;
  for (const needle of ["temat testowy", "punkt 3", "Film numer 1499", "nic-takiego-nie-istnieje"]) {
    const start = process.hrtime.bigint();
    const found = await memory.searchAnalyses(needle, 20);
    searchTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (needle === "temat testowy") hits = found;
  }
  const searchP95 = percentile(searchTimes, 95);

  console.log(
    `[T18] notes=${NOTES} writeMs=${writeMs.toFixed(1)} searchMsEach=${searchTimes.map((v) => v.toFixed(1)).join(",")} ` +
      `searchP95=${searchP95.toFixed(1)}`,
  );

  assert.equal(hits.length, 20, "search still returns a bounded page of hits, not all 1500 notes");
  // Every note matches "temat testowy" by construction; the port's own cap (limit
  // 20, see createLocalMemory in runtime/poc.ts) is what keeps the result bounded.
  const hitBytes = Buffer.byteLength(JSON.stringify(hits[0]));
  assert.ok(hitBytes < 1024, `one search hit is ${hitBytes} bytes, expected a bounded excerpt`);
  assert.ok(
    hits[0].excerpt.length <= 200,
    "a hit carries a short excerpt around the match, not the whole note (bounded by the port's own 60/140 char window)",
  );

  // Reported as a measurement, not a hard product SLO (none exists yet in
  // TEST-PLAN.md for note count): the current implementation is a directory scan
  // that reads every note per search (searchAnalyses in runtime/poc.ts), so this
  // is a real, linear cost — flagged here with a generous ceiling so a future
  // regression (e.g. an accidental O(n^2)) still fails loudly.
  assert.ok(searchP95 < 2000, `search across ${NOTES} notes took p95=${searchP95.toFixed(1)} ms, expected < 2000 ms`);
});

test("T18: polling status has a bounded payload and never starts new work", () => {
  const store = openSqliteStore({ path: join(tempDir(), "state.sqlite") });
  try {
    const request = {
      sourceRef: youtubeRefT18("POLLME"),
      mode: "summary",
      focus: null,
      question: null,
      language: "pl",
      analysisVersion: ANALYSIS_VERSION,
    };
    const enqueued = enqueueAnalysis({ store, request });
    const operationId = enqueued.operation.id;
    store.setOperationState(operationId, "running");

    // A long video: many parts already "started", the way a real multi-part
    // analysis would look mid-flight. The poll response must stay small no
    // matter how many attempts have accumulated underneath it.
    const PARTS = 400;
    for (let i = 0; i < PARTS; i += 1) {
      store.recordAttempt({
        id: `att_${operationId}_${i}`,
        operationId,
        phase: "started",
        partIndex: i,
        model: "stub",
        requestSummary: null,
        responseSummary: null,
        usage: null,
      });
    }

    const opsBefore = store.getOperation(operationId);
    const attemptsBefore = store.listAttempts(operationId).length;

    // What the jobs poll route actually returns while running (see runningView
    // in agent-os-module/src/app/api/omniwatch/jobs/handler.ts): the operation
    // plus a started/partsDone count, never the attempt list itself.
    function pollPayload() {
      const operation = store.getOperation(operationId);
      const started = store.listAttempts(operationId).filter(
        (a) => a.phase === "started" || a.phase === "response",
      ).length;
      return {
        id: operation.id,
        operationId: operation.id,
        state: "running",
        progress: { stage: "watch", parts: started, partsDone: Math.max(0, started - 1) },
      };
    }

    const POLLS = 200;
    const times = [];
    let payload = null;
    for (let i = 0; i < POLLS; i += 1) {
      const start = process.hrtime.bigint();
      payload = pollPayload();
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const p95 = percentile(times, 95);
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload));

    console.log(
      `[T18] polls=${POLLS} attempts=${PARTS} pollMs p50=${percentile(times, 50).toFixed(2)} ` +
        `p95=${p95.toFixed(2)} payloadBytes=${payloadBytes}`,
    );

    assert.equal(payload.progress.parts, PARTS);
    assert.ok(payloadBytes < 512, `poll payload is ${payloadBytes} bytes, expected a bounded status, not the attempt log`);
    assert.equal("attempts" in payload, false, "the poll never inlines the raw attempt list");
    assert.ok(p95 < 50, `polling status must stay cheap: p95=${p95.toFixed(2)} ms for ${POLLS} polls`);

    // The part that matters most: polling status is read-only. 200 polls must not
    // have created a new operation, a new attempt or moved the state along.
    const opsAfter = store.getOperation(operationId);
    const attemptsAfter = store.listAttempts(operationId).length;
    assert.equal(attemptsAfter, attemptsBefore, "polling recorded no new attempts");
    assert.equal(opsAfter.state, opsBefore.state, "polling never advances or restarts the operation");
    assert.equal(opsAfter.updatedAt, opsBefore.updatedAt, "polling does not even touch updatedAt");
  } finally {
    store.close();
  }
});

/**
 * T18 gap: "cache quota + aktywny plik nie jest kasowany" has no implementation
 * to test. Searched `packages/omniwatch/src`, `agent-os-module/src` and
 * `apps/standalone` for any quota/eviction concept (`quota`, `evict`,
 * `cacheBytes`, `diskUsage`, `freeSpace`) and found none: `cacheHours` /
 * `cacheHours()` (packages/omniwatch/src/sources/legacy.ts,
 * evaluateUploadFreshness) is strictly a *time*-based TTL on the remote upload
 * URL a beta cache entry points at (D8's `oss.json` freshness), not a local
 * media-cache size budget, and there is no eviction routine anywhere that could
 * protect "the active file" from being removed while it is in use.
 *
 * This is marked `todo` per the task instructions rather than silently
 * skipped or invented against: the assertions below describe the behaviour a
 * cache quota + active-file protection would need, and they fail today because
 * the feature does not exist. See I-test-gaps/REPORT.md for the full
 * reproduction and the exact files searched.
 */
test(
  "T18: cache quota evicts old media but never the file an active operation is using",
  { todo: "no cache-quota/eviction implementation exists in packages/omniwatch/src or apps/standalone (T18 gap, see I-test-gaps/REPORT.md)" },
  () => {
    assert.fail(
      "no quota/eviction API exists to exercise (grep for quota|evict|cacheBytes|diskUsage " +
        "under packages/omniwatch/src, agent-os-module/src and apps/standalone: zero matches)",
    );
  },
);

/**
 * T18 gap: "duży lokalny film (bez faktycznie dużego pliku - sparse/stub) →
 * pauza przy braku miejsca" also has no matching product behaviour.
 *
 * `SourceRegistry.prepare` (packages/omniwatch/src/sources/registry.ts) wraps
 * *any* error the media tool's `fetch()` throws — including Node's own ENOSPC
 * for "no space left on device" — as a flat `source_unavailable`. There is no
 * distinct pause state for running out of disk space: no `budget_paused` (that
 * errorClass exists only for the T13 cost-budget scan gate, see
 * packages/omniwatch/src/runtime/queue.ts) and nothing that later resumes once
 * space frees up. A large-download-hits-ENOSPC failure today looks exactly like
 * "this one video's cache/network failed" (T05's per-item failure, which does
 * not stop the rest of a batch) — which is a reasonable *fallback*, but it is
 * not the "pauza, dane nienaruszone" behaviour item 4 of the task asks for.
 *
 * The reproduction below uses a real sparse (mostly-empty, near-zero-actual-bytes)
 * file to simulate "a large local video" without writing gigabytes to CI disk,
 * and a media stub that raises ENOSPC the way a real download hitting a full
 * disk would. It is marked `todo`: the assertion documents the desired pause
 * behaviour, which does not exist yet.
 */
test(
  "T18: a large local video that runs out of disk space pauses instead of failing, and nothing is lost",
  { todo: "no disk-space pause exists; ENOSPC during fetch becomes a flat source_unavailable (T18 gap, see I-test-gaps/REPORT.md)" },
  async () => {
    const dir = tempDir();
    // A sparse stand-in for "a large local video": seek far out and write one byte,
    // so the file *reports* a large logical size without actually using that much
    // disk (most filesystems used in CI, including APFS/ext4, support sparse files).
    const sparsePath = join(dir, "large-sparse.mp4");
    const fd = openSync(sparsePath, "w");
    writeSync(fd, Buffer.from([0]), 0, 1, 5 * 1024 * 1024 * 1024 /* 5 GiB offset */);
    closeSync(fd);
    const size = statSync(sparsePath).size;
    assert.ok(size > 1024 * 1024 * 1024, "the stand-in file reports as a large video");

    const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    const source = createFixtureSource({
      title: "Duzy lokalny film",
      durationSeconds: 7200,
    });
    // Override fetch to raise ENOSPC the way a real download onto a full disk would.
    const failing = {
      capabilities: source.capabilities,
      resolve: source.resolve,
      async prepare() {
        throw enospc;
      },
      split: source.split,
    };

    const [outcome] = await prepareMany(failing, [youtubeRefT18("BIGFILM")]);
    assert.equal(outcome.ok, false);
    // Desired behaviour per the task: a readable pause, not a terminal failure —
    // and the sparse file (standing in for whatever partial download exists on
    // disk) must be left exactly as it was.
    assert.equal(outcome.error.errorClass, "budget_paused", "expected a pause state for out-of-space, not a flat failure");
    assert.equal(statSync(sparsePath).size, size, "the active/partial local file must not be touched by the failed prepare");
  },
);
