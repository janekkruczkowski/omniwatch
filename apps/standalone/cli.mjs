#!/usr/bin/env node
/**
 * Beta CLI compatibility launcher (T7 / D2).
 *
 * `uv run omniwatch.py URL [-q|--question] [--lang] [--teardown]` keeps working by
 * mapping the released argument list onto the shared runtime CLI
 * (`packages/omniwatch/src/runtime/cli.ts`). This file owns no analysis logic: it
 * parses the legacy flags, checks that the runtime artifact is present, spawns the
 * shared CLI with a list of arguments (never a shell string) and passes the exit code
 * and the interruption through.
 *
 * A missing Node, a missing core artifact or a missing API key is a readable error
 * *before* anything is started. There is no fallback to the old Python engine.
 *
 * Exit codes (shared with the runtime CLI):
 *   0 ok | 1 error | 2 invalid input | 3 missing config | 4 runtime unavailable | 5 unknown outcome
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadStandaloneConfig, writeRuntimeConfigFile } from "./config.mjs";

export const MIN_NODE_VERSION = [22, 22, 3];
export const EXIT = { ok: 0, error: 1, invalid_input: 2, missing_config: 3, runtime_unavailable: 4, unknown: 5 };

const HELP = [
  "OmniWatch - zapytaj film, a Qwen Omni obejrzy go za Ciebie.",
  "",
  "  omniwatch.py <url> [-q \"pytanie\"] [--lang en|pl|de|es|fr] [--teardown]",
  "",
  "  -q, --question <tekst>  pytanie o film (puste = pelne streszczenie)",
  "  --lang <kod>            jezyk odpowiedzi",
  "  --teardown              rozbierz film na czesci (hook, beaty, montaz, CTA)",
  "  --conversation <id>     rozmowa, do ktorej nalezy pytanie",
  "  --parent <turnId>       poprzednia odpowiedz, ktora rozwijamy",
  "  --help                  ta instrukcja",
  "",
  "Analize wykonuje wspolny runtime OmniWatch (jedna implementacja dla CLI i WWW).",
].join("\n");

/** Where the shared CLI lives, relative to this standalone app. */
export function coreCliPath(appRoot) {
  return path.join(path.resolve(appRoot), "..", "..", "packages", "omniwatch", "src", "runtime", "cli.ts");
}

function parseVersion(text) {
  const match = String(text).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeVersionSupported(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] > MIN_NODE_VERSION[i]) return true;
    if (parsed[i] < MIN_NODE_VERSION[i]) return false;
  }
  return true;
}

const VALUE_FLAGS = new Set(["-q", "--question", "--lang", "--conversation", "--parent"]);
const PASSTHROUGH_FLAGS = new Set([
  "--teardown",
  "--summary",
  "--force",
  "--json",
  "--detach",
  "--enqueue-only",
  "--data-dir",
  "--config",
  "--owner-stale-ms",
  "--focus",
]);

/**
 * Legacy argv -> shared CLI argv. `-q`/`--question`, `--lang` and `--teardown` are
 * the released inputs; the runtime's own extra flags are forwarded unchanged so the
 * new conversation fields work from the command line too. The URL is always the
 * first positional, exactly as the beta required.
 */
export function mapLegacyArgs(argv) {
  const tokens = [...argv];
  if (tokens.some((token) => token === "--help" || token === "-h")) {
    return { args: [], help: true, error: null };
  }
  const out = [];
  let url = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const inline = token.startsWith("--") && token.includes("=");
    const name = inline ? token.slice(0, token.indexOf("=")) : token;
    if (VALUE_FLAGS.has(name)) {
      const value = inline ? token.slice(token.indexOf("=") + 1) : tokens[++i];
      if (value === undefined) return { args: [], help: false, error: `Znacznik ${name} wymaga wartosci.` };
      out.push(name === "-q" ? "--question" : name, value);
      continue;
    }
    if (PASSTHROUGH_FLAGS.has(name)) {
      out.push(token);
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      return { args: [], help: false, error: `Nieznany znacznik "${token}". Uruchom z --help.` };
    }
    if (url === null) {
      url = token;
      continue;
    }
    return { args: [], help: false, error: `Nieoczekiwany argument "${token}".` };
  }
  if (url === null) return { args: [], help: false, error: "Podaj URL materialu: omniwatch.py <url>" };
  return { args: ["analyze", url, ...out], help: false, error: null };
}

/** Readable installation instruction; returned instead of starting anything. */
export function preflight(options = {}) {
  const appRoot = path.resolve(options.appRoot ?? path.dirname(fileURLToPath(import.meta.url)));
  const version = options.nodeVersion ?? process.versions.node;
  if (!nodeVersionSupported(version)) {
    return {
      ok: false,
      code: EXIT.runtime_unavailable,
      message: [
        `OmniWatch wymaga Node ${MIN_NODE_VERSION.join(".")} lub nowszego (znaleziono ${version}).`,
        "Zainstaluj Node 22 LTS: https://nodejs.org/download/release/v22.22.3/",
        "Po instalacji uruchom ponownie: uv run omniwatch.py <url>",
      ].join("\n"),
    };
  }
  const cli = options.coreCli ?? process.env.OMNIWATCH_CORE_CLI ?? coreCliPath(appRoot);
  if (!existsSync(cli)) {
    return {
      ok: false,
      code: EXIT.runtime_unavailable,
      message: [
        "Nie znaleziono wspolnego runtime OmniWatch (artefakt rdzenia).",
        `Oczekiwana sciezka: ${cli}`,
        "Zainstaluj wydanie OmniWatch (instalator kopiuje rdzen razem z aplikacja) albo",
        "uruchom `npm install` w katalogu repozytorium, jesli pracujesz ze zrodlami.",
        "Stary silnik Python nie jest uruchamiany awaryjnie.",
      ].join("\n"),
    };
  }
  return { ok: true, code: EXIT.ok, message: "", cli };
}

/**
 * Run one legacy CLI invocation. Returns the exit code; it never calls
 * `process.exit`, so tests can drive it in-process.
 */
export async function runStandaloneCli(argv, options = {}) {
  const appRoot = path.resolve(options.appRoot ?? path.dirname(fileURLToPath(import.meta.url)));
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));

  const mapped = mapLegacyArgs(argv);
  if (mapped.help) {
    stdout(`${HELP}\n`);
    return EXIT.ok;
  }
  if (mapped.error) {
    stderr(`${mapped.error}\n`);
    return EXIT.invalid_input;
  }

  const ready = preflight({ appRoot, env });
  if (!ready.ok) {
    stderr(`${ready.message}\n`);
    return ready.code;
  }

  const config = loadStandaloneConfig({ appRoot, env });
  if (!config.apiKeyPresent) {
    stderr(
      [
        "Brak klucza modelu: ustaw DASHSCOPE_API_KEY w pliku .env obok skryptow",
        `(oczekiwana lokalizacja: ${config.envFile}) albo w srodowisku procesu.`,
        "Klucz nie jest zapisywany w katalogu danych ani w argv.",
      ].join("\n") + "\n",
    );
    return EXIT.missing_config;
  }
  writeRuntimeConfigFile(config);

  const args = [...mapped.args];
  if (!args.includes("--data-dir")) args.push("--data-dir", config.dataDir);
  if (!args.includes("--config")) args.push("--config", config.runtimeConfigPath);

  const spawnImpl = options.spawnImpl ?? spawn;
  return await new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [ready.cli, ...args], {
      stdio: "inherit",
      env: { ...env },
    });
    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // The child already exited; the exit handler decides the code.
      }
    };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("error", (error) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      stderr(`Nie udalo sie uruchomic runtime OmniWatch: ${error.message}\n`);
      resolve(EXIT.runtime_unavailable);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      resolve(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : EXIT.error);
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const code = await runStandaloneCli(process.argv.slice(2));
  process.exitCode = code;
}
