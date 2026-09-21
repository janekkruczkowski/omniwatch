// The blueprint validator: the thing that makes a machine-written layout trustworthy.
//
//   node --test agent-os-module/test/blueprint.test.mjs
//
// Every case here is one the live model actually produced or nearly produced on the
// reference video, so these are regressions, not hypotheticals.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchBlueprint.ts")))
  || path.join(HERE, "..", "src");
const LIB = path.join(SOURCE, "lib", "omniwatchBlueprint.ts");
const req = createRequire(path.join(AGENT_OS, "package.json"));

const ts = req("typescript");
const out = ts.transpileModule(readFileSync(LIB, "utf8"), {
  fileName: LIB, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dir = mkdtempSync(path.join(tmpdir(), "omni-bp-"));
writeFileSync(path.join(dir, "bp.js"), out);
const lib = req(path.join(dir, "bp.js"));

const good = () => ({
  version: lib.BLUEPRINT_VERSION,
  canvas: { width: 1080, height: 1920, fps: 30, seconds: 20 },
  regions: [
    { id: "bg", role: "backdrop", rect: [0, 0, 1, 1], z: 0 },
    { id: "cap", role: "text", rect: [0.1, 0.5, 0.8, 0.08], z: 4 },
  ],
  tracks: [
    { region: "bg", kind: "video", items: [{ start: 0, end: 20, value: "a room" }] },
    { region: "cap", kind: "text", items: [{ start: 2, end: 4, value: "second line" }, { start: 0, end: 2, value: "first line" }] },
  ],
});

test("a well-formed blueprint passes, and items come back in time order", () => {
  const r = lib.validateBlueprint(good());
  assert.equal(r.ok, true, r.error);
  const cap = r.blueprint.tracks.find((t) => t.region === "cap");
  assert.deepEqual(cap.items.map((i) => i.value), ["first line", "second line"],
    "items must be sorted, or a renderer walking them in order draws the wrong thing");
});

test("a caption track that runs past the end of the video is refused", () => {
  // Measured: the model laid captions on a one-per-second grid and ran a 20s video to 24s.
  const b = good();
  b.tracks[1].items.push({ start: 19, end: 24, value: "overrun" });
  const r = lib.validateBlueprint(b);
  assert.equal(r.ok, false);
  assert.match(r.error, /past the end/);
});

test("the vocabularies are closed, and the prompt is generated from them", () => {
  const b = good();
  b.regions[0].role = "tier_list";
  assert.match(lib.validateBlueprint(b).error, /role must be one of/);
  const c = good();
  c.tracks[0].kind = "audio";
  assert.match(lib.validateBlueprint(c).error, /kind must be one of/);
  // The prompt interpolates the same constants, so the model cannot be told about a value
  // the validator will then reject.
  for (const role of lib.REGION_ROLES) assert.ok(lib.BLUEPRINT_SCHEMA_PROMPT.includes(role), role);
  for (const kind of lib.TRACK_KINDS) assert.ok(lib.BLUEPRINT_SCHEMA_PROMPT.includes(kind), kind);
});

test("geometry must be fractions, because a clone is rendered at another size", () => {
  const b = good();
  b.regions[1].rect = [0, 540, 1080, 96]; // pixels, the easy mistake
  assert.match(lib.validateBlueprint(b).error, /fractions/);
  for (const bad of [[0, 0, 1], [0, 0, 0, 1], "x", [0, 0, "1", 1]]) {
    const c = good(); c.regions[1].rect = bad;
    assert.equal(lib.validateBlueprint(c).ok, false, JSON.stringify(bad));
  }
});

test("a track must name a region that exists, and every region must carry something", () => {
  const b = good();
  b.tracks[1].region = "nope";
  assert.match(lib.validateBlueprint(b).error, /not a declared region/);
  const c = good();
  c.regions.push({ id: "ghost", role: "overlay", rect: [0, 0, 0.2, 0.2], z: 9 });
  assert.match(lib.validateBlueprint(c).error, /has no track/);
});

test("a wrong or missing version is refused outright", () => {
  for (const v of [undefined, "", "omniwatch.blueprint/2", "VISUAL_IR_V1"]) {
    const b = good(); b.version = v;
    assert.equal(lib.validateBlueprint(b).ok, false, String(v));
  }
});

test("it never throws, whatever it is handed", () => {
  for (const junk of [null, 5, "text", [], {}, { version: lib.BLUEPRINT_VERSION }]) {
    const r = lib.validateBlueprint(junk);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, "string");
  }
});
