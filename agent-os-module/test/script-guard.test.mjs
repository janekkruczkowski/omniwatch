// The auto/script guard, tested against the real route file with the provider stubbed.
//
//   node --test agent-os-module/test/script-guard.test.mjs
//
// What this pins down: a request that carries an OmniWatch brief (angle or sceneHints —
// by presence, so an empty angle or an all-b-roll hint list counts) is refused before any
// provider is called, a body that is not an object is a 400, and a scene count above the
// ceiling is a 413 rather than a silent trim. A request with neither field still reaches
// the author exactly as it did before.
//
// AGENT_OS_SOURCE (default ~/Documents/agent-os/source) supplies the TypeScript compiler
// and is where the route is read from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const ROUTE = path.join(AGENT_OS, "src", "app", "api", "video", "auto", "script", "route.ts");
const req = createRequire(path.join(AGENT_OS, "package.json"));

const calls = [];

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
  // The provider seam. Every call is recorded, so "before any provider" is checkable.
  writeFileSync(path.join(dir, "lib", "runner.js"),
    "module.exports = { run: async (...a) => { globalThis.__providerCalls.push(a); return { stdout: \"\", stderr: \"\" }; } };");
  globalThis.__providerCalls = calls;
  return req(path.join(dir, "route.js"));
}

const route = loadRoute();

const post = async (raw) => {
  calls.length = 0;
  const res = await route.POST(new Request("http://x/api/video/auto/script", {
    method: "POST", headers: { "content-type": "application/json" },
    body: typeof raw === "string" ? raw : JSON.stringify(raw),
  }));
  return { status: res.status, body: await res.json(), providerCalls: calls.length };
};

test("a brief with an angle is refused before any provider", async () => {
  const r = await post({ topic: "cold email teardown", angle: "the myth everyone repeats" });
  assert.equal(r.status, 503);
  assert.equal(r.body.pending, "omniwatch-script-author");
  assert.equal(r.providerCalls, 0, "a provider was called");
});

test("presence is what counts: an empty angle or an all-b-roll hint list is still a brief", async () => {
  for (const body of [{ topic: "t", angle: "" }, { topic: "t", sceneHints: [] }, { topic: "t", sceneHints: [{ role: "hook", visual: { kind: "broll" } }] }]) {
    const r = await post(body);
    assert.equal(r.status, 503, JSON.stringify(body));
    assert.equal(r.providerCalls, 0);
  }
});

test("a body that is not an object is a 400, not a crash", async () => {
  for (const raw of ["null", "5", "[]", "{}"]) {
    const r = await post(raw);
    assert.equal(r.status, 400, `body ${raw} → ${r.status}`);
    assert.equal(r.providerCalls, 0);
  }
});

test("a scene count above the ceiling is a 413, not a trim", async () => {
  const r = await post({ topic: "t", sceneCount: 61 });
  assert.equal(r.status, 413);
  assert.equal(r.providerCalls, 0);
});

test("a request with neither field keeps the legacy path", async () => {
  const r = await post({ topic: "a plain topic" });
  assert.equal(r.status, 502, "legacy request did not reach the author");
  assert.ok(r.providerCalls > 0, "the author was never called");
});
