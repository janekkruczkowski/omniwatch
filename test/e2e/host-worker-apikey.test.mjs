/**
 * LF §7: the Agent OS host resolves its DashScope key asynchronously
 * (`@/lib/omniwatch` `apiKey(): Promise<string | null>` - env, then the Hermes
 * profile `.env`, then `~/.agentic-os/config.json`). The shared provider's
 * `ConfigPort.apiKey()` is synchronous. When `DASHSCOPE_API_KEY` is not in the
 * worker's environment, the host worker used to hand the provider that Promise:
 * the call then went out as `Authorization: Bearer [object Promise]` (or crashed on
 * `key.trim`) and the key from the host config was never used.
 *
 * This runs the real worker launcher against a synthetic host tree (no Agent OS
 * checkout needed) and a local stub of the provider endpoint - no paid call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enqueueAnalysis } from "../../packages/omniwatch/src/runtime/queue.ts";
import { openSqliteStore } from "../../packages/omniwatch/src/storage/index.ts";
import { parseSourceUrl } from "../../packages/omniwatch/src/sources/url.ts";
import { ANALYSIS_VERSION } from "../../packages/omniwatch/src/contracts/types.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = path.join(repo, "agent-os-module/omniwatch-host-worker.mjs");
const corePath = path.join(repo, "packages/omniwatch/src/index.ts");

const HOST_KEY = "sk-from-host-config-0123456789";

function syntheticHost(dir) {
  const src = path.join(dir, "host-src");
  fs.mkdirSync(path.join(src, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "lib/config.ts"),
    `export const config = { omniwatch: { model: "qwen3.8-omni-flash", language: "pl" } };\n`,
  );
  // The host engine surface the worker uses. `apiKey` is async, exactly like the host.
  fs.writeFileSync(
    path.join(src, "lib/omniwatch.ts"),
    `import { appendFileSync } from "node:fs";
export async function apiKey(): Promise<string | null> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return ${JSON.stringify(HOST_KEY)};
}
export async function fetchVideo(url: string) {
  return { info: { title: "Fixture", duration: 20, extractor: "youtube", channel: "c" }, src: process.env.FIXTURE_VIDEO as string };
}
export async function run(cmd: string, args: string[]): Promise<string> {
  throw new Error("no tool calls expected in this test: " + cmd);
}
export async function upload(localPath: string, key: unknown, options?: unknown) {
  appendFileSync(process.env.FIXTURE_UPLOAD_LOG as string, JSON.stringify({ keyType: typeof key, key: typeof key === "string" ? key : String(key) }) + "\\n");
  return { url: "oss://fixture/part_0.mp4" };
}
`,
  );
  return src;
}

function stubProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ url: req.url, authorization: req.headers.authorization ?? null });
      if (req.headers.authorization !== `Bearer ${HOST_KEY}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      frame({ choices: [{ delta: { content: "[0:05] Wstep. Film pokazuje fixture." }, finish_reason: null }] });
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
      frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

function runLauncher(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("LF §7: the host worker resolves the host's async API key before the provider uses it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-host-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hostSrc = syntheticHost(dir);
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault);
  const hostConfig = path.join(dir, "config.json");
  fs.writeFileSync(hostConfig, JSON.stringify({ vaultRoot: vault }));
  const video = path.join(dir, "fixture.mp4");
  fs.writeFileSync(video, Buffer.alloc(64));
  const uploadLog = path.join(dir, "uploads.jsonl");
  fs.writeFileSync(uploadLog, "");

  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir);
  const store = openSqliteStore({ path: path.join(dataDir, "state.sqlite") });
  let operationId;
  try {
    const sourceRef = parseSourceUrl("https://www.youtube.com/watch?v=Xu0JinVn_Fg");
    ({ operation: { id: operationId } } = enqueueAnalysis({
      store,
      request: { sourceRef, mode: "summary", language: "pl", analysisVersion: ANALYSIS_VERSION },
    }));
  } finally {
    store.close();
  }

  const provider = await stubProvider();
  t.after(() => provider.server.close());

  const env = { ...process.env };
  // The key is NOT in the environment: only the host's async resolver knows it.
  delete env.DASHSCOPE_API_KEY;
  Object.assign(env, {
    OMNIWATCH_HOST_SRC: hostSrc,
    OMNIWATCH_OVERLAY_SRC: path.join(repo, "agent-os-module/src"),
    OMNIWATCH_CORE: corePath,
    AGENTIC_OS_CONFIG: hostConfig,
    AGENTIC_OS_VAULT: vault,
    DASHSCOPE_API: `http://127.0.0.1:${provider.port}/v1`,
    FIXTURE_VIDEO: video,
    FIXTURE_UPLOAD_LOG: uploadLog,
    HOME: dir,
    HERMES_HOME: path.join(dir, "no-hermes"),
  });

  const result = await runLauncher(["--data-dir", dataDir, "--operation", operationId, "--max", "1"], env);
  assert.equal(result.status, 0, `worker failed:\n${result.stderr}\n${result.stdout}`);

  const after = openSqliteStore({ path: path.join(dataDir, "state.sqlite") });
  let operation;
  try {
    operation = after.getOperation(operationId);
  } finally {
    after.close();
  }
  const why = `${operation?.state} ${operation?.errorClass ?? ""}: ${operation?.errorMessage ?? ""}`;

  assert.equal(provider.seen.length, 1, `exactly one model call (${why})`);
  assert.equal(provider.seen[0].authorization, `Bearer ${HOST_KEY}`, "the provider must authenticate with the resolved key, not a Promise");
  const uploads = fs.readFileSync(uploadLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(uploads.length >= 1, "the media part was uploaded");
  for (const upload of uploads) {
    assert.equal(upload.keyType, "string");
    assert.equal(upload.key, HOST_KEY);
  }
  assert.equal(operation?.state, "delivered", why);
});
