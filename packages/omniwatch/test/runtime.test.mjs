/**
 * T04/T14 — worker lifecycle with REAL processes (T3).
 *
 * These tests spawn the CLI as a child process against a real SQLite file and a
 * stub model that records every paid call, so "no second paid call" is counted
 * across processes rather than asserted in memory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ANALYSIS_VERSION } from "../src/contracts/types.ts";
import { openSqliteStore } from "../src/storage/index.ts";
import { createSourceRegistry } from "../src/sources/registry.ts";
import { enqueueAnalysis, pauseOperation, cancelOperation } from "../src/runtime/queue.ts";
import { createRuntimeWiring } from "../src/runtime/poc.ts";
import { runWorker, runOperation } from "../src/runtime/worker.ts";
import { OperationJournal } from "../src/storage/operations.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repo, "packages/omniwatch/src/runtime/cli.ts");
const URL_A = "https://youtu.be/SYNTHETIC01";

function workspace({ reply = "Streszczenie: [0:03] liczba 7.", delayMs = 0, completed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwatch-runtime-"));
  const dataDir = path.join(dir, "data");
  const callsFile = path.join(dir, "calls.jsonl");
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      protocol: "omniwatch.runtime-config.v1",
      dataDir,
      memoryRoot: path.join(dir, "vault"),
      language: "pl",
      modelName: "stub-model",
      maxFramesPerPart: 2400,
      model: { kind: "stub", reply, callsFile, delayMs, completed, usage: { inputTokens: 1000, outputTokens: 200 } },
      source: { kind: "fixture", title: "Fixture A", channel: "Fixture Channel", durationSeconds: 16 },
    }),
  );
  const calls = () =>
    fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter((l) => l.trim() !== "").length : 0;
  const cliArgs = (args) => [cli, ...args, "--config", configPath, "--data-dir", dataDir, "--json"];
  return { dir, dataDir, configPath, callsFile, calls, cliArgs };
}

function runCliSync(ws, args) {
  return spawnSync(process.execPath, ws.cliArgs(args), { encoding: "utf8" });
}

function lastJson(stdout) {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
}

function openStore(ws) {
  const dbPath = path.join(ws.dataDir, "state.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return openSqliteStore({ path: dbPath });
}

/** A wiring for in-process assertions, with the same stub model as the CLI. */
function inProcess(ws) {
  return createRuntimeWiring({
    configPath: ws.configPath,
    dataDir: ws.dataDir,
    environment: process.env,
  });
}

function fixtureSource() {
  return createSourceRegistry({
    media: {
      cached: async () => null,
      fetch: async () => ({
        localPath: "/tmp/fixture.mp4",
        title: "Fixture A",
        channel: "Fixture Channel",
        durationSeconds: 16,
        extractor: "fixture",
      }),
      slice: async (request) => `${request.localPath}#${request.index}`,
    },
  });
}

test("a spawned worker delivers an enqueued analysis with exactly one paid call", async () => {
  const ws = workspace();
  const enqueue = runCliSync(ws, ["analyze", URL_A, "--enqueue-only"]);
  assert.equal(enqueue.status, 0, enqueue.stderr);
  assert.equal(ws.calls(), 0, "enqueue must not pay for analysis");

  const worker = runCliSync(ws, ["worker"]);
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(ws.calls(), 1, "exactly one paid call for one part");

  const store = openStore(ws);
  const operations = store.listOperations({ limit: 10 });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].state, "delivered");
  assert.equal(store.getOwner(), null, "the worker must release ownership on exit");
  store.close();
});

test("a repeat of delivered work makes zero new paid calls", async () => {
  const ws = workspace();
  assert.equal(runCliSync(ws, ["analyze", URL_A]).status, 0);
  assert.equal(ws.calls(), 1);
  const repeat = runCliSync(ws, ["analyze", URL_A]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(ws.calls(), 1, "the repeat must reuse the stored analysis");
  const payload = lastJson(repeat.stdout);
  assert.equal(payload.reused, true);
});

test("two workers racing one data directory produce one owner and one paid call", async () => {
  const ws = workspace({ delayMs: 700 });
  assert.equal(runCliSync(ws, ["analyze", URL_A, "--enqueue-only"]).status, 0);

  const first = spawn(process.execPath, ws.cliArgs(["worker"]), { encoding: "utf8" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = runCliSync(ws, ["worker"]);
  await new Promise((resolve) => {
    first.on("exit", resolve);
  });

  assert.notEqual(second.status, 0, "the second consumer must refuse to run");
  assert.equal(ws.calls(), 1, "only the owner may start a paid call");
  const store = openStore(ws);
  assert.equal(store.listOperations({ limit: 10 })[0].state, "delivered");
  store.close();
});

test("a worker killed mid-call leaves outcome_unknown and never repeats the paid call", async () => {
  const ws = workspace({ delayMs: 5_000 });
  assert.equal(runCliSync(ws, ["analyze", URL_A, "--enqueue-only"]).status, 0);

  const child = spawn(process.execPath, ws.cliArgs(["worker"]), { stdio: ["ignore", "pipe", "pipe"] });
  // Wait until the paid call has started (intent + started are durable before it).
  const started = Date.now();
  for (;;) {
    const store = openStore(ws);
    const attempts = store.listOperations({ limit: 5 }).length > 0 ? store.listAttempts(store.listOperations({ limit: 5 })[0].id) : [];
    store.close();
    if (attempts.some((attempt) => attempt.phase === "started")) break;
    if (Date.now() - started > 8_000) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));
  const callsAfterKill = ws.calls();

  // Recovery: a new worker must classify the interrupted call as unknown.
  // A real deployment waits out the D5 takeover window (30 s); the test shortens it.
  const recovery = runCliSync(ws, ["worker", "--owner-stale-ms", "0"]);
  assert.equal(ws.calls(), callsAfterKill, "recovery must not repeat the paid call");
  const store = openStore(ws);
  const operation = store.listOperations({ limit: 5 })[0];
  assert.equal(operation.state, "outcome_unknown");
  assert.equal(operation.errorClass, "outcome_unknown");
  store.close();
  assert.equal(recovery.status, 5, `expected the unknown-outcome exit code, got ${recovery.status}`);
});

test("pause stops a queued operation from starting paid work", async () => {
  const ws = workspace();
  const enqueue = runCliSync(ws, ["analyze", URL_A, "--enqueue-only"]);
  const operationId = lastJson(enqueue.stdout).operationId;

  const paused = runCliSync(ws, ["pause", operationId]);
  assert.equal(paused.status, 0, paused.stderr);
  const worker = runCliSync(ws, ["worker"]);
  assert.equal(ws.calls(), 0, "a paused operation must not start a paid call");
  assert.equal(worker.status, 0);

  const store = openStore(ws);
  assert.equal(store.getOperation(operationId).state, "budget_paused");
  store.close();
});

test("cancel closes one operation without touching a sibling that shares the source", async () => {
  const ws = workspace();
  const first = lastJson(runCliSync(ws, ["analyze", URL_A, "--enqueue-only"]).stdout).operationId;
  const second = lastJson(
    runCliSync(ws, ["analyze", URL_A, "--focus", "inny temat", "--enqueue-only"]).stdout,
  ).operationId;
  assert.notEqual(first, second);

  assert.equal(runCliSync(ws, ["cancel", first]).status, 0);
  const store = openStore(ws);
  assert.equal(store.getOperation(first).state, "failed");
  assert.equal(store.getOperation(second).state, "pending", "the sibling operation must stay queued");
  store.close();

  const worker = runCliSync(ws, ["worker"]);
  assert.equal(worker.status, 0, worker.stderr);
  const after = openStore(ws);
  assert.equal(after.getOperation(second).state, "delivered");
  assert.equal(ws.calls(), 1, "only the surviving operation pays");
  after.close();
});

test("an unknown outcome requires an explicit decision before any new paid call", () => {
  const ws = workspace();
  const wiring = inProcess(ws);
  try {
    const enqueued = enqueueAnalysis({
      store: wiring.store,
      request: {
        sourceRef: { platform: "youtube", sourceId: "SYNTHETIC01", canonicalUrl: URL_A },
        mode: "summary",
        language: "pl",
        analysisVersion: ANALYSIS_VERSION,
      },
    });
    const token = "test-owner";
    assert.equal(wiring.store.acquireOwner(token, process.pid, new Date().toISOString()), true);
    const journal = new OperationJournal({ store: wiring.store, ownerToken: token });
    journal.markOutcomeUnknown(enqueued.operation.id, "symulowany nieznany wynik");
    assert.throws(() => journal.start(enqueued.operation.id), /nieznany wynik/);
    const reopened = journal.resolveUnknownOutcome(enqueued.operation.id, "retry");
    assert.equal(reopened.state, "pending");
    wiring.store.releaseOwner(token);
  } finally {
    wiring.close();
  }
});

test("a stale owner cannot write a result", () => {
  const ws = workspace();
  const store = openStore(ws);
  try {
    assert.equal(store.acquireOwner("owner-1", process.pid, "2026-01-01T00:00:00.000Z"), true);
    // A second acquisition after the takeover window replaces the token.
    assert.equal(store.acquireOwner("owner-2", process.pid, "2026-01-01T00:01:00.000Z"), true);
    assert.equal(store.heartbeat("owner-1", "2026-01-01T00:01:01.000Z"), false);
    const staleJournal = new OperationJournal({ store, ownerToken: "owner-1" });
    assert.throws(() => staleJournal.assertOwnership(), /nie jest juz wlascicielem/);
  } finally {
    store.close();
  }
});

test("the worker reports ready before it starts working", () => {
  const ws = workspace();
  const result = runCliSync(ws, ["worker", "--max", "0"]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
  const ready = lines.map((line) => JSON.parse(line)).find((payload) => payload.event === "ready");
  assert.ok(ready, "the worker must emit an explicit readiness event");
  assert.equal(typeof ready.pid, "number");
});

test("a bad executable is reported as runtime_unavailable, not a silent success", async () => {
  const { spawnWorkerProcess } = await import("../src/runtime/spawn.ts");
  const spawned = spawnWorkerProcess({ entry: "/definitely/not/here.ts", readyTimeoutMs: 2_000 });
  await assert.rejects(
    () => spawned.ready,
    (error) => error?.errorClass === "runtime_unavailable",
    "a worker that cannot start must fail as runtime_unavailable",
  );
});
