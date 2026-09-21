// The blueprint validator: the thing that makes a machine-written layout trustworthy.
//
//   node --test agent-os-module/test/blueprint.test.mjs
//
// Every case here is one the live model actually produced or nearly produced on the
// reference video, so these are regressions, not hypotheticals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
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
  fileName: LIB, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dir = mkdtempSync(path.join(tmpdir(), "omni-bp-"));
writeFileSync(path.join(dir, "bp.js"), out);
const lib = req(path.join(dir, "bp.js"));

const good = () => ({
  version: lib.BLUEPRINT_VERSION,
  canvas: { width: 1080, height: 1920, fps: 30, seconds: 20 },
  regions: [
    { id: "bg", role: "backdrop", rect: [0, 0, 1, 1], z: 0 },
    { id: "cap", role: "text", rect: [0.1, 0.5, 0.8, 0.08], z: 4 },
  ],
  tracks: [
    { region: "bg", kind: "video", varies: "fixed", items: [{ start: 0, end: 20, value: "a room" }] },
    { region: "cap", kind: "text", varies: "episode", items: [{ start: 2, end: 4, value: "second line" }, { start: 0, end: 2, value: "first line" }] },
  ],
});

/** The reference this benchmark copies, reduced to two ranked subjects: a scaffolded tier
 *  board, a presenter that holds, and captions and images that change per subject. */
const tierList = () => ({
  version: lib.BLUEPRINT_VERSION,
  canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
  regions: [
    { id: "stage", role: "backdrop", rect: [0, 0, 1, 1], z: 0 },
    { id: "title", role: "text", label: "headline strip", rect: [0, 0, 1, 0.08], z: 3 },
    { id: "host", role: "figure", label: "presenter with microphone", rect: [0.1, 0.1, 0.8, 0.35], z: 2 },
    { id: "face", role: "overlay", label: "reaction inset", rect: [0.05, 0.12, 0.15, 0.1], z: 5, parent: "host" },
    { id: "caption", role: "text", label: "spoken line", rect: [0.05, 0.47, 0.9, 0.07], z: 4 },
    { id: "board", role: "panel", label: "tier list", rect: [0, 0.55, 1, 0.45], z: 1, grid: { rows: 5, cols: 4 } },
    { id: "cell_d1", role: "cell", label: "tier row D, first slot", rect: [0.15, 0.88, 0.25, 0.1], z: 2, parent: "board", at: { row: 5, col: 1 } },
  ],
  tracks: [
    { region: "stage", kind: "color", varies: "fixed", items: [{ start: 0, end: 20, value: "#000000" }] },
    { region: "title", kind: "text", varies: "episode", items: [{ start: 0, end: 20, value: "RANKING THE BEST FOOTBALLERS" }] },
    { region: "board", kind: "image", varies: "fixed", items: [{ start: 0, end: 20, value: "five rows labelled S A B C D" }] },
    { region: "host", kind: "video", varies: "fixed", items: [{ start: 0, end: 20, value: "a presenter holding a microphone" }] },
    { region: "face", kind: "image", varies: "episode", items: [
      { start: 0, end: 10, value: "a portrait of the first subject", beat: 1 },
      { start: 10, end: 20, value: "a portrait of the second subject", beat: 2 },
    ] },
    { region: "caption", kind: "text", varies: "episode", items: [
      { start: 0, end: 2, value: "Ronaldo is D tier.", beat: 1 },
      { start: 2, end: 4, value: "Bro has more hair gel than trophies.", beat: 1 },
      { start: 10, end: 12, value: "Messi? Man won a World Cup", beat: 2 },
      { start: 12, end: 14, value: "looking like somebody's tired dad.", beat: 2 },
    ] },
    { region: "cell_d1", kind: "image", varies: "episode", items: [
      { start: 2, end: 6, value: "hair gel beside empty trophy shelves", beat: 1 },
      { start: 12, end: 16, value: "a World Cup trophy held by a tired man", beat: 2 },
    ] },
  ],
});

test("a well-formed blueprint passes, and items come back in time order", () => {
  const r = lib.validateBlueprint(good());
  assert.equal(r.ok, true, r.error);
  const cap = r.blueprint.tracks.find((t) => t.region === "cap");
  assert.deepEqual(cap.items.map((i) => i.value), ["first line", "second line"],
    "items must be sorted, or a renderer walking them in order draws the wrong thing");
});

test("a caption track that runs past the end of the video is refused", () => {
  // Measured: the model laid captions on a one-per-second grid and ran a 20s video to 24s.
  const b = good();
  b.tracks[1].items.push({ start: 19, end: 24, value: "overrun" });
  const r = lib.validateBlueprint(b);
  assert.equal(r.ok, false);
  assert.match(r.error, /past the end/);
});

test("the vocabularies are closed, and the prompt is generated from them", () => {
  const b = good();
  b.regions[0].role = "tier_list";
  assert.match(lib.validateBlueprint(b).error, /role must be one of/);
  const c = good();
  c.tracks[0].kind = "audio";
  assert.match(lib.validateBlueprint(c).error, /kind must be one of/);
  // The prompt interpolates the same constants, so the model cannot be told about a value
  // the validator will then reject.
  for (const role of lib.REGION_ROLES) assert.ok(lib.BLUEPRINT_SCHEMA_PROMPT.includes(role), role);
  for (const kind of lib.TRACK_KINDS) assert.ok(lib.BLUEPRINT_SCHEMA_PROMPT.includes(kind), kind);
});

test("geometry must be fractions, because a clone is rendered at another size", () => {
  const b = good();
  b.regions[1].rect = [0, 540, 1080, 96]; // pixels, the easy mistake
  assert.match(lib.validateBlueprint(b).error, /fractions/);
  for (const bad of [[0, 0, 1], [0, 0, 0, 1], "x", [0, 0, "1", 1]]) {
    const c = good(); c.regions[1].rect = bad;
    assert.equal(lib.validateBlueprint(c).ok, false, JSON.stringify(bad));
  }
});

test("a track must name a region that exists, and every region must carry something", () => {
  const b = good();
  b.tracks[1].region = "nope";
  assert.match(lib.validateBlueprint(b).error, /not a declared region/);
  const c = good();
  c.regions.push({ id: "ghost", role: "overlay", rect: [0, 0, 0.2, 0.2], z: 9 });
  assert.match(lib.validateBlueprint(c).error, /has no track/);
});

test("a wrong or missing version is refused outright", () => {
  for (const v of [undefined, "", "omniwatch.blueprint/2", "VISUAL_IR_V1"]) {
    const b = good(); b.version = v;
    assert.equal(lib.validateBlueprint(b).ok, false, String(v));
  }
});

test("it never throws, whatever it is handed", () => {
  for (const junk of [null, 5, "text", [], {}, { version: lib.BLUEPRINT_VERSION }]) {
    const r = lib.validateBlueprint(junk);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, "string");
  }
});

test("every track must say whether it is the format or this episode", () => {
  // This is the axis the clone benchmark turns on: copy the video exactly, change the host
  // and the subject. "fixed" is what survives that swap, "episode" is what gets rewritten.
  // A track that does not declare which cannot be reused as a format at all.
  const b = good();
  delete b.tracks[0].varies;
  assert.match(lib.validateBlueprint(b).error, /varies must be/);
  const c = good();
  c.tracks[0].varies = "sometimes";
  assert.match(lib.validateBlueprint(c).error, /varies must be/);
  const ok = lib.validateBlueprint(good());
  assert.equal(ok.blueprint.tracks.find((t) => t.region === "bg").varies, "fixed");
  assert.equal(ok.blueprint.tracks.find((t) => t.region === "cap").varies, "episode");
});

// ── the format layer ─────────────────────────────────────────────────────────────────────
// A capture is one episode. A format is the same layout with the episode removed: the
// scaffolding kept, everything that changes reduced to a named slot, and time as a share.

test("a format has no duration, keeps the scaffolding, and asks for the rest", () => {
  const f = lib.deriveFormat(lib.validateBlueprint(tierList()).blueprint);
  assert.equal(f.canvas.seconds, undefined, "a format has no duration until an episode gives it one");
  assert.equal(f.canvas.width, 720);
  assert.deepEqual(f.fixed.map((t) => t.region).sort(), ["board", "host", "stage"]);
  assert.deepEqual(f.slots.map((s) => s.region).sort(), ["caption", "cell_d1", "face", "title"]);
  assert.equal(f.beats, 2);
});

test("a per-episode field is asked for once, a per-beat one for every beat", () => {
  const f = lib.deriveFormat(lib.validateBlueprint(tierList()).blueprint);
  const title = f.slots.find((s) => s.region === "title");
  assert.equal(title.perBeat, false, "the headline is supplied once");
  assert.equal(title.perUnit, 1);
  const caption = f.slots.find((s) => s.region === "caption");
  assert.equal(caption.perBeat, true, "captions repeat per subject");
});

test("timing is a share of the beat, so the same format stretches to a longer episode", () => {
  // Two captures of the same shape, one twice as slow. The shares must come out identical.
  const slow = tierList();
  slow.canvas.seconds = 40;
  for (const t of slow.tracks) for (const i of t.items) { i.start *= 2; i.end *= 2; }
  const a = lib.deriveFormat(lib.validateBlueprint(tierList()).blueprint);
  const b = lib.deriveFormat(lib.validateBlueprint(slow).blueprint);
  const pick = (f) => f.slots.find((s) => s.region === "caption").timing;
  assert.deepEqual(pick(a), pick(b), "shares must not depend on how long the capture ran");
});

test("one talkative beat does not set the bill for the rest", () => {
  // Beat 1 gets four captions, beat 2 gets one. The typical ask is the median, and the
  // spread is reported rather than hidden.
  const bp = tierList();
  const cap = bp.tracks.find((t) => t.region === "caption");
  cap.items = [
    { start: 0, end: 1, value: "a", beat: 1 }, { start: 1, end: 2, value: "b", beat: 1 },
    { start: 2, end: 3, value: "c", beat: 1 }, { start: 3, end: 4, value: "d", beat: 1 },
    { start: 10, end: 12, value: "e", beat: 2 },
  ];
  const slot = lib.deriveFormat(lib.validateBlueprint(bp).blueprint).slots.find((s) => s.region === "caption");
  assert.equal(slot.perUnitMax, 4, "the busiest beat is still reported");
  assert.ok(slot.perUnit < slot.perUnitMax, "the typical ask must be below the busiest beat");
});

test("a track the model forgot to number is placed by where its items fall", () => {
  // Measured on a real capture: the caption items were numbered and the graphic changing
  // alongside them was not, which called an obviously per-beat track "supplied once".
  const bp = tierList();
  const overlay = { region: "face", kind: "image", varies: "episode", items: [
    { start: 0.5, end: 4, value: "first subject's joke image" },
    { start: 10.5, end: 14, value: "second subject's joke image" },
  ] };
  bp.tracks = bp.tracks.filter((t) => t.region !== "face").concat([overlay]);
  const slot = lib.deriveFormat(lib.validateBlueprint(bp).blueprint).slots.find((s) => s.region === "face");
  assert.equal(slot.perBeat, true, "items sitting inside beat windows belong to those beats");
  assert.equal(slot.perUnit, 1);
});

test("a guess that does not explain the track is not adopted", () => {
  // Items scattered outside every beat window stay a per-episode field rather than being
  // forced into beats they do not belong to.
  const bp = tierList();
  bp.canvas.seconds = 40;
  bp.tracks = bp.tracks.filter((t) => t.region !== "face").concat([{
    region: "face", kind: "image", varies: "episode",
    items: [{ start: 30, end: 33, value: "an outro card" }, { start: 33, end: 36, value: "a logo" }],
  }]);
  const slot = lib.deriveFormat(lib.validateBlueprint(bp).blueprint).slots.find((s) => s.region === "face");
  assert.equal(slot.perBeat, false, "nothing should be invented to make a track look repeating");
});
