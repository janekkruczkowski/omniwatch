// Where a staged item waits, and where it lands.
//
//   node --test agent-os-module/test/stage.test.mjs
//
// The reference's tier board fills in as the video goes — a subject's icon sits beside the
// presenter, then lands in its row when the verdict lands. Today's renderer draws every tile
// in its row from frame one, which is why a clone reads as a static wallpaper. `hold` and
// `waitsAt` (IR-CONTRACT-V2 §3, omniwatchBlueprint) are the fields that say otherwise, and
// omniwatchStage is the geometry that answers them: where does the icon wait, where does it
// land, and when does it move.
//
// No fixtures, no video: a tier board is built here the same way test/blueprint.test.mjs and
// test/recipe.test.mjs build theirs, because the thing under test is arithmetic over a
// blueprint's own rects, not anything that needs a real frame.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchStage.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-stage-"));

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
const bp = load("omniwatchBlueprint");
const stage = load("omniwatchStage");

/** A minimal tier board: a presenter above, a two-cell board below (one row, two columns —
 *  a label cell and a slot cell), and a spot off to the side an icon could wait at. Small on
 *  purpose; every geometric fact a test needs is a rect on one of these five regions. */
function tierBoard(extraRegions = []) {
  return {
    version: bp.BLUEPRINT_VERSION,
    canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
    regions: [
      { id: "host", role: "figure", label: "presenter", rect: [0.1, 0.05, 0.8, 0.4], z: 1 },
      { id: "board", role: "panel", label: "tier board", rect: [0, 0.55, 1, 0.4], z: 2, grid: { rows: 1, cols: 2 } },
      { id: "s-label", role: "cell", label: "S row label", rect: [0, 0.55, 0.15, 0.2], z: 3, parent: "board", at: { row: 1, col: 1 } },
      { id: "s-slot", role: "cell", label: "S row slot", rect: [0.15, 0.55, 0.85, 0.2], z: 3, parent: "board", at: { row: 1, col: 2 } },
      // Painted rather than tracked — a spot an icon waits at needs no content of its own,
      // only a place, and `validateBlueprint` refuses a region that carries neither a track
      // nor a paint nor a child ("every region must carry something").
      { id: "stage-spot", role: "overlay", label: "where subjects wait", rect: [0.02, 0.06, 0.18, 0.12], z: 5, paint: { fill: "#202020" } },
      ...extraRegions,
    ],
    tracks: [
      { region: "host", kind: "video", varies: "fixed", items: [{ start: 0, end: 20, value: "a presenter" }] },
      { region: "board", kind: "image", varies: "fixed", items: [{ start: 0, end: 20, value: "a tier board, one row" }] },
      { region: "s-label", kind: "text", varies: "fixed", items: [{ start: 0, end: 20, value: "S" }] },
    ],
  };
}

test("hold on-cue with a declared waitsAt region: the waiting box IS that region, the final box is its own row, and they differ", () => {
  const film = tierBoard();
  const track = {
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 6.4, end: 12, value: "a trophy icon", hold: "on-cue", waitsAt: "stage-spot" }],
  };
  film.tracks.push(track);
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);

  const slotTrack = checked.blueprint.tracks.find((t) => t.region === "s-slot");
  const item = slotTrack.items[0];
  assert.equal(item.hold, "on-cue");
  assert.equal(item.waitsAt, "stage-spot");

  const out = stage.stageItem(checked.blueprint, slotTrack, item);
  assert.equal(out.ok, true, out.ok ? "" : out.reason);
  assert.equal(out.stage.source, "waits-at-region");
  assert.deepEqual(out.stage.waiting, [0.02, 0.06, 0.18, 0.12], "waiting box is the named region's own measured rect");
  assert.deepEqual(out.stage.final, [0.15, 0.55, 0.85, 0.2], "final box is the row cell the track paints into");
  assert.notDeepEqual(out.stage.waiting, out.stage.final, "an item cannot wait where it also lands");
  assert.equal(out.stage.moves, 6.4, "moves at the item's own start, not invented");
  assert.ok(out.notes.some((n) => /measured, not derived/.test(n)), out.notes.join(" | "));
});

test("waitsAt names a spot nothing declared: the waiting box is derived from the presenter, still different from the row", () => {
  const film = tierBoard();
  const track = {
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 3, end: 9, value: "a boot icon", hold: "on-cue", waitsAt: "beside-the-head" }],
  };
  film.tracks.push(track);
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
  const slotTrack = checked.blueprint.tracks.find((t) => t.region === "s-slot");
  const item = slotTrack.items[0];

  const out = stage.stageItem(checked.blueprint, slotTrack, item);
  assert.equal(out.ok, true, out.ok ? "" : out.reason);
  assert.equal(out.stage.source, "presenter-corner");
  const [hx, hy, hw, hh] = [0.1, 0.05, 0.8, 0.4]; // host rect, from tierBoard()
  const [wx, wy, ww, wh] = out.stage.waiting;
  assert.ok(wx >= hx - 1e-9 && wx + ww <= hx + hw + 1e-9, "waiting box sits inside the presenter's own width");
  assert.ok(wy >= hy - 1e-9 && wy + wh <= hy + hh + 1e-9, "waiting box sits inside the presenter's own height");
  assert.ok(ww > 0 && wh > 0);
  assert.notDeepEqual(out.stage.waiting, out.stage.final, "still not the same box as its row");
  assert.ok(out.notes.some((n) => /not a declared region/.test(n)), out.notes.join(" | "));
});

test("an item with no hold or waitsAt is untouched — validates and renders exactly as today", () => {
  const film = tierBoard();
  film.tracks.push({
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 1, end: 5, value: "a plain tile, no new fields" }],
  });
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);

  const slotTrack = checked.blueprint.tracks.find((t) => t.region === "s-slot");
  const item = slotTrack.items[0];
  // Byte-identical to what today's schema already produced: no hold, no waitsAt key at all.
  assert.deepEqual(item, { start: 1, end: 5, value: "a plain tile, no new fields" });
  assert.equal("hold" in item, false);
  assert.equal("waitsAt" in item, false);
  assert.equal(stage.needsStaging(item), false);

  const out = stage.stageItem(checked.blueprint, slotTrack, item);
  assert.equal(out.ok, false);
  assert.match(out.reason, /from-start/);
});

test("junk in hold or waitsAt does not throw — it falls back to the default, nothing staged", () => {
  const film = tierBoard();
  film.tracks.push({
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 0, end: 20, value: "a plain tile" }],
  });
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
  const slotTrack = checked.blueprint.tracks.find((t) => t.region === "s-slot");

  // Hand-built, the way every other test file in this repo builds its own fixtures — bypasses
  // the TypeScript types entirely, which is exactly the case omniwatchStage has to survive.
  const junkHold = { start: 1, end: 2, value: "x", hold: "spaghetti", waitsAt: "stage-spot" };
  assert.equal(stage.needsStaging(junkHold), false);
  let out;
  assert.doesNotThrow(() => { out = stage.stageItem(checked.blueprint, slotTrack, junkHold); });
  assert.equal(out.ok, false);
  assert.match(out.reason, /spaghetti/);

  const junkWaitsAt = { start: 1, end: 2, value: "x", hold: "on-cue", waitsAt: 42 };
  assert.equal(stage.needsStaging(junkWaitsAt), false);
  assert.doesNotThrow(() => { out = stage.stageItem(checked.blueprint, slotTrack, junkWaitsAt); });
  assert.equal(out.ok, false);

  const emptyWaitsAt = { start: 1, end: 2, value: "x", hold: "on-cue", waitsAt: "   " };
  assert.equal(stage.needsStaging(emptyWaitsAt), false);
  assert.doesNotThrow(() => { out = stage.stageItem(checked.blueprint, slotTrack, emptyWaitsAt); });
  assert.equal(out.ok, false);
});

test("validateBlueprint refuses a hold value outside the closed set, the way a bad rect is refused", () => {
  const film = tierBoard();
  film.tracks.push({
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 1, end: 5, value: "x", hold: "teleport" }],
  });
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, false);
  assert.match(checked.error, /hold must be one of/);
});

test("validateBlueprint refuses a waitsAt that is not a region-shaped string", () => {
  const film = tierBoard();
  film.tracks.push({
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 1, end: 5, value: "x", hold: "on-cue", waitsAt: "Not A Valid Id!" }],
  });
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, false);
  assert.match(checked.error, /waitsAt must look like a region id/);
});

test("a blueprint with no presenter region still validates, and staging reports a note instead of crashing", () => {
  const film = {
    version: bp.BLUEPRINT_VERSION,
    canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
    regions: [
      { id: "board", role: "panel", rect: [0, 0.55, 1, 0.4], z: 2, grid: { rows: 1, cols: 1 } },
      { id: "s-slot", role: "cell", rect: [0, 0.55, 1, 0.2], z: 3, parent: "board", at: { row: 1, col: 1 } },
    ],
    tracks: [
      { region: "board", kind: "color", varies: "fixed", items: [{ start: 0, end: 20, value: "#141316" }] },
      {
        region: "s-slot", kind: "image", varies: "episode",
        items: [{ start: 4, end: 9, value: "a subject icon", hold: "on-cue", waitsAt: "nowhere-declared" }],
      },
    ],
  };
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
  assert.equal(stage.findPresenter(checked.blueprint), null);

  const slotTrack = checked.blueprint.tracks.find((t) => t.region === "s-slot");
  const item = slotTrack.items[0];
  let out;
  assert.doesNotThrow(() => { out = stage.stageItem(checked.blueprint, slotTrack, item); });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no region to measure/);
  assert.ok(out.notes.length > 0, "a reason must be visible, not just a false");
  assert.ok(out.notes.some((n) => /no presenter/.test(n)), out.notes.join(" | "));
});

// ── landsAt (IR-CONTRACT-V2 §3's own gap) ──────────────────────────────────────

test("an item with no landsAt moves exactly as before — the default is byte-for-byte unchanged", () => {
  const film = tierBoard();
  const track = {
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 6.4, end: 12, value: "a trophy icon", hold: "on-cue", waitsAt: "stage-spot" }],
  };
  film.tracks.push(track);
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
  const slotTrack = checked.blueprint.tracks.find((t) => t.region === "s-slot");
  const item = slotTrack.items[0];
  assert.equal("landsAt" in item, false, "no landsAt key at all — this is what every blueprint written before today produces");

  const out = stage.stageItem(checked.blueprint, slotTrack, item);
  assert.equal(out.ok, true, out.ok ? "" : out.reason);
  assert.equal(out.stage.moves, item.start, "moves at the item's own start, exactly today's behaviour");
});

test("an item with landsAt later than start stays at the waiting box until that second, not until start", () => {
  const film = tierBoard();
  const track = {
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 6.4, end: 12, value: "a trophy icon", hold: "on-cue", waitsAt: "stage-spot", landsAt: 9.8 }],
  };
  film.tracks.push(track);
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
  const slotTrack = checked.blueprint.tracks.find((t) => t.region === "s-slot");
  const item = slotTrack.items[0];
  assert.equal(item.landsAt, 9.8);

  const out = stage.stageItem(checked.blueprint, slotTrack, item);
  assert.equal(out.ok, true, out.ok ? "" : out.reason);
  assert.equal(out.stage.moves, 9.8, "the item waits well past its own start before it travels");
  assert.notEqual(out.stage.moves, item.start, "landsAt, once present, is what decides the moment — not start");
});

test("validateBlueprint refuses a landsAt before start or after end — a value outside the item's own window was never measured from anything", () => {
  const filmBefore = tierBoard();
  filmBefore.tracks.push({
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 6.4, end: 12, value: "x", hold: "on-cue", waitsAt: "stage-spot", landsAt: 3 }],
  });
  const before = bp.validateBlueprint(filmBefore, { preserveGeometry: true });
  assert.equal(before.ok, false);
  assert.match(before.error, /landsAt must fall between start and end/);

  const filmAfter = tierBoard();
  filmAfter.tracks.push({
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 6.4, end: 12, value: "x", hold: "on-cue", waitsAt: "stage-spot", landsAt: 15 }],
  });
  const after = bp.validateBlueprint(filmAfter, { preserveGeometry: true });
  assert.equal(after.ok, false);
  assert.match(after.error, /landsAt must fall between start and end/);
});

test("stageItem still clamps a landsAt outside [start, end] for a hand-built blueprint that skipped validation", () => {
  // Every other test file in this repo builds its own blueprint by hand, bypassing
  // validateBlueprint entirely — omniwatchStage has to survive that, the same defence
  // needsStaging already has for junk hold/waitsAt values.
  const film = tierBoard();
  const track = {
    region: "s-slot", kind: "image", varies: "episode",
    items: [{ start: 6.4, end: 12, value: "x", hold: "on-cue", waitsAt: "stage-spot" }],
  };
  film.tracks.push(track);
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
  const slotTrack = checked.blueprint.tracks.find((t) => t.region === "s-slot");
  const tooEarly = { ...slotTrack.items[0], landsAt: 3 };
  const tooLate = { ...slotTrack.items[0], landsAt: 15 };

  const earlyOut = stage.stageItem(checked.blueprint, slotTrack, tooEarly);
  assert.equal(earlyOut.ok, true, earlyOut.ok ? "" : earlyOut.reason);
  assert.equal(earlyOut.stage.moves, 6.4, "clamped up to the item's own start");

  const lateOut = stage.stageItem(checked.blueprint, slotTrack, tooLate);
  assert.equal(lateOut.ok, true, lateOut.ok ? "" : lateOut.reason);
  assert.equal(lateOut.stage.moves, 12, "clamped down to the item's own end");
});

test("stageBlueprint walks every staged item in the film and leaves the rest alone", () => {
  const film = tierBoard();
  film.tracks.push({
    region: "s-slot", kind: "image", varies: "episode",
    items: [
      { start: 2, end: 6, value: "untouched tile" },
      { start: 8, end: 14, value: "staged tile", hold: "on-cue", waitsAt: "stage-spot" },
    ],
  });
  const checked = bp.validateBlueprint(film, { preserveGeometry: true });
  assert.equal(checked.ok, true, checked.ok ? "" : checked.error);

  const results = stage.stageBlueprint(checked.blueprint);
  assert.equal(results.length, 1, "only the staged item is walked");
  assert.equal(results[0].item.value, "staged tile");
  assert.equal(results[0].outcome.ok, true);
});
