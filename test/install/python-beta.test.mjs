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
import { createStandaloneServer, sseFrame } from "../../apps/standalone/server.mjs";
import { evaluateUploadFreshness } from "../../packages/omniwatch/src/sources/legacy.ts";

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

test("oss.json timestamps are seconds: 47 h is stale at the beta default, fresh at a 48 h TTL", () => {
  const { appRoot } = betaCopy();
  const at = NOW_SECONDS - 47 * 3600;

  // The audit keeps the oss variants as separate fixture files; place the expired
  // one where the beta itself stored it.
  fs.copyFileSync(
    path.join(fixtures, "oss", "expired.json"),
    path.join(appRoot, ".cache", "SYNTHETIC01", "oss.json"),
  );
  const betaDefault = readLegacyUploads(appRoot, "SYNTHETIC01", { nowSeconds: NOW_SECONDS, cacheHours: 47 });
  const entry = betaDefault.entries.find((item) => item.name === "source.mp4");
  assert.equal(entry.freshness.valid, false, "the beta's own 47 h TTL treats 47 h as expired");

  assert.equal(evaluateUploadFreshness({ at }, 48, NOW_SECONDS).valid, true, "a configured 48 h TTL keeps a 47 h entry");
  assert.equal(evaluateUploadFreshness({ at }, 47, NOW_SECONDS).valid, false);

  fs.copyFileSync(
    path.join(fixtures, "oss", "fresh.json"),
    path.join(appRoot, ".cache", "SYNTHETIC01", "oss.json"),
  );
  const fresh = readLegacyUploads(appRoot, "SYNTHETIC01", { nowSeconds: NOW_SECONDS, cacheHours: 48 });
  assert.equal(fresh.entries.find((item) => item.name === "source.mp4").freshness.valid, true);

  fs.copyFileSync(
    path.join(fixtures, "oss", "future.json"),
    path.join(appRoot, ".cache", "SYNTHETIC01", "oss.json"),
  );
  const future = readLegacyUploads(appRoot, "SYNTHETIC01", { nowSeconds: NOW_SECONDS, cacheHours: 48 });
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
