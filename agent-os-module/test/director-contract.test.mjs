// The Director's contract with the script author and the assembler.
//
//   node --test agent-os-module/test/director-contract.test.mjs
//
// The brief is a scene-by-scene reference: every scene keeps its own seconds, its idea
// index and its visual hint, in the scenes' own order. Dropping a zero-length shot, or
// sending only a role and a visual hint, breaks that one-to-one mapping — the author then
// lines its script up against a rhythm that no longer matches the scenes it was given.
//
// AGENT_OS_SOURCE (default ~/Documents/agent-os/source) supplies the TypeScript compiler
// and the component under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const VIEW = path.join(AGENT_OS, "src", "components", "VideoDirector.tsx");
const source = readFileSync(VIEW, "utf8");
const req = createRequire(path.join(AGENT_OS, "package.json"));

function loadView() {
  const ts = req("typescript");
  const out = ts.transpileModule(source, {
    fileName: VIEW,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), "omni-director-"));
  writeFileSync(path.join(dir, "VideoDirector.js"), out);
  writeFileSync(path.join(dir, "VoiceButton.js"), "module.exports = { __esModule: true, default: () => null };");
  process.env.NODE_PATH = [path.join(AGENT_OS, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  req("node:module").Module._initPaths();
  return req(path.join(dir, "VideoDirector.js"));
}

const view = loadView();

const runWith = (omni) => ({
  id: "d1", topic: "why cold emails die", durationSec: 47, mode: "voiceover", engine: "minimax",
  voiceEngine: "elevenlabs", brand: "Agent OS", stage: "brief", broll: {},
  avatar: { status: "idle" }, voiceover: { status: "idle" }, createdAt: 1, omni,
});

test("every scene keeps its own seconds and idea index, in order", () => {
  const payload = view.briefPayload(runWith({
    // a zero-length shot is exactly the case that used to shift every later index
    seconds: [0, 12, 7],
    graphic: [false, true, false],
    angle: "the myth everyone repeats",
    hints: [
      { role: "hook", visual: { kind: "broll", hint: "hand typing" }, seconds: 0, idea: 0 },
      { role: "claim", visual: { kind: "graphic", hint: "one number" }, seconds: 12, idea: 1 },
      { role: "cta", visual: { kind: "broll", hint: "desk" }, seconds: 7, idea: 2 },
    ],
    source: "A — the teardown",
  }));
  assert.equal(payload.sceneCount, 3, "sceneCount must be the number of scenes, not of positive durations");
  assert.deepEqual(payload.sceneHints.map((h) => h.seconds), [0, 12, 7]);
  assert.deepEqual(payload.sceneHints.map((h) => h.idea), [0, 1, 2]);
  assert.equal(payload.sceneHints[1].visual.kind, "graphic", "visual hints must survive the POST");
  assert.equal(payload.angle, "the myth everyone repeats");
});

test("an empty angle is still sent, because its presence is what marks a brief", () => {
  const payload = view.briefPayload(runWith({ seconds: [5], graphic: [false], angle: "", hints: [], source: null }));
  assert.ok(Object.prototype.hasOwnProperty.call(payload, "angle"), "angle key missing");
  assert.equal(payload.angle, "");
  assert.ok(Object.prototype.hasOwnProperty.call(payload, "sceneHints"), "sceneHints key missing");
  assert.deepEqual(payload.sceneHints, []);
});

test("a run with no brief sends exactly the legacy payload", () => {
  const payload = view.briefPayload(runWith(undefined));
  assert.deepEqual(payload, { topic: "why cold emails die", durationSec: 47 });
  assert.equal("angle" in payload, false);
  assert.equal("sceneHints" in payload, false);
});

test("the brief's arrays are built one-per-scene, with nothing filtered out", () => {
  assert.doesNotMatch(source, /\.filter\(\(n: number\) => n > 0\)/, "durations are filtered independently of the scenes");
  assert.match(source, /const secs: number\[\] = b\.scenes\.map/, "seconds are mapped per scene");
  assert.match(source, /idea: i,/, "each hint carries its idea index");
});

test("the goal-breaking paths are still wired the way they were fixed", () => {
  // graphics AND a scene's own supplied asset are settled without b-roll, and never sent
  // to the generator — a per-scene assetUrl is as good a reason to skip b-roll as a graphic is.
  assert.match(
    source,
    /broll\[i\] = omniGraphic\[i\] \|\| s\.assetUrl\s*\n\s*\? \{ status: "done", url: s\.assetUrl \}\s*\n\s*: \{ status: "processing" \}/,
    "a graphic scene or a scene with its own assetUrl must settle as done, not processing"
  );
  assert.match(
    source,
    /if \(!omniGraphic\[i\] && !scene\.assetUrl\) genBroll\(i, scene\.broll_prompt\)/,
    "b-roll generation must be skipped for a graphic scene AND for a scene with its own assetUrl"
  );
  // a scene's own asset also wins at assemble time: it must not be overridden by a graphic card
  assert.match(
    source,
    /\.\.\.\(!s\.assetUrl && \(s\.graphic \|\| omniGraphic\[i\]\)/,
    "a scene with its own assetUrl must suppress the graphic card, even if the brief marked it as one"
  );
  // narration is not optional
  assert.match(source, /const canAssemble = audioReady && brollSettled && brollDone > 0;/);
  // the brief survives a reload because it lives on the run
  assert.match(source, /const omniSeconds = run\.omni\?\.seconds \?\? \[\];/);
  // a new brief is a fresh run, so no old assets come with it
  assert.match(source, /\.\.\.freshRun\(\),/);
  // ElevenLabs stays the default engine
  assert.match(source, /voiceEngine: "elevenlabs"/);
  // the local voice is labelled as a test path, not as narration to publish
  assert.match(source, /System voice \(Mac\) — test/);
  // and a missing ElevenLabs account is stated, not spun forever
  assert.match(source, /Loading voices…/);
  assert.match(source, /No ElevenLabs voices available/);
});

// ── purpose rides with the brief ─────────────────────────────────────────────────────────
// The recreate route has accepted `purpose` all along and nothing forwarded it, so every
// brief silently became "pattern". These pin the two ends of that wire.

test("the brief's purpose is sent to the author", () => {
  const payload = view.briefPayload(runWith({
    seconds: [5], graphic: [false], angle: "a", purpose: "review", hints: [], source: null,
  }));
  assert.equal(payload.purpose, "review");
});

test("a run saved before purpose existed still means pattern", () => {
  // An older localStorage run has no `purpose` key at all. It must not become undefined in
  // the payload, or the author would fall back by accident rather than by decision.
  const payload = view.briefPayload(runWith({ seconds: [5], graphic: [false], angle: "", hints: [], source: null }));
  assert.equal(payload.purpose, "pattern");
});

test("a run with no brief still sends exactly the two fields it always did", () => {
  const payload = view.briefPayload(runWith(undefined));
  assert.deepEqual(Object.keys(payload).sort(), ["durationSec", "topic"]);
});

test("the import normalises the brief's purpose rather than trusting it", () => {
  // The route's own rule: anything that is not "review" is "pattern". The component must
  // apply it too, or a brief carrying junk would reach the author as junk.
  assert.match(source, /purpose: b\.purpose === "review" \? "review" : "pattern"/,
    "the ?brief= import must normalise purpose the way the route does");
});

// ── the reference's own frame ────────────────────────────────────────────────────────────
// The clone benchmark turns on this: a 720x1280 reference must not come back as a
// 1920x1080 film. The assembler has taken an output size for a while; the Director never
// sent one, so every render used the landscape default whatever it was copying.

test("a portrait brief sends the assembler a portrait frame", () => {
  const run = runWith({
    seconds: [3], graphic: [false], angle: "", hints: [], source: "ref",
    output: { width: 720, height: 1280 },
  });
  assert.deepEqual(run.omni.output, { width: 720, height: 1280 });
  assert.match(source, /\.\.\.\(run\.omni\?\.output \? \{ output: run\.omni\.output \} : \{\}\)/,
    "the assemble body must carry the brief's frame");
});

test("the import reads the frame off the brief's source, and only when it is real", () => {
  // width/height are absent on a brief made before the recreate route stored them, and a
  // zero must not become an output size the assembler then clamps to its minimum.
  assert.match(source, /Number\(b\.source\?\.width\) > 0 && Number\(b\.source\?\.height\) > 0/,
    "a missing or zero dimension must leave output unset");
  assert.match(source, /output: \{ width: Number\(b\.source\.width\), height: Number\(b\.source\.height\) \}/,
    "the frame must come from the brief's own source block");
});

test("a run with no brief still sends no output, so the landscape default stands", () => {
  const payload = view.briefPayload(runWith(undefined));
  assert.equal(payload.output, undefined);
  assert.match(source, /assembler keeps its own landscape default/,
    "the reason a brief-less run is unchanged should be stated where it is done");
});

// ── Wan as the third b-roll engine ───────────────────────────────────────────────────────
// MiniMax and Grok both need an OAuth sign-in. On a machine without one the Director could
// not finish a run at all, which is how a film ended up with an empty background.

test("Wan is offered, and is the fallback when another engine fails", () => {
  assert.match(source, /engine: "minimax" \| "grok" \| "wan"/, "the engine union must include Wan");
  assert.match(source, /\{ v: "wan", l: "Wan" \}/, "Wan must be selectable in the b-roll engine toggle");
  assert.match(source, /\["wan", "grok", "minimax"\] as DirectorRun\["engine"\]\[\]\)\.find\(\(e\) => e !== eng\)/,
    "the fallback order must be fixed and must drop the engine that just failed");
});

test("a Wan clip is taken as finished, not polled for a task id", () => {
  // The other two answer with a task to poll; ours answers with the stored clip. Treating
  // it like the others would leave every scene stuck on \"processing\".
  assert.match(source, /fetch\("\/api\/omniwatch\/broll"/, "Wan must go to the module's own route");
  assert.match(source, /if \(j\.ok && j\.url\) setRun[\s\S]{0,160}status: "done", url: j\.url/,
    "a Wan answer with a url is a finished clip");
});

test("Wan is asked for the brief's own frame", () => {
  // A portrait reference filled with landscape footage is the failure the output-size work
  // exists to stop; the footage has to agree with the frame, not just the canvas.
  assert.match(source, /o\.height > o\.width \? "9:16" : o && o\.width > o\.height \? "16:9" : "9:16"/,
    "the clip's aspect must follow the brief's source frame");
});
