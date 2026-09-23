/**
 * T14 / T13 (offline): process lifecycle, shared operations and the Scout report.
 *
 * The panel is deliberately thrown away mid-run here: admission happens through the
 * jobs handler, then a *second* store connection on the same data directory runs the
 * worker — the same thing that happens when the tab (or the whole dashboard) is
 * closed. Nothing is cancelled by the poll disappearing.
 *
 * Scout is exercised through its route handler with the real shared `runScan`: the
 * manual button and Hermes call the same function, zero new material stays quiet, and
 * a report finished after the launcher timed out is delivered by the next run.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { enqueueAnalysis, pauseOperation } from "../../packages/omniwatch/src/runtime/queue.ts";
import { runWorker } from "../../packages/omniwatch/src/runtime/worker.ts";
import { runScan, saveCollection } from "../../packages/omniwatch/src/collections/scan.ts";
import { ensureRunReport, handOffRunReport, readRunReport, reportsToHandOff } from "../../packages/omniwatch/src/collections/report.ts";
import { openSqliteStore } from "../../packages/omniwatch/src/storage/index.ts";
import { createJobsHandler } from "../../agent-os-module/src/app/api/omniwatch/jobs/handler.ts";
import { createScoutHandler } from "../../agent-os-module/src/app/api/omniwatch/scout/handler.ts";
import { accountSourceRef } from "../../agent-os-module/src/app/api/omniwatch/channel/handler.ts";
import { createStatusHandler } from "../../agent-os-module/src/app/api/omniwatch/status/handler.ts";
import { createMediaHandler } from "../../agent-os-module/src/app/api/omniwatch/media/[...path]/handler.ts";
import { createI18nHandler } from "../../agent-os-module/src/app/api/omniwatch/i18n/handler.ts";
import {
  cachedIds,
  cleanupTempDirs,
  createHarness,
  listableSource,
  mediaLookup,
  tempDir,
  videoItem,
} from "./omniwatch-harness.mjs";

after(cleanupTempDirs);

const URL_A = "https://youtu.be/AAAAAAAAAAA";

function jobsPanel(h, overrides = {}) {
  const ensured = [];
  const deps = {
    store: h.store,
    memory: h.memory,
    resolveSource: async ({ url, sourceId }) =>
      sourceId
        ? { platform: "youtube", sourceId, canonicalUrl: `https://youtu.be/${sourceId}`, legacyId: sourceId }
        : h.source.resolve({ url }),
    isCached: cachedIds(["AAAAAAAAAAA"]),
    enqueue: (request) => enqueueAnalysis({ store: h.store, request }),
    ensureWorker: async (id) => {
      ensured.push(id);
    },
    lookupMedia: mediaLookup({ AAAAAAAAAAA: { id: "AAAAAAAAAAA", title: "A", channel: "C", duration: "2:00", seconds: 120, strip: [3, 9] } }),
    legacyFilm: { dispatch: async () => ({ answer: "", stats: {} }) },
    defaultLanguage: "en",
    languages: ["en", "pl"],
    ...overrides,
  };
  return { handler: createJobsHandler(deps), deps, ensured };
}

function scoutPanel(h, sources, overrides = {}) {
  const config = { collectionId: "scout-collection", channels: [] };
  for (const collectionId of ["scout-collection", "hermes-collection"]) {
    saveCollection(h.store, {
      settings: { collectionId, mode: "summary", focus: null, question: null, language: "en", maxNewItems: null, budgetUsd: null },
      sources,
    });
  }
  const deps = {
    store: h.store,
    runScan: async (input) =>
      runScan({
        deps: h.deps,
        request: {
          collectionId: input.collectionId,
          runId: input.runId,
          trigger: input.trigger,
          sources: input.sources,
          confirmPaidListing: input.confirmPaidListing,
        },
      }),
    reportsToHandOff: (limit) => reportsToHandOff(h.store, limit),
    handOffRunReport: (id, note) => handOffRunReport(h.store, id, note),
    readRunReport: (runId) => readRunReport(h.store, runId),
    readConfig: async () => config,
    readLatest: async () => null,
    toolsPresent: async () => ({ ytDlp: true, ffmpeg: true }),
    apiKeyPresent: async () => true,
    apifyReady: async () => ({ hermes: true, apify: true }),
    needsApify: (sources) => sources.some((s) => s.platform !== "youtube"),
    saveCollection: ({ collectionId, sources }) =>
      saveCollection(h.store, {
        settings: { collectionId, mode: "summary", focus: null, question: null, language: "en", maxNewItems: null, budgetUsd: null },
        sources,
      }),
    accountRef: (platform, handle) => accountSourceRef({ platform, handle }),
    ...overrides,
  };
  return { handler: createScoutHandler(deps), deps, config };
}

const postJson = (handler, path, body) =>
  handler.POST(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

/** Poll the scout job until it leaves "running", the way the tab does. */
async function awaitScoutJob(handler, jobId, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    const view = await (await handler.GET(new Request(`http://localhost/api/omniwatch/scout?job=${jobId}`))).json();
    if (view.state === "done") return view;
    if (view.state === "error") throw new Error(`scout failed: ${view.error}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("scout job did not finish");
}

test("T14: killing the panel does not kill the worker; a fresh process still finishes the job", async () => {
  const h = createHarness();
  const panel = jobsPanel(h);

  const started = await (await postJson(panel.handler, "/api/omniwatch/jobs", { url: URL_A })).json();
  // The panel is gone: no poll, no handler, no RAM job. A different connection to the
  // same data directory is what the spawned worker has.
  const secondStore = openSqliteStore({ path: join(h.dataDir, "state.sqlite"), ownerStaleAfterMs: 0 });
  try {
    const result = await runWorker({
      deps: { ...h.deps, store: secondStore },
      operationIds: [started.id],
      ownerToken: "worker_process_2",
    });
    assert.equal(result.delivered, 1);
    assert.equal(secondStore.getOperation(started.id).state, "delivered");
  } finally {
    secondStore.close();
  }

  // And the answer is in the knowledge library, readable after the fact.
  const delivery = h.store.getDeliveryForOperation(started.id);
  const note = await h.memory.readAnalysis(delivery.analysisId);
  assert.match(note.result.content, /punkt pierwszy/);
  assert.equal(h.model.calls.length, 1);
});

test("T14: two runs share one operation instead of paying twice for the same video", async () => {
  const source = listableSource({ items: [videoItem("AAAAAAAAAAA", 120)] });
  const h = createHarness({ source });
  const refs = [await source.resolve({ url: URL_A })];

  const first = await runScan({
    deps: h.deps,
    request: { collectionId: "run-a", runId: "run_a", trigger: "cli", sources: refs },
  });
  assert.equal(first.analysed, 1);
  assert.equal(h.model.calls.length, 1);

  // A second run of the same goal over the same video: one shared operation, no new
  // model call (D3: overlapping scans never duplicate identical work).
  const second = await runScan({
    deps: h.deps,
    request: { collectionId: "run-b", runId: "run_b", trigger: "cli", sources: refs },
  });
  assert.equal(second.newItems, 0);
  assert.equal(second.analysed, 0);
  assert.equal(h.model.calls.length, 1, "the shared operation was reused, not re-run");
});

test("T14: pausing one run's item never cancels the work another run already needs", async () => {
  const source = listableSource({ items: [videoItem("AAAAAAAAAAA", 120), videoItem("BBBBBBBBBBB", 60)] });
  const h = createHarness({ source });
  const refA = await source.resolve({ url: URL_A });
  const refB = await source.resolve({ url: "https://youtu.be/BBBBBBBBBBB" });

  // Run A admits one video and defers the other to a later run.
  const runA = await runScan({
    deps: h.deps,
    request: { collectionId: "run-a", runId: "run_a", trigger: "cli", sources: [refA, refB], settings: { maxNewItems: 1 } },
  });
  assert.equal(runA.analysed, 1);
  assert.equal(runA.pendingItems, 1);

  const deferred = h.store.listOperations({ limit: 20 }).find((operation) => operation.state === "pending");
  assert.ok(deferred, "the second video waits for the next run");

  // Run B only needs the video run A already finished.
  const runB = await runScan({
    deps: h.deps,
    request: { collectionId: "run-b", runId: "run_b", trigger: "cli", sources: [refA] },
  });
  assert.equal(runB.analysed, 0);
  assert.equal(h.model.calls.length, 1);

  // A pause of run A's own deferred item is a decision about that item only.
  pauseOperation(h.store, deferred.id, "wstrzymane w przebiegu A");
  assert.equal(h.store.getOperation(deferred.id).state, "budget_paused");

  const sharedOperation = h.store.getOperationByKey(deferred.analysisKey);
  assert.equal(sharedOperation.state, "budget_paused");
  const delivered = h.store.listOperations({ state: "delivered", limit: 10 });
  assert.equal(delivered.length, 1, "the finished work another run depends on is untouched");
  assert.equal(h.model.calls.length, 1, "and no new paid call happened");
});

test("T13: zero new material produces no report and no notification", async () => {
  const source = listableSource({ items: [videoItem("AAAAAAAAAAA", 120)] });
  const h = createHarness({ source });
  const scout = scoutPanel(h, [await source.resolve({ url: URL_A })]);

  const first = await (await postJson(scout.handler, "/api/omniwatch/scout", {
    action: "scan",
    collectionId: "scout-collection",
  })).json();
  const firstView = await awaitScoutJob(scout.handler, first.id);
  assert.equal(firstView.outcome.analysed, 1);
  assert.ok(firstView.outcome.report, "new material is reported");
  assert.equal(firstView.run.analyses.length, 1, "the Scout run view still carries the answers");
  assert.match(firstView.run.analyses[0].text, /punkt pierwszy/);
  assert.equal(h.model.calls.length, 1);

  // Same collection, same goal, nothing new: silence.
  const second = await (await postJson(scout.handler, "/api/omniwatch/scout", {
    action: "scan",
    collectionId: "scout-collection",
  })).json();
  const secondView = await awaitScoutJob(scout.handler, second.id);
  assert.equal(secondView.outcome.analysed, 0);
  assert.equal(secondView.outcome.report, null, "no new material means no report");
  assert.equal(secondView.outcome.reportDecision.report, false);
  assert.equal(h.model.calls.length, 1, "and no model call");
});

test("T13: a report finished after the launcher timed out is delivered by the next run", async () => {
  const source = listableSource({ items: [videoItem("AAAAAAAAAAA", 120)] });
  const h = createHarness({ source });
  const scout = scoutPanel(h, [await source.resolve({ url: URL_A })]);

  // A run that finished after the launcher gave up: its report is durable and pending.
  ensureRunReport(h.store, { runId: "run_after_timeout", summary: "2 nowych analiz", newAnalyses: 2 });
  assert.equal(reportsToHandOff(h.store).length, 1);

  const next = await (await postJson(scout.handler, "/api/omniwatch/scout", {
    action: "scan",
    collectionId: "scout-collection",
  })).json();
  assert.equal(next.handedOff.length, 1, "the previous run's report goes out first");
  assert.equal(next.handedOff[0].runId, "run_after_timeout");
  assert.equal(h.store.getReport("rpt_run_after_timeout").state, "handed_off");
  await awaitScoutJob(scout.handler, next.id);
});

test("T13: `?report=<runId>` is a pure re-read and never analyses anything", async () => {
  const source = listableSource({ items: [videoItem("AAAAAAAAAAA", 120)] });
  const h = createHarness({ source });
  const scout = scoutPanel(h, [await source.resolve({ url: URL_A })]);

  const started = await (await postJson(scout.handler, "/api/omniwatch/scout", {
    action: "scan",
    collectionId: "scout-collection",
  })).json();
  const view = await awaitScoutJob(scout.handler, started.id);
  const runId = view.outcome.runId;
  const callsAfterScan = h.model.calls.length;

  const reread = await (await scout.handler.GET(new Request(`http://localhost/api/omniwatch/scout?report=${runId}`))).json();
  assert.equal(reread.runId, runId);
  assert.equal(reread.reports.length, 1);
  assert.equal(reread.reports[0].protocol, "omniwatch.report.v1");
  assert.equal(h.model.calls.length, callsAfterScan, "re-reading a report costs nothing");
});

test("T13: Hermes supplies a collection id, never a prompt", async () => {
  const source = listableSource({ items: [videoItem("AAAAAAAAAAA", 120)] });
  const h = createHarness({ source });
  const scout = scoutPanel(h, [await source.resolve({ url: URL_A })]);

  const noCollection = await postJson(scout.handler, "/api/omniwatch/scout", { action: "scan" });
  assert.equal(noCollection.status, 400, "the manual button without a configured collection is refused");

  const started = await (await postJson(scout.handler, "/api/omniwatch/scout", {
    action: "scan",
    collectionId: "hermes-collection",
    trigger: "schedule",
  })).json();
  const view = await awaitScoutJob(scout.handler, started.id);
  assert.equal(view.outcome.collectionId, "hermes-collection");
  assert.equal(view.outcome.trigger, "schedule");
});

test("status keeps the fields the existing UI reads, and adds the durable view", async () => {
  const h = createHarness();
  const handler = createStatusHandler({
    store: h.store,
    apiKeyPresent: async () => true,
    toolsPresent: async () => ({ ytDlp: true, ffmpeg: false }),
    defaultLang: "en",
    langs: [{ code: "en", name: "English" }],
  });
  const view = await (await handler.GET()).json();
  assert.equal(view.ready, false, "a missing ffmpeg still reports not-ready");
  assert.equal(view.key, true);
  assert.equal(view.ytDlp, true);
  assert.equal(view.ffmpeg, false);
  assert.equal(view.defaultLang, "en");
  assert.deepEqual(view.langs, [{ code: "en", name: "English" }]);
  assert.deepEqual(view.operations, []);
  assert.equal(view.owner, null);
});

test("media serves a cached file with range support and refuses an unknown id", async () => {
  const dir = tempDir("omniwatch-media-");
  const videoDir = join(dir, "vid");
  mkdirSync(videoDir, { recursive: true });
  writeFileSync(join(videoDir, "source.mp4"), "0123456789");
  const handler = createMediaHandler({
    videoDir: (id) => join(dir, id),
    frameJpeg: async () => join(dir, "vid", "missing.jpg"),
  });

  const full = await handler.GET(new Request("http://localhost/api/omniwatch/media/video/vid"), {
    params: Promise.resolve({ path: ["video", "vid"] }),
  });
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789");

  const ranged = await handler.GET(
    new Request("http://localhost/api/omniwatch/media/video/vid", { headers: { range: "bytes=2-4" } }),
    { params: Promise.resolve({ path: ["video", "vid"] }) },
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await ranged.text(), "234");

  const frame = await handler.GET(new Request("http://localhost/api/omniwatch/media/frame/vid/3"), {
    params: Promise.resolve({ path: ["frame", "vid", "3"] }),
  });
  assert.equal(frame.status, 404);

  const bad = await handler.GET(new Request("http://localhost/api/omniwatch/media/nope/x"), {
    params: Promise.resolve({ path: ["nope", "x"] }),
  });
  assert.equal(bad.status, 404);
});

test("i18n hands the tab the same translations the prompts use", async () => {
  const handler = createI18nHandler({ en: { name: "English" }, pl: { name: "Polski" } });
  const view = await (await handler.GET()).json();
  assert.deepEqual(Object.keys(view), ["en", "pl"]);
});
