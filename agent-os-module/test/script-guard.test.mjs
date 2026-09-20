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
