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

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { createFfmpegShrinker, createOpenAiModelPort } from "../../../packages/omniwatch/src/analysis/index.ts";
import { chatCompletionsUrl, DEFAULT_DASHSCOPE_HOST } from "../../../packages/omniwatch/src/contracts/endpoints.ts";
import { OmniWatchError } from "../../../packages/omniwatch/src/contracts/errors.ts";
import { ANALYSIS_VERSION } from "../../../packages/omniwatch/src/contracts/types.ts";
import type {
  AnalysisRequest,
  MediaPart,
  Operation,
  SourceRef,
} from "../../../packages/omniwatch/src/contracts/types.ts";
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
import {
  DEFAULT_HEARTBEAT_MS,
  OWNER_STALE_AFTER_MS,
  recoverPendingWork,
  runOperation,
} from "../../../packages/omniwatch/src/runtime/worker.ts";
import type { WorkerOperationSummary } from "../../../packages/omniwatch/src/runtime/worker.ts";
import { OperationJournal } from "../../../packages/omniwatch/src/storage/operations.ts";
import { createSourceRegistry, keyframeAlignedStart } from "../../../packages/omniwatch/src/sources/index.ts";
import {
  createYtDlpRetryBudget,
  runYtDlpResilient,
  ytDlpCookieArgs,
  ytDlpRetrySeconds,
} from "../../../packages/omniwatch/src/sources/ytdlp.ts";
import type { SourceWait } from "../../../packages/omniwatch/src/sources/ytdlp.ts";
import { openSqliteStore } from "../../../packages/omniwatch/src/storage/index.ts";
import { createOmniWatchHost, type OmniWatchHost } from "./omniwatchHost.ts";
import { uploadThroughHost } from "./omniwatchHostWorker.ts";
import type { HostModelPort } from "./omniwatchMemory.ts";
import { registerDurableJobReader } from "./omniwatchJobs.ts";
import type { Job } from "./omniwatchJobs.ts";
import { cardProgress } from "./omniwatchProgress.ts";
import type { LiveProgress } from "./omniwatchProgress.ts";

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
    model: createHostAnswerModel(env),
    // The same `omniwatch.memory.*` channel the answer model logs on, so a failed or
    // empty expansion is visible next to the call it belongs to (R3-02).
    log: (line) => console.info(line),
  });
}

/**
 * The provider settings of this panel, read in ONE place. The video-analysis model port
 * and the library answer model both take their key, host and model name from here, so
 * the two can never drift apart again (FAIL-C: the answer model once built its own URL
 * and hit a 404 on the documented DashScope default).
 */
export function panelApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.DASHSCOPE_API_KEY || env.OMNIWATCH_API_KEY || null;
}

export function panelApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.DASHSCOPE_API || env.OMNIWATCH_API_BASE || DEFAULT_DASHSCOPE_HOST;
}

export function panelModelName(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMNI_MODEL || "qwen3.8-omni-flash";
}

/** Same per-token price the analysis port reports; null when the provider gave no usage. */
export function panelCostForUsage(inputTokens: unknown, outputTokens: unknown): number | null {
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return inputTokens * (0.15 / 1e6) + outputTokens * (0.47 / 1e6);
}

/**
 * The host model used to answer questions about the library (D7). A thin adapter over
 * the host's own key and endpoint — not a second knowledge base and not a new provider.
 * The endpoint comes from the shared `chatCompletionsUrl`, the same function the
 * analysis provider uses: one source of truth for provider URLs.
 */
export function createHostAnswerModel(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch; log?: (line: string) => void } = {},
): HostModelPort | null {
  const key = panelApiKey(env);
  if (!key) return null;
  const url = chatCompletionsUrl(panelApiBase(env));
  const model = panelModelName(env);
  // Resolved per call, so a process-level fetch (or a test stub) installed later is used.
  const doFetch: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init);
  const log = options.log ?? ((line: string) => console.info(line));
  return {
    modelName: model,
    async complete({ system, user, maxOutputTokens, temperature, reasoningEffort }) {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          // Omni models on DashScope only answer in streaming mode; a single SSE
          // response is read to its final frame below.
          stream: true,
          stream_options: { include_usage: true },
          modalities: ["text"],
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
          // R3-02: the keyword-expansion call asks for determinism and low reasoning.
          // `max_tokens` cannot bound thinking (it is not the completion), so the model
          // has to be told not to spend it; the analysis provider uses the same
          // `reasoning_effort: "low"` for this model.
          ...(typeof temperature === "number" ? { temperature } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
      });
      if (!response.ok) throw new Error(`model HTTP ${response.status}`);
      const { text, usage } = await readChatResponse(response);
      const cost = panelCostForUsage(usage?.prompt_tokens, usage?.completion_tokens);
      // Informational only (no secret): lets an operator see what a library answer cost.
      log(
        `omniwatch.memory.answer model=${model} in=${usage?.prompt_tokens ?? "?"} out=${usage?.completion_tokens ?? "?"} ` +
          `costUsd=${cost === null ? "unknown" : cost.toFixed(6)}`,
      );
      return text;
    },
  };
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Reads either a JSON completion or an SSE stream of `chat.completion.chunk` frames. */
async function readChatResponse(response: Response): Promise<{ text: string; usage: ChatUsage | null }> {
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  if (!/event-stream/i.test(contentType) && !/^\s*data:/m.test(raw)) {
    const payload = JSON.parse(raw) as { choices?: { message?: { content?: string } }[]; usage?: ChatUsage };
    return { text: payload.choices?.[0]?.message?.content ?? "", usage: payload.usage ?? null };
  }
  let text = "";
  let usage: ChatUsage | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    let frame: { choices?: { delta?: { content?: string } }[]; usage?: ChatUsage | null };
    try {
      frame = JSON.parse(data);
    } catch {
      continue;
    }
    for (const choice of frame.choices ?? []) text += choice.delta?.content ?? "";
    if (frame.usage) usage = frame.usage;
  }
  return { text, usage };
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
  /** The Vault this panel reads and writes (the resolved one, not a default label). */
  vaultRoot: string;
  /** OmniWatch directory inside the Vault. */
  analysesDir: string;
  /** True when a host model can answer questions about the library. */
  answerModel: boolean;
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
  /**
   * Startup recovery (R2-04): resolves once this process has tried to take the data
   * directory and settled what a dead process left behind. Never rejects.
   */
  ready: Promise<void>;
  /** Take the data directory when nobody alive holds it and recover orphans (no model call). */
  recover(): Promise<void>;
  /** True when a live process (this one or the current owner) can still finish the operation. */
  hasConsumer(operationId: string): boolean;
  /** R5: the last real progress event of an operation this process executes, or null. */
  progress(operationId: string): LiveProgress | null;
  /** The user's confirmed retry of an `outcome_unknown` operation, resolved under ownership. */
  retryUnknown(operationId: string): Promise<Operation>;
  /** "Try again" on a `failed` operation: back to pending, resumed from committed parts. */
  retryFailed(operationId: string): Promise<Operation>;
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
    modelName: panelModelName(env),
    apiKey: () => panelApiKey(env),
    apiBaseUrl: () => panelApiBase(env),
    maxFramesPerPart: () => Math.max(300, Number(env.OMNI_MAX_FRAMES || 2400)),
    cacheHours: () => 48,
    configPath: configPath ?? undefined,
  };

  // Loaded on first use, not when the runtime is built: startup recovery needs only the
  // store, and an eager import that fails would surface as an unhandled rejection.
  let hostLoad: Promise<HostModules> | null = null;
  const hostModules = (): Promise<HostModules> => (hostLoad ??= lazyHostModules());
  const source = buildHostSource(hostModules);
  const model = createOpenAiModelPort({
    config,
    resolveMediaUrl: async (part: MediaPart, resolveOptions?: { refresh?: boolean }) => {
      const legacy = (await hostModules()).omniwatch;
      const key = config.apiKey();
      if (!key) throw new Error("Brak klucza API dla uploadu materialu.");
      const uploaded = await uploadThroughHost(legacy.upload, part.localPath, key, resolveOptions);
      return uploaded.url;
    },
    costForUsage: ({ inputTokens, outputTokens }) => panelCostForUsage(inputTokens, outputTokens),
    // R6: a part Qwen's content filter refuses goes to the Gemini fallback, inlined; a
    // part too big to inline is re-encoded by the host's ffmpeg first. The fallback's
    // model/base/key come from OMNIWATCH_FALLBACK_* / OPENROUTER_API_KEY in `env`.
    env,
    shrinkMedia: async (part, maxBytes) => {
      const legacy = (await hostModules()).omniwatch;
      return createFfmpegShrinker((cmd, args) => legacy.run(cmd, args))(part, maxBytes);
    },
  });

  const deps: RuntimeDeps = { clock, logger, config, store, source, model, memory };

  // R2-04 / D5: one owner per data directory. With `OMNIWATCH_WORKER=cli` the spawned
  // worker executes the work; the panel still recovers what a dead process left behind
  // and holds the directory while a Scout/channel scan runs inside this process.
  const inProcess = env.OMNIWATCH_WORKER !== "cli";
  const consumer = createPanelConsumer({ deps, execute: inProcess });
  // "At start": the first route that builds this runtime settles what a killed process
  // left behind (running + started call -> outcome_unknown) before any card polls it.
  const ready = consumer.recover().then(
    () => undefined,
    (error: unknown) => {
      logger.warn("omniwatch.panel.startup_recovery_failed", { message: String(error) });
    },
  );

  // Other `getJob` callers (the film routes, the Scout tab) see durable operations too.
  registerDurableJobReader((id) => durableJobView(store, id, consumer.progress(id)));

  async function resolveSource(input: { url?: string | null; sourceId?: string | null }): Promise<SourceRef> {
    const sourceId = String(input.sourceId ?? "").trim();
    if (sourceId) {
      const legacy = (await hostModules()).omniwatch;
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
    return Boolean(await (await hostModules()).omniwatch.cachedVideo(sourceId));
  }

  async function lookupMedia(sourceRef: SourceRef): Promise<CardMeta | null> {
    const legacy = (await hostModules()).omniwatch;
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
    // import them — so the panel executes the admitted operation itself, in work that
    // outlives the request. The durable operation stays the record either way.
    if (!inProcess) {
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

    // In-process execution goes through the owned consumer: owner token, heartbeat and
    // the recovery pass, exactly like the shared worker (R2-04). When another live
    // process owns the data directory this is refused and the operation stays pending
    // with a visible reason — never a second consumer of the same work.
    await consumer.run(operationId);
  }

  return {
    dataDir,
    configPath,
    vaultRoot: hostMemory.vaultRoot,
    analysesDir: hostMemory.analysesDir,
    answerModel: hostMemory.modelName !== null,
    store,
    memory,
    source,
    model,
    deps,
    resolveSource,
    isCached,
    lookupMedia,
    ensureWorker,
    ready,
    recover: async () => {
      await consumer.recover();
    },
    hasConsumer: (operationId) => consumer.hasConsumer(operationId),
    progress: (operationId) => consumer.progress(operationId),
    retryUnknown: (operationId) => consumer.retry(operationId),
    retryFailed: (operationId) => consumer.retry(operationId),
    // A scan executes its analyses in this process, so it runs as the owner too: an
    // unowned scan would be "recovered" as orphaned by the next request.
    runScan: (input) =>
      consumer.hold((ownerToken) => runScan({
        deps,
        ownerToken,
        request: {
          collectionId: input.collectionId,
          trigger: input.trigger,
          runId: input.runId,
          sources: input.sources,
          confirmPaidListing: input.confirmPaidListing,
          ...(input.maxNewItems === undefined ? {} : { settings: { maxNewItems: input.maxNewItems } }),
        },
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      })),
    reportsToHandOff: (limit) => reportsToHandOff(store, limit),
    handOffRunReport: (reportId, note) => handOffRunReport(store, reportId, note),
    readRunReport: (runId) => readRunReport(store, runId),
    host: hostModules,
    close: () => {
      registerDurableJobReader(null);
      consumer.close();
      store.close();
    },
  };
}

/* ------------------------------------------------------------------------------ *
 * R2-04 / D5: the panel as the single owner of its data directory.
 *
 * The in-process path used to call `runOperation` with no owner token, no heartbeat
 * and no recovery pass. A killed Next process therefore left `running` operations with
 * a `started` attempt and an empty `runtime_owner` behind, and nothing looked at them
 * again: the card polled "running" for ever and the request key stayed blocked. The
 * panel now follows the protocol of the shared worker (`runWorker`) and the standalone
 * server, reusing the core functions rather than a copy of them:
 *
 *   acquireOwner -> recoverPendingWork -> runOperation (owned journal + heartbeat)
 *     -> releaseOwner as soon as nothing is in flight
 *
 * Recovery never repeats a paid call: an unconfirmed call becomes `outcome_unknown`
 * and waits for the user's explicit retry (`retryOperation` + `confirmRetry`). A
 * second panel process on the same data directory cannot take ownership while the
 * first one's heartbeat is alive, so it neither works the same operation twice nor
 * mistakes a live call for an orphan.
 * ------------------------------------------------------------------------------ */

export interface PanelConsumerOptions {
  deps: RuntimeDeps;
  /**
   * False in `OMNIWATCH_WORKER=cli` mode: the spawned worker executes admitted work;
   * this process only recovers orphans and owns the directory for in-process scans.
   */
  execute?: boolean;
  heartbeatMs?: number;
  /** How old a foreign heartbeat may be before its owner counts as gone. */
  ownerStaleAfterMs?: number;
  token?: string;
  pid?: number;
}

export interface PanelConsumer {
  readonly token: string;
  /** True while this process holds the data directory. */
  owns(): boolean;
  /** True while this process is executing the operation. */
  isActive(operationId: string): boolean;
  /**
   * True when a live process can still finish this operation: this one is running
   * it, or another process holds the data directory with a fresh heartbeat.
   */
  hasConsumer(operationId: string): boolean;
  /** R5: the last real progress event of an operation this process executes, or null. */
  progress(operationId: string): LiveProgress | null;
  /**
   * Take the data directory if nobody alive holds it, recover what a dead process
   * left behind and let go again when idle. Never calls the model. Resolves to the
   * recovery summaries, or null when another live process owns the directory.
   */
  recover(): Promise<WorkerOperationSummary[] | null>;
  /** Execute one admitted operation as the owner (no-op when it already runs here). */
  run(operationId: string): Promise<void>;
  /**
   * The user's retry, decided as the owner: a confirmed retry of an `outcome_unknown`
   * operation, or "try again" on a `failed` one (resumes from its committed parts).
   */
  retry(operationId: string): Promise<Operation>;
  /** Run other in-process work (a scan) as the owner; `fn` gets the owner token. */
  hold<T>(fn: (ownerToken: string) => Promise<T>): Promise<T>;
  /** Resolves when nothing is in flight (tests, graceful shutdown). */
  idle(): Promise<void>;
  close(): void;
}

const MAX_ADOPT_ROUNDS = 3;

export function createPanelConsumer(options: PanelConsumerOptions): PanelConsumer {
  const { deps } = options;
  const execute = options.execute ?? true;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = options.ownerStaleAfterMs ?? OWNER_STALE_AFTER_MS;
  const pid = options.pid ?? process.pid;
  const token = options.token ?? `panel_${pid}_${randomUUID()}`;
  const now = () => deps.clock.now().toISOString();
  const journal = new OperationJournal({ store: deps.store, ownerToken: token, now });

  /** Work this process is doing as the owner: operations by id, scans by a hold key. */
  const active = new Map<string, Promise<unknown>>();
  /** R5: the latest real progress event per executing operation (what the card shows). */
  const live = new Map<string, LiveProgress>();
  let owned = false;
  let closed = false;
  let heartbeatHandle: unknown = null;
  let adopting: Promise<WorkerOperationSummary[] | null> | null = null;

  function stopHeartbeat(): void {
    if (heartbeatHandle !== null) deps.clock.clearTimeout(heartbeatHandle);
    heartbeatHandle = null;
  }

  function scheduleHeartbeat(): void {
    stopHeartbeat();
    const handle = deps.clock.setTimeout(beat, heartbeatMs);
    // The beat must never be what keeps a finished process alive.
    (handle as { unref?: () => void } | null)?.unref?.();
    heartbeatHandle = handle;
  }

  function beat(): void {
    heartbeatHandle = null;
    if (!owned || closed) return;
    try {
      if (!deps.store.heartbeat(token, now())) {
        // Another process took over after our beat went stale. Every journal write
        // checks the token too, so a late result of ours is not recorded.
        owned = false;
        deps.logger.warn("omniwatch.panel.ownership_lost", { token });
        return;
      }
    } catch (error) {
      deps.logger.warn("omniwatch.panel.heartbeat_failed", { message: String(error) });
    }
    scheduleHeartbeat();
  }

  function releaseIfIdle(): void {
    if (!owned || active.size > 0 || adopting) return;
    owned = false;
    stopHeartbeat();
    try {
      deps.store.releaseOwner(token);
    } catch (error) {
      deps.logger.warn("omniwatch.panel.release_failed", { message: String(error) });
    }
  }

  async function adoptOnce(): Promise<WorkerOperationSummary[] | null> {
    if (closed) return null;
    if (owned) {
      if (deps.store.heartbeat(token, now())) return [];
      owned = false;
      stopHeartbeat();
    }
    if (!deps.store.acquireOwner(token, pid, now())) return null;
    owned = true;
    scheduleHeartbeat();
    // Only on a takeover with nothing of ours in flight is every open operation either
    // queued or left behind by a process that is gone — the worker's precondition.
    if (active.size > 0) return [];
    const recovered = await recoverPendingWork(deps, journal);
    for (const summary of recovered) {
      deps.logger.info("omniwatch.panel.recovered", {
        operationId: summary.operationId,
        state: summary.state,
        errorClass: summary.errorClass ?? null,
      });
    }
    return recovered;
  }

  function adopt(): Promise<WorkerOperationSummary[] | null> {
    if (!adopting) {
      adopting = adoptOnce().finally(() => {
        adopting = null;
      });
    }
    return adopting;
  }

  /**
   * Run `fn` synchronously while this process owns the directory. The check and `fn`
   * share one tick, so a release by other finishing work cannot slip in between.
   */
  async function asOwner<T>(operationId: string | undefined, fn: () => T): Promise<T> {
    for (let round = 0; round < MAX_ADOPT_ROUNDS; round += 1) {
      const result = await adopt();
      if (result === null) break;
      if (owned) {
        try {
          return fn();
        } finally {
          releaseIfIdle();
        }
      }
    }
    throw new OmniWatchError(
      "runtime_unavailable",
      "Inny proces OmniWatch jest wlascicielem tego katalogu danych; praca nie zostanie wykonana drugi raz rownolegle.",
      {
        ...(operationId ? { operationId } : {}),
        action: { label: "poczekaj na zakonczenie pracy drugiego procesu", kind: "check_operation" },
      },
    );
  }

  function otherOwnerAlive(): boolean {
    const owner = deps.store.getOwner();
    if (!owner || owner.token === token) return false;
    const beatAt = Date.parse(owner.heartbeatAt);
    if (!Number.isFinite(beatAt)) return false;
    return deps.clock.now().getTime() - beatAt < staleAfterMs;
  }

  function startable(operationId: string): boolean {
    const state = deps.store.getOperation(operationId)?.state;
    // `running` is deliberately absent: after the takeover recovery a running row is
    // not ours to restart. An orphan is `outcome_unknown` and needs the user's decision.
    return state === "pending" || state === "failed" || state === "budget_paused";
  }

  function launch(operationId: string): void {
    const work = (async () => {
      try {
        const summary = await runOperation(deps, journal, operationId, {
          onProgress: (event) => {
            live.set(operationId, {
              stage: event.stage,
              at: deps.clock.now().getTime(),
              itemIndex: event.itemIndex ?? null,
              itemCount: event.itemCount ?? null,
              waitSeconds: event.waitSeconds ?? null,
              reason: event.reason ?? null,
            });
          },
        });
        deps.logger.info("omniwatch.panel.operation", {
          operationId,
          state: summary.state,
          errorClass: summary.errorClass ?? null,
          modelCalls: summary.modelCalls,
        });
      } catch (error) {
        // runOperation records its own terminal states; what reaches here is a lost
        // ownership or a storage failure, already reflected in the durable record.
        deps.logger.warn("omniwatch.panel.operation_failed", { operationId, message: String(error) });
      } finally {
        active.delete(operationId);
        live.delete(operationId);
        releaseIfIdle();
      }
    })();
    active.set(operationId, work);
  }

  return {
    token,
    owns: () => owned,
    isActive: (operationId) => active.has(operationId),
    hasConsumer: (operationId) => active.has(operationId) || otherOwnerAlive(),
    progress: (operationId) => live.get(operationId) ?? null,
    async recover() {
      try {
        return await adopt();
      } finally {
        releaseIfIdle();
      }
    },
    async run(operationId) {
      if (active.has(operationId)) return;
      await asOwner(operationId, () => {
        // Re-checked as the owner: a parallel request may have started it meanwhile.
        if (!execute || active.has(operationId) || !startable(operationId)) return;
        launch(operationId);
      });
    },
    retry(operationId) {
      return asOwner(operationId, () => {
        // Decided as the owner, AFTER the takeover recovery: the interrupted attempt is
        // still `started` in the journal, so a recovery pass run after this decision
        // would turn the confirmed retry straight back into outcome_unknown.
        // A definitively failed operation (4xx, content filter, missing config) needs no
        // cost decision: it is queued again and resumes from its committed parts.
        const current = deps.store.getOperation(operationId);
        const operation = current?.state === "failed"
          ? journal.requeueFailed(operationId)
          : journal.resolveUnknownOutcome(operationId, "retry");
        if (execute && !active.has(operationId)) launch(operationId);
        return operation;
      });
    },
    async hold(fn) {
      const key = `hold_${randomUUID()}`;
      let settle: () => void = () => undefined;
      const marker = new Promise<void>((resolve) => {
        settle = resolve;
      });
      await asOwner(undefined, () => {
        active.set(key, marker);
      });
      try {
        return await fn(token);
      } finally {
        active.delete(key);
        settle();
        releaseIfIdle();
      }
    },
    async idle() {
      while (active.size > 0 || adopting) {
        await Promise.allSettled([...active.values(), ...(adopting ? [adopting] : [])]);
      }
    },
    close() {
      closed = true;
      stopHeartbeat();
      if (!owned) return;
      owned = false;
      try {
        deps.store.releaseOwner(token);
      } catch (error) {
        deps.logger.warn("omniwatch.panel.release_failed", { message: String(error) });
      }
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
function buildHostSource(hostModules: () => Promise<HostModules>): SourcePort {
  const media = {
    async cached(source: SourceRef) {
      const legacy = (await hostModules()).omniwatch;
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
    async fetch(source: SourceRef, options?: { onWait?: (wait: SourceWait) => void }) {
      const legacy = (await hostModules()).omniwatch;
      // R5: the panel's own download (classified errors, one visible 429 retry, opt-in
      // cookies) over the host library's cache layout. The film library's fetchVideo
      // is a protected host file and keeps its own behaviour for the film modes.
      const { info, src } = await downloadForPanel(legacy, source.canonicalUrl, { onWait: options?.onWait });
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
      // Cut exactly the range the core planned. The legacy splitter re-planned from
      // its own frame limit and a fake duration, so part 0 of a two-part plan was the
      // whole film and any other plan asked for parts it never made.
      const legacy = (await hostModules()).omniwatch;
      const target = join(dirname(input.localPath), `part_${input.count}_${input.index}.mp4`);
      if (!existsSync(target)) {
        await legacy.run("ffmpeg", [
          "-y", "-loglevel", "error",
          "-ss", String(input.startSeconds),
          "-t", String(Math.max(0, input.endSeconds - input.startSeconds)),
          "-i", input.localPath,
          "-c", "copy", "-avoid_negative_ts", "make_zero",
          target,
        ]);
      }
      // A stream copy starts on the keyframe before the planned start (R2-08).
      try {
        const probed = Number(String(await legacy.run("ffprobe", [
          "-v", "error", "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1", target,
        ])).trim());
        return { localPath: target, startSeconds: keyframeAlignedStart(input.startSeconds, input.endSeconds, probed) };
      } catch {
        return target;
      }
    },
  };

  return createSourceRegistry({
    media,
    cacheHours: () => 48,
    listers: {
      youtube: {
        async list(source: SourceRef, options: { limit?: number }) {
          const channel = (await hostModules()).channel;
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

/** The pieces of the host film library (`@/lib/omniwatch`) the panel's download reuses. */
export interface HostDownloadTools {
  run(cmd: string, args: string[], timeoutMs?: number): Promise<string>;
  cleanup(): Promise<string[]>;
  cacheKey(url: string): string;
  videoDir(id: string): string;
  probeDuration(file: string): Promise<number>;
}

export interface PanelVideoInfo {
  id: string;
  title: string;
  channel: string;
  duration: number;
  extractor: string;
}

/**
 * R5: download one film for the analysis card, into the host library's cache layout
 * (`<cache>/<id>/info.json` + `source.mp4`, so frames, the player and follow-ups keep
 * working), with every yt-dlp call going through the shared `runYtDlpResilient`:
 *
 *   - a failure is a classified `source_unavailable` (rate limit, bot check, private,
 *     unavailable, geo, network) whose raw yt-dlp output is kept for "details";
 *   - a plain HTTP 429 waits once (reported through `onWait`, which the card shows as
 *     "retrying in N s") and tries again - one retry for the whole fetch; a bot check
 *     is never retried;
 *   - browser cookies are passed ONLY when the user set
 *     OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER or OMNIWATCH_YTDLP_COOKIES.
 *
 * Same steps as the host's `fetchVideo` otherwise (480p sort, mp4 merge, ffprobe only
 * when the extractor reported no duration). `--no-warnings` is dropped on purpose: the
 * warnings (429, PO token) are part of why a download failed.
 */
export async function downloadForPanel(
  tools: HostDownloadTools,
  url: string,
  options: { onWait?: (wait: SourceWait) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<{ info: PanelVideoInfo; src: string }> {
  const env = options.env ?? process.env;
  const cookies = ytDlpCookieArgs(env);
  const budget = createYtDlpRetryBudget(1);
  const ytDlp = (args: string[], timeoutMs?: number) => runYtDlpResilient([...cookies, ...args], {
    run: (all) => tools.run("yt-dlp", all, timeoutMs),
    url,
    budget,
    retrySeconds: ytDlpRetrySeconds(env),
    onWait: options.onWait,
  });

  await tools.cleanup();
  const dir = tools.videoDir(tools.cacheKey(url));
  const infoFile = join(dir, "info.json");
  const src = join(dir, "source.mp4");
  let info: PanelVideoInfo;

  if (existsSync(infoFile) && existsSync(src)) {
    info = JSON.parse(await readFile(infoFile, "utf8")) as PanelVideoInfo;
    const now = new Date();
    await utimes(infoFile, now, now); // keep a video that is still being asked about alive
  } else {
    const raw = JSON.parse(await ytDlp(["-J", "--no-playlist", url], 180_000)) as Record<string, unknown>;
    info = {
      id: basename(dir),
      title: String(raw.title || "?"),
      channel: String(raw.channel || raw.uploader || "?"),
      duration: Math.round(Number(raw.duration) || 0),
      extractor: String(raw.extractor_key || ""),
    };
    await mkdir(dir, { recursive: true });
    await writeFile(infoFile, JSON.stringify(info));
  }
  if (!existsSync(src)) {
    await ytDlp(["--no-playlist", "-q", "-N", "8",
      "-S", "res:480", "-f", "bv*+ba/b",
      "--merge-output-format", "mp4", "-o", src, url]);
  }
  if (!info.duration) {
    const probed = await tools.probeDuration(src);
    if (probed) {
      info = { ...info, duration: probed };
      await writeFile(infoFile, JSON.stringify(info));
    }
  }
  return { info, src };
}

/** Sync durable view used by `getJob`; the richer async view lives in the jobs handler. */
function durableJobView(store: StorePort, id: string, live: LiveProgress | null = null): Job | null {
  const operation = store.getOperation(id);
  if (!operation) return null;
  const buffer = store.getBuffer(id)?.result ?? null;
  const running = operation.state === "pending" || operation.state === "running";
  const done = operation.state === "delivered" || operation.state === "result_ready";
  // R5: the same honest stage as the card (live event, else the journal); never
  // "watch" for a download and never "answer" for a failure.
  const startedAttempts = store.listAttempts(id).filter((a) => a.phase === "started" || a.phase === "response").length;
  const stage = cardProgress({ state: operation.state, startedAttempts, live }).stage;
  return {
    id,
    operationId: id,
    kind: "analysis",
    state: done ? "done" : running ? "running" : "error",
    startedAt: Date.parse(operation.createdAt) || Date.now(),
    ...(done ? {} : { error: operation.errorMessage ?? undefined }),
    progress: { stage, ...(buffer ? { text: buffer.content } : {}) },
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
