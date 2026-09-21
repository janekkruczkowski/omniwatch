// Wan b-roll through kie.ai — the third engine, added because the Director's two are an
// OAuth sign-in this machine does not have.
//
//   node --test agent-os-module/test/broll.test.mjs
//
// Offline: globalThis.fetch is replaced, so no key is needed and nothing leaves the
// machine. SOURCE (env or --source) picks the src root, as in the graphics/assets suites.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const argSource = process.argv.find((a) => a.startsWith("--source="))?.slice("--source=".length);
const SOURCE = process.env.SOURCE || argSource
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchBroll.ts")))
  || path.join(HERE, "..", "src");
const LIB = path.join(SOURCE, "lib", "omniwatchBroll.ts");
const req = createRequire(path.join(AGENT_OS, "package.json"));

function loadLib() {
  const ts = req("typescript");
  const out = ts.transpileModule(readFileSync(LIB, "utf8"), {
    fileName: LIB,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText.replace(/require\("@\/lib\/omniwatchAssets"\)/g, 'require("./assets")');
  const dir = mkdtempSync(path.join(tmpdir(), "omni-broll-"));
  mkdirSync(path.join(dir, "root"), { recursive: true });
  writeFileSync(path.join(dir, "omniwatchBroll.js"), out);
  // The asset store is a seam here: the point under test is what reaches it, not the disk.
  writeFileSync(path.join(dir, "assets.js"), `
    const saved = [];
    module.exports = {
      MAX_ASSET_BYTES: 200 * 1024 * 1024,
      sniffMedia: (b) => (b.length >= 12 && String.fromCharCode(...b.subarray(4, 8)) === "ftyp" ? "video/mp4" : null),
      newAssetName: (m) => (m === "video/mp4" ? "abcdef0123456789abcdef0123456789.mp4" : null),
      saveAssetBytes: async (bytes, name) => { saved.push({ name, bytes: bytes.byteLength }); return { name, bytes: bytes.byteLength }; },
      __saved: saved,
    };`);
  return req(path.join(dir, "omniwatchBroll.js"));
}

const lib = loadLib();
const realFetch = globalThis.fetch;
let calls;
beforeEach(() => { calls = []; process.env.KIE_API_KEY = "test-key-0123456789"; });
after(() => { globalThis.fetch = realFetch; delete process.env.KIE_API_KEY; });

const mp4 = () => { const b = new Uint8Array(64); b.set([0x00,0x00,0x00,0x18], 0); b.set([0x66,0x74,0x79,0x70], 4); return b; };

function stub(handler) {
  globalThis.fetch = async (url, init) => { const c = { url: String(url), init }; calls.push(c); return handler(c); };
}
const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

test("a finished clip is stored locally, and the caller gets our own URL", async () => {
  stub((c) => {
    if (c.url.endsWith("/jobs/createTask")) return json({ code: 200, data: { taskId: "t1" } });
    if (c.url.includes("/jobs/recordInfo")) return json({ code: 200, data: { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://cdn.kie.ai/a.mp4"] }) } });
    if (c.url === "https://cdn.kie.ai/a.mp4") return { ok: true, status: 200, arrayBuffer: async () => mp4().buffer };
    throw new Error(`unexpected fetch: ${c.url}`);
  });
  const r = await lib.wanClip("a desk at night", "9:16", "720p");
  assert.equal(r.ok, true, r.error);
  assert.match(r.url, /^\/api\/omniwatch\/assets\?file=/, "the clip must be served from our own store, not the provider's CDN");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, lib.WAN_MODEL);
  assert.equal(body.input.aspect_ratio, "9:16", "the requested frame must reach the model");
  assert.ok(calls[0].init.headers.Authorization.startsWith("Bearer "), "the key rides as a bearer header");
  assert.doesNotMatch(calls[0].url, /test-key/, "the key must never appear in a URL");
});

test("a failed task is reported, not retried forever", async () => {
  stub((c) => {
    if (c.url.endsWith("/jobs/createTask")) return json({ code: 200, data: { taskId: "t2" } });
    if (c.url.includes("/jobs/recordInfo")) return json({ code: 200, data: { state: "fail", failMsg: "content policy" } });
    throw new Error("should not download");
  });
  const r = await lib.wanClip("x");
  assert.equal(r.ok, false);
  assert.match(r.error, /content policy/);
  assert.equal(r.status, 502);
});

test("a download that is not a video is refused, whatever the provider called it", async () => {
  stub((c) => {
    if (c.url.endsWith("/jobs/createTask")) return json({ code: 200, data: { taskId: "t3" } });
    if (c.url.includes("/jobs/recordInfo")) return json({ code: 200, data: { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://cdn.kie.ai/a.mp4"] }) } });
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  });
  const r = await lib.wanClip("x");
  assert.equal(r.ok, false);
  assert.match(r.error, /not a video/);
});

test("the result URL must be a public https address", () => {
  for (const good of ["https://cdn.kie.ai/a.mp4", "https://files.example.com/x.mp4"]) {
    assert.equal(lib.resultUrlAllowed(good), true, good);
  }
  for (const bad of [
    "http://cdn.kie.ai/a.mp4", "https://localhost/a.mp4", "https://127.0.0.1/a.mp4",
    "https://10.0.0.5/a.mp4", "https://192.168.1.9/a.mp4", "https://169.254.169.254/latest/meta-data",
    "file:///etc/passwd", "not a url",
  ]) {
    assert.equal(lib.resultUrlAllowed(bad), false, bad);
  }
});

test("no key is a 503 that names the file to put it in, and sends nothing", async () => {
  delete process.env.KIE_API_KEY;
  process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "no-hermes-"));
  stub(() => { throw new Error("must not be called"); });
  const r = await lib.wanClip("x");
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.match(r.error, /KIE_API_KEY/);
  assert.equal(calls.length, 0, "nothing may be sent before a key exists");
  delete process.env.HERMES_HOME;
});
