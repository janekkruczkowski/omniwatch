/**
 * Long films against DashScope's ~60 s pre-header close (LF, R2-01/03/05/08).
 *
 * Stubs only - no network, no API key, no ffmpeg. The provider behaviour these
 * tests model was measured live on 2026-09-23 (qa-omniwatch-20260923/LF-long-film and
 * LF2-speed):
 *   - headers arrive only with the first token; no headers after ~60 s = closed, on the
 *     compatible and the native SSE endpoint alike (TCP keepalive, HTTP/2 and timeout
 *     headers do not change it);
 *   - that close is a random provider queueing tail, not caused by our concurrency:
 *     17 parts sent at once all answered;
 *   - an oss:// URL that already served a request can later be refused with 400.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { OmniWatchError } from "../src/contracts/index.ts";
import {
  aggregateUsage,
  analyze,
  countUnknownCostCalls,
  DEFAULT_PART_CONCURRENCY,
  runBounded,
  unknownPartsMessage,
} from "../src/analysis/engine.ts";
import { createOpenAiModelPort } from "../src/analysis/provider-openai.ts";
import {
  effectiveMaxFramesPerPart,
  fpsFor,
  keyframeAlignedStart,
  partPlan,
  QWEN38_OMNI_FLASH_LONG_FILM_MAX_FRAMES_PER_PART,
  QWEN38_OMNI_FLASH_MAX_FRAMES_PER_PART,
  shiftTimestamps,
  splitParts,
} from "../src/sources/media.ts";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ scheduling --- */

test("runBounded keeps up to the limit in flight without waiting for headers (LF2)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const ended = [];
  await runBounded([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (item) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // A call that never answers for a long time does not hold the others back.
    await tick(item === 0 ? 40 : 5);
    inFlight -= 1;
    ended.push(item);
  });
  assert.equal(maxInFlight, 4, "the limit is used in full, not one-by-one behind a header gate");
  assert.equal(ended.length, 10);
  assert.ok(ended.indexOf(0) > 3, "later items finished while the slow first one was still waiting");
});

test("runBounded honours stop() and swallows nothing it should not start", async () => {
  const started = [];
  await runBounded([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    await tick(2);
  }, () => started.length >= 2);
  assert.deepEqual(started, [0, 1], "stop() prevents new starts; running items finish");
  assert.ok(DEFAULT_PART_CONCURRENCY >= 8, "a 30-minute film's parts run side by side by default");
});

/* ------------------------------------------------------------ split policy --- */

test("long films (> 10 min) are sampled at 1 fps in 2-minute parts of 120 frames (LF2)", () => {
  assert.equal(fpsFor(180), 10);
  assert.equal(fpsFor(181), 2);
  assert.equal(fpsFor(600), 2);
  assert.equal(fpsFor(601), 1);
  assert.equal(QWEN38_OMNI_FLASH_LONG_FILM_MAX_FRAMES_PER_PART, 120);
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash", 2400, 1953), 120);
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash", 2400, 600), 240, "a 10-minute film keeps 2 fps parts");
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash", 60, 1953), 60, "a smaller setting still wins");
  assert.equal(effectiveMaxFramesPerPart("other-model", 2400, 1953), 2400);
  // The owner's film: 32:33 -> 17 parts of ~115 s at 1 fps (~25k tokens each).
  const plan = partPlan(1953, { maxFramesPerPart: 120 });
  assert.equal(plan.length, 17);
  assert.ok(plan.every((part) => part.endSeconds - part.startSeconds <= 120));
  // 34:21 -> 18 parts.
  assert.equal(partPlan(2061, { maxFramesPerPart: 120 }).length, 18);
});

test("Qwen3.8-Omni-Flash parts are capped at 240 frames in the core, for every shell", () => {
  assert.equal(QWEN38_OMNI_FLASH_MAX_FRAMES_PER_PART, 240);
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash", 2400), 240);
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash-2026-09-01", 480), 240);
  assert.equal(effectiveMaxFramesPerPart("qwen3.8-omni-flash", 100), 100, "a smaller setting still wins");
  assert.equal(effectiveMaxFramesPerPart("other-model", 2400), 2400);
  // Without a known length the 240-frame bound applies (2 fps films up to 10 min).
  const plan = partPlan(600, { maxFramesPerPart: 240 });
  assert.equal(plan.length, 5);
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

test("R3 M19: ranges are shifted to the film's clock and a clip overrun never passes the part's end", () => {
  // Live R3 (c-lBErfxszs, 0:31, 2 parts): part 2 really starts at 11.93 s and the model
  // wrote ranges, one of them past its 19 s clip. Unshifted, "[0:05–0:07]" became 0:04
  // in a follow-up and "[0:21–0:25]" became 0:33 in a 0:31 film.
  const offset = 11.93;
  const length = 31 - offset;
  assert.equal(shiftTimestamps("[0:05–0:07] dashed spine line", offset, length), "[0:16–0:18] dashed spine line");
  assert.equal(shiftTimestamps("[0:05-0:07] ascii dash", offset, length), "[0:16–0:18] ascii dash");
  assert.equal(shiftTimestamps("[0:08] one unit", offset, length), "[0:19] one unit");
  assert.equal(shiftTimestamps("[0:21–0:25] knees", offset, length), "[0:31–0:31] knees");
  assert.equal(shiftTimestamps("[0:22] rest", offset, length), "[0:31] rest");
  // Clearly absolute positions (well past the clip) are still left alone.
  assert.equal(shiftTimestamps("[9:00–9:05] recap", 0, 120), "[9:00–9:05] recap");
  assert.equal(shiftTimestamps("[1:00:05] long", 3600, 300), "[1:00:05] long");
});

/* ----------------------------------------------------------- engine runs --- */

// Timers fire at once: the unbilled-retry backoff is policy, not something to wait for here.
const fastClock = {
  now: () => new Date("2026-09-23T12:00:00.000Z"),
  setTimeout: (fn) => setImmediate(fn),
  clearTimeout() {},
};

function engineDeps({ duration = 600, model, completedAttempts = [], concurrency, preHeaderRetries, clock }) {
  const sourceRef = { platform: "youtube", sourceId: "LONG01", canonicalUrl: "https://www.youtube.com/watch?v=LONG01" };
  const journal = [];
  const events = [];
  const deps = {
    clock: clock ?? { now: () => new Date("2026-09-23T12:00:00.000Z"), setTimeout, clearTimeout },
    logger: { info() {}, warn() {}, error() {} },
    config: {
      dataDir: "/tmp/lf", memoryRoot: "/tmp/lf/m", language: "pl", modelName: model.modelName,
      apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 240, cacheHours: () => 48,
      ...(concurrency ? { partConcurrency: () => concurrency } : {}),
      ...(preHeaderRetries !== undefined ? { preHeaderRetries: () => preHeaderRetries } : {}),
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
      async unknown(id) {
        const intent = journal.find((entry) => entry.id === id);
        journal.push({ id, partIndex: intent?.partIndex, phase: "unknown" });
      },
      async failed(id) {
        const intent = journal.find((entry) => entry.id === id);
        journal.push({ id, partIndex: intent?.partIndex, phase: "failed" });
      },
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

test("parts run side by side; one unknown part does not stop the others; no merge; cost unknown", async () => {
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
          // Unknown for a reason other than a provider pre-header close (no transportPhase):
          // never resent automatically.
          throw new OmniWatchError("outcome_unknown", "Model zwrocil blad 502; nie wiadomo, czy wywolanie zostalo rozliczone.");
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
  assert.equal(maxInFlight, 5, "all five parts in flight together, no header gate");
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
  const { deps, sourceRef } = engineDeps({ duration: 600, model, concurrency: 2 });
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

/* ------------------------------------------------------------- R3-03 --- */

/**
 * The R3-03 case: the operation was first run with two calls whose outcome is unknown,
 * then consciously retried. The retry reports `costKnown: true` and the cost of what it
 * confirmed — correct for what it bills, but the operation may also have been charged
 * for the two earlier calls. The count travels on the usage so the UI can say so.
 */
test("R3-03: a retry reports the earlier unconfirmed calls alongside its own confirmed cost", () => {
  // The journal as it looks after the first run: two calls reached the provider and no
  // response was ever committed for either.
  const firstRun = [
    { id: "att_1", operationId: "op_long", phase: "intent", partIndex: 0, createdAt: "2026-09-23T12:00:00.000Z" },
    { id: "att_1", operationId: "op_long", phase: "started", partIndex: 0, createdAt: "2026-09-23T12:00:00.000Z" },
    { id: "att_1", operationId: "op_long", phase: "unknown", partIndex: 0, createdAt: "2026-09-23T12:00:00.000Z" },
    { id: "att_2", operationId: "op_long", phase: "intent", partIndex: 2, createdAt: "2026-09-23T12:00:00.000Z" },
    { id: "att_2", operationId: "op_long", phase: "started", partIndex: 2, createdAt: "2026-09-23T12:00:00.000Z" },
    // A process killed mid-call leaves `started` and nothing after it.
    { id: "att_3", operationId: "op_long", phase: "started", partIndex: 4, createdAt: "2026-09-23T12:00:00.000Z" },
    // A definitive rejection provably never ran the model, so it is not charged.
    { id: "att_4", operationId: "op_long", phase: "failed", partIndex: 5, createdAt: "2026-09-23T12:00:00.000Z" },
    // A call confirmed in the first run: it is in the total, never counted as unknown.
    { id: "att_5", operationId: "op_long", phase: "response", partIndex: 1, createdAt: "2026-09-23T12:00:00.000Z" },
  ];
  // att_1 ended `unknown`, att_2 and att_3 were left `started` (the process died before
  // anything was written after them): three calls may have been billed and none of them
  // is in the retry's total. att_1's three journal rows are one call, not three.
  assert.equal(countUnknownCostCalls(firstRun), 3, "two started plus one unknown, deduplicated by id");
  // No journal at all is the ordinary first run: nothing to report.
  assert.equal(countUnknownCostCalls([]), 0);
  assert.equal(countUnknownCostCalls(undefined), 0);
  // An attempt written `unknown` and then confirmed is the same call, now accounted for.
  assert.equal(
    countUnknownCostCalls([
      { id: "att_6", operationId: "op_long", phase: "unknown", partIndex: 0, createdAt: "2026-09-23T12:00:00.000Z" },
      { id: "att_6", operationId: "op_long", phase: "response", partIndex: 0, createdAt: "2026-09-23T12:00:00.000Z" },
    ]),
    0,
    "a confirmed call is never counted as unknown",
  );

  // The count rides on the usage, and only when there is something to report.
  const confirmed = { text: "## Scalone", usage, completed: true };
  assert.equal(aggregateUsage([confirmed], 0, 0).unknownCostCalls, undefined, "a clean run is unchanged");
  assert.equal(aggregateUsage([confirmed], 0, 3).unknownCostCalls, 3);
  assert.equal(aggregateUsage([confirmed], 0, 3).costKnown, true, "the confirmed total is still known");
});

test("R3-03: the retry's own result carries the earlier unconfirmed calls", async () => {
  const firstRun = [
    { id: "att_a", operationId: "op_long", phase: "started", partIndex: 0, createdAt: "2026-09-23T12:00:00.000Z" },
    { id: "att_a", operationId: "op_long", phase: "unknown", partIndex: 0, createdAt: "2026-09-23T12:00:00.000Z" },
    { id: "att_b", operationId: "op_long", phase: "started", partIndex: 1, createdAt: "2026-09-23T12:00:00.000Z" },
    { id: "att_b", operationId: "op_long", phase: "unknown", partIndex: 1, createdAt: "2026-09-23T12:00:00.000Z" },
  ];
  const model = {
    modelName: "stub-retry",
    async call(req) {
      req.onResponseStarted?.();
      return { text: `[0:05] po ponowieniu ${req.partIndex}`, usage, completed: true };
    },
  };
  const { deps, sourceRef } = engineDeps({ duration: 16, model, completedAttempts: firstRun });
  const outcome = await analyze(request(sourceRef), deps);
  assert.equal(outcome.errorClass, null, "the retry itself succeeded");
  assert.equal(outcome.usage.costKnown, true, "the confirmed calls of this run are known");
  assert.equal(outcome.usage.unknownCostCalls, 2, "the two earlier calls are reported");
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

/* ------------------------------------------------ LF2 bounded resend policy --- */

const preHeaderClose = () => new OmniWatchError("outcome_unknown",
  "Polaczenie z modelem przerwane; nie wiadomo, czy wywolanie doszlo do skutku. (phase=headers code=UND_ERR_SOCKET name=TypeError abort=none elapsed_ms=60040)",
  { transportPhase: "headers" });

function scriptedModel(script) {
  const calls = [];
  return {
    calls,
    model: {
      modelName: "qwen3.8-omni-flash",
      async call(req) {
        calls.push(req.partIndex);
        const seen = calls.filter((index) => index === req.partIndex).length;
        const step = script(req.partIndex, seen);
        if (step instanceof Error) throw step;
        if (step === "broken-stream") return { text: "[0:01] pol", usage, completed: false, failureDetail: "phase=stream code=UND_ERR_SOCKET" };
        return { text: req.mediaParts.length ? `[0:10] notatka ${req.partIndex}` : "## Scalone", usage, completed: true };
      },
    },
  };
}

test("LF2: a provider close before headers is resent once and the film is delivered; cost is reported as unknown", async () => {
  const { calls, model } = scriptedModel((index, seen) => (index === 2 && seen === 1 ? preHeaderClose() : "ok"));
  const { deps, journal, events, sourceRef } = engineDeps({ duration: 600, model });
  const outcome = await analyze(request(sourceRef), deps);
  assert.equal(outcome.errorClass, null, "all parts confirmed, merged, delivered");
  assert.equal(outcome.content, "## Scalone");
  assert.equal(outcome.unknownParts, undefined);
  assert.deepEqual(calls.filter((index) => index === 2), [2, 2], "part 2 sent twice");
  assert.equal(calls.filter((index) => index === 5).length, 1, "one merge");
  // The closed attempt keeps its own journal record; the resend is a new attempt.
  const part2 = journal.filter((entry) => entry.partIndex === 2);
  assert.deepEqual(part2.map((entry) => entry.phase), ["intent", "unknown", "intent", "response"]);
  assert.notEqual(part2[0].id, part2[2].id);
  assert.equal(outcome.usage.costKnown, false, "the closed attempt may have been billed");
  assert.equal(outcome.usage.costUsd, null);
  assert.deepEqual(events.filter((event) => event.stage === "part_retry").map((event) => event.itemIndex), [2]);
});

test("LF2: resends are bounded (default 2): a part closed every time ends unknown, and no merge is paid for", async () => {
  const { calls, model } = scriptedModel((index) => (index === 1 ? preHeaderClose() : "ok"));
  const { deps, sourceRef } = engineDeps({ duration: 600, model });
  const outcome = await analyze(request(sourceRef), deps);
  assert.equal(outcome.errorClass, "outcome_unknown");
  assert.deepEqual(outcome.unknownParts, [1]);
  assert.equal(calls.filter((index) => index === 1).length, 3, "two resends, not more");
  assert.ok(!calls.includes(5), "no merge while a part is unknown");
  assert.match(outcome.outcomeMessage, /czesc 2\/5/);
});

test("LF2: preHeaderRetries=0 restores the strict policy; 1 allows a single resend", async () => {
  for (const [retries, sends] of [[0, 1], [1, 2]]) {
    const { calls, model } = scriptedModel((index) => (index === 1 ? preHeaderClose() : "ok"));
    const { deps, sourceRef } = engineDeps({ duration: 600, model, preHeaderRetries: retries });
    const outcome = await analyze(request(sourceRef), deps);
    assert.deepEqual(outcome.unknownParts, [1]);
    assert.equal(calls.filter((index) => index === 1).length, sends);
  }
});

test("LF2: a stream that broke after headers is never resent", async () => {
  const { calls, model } = scriptedModel((index) => (index === 3 ? "broken-stream" : "ok"));
  const { deps, sourceRef } = engineDeps({ duration: 600, model });
  const outcome = await analyze(request(sourceRef), deps);
  assert.deepEqual(outcome.unknownParts, [3]);
  assert.equal(calls.filter((index) => index === 3).length, 1);
});

test("LF2: a 429 (not run, not billed) is resent after a backoff and the cost stays known", async () => {
  const limited = () => new OmniWatchError("rate_limited", "Model odrzucil tempo zapytan (429).");
  const { calls, model } = scriptedModel((index, seen) => (index === 0 && seen <= 2 ? limited() : "ok"));
  const { deps, journal, sourceRef } = engineDeps({ duration: 600, model, clock: fastClock });
  const outcome = await analyze(request(sourceRef), deps);
  assert.equal(outcome.errorClass, null);
  assert.equal(calls.filter((index) => index === 0).length, 3, "two backoff resends");
  assert.deepEqual(journal.filter((entry) => entry.partIndex === 0).map((entry) => entry.phase),
    ["intent", "failed", "intent", "failed", "intent", "response"]);
  assert.equal(outcome.usage.costKnown, true, "nothing unknown was sent");
});

test("LF2: an upload that never reached the provider is resent at most twice, then fails the run", async () => {
  const notSent = () => new OmniWatchError("provider_rejected", "Nie udalo sie wyslac materialu czesci 4 do providera (ENOTFOUND).", { transportPhase: "not_sent" });
  const { calls, model } = scriptedModel((index) => (index === 4 ? notSent() : "ok"));
  const { deps, sourceRef } = engineDeps({ duration: 600, model, clock: fastClock });
  await assert.rejects(analyze(request(sourceRef), deps), (error) => error.errorClass === "provider_rejected");
  assert.equal(calls.filter((index) => index === 4).length, 3);
});

test("LF2 provider: only the provider's own pre-header close is marked for resend; uploads that fail are not_sent", async () => {
  const part = { index: 0, startSeconds: 0, endSeconds: 10, localPath: "/tmp/p.mp4", fps: 1 };
  const req = { operationId: "op", attemptId: "a", partIndex: 0, messages: [{ role: "user", text: "x" }], mediaParts: [part], language: "pl" };
  const socketClose = () => { const error = new TypeError("fetch failed"); error.cause = { code: "UND_ERR_SOCKET" }; return error; };
  const closing = createOpenAiModelPort({
    config: { modelName: "m", apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 120 },
    resolveMediaUrl: async () => "oss://bucket/x.mp4",
    fetchImpl: async () => { throw socketClose(); },
  });
  await assert.rejects(closing.call(req, sink()), (error) => error.errorClass === "outcome_unknown" && error.transportPhase === "headers");

  // Our own start-up deadline is not the provider's close: no resend mark.
  const timers = { setTimeout: (fn) => { setImmediate(fn); return 1; }, clearTimeout() {} };
  const slow = createOpenAiModelPort({
    config: { modelName: "m", apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 120 },
    resolveMediaUrl: async () => "oss://bucket/x.mp4",
    timeoutMs: 5, idleTimeoutMs: 0, timers,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  await assert.rejects(slow.call(req, sink()), (error) => {
    assert.equal(error.errorClass, "outcome_unknown");
    assert.match(error.message, /abort=deadline/);
    assert.equal(error.transportPhase, undefined);
    return true;
  });

  let fetched = 0;
  const failingUpload = createOpenAiModelPort({
    config: { modelName: "m", apiKey: () => "k", apiBaseUrl: () => "https://p.invalid/v1", maxFramesPerPart: () => 120 },
    resolveMediaUrl: async () => { const error = new TypeError("fetch failed"); error.cause = { code: "ENOTFOUND" }; throw error; },
    fetchImpl: async () => { fetched += 1; return sseResponse(DONE); },
  });
  await assert.rejects(failingUpload.call(req, sink()), (error) => {
    assert.equal(error.errorClass, "provider_rejected");
    assert.equal(error.transportPhase, "not_sent");
    assert.match(error.message, /ENOTFOUND/);
    return true;
  });
  assert.equal(fetched, 0, "no model request after a failed upload");
});

test("LF2: a resend that is then rejected keeps the part unknown (the closed send may have been billed)", async () => {
  const rejected = () => new OmniWatchError("provider_rejected", "Model odrzucil zadanie (400).");
  const { calls, model } = scriptedModel((index, seen) => (index === 2 ? (seen === 1 ? preHeaderClose() : rejected()) : "ok"));
  const { deps, sourceRef } = engineDeps({ duration: 600, model });
  const outcome = await analyze(request(sourceRef), deps);
  assert.equal(outcome.errorClass, "outcome_unknown");
  assert.deepEqual(outcome.unknownParts, [2]);
  assert.equal(calls.filter((index) => index === 2).length, 2);
  assert.match(outcome.outcomeMessage, /Ponowne wyslanie odrzucone/);
});
