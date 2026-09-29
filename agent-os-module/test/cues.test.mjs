// The clock: word times, and what may move onto them.
//
//   node --test agent-os-module/test/cues.test.mjs
//
// Every case here is a way the caption used to drift. The times the chunker hands out are a
// share of a span proportional to letter count — close, and wrong by a tenth of a second —
// and nothing downstream could tell. These tests are what tells.
//
// No network and no fixtures: the words are written here, because a word list IS the input.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchCues.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-cues-"));

// The one thing stood in for: the process helper, which reaches into Agent OS's own PATH
// handling. Nothing in these tests runs ffmpeg or calls an aligner.
writeFileSync(path.join(dir, "omniwatch.js"), `
exports.run = async () => { throw new Error("no ffmpeg in a unit test"); };
exports.videoDir = (id) => id;
exports.apiKey = async () => null;
`);

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
load("omniwatchBlueprint");
load("omniwatchTranscript");
// landItemsOnWords defers to omniwatchStage's own needsStaging rather than re-testing the
// hold/waitsAt junk-handling this file already covers, so that module has to be on disk
// before omniwatchCues is required.
load("omniwatchStage");
const cues = load("omniwatchCues");

/** Spoken at a steady clip, with one real gap in the middle. */
const WORDS = [
  { text: "he", start: 1.00, end: 1.18 },
  { text: "got", start: 1.20, end: 1.44 },
  { text: "the", start: 1.46, end: 1.60 },
  { text: "most", start: 1.62, end: 1.95 },
  { text: "followers", start: 2.00, end: 2.70 },
  { text: "by", start: 3.40, end: 3.55 },
  { text: "a", start: 3.57, end: 3.62 },
  { text: "mile", start: 3.64, end: 4.10 },
];

const film = (tracks, regions = []) => ({
  version: 2,
  canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
  regions: [{ id: "caption-area", role: "text", rect: [0, 0.4, 1, 0.1], z: 7 }, ...regions],
  tracks,
});

const capTrack = (items) => ({
  region: "caption-area", kind: "text", varies: "episode",
  style: { color: "#FFFFFF" }, items,
});

test("caption chunks land on the words they are made of", () => {
  // What the chunker would hand over: the right words, times shared out by letter count.
  const bp = film([capTrack([
    { start: 0.90, end: 2.40, value: "he got the most [[most]]" },
    { start: 2.40, end: 4.30, value: "by a [[mile]]" },
  ])]);
  // Fix the first cue's text to something really spoken, marker on its last word.
  bp.tracks[0].items[0].value = "he got the [[most]]";

  const notes = [];
  const out = cues.snapCaptionsToWords(bp, WORDS, notes);
  const items = out.tracks[0].items;

  assert.equal(items[0].start, 1.00, "first cue starts on 'he'");
  assert.equal(items[1].start, 3.40, "second cue starts on 'by'");
  // The line holds until the next word is heard rather than blinking out in the pause.
  assert.ok(items[0].end >= 1.95 && items[0].end <= 2.40, `first cue ends ${items[0].end}`);
  // With nothing following it, the last cue keeps the end it was SEEN with — holding a
  // line past its final word is how a caption stops flickering at the end of a sentence.
  assert.equal(items[1].end, 4.30, "last cue should hold to the end it was seen with");
  // The highlight survives the move — the screen decided it, not the soundtrack.
  assert.match(items[0].value, /\[\[most\]\]/);
  assert.ok(notes.some((n) => /moved onto word boundaries/.test(n)), notes.join(" | "));
});

test("a line nobody says keeps the time it was seen with", () => {
  const bp = film([capTrack([{ start: 0.2, end: 0.9, value: "RANKING THE BEST FOOTBALLERS" }])]);
  const notes = [];
  const out = cues.snapCaptionsToWords(bp, WORDS, notes);
  assert.equal(out.tracks[0].items[0].start, 0.2);
  assert.equal(out.tracks[0].items[0].end, 0.9);
});

test("everything else the item carries survives the move", () => {
  const bp = film([capTrack([{ start: 0.90, end: 2.40, value: "he got the most", beat: 3 }])]);
  const out = cues.snapCaptionsToWords(bp, WORDS, []);
  assert.equal(out.tracks[0].items[0].beat, 3, "beat was dropped");
});

test("an overlay near a word edge is pulled onto it, with a pad", () => {
  const bp = film([{
    region: "insert", kind: "image", varies: "episode",
    items: [{ start: 2.12, end: 2.80, value: "a phone screenshot", rect: [0.1, 0.2, 0.5, 0.3] }],
  }], [{ id: "insert", role: "figure", rect: [0, 0.1, 1, 0.5], z: 8 }]);

  const notes = [];
  const out = cues.snapSpansToWords(bp, WORDS, notes);
  const it = out.tracks[0].items[0];
  // 'followers' runs 2.00–2.70: the start pulls back to 2.00, the end forward to 2.70,
  // each moved out by the pad so the consonants are not clipped.
  assert.ok(Math.abs(it.start - (2.00 - cues.PAD)) < 1e-9, `start ${it.start}`);
  assert.ok(Math.abs(it.end - (2.70 + cues.PAD)) < 1e-9, `end ${it.end}`);
  assert.deepEqual(it.rect, [0.1, 0.2, 0.5, 0.3], "the box must not move");
  assert.ok(notes.some((n) => /word boundaries/.test(n)));
});

test("an overlay that genuinely starts mid-phrase is left where it is", () => {
  // 6.0s is far from every word edge in this soundtrack; snapping it would invent a sync.
  const bp = film([{
    region: "insert", kind: "image", varies: "episode",
    items: [{ start: 6.0, end: 7.0, value: "a trophy" }],
  }], [{ id: "insert", role: "figure", rect: [0, 0.1, 1, 0.5], z: 8 }]);
  const out = cues.snapSpansToWords(bp, WORDS, []);
  assert.equal(out.tracks[0].items[0].start, 6.0);
  assert.equal(out.tracks[0].items[0].end, 7.0);
});

test("the format's furniture is not a cut", () => {
  // A board that stands for the whole film has no edge to place.
  const bp = film([{
    region: "board", kind: "color", varies: "fixed",
    items: [{ start: 0, end: 20, value: "#141316" }],
  }], [{ id: "board", role: "panel", rect: [0, 0.55, 1, 0.45], z: 2 }]);
  const out = cues.snapSpansToWords(bp, WORDS, []);
  assert.equal(out.tracks[0].items[0].start, 0);
  assert.equal(out.tracks[0].items[0].end, 20);
});

// ── landsAt: when a waiting item stops waiting (IR-CONTRACT-V2 §3) ────────────

const onCueItem = (extra) => ({
  region: "s-slot", kind: "image", varies: "episode",
  items: [{ start: 0.9, end: 3.0, value: "a trophy icon", hold: "on-cue", waitsAt: "stage-spot", ...extra }],
});

test("landItemsOnWords lands an item at the end of the sentence in its window, not at start", () => {
  const bpFilm = film([onCueItem()]);
  const notes = [];
  const out = cues.landItemsOnWords(bpFilm, WORDS, notes);
  const item = out.tracks[0].items[0];
  // "followers" is the last word before the 0.70s pause — the sentence this item is
  // anchored to ends there, well after item.start (0.9) and before item.end (3.0).
  assert.equal(item.landsAt, 2.70);
  assert.ok(notes.some((n) => /given landsAt/.test(n)), notes.join(" | "));
});

test("landItemsOnWords stops at the film's own pause, even when the item's own end runs far past it", () => {
  // An item that lands and then holds its row for the rest of the film can have an `end`
  // long after the one sentence it is anchored to — taking the last word before THAT would
  // land it at the end of the video, not the end of its sentence.
  const bpFilm = film([onCueItem({ end: 20 })]);
  const out = cues.landItemsOnWords(bpFilm, WORDS, []);
  assert.equal(out.tracks[0].items[0].landsAt, 2.70, "the pause after 'followers' stops the sentence, not item.end");
});

test("landItemsOnWords clamps to the item's own end when the sentence runs past it", () => {
  const bpFilm = film([onCueItem({ end: 2.2 })]);
  const out = cues.landItemsOnWords(bpFilm, WORDS, []);
  assert.equal(out.tracks[0].items[0].landsAt, 2.2);
});

test("landItemsOnWords never overwrites a landsAt a producer already set", () => {
  const bpFilm = film([onCueItem({ landsAt: 5 })]);
  const out = cues.landItemsOnWords(bpFilm, WORDS, []);
  assert.equal(out.tracks[0].items[0].landsAt, 5);
});

test("landItemsOnWords leaves a plain item alone, on-cue or not", () => {
  // Not on-cue at all — nothing to land.
  const plain = film([{ region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 0.9, end: 3.0, value: "a plain tile" }] }]);
  const outPlain = cues.landItemsOnWords(plain, WORDS, []);
  assert.equal("landsAt" in outPlain.tracks[0].items[0], false);

  // No word anywhere inside the item's own window — nothing to measure from, so nothing
  // is invented.
  const stranded = film([onCueItem({ start: 10, end: 12 })]);
  const outStranded = cues.landItemsOnWords(stranded, WORDS, []);
  assert.equal("landsAt" in outStranded.tracks[0].items[0], false);
});

test("landItemsOnWords with no words at all returns the blueprint untouched", () => {
  const bpFilm = film([onCueItem()]);
  const out = cues.landItemsOnWords(bpFilm, [], []);
  assert.equal(out, bpFilm);
});

test("the words are read from the cache, not paid for twice", async () => {
  // The source does not exist and the stubbed ffmpeg throws: if this returns words, they
  // can only have come from the cache beside it.
  const home = mkdtempSync(path.join(tmpdir(), "omni-src-"));
  writeFileSync(path.join(home, "words.json"), JSON.stringify(WORDS));
  const notes = [];
  const got = await cues.wordTimes(path.join(home, "source.mp4"), dir, notes);
  assert.equal(got.length, WORDS.length);
  assert.ok(notes.some((n) => /from cache/.test(n)), notes.join(" | "));
});

test("a corrupt cache is ignored rather than trusted", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "omni-src-"));
  writeFileSync(path.join(home, "words.json"), JSON.stringify([{ text: "he" }]));
  const notes = [];
  // No key and no ffmpeg, so this falls all the way through — the point is that it does
  // not hand back a word with no time on it.
  const got = await cues.wordTimes(path.join(home, "source.mp4"), dir, notes);
  assert.equal(got, null);
  assert.ok(notes.some((n) => /aligner unavailable/.test(n)), notes.join(" | "));
});
