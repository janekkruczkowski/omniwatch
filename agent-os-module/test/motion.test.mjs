// The vocabulary of arriving and leaving: junk in, a valid Move out; a Move plus timing out
// as a tween spec the renderer can run.
//
//   node --test agent-os-module/test/motion.test.mjs
//
// Every case here is a way a model's answer could have broken the render: a `shape` it
// invented, a `seconds` or `amount` far outside what a human would ever ask for, a move
// asked to outlast the element carrying it. Nothing in `omniwatchMotion.ts` reaches out to
// ffmpeg, GSAP or the DOM, so — unlike `cues.test.mjs` — there is no process helper to stub
// and no fixture to load beyond the transpiled module itself.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchMotion.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-motion-"));

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
const motion = load("omniwatchMotion");

const BOX = { width: 400, height: 220 };
const LONG_LIFE = { start: 2, end: 10 }; // 8s life — never the binding constraint below

// ---------------------------------------------------------------------------------------
// normalizeMove — junk in, a valid Move out
// ---------------------------------------------------------------------------------------

test("null, a string, a number and an array all fall back to the cut sentinel", () => {
  for (const junk of [null, "pop", 42, [1, 2, 3], undefined]) {
    const move = motion.normalizeMove(junk);
    assert.deepEqual(move, motion.CUT_MOVE, `${JSON.stringify(junk)} -> ${JSON.stringify(move)}`);
  }
});

test("an unrecognised shape falls back to cut, not to a guess", () => {
  const move = motion.normalizeMove({ shape: "bounce", seconds: 0.3, amount: 0.1 });
  assert.deepEqual(move, motion.CUT_MOVE);
});

test("a caller-supplied fallback is honoured for junk and unknown shapes alike", () => {
  const fallback = { shape: "fade", seconds: 0.3, ease: "soft-out", amount: 0 };
  assert.deepEqual(motion.normalizeMove(null, fallback), fallback);
  assert.deepEqual(motion.normalizeMove({ shape: "zoom" }, fallback), fallback);
});

test("negative seconds are clamped up to the floor, not dropped or negated", () => {
  const move = motion.normalizeMove({ shape: "fade", seconds: -5, amount: 0.1 });
  assert.equal(move.seconds, motion.MOVE_SECONDS_MIN);
});

test("seconds far above the ceiling are clamped down to it", () => {
  const move = motion.normalizeMove({ shape: "swell", seconds: 99 });
  assert.equal(move.seconds, motion.MOVE_SECONDS_MAX);
});

test("an amount of 50 is clamped down to the contract's ceiling", () => {
  const move = motion.normalizeMove({ shape: "pop", amount: 50 });
  assert.equal(move.amount, motion.MOVE_AMOUNT_MAX);
});

test("a negative amount is clamped up to zero", () => {
  const move = motion.normalizeMove({ shape: "drift", amount: -3 });
  assert.equal(move.amount, motion.MOVE_AMOUNT_MIN);
});

test("missing seconds, amount and ease are filled from that shape's own defaults", () => {
  const move = motion.normalizeMove({ shape: "pop" });
  assert.equal(move.shape, "pop");
  assert.ok(move.seconds >= motion.MOVE_SECONDS_MIN && move.seconds <= motion.MOVE_SECONDS_MAX);
  assert.ok(move.amount >= motion.MOVE_AMOUNT_MIN && move.amount <= motion.MOVE_AMOUNT_MAX);
  assert.ok(motion.MOVE_EASES.includes(move.ease));
});

test("an invalid ease string is replaced by the shape's default rather than passed through", () => {
  const move = motion.normalizeMove({ shape: "fade", ease: "linear" });
  assert.notEqual(move.ease, "linear");
  assert.ok(motion.MOVE_EASES.includes(move.ease));
});

test("shape 'cut' always returns the sentinel, even when other fields are supplied", () => {
  const move = motion.normalizeMove({ shape: "cut", seconds: 5, amount: 5, ease: "overshoot" });
  assert.deepEqual(move, motion.CUT_MOVE);
});

test("a well-formed Move within range passes through unchanged", () => {
  const raw = { shape: "drift", seconds: 0.2, ease: "soft-in-out", amount: 0.15 };
  assert.deepEqual(motion.normalizeMove(raw), raw);
});

// ---------------------------------------------------------------------------------------
// arrivalTween / departureTween — every shape, only supported vars, never linear
// ---------------------------------------------------------------------------------------

test("every one of the five shapes produces vars using only renderer-supported properties", () => {
  for (const shape of motion.MOVE_SHAPES) {
    const move = motion.normalizeMove({ shape });
    for (const tween of [motion.arrivalTween(move, LONG_LIFE, BOX), motion.departureTween(move, LONG_LIFE, BOX)]) {
      for (const key of Object.keys(tween.vars)) {
        assert.ok(motion.MOTION_VARS.includes(key), `${shape}: unsupported var "${key}"`);
      }
      assert.ok(["from", "fromTo", "set"].includes(tween.method), `${shape}: bad method "${tween.method}"`);
    }
  }
});

test("easing is never linear or none, for any shape, any input", () => {
  const inputs = [
    { shape: "cut" }, { shape: "fade" }, { shape: "pop" }, { shape: "drift" }, { shape: "swell" },
    { shape: "fade", ease: "linear" }, { shape: "pop", ease: "none" }, { shape: "junk" }, null, "garbage", 7,
  ];
  for (const raw of inputs) {
    const move = motion.normalizeMove(raw);
    for (const tween of [motion.arrivalTween(move, LONG_LIFE, BOX), motion.departureTween(move, LONG_LIFE, BOX)]) {
      assert.notEqual(tween.ease, "linear");
      assert.notEqual(tween.ease, "none");
      assert.ok(tween.ease.length > 0);
    }
  }
});

test("fade animates only opacity, in on arrival and out on departure", () => {
  const move = motion.normalizeMove({ shape: "fade" });
  const arrival = motion.arrivalTween(move, LONG_LIFE, BOX);
  assert.equal(arrival.method, "from");
  assert.deepEqual(arrival.vars, { opacity: 0 });

  const departure = motion.departureTween(move, LONG_LIFE, BOX);
  assert.equal(departure.method, "fromTo");
  assert.deepEqual(departure.vars, { opacity: [1, 0] });
});

test("pop scales up from smaller with an overshoot ease by default", () => {
  const move = motion.normalizeMove({ shape: "pop" });
  assert.equal(move.ease, "overshoot");
  const arrival = motion.arrivalTween(move, LONG_LIFE, BOX);
  assert.equal(arrival.vars.scale, 1 - move.amount);
  assert.equal(arrival.ease, motion.GSAP_EASE.overshoot);
});

test("swell scales up from smaller without the overshoot ease by default", () => {
  const move = motion.normalizeMove({ shape: "swell" });
  assert.equal(move.ease, "soft-in-out");
  assert.notEqual(move.ease, "overshoot");
});

test("drift moves by amount of the caller's own box width, in pixels", () => {
  const move = motion.normalizeMove({ shape: "drift", amount: 0.2 });
  const arrival = motion.arrivalTween(move, LONG_LIFE, BOX);
  assert.equal(Math.abs(arrival.vars.x), 0.2 * BOX.width);
  // A box with no usable width degrades to no slide rather than NaN.
  const noBox = motion.arrivalTween(move, LONG_LIFE, { width: 0, height: 0 });
  assert.equal(noBox.vars.x, 0);
});

test("cut produces today's behaviour: no vars, a plain set, zero duration", () => {
  const move = motion.normalizeMove({ shape: "cut" });
  const arrival = motion.arrivalTween(move, LONG_LIFE, BOX);
  const departure = motion.departureTween(move, LONG_LIFE, BOX);
  assert.equal(arrival.method, "set");
  assert.deepEqual(arrival.vars, {});
  assert.equal(arrival.duration, 0);
  assert.equal(departure.method, "set");
  assert.deepEqual(departure.vars, {});
  assert.equal(departure.duration, 0);
});

test("cut is also what an absent Move renders as", () => {
  const move = motion.normalizeMove(undefined);
  const arrival = motion.arrivalTween(move, LONG_LIFE, BOX);
  assert.deepEqual(arrival.vars, {});
  assert.equal(arrival.duration, 0);
});

// ---------------------------------------------------------------------------------------
// The hard limit: a move never exceeds half the element's lifetime
// ---------------------------------------------------------------------------------------

test("a move longer than half the element's life is clamped down to that half", () => {
  const shortLife = { start: 10, end: 10.2 }; // 0.2s life -> at most 0.1s of move
  const move = motion.normalizeMove({ shape: "swell", seconds: 0.6 }); // the contract ceiling
  const arrival = motion.arrivalTween(move, shortLife, BOX);
  assert.ok(arrival.duration <= 0.1 + 1e-9, `duration ${arrival.duration} exceeds half the 0.2s life`);
  const departure = motion.departureTween(move, shortLife, BOX);
  assert.ok(departure.duration <= 0.1 + 1e-9);
});

test("a zero or negative lifetime never produces a negative or NaN duration", () => {
  for (const timing of [{ start: 5, end: 5 }, { start: 5, end: 4 }, { start: NaN, end: NaN }]) {
    const move = motion.normalizeMove({ shape: "pop" });
    const arrival = motion.arrivalTween(move, timing, BOX);
    const departure = motion.departureTween(move, timing, BOX);
    assert.ok(Number.isFinite(arrival.duration) && arrival.duration >= 0, `arrival ${arrival.duration}`);
    assert.ok(Number.isFinite(departure.duration) && departure.duration >= 0, `departure ${departure.duration}`);
  }
});

test("arrival starts at the element's own start; departure ends at its own end", () => {
  const move = motion.normalizeMove({ shape: "fade" });
  const arrival = motion.arrivalTween(move, LONG_LIFE, BOX);
  assert.equal(arrival.at, LONG_LIFE.start);
  const departure = motion.departureTween(move, LONG_LIFE, BOX);
  assert.ok(Math.abs(departure.at + departure.duration - LONG_LIFE.end) < 1e-9);
  assert.ok(departure.at >= LONG_LIFE.start);
});

// ---------------------------------------------------------------------------------------
// elementTweens — one arrival, one departure, straight from raw model output
// ---------------------------------------------------------------------------------------

test("elementTweens normalizes raw arrival/departure and returns exactly one of each", () => {
  const item = { arrival: { shape: "pop", amount: 0.2 }, departure: { shape: "bogus" }, start: 1, end: 9 };
  const { arrival, departure } = motion.elementTweens(item, BOX);
  assert.equal(Object.keys({ arrival, departure }).length, 2);
  assert.equal(arrival.method, "from");
  assert.equal(arrival.vars.scale, 1 - 0.2);
  // "bogus" is not a real shape, so the departure is cut's no-op.
  assert.deepEqual(departure.vars, {});
});

test("an item with neither field set renders as cut on both edges", () => {
  const { arrival, departure } = motion.elementTweens({ start: 0, end: 5 }, BOX);
  assert.deepEqual(arrival.vars, {});
  assert.deepEqual(departure.vars, {});
});
