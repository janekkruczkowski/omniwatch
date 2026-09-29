// Provenance: a region's rect says WHERE IT CAME FROM, and a tidy-up pass does not get to
// change that answer.
//
//   node --test agent-os-module/test/measure-origin.test.mjs
//
// The defect this pins down: the caption-band gate in omniwatchMeasure.ts used to accept a
// box the moment it differed from the capture's guess. On the reference that was true for the
// right reason (locate, or `fitTypeToInk`'s ink scan, had genuinely measured something) — and
// also true for the wrong one: reproduced with every provider key withheld, `locate` answered
// nothing, and `sanitizeCaptionVsBanner` still moved the caption away from the guess on its
// own, using a hard-coded board-top fraction, not a measurement of anything. A box that came
// back DIFFERENT is not the same fact as a box that came back MEASURED, and the old gate could
// not tell them apart.
//
// The fix is a `RegionOrigins` map (omniwatchGround.ts) threaded alongside `hits`: `applyHits`
// and `fitTypeToInk` write an entry when they actually measure a region (from locate or from
// pixels), and the tidy-up passes — `sanitizeCaptionVsBanner` chief among them — are simply
// never handed the map, so a rect they move keeps whatever origin it already had. Nothing
// here calls ffmpeg or a model: `applyHits`, `sanitizeCaptionVsBanner` and `fitTypeToInk` are
// pure functions over a blueprint and some hits/measurements, exactly like the fixtures
// test/hard-rules.test.mjs already builds by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const SOURCE = process.env.SOURCE
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchGround.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-origin-"));

// The process helper, stood in for: nothing here shells out to ffmpeg or calls a provider.
writeFileSync(path.join(dir, "omniwatch.js"), `
exports.run = async () => { throw new Error("no ffmpeg in a unit test"); };
exports.videoDir = (id) => id;
exports.apiKey = async () => null;
`);

// Same "read every import from the source" loader as hard-rules.test.mjs and node.test.mjs —
// a hand-written load order has gone stale twice already when a new lib file appeared.
const emitted = new Set();
function emit(name) {
  if (emitted.has(name)) return;
  emitted.add(name);
  const file = path.join(SOURCE, "lib", `${name}.ts`);
  const src = readFileSync(file, "utf8");
  const out = ts.transpileModule(src, {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText.replace(/require\("@\/lib\/([A-Za-z0-9_]+)"\)/g, 'require("./$1.js")');
  writeFileSync(path.join(dir, `${name}.js`), out);
  for (const dep of src.matchAll(/["']@\/lib\/([A-Za-z0-9_]+)["']/g)) emit(dep[1]);
}
function load(name) {
  emit(name);
  return req(path.join(dir, `${name}.js`));
}
const bpLib = load("omniwatchBlueprint");
load("omniwatchBoardScan");
load("omniwatchNode"); // omniwatchGround imports from it — has to be on disk first
const ground = load("omniwatchGround");

/** A presenter-and-caption film with no board — the shape of the interview reference, and
 *  the shape that puts the caption where `sanitizeCaptionVsBanner` will move it: overlapping
 *  the banner. `boardTop` inside that function falls back to its own default (0.55) exactly
 *  as it does on a board-less film. */
function film() {
  return {
    version: bpLib.BLUEPRINT_VERSION,
    canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
    regions: [
      { id: "top-banner", role: "text", rect: [0.1, 0.02, 0.8, 0.08], z: 5, paint: { fill: "#fff8e7" } },
      { id: "presenter-stage", role: "figure", rect: [0, 0, 1, 0.7], z: 1 },
      // Squarely on top of the banner — the exact "locate confused them" shape the function
      // exists to correct.
      { id: "caption-area", role: "text", rect: [0.12, 0.03, 0.7, 0.06], z: 8 },
    ],
    tracks: [
      { region: "top-banner", kind: "text", varies: "episode", items: [{ start: 0, end: 20, value: "A Title" }] },
      { region: "presenter-stage", kind: "video", varies: "episode", fill: "cut",
        items: [{ start: 0, end: 20, value: "whoever is on screen" }] },
      { region: "caption-area", kind: "text", varies: "episode",
        style: { color: "#FFFFFF", outline: "#000000" },
        items: [{ start: 0, end: 2, value: "hello" }] },
    ],
  };
}

test("a region locate actually answered for is marked 'located'", () => {
  const bp = film();
  const notes = [];
  const origins = new Map();
  const hits = [{ id: "caption-area", rect: [0.1, 0.5, 0.8, 0.06], via: "openrouter:test" }];
  ground.applyHits(bp, hits, notes, null, origins);
  assert.equal(origins.get("caption-area"), "located");
});

test("a tidy-up nudge to a box nobody measured leaves no origin behind — the regression for the reference's exact failure", () => {
  const bp = film();
  const notes = [];
  const origins = new Map();

  // Nothing located anything — reproduces the probe run with every provider key withheld:
  // locate comes back with zero hits, exactly like a call that could not reach a model.
  const afterHits = ground.applyHits(bp, [], notes, null, origins);
  assert.equal(origins.has("caption-area"), false, "no hit landed, so nothing should be marked measured yet");

  const before = afterHits.regions.find((r) => r.id === "caption-area").rect;
  const after = ground.sanitizeCaptionVsBanner(afterHits, [], notes);
  const afterRect = after.regions.find((r) => r.id === "caption-area").rect;

  // Prove the test is not vacuous: sanitize really did move the box.
  assert.notDeepEqual(afterRect, before, "sanitize must actually have moved the caption for this test to mean anything");
  assert.ok(notes.some((n) => /caption sanitize/.test(n)), "expected a sanitize note recording the move");

  // The regression itself: a box that moved because of a tidy-up heuristic is still nobody's
  // measurement. `origins` must say so — which here means saying nothing at all.
  assert.equal(origins.has("caption-area"), false,
    "a tidy-up nudge must not promote an unmeasured guess to 'measured'");
});

test("a tidy-up nudge does not erase a REAL measurement either — sanitize only repositions, it never re-measures", () => {
  const bp = film();
  const notes = [];
  const origins = new Map();
  // This time locate did answer, with the same bad, banner-overlapping box sanitize exists
  // to catch.
  const hits = [{ id: "caption-area", rect: [0.15, 0.03, 0.6, 0.05], via: "openrouter:test" }];
  const afterHits = ground.applyHits(bp, hits, notes, null, origins);
  assert.equal(origins.get("caption-area"), "located");

  const after = ground.sanitizeCaptionVsBanner(afterHits, hits, notes);
  const moved = after.regions.find((r) => r.id === "caption-area").rect;
  assert.notDeepEqual(moved, hits[0].rect, "sanitize must still have moved the located box for this test to mean anything");

  // The nudge repositions a box that WAS measured; it does not un-measure it. `applyHits`
  // wrote the fact, and nothing after it retracts that fact just because the number changed.
  assert.equal(origins.get("caption-area"), "located",
    "moving an already-measured box must not erase what measured it");
});

test("a tier board and its cells, built from the pixel scan, are marked 'scanned'", () => {
  const bp = {
    version: bpLib.BLUEPRINT_VERSION,
    canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
    regions: [{ id: "presenter-stage", role: "figure", rect: [0, 0, 1, 1], z: 1 }],
    tracks: [{ region: "presenter-stage", kind: "video", varies: "episode", fill: "cut",
      items: [{ start: 0, end: 20, value: "whoever is on screen" }] }],
  };
  const notes = [];
  const origins = new Map();
  const rowRect = (i) => [0, 0.5 + i * 0.1, 1, 0.1];
  const measured = {
    board: [0, 0.5, 1, 0.5],
    rows: ["s", "a", "b", "c", "d"].map((letter, i) => ({
      id: letter, rect: rowRect(i), label: [0, rowRect(i)[1], 0.16, 0.1], slot: [0.16, rowRect(i)[1], 0.84, 0.1],
      fill: "#1a1a1a", thumbs: [],
    })),
    labelRatio: 0.16, rowGap: 0.002, slotBackground: "#1a1a1a", boardBackground: "#000000",
    letterCapRatio: null, letterInk: null,
    thumb: { heightRatio: 0.9, aspect: 1, gap: 0.01, padX: 0.02 },
    notes: [],
  };
  ground.applyHits(bp, [], notes, measured, origins);
  assert.equal(origins.get("tier-board"), "scanned");
  for (const letter of ["s", "a", "b", "c", "d"]) {
    assert.equal(origins.get(`${letter}-label`), "scanned", `${letter}-label should be marked scanned`);
    assert.equal(origins.get(`${letter}-slot`), "scanned", `${letter}-slot should be marked scanned`);
  }
});
