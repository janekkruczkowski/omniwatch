// Bounded tests for the OmniWatch graphic card inputs (validator, escaping, ranges).
//
//   node --test agent-os-module/test/graphics/graphics.test.mjs
//   SOURCE=/path/to/agent-os/source/src node --test .../graphics.test.mjs
//   node --test .../graphics.test.mjs --source=/path/to/agent-os/source/src
//
// Portability: SOURCE (env or --source) says where src/lib/omniwatchGraphic.ts
// lives; it defaults to the module's own src/ next to this test, then to the
// Agent OS install (AGENT_OS_SOURCE, then ~/Documents/agent-os/source). The
// TypeScript compiler is borrowed from that install, exactly like
// test/card-source.test.mjs does, so nothing has to be installed here.
// No ffmpeg, no network, no paid request: run() is stubbed to throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || "";
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(HOME, "Documents", "agent-os", "source");

const argSource = process.argv.find((a) => a.startsWith("--source="))?.slice("--source=".length);
const SOURCE =
  process.env.SOURCE ||
  argSource ||
  [path.join(HERE, "..", "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchGraphic.ts"))) ||
  path.join(HERE, "..", "..", "src");

const LIB = path.join(SOURCE, "lib", "omniwatchGraphic.ts");
if (!existsSync(LIB)) {
  throw new Error(`no omniwatchGraphic.ts under ${SOURCE} — pass SOURCE=<agent-os>/src or --source=<agent-os>/src`);
}

// Load the real module without a bundler: transpile it with the install's own
// TypeScript, and answer its one runtime import (@/lib/omniwatch, which only
// supplies ffmpeg/PATH plumbing) with a stub that refuses to shell out.
const tmp = mkdtempSync(path.join(os.tmpdir(), "graphics-test-"));
const stubPath = path.join(tmp, "omniwatch-stub.mjs");
writeFileSync(
  stubPath,
  `export const OMNI_ROOT = ${JSON.stringify(path.join(tmp, "root"))};\n` +
    `export const run = async () => { throw new Error("ffmpeg must not be called by these tests"); };\n`,
);

const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const transpiled = ts.transpileModule(
  (await readFile(LIB, "utf8")).replaceAll("@/lib/omniwatch", pathToFileURL(stubPath).href),
  { fileName: LIB, compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText;
const modulePath = path.join(tmp, "omniwatchGraphic.mjs");
writeFileSync(modulePath, transpiled);

const { validateGraphicSpec, parseByteRange, buildFilters, renderGraphic, GRAPHIC_LIMITS } = await import(pathToFileURL(modulePath).href);

const cases = [];
const check = (name, fn) => cases.push([name, fn]);
const expectOk = (name, spec) =>
  check(name, () => assert.equal(validateGraphicSpec(spec), null, "expected the spec to be accepted"));
const expectBad = (name, spec, re) =>
  check(name, () => {
    const got = validateGraphicSpec(spec);
    assert.equal(typeof got, "string", "expected a reason, got " + JSON.stringify(got));
    assert.match(got, re);
  });

const SECONDS = 5;
const ranking = (items, extra = {}) => ({ kind: "ranking", title: "Top 3", items, seconds: SECONDS, ...extra });

// ---- valid input keeps working ------------------------------------------------
expectOk("ranking, label only", ranking([{ label: "One" }, { label: "Two" }]));
expectOk("ranking, with values", ranking([{ label: "One", value: "12%" }, { label: "Two", value: "" }]));
expectOk("ranking, value null / whitespace", ranking([{ label: "One", value: null }, { label: "Two", value: " " }]));
expectOk("stat, required only", { kind: "stat", title: "Views", value: "1.2M", seconds: 3 });
expectOk("stat, with caption", { kind: "stat", title: "Views", value: "1.2M", caption: "last 30 days", seconds: 3 });
expectOk("stat, caption empty string", { kind: "stat", title: "Views", value: "1.2M", caption: "", seconds: 3 });
expectOk("compare, both sides", {
  kind: "compare", title: "Before / after", seconds: 6,
  left: { label: "Before", items: ["a", "b"] }, right: { label: "After", items: ["c"] },
});
expectOk("compare, empty items list", {
  kind: "compare", title: "Before / after", seconds: 6,
  left: { label: "Before", items: [] }, right: { label: "After", items: [] },
});
expectOk("quote, with attribution", { kind: "quote", text: "Ship it.", attribution: "Someone", seconds: 4 });
expectOk("quote, attribution omitted", { kind: "quote", text: "Ship it.", seconds: 4 });
expectOk("seconds at the cap", ranking([{ label: "One" }], { seconds: GRAPHIC_LIMITS.seconds }));
expectOk("fractional seconds", ranking([{ label: "One" }], { seconds: 0.5 }));
expectOk("rows at the cap", ranking(Array.from({ length: GRAPHIC_LIMITS.rows }, (_, i) => ({ label: "Row " + i }))));

// Character literals: ffmpeg filter syntax (":", ",", "'", "%", backslash) and
// non-latin text all have to survive validation untouched.
const HOSTILE = "A: it's 100% \"done\", {x} \\ b";
const NEWLINEY = "first line\nsecond line";
expectOk("ranking label with filter-syntax literals", ranking([{ label: HOSTILE, value: HOSTILE }]));
expectOk("stat fields with filter-syntax literals", { kind: "stat", title: HOSTILE, value: HOSTILE, caption: HOSTILE, seconds: 3 });
expectOk("compare with filter-syntax literals", {
  kind: "compare", title: HOSTILE, seconds: 6,
  left: { label: HOSTILE, items: [HOSTILE] }, right: { label: HOSTILE, items: [HOSTILE] },
});
expectOk("quote with filter-syntax literals", { kind: "quote", text: HOSTILE, attribution: HOSTILE, seconds: 4 });
expectOk("newline in a label", ranking([{ label: NEWLINEY }]));
expectOk("non-latin text", { kind: "quote", text: "Zazolc gesla jazn", attribution: "Japonski", seconds: 4 });

// ---- malformed bodies get a reason, never an exception ------------------------
expectBad("ranking items [null] (the crash this hardening is about)", ranking([null]), /string label/);
expectBad("ranking items [valid, null]", ranking([{ label: "One" }, null]), /string label/);
expectBad("ranking item {}", ranking([{}]), /string label/);
expectBad("ranking item string", ranking(["One"]), /string label/);
expectBad("ranking item numeric label", ranking([{ label: 7 }]), /string label/);
expectBad("ranking item value number", ranking([{ label: "One", value: 12 }]), /value must be a string/);
expectBad("ranking item value object", ranking([{ label: "One", value: {} }]), /value must be a string/);
expectBad("ranking item value array", ranking([{ label: "One", value: [] }]), /value must be a string/);
expectBad("ranking item value too long", ranking([{ label: "One", value: "v".repeat(GRAPHIC_LIMITS.value + 1) }]), /value must be a string/);
expectBad("ranking label too long", ranking([{ label: "l".repeat(GRAPHIC_LIMITS.label + 1) }]), /labels are limited/);
expectBad("ranking title too long", ranking([{ label: "One" }], { title: "t".repeat(GRAPHIC_LIMITS.title + 1) }), /title is limited/);
expectBad("ranking title whitespace only", ranking([{ label: "One" }], { title: "   " }), /needs a title/);
expectBad("ranking items empty", ranking([]), /at least one item/);
expectBad("ranking items not an array", ranking("One"), /at least one item/);
expectBad("ranking items too many", ranking(Array.from({ length: GRAPHIC_LIMITS.rows + 1 }, (_, i) => ({ label: "Row " + i }))), /at most/);
expectBad("stat value number", { kind: "stat", title: "Views", value: 12, seconds: 3 }, /needs a value/);
expectBad("stat value missing", { kind: "stat", title: "Views", seconds: 3 }, /needs a value/);
expectBad("stat value too long", { kind: "stat", title: "Views", value: "1".repeat(GRAPHIC_LIMITS.value + 1), seconds: 3 }, /value is limited/);
expectBad("stat caption number", { kind: "stat", title: "Views", value: "1", caption: 42, seconds: 3 }, /caption must be a string/);
expectBad("stat caption object", { kind: "stat", title: "Views", value: "1", caption: { text: "x" }, seconds: 3 }, /caption must be a string/);
expectBad("stat caption too long", { kind: "stat", title: "Views", value: "1", caption: "c".repeat(GRAPHIC_LIMITS.caption + 1), seconds: 3 }, /caption must be a string/);
expectBad("compare side missing", { kind: "compare", title: "t", seconds: 6, left: { label: "L", items: [] } }, /compare\.right needs a label/);
expectBad("compare side null", { kind: "compare", title: "t", seconds: 6, left: null, right: { label: "R", items: [] } }, /compare\.left needs a label/);
expectBad("compare items non-string", { kind: "compare", title: "t", seconds: 6, left: { label: "L", items: ["a", 2] }, right: { label: "R", items: [] } }, /list of strings/);
expectBad("compare items too many", {
  kind: "compare", title: "t", seconds: 6,
  left: { label: "L", items: Array.from({ length: GRAPHIC_LIMITS.rows + 1 }, () => "x") },
  right: { label: "R", items: [] },
}, /at most/);
expectBad("compare item too long", {
  kind: "compare", title: "t", seconds: 6,
  left: { label: "L", items: ["x".repeat(GRAPHIC_LIMITS.label + 1)] },
  right: { label: "R", items: [] },
}, /limited to/);
expectBad("quote text number", { kind: "quote", text: 42, seconds: 4 }, /needs text/);
expectBad("quote text missing", { kind: "quote", seconds: 4 }, /needs text/);
expectBad("quote text too long", { kind: "quote", text: "q".repeat(GRAPHIC_LIMITS.text + 1), seconds: 4 }, /quote is limited/);
expectBad("quote attribution number", { kind: "quote", text: "x", attribution: 7, seconds: 4 }, /attribution must be a string/);
expectBad("quote attribution array", { kind: "quote", text: "x", attribution: ["a"], seconds: 4 }, /attribution must be a string/);
expectBad("quote attribution too long", { kind: "quote", text: "x", attribution: "a".repeat(GRAPHIC_LIMITS.attribution + 1), seconds: 4 }, /attribution must be a string/);
expectBad("seconds as numeric string", ranking([{ label: "One" }], { seconds: "5" }), /positive number/);
expectBad("seconds zero", ranking([{ label: "One" }], { seconds: 0 }), /positive number/);
expectBad("seconds negative", ranking([{ label: "One" }], { seconds: -1 }), /positive number/);
expectBad("seconds NaN", ranking([{ label: "One" }], { seconds: Number.NaN }), /positive number/);
expectBad("seconds Infinity", ranking([{ label: "One" }], { seconds: Number.POSITIVE_INFINITY }), /positive number/);
expectBad("seconds missing", { kind: "stat", title: "t", value: "v" }, /positive number/);
expectBad("seconds above the cap", ranking([{ label: "One" }], { seconds: GRAPHIC_LIMITS.seconds + 1 }), /or less/);
expectBad("unknown kind", { kind: "barchart", title: "t", seconds: 3 }, /kind must be one of/);
expectBad("kind not a string", { kind: { kind: "ranking" }, seconds: 3 }, /kind must be one of/);
expectBad("body null", null, /GraphicSpec object/);
expectBad("body array", [ranking([{ label: "One" }])], /GraphicSpec object/);
expectBad("body string", "ranking", /GraphicSpec object/);
expectBad("body number", 7, /GraphicSpec object/);
expectBad("body empty object", {}, /kind must be one of/);

// The validator runs outside the route's try/catch, so it must never throw, no
// matter how hostile the body is.
check("validator never throws", () => {
  const hostile = [
    null, undefined, 0, 1, "", "ranking", true, false, [], [null], [[]],
    { kind: "ranking" }, { kind: "ranking", items: [null], title: "x", seconds: 1 },
    { kind: "ranking", title: "x", items: [{ label: "a", value: { toString: null } }], seconds: 1 },
    { kind: "stat", title: "x", value: "y", caption: new Map(), seconds: 1 },
    { kind: "compare", title: "x", left: { label: "l", items: new Set() }, right: { label: "r", items: [] }, seconds: 1 },
    { kind: "quote", text: "x", attribution: Symbol("a"), seconds: 1 },
    { kind: "ranking", title: "x", items: [{ label: "a" }], seconds: { valueOf: () => 5 } },
  ];
  for (const body of hostile) {
    const got = validateGraphicSpec(body);
    assert.ok(got === null || typeof got === "string", "unexpected return for " + String(body));
  }
});

// ---- renderGraphic re-checks before hashing, and never shells out here --------
check("renderGraphic rejects a bad spec before hashing", async () => {
  const err = await renderGraphic(ranking([null])).then(() => null, (e) => e);
  assert.ok(err instanceof Error, "expected renderGraphic to reject");
  assert.match(err.message, /string label/);
});

check("renderGraphic carries literals through hash and stops at the drawtext check", async () => {
  const err = await renderGraphic({ kind: "quote", text: HOSTILE, attribution: NEWLINEY, seconds: 4 })
    .then(() => null, (e) => e);
  assert.ok(err instanceof Error, "expected renderGraphic to reject without ffmpeg");
  assert.match(err.message, /drawtext/, "should get past canonical()/hashSpec() to the ffmpeg capability check");
});

// ---- drawtext escaping: caller text never enters the filter graph -------------
check("filter graph keeps text in files, escapes paths, disables expansion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gfx-filters-"));
  try {
    const ctx = { dir, n: 0, files: [] };
    const font = { reg: "/tmp/f:o'nt.ttf", bold: "/tmp/f:o'nt-bold.ttf" };
    const spec = {
      kind: "ranking", title: HOSTILE, seconds: 5,
      items: [{ label: NEWLINEY, value: HOSTILE }, { label: "plain" }],
    };
    const filters = await buildFilters(spec, font, ctx);
    const joined = filters.join(",");

    assert.ok(!joined.includes("second line"), "caller text must not be inlined into the filter graph");
    assert.ok(!joined.includes("%"), "no caller percent sign may reach the filter string");
    assert.ok(joined.includes("fontfile=/tmp/f\\:o\\'nt.ttf"), "font path not escaped: " + joined.slice(0, 120));
    assert.equal((joined.match(/drawtext=/g) ?? []).length, (joined.match(/expansion=none/g) ?? []).length, "every drawtext needs expansion=none");
    assert.ok(joined.includes("textfile=" + dir.replace(/\\/g, "\\\\")), "text must be passed via textfile=");

    const written = await Promise.all(ctx.files.map((f) => readFile(f, "utf8")));
    // The newline label is whitespace-normalised by wrapText, so the byte-for-byte
    // assertion uses the single-line literal; the newline itself must not appear in
    // the filter string (checked above).
    assert.ok(written.some((t) => t.includes(HOSTILE)), "the label should reach a text file byte-for-byte");
    assert.ok(written.some((t) => t.includes("first line second line")), "wrapped text should be written to its own file");
    assert.equal(ctx.files.length, ctx.n, "every text file should be tracked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- range parsing (the suffix form is the bug being fixed) -------------------
check("range: normal, open-ended, suffix and clipped forms", () => {
  const total = 1000;
  assert.deepEqual(parseByteRange("bytes=0-99", total), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=100-", total), { start: 100, end: 999 });
  assert.deepEqual(parseByteRange("bytes=0-", total), { start: 0, end: 999 });
  assert.deepEqual(parseByteRange("bytes=500-99999", total), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange("bytes=999-1000", total), { start: 999, end: 999 });
  // bytes=-N means the LAST N bytes (it used to answer 0..N).
  assert.deepEqual(parseByteRange("bytes=-100", total), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-1", total), { start: 999, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-1000", total), { start: 0, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-5000", total), { start: 0, end: 999 });
  assert.deepEqual(parseByteRange(" bytes=-100 ", total), { start: 900, end: 999 });
});

check("range: unsatisfiable forms", () => {
  const total = 1000;
  assert.equal(parseByteRange("bytes=1000-", total), "unsatisfiable");
  assert.equal(parseByteRange("bytes=1000-1001", total), "unsatisfiable");
  assert.equal(parseByteRange("bytes=100-50", total), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", total), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-", total), "unsatisfiable");
  assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable");
});

check("range: absent or foreign headers mean 'serve the whole body'", () => {
  assert.equal(parseByteRange(null, 1000), null);
  assert.equal(parseByteRange(undefined, 1000), null);
  assert.equal(parseByteRange("", 1000), null);
  assert.equal(parseByteRange("items=0-5", 1000), null);
  assert.equal(parseByteRange("bytes=abc-def", 1000), null);
  assert.equal(parseByteRange("bytes=0-1,3-4", 1000), null);
  assert.equal(parseByteRange("bytes=0-1-2", 1000), null);
});

test(`graphics: validation, escaping and ranges (${cases.length} checks, source ${SOURCE})`, async () => {
  const failures = [];
  for (const [name, fn] of cases) {
    try {
      await fn();
    } catch (e) {
      failures.push(`${name}: ${String(e.message).split("\n")[0]}`);
    }
  }
  console.log(`graphics: ${cases.length - failures.length}/${cases.length} checks passed`);
  assert.deepEqual(failures, []);
});
