#!/usr/bin/env node
// One frame, measured against the film it was cloned from — and, on request, the whole film.
//
//   node agent-os-module/scripts/proof-frame.mjs \
//     --blueprint .cache/outer-loop/bp-sharp.json \
//     --source ~/.agentic-os/omniwatch/cache/3acd67c83aff434a/source.mp4 \
//     --assets .cache/outer-loop/gen-faces/asset-map.json \
//     --slug hypit-recipe-v1 --at 0.5
//
// The cheap half of the definition of done: measure, author the recipe, draw ONE frame, and
// put it next to the same second of the source. A full render costs minutes and hides the
// question; a pair sheet answers it.
//
// `--film` renders the whole thing afterwards. The composition is the SAME one the frame was
// taken from — every item on its own clock, nothing held back — so the frame that was checked
// is a frame of the film that gets rendered, rather than a picture of a different composition.
//
// It runs the real pipeline — the same measure, the same recipe, the same composer the
// server uses — without needing Agent OS to be up. The libraries are TypeScript, so they are
// transpiled here the way the tests do it; nothing is reimplemented.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = path.join(HERE, "..", "src");
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(homedir(), "Documents", "agent-os", "source");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const expand = (p) => (p && p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);

const SOURCE = path.resolve(expand(arg("source", path.join(homedir(), ".agentic-os/omniwatch/cache/3acd67c83aff434a/source.mp4"))));
const BLUEPRINT = path.resolve(expand(arg("blueprint", "")));
const ASSET_MAP = expand(arg("assets", ""));
const SLUG = arg("slug", "recipe-proof");
const AT = Number(arg("at", "0.5"));
const OUT = path.resolve(expand(arg("out", path.join(homedir(), ".agentic-os/video-projects"))));
const FILM = process.argv.includes("--film");
const FRAMES = arg("frames", "");
const ASSET_STORE = path.join(homedir(), ".agentic-os/omniwatch/assets");

if (!BLUEPRINT || !existsSync(BLUEPRINT)) { console.error("--blueprint <capture.json> is required"); process.exit(2); }
if (!existsSync(SOURCE)) { console.error(`source not found: ${SOURCE}`); process.exit(2); }

// ── the pipeline's own code, transpiled ────────────────────────────────────────
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const work = mkdtempSync(path.join(tmpdir(), "omni-proof-"));
// The one thing that is stood in for: the process helper, because the real one reaches for
// Agent OS's own PATH handling. Everything else is the shipped code.
writeFileSync(path.join(work, "omniwatch.js"), `
const { execFileSync } = require("node:child_process");
exports.run = async (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 });
exports.videoDir = (id) => require("node:path").join(require("node:os").homedir(), ".agentic-os/omniwatch/cache", id);
exports.apiKey = async () => process.env.DASHSCOPE_API_KEY || null;
`);
const emitted = new Set();
function emit(name) {
  if (emitted.has(name)) return;
  emitted.add(name);
  const file = path.join(MODULE_SRC, "lib", `${name}.ts`);
  const src = readFileSync(file, "utf8");
  const out = ts.transpileModule(src, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText.replace(/require\("@\/lib\/([A-Za-z0-9_]+)"\)/g, 'require("./$1.js")');
  writeFileSync(path.join(work, `${name}.js`), out);
  for (const dep of src.matchAll(/["']@\/lib\/([A-Za-z0-9_]+)["']/g)) emit(dep[1]);
}
function load(name) {
  emit(name);
  return req(path.join(work, `${name}.js`));
}

load("omniwatchBlueprint");
load("omniwatchBoardScan");
load("omniwatchRecipe");
load("omniwatchNode"); load("omniwatchGround");
// The clock. Measure reaches for these, so they have to be on disk beside it.
load("omniwatchTranscript");
load("omniwatchCues");
const measureLib = load("omniwatchMeasure");
// The composer now moves things, so the two libraries that decide how go in first.
load("omniwatchMotion");
load("omniwatchStage");
const compose = load("omniwatchCompose");

// ── measure the film, author the recipe ────────────────────────────────────────
const capture = JSON.parse(readFileSync(BLUEPRINT, "utf8"));
const measureDir = path.join(work, "measure");
mkdirSync(measureDir, { recursive: true });
console.log(`measuring ${path.basename(SOURCE)} …`);
const measured = await measureLib.measureBlueprint(capture, { sourcePath: SOURCE, workDir: measureDir, at: [AT] });
if (!measured.ok) { console.error(`measure failed: ${measured.error}`); process.exit(1); }
for (const n of measured.notes) console.log(`  · ${n}`);

const bp = measured.blueprint;
const recipe = measured.recipe;
console.log(`\nrecipe: label column ${recipe.board.labelRatio.toFixed(4)} of board, ` +
  `letter ${recipe.label.sizeRatioOfRow.toFixed(3)} of row in ${recipe.label.type.face} ${recipe.label.type.weight}, ` +
  `tiles ${recipe.tiers.map((t) => t.count ?? "?").join("/")}`);

// ── fill the slots ─────────────────────────────────────────────────────────────
const cwd = path.join(OUT, SLUG);
rmSync(cwd, { recursive: true, force: true });
mkdirSync(path.join(cwd, "assets"), { recursive: true });
const assetMap = ASSET_MAP && existsSync(ASSET_MAP) ? JSON.parse(readFileSync(ASSET_MAP, "utf8")) : {};
const given = new Map();
const missing = [];
for (const [slot, name] of Object.entries(assetMap)) {
  const from = path.join(ASSET_STORE, String(name));
  if (!existsSync(from)) { missing.push(slot); continue; }
  copyFileSync(from, path.join(cwd, "assets", path.basename(from)));
  given.set(slot, `assets/${path.basename(from)}`);
}
if (missing.length) console.log(`assets missing from the store: ${missing.join(", ")}`);

// The timeline is drawn in full: every item carries its own start and duration, and the
// renderer honours them. `activeAt` exists for a capture whose timings are not trusted yet —
// it emits only what is on screen at one second — and using it would mean the frame being
// checked came from a composition that is not the film.
const html = compose.composeBlueprint(bp, {
  recipe,
  assetFor: (track, _item, i) => given.get(`${track.region}:${i}`) ?? given.get(track.region) ?? null,
});
writeFileSync(path.join(cwd, "index.html"), html);
writeFileSync(path.join(cwd, "recipe.json"), JSON.stringify(recipe, null, 2));
writeFileSync(path.join(cwd, "layout.json"), JSON.stringify(measured.layout, null, 2));
writeFileSync(path.join(cwd, "hyperframes.json"), JSON.stringify({
  name: SLUG, composition: "index.html",
  width: Math.round(bp.canvas.width), height: Math.round(bp.canvas.height),
  fps: Math.round(bp.canvas.fps), duration: bp.canvas.seconds,
}, null, 2));
console.log(`project: ${cwd}`);

// ── one frame, against the film ────────────────────────────────────────────────
const snaps = path.join(cwd, "snapshots");
const at = FRAMES || String(AT);
console.log(`\nsnapshot at ${at}s against the source …`);
try {
  const out = execFileSync("hyperframes", [
    "snapshot", cwd, "-o", snaps, "--at", at, "--no-end",
    "--against", SOURCE, "--describe", "false",
  ], { encoding: "utf8", maxBuffer: 1 << 28 });
  process.stdout.write(out);
} catch (e) {
  console.error(`snapshot failed: ${e.message}`);
  process.exit(1);
}
console.log(`\npairs in: ${snaps}`);

if (FILM) {
  const mp4 = path.join(cwd, "renders", `${SLUG}.mp4`);
  console.log(`\nrendering the whole ${bp.canvas.seconds}s …`);
  try {
    const out = execFileSync("hyperframes", ["render", cwd, "-o", mp4], {
      encoding: "utf8", maxBuffer: 1 << 28,
    });
    process.stdout.write(out);
  } catch (e) {
    console.error(`render failed: ${e.message}`);
    process.exit(1);
  }
  console.log(`\nfilm: ${mp4}`);
}
