#!/usr/bin/env node
// The generation gate: not "did we copy the words" (eval-text.mjs asks that) but "given a
// film, can we make a DIFFERENT film in the same format?"
//
//   node agent-os-module/scripts/eval-generate.mjs                       # every runnable case
//   node agent-os-module/scripts/eval-generate.mjs --case ranking-football--swap-topic
//
// eval-text.mjs scores "extract" cases: their authored script IS the film's own script, so
// the extraction can be checked word for word. A "generate" case is the same film with a
// DIFFERENT intended script — a swapped topic, a swapped effect — and scoring our extraction
// against that script would only prove the two scripts differ, which is the premise. That
// question belongs here instead: build the clone, MEASURE WHAT CAME OUT with the same
// measuring code that measured the source, and compare the two measurements structurally.
// A format that survived the swap produces the same structure with different content. A
// format that did not produces a different structure — a board that lost rows, a caption
// that moved, a layer that vanished, a picture layer that stopped being pictures.
//
// Spends no image/video generation credits: the clone is built with --still (draw empty
// boxes, ask no provider for pictures) and --mock-host (a stand-in host plate cut from the
// film's own quietest frame, one ffmpeg call, zero credits — see make-plate.mjs). The one
// thing this gate measures for real is the render clone-film.mjs produces from those two
// flags, which is genuinely the same compose-and-render path a real clone goes through; only
// the picture PROVIDER is skipped.
//
// What "the source" means here is not re-measured from scratch: clone-film.mjs already
// measures the source once, to build the clone, and writes that measurement to the project's
// blueprint.json. That IS "the same measuring code that measured the source" — reading it
// back is cheaper than asking the grounding model the same question twice, and it is the
// literal blueprint the clone was built from rather than a second, possibly-different
// sampling of it. Only the RESULT — the rendered clone — gets a fresh measurement here.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = path.join(HERE, "..", "src");
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(homedir(), "Documents", "agent-os", "source");
const CACHE = path.join(homedir(), ".agentic-os", "omniwatch", "cache");
const PROJECTS = path.join(homedir(), ".agentic-os", "video-projects");
const EVAL = path.join(HERE, "..", "test", "eval");
const CAPTURES = path.join(EVAL, "captures");
const ONLY = process.argv.find((a, i) => process.argv[i - 1] === "--case");

/** What "passing" means, and what each floor was measured against. Same discipline as
 *  eval-text.mjs's BAR: these are floors below which a viewer would see a different format,
 *  not scores to maximise.
 *
 *  Everything here is either a COUNT (rows, pictures, the order layers stack in) — which has
 *  to match exactly, because being one off means a row or a layer is actually missing — or a
 *  POSITION, which is allowed the same slack the measuring code already gives itself. */
const BAR = {
  /** A region's box is "the same place" if it does not drift by more than this, summed over
   *  x, y, width, height (the same L1 distance omniwatchMeasure.ts uses). Not invented here:
   *  it is the exact threshold `layoutsSimilar()` in src/lib/omniwatchMeasure.ts uses to
   *  decide two measurements of the SAME film are the same layout (see that function) — if
   *  two samples of one film are allowed to drift this much and still count as unchanged,
   *  two samples a render apart cannot be held to a tighter number without the bar being
   *  stricter than the measuring code trusts itself to be. */
  regionDrift: 0.08,
  /** Board rows are a count of things — a tier list either has five rows or it does not —
   *  so this is exact, not a tolerance. Losing a row is the headline failure this gate
   *  exists to catch (docs/GRAPH-PLAN.md, "a board that lost rows"). */
  boardRowsExact: true,
  /** Pictures pinned to speech (the insert/overlay layer) are also a count of things — the
   *  same reasoning eval-text.mjs uses for `spansExact`. One short is a card the clone
   *  dropped; one over is a card it invented. Measured two different ways on the two sides
   *  of the comparison (see `cloneHoles` in runGenerateCase) because a --still render draws
   *  that layer as empty boxes on purpose, and an empty box has no picture in it for a
   *  vision-grounding call to find — that is not a defect to paper over, it is why the count
   *  is read off the composed HTML on that side instead of off the render's pixels. */
  spansExact: true,
  /** The stacking order of the regions that carry content (sorted by z) has to match
   *  exactly: a caption drawn BEHIND the board instead of in front of it is not a drifted
   *  position, it is a different film, even where the rectangles happen to line up. */
  layerOrderExact: true,
};

/** Which cached film each authored reference was made from, and what kind of case it is.
 *  Shared with eval-text.mjs; not duplicated, read straight from the same file so a case
 *  added there is visible here without a second edit. */
const SOURCES = JSON.parse(readFileSync(path.join(EVAL, "sources.json"), "utf8")).cases;

const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const work = mkdtempSync(path.join(tmpdir(), "omni-evalgen-"));
writeFileSync(path.join(work, "omniwatch.js"), `
const { execFileSync } = require("node:child_process");
exports.run = async (c, a) => execFileSync(c, a, { encoding: "utf8", maxBuffer: 1 << 28 });
exports.videoDir = (id) => require("node:path").join(${JSON.stringify(CACHE)}, id);
exports.apiKey = async () => process.env.DASHSCOPE_API_KEY || null;
exports.OMNI_ROOT = require("node:path").join(require("node:os").homedir(), ".agentic-os/omniwatch");
`);
// The lib files require each other by relative path once transpiled (@/lib/X → ./X.js), and
// which file needs which keeps changing as the pipeline grows — omniwatchGround now pulls in
// omniwatchNode, omniwatchCues now pulls in omniwatchStage, neither true when eval-text.mjs's
// loader (which this one copies) was written. Loading one file at a time in a fixed list
// breaks every time an edit adds a cross-import the list does not yet know about. So: write
// every lib file to disk (transpiled, not executed) before requiring any of them — Node's
// own require() then resolves whatever a module actually needs, in whatever order, because
// the file is already there.
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
      // A sibling lib this gate never touches, mid-edit elsewhere: skip it here, and let a
      // real require() failure (from something that actually needs it) surface on its own.
    }
  }
}
function load(name) {
  writeAllLibs();
  return req(path.join(work, `${name}.js`));
}
load("omniwatchBlueprint"); load("omniwatchBoardScan"); load("omniwatchRecipe");
load("omniwatchNode"); load("omniwatchGround"); load("omniwatchTranscript"); load("omniwatchMotion");
load("omniwatchStage"); load("omniwatchPrompt");
load("omniwatchCues");
const measureLib = load("omniwatchMeasure");

// ── structural fingerprints ──────────────────────────────────────────────────────
// What "the format" means for this comparison: not the pixels, not the words — the shape.
// Every one of these is exactly what docs/GRAPH-PLAN.md names as what a swap must preserve:
// "the same regions in the same places, the same board with the same number of rows, the
// caption band in the same place ..., the same layers in the same order, the same kinds of
// motion."

const boardRows = (bp) => new Set(bp.regions
  .filter((r) => /-(label|slot)$/.test(r.id)).map((r) => r.id.replace(/-(label|slot)$/, ""))).size;

const captionRect = (bp) => bp.regions.find((r) => /caption/i.test(r.id))?.rect ?? null;

const presenterRect = (bp) => bp.regions.find((r) => r.role === "figure" && /presenter|host|stage/i.test(r.id))?.rect
  ?? bp.regions.find((r) => r.role === "figure")?.rect ?? null;

/** The stacking order: which roles sit in front of which, independent of their id. Two
 *  formats with the caption behind the board instead of in front of it are not "close" —
 *  the film reads differently even if every rectangle is identical. */
const layerOrder = (bp) => [...bp.regions].sort((a, b) => a.z - b.z).map((r) => r.role);

/** Which kinds of track (text / image / video) each region carries, region by region. This
 *  is the closest a static frame-sampling measurer can get to "kinds of motion": a region
 *  that gained or lost a video/image track between the source and the render gained or lost
 *  whatever moved through it. */
function trackKindsByRegion(bp) {
  const m = new Map();
  for (const t of bp.tracks) {
    const s = m.get(t.region) ?? new Set();
    s.add(t.kind);
    m.set(t.region, s);
  }
  return m;
}

/** The region eval-text.mjs already treats as "the insert layer" — the timed pictures a tier
 *  list drops over its board, told apart from the caption and the title band by the same
 *  id pattern that file uses, so the two gates agree on what they are counting. */
const overlayRegionOf = (bp) => bp.regions.find((r) => /overlay|insert/i.test(r.id) && !/caption|banner/i.test(r.id));

/** EVERY region with role "overlay" — a format can carry more than one (this source's own
 *  capture has three: `board-overlay`, plus two named portrait insets). All of them are
 *  pictures layered over something else, and --still draws every one of them as an empty box
 *  by construction, so none of them can be found again from the render's pixels. */
const overlayRoleRegions = (bp) => new Set(bp.regions.filter((r) => r.role === "overlay").map((r) => r.id));

/** How many timed pictures are pinned over the board, from a REAL measurement (pixels the
 *  aligner and the grounding model actually looked at). Only meaningful on the source side —
 *  see the note beside `cloneHoles` in runGenerateCase for why the render side is not asked
 *  this question the same way. */
function spanCount(bp) {
  const overlay = overlayRegionOf(bp);
  if (!overlay) return 0;
  return bp.tracks.find((t) => t.region === overlay.id && t.kind !== "text")?.items.length ?? 0;
}

const rectDist = (a, b) => !a || !b ? Infinity : a.reduce((s, n, i) => s + Math.abs(n - b[i]), 0);

/** Regions and tracks minus every overlay-role layer. Used for every STRUCTURAL comparison
 *  (region count, layer order, track kinds) because the render side of this gate is measured
 *  with those regions already stripped from its input — see runGenerateCase — so comparing
 *  the full source fingerprint against a necessarily-overlay-free render fingerprint would
 *  report a layer "vanishing" that was never asked to be found in the first place. */
function withoutOverlay(bp) {
  const drop = overlayRoleRegions(bp);
  if (!drop.size) return bp;
  return {
    ...bp,
    regions: bp.regions.filter((r) => !drop.has(r.id)),
    tracks: bp.tracks.filter((t) => !drop.has(t.region)),
  };
}

function fingerprint(bp) {
  const core = withoutOverlay(bp);
  return {
    regionCount: core.regions.length,
    boardRows: boardRows(core),
    caption: captionRect(core),
    presenter: presenterRect(core),
    layers: layerOrder(core),
    tracks: trackKindsByRegion(core),
    // Real only on the side that was actually measured from pixels (the source). The render
    // side overwrites this in runGenerateCase with a count that answers the same question a
    // different, honest way.
    spans: spanCount(bp),
  };
}

/** Compare two fingerprints and say, in the same vocabulary docs/GRAPH-PLAN.md uses, what
 *  did not survive the swap. Empty array = the format survived. */
function compareFingerprints(src, clone) {
  const failed = [];
  if (BAR.boardRowsExact && src.boardRows !== clone.boardRows) {
    failed.push(`board rows: source measured ${src.boardRows}, the render measured ${clone.boardRows}`);
  }
  const capDrift = rectDist(src.caption, clone.caption);
  if (src.caption && clone.caption && capDrift > BAR.regionDrift) {
    failed.push(`caption band moved: drift ${capDrift.toFixed(3)} > ${BAR.regionDrift} (source ${JSON.stringify(src.caption.map((n) => Math.round(n * 1000) / 1000))}, render ${JSON.stringify(clone.caption.map((n) => Math.round(n * 1000) / 1000))})`);
  } else if (Boolean(src.caption) !== Boolean(clone.caption)) {
    failed.push(`caption band ${src.caption ? "vanished" : "appeared"} in the render`);
  }
  const presDrift = rectDist(src.presenter, clone.presenter);
  if (src.presenter && clone.presenter && presDrift > BAR.regionDrift) {
    failed.push(`presenter stage moved: drift ${presDrift.toFixed(3)} > ${BAR.regionDrift}`);
  } else if (Boolean(src.presenter) !== Boolean(clone.presenter)) {
    failed.push(`presenter stage ${src.presenter ? "vanished" : "appeared"} in the render`);
  }
  if (BAR.layerOrderExact && src.layers.join(">") !== clone.layers.join(">")) {
    failed.push(`layer stacking order changed: source [${src.layers.join(", ")}] vs render [${clone.layers.join(", ")}]`);
  }
  if (BAR.spansExact && src.spans !== clone.spans) {
    failed.push(`pictures pinned over the board: source measured ${src.spans}, the render's composition placed ${clone.spans} slot(s) for them`);
  }
  // Region-by-region track kinds, only for regions BOTH measurements found — a region that
  // exists in one and not the other is already reported by regionCount/boardRows above.
  for (const [region, kinds] of src.tracks) {
    const other = clone.tracks.get(region);
    if (!other) continue;
    const a = [...kinds].sort().join(",");
    const b = [...other].sort().join(",");
    if (a !== b) failed.push(`region "${region}" carried [${a}] in source, [${b}] in the render`);
  }
  return failed;
}

// ── run the cheap clone and measure what came out ────────────────────────────────

function renderProjectPaths(slug) {
  const cwd = path.join(PROJECTS, slug);
  return { cwd, blueprint: path.join(cwd, "blueprint.json"), mp4: path.join(cwd, "renders", `${slug}.mp4`) };
}

/** A capture describes what a RECORDING contains — its regions, its canvas, which region
 *  carries the board, the caption band, the presenter. None of that changes when a swap case
 *  changes the words being said: `podcast--swap-app` is the same 18s recording as
 *  `podcast--reference`, filmed on the same stage, with a different answer spoken into it. So
 *  a case with no capture of its own is not a case with no capture — it is a case whose
 *  capture is its format's `--reference`, and the honest thing is to say so out loud rather
 *  than have a byte-identical file sitting in test/eval/captures/ with no note explaining why
 *  it is identical. (Three ranking captures used to exist exactly that way — see git history
 *  before this comment — and this function replaces them.)
 *
 *  This only ever falls back to the SAME format's reference (matched on the text before
 *  "--"): a podcast case never borrows an interview's layout, because those are different
 *  recordings with different regions. Returns null, with the caller left to report why, when
 *  even the reference has no capture — that would mean the format itself was never captured. */
function resolveCaptureFile(name) {
  const own = path.join(CAPTURES, `${name}.json`);
  if (existsSync(own)) return { file: own, reused: false };
  const format = name.split("--")[0];
  const reference = path.join(CAPTURES, `${format}--reference.json`);
  if (existsSync(reference)) return { file: reference, reused: true, from: `${format}--reference.json` };
  return null;
}

async function runGenerateCase(name, entry) {
  const sourceId = entry.source;
  const source = sourceId ? path.join(CACHE, sourceId, "source.mp4") : null;
  if (!source || !existsSync(source)) {
    const why = sourceId ? "source not in the cache" : "no source film mapped";
    console.log(`— ${name}: ${why} — skipped, not scored`);
    return { name, scored: false, why };
  }
  const resolved = resolveCaptureFile(name);
  if (!resolved) {
    console.log(`— ${name}: no capture at ${path.join(CAPTURES, `${name}.json`)}, and no reference capture for its format either — skipped, not scored`);
    return { name, scored: false, why: "no capture for this case or its format" };
  }
  if (resolved.reused) {
    console.log(`  ${name}: no capture of its own — reusing ${resolved.from} (same recording, same layout, different words)`);
  }
  const capture = JSON.parse(readFileSync(resolved.file, "utf8"));
  const at = Math.min(8.5, (capture.canvas?.seconds ?? 20) / 2);

  const slug = `eval-generate--${name}`;
  console.log(`  ${name}: building the clone (--still --mock-host --film, no credits spent) …`);
  let cloneLog;
  try {
    cloneLog = execFileSync("node", [
      path.join(HERE, "clone-film.mjs"),
      "--source", sourceId, "--capture", resolved.file, "--slug", slug,
      "--at", String(at), "--still", "--mock-host", "--film",
    ], { encoding: "utf8", maxBuffer: 1 << 28, cwd: path.join(HERE, "..") });
  } catch (e) {
    const msg = (e.stdout || "") + (e.stderr || e.message);
    console.log(`✗ ${name}: clone-film.mjs failed — ${msg.split("\n").filter(Boolean).slice(-3).join(" | ")}`);
    return { name, scored: false, why: "clone-film.mjs failed to build the clone" };
  }

  const { blueprint: bpFile, mp4 } = renderProjectPaths(slug);
  if (!existsSync(bpFile)) {
    console.log(`✗ ${name}: clone ran but wrote no blueprint.json at ${bpFile}`);
    return { name, scored: false, why: "clone produced no blueprint" };
  }
  if (!existsSync(mp4)) {
    console.log(`✗ ${name}: clone ran but rendered no file at ${mp4}`);
    return { name, scored: false, why: "clone produced no render" };
  }
  const srcBp = JSON.parse(readFileSync(bpFile, "utf8"));

  // Zero-cost aligner: the mock-host plate carries the SOURCE's own soundtrack for its full
  // length (make-plate.mjs), so the words in the render's audio are, in fact, the source's
  // words at the source's times. Seeding the cache with them is not a guess standing in for
  // a real answer — it is the real answer, already paid for once — and it is what stops this
  // measurement from asking a paid transcription API to listen to audio we already have the
  // transcript of.
  const renderDir = path.dirname(mp4);
  const wordsCache = path.join(renderDir, "words.json");
  const sourceWords = path.join(CACHE, sourceId, "words.json");
  if (!existsSync(wordsCache) && existsSync(sourceWords)) {
    copyFileSync(sourceWords, wordsCache);
  }

  // The insert/overlay layer cannot be asked for here: --still draws it as empty boxes by
  // construction (no provider was asked for a picture), so there is no picture on the
  // rendered frame for a vision-grounding call to find, and asking anyway does not fail
  // quietly — refineBlueprint returns a region with no track, and validateBlueprint (rightly)
  // refuses a region that carries nothing. Stripping it from the INPUT this measurement is
  // given is the honest fix: this gate is not asking "does the render's insert layer look
  // like a picture" (it never can, under --still), it asks the question the composed HTML can
  // actually answer instead — see `cloneHoles` below.
  const dropForRender = overlayRoleRegions(capture);
  const renderCapture = dropForRender.size
    ? { ...capture,
        regions: capture.regions.filter((r) => !dropForRender.has(r.id)),
        tracks: capture.tracks.filter((t) => !dropForRender.has(t.region)) }
    : capture;

  console.log(`  ${name}: measuring the render at t=${at.toFixed(2)}s …`);
  const cloneWorkDir = path.join(work, `measure-${name}`);
  mkdirSync(cloneWorkDir, { recursive: true });
  const cloneMeasured = await measureLib.measureBlueprint(renderCapture, {
    sourcePath: mp4, workDir: cloneWorkDir, at: [at],
  });
  if (!cloneMeasured.ok) {
    console.log(`✗ ${name}: could not measure the render — ${cloneMeasured.error}`);
    return { name, scored: false, why: `measure(render) failed: ${cloneMeasured.error}` };
  }

  const srcFp = fingerprint(srcBp);
  const cloneFp = fingerprint(cloneMeasured.blueprint);
  // What the render's OWN composition actually placed for the insert layer, read off the
  // same HTML clone-film.mjs already wrote and already summarises as "N unfilled slot(s)" in
  // its own log — an empty box under --still still occupies a slot, it just has no picture in
  // it, and counting the slots is a fair, free stand-in for counting pictures.
  // Scoped to the insert/overlay region's OWN block, not the whole document: this format
  // also carries per-row tier photos (s-slot..d-slot) and named portrait insets, each their
  // own "it missing" divs under --still, and counting the page's total conflated all of them
  // into one number that had nothing to do with the board-overlay layer eval-text.mjs (and
  // srcFp.spans above) actually measures. composeBlueprint emits one flat, unnested block per
  // region — `<div class="rg rg-<role>" id="rg-<id>">...items...</div>` — so the region's own
  // items are exactly what sits between its opening tag and the first 4-space-indented
  // closing </div>; item divs are indented six spaces, so that boundary is unambiguous.
  const html = readFileSync(path.join(renderProjectPaths(slug).cwd, "index.html"), "utf8");
  const overlayId = overlayRegionOf(srcBp)?.id;
  const overlayBlock = overlayId
    ? html.match(new RegExp(`<div class="rg rg-overlay" id="rg-${overlayId}"[\\s\\S]*?\\n    </div>`))?.[0]
    : null;
  cloneFp.spans = overlayBlock ? (overlayBlock.match(/class="it missing"/g) ?? []).length : 0;

  const failed = compareFingerprints(srcFp, cloneFp);

  console.log(`    board  source ${srcFp.boardRows} row(s), render ${cloneFp.boardRows} row(s)`);
  console.log(`    spans  source measured ${srcFp.spans} picture(s) pinned to speech, render's composition placed ${cloneFp.spans} slot(s)`);
  console.log(`    layers source [${srcFp.layers.join(", ")}]`);
  console.log(`           render [${cloneFp.layers.join(", ")}]`);
  if (srcFp.caption && cloneFp.caption) {
    console.log(`    caption drift ${rectDist(srcFp.caption, cloneFp.caption).toFixed(3)} (bar ${BAR.regionDrift})`);
  }

  return {
    name, scored: true, sourceId, mp4,
    source: srcFp, clone: cloneFp, failed,
  };
}

const chosen = Object.entries(SOURCES).filter(([name, e]) => e.kind === "generate" && (!ONLY || name === ONLY));
if (!chosen.length) {
  console.error(ONLY ? `no generate case named "${ONLY}"` : "no generate cases in sources.json");
  process.exit(1);
}

console.log(`generation gate — ${chosen.length} generate case(s) declared\n`);

const rows = [];
// A verdict per case, the moment it is known, and by default nothing rendered after the
// first failure. The gate used to hold every verdict back until the scorecard, so a case
// that failed in third place still paid for five more renders nobody was going to trust —
// and until the last one finished there was nothing to watch. Both are the same mistake:
// work that has already answered the question should not be repeated silently.
const KEEP_GOING = process.argv.includes("--all");
for (const [name, entry] of chosen) {
  const row = await runGenerateCase(name, entry);
  rows.push(row);
  if (row.scored) {
    const verdict = row.failed.length ? `BELOW THE BAR — ${row.failed.join("; ")}` : "clears the bar";
    console.log(`    => ${name}: ${verdict}   [${rows.length}/${chosen.length}]`);
  } else {
    console.log(`    => ${name}: not scored — ${row.why}   [${rows.length}/${chosen.length}]`);
  }
  if (row.scored && row.failed.length && !KEEP_GOING) {
    console.log(`\nstopping here: ${name} is below the bar, and the cases after it would only`);
    console.log(`cost renders to tell us something we already know. Pass --all to run them anyway.`);
    break;
  }
}

const scored = rows.filter((r) => r.scored);
const runnable = rows.filter((r) => r.scored || r.why?.startsWith("measure") || r.why?.startsWith("clone"));

const md = [
  "# Eval — the generation gate: does the format survive a content swap",
  "",
  "Not text-for-text: a `generate` case authors a DIFFERENT script for the same film, on",
  "purpose. What has to survive is the FORMAT — regions, board rows, caption placement,",
  "layer order, the kinds of motion in each layer — measured from the film once (by",
  "clone-film.mjs, to build the clone) and again from the clone's own render, then compared.",
  "",
  `Run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  "",
  "| case | board rows | pictures pinned | layer order | verdict |",
  "|---|---|---|---|---|",
  ...rows.map((r) => r.scored
    ? `| \`${r.name}\` | ${r.source.boardRows} → ${r.clone.boardRows} | ${r.source.spans} → ${r.clone.spans} | ${r.source.layers.join(">") === r.clone.layers.join(">") ? "unchanged" : "**changed**"} | ${r.failed.length ? "**below the bar**" : "clears the bar"} |`
    : `| \`${r.name}\` | — | — | — | _${r.why}_ |`),
  "",
  "## What the columns mean",
  "",
  "**Board rows** — how many labelled tier rows the format has, measured from the source and",
  "again from the render. A count, not a percentage: losing one is losing a row.",
  "",
  "**Pictures pinned** — the insert layer's item count, source vs render. Also exact: a",
  "format either drops the same number of pictures over its board or it does not.",
  "",
  "**Layer order** — the regions carrying content, sorted by z. Changed order means a layer",
  "moved in front of or behind another one, independent of where its rectangle sits.",
].join("\n");
writeFileSync(path.join(EVAL, "EVAL-GENERATE.md"), md);
writeFileSync(path.join(EVAL, "eval-generate.json"), JSON.stringify(rows, null, 2));

console.log(`\nscorecard: ${path.join(EVAL, "EVAL-GENERATE.md")}`);
for (const r of scored) for (const why of r.failed) console.log(`✗ ${r.name}: ${why}`);
for (const r of rows) if (!r.scored) console.log(`— ${r.name}: not scored — ${r.why}`);

if (!scored.length) {
  console.log(`scored nothing: 0 of ${rows.length} generate case(s) could be measured`);
  process.exit(1);
}
const bad = scored.filter((r) => r.failed.length);
console.log(bad.length
  ? `${bad.length} of ${scored.length} scored case(s) below the bar`
  : `all ${scored.length} scored case(s) clear the bar`);
process.exit(bad.length ? 1 : 0);
