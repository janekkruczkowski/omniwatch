// The recipe, the scan that fills it, and the composer that draws from it.
//
//   node --test agent-os-module/test/recipe.test.mjs
//
// The render kept being nearly right, and every near miss was a number the composer had
// decided for itself: a letter column of "about sixteen percent", a caption stroke of "about
// three pixels", a tier letter in a poster face because nothing said otherwise. The fix was
// to make those numbers data and to measure the ones that can be counted. So the cases here
// are, in order: the contract survives whatever a model writes into it; the scan counts a
// board correctly AND refuses a frame that has no board in it; the composer draws exactly
// what the recipe says.
//
// The board is synthesised as raw pixels rather than loaded from a fixture. A tier list is
// flat colour, so a frame that is made of flat colour is not a simplification of the real
// case — and a test that builds its own subject says what it is testing.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchRecipe.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-recipe-"));

// The scan reaches for ffmpeg only to decode a file; every case here hands it pixels, so the
// process helper is stubbed rather than run.
writeFileSync(path.join(dir, "omniwatch.js"), `exports.run = async () => "";\n`);
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
const scan = load("omniwatchBoardScan");
const recipeLib = load("omniwatchRecipe");
// The composer now moves things, so the two libraries that decide how go in first.
load("omniwatchMotion");
load("omniwatchStage");
const compose = load("omniwatchCompose");

// ── a board, as pixels ─────────────────────────────────────────────────────────
const W = 720, H = 1280;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** A tier board drawn into a raw RGB buffer: five plates, a letter column, square tiles.
 *
 *  `tiles` says how many each row holds, so the case where the scan has to COUNT them is the
 *  same case that says what the answer should be. */
function drawBoard({
  top = 704, rowH = 113, gap = 3, labelW = 174,
  fills = ["#ec5d4f", "#ed9f4b", "#eec74c", "#eae254", "#a6da7a"],
  slotBg = "#2b2b2f", boardBg = "#121215", tiles = [1, 1, 2, 2, 3],
  tileGap = 4, tilePad = 0, letterCap = 25,
} = {}) {
  const data = Buffer.alloc(W * H * 3);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
  };
  const rect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, c);
  };
  // Above the board: something that is not the board, so the scan has to find its top edge.
  rect(0, 0, W, H, hex("#5a7f99"));
  rect(0, top - gap, W, H - top + gap, hex(boardBg));
  fills.forEach((fill, i) => {
    const y = top + i * (rowH + gap);
    rect(0, y, labelW, rowH, hex(fill));
    // The letter: a dark block of the cap height a real capital would have.
    const lw = Math.round(letterCap * 0.7);
    rect(Math.round(labelW / 2 - lw / 2), Math.round(y + rowH / 2 - letterCap / 2), lw, letterCap, hex("#27272a"));
    const slotX = labelW + gap;
    rect(slotX, y, W - slotX, rowH, hex(slotBg));
    const tileH = Math.round(rowH * 0.955);
    const tileTop = y + Math.round((rowH - tileH) / 2);
    for (let k = 0; k < tiles[i]; k++) {
      const x = slotX + tilePad + k * (tileH + tileGap);
      // Each tile a different shade, so merging two into one would show as a miscount.
      rect(x, tileTop, tileH, tileH, [200 - k * 40, 170 + k * 20, 120 + k * 30]);
    }
  });
  return { width: W, height: H, data };
}

test("the board's grid is counted off the pixels, not divided evenly", () => {
  const px = drawBoard();
  const m = scan.scanBoard(px, [0, 0.55, 1, 0.45]);
  assert.ok(m, "a board drawn as flat colour must be measurable");
  // The letter column: 174 of 720 — the number four rounds of CSS had as "about 0.16".
  assert.ok(Math.abs(m.labelRatio - 174 / 720) < 0.01, `labelRatio ${m.labelRatio}`);
  assert.equal(m.rows.length, 5);
  assert.deepEqual(m.rows.map((r) => r.thumbs.length), [1, 1, 2, 2, 3]);
  assert.equal(m.rows[0].fill.toLowerCase(), "#ec5d4f");
  assert.ok(Math.abs(m.rowGap - 3 / H) < 0.002, `rowGap ${m.rowGap}`);
  assert.ok(Math.abs(m.thumb.aspect - 1) < 0.1, `aspect ${m.thumb.aspect}`);
  assert.ok(m.thumb.heightRatio > 0.9 && m.thumb.heightRatio <= 1, `heightRatio ${m.thumb.heightRatio}`);
  // A capital of 25px in a row of 113 is 0.22 of it.
  assert.ok(Math.abs(m.letterCapRatio - 25 / 113) < 0.03, `letterCapRatio ${m.letterCapRatio}`);
});

test("a frame with no board in it is refused, rather than measured anyway", () => {
  // Bands of the right sort of colour at the wrong sort of spacing: a wall, a desk, a poster.
  // Ranking windows always yields a best one; the question is whether the best one is a grid.
  const px = drawBoard({ rowH: 30 });
  const data = Buffer.from(px.data);
  const put = (x, y, c) => { const i = (y * W + x) * 3; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
  // Stretch one band to four times the others — same colours, no longer a grid.
  for (let y = 800; y < 1000; y++) for (let x = 0; x < W; x++) put(x, y, hex("#ed9f4b"));
  const m = scan.scanBoard({ width: W, height: H, data }, [0, 0.55, 1, 0.45]);
  assert.equal(m, null);
});

test("a recipe is filled in from whatever a model wrote, and never throws", () => {
  for (const junk of [null, undefined, 42, "nonsense", [], { tiers: "no" }, { banner: 7 }]) {
    const r = recipeLib.normalizeRecipe(junk, { width: 720, height: 1280 });
    assert.equal(r.version, recipeLib.RECIPE_VERSION);
    assert.equal(r.tiers.length, 5);
    assert.ok(r.board.labelRatio > 0 && r.board.labelRatio < 0.5);
    assert.match(r.caption.type.ink, /^#[0-9a-fA-F]{6}$/);
  }
});

test("a plate said to be absent is absent, and a pixel stroke becomes a fraction", () => {
  const r = recipeLib.normalizeRecipe({
    banner: { hasPlate: false, fill: "#ffffff" },
    // The shape the first recipe pass answered in: a transparent hex meaning "no plate",
    // and a stroke quoted in pixels of a 1280-high frame.
    caption: { background: "#00000000", hasBackdropPlate: false, strokeWidth: 5, strokeColor: "#000000" },
  }, { width: 720, height: 1280 });
  assert.equal(r.banner.plate, null);
  assert.equal(r.caption.type.plate, null);
  assert.ok(r.caption.type.stroke, "a stroke was named and must survive");
  assert.ok(Math.abs(r.caption.type.stroke.width - 5 / 1280) < 1e-6, `stroke ${r.caption.type.stroke.width}`);
});

test("the band behind a title is the region's, not the words'", () => {
  // The model answers banner.plate with the colour of the BAND. Passing the banner's fields
  // straight into its type handed that colour to the words as well, and the title came out on
  // a second, narrower plate sitting on the first — visible as a white box inside a cream bar.
  const r = recipeLib.normalizeRecipe({
    banner: { plate: "#eeefe3", textColor: "#111111", face: "grotesque-black", weight: 900 },
  }, { width: 720, height: 1280 });
  assert.equal(r.banner.plate, "#eeefe3", "the band keeps its colour");
  assert.equal(r.banner.type.plate, null, "the words carry no plate of their own");
  // A plate behind the words ALONE is still sayable, it just has to be said separately.
  const named = recipeLib.normalizeRecipe({
    banner: { plate: "#eeefe3", textPlate: "#ffffff" },
  }, { width: 720, height: 1280 });
  assert.equal(named.banner.type.plate, "#ffffff");
});

test("measurements beat the model, and a cap height is not a font size", () => {
  const px = drawBoard();
  const m = scan.scanBoard(px, [0, 0.55, 1, 0.45]);
  const authored = recipeLib.normalizeRecipe({
    board: { labelRatio: 0.16 },
    tiers: [{ id: "s", letter: "S", fill: "#ff0000" }],
  }, { width: 720, height: 1280 });
  const notes = [];
  const merged = recipeLib.applyMeasure(authored, m, notes);
  assert.ok(Math.abs(merged.board.labelRatio - 174 / 720) < 0.01, "the counted column wins over the stated one");
  assert.equal(merged.tiers[0].fill.toLowerCase(), "#ec5d4f");
  assert.equal(merged.tiers[0].count, 1);
  // 25px of capital in a 113px row is 0.22 of the row; the type is set at 0.22 / 0.72.
  assert.ok(Math.abs(merged.label.sizeRatioOfRow - (25 / 113) / recipeLib.CAP_OF_EM) < 0.05,
    `sizeRatioOfRow ${merged.label.sizeRatioOfRow}`);
  assert.ok(notes.some((n) => /measured board/.test(n)), notes.join(" | "));
});

test("lettering that measures narrower than its face is set in a narrower one", () => {
  // 18 characters filling 395px at a 50px em is 0.44 of the em each — which is a condensed
  // face, whatever the model called it. Same measurement against the face it already has
  // returns nothing, because there is nothing to correct.
  assert.equal(recipeLib.faceFromWidth("grotesque-black", 18, 395, 50), "condensed-black");
  assert.equal(recipeLib.faceFromWidth("grotesque-black", 18, 560, 50), null);
  assert.equal(recipeLib.faceFromWidth("grotesque-black", 3, 60, 50), null, "three letters is not evidence");
});

// ── the composer, drawing only what it was given ───────────────────────────────
const tierBlueprint = () => ({
  version: bp.BLUEPRINT_VERSION,
  canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
  regions: [
    { id: "tier-board", role: "panel", rect: [0, 0.55, 1, 0.45], z: 2, grid: { rows: 1, cols: 2 } },
    { id: "s-label", role: "cell", rect: [0, 0.55, 0.24, 0.088], z: 3, parent: "tier-board", at: { row: 1, col: 1 } },
    { id: "s-slot", role: "cell", rect: [0.245, 0.55, 0.755, 0.088], z: 3, parent: "tier-board", at: { row: 1, col: 2 } },
  ],
  tracks: [
    { region: "s-label", kind: "text", varies: "fixed", fill: "draw", items: [{ start: 0, end: 20, value: "S" }] },
    { region: "s-slot", kind: "image", varies: "episode", fill: "generate",
      items: [{ start: 0, end: 20, value: "one" }, { start: 0, end: 20, value: "two" }] },
  ],
});

test("a tier row is drawn from the recipe's numbers, not from a stylesheet", () => {
  const c = bp.validateBlueprint(tierBlueprint(), { preserveGeometry: true });
  assert.equal(c.ok, true, c.error);
  const recipe = recipeLib.normalizeRecipe({
    board: { slotBackground: "#2b2b2f" },
    label: { sizeRatioOfRow: 0.31, ink: "#27272a", face: "grotesque", weight: 400 },
    thumb: { heightRatio: 0.955, radiusRatio: 0.11, gap: 0.0055, padX: 0, aspect: 1 },
    tiers: [{ id: "s", letter: "S", fill: "#ec5d4f" }],
  }, { width: 720, height: 1280 });
  const html = compose.composeBlueprint(c.blueprint, {
    recipe, assetFor: (_t, _i, n) => `assets/face-${n}.png`,
  });

  // The plate is the recipe's fill, and the letter is set at the recipe's share of the row.
  assert.match(html, /id="rg-s-label"[^>]*background:#ec5d4f/);
  const rowH = 0.088 * 1280;
  const expected = Math.round(rowH * 0.31);
  assert.match(html, new RegExp(`font-size:${expected}px`), `letter should be ${expected}px`);
  assert.match(html, /font-family:'Helvetica Neue'/);

  // Two items in the row mean two tiles, each a square of the row's height, a gap apart.
  const tiles = [...html.matchAll(/<img class="med tile"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tiles.length, 2);
  const size = Math.round(rowH * 0.955 * 100) / 100;
  assert.match(tiles[0], new RegExp(`width:${size}px;height:${size}px`));
  const left = (s) => Number(/left:([\d.]+)px/.exec(s)[1]);
  assert.ok(Math.abs((left(tiles[1]) - left(tiles[0])) - (size + 0.0055 * 720)) < 0.5,
    `tiles should sit a tile and a gap apart, got ${left(tiles[1]) - left(tiles[0])}`);

  // The tile assets are asked for by POSITION in the row, which is what a caller can predict.
  assert.match(tiles[0], /face-0\.png/);
  assert.match(tiles[1], /face-1\.png/);

  // And the rules that used to do this job by force are gone.
  assert.doesNotMatch(html, /!important/);
});

test("without a recipe the old path still draws, so other formats keep working", () => {
  const c = bp.validateBlueprint(tierBlueprint(), { preserveGeometry: true });
  const html = compose.composeBlueprint(c.blueprint, { assetFor: () => null });
  assert.match(html, /id="rg-s-label"/);
  assert.doesNotMatch(html, /class="med tile"/);
});
