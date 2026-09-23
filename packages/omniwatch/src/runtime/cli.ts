/**
 * Shared OmniWatch CLI (T3).
 *
 * Hermes, the Agent OS routes and the standalone launchers all call this one
 * entry point; none of them owns a second analysis implementation. Arguments are
 * parsed as a list (no shell) and secrets never appear in argv.
 *
 * Exit codes:
 *   0 ok | 2 invalid input | 3 missing config | 4 runtime unavailable | 5 outcome unknown
 */

import { pathToFileURL } from "node:url";

import { OmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import { ANALYSIS_VERSION } from "../contracts/types.ts";
import type { AnalysisRequest, Mode } from "../contracts/types.ts";
import { confirmRunReport, handOffRunReport, readRunReport, reportPayload, reportsToHandOff, runScan, scanPayload } from "../collections/index.ts";
import { deliverOperation } from "../storage/delivery.ts";
import { OperationJournal } from "../storage/operations.ts";
import { parseSourceUrl } from "../sources/url.ts";
import { createRuntimeWiring } from "./poc.ts";
import type { RuntimeWiring, RuntimeWiringOptions } from "./poc.ts";
import { cancelOperation, enqueueAnalysis, pauseOperation } from "./queue.ts";
import { spawnWorkerProcess } from "./spawn.ts";
import { runOperation, runWorker } from "./worker.ts";

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  invalid_input: 2,
  missing_config: 3,
  runtime_unavailable: 4,
  outcome_unknown: 5,
} as const;

export function exitCodeFor(error: unknown): number {
  const failure = toOmniWatchError(error, "runtime_unavailable");
  switch (failure.errorClass) {
    case "invalid_input":
      return EXIT_CODES.invalid_input;
    case "missing_config":
      return EXIT_CODES.missing_config;
    case "runtime_unavailable":
    case "storage_unavailable":
      return EXIT_CODES.runtime_unavailable;
    case "outcome_unknown":
      return EXIT_CODES.outcome_unknown;
    default:
      return EXIT_CODES.error;
  }
}

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | string[] | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "detach",
  "enqueue-only",
  "summary",
  "teardown",
  "force",
  "help",
  "quiet",
  "pending",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const tokens = [...argv];
  let command = "";
  const first = tokens[0];
  if (first !== undefined && !first.startsWith("--")) command = tokens.shift() ?? "";
  const rest = tokens;
  const positionals: string[] = [];
  const flags = new Map<string, string | string[] | boolean>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    const name = rawName.trim();
    if (name === "") throw new OmniWatchError("invalid_input", "Pusty znacznik argumentu (--).");
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, inlineValue === undefined ? true : inlineValue !== "false");
      continue;
    }
    const value = inlineValue ?? rest[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new OmniWatchError("invalid_input", `Znacznik --${name} wymaga wartosci.`);
    }
    const previous = flags.get(name);
    if (typeof previous === "string") {
      flags.set(name, [...(Array.isArray(previous) ? previous : [previous]), value]);
    } else if (Array.isArray(previous)) {
      flags.set(name, [...previous, value]);
    } else {
      flags.set(name, value);
    }
  }
  if (flags.get("summary") === true && flags.get("teardown") === true) {
    throw new OmniWatchError("invalid_input", "Wybierz jeden tryb: --summary albo --teardown.");
  }
  return { command, positionals, flags };
}

const KNOWN_COMMANDS = new Set(["analyze", "worker", "status", "report", "pause", "cancel", "scan"]);

/**
 * Validate everything that does not need configuration before touching the data
 * directory, so a bad URL or an unknown command is never reported as a missing
 * config file.
 */
export function validateInvocation(parsed: ParsedArgs): void {
  if (parsed.command === "" || parsed.flags.get("help") === true) return;
  if (!KNOWN_COMMANDS.has(parsed.command)) {
    throw new OmniWatchError("invalid_input", `Nieznana komenda "${parsed.command}". Uruchom z --help.`);
  }
  if (parsed.command === "analyze" && parsed.positionals.length === 0) {
    throw new OmniWatchError("invalid_input", "Podaj URL materialu: omniwatch analyze <url>");
  }
  if (parsed.command === "analyze") {
    // Pure format validation: a bad URL must fail as invalid_input before the data
    // directory or the configuration is touched at all.
    parseSourceUrl(parsed.positionals[0]);
  }
  if ((parsed.command === "pause" || parsed.command === "cancel") && parsed.positionals.length === 0) {
    throw new OmniWatchError("invalid_input", `Komenda ${parsed.command} wymaga identyfikatora operacji.`);
  }
  if (parsed.command === "report" && !parsed.flags.get("run") && !parsed.flags.get("pending") && !parsed.flags.get("handoff") && !parsed.flags.get("confirm") && parsed.positionals.length === 0) {
    throw new OmniWatchError("invalid_input", "Podaj --run <id>, --pending, --handoff albo --confirm <reportId>.");
  }
  if (parsed.command === "scan" && !parsed.flags.get("collection")) {
    throw new OmniWatchError("invalid_input", "Podaj kolekcje: omniwatch scan --collection <id>");
  }
  if (parsed.command === "analyze") modeFromFlags(parsed);
}

function stringFlag(parsed: ParsedArgs, name: string): string | null {
  const value = parsed.flags.get(name);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1] ?? null;
  return null;
}

function listFlag(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags.get(name);
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function modeFromFlags(parsed: ParsedArgs): Mode {
  const teardown = parsed.flags.get("teardown") === true;
  const summary = parsed.flags.get("summary") === true;
  if (teardown && summary) {
    throw new OmniWatchError("invalid_input", "Wybierz jeden tryb: --summary albo --teardown.");
  }
  return teardown ? "teardown" : "summary";
}

function wiringOptionsFromFlags(parsed: ParsedArgs): RuntimeWiringOptions {
  const staleRaw = stringFlag(parsed, "owner-stale-ms");
  const ownerStaleAfterMs = staleRaw === null ? undefined : Number(staleRaw);
  if (ownerStaleAfterMs !== undefined && (!Number.isFinite(ownerStaleAfterMs) || ownerStaleAfterMs < 0)) {
    throw new OmniWatchError("invalid_input", `--owner-stale-ms wymaga nieujemnej liczby (otrzymano "${staleRaw}").`);
  }
  return {
    configPath: stringFlag(parsed, "config") ?? undefined,
    dataDir: stringFlag(parsed, "data-dir") ?? undefined,
    ownerStaleAfterMs,
  };
}

function print(value: unknown, json: boolean, fallback: string): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${fallback}\n`);
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
};

/** Run one CLI invocation and return its exit code (no process.exit here). */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const parsed = parseArgs(argv);
  const json = parsed.flags.get("json") === true;

  if (parsed.command === "" || parsed.flags.get("help") === true) {
    io.stdout(helpText());
    return parsed.flags.get("help") === true ? EXIT_CODES.ok : EXIT_CODES.invalid_input;
  }

  validateInvocation(parsed);

  const wiring = createRuntimeWiring({ ...wiringOptionsFromFlags(parsed), environment: io.env });
  try {
    switch (parsed.command) {
      case "analyze":
        return await commandAnalyze(parsed, wiring, io, json);
      case "worker":
        return await commandWorker(parsed, wiring, io, json);
      case "status":
        return commandStatus(wiring, io, json);
      case "report":
        return commandReport(parsed, wiring, io, json);
      case "scan":
        return await commandScan(parsed, wiring, io, json);
      case "pause":
      case "cancel": {
        const operationId = parsed.positionals[0];
        if (!operationId) {
          throw new OmniWatchError("invalid_input", `Komenda ${parsed.command} wymaga identyfikatora operacji.`);
        }
        const operation =
          parsed.command === "pause"
            ? pauseOperation(wiring.store, operationId)
            : cancelOperation(wiring.store, operationId);
        print(
          { protocol: "omniwatch.runtime.v1", command: parsed.command, operation },
          json,
          `${parsed.command}: ${operation.id} -> ${operation.state}`,
        );
        return EXIT_CODES.ok;
      }
      default:
        throw new OmniWatchError("invalid_input", `Nieznana komenda "${parsed.command}". Uruchom z --help.`);
    }
  } finally {
    wiring.close();
  }
}

async function commandAnalyze(parsed: ParsedArgs, wiring: RuntimeWiring, io: CliIo, json: boolean): Promise<number> {
  const url = parsed.positionals[0];
  if (!url) throw new OmniWatchError("invalid_input", "Podaj URL materialu: omniwatch analyze <url>");

  const sourceRef = await wiring.deps.source.resolve({ url });
  const request: AnalysisRequest = {
    sourceRef,
    mode: modeFromFlags(parsed),
    focus: stringFlag(parsed, "focus"),
    question: stringFlag(parsed, "question"),
    language: stringFlag(parsed, "lang") ?? wiring.deps.config.language,
    analysisVersion: ANALYSIS_VERSION,
    conversationId: stringFlag(parsed, "conversation"),
    parentTurnId: stringFlag(parsed, "parent"),
    force: parsed.flags.get("force") === true,
  };

  const enqueued = enqueueAnalysis({ store: wiring.store, request });

  if (parsed.flags.get("enqueue-only") === true) {
    print(
      { protocol: "omniwatch.runtime.v1", operationId: enqueued.operation.id, created: enqueued.created, state: enqueued.operation.state },
      json,
      `zlecono ${enqueued.operation.id} (${enqueued.operation.state})`,
    );
    return EXIT_CODES.ok;
  }

  if (parsed.flags.get("detach") === true) {
    const spawned = spawnWorkerProcess({
      entry: new URL("./cli.ts", import.meta.url).pathname,
      args: [
        "--operation",
        enqueued.operation.id,
        ...(wiring.configPath ? ["--config", wiring.configPath] : []),
        "--data-dir",
        wiring.dataDir,
      ],
      env: io.env,
    });
    await spawned.ready;
    print(
      {
        protocol: "omniwatch.runtime.v1",
        operationId: enqueued.operation.id,
        pid: spawned.pid,
        created: enqueued.created,
      },
      json,
      `zlecono ${enqueued.operation.id} (pid ${String(spawned.pid)})`,
    );
    return EXIT_CODES.ok;
  }

  // A repeat of already-finished work must show the existing answer instead of
  // starting a second paid analysis (SPEC A6/F6).
  if (!enqueued.created) {
    const state = enqueued.operation.state;
    if (state === "outcome_unknown") {
      print(
        {
          protocol: "omniwatch.runtime.v1",
          operationId: enqueued.operation.id,
          state,
          errorClass: "outcome_unknown",
          message: "Operacja ma nieznany wynik wywolania; wymagana jest jawna decyzja (retry/abandon).",
        },
        json,
        `operacja ${enqueued.operation.id}: outcome_unknown (wymagana jawna decyzja)`,
      );
      return EXIT_CODES.outcome_unknown;
    }
    if (state === "delivered" || state === "result_ready") {
      if (state === "result_ready") {
        const delivered = await deliverOperation({ store: wiring.store, memory: wiring.deps.memory }, enqueued.operation.id);
        wiring.store.setOperationState(enqueued.operation.id, "delivered");
        const buffered = wiring.store.getBuffer(enqueued.operation.id);
        print(
          {
            protocol: "omniwatch.runtime.v1",
            operationId: enqueued.operation.id,
            state: "delivered",
            analysisId: delivered.delivery.analysisId,
            memoryRef: delivered.memoryRef,
            reused: true,
            content: buffered?.result.content ?? null,
          },
          json,
          buffered?.result.content ?? "(wynik dostarczony z bufora)",
        );
        return EXIT_CODES.ok;
      }
      const buffered = wiring.store.getBuffer(enqueued.operation.id);
      const analysisId =
        buffered?.result.analysisId ?? wiring.store.getDeliveryForOperation(enqueued.operation.id)?.analysisId ?? null;
      let content = buffered?.result.content ?? null;
      if (content === null && analysisId) {
        const found = await wiring.deps.memory.readAnalysis(analysisId);
        content = found?.result.content ?? null;
      }
      print(
        {
          protocol: "omniwatch.runtime.v1",
          operationId: enqueued.operation.id,
          state,
          analysisId,
          reused: true,
          content,
        },
        json,
        content ?? "(wynik jest juz zapisany; odczytaj go z biblioteki wiedzy)",
      );
      return EXIT_CODES.ok;
    }
    if (state === "running") {
      print(
        {
          protocol: "omniwatch.runtime.v1",
          operationId: enqueued.operation.id,
          state,
          message: "Operacja jest juz wykonywana przez proces roboczy.",
        },
        json,
        `operacja ${enqueued.operation.id}: juz wykonywana`,
      );
      return EXIT_CODES.ok;
    }
  }

  // An inline run owns the data directory for the duration of the command and must
  // release it on every path; otherwise the next command looks like a second consumer.
  const token = `cli_${process.pid}_${Date.now()}`;
  if (!wiring.store.acquireOwner(token, process.pid, new Date().toISOString())) {
    throw new OmniWatchError("runtime_unavailable", "Inny proces jest wlascicielem katalogu danych OmniWatch.", {
      action: { label: "poczekaj na proces roboczy", kind: "check_operation" },
    });
  }
  try {
    const journal = new OperationJournal({ store: wiring.store, ownerToken: token });
    const summary = await runOperation(wiring.deps, journal, enqueued.operation.id);
    const buffer = wiring.store.getBuffer(enqueued.operation.id);
    if (summary.state !== "delivered") {
      print(
        { protocol: "omniwatch.runtime.v1", operation: summary, content: buffer?.result.content ?? null },
        json,
        `operacja ${summary.operationId}: ${summary.state}${summary.message ? ` (${summary.message})` : ""}`,
      );
      return summary.state === "outcome_unknown" ? EXIT_CODES.outcome_unknown : EXIT_CODES.error;
    }
    print(
      {
        protocol: "omniwatch.runtime.v1",
        operation: summary,
        analysisId: summary.analysisId,
        memoryRef: summary.memoryRef,
        reused: summary.reused ?? false,
        content: buffer?.result.content ?? null,
      },
      json,
      buffer?.result.content ?? "(brak tresci)",
    );
    return EXIT_CODES.ok;
  } finally {
    wiring.store.releaseOwner(token);
  }
}

async function commandWorker(parsed: ParsedArgs, wiring: RuntimeWiring, io: CliIo, json: boolean): Promise<number> {
  const ids = listFlag(parsed, "operation");
  const maxRaw = stringFlag(parsed, "max");
  const maxOperations = maxRaw === null ? null : Number(maxRaw);
  if (maxOperations !== null && (!Number.isInteger(maxOperations) || maxOperations < 0)) {
    throw new OmniWatchError("invalid_input", `--max wymaga dodatniej liczby calkowitej (otrzymano "${maxRaw}").`);
  }

  // Readiness is explicit: the parent must not treat "spawned" as "running".
  io.stdout(`${JSON.stringify({ protocol: "omniwatch.runtime.v1", event: "ready", pid: process.pid })}\n`);

  const result = await runWorker({
    deps: wiring.deps,
    operationIds: ids.length > 0 ? ids : null,
    maxOperations,
    onProgress: (event) => {
      if (json) {
        io.stdout(`${JSON.stringify({ protocol: "omniwatch.runtime.v1", event: "progress", progress: event })}\n`);
      }
    },
  });
  print(
    { protocol: "omniwatch.runtime.v1", event: "done", result },
    json,
    `worker: dostarczono ${result.delivered}, bledy ${result.failed}, nieznane ${result.unknown} (${result.stopped})`,
  );
  return result.unknown > 0 ? EXIT_CODES.outcome_unknown : EXIT_CODES.ok;
}

function commandStatus(wiring: RuntimeWiring, io: CliIo, json: boolean): number {
  const operations = wiring.store.listOperations({ limit: 50 });
  const reports = wiring.store.listReports({ limit: 20 });
  const owner = wiring.store.getOwner();
  print(
    { protocol: "omniwatch.runtime.v1", owner, operations, reports },
    json,
    [
      `wlasciciel: ${owner ? `${owner.token} (pid ${owner.pid})` : "brak"}`,
      ...operations.map((operation) => `${operation.id}  ${operation.state}  ${operation.request.mode}`),
    ].join("\n"),
  );
  return EXIT_CODES.ok;
}

function commandReport(parsed: ParsedArgs, wiring: RuntimeWiring, io: CliIo, json: boolean): number {
  if (parsed.flags.get("pending") === true) {
    const reports = reportsToHandOff(wiring.store).map(reportPayload);
    print({ protocol: "omniwatch.runtime.v1", reports }, json, reports.map((report) => String(report.reportId)).join("\n"));
    return EXIT_CODES.ok;
  }
  const handoffId = stringFlag(parsed, "handoff");
  if (handoffId) {
    const report = handOffRunReport(wiring.store, handoffId);
    print({ protocol: "omniwatch.runtime.v1", report: reportPayload(report) }, json, `przekazano ${report.id}`);
    return EXIT_CODES.ok;
  }
  const confirmId = stringFlag(parsed, "confirm");
  if (confirmId) {
    const report = confirmRunReport(wiring.store, confirmId);
    print({ protocol: "omniwatch.runtime.v1", report: reportPayload(report) }, json, `potwierdzono ${report.id}`);
    return EXIT_CODES.ok;
  }
  const runId = stringFlag(parsed, "run") ?? parsed.positionals[0];
  if (!runId) throw new OmniWatchError("invalid_input", "Podaj przebieg: omniwatch report --run <id>");
  const reports = wiring.store.listReports({ runId, limit: 50 });
  if (reports.length === 0) {
    print(
      { protocol: "omniwatch.runtime.v1", runId, reports: [], note: "brak raportu dla tego przebiegu" },
      json,
      `brak raportu dla przebiegu ${runId}`,
    );
    return EXIT_CODES.ok;
  }
  print(
    { protocol: "omniwatch.runtime.v1", runId, reports },
    json,
    reports.map((report) => `${report.id}  ${report.state}  nowe=${report.newAnalyses}  ${report.summary}`).join("\n"),
  );
  return EXIT_CODES.ok;
}

/**
 * The one scan operation Hermes and the manual button share (D8): the caller passes
 * a collection id, never a prompt. Zero new material produces no report.
 */
async function commandScan(parsed: ParsedArgs, wiring: RuntimeWiring, io: CliIo, json: boolean): Promise<number> {
  const collectionId = stringFlag(parsed, "collection");
  if (!collectionId) throw new OmniWatchError("invalid_input", "Podaj kolekcje: omniwatch scan --collection <id>");
  const maxRaw = stringFlag(parsed, "max-new");
  const maxNewItems = maxRaw === null ? undefined : Number(maxRaw);
  if (maxNewItems !== undefined && (!Number.isInteger(maxNewItems) || maxNewItems < 0)) {
    throw new OmniWatchError("invalid_input", `--max-new wymaga nieujemnej liczby calkowitej (otrzymano "${maxRaw}").`);
  }
  const language = stringFlag(parsed, "lang");
  const mode = parsed.flags.get("teardown") === true ? "teardown" : undefined;
  // `--source <url>` (repeatable) defines or extends the collection's source list.
  const sourceUrls = listFlag(parsed, "source");
  const sources = [];
  for (const url of sourceUrls) {
    sources.push(await wiring.deps.source.resolve({ url }));
  }

  const outcome = await runScan({
    deps: wiring.deps,
    request: {
      collectionId,
      trigger: stringFlag(parsed, "trigger") === "schedule" ? "schedule" : "cli",
      settings: {
        ...(mode ? { mode } : {}),
        ...(stringFlag(parsed, "focus") !== null ? { focus: stringFlag(parsed, "focus") } : {}),
        ...(stringFlag(parsed, "question") !== null ? { question: stringFlag(parsed, "question") } : {}),
        ...(language ? { language } : {}),
        ...(maxNewItems !== undefined ? { maxNewItems } : {}),
      },
      confirmPaidListing: parsed.flags.get("confirm-paid-listing") === true,
      ...(sources.length > 0 ? { sources } : {}),
    },
    onProgress: (event) => {
      if (json) io.stdout(`${JSON.stringify({ protocol: "omniwatch.runtime.v1", event: "scan-progress", progress: event })}\n`);
    },
  });

  const payload = scanPayload(outcome);
  print(
    payload,
    json,
    `skan ${outcome.runId}: ${outcome.state}, nowe ${outcome.newItems}, oczekujace ${outcome.pendingItems}`,
  );
  return EXIT_CODES.ok;
}

function helpText(): string {
  return [
    "OmniWatch - wspolny runtime analizy filmow",
    "",
    "  analyze <url> [--focus <temat>] [--question <pytanie>] [--lang <kod>]",
    "                [--summary|--teardown] [--conversation <id>] [--parent <turnId>]",
    "                [--force] [--detach] [--json]",
    "  worker        [--operation <id>]... [--max <n>] [--json]",
    "  status        [--json]",
    "  report        --run <runId> [--json]",
    "  pause <operationId> | cancel <operationId>",
    "",
    "  --config <plik>   plik konfiguracji runtime (bez sekretow)",
    "  --data-dir <dir>  katalog danych OmniWatch (state.sqlite, cache)",
    "  --owner-stale-ms <n>  okno przejecia po crashu (domyslnie 30000, D5)",
  ].join("\n");
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const failure = toOmniWatchError(error, "runtime_unavailable");
      process.stderr.write(`${failure.errorClass}: ${failure.message}\n`);
      process.exitCode = exitCodeFor(failure);
    });
}
