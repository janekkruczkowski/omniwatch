/**
 * T01 — input validation and CLI contract (T3).
 *
 * A rejected input must never start a process, a download or a paid call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OmniWatchError } from "../src/contracts/errors.ts";
import { createSourceRegistry } from "../src/sources/registry.ts";
import { parseArgs, runCli, EXIT_CODES } from "../src/runtime/cli.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repo, "packages/omniwatch/src/runtime/cli.ts");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omniwatch-input-"));
}

/** A source registry with counting adapters: any use of the media tool is recorded. */
function countingSource() {
  const calls = [];
  const source = createSourceRegistry({
    media: {
      cached: async () => null,
      fetch: async (request) => {
        calls.push(request);
        return { localPath: "/tmp/never.mp4", title: "x", channel: null, durationSeconds: 10, extractor: "stub" };
      },
      slice: async (request) => {
        calls.push(request);
        return `${request.localPath}#${request.index}`;
      },
    },
  });
  return { source, calls };
}

test("every supported platform resolves to a stable source ref", async () => {
  const { source } = countingSource();
  const cases = [
    ["https://www.youtube.com/watch?v=SYNTHETIC01", "youtube", "SYNTHETIC01"],
    ["https://youtube.com/shorts/SYNTHETIC01", "youtube", "SYNTHETIC01"],
    ["https://youtu.be/SYNTHETIC01", "youtube", "SYNTHETIC01"],
    ["https://www.tiktok.com/@creator/video/123", "tiktok", null],
    ["https://www.instagram.com/reel/ABC123/", "instagram", null],
    ["https://x.com/creator/status/123", "x", null],
    ["https://example.test/video/alpha", "generic", null],
  ];
  for (const [url, platform, sourceId] of cases) {
    const ref = await source.resolve({ url });
    assert.equal(ref.platform, platform, url);
    if (sourceId) assert.equal(ref.sourceId, sourceId, url);
    assert.ok(ref.canonicalUrl.startsWith("http"), url);
  }
});

test("non-YouTube identities keep the released beta hash", async () => {
  const { source } = countingSource();
  const a = await source.resolve({ url: "https://example.test/video/alpha" });
  const b = await source.resolve({ url: "https://example.test/video/alpha?x=1" });
  const c = await source.resolve({ url: "https://example.test/video/alpha#clip" });
  assert.equal(a.legacyId, "ade4dd11a0580e69");
  assert.equal(b.legacyId, "ade4dd11a0580e69");
  assert.equal(c.legacyId, "ade4dd11a0580e69");
});

test("rejected inputs throw invalid_input and touch no media tool", async () => {
  const { source, calls } = countingSource();
  const bad = [
    "",
    "not a url",
    "file:///etc/passwd",
    "ftp://example.test/x",
    "http://127.0.0.1:9999/x",
    "http://localhost/x",
    "http://10.0.0.5/x",
    "http://169.254.169.254/latest/meta-data",
    `https://example.test/${"a".repeat(4000)}`,
    "https://example.test/../../etc/passwd",
  ];
  for (const url of bad) {
    await assert.rejects(
      () => source.resolve({ url }),
      (error) => error instanceof OmniWatchError && error.errorClass === "invalid_input",
      `expected rejection for ${JSON.stringify(url)}`,
    );
  }
  assert.equal(calls.length, 0, "a rejected input must not reach the media tool");
});

test("CLI argument parsing keeps Unicode and spaces in one argument", () => {
  const parsed = parseArgs([
    "analyze",
    "https://youtu.be/SYNTHETIC01",
    "--question",
    "Zażółć gęślą jaźń",
    "--lang",
    "pl",
  ]);
  assert.equal(parsed.command, "analyze");
  assert.equal(parsed.positionals[0], "https://youtu.be/SYNTHETIC01");
  assert.equal(parsed.flags.get("question"), "Zażółć gęślą jaźń");
  assert.equal(parsed.flags.get("lang"), "pl");
});

test("conflicting mode flags and missing flag values are invalid input", () => {
  assert.throws(() => parseArgs(["analyze", "u", "--summary", "--teardown"]), /jeden tryb/);
  assert.throws(() => parseArgs(["analyze", "u", "--focus"]), /wymaga wartosci/);
});

test("CLI reports invalid input with exit code 2 before any paid work", () => {
  const result = spawnSync(process.execPath, [cli, "analyze", "http://127.0.0.1:9999/x", "--json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, EXIT_CODES.invalid_input);
  assert.match(result.stderr, /invalid_input/);
});

test("CLI without a URL is invalid input and prints no result", () => {
  const result = spawnSync(process.execPath, [cli, "analyze", "--json"], { encoding: "utf8" });
  assert.equal(result.status, EXIT_CODES.invalid_input);
  assert.equal(result.stdout.trim(), "");
});

test("missing configuration is reported before a download or a model call", () => {
  const dir = tempDir();
  const result = spawnSync(
    process.execPath,
    [cli, "analyze", "https://youtu.be/SYNTHETIC01", "--data-dir", path.join(dir, "data")],
    { encoding: "utf8", env: { ...process.env, OMNIWATCH_CONFIG: path.join(dir, "missing.json") } },
  );
  assert.equal(result.status, EXIT_CODES.missing_config);
  assert.match(result.stderr, /missing_config/);
});

test("unknown command is invalid input instead of a silent success", async () => {
  const error = await runCli(["frobnicate"], { stdout: () => {}, stderr: () => {}, env: process.env }).catch(
    (caught) => caught,
  );
  assert.ok(error instanceof OmniWatchError, "unknown command throws instead of exiting 0");
  assert.equal(error.errorClass, "invalid_input");
});

test("--help exits 0 and documents the shared commands", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, EXIT_CODES.ok);
  for (const command of ["analyze", "worker", "status", "report", "pause", "cancel"]) {
    assert.match(result.stdout, new RegExp(command));
  }
});

/**
 * T01 gap closed: QA (E-tests, section 3/4, item 1) found no test for a symlink
 * pointing outside the allowed directory for local input.
 *
 * `parseSourceUrl` (packages/omniwatch/src/sources/url.ts) is the only T01 entry
 * point and it accepts nothing but `http:`/`https:` — every other scheme (`file:`,
 * a bare filesystem path, a UNC path) is rejected before `new URL()` even
 * succeeds, or rejected on the protocol check right after. There is no code path
 * anywhere in `packages/omniwatch/src` or `agent-os-module/src` that opens a
 * locally supplied video file, so "a symlink pointing outside the allowed
 * directory for local input" has no directory to escape from: OmniWatch has no
 * local-file input feature to begin with (grep for `formData`/`multipart`/
 * `filePath` under those trees turns up only the unrelated teardown-asset upload
 * route, `agent-os-module/src/app/api/omniwatch/assets/route.ts`, which is not on
 * the T01 analyze path and never resolves a symlink either — it stores the
 * uploaded bytes under a generated name).
 *
 * This test is therefore the documented substitute the task asked for: it proves
 * that a symlink-shaped or otherwise local-looking path, in every form a person
 * could paste it (a bare filesystem path, a `file:` URL, a UNC share, a
 * `file:` URL whose path resolves through `..` the way a symlink escape would),
 * is rejected as `invalid_input` before the media tool is ever touched — i.e. the
 * same guarantee a "symlink escape" test would need, given there is no local
 * filesystem input surface to attach a symlink to.
 */
test("T01: symlink-shaped and local-file-scheme input never reaches the media tool", async () => {
  const { source, calls } = countingSource();
  const dir = tempDir();
  const outside = path.join(dir, "outside", "secret.mp4");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, "not a real video");
  const allowed = path.join(dir, "allowed");
  fs.mkdirSync(allowed, { recursive: true });
  const linkPath = path.join(allowed, "video.mp4");
  // Best-effort: symlink creation can be denied by policy on some hosts (notably
  // Windows without dev mode). The rejection below does not depend on the link
  // actually resolving — parseSourceUrl never touches the filesystem at all — so
  // the test still proves the contract when the symlink itself cannot be made.
  try {
    fs.symlinkSync(outside, linkPath);
  } catch {
    // fall through: linkPath stays a plain path string, still local-looking.
  }

  const bad = [
    linkPath,
    `file://${linkPath}`,
    `file://${outside}`,
    `file:///${allowed.replace(/\\/g, "/")}/../outside/secret.mp4`,
    "\\\\server\\share\\video.mp4",
    "/etc/passwd",
    "C:\\Users\\Public\\video.mp4",
  ];
  for (const url of bad) {
    await assert.rejects(
      () => source.resolve({ url }),
      (error) => error instanceof OmniWatchError && error.errorClass === "invalid_input",
      `expected rejection for ${JSON.stringify(url)}`,
    );
  }
  assert.equal(calls.length, 0, "a local/symlink-shaped input must not reach the media tool");
});
