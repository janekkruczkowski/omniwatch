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
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(path.join(dir, `${name}.js`), rewrite(out));
  return req(path.join(dir, `${name}.js`));
}
const bp = load("omniwatchBlueprint");
const compose = load("omniwatchCompose", (s) =>
  s.replace(/require\("@\/lib\/omniwatchBlueprint"\)/g, 'require("./omniwatchBlueprint")'));

/** A tier row: a coloured rectangle with a letter on it. The case the schema was missing. */
const row = () => ({
  version: bp.BLUEPRINT_VERSION,
  canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
  regions: [
    { id: "board", role: "panel", rect: [0, 0.54, 1, 0.46], z: 5, grid: { rows: 5, cols: 2 } },
    { id: "s-label", role: "cell", rect: [0, 0.54, 0.13, 0.09], z: 6, parent: "board", at: { row: 1, col: 1 },
      paint: { fill: "#F2796B", border: { color: "#000000", width: 0.02 } } },
    { id: "cap", role: "text", rect: [0.08, 0.53, 0.84, 0.07], z: 7 },
  ],
  tracks: [
    { region: "s-label", kind: "text", varies: "fixed", fill: "draw",
      style: { color: "#111111", weight: 900, size: 0.035, align: "center" },
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

test("style belongs to words only", () => {
  const b = row();
  b.tracks.push({ region: "board", kind: "image", varies: "fixed",
    style: { color: "#FFFFFF" }, items: [{ start: 0, end: 20, value: "x" }] });
  const c = bp.validateBlueprint(b);
  assert.equal(c.ok, false);
  assert.match(c.error, /style belongs on a text track/);
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
