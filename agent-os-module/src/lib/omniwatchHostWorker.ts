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

import path from "node:path";
import type { MediaInfo, MediaPart, SourceRef } from "../../../packages/omniwatch/src/contracts/types.ts";

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
  const memoryModule = await import("@/lib/omniwatchMemory");

  const hostSettings = (hostConfig.config ?? {}) as typeof hostConfig.config & {
    omniwatch?: { language?: string; maxFrames?: number; cacheHours?: number; model?: string };
    dashscopeApi?: string;
  };
  const vaultRoot = hostSettings.vaultRoot ?? options.memoryRoot ?? null;
  if (typeof vaultRoot !== "string" || vaultRoot.trim() === "") {
    throw new core.OmniWatchError("missing_config", "Agent OS nie ma skonfigurowanego vaultRoot; ustaw go przed analiza.", {
      action: { label: "ustaw vaultRoot w ~/.agentic-os/config.json", kind: "fix_config" },
    });
  }

  const omniSettings = hostSettings.omniwatch ?? {};
  const language = options.language ?? omniSettings.language ?? "pl";
  const maxFramesPerPart = options.maxFramesPerPart ?? omniSettings.maxFrames ?? 2400;
  const cacheHours = options.cacheHours ?? omniSettings.cacheHours ?? 48;
  const dataDir = path.resolve(options.dataDir);

  const store = core.openSqliteStore({
    path: path.join(dataDir, "state.sqlite"),
    ...(options.ownerStaleAfterMs !== undefined ? { ownerStaleAfterMs: options.ownerStaleAfterMs } : {}),
  });

  const configPort = {
    dataDir,
    memoryRoot: vaultRoot,
    language,
    modelName: omniSettings.model ?? "qwen3.8-omni-flash",
    apiKey: () => process.env.DASHSCOPE_API_KEY ?? hostEngine.apiKey?.() ?? null,
    apiBaseUrl: () => process.env.DASHSCOPE_API ?? hostSettings.dashscopeApi ?? null,
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
    split: async (info: MediaInfo): Promise<MediaPart[]> => {
      const fetched = prepared.get(info.sourceRef.sourceId);
      if (!fetched) throw new Error(`Brak przygotowanego materialu ${info.sourceRef.sourceId}`);
      const parts = await hostEngine.splitParts(fetched.info, fetched.src);
      return parts.map((part, index) => ({
        index,
        startSeconds: Number(part.start ?? 0),
        endSeconds:
          index + 1 < parts.length ? Number(parts[index + 1].start ?? 0) : Number(fetched.info?.duration ?? 0),
        localPath: String(part.file),
      }));
    },
  };

  const model = core.createOpenAiModelPort({
    config: configPort,
    resolveMediaUrl: async (part: MediaPart) => {
      const uploaded = await hostEngine.upload(part.localPath, `${path.basename(part.localPath)}#${part.index}`);
      return uploaded.url;
    },
  });

  const memory = memoryModule.createVaultMemory({
    root: vaultRoot,
    model: {
      modelName: configPort.modelName,
      complete: async ({ system, user }: { system: string; user: string }) => {
        const answer = await hostEngine.run("model", ["--prompt", `${system}\n\n${user}`]);
        return String(answer);
      },
    },
  });

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
