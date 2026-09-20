// The auto/script guard, tested against the real route file with the provider and fetch
// seams stubbed.
//
//   node --test agent-os-module/test/script-guard.test.mjs
//
// The brief author is live now (sentinel: omni-author-flash-v3): a request carrying an
// OmniWatch brief (angle or sceneHints — by presence, so an empty angle or an all-b-roll
// hint list counts) is AUTHORED by Flash through the pinned loopback codex-router, never
// refused. A body that is not an object is still a 400, and a scene count above the
// ceiling is still a 413. A request with neither field still reaches the legacy author
// (Grok via the runner stub) unchanged.
//
// Nothing here reaches the network: `globalThis.fetch` — the seam both the Flash author and
// the local-Ollama last resort call directly, with no module to stub — is replaced before
// every test, and every call is recorded so a test can assert on what WOULD have been sent.
// Any call to an unstubbed URL throws inside the stub rather than opening a socket, so the
// whole suite runs offline and finishes in well under a second per case (the un-seamed
// version spent ~27s per brief case hitting a real local model router).
//
// AGENT_OS_SOURCE (default ~/Documents/agent-os/source) supplies the TypeScript compiler
// and is where the route is read from.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const ROUTE = path.join(AGENT_OS, "src", "app", "api", "video", "auto", "script", "route.ts");
const req = createRequire(path.join(AGENT_OS, "package.json"));

const calls = [];
const FLASH_URL = "http://127.0.0.1:4202/v1/responses";

function loadRoute() {
  const ts = req("typescript");
  const out = ts.transpileModule(readFileSync(ROUTE, "utf8"), {
    fileName: ROUTE,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
    .replace(/require\("next\/server"\)/g, 'require("./next-server")')
    .replace(/require\("@\/lib\/config"\)/g, 'require("./lib/config")')
    .replace(/require\("@\/lib\/runner"\)/g, 'require("./lib/runner")');

  const dir = mkdtempSync(path.join(tmpdir(), "omni-script-"));
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  writeFileSync(path.join(dir, "route.js"), out);
  writeFileSync(path.join(dir, "next-server.js"),
    "module.exports = { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body, json: async () => body }) } };");
  writeFileSync(path.join(dir, "lib", "config.js"),
    'module.exports = { CLAUDE_MODEL: "claude", config: { claude: false }, hermesHome: () => "/tmp/hermes" };');
  // The legacy provider seam (Grok, via Hermes). Every call is recorded, so "never reached
  // the legacy author" is checkable for a brief-driven request.
  writeFileSync(path.join(dir, "lib", "runner.js"),
    "module.exports = { run: async (...a) => { globalThis.__providerCalls.push(a); return { stdout: \"\", stderr: \"\" }; } };");
  globalThis.__providerCalls = calls;
  return req(path.join(dir, "route.js"));
}

const route = loadRoute();

// ── the fetch seam ──────────────────────────────────────────────────────────────────────
// The Flash author, and the local-Ollama last resort, both call a bare global `fetch`
// directly — there is no module boundary to stub, so `globalThis.fetch` itself is the seam.
// Every call is recorded before the handler answers it, so a test can assert on exactly
// what would have gone out (url, method, headers, body) without a byte reaching a socket.
// A call to anything the handler does not recognise throws instead of falling through to a
// real network request — the route's own try/catch around each provider call turns that
// into a clean failure rather than a crash.
const realFetch = globalThis.fetch;
let fetchCalls;

function stubFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    fetchCalls.push(call);
    return handler(call);
  };
}

// A well-formed Flash /v1/responses reply: one "message" item whose output_text is the
// script JSON the route's extractJson() expects. `body` is left unset so the route takes
// its res.text() fallback path rather than trying to stream a reader that isn't there.
function flashReply(script) {
  const text = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(script) }] }] });
  return { ok: true, status: 200, body: undefined, text: async () => text, json: async () => JSON.parse(text) };
}

const okScript = {
  title: "t", hook: "h", narration: "one two three.", description: "d", cta: "c",
  research_notes: [], scenes: [{ caption: "c1", narration_line: "one two three.", broll_prompt: "b" }],
};

// Default per-test stub: the pinned Flash endpoint answers with a usable script; anything
// else (e.g. the Ollama last resort on the legacy path) throws, which the route's own
// try/catch swallows into a normal failure — so a stray call is provable, never a real hit.
beforeEach(() => {
  stubFetch((call) => {
    if (call.url === FLASH_URL) return flashReply(okScript);
    throw new Error(`unexpected outbound fetch: ${call.url}`);
  });
});

after(() => { globalThis.fetch = realFetch; });

const post = async (raw) => {
  calls.length = 0;
  const res = await route.POST(new Request("http://x/api/video/auto/script", {
    method: "POST", headers: { "content-type": "application/json" },
    body: typeof raw === "string" ? raw : JSON.stringify(raw),
  }));
  return { status: res.status, body: await res.json(), providerCalls: calls.length };
};

test("a brief with an angle is authored by Flash — pinned endpoint, no tools, credential as a header only", async () => {
  const r = await post({ topic: "cold email teardown", angle: "the myth everyone repeats" });

  assert.equal(fetchCalls.length, 1, "the Flash author must be called exactly once");
  const [sent] = fetchCalls;
  assert.equal(sent.url, FLASH_URL, "must hit the pinned loopback Responses endpoint");
  assert.equal(sent.init.method, "POST");
  const sentBody = JSON.parse(sent.init.body);
  assert.equal("tools" in sentBody, false, "no tool surface may be handed to the model");
  assert.match(JSON.stringify(sentBody), /the myth everyone repeats/, "the brief's angle must reach the author");

  // Security property: the router capability rides as a bearer header, attached only to
  // the already-pinned loopback request, and is never present in the URL itself.
  assert.ok(sent.init.headers.authorization?.startsWith("Bearer "), "the router capability must be sent as a bearer header");
  assert.equal(sent.init.headers.authorization.length > "Bearer ".length, true, "a real capability must be attached");
  assert.doesNotMatch(sent.url, /Bearer|authorization|secret/i, "the credential must never appear in the URL");

  assert.equal(r.providerCalls, 0, "a brief must never reach Grok/Claude — Flash is the only author for a brief");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.engine, "codex");
});

test("presence is what counts: an empty angle or an all-b-roll hint list still goes down the Flash path", async () => {
  for (const body of [{ topic: "t", angle: "" }, { topic: "t", sceneHints: [] }, { topic: "t", sceneHints: [{ role: "hook", visual: { kind: "broll" } }] }]) {
    fetchCalls.length = 0;
    const r = await post(body);
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(r.body.ok, true, JSON.stringify(body));
    assert.equal(fetchCalls.length, 1, JSON.stringify(body));
    assert.equal(fetchCalls[0].url, FLASH_URL, JSON.stringify(body));
    assert.equal(r.providerCalls, 0, JSON.stringify(body));
  }
});

test("a body that is not an object is a 400, not a crash", async () => {
  for (const raw of ["null", "5", "[]", "{}"]) {
    const r = await post(raw);
    assert.equal(r.status, 400, `body ${raw} → ${r.status}`);
    assert.equal(r.providerCalls, 0);
    assert.equal(fetchCalls.length, 0, `body ${raw} must never reach the author`);
  }
});

test("a scene count above the ceiling is a 413, not a trim", async () => {
  const r = await post({ topic: "t", sceneCount: 61 });
  assert.equal(r.status, 413);
  assert.equal(r.providerCalls, 0);
  assert.equal(fetchCalls.length, 0, "a rejected scene count must never reach the author");
});

test("a request with neither field keeps the legacy path, and never touches the Flash author", async () => {
  const r = await post({ topic: "a plain topic" });
  assert.equal(r.status, 502, "legacy request did not reach the author");
  assert.ok(r.providerCalls > 0, "the legacy author (Grok) was never called");
  assert.ok(!fetchCalls.some((c) => c.url === FLASH_URL), "a brief-less request must never reach the Flash author");
});

// ── purpose: the brief's mode must actually reach the author ────────────────────────────
// A control that is carried and ignored is the failure this route already refuses for the
// angle. These cases read what would have gone to the model and assert the instruction
// itself changes, not merely that the field survived the trip.

const sentText = () => JSON.parse(fetchCalls[0].init.body).input[0].content[0].text;

test("a review brief tells the author it is reviewing the source, and forbids inventing evidence", async () => {
  const r = await post({
    topic: "what this keynote actually claimed", angle: "the number nobody checks",
    purpose: "review",
    sceneHints: [{ role: "hook", visual: { kind: "broll", hint: "Speaker in medium close-up" }, seconds: 4, idea: 0 }],
  });
  assert.equal(r.status, 200);
  const text = sentText();
  assert.match(text, /REVIEW of that video/, "the author must be told this is a review");
  assert.match(text, /never invent a quotation, a statistic or a timestamp/, "review must forbid fabricated evidence");
  assert.match(text, /no excerpt of the reviewed video is cut into this film/,
    "review must not let the narration point at source clips we cannot cut yet");
  assert.doesNotMatch(text, /Do not reuse any sentence from the video that was watched/,
    "the pattern rule contradicts a review and must not be sent with it");
});

test("a pattern brief keeps the adaptation rules, and is what an absent purpose means", async () => {
  for (const body of [
    { topic: "t", angle: "a", purpose: "pattern", sceneHints: [{ role: "hook", seconds: 3, idea: 0 }] },
    { topic: "t", angle: "a", sceneHints: [{ role: "hook", seconds: 3, idea: 0 }] },            // absent
    { topic: "t", angle: "a", purpose: "nonsense", sceneHints: [{ role: "hook", seconds: 3, idea: 0 }] }, // unknown
  ]) {
    fetchCalls.length = 0;
    const r = await post(body);
    assert.equal(r.status, 200, JSON.stringify(body));
    const text = sentText();
    assert.match(text, /What transfers is the PATTERN/, JSON.stringify(body));
    assert.match(text, /Do not reuse any sentence from the video that was watched/, JSON.stringify(body));
    assert.doesNotMatch(text, /REVIEW of that video/, JSON.stringify(body));
  }
});

// ── card rules that a rendered frame caught ─────────────────────────────────────────────
// A real render showed "1  1. Plan at the finish line" (the card draws its own numerals
// and the model had numbered the labels too) and the card's title repeated verbatim in the
// lower-third caption under it. Which card kind the model picks is its own call, so these
// assert the INSTRUCTION reaches the model rather than hoping for a ranking card.

test("the author is told not to number ranking labels, and not to echo the card title", async () => {
  const r = await post({
    topic: "t", angle: "a",
    sceneHints: [{ role: "list", visual: { kind: "graphic", hint: "three items" }, seconds: 3, idea: 0 }],
  });
  // The stub answers with a script that has no card, so this brief's graphic slot is
  // correctly refused with 502 incomplete:"graphic-slots". The prompt went out before that,
  // which is what these assert — the rules, not the verdict.
  assert.equal(r.status, 502, "a declared card slot returned without a card must not pass");
  assert.equal(r.body.incomplete, "graphic-slots");
  const text = JSON.parse(fetchCalls[0].init.body).input[0].content[0].text;
  assert.match(text, /draws its own 1, 2, 3/, "the numbering rule must reach the model");
  assert.match(text, /never "1\. Plan at the finish line"/, "the rule must show the failure it prevents");
  assert.match(text, /must ADD to the card, not repeat it/, "the caption rule must reach the model");
});

test("a card slot too short to read is asked for as footage, not as a card", async () => {
  // Scene 1 is 1.08s — the length the first real render actually held a ranking card for.
  // Scene 2 is 3s and stays a card. Neither loses its composition reference.
  const r = await post({
    topic: "t", angle: "a",
    sceneHints: [
      { role: "flash", visual: { kind: "graphic", hint: "a word appears" }, seconds: 1.08, idea: 0 },
      { role: "list", visual: { kind: "graphic", hint: "three items" }, seconds: 3, idea: 1 },
    ],
  });
  const text = JSON.parse(fetchCalls[0].init.body).input[0].content[0].text;
  assert.match(text, /scene 1: 1\.08s, broll/, "a 1.08s slot must be asked for as footage");
  assert.match(text, /scene 2: 3\.00s, graphic/, "a 3s slot stays a card");
  assert.match(text, /REQUIRED: scene 2 is a CARD/, "only the readable slot may be demanded");
  assert.doesNotMatch(text, /REQUIRED: scenes 1, 2/, "the short slot must not be demanded as a card");
  assert.match(text, /a word appears/, "the short slot keeps its composition reference");
  assert.equal(r.status, 502, "the stub still returns no card for scene 2");
});

test("a card the model puts on an unreadable beat is dropped, not refused", async () => {
  // The prompt asks for this and a measured run showed the model ignoring it once in four,
  // so the route enforces it. The scene survives; only its card goes.
  const withCards = {
    ...okScript,
    scenes: [
      { caption: "c1", narration_line: "one", broll_prompt: "b1", graphic: { kind: "stat", value: "3x" } },
      { caption: "c2", narration_line: "two", broll_prompt: "b2", graphic: { kind: "stat", value: "9x" } },
    ],
  };
  stubFetch((call) => {
    if (call.url === FLASH_URL) return flashReply(withCards);
    throw new Error(`unexpected outbound fetch: ${call.url}`);
  });
  const r = await post({
    topic: "t", angle: "a",
    sceneHints: [
      { role: "flash", seconds: 1, idea: 0 },   // too short to read
      { role: "list", seconds: 3, idea: 1 },    // long enough
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.droppedCards, [1], "the 1s card must be reported as dropped");
  assert.equal(r.body.script.scenes[0].graphic, undefined, "the unreadable card must be gone");
  assert.equal(r.body.script.scenes[0].narration_line, "one", "the scene itself must survive");
  assert.equal(r.body.script.scenes[1].graphic?.value, "9x", "the readable card must be untouched");
});
