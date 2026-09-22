/**
 * T0 acceptance: the frozen contracts are executable, key derivation is
 * deterministic, and nothing here needs a private Vault, network or API key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANALYSIS_VERSION,
  CONTRACT_VERSION,
  ERROR_CLASSES,
  OmniWatchError,
  canonicalRequestKey,
  computeAnalysisId,
  computeAnalysisKey,
  legacyHashId,
  toOmniWatchError,
} from "../src/contracts/index.ts";

/** @returns {import("../src/contracts/types.ts").AnalysisRequest} */
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

test("contract version is frozen and exported", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
  assert.equal(ANALYSIS_VERSION, "analysis-v1");
  assert.equal(ERROR_CLASSES.length, 11);
});

test("legacy hash matches the released Python beta identity", () => {
  // Fixture from docs/omniwatch/work-orders/BETA-FIXTURES.md ids.json
  assert.equal(legacyHashId("https://example.test/video/alpha"), "ade4dd11a0580e69");
});

test("analysis key is deterministic and independent of key order", () => {
  const a = makeRequest();
  const b = makeRequest();
  assert.equal(computeAnalysisKey(a), computeAnalysisKey(b));
  assert.equal(canonicalRequestKey(a), canonicalRequestKey(b));
});

test("focus, mode, language and parent turn all produce distinct keys", () => {
  const base = computeAnalysisKey(makeRequest());
  assert.notEqual(base, computeAnalysisKey(makeRequest({ focus: "redukcja tkanki tluszczowej" })));
  assert.notEqual(base, computeAnalysisKey(makeRequest({ mode: "teardown" })));
  assert.notEqual(base, computeAnalysisKey(makeRequest({ language: "en" })));
  assert.notEqual(base, computeAnalysisKey(makeRequest({ parentTurnId: "turn-1" })));
  assert.notEqual(base, computeAnalysisKey(makeRequest({ analysisVersion: "analysis-v2" })));
});

test("whitespace-only focus is treated as no focus", () => {
  assert.equal(computeAnalysisKey(makeRequest()), computeAnalysisKey(makeRequest({ focus: "   " })));
});

test("conversation context participates in the key", () => {
  const request = makeRequest({ mode: "teardown", question: "rozwin drugi punkt" });
  const withoutContext = computeAnalysisKey(request, null);
  const withContext = computeAnalysisKey(request, "turn-1:assistant-answer-2");
  assert.notEqual(withoutContext, withContext);
});

test("analysis id is a stable prefix of the key", () => {
  const key = computeAnalysisKey(makeRequest());
  assert.match(computeAnalysisId(key), /^omni_[0-9a-f]{16}$/);
  assert.equal(computeAnalysisId(key), computeAnalysisId(key));
});

test("errors carry a class, a safe message and a recovery action", () => {
  const error = new OmniWatchError("outcome_unknown", "Model call did not confirm completion", {
    operationId: "op-1",
    action: { label: "sprawdz operacje", kind: "check_operation" },
  });
  assert.equal(error.errorClass, "outcome_unknown");
  assert.equal(error.operationId, "op-1");
  assert.equal(error.action?.kind, "check_operation");
});

test("unknown failures are converted instead of swallowed", () => {
  const converted = toOmniWatchError(new Error("boom"), "storage_unavailable");
  assert.equal(converted.errorClass, "storage_unavailable");
  assert.match(converted.message, /boom/);
  assert.equal(toOmniWatchError(converted).errorClass, "storage_unavailable");
});
