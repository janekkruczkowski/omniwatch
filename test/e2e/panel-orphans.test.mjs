/**
 * R2-04 (T04 / T07 / T14, QA M07 / M08 / M14): the Agent OS panel owns its data
 * directory and recovers what a killed Next process left behind.
 *
 * QA found `op_0e06e42ba8964839efcdd127` in `running` with a `started` attempt and an
 * empty `runtime_owner` a day after the Next process that ran it was killed; the jobs
 * GET answered `running, partsDone 0` for ever. These tests rebuild exactly that row
 * offline (stub model, temp SQLite, no network, no paid call) and prove that:
 *   - a restarted panel turns it into `outcome_unknown` without calling the model;
 *   - the card's GET returns that final state (retryable), not a spinner;
 *   - only the user's confirmed retry pays, once;
 *   - a second panel process on the same data directory does not work the same
 *     operation twice and does not "recover" an operation a live owner is running.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { enqueueAnalysis } from "../../packages/omniwatch/src/runtime/queue.ts";
import { OperationJournal } from "../../packages/omniwatch/src/storage/operations.ts";
import { openSqliteStore } from "../../packages/omniwatch/src/storage/index.ts";
import { ANALYSIS_VERSION } from "../../packages/omniwatch/src/contracts/types.ts";
import { createJobsHandler } from "../../agent-os-module/src/app/api/omniwatch/jobs/handler.ts";
import {
  createPanelConsumer,
  createPanelRuntime,
} from "../../agent-os-module/src/lib/omniwatchPanelRuntime.ts";
import { cachedIds, cleanupTempDirs, createHarness, mediaLookup, recordingModel, tempDir } from "./omniwatch-harness.mjs";

after(cleanupTempDirs);

const VIDEO = "Xu0JinVn_Fg";
const URL = `https://www.youtube.com/watch?v=${VIDEO}`;
/** The real takeover window: a live owner must not be stolen from in these tests. */
const STALE_MS = 30_000;

function openStore(dataDir) {
  const store = openSqliteStore({ path: join(dataDir, "state.sqlite"), ownerStaleAfterMs: STALE_MS });
  store.migrate();
  return store;
}

async function summaryRequest(h, question = null) {
  return {
    sourceRef: await h.source.resolve({ url: URL }),
    mode: "summary",
    focus: null,
    question,
    language: "pl",
    analysisVersion: ANALYSIS_VERSION,
    conversationId: null,
    parentTurnId: null,
    force: false,
  };
}

/**
 * What the killed Next process left: admitted, started (`running`), one paid call
 * recorded as `started`, never answered, and no owner row (the old in-process path
 * never took one).
 */
async function orphanRunningCall(store, request) {
  const { operation } = enqueueAnalysis({ store, request });
  const journal = new OperationJournal({ store });
  journal.start(operation.id);
  const sink = journal.sinkFor(operation.id, "stub-recording");
  const attemptId = `att_${operation.id}_1`;
  await sink.intent({ id: attemptId, partIndex: 0, model: "stub-recording" });
  await sink.started(attemptId, {});
  return operation.id;
}

/** Died while downloading: `running`, but no call ever reached the provider. */
function orphanBeforeAnyCall(store, request) {
  const { operation } = enqueueAnalysis({ store, request });
  new OperationJournal({ store }).start(operation.id);
  return operation.id;
}

function jobsHandlerFor(h, consumer) {
  return createJobsHandler({
    store: h.store,
    memory: h.memory,
    resolveSource: async ({ url }) => h.source.resolve({ url }),
    isCached: cachedIds([VIDEO]),
    enqueue: (request) => enqueueAnalysis({ store: h.store, request }),
    ensureWorker: (id) => consumer.run(id),
    retryUnknown: (id) => consumer.retry(id),
    recover: async () => {
      await consumer.recover();
    },
    hasConsumer: (id) => consumer.hasConsumer(id),
    lookupMedia: mediaLookup({}),
    legacyFilm: { dispatch: async () => ({ answer: "", stats: {} }) },
    defaultLanguage: "pl",
    languages: ["pl", "en"],
  });
}

const getJob = async (handler, id) =>
  (await handler.GET(new Request(`http://localhost/api/omniwatch/jobs?id=${id}`))).json();

const postJob = async (handler, body) => {
  const response = await handler.POST(
    new Request("http://localhost/api/omniwatch/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
};

/** A model that holds its answer until the test opens the gate. */
function gatedModel() {
  const inner = recordingModel();
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  let entered;
  const called = new Promise((resolve) => {
    entered = resolve;
  });
  return {
    modelName: inner.modelName,
    calls: inner.calls,
    open: () => open(),
    called,
    async call(request) {
      entered();
      await gate;
      return inner.call(request);
    },
  };
}

test("R2-04: a restarted panel turns the orphaned running call into outcome_unknown without a model call", async () => {
  const dir = tempDir();
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });

  // Process 1 (killed): leaves the orphan behind.
  const dead = openStore(dataDir);
  const seed = createHarness({ dir, store: dead });
  const operationId = await orphanRunningCall(dead, await summaryRequest(seed));
  assert.equal(dead.getOwner(), null, "the old in-process path left no owner row");
  dead.close();

  // Process 2: the panel after restart, on the same data directory.
  const h = createHarness({ dir, store: openStore(dataDir) });
  const consumer = createPanelConsumer({ deps: h.deps });
  const handler = jobsHandlerFor(h, consumer);
  try {
    // The very first request is the card's poll: it must come back final, not running.
    const view = await getJob(handler, operationId);
    assert.equal(view.state, "error");
    assert.equal(view.errorClass, "outcome_unknown");
    assert.equal(view.retryable, true);
    assert.ok(view.retryWarning, "the retry warning names the possible second cost");
    assert.equal(h.store.getOperation(operationId).state, "outcome_unknown");
    assert.equal(h.model.calls.length, 0, "recovery never calls the model");
    assert.equal(h.store.getOwner(), null, "an idle panel lets go of the data directory");

    // Pasting the same link again does not pay silently either.
    const again = await postJob(handler, { url: URL, mode: "summary", lang: "pl" });
    assert.equal(again.status, 202);
    assert.equal(again.body.id, operationId, "the request key maps to the same operation");
    assert.equal(again.body.errorClass, "outcome_unknown");
    assert.equal(again.body.retryable, true);
    await consumer.idle();
    assert.equal(h.model.calls.length, 0);

    // Without confirmation nothing happens.
    const unconfirmed = await postJob(handler, { retryOperation: operationId });
    assert.equal(unconfirmed.status, 409);
    assert.equal(h.model.calls.length, 0);

    // The user's explicit, confirmed retry pays exactly once and finishes.
    const retried = await postJob(handler, { retryOperation: operationId, confirmRetry: 1 });
    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.equal(retried.body.retried, true);
    await consumer.idle();
    assert.equal(h.store.getOperation(operationId).state, "delivered");
    assert.equal(h.model.calls.length, 1, "one confirmed retry = one paid call");
    const done = await getJob(handler, operationId);
    assert.equal(done.state, "done");
    assert.ok(done.text);

    // A second confirmation after the retry finished is refused.
    const twice = await postJob(handler, { retryOperation: operationId, confirmRetry: 1 });
    assert.equal(twice.status, 409);
    assert.equal(h.model.calls.length, 1);
    assert.equal(h.store.getOwner(), null);
  } finally {
    consumer.close();
    h.store.close();
  }
});

test("R2-04: panel startup (createPanelRuntime) recovers orphans before any request", async () => {
  const dir = tempDir();
  const dataDir = join(dir, "data");
  const vault = join(dir, "vault");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(vault, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ vaultRoot: vault }));

  const dead = openStore(dataDir);
  const seed = createHarness({ dir, store: dead });
  const unknownId = await orphanRunningCall(dead, await summaryRequest(seed));
  const unpaidId = orphanBeforeAnyCall(dead, await summaryRequest(seed, "co jest w 0:30?"));
  dead.close();

  const panel = createPanelRuntime({
    env: { OMNIWATCH_DATA_DIR: dataDir, AGENTIC_OS_CONFIG: config, AGENTIC_OS_VAULT: vault },
  });
  try {
    await panel.ready;
    assert.equal(panel.store.getOperation(unknownId).state, "outcome_unknown");
    // Never reached the provider: back in the queue, not a fake "running".
    assert.equal(panel.store.getOperation(unpaidId).state, "pending");
    assert.equal(panel.store.listAttempts(unpaidId).length, 0, "startup started no paid work");
    assert.equal(panel.store.getOwner(), null, "an idle panel does not hold the directory");
    assert.equal(panel.hasConsumer(unpaidId), false);
  } finally {
    panel.close();
  }
});

test("R2-04: a queued operation nobody executes is reported, and re-sending it runs it once", async () => {
  const dir = tempDir();
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const dead = openStore(dataDir);
  const seed = createHarness({ dir, store: dead });
  const operationId = orphanBeforeAnyCall(dead, await summaryRequest(seed));
  dead.close();

  const h = createHarness({ dir, store: openStore(dataDir) });
  const consumer = createPanelConsumer({ deps: h.deps });
  const handler = jobsHandlerFor(h, consumer);
  try {
    const view = await getJob(handler, operationId);
    assert.equal(view.state, "error", "no eternal spinner for work without a consumer");
    assert.equal(view.errorClass, "runtime_unavailable");
    assert.equal(view.resubmit, true);
    assert.equal(h.model.calls.length, 0, "a poll never starts paid work (T09)");
    assert.equal(h.store.getOperation(operationId).state, "pending");

    const again = await postJob(handler, { url: URL, mode: "summary", lang: "pl" });
    assert.equal(again.status, 202);
    assert.equal(again.body.id, operationId);
    await consumer.idle();
    assert.equal(h.store.getOperation(operationId).state, "delivered");
    assert.equal(h.model.calls.length, 1);
  } finally {
    consumer.close();
    h.store.close();
  }
});

test("R2-04: two panel processes on one data directory - one owner, no double work", async () => {
  const dir = tempDir();
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });

  const model = gatedModel();
  const a = createHarness({ dir, store: openStore(dataDir), model });
  const b = createHarness({ dir, store: openStore(dataDir), model });
  const panelA = createPanelConsumer({ deps: a.deps, token: "panel_A" });
  const panelB = createPanelConsumer({ deps: b.deps, token: "panel_B" });
  const handlerA = jobsHandlerFor(a, panelA);
  const handlerB = jobsHandlerFor(b, panelB);
  try {
    const started = await postJob(handlerA, { url: URL, mode: "summary", lang: "pl" });
    assert.equal(started.status, 202);
    const operationId = started.body.id;
    await model.called;
    assert.equal(a.store.getOwner()?.token, "panel_A");
    assert.equal(a.store.getOperation(operationId).state, "running");

    // Panel B sees a live owner: it neither recovers A's running call (no false
    // outcome_unknown) nor starts it a second time.
    assert.equal(await panelB.recover(), null);
    assert.equal(b.store.getOperation(operationId).state, "running");
    assert.equal(panelB.hasConsumer(operationId), true);
    const polled = await getJob(handlerB, operationId);
    assert.equal(polled.state, "running");

    const duplicate = await postJob(handlerB, { url: URL, mode: "summary", lang: "pl" });
    assert.equal(duplicate.body.id, operationId, "same request key -> same operation");
    await assert.rejects(panelB.run(operationId), (error) => error.errorClass === "runtime_unavailable");
    assert.equal(a.store.getOwner()?.token, "panel_A", "B never takes a live owner's directory");

    model.open();
    await panelA.idle();
    await panelB.idle();
    assert.equal(a.store.getOperation(operationId).state, "delivered");
    assert.equal(model.calls.length, 1, "exactly one paid call across both processes");
    assert.equal(a.store.getOwner(), null, "A lets go once idle");

    // With A idle, B may own the directory; there is nothing left to recover.
    const recovered = await panelB.recover();
    assert.deepEqual(recovered, []);
    assert.equal(model.calls.length, 1);
  } finally {
    model.open();
    panelA.close();
    panelB.close();
    a.store.close();
    b.store.close();
  }
});

test("R2-04: a live foreign heartbeat blocks recovery; an expired one is taken over as outcome_unknown", async () => {
  const dir = tempDir();
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const h = createHarness({ dir, store: openStore(dataDir) });
  const operationId = await orphanRunningCall(h.store, await summaryRequest(h));
  const consumer = createPanelConsumer({ deps: h.deps });
  try {
    // A process that is still beating owns the directory: its call is not ours to judge.
    assert.equal(h.store.acquireOwner("worker_alive", 4242, new Date().toISOString()), true);
    assert.equal(await consumer.recover(), null);
    assert.equal(h.store.getOperation(operationId).state, "running");
    assert.equal(consumer.hasConsumer(operationId), true);

    // The same owner, silent for longer than the takeover window: it is gone. The call
    // it started is NOT repeated - it becomes outcome_unknown for the user to decide.
    const old = new Date(Date.now() - 2 * STALE_MS).toISOString();
    assert.equal(h.store.heartbeat("worker_alive", old), true);
    assert.equal(consumer.hasConsumer(operationId), false);
    const recovered = await consumer.recover();
    assert.ok(recovered?.some((item) => item.operationId === operationId && item.state === "outcome_unknown"));
    assert.equal(h.store.getOperation(operationId).state, "outcome_unknown");
    assert.equal(h.model.calls.length, 0);
    assert.equal(h.store.getOwner(), null);
  } finally {
    consumer.close();
    h.store.close();
  }
});

test("R2-04: the panel's heartbeat keeps a long analysis owned past the takeover window", async () => {
  const dir = tempDir();
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const model = gatedModel();
  // A manual clock: time moves only when the test says so, beats fire on demand.
  let nowMs = Date.parse("2026-09-23T10:00:00.000Z");
  const timers = [];
  const clock = {
    now: () => new Date(nowMs),
    setTimeout: (fn) => {
      const handle = { fn, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (handle) handle.cleared = true;
    },
  };
  const h = createHarness({ dir, store: openStore(dataDir), model, clock });
  const consumer = createPanelConsumer({ deps: h.deps, token: "panel_long", heartbeatMs: 5_000 });
  try {
    const { operation } = enqueueAnalysis({ store: h.store, request: await summaryRequest(h) });
    await consumer.run(operation.id);
    await model.called;
    // 60 s of analysis, beating every 5 s: a second process must still see a live owner.
    for (let i = 0; i < 12; i += 1) {
      nowMs += 5_000;
      const due = timers.splice(0).filter((handle) => !handle.cleared);
      for (const handle of due) handle.fn();
    }
    assert.equal(h.store.getOwner()?.token, "panel_long");
    assert.equal(
      h.store.acquireOwner("intruder", 1, new Date(nowMs).toISOString()),
      false,
      "a fresh heartbeat is not taken over",
    );
    model.open();
    await consumer.idle();
    assert.equal(h.store.getOperation(operation.id).state, "delivered");
    assert.equal(model.calls.length, 1);
    assert.equal(h.store.getOwner(), null);
  } finally {
    model.open();
    consumer.close();
    h.store.close();
  }
});
