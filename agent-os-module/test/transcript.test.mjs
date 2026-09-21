// Putting what was SEEN together with what was HEARD.
//
//   node --test agent-os-module/test/transcript.test.mjs
//
// Offline: nothing here touches a key, a network or a video. The question under test is
// the reconciliation rule — the screen decides the words and the mark, the soundtrack
// decides the clock — because that rule is the whole reason this project runs two
// measurements instead of copying the one everybody else runs.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchTranscript.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-stt-"));
writeFileSync(path.join(dir, "omniwatch.js"), "module.exports = { run: async () => '' };");
const file = path.join(SOURCE, "lib", "omniwatchTranscript.ts");
writeFileSync(path.join(dir, "t.js"), ts.transpileModule(readFileSync(file, "utf8"), {
  fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/require\("@\/lib\/omniwatch"\)/g, 'require("./omniwatch")'));
const lib = req(path.join(dir, "t.js"));

/** The reference's opening, as each instrument reported it. The vision pass reads sampled
 *  frames and was late by four tenths; the aligner has the words to the hundredth. */
const WORDS = [
  { text: "Ronaldo", start: 0.08, end: 0.56 },
  { text: "is", start: 0.56, end: 0.80 },
  { text: "D", start: 0.80, end: 1.04 },
  { text: "tier.", start: 1.04, end: 1.30 },
  { text: "Bro", start: 1.64, end: 1.84 },
  { text: "has", start: 1.84, end: 2.02 },
  { text: "more", start: 2.02, end: 2.22 },
];
const SCREEN = [
  { start: 0.50, end: 1.40, text: "Ronaldo is D tier.", marked: "Ronaldo", where: "caption" },
  { start: 1.50, end: 2.00, text: "Bro has more", marked: "more", where: "caption" },
];

test("the words and the mark come from the screen, the clock from the soundtrack", () => {
  const { items, snapped, kept } = lib.alignCues(SCREEN, WORDS);
  assert.equal(snapped, 2);
  assert.equal(kept, 0);
  assert.equal(items[0].start, 0.08);            // heard, not seen
  assert.equal(items[0].value, "[[Ronaldo]] is D tier.");
  assert.equal(items[1].start, 1.64);
  assert.equal(items[1].value, "Bro has [[more]]");
});

test("a cue holds until the next one is heard, so a pause does not blank the line", () => {
  const { items } = lib.alignCues(SCREEN, WORDS);
  // "tier." stops at 1.30 and "Bro" starts at 1.64; the line stays up across the gap.
  assert.ok(items[0].end >= 1.30, `ended at ${items[0].end}`);
  assert.ok(items[0].end <= 1.64, `ran into the next cue at ${items[0].end}`);
});

test("text nobody says keeps the times it was seen with", () => {
  // A title, a price, a watermark: there is nothing in the speech to align it to, and
  // dropping it would lose text that is really on screen.
  const screen = [...SCREEN, { start: 0, end: 20, text: "RANKING THE BEST FOOTBALLERS", where: "title bar" }];
  const { items, snapped, kept } = lib.alignCues(screen, WORDS);
  assert.equal(snapped, 2);
  assert.equal(kept, 1);
  const title = items.find((i) => i.value.startsWith("RANKING"));
  assert.equal(title.start, 0);
  assert.equal(title.end, 20);
});

test("a word repeated later cannot pull an earlier cue forward", () => {
  const words = [
    { text: "tier.", start: 0.1, end: 0.4 },
    { text: "Ronaldo", start: 0.5, end: 0.9 },
    { text: "is", start: 0.9, end: 1.1 },
    { text: "D", start: 1.1, end: 1.3 },
    { text: "tier.", start: 1.3, end: 1.6 },
  ];
  const { items } = lib.alignCues([SCREEN[0]], words);
  assert.equal(items[0].start, 0.5);
});

test("punctuation and casing do not stop a match", () => {
  const { items } = lib.alignCues(
    [{ start: 9, end: 9.9, text: "on Instagram.", marked: "Instagram." }],
    [{ text: "on", start: 9.2, end: 9.4 }, { text: "instagram", start: 9.4, end: 9.95 }],
  );
  assert.equal(items[0].start, 9.2);
  assert.equal(items[0].value, "on [[Instagram.]]");
});

test("without a screen pass, speech alone still makes karaoke cues", () => {
  const items = lib.cuesFromWords(WORDS, { karaoke: true, maxWords: 4 });
  // One item per word: the line holds and the mark moves along it.
  assert.equal(items.length, WORDS.length);
  assert.equal(items[0].value, "[[Ronaldo]] is D tier.");
  assert.equal(items[1].value, "Ronaldo [[is]] D tier.");
  // A silence of at least the gap ends the cue on screen.
  assert.match(items[4].value, /^\[\[Bro\]\]/);
});

test("a silence breaks a cue; a run of quick words does not", () => {
  const items = lib.cuesFromWords(WORDS, { karaoke: false, gap: 0.3, maxWords: 99, maxChars: 999 });
  assert.equal(items.length, 2);
  assert.equal(items[0].value, "Ronaldo is D tier.");
  assert.equal(items[1].value, "Bro has more");
});
