// Colour, type and where a slot's content comes from.
//
//   node --test agent-os-module/test/style.test.mjs
//
// These three were missing when a reference was cloned with a new subject, and the film
// came back the right shape and the wrong film: a black-on-white title drawn white on
// black, an emphasised word drawn flat, and five coloured tier rows sent to an image model
// which returned five photographs of tier lists. Every case here is one of those.

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
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-style-"));

function load(name, rewrite = (s) => s) {
  const file = path.join(SOURCE, "lib", `${name}.ts`);
  const out = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
    // Every sibling library, not one named one: the composer now reads the recipe, and a
    // loader that rewrote a single import silently stopped resolving the moment it did.
    .replace(/require\("@\/lib\/([A-Za-z0-9_]+)"\)/g, 'require("./$1.js")');
  writeFileSync(path.join(dir, `${name}.js`), rewrite(out));
  return req(path.join(dir, `${name}.js`));
}
const bp = load("omniwatchBlueprint");
load("omniwatchRecipe");
// The composer now moves things, so the two libraries that decide how go in first.
load("omniwatchMotion");
load("omniwatchStage");
const compose = load("omniwatchCompose");

/** A tier row: a coloured rectangle with a letter on it. The case the schema was missing. */
const row = () => ({
  version: bp.BLUEPRINT_VERSION,
  canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
  regions: [
    { id: "board", role: "panel", rect: [0, 0.54, 1, 0.46], z: 5, grid: { rows: 5, cols: 2 } },
    { id: "s-label", role: "cell", rect: [0, 0.54, 0.13, 0.09], z: 6, parent: "board", at: { row: 1, col: 1 },
      paint: { fill: "#F2796B", border: { color: "#000000", width: 0.02 } } },
    { id: "cap", role: "text", rect: [0.08, 0.46, 0.84, 0.07], z: 7 },
  ],
  tracks: [
    { region: "s-label", kind: "text", varies: "fixed", fill: "draw",
      style: { color: "#111111", font: "display", weight: 900, size: 0.05, align: "center" },
      items: [{ start: 0, end: 20, value: "S" }] },
    { region: "cap", kind: "text", varies: "episode",
      style: { color: "#FFFFFF", outline: "#000000", emphasis: { style: "highlight", color: "#2F6BFF" } },
      items: [{ start: 6, end: 7, value: "plays like a Greek [[tragedy.]]" }] },
  ],
});

test("a region carries its own surface, and it survives validation", () => {
  const c = bp.validateBlueprint(row());
  assert.equal(c.ok, true);
  const label = c.blueprint.regions.find((r) => r.id === "s-label");
  assert.equal(label.paint.fill, "#F2796B");
  assert.equal(label.paint.border.width, 0.02);
});

test("a colour that is not a plain hex is refused, never escaped", () => {
  for (const bad of ["url(x)", "red", "#12", "rgb(1,2,3)", "#00ff00;background:url(x)"]) {
    const b = row();
    b.regions[1].paint.fill = bad;
    const c = bp.validateBlueprint(b);
    assert.equal(c.ok, false, `accepted ${bad}`);
    assert.match(c.error, /hex colour/);
  }
});

test("a rectangle may not be sent to an image model", () => {
  const b = row();
  b.tracks[0].fill = "generate";
  const c = bp.validateBlueprint(b);
  assert.equal(c.ok, false);
  assert.match(c.error, /must be "draw" for a text track/);
});

test("a picture may not be drawn out of thin air either", () => {
  const b = row();
  b.tracks.push({ region: "board", kind: "image", varies: "fixed", fill: "draw",
    items: [{ start: 0, end: 20, value: "a board" }] });
  const c = bp.validateBlueprint(b);
  assert.equal(c.ok, false);
  assert.match(c.error, /nothing to draw from/);
});

test("the four sources are the whole vocabulary, and each kind gets a sane default", () => {
  assert.deepEqual([...bp.FILL_SOURCES], ["draw", "generate", "cut", "supply"]);
  assert.equal(bp.defaultFill("text"), "draw");
  assert.equal(bp.defaultFill("color"), "draw");
  assert.equal(bp.defaultFill("image"), "generate");
  assert.equal(bp.defaultFill("video"), "generate");
});

test("a style on a picture is dropped and named, not fatal", () => {
  // The model reaches for "style" to describe a card's white face and dark border, which
  // is really the region's paint. Nothing there can draw, so refusing a whole capture over
  // it would turn a modelling slip into a lost analysis — but a silent drop would let the
  // slip become a habit.
  const b = row();
  b.tracks.push({ region: "board", kind: "image", varies: "fixed",
    style: { color: "#FFFFFF" }, items: [{ start: 0, end: 20, value: "x" }] });
  const c = bp.validateBlueprint(b);
  assert.equal(c.ok, true);
  assert.equal(c.blueprint.tracks.find((t) => t.kind === "image").style, undefined);
  assert.ok(c.notes.some((n) => /no words to set/.test(n)), c.notes.join(" | "));
});

test("a clean blueprint has nothing to report", () => {
  // The authored template is asked for here. It stopped being the default when geometry
  // started being measured off the source: a template that hard-codes a board top is a
  // rescue for a capture that guessed, and an overwrite for one that counted.
  const c = bp.validateBlueprint(row(), { snapTemplate: true });
  assert.equal(c.ok, true);
  assert.ok(c.notes.every((n) => /TierList9x16|equalized|snapped|caption|cream|safe|square|title|plate|highlight|board/.test(n)), c.notes.join(" | "));
  const board = c.blueprint.regions.find((r) => r.id === "board");
  assert.deepEqual(board.rect, [0, 0.56, 1, 0.44]);
});

test("words too long for their box are shrunk to fit, not clipped", () => {
  const b = row();
  b.tracks[1].items = [{ start: 6, end: 7, value: "Built like a Greek god, plays like a Greek [[tragedy.]]" }];
  const c = bp.validateBlueprint(b);
  const html = compose.composeBlueprint(c.blueprint, { assetFor: () => null });
  // The caption's own element: the tier label above it carries its own size.
  const cap = html.slice(html.indexOf('id="rg-cap"'));
  const size = Number(/font-size:(\d+)px/.exec(cap)[1]);
  // The caption strip is 84% x 7% of 720x1280 — 605x90 — and the captured size would put
  // fifty-four characters on two clipped lines.
  assert.ok(size < 45, `expected a shrunk size, got ${size}`);
  assert.ok(size > 10, `expected something still readable, got ${size}`);
});

test("an emphasised span is split out of the words, and plain text is left alone", () => {
  assert.deepEqual(bp.splitEmphasis("plays like a Greek [[tragedy.]]"),
    [{ text: "plays like a Greek ", strong: false }, { text: "tragedy.", strong: true }]);
  assert.deepEqual(bp.splitEmphasis("no marks here"), [{ text: "no marks here", strong: false }]);
  // Brackets around nothing are not an emphasis, and must not swallow the line.
  assert.deepEqual(bp.splitEmphasis("[[]]"), [{ text: "[[]]", strong: false }]);
});

test("the composer paints the surface and sets the type instead of assuming white on nothing", () => {
  const c = bp.validateBlueprint(row());
  assert.equal(c.ok, true);
  const html = compose.composeBlueprint(c.blueprint, { assetFor: () => null });
  // The row is a coloured rectangle with a border, not a picture of one.
  assert.match(html, /background:#F2796B/);
  assert.match(html, /solid #000000/);
  // The letter is dark and heavy, because that is what the reference does.
  assert.match(html, /color:#111111/);
  assert.match(html, /font-weight:900/);
  // The emphasised word is boxed; the rest of the line is not.
  assert.match(html, /<mark style="background:#2F6BFF[^"]*">tragedy\.<\/mark>/);
  assert.match(html, /plays like a Greek /);
  // And the caption keeps the stroke that makes it readable over footage.
  assert.match(html, /-webkit-text-stroke:\d+px #000000/);
});

test("a traced clone still draws no text of its own", () => {
  const c = bp.validateBlueprint(row());
  const html = compose.composeBlueprint(c.blueprint, { assetFor: () => null, tracedPixels: true });
  assert.equal(/tragedy/.test(html), false);
  // The surface is still painted: a trace that cut nothing for a region would otherwise
  // leave a hole where a coloured row belongs.
  assert.match(html, /background:#F2796B/);
});


test("dark plate over footage becomes an outline", () => {
  const b = row();
  b.tracks[1].style = { color: "#FFFFFF", background: "#000000", weight: 800, size: 0.035 };
  const c = bp.validateBlueprint(b);
  assert.equal(c.ok, true);
  const cap = c.blueprint.tracks.find((t) => t.region === "cap");
  assert.equal(cap.style.background, undefined);
  assert.equal(cap.style.outline, "#000000");
  assert.ok(c.notes.some((n) => /dark plate over footage/.test(n)));
});

test("duplicate plate on painted region is dropped from the words", () => {
  const b = row();
  b.regions.push({
    id: "title", role: "text", rect: [0.06, 0.03, 0.88, 0.09], z: 1,
    paint: { fill: "#fffdf5", radius: 0.12 },
  });
  b.tracks.push({
    region: "title", kind: "text", varies: "fixed", fill: "draw",
    style: { color: "#111111", background: "#fffdf5", font: "display", weight: 900, size: 0.035 },
    items: [{ start: 0, end: 20, value: "RANKING THE BEST FOOTBALLERS" }],
  });
  const c = bp.validateBlueprint(b, { snapTemplate: true });
  assert.equal(c.ok, true);
  const title = c.blueprint.tracks.find((t) => t.region === "title");
  assert.equal(title.style.background, undefined);
  const region = c.blueprint.regions.find((r) => r.id === "title");
  // TierList9x16 forces thin full-bleed banner flush to top.
  assert.deepEqual(region.rect, [0, 0.045, 1, 0.052]);
  assert.ok(c.notes.some((n) => /TierList9x16 banner|full width/.test(n)), c.notes.join(" | "));
  assert.ok(c.notes.some((n) => /word-plate|same plate/.test(n)), c.notes.join(" | "));
});

test("compose does not redraw a plate the region already painted", () => {
  const b = row();
  b.regions.push({
    id: "title", role: "text", rect: [0, 0.045, 1, 0.052], z: 1,
    paint: { fill: "#fffdf5" },
  });
  b.tracks.push({
    region: "title", kind: "text", varies: "fixed", fill: "draw",
    style: { color: "#111111", background: "#fffdf5", weight: 900, size: 0.035 },
    items: [{ start: 0, end: 20, value: "TITLE" }],
  });
  const c = bp.validateBlueprint(b, { snapTemplate: true });
  assert.equal(c.ok, true);
  const html = compose.composeBlueprint(c.blueprint, { assetFor: () => null });
  // Region box keeps the cream; the span must not carry a second background.
  assert.match(html, /id="rg-title"[^>]*background:#fff8e7/);
  const span = html.match(/id="rg-title"[\s\S]*?<span([^>]*)>/);
  assert.ok(span, "title span missing");
  assert.doesNotMatch(span[1], /background:#fff8e7/);
});


test("font-family quotes do not break the style attribute", () => {
  const b = row();
  b.tracks[1].style = { color: "#111111", font: "display", weight: 900, size: 0.035, background: "#fffdf5" };
  const c = bp.validateBlueprint(b);
  assert.equal(c.ok, true);
  const html = compose.composeBlueprint(c.blueprint, { assetFor: () => null });
  const m = html.match(/<span style="([^"]*color:#111111[^"]*)"/);
  assert.ok(m, "span style missing");
  assert.match(m[1], /font-family:/);
  // Whichever display stack is mapped, it must arrive intact — the check is that a family
  // name with a space in it did not close the attribute early.
  assert.match(m[1], /League Gothic|Anton|Impact/);
  assert.doesNotMatch(m[1], /font-family:"/);
});


// The renderer's contract. Not styling, but it lives or dies in the same emitted string,
// and the failure mode is silent: a key that does not match the wrapper's id registers a
// timeline nobody reads, and the only symptom is that the render takes five times longer.
test("the composition registers a paused timeline under its own id", () => {
  const c = bp.validateBlueprint(row());
  assert.equal(c.ok, true);
  const html = compose.composeBlueprint(c.blueprint, { assetFor: () => null });

  const id = html.match(/data-composition-id="([^"]+)"/);
  assert.ok(id, "composition wrapper has no id");
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/gsap@3/);
  // The key and the wrapper's id are the same string.
  assert.ok(
    html.includes(`window.__timelines[${JSON.stringify(id[1])}]`),
    `timeline is not registered under ${id[1]}`,
  );
  assert.match(html, /gsap\.timeline\(\{ paused: true \}\)/);
  // The script comes after the wrapper closes, so every element it could touch exists.
  assert.ok(html.indexOf("__timelines") > html.lastIndexOf("</div>"), "timeline script runs before the stage is built");
});
