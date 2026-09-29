#!/usr/bin/env node
// Watch a film, take its format, make one of your own in it.
//
//   node agent-os-module/scripts/clone-film.mjs --source <id|path> --slug my-film --film
//
//   --source   a video in the OmniWatch cache (by its id) or a path to one. Required.
//   --capture  a capture describing what the film CONTAINS. Optional: without one, the
//              pipeline is given only "there is a presenter and there is a caption band"
//              and everything else in the answer has to be measured.
//   --slug     what to call the project. Default: the source's id.
//   --at       the second to look at when locating regions. Default: a third of the way in.
//   --film     render the mp4. Without it you get the composition and one frame, which is
//              where you should look first — a render costs minutes and tells you less.
//   --against  a video to put our frame beside, for a pair sheet. Default: the source.
//   --keep-cast  render the film's own named subjects instead of unnamed stand-ins. For
//              reproducing a film; leave it off when making your own.
//   --mock-host  build a still stand-in for the host out of the film itself and use it. The
//              cheapest way to test a format: no provider, no credits, nothing moving. The
//              slice it keeps is worked out from the regions THIS run measured — below
//              whatever banner the format has, above whatever caption it writes — so the
//              plate carries only what the clone does not draw for itself.
//   --host     a picture or clip to put in the presenter's place — the swap this whole tool
//              exists for. Without one, the presenter is cut from the film being watched,
//              which reproduces it rather than replacing it.
//   --still    do not ask any provider for pictures; draw the boxes empty. The cheapest way
//              to see whether a format came out right.
//   --model    which still provider to ask. Default: nano-banana.
//   --save-template <name>  after this run has its structure settled — measured, or loaded
//              from a template already — save it as a reusable template under this name:
//              regions, recipe, motion and cue policy, with the words held out. See
//              src/lib/omniwatchTemplate.ts for the structure/content boundary this draws
//              and why. Saved under ~/.agentic-os/omniwatch/templates/.
//   --from-template <name>  skip measuring entirely and build from a saved template instead
//              (by its saved name or its id) — no ffmpeg call, no model call for geometry.
//              --source becomes optional: pass it only if a fill still needs to CUT
//              something from a film, and pass --host (or --still) when it does not, since
//              there is no film here to cut from unless one is named.
//   --content <path>  a JSON file of new words/pictures for a template's episode slots,
//              keyed "<region>:<kind>" — the same ids --list-templates prints. Without it,
//              --from-template reproduces the episode the template was measured on.
//   --list-templates  print the template library (name, source film, when, what it needs)
//              and exit. Nothing else runs.
//
// What it does, in order: measure the film (geometry from pixels, word times from the
// soundtrack, categories from the capture) — or load a saved template instead of measuring —
// ask a provider for the pictures the blueprint says it needs, give the format its movement,
// compose, and render.
//
// Everything it generates is cached beside the project, so running it twice costs one run.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = path.join(HERE, "..", "src");
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(homedir(), "Documents", "agent-os", "source");
const OMNI = path.join(homedir(), ".agentic-os", "omniwatch");
const CACHE = path.join(OMNI, "cache");
const STORE = path.join(OMNI, "assets");
const PROJECTS = path.join(homedir(), ".agentic-os", "video-projects");

const arg = (name, fallback = "") => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const SOURCE_ARG = arg("source");
const FROM_TEMPLATE = arg("from-template");
const SAVE_TEMPLATE = arg("save-template");
const CONTENT_ARG = arg("content");
const LIST_TEMPLATES = has("list-templates");
if (!SOURCE_ARG && !FROM_TEMPLATE && !LIST_TEMPLATES) {
  console.error("--source <id|path> is required (or --from-template <name>, or --list-templates)");
  process.exit(2);
}
// A template run has no film to require: everything it needs already lives in the template.
// --source stays meaningful there only for a fill that wants to CUT something from a film —
// pass --host instead when there is nothing to cut from.
let SOURCE = null;
if (SOURCE_ARG) {
  SOURCE = existsSync(SOURCE_ARG) ? path.resolve(SOURCE_ARG) : path.join(CACHE, SOURCE_ARG, "source.mp4");
  if (!existsSync(SOURCE)) { console.error(`no such film: ${SOURCE}`); process.exit(2); }
}
const SLUG = arg("slug", SOURCE ? path.basename(path.dirname(SOURCE)) : String(FROM_TEMPLATE || "template"));
const CWD = path.join(PROJECTS, SLUG);
const MADE = path.join(CWD, "generated.json");
const STILL_MODEL = arg("model", "nano-banana");

// ── the pipeline's own code, transpiled ────────────────────────────────────────
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const work = mkdtempSync(path.join(tmpdir(), "clone-"));
// The one thing stood in for: the process helper, because the real one reaches into Agent
// OS's own PATH handling. Everything else below is the shipped code.
writeFileSync(path.join(work, "omniwatch.js"), `
const { execFileSync } = require("node:child_process");
exports.run = async (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 });
exports.videoDir = (id) => require("node:path").join(${JSON.stringify(CACHE)}, id);
exports.apiKey = async () => process.env.DASHSCOPE_API_KEY || null;
exports.OMNI_ROOT = ${JSON.stringify(OMNI)};
`);
// The lib files import each other by relative path once transpiled (@/lib/X → ./X.js), and
// which file imports which keeps changing as the pipeline grows — omniwatchGround now pulls
// in omniwatchNode, omniwatchCues now pulls in omniwatchStage, neither true when this loader
// was written. Transpiling one file at a time in a fixed list broke every time an edit added
// a new cross-import the list did not yet know about. So: write every lib file to disk
// (transpiled, not executed) before requiring any of them — Node's own require() then
// resolves whichever ones a module actually needs, in whatever order, because the file is
// already there. Purely additive: every existing load() call still returns the same module.
let libsWritten = false;
function writeAllLibs() {
  if (libsWritten) return;
  libsWritten = true;
  const libDir = path.join(MODULE_SRC, "lib");
  for (const f of readdirSync(libDir)) {
    if (!f.endsWith(".ts")) continue;
    const file = path.join(libDir, f);
    try {
      const out = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      }).outputText.replace(/require\("@\/lib\/([A-Za-z0-9_]+)"\)/g, 'require("./$1.js")');
      writeFileSync(path.join(work, f.replace(/\.ts$/, ".js")), out);
    } catch {
      // A sibling lib this script never touches, mid-edit elsewhere: skip it here, and let a
      // real require() failure (from something that actually needs it) surface on its own.
    }
  }
}
function load(name) {
  writeAllLibs();
  return req(path.join(work, `${name}.js`));
}
const bpLib = load("omniwatchBlueprint");
load("omniwatchBoardScan"); load("omniwatchRecipe"); load("omniwatchNode"); load("omniwatchGround");
load("omniwatchTranscript"); load("omniwatchCues");
load("omniwatchMotion"); load("omniwatchStage"); load("omniwatchAssets");
const promptLib = load("omniwatchPrompt");
const broll = load("omniwatchBroll");
const measureLib = load("omniwatchMeasure");
const compose = load("omniwatchCompose");
const templateLib = load("omniwatchTemplate");

if (LIST_TEMPLATES) {
  const list = await templateLib.listTemplates();
  if (!list.length) console.log(`no templates saved yet -- ${templateLib.TEMPLATES_ROOT}`);
  for (const t of list) {
    console.log(`${t.id}  "${t.name}"`);
    console.log(`  from ${t.source} -- measured ${t.measuredAt} -- ${t.regions} region(s), ${t.episodeSlots} slot(s) to fill`);
  }
  process.exit(0);
}

let bp, recipe, measuredNotes, provenanceSource = SOURCE_ARG || null;
let AT = 0;
if (FROM_TEMPLATE) {
  const t = await templateLib.findTemplate(FROM_TEMPLATE);
  if (!t) { console.error(`no such template: ${FROM_TEMPLATE} (see --list-templates)`); process.exit(2); }
  console.log(`building from template "${t.name}" -- measured from ${t.provenance.source} at ${t.provenance.measuredAt}`);
  console.log(`  no film opened, no model asked: every number here already lived in the template`);
  const content = CONTENT_ARG ? JSON.parse(readFileSync(CONTENT_ARG, "utf8")) : {};
  const built = templateLib.hydrateTemplate(t, content);
  if (!built.ok) { console.error(`template would not produce a valid blueprint: ${built.error}`); process.exit(1); }
  bp = built.blueprint;
  recipe = t.recipe;
  measuredNotes = t.provenance.measured;
  provenanceSource = t.provenance.source;
  AT = Number(arg("at", String(Math.max(0.5, bp.canvas.seconds / 3))));
} else {
  const seconds = Number(execFileSync("ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", SOURCE], { encoding: "utf8" }).trim()) || 20;
  AT = Number(arg("at", String(Math.max(0.5, seconds / 3))));

  /** Told only that there is someone on screen and a band of words under them.
   *
   *  Deliberately the least a short-form video can be. Anything richer than this in the
   *  finished blueprint was found by measuring the film, which is the point -- a capture that
   *  describes a board would produce a board whether or not the film has one. */
  const thinCapture = () => {
    const portrait = seconds <= 90;
    return {
      version: bpLib.BLUEPRINT_VERSION,
      canvas: { width: portrait ? 720 : 1280, height: portrait ? 1280 : 720, fps: 30, seconds },
      regions: [
        { id: "presenter-stage", role: "figure", rect: [0, 0, 1, 0.7], z: 1 },
        { id: "caption-area", role: "text", rect: [0.05, 0.72, 0.9, 0.1], z: 8 },
      ],
      tracks: [
        { region: "presenter-stage", kind: "video", varies: "episode", fill: "cut",
          items: [{ start: 0, end: seconds, value: "whoever is on screen" }] },
        { region: "caption-area", kind: "text", varies: "episode",
          style: { color: "#FFFFFF", outline: "#000000" },
          items: [{ start: 0, end: Math.min(2, seconds), value: "\u2014" }] },
      ],
    };
  };

  // -- 1. measure --------------------------------------------------------------------
  const captureFile = arg("capture");
  const capture = captureFile ? JSON.parse(readFileSync(captureFile, "utf8")) : thinCapture();
  console.log(`watching ${path.basename(SOURCE)} (${seconds.toFixed(1)}s), looking at t=${AT.toFixed(1)}s ...`);
  const measured = await measureLib.measureBlueprint(capture, { sourcePath: SOURCE, workDir: path.join(work, "m"), at: [AT] });
  if (!measured.ok) { console.error(`could not measure: ${measured.error}`); process.exit(1); }
  for (const n of measured.notes) {
    if (process.env.CLONE_VERBOSE || /board measured from|insert layer:|aligner:|rhythm|re-cut|soundtrack instead|no regular grid|ceiling of/.test(n)) console.log(`  - ${n}`);
  }
  // One run, one report. Every gate in the pipeline now keeps a record of what it tried and
  // how it ended (see omniwatchNode.ts), and this prints it -- because the failure that made
  // the gates necessary was not a wrong number, it was a wrong number that looked exactly
  // like a right one. A gate that gave up, or one that only got its answer on the third try,
  // is the first thing worth knowing when a frame comes out wrong, and until now it could
  // only be recovered by grepping the log.
  const MARK = { accepted: "\u2713", degraded: "\u26a0", hole: "\u2717" };
  const ENDED = {
    accepted: (r) => `accepted on attempt ${r.attempts.length}`,
    degraded: (r) => `gave up after ${r.attempts.length} attempt(s) -- kept a stand-in`,
    hole: (r) => `gave up after ${r.attempts.length} attempt(s) -- left a hole`,
  };
  // A gate that runs once per insert produces one record per insert, and eleven identical
  // lines are not a report. Runs of the same node with the same outcome collapse to one line
  // carrying the count; anything that ended differently keeps its own line, because the
  // exception is the whole reason to look.
  const rollUp = (log) => {
    const out = [];
    for (const r of log) {
      const prev = out[out.length - 1];
      if (prev && prev.r.node === r.node && prev.r.outcome === r.outcome
          && prev.r.attempts.length === 1 && r.attempts.length === 1) { prev.n += 1; prev.also.push(r); continue; }
      out.push({ r, n: 1, also: [] });
    }
    return out;
  };
  if (measured.log?.length) {
    console.log(`\n  gates`);
    for (const { r, n, also } of rollUp(measured.log)) {
      const last = r.attempts[r.attempts.length - 1];
      const got = last?.detail ? ` -- ${last.detail}` : "";
      const times = n > 1 ? ` (${n} times)` : "";
      console.log(`    ${MARK[r.outcome]} ${r.node.padEnd(20)} ${ENDED[r.outcome](r)}${times}${got}`);
      if (n > 1 && process.env.CLONE_VERBOSE) {
        for (const one of [r, ...also]) console.log(`        - ${one.attempts[0].detail || "no detail"}`);
        continue;
      }
      if (n > 1) continue;
      // The attempts themselves only matter when something went wrong, or when asked for.
      if (r.outcome === "accepted" && r.attempts.length === 1 && !process.env.CLONE_VERBOSE) continue;
      for (const a of r.attempts) {
        console.log(`        ${a.attempt}. ${a.input} -> ${a.verdict}${a.detail ? `: ${a.detail}` : ""}`);
      }
    }
  }

  bp = measured.blueprint;
  recipe = measured.recipe;
  measuredNotes = measured.notes;
}
const rows = new Set(bp.regions.filter((r) => /-(label|slot)$/.test(r.id)).map((r) => r.id.replace(/-(label|slot)$/, ""))).size;
console.log(`  format: ${bp.regions.length} region(s)${rows ? `, a board of ${rows} row(s)` : ", no board"}`);

// ── 2. the pictures the blueprint says it needs ────────────────────────────────
mkdirSync(CWD, { recursive: true });
const made = existsSync(MADE) ? JSON.parse(readFileSync(MADE, "utf8")) : {};
if (!has("still")) {
  // A slot marked "generate" is one the film asks a provider for. A slot marked "supply"
  // wants something nobody can make — a real person, a real screenshot — which for a CLONE
  // is a hole to fill by hand, and for a film of your own is exactly the slot that should
  // stop being their cast and start being yours.
  const swapCast = !has("keep-cast");
  const jobs = [];
  for (const t of bp.tracks) {
    const fill = t.fill ?? bpLib.defaultFill(t.kind);
    if (t.kind !== "image" && t.kind !== "video") continue;
    if (fill !== "generate" && !(swapCast && fill === "supply")) continue;
    const region = bp.regions.find((r) => r.id === t.region);
    const [, , fw, fh] = region?.rect ?? [0, 0, 1, 1];
    t.items.forEach((it, i) => jobs.push({
      slot: `${t.region}:${i}`,
      aspect: broll.nearestStillAspect(Math.max(fw * bp.canvas.width, 1), Math.max(fh * bp.canvas.height, 1)),
      prompt: promptLib.promptForItem(bp, t, it, { swapCast }).slice(0, broll.MAX_PROMPT),
    }));
  }
  const todo = jobs.filter((j) => !made[j.slot]);
  if (todo.length) {
    console.log(`\nasking for ${todo.length} picture(s) …`);
    const ask = async (j) => {
      const r = await broll.kieStill(j.prompt, j.aspect, STILL_MODEL);
      if (r.ok) { made[j.slot] = r.name; console.log(`  ✓ ${j.slot}`); return true; }
      return r.error;
    };
    await Promise.all(todo.map(async (j) => {
      const first = await ask(j);
      if (first === true) return;
      // One retry, because a provider that refused once usually has not refused the
      // PICTURE — it was busy, or the queue timed out. A slot left empty is a visible hole
      // in the film, which is worse than asking twice.
      const second = await ask(j);
      if (second !== true) console.log(`  ✗ ${j.slot}: ${second}`);
    }));
    writeFileSync(MADE, JSON.stringify(made, null, 2));
  } else if (jobs.length) {
    console.log(`\n${jobs.length} picture(s) already made for this project`);
  }
}

// ── 3. movement ───────────────────────────────────────────────────
// Only where the blueprint gives something to move. A format with no board has no icon to
// land in a row, and saying so is not a limitation — it is the film.
//
// Skipped for --from-template: the template already carries whatever motion and cue policy
// this heuristic would decide (see src/lib/omniwatchTemplate.ts) — it was baked in the run
// that measured the film and saved the template, and redeciding it here from region-id
// patterns is exactly the re-guessing a saved format is supposed to make unnecessary.
if (!FROM_TEMPLATE) {
  const presenter = bp.regions.find((r) => r.role === "figure" && /presenter|host|stage/i.test(r.id));
  let staged = 0;
  bp = { ...bp, tracks: bp.tracks.map((t) => {
    const r = bp.regions.find((x) => x.id === t.region);
    if (!r) return t;
    if (/overlay|insert/i.test(r.id) && t.kind !== "text") {
      return { ...t, items: t.items.map((it) => ({ ...it, arrival: "pop", departure: "fade" })) };
    }
    if (/-slot$/.test(r.id) && t.items.length && presenter) {
      staged++;
      return { ...t, items: t.items.map((it, i) => {
        if (i !== 0) return it;
        const when = Math.max(it.start, 1 + staged * 2);
        if (when >= it.end - 1) return it;
        return { ...it, start: when, hold: "on-cue", waitsAt: presenter.id };
      }) };
    }
    return t;
  }) };
  const checked = bpLib.validateBlueprint(bp, { preserveGeometry: true });
  if (!checked.ok) { console.error(`the film would not validate: ${checked.error}`); process.exit(1); }
  bp = checked.blueprint;
}

// ── the structure this run settled on, saved as a reusable template ───────────────
// Placed here rather than right after measuring: this is the point where the movement this
// format uses is finally settled, whether it came from --from-template already or was just
// decided above, so a template saved from a fresh --source run and one re-saved from
// --from-template carry the same kind of structure.
if (SAVE_TEMPLATE) {
  const templateNotes = (measuredNotes || []).filter((n) =>
    /board measured from|insert layer:|aligner:|rhythm|re-cut|soundtrack instead|no regular grid|ceiling of|caption band/.test(n));
  const provenance = {
    source: provenanceSource || SLUG,
    measuredAt: new Date().toISOString(),
    measured: templateNotes.length ? templateNotes : (recipe?.notes ?? []),
  };
  const t = templateLib.deriveTemplate(SAVE_TEMPLATE, bp, recipe, provenance);
  const saved = await templateLib.saveTemplate(t);
  if (!saved.ok) { console.error(`\ncould not save template "${SAVE_TEMPLATE}": ${saved.error}`); process.exit(1); }
  console.log(`\ntemplate saved: ${saved.id}  (${saved.path})`);
}

// ── 3b. whoever is on screen ───────────────────────────────────────────────────
// A region marked "cut" is one the film itself supplies. Left alone it is a hole where the
// host should be, which is the most visible hole a clone can have.
const cuts = new Map();
let HOST = arg("host");

// A stand-in host, cut from the film's own quiet parts.
//
// The window it keeps is not a guess and not a constant: every region this run measured that
// DRAWS something — a banner, a caption, a portrait laid over the host — is a region whose
// pixels the clone supplies itself, and a plate carrying the original's version of them puts
// two banners and two captions on screen at once. That was the first version's failure, and
// it is visible at a glance.
//
// So the plate keeps the widest horizontal slice of the host's box that nothing else is
// drawn into.
if (has("mock-host") && !HOST && !SOURCE) {
  console.log("  · --mock-host needs a film to cut a stand-in from — pass --source too, or use --host / --still instead");
}
if (has("mock-host") && !HOST && SOURCE) {
  const host = bp.regions.find((r) => r.role === "figure" && /presenter|host|stage/i.test(r.id)) ?? bp.regions[0];
  // Only a region that crosses the host BLOCKS a slice of it. A banner and a caption band
  // run the full width and cut the frame in two; a portrait in the corner sits over the
  // host without stopping the plate using the rest of that height. Treating both the same
  // left a stand-in made of somebody's chin.
  const BLOCKS = 0.5;
  const over = bp.regions
    .filter((r) => r !== host
      && r.rect[1] < host.rect[1] + host.rect[3] && r.rect[1] + r.rect[3] > host.rect[1]
      && r.rect[2] >= host.rect[2] * BLOCKS)
    .map((r) => [r.rect[1], r.rect[1] + r.rect[3]]);
  // Walk down the host's box and keep the longest run no other region covers.
  const EDGE = 0.005;
  let best = [host.rect[1], host.rect[1]];
  let run = host.rect[1];
  for (let y = host.rect[1]; y <= host.rect[1] + host.rect[3] + 1e-9; y += EDGE) {
    const covered = over.some(([a, b]) => y >= a - 1e-9 && y <= b + 1e-9);
    if (covered) { run = y + EDGE; continue; }
    if (y - run > best[1] - best[0]) best = [run, y];
  }
  if (best[1] - best[0] < 0.1) best = [host.rect[1], Math.min(host.rect[1] + host.rect[3], 0.45)];
  console.log(`  · a stand-in host from ${(best[0] * 100).toFixed(0)}%–${(best[1] * 100).toFixed(0)}% of the frame — the slice nothing else is drawn into`);
  const plate = path.join(CWD, "assets", "host-plate.mp4");
  mkdirSync(path.join(CWD, "assets"), { recursive: true });
  execFileSync("node", [path.join(HERE, "make-plate.mjs"), "--source", SOURCE,
    "--top", best[0].toFixed(4), "--bottom", best[1].toFixed(4), "--out", plate], { encoding: "utf8" });
  HOST = plate;
}
for (const t of bp.tracks) {
  const fill = t.fill ?? bpLib.defaultFill(t.kind);
  if (fill !== "cut") continue;
  const region = bp.regions.find((r) => r.id === t.region);
  if (!region) continue;
  const supplied = HOST && /presenter|host|stage|figure/i.test(region.id)
    ? (existsSync(HOST) ? HOST : path.join(STORE, HOST)) : null;
  if (supplied && existsSync(supplied)) {
    const name = `host${path.extname(supplied)}`;
    mkdirSync(path.join(CWD, "assets"), { recursive: true });
    copyFileSync(supplied, path.join(CWD, "assets", name));
    cuts.set(region.id, `assets/${name}`);
    console.log(`  · ${region.id}: your own, from ${path.basename(supplied)}`);
    continue;
  }
  // Nothing supplied: take the region out of the film being watched, for its own span —
  // unless there IS no film here (a --from-template run with no --source). That is not a
  // reason to fabricate a source; it is a hole, and it stays visible rather than silent.
  if (!SOURCE) {
    console.log(`  · ${region.id}: no film to cut from and nothing supplied — left as a hole (pass --host)`);
    continue;
  }
  try {
    let [x, y, w, h] = region.rect;
    // Stop the cut above any writing that lies over it.
    //
    // A presenter's box runs the full height of the frame, and the format's caption sits
    // near the bottom of it — so a straight cut brings the ORIGINAL's words along, and the
    // clone ends up with two captions sliding through each other. Cropping short of the
    // band loses nothing, because the band is exactly the strip our own caption is about to
    // cover.
    const written = bp.regions
      .filter((r) => r.role === "text" && r.id !== region.id)
      .map((r) => r.rect)
      .filter((t) => t[1] > y + h * 0.4 && t[0] < x + w && t[0] + t[2] > x)
      .reduce((top, t) => Math.min(top, t[1]), Infinity);
    if (Number.isFinite(written) && written > y) {
      const cut = written - y;
      console.log(`  · ${region.id}: cut stops at ${written.toFixed(3)} — above the film's own lettering`);
      h = cut;
    }
    const name = `${region.id}.mp4`;
    mkdirSync(path.join(CWD, "assets"), { recursive: true });
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", SOURCE,
      "-vf", `crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)}`,
      "-an", path.join(CWD, "assets", name)], { encoding: "utf8" });
    cuts.set(region.id, `assets/${name}`);
    console.log(`  · ${region.id}: cut from the film being watched (pass --host to replace them)`);
  } catch (e) {
    console.log(`  ✗ ${region.id}: could not be cut — ${e.message.split("\n")[0]}`);
  }
}

// ── 4. compose ─────────────────────────────────────────────────────────────────
mkdirSync(path.join(CWD, "assets"), { recursive: true });
const given = new Map();
for (const [slot, name] of Object.entries(made)) {
  const from = path.join(STORE, String(name));
  if (!existsSync(from)) continue;
  copyFileSync(from, path.join(CWD, "assets", path.basename(from)));
  given.set(slot, `assets/${path.basename(from)}`);
}
const html = compose.composeBlueprint(bp, {
  recipe,
  assetFor: (track, _item, i) =>
    given.get(`${track.region}:${i}`) ?? given.get(track.region) ?? cuts.get(track.region) ?? null,
});
writeFileSync(path.join(CWD, "index.html"), html);
writeFileSync(path.join(CWD, "blueprint.json"), JSON.stringify(bp, null, 2));
writeFileSync(path.join(CWD, "recipe.json"), JSON.stringify(recipe, null, 2));
writeFileSync(path.join(CWD, "hyperframes.json"), JSON.stringify({
  name: SLUG, composition: "index.html",
  width: Math.round(bp.canvas.width), height: Math.round(bp.canvas.height),
  fps: Math.round(bp.canvas.fps), duration: bp.canvas.seconds,
}, null, 2));
const holes = (html.match(/class="it missing"/g) ?? []).length;
console.log(`\n${SLUG}: ${(html.match(/^ +tl\./gm) ?? []).length} tween(s), ${holes} unfilled slot(s)`);
console.log(`project: ${CWD}`);

// ── 5. one frame, against the film ─────────────────────────────────────────────
const snaps = path.join(CWD, "snapshots");
try {
  const snapArgs = ["snapshot", CWD, "-o", snaps, "--at", String(AT), "--no-end", "--describe", "false"];
  // A pair sheet needs something to put beside the render. There is one by default whenever
  // a film was opened; a --from-template run with no --source has nothing to compare against
  // unless one was named, and skipping the flag is honest about that rather than passing an
  // empty string hyperframes would have to reject on its own.
  const against = arg("against", SOURCE || "");
  if (against) snapArgs.push("--against", against);
  execFileSync("hyperframes", snapArgs, { encoding: "utf8", maxBuffer: 1 << 28 });
  console.log(`pair sheet: ${snaps}`);
} catch (e) {
  console.error(`the frame could not be taken: ${e.message}`);
}

// ── 6. the film, on request ────────────────────────────────────────────────────
if (has("film")) {
  const mp4 = path.join(CWD, "renders", `${SLUG}.mp4`);
  console.log(`\nrendering ${bp.canvas.seconds.toFixed(0)}s …`);
  const out = execFileSync("hyperframes", ["render", CWD, "-o", mp4], { encoding: "utf8", maxBuffer: 1 << 28 });
  for (const l of out.split("\n")) if (/rendered in|static-dedup\] reused/.test(l)) console.log(`  ${l.trim()}`);
  console.log(`\nfilm: ${mp4}`);
}
