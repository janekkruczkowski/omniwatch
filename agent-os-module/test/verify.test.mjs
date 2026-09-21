// Checking a capture against the video it claims to describe.
//
//   node --test agent-os-module/test/verify.test.mjs
//
// Offline: globalThis.fetch and the ffmpeg seam are replaced, so no model and no video.
// What is under test is the JUDGEMENT — what a correction is allowed to change — because
// a verifier that accepts any answer is worse than none: it launders a guess into a fact.

import { test, beforeEach } from "node:test";
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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchVerify.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-verify-"));

function transpile(name, rewrite = (s) => s) {
  const file = path.join(SOURCE, "lib", `${name}.ts`);
  const out = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(path.join(dir, `${name}.js`), rewrite(out));
  return path.join(dir, `${name}.js`);
}
transpile("omniwatchBlueprint");
// The source file and the vision call are both seams: ffmpeg would need a video, and the
// model would need a key and the network.
writeFileSync(path.join(dir, "omniwatch.js"), `
  const { writeFileSync } = require("node:fs");
  module.exports = {
    apiKey: async () => "test-key",
    // ffmpeg's job here is to leave a file where the checker will read one; what is IN it
    // never reaches anything but the stubbed model.
    run: async (cmd, args) => { writeFileSync(args[args.length - 1], "not really a jpeg"); return ""; },
    OMNI_ROOT: ${JSON.stringify(dir)},
  };
`);
const LIB = transpile("omniwatchVerify", (s) => s
  .replace(/require\("@\/lib\/omniwatchBlueprint"\)/g, 'require("./omniwatchBlueprint")')
  .replace(/require\("@\/lib\/omniwatch"\)/g, 'require("./omniwatch")'));
const bpLib = req(path.join(dir, "omniwatchBlueprint.js"));

/** A board whose five label cells share one column — and one wrong width. */
const board = () => ({
  version: bpLib.BLUEPRINT_VERSION,
  canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
  regions: [
    { id: "board", role: "panel", rect: [0, 0.54, 1, 0.46], z: 5, grid: { rows: 3, cols: 2 } },
    { id: "s-label", role: "cell", rect: [0, 0.54, 0.13, 0.09], z: 6, parent: "board", at: { row: 1, col: 1 } },
    { id: "a-label", role: "cell", rect: [0, 0.63, 0.13, 0.09], z: 6, parent: "board", at: { row: 2, col: 1 } },
    { id: "b-label", role: "cell", rect: [0, 0.72, 0.13, 0.09], z: 6, parent: "board", at: { row: 3, col: 1 } },
    { id: "cap", role: "text", rect: [0.08, 0.47, 0.84, 0.07], z: 7 },
  ],
  tracks: [
    { region: "board", kind: "color", varies: "fixed", items: [{ start: 0, end: 20, value: "#111111" }] },
    { region: "s-label", kind: "text", varies: "fixed", items: [{ start: 0, end: 20, value: "S" }] },
    { region: "a-label", kind: "text", varies: "fixed", items: [{ start: 0, end: 20, value: "A" }] },
    { region: "b-label", kind: "text", varies: "fixed", items: [{ start: 0, end: 20, value: "B" }] },
    { region: "cap", kind: "text", varies: "episode", items: [{ start: 0, end: 20, value: "a line" }] },
  ],
});

/** Answer as the model, once per call, in the order given. */
let answers = [];
beforeEach(() => { answers = []; });
function serve() {
  globalThis.fetch = async () => {
    const body = answers.shift() ?? '{"checks":[]}';
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}\n\ndata: [DONE]\n`;
    return { ok: true, status: 200, body: null, text: async () => sse };
  };
}
const load = () => req(LIB);
const rectOf = (bp, id) => bp.regions.find((r) => r.id === id).rect;

test("a correction to one cell of a column reaches its identical siblings", async () => {
  serve();
  answers = ['{"checks":[{"id":"b-label","ok":false,"rect":[0,0.72,0.25,0.09],"note":"too narrow"}]}', '{"checks":[{"id":"b-label","ok":false,"rect":[0,0.72,0.25,0.09],"note":"too narrow"}]}'];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.equal(r.ok, true);
  // The one the model judged.
  assert.deepEqual(rectOf(r.blueprint, "b-label"), [0, 0.72, 0.25, 0.09]);
  // And the two it waved through, which carry the same wrong width in the same column.
  assert.deepEqual(rectOf(r.blueprint, "s-label"), [0, 0.54, 0.25, 0.09]);
  assert.deepEqual(rectOf(r.blueprint, "a-label"), [0, 0.63, 0.25, 0.09]);
});

test("a sibling that was already different is left alone", async () => {
  serve();
  const bp = board();
  bp.regions.find((r) => r.id === "a-label").rect = [0, 0.63, 0.4, 0.09];
  answers = ['{"checks":[{"id":"b-label","ok":false,"rect":[0,0.72,0.25,0.09]}]}', '{"checks":[{"id":"b-label","ok":false,"rect":[0,0.72,0.25,0.09]}]}'];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(bp, "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.deepEqual(rectOf(r.blueprint, "a-label"), [0, 0.63, 0.4, 0.09]);
});

test("a corrected edge pulls its neighbour in the same row to meet it", async () => {
  serve();
  const bp = board();
  // A label column and a slot column that tile at 0.13, as the capture had them.
  bp.regions.push({ id: "s-slot", role: "cell", rect: [0.13, 0.54, 0.87, 0.09], z: 6, parent: "board", at: { row: 1, col: 2 } });
  bp.tracks.push({ region: "s-slot", kind: "image", varies: "episode", fill: "supply",
    items: [{ start: 0, end: 20, value: "a headshot" }] });
  // The model corrects the slot — "bleeds left into the label column" — and passes the
  // label beside it. Both cannot be true.
  answers = ['{"checks":[{"id":"s-slot","ok":false,"rect":[0.25,0.54,0.75,0.09],"note":"bleeds left"},{"id":"s-label","ok":true}]}', '{"checks":[{"id":"s-slot","ok":false,"rect":[0.25,0.54,0.75,0.09],"note":"bleeds left"},{"id":"s-label","ok":true}]}'];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(bp, "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.equal(r.ok, true);
  const [lx, , lw] = rectOf(r.blueprint, "s-label");
  const [sx] = rectOf(r.blueprint, "s-slot");
  assert.equal(sx, 0.25);
  // The label grows to meet it: no stripe of the board shows through between them.
  assert.ok(Math.abs((lx + lw) - sx) < 0.005, `gap of ${(sx - (lx + lw)).toFixed(3)}`);
});

test("a text area may be moved but not shrunk to whatever line is showing", async () => {
  serve();
  answers = ['{"checks":[{"id":"cap","ok":false,"rect":[0.27,0.54,0.46,0.03],"note":"lower"}]}', '{"checks":[{"id":"cap","ok":false,"rect":[0.27,0.54,0.46,0.03],"note":"lower"}]}'];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  const [x, y, w, h] = rectOf(r.blueprint, "cap");
  assert.equal(y, 0.54);            // the position it really sits at is taken
  assert.equal(w, 0.84);            // the width the format gives it is kept
  assert.equal(h, 0.07);
  assert.equal(x, 0.27);
});

test("a text area IS allowed to grow", async () => {
  serve();
  answers = ['{"checks":[{"id":"cap","ok":false,"rect":[0.02,0.54,0.96,0.12]}]}', '{"checks":[{"id":"cap","ok":false,"rect":[0.02,0.54,0.96,0.12]}]}'];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.deepEqual(rectOf(r.blueprint, "cap"), [0.02, 0.54, 0.96, 0.12]);
});

test("a sighting in one frame outranks an absence in another", async () => {
  serve();
  answers = [
    '{"checks":[{"id":"cap","ok":true,"note":"there"}]}',
    '{"checks":[{"id":"cap","ok":false,"rect":[0,0,0.1,0.1],"note":"not visible"}]}',
  ];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.deepEqual(rectOf(r.blueprint, "cap"), [0.08, 0.47, 0.84, 0.07]);
  assert.equal(r.corrected.includes("cap"), false);
});

test("a correction that is not a rectangle on this canvas is not a correction", async () => {
  serve();
  answers = ['{"checks":[{"id":"cap","ok":false,"rect":[0,0,0,0.5]},{"id":"s-label","ok":false,"rect":[9,9,9,9]}]}', '{"checks":[{"id":"cap","ok":false,"rect":[0,0,0,0.5]},{"id":"s-label","ok":false,"rect":[9,9,9,9]}]}'];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.deepEqual(r.corrected, []);
});

test("prose instead of JSON changes nothing, and does not throw", async () => {
  serve();
  answers = ["I had a look and everything seems fine to me."];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.equal(r.ok, true);
  assert.deepEqual(r.corrected, []);
});

test("one look objecting is a suspicion, not a correction", async () => {
  serve();
  // The same capture checked twice really did come back with three corrections and then
  // none; acting on either alone would be a coin toss presented as a finding.
  answers = [
    '{"checks":[{"id":"cap","ok":false,"rect":[0.08,0.54,0.84,0.07],"note":"lower"}]}',
    '{"checks":[{"id":"cap","ok":true}]}',
  ];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.deepEqual(r.corrected, []);
  assert.deepEqual(rectOf(r.blueprint, "cap"), [0.08, 0.47, 0.84, 0.07]);
  assert.equal(r.suspected.length, 1);
  assert.equal(r.suspected[0].id, "cap");
  assert.match(r.suspected[0].note, /seen once/);
});

test("two looks that disagree about WHERE it is are two guesses", async () => {
  serve();
  answers = [
    '{"checks":[{"id":"cap","ok":false,"rect":[0.08,0.54,0.84,0.07]}]}',
    '{"checks":[{"id":"cap","ok":false,"rect":[0.30,0.20,0.30,0.05]}]}',
  ];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.deepEqual(r.corrected, []);
  assert.equal(r.suspected.length, 1);
});

test("two looks that agree are averaged, and that is a correction", async () => {
  serve();
  answers = [
    '{"checks":[{"id":"cap","ok":false,"rect":[0.08,0.54,0.84,0.07]}]}',
    '{"checks":[{"id":"cap","ok":false,"rect":[0.10,0.56,0.82,0.07]}]}',
  ];
  const { verifyBlueprint } = load();
  const r = await verifyBlueprint(board(), "/nope.mp4", [6, 14], (n) => path.join(dir, n));
  assert.deepEqual(r.corrected, ["cap"]);
  const [x, y] = rectOf(r.blueprint, "cap");
  assert.ok(Math.abs(x - 0.09) < 1e-9, `x ${x}`);
  assert.ok(Math.abs(y - 0.55) < 1e-9, `y ${y}`);
});
