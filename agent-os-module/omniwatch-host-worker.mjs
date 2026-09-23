/**
 * Separate-process worker launcher for Agent OS (D5).
 *
 * Usage (the panel and Hermes both call this):
 *   OMNIWATCH_HOST_SRC=<host>/src \
 *   OMNIWATCH_CORE=<checkout>/packages/omniwatch/src/index.ts \
 *   node omniwatch-host-worker.mjs --data-dir <dir> [--operation <id>]... [--max <n>]
 *
 * It prints a `{"event":"ready"}` line before doing any work, so the parent never
 * confuses "the process started" with "the analysis runs".
 */

import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.OMNIWATCH_HOST_SRC) {
  process.env.OMNIWATCH_HOST_SRC = path.join(here, "src");
}
register(pathToFileURL(path.join(here, "omniwatch-host-loader.mjs")).href, pathToFileURL(`${here}/`));

function parse(argv) {
  const out = { operations: [], max: null, dataDir: null, language: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--operation") out.operations.push(argv[++i]);
    else if (token === "--max") out.max = Number(argv[++i]);
    else if (token === "--data-dir") out.dataDir = argv[++i];
    else if (token === "--lang") out.language = argv[++i];
    else if (token === "--json") out.json = true;
  }
  return out;
}

const args = parse(process.argv.slice(2));

const dataDir = args.dataDir ?? process.env.OMNIWATCH_DATA_DIR;
if (!dataDir) {
  process.stderr.write("missing_config: podaj --data-dir albo OMNIWATCH_DATA_DIR\n");
  process.exitCode = 3;
} else {
  const corePath = process.env.OMNIWATCH_CORE ?? path.join(here, "..", "packages", "omniwatch", "src", "index.ts");
  try {
    const worker = await import(pathToFileURL(path.resolve(here, "src/lib/omniwatchHostWorker.ts")).href);
    const result = await worker.runHostWorker({
      corePath: pathToFileURL(path.resolve(corePath)).href,
      dataDir,
      operationIds: args.operations.length > 0 ? args.operations : null,
      maxOperations: args.max,
      language: args.language ?? undefined,
      onReady: () => process.stdout.write(`${JSON.stringify({ protocol: "omniwatch.runtime.v1", event: "ready", pid: process.pid })}\n`),
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`${JSON.stringify({ protocol: "omniwatch.runtime.v1", event: "done", result })}\n`);
    process.exitCode = result.unknown > 0 ? 5 : 0;
  } catch (error) {
    process.stderr.write(`${error?.errorClass ?? "runtime_unavailable"}: ${error?.message ?? String(error)}\n`);
    process.exitCode = error?.errorClass === "missing_config" ? 3 : 4;
  }
}
