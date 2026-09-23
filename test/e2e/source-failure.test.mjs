/**
 * R5, Agent OS panel: a YouTube download failure through the real jobs handler and the
 * real in-process consumer (live progress events), with yt-dlp replaced by a stub `run`.
 *
 * What the user saw on QzTkVaC-da4: yt-dlp refused (429, then "Sign in to confirm
 * you're not a bot"), the server logged `failed/source_unavailable modelCalls=0`, and the
 * card still drew "watching the film" / "writing the answer" next to the raw error.
 * These tests pin the opposite: stages only from real events, a failure lights no step,
 * the error is classified and says nothing was sent to the model, the raw output is only
 * `detail`, and a plain 429 is retried once after a visible wait.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";

import { enqueueAnalysis } from "../../packages/omniwatch/src/runtime/queue.ts";
import { createSourceRegistry } from "../../packages/omniwatch/src/sources/registry.ts";
import { runYtDlpResilient } from "../../packages/omniwatch/src/sources/ytdlp.ts";
import { createJobsHandler } from "../../agent-os-module/src/app/api/omniwatch/jobs/handler.ts";
import { createPanelConsumer } from "../../agent-os-module/src/lib/omniwatchPanelRuntime.ts";
import { cardProgress, stageForEvent } from "../../agent-os-module/src/lib/omniwatchProgress.ts";
import { cachedIds, cleanupTempDirs, createHarness, mediaLookup } from "./omniwatch-harness.mjs";

after(cleanupTempDirs);

const URL = "https://www.youtube.com/watch?v=QzTkVaC-da4";

const LIVE_BOT_CHECK = [
  "yt-dlp failed:",
  "WARNING: [youtube] QzTkVaC-da4: Unable to download API page: HTTP Error 429: Too Many Requests",
  "WARNING: [youtube] QzTkVaC-da4: Unable to fetch GVS PO Token for web client: Missing required Visitor Data.",
  "ERROR: [youtube] QzTkVaC-da4: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
].join("\n");
const PLAIN_429 = "yt-dlp failed:\nERROR: [youtube] QzTkVaC-da4: Unable to download webpage: HTTP Error 429: Too Many Requests";

/**
 * A media tool shaped like the host adapter: every yt-dlp call goes through the shared
 * resilient runner, and `outputs` scripts what yt-dlp does on each call.
 */
function ytDlpMedia(outputs, { sleep } = {}) {
  const runs = [];
  return {
    runs,
    media: {
      cached: async () => null,
      async fetch(source, options) {
        await runYtDlpResilient(["-J", "--no-playlist", source.canonicalUrl], {
          url: source.canonicalUrl,
          run: async (args) => {
            runs.push(args);
            const next = outputs.shift();
            if (next instanceof Error) throw next;
            return next ?? "{}";
          },
          onWait: options?.onWait,
          ...(sleep ? { sleep } : {}),
        });
        return { localPath: "/nonexistent/source.mp4", title: "QzTkVaC-da4", channel: "Chan", durationSeconds: 60, extractor: "Youtube" };
      },
      slice: async () => {
        throw new Error("one part only in these tests");
      },
    },
  };
}

function setup(outputs, options = {}) {
  const stub = ytDlpMedia(outputs, options);
  const h = createHarness({ source: createSourceRegistry({ media: stub.media }) });
  const consumer = createPanelConsumer({ deps: h.deps, token: `panel_test_${Math.random().toString(16).slice(2)}` });
  const handler = createJobsHandler({
    store: h.store,
    memory: h.memory,
    resolveSource: async ({ url }) => h.source.resolve({ url }),
    isCached: cachedIds([]),
    enqueue: (request) => enqueueAnalysis({ store: h.store, request }),
    ensureWorker: (id) => consumer.run(id),
    recover: async () => {
      await consumer.recover();
    },
    hasConsumer: (id) => consumer.hasConsumer(id),
    progress: (id) => consumer.progress(id),
    lookupMedia: mediaLookup({}),
    legacyFilm: { dispatch: async () => ({ answer: "", stats: {} }) },
    defaultLanguage: "pl",
    languages: ["pl", "en"],
  });
  after(() => consumer.close());
  return { h, stub, consumer, handler };
}

async function start(handler) {
  const response = await handler.POST(new Request("http://localhost/api/omniwatch/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: URL }),
  }));
  assert.equal(response.status, 202);
  return (await response.json()).id;
}

async function poll(handler, id) {
  return (await handler.GET(new Request(`http://localhost/api/omniwatch/jobs?id=${id}`))).json();
}

test("R5: the live bot-check failure ends as one classified error - no answer stage, no film, no model call", async () => {
  const { h, stub, consumer, handler } = setup([new Error(LIVE_BOT_CHECK)]);
  const id = await start(handler);
  await consumer.idle();

  const view = await poll(handler, id);
  assert.equal(view.state, "error");
  assert.equal(view.errorClass, "source_unavailable");
  assert.equal(view.stage, "failed", "a failure lights no step - never 'answer'");
  assert.notEqual(view.stage, "watch");
  assert.equal(view.meta, undefined, "no film was downloaded, so the card gets no player to point at");
  assert.equal(view.sourceFailure.reason, "bot_check");
  assert.equal(view.sourceFailure.retryable, false);
  assert.equal(view.noModelCalls, true, "the server confirms nothing was sent to the model");
  assert.doesNotMatch(view.error, /Sign in to confirm/, "the headline is the friendly sentence, not yt-dlp's text");
  assert.match(view.error, /nie jestem botem/);
  assert.match(view.sourceFailure.detail, /Sign in to confirm you're not a bot/, "the raw output is kept for 'details'");
  assert.match(view.sourceFailure.detail, /HTTP Error 429/);

  assert.equal(h.model.calls.length, 0, "zero model calls");
  assert.equal(stub.runs.length, 1, "a bot check is not retried");
  assert.equal(h.store.listAttempts(id).length, 0, "no paid attempt was journaled");
});

test("R5: a plain 429 waits once - the card shows the real wait on the download step, then the run finishes", async () => {
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const sleep = () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const { h, stub, consumer, handler } = setup([new Error(PLAIN_429), "{\"title\":\"ok\"}"], { sleep });
  const id = await start(handler);
  await waiting;

  const during = await poll(handler, id);
  assert.equal(during.state, "running");
  assert.equal(during.stage, "download", "still downloading - not 'watching the film'");
  assert.equal(during.wait.reason, "rate_limited_by_youtube");
  assert.equal(during.wait.seconds, 30);
  assert.ok(during.wait.remainingSeconds > 0 && during.wait.remainingSeconds <= 30);
  assert.equal(h.model.calls.length, 0, "nothing reaches the model while the download waits");

  release();
  await consumer.idle();
  const done = await poll(handler, id);
  assert.equal(done.state, "done");
  assert.equal(stub.runs.length, 2, "exactly one retry");
  assert.equal(h.model.calls.length, 1);
});

test("R5: a second 429 fails as rate_limited_by_youtube after the single retry", async () => {
  const { h, stub, consumer, handler } = setup([new Error(PLAIN_429), new Error(PLAIN_429)], { sleep: async () => {} });
  const id = await start(handler);
  await consumer.idle();
  const view = await poll(handler, id);
  assert.equal(view.state, "error");
  assert.equal(view.stage, "failed");
  assert.equal(view.sourceFailure.reason, "rate_limited_by_youtube");
  assert.equal(view.noModelCalls, true);
  assert.equal(stub.runs.length, 2);
  assert.equal(h.model.calls.length, 0);
});

test("R5: card stages come only from real events or the journal", () => {
  assert.deepEqual(cardProgress({ state: "pending", startedAttempts: 0 }), { stage: "queued" });
  assert.deepEqual(cardProgress({ state: "running", startedAttempts: 0 }), { stage: "download" },
    "running without any model attempt is still the download, never 'watch'");
  assert.deepEqual(cardProgress({ state: "running", startedAttempts: 1 }), { stage: "watch" });
  assert.deepEqual(cardProgress({ state: "failed", startedAttempts: 0 }), { stage: "failed" });
  assert.deepEqual(cardProgress({ state: "outcome_unknown", startedAttempts: 1 }), { stage: "failed" });
  assert.deepEqual(cardProgress({ state: "running", startedAttempts: 0, live: { stage: "split", at: 0 } }), { stage: "upload" });
  assert.deepEqual(cardProgress({ state: "running", startedAttempts: 1, live: { stage: "merge", at: 0 } }), { stage: "answer" });
  const waiting = cardProgress({
    state: "running",
    startedAttempts: 0,
    live: { stage: "source_wait", at: 1_000, waitSeconds: 30, reason: "rate_limited_by_youtube" },
    now: 11_000,
  });
  assert.deepEqual(waiting, { stage: "download", wait: { reason: "rate_limited_by_youtube", seconds: 30, remainingSeconds: 20 } });
  const over = cardProgress({ state: "running", startedAttempts: 0, live: { stage: "source_wait", at: 0, waitSeconds: 30 }, now: 31_000 });
  assert.deepEqual(over, { stage: "download" }, "no countdown once the wait is over");
  assert.equal(stageForEvent("prepare"), "download");
  assert.equal(stageForEvent("call"), "watch");
  assert.equal(stageForEvent("something-new"), null);
});
