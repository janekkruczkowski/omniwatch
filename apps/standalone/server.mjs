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

import { importCore, resolveCore } from "./core.mjs";
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

/**
 * The shared core, loaded from the installed release (`vendor/omniwatch/current`) or,
 * in the source checkout, from `packages/omniwatch/src` - see core.mjs (D4, QA R2 H3).
 */
export const CORE = resolveCore();
const [
  { createOpenAiModelPort },
  { OmniWatchError },
  { uploadPolicyUrl },
  { ANALYSIS_VERSION },
  { createRuntimeWiring },
  { analysisKeyForRequest, enqueueAnalysis },
  { OperationJournal },
  { recoverPendingWork, runOperation },
  { createSourceRegistry },
  { effectiveMaxFramesPerPart, fpsFor, formatDuration, keyframeAlignedStart, strip },
  { BETA_OSS_TTL_HOURS },
] = await Promise.all(
  [
    "analysis/index",
    "contracts/errors",
    "contracts/endpoints",
    "contracts/types",
    "runtime/poc",
    "runtime/queue",
    "storage/operations",
    "runtime/worker",
    "sources/registry",
    "sources/media",
    "sources/legacy",
  ].map((rel) => importCore(rel, { core: CORE })),
);

export const DEFAULT_HOST = "127.0.0.1";
/** Beta pricing for qwen3.8-omni-flash; the standalone is the host that owns pricing. */
export const PRICE_PER_INPUT_TOKEN = 0.15 / 1e6;
export const PRICE_PER_OUTPUT_TOKEN = 0.47 / 1e6;

/**
 * How often a long-running standalone request refreshes its ownership heartbeat.
 *
 * The shared worker already beats every `DEFAULT_HEARTBEAT_MS`; this adapter did not.
 * One Qwen analysis runs far longer than the takeover window (30 s), so without a
 * heartbeat a request that is still very much alive looked abandoned: a second
 * concurrent request on the same data directory called `acquireOwner`, saw a heartbeat
 * frozen at acquire time, took ownership, and the first request then died inside
 * `assertOwnership` mid-analysis - with its paid answer already on disk.
 *
 * The beat is well under the 30 s stale window on purpose: several missed ticks must
 * still look live, while a process that really died goes stale on schedule.
 */
export const OWNER_HEARTBEAT_MS = 1_000;

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
      // A stream copy starts on the keyframe before the planned start (R2-08); report
      // where the file really begins so part timestamps land on the film's clock.
      try {
        const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", target]);
        const actual = Number(String(probe.stdout).trim());
        return { localPath: target, startSeconds: keyframeAlignedStart(request.startSeconds, request.endSeconds, actual) };
      } catch {
        return target;
      }
    },

    /**
     * Upload one part to Model Studio storage, reusing a fresh `oss.json` entry. The
     * material id comes from the part's own directory (`<cacheDir>/<id>/part_*.mp4`),
     * so the caller does not have to thread a `SourceRef` through the model port.
     */
    async uploadPart(part, config, options = {}) {
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
      // The provider's upload lifetime (47 h, the beta's OSS_TTL), not the local cache
      // window: a longer OMNI_CACHE_HOURS must never resend an expired oss:// URL.
      const verdict = evaluateUploadFreshness(known?.[name] ?? null, BETA_OSS_TTL_HOURS, nowSeconds());
      // `refresh`: the provider refused the cached URL (R2-03); upload a new object.
      if (!options.refresh && verdict.valid && typeof known[name]?.url === "string") {
        return { url: known[name].url, reused: true };
      }
      const key = config.apiKey();
      if (!key) throw new Error("Brak klucza modelu do uploadu materialu.");
      // The upload API lives on the DashScope HOST (`/api/v1/uploads`), not under
      // `compatible-mode/v1` - that prefix belongs to the chat endpoint only.
      const policyEndpoint = uploadPolicyUrl(config.apiBaseUrl(), config.modelName);
      const policyResponse = await fetch(
        policyEndpoint,
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
    case "part_unknown":
      return { name: "part_unknown", data: { i: event.itemIndex ?? 0 } };
    case "merge":
      return { name: "merge", data: {} };
    default:
      return null;
  }
}

/**
 * Usage for a READ of an answer that was already paid for (QA R2-07). Nothing new is
 * billed, so no cost is presented as this request's cost: `savedAnswer` tells the UI
 * to say "saved analysis - no new cost" instead of repeating the old bill next to the
 * "video already in Qwen" upload-reuse label (which belongs to paid analyses).
 */
export function savedAnswerUsage(usage, parts) {
  const payload = {
    in: 0,
    out: 0,
    parts,
    reused: false,
    savedAnswer: true,
    newCostUsd: 0,
  };
  if (usage?.costKnown === true && typeof usage.costUsd === "number") payload.originalCostUsd = usage.costUsd;
  return payload;
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

  const retryId = request.retryOperationId ?? null;
  const prior = retryId ? wiring.store.getOperation(retryId) : null;
  if (retryId && (!prior || prior.state !== "outcome_unknown" || request.confirmRetry !== true)) {
    throw new OmniWatchError("invalid_input", "Ponowienie wymaga jawnego potwierdzenia operacji o nieznanym wyniku.", {
      operationId: retryId,
    });
  }
  // The durable request, not mutable form fields, defines a paid retry. This keeps
  // teardown/summary, language and conversation parent identical to the first call.
  const savedRequest = prior?.request ?? null;

  if (!config.apiKeyPresent) {
    throw new OmniWatchError(
      "missing_config",
      "Brak klucza modelu: ustaw DASHSCOPE_API_KEY w pliku .env obok skryptow albo w srodowisku procesu.",
      { action: { label: "ustaw klucz API", kind: "fix_config" } },
    );
  }

  const sourceRef = savedRequest?.sourceRef ?? await wiring.deps.source.resolve({ url: request.url });
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

  // The same bound the engine applies, or the UI would draw a different part count
  // than the engine reports progress for.
  const parts = await wiring.deps.source.split(info, {
    maxFramesPerPart: effectiveMaxFramesPerPart(wiring.deps.model.modelName, wiring.deps.config.maxFramesPerPart()),
  });
  emit("parts", { n: parts.length, starts: parts.map((part) => part.startSeconds) });
  emit("uploaded", { reused: info.reusedUpload === true });
  emit("stage", { step: "watch", parts: parts.length, fps: fpsFor(info.durationSeconds) });

  const analysisRequest = savedRequest ?? {
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
  // Claim the data directory BEFORE admitting work. The order matters: admission is
  // what writes a `pending` operation, and if ownership is refused afterwards the
  // queue would hold work no consumer can ever pick up. A request that cannot own the
  // directory must fail before it leaves anything behind.
  const token = `standalone_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (!wiring.store.acquireOwner(token, process.pid, new Date().toISOString())) {
    throw new OmniWatchError("runtime_unavailable", "Inny proces OmniWatch jest wlascicielem tego katalogu danych.", {
      action: { label: "poczekaj na proces roboczy", kind: "check_operation" },
    });
  }

  // This request is alive for as long as it is working, and it has to say so. The
  // shared worker beats; the adapter used to stay silent, which made every analysis
  // longer than the takeover window look abandoned to the next concurrent request.
  let beat = null;
  const startHeartbeat = () => {
    beat = setInterval(() => {
      try {
        wiring.store.heartbeat(token, new Date().toISOString());
      } catch {
        // A failed beat is not fatal by itself: `assertOwnership` still guards every
        // write, so a genuinely lost directory is reported where it matters.
      }
    }, OWNER_HEARTBEAT_MS);
    if (typeof beat.unref === "function") beat.unref();
  };

  let summary;
  let enqueued;
  try {
    startHeartbeat();
    const journal = new OperationJournal({ store: wiring.store, ownerToken: token });
    // Resolve interrupted work before admission. A previously started paid call is
    // marked outcome_unknown here, so claiming the same key cannot execute it again.
    await recoverPendingWork(wiring.deps, journal);
    if (retryId) {
      const current = journal.requireOperation(retryId);
      if (current.state !== "outcome_unknown") {
        throw new OmniWatchError("invalid_input", "Operacja nie czeka juz na decyzje o ponowieniu.", { operationId: retryId });
      }
      journal.resolveUnknownOutcome(retryId, "retry");
      enqueued = { operation: journal.requireOperation(retryId), created: false };
    } else {
      enqueued = enqueueAnalysis({ store: wiring.store, request: analysisRequest });
    }
    emit("operation", { operationId: enqueued.operation.id });

    if (enqueued.operation.state === "outcome_unknown") {
      const saved = enqueued.operation.errorMessage ? ` ${enqueued.operation.errorMessage}` : "";
      throw new OmniWatchError("outcome_unknown", `Wynik poprzedniego wywolania modelu jest nieznany; sprawdz operacje przed ponowieniem.${saved}`, {
        operationId: enqueued.operation.id,
      });
    }

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
        emit("done", { text: existing.content, usage: savedAnswerUsage(existing.usage, existing.parts) });
        return { analysisId: existing.analysisId, operationId: enqueued.operation.id, reused: true };
      }
    }

    summary = await runOperation(wiring.deps, journal, enqueued.operation.id, {
      legacyCheckpointAttemptId: retryId ? config.effectiveEnv?.OMNIWATCH_LEGACY_CHECKPOINT_ATTEMPT ?? null : null,
      onProgress: (event) => {
        const mapped = progressToEvent(event);
        if (mapped) emit(mapped.name, mapped.data);
      },
    });
  } finally {
    if (beat) clearInterval(beat);
    wiring.store.releaseOwner(token);
  }

  const buffer = wiring.store.getBuffer(enqueued.operation.id);
  const result = buffer?.result ?? null;
  if (summary.state !== "delivered" || !result) {
    throw new OmniWatchError(
      summary.errorClass ?? "runtime_unavailable",
      summary.message ?? "Analiza nie zakonczyla sie poprawnie.",
      { operationId: enqueued.operation.id },
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

/**
 * R2-06: find an answer that already exists for exactly this request WITHOUT joining
 * the queue. The key is computed the same way admission computes it
 * (`analysisKeyForRequest` over the same request fields `runWatchPipeline` builds), and
 * only a finished operation with a buffered result counts. Nothing is written, nothing
 * is downloaded (a film that is not in the local cache falls back to the normal path),
 * and no model is called. Returns null when the request needs real work.
 */
export async function findSavedAnswer(options) {
  const { wiring, request, media } = options;
  if (request.retryOperationId) return null;
  const sourceRef = await wiring.deps.source.resolve({ url: request.url });
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
  const key = analysisKeyForRequest(wiring.store, analysisRequest);
  const operation = wiring.store.getOperationByKey(key);
  if (!operation || !["delivered", "result_ready"].includes(operation.state)) return null;
  const result = wiring.store.getBuffer(operation.id)?.result ?? null;
  if (!result) return null;
  // Film metadata for the page header, only from the local cache: a free read must
  // never trigger a download.
  if (media && typeof media.cached === "function" && !(await media.cached(sourceRef))) return null;
  const info = await wiring.deps.source.prepare(sourceRef);
  return { sourceRef, info, operation, result };
}

/** The SSE frames of a saved-answer read (same shape as the in-queue reuse path). */
export function emitSavedAnswer(emit, saved) {
  const { sourceRef, info, operation, result } = saved;
  emit("meta", {
    id: sourceRef.legacyId ?? sourceRef.sourceId,
    title: info.title,
    channel: info.channel ?? "",
    duration: formatDuration(info.durationSeconds),
    seconds: info.durationSeconds,
    strip: strip(info.durationSeconds),
  });
  emit("operation", { operationId: operation.id });
  emit("answer.text", { text: result.content });
  emit("turn", {
    conversationId: result.conversationId,
    turnId: result.turnId,
    parentTurnId: result.parentTurnId ?? null,
    analysisId: result.analysisId,
    reused: true,
  });
  emit("done", { text: result.content, usage: savedAnswerUsage(result.usage, result.parts) });
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

/**
 * Where a generated frame is written: always the NEW runtime's data directory.
 *
 * The source video may still live in the beta's `.cache/<id>` (read-only for this
 * runtime), but the frame we render is ours. Writing it next to the beta's files
 * changed the beta tree and made a rollback no longer byte-identical (QA R2 L1).
 */
export function frameTargetPath(context, vid, sec) {
  const safe = assertSafeLegacyId(vid);
  if (!resolveMediaPath(context, safe, "source.mp4")) return null;
  const dir = path.join(context.config.cacheDir, safe);
  return { dir, file: path.join(dir, "frames", `${sec}.jpg`) };
}

/**
 * Generate one frame with ffmpeg, exactly like the released beta did
 * (`-ss <sec> -i source.mp4 -frames:v 1 -vf scale=480:-2 -q:v 4`).
 *
 * The port originally only SERVED an existing frame file, so a freshly downloaded
 * video produced 404s for all 16 strip thumbnails - QA saw `naturalWidth === 0`.
 * Generation is on demand, deterministic and idempotent: the second request serves
 * the file that the first one wrote.
 */
export async function ensureFrameFile(context, vid, sec, options = {}) {
  const existing = resolveMediaPath(context, vid, path.join("frames", `${sec}.jpg`));
  if (existing) return { file: existing, generated: false };

  const target = frameTargetPath(context, vid, sec);
  if (!target) return null;
  const source = resolveMediaPath(context, vid, "source.mp4");
  if (!source) return null;

  mkdirSync(path.dirname(target.file), { recursive: true });
  const ffmpegBin = options.ffmpegPath ?? process.env.OMNIWATCH_FFMPEG ?? "ffmpeg";
  /**
   * Seeking past the end of the file makes ffmpeg fail to open an encoder. The strip
   * requests whole seconds up to the reported duration, so a seek can legitimately
   * land beyond the last frame (rounding, slightly shorter real stream). Clamp the
   * seek inside the file instead of 500-ing the thumbnail.
   */
  const duration = await probeDurationSeconds(source, options.ffmpegPath);
  const target_sec = duration && Number.isFinite(duration) ? Math.max(0, Math.min(sec, Math.max(0, duration - 0.5))) : sec;
  const args = [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    String(target_sec),
    "-i",
    source,
    "-frames:v",
    "1",
    // Keep an even width for the encoder; `-2` keeps the aspect ratio.
    "-vf",
    "scale=480:-2",
    "-q:v",
    "4",
    "-f",
    "image2",
    target.file,
  ];
  const result = await new Promise((resolve) => {
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => resolve({ ok: false, message: String(error.message) }));
    child.once("exit", (code) => resolve({ ok: code === 0, message: code === 0 ? "" : stderr.trim() }));
  });
  if (!result.ok || !existsSync(target.file)) {
    return { file: null, generated: false, error: result.message || "ffmpeg nie utworzyl klatki" };
  }
  return { file: target.file, generated: true };
}

/** Duration in seconds via ffprobe; null when it cannot be determined. */
async function probeDurationSeconds(source, ffprobePath) {
  const bin = ffprobePath ?? process.env.OMNIWATCH_FFPROBE ?? "ffprobe";
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => {
      const value = Number.parseFloat(out.trim());
      resolve(code === 0 && Number.isFinite(value) ? value : null);
    });
  });
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
  const retryOperationId = url.searchParams.get("retryOperation");
  const confirmRetry = url.searchParams.get("confirmRetry") === "1";

  res.writeHead(200, sseHeaders());
  const emit = (name, data) => {
    if (res.writableEnded) return;
    res.write(sseFrame(name, data));
  };

  try {
    if (context.runWatch) {
      await context.runWatch({
        emit,
        request: { url: target, question, language, mode, conversationId, parentTurnId, retryOperationId, confirmRetry },
      });
    } else {
      await context.defaultWatch({
        emit,
        request: { url: target, question, language, mode, conversationId, parentTurnId, retryOperationId, confirmRetry },
      });
    }
  } catch (error) {
    const errorClass = error?.errorClass ?? "runtime_unavailable";
    const message = String(error?.message ?? error).slice(0, 600);
    emit("error", { error: errorClass, message, operationId: error?.operationId ?? null });
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
      // Serve an existing frame; otherwise generate it from the downloaded video the
      // way the released beta did. A missing video is still an honest 404.
      const produced = await ensureFrameFile(context, vid, sec, { ffmpegPath: context.ffmpegPath });
      if (produced?.file) {
        await serveFile(req, res, produced.file, "image/jpeg");
        return;
      }
      if (produced?.error) {
        sendJson(res, 500, {
          error: "source_unavailable",
          message: `Nie udalo sie utworzyc klatki ${sec}s dla ${vid}: ${produced.error}`,
        });
        return;
      }
      sendJson(res, 404, { error: "not_found", message: `Brak materialu dla klatki ${sec}s (${vid}).` });
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
      // Secrets stay in this process: `.env` values are merged under the real
      // process environment so a key configured the beta way is still found.
      environment: config.effectiveEnv ?? env,
      source,
      ...(options.model ? { model: options.model } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.store ? { store: options.store } : {}),
    });
    wiring.standaloneMedia = options.source ? (options.media ?? null) : media;
    if (!options.model) {
      // The shared runtime cannot know how the standalone maps a part to a provider
      // URL, so the host adapter supplies that mapping (D5: host owns uploads).
      wiring.deps.model = createOpenAiModelPort({
        config: wiring.deps.config,
        resolveMediaUrl: async (part, resolveOptions) => {
          const uploaded = await media.uploadPart(part, wiring.deps.config, resolveOptions);
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

  // One HTTP process has one writer for this data directory. Requests wait in arrival
  // order; each claims ownership and admits work only when its turn begins. This keeps
  // two tabs independent while retaining the store's cross-process fencing.
  let watchTail = Promise.resolve();
  let watchesInFlight = 0;
  context.defaultWatch = async ({ emit, request }) => {
    // R2-06: reading an answer that already exists is free and must not wait behind
    // somebody else's long paid analysis. Any failure here simply falls through to
    // the normal path, which reports errors the usual way.
    if (!request.retryOperationId) {
      let probe = null;
      let saved = null;
      try {
        probe = buildWiring();
        saved = await findSavedAnswer({ wiring: probe, request, media: probe.standaloneMedia });
      } catch {
        saved = null;
      } finally {
        probe?.close();
      }
      if (saved) {
        emitSavedAnswer(emit, saved);
        return;
      }
    }
    const previous = watchTail;
    let release;
    watchTail = new Promise((resolve) => { release = resolve; });
    // Say so when this request waits for another one, instead of a frozen "downloading".
    if (watchesInFlight > 0) emit("stage", { step: "queued", ahead: watchesInFlight });
    watchesInFlight += 1;
    await previous;
    let wiring;
    try {
      wiring = buildWiring();
      await runWatchPipeline({ wiring, emit, request, config });
    } finally {
      wiring?.close();
      watchesInFlight -= 1;
      release();
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
