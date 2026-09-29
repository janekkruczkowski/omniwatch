// The node shape: one loop, run against nodes that never touch a network.
//
//   node --test agent-os-module/test/node.test.mjs
//
// Four gates in this pipeline already checked their own output and tried again before this
// file existed — each written by hand, each in its own style. What is tested here is not any
// one of those gates; it is the loop they now share: that an accepted result on the first try
// costs one attempt, that a retry actually drives the next attempt from the changed INPUT
// (never the same question asked twice), and that giving up produces a DEGRADED value when the
// node says so and a HOLE — not a value that merely looks like one — when it does not.

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
  || [path.join(HERE, "..", "src"), path.join(AGENT_OS, "src")].find((c) => existsSync(path.join(c, "lib", "omniwatchNode.ts")))
  || path.join(HERE, "..", "src");
const req = createRequire(path.join(AGENT_OS, "package.json"));
const ts = req("typescript");
const dir = mkdtempSync(path.join(tmpdir(), "omni-node-"));

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
const { runNode } = load("omniwatchNode");

test("accepted on the first attempt costs exactly one attempt", async () => {
  const log = [];
  const node = {
    name: "first-try",
    async run(input) { return input; },
    accepts: (out) => out === "good",
  };
  const out = await runNode(node, "good", log);
  assert.equal(out, "good");
  assert.equal(log.length, 1);
  assert.equal(log[0].node, "first-try");
  assert.equal(log[0].outcome, "accepted");
  assert.equal(log[0].attempts.length, 1);
  assert.equal(log[0].attempts[0].attempt, 1);
  assert.equal(log[0].attempts[0].verdict, "accepted");
});

test("accepted on a later attempt after retry changed the input", async () => {
  const log = [];
  const tried = [];
  // The moments a caption-band-style gate would look at: the first one is a value the format
  // never actually shows, so accepts() rejects it until retry moves to the next one.
  const moments = [3, 8, 15];
  const node = {
    name: "later-try",
    describe: (at) => `t=${at}`,
    async run(at) { tried.push(at); return at; },
    accepts: (at) => at === 15,
    retry: (_at, attempt) => (attempt < moments.length ? moments[attempt] : null),
  };
  const out = await runNode(node, moments[0], log);
  assert.equal(out, 15);
  // Never the same input twice — retry actually changed what was tried each time.
  assert.deepEqual(tried, [3, 8, 15]);
  assert.equal(log.length, 1);
  assert.equal(log[0].outcome, "accepted");
  assert.equal(log[0].attempts.length, 3);
  assert.deepEqual(log[0].attempts.map((a) => a.verdict), ["rejected", "rejected", "accepted"]);
  assert.deepEqual(log[0].attempts.map((a) => a.input), ["t=3", "t=8", "t=15"]);
});

test("never accepts, and onGiveUp stands in with a degraded value", async () => {
  const log = [];
  let attemptsMade = 0;
  const node = {
    name: "degrades",
    async run(input, attempt) { attemptsMade = attempt; return { rows: attempt }; },
    accepts: (out) => out.rows >= 100, // never reachable in three attempts
    retry: (input, attempt) => (attempt < 3 ? input + 1 : null),
    onGiveUp: () => ({ rows: -1, degraded: true }),
  };
  const out = await runNode(node, 1, log);
  assert.deepEqual(out, { rows: -1, degraded: true });
  assert.equal(attemptsMade, 3);
  assert.equal(log.length, 1);
  assert.equal(log[0].outcome, "degraded");
  assert.equal(log[0].attempts.length, 3);
  assert.ok(log[0].attempts.every((a) => a.verdict === "rejected"));
});

test("never accepts, no onGiveUp value, and the result is a hole — not the input's own guess", async () => {
  const log = [];
  const node = {
    name: "hole",
    async run() { return null; }, // every attempt genuinely fails to produce anything
    accepts: () => false,
    retry: (input, attempt) => (attempt < 2 ? input : null),
  };
  const out = await runNode(node, "whatever", log);
  assert.equal(out, null);
  assert.equal(log.length, 1);
  assert.equal(log[0].outcome, "hole");
  assert.equal(log[0].attempts.length, 2);
  assert.ok(log[0].attempts.every((a) => a.verdict === "failed"));
});

test("a node with no retry() stops after one attempt — no retry means no second try", async () => {
  const log = [];
  let calls = 0;
  const node = {
    name: "no-retry",
    async run() { calls++; return "meh"; },
    accepts: () => false,
  };
  const out = await runNode(node, null, log);
  assert.equal(out, null);
  assert.equal(calls, 1);
  assert.equal(log[0].attempts.length, 1);
  assert.equal(log[0].outcome, "hole");
});

test("appends to an existing log rather than replacing it — multiple nodes, multiple records", async () => {
  const log = [{ node: "earlier", attempts: [], outcome: "accepted" }];
  const node = { name: "later", async run() { return 1; }, accepts: () => true };
  await runNode(node, null, log);
  assert.equal(log.length, 2);
  assert.equal(log[0].node, "earlier");
  assert.equal(log[1].node, "later");
});
