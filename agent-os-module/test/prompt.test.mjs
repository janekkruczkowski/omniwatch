// What we are allowed to tell a picture provider.
//
//   node --test agent-os-module/test/prompt.test.mjs
//
// The rule these defend: framing is ours to decide because we MEASURED the box; content is
// the film's to decide because it watched the film. The failure that produced this file was
// typing "tight head-and-shoulders portrait, face filling the frame" into the tier-tile
// prompt. It fixed the picture in front of me and silently asked every future format — cars,
// album covers, flying fairies — to be a face.
//
// So the tests below are mostly about what the prompt must NOT contain.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchPrompt.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-prompt-"));

// Emitting a module emits whatever it imports, first. Every caller used to keep a
// hand-written list of `load(...)` calls in dependency order, and twice today a new module
// (omniwatchNode, then omniwatchBandScan) was added to the library and every one of those
// lists silently went stale — the failure was `Cannot find module`, at the gate, long after
// the change that caused it. A list that has to be updated in five places is not a list, so
// the imports are read from the source instead.
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
  // After the file is on disk, so a cycle between two modules resolves instead of recursing.
  for (const dep of src.matchAll(/["']@\/lib\/([A-Za-z0-9_]+)["']/g)) emit(dep[1]);
}
function load(name) {
  emit(name);
  return req(path.join(dir, `${name}.js`));
}
const bpLib = load("omniwatchBlueprint");
const p = load("omniwatchPrompt");

/** Words that describe CONTENT. If one of these reaches a prompt without the film having
 *  said it, something in this pipeline has decided what the picture is. */
const CONTENT_WORDS = [
  "face", "portrait", "head-and-shoulders", "headshot", "person", "player", "footballer",
  "product", "thumbnail card", "tier list", "logo", "landscape", "animal",
];

const tinyBox = { boxFractionOfWidth: 0.11 };

test("framing follows the box, not the subject", () => {
  // The same rule for a face, a car and a fairy, because the argument is about pixels.
  for (const subject of ["Erling Haaland", "a vintage sports car", "a flying fairy with gauzy wings"]) {
    const out = p.promptFor(subject, tinyBox);
    assert.match(out, /fills the frame/, `a tile-sized box must demand a filled frame: ${out}`);
    assert.ok(out.startsWith(subject), `the film's words must lead: ${out}`);
  }
  // A big box does not demand anything.
  assert.doesNotMatch(p.promptFor("a flying fairy", { boxFractionOfWidth: 0.9 }), /fills the frame|centred and large/);
});

test("the prompt never decides what the picture is of", () => {
  const subject = "a flying fairy with gauzy wings";
  const out = p.promptFor(subject, { ...tinyBox, single: true, swapCast: true });
  const added = out.slice(subject.length);
  for (const word of CONTENT_WORDS) {
    assert.ok(!added.toLowerCase().includes(word),
      `the prompt added the word "${word}" to a picture the film never called that:\n  ${out}`);
  }
});

test("the three framings are a closed set keyed only to width", () => {
  assert.equal(p.framingFor(0.05), "fills");
  assert.equal(p.framingFor(0.17), "fills");
  assert.equal(p.framingFor(0.3), "close");
  assert.equal(p.framingFor(0.8), "open");
  // Nonsense in, the mildest answer out — never a crash, never an invented crop.
  for (const junk of [0, -1, NaN, undefined, null]) assert.equal(p.framingFor(junk), "open");
});

test("a named cast is only replaced when the caller asks for a swap", () => {
  const value = "Cutout portrait of Cristiano Ronaldo.";
  // A reproduction means that person: leave the film's words alone.
  assert.ok(p.promptFor(value, tinyBox).startsWith(value));
  // A swap must not render somebody else's cast.
  const swapped = p.promptFor(value, { ...tinyBox, swapCast: true });
  assert.doesNotMatch(swapped, /Cristiano|Ronaldo/);
  assert.match(swapped, /an unnamed person/);
});

test("anonymising leaves everything that is not a name", () => {
  assert.equal(p.anonymise("A vintage sports car on a wet road."), "A vintage sports car on a wet road.");
  assert.match(p.anonymise("Photo of Diego Maradona holding a trophy."), /holding a trophy/);
});

test("a row split into tiles asks for one picture, not a collage", () => {
  const bp = bpLib.validateBlueprint({
    version: bpLib.BLUEPRINT_VERSION,
    canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
    regions: [
      { id: "board", role: "panel", rect: [0, 0.55, 1, 0.45], z: 2, grid: { rows: 5, cols: 2 } },
      { id: "d-slot", role: "cell", rect: [0.24, 0.9, 0.76, 0.09], z: 3, parent: "board", at: { row: 5, col: 2 } },
    ],
    tracks: [{
      region: "d-slot", kind: "image", varies: "episode",
      items: [
        { start: 0, end: 20, value: "Three images side-by-side: one, two and three." },
        { start: 0, end: 20, value: "Three images side-by-side: one, two and three." },
        { start: 0, end: 20, value: "Three images side-by-side: one, two and three." },
      ],
    }],
  }, { preserveGeometry: true });
  assert.equal(bp.ok, true, bp.error);
  const track = bp.blueprint.tracks[0];
  const out = p.promptForItem(bp.blueprint, track, track.items[0]);
  // Three tiles in a row that wide: each one is a thumbnail, and each one holds one thing.
  assert.match(out, /one single subject, not a collage/);
  assert.match(out, /fills the frame/);
});

test("nothing anywhere asks a provider to draw words", () => {
  // The composer draws every word this format shows, from the blueprint. A caption inside a
  // generated picture can only ever be a second, wrong one.
  assert.match(p.promptFor("anything at all", tinyBox), /no text, no watermark/);
});
