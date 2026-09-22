/**
 * D5 lifecycle against the REAL Agent OS host (T6/F).
 *
 * Skipped when no host checkout is present, so the suite stays green on a machine
 * without Agent OS. When it is present, it proves the panel-independent worker path:
 * the host's own modules are loaded by plain Node (through the alias loader) and the
 * worker takes ownership of the data directory in its own process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = path.join(repo, "agent-os-module/omniwatch-host-worker.mjs");
const corePath = path.join(repo, "packages/omniwatch/src/index.ts");
const hostRoot = process.env.OMNIWATCH_HOST_ROOT ?? "/Users/janek/Documents/agent-os";
const hostSrc = path.join(hostRoot, "source/src");
const hostAvailable = fs.existsSync(path.join(hostSrc, "lib/omniwatch.ts"));

function runWorker(args) {
  return spawnSync(process.execPath, [launcher, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OMNIWATCH_HOST_SRC: hostSrc,
      OMNIWATCH_OVERLAY_SRC: path.join(repo, "agent-os-module/src"),
      OMNIWATCH_CORE: corePath,
    },
  });
}

test("the Agent OS host engine is loadable by plain Node through the alias loader", (t) => {
  if (!hostAvailable) {
    t.skip(`no Agent OS host at ${hostRoot}`);
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-host-"));
  const result = runWorker(["--data-dir", dataDir, "--max", "0"]);
  assert.equal(result.status, 0, result.stderr);
  const payloads = result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "" && line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const ready = payloads.find((payload) => payload.event === "ready");
  const done = payloads.find((payload) => payload.event === "done");
  assert.ok(ready, "the worker must announce readiness before working");
  assert.ok(done, "the worker must report a final result");
  assert.equal(done.result.delivered, 0, "an empty queue delivers nothing");
  assert.equal(done.result.unknown, 0);
});

test("the host worker releases ownership on an empty queue", async (t) => {
  if (!hostAvailable) {
    t.skip(`no Agent OS host at ${hostRoot}`);
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-host-"));
  const result = runWorker(["--data-dir", dataDir, "--max", "0"]);
  assert.equal(result.status, 0, result.stderr);
  const { openSqliteStore } = await import("../../packages/omniwatch/src/storage/index.ts");
  const store = openSqliteStore({ path: path.join(dataDir, "state.sqlite") });
  try {
    assert.equal(store.getOwner(), null, "the worker must not leave an owner behind");
    assert.equal(store.listOperations({ limit: 10 }).length, 0);
  } finally {
    store.close();
  }
});

test("a missing data directory is reported as missing_config, not a crash", () => {
  const result = spawnSync(process.execPath, [launcher, "--max", "0"], {
    encoding: "utf8",
    env: { ...process.env, OMNIWATCH_DATA_DIR: "", OMNIWATCH_HOST_SRC: hostSrc, OMNIWATCH_CORE: corePath },
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /missing_config/);
});
