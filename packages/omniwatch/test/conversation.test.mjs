/**
 * T10: conversation context - the right parent, separate branches, per-source
 * isolation and an explicit budget limit. Stubs only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ANALYSIS_VERSION, OmniWatchError, computeAnalysisKey } from "../src/contracts/index.ts";
import { analyze } from "../src/analysis/engine.ts";
import { buildConversationContext, estimateTokens } from "../src/analysis/context.ts";
import { capabilitiesFor, parseSourceUrl } from "../src/sources/index.ts";

const SOURCE = parseSourceUrl("https://example.test/video/alpha");
const OTHER_SOURCE = parseSourceUrl("https://example.test/video/beta");

function turn(overrides) {
  return {
    turnId: "turn",
    conversationId: "convA",
    parentTurnId: null,
    role: "assistant",
    mode: "summary",
    text: "",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function turnSource(turns) {
  return {
    listTurns(conversationId) {
      return turns.filter((entry) => entry.conversationId === conversationId);
    },
  };
}

function makeClock() {
  return {
    now: () => new Date("2026-01-01T12:00:00.000Z"),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

function makeLogger() {
  const lines = [];
  const push = (level) => (message, fields) => lines.push({ level, message, fields });
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

function makeSink() {
  const phases = [];
  return {
    phases,
    async intent() { phases.push("intent"); },
    async started() { phases.push("started"); },
    async response() { phases.push("response"); },
    async unknown() { phases.push("unknown"); },
    async failed() { phases.push("failed"); },
  };
}

function makeBundle(sourceRef, turns, overrides = {}) {
  const requests = [];
  const model = {
    modelName: "fixture-omni",
    requests,
    async call(request) {
      requests.push(request);
      return {
        text: "## In short\nfollow-up answer",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, costKnown: true },
        completed: true,
      };
    },
  };
  const source = {
    async resolve() { return sourceRef; },
    capabilities: () => capabilitiesFor(sourceRef.platform),
    async prepare() {
      return {
        sourceRef,
        title: "Fixture",
        channel: "Fixture Channel",
        durationSeconds: 16,
        extractor: "Generic",
        localPath: "/tmp/omniwatch/source.mp4",
        uploadedUrl: null,
        reusedUpload: false,
      };
    },
    async split() {
      return [{ index: 0, startSeconds: 0, endSeconds: 16, localPath: "/tmp/omniwatch/source.mp4" }];
    },
  };
  const deps = {
    clock: makeClock(),
    logger: makeLogger(),
    config: {
      dataDir: "/tmp/omniwatch",
      memoryRoot: "/tmp/omniwatch/memory",
      language: "pl",
      modelName: "fixture-omni",
      apiKey: () => "test-key-not-a-secret",
      apiBaseUrl: () => "https://provider.example.invalid/v1",
      maxFramesPerPart: () => 2400,
      cacheHours: () => 48,
    },
    source,
    model,
    attempts: makeSink(),
    turns: turns ? turnSource(turns) : undefined,
  };
  if (overrides.conversationBudgetTokens) deps.conversationBudgetTokens = overrides.conversationBudgetTokens;
  return { model, source, deps };
}

function requestFor(sourceRef, overrides = {}) {
  return {
    sourceRef,
    mode: "summary",
    focus: null,
    question: null,
    language: "pl",
    analysisVersion: ANALYSIS_VERSION,
    ...overrides,
  };
}

function promptOf(model) {
  return model.requests[0].messages.map((message) => message.text).join("\n");
}

const CHAIN_TURNS = [
  turn({
    turnId: "t-q1",
    role: "user",
    parentTurnId: null,
    text: "streszcz ten film",
    createdAt: "2026-01-01T10:00:00.000Z",
  }),
  turn({
    turnId: "t-a1",
    role: "assistant",
    parentTurnId: "t-q1",
    text: "1. Pierwszy punkt\n2. Drugi punkt: redukcja tkanki\n3. Trzeci punkt",
    createdAt: "2026-01-01T10:01:00.000Z",
  }),
];

test("a follow-up resolves to the referenced parent answer and its chain", async () => {
  const bundle = makeBundle(SOURCE, CHAIN_TURNS);
  const request = requestFor(SOURCE, {
    conversationId: "convA",
    parentTurnId: "t-a1",
    question: "rozwin drugi punkt",
  });
  const result = await analyze(request, bundle.deps);
  const prompt = promptOf(bundle.model);

  assert.match(prompt, /Drugi punkt: redukcja tkanki/);
  assert.match(prompt, /EARLIER QUESTION/);
  assert.match(prompt, /rozwin drugi punkt/);
  assert.equal(result.parentTurnId, "t-a1");
  assert.equal(result.conversationId, "convA");
  // The context participates in the key, so a follow-up is its own generation.
  assert.notEqual(result.analysisKey, computeAnalysisKey(request, null));
});

test("two branches off one parent stay separate", async () => {
  const branches = [
    turn({ turnId: "p", role: "assistant", parentTurnId: null, text: "PARENT-ANSWER", createdAt: "2026-01-01T10:00:00.000Z" }),
    turn({ turnId: "b1", role: "assistant", parentTurnId: "p", text: "BRANCH-ONE-ANSWER", createdAt: "2026-01-01T10:01:00.000Z" }),
    turn({ turnId: "b2", role: "assistant", parentTurnId: "p", text: "BRANCH-TWO-ANSWER", createdAt: "2026-01-01T10:02:00.000Z" }),
  ];

  const first = makeBundle(SOURCE, branches);
  await analyze(
    requestFor(SOURCE, { conversationId: "convA", parentTurnId: "b1", question: "rozwin punkt drugi" }),
    first.deps,
  );
  const firstPrompt = promptOf(first.model);
  assert.match(firstPrompt, /BRANCH-ONE-ANSWER/);
  assert.match(firstPrompt, /PARENT-ANSWER/);
  assert.doesNotMatch(firstPrompt, /BRANCH-TWO-ANSWER/);

  const second = makeBundle(SOURCE, branches);
  await analyze(
    requestFor(SOURCE, { conversationId: "convA", parentTurnId: "b2", question: "rozwin punkt pierwszy" }),
    second.deps,
  );
  const secondPrompt = promptOf(second.model);
  assert.match(secondPrompt, /BRANCH-TWO-ANSWER/);
  assert.match(secondPrompt, /PARENT-ANSWER/);
  assert.doesNotMatch(secondPrompt, /BRANCH-ONE-ANSWER/);
});

test("changing the video never mixes context from another conversation", async () => {
  // Directly, with unfiltered turns: a parent that belongs to another conversation is
  // named as such instead of being treated as missing.
  assert.throws(
    () =>
      buildConversationContext({
        sourceRef: OTHER_SOURCE,
        conversationId: "convB",
        question: "rozwin drugi punkt",
        parentTurnId: "t-a1",
        turns: CHAIN_TURNS,
        budget: { inputBudgetTokens: 12000 },
      }),
    (error) => error.errorClass === "invalid_input" && /innym materiale/.test(error.message),
  );

  const bundle = makeBundle(OTHER_SOURCE, CHAIN_TURNS);

  // Through the engine the store already scopes turns by conversation, so the parent
  // is simply not present - still a clear error, still no paid call.
  await assert.rejects(
    () =>
      analyze(
        requestFor(OTHER_SOURCE, { conversationId: "convB", parentTurnId: "t-a1", question: "rozwin drugi punkt" }),
        bundle.deps,
      ),
    (error) => error instanceof OmniWatchError
      && error.errorClass === "invalid_input"
      && /nie jest juz dostepna|innym materiale/.test(error.message),
  );
  assert.equal(bundle.model.requests.length, 0);

  // A fresh conversation about video B gets none of video A's history.
  const fresh = makeBundle(OTHER_SOURCE, CHAIN_TURNS);
  const result = await analyze(
    requestFor(OTHER_SOURCE, { conversationId: "convB", question: "nowe pytanie o film B" }),
    fresh.deps,
  );
  const prompt = promptOf(fresh.model);
  assert.doesNotMatch(prompt, /Drugi punkt: redukcja tkanki/);
  assert.doesNotMatch(prompt, /streszcz ten film/);
  assert.match(prompt, /nowe pytanie o film B/);
  assert.equal(result.conversationId, "convB");
});

test("a record from another conversation is never silently treated as the parent", async () => {
  const bundle = makeBundle(SOURCE, CHAIN_TURNS);
  await assert.rejects(
    () => analyze(requestFor(SOURCE, { conversationId: "convA", parentTurnId: "missing-turn" }), bundle.deps),
    (error) => error.errorClass === "invalid_input" && /nie jest juz dostepna/.test(error.message),
  );
});

test("the history limit is explicit and never drops the referenced answer", () => {
  const turns = CHAIN_TURNS;
  const question = "rozwin drugi punkt";
  const requiredTokens = estimateTokens(turns[1].text) + estimateTokens(question);

  // Required set alone does not fit: the user is told what to do, and no answer is dropped.
  assert.throws(
    () =>
      buildConversationContext({
        sourceRef: SOURCE,
        conversationId: "convA",
        question,
        parentTurnId: "t-a1",
        turns,
        budget: { inputBudgetTokens: requiredTokens - 1 },
      }),
    (error) =>
      error instanceof OmniWatchError
      && error.errorClass === "invalid_input"
      && /fragment/.test(error.message)
      && /rozmow/.test(error.message),
  );

  assert.throws(
    () =>
      buildConversationContext({
        sourceRef: SOURCE,
        conversationId: "convA",
        question,
        parentTurnId: null,
        turns,
        budget: { inputBudgetTokens: 0 },
      }),
    (error) => error.errorClass === "invalid_input",
  );
});

test("optional history is trimmed with an explicit flag while the newest answer stays", async () => {
  const older = [
    turn({ turnId: "q-old", role: "user", parentTurnId: null, text: "stare pytanie ".repeat(12), createdAt: "2026-01-01T09:00:00.000Z" }),
    turn({ turnId: "a-old", role: "assistant", parentTurnId: "q-old", text: "stara odpowiedz ".repeat(12), createdAt: "2026-01-01T09:01:00.000Z" }),
    turn({ turnId: "a-new", role: "assistant", parentTurnId: "q-old", text: "najnowsza odpowiedz", createdAt: "2026-01-01T09:02:00.000Z" }),
  ];
  const question = "nowe pytanie";
  const requiredTokens = estimateTokens("najnowsza odpowiedz") + estimateTokens(question);

  const context = buildConversationContext({
    sourceRef: SOURCE,
    conversationId: "convA",
    question,
    parentTurnId: null,
    turns: older,
    budget: { inputBudgetTokens: requiredTokens + estimateTokens("stara odpowiedz ".repeat(12)) },
  });
  assert.equal(context.trimmed, true);
  const included = context.turns.map((entry) => entry.turnId);
  assert.ok(included.includes("a-new"), "the newest answer is always required");
  assert.ok(included.includes("a-old"));
  assert.ok(!included.includes("q-old"), "the oldest optional turn is dropped first");

  const bundle = makeBundle(SOURCE, older, { conversationBudgetTokens: requiredTokens + estimateTokens("stara odpowiedz ".repeat(12)) });
  const result = await analyze(requestFor(SOURCE, { conversationId: "convA", question }), bundle.deps);
  const prompt = promptOf(bundle.model);
  assert.doesNotMatch(prompt, /stare pytanie/);
  assert.match(prompt, /najnowsza odpowiedz/);
  assert.equal(result.question, question);
});

test("context keys are stable for the same turns and change when the answer changes", () => {
  const base = buildConversationContext({
    sourceRef: SOURCE,
    conversationId: "convA",
    question: "rozwin drugi punkt",
    parentTurnId: "t-a1",
    turns: CHAIN_TURNS,
    budget: { inputBudgetTokens: 12000 },
  });
  const same = buildConversationContext({
    sourceRef: SOURCE,
    conversationId: "convA",
    question: "rozwin drugi punkt",
    parentTurnId: "t-a1",
    turns: CHAIN_TURNS,
    budget: { inputBudgetTokens: 12000 },
  });
  assert.equal(base.contextKey, same.contextKey);
  assert.equal(base.contextKey.startsWith("ctx_"), true);
  assert.equal(base.trimmed, false);

  const changed = buildConversationContext({
    sourceRef: SOURCE,
    conversationId: "convA",
    question: "rozwin drugi punkt",
    parentTurnId: "t-a1",
    turns: [CHAIN_TURNS[0], { ...CHAIN_TURNS[1], text: "1. Inny punkt\n2. Zmieniony punkt" }],
    budget: { inputBudgetTokens: 12000 },
  });
  assert.notEqual(base.contextKey, changed.contextKey);
});
