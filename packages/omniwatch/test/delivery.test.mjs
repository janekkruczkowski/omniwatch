/**
 * T2 / T08: buffer + delivery against a real SQLite file and a controlled
 * memory adapter (the Vault stand-in).
 *
 * Covered: unavailable delivery target, duplicate delivery, interruption after
 * the note write but before the reference write, a human-edited note (conflict
 * instead of overwrite), a retry that repeats only the write, and a buffer that
 * survives a store restart with its content intact.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ANALYSIS_VERSION, OmniWatchError, computeAnalysisKey } from "../src/contracts/index.ts";
import {
  OperationJournal,
  checkPaidWorkGate,
  deliverOperation,
  deliverPending,
  openSqliteStore,
} from "../src/storage/index.ts";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omniwatch-t8-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const T0 = "2026-09-22T10:00:00.000Z";
const CONTENT = "# Answer\n[0:03] Syntetyczny ekran: 7.";

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

function makeResult(operation, content = CONTENT) {
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
    highlights: [{ seconds: 3, label: "0:03" }],
    conversationId: "conv_1",
    turnId: "turn_1",
    parentTurnId: null,
    parts: 1,
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001, costKnown: true },
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
        text: CONTENT,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
}

function makeMemory() {
  const notes = new Map();
  const calls = { write: 0, read: 0 };
  return {
    notes,
    calls,
    async writeAnalysis(result) {
      calls.write += 1;
      const existing = notes.get(result.analysisId);
      if (existing && existing.result.content !== result.content) {
        throw new OmniWatchError(
          "delivery_conflict",
          `notatka ${result.analysisId} zostala zmieniona poza OmniWatchem; nie nadpisujemy pliku`,
        );
      }
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
      calls.read += 1;
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

/** One real paid call through the journal, then result_ready with a real buffer. */
async function seedResultReady(store, journal, model, content = CONTENT, overrides = {}) {
  const claimed = journal.claim(claimInput(makeRequest(overrides)));
  journal.start(claimed.operation.id);
  const request = journal.buildModelRequest({
    operationId: claimed.operation.id,
    partIndex: 0,
    messages: [{ role: "user", text: "podsumuj" }],
    mediaParts: [],
    language: "pl",
  });
  await journal.runPaidCall(model, request);
  journal.completeWithResult(claimed.operation.id, makeResult(claimed.operation, content));
  return claimed.operation;
}

test("T08: an unavailable delivery target keeps the buffer and blocks new paid work", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  const memory = makeMemory();
  memory.writeAnalysis = async () => {
    throw new OmniWatchError("storage_unavailable", "biblioteka wiedzy jest niedostepna");
  };
  try {
    const operation = await seedResultReady(store, journal, model);
    assert.equal(model.calls.length, 1);

    await assert.rejects(
      () => deliverOperation({ store, memory }, operation.id),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );

    const delivery = store.getDeliveryForOperation(operation.id);
    assert.equal(delivery.state, "failed");
    assert.match(delivery.errorMessage, /niedostepna/);
    assert.equal(store.getOperation(operation.id).state, "result_ready", "the result is not lost");
    assert.equal(store.getBuffer(operation.id).result.content, CONTENT, "the buffer keeps the content");

    const gate = checkPaidWorkGate(store);
    assert.equal(gate.allowed, false, "a failed delivery stops further paid work");
    assert.equal(gate.errorClass, "storage_unavailable");
    assert.equal(model.calls.length, 1, "no model call was repeated");
  } finally {
    store.close();
  }
});

test("T08: a retry repeats only the write, never the model call", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  const memory = makeMemory();
  const healthyWrite = memory.writeAnalysis.bind(memory);
  let failures = 1;
  memory.writeAnalysis = async (result) => {
    if (failures > 0) {
      failures -= 1;
      throw new OmniWatchError("storage_unavailable", "przejściowy blad zapisu do biblioteki");
    }
    return healthyWrite(result);
  };
  try {
    const operation = await seedResultReady(store, journal, model);
    await assert.rejects(() => deliverOperation({ store, memory }, operation.id));
    assert.equal(store.getDeliveryForOperation(operation.id).state, "failed");

    const outcome = await deliverOperation({ store, memory }, operation.id);
    assert.equal(outcome.delivery.state, "confirmed");
    assert.equal(outcome.reused, false);
    assert.equal(store.getOperation(operation.id).state, "delivered");
    assert.equal(store.getDeliveryAttemptCount(outcome.delivery.id), 2, "the delivery was retried");
    assert.equal(memory.calls.read, 2, "every attempt looks for an existing note first");
    assert.equal(memory.calls.write, 1, "exactly one note was written");
    assert.equal(model.calls.length, 1, "the model was not called again");
    assert.equal(checkPaidWorkGate(store).allowed, true, "the gate opens after confirmation");
  } finally {
    store.close();
  }
});

test("T08: duplicate delivery is idempotent and never writes a second note", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  const memory = makeMemory();
  try {
    const operation = await seedResultReady(store, journal, model);
    const first = await deliverOperation({ store, memory }, operation.id);
    const second = await deliverOperation({ store, memory }, operation.id);

    assert.equal(first.reused, false);
    assert.equal(second.reused, true, "the confirmation is adopted, not repeated");
    assert.equal(second.delivery.id, first.delivery.id);
    assert.equal(second.memoryRef.analysisId, first.memoryRef.analysisId);
    assert.equal(memory.calls.write, 1, "the memory adapter wrote exactly one note");
    assert.equal(store.listPendingDeliveries().length, 0);

    // createDelivery for the same operation is an idempotent merge, not a row.
    const duplicate = store.createDelivery({
      id: "dlv_duplicate_attempt",
      operationId: operation.id,
      analysisId: first.delivery.analysisId,
      state: "pending",
      memoryRef: null,
      errorMessage: null,
      payloadPath: null,
    });
    assert.equal(duplicate.id, first.delivery.id);
    assert.equal(duplicate.state, "confirmed", "a duplicate cannot reopen a confirmed delivery");
    assert.equal(model.calls.length, 1);
  } finally {
    store.close();
  }
});

test("T08: a crash between the note write and the reference write adopts the note on retry", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  const memory = makeMemory();
  const healthyWrite = memory.writeAnalysis.bind(memory);
  let interrupted = true;
  memory.writeAnalysis = async (result) => {
    const outcome = await healthyWrite(result);
    if (interrupted) {
      interrupted = false;
      throw new OmniWatchError("storage_unavailable", "przerwane po zapisie notatki, przed referencja");
    }
    return outcome;
  };
  try {
    const operation = await seedResultReady(store, journal, model);
    await assert.rejects(
      () => deliverOperation({ store, memory }, operation.id),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );
    const analysisId = store.getBuffer(operation.id).result.analysisId;
    assert.equal(memory.notes.has(analysisId), true, "the note exists despite the failed delivery");

    const outcome = await deliverOperation({ store, memory }, operation.id);
    assert.equal(outcome.delivery.state, "confirmed");
    assert.equal(outcome.reused, true, "the existing note was adopted");
    assert.equal(memory.calls.write, 1, "no second note was written");
    assert.equal(memory.calls.read, 2, "both attempts looked the note up by analysis id");
    assert.equal(store.getDeliveryAttemptCount(outcome.delivery.id), 2);
    assert.equal(store.getOperation(operation.id).state, "delivered");
    assert.equal(model.calls.length, 1);
  } finally {
    store.close();
  }
});

test("T08: a human-edited note becomes a conflict and is never overwritten", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  const memory = makeMemory();
  try {
    const operation = await seedResultReady(store, journal, model);
    const buffer = store.getBuffer(operation.id);
    const analysisId = buffer.result.analysisId;

    // A human edited the note after an earlier (failed) delivery attempt.
    memory.notes.set(analysisId, {
      result: { ...buffer.result, content: "recznie zmieniona notatka uzytkownika" },
      ref: {
        analysisId,
        adapter: "stub-memory",
        relativePath: `OmniWatch/Analyses/${analysisId}.md`,
        anchor: null,
        fingerprint: "fp_edited",
      },
    });
    const delivery = store.getDeliveryForOperation(operation.id);
    store.updateDelivery(delivery.id, { state: "failed", errorMessage: "poprzednia proba" });

    await assert.rejects(
      () => deliverOperation({ store, memory }, operation.id),
      (error) => error instanceof OmniWatchError && error.errorClass === "delivery_conflict",
    );

    assert.equal(store.getDeliveryForOperation(operation.id).state, "conflict");
    assert.equal(
      memory.notes.get(analysisId).result.content,
      "recznie zmieniona notatka uzytkownika",
      "the edited file was not overwritten",
    );
    assert.equal(memory.calls.write, 0, "the adapter never got a write for the conflict");
    const gate = checkPaidWorkGate(store);
    assert.equal(gate.allowed, false);
    assert.equal(gate.errorClass, "delivery_conflict");
    assert.equal(store.getOperation(operation.id).state, "result_ready");
    assert.equal(model.calls.length, 1);
  } finally {
    store.close();
  }
});

test("T08: an adapter-reported conflict is recorded as conflict, not as a failure", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  const memory = makeMemory();
  memory.writeAnalysis = async () => {
    throw new OmniWatchError("delivery_conflict", "plik istnieje z inna trescia");
  };
  try {
    const operation = await seedResultReady(store, journal, model);
    await assert.rejects(
      () => deliverOperation({ store, memory }, operation.id),
      (error) => error instanceof OmniWatchError && error.errorClass === "delivery_conflict",
    );
    const delivery = store.getDeliveryForOperation(operation.id);
    assert.equal(delivery.state, "conflict");
    assert.equal(store.getOperation(operation.id).state, "result_ready");
    assert.equal(checkPaidWorkGate(store).errorClass, "delivery_conflict");
  } finally {
    store.close();
  }
});

test("T08: the buffer survives a restart and delivers without a model call", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const model = makeModel();
  const operation = await seedResultReady(store, journal, model);
  store.close();

  const reopened = openSqliteStore({ path });
  const memory = makeMemory();
  try {
    const buffer = reopened.getBuffer(operation.id);
    assert.ok(buffer, "the buffer survives the restart");
    assert.equal(buffer.result.content, CONTENT);
    assert.equal(buffer.result.analysisId, `omni_${operation.analysisKey.slice(0, 16)}`);
    assert.equal(reopened.getOperation(operation.id).state, "result_ready");

    const outcomes = await deliverPending({ store: reopened, memory });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].delivery.state, "confirmed");
    assert.equal(reopened.getOperation(operation.id).state, "delivered");
    assert.equal(reopened.getBuffer(operation.id).result.content, CONTENT, "content is kept after confirmation");
    assert.equal(model.calls.length, 1, "the restarted process re-ran no model call");
  } finally {
    reopened.close();
  }
});

test("T08: delivery without a buffered result raises instead of inventing content", async () => {
  const path = join(tempDir(), "state.sqlite");
  const store = openSqliteStore({ path, now: () => T0 });
  const journal = new OperationJournal({ store, now: () => T0 });
  const memory = makeMemory();
  try {
    const claimed = journal.claim(claimInput(makeRequest()));
    await assert.rejects(
      () => deliverOperation({ store, memory }, claimed.operation.id),
      (error) => error instanceof OmniWatchError && error.errorClass === "storage_unavailable",
    );
    assert.equal(memory.calls.write, 0);
    await assert.rejects(
      () => deliverOperation({ store, memory }, "op_nie_istnieje"),
      (error) => error instanceof OmniWatchError && error.errorClass === "invalid_input",
    );
  } finally {
    store.close();
  }
});
