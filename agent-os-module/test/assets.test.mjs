// The per-scene asset store: what may be stored, what may be served, and what a file
// actually is.
//
//   node --test agent-os-module/test/assets.test.mjs
//   SOURCE=/path/to/agent-os/source/src node --test .../assets.test.mjs
//   node --test .../assets.test.mjs --source=/path/to/agent-os/source/src
//
// The two questions this pins down are the ones a file upload gets wrong: the name on disk
// is ours (so a caller cannot name a path), and the type comes from the bytes (so a file
// called .mp4 that is really a page is refused rather than served).
//
// Portability: SOURCE (env or --source) says where src/lib/omniwatchAssets.ts lives; it
// defaults to the module's own src/ next to this test (which is where sniffMedia and
// saveAssetBytes actually live), then to the Agent OS install (AGENT_OS_SOURCE, then
// ~/Documents/agent-os/source) — the same convention test/graphics/graphics.test.mjs uses.
// The TypeScript compiler is always borrowed from the Agent OS install, whichever src/
// the library itself is read from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");

const argSource = process.argv.find((a) => a.startsWith("--source="))?.slice("--source=".length);
const SOURCE =
  process.env.SOURCE ||
  argSource ||
  [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchAssets.ts"))) ||
  path.join(HERE, "..", "src");

const LIB = path.join(SOURCE, "lib", "omniwatchAssets.ts");
if (!existsSync(LIB)) {
  throw new Error(`no omniwatchAssets.ts under ${SOURCE} — pass SOURCE=<agent-os>/src or --source=<agent-os>/src`);
}
const req = createRequire(path.join(AGENT_OS, "package.json"));

function loadLib() {
  const ts = req("typescript");
  const out = ts.transpileModule(readFileSync(LIB, "utf8"), {
    fileName: LIB,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText.replace(/require\("@\/lib\/omniwatch"\)/g, 'require("./omniwatch")');
  const dir = mkdtempSync(path.join(tmpdir(), "omni-assets-"));
  writeFileSync(path.join(dir, "omniwatchAssets.js"), out);
  writeFileSync(path.join(dir, "omniwatch.js"), `module.exports = { OMNI_ROOT: ${JSON.stringify(path.join(dir, "root"))} };`);
  mkdirSync(path.join(dir, "root"), { recursive: true });
  return { lib: req(path.join(dir, "omniwatchAssets.js")), dir };
}

const { lib, dir } = loadLib();

const head = (bytes) => new Uint8Array(bytes);
const ftyp = (brand) => head([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...brand.split("").map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);

test("the name on disk is one we make, with the extension of the real type", () => {
  for (const [mime, ext] of [["video/mp4", "mp4"], ["video/quicktime", "mov"], ["video/webm", "webm"], ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]) {
    const name = lib.newAssetName(mime);
    assert.match(name, new RegExp(`^[a-f0-9]{32}\\.${ext}$`), `${mime} → ${name}`);
  }
  for (const bad of ["text/html", "application/javascript", "image/svg+xml", "", "video/x-msvideo"]) {
    assert.equal(lib.newAssetName(bad), null, `${bad} was allowed`);
  }
});

test("a name that is not ours never reaches the filesystem", () => {
  for (const bad of ["../../etc/passwd", "passwd", "abc.mp4", `${"a".repeat(32)}.html`, `${"a".repeat(31)}.mp4`, `${"A".repeat(32)}.mp4`, `${"a".repeat(32)}.mp4/../x`]) {
    assert.equal(lib.assetPath(bad), null, `${bad} resolved`);
    assert.equal(lib.contentTypeFor(bad), null, `${bad} was servable`);
  }
  const good = `${"a".repeat(32)}.mp4`;
  assert.equal(lib.assetPath(good), path.join(dir, "root", "assets", good));
  assert.equal(lib.contentTypeFor(good), "video/mp4");
});

test("the type comes from the bytes, not from the upload's claim", () => {
  assert.equal(lib.sniffMedia(ftyp("isom")), "video/mp4");
  assert.equal(lib.sniffMedia(ftyp("qt  ")), "video/quicktime");
  assert.equal(lib.sniffMedia(head([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), "video/webm");
  assert.equal(lib.sniffMedia(head([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(lib.sniffMedia(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(lib.sniffMedia(head([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "image/webp");
  // a page or a script dressed as footage
  assert.equal(lib.sniffMedia(Buffer.from("<!doctype html><script>alert(1)</script>")), null);
  assert.equal(lib.sniffMedia(Buffer.from("#!/bin/sh\necho hi\n")), null);
  assert.equal(lib.sniffMedia(head([])), null);
});
