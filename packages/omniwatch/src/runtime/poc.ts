/**
 * Runtime wiring (T3 / D5).
 *
 * The runtime orchestrates core + store + memory: it owns the process lifecycle and
 * the durable state, while the analysis engine, the source adapters and the host
 * knowledge library stay behind their contracts. This module is the one place that
 * turns a *non-secret* configuration file (or an injected object for tests) into a
 * `RuntimeDeps` bundle.
 *
 * Secrets never reach argv, SQLite or the config file: the file names environment
 * variables (`apiKeyEnv`, `apiBaseUrlEnv`) and the values are resolved inside the
 * process that already has them.
 *
 * Kinds supported here:
 *   - model:  `stub` (deterministic, used by `npm run poc` and the process tests),
 *             `openai` (the shared provider port; needs a key at runtime);
 *   - source: `fixture` (no download; synthetic local paths) or `host` (the caller
 *             injects a real `SourcePort`, e.g. the Agent OS yt-dlp/ffmpeg adapter);
 *   - memory: the caller injects the host adapter, otherwise a small local file
 *             library under `memoryRoot` is used (the standalone shape).
 *
 * Anything that cannot be resolved fails with `missing_config` *before* a paid call
 * or a download, so the shell can report the reason instead of guessing.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createOpenAiModelPort } from "../analysis/index.ts";
import { OmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import type {
  AttemptSink,
  ClockPort,
  ConfigPort,
  LoggerPort,
  MemoryAnswer,
  MemoryPort,
  MemorySearchHit,
  MemoryWriteResult,
  ModelCallRequest,
  ModelCallResponse,
  ModelPort,
  SourcePort,
  StorePort,
} from "../contracts/ports.ts";
import type {
  AnalysisResult,
  ErrorClass,
  MemoryRef,
  Usage,
} from "../contracts/types.ts";
import { createSourceRegistry } from "../sources/index.ts";
import type { PreparedMedia } from "../sources/registry.ts";
import { openSqliteStore } from "../storage/index.ts";

/** Versioned protocol shared by the CLI, the progress stream and the report read. */
export const RUNTIME_PROTOCOL = "omniwatch.runtime.v1";

export const RUNTIME_CONFIG_PROTOCOL = "omniwatch.runtime-config.v1";

export const STATE_DB_FILE = "state.sqlite";

/* ---------------------------------------------------------------- config ---- */

export interface StubModelConfig {
  kind: "stub";
  /** Deterministic answer text; `{part}` is replaced by the part index. */
  reply?: string;
  /** Append one JSON line per paid call here, so tests can count cross-process. */
  callsFile?: string;
  usage?: Partial<Usage>;
  /** `false` returns an answer without a completion marker (D9 unknown path). */
  completed?: boolean;
  /** Force a provider failure instead of an answer. */
  errorClass?: ErrorClass | null;
  /** Delay for the first call, and for every later call. Real ms, not injected. */
  delayMs?: number;
  delayMsAfterFirst?: number;
}

export interface OpenAiModelConfig {
  kind: "openai";
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

export type ModelConfig = StubModelConfig | OpenAiModelConfig;

export interface FixtureSourceConfig {
  kind: "fixture";
  title?: string;
  channel?: string | null;
  durationSeconds?: number;
  extractor?: string;
  mediaFile?: string;
}

export interface HostSourceConfig {
  kind: "host";
}

export type SourceConfig = FixtureSourceConfig | HostSourceConfig;

export interface RuntimeConfigFile {
  protocol?: string;
  dataDir?: string;
  memoryRoot?: string;
  language?: string;
  modelName?: string;
  maxFramesPerPart?: number;
  cacheHours?: number;
  /** Environment variable names; the config file never carries the secret itself. */
  apiKeyEnv?: string;
  apiBaseUrlEnv?: string;
  /**
   * Effective non-secret endpoint the shell already resolved (for example the
   * documented provider default when the user configured only a key). The runtime
   * prefers the environment variable when the user set one explicitly, then this
   * value, so a deployment default cannot be lost between the shell and the worker.
   */
  apiBaseUrlDefault?: string | null;
  model?: ModelConfig;
  source?: SourceConfig;
}

export interface RuntimeWiringOptions {
  /** Explicit data directory; wins over the config file. */
  dataDir?: string;
  configPath?: string;
  config?: RuntimeConfigFile;
  clock?: ClockPort;
  logger?: LoggerPort;
  store?: StorePort;
  source?: SourcePort;
  model?: ModelPort;
  memory?: MemoryPort;
  /** Overrides the SQLite takeover window; tests use a short one. */
  ownerStaleAfterMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export interface RuntimeWiring {
  deps: RuntimeBundle;
  store: StorePort;
  dataDir: string;
  configPath: string | null;
  configFile: RuntimeConfigFile;
  close(): void;
}

/** The ports one worker needs, plus the resolved data directory. */
export interface RuntimeBundle {
  clock: ClockPort;
  logger: LoggerPort;
  config: ConfigPort;
  store: StorePort;
  source: SourcePort;
  model: ModelPort;
  memory: MemoryPort;
}

export function missingConfig(message: string, actionLabel = "uzupelnij konfiguracje OmniWatch"): OmniWatchError {
  return new OmniWatchError("missing_config", message, {
    action: { label: actionLabel, kind: "fix_config" },
  });
}

/* ----------------------------------------------------------------- paths ---- */

function invalidPath(message: string): OmniWatchError {
  return new OmniWatchError("invalid_input", message, {
    action: { label: "sprawdz sciezke lokalna", kind: "none" },
  });
}

const CASE_INSENSITIVE_PATHS = process.platform === "darwin" || process.platform === "win32";

function samePathPart(a: string, b: string): boolean {
  return CASE_INSENSITIVE_PATHS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `candidate` is `root` itself or lives under it (lexically). */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  const first = rel.split(sep)[0] ?? "";
  return !samePathPart(first, "..");
}

function realpathOrNull(target: string): string | null {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

export interface ConfinedPathOptions {
  createRoot?: boolean;
  mustExist?: boolean;
  allowRoot?: boolean;
}

/**
 * D11: a file read must verify the *real* location stays inside the allowed
 * directory, symlinks included. The candidate is always relative; absolute input
 * and `..` traversal are refused before any filesystem call.
 */
export function resolveConfinedPath(
  rootDir: string,
  candidate: string,
  options: ConfinedPathOptions = {},
): string {
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw invalidPath("Brak katalogu bazowego dla sciezki lokalnej.");
  }
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw invalidPath("Brak sciezki lokalnej do sprawdzenia.");
  }
  if (isAbsolute(candidate)) {
    throw invalidPath("Sciezka lokalna musi byc wzgledna wobec skonfigurowanego katalogu.");
  }
  if (options.createRoot) mkdirSync(rootDir, { recursive: true });

  const rootReal = realpathOrNull(rootDir);
  if (!rootReal) {
    throw invalidPath(`Katalog bazowy nie istnieje: ${rootDir}`);
  }

  const lexical = resolve(rootReal, candidate);
  const insideRoot =
    samePathPart(lexical, rootReal) ? options.allowRoot === true : isPathInside(rootReal, lexical);
  if (!insideRoot) {
    throw invalidPath(`Sciezka "${candidate}" wychodzi poza dozwolony katalog.`);
  }

  // Walk up to the first existing ancestor and resolve *its* real path: that is the
  // step which catches a symlink pointing outside the allowed directory.
  let ancestor = lexical;
  const trailing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    trailing.unshift(basename(ancestor));
    ancestor = parent;
  }
  const ancestorReal = realpathOrNull(ancestor);
  if (!ancestorReal) {
    throw invalidPath(`Nie mozna ustalic rzeczywistej sciezki: ${ancestor}`);
  }
  const resolvedReal = trailing.length > 0 ? join(ancestorReal, ...trailing) : ancestorReal;
  const insideReal =
    samePathPart(resolvedReal, rootReal) ? options.allowRoot === true : isPathInside(rootReal, resolvedReal);
  if (!insideReal) {
    throw invalidPath(
      `Sciezka "${candidate}" prowadzi (m.in. przez dowiazanie symboliczne) poza dozwolony katalog.`,
    );
  }
  if (options.mustExist && !existsSync(resolvedReal)) {
    throw invalidPath(`Sciezka nie istnieje: ${candidate}`);
  }
  return resolvedReal;
}

/**
 * Browser/Hermes supplied identifiers (`run_...`, `op_...`) must never be joined
 * into a filesystem path without this check.
 */
export function assertSafeId(value: unknown, label = "id", maxLength = 200): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OmniWatchError("invalid_input", `Brak wartosci ${label}.`);
  }
  const id = value.trim();
  if (id.length > maxLength) {
    throw new OmniWatchError("invalid_input", `${label} jest zbyt dlugie (limit ${maxLength} znakow).`);
  }
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new OmniWatchError("invalid_input", `${label} zawiera niedozwolone znaki sciezki.`);
  }
  if (!/^[\w.:@+-]+$/u.test(id)) {
    throw new OmniWatchError("invalid_input", `${label} zawiera niedozwolone znaki.`);
  }
  return id;
}

/* ----------------------------------------------------------------- clock ---- */

export function systemClock(): ClockPort {
  return {
    now: () => new Date(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/* ---------------------------------------------------------------- logger ---- */

const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi },
];

/**
 * D11: logs are size bounded and never carry API keys, signed upload URLs or Vault
 * content. Everything written by the runtime goes through this redaction.
 */
export function redactSecrets(value: string): string {
  let out = value;
  for (const { pattern } of REDACTION_PATTERNS) {
    out = out.replace(pattern, "[ukryte]");
  }
  return out;
}

const LOG_VALUE_LIMIT = 400;

function renderFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    let rendered: string;
    if (value === null || value === undefined) rendered = String(value);
    else if (typeof value === "string") rendered = value;
    else {
      try {
        rendered = JSON.stringify(value);
      } catch {
        rendered = "[nie-serializowalne]";
      }
    }
    if (rendered.length > LOG_VALUE_LIMIT) rendered = `${rendered.slice(0, LOG_VALUE_LIMIT)}...`;
    parts.push(`${key}=${rendered}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export interface LoggerOptions {
  /** Where log lines go. Defaults to stderr: stdout carries the progress protocol. */
  sink?: (line: string) => void;
  level?: "info" | "warn" | "error";
}

export function createLogger(options: LoggerOptions = {}): LoggerPort {
  const sink =
    options.sink ??
    ((line: string): void => {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // stderr gone (the parent closed the pipe): the work continues regardless.
      }
    });
  const threshold = options.level === "error" ? 3 : options.level === "warn" ? 2 : 1;
  const write = (level: number, name: string, message: string, fields?: Record<string, unknown>): void => {
    if (level < threshold) return;
    sink(redactSecrets(`omniwatch.${name} ${message}${renderFields(fields)}`));
  };
  return {
    info: (message, fields) => write(1, "info", message, fields),
    warn: (message, fields) => write(2, "warn", message, fields),
    error: (message, fields) => write(3, "error", message, fields),
  };
}

/* ----------------------------------------------------------------- model ---- */

export interface StubModelOptions extends Omit<StubModelConfig, "kind"> {
  name?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Deterministic model used by the PoC and by the real-process tests. It is a real
 * `ModelPort`: it answers through the attempt sink and records every paid call to an
 * append-only file, so two processes can be checked for exactly one call.
 */
export function createStubModel(options: StubModelOptions = {}): ModelPort {
  let calls = 0;
  return {
    modelName: options.name ?? "stub-model",
    async call(request: ModelCallRequest, _sink: AttemptSink): Promise<ModelCallResponse> {
      calls += 1;
      if (options.callsFile) {
        try {
          appendFileSync(
            options.callsFile,
            `${JSON.stringify({
              operationId: request.operationId,
              attemptId: request.attemptId,
              partIndex: request.partIndex,
              call: calls,
              at: new Date().toISOString(),
            })}\n`,
          );
        } catch (error) {
          throw new OmniWatchError("storage_unavailable", `Nie mozna zapisac licznika wywolan: ${String(error)}`);
        }
      }
      const delay = calls === 1 ? options.delayMs ?? 0 : options.delayMsAfterFirst ?? options.delayMs ?? 0;
      if (delay > 0) await sleep(delay);
      if (options.errorClass) {
        throw new OmniWatchError(options.errorClass, `stub model zglasza ${options.errorClass}`);
      }
      const reply = (options.reply ?? "Streszczenie stub: material zostal przeczytany.").replace(
        "{part}",
        String(request.partIndex),
      );
      const completed = options.completed !== false;
      return {
        text: completed ? reply : `${reply} (bez znacznika konca)`,
        usage: {
          inputTokens: options.usage?.inputTokens ?? 120,
          outputTokens: options.usage?.outputTokens ?? 60,
          costUsd: options.usage?.costUsd ?? 0.002,
          costKnown: options.usage?.costKnown ?? true,
        },
        completed,
      };
    },
  };
}

/* ---------------------------------------------------------------- source ---- */

export interface FixtureSourceOptions extends Omit<FixtureSourceConfig, "kind"> {
  cacheHours?: () => number;
}

/**
 * Study-case source: the same `SourceRegistry` the host uses, with a media tool port
 * that never downloads. `slice()` returns synthetic part paths, which is enough for
 * the stub model and keeps the process tests offline.
 */
export function createFixtureSource(options: FixtureSourceOptions = {}): SourcePort {
  const prepared: PreparedMedia = {
    localPath: options.mediaFile ?? join(process.cwd(), "fixture-media.mp4"),
    title: options.title ?? "Syntetyczny material OmniWatch",
    channel: options.channel ?? null,
    durationSeconds: options.durationSeconds ?? 240,
    extractor: options.extractor ?? "fixture",
    publishedAt: null,
  };
  return createSourceRegistry({
    media: {
      cached: async () => null,
      fetch: async () => prepared,
      slice: async (request) => `${request.localPath}#part${request.index}`,
    },
    cacheHours: options.cacheHours,
  });
}

/* ---------------------------------------------------------------- memory ---- */

const ANALYSIS_DIR = "Analyses";
const META_PREFIX = "<!-- omniwatch:analysis ";
const META_SUFFIX = " -->";

export interface LocalMemoryOptions {
  root: string;
}

function analysisFileName(analysisId: string): string {
  return `${assertSafeId(analysisId, "analysisId")}.md`;
}

/**
 * Standalone-shaped knowledge library: one Markdown note per analysis under
 * `<root>/Analyses`. The Agent OS Vault adapter (T4) implements the same port; this
 * one exists so the PoC and the runtime tests can prove the delivery path end to end.
 *
 * The note keeps its machine-readable metadata in a first-line HTML comment, so
 * `readAnalysis` can rebuild the exact `AnalysisResult` (needed by the delivery
 * adoption path) while the body stays ordinary Markdown.
 */
export function createLocalMemory(options: LocalMemoryOptions): MemoryPort {
  const root = resolve(options.root);
  const dir = join(root, ANALYSIS_DIR);

  function relativePathFor(analysisId: string): string {
    return `${ANALYSIS_DIR}/${analysisFileName(analysisId)}`;
  }

  function absolutePathFor(analysisId: string): string {
    return resolveConfinedPath(root, relativePathFor(analysisId), { createRoot: true });
  }

  function memoryRefFor(result: AnalysisResult): MemoryRef {
    return {
      analysisId: result.analysisId,
      adapter: "local-files",
      relativePath: relativePathFor(result.analysisId),
      anchor: null,
      fingerprint: `${result.analysisKey.slice(0, 16)}:${result.content.length}`,
    };
  }

  function serialize(result: AnalysisResult): string {
    return `${META_PREFIX}${JSON.stringify(result)}${META_SUFFIX}\n${result.content}\n`;
  }

  function parseNote(text: string): AnalysisResult | null {
    if (!text.startsWith(META_PREFIX)) return null;
    const end = text.indexOf(META_SUFFIX);
    if (end < 0) return null;
    const payload = text.slice(META_PREFIX.length, end);
    try {
      return JSON.parse(payload) as AnalysisResult;
    } catch {
      return null;
    }
  }

  const memory: MemoryPort = {
    async writeAnalysis(result: AnalysisResult): Promise<MemoryWriteResult> {
      mkdirSync(dir, { recursive: true });
      const target = absolutePathFor(result.analysisId);
      if (existsSync(target)) {
        const existing = parseNote(readFileSync(target, "utf8"));
        if (existing && existing.analysisKey === result.analysisKey && existing.content === result.content) {
          return { memoryRef: memoryRefFor(result), reused: true };
        }
        throw new OmniWatchError(
          "delivery_conflict",
          `Notatka ${result.analysisId} istnieje z inna trescia; nie nadpisujemy pliku`,
          { action: { label: "rozwiaz konflikt notatki", kind: "check_operation" } },
        );
      }
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      try {
        writeFileSync(tmp, serialize(result), { encoding: "utf8" });
        renameSync(tmp, target);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw toOmniWatchError(error, "storage_unavailable");
      }
      return { memoryRef: memoryRefFor(result), reused: false };
    },

    async readAnalysis(analysisId: string) {
      const target = absolutePathFor(analysisId);
      if (!existsSync(target)) return null;
      const result = parseNote(readFileSync(target, "utf8"));
      if (!result) return null;
      return { result, memoryRef: memoryRefFor(result) };
    },

    async searchAnalyses(query: string, limit = 20): Promise<MemorySearchHit[]> {
      const needle = query.trim().toLowerCase();
      if (needle === "" || !existsSync(dir)) return [];
      const hits: MemorySearchHit[] = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const text = readFileSync(join(dir, name), "utf8");
        const result = parseNote(text);
        if (!result) continue;
        const haystack = `${result.title}\n${result.content}`.toLowerCase();
        const at = haystack.indexOf(needle);
        if (at < 0) continue;
        hits.push({
          analysisId: result.analysisId,
          title: result.title,
          excerpt: result.content.slice(Math.max(0, at - 60), at + 140),
          relativePath: relativePathFor(result.analysisId),
        });
        if (hits.length >= limit) break;
      }
      return hits;
    },

    async answerFromAnalyses(question: string, opts?: { limit?: number }): Promise<MemoryAnswer> {
      const hits = await memory.searchAnalyses(question, opts?.limit ?? 5);
      if (hits.length === 0) {
        return { text: "Nie znalazlem tego w analizach.", refs: [], notFound: true };
      }
      const refs: MemoryRef[] = [];
      for (const hit of hits) {
        const found = await memory.readAnalysis(hit.analysisId);
        if (found) refs.push(found.memoryRef);
      }
      return {
        text: hits.map((hit) => `${hit.title}: ${hit.excerpt}`).join("\n\n"),
        refs,
        notFound: false,
      };
    },
  };
  return memory;
}

/* ----------------------------------------------------------------- file ----- */

export function readRuntimeConfigFile(configPath: string): RuntimeConfigFile {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    throw missingConfig(`Nie mozna odczytac pliku konfiguracji ${configPath}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw missingConfig(`Plik konfiguracji ${configPath} nie jest poprawnym JSON: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw missingConfig(`Plik konfiguracji ${configPath} nie zawiera obiektu konfiguracji.`);
  }
  const config = parsed as RuntimeConfigFile;
  if (config.protocol && config.protocol !== RUNTIME_CONFIG_PROTOCOL) {
    throw missingConfig(
      `Plik konfiguracji ${configPath} deklaruje protokol "${config.protocol}"; ten runtime obsluguje "${RUNTIME_CONFIG_PROTOCOL}".`,
    );
  }
  return config;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback;
}

function configPort(
  file: RuntimeConfigFile,
  dataDir: string,
  configPath: string | null,
  environment: NodeJS.ProcessEnv,
): ConfigPort {
  const memoryRoot = file.memoryRoot ? resolve(file.memoryRoot) : join(dataDir, "knowledge");
  const apiKeyEnv = file.apiKeyEnv ?? "OMNIWATCH_API_KEY";
  const apiBaseUrlEnv = file.apiBaseUrlEnv ?? "OMNIWATCH_API_BASE";
  const apiBaseUrlDefault =
    typeof file.apiBaseUrlDefault === "string" && file.apiBaseUrlDefault.trim() !== ""
      ? file.apiBaseUrlDefault
      : null;
  return {
    dataDir,
    memoryRoot,
    language: file.language ?? "pl",
    modelName: file.modelName ?? "stub-model",
    apiKey: () => environment[apiKeyEnv] ?? null,
    apiBaseUrl: () => {
      const configured = environment[apiBaseUrlEnv];
      if (typeof configured === "string" && configured.trim() !== "") return configured;
      return apiBaseUrlDefault;
    },
    maxFramesPerPart: () => numberOr(file.maxFramesPerPart, 8),
    cacheHours: () => numberOr(file.cacheHours, 48),
    configPath: configPath ?? undefined,
  };
}

export function resolveRuntimeDataDir(options: RuntimeWiringOptions, file: RuntimeConfigFile): string {
  const explicit = options.dataDir ?? file.dataDir ?? options.environment?.OMNIWATCH_DATA_DIR;
  if (typeof explicit !== "string" || explicit.trim() === "") {
    throw missingConfig(
      "Brak katalogu danych OmniWatch. Podaj --data-dir, katalog w pliku konfiguracji albo OMNIWATCH_DATA_DIR.",
    );
  }
  return resolve(explicit);
}

export function resolveRuntimeConfigPath(options: RuntimeWiringOptions): string | null {
  const explicit = options.configPath ?? options.environment?.OMNIWATCH_CONFIG;
  return typeof explicit === "string" && explicit.trim() !== "" ? resolve(explicit) : null;
}

/**
 * Build the ports a worker runs with. Anything the caller injects wins over the
 * config file, which is what lets the Agent OS adapter and the tests share one path.
 */
export function createRuntimeWiring(options: RuntimeWiringOptions): RuntimeWiring {
  const environment = options.environment ?? process.env;
  const configPath = resolveRuntimeConfigPath(options);
  const file = options.config ?? (configPath ? readRuntimeConfigFile(configPath) : {});
  const dataDir = resolveRuntimeDataDir(options, file);
  const clock = options.clock ?? systemClock();
  const logger = options.logger ?? createLogger();
  const config = configPort(file, dataDir, configPath, environment);

  let ownedStore: StorePort | null = null;
  const store =
    options.store ??
    (() => {
      const opened = openSqliteStore({
        path: resolveConfinedPath(dataDir, STATE_DB_FILE, { createRoot: true }),
        ownerStaleAfterMs: options.ownerStaleAfterMs,
      });
      ownedStore = opened;
      return opened;
    })();

  const source = options.source ?? buildSource(file, config, logger);
  const model = options.model ?? buildModel(file, config, logger, environment);
  const memory = options.memory ?? createLocalMemory({ root: config.memoryRoot });

  return {
    deps: { clock, logger, config, store, source, model, memory },
    store,
    dataDir,
    configPath,
    configFile: file,
    close: () => {
      ownedStore?.close();
    },
  };
}

function buildSource(file: RuntimeConfigFile, config: ConfigPort, logger: LoggerPort): SourcePort {
  const source = file.source;
  if (!source || source.kind === "fixture") {
    const fixture = (source ?? { kind: "fixture" }) as FixtureSourceConfig;
    return createFixtureSource({
      ...fixture,
      cacheHours: () => config.cacheHours(),
    });
  }
  if (source.kind === "host") {
    throw missingConfig(
      "Konfiguracja wskazuje zrodlo hosta, ale runtime nie otrzymal adaptera zrodla (SourcePort).",
      "przekaz adapter zrodla hosta",
    );
  }
  logger.warn("omniwatch.runtime.source.unknown", { kind: String((source as { kind?: unknown }).kind) });
  throw missingConfig("Nieznany rodzaj zrodla w konfiguracji OmniWatch.");
}

function buildModel(file: RuntimeConfigFile, config: ConfigPort, logger: LoggerPort, environment: NodeJS.ProcessEnv): ModelPort {
  const model = file.model;
  if (!model || model.kind === "stub") {
    const stub = (model ?? { kind: "stub" }) as StubModelConfig;
    return createStubModel({ ...stub, name: config.modelName });
  }
  if (model.kind === "openai") {
    return createOpenAiModelPort({
      config,
      env: environment,
      timeoutMs: model.timeoutMs,
      idleTimeoutMs: model.idleTimeoutMs,
    });
  }
  logger.warn("omniwatch.runtime.model.unknown", { kind: String((model as { kind?: unknown }).kind) });
  throw missingConfig("Nieznany rodzaj modelu w konfiguracji OmniWatch.");
}
