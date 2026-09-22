/**
 * T4 / D7: host wiring for the Agent OS memory adapter.
 *
 * Everything the adapter needs comes from injected configuration, so a stock Agent OS
 * host with its own directory convention works without patching this module:
 *
 *   vaultRoot      -> explicit option, then the host config file, then env, then the
 *                     conventional Vault locations under the injected home directory;
 *   analysesDir    -> explicit option or the host config file (default
 *                     `OmniWatch/Analyses`);
 *   model          -> an injected `HostModelPort` (or a factory) for grounded answers.
 *
 * Nothing here guesses the author's private Vault: the default candidates are the
 * host's own conventional paths, and a *configured* root that is missing is an error,
 * never a silent fallback to a different library.
 *
 * The installer gets two entry points:
 *   - `inspectHostRoot(config)` never throws; it reports what is missing or unwritable;
 *   - `createOmniWatchHost(config)` fails loudly when the root is missing or unwritable
 *     and otherwise exposes the `MemoryPort` plus `ensureReady()`.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { OmniWatchError } from "../../../packages/omniwatch/src/contracts/errors.ts";
import type { MemoryPort } from "../../../packages/omniwatch/src/contracts/ports.ts";

import {
  createVaultMemory,
  DEFAULT_ANALYSES_DIR,
  normalizeAnalysesDir,
  type HostModelPort,
} from "./omniwatchMemory.ts";

/** Default env var the host itself uses for an explicit Vault root. */
export const DEFAULT_VAULT_ENV = "AGENTIC_OS_VAULT";

/** Default Agent OS config file, relative to the injected home directory. */
export const DEFAULT_CONFIG_PATH = ".agentic-os/config.json";

export interface HostConfig {
  /** Highest priority root; a configured-but-missing root is an error. */
  vaultRoot?: string | null;
  /** Analyses directory inside the root; default `OmniWatch/Analyses`. */
  analysesDir?: string | null;
  /** Host config file (Agent OS `config.json`); default `<home>/.agentic-os/config.json`. */
  configPath?: string | null;
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined> | null;
  /** Home directory used for config and conventional Vault paths. */
  homeDir?: string | null;
  /** Env var holding an explicit root; default `AGENTIC_OS_VAULT`. */
  envVarName?: string | null;
  /** Injected host model for `answerFromAnalyses`. */
  model?: HostModelPort | null;
  /** Lazily resolved host model, e.g. the host's own model client. */
  modelFactory?: (() => HostModelPort | null) | null;
}

export type VaultRootSource = "explicit" | "config" | "env" | "default";

export interface ResolvedVaultRoot {
  root: string;
  source: VaultRootSource;
  /** Every candidate considered, in order, for the installer's report. */
  candidates: string[];
}

export interface HostIssue {
  code: string;
  message: string;
}

export interface HostCapabilities {
  vaultRoot: string | null;
  vaultRootSource: VaultRootSource | null;
  rootExists: boolean;
  rootIsDirectory: boolean;
  rootWritable: boolean;
  analysesDir: string;
  analysesPath: string | null;
  analysesWritable: boolean;
  answerModel: boolean;
  modelName: string | null;
  issues: HostIssue[];
  /** True when memory can be read and written; answering still needs a model. */
  ok: boolean;
}

export interface OmniWatchHost {
  vaultRoot: string;
  analysesDir: string;
  memory: MemoryPort;
  modelName: string | null;
  /** Re-reads the current state; never throws. */
  capabilities(): HostCapabilities;
  /** Creates the analyses directory and probes a real write; throws on failure. */
  ensureReady(): HostCapabilities;
}

interface HostConfigFile {
  vaultRoot?: unknown;
  analysesDir?: unknown;
  omniwatchAnalysesDir?: unknown;
  vaultEnvVar?: unknown;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readHostConfigFile(path: string): HostConfigFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as HostConfigFile) : null;
  } catch {
    return null;
  }
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Nearest existing ancestor of a path (the one a `mkdir -p` would need to write). */
function nearestExistingAncestor(path: string): string | null {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolves the Vault root. A root that was configured explicitly (option, config file
 * or env) but does not exist throws: falling back to another directory would silently
 * point the library at a different knowledge base (D7).
 */
export function resolveVaultRoot(config: HostConfig = {}): ResolvedVaultRoot {
  const home = nonEmpty(config.homeDir) ?? homedir();
  const env = config.env ?? process.env;
  const candidates: string[] = [];

  const explicit = nonEmpty(config.vaultRoot);
  if (explicit) {
    candidates.push(explicit);
    if (!existsSync(explicit)) {
      throw new OmniWatchError(
        "missing_config",
        `Skonfigurowany vaultRoot nie istnieje: ${explicit}. Nie podstawiamy innego katalogu pamieci.`,
        { action: { label: "popraw vaultRoot", kind: "fix_config" } },
      );
    }
    return { root: resolve(explicit), source: "explicit", candidates };
  }

  const configPath = resolve(
    nonEmpty(config.configPath) ?? join(home, DEFAULT_CONFIG_PATH),
  );
  const file = existsSync(configPath) ? readHostConfigFile(configPath) : null;
  const configured = nonEmpty(file?.vaultRoot);
  if (configured) {
    candidates.push(configured);
    if (!existsSync(configured)) {
      throw new OmniWatchError(
        "missing_config",
        `vaultRoot z ${configPath} nie istnieje: ${configured}. Nie podstawiamy innego katalogu pamieci.`,
        { action: { label: "popraw vaultRoot", kind: "fix_config" } },
      );
    }
    return { root: resolve(configured), source: "config", candidates };
  }

  const envVarName = nonEmpty(config.envVarName) ?? nonEmpty(file?.vaultEnvVar) ?? DEFAULT_VAULT_ENV;
  const fromEnv = nonEmpty(env[envVarName]);
  if (fromEnv) {
    candidates.push(fromEnv);
    if (!existsSync(fromEnv)) {
      throw new OmniWatchError(
        "missing_config",
        `${envVarName} wskazuje nieistniejacy katalog pamieci: ${fromEnv}.`,
        { action: { label: "popraw vaultRoot", kind: "fix_config" } },
      );
    }
    return { root: resolve(fromEnv), source: "env", candidates };
  }

  const defaults = [
    join(home, "Documents", "Obsidian Vault"),
    join(home, "Obsidian"),
    join(home, "Obsidian Vault"),
  ];
  candidates.push(...defaults);
  const found = defaults.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new OmniWatchError(
      "missing_config",
      `Nie znaleziono katalogu pamieci (vaultRoot). Sprawdzone: ${candidates.join(", ")}`,
      { action: { label: "ustaw vaultRoot", kind: "fix_config" } },
    );
  }
  return { root: resolve(found), source: "default", candidates };
}

/** Analyses directory from the injected option, the host config file, or the default. */
export function resolveAnalysesDir(config: HostConfig = {}): string {
  const explicit = nonEmpty(config.analysesDir);
  if (explicit) return normalizeAnalysesDir(explicit);
  const home = nonEmpty(config.homeDir) ?? homedir();
  const configPath = resolve(nonEmpty(config.configPath) ?? join(home, DEFAULT_CONFIG_PATH));
  const file = existsSync(configPath) ? readHostConfigFile(configPath) : null;
  const fromFile = nonEmpty(file?.omniwatchAnalysesDir) ?? nonEmpty(file?.analysesDir);
  return normalizeAnalysesDir(fromFile ?? DEFAULT_ANALYSES_DIR);
}

/** Never throws: the installer reports these issues before deciding to install. */
export function inspectHostRoot(config: HostConfig = {}): HostCapabilities {
  const analysesDir = (() => {
    try {
      return resolveAnalysesDir(config);
    } catch {
      return DEFAULT_ANALYSES_DIR;
    }
  })();
  const issues: HostIssue[] = [];
  let vaultRoot: string | null = null;
  let source: VaultRootSource | null = null;
  let rootExists = false;
  let rootIsDirectory = false;
  let rootWritable = false;
  let analysesPath: string | null = null;
  let analysesWritable = false;

  try {
    const resolved = resolveVaultRoot(config);
    vaultRoot = resolved.root;
    source = resolved.source;
    rootExists = true;
    rootIsDirectory = statSync(resolved.root).isDirectory();
    if (!rootIsDirectory) {
      issues.push({ code: "vault_root_not_directory", message: `vaultRoot nie jest katalogiem: ${resolved.root}` });
    } else {
      rootWritable = canWrite(resolved.root);
      if (!rootWritable) {
        issues.push({ code: "vault_root_unwritable", message: `Brak prawa zapisu w Vault: ${resolved.root}` });
      }
      analysesPath = resolve(resolved.root, analysesDir);
      const probe = existsSync(analysesPath) ? analysesPath : nearestExistingAncestor(analysesPath);
      const probeIsDirectory = probe !== null && existsSync(probe) && statSync(probe).isDirectory();
      if (existsSync(analysesPath) && !statSync(analysesPath).isDirectory()) {
        issues.push({
          code: "analyses_dir_not_directory",
          message: `Sciezka katalogu analiz nie jest katalogiem: ${analysesPath}`,
        });
      }
      analysesWritable = probeIsDirectory && canWrite(probe);
      if (!probeIsDirectory) {
        issues.push({
          code: "analyses_dir_blocked",
          message: `Katalogu analiz nie da sie utworzyc (w miejscu sciezki jest plik): ${analysesPath}`,
        });
      } else if (!analysesWritable) {
        issues.push({
          code: "analyses_dir_unwritable",
          message: `Nie mozna zapisac katalogu analiz: ${analysesPath}`,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({ code: "vault_root_missing", message });
  }

  const model = config.model ?? (config.modelFactory ? config.modelFactory() : null);
  if (!model) {
    issues.push({
      code: "answer_model_missing",
      message: "Brak klienta modelu gospodarza; zapis i wyszukiwanie dzialaja, odpowiadanie z odsylaczami nie.",
    });
  }

  const blocking = issues.some((issue) => issue.code !== "answer_model_missing");
  return {
    vaultRoot,
    vaultRootSource: source,
    rootExists,
    rootIsDirectory,
    rootWritable,
    analysesDir,
    analysesPath,
    analysesWritable,
    answerModel: Boolean(model),
    modelName: model?.modelName ?? null,
    issues,
    ok: !blocking,
  };
}

/**
 * Wires the host memory adapter. Throws a clear `missing_config` /
 * `storage_unavailable` error when the root is missing or unwritable; it never
 * substitutes a different directory.
 */
export function createOmniWatchHost(config: HostConfig = {}): OmniWatchHost {
  const analysesDir = resolveAnalysesDir(config);
  const resolved = resolveVaultRoot(config);

  if (!statSync(resolved.root).isDirectory()) {
    throw new OmniWatchError(
      "storage_unavailable",
      `vaultRoot nie jest katalogiem: ${resolved.root}`,
      { action: { label: "popraw vaultRoot", kind: "fix_config" } },
    );
  }
  if (!canWrite(resolved.root)) {
    throw new OmniWatchError(
      "storage_unavailable",
      `Brak prawa zapisu w Vault: ${resolved.root}. Pamiec OmniWatch nie moze zapisac analiz.`,
      { action: { label: "napraw uprawnienia Vaulta", kind: "fix_config" } },
    );
  }

  const model = config.model ?? (config.modelFactory ? config.modelFactory() : null);
  const memory = createVaultMemory({ root: resolved.root, analysesDir, model });

  function capabilities(): HostCapabilities {
    return inspectHostRoot(config);
  }

  function ensureReady(): HostCapabilities {
    const analysesPath = resolve(resolved.root, analysesDir);
    let probeFile: string | null = null;
    try {
      mkdirSync(analysesPath, { recursive: true });
      probeFile = join(analysesPath, `.omniwatch-write-probe-${process.pid}-${Date.now()}`);
      writeFileSync(probeFile, "omniwatch\n", { encoding: "utf8", flag: "wx" });
      rmSync(probeFile, { force: true });
      probeFile = null;
    } catch (error) {
      if (probeFile) rmSync(probeFile, { force: true });
      const detail = error instanceof Error ? error.message : String(error);
      throw new OmniWatchError(
        "storage_unavailable",
        `Katalog pamieci nie jest gotowy do zapisu (${analysesPath}): ${detail}`,
        { action: { label: "napraw uprawnienia Vaulta", kind: "fix_config" }, cause: error },
      );
    }
    return capabilities();
  }

  return {
    vaultRoot: resolved.root,
    analysesDir,
    memory,
    modelName: model?.modelName ?? null,
    capabilities,
    ensureReady,
  };
}
