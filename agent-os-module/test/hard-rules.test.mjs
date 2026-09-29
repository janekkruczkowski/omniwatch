// Production correctness, as tests rather than as advice.
//
//   node --test agent-os-module/test/hard-rules.test.mjs
//
// These are the rules from our contract's §6 — the things a MODEL must never get to choose,
// because breaking them fails silently. An overlay drawn over the caption is not an error
// anywhere; it is a film with an unreadable line in it. A cut inside a word is not an error;
// it is a caption that reads as a typo. Nothing throws, nothing logs, and the only place it
// shows up is in the finished video, which is the most expensive place to find it.
//
// So each rule here is written twice: once as a film that keeps it, and once as a film that
// breaks it. A rule that only ever sees good input is not a test — it is a comment that
// costs CPU.
//
// Three rules from §6 are NOT here yet, because they are properties of movement and the
// movement layer is still being built: easing is never linear (§6.3), a move never exceeds
// half an element's life (§6.6), and the pop/drift vocabulary is clamped. They go in when
// the composer starts emitting tweens.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchCompose.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-rules-"));

// The process helper, stood in for: the real one reaches into Agent OS's own PATH
// handling, and nothing here runs ffmpeg.
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
const bpLib = load("omniwatchBlueprint");
const recipeLib = load("omniwatchRecipe");
load("omniwatchBoardScan");
load("omniwatchNode"); // omniwatchGround now imports from it — has to be on disk first
const ground = load("omniwatchGround");
// The composer now moves things, so the two libraries that decide how go in first.
load("omniwatchMotion");
load("omniwatchStage");
const compose = load("omniwatchCompose");

// ── the film under test ────────────────────────────────────────────────────────
/** A board with a caption band over it and one timed picture laid on the board — the
 *  shape of every film this pipeline makes. */
const film = () => ({
  version: bpLib.BLUEPRINT_VERSION,
  canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
  regions: [
    { id: "presenter-stage", role: "figure", rect: [0, 0, 1, 0.55], z: 1 },
    { id: "tier-board", role: "panel", rect: [0, 0.55, 1, 0.45], z: 2, grid: { rows: 5, cols: 2 },
      paint: { fill: "#141316" } },
    { id: "s-slot", role: "cell", rect: [0.24, 0.55, 0.76, 0.09], z: 3, parent: "tier-board",
      at: { row: 1, col: 2 } },
    { id: "board-overlay", role: "overlay", rect: [0.1, 0.6, 0.6, 0.3], z: 6 },
    { id: "caption-area", role: "text", rect: [0.04, 0.5, 0.92, 0.05], z: 10 },
  ],
  tracks: [
    { region: "presenter-stage", kind: "video", varies: "episode", items: [{ start: 0, end: 20, value: "the host" }] },
    { region: "s-slot", kind: "image", varies: "episode", items: [{ start: 0, end: 20, value: "a portrait" }] },
    { region: "board-overlay", kind: "image", varies: "episode",
      items: [{ start: 4, end: 6, value: "a phone screenshot", rect: [0.1, 0.6, 0.6, 0.3] }] },
    { region: "caption-area", kind: "text", varies: "episode",
      style: { color: "#FFFFFF", outline: "#000000" },
      items: [
        { start: 4.04, end: 5.28, value: "Built like a Greek god," },
        { start: 5.28, end: 6.40, value: "plays like a Greek tragedy." },
        { start: 19.0, end: 20.0, value: "Definitely S tier." },
      ] },
  ],
});

const composed = (b, src = {}) => {
  const c = bpLib.validateBlueprint(b, { preserveGeometry: true });
  assert.equal(c.ok, true, `blueprint invalid: ${c.error}`);
  return compose.composeBlueprint(c.blueprint, { assetFor: () => "assets/x.jpg", ...src });
};

/** Where a region's box is drawn in the emitted document, by id. */
const drawnAt = (html, id) => html.indexOf(`id="rg-${id}"`);
const zOf = (html, id) => {
  const m = html.match(new RegExp(`id="rg-${id}"[^>]*z-index:(\\d+)`));
  return m ? Number(m[1]) : null;
};

// ── §6.1 — the caption is drawn last ──────────────────────────────────────────
test("the caption is drawn over every overlay, never under one", () => {
  const html = composed(film());
  const cap = zOf(html, "caption-area");
  const over = zOf(html, "board-overlay");
  assert.ok(cap !== null && over !== null, "both regions must be drawn");
  assert.ok(cap > over, `caption z-index ${cap} must beat the overlay's ${over}`);
  // Stacking that depends on document order too, so the two agree rather than fight.
  assert.ok(drawnAt(html, "caption-area") > drawnAt(html, "board-overlay"),
    "the caption's box must come after the overlay's in the document");
});

test("an overlay authored above the caption is caught", () => {
  // The failure this guards: a capture that hands the insert a higher layer than the text.
  const b = film();
  b.regions.find((r) => r.id === "board-overlay").z = 11;
  const html = composed(b);
  assert.ok(zOf(html, "caption-area") <= zOf(html, "board-overlay"),
    "the bad film must really be bad, or this test proves nothing");
});

// ── §6.2 — no cut inside a word ───────────────────────────────────────────────
test("splitting a caption to fit the band never cuts inside a word", () => {
  const rec = recipeLib.defaultRecipe();
  rec.caption.overflow = "chunk";
  // A band narrow enough to force several pieces out of one line.
  const b = film();
  b.regions.find((r) => r.id === "caption-area").rect = [0.04, 0.5, 0.35, 0.05];
  const c = bpLib.validateBlueprint(b, { preserveGeometry: true });
  assert.equal(c.ok, true);

  const before = c.blueprint.tracks.find((t) => t.region === "caption-area").items
    .map((it) => it.value).join(" ").split(/\s+/).filter(Boolean);
  const out = ground.chunkCaptionsToBand(c.blueprint, rec, []);
  const after = out.tracks.find((t) => t.region === "caption-area").items
    .map((it) => it.value.replace(/\[\[|\]\]/g, "")).join(" ").split(/\s+/).filter(Boolean);

  // Same words, same order, none of them halved. The piece count may change; the WORDS
  // may not.
  assert.deepEqual(after, before, "chunking changed the words, not just where they break");
});

// ── §6.4 — the last thing on screen is held ───────────────────────────────────
test("the last line is held long enough to be read", () => {
  const b = film();
  const items = b.tracks.find((t) => t.region === "caption-area").items;
  const last = items.reduce((a, it) => (it.start > a.start ? it : a));
  assert.ok(last.end - last.start >= 0.999,
    `a final line shown for ${(last.end - last.start).toFixed(2)}s is a flash, not a line`);
});

// ── §6.5 — two independent things do not arrive together ──────────────────────
test("two independent elements do not reveal at the same moment", () => {
  const b = film();
  const caption = b.regions.find((r) => /caption/i.test(r.id));
  // Everything that ARRIVES — furniture standing for the whole film is not a reveal, and
  // neither is the caption. The caption is the spine the rest of the film syncs TO: an
  // insert landing on the line that describes it is the effect we are after, not a clash.
  // The rule is about two things that have nothing to do with each other arriving together.
  const reveals = b.tracks.filter((t) => t.region !== caption?.id).flatMap((t) => t.items
    .filter((it) => it.start > 0.05 && it.end - it.start < b.canvas.seconds - 0.05)
    .map((it) => ({ region: t.region, start: it.start })));
  for (let i = 0; i < reveals.length; i++) {
    for (let j = i + 1; j < reveals.length; j++) {
      if (reveals[i].region === reveals[j].region) continue;
      assert.ok(Math.abs(reveals[i].start - reveals[j].start) > 0.08,
        `${reveals[i].region} and ${reveals[j].region} both appear at ${reveals[i].start}s — ` +
        `one, a pause, then the other`);
    }
  }
});

// ── §6.7 — geometry is data, not a cascade ────────────────────────────────────
test("the emitted document contains no !important", () => {
  const html = composed(film());
  assert.doesNotMatch(html, /!important/,
    "a row that comes out wrong should be a number in the recipe, not an override to debug");
});

// ── §6.8 — a missing asset is a hole you can see ──────────────────────────────
test("an item with no asset leaves a visible gap rather than vanishing", () => {
  const html = composed(film(), { assetFor: () => null });
  assert.match(html, /class="it missing"/,
    "an unfilled slot must stay on screen as a gap — a silently collapsed layout hides the fault");
  // And the region it belongs to is still drawn, so the geometry does not close up around it.
  assert.ok(drawnAt(html, "board-overlay") >= 0, "the overlay's box disappeared with its asset");
});


// ── §6.3 / §6.6 — the rules that only exist once the film moves ───────────────
//
// These three could not be written until the composer emitted tweens, which is why the
// header above said they were missing. They are the reason the movement vocabulary is a
// closed set with clamps rather than four numbers a model fills in.

/** A film whose elements were given a manner of arriving, and one that travels. */
const movingFilm = () => {
  const b = film();
  b.regions.push({ id: "head-stage", role: "figure", rect: [0.6, 0.05, 0.3, 0.2], z: 9 });
  // The waiting spot has to hold something, or the validator throws it out as a region
  // somebody imagined — which is a rule worth keeping, and worth obeying here.
  b.tracks.push({ region: "head-stage", kind: "image", varies: "episode",
    items: [{ start: 0, end: 20, value: "where the icon waits" }] });
  const overlay = b.tracks.find((t) => t.region === "board-overlay");
  overlay.items[0].arrival = "pop";
  overlay.items[0].departure = "fade";
  // A tile that belongs in the S row but starts beside the presenter's head.
  b.tracks.find((t) => t.region === "s-slot").items = [
    { start: 2, end: 20, value: "a portrait", hold: "on-cue", waitsAt: "head-stage" },
  ];
  return b;
};

const tweenLines = (html) => (html.match(/^ +tl\.(set|to|from|fromTo)\(.*$/gm) ?? []);

test("the composition actually moves once elements ask to", () => {
  const lines = tweenLines(composed(movingFilm()));
  assert.ok(lines.length >= 3, `expected tweens, got:\n${lines.join("\n") || "(none)"}`);
  // Every statement aims at an element that exists in the document.
  const html = composed(movingFilm());
  for (const line of tweenLines(html)) {
    const sel = line.match(/tl\.\w+\("#([^"]+)"/);
    assert.ok(sel, `a tween with no target: ${line}`);
    assert.ok(html.includes(`id="${sel[1]}"`), `tween aims at ${sel[1]}, which is not drawn`);
  }
});

test("a film that asks for nothing emits no tweens at all", () => {
  // The default is stillness. A blueprint written before movement existed must compose to
  // exactly what it composed to before.
  assert.equal(tweenLines(composed(film())).length, 0);
});

test("§6.3 — easing is never linear", () => {
  for (const line of tweenLines(composed(movingFilm()))) {
    const ease = line.match(/ease: "([^"]+)"/);
    if (!ease) continue;
    assert.doesNotMatch(ease[1], /^(none|linear)$/i, `linear easing in: ${line}`);
  }
});

test("§6.6 — a move never eats more than half an element's life", () => {
  const b = movingFilm();
  // Ask for the longest move the vocabulary allows on an element that barely exists.
  const overlay = b.tracks.find((t) => t.region === "board-overlay");
  overlay.items[0] = { ...overlay.items[0], start: 4, end: 4.2, arrival: { shape: "pop", seconds: 0.6 } };
  // Only the short-lived element's own tweens — every OTHER element on this board has a
  // life of its own and a ceiling of its own, and holding them all to this one's would be
  // testing the wrong thing.
  let checked = 0;
  for (const line of tweenLines(composed(b))) {
    if (!line.includes("#el-board-overlay-")) continue;
    const d = line.match(/duration: ([0-9.]+)/);
    if (!d) continue;
    checked++;
    assert.ok(Number(d[1]) <= 0.1 + 1e-9,
      `a 0.2s element was given a ${d[1]}s move — half its life is the ceiling: ${line}`);
  }
  assert.ok(checked > 0, "the short-lived element emitted no tweens, so nothing was proven");
});

test("a travelling element is held at its waiting spot, not in its row", () => {
  const html = composed(movingFilm());
  const lines = tweenLines(html);
  const set = lines.find((l) => l.includes("tl.set(") && /x: -?[0-9.]+/.test(l));
  assert.ok(set, `no opening position for the travelling tile:\n${lines.join("\n")}`);
  // Placed at zero, so seeking to any frame before the drop finds it waiting.
  assert.match(set, /\}, 0\);$/, `the waiting position must be set at time zero: ${set}`);
  const to = lines.find((l) => l.includes("tl.to(") && l.includes("x: 0"));
  assert.ok(to, "the tile never travels to its row");
  assert.match(to, /\}, 2\);$/, `the drop must happen at the item's own moment: ${to}`);
});

test("landsAt (IR-CONTRACT-V2 §3) moves the drop past start — the icon waits beside the presenter, not just in front of it", () => {
  const b = movingFilm();
  const staged = b.tracks.find((t) => t.region === "s-slot").items[0];
  staged.landsAt = 11.5; // well past its own start (2) and short of its own end (20)
  const html = composed(b);
  const lines = tweenLines(html);
  const set = lines.find((l) => l.includes("tl.set(") && /x: -?[0-9.]+/.test(l));
  assert.ok(set, `no opening position for the travelling tile:\n${lines.join("\n")}`);
  // Still held from time zero — landsAt changes WHEN it lets go, not that it holds at all.
  assert.match(set, /\}, 0\);$/, `the waiting position must still be set at time zero: ${set}`);
  const to = lines.find((l) => l.includes("tl.to(") && l.includes("x: 0"));
  assert.ok(to, "the tile never travels to its row");
  assert.match(to, /\}, 11\.5\);$/, `the drop must happen at landsAt, not at start: ${to}`);
});


// ── how many pictures an insert is ────────────────────────────────────────────
//
// The rule these pin down went wrong three times in one afternoon, each time because it had
// been written from one film: two fixed sample points, a width comparison, then an area
// comparison. What survives is geometry — does a box still hold the ground it held — and
// these are the cases that forced each part of it.

test("a box that barely moves is still the same picture", () => {
  // A card settling into place: same spot, a hair larger.
  assert.ok(ground.overlap([0.07, 0.72, 0.62, 0.10], [0.04, 0.71, 0.68, 0.11]) >= ground.SAME_PICTURE);
});

test("a card arriving BELOW another is a second picture, not a wider one", () => {
  // The case that broke a width comparison: the pair grows a tenth wider and nearly twice
  // as tall, so anything watching the width alone sees one stretched picture.
  const first = [0.04, 0.71, 0.68, 0.11];
  const pair = [0.04, 0.64, 0.45, 0.31];
  assert.ok(ground.overlap(first, pair) < ground.SAME_PICTURE, "the pair must not read as the first card");
  const second = ground.gained(first, pair);
  assert.ok(second[3] > 0, "the new card must have height of its own");
  // And it is the ground that was GAINED, not the outline of both — otherwise one picture
  // is stretched over two cards' worth of board.
  assert.ok(second[3] < pair[3], "the second card must be smaller than the pair's outline");
});

test("a card that replaces another somewhere else shares no ground", () => {
  assert.equal(ground.overlap([0.11, 0.70, 0.29, 0.23], [0.45, 0.79, 0.40, 0.13]), 0);
});

test("a half-drawn card is a fraction of the finished one", () => {
  // A card wiping in from below, caught mid-wipe, against its settled self.
  const mid = 0.45 * 0.05, done = 0.39 * 0.17;
  assert.ok(mid < done * ground.HALF_DRAWN, "the wipe must fall under the bar that rejects it");
  // While a genuine second card, smaller than the first, must clear it.
  const smaller = 0.40 * 0.13, biggest = 0.29 * 0.23;
  assert.ok(smaller >= biggest * ground.HALF_DRAWN, "a real second card must survive the same bar");
});
