// Writing a new episode into a watched video's format.
//
//   node --test agent-os-module/test/episode.test.mjs
//
// Offline: globalThis.fetch is replaced and HOME is redirected at a temp dir, so no
// router, no capability and no network. What is under test is the CONTRACT — that the
// format survives untouched, that a short or broken answer is reported rather than
// papered over, and that the credential never leaves the pinned loopback endpoint.

import { test, beforeEach } from "node:test";
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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchEpisode.ts")))
  || path.join(HERE, "..", "src");
const LIB = path.join(SOURCE, "lib", "omniwatchEpisode.ts");
const req = createRequire(path.join(AGENT_OS, "package.json"));

const REAL_HOME = process.env.HOME;

/** A home with a router capability in it, or one without, chosen per test. */
function fakeHome(withSecret) {
  const dir = mkdtempSync(path.join(tmpdir(), "omni-ep-home-"));
  if (withSecret) {
    mkdirSync(path.join(dir, ".codex", "codex-router"), { recursive: true });
    writeFileSync(path.join(dir, ".codex", "codex-router", "caller-secret"), "test-capability\n");
  }
  process.env.HOME = dir;
  return dir;
}

function loadLib() {
  const ts = req("typescript");
  const out = ts.transpileModule(readFileSync(LIB, "utf8"), {
    fileName: LIB,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), "omni-ep-"));
  const f = path.join(dir, `omniwatchEpisode-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(f, out);
  return req(f);
}

/** A two-region blueprint: one fixed headline, one episode caption of two items.
 *  Deliberately not a tier list — the code must not know what it is looking at. */
const BP = Object.freeze({
  version: "omniwatch.blueprint/1",
  canvas: { width: 720, height: 1280, fps: 30, seconds: 6 },
  regions: [
    { id: "headline", role: "text", rect: [0, 0, 1, 0.1], z: 1 },
    { id: "stage", role: "figure", rect: [0, 0.1, 1, 0.6], z: 2 },
  ],
  tracks: [
    { region: "headline", kind: "text", varies: "fixed", items: [{ start: 0, end: 6, value: "OLD HEADLINE" }] },
    { region: "stage", kind: "video", varies: "episode", items: [
      { start: 0, end: 3, value: "old subject one" },
      { start: 3, end: 6, value: "old subject two" },
    ] },
  ],
});

let calls = [];
function answerWith(text, { status = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      body: null,
      text: async () => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }),
    };
  };
}

beforeEach(() => { calls = []; process.env.HOME = REAL_HOME; });

test("every item is one slot, in track order", () => {
  fakeHome(true);
  const { slotsOf } = loadLib();
  const s = slotsOf(BP);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.region), ["headline", "stage", "stage"]);
  // The role travels with the slot, so an author can tell a caption from a presenter.
  assert.equal(s[1].role, "figure");
  assert.equal(s[2].start, 3);
});

test("new values go in, geometry and timing stay exactly as they were", async () => {
  fakeHome(true);
  answerWith('{"title":"Overrated languages","values":["NEW HEADLINE","a presenter at a desk","the same presenter, closer"]}');
  const { writeEpisode } = loadLib();
  const r = await writeEpisode(BP, "overrated programming languages", "a bearded man in a hoodie");
  assert.equal(r.ok, true);
  assert.equal(r.changed, 3);
  assert.equal(r.title, "Overrated languages");
  assert.deepEqual(r.blueprint.regions, BP.regions);
  assert.deepEqual(r.blueprint.canvas, BP.canvas);
  assert.deepEqual(r.blueprint.tracks.map((t) => t.items.map((i) => [i.start, i.end])),
    BP.tracks.map((t) => t.items.map((i) => [i.start, i.end])));
  assert.equal(r.blueprint.tracks[0].items[0].value, "NEW HEADLINE");
  assert.equal(r.blueprint.tracks[1].items[1].value, "the same presenter, closer");
});

test("a short answer keeps what it did not replace and says how many it changed", async () => {
  fakeHome(true);
  answerWith('{"values":["NEW HEADLINE"]}');
  const { writeEpisode } = loadLib();
  const r = await writeEpisode(BP, "topic", "host");
  assert.equal(r.ok, true);
  assert.equal(r.changed, 1);
  assert.equal(r.blueprint.tracks[1].items[0].value, "old subject one");
  // No title in the answer: the topic stands in rather than an empty string.
  assert.equal(r.title, "topic");
});

test("prose around the JSON is fine; prose instead of it is not", async () => {
  fakeHome(true);
  answerWith('Sure! Here you go:\n```json\n{"values":["A","B","C"]}\n```\nHope that helps.');
  const { writeEpisode } = loadLib();
  const ok = await writeEpisode(BP, "t", "h");
  assert.equal(ok.ok, true);
  assert.equal(ok.blueprint.tracks[0].items[0].value, "A");

  answerWith("I could not do that.");
  const bad = await writeEpisode(BP, "t", "h");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no JSON object/);
});

test("without the router capability nothing is sent anywhere", async () => {
  fakeHome(false);
  answerWith('{"values":["A","B","C"]}');
  const { writeEpisode } = loadLib();
  const r = await writeEpisode(BP, "t", "h");
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0);
});

test("the credential only ever goes to the pinned loopback endpoint, with no tools", async () => {
  fakeHome(true);
  answerWith('{"values":["A","B","C"]}');
  const { writeEpisode } = loadLib();
  await writeEpisode(BP, "t", "h");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:4202/v1/responses");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-capability");
  assert.equal(calls[0].init.redirect, "error");
  const body = JSON.parse(calls[0].init.body);
  assert.equal("tools" in body, false);
  assert.equal(body.stream, false);
});

test("the brief carries each slot's seconds and what was there, and the new subject", async () => {
  fakeHome(true);
  answerWith('{"values":["A","B","C"]}');
  const { writeEpisode } = loadLib();
  await writeEpisode(BP, "overrated programming languages", "a bearded man in a hoodie");
  const text = JSON.parse(calls[0].init.body).input[0].content[0].text;
  assert.match(text, /overrated programming languages/);
  assert.match(text, /a bearded man in a hoodie/);
  assert.match(text, /region=stage role=figure kind=video/);
  assert.match(text, /old subject two/);
  // The frame is stated, because what fits on screen depends on it.
  assert.match(text, /720x1280/);
});

test("an answer too large to be an episode is refused, not buffered", async () => {
  fakeHome(true);
  const { writeEpisode, MAX_SLOTS } = loadLib();
  const many = {
    ...BP,
    tracks: [{ region: "headline", kind: "text", varies: "episode",
      items: Array.from({ length: MAX_SLOTS + 1 }, (_, i) => ({ start: i, end: i + 1, value: "x" })) }],
  };
  answerWith('{"values":[]}');
  const r = await writeEpisode(many, "t", "h");
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(calls.length, 0);
});
