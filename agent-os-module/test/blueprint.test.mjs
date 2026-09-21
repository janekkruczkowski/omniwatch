// The blueprint validator, exercised on the shape of the reference this benchmark copies:
// a 720x1280 tier-list video — title bar, presenter, word-timed caption, a board with
// slots, and one repeating unit per ranked subject.
//
//   node --test agent-os-module/test/blueprint.test.mjs

import { test } from "node:test";
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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchBlueprint.ts")))
  || path.join(HERE, "..", "src");
const LIB = path.join(SOURCE, "lib", "omniwatchBlueprint.ts");
const req = createRequire(path.join(AGENT_OS, "package.json"));

const ts = req("typescript");
const out = ts.transpileModule(readFileSync(LIB, "utf8"), {
  fileName: LIB,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const dir = mkdtempSync(path.join(tmpdir(), "omni-bp-"));
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "bp.js"), out);
const lib = req(path.join(dir, "bp.js"));

/** The reference, reduced to two ranked subjects. */
const tierList = () => ({
  version: lib.BLUEPRINT_VERSION,
  canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
  regions: [
    { id: "stage", role: "stage", rect: [0, 0, 1, 1], z: 0 },
    { id: "title", role: "title_bar", rect: [0, 0, 1, 0.08], z: 3 },
    { id: "host", role: "presenter", rect: [0.1, 0.1, 0.8, 0.35], z: 2 },
    { id: "caption", role: "caption", rect: [0.05, 0.47, 0.9, 0.07], z: 4 },
    { id: "board", role: "board", rect: [0, 0.55, 1, 0.45], z: 1 },
    { id: "slot_d", role: "slot", rect: [0.15, 0.88, 0.25, 0.1], z: 2, parent: "board" },
  ],
  tracks: [
    { region: "stage", kind: "color", varies: "fixed", items: [{ start: 0, end: 20, value: "#000000" }] },
    { region: "title", kind: "text", varies: "episode", items: [{ start: 0, end: 20, value: "RANKING THE BEST FOOTBALLERS" }] },
    { region: "board", kind: "image", varies: "fixed", items: [{ start: 0, end: 20, value: "five rows labelled S A B C D, coloured red to green" }] },
    { region: "host", kind: "video", varies: "fixed", items: [{ start: 0, end: 20, value: "a presenter holding a microphone, fixed medium shot" }] },
    { region: "caption", kind: "text", varies: "episode", items: [
      { start: 0, end: 2, value: "Ronaldo is D tier.", beat: 1 },
      { start: 2, end: 4, value: "Bro has more hair gel than trophies.", beat: 1 },
      { start: 10, end: 12, value: "Messi? Man won a World Cup", beat: 2 },
    ] },
    { region: "slot_d", kind: "image", varies: "episode", items: [{ start: 2, end: 6, value: "a bottle of hair gel beside empty trophy shelves", beat: 1 }] },
  ],
});

test("the reference's own shape validates", () => {
  const r = lib.validateBlueprint(tierList());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.blueprint.regions.length, 6);
  assert.equal(r.blueprint.regions.find((x) => x.id === "slot_d").parent, "board");
  assert.equal(r.blueprint.tracks.find((t) => t.region === "caption").items[0].beat, 1);
});

test("items come back in time order however they were written", () => {
  const bp = tierList();
  bp.tracks[4].items.reverse();
  const r = lib.validateBlueprint(bp);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.blueprint.tracks.find((t) => t.region === "caption").items.map((i) => i.start), [0, 2, 10]);
});

test("a track that will not say whether it is format or episode is refused", () => {
  // Without this the format layer cannot be lifted out of a capture at all.
  const bp = tierList();
  delete bp.tracks[0].varies;
  const r = lib.validateBlueprint(bp);
  assert.equal(r.ok, false);
  assert.match(r.error, /varies/);
});

test("a slot may name a board declared after it, but not one that does not exist", () => {
  const ok = tierList();
  ok.regions.unshift(ok.regions.splice(5, 1)[0]); // slot first, board later
  assert.equal(lib.validateBlueprint(ok).ok, true);

  const bad = tierList();
  bad.regions[5].parent = "nowhere";
  const r = lib.validateBlueprint(bad);
  assert.equal(r.ok, false);
  assert.match(r.error, /not a declared region/);
});

test("a parent loop is refused rather than hanging whatever walks the tree", () => {
  const bp = tierList();
  bp.regions.find((r) => r.id === "board").parent = "slot_d";
  const r = lib.validateBlueprint(bp);
  assert.equal(r.ok, false);
  assert.match(r.error, /parent loop/);
});

test("geometry is fractions of the canvas, and pixels are refused", () => {
  const bp = tierList();
  bp.regions[1].rect = [0, 0, 720, 96];
  const r = lib.validateBlueprint(bp);
  assert.equal(r.ok, false);
  assert.match(r.error, /fractions/);
});

test("a beat is a whole repetition number, counting from one", () => {
  for (const bad of [0, -1, 1.5, "1"]) {
    const bp = tierList();
    bp.tracks[4].items[0].beat = bad;
    const r = lib.validateBlueprint(bp);
    assert.equal(r.ok, false, `beat ${bad} should be refused`);
    assert.match(r.error, /beat/);
  }
});

test("a container whose children hold the content is fine", () => {
  // A board can have nothing of its own to paint; its slots carry everything.
  const bp = tierList();
  bp.tracks = bp.tracks.filter((t) => t.region !== "board");
  const r = lib.validateBlueprint(bp);
  assert.equal(r.ok, true, r.error);
});

test("a region nobody ever paints into is refused as imagined, not observed", () => {
  const bp = tierList();
  bp.regions.push({ id: "ghost", role: "sticker", rect: [0, 0, 0.1, 0.1], z: 9 });
  const r = lib.validateBlueprint(bp);
  assert.equal(r.ok, false);
  assert.match(r.error, /has no track/);
});

test("an item cannot run past the end of the video, or backwards", () => {
  const past = tierList(); past.tracks[0].items[0].end = 90;
  assert.match(lib.validateBlueprint(past).error, /past the end/);
  const back = tierList(); back.tracks[0].items[0] = { start: 5, end: 2, value: "x" };
  assert.match(lib.validateBlueprint(back).error, /after start/);
});

test("malformed input is an answer, never a throw", () => {
  for (const bad of [null, 42, "x", [], {}, { version: "something/else" }]) {
    const r = lib.validateBlueprint(bad);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, "string");
  }
});

test("the schema the model is given matches the one that is enforced", () => {
  const p = lib.BLUEPRINT_SCHEMA_PROMPT;
  for (const role of lib.REGION_ROLES) assert.ok(p.includes(role), `role ${role} missing from the prompt`);
  for (const kind of lib.TRACK_KINDS) assert.ok(p.includes(kind), `kind ${kind} missing from the prompt`);
  assert.ok(p.includes(lib.BLUEPRINT_VERSION), "the prompt must pin the version the validator requires");
  for (const field of ['"varies"', '"beat"', '"parent"']) assert.ok(p.includes(field), `${field} must be explained to the model`);
});
