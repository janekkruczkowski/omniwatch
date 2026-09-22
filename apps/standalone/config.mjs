/**
 * Beta-compatible standalone configuration (T7 / D2).
 *
 * The released Python beta read `.env` next to its own scripts and let the process
 * environment win (`os.environ.setdefault`). That precedence, the file location and
 * the six supported names are preserved here; the values are then handed to the
 * shared runtime as a *non-secret* config document (the key itself stays in the
 * environment, never in argv, SQLite or a config file).
 *
 * `OMNI_PART_MINUTES` is read and reported, but it is inert: the beta split work by
 * `OMNI_MAX_FRAMES` (duration x fps), and the shared split policy does the same. The
 * migration documentation states that divergence instead of pretending the option
 * ever worked.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Beta defaults, copied verbatim so an empty `.env` behaves like the released app. */
export const DEFAULT_API_BASE = "https://dashscope-intl.aliyuncs.com";
export const DEFAULT_MODEL = "qwen3.8-omni-flash";
export const DEFAULT_LANG = "en";
export const DEFAULT_CACHE_HOURS = 48;
export const DEFAULT_MAX_FRAMES = 2400;
export const MIN_MAX_FRAMES = 300;
export const DEFAULT_PORT = 8765;

export const ENV_FILE_NAME = ".env";
export const RUNTIME_CONFIG_FILE_NAME = "runtime-config.json";
export const API_KEY_ENV = "DASHSCOPE_API_KEY";
export const API_BASE_ENV = "DASHSCOPE_API";

/** Names the beta documented. `OMNI_PART_MINUTES` is listed because it must be reported as inert. */
export const BETA_ENV_NAMES = [
  API_KEY_ENV,
  API_BASE_ENV,
  "OMNI_MODEL",
  "OMNI_LANG",
  "OMNI_CACHE_HOURS",
  "OMNI_MAX_FRAMES",
  "OMNI_PART_MINUTES",
];

/** Standalone-only names (not part of the beta `.env` contract). */
export const STANDALONE_ENV_NAMES = ["OMNIWATCH_DATA_DIR", "OMNIWATCH_CONFIG", "OMNIWATCH_PORT", "OMNIWATCH_APP_ROOT"];

/**
 * The beta parser: `k, _, v = line.partition("=")`, skip blank/comment lines, keep the
 * raw value (no quote stripping, no escapes), and the *first* occurrence wins because
 * every line went through `os.environ.setdefault`.
 */
export function parseEnvText(text) {
  const values = Object.create(null);
  for (const line of String(text).split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    if (key === "" || key.startsWith("#")) continue;
    if (key in values) continue;
    values[key] = line.slice(at + 1).trim();
  }
  return values;
}

export function envFilePath(appRoot) {
  return path.join(appRoot, ENV_FILE_NAME);
}

/** Read `.env` next to the launchers. A missing file is not an error. */
export function readEnvFile(appRoot) {
  const file = envFilePath(appRoot);
  if (!existsSync(file)) return { path: file, exists: false, values: Object.create(null) };
  return { path: file, exists: true, values: parseEnvText(readFileSync(file, "utf8")) };
}

function pick(name, fileValues, env) {
  // Process environment wins even when it is an empty string: the beta's
  // `os.environ.setdefault` did exactly that.
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (Object.prototype.hasOwnProperty.call(fileValues, name)) return fileValues[name];
  return undefined;
}

function stringValue(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

function numberValue(raw, fallback) {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve one standalone configuration from `.env` + process environment.
 * Never throws for a missing key: the HTTP/CLI layer turns that into a visible error
 * before any download or model call, while reading old analyses keeps working.
 */
export function loadStandaloneConfig(options = {}) {
  const env = options.env ?? process.env;
  const appRoot = path.resolve(
    options.appRoot ?? env.OMNIWATCH_APP_ROOT ?? path.dirname(new URL(import.meta.url).pathname),
  );
  const file = readEnvFile(appRoot);
  const fileValues = file.values;

  const apiKey = stringValue(pick(API_KEY_ENV, fileValues, env), null);
  const apiBase = stringValue(pick(API_BASE_ENV, fileValues, env), DEFAULT_API_BASE);
  const model = stringValue(pick("OMNI_MODEL", fileValues, env), DEFAULT_MODEL);
  const language = stringValue(pick("OMNI_LANG", fileValues, env), DEFAULT_LANG);
  const cacheHours = Math.max(0, numberValue(pick("OMNI_CACHE_HOURS", fileValues, env), DEFAULT_CACHE_HOURS));
  const maxFrames = Math.max(
    MIN_MAX_FRAMES,
    Math.trunc(numberValue(pick("OMNI_MAX_FRAMES", fileValues, env), DEFAULT_MAX_FRAMES)),
  );
  const partMinutesRaw = pick("OMNI_PART_MINUTES", fileValues, env);

  const dataDir = path.resolve(
    stringValue(pick("OMNIWATCH_DATA_DIR", fileValues, env), path.join(appRoot, "data")),
  );
  const runtimeConfigPath = path.resolve(
    stringValue(pick("OMNIWATCH_CONFIG", fileValues, env), path.join(dataDir, RUNTIME_CONFIG_FILE_NAME)),
  );
  const port = Math.trunc(numberValue(pick("OMNIWATCH_PORT", fileValues, env), DEFAULT_PORT));

  return {
    appRoot,
    envFile: file.path,
    envFileExists: file.exists,
    /**
     * The effective environment the RUNTIME must resolve secrets from: process
     * environment first (the beta's precedence), then the `.env` next to the
     * scripts. Passing only `process.env` lost a key that lived in `.env` and made
     * the runtime report a missing key for a correctly configured installation.
     * Never serialised to the runtime config FILE: that file carries names only.
     */
    effectiveEnv: { ...fileValues, ...env },
    apiKey,
    apiKeyPresent: typeof apiKey === "string" && apiKey.trim() !== "",
    apiBase,
    model,
    language,
    cacheHours,
    maxFrames,
    /** Read but never used: the beta split by frames, not minutes. */
    partMinutes: partMinutesRaw === undefined ? null : numberValue(partMinutesRaw, null),
    partMinutesInert: true,
    dataDir,
    memoryRoot: path.join(dataDir, "knowledge"),
    cacheDir: path.join(dataDir, "cache"),
    runtimeConfigPath,
    port: port > 0 && port < 65536 ? port : DEFAULT_PORT,
    /** Legacy beta layout, next to the copied scripts. */
    legacyCacheDir: path.join(appRoot, ".cache"),
    legacySummariesDir: path.join(appRoot, "summaries"),
  };
}

/** Diagnostics without secrets: never print the key itself. */
export function describeConfig(config) {
  return {
    appRoot: config.appRoot,
    envFile: config.envFile,
    envFileExists: config.envFileExists,
    apiKeyPresent: config.apiKeyPresent,
    apiBase: config.apiBase,
    model: config.model,
    language: config.language,
    cacheHours: config.cacheHours,
    maxFrames: config.maxFrames,
    partMinutes: config.partMinutes,
    partMinutesInert: config.partMinutesInert,
    dataDir: config.dataDir,
    runtimeConfigPath: config.runtimeConfigPath,
    port: config.port,
  };
}

/**
 * The shared runtime reads this JSON file. It names environment variables instead of
 * carrying the secret, so the file is safe to print and to keep next to the data.
 */
export function runtimeConfigDocument(config) {
  return {
    protocol: "omniwatch.runtime-config.v1",
    dataDir: config.dataDir,
    memoryRoot: config.memoryRoot,
    language: config.language,
    modelName: config.model,
    maxFramesPerPart: config.maxFrames,
    cacheHours: config.cacheHours,
    apiKeyEnv: API_KEY_ENV,
    apiBaseUrlEnv: API_BASE_ENV,
    /**
     * The endpoint the user effectively has: an explicit env/file value, or the
     * documented provider default. Without this the runtime only saw a variable
     * NAME and failed with "Brak adresu API modelu analizy" when the user set just
     * the key - the released beta used DEFAULT_API_BASE in exactly that case.
     */
    apiBaseUrlDefault: config.apiBase,
    model: { kind: "openai", timeoutMs: 600000, idleTimeoutMs: 120000 },
  };
}

/** Write the runtime config for the shared runtime (no secrets inside). */
export function writeRuntimeConfigFile(config) {
  const document = runtimeConfigDocument(config);
  mkdirSync(path.dirname(config.runtimeConfigPath), { recursive: true });
  const body = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(config.runtimeConfigPath, body, "utf8");
  return config.runtimeConfigPath;
}

/** The beta's language fallback: an unknown code answers in the configured language. */
export function resolveLanguage(requested, available, fallback) {
  if (typeof requested === "string" && available.includes(requested)) return requested;
  return available.includes(fallback) ? fallback : "en";
}

/** The beta mapped every mode except `teardown` to a question/summary ask. */
export function resolveMode(requested) {
  return requested === "teardown" ? "teardown" : "summary";
}
