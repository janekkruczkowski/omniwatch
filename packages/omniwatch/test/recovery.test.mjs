/**
 * T2 / T07: fault injection on a real SQLite file (never a mock database).
 *
 * Covered crashes and failures:
 * 1. before the model intent write (full disk),
 * 2. after the intent but before the call (crash),
 * 3. after the provider answered, before COMMIT (crash),
 * 4. after COMMIT / restart (buffer intact, delivery without a model call),
 * 5. busier database (SQLITE_BUSY) and a failed migration,
 * 6. destructive migration copies state before rewriting.
 *
 * Assertions follow T07: new paid work stops, there is no silent fallback to
 * RAM state, and an unknown-outcome call is never repeated automatically.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANALYSIS_VERSION, OmniWatchError, computeAnalysisKey } from "../src/contracts/index.ts";
import {
  MIGRATIONS,
  OperationJournal,
  SqliteStore,
  classifyOperationRecovery,
  deliverPending,
  listAppliedMigrations,
  openDatabase,
  openSqliteStore,
  runMigrations,
  storageFailure,
} from "../src/storage/index.ts";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omniwatch-t7-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = "2026-09-22T10:00:00.000Z";

class SimulatedCrash extends Error {}

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

function makeResult(operation, content = "# Answer\n[0:03] 7") {
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
    content,
    highlights: [],
    conversationId: "conv_1",
    turnId: "turn_1",
    parentTurnId: null,
    parts: 1,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, costKnown: false },
    createdAt: T0,
  };
}

function makeModel() {
  const calls = [];
  return {
    modelName: "stub-model",
    calls,
    async call(request) {
      calls.push(request);
      return {
        text: `answer part ${request.partIndex}`,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
}

function makeMemory() {
  const notes = new Map();
  return {
    notes,
    async writeAnalysis(result) {
      const existing = notes.get(result.analysisId);
      if (existing && existing.content !== result.content) {
        throw new OmniWatchError("delivery_conflict", "notatka istnieje z inna trescia");
      }
      if (existing) {
        return { memoryRef: existing.ref, reused: true };
      }
      const ref = {
        analysisId: result.analysisId,
        adapter: "stub-memory",
        relativePath: `OmniWatch/Analyses/${result.analysisId}.md`,
        anchor: null,
        fingerprint: `fp_${result.analysisId}`,
      };
      notes.set(result.analysisId, { content: result.content, ref });
      return { memoryRef: ref, reused: false };
    },
    async readAnalysis(analysisId) {
      const existing = notes.get(analysisId);
      return existing ? { result: null, memoryRef: existing.ref } : null;
    },
    async searchAnalyses() {
      return [];
    },
    async answerFromAnalyses() {
      return { text: "", refs: [], notFound: true };
    },
  };
}

async function seedRunningOperation(store, journal, overrides = {}) {
  const claimed = journal.claim(claimInput(makeRequest(overrides)));
  journal.start(claimed.operation.id);
  return claimed.operation;
}

test("T07: a full disk before the intent write stops paid work without calling the model", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  try {
    const operation = await seedRunningOperation(store, journal);
    store.capStorageToCurrentPages();

    const request = journal.buildModelRequest({
      operationId: operation.id,
      partIndex: 0,
      messages: [{ role: "user", text: "x".repeat(200_000) }],
      mediaParts: [],
      language: "pl",
    });
    await assert.rejects(
      () => journal.runPaidCall(model, request),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );

    assert.equal(model.calls.length, 0, "no paid call was issued");
    assert.equal(store.listAttempts(operation.id).length, 0, "no intent row was written");

    // New paid work is stopped and there is no RAM fallback: the next paid call
    // cannot even journal its intent, so the provider is never reached.
    const other = journal.claim(claimInput(makeRequest({ focus: "inny temat" })));
    const otherRequest = journal.buildModelRequest({
      operationId: other.operation.id,
      partIndex: 0,
      messages: [{ role: "user", text: "y".repeat(200_000) }],
      mediaParts: [],
      language: "pl",
    });
    await assert.rejects(
      () => journal.runPaidCall(model, otherRequest),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );
    assert.equal(model.calls.length, 0, "the second paid call never reached the provider");
  } finally {
    store.close();
  }
});

test("T07: a crash after the intent but before the call stays unpaid and retryable", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  try {
    const operation = await seedRunningOperation(store, journal);
    const request = journal.buildModelRequest({
      operationId: operation.id,
      partIndex: 0,
      messages: [{ role: "user", text: "podsumuj" }],
      mediaParts: [],
      language: "pl",
    });

    await assert.rejects(
      () =>
        journal.runPaidCall(model, request, {
          afterIntent: () => {
            throw new SimulatedCrash("proces zginął przed wyslaniem wywolania");
          },
        }),
      (error) => error instanceof SimulatedCrash,
    );

    assert.equal(model.calls.length, 0, "the provider was never called");
    const attempts = store.listAttempts(operation.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].phase, "intent", "only the durable intent exists");
    assert.equal(store.getOperation(operation.id).state, "running");

    const recovery = classifyOperationRecovery(store, operation.id);
    assert.equal(recovery.classification, "unpaid_retryable");
    assert.equal(recovery.requiresUserDecision, false);
    assert.equal(recovery.action, "retry_paid_call");
  } finally {
    store.close();
  }
});

test("T07: a crash after the response but before COMMIT becomes outcome_unknown and is never repeated", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  try {
    const operation = await seedRunningOperation(store, journal);
    const request = journal.buildModelRequest({
      operationId: operation.id,
      partIndex: 0,
      messages: [{ role: "user", text: "podsumuj" }],
      mediaParts: [],
      language: "pl",
    });

    await assert.rejects(
      () =>
        journal.runPaidCall(model, request, {
          beforeResponseCommit: () => {
            throw new SimulatedCrash("proces zginął przed COMMIT");
          },
        }),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );

    assert.equal(model.calls.length, 1, "the provider call already happened");
    const attempts = store.listAttempts(operation.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].phase, "unknown", "the answer is not durable, so the call is unconfirmed");
    assert.equal(store.getOperation(operation.id).state, "outcome_unknown");

    const recovery = classifyOperationRecovery(store, operation.id);
    assert.equal(recovery.classification, "unconfirmed_call");
    assert.equal(recovery.requiresUserDecision, true);
    assert.equal(recovery.action, "ask_user");

    // No automatic repeat: start() refuses and the model call count cannot grow.
    assert.throws(
      () => journal.start(operation.id),
      (error) => error instanceof OmniWatchError && error.errorClass === "outcome_unknown",
    );
    const flagged = listRecoveryItemsFor(store, operation.id);
    assert.equal(flagged.requiresUserDecision, true);
    assert.equal(model.calls.length, 1);

    // Only an explicit user decision may reopen it.
    journal.resolveUnknownOutcome(operation.id, "abandon", "uzytkownik nie ponawia");
    assert.equal(store.getOperation(operation.id).state, "failed");
    assert.equal(model.calls.length, 1);
  } finally {
    store.close();
  }
});

test("T07: after COMMIT the buffer survives a restart and delivery repeats no model call", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  const operationId = await (async () => {
    const operation = await seedRunningOperation(store, journal);
    const request = journal.buildModelRequest({
      operationId: operation.id,
      partIndex: 0,
      messages: [{ role: "user", text: "podsumuj" }],
      mediaParts: [],
      language: "pl",
    });
    const response = await journal.runPaidCall(model, request);
    assert.equal(response.completed, true);
    assert.equal(store.listAttempts(operation.id).at(-1).phase, "response");
    journal.completeWithResult(operation.id, makeResult(operation, response.text));
    assert.equal(store.getOperation(operation.id).state, "result_ready");
    assert.equal(classifyOperationRecovery(store, operation.id).classification, "delivery_only");
    return operation.id;
  })();
  store.close();

  const reopened = openSqliteStore({ path });
  const memory = makeMemory();
  try {
    const buffer = reopened.getBuffer(operationId);
    assert.ok(buffer, "the finished content survives the restart");
    assert.equal(buffer.result.content, "answer part 0");

    const outcomes = await deliverPending({ store: reopened, memory });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].delivery.state, "confirmed");
    assert.equal(reopened.getOperation(operationId).state, "delivered");
    assert.equal(model.calls.length, 1, "delivery never re-ran the model");
  } finally {
    reopened.close();
  }
});

test("T07: a committed response that could not be buffered is rebuilt without a new paid call", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  try {
    const operation = await seedRunningOperation(store, journal);
    const request = journal.buildModelRequest({
      operationId: operation.id,
      partIndex: 0,
      messages: [{ role: "user", text: "podsumuj" }],
      mediaParts: [],
      language: "pl",
    });
    const response = await journal.runPaidCall(model, request);

    store.capStorageToCurrentPages();
    assert.throws(
      () => journal.completeWithResult(operation.id, makeResult(operation, "y".repeat(200_000))),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );

    const recovery = classifyOperationRecovery(store, operation.id);
    assert.equal(recovery.classification, "response_committed");
    assert.equal(recovery.action, "rebuild_result");
    assert.equal(recovery.requiresUserDecision, false);
    assert.equal(recovery.lastAttempt.responseSummary, response.text, "the durable answer can be reused");
    assert.equal(model.calls.length, 1, "the recovery path needs no provider call");
  } finally {
    store.close();
  }
});

test("T07: a busy database raises storage_unavailable and leaves the state untouched", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, busyTimeoutMs: 50, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  try {
    const claimed = journal.claim(claimInput(makeRequest()));
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA busy_timeout = 50; BEGIN EXCLUSIVE;");
    try {
      assert.throws(
        () => store.setOperationState(claimed.operation.id, "running"),
        (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
      );
    } finally {
      holder.exec("ROLLBACK;");
      holder.close();
    }
    assert.equal(store.getOperation(claimed.operation.id).state, "pending");
    store.setOperationState(claimed.operation.id, "running");
    assert.equal(store.getOperation(claimed.operation.id).state, "running");
  } finally {
    store.close();
  }
});

test("T07: a failed migration blocks work and records nothing", () => {
  const path = join(tempDir(), "state.sqlite");
  const db = openDatabase(path);
  try {
    const applied = runMigrations(db, MIGRATIONS);
    assert.deepEqual(applied.applied.map((migration) => migration.version), [1]);

    assert.throws(
      () =>
        runMigrations(db, [
          ...MIGRATIONS,
          {
            version: 2,
            name: "broken_step",
            up(connection) {
              connection.exec("ALTER TABLE operations ADD COLUMN archived_at TEXT");
              connection.exec("SELECT * FROM tabela_ktorej_nie_ma");
            },
          },
        ]),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );

    assert.deepEqual(
      listAppliedMigrations(db).map((migration) => migration.version),
      [1],
      "the failed migration is not recorded",
    );
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('operations')")
      .all()
      .map((row) => row.name);
    assert.equal(columns.includes("archived_at"), false, "the rolled-back step left no column");
  } finally {
    db.close();
  }
});

test("T07: a destructive migration copies state before rewriting the table", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const claimed = store.claimOperation(claimInput(makeRequest()));
  store.close();

  const db = openDatabase(path);
  try {
    const result = runMigrations(db, [
      ...MIGRATIONS,
      {
        version: 2,
        name: "add_archived_at",
        backupTables: ["operations"],
        up(connection) {
          connection.exec("ALTER TABLE operations ADD COLUMN archived_at TEXT");
        },
      },
    ]);
    assert.deepEqual(result.applied.map((migration) => migration.version), [2]);
    assert.deepEqual(result.applied[0].backupTables, ["operations__backup_v2"]);

    const backup = db.prepare("SELECT id, state FROM operations__backup_v2").all();
    assert.equal(backup.length, 1);
    assert.equal(backup[0].id, claimed.operation.id);
    assert.equal(backup[0].state, "pending");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS total FROM operations").get().total,
      1,
      "the row survives the destructive step",
    );
  } finally {
    db.close();
  }
});

test("T07: a store whose migration failed raises storage_unavailable instead of using RAM", () => {
  const path = join(tempDir(), "state.sqlite");
  const store = new SqliteStore({
    path,
    migrations: [
      {
        version: 1,
        name: "broken_initial",
        up() {
          throw storageFailure("symulowany blad migracji");
        },
      },
    ],
  });
  try {
    assert.throws(
      () => store.migrate(),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );
    assert.throws(
      () => store.claimOperation(claimInput(makeRequest())),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );
    const inspector = new DatabaseSync(path);
    try {
      const table = inspector
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations'")
        .get();
      assert.equal(table, undefined, "no partial schema was left behind");
    } finally {
      inspector.close();
    }
  } finally {
    store.close();
  }
});

function listRecoveryItemsFor(store, operationId) {
  const item = classifyOperationRecovery(store, operationId);
  assert.ok(item, "operation is unfinished");
  return item;
}
