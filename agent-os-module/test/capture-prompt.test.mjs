// The capture prompt's doctrine, enforced: Omni gets categories, never measurements.
//
//   node --test agent-os-module/test/capture-prompt.test.mjs
//
// The failure this guards against is the one IR-CONTRACT-V2.md §0 documents: asked for a
// continuous quantity, Omni answered 0.028 where the pixels measured 0.038, and "shrinks" where
// the truth was "chunks". The fix was to stop asking for quantities at all. This file is what
// makes sure a later edit does not quietly reintroduce one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const SOURCE = process.env.SOURCE
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchCapturePrompt.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-capture-prompt-"));

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

const cap = load("omniwatchCapturePrompt");

// Every one of these matching the prompt TEXT is a doctrine violation: a request for a
// continuous quantity that a pixel scan or an aligner should answer instead. Written broad on
// purpose — this is the test that is supposed to be annoying to satisfy by accident.
const FORBIDDEN_PATTERNS = [
  { name: "size", re: /\bsize\b/i },
  { name: "percentage", re: /%|\bpercent(age)?\b/i },
  { name: "pixel value", re: /\bpixels?\b|\bpx\b/i },
  { name: "hex colour", re: /#[0-9a-f]{3,8}\b/i },
  { name: "colour word", re: /\bcolou?r\b/i },
  { name: "duration in seconds", re: /\bsecond(s)?\b|\bms\b|\bmillisecond(s)?\b/i },
  { name: "timestamp", re: /\btimestamp(s)?\b/i },
];

function samplePrompt() {
  return cap.buildCapturePrompt([
    { id: "title-banner", label: "the title banner" },
    { id: "caption-band" },
    { id: "s-slot" },
  ]);
}

test("asks for no continuous quantity — the doctrine test", () => {
  const text = samplePrompt();
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    assert.ok(!re.test(text), `capture prompt must never mention a ${name}, but matched ${re}`);
  }
});

test("the same doctrine holds with no known regions passed in", () => {
  const text = cap.buildCapturePrompt();
  for (const { name, re } of FORBIDDEN_PATTERNS) {
    assert.ok(!re.test(text), `capture prompt (no regions) must never mention a ${name}, but matched ${re}`);
  }
});

test("every MOVE_SHAPES value is enumerated in the prompt text", () => {
  const text = samplePrompt();
  assert.ok(cap.MOVE_SHAPES.length >= 5, "expected the five-shape closed set from IR-CONTRACT-V2 §2");
  for (const shape of cap.MOVE_SHAPES) {
    assert.ok(text.includes(shape), `move shape "${shape}" is not enumerated in the prompt`);
  }
});

test("every HOLD_KINDS value is enumerated in the prompt text", () => {
  const text = samplePrompt();
  assert.deepEqual([...cap.HOLD_KINDS], ["from-start", "on-cue"]);
  for (const kind of cap.HOLD_KINDS) {
    assert.ok(text.includes(kind), `hold kind "${kind}" is not enumerated in the prompt`);
  }
});

test("every question states its default, as an instruction", () => {
  const text = samplePrompt();
  // ARRIVAL and DEPARTURE both default to DEFAULT_MOVE_SHAPE — two separate statements, not one
  // shared between them, because a reader (model or human) answering DEPARTURE should not have
  // to scroll back up to ARRIVAL to find out what "unsure" means there.
  const arrivalDefault = `answer\n   "${cap.DEFAULT_MOVE_SHAPE}"`;
  const unsureCount = (text.match(/if you are unsure/gi) || []).length;
  assert.ok(unsureCount >= 5, `expected at least 5 stated defaults ("if you are unsure, answer …"), found ${unsureCount}`);

  assert.ok(text.includes(`answer\n   "${cap.DEFAULT_MOVE_SHAPE}"`) || text.includes(`answer "${cap.DEFAULT_MOVE_SHAPE}"`),
    "ARRIVAL/DEPARTURE default is not stated as an instruction");
  assert.ok(text.includes(`"${cap.DEFAULT_HOLD_KIND}"`), "HOLD default is not stated");
  assert.ok(text.includes(`"${cap.DEFAULT_WAITS_AT}"`), "WAITS-AT default is not stated");
  assert.ok(text.includes(`"${cap.DEFAULT_SUBJECT}"`), "SUBJECT default is not stated");
  void arrivalDefault;
});

test("layer order has a stated fallback for when the model cannot tell", () => {
  const text = samplePrompt();
  assert.match(text, /if you cannot tell which (one is on top|of two is on top)/i);
});

test("the named distractors are present verbatim", () => {
  const text = samplePrompt();
  assert.ok(cap.DISTRACTORS.length >= 4, "expected at least the four named distractors from the task brief");
  for (const d of cap.DISTRACTORS) {
    assert.ok(text.includes(d), `distractor not present verbatim: ${d}`);
  }
  // The brief's own four examples, in substance: platform UI, a watermark, a follower counter,
  // burned-in subtitles.
  assert.ok(/platform/i.test(cap.DISTRACTORS.join(" ")) && /interface|chrome/i.test(cap.DISTRACTORS.join(" ")));
  assert.ok(/watermark/i.test(cap.DISTRACTORS.join(" ")));
  assert.ok(/follower|subscriber/i.test(cap.DISTRACTORS.join(" ")));
  assert.ok(/burned.in/i.test(cap.DISTRACTORS.join(" ")) && /caption/i.test(cap.DISTRACTORS.join(" ")));
});

test("known regions are listed by id so WAITS-AT and LAYER ORDER can point at them", () => {
  const text = samplePrompt();
  assert.ok(text.includes('"title-banner"'));
  assert.ok(text.includes('"caption-band"'));
  assert.ok(text.includes('"s-slot"'));
});

test("with no regions, the prompt tells Omni to invent its own ids rather than going silent", () => {
  const text = cap.buildCapturePrompt([]);
  assert.match(text, /invent/i);
});

test("asks for output as one strict JSON object", () => {
  const text = samplePrompt();
  assert.match(text, /ONE JSON object/);
  assert.match(text, /"elements"/);
  assert.match(text, /"subjects"/);
  assert.match(text, /"layerOrder"/);
});

test("CAPTURE_PROMPT_VERSION is exported and stable-looking", () => {
  assert.equal(typeof cap.CAPTURE_PROMPT_VERSION, "string");
  assert.match(cap.CAPTURE_PROMPT_VERSION, /^omniwatch\.capture-prompt\//);
});
