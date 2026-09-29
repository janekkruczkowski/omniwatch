#!/usr/bin/env node
// The cheap gate: compare what we EXTRACT with what someone else AUTHORED, as text.
//
//   node agent-os-module/scripts/eval-text.mjs                  # every case with a source
//   node agent-os-module/scripts/eval-text.mjs --case ranking-football--reference
//
// A render costs minutes and money and answers a question the data already answers. Before
// any of that: did we come out of the film with the same FACTS the reference was built from?
// Their authored source is a data model — the words, where the caption breaks, which stretch
// of speech each insert is pinned to — and ours is a blueprint. Both are text. Comparing them
// is free, repeatable, and fails loudly in exactly the places that matter.
//
// What is scored, in order of how much it would hurt to get wrong:
//
//   words   — did we hear the same thing? Everything downstream is anchored to this.
//   cues    — do the caption chunks break where theirs break? A format's rhythm IS its cuts.
//   spans   — are the same number of pictures pinned to the same stretches of speech?
//
// Nothing here renders, generates or downloads. Pictures are placeholders by construction:
// the question is whether the film's STRUCTURE came out right, and a generated photograph
// cannot make a wrong structure right or a right one wrong.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = path.join(HERE, "..", "src");
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(homedir(), "Documents", "agent-os", "source");
const CACHE = path.join(homedir(), ".agentic-os", "omniwatch", "cache");
const EVAL = path.join(HERE, "..", "test", "eval");
const GROUND = path.join(EVAL, "ground");
const CAPTURES = path.join(EVAL, "captures");
const ONLY = process.argv.find((a, i) => process.argv[i - 1] === "--case");

/** A capture describes what a RECORDING contains, not what is said in it — an `extract` swap
 *  case (their authored script for the same film, with the host or a detail swapped) is shot
 *  on the same stage as its format's `--reference` and needs no capture of its own. Shared
 *  with eval-generate.mjs's `resolveCaptureFile`, same reasoning: never duplicated as a
 *  byte-identical file with no note saying why, and never borrows a DIFFERENT film's capture
 *  — only ever falls back to the same format's own reference, matched on the text before "--". */
function resolveCaptureFile(name) {
  const own = path.join(CAPTURES, `${name}.json`);
  if (existsSync(own)) return { file: own, reused: false };
  const format = name.split("--")[0];
  const reference = path.join(CAPTURES, `${format}--reference.json`);
  if (existsSync(reference)) return { file: reference, reused: true, from: `${format}--reference.json` };
  return null;
}

/** What "passing" means, written down rather than read off whatever today's numbers happen
 *  to be. Each bar answers a question somebody would actually ask about a clone.
 *
 *  Nothing here is a score to maximise. They are floors: below them the extraction is wrong
 *  in a way a viewer would notice, and above them the remaining difference is taste. */
const BAR = {
  /** Did we hear the film? Everything anchored to speech rests on this, and a tenth of a
   *  script missing is a caption that says something the host did not. */
  words: 0.9,
  /** Did we break the captions where the format breaks them? Not all of them — a format's
   *  rhythm survives a break landing a word early — but most. */
  breaks: 0.7,
  /** Did we find the same number of pictures pinned to speech? Exact, because this is a
   *  count of things, and being one out means a card is missing or invented. */
  spansExact: true,
};

/** Which cached film each authored reference was made from. A case with no source can still
 *  be read — it just cannot be scored, and says so rather than being quietly dropped. */
const SOURCES = JSON.parse(readFileSync(path.join(EVAL, "sources.json"), "utf8")).cases;

const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const work = mkdtempSync(path.join(tmpdir(), "omni-evaltext-"));
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
load("omniwatchBlueprint"); load("omniwatchBoardScan"); load("omniwatchRecipe");
load("omniwatchNode"); load("omniwatchGround"); load("omniwatchTranscript"); load("omniwatchMotion");
load("omniwatchStage"); load("omniwatchPrompt");
const cuesLib = load("omniwatchCues");
const measureLib = load("omniwatchMeasure");

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/** How much of THEIR script we heard, as a longest-common-subsequence over normalised
 *  words. Not a character score: a caption is made of words, and a word half-heard is a
 *  word missed. */
function wordAgreement(mine, theirs) {
  const a = mine.map(norm).filter(Boolean);
  const b = theirs.map(norm).filter(Boolean);
  if (!b.length) return { matched: 0, of: 0, ratio: 1 };
  // Classic LCS, small inputs — a short-form script is under 200 words.
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matched = dp[a.length][b.length];
  return { matched, of: b.length, ratio: matched / b.length };
}

/** Where their cue breaks fall, counted in words from the start of the script. */
function breakPositions(segments) {
  const at = [];
  let base = 0;
  for (const seg of segments) {
    let n = 0;
    for (const cue of seg.cues.slice(0, -1)) {
      n += cue.split(/\s+/).filter(Boolean).length;
      at.push(base + n);
    }
    base += seg.words.length;
  }
  return at;
}

/** Our own cue breaks, in the same unit: the index of the first word of each caption item,
 *  counted over the caption track in order. */
function ourBreaks(bp) {
  const region = bp.regions.find((r) => /caption/i.test(r.id));
  const track = bp.tracks.find((t) => t.kind === "text" && t.region === region?.id);
  if (!track) return { at: [], words: [] };
  const items = [...track.items].sort((a, b) => a.start - b.start);
  const words = [];
  const at = [];
  for (const it of items) {
    if (words.length) at.push(words.length);
    for (const w of it.value.replace(/\[\[|\]\]/g, "").split(/\s+/).filter(Boolean)) words.push(w);
  }
  return { at, words, items };
}

const pctOf = (n) => `${Math.round(n * 100)}%`;

const files = readdirSync(GROUND).filter((f) => f.endsWith(".json"));
const chosen = files.filter((f) => !ONLY || f === `${ONLY}.json`);
const rows = [];

for (const file of chosen) {
  const name = file.replace(/\.json$/, "");
  const truth = JSON.parse(readFileSync(path.join(GROUND, file), "utf8"));
  const entry = SOURCES[name] ?? {};
  const sourceId = entry.source;
  // A "generate" case is the same film with a DIFFERENT intended script — their swapped
  // topic, their swapped effect. Scoring our extraction against it would only prove the two
  // scripts differ, which is the premise. It belongs to the generation gate, not this one.
  if (entry.kind === "generate") {
    rows.push({ name, scored: false, kind: "generate",
      why: "a target for the generation gate, not a reference for extraction",
      theirs: { segments: truth.segments.length,
                cues: truth.segments.reduce((n, x) => n + x.cues.length, 0),
                spans: truth.segments.reduce((n, x) => n + x.spans.length, 0),
                words: truth.segments.flatMap((x) => x.words).length } });
    console.log(`· ${name}: generation target (${truth.segments.reduce((n, x) => n + x.spans.length, 0)} spans authored) — not scored here`);
    continue;
  }
  const source = sourceId ? path.join(CACHE, sourceId, "source.mp4") : null;
  const theirWords = truth.segments.flatMap((s) => s.words);
  const theirSpans = truth.segments.reduce((n, s) => n + s.spans.length, 0);
  const theirCues = truth.segments.reduce((n, s) => n + s.cues.length, 0);

  if (!source || !existsSync(source)) {
    rows.push({ name, scored: false, why: sourceId ? "source not in the cache" : "no source film mapped",
      theirs: { segments: truth.segments.length, cues: theirCues, spans: theirSpans, words: theirWords.length } });
    console.log(`— ${name}: ${sourceId ? "source not in the cache" : "no source film mapped"}`);
    continue;
  }

  const resolved = resolveCaptureFile(name);
  if (!resolved) {
    rows.push({ name, scored: false, why: "no capture for this case or its format" });
    console.log(`— ${name}: no capture at ${path.join(CAPTURES, `${name}.json`)}, and no reference capture for its format either`);
    continue;
  }
  if (resolved.reused) {
    console.log(`  ${name}: no capture of its own — reusing ${resolved.from} (same recording, same layout, different words)`);
  }
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  const capture = JSON.parse(readFileSync(resolved.file, "utf8"));
  const measured = await measureLib.measureBlueprint(capture, { sourcePath: source, workDir: dir, at: [Math.min(8.5, (capture.canvas?.seconds ?? 20) / 2)] });
  if (!measured.ok) {
    rows.push({ name, scored: false, why: `measure failed: ${measured.error}` });
    console.log(`✗ ${name}: ${measured.error}`);
    continue;
  }

  // The words we heard, from the aligner — the same cache the clone path uses.
  const heard = (await cuesLib.wordTimes(source, dir, [])) ?? [];
  const words = wordAgreement(heard.map((w) => w.text), theirWords);

  const mine = ourBreaks(measured.blueprint);
  const theirAt = breakPositions(truth.segments);
  // A break is "the same break" when it falls within one word of theirs — a caption that
  // cuts one word early is a different rhythm, not a different film.
  const hit = theirAt.filter((t) => mine.at.some((m) => Math.abs(m - t) <= 1)).length;

  // The negative check, and the most valuable one here: a film with no board must not come
  // back with rows. Six of these seven cases have no ranking of any kind, so any row in them
  // was recognised rather than measured.
  const boardRows = new Set(measured.blueprint.regions
    .filter((r) => /-(label|slot)$/.test(r.id)).map((r) => r.id.replace(/-(label|slot)$/, ""))).size;
  const theirRanking = truth.segments.some((x) => x.spans.length > 0) || /ranking/.test(name);

  const overlay = measured.blueprint.regions.find((r) => /overlay|insert/i.test(r.id) && !/caption|banner/i.test(r.id));
  const mySpans = overlay
    ? (measured.blueprint.tracks.find((t) => t.region === overlay.id && t.kind !== "text")?.items.length ?? 0) : 0;

  rows.push({
    name, scored: true,
    theirs: { segments: truth.segments.length, cues: theirCues, spans: theirSpans, words: theirWords.length },
    mine: { cues: mine.at.length + 1, spans: mySpans, words: heard.length },
    words, breaks: { hit, of: theirAt.length },
    boardRows, invented: !theirRanking && boardRows > 0,
    failed: [
      words.ratio < BAR.words ? `heard ${pctOf(words.ratio)} of the script, the bar is ${pctOf(BAR.words)}` : null,
      theirAt.length && hit / theirAt.length < BAR.breaks
        ? `matched ${hit}/${theirAt.length} caption breaks, the bar is ${pctOf(BAR.breaks)}` : null,
      BAR.spansExact && mySpans !== theirSpans
        ? `found ${mySpans} picture(s) pinned to speech against ${theirSpans} authored` : null,
      !theirRanking && boardRows > 0 ? `invented ${boardRows} tier row(s) in a film with no ranking` : null,
    ].filter(Boolean),
  });
  console.log(`  ${name}`);
  console.log(`    words  ${(words.ratio * 100).toFixed(0)}% of their script heard (${words.matched}/${words.of})`);
  console.log(`    cues   ${hit}/${theirAt.length} of their breaks matched — we cut ${mine.at.length + 1}, they cut ${theirCues}`);
  console.log(`    spans  we found ${mySpans} picture(s) pinned to speech, they authored ${theirSpans}`);
  console.log(`    board  ${boardRows ? `${boardRows} row(s)` : "none"}${!theirRanking && boardRows > 0 ? "  ← INVENTED: this film has no ranking" : ""}`);
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const md = [
  "# Eval — our extraction against someone else's authored data",
  "",
  "Text only, and deliberately so: it costs nothing, it runs on every change, and every",
  "defect this pipeline has had would have shown up here before a single frame was drawn.",
  "Pictures are placeholders throughout — a generated photograph cannot make a wrong",
  "structure right.",
  "",
  `Run ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  "",
  "| case | words heard | caption breaks | pictures pinned to speech | board |",
  "|---|---|---|---|---|",
  ...rows.map((r) => r.scored
    ? `| \`${r.name}\` | ${pct(r.words.ratio)} (${r.words.matched}/${r.words.of}) | ${r.breaks.hit}/${r.breaks.of} | ${r.mine.spans} vs ${r.theirs.spans} authored | ${r.invented ? `**${r.boardRows} INVENTED**` : r.boardRows ? `${r.boardRows} rows, measured` : "none, correctly"} |`
    : `| \`${r.name}\` | — | — | _${r.why}_ | — |`),
  "",
  "## What the numbers mean",
  "",
  "**Words heard** — the longest run of their script our aligner recovered, word for word.",
  "Anything anchored to speech is only as good as this.",
  "",
  "**Caption breaks** — how many of their cue breaks we cut within one word of. This is the",
  "format's rhythm, and it is the thing a viewer feels without being able to name.",
  "",
  "**Pictures pinned to speech** — how many timed pictures we found over the board against how",
  "many they anchored to words. Counting the same number is the floor, not the ceiling: the",
  "next check is whether they cover the same words.",
  "",
  "**Board** — the check that costs nothing and catches the worst kind of mistake. Six of",
  "these films have no ranking in them at all. A row reported in one of those was not",
  "measured, it was recognised: the pipeline finding the shape of the film it was built on.",
];
writeFileSync(path.join(EVAL, "EVAL-TEXT.md"), md.join("\n"));
writeFileSync(path.join(EVAL, "eval-text.json"), JSON.stringify(rows, null, 2));
const scored = rows.filter((r) => r.scored);
const bad = scored.filter((r) => r.failed.length);
console.log(`\nscorecard: ${path.join(EVAL, "EVAL-TEXT.md")}`);
for (const r of bad) for (const why of r.failed) console.log(`✗ ${r.name}: ${why}`);
console.log(bad.length
  ? `${bad.length} of ${scored.length} scored case(s) below the bar`
  : `all ${scored.length} scored case(s) clear the bar`);
process.exit(bad.length ? 1 : 0);
