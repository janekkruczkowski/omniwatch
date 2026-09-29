// The template library: measure a format once, keep it, render many films in it without
// measuring again.
//
//   node --test agent-os-module/test/template.test.mjs
//
// Three things are worth proving, in this order. First, that lifting a template out of a
// measured blueprint and immediately hydrating it back — no new content supplied — produces
// the SAME structure: same regions, same row count, same layer order, same caption box. That
// is the round trip the whole feature rests on: if it does not hold, nothing downstream can
// be trusted either. Second, that doing so touches neither a film nor a model — proven here
// by making both throw if called, not by reading the source and taking its word for it.
// Third, that a template which cannot produce a valid blueprint is refused at SAVE time, with
// the validator's own reason, rather than failing silently and surfacing as a broken render.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchTemplate.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-template-"));

// Where the library on disk lives for this run — a fresh temp directory, never the real
// ~/.agentic-os/omniwatch, so this file cannot leave anything behind in a person's home.
const OMNI_HOME = mkdtempSync(path.join(tmpdir(), "omni-template-home-"));

// The only two doors this codebase has to a film or a model are `run` (shells out, mostly to
// ffmpeg) and `apiKey` (unlocks a provider). Both throw here. If saving, loading or hydrating
// a template ever called either, the test that exercises it fails loudly instead of quietly
// passing on a lucky code path.
writeFileSync(path.join(dir, "omniwatch.js"), `
exports.OMNI_ROOT = ${JSON.stringify(OMNI_HOME)};
exports.run = async () => { throw new Error("template code must not shell out — this would have measured the film again"); };
exports.apiKey = async () => { throw new Error("template code must not ask a model for anything"); };
exports.videoDir = (id) => require("node:path").join(${JSON.stringify(OMNI_HOME)}, "cache", id);
`);

// Emitting a module emits whatever it imports, first, so a hand-kept list of load() calls
// never goes stale — see the identical comment in recipe.test.mjs, which this copies.
// "omniwatch" is pre-marked emitted so that recursive discovery (omniwatchTemplate ->
// omniwatchRecipe -> omniwatchBlueprint -> omniwatchBoardScan -> omniwatch) can never
// overwrite the stub above with the real, network/ffmpeg-touching module.
const emitted = new Set(["omniwatch"]);
function emit(name) {
  if (emitted.has(name)) return;
  emitted.add(name);
  const file = path.join(SOURCE, "lib", `${name}.ts`);
  const src = readFileSync(file, "utf8");
  const out = ts.transpileModule(src, {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText.replace(/require\("@\/lib\/([A-Za-z0-9_]+)"\)/g, 'require("./$1.js")');
  writeFileSync(path.join(dir, `${name}.js`), out);
  for (const dep of src.matchAll(/["']@\/lib\/([A-Za-z0-9_]+)["']/g)) emit(dep[1]);
}
function load(name) {
  emit(name);
  return req(path.join(dir, `${name}.js`));
}
const bp = load("omniwatchBlueprint");
const recipeLib = load("omniwatchRecipe");
const tmpl = load("omniwatchTemplate");

// ── a measured episode, the same shape blueprint.test.mjs's tierList() uses ───────────────
// A scaffolded tier board, a presenter that is CUT from the source film, and captions and
// images that change per ranked subject — plus the motion/cue fields IR-CONTRACT-V2 §2-3
// added, so the template has something real to carry besides geometry: the reaction icon
// waits beside the host and lands when the verdict is said (beat 1 lands at t=8, beat 2 at
// t=18), and the insert photograph over the board pops in and fades out.
function measuredEpisode() {
  return {
    version: bp.BLUEPRINT_VERSION,
    canvas: { width: 720, height: 1280, fps: 30, seconds: 20 },
    regions: [
      { id: "stage", role: "backdrop", rect: [0, 0, 1, 1], z: 0 },
      { id: "title", role: "text", label: "headline strip", rect: [0, 0, 1, 0.08], z: 3 },
      { id: "host", role: "figure", label: "presenter with microphone", rect: [0.1, 0.1, 0.8, 0.35], z: 2 },
      { id: "face", role: "overlay", label: "reaction inset", rect: [0.05, 0.12, 0.15, 0.1], z: 5, parent: "host" },
      { id: "caption", role: "text", label: "spoken line", rect: [0.05, 0.47, 0.9, 0.07], z: 4 },
      { id: "board", role: "panel", label: "tier list", rect: [0, 0.55, 1, 0.45], z: 1, grid: { rows: 5, cols: 4 } },
      { id: "cell_d1", role: "cell", label: "tier row D, first slot", rect: [0.15, 0.88, 0.25, 0.1], z: 2, parent: "board", at: { row: 5, col: 1 } },
    ],
    tracks: [
      { region: "stage", kind: "color", varies: "fixed", items: [{ start: 0, end: 20, value: "#000000" }] },
      { region: "title", kind: "text", varies: "fixed", items: [{ start: 0, end: 20, value: "RANKING THE BEST FOOTBALLERS" }] },
      { region: "board", kind: "image", varies: "fixed", items: [{ start: 0, end: 20, value: "five rows labelled S A B C D" }] },
      { region: "host", kind: "video", varies: "episode", fill: "cut", items: [{ start: 0, end: 20, value: "whoever is on screen" }] },
      { region: "face", kind: "image", varies: "episode", items: [
        {
          start: 0, end: 10, value: "a portrait of the first subject", beat: 1,
          hold: "on-cue", waitsAt: "host", landsAt: 8,
          arrival: { shape: "pop", seconds: 0.3, amount: 0.2, ease: "soft-out" },
          departure: { shape: "fade" },
        },
        {
          start: 10, end: 20, value: "a portrait of the second subject", beat: 2,
          hold: "on-cue", waitsAt: "host", landsAt: 18,
          arrival: { shape: "pop", seconds: 0.3, amount: 0.2, ease: "soft-out" },
          departure: { shape: "fade" },
        },
      ] },
      { region: "caption", kind: "text", varies: "episode", items: [
        { start: 0, end: 2, value: "Ronaldo is D tier.", beat: 1 },
        { start: 2, end: 4, value: "Bro has more hair gel than trophies.", beat: 1 },
        { start: 10, end: 12, value: "Messi? Man won a World Cup", beat: 2 },
        { start: 12, end: 14, value: "looking like somebody's tired dad.", beat: 2 },
      ] },
      { region: "cell_d1", kind: "image", varies: "episode", items: [
        {
          start: 2, end: 6, value: "hair gel beside empty trophy shelves", beat: 1,
          arrival: { shape: "pop", seconds: 0.25, amount: 0.15, ease: "overshoot" },
          departure: { shape: "fade", seconds: 0.2 },
        },
        {
          start: 12, end: 16, value: "a World Cup trophy held by a tired man", beat: 2,
          arrival: { shape: "pop", seconds: 0.25, amount: 0.15, ease: "overshoot" },
          departure: { shape: "fade", seconds: 0.2 },
        },
      ] },
    ],
  };
}

const measured = () => bp.validateBlueprint(measuredEpisode());
const recipeFor = () => recipeLib.defaultRecipe({ width: 720, height: 1280 });
const provenanceFor = (notes = ["board measured from t=6.67", "aligner: 41 word times from cache"]) => ({
  source: "ranking/3acd67c83aff434a", measuredAt: new Date("2026-09-22T10:00:00Z").toISOString(), measured: notes,
});

test("deriving a template keeps every structural field and holds content out as guidance", () => {
  const { blueprint } = measured();
  const t = tmpl.deriveTemplate("ranking format", blueprint, recipeFor(), provenanceFor());

  assert.deepEqual(t.regions, blueprint.regions, "regions are 100% structure — kept verbatim");
  assert.equal(t.recipe.label.type.face, recipeFor().label.type.face, "the recipe carries over whole");

  const face = t.tracks.find((tr) => tr.region === "face");
  assert.equal(face.varies, "episode");
  assert.equal(face.items[0].example, "a portrait of the first subject", "the captured value survives as guidance");
  assert.equal(face.items[0].hold, "on-cue");
  assert.equal(face.items[0].waitsAt, "host");
  assert.equal(face.items[0].landsAt, 8, "cue policy — WHEN it lands — is structure, not content");
  assert.deepEqual(face.items[0].arrival, { shape: "pop", seconds: 0.3, amount: 0.2, ease: "soft-out" });

  const title = t.tracks.find((tr) => tr.region === "title");
  assert.equal(title.varies, "fixed");
  assert.equal(title.items[0].example, "RANKING THE BEST FOOTBALLERS", "a fixed track's value IS structure");
});

test("hydrating a template with no new content reproduces the measured structure exactly", () => {
  // This is the acceptance test the whole feature rests on: save what was measured, build
  // from the template alone, and the STRUCTURE must come back identical — same regions,
  // same row count, same layer order, same caption box.
  const { blueprint: original } = measured();
  const t = tmpl.deriveTemplate("ranking format", original, recipeFor(), provenanceFor());
  const built = tmpl.hydrateTemplate(t);
  assert.equal(built.ok, true, built.error);

  assert.deepEqual(built.blueprint.regions, original.regions, "same regions");
  const rows = original.regions.find((r) => r.id === "board").grid.rows;
  assert.equal(built.blueprint.regions.find((r) => r.id === "board").grid.rows, rows, "same row count");
  assert.deepEqual(
    built.blueprint.tracks.map((tr) => [tr.region, original.tracks.find((o) => o.region === tr.region)?.varies]),
    original.tracks.map((tr) => [tr.region, tr.varies]),
    "same layer order — tracks come back in the same sequence, painted the same regions",
  );
  const captionNow = built.blueprint.regions.find((r) => r.id === "caption");
  const captionThen = original.regions.find((r) => r.id === "caption");
  assert.deepEqual(captionNow.rect, captionThen.rect, "same caption box");
  assert.deepEqual(captionNow, captionThen);

  // Content came back too, because no override was given — the default is "reproduce what
  // was measured", not an empty hole.
  const face = built.blueprint.tracks.find((tr) => tr.region === "face");
  assert.deepEqual(face.items.map((i) => i.value), ["a portrait of the first subject", "a portrait of the second subject"]);
  assert.equal(face.items[0].hold, "on-cue");
  assert.equal(face.items[0].landsAt, 8);
});

test("hydrating a template touches no film and no model — proven by making both throw", () => {
  // omniwatch.js's `run` and `apiKey` both throw unconditionally in this file's stub. If
  // deriveTemplate/hydrateTemplate/saveTemplate ever reached either — meaning the film was
  // opened or a provider was asked something — this test fails with THAT error, not a
  // hand-wavy assertion that nothing happened.
  const { blueprint } = measured();
  const t = tmpl.deriveTemplate("no-measure check", blueprint, recipeFor(), provenanceFor());
  const built = tmpl.hydrateTemplate(t, {
    "caption:text": ["New line one.", "New line two.", "New line three.", "New line four."],
  });
  assert.equal(built.ok, true, built.error);
  assert.deepEqual(
    built.blueprint.tracks.find((tr) => tr.region === "caption").items.map((i) => i.value),
    ["New line one.", "New line two.", "New line three.", "New line four."],
  );
});

test("new content fills episode slots while structure stays put; a wrong count is refused", () => {
  const { blueprint } = measured();
  const t = tmpl.deriveTemplate("content swap", blueprint, recipeFor(), provenanceFor());

  const built = tmpl.hydrateTemplate(t, { "face:image": ["a portrait of Mbappe", "a portrait of Haaland"] });
  assert.equal(built.ok, true, built.error);
  const face = built.blueprint.tracks.find((tr) => tr.region === "face");
  assert.deepEqual(face.items.map((i) => i.value), ["a portrait of Mbappe", "a portrait of Haaland"]);
  // The timing and the cue policy did not move just because the words did.
  assert.equal(face.items[0].start, 0);
  assert.equal(face.items[0].landsAt, 8);
  assert.equal(face.items[0].waitsAt, "host");

  const wrongCount = tmpl.hydrateTemplate(t, { "face:image": ["only one subject this time"] });
  assert.equal(wrongCount.ok, false);
  assert.match(wrongCount.error, /content for "face:image" has 1 value/);

  // A fixed track cannot be overridden through content — it is scaffolding, not a slot.
  const ignoredOverride = tmpl.hydrateTemplate(t, { "title:text": ["SOMETHING ELSE ENTIRELY"] });
  assert.equal(ignoredOverride.ok, true, ignoredOverride.error);
  assert.equal(
    ignoredOverride.blueprint.tracks.find((tr) => tr.region === "title").items[0].value,
    "RANKING THE BEST FOOTBALLERS",
  );
});

test("saving writes readable JSON with provenance, and loading/listing/finding it back all work", async () => {
  const { blueprint } = measured();
  const t = tmpl.deriveTemplate("ranking format", blueprint, recipeFor(), provenanceFor());
  const saved = await tmpl.saveTemplate(t);
  assert.equal(saved.ok, true, saved.error);
  assert.ok(existsSync(saved.path), "the template is a real file on disk");

  const onDisk = JSON.parse(readFileSync(saved.path, "utf8"));
  assert.equal(onDisk.version, tmpl.TEMPLATE_VERSION);
  assert.equal(onDisk.provenance.source, "ranking/3acd67c83aff434a", "provenance says which film");
  assert.ok(onDisk.provenance.measuredAt, "provenance says when");
  assert.ok(onDisk.provenance.measured.length > 0, "provenance says what was actually measured");

  const loaded = await tmpl.loadTemplate(saved.id);
  assert.deepEqual(loaded, t);

  const byName = await tmpl.findTemplate("ranking format");
  assert.equal(byName.name, "ranking format");

  const listing = await tmpl.listTemplates();
  assert.ok(listing.some((l) => l.id === saved.id));
  assert.equal(listing.find((l) => l.id === saved.id).episodeSlots, 4, "host, face, caption, cell_d1 — four episode tracks");

  const described = tmpl.describeTemplate(t);
  assert.match(described, /ranking format/);
  assert.match(described, /face:image/, "a reader can see what slot to fill without opening the film");
});

test("a template that would produce an invalid blueprint is refused at save time, naming the rule", async () => {
  const { blueprint } = measured();
  const t = tmpl.deriveTemplate("broken template", blueprint, recipeFor(), provenanceFor());
  // Break a rule that only shows up once the template is turned back into a blueprint: give
  // a region a rect with zero height. deriveTemplate itself cannot catch this — it only
  // copies what validateBlueprint already accepted — so the refusal has to come from
  // hydrating the template and running it back through the same validator.
  const broken = { ...t, regions: t.regions.map((r) => (r.id === "caption" ? { ...r, rect: [r.rect[0], r.rect[1], r.rect[2], 0] } : r)) };

  const refused = await tmpl.saveTemplate(broken);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /width and height must be above zero/, "the validator's own rule, not a generic failure");

  const listing = await tmpl.listTemplates();
  assert.ok(!listing.some((l) => l.name === "broken template"), "nothing was written for a template that fails to hydrate");
});
