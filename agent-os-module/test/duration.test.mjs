// The duration fallback: yt-dlp reports none for a plain file URL, and zero is not a
// harmless gap — the rhythm, every scene's seconds and the brief are derived from it.
//
//   node --test agent-os-module/test/duration.test.mjs
//
// Hermetic: ffmpeg makes a clip of a known length in a temp dir, and ffprobe is asked
// about it through the library's own helper. SOURCE (env or --source) picks the src root
// the way the graphics and assets suites do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const argSource = process.argv.find((a) => a.startsWith("--source="))?.slice("--source=".length);
const SOURCE = process.env.SOURCE || argSource
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatch.ts")))
  || path.join(HERE, "..", "src");
const LIB = path.join(SOURCE, "lib", "omniwatch.ts");
const req = createRequire(path.join(AGENT_OS, "package.json"));

// The library pulls in i18n and next-only helpers; only probeDuration is under test, so it
// is transpiled with its imports stubbed rather than the whole module graph loaded.
function loadProbe() {
  const ts = req("typescript");
  const src = readFileSync(LIB, "utf8");
  const out = ts.transpileModule(src, {
    fileName: LIB,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
    .replace(/require\("@\/lib\/omniwatchI18n"\)/g, 'require("./i18n")')
    .replace(/require\("@\/lib\/omniwatchBlueprint"\)/g, 'require("./blueprint")');
  const dir = mkdtempSync(path.join(tmpdir(), "omni-dur-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "omniwatch.js"), out);
  writeFileSync(path.join(dir, "i18n.js"), "module.exports = { __esModule: true, default: { en: { sections: {} } } };");
  writeFileSync(path.join(dir, "blueprint.js"), "module.exports = { BLUEPRINT_SCHEMA_PROMPT: '' };");
  return req(path.join(dir, "omniwatch.js"));
}

const lib = loadProbe();

test("a real file answers with its own length, rounded to whole seconds", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "omni-clip-"));
  const clip = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=7",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip]);
  assert.equal(await lib.probeDuration(clip), 7);
});

test("a missing file is 0, not a throw — the caller keeps whatever the extractor gave", async () => {
  assert.equal(await lib.probeDuration(path.join(tmpdir(), "omni-does-not-exist-9f2.mp4")), 0);
});

test("a file that is not media is 0", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "omni-junk-"));
  const junk = path.join(dir, "not-a-video.mp4");
  writeFileSync(junk, "this is not an mp4");
  assert.equal(await lib.probeDuration(junk), 0);
});

test("the download path asks only when the extractor gave nothing", () => {
  // A site with its own duration must not pay for an extra process, and a zero must not
  // survive. Both are one branch in fetchVideo, pinned here at the source level.
  const src = readFileSync(LIB, "utf8");
  assert.match(src, /if \(!info\.duration\) \{\s*\n\s*const probed = await probeDuration\(src\);/,
    "fetchVideo must probe exactly when the metadata has no duration");
  assert.match(src, /info = \{ \.\.\.info, duration: probed \};[\s\S]{0,120}writeFile\(infoFile/,
    "the probed duration must be persisted, or every later read sees zero again");
});
