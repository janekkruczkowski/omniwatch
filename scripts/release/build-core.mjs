#!/usr/bin/env node
/**
 * T8 / D4-D6: build the shared OmniWatch core once and package it.
 *
 *   node scripts/release/build-core.mjs [--out <dir>] [--skip-typecheck] [--json]
 *
 * One TypeScript build of `packages/omniwatch`, one `npm pack` artifact and one
 * manifest. The manifest is what the installer (scripts/release/install.mjs) and
 * the release archive trust: library version, exact tested Node requirement,
 * runtime dependencies, tarball sha256, every packaged file with its own sha256,
 * the analysis-contract versions read from the *built* contracts, and the tool
 * versions the artifact was built with.
 *
 * The tarball is never published and never installed into a private Agent OS
 * checkout; install tests use synthetic host copies under the OS temp directory.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const CORE = join(ROOT, "packages", "omniwatch");

/**
 * Node lines this release is built and tested for (TECHNICAL D6): the 22 line from
 * 22.22.3 (the release where node:sqlite needs no flag) and the 24 line. Anything
 * else is unsupported and the installer refuses it during preflight.
 */
const NODE_REQUIREMENT = ">=22.22.3 <23 || >=24.0.0 <25";
const NODE_TESTED = ["22.22.3", "24"];

/** Paths a release tarball must never contain. */
const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /\.(sqlite|sqlite-wal|sqlite-shm|db)$/i,
  /(^|\/)(data|fixtures?|secrets?|private)(\/|$)/i,
  /(^|\/)test(s)?(\/|$)/,
  /\.(pem|key|p12|pfx)$/i,
];

/** Files may only come from the package's own published surface. */
const ALLOWED_PATH_PATTERNS = [/^package\.json$/, /^README\.md$/, /^dist\//, /^src\//];

/** An assignment of a real credential, not an identifier that merely names one. */
const SECRET_VALUE_PATTERN =
  /(^|\n)\s*(?:export\s+)?(DASHSCOPE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|APIFY_TOKEN|APIFY_API_TOKEN|GEMINI_API_KEY|OMNI_API_KEY|OMNIWATCH_API_KEY|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})/;

function log(line) {
  process.stderr.write(`${line}\n`);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fail(message) {
  log(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { out: join(ROOT, "dist", "release"), skipTypecheck: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") options.out = resolve(argv[++i] ?? "");
    else if (arg === "--skip-typecheck") options.skipTypecheck = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") {
      log("usage: build-core.mjs [--out <dir>] [--skip-typecheck] [--json]");
      process.exit(0);
    } else fail(`nieznany argument: ${arg}`);
  }
  if (!options.out) fail("--out wymaga katalogu");
  return options;
}

/* ------------------------------------------------------------------- tar ---- */

function cString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
}

function parsePax(data) {
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1).replace(/\n$/, "");
    offset += length;
  }
  return records;
}

/**
 * Minimal POSIX/GNU tar reader for the `npm pack` tarball. Node has no tar in its
 * standard library and the artifact must be verified without depending on a tar
 * tool the host may not have.
 */
function readTarGzEntries(tarball) {
  const buffer = gunzipSync(tarball);
  const entries = [];
  let offset = 0;
  let longName = null;
  let pax = {};
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const sizeField = cString(header.subarray(124, 136)).trim();
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = cString(header.subarray(345, 500));
    const modeField = cString(header.subarray(100, 108)).trim();
    const mode = modeField ? Number.parseInt(modeField, 8) : 0o644;
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cString(data);
      continue;
    }
    if (type === "x" || type === "g") {
      pax = { ...pax, ...parsePax(data) };
      continue;
    }
    const entryPath = longName ?? pax.path ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    pax = {};
    if (type === "5") {
      entries.push({ path: entryPath, dir: true, size: 0, mode, sha256: null, data: null });
    } else if (type === "0" || type === "\u0000" || type === "7" || type === "") {
      entries.push({ path: entryPath, dir: false, size: data.length, mode, sha256: sha256(data), data });
    }
  }
  return entries;
}

/* ----------------------------------------------------------------- build ---- */

function run(command, args, env = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

function localTsc() {
  const candidate = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  return existsSync(candidate) ? candidate : null;
}

function typescriptVersion() {
  const manifest = join(ROOT, "node_modules", "typescript", "package.json");
  if (!existsSync(manifest)) return null;
  return JSON.parse(readFileSync(manifest, "utf8")).version ?? null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8"));
  const version = packageJson.version;
  const outDir = options.out;
  mkdirSync(outDir, { recursive: true });

  // 1. Clean build of the core package.
  const distDir = join(CORE, "dist");
  rmSync(distDir, { recursive: true, force: true });
  if (!options.skipTypecheck) {
    const tsc = localTsc();
    log(`→ tsc packages/omniwatch/tsconfig.json${tsc ? "" : " (npx)"}`);
    if (tsc) run(process.execPath, [tsc, "-p", join(CORE, "tsconfig.json")]);
    else run("npx", ["tsc", "-p", join(CORE, "tsconfig.json")]);
  }
  const builtContracts = join(distDir, "contracts", "index.js");
  if (!existsSync(builtContracts)) {
    fail(`brak zbudowanych kontraktow: ${builtContracts}; tsc nie wykonal sie poprawnie`);
  }

  // 2. Contract versions come from the built JS, not from this script's guess.
  const contracts = await import(`${pathToFileURL(builtContracts).href}?v=${Date.now()}`);
  const contractVersion = contracts.CONTRACT_VERSION;
  const analysisVersion = contracts.ANALYSIS_VERSION;
  if (typeof contractVersion !== "string" || typeof analysisVersion !== "string") {
    fail("zbudowane kontrakty nie eksportuja CONTRACT_VERSION/ANALYSIS_VERSION");
  }

  // 3. Exactly one artifact in the output directory.
  for (const entry of readdirSync(outDir)) {
    if (/^omniwatch-core-.*\.tgz$/.test(entry)) {
      rmSync(join(outDir, entry));
      log(`· usunieto poprzedni artefakt ${entry}`);
    }
  }
  log("→ npm pack ./packages/omniwatch");
  // A project-local npm cache keeps the build reproducible and independent of a
  // host's global cache permissions (a root-owned ~/.npm must not break a release).
  const packOutput = run(
    "npm",
    ["pack", "./packages/omniwatch", "--json", "--ignore-scripts", "--pack-destination", outDir],
    { npm_config_cache: join(outDir, ".npm-cache") },
  );
  let packed;
  try {
    packed = JSON.parse(packOutput);
  } catch (error) {
    fail(`nie mozna odczytac JSON z npm pack: ${String(error)}`);
  }
  const packResult = Array.isArray(packed) ? packed[0] : packed;
  if (!packResult?.filename) fail("npm pack nie zwrocil nazwy artefaktu");
  const tarballPath = join(outDir, packResult.filename.replace(/^.*[/\\]/, ""));
  if (!existsSync(tarballPath)) fail(`npm pack nie utworzyl ${tarballPath}`);
  const tarballs = readdirSync(outDir).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    fail(`katalog wydania musi zawierac dokladnie jeden tarball, jest ${tarballs.length}`);
  }

  // 4. Verify the artifact: paths, sizes, per-file hashes, no secrets.
  const tarball = readFileSync(tarballPath);
  const tarballSha = sha256(tarball);
  const entries = readTarGzEntries(tarball).filter((entry) => !entry.dir);
  if (entries.length === 0) fail("tarball jest pusty");
  const files = [];
  for (const entry of entries) {
    if (!entry.path.startsWith("package/")) {
      fail(`wpis tarballa poza katalogiem package/: ${entry.path}`);
    }
    const entryPath = entry.path.slice("package/".length);
    const forbidden = FORBIDDEN_PATH_PATTERNS.find((pattern) => pattern.test(entryPath));
    if (forbidden) fail(`zabroniona sciezka w paczce: ${entryPath}`);
    if (!ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(entryPath))) {
      fail(`plik poza dozwolona powierzchnia pakietu: ${entryPath}`);
    }
    if (SECRET_VALUE_PATTERN.test(entry.data.toString("utf8"))) {
      fail(`podejrzenie sekretu w pliku paczki: ${entryPath}`);
    }
    files.push({ path: entryPath, bytes: entry.size, sha256: entry.sha256 });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const npmListed = (packResult.files ?? []).map((file) => file.path).sort();
  const tarListed = entries.map((entry) => entry.path.slice("package/".length)).sort();
  if (npmListed.length !== tarListed.length || npmListed.some((path, i) => path !== tarListed[i])) {
    fail("lista plikow z npm pack nie zgadza sie z zawartoscia tarballa");
  }

  // 5. Manifest.
  const nodeVersion = process.versions.node;
  // The package manifest's declared entry points must really be in the artifact.
  // `packages/omniwatch` is the coordinator's file: when it declares an entry the
  // build cannot produce, the release says so instead of shipping a broken import.
  const declaredEntryPoints = new Map();
  const declareEntry = (value) => {
    if (typeof value !== "string" || !value.startsWith("./")) return;
    declaredEntryPoints.set(value.slice(2), null);
  };
  declareEntry(packageJson.main);
  declareEntry(packageJson.types);
  for (const target of Object.values(packageJson.exports ?? {})) {
    if (typeof target === "string") declareEntry(target);
    else if (target && typeof target === "object") {
      for (const value of Object.values(target)) declareEntry(value);
    }
  }
  const filePaths = new Set(files.map((file) => file.path));
  const entryPoints = [...declaredEntryPoints.keys()].sort().map((path) => ({
    path,
    present: filePaths.has(path),
  }));
  const warnings = entryPoints
    .filter((entry) => !entry.present)
    .map(
      (entry) =>
        `package.json deklaruje ${entry.path}, ale tego pliku nie ma w zbudowanym pakiecie ` +
        "(brak zrodla wejsciowego w packages/omniwatch/src) - konsument nie moze zaimportowac korzenia pakietu",
    );
  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    library: {
      name: packageJson.name,
      version,
      privatePackage: packageJson.private === true,
      declaredEntryPoints: entryPoints,
    },
    artifact: {
      filename: tarballPath.replace(/^.*[/\\]/, ""),
      format: "npm-tarball",
      bytes: tarball.length,
      sha256: tarballSha,
      npmIntegrity: packResult.integrity ?? null,
    },
    node: {
      requirement: NODE_REQUIREMENT,
      testedLines: NODE_TESTED,
      enginesField: packageJson.engines?.node ?? null,
      builtOn: nodeVersion,
    },
    runtimeDependencies: packageJson.dependencies ?? {},
    contracts: {
      contractVersion,
      analysisVersion,
      supportedContractVersions: [contractVersion],
      supportedAnalysisVersions: [analysisVersion],
      source: "dist/contracts/index.js",
    },
    tools: {
      node: `v${nodeVersion}`,
      npm: packResult.npmVersion ?? run("npm", ["--version"]).trim(),
      typescript: typescriptVersion(),
      platform: `${process.platform}-${process.arch}`,
    },
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    warnings,
  };
  const manifestPath = join(
    outDir,
    `${packageJson.name.replace(/^@/, "").replace("/", "-")}-${version}.manifest.json`,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const summary = {
    ok: true,
    tarball: tarballPath,
    manifest: manifestPath,
    sha256: tarballSha,
    fileCount: files.length,
    bytes: statSync(tarballPath).size,
    libraryVersion: version,
    contracts: { contractVersion, analysisVersion },
  };
  log(`✓ artefakt: ${tarballPath}`);
  log(`✓ manifest: ${manifestPath}`);
  log(`✓ sha256:   ${tarballSha}`);
  log(`✓ plikow:   ${files.length}`);
  for (const warning of warnings) log(`! ${warning}`);
  if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => fail(error?.stack ?? String(error)));
}
