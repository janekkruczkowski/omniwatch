/**
 * Node-loadable Agent OS worker entry (T6/F, D5).
 *
 * Loaded by `omniwatch-host-worker.mjs` (which registers the `@/` alias resolver).
 * It composes the shared runtime from what the host already exposes:
 *   - config/vault: `@/lib/config` (real `vaultRoot`), never a private layout;
 *   - media: the host's `fetchVideo` / `splitParts` / `upload`;
 *   - model: the shared OpenAI-compatible provider pointed at the host endpoint,
 *     with media URLs produced by the host uploader.
 *
 * Secrets stay in the environment: the entry passes env-var NAMES, never values.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaInfo, MediaPart, SourceRef } from "../../../packages/omniwatch/src/contracts/types.ts";

/** The host's uploader, as every Agent OS release ships it: `(file, key)`. */
export type HostUpload = (src: string, key: string) => Promise<{ url: string; reused: boolean }>;

/**
 * Upload one part through the host's own uploader, optionally forcing a new object.
 *
 * `src/lib/omniwatch.ts` is a protected host file: the installer never replaces it, so
 * the integration must work with the host's two-argument `upload(src, key)`. The host
 * caches oss:// URLs in `<dir>/oss.json` keyed by file name; when Model Studio refused
 * the cached URL (R2-03: 400 "URL not valid"), forgetting that one entry makes the
 * host upload a fresh object. A third argument would be ignored by older hosts and
 * breaks the host's typecheck (R3).
 */
export async function uploadThroughHost(
  upload: HostUpload,
  src: string,
  key: string,
  options?: { refresh?: boolean },
): Promise<{ url: string; reused: boolean }> {
  if (options?.refresh) {
    const meta = path.join(path.dirname(src), "oss.json");
    try {
      const known = JSON.parse(await readFile(meta, "utf8")) as Record<string, unknown> | null;
      const name = path.basename(src);
      if (known && typeof known === "object" && Object.prototype.hasOwnProperty.call(known, name)) {
        delete known[name];
        await writeFile(meta, JSON.stringify(known));
      }
    } catch {
      /* no cache yet: the host uploads anyway */
    }
  }
  return upload(src, key);
}

export interface HostWorkerOptions {
  /** Absolute file URL of the shared core entry (checkout `src/index.ts` or installed dist). */
  corePath: string;
  dataDir: string;
  memoryRoot?: string | null;
  operationIds?: string[] | null;
  maxOperations?: number | null;
  ownerStaleAfterMs?: number;
  language?: string;
  maxFramesPerPart?: number;
  cacheHours?: number;
  env?: NodeJS.ProcessEnv;
  onReady?: () => void;
  log?: (line: string) => void;
}

export interface HostWorkerResult {
  ownerToken: string;
  stopped: string;
  delivered: number;
  failed: number;
  unknown: number;
}

/**
 * Build the runtime dependencies from the host and run the worker. Imported
 * dynamically so the entry stays loadable without the core present (the installer
 * preflight reports a missing core before this runs).
 */
export async function runHostWorker(options: HostWorkerOptions): Promise<HostWorkerResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const core = await import(options.corePath);
  const hostConfig = await import("@/lib/config");
  const hostEngine = await import("@/lib/omniwatch");
  const hostMemoryModule = await import("@/lib/omniwatchHost");
  const env = options.env ?? process.env;

  const hostSettings = (hostConfig.config ?? {}) as typeof hostConfig.config & {
    omniwatch?: { language?: string; maxFrames?: number; cacheHours?: number; model?: string };
    dashscopeApi?: string;
  };
  const omniSettings = hostSettings.omniwatch ?? {};
  const language = options.language ?? omniSettings.language ?? "pl";
  const maxFramesPerPart = options.maxFramesPerPart ?? omniSettings.maxFrames ?? 2400;
  const cacheHours = options.cacheHours ?? omniSettings.cacheHours ?? 48;
  const dataDir = path.resolve(options.dataDir);
  const hostMemory = hostMemoryModule.createOmniWatchHost({
    vaultRoot: options.memoryRoot,
    configPath: env.AGENTIC_OS_CONFIG,
    env,
    model: {
      modelName: omniSettings.model ?? "qwen3.8-omni-flash",
      complete: async ({ system, user }: { system: string; user: string }) => {
        const answer = await hostEngine.run("model", ["--prompt", `${system}\n\n${user}`]);
        return String(answer);
      },
    },
  });
  const vaultRoot = hostMemory.vaultRoot;
  mkdirSync(dataDir, { recursive: true });

  const store = core.openSqliteStore({
    path: path.join(dataDir, "state.sqlite"),
    ...(options.ownerStaleAfterMs !== undefined ? { ownerStaleAfterMs: options.ownerStaleAfterMs } : {}),
  });

  // The host resolves its key asynchronously (env, Hermes profile .env, then
  // ~/.agentic-os/config.json), but the provider's ConfigPort.apiKey() is synchronous.
  // Resolve it once, here: handing over the Promise sent `Bearer [object Promise]`
  // (or failed on `key.trim`) whenever DASHSCOPE_API_KEY was not in the env (LF §7).
  const envKey = typeof env.DASHSCOPE_API_KEY === "string" ? env.DASHSCOPE_API_KEY.trim() : "";
  const hostKey = envKey !== "" ? envKey : ((await hostEngine.apiKey?.()) ?? null);
  const resolvedKey: string | null = typeof hostKey === "string" && hostKey.trim() !== "" ? hostKey.trim() : null;

  const configPort = {
    dataDir,
    memoryRoot: vaultRoot,
    language,
    modelName: omniSettings.model ?? "qwen3.8-omni-flash",
    apiKey: (): string | null => resolvedKey,
    apiBaseUrl: () => env.DASHSCOPE_API ?? hostSettings.dashscopeApi ?? null,
    maxFramesPerPart: () => maxFramesPerPart,
    cacheHours: () => cacheHours,
  };

  // Real host media path: fetchVideo -> local file, splitParts -> parts, upload -> URL.
  const prepared = new Map<string, Awaited<ReturnType<typeof hostEngine.fetchVideo>>>();
  const source = {
    capabilities: (sourceRef: SourceRef) => ({
      platform: sourceRef.platform,
      singleVideo: true,
      listing: sourceRef.platform === "youtube" ? "full" : "limited",
      listingScopeNote: sourceRef.platform === "youtube" ? null : "zakres zalezy od adaptera zrodla",
      pagination: sourceRef.platform === "youtube",
      listingCost: sourceRef.platform === "x" || sourceRef.platform === "meta-ads" ? "paid" : "free",
      requiresConfig: sourceRef.platform === "x" || sourceRef.platform === "meta-ads" ? ["APIFY_TOKEN"] : [],
    }),
    resolve: async ({ url }: { url: string }) => core.parseSourceUrl(url),
    prepare: async (sourceRef: SourceRef) => {
      const fetched = await hostEngine.fetchVideo(sourceRef.canonicalUrl);
      prepared.set(sourceRef.sourceId, fetched);
      const info = fetched.info ?? {};
      return {
        sourceRef,
        title: String(info.title ?? sourceRef.sourceId),
        channel: info.channel ?? null,
        durationSeconds: Number(info.duration ?? 0),
        extractor: String(info.extractor ?? "host"),
        publishedAt: null,
        localPath: fetched.src,
        reusedUpload: false,
      };
    },
    split: async (info: MediaInfo, options: { maxFramesPerPart: number }): Promise<MediaPart[]> => {
      const fetched = prepared.get(info.sourceRef.sourceId);
      if (!fetched) throw new Error(`Brak przygotowanego materialu ${info.sourceRef.sourceId}`);
      // The core's plan (its model-aware frame cap), cut exactly; the host splitter
      // used its own OMNI_MAX_FRAMES and ignored the engine's limit.
      return core.splitParts(
        { ...info, localPath: fetched.src },
        { maxFramesPerPart: options.maxFramesPerPart },
        async (input: { localPath: string; startSeconds: number; endSeconds: number; index: number; count: number }) => {
          const target = path.join(path.dirname(input.localPath), `part_${input.count}_${input.index}.mp4`);
          if (!existsSync(target)) {
            await hostEngine.run("ffmpeg", [
              "-y", "-loglevel", "error",
              "-ss", String(input.startSeconds),
              "-t", String(Math.max(0, input.endSeconds - input.startSeconds)),
              "-i", input.localPath,
              "-c", "copy", "-avoid_negative_ts", "make_zero",
              target,
            ]);
          }
          try {
            const probed = Number(String(await hostEngine.run("ffprobe", [
              "-v", "error", "-show_entries", "format=duration",
              "-of", "default=noprint_wrappers=1:nokey=1", target,
            ])).trim());
            return { localPath: target, startSeconds: core.keyframeAlignedStart(input.startSeconds, input.endSeconds, probed) };
          } catch {
            return target;
          }
        },
      );
    },
  };

  const model = core.createOpenAiModelPort({
    config: configPort,
    resolveMediaUrl: async (part: MediaPart, resolveOptions?: { refresh?: boolean }) => {
      // The second argument is the API key (the upload authenticates with it); this
      // used to pass a file label, which could never authenticate.
      const key = configPort.apiKey();
      if (!key) throw new Error("Brak klucza API dla uploadu materialu.");
      const uploaded = await uploadThroughHost(hostEngine.upload, part.localPath, key, resolveOptions);
      return uploaded.url;
    },
    // R6: Gemini fallback for a part Qwen's content filter refuses (OMNIWATCH_FALLBACK_*,
    // OPENROUTER_API_KEY); an oversized part is shrunk by the host's ffmpeg first.
    env,
    ...(typeof core.createFfmpegShrinker === "function"
      ? { shrinkMedia: core.createFfmpegShrinker((cmd: string, args: string[]) => hostEngine.run(cmd, args)) }
      : {}),
  });

  const memory = hostMemory.memory;

  const deps = {
    clock: core.systemClock(),
    logger: core.createLogger({ sink: (line: string) => log(line) }),
    config: configPort,
    store,
    source,
    model,
    memory,
  };

  try {
    options.onReady?.();
    const result = await core.runWorker({
      deps,
      operationIds: options.operationIds ?? null,
      maxOperations: options.maxOperations ?? null,
      ownerStaleAfterMs: options.ownerStaleAfterMs,
    });
    return {
      ownerToken: result.ownerToken,
      stopped: result.stopped,
      delivered: result.delivered,
      failed: result.failed,
      unknown: result.unknown,
    };
  } finally {
    store.close();
  }
}
