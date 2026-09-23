/**
 * Long films against DashScope's ~60 s pre-header close (LF, R2-01/03/05/08).
 *
 * Stubs only - no network, no API key, no ffmpeg. The provider behaviour these
 * tests model was measured live on 2026-09-23 (qa-omniwatch-20260923/LF-long-film):
 *   - headers arrive only with the first token; no headers after ~60 s = closed;
 *   - parts sent together wait behind each other's prefill;
 *   - an oss:// URL that already served a request can later be refused with 400.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { OmniWatchError } from "../src/contracts/index.ts";
import { aggregateUsage, analyze, runGated, unknownPartsMessage } from "../src/analysis/engine.ts";
import { createOpenAiModelPort } from "../src/analysis/provider-openai.ts";
import {
  effectiveMaxFramesPerPart,
  keyframeAlignedStart,
  partPlan,
  QWEN38_OMNI_FLASH_MAX_FRAMES_PER_PART,
  shiftTimestamps,
  splitParts,
} from "../src/sources/media.ts";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ scheduling --- */

test("runGated never exceeds the limit and starts the next item only after the running ones started answering", async () => {
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let waitingForHeaders = 0;
  let violations = 0;
  await runGated([0, 1, 2, 3, 4, 5], 3, async (item, started) => {
    if (waitingForHeaders > 0) violations += 1;
    inFlight += 1;
    waitingForHeaders += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    log.push(`start ${item}`);
    await tick(5); // prefill
    waitingForHeaders -= 1;
    started();
    await tick(item === 0 ? 40 : 15); // generation; part 0 is slow
    inFlight -= 1;
    log.push(`end ${item}`);
  });
  assert.equal(violations, 0, "no part is sent while another is still waiting for headers");
  assert.ok(maxInFlight > 1, "generation overlaps with the next prefill");
  assert.ok(maxInFlight <= 3, `at most 3 in flight, saw ${maxInFlight}`);
  assert.equal(log.filter((line) => line.startsWith("end")).length, 6);
});

test("runGated treats a call that never reports headers as started when it settles, and honours stop()", async () => {
  const started = [];
  await runGated([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    await tick(2);
  }, () => started.length >= 2);
  assert.deepEqual(started, [0, 1], "stop() prevents new starts; running items finish");
});

/* ------------------------------------------------------------ split policy --- */

test("Qwen3.8-Omni-Flash parts are capped at 240 frames in the core, for every shell", () => {
  assert.equal(QWEN38_OMNI_FLASH_MAX_FRAMES_PER_PART, 240);
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash", 2400), 240);
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash-2026-09-01", 480), 240);
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash", 100), 100, "a smaller setting still wins");
  assert.equal(effectiveMaxFramesPerPart("other-model", 2400), 2400);
  // The film from the report: 1953 s at 2 fps -> 17 parts of ~115 s (~46k tokens).
  const plan = partPlan(1953, { maxFramesPerPart: 240 });
  assert.equal(plan.length, 17);
  assert.ok(plan.every((part) => (part.endSeconds - part.startSeconds) * 2 <= 240));
});

test("every part carries the FILM's sampling rate: early parts of a 5-minute film are not sampled at 10 fps", async () => {
  const info = { sourceRef: { platform: "youtube", sourceId: "x", canonicalUrl: "https://youtu.be/x" }, title: "t", channel: null,
    durationSeconds: 300, extractor: "t", localPath: "/tmp/x/source.mp4" };
  const parts = await splitParts(info, { maxFramesPerPart: 240 }, async ({ index, count }) => `/tmp/x/part_${count}_${index}.mp4`);
  assert.equal(parts.length, 3);
  assert.ok(parts[0].endSeconds <= 180, "part 0 ends inside the short-form window");
  assert.deepEqual(parts.map((part) => part.fps), [2, 2, 2]);

  const bodies = [];
  const model = createOpenAiModelPort({
    config: { modelName: "fixture", apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 240 },
    resolveMediaUrl: async (part) => `oss://bucket/${part.index}`,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n"]);
    },
  });
  await model.call({ operationId: "op", attemptId: "a", partIndex: 0, messages: [{ role: "user", text: "x" }], mediaParts: [parts[0]], language: "pl" }, sink());
  assert.equal(bodies[0].messages[0].content[0].fps, 2);
});

/* --------------------------------------------------------- R2-08 offsets --- */

test("R2-08: a stream-copied part that starts on an earlier keyframe shifts notes by its real start", async () => {
  // TikTok 7681695065927912735: 58.54 s, two parts planned at 29.27 s; the second
  // file is 34.61 s long, so it really starts at 23.93 s.
  assert.equal(keyframeAlignedStart(29.27, 58.54, 29.29), 29.27, "container rounding is not a shift");
  const real = keyframeAlignedStart(29.27, 58.54, 34.61);
  assert.ok(Math.abs(real - 23.93) < 0.01, `start ${real}`);
  const info = { sourceRef: { platform: "tiktok", sourceId: "t", canonicalUrl: "https://t" }, title: "t", channel: null,
    durationSeconds: 58.54, extractor: "t", localPath: "/tmp/t/source.mp4" };
  const parts = await splitParts(info, { maxFramesPerPart: 300, fpsForSeconds: () => 10 }, async (request) => ({
    localPath: `/tmp/t/part_${request.index}.mp4`,
    startSeconds: request.index === 1 ? real : request.startSeconds,
  }));
  assert.ok(Math.abs(parts[1].startSeconds - 23.93) < 0.01);
  // The model's "[0:32] TikTok logo" in part 2 is inside the 0:58 film, not at 1:01.
  const shifted = shiftTimestamps("[0:32] logo", parts[1].startSeconds, parts[1].endSeconds - parts[1].startSeconds);
  assert.equal(shifted, "[0:55] logo");
  // A reported start later than the plan is not believable and is ignored.
  const bogus = await splitParts(info, { maxFramesPerPart: 300, fpsForSeconds: () => 10 }, async (request) => ({
    localPath: "/tmp/t/p.mp4", startSeconds: request.startSeconds + 5,
  }));
  assert.deepEqual(bogus.map((part) => Math.round(part.startSeconds * 100) / 100), [0, 29.27]);
});

/* ----------------------------------------------------------- engine runs --- */

function engineDeps({ duration = 600, model, completedAttempts = [], concurrency }) {
  const sourceRef = { platform: "youtube", sourceId: "LONG01", canonicalUrl: "https://www.youtube.com/watch?v=LONG01" };
  const journal = [];
  const events = [];
  const deps = {
    clock: { now: () => new Date("2026-09-23T12:00:00.000Z"), setTimeout, clearTimeout },
    logger: { info() {}, warn() {}, error() {} },
    config: {
      dataDir: "/tmp/lf", memoryRoot: "/tmp/lf/m", language: "pl", modelName: model.modelName,
      apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 240, cacheHours: () => 48,
      ...(concurrency ? { partConcurrency: () => concurrency } : {}),
    },
    source: {
      capabilities: () => ({}),
      async resolve() { return sourceRef; },
      async prepare() {
        return { sourceRef, title: "Long", channel: "C", durationSeconds: duration, extractor: "t", localPath: "/tmp/lf/source.mp4" };
      },
      async split(info, options) {
        return splitParts(info, options, async ({ index, count }) => `/tmp/lf/part_${count}_${index}.mp4`);
      },
    },
    model,
    attempts: {
      async intent(record) { journal.push({ ...record, phase: "intent" }); },
      async started() {},
      async response(id, response) {
        const intent = journal.find((entry) => entry.id === id);
        journal.push({ ...intent, phase: "response", responseSummary: response.text, usage: response.usage, createdAt: "2026-09-23T12:00:00.000Z" });
      },
      async unknown(id) { journal.push({ id, phase: "unknown" }); },
      async failed(id) { journal.push({ id, phase: "failed" }); },
    },
    completedAttempts,
    progress: (event) => events.push(event),
    operationId: "op_long",
  };
  return { deps, journal, events, sourceRef };
}

function request(sourceRef) {
  return { sourceRef, mode: "summary", focus: null, question: null, language: "pl", analysisVersion: "analysis-v1",
    conversationId: null, parentTurnId: null, force: false };
}

const usage = { inputTokens: 100, outputTokens: 10, costUsd: 0.01, costKnown: true };

test("parts run side by side under the gate; one unknown part does not stop the others; no merge; cost unknown", async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const model = {
    modelName: "qwen3.8-omni-flash",
    async call(req) {
      calls.push(req.partIndex);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await tick(3);
        if (req.partIndex === 1 || req.partIndex === 3) {
          // The provider closed the socket before headers: never started answering.
          throw new OmniWatchError("outcome_unknown", "Polaczenie z modelem przerwane (phase=headers code=UND_ERR_SOCKET).");
        }
        req.onResponseStarted?.();
        await tick(10);
        return { text: `[0:10] notatka ${req.partIndex}`, usage, completed: true };
      } finally {
        inFlight -= 1;
      }
    },
  };
  const { deps, events, journal, sourceRef } = engineDeps({ duration: 600, model });
  const outcome = await analyze(request(sourceRef), deps);
  assert.equal(outcome.parts, 5, "600 s at 2 fps and 240 frames -> 5 parts");
  assert.deepEqual([...calls].sort(), [0, 1, 2, 3, 4], "every part was attempted once; no merge");
  assert.ok(maxInFlight > 1 && maxInFlight <= 3, `bounded overlap, saw ${maxInFlight}`);
  assert.equal(outcome.errorClass, "outcome_unknown");
  assert.deepEqual(outcome.unknownParts, [1, 3]);
  assert.match(outcome.outcomeMessage, /czesci 2, 4 \(z 5\)/);
  assert.match(outcome.outcomeMessage, /Gotowe czesci \(3\/5\)/);
  assert.equal(outcome.usage.costKnown, false, "R2-05: an unknown part makes the run's cost unknown");
  assert.equal(outcome.usage.costUsd, null);
  assert.deepEqual(events.filter((event) => event.stage === "part_unknown").map((event) => event.itemIndex).sort(), [1, 3]);
  assert.equal(events.filter((event) => event.stage === "part_done").length, 3);
  assert.equal(journal.filter((entry) => entry.phase === "response").length, 3);
  // Notes of the finished parts are kept and shifted to the film's clock.
  assert.match(outcome.content, /\[2:10\] notatka 1|\[4:10\] notatka 2/);

  // Confirmed retry: only the two unknown parts and the merge are paid for.
  const retryCalls = [];
  const retryModel = {
    modelName: "qwen3.8-omni-flash",
    async call(req) {
      retryCalls.push(req.partIndex);
      req.onResponseStarted?.();
      return { text: req.mediaParts.length ? `[0:05] druga proba ${req.partIndex}` : "## Scalone [12:00]", usage, completed: true };
    },
  };
  const second = engineDeps({ duration: 600, model: retryModel, completedAttempts: journal.filter((entry) => entry.phase === "response") });
  const retried = await analyze(request(second.sourceRef), second.deps);
  assert.deepEqual([...retryCalls].sort((a, b) => a - b), [1, 3, 5], "parts 1 and 3, then the merge (index 5)");
  assert.equal(retried.errorClass, null);
  assert.equal(retried.content, "## Scalone [12:00]");
  assert.equal(second.events.filter((event) => event.stage === "call_reused").length, 3);
});

test("a definitive rejection stops new parts but waits for the ones in flight", async () => {
  const calls = [];
  const settled = [];
  const model = {
    modelName: "qwen3.8-omni-flash",
    async call(req) {
      calls.push(req.partIndex);
      if (req.partIndex === 1) throw new OmniWatchError("provider_rejected", "Model odrzucil zadanie (400).");
      req.onResponseStarted?.();
      await tick(20);
      settled.push(req.partIndex);
      return { text: "[0:01] x", usage, completed: true };
    },
  };
  const { deps, sourceRef } = engineDeps({ duration: 600, model });
  await assert.rejects(analyze(request(sourceRef), deps), (error) => error.errorClass === "provider_rejected");
  assert.ok(!calls.includes(4), `no new part after the rejection, called ${calls}`);
  assert.deepEqual(settled.sort(), calls.filter((index) => index !== 1).sort(), "every started call finished before the throw");
});

test("partConcurrency=1 is strictly one part at a time", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const model = {
    modelName: "fixture",
    async call(req) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      req.onResponseStarted?.();
      await tick(3);
      inFlight -= 1;
      return { text: "x", usage, completed: true };
    },
  };
  const { deps, sourceRef } = engineDeps({ duration: 600, model, concurrency: 1 });
  const outcome = await analyze(request(sourceRef), deps);
  assert.equal(outcome.errorClass, null);
  assert.equal(maxInFlight, 1);
});

test("R2-05: usage with any unknown call is never reported as a known cost", () => {
  const ok = { text: "", usage, completed: true };
  assert.equal(aggregateUsage([ok, ok]).costKnown, true);
  assert.equal(aggregateUsage([ok, ok], 1).costKnown, false);
  assert.equal(aggregateUsage([ok, ok], 1).costUsd, null);
  assert.match(unknownPartsMessage([7], 17, 16, "phase=headers"), /czesc 8\/17/);
});

/* -------------------------------------------------------------- provider --- */

function sseResponse(frames, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status, headers: { "content-type": "text/event-stream" } });
}

function sink() {
  return { async intent() {}, async started() {}, async response() {}, async unknown() {}, async failed() {} };
}

const INVALID_URL_BODY = JSON.stringify({ error: { message: "<400> InternalError.Algo.InvalidParameter: The provided URL does not appear to be valid. Ensure it is correctly formatted.", code: "invalid_parameter_error" } });
const DONE = ["data: {\"choices\":[{\"delta\":{\"content\":\"odpowiedz\"},\"finish_reason\":null}]}\n\n", "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n", "data: [DONE]\n\n"];

test("R2-03: a refused oss:// URL is uploaded again and the request is sent exactly once more", async () => {
  const resolved = [];
  const sent = [];
  let headers = 0;
  const model = createOpenAiModelPort({
    config: { modelName: "qwen3.8-omni-flash", apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 240 },
    resolveMediaUrl: async (part, options) => {
      resolved.push(options?.refresh === true);
      return options?.refresh ? "oss://bucket/fresh.mp4" : "oss://bucket/cached.mp4";
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.messages[0].content[0].video_url.url);
      return sent.length === 1 ? new Response(INVALID_URL_BODY, { status: 400 }) : sseResponse(DONE);
    },
  });
  const part = { index: 3, startSeconds: 0, endSeconds: 100, localPath: "/tmp/p.mp4", fps: 2 };
  const response = await model.call({ operationId: "op", attemptId: "a", partIndex: 3, messages: [{ role: "user", text: "x" }],
    mediaParts: [part], language: "pl", onResponseStarted: () => { headers += 1; } }, sink());
  assert.equal(response.completed, true);
  assert.equal(response.text, "odpowiedz");
  assert.deepEqual(resolved, [false, true], "second resolution asks the host for a fresh upload");
  assert.deepEqual(sent, ["oss://bucket/cached.mp4", "oss://bucket/fresh.mp4"]);
  assert.equal(headers, 1, "the scheduler hears about the answering request once");
});

test("R2-03: a second refusal, or any other 400, is a plain rejection with no further request", async () => {
  let sent = 0;
  const always = createOpenAiModelPort({
    config: { modelName: "m", apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 240 },
    resolveMediaUrl: async () => "oss://bucket/x.mp4",
    fetchImpl: async () => { sent += 1; return new Response(INVALID_URL_BODY, { status: 400 }); },
  });
  const part = { index: 0, startSeconds: 0, endSeconds: 10, localPath: "/tmp/p.mp4", fps: 2 };
  const req = { operationId: "op", attemptId: "a", partIndex: 0, messages: [{ role: "user", text: "x" }], mediaParts: [part], language: "pl" };
  await assert.rejects(always.call(req, sink()), (error) => error.errorClass === "provider_rejected" && /does not appear to be valid/.test(error.message));
  assert.equal(sent, 2);

  sent = 0;
  const other = createOpenAiModelPort({
    config: { modelName: "m", apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 240 },
    resolveMediaUrl: async () => "oss://bucket/x.mp4",
    fetchImpl: async () => { sent += 1; return new Response("{\"error\":{\"message\":\"Range of input length should be [1, 991000]\"}}", { status: 400 }); },
  });
  await assert.rejects(other.call(req, sink()), (error) => error.errorClass === "provider_rejected");
  assert.equal(sent, 1, "only the media-URL refusal is resent");
});

test("a pre-header close stays outcome_unknown, is never resent, and reports wire time without upload time", async () => {
  let sent = 0;
  const model = createOpenAiModelPort({
    config: { modelName: "m", apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 240 },
    resolveMediaUrl: async () => { await tick(30); return "oss://bucket/x.mp4"; },
    fetchImpl: async () => {
      sent += 1;
      const error = new TypeError("fetch failed");
      error.cause = { code: "UND_ERR_SOCKET" };
      throw error;
    },
  });
  const part = { index: 0, startSeconds: 0, endSeconds: 10, localPath: "/tmp/p.mp4", fps: 2 };
  await assert.rejects(
    model.call({ operationId: "op", attemptId: "a", partIndex: 0, messages: [{ role: "user", text: "x" }], mediaParts: [part], language: "pl" }, sink()),
    (error) => {
      assert.equal(error.errorClass, "outcome_unknown");
      const elapsed = Number(/elapsed_ms=(\d+)/.exec(error.message)[1]);
      assert.ok(elapsed < 25, `upload time is not counted as wire time (${elapsed} ms)`);
      return true;
    },
  );
  assert.equal(sent, 1);
});
