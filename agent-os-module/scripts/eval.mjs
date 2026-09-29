#!/usr/bin/env node
// The gate: run the pipeline against films that disagree with each other, and score it.
//
//   node agent-os-module/scripts/eval.mjs                 # the quick cases
//   node agent-os-module/scripts/eval.mjs --all           # including the long ones
//   node agent-os-module/scripts/eval.mjs --case tier-list-9x16
//
// Why this exists. Every defect this pipeline has had was a rule that fit ONE film. A filter
// that threw away the insert layer because one capture misused an id. A flex rule with three
// overrides because one row held three tiles. A prompt asking for a face because one board
// happened to hold faces. Each was correct on the film in front of it and wrong as a rule,
// and each survived because there was only ever one film in front of it.
//
// So the set is chosen for disagreement: one film has a tier board and six do not; one is
// twenty seconds and one is twenty-one minutes; some are portrait and some landscape. The
// most valuable check here is the NEGATIVE one — a run that reports a grid of rows in a film
// that has no board has not measured anything, it has recognised its own assumption.
//
// Nothing here renders a film. A render is minutes and answers a question the frame already
// answers; what is being scored is what the pipeline BELIEVES about a film, which is the
// blueprint plus the document composed from it.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = path.join(HERE, "..", "src");
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(homedir(), "Documents", "agent-os", "source");
const CACHE = path.join(homedir(), ".agentic-os", "omniwatch", "cache");
const CASES = JSON.parse(readFileSync(path.join(HERE, "..", "test", "eval", "cases.json"), "utf8")).cases;
const OUT = path.join(HERE, "..", "test", "eval");

const ALL = process.argv.includes("--all");
const ONLY = process.argv.find((a, i) => process.argv[i - 1] === "--case");

const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const work = mkdtempSync(path.join(tmpdir(), "omni-eval-"));
writeFileSync(path.join(work, "omniwatch.js"), `
const { execFileSync } = require("node:child_process");
exports.run = async (c, a) => execFileSync(c, a, { encoding: "utf8", maxBuffer: 1 << 28 });
exports.videoDir = (id) => require("node:path").join(${JSON.stringify(CACHE)}, id);
exports.apiKey = async () => process.env.DASHSCOPE_API_KEY || null;
exports.OMNI_ROOT = require("node:path").join(require("node:os").homedir(), ".agentic-os/omniwatch");
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
  const file = path.join(MODULE_SRC, "lib", `${name}.ts`);
  const src = readFileSync(file, "utf8");
  const out = ts.transpileModule(src, {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText.replace(/require\("@\/lib\/([A-Za-z0-9_]+)"\)/g, 'require("./$1.js")');
  writeFileSync(path.join(work, `${name}.js`), out);
  // After the file is on disk, so a cycle between two modules resolves instead of recursing.
  for (const dep of src.matchAll(/["']@\/lib\/([A-Za-z0-9_]+)["']/g)) emit(dep[1]);
}
function load(name) {
  emit(name);
  return req(path.join(work, `${name}.js`));
}
const bpLib = load("omniwatchBlueprint");
load("omniwatchBoardScan"); load("omniwatchRecipe"); load("omniwatchNode"); load("omniwatchGround");
load("omniwatchTranscript"); load("omniwatchCues");
load("omniwatchMotion"); load("omniwatchStage"); load("omniwatchPrompt");
const measureLib = load("omniwatchMeasure");
const compose = load("omniwatchCompose");

/** A capture to feed the measurer.
 *
 *  Only the reference has a real one on disk. For every other film the eval supplies the
 *  thinnest possible capture — a presenter and a caption band, which every short-form video
 *  has — precisely so that anything MORE than that in the answer came from measurement
 *  rather than from the capture. A board reported here was found, not repeated. */
function captureFor(c) {
  const real = path.join(HERE, "..", "..", ".cache", "outer-loop", "bp-sharp.json");
  if (c.id === "tier-list-9x16" && existsSync(real)) return JSON.parse(readFileSync(real, "utf8"));
  const portrait = c.expect.shortForm;
  return {
    version: bpLib.BLUEPRINT_VERSION,
    canvas: { width: portrait ? 720 : 1280, height: portrait ? 1280 : 720, fps: 30, seconds: c.seconds },
    regions: [
      { id: "presenter-stage", role: "figure", rect: [0, 0, 1, 0.7], z: 1 },
      { id: "caption-area", role: "text", rect: [0.05, 0.72, 0.9, 0.1], z: 8 },
    ],
    tracks: [
      { region: "presenter-stage", kind: "video", varies: "episode", fill: "cut",
        items: [{ start: 0, end: c.seconds, value: "whoever is on screen" }] },
      { region: "caption-area", kind: "text", varies: "episode",
        style: { color: "#FFFFFF", outline: "#000000" },
        items: [{ start: 0, end: Math.min(2, c.seconds), value: "a line of the narration" }] },
    ],
  };
}

/** Everything the run is scored on. Each check says what it looked at, so a failure is a
 *  lead rather than a verdict. */
function score(c, measured, html, notes) {
  const checks = [];
  const add = (name, pass, saw) => checks.push({ name, pass, saw });

  const bp = measured?.blueprint;
  add("the film measures at all", Boolean(bp), measured?.error ?? "a valid blueprint");
  if (!bp) return checks;

  // ── the one that matters: did we find a format, or recognise our own assumption? ──
  const rowIds = bp.regions.filter((r) => /-(label|slot)$/.test(r.id));
  const sawBoard = rowIds.length > 0;
  const rows = new Set(rowIds.map((r) => r.id.replace(/-(label|slot)$/, ""))).size;
  if (c.expect.board) {
    add("the board it has is found", sawBoard && rows >= (c.expect.rows ?? 1) - 1,
      `${rows} row(s)`);
  } else {
    add("no board is invented", !sawBoard,
      sawBoard ? `INVENTED ${rows} row(s): ${rowIds.map((r) => r.id).join(", ")}` : "none, correctly");
  }

  // ── geometry: measured, or merely repeated back? ──
  const located = notes.filter((n) => /region ".*" rect located/.test(n)).length;
  add("geometry comes from the film", located > 0, `${located} region(s) located in the frame`);

  // ── the clock ──
  const aligned = notes.find((n) => /cue\(s\) moved onto word boundaries/.test(n));
  add("caption times come from the soundtrack", Boolean(aligned), aligned ?? "the aligner never ran");

  // ── the document it would draw ──
  if (html) {
    add("nothing is forced with !important", !/!important/.test(html), "the emitted document");
    const cap = html.match(/id="rg-[^"]*caption[^"]*"[^>]*z-index:(\d+)/);
    const over = [...html.matchAll(/id="rg-[^"]*(?:overlay|insert)[^"]*"[^>]*z-index:(\d+)/g)];
    add("captions are drawn over the overlays",
      !cap || !over.length || over.every((m) => Number(m[1]) < Number(cap[1])),
      cap ? `caption at z${cap[1]}, overlays at ${over.map((m) => "z" + m[1]).join(", ") || "none"}` : "no caption region");
    const ids = [...html.matchAll(/id="(el-[^"]+)"/g)].map((m) => m[1]);
    add("every drawn element can be aimed at", ids.length === new Set(ids).size,
      `${ids.length} element(s), ${new Set(ids).size} distinct`);
  }

  // ── what it would ask a provider for ──
  const prompt = load("omniwatchPrompt");
  const FORBIDDEN = ["head-and-shoulders", "tier list", "thumbnail card", "footballer", "product"];
  const asked = [];
  for (const t of bp.tracks) {
    if (t.kind !== "image" && t.kind !== "video") continue;
    for (const it of t.items) asked.push(prompt.promptForItem(bp, t, it, { swapCast: true }));
  }
  const leaked = asked.filter((p, i) => {
    const own = (bp.tracks.flatMap((t) => t.items).map((x) => x.value)[i] ?? "").toLowerCase();
    return FORBIDDEN.some((w) => p.toLowerCase().includes(w) && !own.includes(w));
  });
  add("no slot prompt invents what the picture is", leaked.length === 0,
    leaked.length ? leaked[0].slice(0, 110) : `${asked.length} prompt(s), none embellished`);

  return checks;
}

const chosen = CASES.filter((c) => (ONLY ? c.id === ONLY : ALL || !c.slow));
console.log(`${chosen.length} case(s): ${chosen.map((c) => c.id).join(", ")}\n`);

const results = [];
for (const c of chosen) {
  const source = path.join(CACHE, c.source, "source.mp4");
  if (!existsSync(source)) { console.log(`— ${c.id}: no source on disk, skipped`); continue; }
  const dir = path.join(work, c.id);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let measured = null, html = null, notes = [];
  try {
    measured = await measureLib.measureBlueprint(captureFor(c), { sourcePath: source, workDir: dir, at: [c.at] });
    notes = measured.notes ?? [];
    if (measured.ok) {
      html = compose.composeBlueprint(measured.blueprint, {
        recipe: measured.recipe, assetFor: () => null,
      });
    }
  } catch (e) {
    notes = [`threw: ${e instanceof Error ? e.message : String(e)}`];
  }
  const checks = score(c, measured?.ok ? measured : null, html, notes);
  const failed = checks.filter((k) => !k.pass);
  results.push({ ...c, checks, seconds: (Date.now() - t0) / 1000 });
  console.log(`${failed.length ? "✗" : "✓"} ${c.id} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  for (const k of checks) console.log(`    ${k.pass ? "·" : "✗"} ${k.name} — ${k.saw}`);
  console.log();
}

const lines = [
  "# Eval — what the pipeline believes about films it was not built on",
  "",
  `Run ${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${results.length} case(s)`,
  "",
  "| case | what it is | result |",
  "|---|---|---|",
  ...results.map((r) => {
    const bad = r.checks.filter((k) => !k.pass);
    return `| \`${r.id}\` | ${r.what} | ${bad.length ? `**${bad.length} failed**` : `${r.checks.length} passed`} |`;
  }),
  "",
  ...results.flatMap((r) => [
    `## ${r.id}`, "", `${r.what} · measured in ${r.seconds.toFixed(0)}s`, "",
    ...r.checks.map((k) => `- ${k.pass ? "✓" : "✗"} **${k.name}** — ${k.saw}`), "",
  ]),
];
writeFileSync(path.join(OUT, "EVAL.md"), lines.join("\n"));
writeFileSync(path.join(OUT, "eval.json"), JSON.stringify(results, null, 2));
const failedCases = results.filter((r) => r.checks.some((k) => !k.pass));
console.log(`scorecard: ${path.join(OUT, "EVAL.md")}`);
console.log(failedCases.length ? `${failedCases.length} case(s) with failures` : "every case passed");
process.exit(failedCases.length ? 1 : 0);
