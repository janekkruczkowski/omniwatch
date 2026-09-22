#!/usr/bin/env node
/**
 * Standalone HTTP/SSE adapter (T7 / D2).
 *
 * Preserves the released beta interface - `GET /`, `GET /i18n.json`,
 * `GET /api/watch?url&q&lang&mode`, `GET /video/{vid}.mp4`,
 * `GET /frame/{vid}/{sec}.jpg` - while the actual analysis runs on the shared
 * runtime (engine, prompts, store, delivery). This file owns the local media
 * adapter, the SSE serialization and the HTTP surface; it implements no analysis
 * logic of its own.
 *
 * The transport keeps the legacy `q`/`mode`/`lang` inputs and adds the conversation
 * identity (`conversation`, `parent`) that a bare URL cannot express. The SSE core is
 * the frozen beta contract (`stage`, `meta`, `parts`, `uploaded`, `answer.text`,
 * `done`, `error`); `turn` is an additive event the old frontend ignores.
 *
 * The server binds loopback only and validates Host/Origin before any state-changing
 * request (starting a paid analysis).
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOpenAiModelPort } from "../../packages/omniwatch/src/analysis/index.ts";
import { OmniWatchError } from "../../packages/omniwatch/src/contracts/errors.ts";
import { ANALYSIS_VERSION } from "../../packages/omniwatch/src/contracts/types.ts";
import { createRuntimeWiring } from "../../packages/omniwatch/src/runtime/poc.ts";
import { enqueueAnalysis } from "../../packages/omniwatch/src/runtime/queue.ts";
import { OperationJournal } from "../../packages/omniwatch/src/storage/operations.ts";
import { runOperation } from "../../packages/omniwatch/src/runtime/worker.ts";
import { createSourceRegistry } from "../../packages/omniwatch/src/sources/registry.ts";
import { fpsFor, formatDuration, strip } from "../../packages/omniwatch/src/sources/media.ts";
import { parseSourceUrl } from "../../packages/omniwatch/src/sources/url.ts";

import {
  loadStandaloneConfig,
  resolveLanguage,
  resolveMode,
  runtimeConfigDocument,
  writeRuntimeConfigFile,
} from "./config.mjs";
import {
  assertSafeLegacyId,
  evaluateUploadFreshness,
  legacyCacheDirsFor,
  migrateLegacyData,
} from "./legacy.mjs";

export const DEFAULT_HOST = "127.0.0.1";
/** Beta pricing for qwen3.8-omni-flash; the standalone is the host that owns pricing. */
export const PRICE_PER_INPUT_TOKEN = 0.15 / 1e6;
export const PRICE_PER_OUTPUT_TOKEN = 0.47 / 1e6;

/* ------------------------------------------------------------------- SSE ---- */

/** The frozen wire shape: `event: <name>\ndata: <JSON>\n\n`. */
export function sseFrame(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  };
}

/* ----------------------------------------------------------- HTTP helpers ---- */

/** `bytes=0-15` -> `{start:0,end:15}`; `null` when absent; `"invalid"` when unusable. */
export function parseRange(header, size) {
  if (typeof header !== "string" || header.trim() === "") return null;
  const match = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";
  if (rawStart === "") {
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return "invalid";
    const start = Math.max(0, size - length);
    return { start, end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

function isLoopbackHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * State-changing requests must come from the local UI: the Host header has to be a
 * loopback name and, when a browser sends Origin, it must be loopback too. This is
 * what stops a random page from spending the user's key through the local port.
 */
export function validateLocalRequest(req, options = {}) {
  const expectedPort = options.port;
  const host = req.headers.host;
  if (typeof host !== "string" || host.trim() === "") {
    return { ok: false, reason: "Brak naglowka Host." };
  }
  const [hostname, rawPort] = host.split(":");
  if (!isLoopbackHostname(hostname)) {
    return { ok: false, reason: `Host ${host} nie jest lokalny.` };
  }
  if (expectedPort !== undefined && rawPort !== undefined && Number(rawPort) !== Number(expectedPort)) {
    return { ok: false, reason: `Host ${host} nie nalezy do tego serwera.` };
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.trim() !== "" && origin !== "null") {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return { ok: false, reason: `Niepoprawny naglowek Origin: ${origin}` };
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      return { ok: false, reason: `Origin ${origin} nie jest lokalny.` };
    }
  }
  return { ok: true, reason: "" };
}

/* --------------------------------------------------- standalone media tool ---- */

function runTool(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} zakonczyl sie kodem ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Local media tooling for the standalone app: yt-dlp download, ffmpeg slicing, the
 * beta's `oss.json` upload cache and read-only access to beta cache directories.
 *
 * New artifacts land under `<dataDir>/cache/<id>`; a beta `.cache/<id>` directory is
 * read but never written, so a rollback to the old release keeps working.
 */
export function createStandaloneMediaTool(options) {
  const cacheDir = path.resolve(options.cacheDir);
  const legacyAppRoot = options.legacyAppRoot ? path.resolve(options.legacyAppRoot) : null;
  const cacheHours = () => options.cacheHours?.() ?? 48;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const run = options.runTool ?? runTool;

  const dirFor = (id) => path.join(cacheDir, assertSafeLegacyId(id));

  function legacyDirs(id) {
    if (!legacyAppRoot) return [];
    return legacyCacheDirsFor(legacyAppRoot, id);
  }

  function findArtifact(id, name) {
    const fresh = path.join(dirFor(id), name);
    if (existsSync(fresh)) return fresh;
    for (const dir of legacyDirs(id)) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  function readInfoFile(id) {
    const candidates = [path.join(dirFor(id), "info.json")];
    for (const dir of legacyDirs(id)) candidates.push(path.join(dir, "info.json"));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        return JSON.parse(readFileSync(candidate, "utf8"));
      } catch {
        // A damaged info.json must not hide a working film; fall through.
      }
    }
    return null;
  }

  function preparedFrom(id, info, localPath) {
    const channel = info?.channel ?? info?.uploader ?? null;
    return {
      localPath,
      title: info?.title ?? id,
      channel,
      durationSeconds: typeof info?.duration === "number" ? info.duration : Number(info?.duration) || 0,
      extractor: info?.extractor_key ?? info?.extractor ?? "generic",
      publishedAt: info?.upload_date ?? null,
    };
  }

  return {
    cacheDir,
    dirFor,
    findArtifact,
    readInfoFile,

    async cached(source) {
      const id = source.legacyId ?? source.sourceId;
      const localPath = findArtifact(id, "source.mp4");
      if (!localPath) return null;
      return preparedFrom(id, readInfoFile(id), localPath);
    },

    async fetch(source) {
      const id = source.legacyId ?? source.sourceId;
      const dir = dirFor(id);
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, "source.mp4");
      const meta = await run("yt-dlp", ["-J", "--no-playlist", source.canonicalUrl]);
      const parsed = JSON.parse(meta.stdout);
      const info = {
        title: parsed.title ?? id,
        channel: parsed.channel ?? null,
        uploader: parsed.uploader ?? null,
        duration: parsed.duration ?? 0,
        extractor_key: parsed.extractor_key ?? "generic",
      };
      if (!existsSync(target)) {
        await run("yt-dlp", [
          "--no-playlist",
          "-q",
          "--no-warnings",
          "-N",
          "8",
          "-S",
          "res:480",
          "-f",
          "bv*+ba/b",
          "--merge-output-format",
          "mp4",
          "-o",
          target,
          source.canonicalUrl,
        ]);
      }
      writeFileSync(path.join(dir, "info.json"), JSON.stringify(info), "utf8");
      return preparedFrom(id, info, target);
    },

    async probeDuration(localPath) {
      const probe = await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        localPath,
      ]);
      const seconds = Number(probe.stdout.trim());
      return Number.isFinite(seconds) ? seconds : 0;
    },

    async readUploads(source) {
      const id = source.legacyId ?? source.sourceId;
      const file = findArtifact(id, "oss.json");
      if (!file) return null;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async slice(request) {
      const id = request.localPath.includes(path.sep)
        ? path.basename(path.dirname(request.localPath))
        : request.localPath;
      const dir = dirFor(id);
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `part_${request.count}_${request.index}.mp4`);
      if (!existsSync(target)) {
        await run("ffmpeg", [
          "-y",
          "-loglevel",
          "error",
          "-ss",
          String(request.startSeconds),
          "-t",
          String(Math.max(0, request.endSeconds - request.startSeconds)),
          "-i",
          request.localPath,
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          target,
        ]);
      }
      return target;
    },

    /**
     * Upload one part to Model Studio storage, reusing a fresh `oss.json` entry. The
     * material id comes from the part's own directory (`<cacheDir>/<id>/part_*.mp4`),
     * so the caller does not have to thread a `SourceRef` through the model port.
     */
    async uploadPart(part, config) {
      const id = assertSafeLegacyId(path.basename(path.dirname(part.localPath)));
      const dir = dirFor(id);
      mkdirSync(dir, { recursive: true });
      const metaFile = path.join(dir, "oss.json");
      let known = {};
      try {
        known = JSON.parse(readFileSync(metaFile, "utf8"));
      } catch {
        known = {};
      }
      const name = path.basename(part.localPath);
      const verdict = evaluateUploadFreshness(known?.[name] ?? null, cacheHours(), nowSeconds());
      if (verdict.valid && typeof known[name]?.url === "string") {
        return { url: known[name].url, reused: true };
      }
      const apiBase = (config.apiBaseUrl() ?? "").replace(/\/+$/, "");
      const key = config.apiKey();
      if (!key) throw new Error("Brak klucza modelu do uploadu materialu.");
      const policyResponse = await fetch(
        `${apiBase}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(config.modelName)}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      if (!policyResponse.ok) throw new Error(`Upload policy HTTP ${policyResponse.status}`);
      const policy = (await policyResponse.json()).data;
      const objectKey = `${policy.upload_dir}/${name}`;
      const body = new FormData();
      for (const [field, value] of Object.entries({
        OSSAccessKeyId: policy.oss_access_key_id,
        Signature: policy.signature,
        policy: policy.policy,
        "x-oss-object-acl": policy.x_oss_object_acl,
        "x-oss-forbid-overwrite": policy.x_oss_forbid_overwrite,
        key: objectKey,
        success_action_status: "200",
      })) {
        body.append(field, String(value));
      }
      body.append("file", new Blob([readFileSync(part.localPath)]), name);
      const uploadResponse = await fetch(policy.upload_host, { method: "POST", body });
      if (!uploadResponse.ok) throw new Error(`Upload HTTP ${uploadResponse.status}`);
      const url = `oss://${objectKey}`;
      known[name] = { url, at: nowSeconds() };
      writeFileSync(metaFile, JSON.stringify(known), "utf8");
      return { url, reused: false };
    },
  };
}

/** The shared `SourcePort`, backed by the standalone media tool. */
export function createStandaloneSource(options) {
  const media = options.media ?? createStandaloneMediaTool(options);
  return createSourceRegistry({
    media,
    cacheHours: () => options.cacheHours?.() ?? 48,
    now: options.nowSeconds,
    defaultCacheHours: 48,
  });
}

/* ------------------------------------------------------------- SSE pipeline ---- */

/**
 * Map the shared runtime's progress to the beta's SSE stages. The engine emits
 * `prepare`, `split`, `call`, `part_done`, `merge`; the beta's UI knows
 * `download`, `upload`, `watch`, `answer`.
 */
export function progressToEvent(event) {
  switch (event.stage) {
    case "call":
      return event.itemIndex === 0 || event.itemIndex === undefined ? { name: "stage", data: { step: "answer" } } : null;
    case "part_done":
      return { name: "part_done", data: { i: event.itemIndex ?? 0 } };
    case "merge":
      return { name: "merge", data: {} };
    default:
      return null;
  }
}

export function usagePayload(usage, parts, reused) {
  const payload = {
    in: usage?.inputTokens ?? 0,
    out: usage?.outputTokens ?? 0,
    parts,
    reused,
  };
  // Never present an unknown cost as zero: without a provider-reported price the
  // consumer shows "cost unknown" instead of a made-up bill.
  if (usage?.costKnown === true && typeof usage.costUsd === "number") {
    payload.costUsd = usage.costUsd;
    payload.costKnown = true;
  }
  return payload;
}

/**
 * Run one `/api/watch` request. `emit(name, data)` receives the beta-shaped events.
 * Everything below the transport is the shared runtime.
 */
export async function runWatchPipeline(options) {
  const { wiring, emit, request, config, analysisId } = options;
  emit("stage", { step: "download" });

  if (!config.apiKeyPresent) {
    throw new OmniWatchError(
      "missing_config",
      "Brak klucza modelu: ustaw DASHSCOPE_API_KEY w pliku .env obok skryptow albo w srodowisku procesu.",
      { action: { label: "ustaw klucz API", kind: "fix_config" } },
    );
  }

  const sourceRef = await wiring.deps.source.resolve({ url: request.url });
  const info = await wiring.deps.source.prepare(sourceRef);
  const legacyId = sourceRef.legacyId ?? sourceRef.sourceId;
  emit("meta", {
    id: legacyId,
    title: info.title,
    channel: info.channel ?? "",
    duration: formatDuration(info.durationSeconds),
    seconds: info.durationSeconds,
    strip: strip(info.durationSeconds),
  });
  emit("stage", { step: "upload" });

  const parts = await wiring.deps.source.split(info, {
    maxFramesPerPart: wiring.deps.config.maxFramesPerPart(),
  });
  emit("parts", { n: parts.length, starts: parts.map((part) => part.startSeconds) });
  emit("uploaded", { reused: info.reusedUpload === true });
  emit("stage", { step: "watch", parts: parts.length, fps: fpsFor(info.durationSeconds) });

  const analysisRequest = {
    sourceRef,
    mode: request.mode,
    focus: null,
    question: request.question === "" ? null : request.question,
    language: request.language,
    analysisVersion: ANALYSIS_VERSION,
    conversationId: request.conversationId,
    parentTurnId: request.parentTurnId,
    force: false,
  };
  const enqueued = enqueueAnalysis({ store: wiring.store, request: analysisRequest });

  // A repeat of already-finished work shows the existing answer instead of paying for
  // a second analysis (the same rule the shared CLI applies).
  if (!enqueued.created && ["delivered", "result_ready"].includes(enqueued.operation.state)) {
    const existing = wiring.store.getBuffer(enqueued.operation.id)?.result ?? null;
    if (existing) {
      emit("answer.text", { text: existing.content });
      emit("turn", {
        conversationId: existing.conversationId,
        turnId: existing.turnId,
        parentTurnId: existing.parentTurnId ?? null,
        analysisId: existing.analysisId,
        reused: true,
      });
      emit("done", { text: existing.content, usage: usagePayload(existing.usage, existing.parts, true) });
      return { analysisId: existing.analysisId, operationId: enqueued.operation.id, reused: true };
    }
  }

  const token = `standalone_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (!wiring.store.acquireOwner(token, process.pid, new Date().toISOString())) {
    throw new OmniWatchError("runtime_unavailable", "Inny proces OmniWatch jest wlascicielem tego katalogu danych.", {
      action: { label: "poczekaj na proces roboczy", kind: "check_operation" },
    });
  }
  let summary;
  try {
    const journal = new OperationJournal({ store: wiring.store, ownerToken: token });
    summary = await runOperation(wiring.deps, journal, enqueued.operation.id, {
      onProgress: (event) => {
        const mapped = progressToEvent(event);
        if (mapped) emit(mapped.name, mapped.data);
      },
    });
  } finally {
    wiring.store.releaseOwner(token);
  }

  const buffer = wiring.store.getBuffer(enqueued.operation.id);
  const result = buffer?.result ?? null;
  if (summary.state !== "delivered" || !result) {
    throw new OmniWatchError(
      summary.errorClass ?? "runtime_unavailable",
      summary.message ?? "Analiza nie zakonczyla sie poprawnie.",
    );
  }

  emit("answer.text", { text: result.content });
  emit("turn", {
    conversationId: result.conversationId,
    turnId: result.turnId,
    parentTurnId: result.parentTurnId ?? null,
    analysisId: result.analysisId ?? analysisId ?? null,
  });
  emit("done", {
    text: result.content,
    usage: usagePayload(result.usage, result.parts, info.reusedUpload === true),
  });
  return { analysisId: result.analysisId, operationId: enqueued.operation.id };
}

/* ---------------------------------------------------------------- HTTP app ---- */

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** Locate one cached artifact: new data dir first, then the read-only beta cache. */
export function resolveMediaPath(context, vid, name) {
  const safe = assertSafeLegacyId(vid);
  const fresh = path.join(context.config.cacheDir, safe, name);
  if (existsSync(fresh)) return fresh;
  for (const dir of legacyCacheDirsFor(context.config.appRoot, safe)) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function serveFile(req, res, file, contentType) {
  const size = statSync(file).size;
  const range = parseRange(req.headers.range, size);
  if (range === "invalid") {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": length,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Accept-Ranges": "bytes",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

async function handleWatch(req, res, context, url) {
  const validation = validateLocalRequest(req, { port: context.port });
  if (!validation.ok) {
    sendJson(res, 403, { error: "forbidden", message: validation.reason });
    return;
  }
  const target = url.searchParams.get("url");
  if (target === null || target.trim() === "") {
    // The beta's FastAPI returned 422 for a missing `url`; the status is the contract.
    sendJson(res, 422, { error: "invalid_input", message: "Brak parametru url." });
    return;
  }

  const language = resolveLanguage(url.searchParams.get("lang"), context.availableLanguages, context.config.language);
  const mode = resolveMode(url.searchParams.get("mode"));
  const question = url.searchParams.get("q") ?? "";
  const conversationId = url.searchParams.get("conversation");
  const parentTurnId = url.searchParams.get("parent");

  res.writeHead(200, sseHeaders());
  const emit = (name, data) => {
    if (res.writableEnded) return;
    res.write(sseFrame(name, data));
  };

  try {
    if (context.runWatch) {
      await context.runWatch({
        emit,
        request: { url: target, question, language, mode, conversationId, parentTurnId },
      });
    } else {
      await context.defaultWatch({
        emit,
        request: { url: target, question, language, mode, conversationId, parentTurnId },
      });
    }
  } catch (error) {
    const errorClass = error?.errorClass ?? "runtime_unavailable";
    const message = String(error?.message ?? error).slice(0, 600);
    emit("error", { error: errorClass, message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

export async function handleRequest(req, res, context) {
  let url;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? DEFAULT_HOST}`);
  } catch {
    sendJson(res, 400, { error: "invalid_input", message: "Niepoprawny adres zadania." });
    return;
  }
  const pathname = url.pathname;

  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname === "/") {
      const file = path.join(context.config.appRoot, "static", "index.html");
      if (!existsSync(file)) {
        sendText(res, 404, "Brak pliku static/index.html.\n");
        return;
      }
      sendText(res, 200, readFileSync(file, "utf8"), "text/html; charset=utf-8");
      return;
    }
    if (pathname === "/i18n.json") {
      const file = path.join(context.config.appRoot, "static", "i18n.json");
      if (!existsSync(file)) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(readFileSync(file));
      return;
    }
    if (pathname === "/api/watch") {
      await handleWatch(req, res, context, url);
      return;
    }
    const video = pathname.match(/^\/video\/([^/]+)\.mp4$/);
    if (video) {
      const file = resolveMediaPath(context, decodeURIComponent(video[1]), "source.mp4");
      if (!file) {
        sendJson(res, 404, { error: "not_found", message: "Brak materialu w cache." });
        return;
      }
      await serveFile(req, res, file, "video/mp4");
      return;
    }
    const frame = pathname.match(/^\/frame\/([^/]+)\/(\d+)\.jpg$/);
    if (frame) {
      const vid = decodeURIComponent(frame[1]);
      const sec = Number(frame[2]);
      const existing = resolveMediaPath(context, vid, path.join("frames", `${sec}.jpg`));
      if (existing) {
        await serveFile(req, res, existing, "image/jpeg");
        return;
      }
      sendJson(res, 404, { error: "not_found", message: `Brak klatki ${sec}s dla ${vid}.` });
      return;
    }
  }

  sendJson(res, 404, { error: "not_found", message: `Nieznana sciezka: ${pathname}` });
}

/** Load the languages the released `/i18n.json` exposes. */
export function availableLanguages(appRoot) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(appRoot, "static", "i18n.json"), "utf8"));
    return Object.keys(parsed);
  } catch {
    return ["en"];
  }
}

/**
 * Build the server. `options.source`/`options.model` are the injection points used by
 * the offline tests; production uses the standalone media tool and the shared
 * OpenAI-compatible provider.
 */
export function createStandaloneServer(options = {}) {
  const env = options.env ?? process.env;
  const appRoot = path.resolve(
    options.appRoot ?? env.OMNIWATCH_APP_ROOT ?? path.dirname(fileURLToPath(import.meta.url)),
  );
  const config = options.config ?? loadStandaloneConfig({ appRoot, env });
  const port = options.port ?? config.port;
  const host = options.host ?? DEFAULT_HOST;

  const context = {
    config,
    port,
    availableLanguages: availableLanguages(config.appRoot),
    runWatch: options.runWatch ?? null,
    defaultWatch: null,
  };

  function buildWiring() {
    const media =
      options.media ??
      createStandaloneMediaTool({
        cacheDir: config.cacheDir,
        legacyAppRoot: config.appRoot,
        cacheHours: () => config.cacheHours,
      });
    const source = options.source ?? createStandaloneSource({ media, cacheHours: () => config.cacheHours });
    const wiring = createRuntimeWiring({
      dataDir: config.dataDir,
      config: runtimeConfigDocument(config),
      environment: env,
      source,
      ...(options.model ? { model: options.model } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.store ? { store: options.store } : {}),
    });
    if (!options.model) {
      // The shared runtime cannot know how the standalone maps a part to a provider
      // URL, so the host adapter supplies that mapping (D5: host owns uploads).
      wiring.deps.model = createOpenAiModelPort({
        config: wiring.deps.config,
        resolveMediaUrl: async (part) => {
          const uploaded = await media.uploadPart(part, wiring.deps.config);
          return uploaded.url;
        },
        costForUsage: ({ inputTokens, outputTokens }) => {
          if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
          return inputTokens * PRICE_PER_INPUT_TOKEN + outputTokens * PRICE_PER_OUTPUT_TOKEN;
        },
      });
    }
    return wiring;
  }

  context.defaultWatch = async ({ emit, request }) => {
    const wiring = buildWiring();
    try {
      await runWatchPipeline({ wiring, emit, request, config });
    } finally {
      wiring.close();
    }
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, context).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: "runtime_unavailable", message: String(error?.message ?? error) });
      else res.end();
    });
  });

  return {
    server,
    config,
    context,
    host,
    port,
    /**
     * Drive one request without a socket. The offline tests use this because a
     * sandboxed process may not be allowed to bind loopback; the same handler runs
     * behind `http.createServer`.
     */
    handle(req, res) {
      return handleRequest(req, res, context);
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      context.port = actualPort;
      return { host, port: actualPort, url: `http://${host}:${actualPort}` };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Start the released standalone app: migrate (offline) then bind 127.0.0.1. */
export async function startStandaloneServer(options = {}) {
  const app = createStandaloneServer(options);
  const migration = migrateLegacyData({
    appRoot: app.config.appRoot,
    dataDir: app.config.dataDir,
    cacheHours: app.config.cacheHours,
    nowSeconds: options.nowSeconds,
  });
  writeRuntimeConfigFile(app.config);
  const address = await app.listen();
  return { ...app, address, migration };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const app = await startStandaloneServer();
  const removed = app.migration.index.counts;
  process.stdout.write(
    `OmniWatch standalone: ${app.address.url}\n` +
      `dane: ${app.config.dataDir}\n` +
      `legacy: ${removed.summaries} analiz, ${removed.cacheEntries} wpisow cache, ${removed.freshUploads} swiezych uploadow\n`,
  );
}
