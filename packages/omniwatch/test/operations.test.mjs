/**
 * T2 / T03 + T04 (store half): real SQLite files in per-test temp directories.
 *
 * - T03: two competing connections and four concurrent processes claiming the
 *   same work produce exactly one operation and one stubbed model call; a
 *   different focus, question or parentTurnId is a different operation; a
 *   repeated click returns the existing work.
 * - T04 (store half): owner token acquisition, stale token rejected, heartbeat
 *   expiry visible, the old owner cannot write a result.
 * - T18 (store half): run items are paged, never returned whole.
 *
 * No mock database: every test opens a real node:sqlite file under the OS temp
 * directory and removes it afterwards.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANALYSIS_VERSION, OmniWatchError, computeAnalysisKey } from "../src/contracts/index.ts";
import {
  OperationJournal,
  OWNER_STALE_AFTER_MS,
  assertPaidWorkAllowed,
  checkPaidWorkGate,
  confirmReport,
  ensureRunReport,
  failReport,
  isHeartbeatStale,
  listUndeliveredReports,
  markReportHandedOff,
  openSqliteStore,
  readReportsForRun,
} from "../src/storage/index.ts";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omniwatch-t2-ops-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = "2026-09-22T10:00:00.000Z";
const T1 = "2026-09-22T10:00:05.000Z";
/** More than OWNER_STALE_AFTER_MS after the last heartbeat at T1. */
const T_STALE = "2026-09-22T10:00:36.000Z";

function makeRequest(overrides = {}) {
  return {
    sourceRef: {
      platform: "youtube",
      sourceId: "SYNTHETIC01",
      canonicalUrl: "https://youtu.be/SYNTHETIC01",
      legacyId: "SYNTHETIC01",
    },
    mode: "summary",
    focus: null,
    question: null,
    language: "pl",
    analysisVersion: ANALYSIS_VERSION,
    ...overrides,
  };
}

function claimInput(request) {
  return { request, analysisKey: computeAnalysisKey(request, request.parentTurnId ?? null) };
}

function makeResult(operation) {
  return {
    analysisId: `omni_${operation.analysisKey.slice(0, 16)}`,
    analysisKey: operation.analysisKey,
    mode: operation.request.mode,
    focus: operation.request.focus ?? null,
    question: operation.request.question ?? null,
    language: operation.request.language,
    analysisVersion: operation.request.analysisVersion,
    sourceRef: operation.request.sourceRef,
    title: "Fixture A",
    content: "# Answer\n[0:03] 7",
    highlights: [{ seconds: 3, label: "0:03" }],
    conversationId: "conv_1",
    turnId: "turn_1",
    parentTurnId: null,
    parts: 1,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, costKnown: false },
    createdAt: "2026-09-22T10:00:00.000Z",
  };
}

test("T03: two competing connections claim one operation and run one paid call", () => {
  const path = join(tempDir(), "state.sqlite");
  const a = openSqliteStore({ path });
  const b = openSqliteStore({ path });
  try {
    const input = claimInput(makeRequest());
    let modelCalls = 0;

    const first = a.claimOperation(input);
    assert.equal(first.created, true);
    const second = b.claimOperation(input);
    assert.equal(second.created, false);
    assert.equal(second.operation.id, first.operation.id, "both runs reference the same operation");

    if (first.created) {
      modelCalls += 1;
      a.setOperationState(first.operation.id, "running");
      a.setOperationState(first.operation.id, "result_ready");
    }
    if (second.created) {
      modelCalls += 1;
      b.setOperationState(second.operation.id, "running");
    }

    assert.equal(modelCalls, 1, "exactly one paid call for the shared operation");
    assert.equal(b.listOperations().length, 1, "one operation row for both runs");
    assert.equal(b.getOperation(first.operation.id).state, "result_ready");
  } finally {
    a.close();
    b.close();
  }
});

test("T03: four concurrent processes produce one operation and one stubbed model call", async () => {
  const dir = tempDir();
  const path = join(dir, "state.sqlite");
  const callsPath = join(dir, "model-calls.txt");
  writeFileSync(callsPath, "", "utf8");

  // Create the schema first so the race is about the claim, not the migration.
  const bootstrap = openSqliteStore({ path });
  bootstrap.close();

  const input = claimInput(makeRequest());
  const scriptPath = join(dir, "claim-worker.mjs");
  writeFileSync(
    scriptPath,
    [
      'import { appendFileSync } from "node:fs";',
      `import { openSqliteStore } from ${JSON.stringify(new URL("../src/storage/index.ts", import.meta.url).href)};`,
      "const [dbPath, key, requestJson, callsFile] = process.argv.slice(2);",
      "const store = openSqliteStore({ path: dbPath });",
      "const request = JSON.parse(requestJson);",
      "const result = store.claimOperation({ request, analysisKey: key });",
      'if (result.created) appendFileSync(callsFile, "model\\n");',
      "store.close();",
      'process.stdout.write(JSON.stringify({ created: result.created, id: result.operation.id }));',
      "",
    ].join("\n"),
    "utf8",
  );

  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      runChild(scriptPath, [path, input.analysisKey, JSON.stringify(input.request), callsPath]),
    ),
  );

  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.id)).size, 1, "all processes see one operation id");
  assert.equal(readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).length, 1);

  const store = openSqliteStore({ path });
  try {
    assert.equal(store.listOperations().length, 1);
  } finally {
    store.close();
  }
});

test("T03: a repeated click returns the existing work instead of calling the model again", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  try {
    const input = claimInput(makeRequest());
    const first = journal.claim(input);
    assert.equal(first.created, true);
    journal.recordIntent({
      operationId: first.operation.id,
      attemptId: "att_repeat_1",
      partIndex: 0,
      model: "stub-model",
      requestSummary: "user: podsumuj",
    });

    const second = journal.claim(input);
    assert.equal(second.created, false);
    assert.equal(second.operation.id, first.operation.id);
    assert.equal(store.listAttempts(first.operation.id).length, 1, "the second click adds no attempt");
  } finally {
    store.close();
  }
});

test("T03: focus, question, parentTurnId, mode and language are separate operations", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path });
  try {
    const cases = [
      claimInput(makeRequest()),
      claimInput(makeRequest({ focus: "redukcja tkanki tluszczowej" })),
      claimInput(makeRequest({ question: "co pokazuje ekran?" })),
      claimInput(makeRequest({ question: "co pokazuje ekran?", parentTurnId: "turn-1" })),
      claimInput(makeRequest({ mode: "teardown" })),
      claimInput(makeRequest({ language: "en" })),
    ];
    const ids = new Set();
    for (const input of cases) {
      ids.add(store.claimOperation(input).operation.id);
    }
    assert.equal(ids.size, cases.length, "every distinct request is its own operation");
    assert.equal(store.listOperations().length, cases.length);
    assert.equal(store.claimOperation(cases[3]).created, false);
  } finally {
    store.close();
  }
});

test("T04: owner token acquisition, stale token rejection and visible heartbeat expiry", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  try {
    assert.equal(store.acquireOwner("owner_a", 111, T0), true);
    assert.equal(store.acquireOwner("owner_b", 222, T1), false, "fresh heartbeat blocks takeover");
    assert.equal(store.heartbeat("owner_a", T1), true);
    assert.equal(store.heartbeat("owner_b", T1), false, "non-owner token cannot heartbeat");
    assert.equal(store.getOwner().token, "owner_a");

    assert.equal(isHeartbeatStale(store.getOwner().heartbeatAt, T1, OWNER_STALE_AFTER_MS), false);
    assert.equal(isHeartbeatStale(store.getOwner().heartbeatAt, T_STALE, OWNER_STALE_AFTER_MS), true);

    assert.equal(store.acquireOwner("owner_b", 222, T_STALE), true, "stale heartbeat allows takeover");
    assert.equal(store.getOwner().token, "owner_b");
    assert.equal(store.heartbeat("owner_a", T_STALE), false, "old token is rejected after takeover");

    store.releaseOwner("owner_b");
    assert.equal(store.getOwner(), null);
  } finally {
    store.close();
  }
});

test("T04: the old owner cannot write a result with a stale token", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const oldOwner = new OperationJournal({ store, ownerToken: "owner_a", now: () => T0 });
  try {
    assert.equal(store.acquireOwner("owner_a", 111, T0), true);
    const claimed = oldOwner.claim(claimInput(makeRequest()));
    assert.equal(oldOwner.hasOwnership(), true);

    assert.equal(store.acquireOwner("owner_b", 222, T_STALE), true, "another process takes over");

    assert.equal(oldOwner.hasOwnership(), false);
    assert.throws(
      () => oldOwner.markFailed(claimed.operation.id, "rate_limited", "stary token nie zapisuje"),
      (error) => error instanceof OmniWatchError && error.errorClass === "runtime_unavailable",
    );
    assert.throws(
      () =>
        oldOwner.recordIntent({
          operationId: claimed.operation.id,
          attemptId: "att_stale",
          partIndex: 0,
        }),
      (error) => error instanceof OmniWatchError && error.errorClass === "runtime_unavailable",
    );
    assert.equal(store.getOperation(claimed.operation.id).state, "pending", "no write happened");
    assert.equal(store.listAttempts(claimed.operation.id).length, 0);

    const newOwner = new OperationJournal({ store, ownerToken: "owner_b", now: () => T_STALE });
    assert.equal(newOwner.hasOwnership(), true);
    newOwner.start(claimed.operation.id);
    assert.equal(store.getOperation(claimed.operation.id).state, "running");
  } finally {
    store.close();
  }
});

test("T03: claimed work, attempts and buffer survive a store reopen", () => {
  const path = join(tempDir(), "state.sqlite");
  const input = claimInput(makeRequest());
  let operationId;
  {
    const store = openSqliteStore({ path, now: () => T0 });
    const claimed = store.claimOperation(input);
    operationId = claimed.operation.id;
    store.setOperationState(operationId, "running");
    store.recordAttempt({
      id: "att_restart",
      operationId,
      phase: "intent",
      partIndex: 0,
      model: "stub-model",
      requestSummary: "user: podsumuj",
      responseSummary: null,
      usage: null,
    });
    store.saveBuffer(operationId, { result: makeResult(claimed.operation), writtenAt: T0 });
    store.setOperationState(operationId, "result_ready");
    store.close();
  }

  const reopened = openSqliteStore({ path });
  try {
    const operation = reopened.getOperationByKey(input.analysisKey);
    assert.equal(operation.id, operationId);
    assert.equal(operation.state, "result_ready");
    assert.equal(reopened.listAttempts(operationId).length, 1);
    const buffer = reopened.getBuffer(operationId);
    assert.ok(buffer, "the durable buffer survives the reopen");
    assert.equal(buffer.result.content, "# Answer\n[0:03] 7");
    assert.equal(buffer.writtenAt, T0);
  } finally {
    reopened.close();
  }
});

test("T18: run items are paged, never returned whole", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path });
  try {
    const settings = {
      collectionId: "col_1",
      mode: "summary",
      focus: null,
      question: null,
      language: "pl",
      maxNewItems: 10,
      budgetUsd: 2,
    };
    store.saveCollectionSettings(settings);
    assert.deepEqual(store.listCollectionIds(), ["col_1"]);
    assert.equal(store.getCollectionSettings("col_1").maxNewItems, 10);

    const run = store.createRun({
      id: "run_1",
      collectionId: "col_1",
      trigger: "manual",
      state: "running",
      settings,
    });
    assert.equal(run.id, "run_1");

    const total = 120;
    for (let index = 0; index < total; index += 1) {
      const sourceId = `SYNTH${String(index).padStart(4, "0")}`;
      const request = makeRequest({
        sourceRef: {
          platform: "youtube",
          sourceId,
          canonicalUrl: `https://youtu.be/${sourceId}`,
        },
      });
      const claimed = store.claimOperation({
        request,
        analysisKey: computeAnalysisKey(request),
        runId: run.id,
      });
      store.attachOperationToRun(claimed.operation.id, run.id, index);
      if (index % 3 === 0) {
        store.markSeenSource("col_1", sourceId, "summary", null, null, "pl");
      }
    }

    const firstPage = store.listRunItems("run_1", { offset: 0, limit: 50 });
    assert.equal(firstPage.total, total);
    assert.equal(firstPage.items.length, 50);
    assert.equal(firstPage.items[0].ordinal, 0);
    assert.equal(firstPage.items[49].ordinal, 49);
    const secondPage = store.listRunItems("run_1", { offset: 50, limit: 50 });
    assert.equal(secondPage.items.length, 50);
    assert.equal(secondPage.items[0].ordinal, 50);
    const lastPage = store.listRunItems("run_1", { offset: 100, limit: 50 });
    assert.equal(lastPage.items.length, 20);

    const item = store.findRunItemBySource("run_1", "SYNTH0007");
    assert.equal(item.ordinal, 7);
    assert.ok(store.getOperation(item.operationId));

    assert.equal(store.isSourceSeen("col_1", "SYNTH0003", "summary", null, null, "pl"), true);
    assert.equal(store.isSourceSeen("col_1", "SYNTH0003", "teardown", null, null, "pl"), false);
    assert.equal(store.isSourceSeen("col_1", "SYNTH0004", "summary", null, null, "pl"), false);
    store.markSeenSource("col_1", "SYNTH0004", "summary", "   temat   ze   spacja ", null, "PL");
    assert.equal(
      store.isSourceSeen("col_1", "SYNTH0004", "summary", "temat ze spacja", null, "pl"),
      true,
      "seen keys use the same whitespace and case normalization as the analysis key",
    );
  } finally {
    store.close();
  }
});

test("T03/T07: the paid-work gate blocks while a ready result is undelivered", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  try {
    assert.equal(checkPaidWorkGate(store).allowed, true);
    const claimed = journal.claim(claimInput(makeRequest()));
    journal.start(claimed.operation.id);
    journal.completeWithResult(claimed.operation.id, makeResult(claimed.operation));

    const gate = checkPaidWorkGate(store);
    assert.equal(gate.allowed, false);
    assert.equal(gate.operationId, claimed.operation.id);
    assert.equal(gate.errorClass, "storage_unavailable");
    assert.throws(
      () => assertPaidWorkAllowed(store),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );

    const other = journal.claim(claimInput(makeRequest({ focus: "inny temat" })));
    assert.throws(
      () => journal.start(other.operation.id),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );
    assert.equal(store.getOperation(other.operation.id).state, "pending");
  } finally {
    store.close();
  }
});

test("T03: the store raises storage_unavailable after close instead of using RAM state", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path });
  const claimed = store.claimOperation(claimInput(makeRequest()));
  store.close();
  assert.throws(
    () => store.getOperation(claimed.operation.id),
    (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
  );
  assert.equal(existsSync(path), true);
});

test("T13 store half: reports stay durable and undelivered ones are returned for the next run", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  try {
    const settings = {
      collectionId: "col_1",
      mode: "summary",
      focus: null,
      question: null,
      language: "pl",
      maxNewItems: 10,
      budgetUsd: null,
    };
    const run = store.createRun({
      id: "run_report",
      collectionId: "col_1",
      trigger: "schedule",
      state: "completed",
      settings,
      completedAt: T0,
    });
    assert.equal(store.getRun(run.id).state, "completed");

    const report = ensureRunReport(store, {
      runId: run.id,
      summary: "3 nowe analizy, 1 blad",
      newAnalyses: 3,
      failedItems: 1,
      pendingItems: 0,
    });
    assert.equal(report.state, "pending");
    assert.deepEqual(
      listUndeliveredReports(store).map((item) => item.id),
      [report.id],
      "pending reports are the next cron run's first job",
    );

    assert.equal(markReportHandedOff(store, report.id, "przekazano Hermesowi").state, "handed_off");
    assert.equal(listUndeliveredReports(store).length, 1, "handed_off is not confirmed yet");
    assert.equal(failReport(store, report.id, "blad przekazania").state, "failed");
    assert.equal(listUndeliveredReports(store).length, 1, "a failed hand-off is retried next run");

    assert.equal(confirmReport(store, report.id, "potwierdzone").state, "confirmed");
    assert.equal(listUndeliveredReports(store).length, 0);

    // report --run <id> re-reads the durable report without any new analysis.
    const reread = readReportsForRun(store, run.id);
    assert.equal(reread.length, 1);
    assert.equal(reread[0].summary, "potwierdzone");
    assert.equal(failReport(store, report.id).state, "confirmed", "a confirmed report is never reopened");
    assert.equal(ensureRunReport(store, { runId: run.id, summary: "inny tekst" }).id, report.id);
    assert.equal(store.listReports({ runId: run.id }).length, 1, "one stable report per run");
  } finally {
    store.close();
  }
});

test("T05 store half: runs, run items and buffer clearing stay consistent", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  try {
    const settings = {
      collectionId: "col_2",
      mode: "summary",
      focus: null,
      question: null,
      language: "pl",
      maxNewItems: null,
      budgetUsd: null,
    };
    const run = store.createRun({
      id: "run_2",
      collectionId: "col_2",
      trigger: "cli",
      state: "pending",
      settings,
    });
    assert.equal(run.state, "pending");
    store.updateRun(run.id, { state: "running" });
    store.updateRun(run.id, { state: "completed", completedAt: T0 });
    assert.equal(store.getRun(run.id).state, "completed");
    assert.equal(store.getRun(run.id).completedAt, T0);

    const claimed = store.claimOperation(claimInput(makeRequest()));
    store.addRunItem({
      runId: run.id,
      ordinal: 0,
      sourceRef: claimed.operation.request.sourceRef,
      operationId: claimed.operation.id,
      state: "running",
      title: "Fixture A",
    });
    store.updateRunItem(run.id, 0, { state: "done" });
    const page = store.listRunItems(run.id);
    assert.equal(page.total, 1);
    assert.equal(page.items[0].state, "done");
    assert.equal(page.items[0].title, "Fixture A");

    const operationId = claimed.operation.id;
    store.setOperationState(operationId, "running");
    store.saveBuffer(operationId, { result: makeResult(claimed.operation), writtenAt: T0 });
    assert.ok(store.getBuffer(operationId));
    store.clearBuffer(operationId);
    assert.equal(store.getBuffer(operationId), null, "the buffer can be cleared without losing the row");
    assert.ok(store.getDeliveryForOperation(operationId), "the delivery row survives clearing");
  } finally {
    store.close();
  }
});

test("D5/D11: the execution snapshot round-trips and rejects stored secrets", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  try {
    const claimed = store.claimOperation(claimInput(makeRequest()));
    assert.equal(store.getExecutionSnapshot(claimed.operation.id), null);
    store.recordExecutionSnapshot(claimed.operation.id, {
      model: "fixture-model",
      promptTemplateVersion: "prompt-v1",
      maxFramesPerPart: 2400,
      language: "pl",
    });
    assert.equal(store.getExecutionSnapshot(claimed.operation.id).promptTemplateVersion, "prompt-v1");

    assert.throws(
      () =>
        store.recordExecutionSnapshot(claimed.operation.id, {
          model: "fixture-model",
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",
        }),
      (error) => error instanceof OmniWatchError && error.errorClass === "invalid_input",
    );
    assert.equal(
      store.getExecutionSnapshot(claimed.operation.id).promptTemplateVersion,
      "prompt-v1",
      "the rejected snapshot did not overwrite the stored one",
    );
  } finally {
    store.close();
  }
});

test("T10 store half: conversation turns are durable, ordered and branch safe", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  try {
    const sourceRef = makeRequest().sourceRef;
    store.ensureConversation("conv_1", sourceRef);
    const turn = (turnId, parentTurnId, role, text) => ({
      turnId,
      conversationId: "conv_1",
      parentTurnId,
      role,
      mode: "summary",
      text,
      createdAt: T0,
    });
    store.appendTurn(turn("t1", null, "user", "podsumuj"));
    store.appendTurn(turn("t2", "t1", "assistant", "streszczenie"));
    store.appendTurn(turn("t3", "t2", "user", "rozwin punkt 2"));
    store.appendTurn(turn("t4", "t2", "user", "a moze punkt 3?"));
    store.appendTurn(turn("t5", "t3", "assistant", "punkt 2"));

    assert.equal(store.getTurn("t2").text, "streszczenie");
    assert.deepEqual(
      store.listTurns("conv_1").map((item) => item.turnId),
      ["t1", "t2", "t3", "t4", "t5"],
      "parallel branches from the same answer are allowed and stay in order",
    );
    assert.deepEqual(
      store.listTurns("conv_1", 2).map((item) => item.turnId),
      ["t4", "t5"],
      "a limited read returns the most recent turns in order",
    );

    store.appendTurn(turn("t5", "t3", "assistant", "punkt 2"));
    assert.equal(store.listTurns("conv_1").length, 5, "a repeated turn write is idempotent");

    assert.throws(
      () => store.appendTurn(turn("t9", "brak", "user", "x")),
      (error) => error instanceof OmniWatchError && error.errorClass === "invalid_input",
    );
    store.ensureConversation("conv_2", sourceRef);
    assert.throws(
      () => store.appendTurn({ ...turn("t10", "t1", "user", "x"), conversationId: "conv_2" }),
      (error) => error instanceof OmniWatchError && error.errorClass === "invalid_input",
    );
  } finally {
    store.close();
  }
});

function runChild(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited with ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`child produced no JSON (${stdout}): ${error.message}`));
      }
    });
  });
}
