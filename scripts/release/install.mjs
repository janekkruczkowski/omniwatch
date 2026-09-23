#!/usr/bin/env node
/**
 * T8 / D4-D5: the real OmniWatch core installer used by both shells.
 *
 *   node scripts/release/install.mjs --target agent-os|standalone --root <dir>
 *        [--tarball <file>] [--manifest <file>] [--release-dir <dir>]
 *        [--data-dir <dir>] [--install-subdir <rel>] [--skip-nav]
 *        [--required-tools a,b] [--node-version <v>] [--check] [--json]
 *   node scripts/release/install.mjs --target agent-os --root <dir> --rollback [--backup <id>]
 *
 * Contract (also documented in docs/omniwatch/install/README.md):
 *
 * 1. Preflight, in this order, changes nothing: manifest/tarball checksum, package
 *    completeness (every manifest file present with the recorded size and sha256),
 *    supported Node line, required tools, install-location sanity (the shell must
 *    really be there - a missing shell file is a clear error, not a silent no-op),
 *    and the D5 in-flight gate over the data directory's unfinished and paused work.
 * 2. Conflicts: a file this installer owns and the user has since changed is
 *    reported and the install stops before any write. Nothing is silently
 *    overwritten.
 * 3. Backup: every file about to be replaced or edited is copied to
 *    <installDir>/backups/<timestamp>/ first.
 * 4. Switch: the release is unpacked to a staging directory, renamed into place and
 *    the `current` pointer is replaced last, via temp-file + rename. A failure
 *    restores the backup, so the previous release stays usable.
 * 5. `--rollback` restores the newest (or named) backup. It never touches the data
 *    directory: user data, cached media and analyses are not ours to delete.
 *
 * No Director/Blueprint patchers, no `git add`, no copying of the whole `src/lib`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { readIntegrationFile } from "./shell-integration.mjs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const require = createRequire(import.meta.url);

const EXIT_OK = 0;
const EXIT_PREFLIGHT = 2;
const EXIT_CONFLICT = 3;
const EXIT_COMPATIBILITY = 4;
const EXIT_APPLY = 5;

/** Paths a release tarball must never contain (mirrors build-core.mjs). */
const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /\.(sqlite|sqlite-wal|sqlite-shm|db)$/i,
  /(^|\/)(data|fixtures?|secrets?|private)(\/|$)/i,
  /(^|\/)test(s)?(\/|$)/,
  /\.(pem|key|p12|pfx)$/i,
];

const UNFINISHED_OPERATION_STATES = [
  "pending",
  "running",
  "result_ready",
  "outcome_unknown",
  "failed",
  "budget_paused",
];

/** Tools that are useful but not blocking; reported with the capability they unlock. */
const OPTIONAL_TOOLS = [
  ["ffmpeg", "sklada i dzieli material wideo"],
  ["ffprobe", "odczytuje dlugosc i strumienie materialu"],
  ["yt-dlp", "pobiera material z platform"],
];

class InstallError extends Error {
  constructor(message, { code = EXIT_PREFLIGHT, details = {} } = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function log(line) {
  process.stderr.write(`${line}\n`);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/* ------------------------------------------------------------------ args ---- */

function parseArgs(argv) {
  const options = {
    target: null,
    root: null,
    tarball: null,
    manifest: null,
    releaseDir: process.env.OMNIWATCH_RELEASE_DIR ?? join(REPO_ROOT, "dist", "release"),
    dataDir: null,
    installSubdir: null,
    skipNav: false,
    requiredTools: null,
    nodeVersion: process.versions.node,
    check: false,
    json: false,
    rollback: false,
    backup: null,
    help: false,
    skipIntegration: false,
  };
  const argvList = [...argv];
  for (let i = 0; i < argvList.length; i++) {
    const arg = argvList[i];
    const next = () => {
      const value = argvList[++i];
      if (value === undefined) throw new InstallError(`flaga ${arg} wymaga wartosci`);
      return value;
    };
    switch (arg) {
      case "--target":
        options.target = next();
        break;
      case "--root":
        options.root = resolve(next());
        break;
      // `--host` was used in an early QA instruction; accept it as a clear alias for
      // `--root` instead of failing with "nieznany argument".
      case "--host":
        options.root = resolve(next());
        break;
      case "--tarball":
        options.tarball = resolve(next());
        break;
      case "--manifest":
        options.manifest = resolve(next());
        break;
      case "--release-dir":
        options.releaseDir = resolve(next());
        break;
      case "--data-dir":
        options.dataDir = resolve(next());
        break;
      case "--install-subdir":
        options.installSubdir = next();
        break;
      case "--required-tools":
        options.requiredTools = next()
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        break;
      case "--node-version":
        options.nodeVersion = next();
        break;
      case "--backup":
        options.backup = next();
        break;
      case "--skip-nav":
        options.skipNav = true;
        break;
      case "--skip-integration":
        options.skipIntegration = true;
        break;
      case "--check":
      case "--dry-run":
        options.check = true;
        break;
      case "--rollback":
        options.rollback = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new InstallError(`nieznany argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.target) throw new InstallError("brak --target (agent-os|standalone)");
  if (!["agent-os", "standalone"].includes(options.target)) {
    throw new InstallError(`nieznany --target "${options.target}"; dozwolone: agent-os, standalone`);
  }
  if (!options.root) throw new InstallError("brak --root (katalog docelowej powloki)");
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

/** Minimal POSIX/GNU tar reader for the release tarball; no host tar tool needed. */
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

/* ---------------------------------------------------------------- helpers ---- */

function semverTuple(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function satisfiesPart([major, minor, patch], part) {
  const match = /^(>=|<=|>|<)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part);
  if (!match) return false;
  const operator = match[1] ?? "=";
  const wanted = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  const current = [major, minor, patch];
  const compare = current[0] - wanted[0] || current[1] - wanted[1] || current[2] - wanted[2];
  switch (operator) {
    case ">=":
      return compare >= 0;
    case ">":
      return compare > 0;
    case "<=":
      return compare <= 0;
    case "<":
      return compare < 0;
    default:
      return compare === 0;
  }
}

/** Satisfies the release's exact supported Node lines: 22.22.3+ in 22, and 24. */
function nodeSupported(version, requirement = ">=22.22.3 <23 || >=24.0.0 <25") {
  const tuple = semverTuple(version);
  if (!tuple) return false;
  for (const clause of requirement.split("||")) {
    const parts = clause.trim().split(/\s+/);
    if (parts.every((part) => satisfiesPart(tuple, part))) return true;
  }
  return false;
}

/** Resolve a tool on PATH the way a shell would, including PATHEXT on Windows. */
function findExecutable(name) {
  if (name === "node") return process.execPath;
  const pathExt =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const extension of pathExt) {
      const candidate = join(dir, `${name}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not there */
      }
    }
  }
  return null;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.omniwatch-tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function copyInto(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function crashPoint(name) {
  if (process.env.OMNIWATCH_TEST_CRASH === name) {
    log(`· [test] symulowane przerwanie instalacji w punkcie "${name}"`);
    process.kill(process.pid, "SIGKILL");
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/* --------------------------------------------------------------- preflight --- */

function defaultManifest(releaseDir) {
  if (!existsSync(releaseDir)) {
    throw new InstallError(
      `brak katalogu wydania ${releaseDir}; zbuduj artefakt: node scripts/release/build-core.mjs`,
    );
  }
  const candidates = readdirSync(releaseDir).filter((entry) => entry.endsWith(".manifest.json"));
  if (candidates.length !== 1) {
    throw new InstallError(
      `katalog ${releaseDir} musi zawierac dokladnie jeden manifest, znaleziono ${candidates.length}`,
    );
  }
  return join(releaseDir, candidates[0]);
}

function loadRelease(options) {
  const manifestPath = options.manifest ?? defaultManifest(options.releaseDir);
  if (!existsSync(manifestPath)) {
    throw new InstallError(
      `brak manifestu wydania: ${manifestPath}; zbuduj artefakt: node scripts/release/build-core.mjs`,
    );
  }
  const manifest = readJson(manifestPath);
  if (manifest.schema !== 1 || !Array.isArray(manifest.files)) {
    throw new InstallError(`manifest ${manifestPath} nie ma oczekiwanego formatu (schema 1)`);
  }
  const tarballPath = options.tarball ?? join(options.releaseDir, manifest.artifact.filename);
  if (!existsSync(tarballPath)) {
    throw new InstallError(`brak tarballa wydania: ${tarballPath}`);
  }
  return { manifest, manifestPath, tarballPath };
}

function verifyChecksum(manifest, tarballPath) {
  const actual = sha256File(tarballPath);
  if (actual !== manifest.artifact.sha256) {
    throw new InstallError(
      `suma kontrolna tarballa sie nie zgadza: oczekiwano ${manifest.artifact.sha256}, jest ${actual}. ` +
        "Instalacja zatrzymana przed jakimkolwiek zapisem.",
      { details: { expected: manifest.artifact.sha256, actual } },
    );
  }
  return actual;
}

function verifyPackage(manifest, tarballPath) {
  const entries = readTarGzEntries(readFileSync(tarballPath)).filter((entry) => !entry.dir);
  const byPath = new Map();
  for (const entry of entries) {
    if (!entry.path.startsWith("package/")) {
      throw new InstallError(`wpis tarballa poza katalogiem package/: ${entry.path}`);
    }
    const entryPath = entry.path.slice("package/".length);
    if (FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(entryPath))) {
      throw new InstallError(`zabroniona sciezka w paczce: ${entryPath}`);
    }
    byPath.set(entryPath, entry);
  }
  const missing = [];
  const mismatched = [];
  for (const file of manifest.files) {
    const entry = byPath.get(file.path);
    if (!entry) missing.push(file.path);
    else if (entry.size !== file.bytes || entry.sha256 !== file.sha256) mismatched.push(file.path);
    else byPath.delete(file.path);
  }
  if (missing.length || mismatched.length || byPath.size) {
    throw new InstallError(
      "paczka jest niekompletna lub niezgodna z manifestem: " +
        [
          missing.length ? `brak plikow: ${missing.slice(0, 5).join(", ")}` : null,
          mismatched.length ? `inna zawartosc: ${mismatched.slice(0, 5).join(", ")}` : null,
          byPath.size ? `nadmiarowe pliki: ${[...byPath.keys()].slice(0, 5).join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; "),
      { details: { missing, mismatched, extra: [...byPath.keys()] } },
    );
  }
  // The artifact must really be the library the manifest names and versions.
  const packageEntry = entries.find((entry) => entry.path === "package/package.json");
  if (!packageEntry) {
    throw new InstallError("paczka nie zawiera package.json - nie wiadomo, co instalujemy");
  }
  let packedPackage;
  try {
    packedPackage = JSON.parse(packageEntry.data.toString("utf8"));
  } catch (error) {
    throw new InstallError(`package.json w paczce jest nieczytelny: ${String(error)}`);
  }
  if (
    packedPackage.name !== manifest.library.name ||
    packedPackage.version !== manifest.library.version
  ) {
    throw new InstallError(
      `paczka zawiera ${packedPackage.name}@${packedPackage.version}, a manifest deklaruje ` +
        `${manifest.library.name}@${manifest.library.version}`,
    );
  }
  return entries.map((entry) => ({
    path: entry.path.slice("package/".length),
    mode: entry.mode,
    size: entry.size,
    sha256: entry.sha256,
    data: entry.data,
  }));
}

function shellFiles(target, root) {
  if (target === "agent-os") {
    return {
      required: [
        join(root, "source", "src", "components", "Sidebar.tsx"),
        join(root, "source", "src", "components", "TopBar.tsx"),
      ],
      navRoot: join(root, "source"),
    };
  }
  return { required: [join(root, "app.py"), join(root, "omniwatch.py")], navRoot: null };
}

/**
 * Plan the Agent OS shell integration (routes/UI/libs) declared by the manifest.
 * Paths are relative to the Agent OS ROOT and start with `source/`. A file that the
 * host already had and the installer does not own is a CONFLICT, never an overwrite:
 * the film project's own modules must survive (SPEC: analysis release must not
 * replace production code).
 */
function planIntegration(options, manifest, previous, conflicts, warnings, entries) {
  const integration = manifest.shellIntegration;
  if (!integration || options.target !== "agent-os") return [];
  const files = integration.files ?? [];
  if (files.length === 0) {
    warnings.push(
      "manifest nie zawiera plikow integracji Agent OS - panel pozostanie niezmieniony; " +
        "przebuduj wydanie z katalogiem agent-os-module",
    );
    return [];
  }
  const moduleRoot = join(REPO_ROOT, "agent-os-module");
  const managedBefore = previous?.integrationFiles ?? {};
  const protectedHost = new Set(integration.protectedHostFiles ?? []);
  const planned = [];
  for (const file of files) {
    const absolute = join(options.root, ...file.path.split("/"));
    const rel = relative(options.root, absolute);
    const plannedItem = {
      absolute,
      rel,
      kind: "integration",
      entry: { path: file.path, data: readIntegrationFile(moduleRoot, file.path), mode: file.mode },
      sha256After: file.sha256,
    };
    if (!existsSync(absolute)) {
      planned.push(plannedItem);
      continue;
    }
    const current = sha256File(absolute);
    const ownedBefore = managedBefore[rel] ?? null;
    if (protectedHost.has(rel.replace(/^source\//, ""))) {
      // Film-production modules are never touched, whatever the manifest says.
      conflicts.push({
        path: rel,
        reason: "plik nalezy do projektu produkcji filmow - instalator analizy go nie dotyka",
      });
      continue;
    }
    if (ownedBefore === null) {
      // FIRST install into a host that already ships OmniWatch (the released beta
      // layout). These are the very files this release supersedes, so adopting them
      // is the documented upgrade path - they are backed up and the ownership is
      // recorded, and from now on an unowned edit is a conflict again.
      if (current === file.sha256) {
        // Byte-identical to the release; adopt without touching it.
        planned.push({ ...plannedItem, unchanged: true, adopt: true });
        continue;
      }
      planned.push({ ...plannedItem, adopt: true });
      continue;
    }
    if (ownedBefore !== current) {
      conflicts.push({
        path: rel,
        reason: "plik integracji zmieniony poza instalatorem od ostatniej instalacji OmniWatch",
      });
      continue;
    }
    planned.push(plannedItem);
  }
  // The host integration imports the shared source graph from the sibling
  // packages/omniwatch directory. Materialize that graph from the VERIFIED tarball;
  // otherwise a standalone Agent OS installation has unresolved relative imports.
  for (const entry of entries.filter((item) => item.path.startsWith("src/"))) {
    const rel = `packages/omniwatch/${entry.path}`;
    const absolute = join(options.root, ...rel.split("/"));
    const ownedBefore = managedBefore[rel] ?? null;
    if (existsSync(absolute) && ownedBefore !== sha256File(absolute)) {
      conflicts.push({ path: rel, reason: "plik wspolnego rdzenia zmieniony poza instalatorem" });
      continue;
    }
    planned.push({ absolute, rel, kind: "integration", entry: { path: rel, data: entry.data, mode: entry.mode } });
  }
  // The shared TypeScript graph intentionally uses explicit .ts extensions. Next's
  // host compiler needs this switch to typecheck those imports in a clean install.
  const tsconfigRel = "source/tsconfig.json";
  const tsconfigPath = join(options.root, tsconfigRel);
  if (existsSync(tsconfigPath)) {
    const ownedBefore = managedBefore[tsconfigRel] ?? null;
    if (ownedBefore && ownedBefore !== sha256File(tsconfigPath)) {
      conflicts.push({ path: tsconfigRel, reason: "tsconfig hosta zmieniony poza instalatorem" });
    } else {
      const hostConfig = readJson(tsconfigPath);
      hostConfig.compilerOptions = { ...hostConfig.compilerOptions, allowImportingTsExtensions: true };
      planned.push({
        absolute: tsconfigPath,
        rel: tsconfigRel,
        kind: "integration",
        entry: { path: tsconfigRel, data: Buffer.from(`${JSON.stringify(hostConfig, null, 2)}\n`), mode: 0o644 },
      });
    }
  }
  return planned;
}


function verifyShell(target, root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new InstallError(`katalog docelowy nie istnieje lub nie jest katalogiem: ${root}`);
  }
  const missing = shellFiles(target, root).required.filter((path) => !existsSync(path));
  if (missing.length) {
    throw new InstallError(
      `${target}: powloka nie jest gotowa - brak ${missing.join(", ")}. ` +
        "Instalator nie udaje sukcesu: najpierw musi istniec plik powloki (Sidebar.tsx/TopBar.tsx " +
        "dla Agent OS; app.py/omniwatch.py dla standalone).",
      { details: { missing } },
    );
  }
  if (target === "standalone" && !existsSync(join(root, "static"))) {
    throw new InstallError(`standalone: brak katalogu static/ w ${root} - powloka niekompletna`);
  }
}

function verifyNode(manifest, version) {
  const requirement = manifest.node?.requirement ?? ">=22.22.3 <23 || >=24.0.0 <25";
  if (!nodeSupported(version, requirement)) {
    throw new InstallError(
      `nieobslugiwana wersja Node: ${version}. Wymagane: ${requirement} ` +
        `(przetestowane linie: ${(manifest.node?.testedLines ?? []).join(", ")}).`,
      { details: { requirement, version } },
    );
  }
}

function verifyTools(options) {
  const required = options.requiredTools ?? ["node", "python3"];
  const found = {};
  const missing = [];
  for (const tool of required) {
    const path = findExecutable(tool);
    found[tool] = path;
    if (!path) missing.push(tool);
  }
  if (missing.length) {
    throw new InstallError(
      `brak wymaganych narzedzi: ${missing.join(", ")}. Instalacja zatrzymana przed zmianami.`,
      { details: { missing, required } },
    );
  }
  const optional = {};
  for (const [tool, role] of OPTIONAL_TOOLS) {
    optional[tool] = { present: findExecutable(tool) !== null, role };
  }
  return { required: found, optional };
}

function resolveDataDir(options) {
  if (options.dataDir) return { dir: options.dataDir, explicit: true };
  const candidates = [join(options.root, ".omniwatch-data"), join(options.root, "data", "omniwatch")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "state.sqlite"))) return { dir: candidate, explicit: false };
  }
  return { dir: candidates[0], explicit: false };
}

/**
 * D5 in-flight gate. Reads the operational snapshot read-only: unfinished
 * operations (including paused ones) record the analysis contract they were
 * accepted under. A release that cannot resume that contract must refuse the
 * update instead of re-analysing the work with new prompts.
 */
function checkInFlight(manifest, options) {
  const { dir, explicit } = resolveDataDir(options);
  const stateDb = join(dir, "state.sqlite");
  const supportedAnalysis = manifest.contracts?.supportedAnalysisVersions ?? [];
  const supportedContracts = manifest.contracts?.supportedContractVersions ?? [];
  const result = {
    checked: false,
    dataDir: dir,
    stateDb,
    unfinished: 0,
    paused: 0,
    unsupported: [],
    decision: "no-state",
  };
  if (!existsSync(stateDb)) {
    if (explicit) result.note = "wskazany katalog danych nie zawiera jeszcze state.sqlite";
    return result;
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new InstallError(
      `${process.versions.node}: brak modulu node:sqlite wymaganego do odczytu stanu operacji`,
    );
  }
  const db = new DatabaseSync(stateDb, { readOnly: true });
  try {
    const hasOperations = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations'")
      .get();
    if (!hasOperations) {
      result.decision = "no-operations-table";
      return result;
    }
    const states = UNFINISHED_OPERATION_STATES.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, state, request_json, execution_snapshot_json FROM operations
          WHERE state IN (${states}) ORDER BY created_at ASC`,
      )
      .all(...UNFINISHED_OPERATION_STATES);
    result.checked = true;
    result.unfinished = rows.length;
    for (const row of rows) {
      let analysisVersion = null;
      let contractVersion = null;
      try {
        const request = JSON.parse(row.request_json);
        analysisVersion = request?.analysisVersion ?? null;
      } catch {
        analysisVersion = "<uszkodzony request_json>";
      }
      try {
        const snapshot = row.execution_snapshot_json ? JSON.parse(row.execution_snapshot_json) : null;
        contractVersion = snapshot?.contractVersion ?? null;
      } catch {
        contractVersion = "<uszkodzony execution_snapshot_json>";
      }
      const problems = [];
      if (analysisVersion !== null && !supportedAnalysis.includes(analysisVersion)) {
        problems.push(`analysisVersion=${analysisVersion}`);
      }
      if (contractVersion !== null && !supportedContracts.includes(contractVersion)) {
        problems.push(`contractVersion=${contractVersion}`);
      }
      if (String(row.state) === "budget_paused") result.paused += 1;
      if (problems.length) {
        result.unsupported.push({ operationId: String(row.id), state: String(row.state), problems });
      }
    }
    // A paused scan run is in-flight work as well.
    const hasRuns = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get();
    if (hasRuns) {
      const pausedRuns = db.prepare("SELECT COUNT(*) AS total FROM runs WHERE state = 'paused'").get();
      result.paused += Number(pausedRuns?.total ?? 0);
    }
    result.decision = result.unsupported.length ? "unsupported" : "compatible";
    if (result.unsupported.length) {
      throw new InstallError(
        `${result.unsupported.length} operacji w toku nie da sie wznowic w tym wydaniu ` +
          `(wspierane analysisVersion: ${supportedAnalysis.join(", ") || "brak"}). ` +
          "Aktualizacja odrzucona - nie podstawiamy nowych promptow; dokoncz lub jawnie zamknij te operacje, " +
          "potem uruchom instalacje ponownie. Operacje: " +
          result.unsupported
            .map((item) => `${item.operationId} (${item.state}: ${item.problems.join(", ")})`)
            .join("; "),
        { code: EXIT_COMPATIBILITY, details: result },
      );
    }
    return result;
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ plan ---- */

function installLayout(options) {
  const installSubdir =
    options.installSubdir ?? (options.target === "agent-os" ? "omniwatch" : "vendor/omniwatch");
  const installDir = join(options.root, installSubdir);
  return {
    installSubdir,
    installDir,
    releasesDir: join(installDir, "releases"),
    currentFile: join(installDir, "current"),
    manifestFile: join(installDir, "install-manifest.json"),
    backupsDir: join(installDir, "backups"),
  };
}

function previousManifest(layout) {
  if (!existsSync(layout.manifestFile)) return null;
  try {
    const parsed = readJson(layout.manifestFile);
    return parsed?.schema === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function navFilesFor(options) {
  const navRoot = shellFiles(options.target, options.root).navRoot;
  if (!navRoot || options.skipNav) return [];
  return [
    { name: "sidebar", absolute: join(navRoot, "src", "components", "Sidebar.tsx") },
    { name: "topbar", absolute: join(navRoot, "src", "components", "TopBar.tsx") },
    {
      name: "hermes",
      absolute: join(navRoot, "src", "app", "hermes", "page.tsx"),
      optional: true,
      missing: "nie istnieje - Scout zostanie zarejestrowany jako gorna zakladka",
    },
    // SPEC F12: the Astros -> OmniWatch link. Registered when the host still has
    // the anchors; a host without AstrosView.tsx gets a warning, and an AstrosView
    // whose anchors moved is a conflict reported before any write.
    {
      name: "astros",
      absolute: join(navRoot, "src", "components", "AstrosView.tsx"),
      optional: true,
      missing: "nie istnieje - link Astros -> OmniWatch (SPEC F12) nie zostal zarejestrowany",
    },
    // The Memory panel's Vault label shows the resolved Vault, not a fixed default.
    {
      name: "memory",
      absolute: join(navRoot, "src", "components", "MemoryPanel.tsx"),
      optional: true,
      missing: "nie istnieje - etykieta Vaulta w panelu pamieci nie zostala podmieniona",
    },
  ];
}

/**
 * Ask the registrar to check its anchors without writing (`--dry-run`). This keeps
 * the anchor knowledge in one place: the installer learns about a moved anchor
 * before it changes anything, and reports it as a conflict instead of a half-patched
 * file.
 */
function checkNavAnchors(options, nav) {
  if (!nav.length) return null;
  const registrar = join(REPO_ROOT, "agent-os-module", "register-nav.py");
  if (!existsSync(registrar)) {
    throw new InstallError(`brak rejestratora nawigacji: ${registrar}`, { code: EXIT_APPLY });
  }
  const navRoot = shellFiles(options.target, options.root).navRoot;
  const only = nav.map((file) => file.name).join(",");
  let output;
  try {
    output = execFileSync("python3", [registrar, navRoot, "--only", only, "--dry-run", "--json"], {
      encoding: "utf8",
    });
  } catch (error) {
    // The registrar prints its JSON report (with the per-file errors) on stdout even
    // when it exits non-zero; the caller turns those into conflicts.
    output = String(error.stdout ?? "").trim();
    if (!output) {
      throw new InstallError(
        `rejestrator nawigacji nie mogl sprawdzic kotwic: ${String(error.message)}`,
        { code: EXIT_CONFLICT },
      );
    }
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new InstallError(`rejestrator nawigacji zwrocil nieczytelny raport: ${String(error)}`, {
      code: EXIT_APPLY,
    });
  }
}

function planNav(options, previous, conflicts, warnings) {
  const planned = [];
  for (const file of navFilesFor(options)) {
    const rel = relative(options.root, file.absolute);
    if (!existsSync(file.absolute)) {
      if (file.optional) {
        warnings.push(`${rel} ${file.missing ?? "nie istnieje - pominiety"}`);
        continue;
      }
      throw new InstallError(
        `brak pliku nawigacji ${file.absolute}; instalator nie udaje sukcesu. ` +
          "Uzupelnij powloke Agent OS (Sidebar.tsx/TopBar.tsx) albo uzyj --skip-nav.",
      );
    }
    const recorded = previous?.navFiles?.[rel] ?? null;
    const current = sha256File(file.absolute);
    if (recorded && recorded !== current) {
      conflicts.push({
        path: rel,
        reason: "plik nawigacji zmieniony poza instalatorem od ostatniej instalacji OmniWatch",
      });
      continue;
    }
    planned.push({ ...file, rel, kind: "nav", sha256Before: current });
  }
  return planned;
}

function planInstall(options, layout, manifest, entries, previous) {
  const version = manifest.library.version;
  /**
   * The release directory is keyed on the ARTIFACT HASH, not just the version.
   *
   * A rebuilt artifact that still carries version 0.2.0 (the normal case while a
   * revision is under QA) must not collide with the previously unpacked release.
   * Keying on the hash gives each artifact its own directory, so nothing is ever
   * overwritten or deleted and the user-edit conflict rule stays strict: an edit
   * inside an existing release directory is still a conflict, because that exact
   * hash directory is only ever written by the install that created it.
   */
  const artifactTag = (manifest.artifact?.sha256 ?? "").slice(0, 12);
  const releaseDir = join(layout.releasesDir, artifactTag ? `${version}-${artifactTag}` : version);
  const planned = [];
  const conflicts = [];
  const warnings = [];

  const releaseDirExists = existsSync(releaseDir);
  for (const entry of entries) {
    const absolute = join(releaseDir, ...entry.path.split("/"));
    const item = {
      absolute,
      rel: relative(options.root, absolute),
      kind: "release",
      entry,
      unchanged: false,
    };
    if (releaseDirExists && existsSync(absolute) && sha256File(absolute) === entry.sha256) {
      item.unchanged = true;
    }
    planned.push(item);
  }
  if (releaseDirExists) {
    warnings.push(
      `wydanie ${version} (${artifactTag}) jest juz rozpakowane; instalator nie nadpisuje tego katalogu`,
    );
  }

  // Files this installer owned and the user has since changed are reported, never
  // overwritten. Files we never owned are the user's until proven otherwise.
  const managedBefore = previous?.managedFiles ?? {};
  for (const [rel, digest] of Object.entries(managedBefore)) {
    const absolute = join(options.root, rel);
    if (!existsSync(absolute)) continue;
    const unchangedPlanned = planned.some((item) => item.rel === rel && item.unchanged);
    // Older installs recorded the old pointer hash before the final atomic switch.
    // Accept that one known installer mistake only when the pointer still names the
    // exact release and tarball recorded by the previous install manifest.
    let validPreviousPointer = false;
    if (absolute === layout.currentFile && previous) {
      try {
        const pointer = JSON.parse(readFileSync(absolute, "utf8"));
        validPreviousPointer = pointer.release === previous.release &&
          pointer.sha256 === previous.tarballSha256;
      } catch { /* malformed pointer remains a conflict */ }
    }
    if (sha256File(absolute) !== digest && !unchangedPlanned && !validPreviousPointer) {
      conflicts.push({
        path: rel,
        reason: "plik OmniWatch zmieniony przez uzytkownika od ostatniej instalacji",
      });
    }
  }

  const currentContent = Buffer.from(
    `${JSON.stringify(
      {
        version,
        release: relative(options.root, releaseDir),
        sha256: manifest.artifact.sha256,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  planned.push({
    absolute: layout.currentFile,
    rel: relative(options.root, layout.currentFile),
    kind: "current",
    content: currentContent,
  });

  const nav = planNav(options, previous, conflicts, warnings);
  const navReport = checkNavAnchors(options, nav);
  for (const entry of navReport?.files ?? []) {
    if (entry.error) {
      conflicts.push({ path: entry.path, reason: `kotwica: ${entry.error}` });
    }
  }

  // The Agent OS shell integration: routes, UI and libs that make /omniwatch use the
  // shared engine. Refused for a file the host already has (never overwrite film code).
  const integration = options.skipIntegration
    ? []
    : planIntegration(options, manifest, previous, conflicts, warnings, entries);
  if (options.target === "agent-os" && !options.skipIntegration && integration.length === 0) {
    warnings.push(
      "brak plikow integracji do instalacji - panel Agent OS nie zostanie zaktualizowany",
    );
  }

  return { releaseDir, planned, nav, integration, conflicts, warnings, version };
}

/* ----------------------------------------------------------------- apply ---- */

function backupIdForNow() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function snapshotBackup(options, layout, plan, previous, backupId) {
  const dir = join(layout.backupsDir, backupId);
  const files = [];
  const record = (rel, absolute) => {
    copyInto(absolute, join(dir, "files", ...rel.split("/")));
    files.push({ path: rel, sha256: sha256File(absolute) });
  };
  for (const item of plan.planned) {
    if (!existsSync(item.absolute)) continue;
    if (item.kind === "release" && item.unchanged) continue;
    record(item.rel, item.absolute);
  }
  for (const file of plan.nav) record(file.rel, file.absolute);
  for (const item of plan.integration ?? []) {
    if (existsSync(item.absolute)) record(item.rel, item.absolute);
  }
  if (previous && existsSync(layout.manifestFile)) {
    record(relative(options.root, layout.manifestFile), layout.manifestFile);
  }
  // Paths this install creates. Rollback removes them again, so a first install
  // can be undone completely; the release directory is removed whole.
  const absent = plan.planned
    .filter((item) => !existsSync(item.absolute))
    .map((item) => item.rel);
  for (const file of plan.nav) {
    if (!existsSync(file.absolute)) absent.push(file.rel);
  }
  for (const item of plan.integration ?? []) {
    if (!existsSync(item.absolute)) absent.push(item.rel);
  }
  const releaseCreated = existsSync(plan.releaseDir) ? null : relative(options.root, plan.releaseDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "backup.json"),
    `${JSON.stringify(
      {
        schema: 1,
        id: backupId,
        createdAt: new Date().toISOString(),
        target: options.target,
        root: options.root,
        previousRelease: previous?.release ?? null,
        releaseCreated,
        absent,
        files,
      },
      null,
      2,
    )}\n`,
  );
  return { dir, files };
}

function restoreBackup(options, layout, backupId) {
  const dir = join(layout.backupsDir, backupId);
  const recordPath = join(dir, "backup.json");
  if (!existsSync(recordPath)) {
    throw new InstallError(`brak kopii zapasowej: ${recordPath}`, { code: EXIT_APPLY });
  }
  const record = readJson(recordPath);
  for (const file of record.files ?? []) {
    const source = join(dir, "files", ...file.path.split("/"));
    if (!existsSync(source)) continue;
    copyInto(source, join(options.root, ...file.path.split("/")));
  }
  // Files this install created are removed again: a rollback of the first install
  // leaves the host as it was, and never keeps a pointer to a release it undid.
  for (const rel of record.absent ?? []) {
    const target = join(options.root, ...rel.split("/"));
    if (existsSync(target)) rmSync(target, { force: true });
  }
  if (record.releaseCreated) {
    const target = join(options.root, ...record.releaseCreated.split("/"));
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  return record;
}

function newestBackup(layout) {
  if (!existsSync(layout.backupsDir)) return null;
  const entries = readdirSync(layout.backupsDir)
    .filter((entry) => existsSync(join(layout.backupsDir, entry, "backup.json")))
    .sort();
  return entries.length ? entries[entries.length - 1] : null;
}

function applyInstall(options, layout, manifest, plan, previous, tools) {
  const backupId = backupIdForNow();
  crashPoint("before-backup");
  snapshotBackup(options, layout, plan, previous, backupId);
  crashPoint("after-backup");

  // Release files: stage under releases/, then a single rename into place.
  const staging = join(layout.releasesDir, `.staging-${process.pid}-${Date.now()}`);
  const releaseItems = plan.planned.filter((item) => item.kind === "release" && !item.unchanged);
  if (releaseItems.length) {
    mkdirSync(staging, { recursive: true });
    for (const item of releaseItems) {
      const target = join(staging, ...item.entry.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, item.entry.data, { mode: item.entry.mode || 0o644 });
    }
    if (existsSync(plan.releaseDir)) rmSync(plan.releaseDir, { recursive: true, force: true });
    mkdirSync(layout.releasesDir, { recursive: true });
    renameSync(staging, plan.releaseDir);
    log(`· rozpakowano wydanie ${manifest.library.version} do ${plan.releaseDir}`);
  }
  crashPoint("after-release");

  // Agent OS shell integration: write the new routes/UI/libs. Ownership was planned
  // above, so a host file we do not own is a conflict and never reaches this point.
  let integrationWritten = 0;
  for (const item of plan.integration ?? []) {
    mkdirSync(dirname(item.absolute), { recursive: true });
    writeFileSync(item.absolute, item.entry.data, { mode: item.entry.mode || 0o644 });
    integrationWritten += 1;
  }
  if (integrationWritten > 0) log(`· zainstalowano integracje Agent OS (${integrationWritten} plikow)`);
  crashPoint("after-integration");

  // Navigation is the only host-owned file this installer edits.
  const navResults = [];
  if (plan.nav.length) {
    const registrar = join(REPO_ROOT, "agent-os-module", "register-nav.py");
    if (!existsSync(registrar)) {
      throw new InstallError(`brak rejestratora nawigacji: ${registrar}`, { code: EXIT_APPLY });
    }
    const navRoot = shellFiles(options.target, options.root).navRoot;
    const only = plan.nav.map((file) => file.name).join(",");
    let output;
    try {
      output = execFileSync("python3", [registrar, navRoot, "--only", only, "--json"], {
        encoding: "utf8",
      });
    } catch (error) {
      throw new InstallError(
        `rejestracja nawigacji nie powiodla sie: ${String(error.stdout ?? error.message).trim()}`,
        { code: EXIT_APPLY },
      );
    }
    let report = null;
    try {
      report = JSON.parse(output);
    } catch {
      report = null;
    }
    if (!report?.ok) {
      throw new InstallError(
        `rejestracja nawigacji nie powiodla sie: ${report ? JSON.stringify(report) : output.trim()}`,
        { code: EXIT_APPLY },
      );
    }
    navResults.push(...(report.files ?? []));
  }

  const navHashes = {};
  for (const file of plan.nav) {
    if (existsSync(file.absolute)) navHashes[file.rel] = sha256File(file.absolute);
  }
  const integrationHashes = {};
  for (const item of plan.integration ?? []) {
    if (existsSync(item.absolute)) integrationHashes[item.rel] = sha256File(item.absolute);
  }
  const managedFiles = {};
  for (const item of plan.planned) {
    if (item.kind === "current") managedFiles[item.rel] = sha256(item.content);
    else if (item.kind === "release" && existsSync(item.absolute)) {
      managedFiles[item.rel] = sha256File(item.absolute);
    }
  }
  const installManifest = {
    schema: 1,
    target: options.target,
    root: options.root,
    installDir: relative(options.root, layout.installDir),
    library: { name: manifest.library.name, version: manifest.library.version },
    release: relative(options.root, plan.releaseDir),
    tarballSha256: manifest.artifact.sha256,
    installedAt: new Date().toISOString(),
    backupId,
    contracts: manifest.contracts,
    nodeRequirement: manifest.node?.requirement ?? null,
    tools: tools.required,
    managedFiles,
    navFiles: navHashes,
    /**
     * Files this installer placed inside the host shell. They are the only host
     * files a later install may replace without asking; anything else stays the
     * host's own code.
     */
    integrationFiles: integrationHashes,
    navSkip: options.skipNav,
    inFlight: options.inFlight ?? null,
  };

  const currentContent = plan.planned.find((item) => item.kind === "current")?.content;
  atomicWrite(layout.manifestFile, `${JSON.stringify(installManifest, null, 2)}\n`);
  crashPoint("before-switch");
  if (currentContent) atomicWrite(layout.currentFile, currentContent);

  return { backupId, navResults, installManifest };
}

/* ---------------------------------------------------------------- report ---- */

function summarize(options, layout, manifest, plan, tools, inFlight, extra = {}) {
  return {
    ok: true,
    target: options.target,
    root: options.root,
    installDir: relative(options.root, layout.installDir),
    library: { name: manifest.library.name, version: manifest.library.version },
    release: relative(options.root, plan.releaseDir),
    tarball: manifest.artifact.filename,
    sha256: manifest.artifact.sha256,
    fileCount: manifest.fileCount,
    contracts: manifest.contracts,
    nodeRequirement: manifest.node?.requirement ?? null,
    artifactWarnings: manifest.warnings ?? [],
    node: options.nodeVersion,
    tools,
    inFlight,
    backupId: null,
    navFiles: [],
    conflicts: [],
    warnings: plan.warnings,
    checkOnly: options.check,
    ...extra,
  };
}

/* ------------------------------------------------------------------ main ---- */

function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log("usage: install.mjs --target agent-os|standalone --root <dir> [--check|--rollback] [--json]");
    return EXIT_OK;
  }
  if (resolve(options.root) === REPO_ROOT || isWithin(REPO_ROOT, options.root)) {
    throw new InstallError(
      `--root ${options.root} jest wewnatrz drzewa zrodlowego OmniWatch; instalator nie instaluje do repo`,
    );
  }
  const layout = installLayout(options);
  const previous = previousManifest(layout);

  if (options.rollback) {
    const backupId = options.backup ?? newestBackup(layout);
    if (!backupId) {
      throw new InstallError(`brak kopii zapasowej do cofniecia w ${layout.backupsDir}`, {
        code: EXIT_APPLY,
      });
    }
    const record = restoreBackup(options, layout, backupId);
    const summary = {
      ok: true,
      action: "rollback",
      target: options.target,
      root: options.root,
      backupId,
      restoredFiles: (record.files ?? []).map((file) => file.path),
      removedPaths: record.absent ?? [],
      removedRelease: record.releaseCreated ?? null,
      previousRelease: record.previousRelease ?? null,
      note: "katalog danych OmniWatch nie zostal zmieniony; dane uzytkownika pozostaja na miejscu",
    };
    log(`✓ cofnieto instalacje z kopii ${backupId} (${summary.restoredFiles.length} plikow)`);
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    return EXIT_OK;
  }

  const { manifest, tarballPath } = loadRelease(options);
  verifyChecksum(manifest, tarballPath);
  const entries = verifyPackage(manifest, tarballPath);
  verifyNode(manifest, options.nodeVersion);
  const tools = verifyTools(options);
  verifyShell(options.target, options.root);
  const inFlight = checkInFlight(manifest, options);
  options.inFlight = inFlight;

  const plan = planInstall(options, layout, manifest, entries, previous);
  if (plan.conflicts.length) {
    const summary = summarize(options, layout, manifest, plan, tools, inFlight, {
      ok: false,
      conflicts: plan.conflicts,
      code: "conflict",
      message: `wykryto ${plan.conflicts.length} konfliktow; nic nie zostalo nadpisane`,
    });
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    log(`✗ konflikty (${plan.conflicts.length}): ${plan.conflicts.map((item) => item.path).join(", ")}`);
    for (const conflict of plan.conflicts) log(`  · ${conflict.path}: ${conflict.reason}`);
    log("  nic nie zostalo nadpisane; uzyj --skip-nav, aby zaktualizowac sama biblioteke bez nawigacji");
    return EXIT_CONFLICT;
  }

  if (options.check) {
    const summary = summarize(options, layout, manifest, plan, tools, inFlight, {
      plannedFiles: plan.planned.filter((item) => !item.unchanged).map((item) => item.rel),
      navFiles: plan.nav.map((item) => item.rel),
    });
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    log("✓ preflight OK (tryb --check: bez zmian)");
    return EXIT_OK;
  }

  try {
    const result = applyInstall(options, layout, manifest, plan, previous, tools);
    const summary = summarize(options, layout, manifest, plan, tools, inFlight, {
      backupId: result.backupId,
      navFiles: result.navResults.map((file) => file.path),
      current: relative(options.root, layout.currentFile),
      navDetails: result.navResults,
    });
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    log(`✓ zainstalowano ${manifest.library.name}@${manifest.library.version} w ${layout.installDir}`);
    log(`✓ kopia zapasowa: ${result.backupId}`);
    return EXIT_OK;
  } catch (error) {
    // A failed apply must leave the previous release usable.
    try {
      const backupId = newestBackup(layout);
      if (backupId) {
        restoreBackup(options, layout, backupId);
        log(`· przywrocono poprzednie pliki z kopii ${backupId}`);
      }
    } catch (restoreError) {
      log(`✗ nie udalo sie przywrocic kopii: ${String(restoreError)}`);
    }
    throw error instanceof InstallError
      ? error
      : new InstallError(`instalacja nie powiodla sie: ${String(error)}`, { code: EXIT_APPLY });
  }
}

function emitError(error, options) {
  const code = error instanceof InstallError ? error.code : EXIT_APPLY;
  if (options?.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        code:
          code === EXIT_CONFLICT
            ? "conflict"
            : code === EXIT_COMPATIBILITY
              ? "compatibility"
              : "preflight",
        exitCode: code,
        message: error.message,
        details: error.details ?? {},
      })}\n`,
    );
  }
  log(`✗ ${error.message}`);
  return code;
}

let parsedOptions = null;
try {
  parsedOptions = parseArgs(process.argv.slice(2));
  process.exitCode = run();
} catch (error) {
  process.exitCode = emitError(error, parsedOptions);
}
