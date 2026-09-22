/**
 * T13 — one scan operation for the manual button and Hermes (T5 / D8 / D11).
 *
 * Offline: stub lister, stub model (counts every paid call), stub knowledge
 * library, real SQLite file per test. No network, no paid listing.
 *
 * Covered: manual and scheduled runs sharing one collection and one plan; 0 new =
 * 0 model calls and silence; 2 new = exactly 2 analyses; a changed goal adding
 * analyses without replacing or re-paying the old ones; the scheduled default of
 * 10 with the rest explicitly pending; the backlog from an earlier run still being
 * picked up; a budget pause instead of spending; a paid listing refusal with zero
 * paid calls; one bad item not discarding the good results; a store write failure
 * stopping further paid work; and a launcher timeout whose report arrives at the
 * next run with zero extra model calls.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANALYSIS_VERSION } from "../src/contracts/types.ts";
import { OmniWatchError } from "../src/contracts/errors.ts";
import { openSqliteStore } from "../src/storage/index.ts";
import {
  DEFAULT_SCHEDULED_MAX_NEW_ITEMS,
  planScanItems,
  plainScanSettings,
  readCollection,
  runScan,
  scanPayload,
} from "../src/collections/index.ts";
import { confirmRunReport, readRunReport, reportsToHandOff, handOffRunReport } from "../src/collections/index.ts";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omniwatch-t13-scan-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const ANSWER = "## Streszczenie\nSyntetyczna odpowiedz. [0:03] ekran";

function youtubeRef(id) {
  return { platform: "youtube", sourceId: id, canonicalUrl: `https://youtu.be/${id}`, legacyId: id };
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

function makeClock() {
  let tick = 0;
  return {
    now: () => new Date(Date.parse("2026-09-22T10:00:00.000Z") + tick++ * 1000),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

function makeLogger() {
  const lines = [];
  const push = (level) => (message, fields) => lines.push({ level, message, fields });
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

function makeMemory() {
  const notes = new Map();
  return {
    notes,
    async writeAnalysis(result) {
      const existing = notes.get(result.analysisId);
      if (existing) return { memoryRef: existing.ref, reused: true };
      const ref = {
        analysisId: result.analysisId,
        adapter: "stub-memory",
        relativePath: `OmniWatch/Analyses/${result.analysisId}.md`,
        anchor: null,
        fingerprint: `fp_${result.analysisId}`,
      };
      notes.set(result.analysisId, { result, ref });
      return { memoryRef: ref, reused: false };
    },
    async readAnalysis(analysisId) {
      const existing = notes.get(analysisId);
      return existing ? { result: existing.result, memoryRef: existing.ref } : null;
    },
    async searchAnalyses() {
      return [];
    },
    async answerFromAnalyses() {
      return { text: "", refs: [], notFound: true };
    },
  };
}

/**
 * One scan workspace: real store, stub source, stub model that counts paid calls.
 * `pages` may be an array or a function `(callIndex, cursor) => page`.
 */
function makeWorkspace({ pages, capabilities = youtubeCapabilities(), modelFailureFor = null } = {}) {
  const dir = tempDir();
  const store = openSqliteStore({ path: join(dir, "state.sqlite") });
  const modelCalls = [];
  const listerCalls = [];
  const model = {
    modelName: "stub-model",
    async call(request) {
      modelCalls.push(request);
      if (modelFailureFor && modelFailureFor(request)) {
        throw new OmniWatchError("source_unavailable", "material niedostepny dla tego jednego filmu");
      }
      return {
        text: ANSWER,
        usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.002, costKnown: true },
        completed: true,
      };
    },
  };
  const source = {
    listerCalls,
    capabilities: () => capabilities,
    async resolve({ url }) {
      return youtubeRef(url.split("/").pop());
    },
    async prepare(sourceRef) {
      return {
        sourceRef,
        title: `Film ${sourceRef.sourceId}`,
        channel: "Kanal",
        durationSeconds: 16,
        extractor: "stub",
        localPath: "/tmp/omniwatch/source.mp4",
        uploadedUrl: null,
        reusedUpload: false,
      };
    },
    async split() {
      return [{ index: 0, startSeconds: 0, endSeconds: 16, localPath: "/tmp/omniwatch/source.mp4" }];
    },
    async list(_ref, options) {
      listerCalls.push(options.cursor ?? null);
      const index = listerCalls.length - 1;
      if (typeof pages === "function") return pages(index, options.cursor ?? null);
      return pages[Math.min(index, pages.length - 1)];
    },
  };
  const memory = makeMemory();
  const deps = {
    clock: makeClock(),
    logger: makeLogger(),
    config: {
      dataDir: dir,
      memoryRoot: join(dir, "vault"),
      language: "pl",
      modelName: "stub-model",
      apiKey: () => null,
      apiBaseUrl: () => null,
      maxFramesPerPart: () => 2400,
      cacheHours: () => 48,
    },
    store,
    source,
    model,
    memory,
  };
  return { dir, store, source, model, memory, deps, modelCalls, listerCalls };
}

function listingPage(ids, { cursor = null, completeness = "complete" } = {}) {
  return { items: ids.map((id) => ({ sourceRef: youtubeRef(id), title: `Film ${id}` })), cursor, completeness };
}

function allItemsPage(ids) {
  return () => listingPage(ids);
}

/* --------------------------------------------- T13: same plan, 0 and 2 new --- */

test("2 new material = exactly 2 analyses, and a report with links", async () => {
  const ws = makeWorkspace({ pages: allItemsPage(["N1", "N2"]) });
  const outcome = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_two", trigger: "manual", sources: [youtubeRef("UC_two")] },
  });

  assert.equal(outcome.state, "completed");
  assert.equal(outcome.analysed, 2);
  assert.equal(outcome.modelCalls, 2);
  assert.equal(ws.modelCalls.length, 2, "exactly one paid call per new material");
  assert.equal(outcome.pendingItems, 0);
  assert.equal(outcome.failedItems, 0);
  assert.equal(outcome.report.newAnalyses, 2);
  assert.match(outcome.report.summary, /https:\/\/youtu\.be\/N1/);
  assert.match(outcome.report.summary, /https:\/\/youtu\.be\/N2/);
  assert.equal(outcome.reportDecision.report, true);
  assert.equal(outcome.listingCompleteness, "complete");
  assert.equal(outcome.fullChannel, true);
  assert.equal(scanPayload(outcome).protocol, "omniwatch.scan.v1");
  assert.deepEqual(outcome.links, ["https://youtu.be/N1", "https://youtu.be/N2"]);
  assert.equal(
    ws.store.listRunItems(outcome.runId, { limit: 10 }).total,
    2,
    "one durable run item per material, never a duplicate row",
  );
  ws.store.close();
});

test("a manual run and a scheduled run share the collection, the settings and the plan; 0 new = 0 calls and no report", async () => {
  const ws = makeWorkspace({ pages: allItemsPage(["M1", "M2"]) });
  const sources = [youtubeRef("UC_shared")];

  const manual = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_shared", trigger: "manual", sources, runId: "run_manual" },
  });
  assert.equal(manual.analysed, 2);
  assert.equal(ws.modelCalls.length, 2);

  const saved = readCollection(ws.store, "col_shared");
  assert.deepEqual(saved.sources, sources);
  const manualPlan = planScanItems(ws.store, "col_shared", saved.settings, [
    { sourceRef: youtubeRef("M1"), title: "Film M1" },
    { sourceRef: youtubeRef("M2"), title: "Film M2" },
  ]);
  assert.equal(manualPlan.newItems.length, 0, "the plan for the same goal is empty after the manual run");

  const scheduled = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_shared", trigger: "schedule", runId: "run_scheduled" },
  });
  assert.equal(scheduled.analysed, 0);
  assert.equal(scheduled.modelCalls, 0);
  assert.equal(ws.modelCalls.length, 2, "the scheduled run adds no paid call");
  assert.equal(scheduled.report, null, "zero new material produces no report");
  assert.equal(scheduled.reportDecision.report, false);
  assert.equal(scheduled.state, "completed");
  assert.deepEqual(readRunReport(ws.store, "run_scheduled"), []);

  const manualRun = ws.store.getRun("run_manual");
  const scheduledRun = ws.store.getRun("run_scheduled");
  assert.equal(manualRun.collectionId, scheduledRun.collectionId);
  assert.deepEqual(
    plainScanSettings(manualRun.settings),
    plainScanSettings(scheduledRun.settings),
    "both runs use the same saved settings snapshot (only the listing cursor progresses)",
  );
  assert.equal(scheduled.maxNewItems, DEFAULT_SCHEDULED_MAX_NEW_ITEMS);
  ws.store.close();
});

test("a changed goal creates new analyses without replacing or re-paying the old ones", async () => {
  const ws = makeWorkspace({ pages: allItemsPage(["G1", "G2"]) });
  const sources = [youtubeRef("UC_goal")];

  const first = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_goal", trigger: "manual", sources, runId: "run_goal_a" },
  });
  assert.equal(first.analysed, 2);
  const firstOperations = ws.store.listRunItems("run_goal_a", { limit: 10 }).items.map((row) => row.operationId);

  const second = await runScan({
    deps: ws.deps,
    request: {
      collectionId: "col_goal",
      trigger: "manual",
      runId: "run_goal_b",
      settings: { focus: "montaz i dzwiek" },
    },
  });
  assert.equal(second.analysed, 2, "the new goal analyses both materials again");
  assert.equal(ws.modelCalls.length, 4);

  const secondOperations = ws.store.listRunItems("run_goal_b", { limit: 10 }).items.map((row) => row.operationId);
  assert.equal(secondOperations.some((id) => firstOperations.includes(id)), false, "new goal = new operations");
  for (const operationId of firstOperations) {
    assert.equal(ws.store.getOperation(operationId).state, "delivered", "the earlier result stays delivered");
  }
  for (const operationId of secondOperations) {
    assert.equal(ws.store.getOperation(operationId).request.focus, "montaz i dzwiek");
  }
  ws.store.close();
});

/* -------------------------------------------------- T13: scheduled limit --- */

test("the scheduled default keeps 10 and leaves the rest explicitly pending", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `L${index}`);
  const ws = makeWorkspace({ pages: allItemsPage(ids) });
  const outcome = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_limit", trigger: "schedule", sources: [youtubeRef("UC_limit")] },
  });

  assert.equal(outcome.maxNewItems, DEFAULT_SCHEDULED_MAX_NEW_ITEMS);
  assert.equal(outcome.analysed, 10);
  assert.equal(outcome.pendingItems, 2);
  assert.equal(outcome.state, "partial");
  assert.equal(ws.modelCalls.length, 10);
  assert.equal(outcome.report.newAnalyses, 10);
  assert.equal(outcome.report.pendingItems, 2);
  assert.equal(outcome.reportDecision.report, true, "deferred work is reported, never silently dropped");
  const pending = ws.store.listOperations({ state: "pending" });
  assert.equal(pending.length, 2);
  assert.equal(ws.store.listRunItems(outcome.runId, { limit: 50 }).total, 12, "all 12 materials are on the run list");
  ws.store.close();
});

test("the next run also picks up earlier unprocessed ids when they leave the source window", async () => {
  const ws = makeWorkspace({
    // First call: the whole window. Later calls: the window moved on and only the
    // newest material is still visible.
    pages: (index) => (index === 0 ? listingPage(["B1", "B2", "B3"]) : listingPage(["B3"])),
  });
  const sources = [youtubeRef("UC_backlog")];

  const first = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_backlog", trigger: "schedule", sources, settings: { maxNewItems: 1 }, runId: "run_backlog_a" },
  });
  assert.equal(first.analysed, 1);
  assert.equal(first.pendingItems, 2);
  assert.equal(ws.modelCalls.length, 1);

  // The archive window moved: the next listing only offers the newest item, but
  // the two ids an earlier run deferred must still be picked up (D11).
  const second = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_backlog", trigger: "manual", settings: { maxNewItems: 5 }, runId: "run_backlog_b" },
  });
  assert.equal(second.analysed, 2, "B3 from the window and B2 from the backlog");
  assert.equal(ws.modelCalls.length, 3, "B3 is analysed once, not twice");
  assert.equal(second.pendingItems, 0);
  assert.equal(second.state, "completed");
  ws.store.close();
});

/* ------------------------------------------------------- T13: budget gate --- */

test("a run whose estimate exceeds the accepted budget pauses visibly instead of spending", async () => {
  const ids = ["P1", "P2", "P3", "P4", "P5"];
  const ws = makeWorkspace({ pages: allItemsPage(ids) });
  const outcome = await runScan({
    deps: ws.deps,
    request: {
      collectionId: "col_budget",
      trigger: "manual",
      sources: [youtubeRef("UC_budget")],
      settings: { budgetUsd: 0.01 },
    },
    estimator: () => 0.004,
  });

  assert.equal(outcome.state, "paused");
  assert.equal(outcome.analysed, 2, "0.008 USD fits the accepted budget");
  assert.equal(ws.modelCalls.length, 2, "the third analysis is never started");
  assert.equal(outcome.reservedCostUsd, 0.008);
  assert.match(outcome.pausedReason, /budzet/);
  assert.equal(outcome.pendingItems, 3);
  assert.equal(outcome.reportDecision.report, true, "a budget pause is reported explicitly");
  assert.match(outcome.report.summary, /uwagi: pauza:/);
  ws.store.close();
});

test("an unknown estimate with an accepted budget pauses with zero paid calls", async () => {
  const ws = makeWorkspace({ pages: allItemsPage(["U1", "U2"]) });
  const outcome = await runScan({
    deps: ws.deps,
    request: {
      collectionId: "col_unknown_cost",
      trigger: "manual",
      sources: [youtubeRef("UC_unknown")],
      settings: { budgetUsd: 1 },
    },
    estimator: () => null,
  });

  assert.equal(outcome.state, "paused");
  assert.equal(ws.modelCalls.length, 0);
  assert.equal(outcome.modelCalls, 0);
  assert.match(outcome.pausedReason, /nie jest wiarygodny/);
  ws.store.close();
});

/* ------------------------------------------------------ paid listing gate --- */

test("billed listing needs explicit confirmation; refusal = failed run with zero paid calls", async () => {
  const paidCapabilities = youtubeCapabilities({
    platform: "x",
    listing: "limited",
    listingScopeNote: "ostatnie posty z materialem wideo; listowanie jest platne i wymaga jawnego startu",
    listingCost: "paid",
    requiresConfig: ["APIFY_TOKEN"],
  });
  const ws = makeWorkspace({ pages: allItemsPage(["X1"]), capabilities: paidCapabilities });
  const sources = [{ platform: "x", sourceId: "x_account", canonicalUrl: "https://x.com/account" }];

  const refused = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_paid", trigger: "manual", sources },
  });
  assert.equal(refused.state, "failed");
  assert.equal(refused.errorClass, "invalid_input");
  assert.match(refused.errorMessage, /platne/);
  assert.equal(ws.listerCalls.length, 0, "a refusal performs zero lister calls");
  assert.equal(ws.modelCalls.length, 0);

  const confirmed = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_paid", trigger: "manual", confirmPaidListing: true, runId: "run_paid_ok" },
  });
  assert.equal(confirmed.analysed, 1);
  assert.equal(ws.listerCalls.length, 1);
  assert.equal(confirmed.sources[0].scope, "limited");
  assert.equal(confirmed.fullChannel, false, "a paid limited listing is never a whole channel");
  ws.store.close();
});

/* ---------------------------------------------------- failure isolation --- */

test("one bad item does not discard the good results", async () => {
  const ws = makeWorkspace({
    pages: allItemsPage(["F1", "F2", "F3"]),
    modelFailureFor: (request) => request.messages.some((message) => message.text.includes("F2")),
  });
  const outcome = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_isolate", trigger: "manual", sources: [youtubeRef("UC_isolate")] },
  });

  assert.equal(outcome.analysed, 2);
  assert.equal(outcome.failedItems, 1);
  assert.equal(outcome.state, "partial");
  assert.equal(outcome.report.newAnalyses, 2);
  assert.equal(outcome.report.failedItems, 1);
  assert.equal(outcome.reportDecision.report, true);
  const items = ws.store.listRunItems(outcome.runId, { limit: 10 }).items;
  assert.equal(items.filter((row) => row.state === "done").length, 2);
  assert.equal(items.filter((row) => row.state === "failed").length, 1);
  ws.store.close();
});

test("a store write failure stops further paid work (D3)", async () => {
  const ws = makeWorkspace({ pages: allItemsPage(["S1", "S2", "S3"]) });
  const failingStore = new Proxy(ws.store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "updateRunItem") {
        return () => {
          throw new OmniWatchError("storage_unavailable", "dysk pelny: nie mozna zapisac statusu pozycji");
        };
      }
      return (...args) => value.apply(target, args);
    },
  });

  const outcome = await runScan({
    deps: { ...ws.deps, store: failingStore },
    request: { collectionId: "col_disk", trigger: "manual", sources: [youtubeRef("UC_disk")] },
  });

  assert.equal(outcome.state, "failed");
  assert.match(outcome.errorMessage, /dysk pelny/);
  assert.equal(ws.modelCalls.length, 1, "the second paid call never starts after the write failure");
  ws.store.close();
});

/* --------------------------------------------- T13: launcher timeout path --- */

test("a report finished after a launcher timeout arrives at the next run with zero extra model calls", async () => {
  const ws = makeWorkspace({ pages: allItemsPage(["T1", "T2"]) });
  const sources = [youtubeRef("UC_timeout")];

  const first = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_timeout", trigger: "schedule", sources, runId: "run_timeout_a" },
  });
  assert.equal(first.analysed, 2);
  assert.equal(ws.modelCalls.length, 2);
  assert.equal(first.report.state, "pending");

  // The launcher timed out and never confirmed: the report stays deliverable.
  const undelivered = reportsToHandOff(ws.store);
  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].runId, "run_timeout_a");

  // Next cron run: first deliver the stored report, then request new work.
  const handedOff = handOffRunReport(ws.store, undelivered[0].id, "przekazano Hermesowi po timeoutcie");
  assert.equal(handedOff.state, "handed_off");
  assert.equal(readRunReport(ws.store, "run_timeout_a").length, 1);
  assert.equal(
    reportsToHandOff(ws.store).length,
    1,
    "stdout is only 'handed to Hermes'; without an acknowledgement the report stays deliverable",
  );
  assert.equal(confirmRunReport(ws.store, handedOff.id, "adapter potwierdzil odbior").state, "confirmed");

  const second = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_timeout", trigger: "schedule", runId: "run_timeout_b" },
  });
  assert.equal(second.analysed, 0);
  assert.equal(ws.modelCalls.length, 2, "reading and re-sending the report costs no model call");
  assert.equal(second.report, null, "the quiet run adds no second report");
  assert.equal(reportsToHandOff(ws.store).length, 0, "a confirmed report is never delivered twice");
  ws.store.close();
});

test("runScan refuses a scan without a collection id or sources", async () => {
  const ws = makeWorkspace({ pages: allItemsPage(["Z1"]) });
  await assert.rejects(
    runScan({ deps: ws.deps, request: { collectionId: "  ", trigger: "manual" } }),
    (error) => error.errorClass === "invalid_input" && /kolekcji/.test(error.message),
  );
  await assert.rejects(
    runScan({ deps: ws.deps, request: { collectionId: "col_empty", trigger: "manual" } }),
    (error) => error.errorClass === "invalid_input" && /zrodel/.test(error.message),
  );
  assert.equal(ws.modelCalls.length, 0);
  ws.store.close();
});

test("a source with zero material ends as empty: no analysis, no failure, no report", async () => {
  const ws = makeWorkspace({ pages: [{ items: [], cursor: null, completeness: "complete" }] });
  const outcome = await runScan({
    deps: ws.deps,
    request: { collectionId: "col_empty", trigger: "schedule", sources: [youtubeRef("UC_empty")] },
  });

  assert.equal(outcome.listingCompleteness, "empty");
  assert.equal(outcome.state, "completed");
  assert.equal(outcome.analysed, 0);
  assert.equal(outcome.failedItems, 0);
  assert.equal(outcome.pendingItems, 0);
  assert.equal(ws.modelCalls.length, 0);
  assert.equal(outcome.report, null);
  assert.equal(outcome.reportDecision.report, false);
  ws.store.close();
});
