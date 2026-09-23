/**
 * T17 — released Python beta migration (T7).
 *
 * Every test works on a synthetic copy of `test/fixtures/beta/legacy` in a temp
 * directory. No real `.env`, `.cache`, `summaries` or Vault is read, and the
 * assertions include the migration's own promise: zero model calls, zero
 * downloads, byte-identical old analyses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLegacyIndex,
  migrateLegacyData,
  readAnalysisCompat,
  readLegacyCacheEntry,
  readLegacySummary,
  readLegacyUploads,
} from "../../apps/standalone/legacy.mjs";
import { loadStandaloneConfig, parseEnvText, resolveLanguage, resolveMode } from "../../apps/standalone/config.mjs";
import { createStandaloneMediaTool, createStandaloneServer, sseFrame } from "../../apps/standalone/server.mjs";
import { mapLegacyArgs, nodeVersionSupported, runStandaloneCli } from "../../apps/standalone/cli.mjs";
import { BETA_OSS_TTL_HOURS, evaluateUploadFreshness } from "../../packages/omniwatch/src/sources/legacy.ts";
import { createSourceRegistry } from "../../packages/omniwatch/src/sources/registry.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(repo, "test/fixtures/beta");
const NOW_SECONDS = 1800000000;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** A beta installation copy: appRoot contains summaries/ and .cache/. */
function betaCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniwatch-beta-"));
  const appRoot = path.join(root, "app");
  fs.mkdirSync(appRoot, { recursive: true });
  fs.cpSync(path.join(fixtures, "legacy"), appRoot, { recursive: true });
  // A real beta installation has its frontend next to the scripts.
  fs.cpSync(path.join(repo, "apps/standalone/static"), path.join(appRoot, "static"), { recursive: true });
  return { root, appRoot, dataDir: path.join(root, "data") };
}

test("beta metadata normalises channel over uploader and extractor_key to extractor", () => {
  const { appRoot } = betaCopy();
  const a = readLegacyCacheEntry(appRoot, "SYNTHETIC01");
  assert.equal(a.info.channel, "Fixture Channel");
  assert.equal(a.info.extractor, "Youtube");
  assert.equal(a.info.title, "Fixture A — ekran");
  assert.equal(a.info.duration, 16);

  const b = readLegacyCacheEntry(appRoot, "ade4dd11a0580e69");
  assert.equal(b.info.channel, "Fixture Uploader", "channel=null must fall back to uploader");
  assert.equal(b.info.extractor, "Generic");
});

test("legacy ids keep the beta SHA-1 identity and reject unsafe ids", () => {
  const { appRoot } = betaCopy();
  assert.equal(readLegacyCacheEntry(appRoot, "ade4dd11a0580e69").id, "ade4dd11a0580e69");
  for (const bad of ["../escape", "a/b", "", "."]) {
    assert.throws(() => readLegacyCacheEntry(appRoot, bad), undefined, `id ${JSON.stringify(bad)} must be refused`);
  }
});

test("oss.json timestamps are seconds; the upload TTL is the beta's fixed 47 h whatever OMNI_CACHE_HOURS says", async () => {
  // QA R2 M2: this test used to assert that a configured 48 h cache window keeps a
  // 47 h-old upload fresh - i.e. it froze the bug that sent expired oss:// URLs to the
  // model. The provider keeps an upload 48 h and the beta refreshed it an hour early
  // (`OSS_TTL = 47 * 3600`, independent of `OMNI_CACHE_HOURS`).
  const { appRoot } = betaCopy();
  fs.copyFileSync(
    path.join(fixtures, "oss", "expired.json"),
    path.join(appRoot, ".cache", "SYNTHETIC01", "oss.json"),
  );
  for (const cacheHours of [47, 48, 168, 100000]) {
    const uploads = readLegacyUploads(appRoot, "SYNTHETIC01", { nowSeconds: NOW_SECONDS, cacheHours });
    const entry = uploads.entries.find((item) => item.name === "source.mp4");
    assert.equal(entry.freshness.valid, false, `a 47 h-old upload is expired with OMNI_CACHE_HOURS=${cacheHours}`);
    const index = buildLegacyIndex(appRoot, { nowSeconds: NOW_SECONDS, cacheHours });
    assert.equal(index.counts.freshUploads, 0, `migration counts no fresh upload with OMNI_CACHE_HOURS=${cacheHours}`);
    assert.equal(index.uploadTtlHours, 47);
  }
  assert.equal(evaluateUploadFreshness({ at: NOW_SECONDS - 47 * 3600 }, BETA_OSS_TTL_HOURS, NOW_SECONDS).valid, false);
  assert.equal(evaluateUploadFreshness({ at: NOW_SECONDS - 46 * 3600 }, BETA_OSS_TTL_HOURS, NOW_SECONDS).valid, true);

  // The standalone media tool (a new upload path) and the core registry (reuse of a
  // beta upload) both refuse a 47.5 h-old oss:// URL even with a one-week cache window.
  const cacheDir = path.join(appRoot, "..", "cache");
  fs.mkdirSync(path.join(cacheDir, "SYNTHETIC01"), { recursive: true });
  const partFile = path.join(cacheDir, "SYNTHETIC01", "part_1_0.mp4");
  fs.writeFileSync(partFile, "part");
  const stale = NOW_SECONDS - Math.round(47.5 * 3600);
  fs.writeFileSync(
    path.join(cacheDir, "SYNTHETIC01", "oss.json"),
    JSON.stringify({ "part_1_0.mp4": { url: "oss://stale/part_1_0.mp4", at: stale } }),
  );
  const media = createStandaloneMediaTool({ cacheDir, cacheHours: () => 168, nowSeconds: () => NOW_SECONDS });
  await assert.rejects(
    () => media.uploadPart({ localPath: partFile }, { apiKey: () => null }),
    /Brak klucza/,
    "a stale upload is not reused, so a new upload is attempted (and needs a key)",
  );
  const registry = createSourceRegistry({
    media: {
      cached: async () => ({ localPath: "/tmp/x/source.mp4", durationSeconds: 16 }),
      fetch: async () => { throw new Error("no download expected"); },
      readUploads: async () => ({ "source.mp4": { url: "oss://stale/source.mp4", at: stale } }),
      slice: async () => "/tmp/x/part.mp4",
    },
    cacheHours: () => 168,
    now: () => NOW_SECONDS,
  });
  const info = await registry.prepare({
    platform: "youtube", sourceId: "SYNTHETIC01", canonicalUrl: "https://youtu.be/SYNTHETIC01", legacyId: "SYNTHETIC01",
  });
  assert.equal(info.reusedUpload, false, "the registry does not reuse a 47.5 h-old upload with OMNI_CACHE_HOURS=168");

  fs.copyFileSync(
    path.join(fixtures, "oss", "fresh.json"),
    path.join(appRoot, ".cache", "SYNTHETIC01", "oss.json"),
  );
  const fresh = readLegacyUploads(appRoot, "SYNTHETIC01", { nowSeconds: NOW_SECONDS });
  assert.equal(fresh.entries.find((item) => item.name === "source.mp4").freshness.valid, true);

  fs.copyFileSync(
    path.join(fixtures, "oss", "future.json"),
    path.join(appRoot, ".cache", "SYNTHETIC01", "oss.json"),
  );
  const future = readLegacyUploads(appRoot, "SYNTHETIC01", { nowSeconds: NOW_SECONDS });
  assert.equal(future.entries.find((item) => item.name === "source.mp4").freshness.valid, false, "future is never fresh");
});

test("malformed, invalid and future upload entries are never treated as fresh", () => {
  assert.equal(evaluateUploadFreshness({ at: "not-a-time" }, 48, NOW_SECONDS).valid, false);
  assert.equal(evaluateUploadFreshness({ at: NOW_SECONDS + 60 }, 48, NOW_SECONDS).valid, false);
  assert.equal(evaluateUploadFreshness(null, 48, NOW_SECONDS).valid, false);
  assert.equal(evaluateUploadFreshness({ at: NOW_SECONDS - 60 }, 48, NOW_SECONDS).valid, true);
});

test("migration is offline, idempotent and leaves old analyses byte-identical", () => {
  const { appRoot, dataDir } = betaCopy();
  const summaryPath = path.join(appRoot, "summaries", "SYNTHETIC01.md");
  const before = sha256(fs.readFileSync(summaryPath));

  const first = migrateLegacyData({ appRoot, dataDir, nowSeconds: NOW_SECONDS, cacheHours: 48 });
  assert.equal(first.modelCalls, 0, "migration must not call a model");
  assert.equal(first.downloads, 0, "migration must not download");
  assert.equal(first.changed, true);

  const second = migrateLegacyData({ appRoot, dataDir, nowSeconds: NOW_SECONDS, cacheHours: 48 });
  assert.equal(second.changed, false, "a second migration must not rewrite the index");

  assert.equal(sha256(fs.readFileSync(summaryPath)), before, "old Markdown must stay byte-identical");
  assert.deepEqual(first.index, second.index);
});

test("the legacy index maps both fixture ids without inventing new ones", () => {
  const { appRoot } = betaCopy();
  const index = buildLegacyIndex(appRoot, { nowSeconds: NOW_SECONDS, cacheHours: 48 });
  const ids = index.entries.map((entry) => entry.legacyId).sort();
  assert.deepEqual(ids, ["SYNTHETIC01", "ade4dd11a0580e69"]);
  assert.equal(index.counts.entries, 2);
  assert.equal(index.counts.modelCalls, 0);
  assert.equal(index.counts.downloads, 0);
});

test("old analyses stay readable, including CRLF and a missing trailing newline", () => {
  const { appRoot, dataDir } = betaCopy();
  migrateLegacyData({ appRoot, dataDir, nowSeconds: NOW_SECONDS, cacheHours: 48 });

  const first = readAnalysisCompat({ appRoot, dataDir, id: "SYNTHETIC01" });
  assert.equal(first.source, "legacy");
  assert.match(first.content, /Synthetic result: the screen shows 7\./);
  assert.match(first.content, /Co pokazuje ekran\?/);

  const raw = readLegacySummary(appRoot, "ade4dd11a0580e69");
  const rawText = raw.bytes.toString("utf8");
  assert.equal(rawText.includes("\r\n"), true, "CRLF formatting must be preserved");
  assert.equal(rawText.endsWith("\n"), false, "the missing trailing newline must be preserved");
});

test("configuration keeps the beta names, file location and process precedence", () => {
  assert.deepEqual({ ...parseEnvText("OMNI_LANG=pl\nOMNI_MODEL=fixture-omni\n") }, {
    OMNI_LANG: "pl",
    OMNI_MODEL: "fixture-omni",
  });

  const { appRoot } = betaCopy();
  fs.writeFileSync(path.join(appRoot, ".env"), fs.readFileSync(path.join(fixtures, "config", "default.env.txt"), "utf8"));

  const fromFile = loadStandaloneConfig({ appRoot, env: {} });
  assert.equal(fromFile.language, "pl");
  assert.equal(fromFile.model, "fixture-omni");
  assert.equal(fromFile.cacheHours, 48);
  assert.equal(fromFile.maxFrames, 2400);
  assert.equal(fromFile.apiKey, "fixture-not-a-secret");

  const fromProcess = loadStandaloneConfig({
    appRoot,
    env: { OMNI_LANG: "en", OMNI_MODEL: "fixture-process", DASHSCOPE_API_KEY: "fixture-process-key" },
  });
  assert.equal(fromProcess.language, "en", "process env must win");
  assert.equal(fromProcess.model, "fixture-process");
  assert.equal(fromProcess.apiKey, "fixture-process-key");
  assert.equal(fromProcess.cacheHours, 48, "unset process values still come from the file");
});

test("OMNI_PART_MINUTES is inert, matching the released beta", () => {
  const { appRoot } = betaCopy();
  fs.writeFileSync(
    path.join(appRoot, ".env"),
    fs.readFileSync(path.join(fixtures, "config", "legacy-minutes.env.txt"), "utf8"),
  );
  const config = loadStandaloneConfig({ appRoot, env: {} });
  assert.equal(config.maxFrames, 2400, "the split is driven by frames, not minutes");
});

test("missing key is a readable config state, never a silent zero", () => {
  const { appRoot } = betaCopy();
  fs.writeFileSync(path.join(appRoot, ".env"), fs.readFileSync(path.join(fixtures, "config", "missing-key.env.txt"), "utf8"));
  const config = loadStandaloneConfig({ appRoot, env: {} });
  assert.equal(config.apiKey, null);
  assert.equal(config.apiKeyPresent, false, "a missing key must be an explicit state");
  assert.equal(config.language, "en", "the rest of the file still applies");
});

test("unknown language and mode fall back exactly like the beta", () => {
  assert.equal(resolveLanguage("de", ["en", "pl"], "pl"), "pl");
  assert.equal(resolveLanguage("en", ["en", "pl"], "pl"), "en");
  assert.equal(resolveMode("teardown"), "teardown");
  assert.equal(resolveMode("anything-else"), "summary", "the product default is summary");
});

test("SSE frames match the frozen beta contract structurally", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(fixtures, "sse", "single.events.json"), "utf8"));
  const wire = golden.map((frame) => sseFrame(frame.event, frame.data)).join("");
  assert.match(wire, /^event: stage\ndata: \{"step":"download"\}\n\n/);
  assert.equal(wire.endsWith("\n\n"), true);
  const parsed = wire
    .split("\n\n")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [eventLine, dataLine] = chunk.split("\n");
      return { event: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) };
    });
  assert.deepEqual(parsed, golden, "wire frames must round-trip to the golden events");
});

test("the local server serves i18n, video bytes with Range, and a frame", async (t) => {
  const { appRoot, dataDir } = betaCopy();
  fs.writeFileSync(path.join(appRoot, ".env"), fs.readFileSync(path.join(fixtures, "config", "default.env.txt"), "utf8"));
  const app = createStandaloneServer({
    appRoot,
    dataDir,
    env: { OMNIWATCH_DATA_DIR: dataDir },
    port: 0,
  });
  let address;
  try {
    address = await app.listen();
  } catch (error) {
    // Some sandboxes forbid binding a socket. Report the limitation instead of
    // pretending the HTTP contract was verified.
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip(`binding a local socket is not permitted in this environment (${error.code})`);
      return;
    }
    throw error;
  }
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const i18n = await fetch(`${base}/i18n.json`);
    assert.equal(i18n.status, 200);

    const full = await fetch(`${base}/video/SYNTHETIC01.mp4`);
    assert.equal(full.status, 200);
    const bytes = Buffer.from(await full.arrayBuffer());
    assert.ok(bytes.length > 1000, "the fixture video must be served whole");
    assert.equal(bytes.subarray(4, 8).toString(), "ftyp", "a real MP4 container, not a renamed text file");

    const ranged = await fetch(`${base}/video/SYNTHETIC01.mp4`, { headers: { Range: "bytes=0-99" } });
    assert.equal(ranged.status, 206);
    assert.match(ranged.headers.get("content-range") ?? "", /^bytes 0-99\//);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);

    const frame = await fetch(`${base}/frame/SYNTHETIC01/3.jpg`);
    assert.equal(frame.status, 200);
    const frameBytes = Buffer.from(await frame.arrayBuffer());
    assert.equal(frameBytes.subarray(0, 2).toString("hex"), "ffd8", "JPEG magic");

    const traversal = await fetch(`${base}/video/..%2f..%2fetc%2fpasswd.mp4`);
    assert.ok(traversal.status >= 400, "path traversal must be refused");
  } finally {
    await app.close();
  }
});

test("the beta installation is untouched by serving and migration", () => {
  const { appRoot, dataDir } = betaCopy();
  const digest = (dir) => {
    const out = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(`${path.relative(dir, full)}:${sha256(fs.readFileSync(full))}`);
      }
    };
    walk(dir);
    return out;
  };
  const before = digest(appRoot);
  migrateLegacyData({ appRoot, dataDir, nowSeconds: NOW_SECONDS, cacheHours: 48 });
  readAnalysisCompat({ appRoot, dataDir, id: "SYNTHETIC01" });
  readLegacyUploads(appRoot, "SYNTHETIC01", { nowSeconds: NOW_SECONDS, cacheHours: 48 });
  assert.deepEqual(digest(appRoot), before, "reading and migrating must not modify the beta installation");
});

/**
 * T17 gap closed: QA (E-tests, section 3/4, item 3) found no "no Node" scenario
 * for the beta migration/launcher path.
 *
 * The migration functions in this file (`migrateLegacyData` and friends) run
 * *inside* Node, so they cannot observe their own runtime missing — by the time
 * JS executes, Node is present by definition. The place a "no Node" failure is
 * actually reachable is one layer out: `agent-os-module/install.sh`, the shell
 * launcher a user (or Hermes) runs to trigger the Agent OS install/migration,
 * which `exec`s `node scripts/release/install.mjs ...` (install.mjs then calls
 * `migrateLegacyData`'s Agent OS counterpart). That script does its own
 * `command -v "$NODE_BIN"` preflight before touching anything, so this test
 * exercises the real launcher, not a re-implementation of it.
 *
 * Note the installer's own `--required-tools` check inside `install.mjs`
 * (`findExecutable`, scripts/release/install.mjs) special-cases `"node"` to
 * always return `process.execPath` — i.e. once inside the Node installer,
 * "node is missing" can never be detected. `install.sh`'s `command -v` guard is
 * therefore the *only* place this product actually detects a missing Node, and
 * it must run, and must refuse, before `install.mjs` (and thus any beta
 * migration or data write) is ever invoked.
 */
test("T17: install.sh refuses cleanly when Node is not on PATH, before any migration or install runs", () => {
  const installSh = path.join(repo, "agent-os-module", "install.sh");
  assert.ok(fs.existsSync(installSh), "the beta/Agent OS launcher must exist");

  const { appRoot, dataDir } = betaCopy();
  const digest = (dir) => {
    const out = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(`${path.relative(dir, full)}:${sha256(fs.readFileSync(full))}`);
      }
    };
    walk(dir);
    return out;
  };
  const before = digest(appRoot);

  // A PATH with no `node` (and no other executables) on it: `command -v node`
  // must fail the same way it would on a host where Node was never installed.
  const emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwatch-no-node-path-"));
  const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "/usr/bin/bash";
  // Real coreutils (dirname, cd, ...) so the script gets past its own plumbing, but
  // no directory that could contain a `node` binary — this must look like a host
  // that genuinely never had Node installed, not an empty PATH the script would
  // fail on for unrelated reasons.
  const strippedPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", emptyPathDir].join(":");
  const result = spawnSync(bash, [installSh, appRoot], {
    encoding: "utf8",
    env: { PATH: strippedPath, HOME: process.env.HOME ?? emptyPathDir },
  });

  assert.notEqual(result.status, 0, "the launcher must not exit 0 when Node cannot be found");
  assert.match(result.stderr, /brak Node w PATH/i, "a readable, specific error, not a stack trace or silence");
  assert.match(result.stderr, /OMNIWATCH_NODE/, "the error tells the user how to point at Node explicitly");
  assert.equal(result.stdout.trim(), "", "nothing that looks like install progress reaches stdout");

  assert.deepEqual(digest(appRoot), before, "beta data is untouched: the launcher stopped before install.mjs ran");
  assert.ok(!fs.existsSync(path.join(appRoot, "omniwatch")), "no release directory was created");

  // Pointing OMNIWATCH_NODE at a binary that does not exist must fail the same
  // readable way, not with a raw ENOENT from `exec`.
  const missingNodeBin = path.join(emptyPathDir, "not-a-real-node");
  const withOverride = spawnSync(bash, [installSh, appRoot], {
    encoding: "utf8",
    env: { PATH: strippedPath, HOME: process.env.HOME ?? emptyPathDir, OMNIWATCH_NODE: missingNodeBin },
  });
  assert.notEqual(withOverride.status, 0);
  assert.match(withOverride.stderr, /brak Node w PATH/i);
  assert.deepEqual(digest(appRoot), before, "an invalid OMNIWATCH_NODE override still leaves beta data untouched");
});

test("QA R2 L6: unrelated work directories under .cache are not counted as cached films", () => {
  const { appRoot } = betaCopy();
  fs.mkdirSync(path.join(appRoot, ".cache", "outer-loop"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, ".cache", "outer-loop", "b1-report.md"), "render notes\n");
  fs.writeFileSync(path.join(appRoot, ".cache", "b2-report.md"), "a file, not a film\n");
  const index = buildLegacyIndex(appRoot, { nowSeconds: NOW_SECONDS });
  assert.deepEqual(index.entries.map((entry) => entry.legacyId).sort(), ["SYNTHETIC01", "ade4dd11a0580e69"]);
  assert.equal(index.counts.cacheEntries, 2);
});

test("QA R2 M1: the beta CLI honours OMNIWATCH_APP_ROOT like the server and config do", async () => {
  const { root, appRoot } = betaCopy();
  let err = "";
  const noKey = await runStandaloneCli(["https://youtu.be/SYNTHETIC01"], {
    env: { OMNIWATCH_APP_ROOT: appRoot },
    stdout: () => {},
    stderr: (text) => { err += text; },
  });
  assert.equal(noKey, 3);
  assert.ok(err.includes(path.join(appRoot, ".env")), `the key is looked up in ${appRoot}/.env, got: ${err}`);

  // With the key in that .env, the runtime is started on that app's data directory.
  fs.writeFileSync(path.join(appRoot, ".env"), "DASHSCOPE_API_KEY=fixture-not-a-secret\n");
  const spawned = [];
  const code = await runStandaloneCli(["https://youtu.be/SYNTHETIC01", "-q", "co pokazuje ekran"], {
    env: { OMNIWATCH_APP_ROOT: appRoot },
    stdout: () => {},
    stderr: () => {},
    spawnImpl: (command, args) => {
      spawned.push(args);
      const child = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.equal(code, 0);
  const args = spawned[0];
  assert.equal(args[args.indexOf("--data-dir") + 1], path.join(appRoot, "data"));
  assert.equal(args[args.indexOf("--config") + 1], path.join(appRoot, "data", "runtime-config.json"));
  assert.ok(fs.existsSync(path.join(appRoot, "data", "runtime-config.json")));
  assert.ok(!fs.existsSync(path.join(repo, "apps", "standalone", "data")), "nothing written next to the checkout");
  void root;
  assert.deepEqual(mapLegacyArgs(["u", "-q", "x"]).args, ["analyze", "u", "--question", "x"]);
});

test("QA R2 L7: launchers accept only the tested Node lines (22 from 22.22.3, and 24)", () => {
  for (const version of ["22.22.3", "22.23.0", "24.0.0", "24.9.1", "v24.1.0"]) {
    assert.equal(nodeVersionSupported(version), true, version);
  }
  for (const version of ["22.22.2", "20.19.0", "23.0.0", "23.11.1", "25.0.0", "26.1.0", "garbage"]) {
    assert.equal(nodeVersionSupported(version), false, version);
  }
  // The Python launchers apply the same bounds before they exec Node.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniwatch-node-"));
  for (const [name, version] of [["node23", "v23.4.0"], ["node25", "v25.0.0"], ["node20", "v20.19.0"]]) {
    const fake = path.join(dir, name);
    fs.writeFileSync(fake, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    for (const launcher of ["app.py", "omniwatch.py"]) {
      const result = spawnSync("python3", [path.join(repo, "apps/standalone", launcher), "https://youtu.be/x"], {
        encoding: "utf8",
        env: { ...process.env, OMNIWATCH_NODE: fake },
      });
      assert.equal(result.status, 4, `${launcher} with Node ${version}: ${result.stderr}`);
      assert.match(result.stderr, />=22\.22\.3 <23 \|\| >=24\.0\.0 <25/);
    }
  }
});
