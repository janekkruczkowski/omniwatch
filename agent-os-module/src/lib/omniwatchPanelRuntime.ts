/**
 * T6 / D5: the Agent OS panel's runtime wiring.
 *
 * One lazily-built bundle of the shared runtime for this Next process: the durable
 * SQLite store, the host knowledge library (the configured Vault), the host media
 * adapter over `@/lib/omniwatch` and the shared OpenAI-compatible model port. The
 * route handlers receive these ports; the handlers themselves import no Next and no
 * host module, which is what makes them testable offline.
 *
 * This file is the only place that knows about the host: it is deliberately thin and
 * has no analysis logic of its own (D1/D9).
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createOpenAiModelPort } from "../../../packages/omniwatch/src/analysis/index.ts";
import { ANALYSIS_VERSION } from "../../../packages/omniwatch/src/contracts/types.ts";
import type { AnalysisRequest, MediaPart, SourceRef } from "../../../packages/omniwatch/src/contracts/types.ts";
import type {
  ConfigPort,
  MemoryPort,
  ModelPort,
  RuntimeDeps,
  SourcePort,
  StorePort,
} from "../../../packages/omniwatch/src/contracts/ports.ts";
import type { ScanReport } from "../../../packages/omniwatch/src/contracts/types.ts";
import {
  handOffRunReport,
  readRunReport,
  reportsToHandOff,
  runScan,
} from "../../../packages/omniwatch/src/collections/index.ts";
import type { ScanOutcome } from "../../../packages/omniwatch/src/collections/scan.ts";
import { createLogger, systemClock } from "../../../packages/omniwatch/src/runtime/poc.ts";
import { spawnWorkerProcess } from "../../../packages/omniwatch/src/runtime/spawn.ts";
import { runOperation } from "../../../packages/omniwatch/src/runtime/worker.ts";
import { OperationJournal } from "../../../packages/omniwatch/src/storage/operations.ts";
import { createSourceRegistry } from "../../../packages/omniwatch/src/sources/index.ts";
import { openSqliteStore } from "../../../packages/omniwatch/src/storage/index.ts";
import { createOmniWatchHost, type OmniWatchHost } from "./omniwatchHost.ts";
import type { HostModelPort } from "./omniwatchMemory.ts";
import { registerDurableJobReader } from "./omniwatchJobs.ts";
import { startJob } from "./omniwatchJobs.ts";
import type { Job } from "./omniwatchJobs.ts";

/** Where the panel keeps durable state. Outside the Vault, as D3 requires. */
export function panelDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OMNIWATCH_DATA_DIR || join(homedir(), ".agentic-os", "omniwatch", "data"));
}

export function panelConfigPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.OMNIWATCH_CONFIG;
  return explicit && explicit.trim() !== "" ? resolve(explicit) : null;
}

/** One Vault selection path for the panel and its offline regression tests. */
export function createPanelHostMemory(env: NodeJS.ProcessEnv = process.env): OmniWatchHost {
  return createOmniWatchHost({
    env,
    configPath: env.AGENTIC_OS_CONFIG,
    model: hostAnswerModel(env),
  });
}

/**
 * The host model used to answer questions about the library (D7). A thin adapter over
 * the host's own key and endpoint — not a second knowledge base and not a new provider.
 */
function hostAnswerModel(env: NodeJS.ProcessEnv): HostModelPort | null {
  const key = env.DASHSCOPE_API_KEY || env.OMNIWATCH_API_KEY;
  if (!key) return null;
  const base = (env.DASHSCOPE_API || env.OMNIWATCH_API_BASE || "https://dashscope-intl.aliyuncs.com").replace(/\/+$/, "");
  const model = env.OMNI_MODEL || "qwen3.8-omni-flash";
  const url = /\/(?:compatible-mode\/)?v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  return {
    modelName: model,
    async complete({ system, user, maxOutputTokens }) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
        }),
      });
      if (!response.ok) throw new Error(`model HTTP ${response.status}`);
      const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      return payload.choices?.[0]?.message?.content ?? "";
    },
  };
}

export interface HostModules {
  omniwatch: typeof import("@/lib/omniwatch");
  channel: typeof import("@/lib/omniwatchChannel");
  scout: typeof import("@/lib/omniwatchScout");
  presets: typeof import("@/lib/omniwatchPresets");
}

export interface CardMeta {
  id: string;
  title: string;
  channel: string;
  duration: string;
  seconds: number;
  strip: number[];
}

export interface PanelRuntime {
  dataDir: string;
  configPath: string | null;
  store: StorePort;
  memory: MemoryPort;
  source: SourcePort;
  model: ModelPort;
  deps: RuntimeDeps;
  resolveSource(input: { url?: string | null; sourceId?: string | null }): Promise<SourceRef>;
  isCached(sourceId: string): Promise<boolean>;
  lookupMedia(sourceRef: SourceRef): Promise<CardMeta | null>;
  /** Spawn (or verify) the on-demand worker for one operation (D5). */
  ensureWorker(operationId: string): Promise<void>;
  runScan(input: {
    collectionId: string;
    trigger: "manual" | "schedule" | "cli";
    runId?: string;
    sources?: SourceRef[];
    confirmPaidListing?: boolean;
    maxNewItems?: number | null;
    onProgress?: (event: { stage: string; sourceId?: string | null; message?: string | null; newItems?: number }) => void;
  }): Promise<ScanOutcome>;
  reportsToHandOff(limit?: number): ScanReport[];
  handOffRunReport(reportId: string, note?: string): ScanReport;
  readRunReport(runId: string): ScanReport[];
  host(): Promise<HostModules>;
  close(): void;
}

let runtime: PanelRuntime | null = null;

/** The process-wide runtime. Routes call this; nothing else constructs ports. */
export function getPanelRuntime(): PanelRuntime {
  if (!runtime) runtime = createPanelRuntime();
  return runtime;
}

/** Test/route hook: replace the singleton (used by the offline tests). */
export function setPanelRuntime(next: PanelRuntime | null): void {
  runtime = next;
}

export function createPanelRuntime(options: { env?: NodeJS.ProcessEnv } = {}): PanelRuntime {
  const env = options.env ?? process.env;
  const dataDir = panelDataDir(env);
  const configPath = panelConfigPath(env);
  // Resolve the host Vault before creating state or admitting work. A bad explicit
  // location must stop the request; local-memory fallback could spend on an analysis
  // and then deliver its result to a different library.
  const hostMemory = createPanelHostMemory(env);
  const memory: MemoryPort = hostMemory.memory;
  mkdirSync(dataDir, { recursive: true });

  const clock = systemClock();
  const logger = createLogger();
  const store = openSqliteStore({ path: join(dataDir, "state.sqlite") });
  store.migrate();

  const config: ConfigPort = {
    dataDir,
    memoryRoot: hostMemory.vaultRoot,
    language: env.OMNI_LANG || "en",
    modelName: env.OMNI_MODEL || "qwen3.8-omni-flash",
    apiKey: () => env.DASHSCOPE_API_KEY || env.OMNIWATCH_API_KEY || null,
    apiBaseUrl: () => env.DASHSCOPE_API || env.OMNIWATCH_API_BASE || "https://dashscope-intl.aliyuncs.com",
    maxFramesPerPart: () => Math.max(300, Number(env.OMNI_MAX_FRAMES || 2400)),
    cacheHours: () => 48,
    configPath: configPath ?? undefined,
  };

  const hostModules = lazyHostModules();
  const source = buildHostSource(hostModules);
  const model = createOpenAiModelPort({
    config,
    resolveMediaUrl: async (part: MediaPart) => {
      const legacy = (await hostModules).omniwatch;
      const key = config.apiKey();
      if (!key) throw new Error("Brak klucza API dla uploadu materialu.");
      const uploaded = await legacy.upload(part.localPath, key);
      return uploaded.url;
    },
    costForUsage: ({ inputTokens, outputTokens }) => {
      if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
      return inputTokens * (0.15 / 1e6) + outputTokens * (0.47 / 1e6);
    },
  });

  const deps: RuntimeDeps = { clock, logger, config, store, source, model, memory };

  // Other `getJob` callers (the film routes, the Scout tab) see durable operations too.
  registerDurableJobReader((id) => durableJobView(store, id));

  async function resolveSource(input: { url?: string | null; sourceId?: string | null }): Promise<SourceRef> {
    const sourceId = String(input.sourceId ?? "").trim();
    if (sourceId) {
      const legacy = (await hostModules).omniwatch;
      if (!(await legacy.cachedVideo(sourceId))) throw new Error(`Material ${sourceId} nie jest w cache.`);
      return {
        platform: "youtube",
        sourceId,
        canonicalUrl: `https://www.youtube.com/watch?v=${sourceId}`,
        legacyId: sourceId,
      };
    }
    return source.resolve({ url: String(input.url ?? "") });
  }

  async function isCached(sourceId: string): Promise<boolean> {
    return Boolean(await (await hostModules).omniwatch.cachedVideo(sourceId));
  }

  async function lookupMedia(sourceRef: SourceRef): Promise<CardMeta | null> {
    const legacy = (await hostModules).omniwatch;
    const cached = await legacy.cachedVideo(sourceRef.legacyId ?? sourceRef.sourceId);
    if (!cached) return null;
    const seconds = cached.info.duration || 0;
    return {
      id: cached.info.id,
      title: cached.info.title,
      channel: cached.info.channel ?? "",
      duration: legacy.fmt(seconds),
      seconds,
      strip: Array.from({ length: legacy.STRIP }, (_, i) => Math.round((seconds * (i + 0.5)) / legacy.STRIP)),
    };
  }

  async function ensureWorker(operationId: string): Promise<void> {
    // A separate process is the target shape (D5), and it is used when the host ships a
    // Node-loadable adapter config (`OMNIWATCH_WORKER=cli`). Until then the Agent OS
    // media and model adapters live inside this Next process — the shared CLI cannot
    // import them — so the panel executes the admitted operation itself, in a job that
    // outlives the request. The durable operation stays the record either way.
    if (env.OMNIWATCH_WORKER === "cli") {
      // Use the host worker entry, which validates the same Vault configuration as
      // this panel before announcing readiness. The generic core CLI would write to
      // its local-memory adapter instead of the Agent OS Vault.
      const entry = new URL("../../omniwatch-host-worker.mjs", import.meta.url).pathname;
      const spawned = spawnWorkerProcess({
        entry,
        args: [
          "--operation",
          operationId,
          "--data-dir",
          dataDir,
        ],
        env,
        detached: true,
      });
      spawned.child.unref?.();
      await spawned.ready;
      return;
    }

    startJob(
      async (job) => {
        job.progress = { stage: "watch" };
        const journal = new OperationJournal({ store });
        return runOperation(deps, journal, operationId, {
          onProgress: (event) => {
            job.progress = { stage: event.stage, message: event.message ?? undefined, parts: event.itemCount ?? undefined };
          },
        });
      },
      { kind: "analysis" },
    );
  }

  return {
    dataDir,
    configPath,
    store,
    memory,
    source,
    model,
    deps,
    resolveSource,
    isCached,
    lookupMedia,
    ensureWorker,
    runScan: (input) =>
      runScan({
        deps,
        request: {
          collectionId: input.collectionId,
          trigger: input.trigger,
          runId: input.runId,
          sources: input.sources,
          confirmPaidListing: input.confirmPaidListing,
          ...(input.maxNewItems === undefined ? {} : { settings: { maxNewItems: input.maxNewItems } }),
        },
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      }),
    reportsToHandOff: (limit) => reportsToHandOff(store, limit),
    handOffRunReport: (reportId, note) => handOffRunReport(store, reportId, note),
    readRunReport: (runId) => readRunReport(store, runId),
    host: () => hostModules,
    close: () => {
      registerDurableJobReader(null);
      store.close();
    },
  };
}

/** Host modules load lazily so importing a handler never pulls in Next or the film code. */
function lazyHostModules(): Promise<HostModules> {
  return Promise.all([
    import("@/lib/omniwatch"),
    import("@/lib/omniwatchChannel"),
    import("@/lib/omniwatchScout"),
    import("@/lib/omniwatchPresets"),
  ]).then(([omniwatch, channel, scout, presets]) => ({ omniwatch, channel, scout, presets }));
}

/** The host media tool: yt-dlp/ffmpeg behind the core's `MediaToolPort` (D5). */
function buildHostSource(hostModules: Promise<HostModules>): SourcePort {
  const media = {
    async cached(source: SourceRef) {
      const legacy = (await hostModules).omniwatch;
      const cached = await legacy.cachedVideo(source.legacyId ?? source.sourceId);
      if (!cached) return null;
      return {
        localPath: cached.src,
        title: cached.info.title,
        channel: cached.info.channel,
        durationSeconds: cached.info.duration,
        extractor: cached.info.extractor,
        publishedAt: null,
      };
    },
    async fetch(source: SourceRef) {
      const legacy = (await hostModules).omniwatch;
      const { info, src } = await legacy.fetchVideo(source.canonicalUrl);
      return {
        localPath: src,
        title: info.title,
        channel: info.channel,
        durationSeconds: info.duration,
        extractor: info.extractor,
        publishedAt: null,
      };
    },
    async slice(input: {
      localPath: string;
      startSeconds: number;
      endSeconds: number;
      index: number;
      count: number;
    }) {
      const legacy = (await hostModules).omniwatch;
      const parts = await legacy.splitParts(
        { id: "", title: "", channel: "", duration: input.endSeconds, extractor: "" },
        input.localPath,
      );
      const match = parts[input.index];
      if (!match) throw new Error(`Nie udalo sie przygotowac czesci ${input.index}.`);
      return match.file;
    },
  };

  return createSourceRegistry({
    media,
    cacheHours: () => 48,
    listers: {
      youtube: {
        async list(source: SourceRef, options: { limit?: number }) {
          const channel = (await hostModules).channel;
          const account = channel.parseAccount(source.canonicalUrl, "youtube");
          if (!account) throw new Error(`Nie mozna odczytac kanalu z ${source.canonicalUrl}.`);
          const listing = await channel.listChannel(account, "popular", options.limit ?? 50);
          return {
            items: listing.videos.map((video) => ({
              sourceRef: { platform: "youtube" as const, sourceId: video.url, canonicalUrl: video.url },
              title: video.title,
              durationSeconds: video.duration ?? null,
              publishedAt: video.postedAt ?? null,
              private: false,
            })),
            cursor: null,
            completeness: "complete" as const,
            note: listing.note ?? null,
          };
        },
      },
    },
  });
}

/** Sync durable view used by `getJob`; the richer async view lives in the jobs handler. */
function durableJobView(store: StorePort, id: string): Job | null {
  const operation = store.getOperation(id);
  if (!operation) return null;
  const buffer = store.getBuffer(id)?.result ?? null;
  const running = operation.state === "pending" || operation.state === "running";
  const done = operation.state === "delivered" || operation.state === "result_ready";
  return {
    id,
    operationId: id,
    kind: "analysis",
    state: done ? "done" : running ? "running" : "error",
    startedAt: Date.parse(operation.createdAt) || Date.now(),
    ...(done ? {} : { error: operation.errorMessage ?? undefined }),
    progress: { stage: running ? "watch" : "answer", ...(buffer ? { text: buffer.content } : {}) },
    ...(done && buffer
      ? {
          result: {
            text: buffer.content,
            analysisId: buffer.analysisId,
            conversationId: buffer.conversationId,
            turnId: buffer.turnId,
          },
        }
      : {}),
  } as Job;
}

/** Analysis version the panel admits; re-exported so routes do not import core types. */
export const PANEL_ANALYSIS_VERSION = ANALYSIS_VERSION;

export type { AnalysisRequest, ScanOutcome, ScanReport };
