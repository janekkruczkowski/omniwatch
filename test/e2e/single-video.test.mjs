/**
 * T09 / T10 (offline): the single-video card through the jobs route handler.
 *
 * No Next, no browser, no model provider: the handler runs against a real SQLite store,
 * the fixture source and a recording stub model, and the "worker" is the real
 * `runWorker` from the shared runtime, started separately from the panel — which is the
 * point: the panel only admits work.
 *
 * Covered: a bare URL defaults to a summary; focus narrows it; teardown is the second
 * mode; a follow-up carries the conversation and its parent; switching video A to B
 * never mixes context; dropping the poll (closing the card) does not cancel the work and
 * the id still shows progress when it is re-opened; the legacy modes and `sourceId`
 * still dispatch and stay readable.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OmniWatchError } from "../../packages/omniwatch/src/contracts/errors.ts";
import { enqueueAnalysis } from "../../packages/omniwatch/src/runtime/queue.ts";
import { runWorker } from "../../packages/omniwatch/src/runtime/worker.ts";
import { createJobsHandler, readDurableJob } from "../../agent-os-module/src/app/api/omniwatch/jobs/handler.ts";
import { cachedIds, cleanupTempDirs, createHarness, mediaLookup } from "./omniwatch-harness.mjs";

after(cleanupTempDirs);

const URL_A = "https://youtu.be/AAAAAAAAAAA";
const URL_B = "https://youtu.be/BBBBBBBBBBB";

const MEDIA = {
  AAAAAAAAAAA: { id: "AAAAAAAAAAA", title: "A", channel: "Chan A", duration: "4:00", seconds: 240, strip: [7, 22, 37] },
  BBBBBBBBBBB: { id: "BBBBBBBBBBB", title: "B", channel: "Chan B", duration: "2:00", seconds: 120, strip: [3, 9] },
};

function panel(h, overrides = {}) {
  const enqueued = [];
  const ensured = [];
  const dispatched = [];
  const deps = {
    store: h.store,
    memory: h.memory,
    resolveSource: async ({ url, sourceId }) => {
      if (sourceId) {
        return { platform: "youtube", sourceId, canonicalUrl: `https://youtu.be/${sourceId}`, legacyId: sourceId };
      }
      return h.source.resolve({ url });
    },
    isCached: cachedIds(["video-A", "video-B", "AAAAAAAAAAA", "BBBBBBBBBBB"]),
    enqueue: (request) => {
      enqueued.push(request);
      return enqueueAnalysis({ store: h.store, request });
    },
    ensureWorker: async (id) => {
      ensured.push(id);
    },
    lookupMedia: mediaLookup(MEDIA),
    legacyFilm: {
      dispatch: async (request) => {
        dispatched.push(request);
        return { answer: `film:${request.mode}`, stats: { parts: 1, in: 1, out: 1 } };
      },
    },
    defaultLanguage: "en",
    languages: ["en", "pl"],
    ...overrides,
  };
  return { handler: createJobsHandler(deps), deps, enqueued, ensured, dispatched };
}

function post(handler, body) {
  return handler.POST(new Request("http://localhost/api/omniwatch/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function get(handler, id) {
  return handler.GET(new Request(`http://localhost/api/omniwatch/jobs?id=${encodeURIComponent(id)}`));
}

/** The on-demand worker, started the way the panel's spawner would start it. */
async function drain(h, operationIds) {
  return runWorker({ deps: h.deps, operationIds, ownerToken: `test_${Math.random().toString(16).slice(2)}` });
}

test("T09: a bare URL starts a summary, answers 202 with a durable id, and is readable by id", async () => {
  const h = createHarness();
  const { handler, enqueued, ensured } = panel(h);

  const started = await post(handler, { url: URL_A });
  assert.equal(started.status, 202);
  const { id } = await started.json();
  assert.match(id, /^op_/, "the id is the durable operation id, not an in-RAM one");
  assert.deepEqual(ensured, [id], "admission makes sure a consumer exists (D5)");
  assert.equal(enqueued.length, 1, "the panel never analyses inline");
  assert.equal(enqueued[0].mode, "summary", "a bare link is a summary by default (A0)");
  assert.equal(enqueued[0].focus, null);
  assert.equal(enqueued[0].question, null);

  // The panel is gone; the worker runs the admitted work.
  const result = await drain(h, [id]);
  assert.equal(result.delivered, 1);
  assert.equal(h.model.calls.length, 1);

  const poll = await get(handler, id);
  assert.equal(poll.status, 200);
  const view = await poll.json();
  assert.equal(view.state, "done");
  assert.match(view.text, /punkt pierwszy/);
  assert.equal(view.analysisId.startsWith("omni_"), true);
  assert.equal(view.meta.id, "AAAAAAAAAAA");
  assert.equal(view.meta.seconds, 240);
  assert.equal(typeof view.turnId, "string");
  assert.equal(typeof view.conversationId, "string");
});

test("T09: focus narrows the summary and reaches the prompt as its own field", async () => {
  const h = createHarness();
  const { handler, enqueued } = panel(h);

  const started = await post(handler, { url: URL_A, focus: "redukcja tkanki tluszczowej" });
  const { id } = await started.json();
  assert.equal(enqueued[0].focus, "redukcja tkanki tluszczowej");
  assert.equal(enqueued[0].question, null, "a focus is not a question");
  assert.equal(enqueued[0].mode, "summary");

  await drain(h, [id]);
  assert.match(h.model.calls[0].text, /redukcja tkanki tluszczowej/, "the focus is in the prompt");
});

test("T09: teardown is a separate mode, not the default", async () => {
  const h = createHarness();
  const { handler, enqueued } = panel(h);
  const started = await post(handler, { url: URL_A, mode: "teardown", q: "co przetrwa w moim filmie" });
  const { id } = await started.json();
  assert.equal(enqueued[0].mode, "teardown");
  assert.equal(enqueued[0].question, "co przetrwa w moim filmie");
  assert.equal(enqueued[0].focus, null);
  await drain(h, [id]);
  assert.equal((await get(handler, id)).status, 200);
});

test("T10: a follow-up carries the conversation and its parent, and the model sees the earlier answer", async () => {
  const h = createHarness();
  const { handler, enqueued } = panel(h);

  const first = await (await post(handler, { url: URL_A })).json();
  await drain(h, [first.id]);
  const firstView = await (await get(handler, first.id)).json();

  const follow = await post(handler, {
    url: URL_A,
    q: "rozwij drugi punkt",
    conversationId: firstView.conversationId,
    parent: firstView.turnId,
  });
  assert.equal(follow.status, 202);
  const { id } = await follow.json();

  assert.equal(enqueued[1].mode, "summary");
  assert.equal(enqueued[1].question, "rozwij drugi punkt");
  assert.equal(enqueued[1].parentTurnId, firstView.turnId);
  assert.equal(enqueued[1].conversationId, firstView.conversationId);

  await drain(h, [id]);
  const followCall = h.model.calls[1];
  assert.match(followCall.text, /EARLIER ANSWER/, "the referenced answer is passed to the model");
  assert.match(followCall.text, /punkt pierwszy/, "and it is the real earlier text");
  assert.equal(followCall.operationId, id);
});

test("T10: switching video A to B never mixes conversation context", async () => {
  const h = createHarness();
  const { handler, enqueued } = panel(h);

  const a = await (await post(handler, { url: URL_A })).json();
  await drain(h, [a.id]);
  const aView = await (await get(handler, a.id)).json();

  const b = await (await post(handler, { url: URL_B })).json();
  assert.equal(enqueued[1].conversationId, null, "B starts its own conversation, not A's");
  await drain(h, [b.id]);
  const bView = await (await get(handler, b.id)).json();

  assert.notEqual(bView.conversationId, aView.conversationId);
  assert.doesNotMatch(h.model.calls[1].text, /punkt pierwszy/, "A's answer is not in B's prompt");

  // A question about A still lands on A's conversation.
  const followA = await (await post(handler, { url: URL_A, q: "a co z trzecim punktem", parent: aView.turnId })).json();
  assert.equal(enqueued[2].conversationId, aView.conversationId);
  assert.equal(enqueued[2].parentTurnId, aView.turnId);
  await drain(h, [followA.id]);
  assert.match(h.model.calls[2].text, /punkt pierwszy/);
});

test("T10: dropping the poll does not cancel the work; re-opening by id shows it finished", async () => {
  const h = createHarness();
  const { handler } = panel(h);

  const started = await (await post(handler, { url: URL_A })).json();
  // No GET at all: the card is closed. The work is admitted, so it must survive.
  const reopened = await readDurableJob(panel(h).deps, started.id);
  assert.equal(reopened.state, "running");
  assert.equal(reopened.progress.stage, "download");

  await drain(h, [started.id]);

  const after = await (await get(handler, started.id)).json();
  assert.equal(after.state, "done");
  assert.match(after.text, /punkt pierwszy/);
  assert.equal(after.operationId, started.id);
});

/**
 * T09 gap closed: QA (E-tests, section 3/4, item 2) found no test for an HTTP
 * 500/connection-loss from the model dependency reaching this API contract, and
 * no test that the done result carries the timestamp references a UI needs to
 * jump into the video.
 *
 * `provider.test.mjs` already proves 500/503 classify as `outcome_unknown` and a
 * reset-after-send is `outcome_unknown` too (never retried) at the transport
 * layer; this closes the gap one layer up, at the same `/api/omniwatch/jobs`
 * contract T09 already covers: a model that fails the way a dependency's 500 or a
 * dropped connection would must leave the job in a *readable terminal* state
 * (not a forever "running" spinner), must not have been retried, and must not
 * silently look like success.
 */
test("T09: an HTTP-500/connection-loss style provider failure ends the job readably, without a blind retry", async () => {
  const h = createHarness();
  let calls = 0;
  h.model.call = async () => {
    calls += 1;
    // Mirrors what the OpenAI transport (provider-openai.ts) raises for a 500/503
    // response or a connection reset after the request was sent: `outcome_unknown`,
    // because the call may have been billed even though no answer came back.
    throw new OmniWatchError(
      "outcome_unknown",
      "polaczenie z dostawca modelu przerwane (HTTP 500 / utrata polaczenia); wynik nieznany",
    );
  };
  const { handler, enqueued } = panel(h);

  const started = await post(handler, { url: URL_A });
  const { id } = await started.json();
  await drain(h, [id]);

  assert.equal(calls, 1, "exactly one attempt reaches the provider, no blind paid retry");

  const poll = await get(handler, id);
  assert.equal(poll.status, 200, "the job stays readable by id, never 'gone'");
  const view = await poll.json();
  assert.equal(view.state, "error", "a broken dependency ends the job, it does not spin forever as 'running'");
  assert.equal(view.errorClass, "outcome_unknown");
  assert.equal(typeof view.error, "string");
  assert.ok(view.error.length > 0, "a readable end error is shown, not a blank failure");

  // Re-polling must not silently retry: still one call, still the same terminal state.
  const secondPoll = await get(handler, id);
  const secondView = await secondPoll.json();
  assert.equal(secondView.state, "error");
  assert.equal(calls, 1, "polling after the failure must never trigger a second paid call");
  assert.equal(enqueued.length, 1, "the failure did not create a duplicate operation either");
});

test("T09: a finished summary carries timestamp references the UI can jump to", async () => {
  const h = createHarness();
  const { handler } = panel(h);

  const started = await post(handler, { url: URL_A });
  const { id } = await started.json();
  await drain(h, [id]);

  const poll = await get(handler, id);
  const view = await poll.json();
  assert.equal(view.state, "done");
  // The model's answer carries inline `[m:ss]` markers into the video (T09's "jump
  // to timestamp" contract); the recording stub's reply always includes these.
  assert.match(view.text, /\[0:\d{2}\]/, "the answer text carries at least one timestamp marker");
  // The card also gets a frame strip in seconds, independent of the answer text, so
  // the player has concrete positions even before the text is parsed.
  assert.ok(Array.isArray(view.meta.strip), "the poll exposes a frame strip in seconds");
  assert.ok(view.meta.strip.length > 0, "the frame strip is not empty for a known-duration video");
  assert.ok(
    view.meta.strip.every((seconds) => Number.isFinite(seconds) && seconds >= 0 && seconds <= view.meta.seconds),
    "every strip position is a real second offset inside the video's duration",
  );
});

test("T10: an unknown id is reported as gone instead of spinning forever", async () => {
  const h = createHarness();
  const { handler } = panel(h);
  const response = await get(handler, "op_does_not_exist");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { state: "gone" });
});

test("legacy: both/blueprint/screentext still dispatch through the film adapter and stay readable", async () => {
  const h = createHarness();
  const { handler, dispatched, enqueued } = panel(h);

  for (const mode of ["both", "blueprint", "screentext"]) {
    const response = await post(handler, { url: URL_A, mode, q: "topic" });
    assert.equal(response.status, 202, `${mode} is accepted`);
    const { id } = await response.json();
    const poll = await get(handler, id);
    assert.equal(poll.status, 200, `${mode} status is readable`);
    const view = await poll.json();
    assert.equal(view.state, "done");
    assert.equal(view.text, `film:${mode}`);
  }
  assert.equal(dispatched.length, 3);
  assert.deepEqual(dispatched.map((d) => d.mode), ["both", "blueprint", "screentext"]);
  assert.equal(enqueued.length, 0, "film modes never enter the analysis queue");
});

test("legacy: sourceId resolves from the cache and is rejected when it is not there", async () => {
  const h = createHarness();
  const { handler, enqueued, dispatched } = panel(h);

  const ok = await post(handler, { sourceId: "video-A", mode: "teardown", q: "hook" });
  assert.equal(ok.status, 202);
  const { id } = await ok.json();
  assert.equal(enqueued[0].sourceRef.sourceId, "video-A");
  assert.equal(enqueued[0].mode, "teardown");
  await drain(h, [id]);

  const film = await post(handler, { sourceId: "video-A", mode: "blueprint" });
  assert.equal(film.status, 202);
  await film.json();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sourceId, "video-A");

  const missing = await post(handler, { sourceId: "not-cached", mode: "summary" });
  assert.equal(missing.status, 404);
});

test("legacy: an unknown mode is rejected before any work is admitted", async () => {
  const h = createHarness();
  const { handler, enqueued, dispatched } = panel(h);
  const response = await post(handler, { url: URL_A, mode: "nonsense" });
  assert.equal(response.status, 400);
  assert.equal(enqueued.length, 0);
  assert.equal(dispatched.length, 0);
});

test("a missing url and sourceId is a 400, not a silent summary", async () => {
  const h = createHarness();
  const { handler, enqueued } = panel(h);
  const response = await post(handler, { mode: "summary" });
  assert.equal(response.status, 400);
  assert.equal(enqueued.length, 0);
});

// The UI half of T09/T10. No browser is available in this checkout, so these are
// source-level checks of the wiring the component actually renders (the same technique
// `agent-os-module/test/card-source.test.mjs` uses for the A to B card bug).
test("T09/T10 UI: the tab starts at summary, has a focus field, and keeps follow-ups per video", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const view = readFileSync(join(here, "..", "..", "agent-os-module", "src", "components", "OmniWatchView.tsx"), "utf8");

  assert.match(view, /useState<UiMode>\("ask"\)/, "the default mode is the summary path, not teardown");
  assert.match(view, /const \[focus, setFocus\] = useState\(""\)/, "a focus field exists");
  assert.match(view, /ui\?\.focusPlaceholder \|\| "Focus \(optional\)/, "the focus field is labelled honestly");
  assert.match(view, /setMode\("teardown"\)/, "teardown is still an explicit switch");

  // The follow-up carries the conversation and the parent turn of the card it replies to.
  assert.match(view, /askContextRef/, "the follow-up context is per card, held in a ref");
  assert.match(view, /conversationId: context\?\.conversationId \?\? undefined/);
  assert.match(view, /parent: context\?\.turnId \?\? undefined/);
  assert.match(view, /const link = \(target \?\? context\?\.url \?\? url\)\.trim\(\)/, "a follow-up targets its own card's video");
  assert.match(view, /question: q\.trim\(\) \|\| undefined/, "a question is sent as a question, not guessed from text");
});
