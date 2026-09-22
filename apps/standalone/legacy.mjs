/**
 * Beta data compatibility (T7 / D2).
 *
 * Reads the released Python beta's data exactly as it is and never rewrites it:
 *
 *   <root>/.cache/<id>/info.json     yt-dlp metadata (`extractor_key`, `channel`/`uploader`)
 *   <root>/.cache/<id>/source.mp4    the downloaded film
 *   <root>/.cache/<id>/oss.json      temporary upload URLs, `at` in SECONDS
 *   <root>/.cache/<id>/frames/*.jpg  already rendered frames
 *   <root>/summaries/<id>.md         one Markdown file per film, appended per question
 *
 * The identity/metadata/TTL rules themselves live in the shared library
 * (`packages/omniwatch/src/sources/legacy.ts`); this module is the filesystem adapter
 * around them plus an idempotent migration index. Migration performs no download and
 * no model call: it only reads files and writes one index under the new data dir.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BETA_OSS_TTL_HOURS,
  evaluateUploadFreshness,
  normalizeLegacyInfo,
  parseLegacyInfoJson,
  resolveLegacyId,
  tryNormalizeLegacyInfo,
} from "../../packages/omniwatch/src/sources/legacy.ts";

export {
  BETA_OSS_TTL_HOURS,
  evaluateUploadFreshness,
  normalizeLegacyInfo,
  parseLegacyInfoJson,
  resolveLegacyId,
  tryNormalizeLegacyInfo,
};

export const LEGACY_INDEX_PROTOCOL = "omniwatch.legacy-index.v1";

/**
 * Roots that may hold beta data. The released install keeps everything next to the
 * scripts; a `legacy/` subdirectory is also accepted so an installation that was
 * copied aside (as the compatibility fixtures are) stays readable. The first root
 * that has the artifact wins; nothing is ever written back.
 */
export function legacyRoots(appRoot) {
  return [path.resolve(appRoot), path.join(path.resolve(appRoot), "legacy")];
}

/** Filenames are joined into a path, so refuse anything that is not a plain id. */
export function assertSafeLegacyId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Brak identyfikatora materialu.");
  }
  const id = value.trim();
  if (
    id.length > 200 ||
    /[/\\]/.test(id) ||
    id.includes("..") ||
    /^\.+$/.test(id) ||
    !/^[\w.@+-]+$/u.test(id)
  ) {
    throw new Error(`Niepoprawny identyfikator materialu: "${value}".`);
  }
  return id;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function tryStat(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function legacyCacheDirFor(appRoot, id) {
  const safeId = assertSafeLegacyId(id);
  return firstExisting(legacyCacheDirsFor(appRoot, safeId));
}

/**
 * Every `<root>/.cache/<id>` directory that exists. A beta install keeps metadata and
 * media together; a copied-aside tree may split them (metadata next to the scripts,
 * media under `legacy/`), so each artifact is looked up independently.
 */
export function legacyCacheDirsFor(appRoot, id) {
  const safeId = assertSafeLegacyId(id);
  return legacyRoots(appRoot)
    .map((root) => path.join(root, ".cache", safeId))
    .filter((dir) => existsSync(dir));
}

export function legacySummariesDirFor(appRoot) {
  return firstExisting(legacyRoots(appRoot).map((root) => path.join(root, "summaries")));
}

/** The beta's summary file, byte-for-byte, or null when it does not exist. */
export function readLegacySummary(appRoot, id) {
  const dir = legacySummariesDirFor(appRoot);
  if (!dir) return null;
  const file = path.join(dir, `${assertSafeLegacyId(id)}.md`);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  return { id, path: file, bytes, sha256: sha256(bytes), mtimeSeconds: Math.floor(statSync(file).mtimeMs / 1000) };
}

/**
 * One cache entry: normalised metadata plus the raw file facts. A missing or damaged
 * `info.json` is reported, never repaired: the beta's analysis Markdown stays valid.
 */
export function readLegacyCacheEntry(appRoot, id) {
  const safeId = assertSafeLegacyId(id);
  const dirs = legacyCacheDirsFor(appRoot, safeId);
  if (dirs.length === 0) return null;
  const infoDir = dirs.find((dir) => existsSync(path.join(dir, "info.json"))) ?? null;
  const mediaDir = dirs.find((dir) => existsSync(path.join(dir, "source.mp4"))) ?? dirs[0];
  const dir = infoDir ?? mediaDir;
  const infoPath = path.join(infoDir ?? mediaDir, "info.json");
  const sourcePath = path.join(mediaDir, "source.mp4");
  const sourceStat = tryStat(sourcePath);
  let info = null;
  let infoError = null;
  let infoRaw = null;
  if (existsSync(infoPath)) {
    const bytes = readFileSync(infoPath);
    infoRaw = { path: infoPath, sha256: sha256(bytes), mtimeSeconds: Math.floor(statSync(infoPath).mtimeMs / 1000) };
    try {
      info = parseLegacyInfoJson(bytes.toString("utf8"));
    } catch (error) {
      infoError = error instanceof Error ? error.message : String(error);
    }
  }
  const framesDir = path.join(mediaDir, "frames");
  const frames = existsSync(framesDir)
    ? readdirSync(framesDir).filter((name) => name.endsWith(".jpg")).sort()
    : [];
  const parts = readdirSync(mediaDir).filter((name) => /^part_\d+_\d+\.mp4$/.test(name)).sort();
  return {
    id: safeId,
    dir,
    infoDir,
    mediaDir,
    infoPath: existsSync(infoPath) ? infoPath : null,
    info,
    infoError,
    infoRaw,
    sourcePath: sourceStat ? sourcePath : null,
    sourceBytes: sourceStat ? sourceStat.size : null,
    frames,
    parts,
  };
}

/**
 * `oss.json` verdicts. `at` is in SECONDS in the beta; the TTL defaults to the beta's
 * 47 h and a configured `OMNI_CACHE_HOURS` (48) overrides it. Expired, future and
 * malformed entries are never reusable and are never rewritten.
 */
export function readLegacyUploads(appRoot, id, options = {}) {
  const safeId = assertSafeLegacyId(id);
  const dir = legacyCacheDirFor(appRoot, safeId);
  if (!dir) return null;
  const file = path.join(dir, "oss.json");
  if (!existsSync(file)) return { id: safeId, path: null, entries: [], malformed: false };
  const nowSeconds = Number.isFinite(options.nowSeconds) ? options.nowSeconds : Math.floor(Date.now() / 1000);
  const cacheHours = options.cacheHours ?? BETA_OSS_TTL_HOURS;
  let raw;
  try {
    raw = readJson(file);
  } catch {
    return { id: safeId, path: file, entries: [], malformed: true };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { id: safeId, path: file, entries: [], malformed: true };
  }
  const entries = Object.entries(raw).map(([name, entry]) => ({
    name,
    entry,
    freshness: evaluateUploadFreshness(entry, cacheHours, nowSeconds),
  }));
  return { id: safeId, path: file, entries, malformed: false };
}

function listCacheIds(root) {
  const cacheDir = path.join(root, ".cache");
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listSummaryIds(root) {
  const summariesDir = path.join(root, "summaries");
  if (!existsSync(summariesDir)) return [];
  return readdirSync(summariesDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}

/**
 * Everything the beta left behind, grouped by legacy id. Only reads.
 */
export function readLegacyInstall(appRoot, options = {}) {
  const ids = new Set();
  for (const root of legacyRoots(appRoot)) {
    for (const id of listCacheIds(root)) ids.add(id);
    for (const id of listSummaryIds(root)) ids.add(id);
  }
  const entries = [];
  for (const id of [...ids].sort()) {
    const summary = readLegacySummary(appRoot, id);
    const cache = readLegacyCacheEntry(appRoot, id);
    const uploads = readLegacyUploads(appRoot, id, options);
    entries.push({
      legacyId: id,
      summary,
      cache,
      uploads,
    });
  }
  return entries;
}

function summaryFingerprint(summary) {
  if (!summary) return null;
  return { path: summary.path, sha256: summary.sha256, bytes: summary.bytes.length };
}

function cacheFingerprint(cache) {
  if (!cache) return null;
  return {
    dir: cache.dir,
    info: cache.infoRaw ? { path: cache.infoRaw.path, sha256: cache.infoRaw.sha256 } : null,
    infoError: cache.infoError,
    normalized: cache.info
      ? {
          id: cache.info.id,
          title: cache.info.title,
          channel: cache.info.channel,
          duration: cache.info.duration,
          extractor: cache.info.extractor,
        }
      : null,
    source: cache.sourcePath ? { path: cache.sourcePath, bytes: cache.sourceBytes } : null,
    frames: cache.frames,
    parts: cache.parts,
  };
}

function uploadFingerprint(uploads) {
  if (!uploads) return null;
  return {
    path: uploads.path,
    malformed: uploads.malformed,
    entries: uploads.entries.map((item) => ({
      name: item.name,
      url: typeof item.entry?.url === "string" ? item.entry.url : null,
      at: typeof item.entry?.at === "number" ? item.entry.at : null,
      freshness: item.freshness,
    })),
  };
}

/**
 * Build the migration document. Deterministic: the same input tree always produces
 * the same bytes, so a second run cannot duplicate an entry or shuffle the mapping.
 */
export function buildLegacyIndex(appRoot, options = {}) {
  const nowSeconds = Number.isFinite(options.nowSeconds) ? options.nowSeconds : Math.floor(Date.now() / 1000);
  const cacheHours = options.cacheHours ?? BETA_OSS_TTL_HOURS;
  const entries = readLegacyInstall(appRoot, { nowSeconds, cacheHours }).map((entry) => ({
    legacyId: entry.legacyId,
    summary: summaryFingerprint(entry.summary),
    cache: cacheFingerprint(entry.cache),
    uploads: uploadFingerprint(entry.uploads),
  }));
  return {
    protocol: LEGACY_INDEX_PROTOCOL,
    source: { appRoot: path.resolve(appRoot), roots: legacyRoots(appRoot).filter((root) => existsSync(root)) },
    clock: { nowSeconds },
    cacheHours,
    betaOssTtlHours: BETA_OSS_TTL_HOURS,
    counts: {
      entries: entries.length,
      summaries: entries.filter((entry) => entry.summary).length,
      cacheEntries: entries.filter((entry) => entry.cache).length,
      freshUploads: entries.reduce(
        (sum, entry) => sum + (entry.uploads?.entries ?? []).filter((item) => item.freshness.valid).length,
        0,
      ),
      modelCalls: 0,
      downloads: 0,
    },
    entries,
  };
}

export function legacyIndexPath(dataDir) {
  return path.join(path.resolve(dataDir), "legacy-index.json");
}

export function readLegacyIndex(dataDir) {
  const file = legacyIndexPath(dataDir);
  if (!existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

/**
 * The migration step of D2: index the beta data under the new data directory. It
 * never downloads, never calls a model and never touches the beta's own files, so it
 * is safe to run before every start. Running it twice produces identical bytes.
 */
export function migrateLegacyData(options) {
  const appRoot = path.resolve(options.appRoot);
  const dataDir = path.resolve(options.dataDir);
  const document = buildLegacyIndex(appRoot, {
    nowSeconds: options.nowSeconds,
    cacheHours: options.cacheHours,
  });
  const body = `${JSON.stringify(document, null, 2)}\n`;
  const target = legacyIndexPath(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
  writeFileSync(target, body, "utf8");
  return {
    index: document,
    path: target,
    changed: previous !== body,
    /** Explicit, so a caller can assert that migration stayed offline. */
    modelCalls: 0,
    downloads: 0,
  };
}

/**
 * Read an analysis for a legacy id. The shared knowledge library wins; when it has
 * nothing, the beta Markdown is returned byte-for-byte with `source: "legacy"`.
 */
export function readAnalysisCompat(options) {
  const id = assertSafeLegacyId(options.id);
  const memoryDir = path.join(path.resolve(options.dataDir), "knowledge", "Analyses");
  if (existsSync(memoryDir)) {
    for (const name of readdirSync(memoryDir)) {
      if (!name.endsWith(".md")) continue;
      const text = readFileSync(path.join(memoryDir, name), "utf8");
      const payload = parseRuntimeNote(text);
      if (!payload) continue;
      if (payload.sourceRef?.legacyId !== id && payload.analysisId !== id) continue;
      return { id, source: "runtime", path: path.join(memoryDir, name), content: payload.content ?? "" };
    }
  }
  const summary = readLegacySummary(options.appRoot, id);
  if (!summary) return null;
  return { id, source: "legacy", path: summary.path, content: summary.bytes.toString("utf8"), bytes: summary.bytes };
}

const RUNTIME_NOTE_PREFIX = "<!-- omniwatch:analysis ";
const RUNTIME_NOTE_SUFFIX = " -->";

/** The knowledge note keeps its machine-readable payload in a first-line comment. */
export function parseRuntimeNote(text) {
  if (typeof text !== "string" || !text.startsWith(RUNTIME_NOTE_PREFIX)) return null;
  const end = text.indexOf(RUNTIME_NOTE_SUFFIX);
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(RUNTIME_NOTE_PREFIX.length, end));
  } catch {
    return null;
  }
}

export function summarizeLegacyIndex(index) {
  if (!index) return null;
  return {
    protocol: index.protocol,
    entries: index.counts?.entries ?? index.entries?.length ?? 0,
    summaries: index.counts?.summaries ?? 0,
    cacheEntries: index.counts?.cacheEntries ?? 0,
    freshUploads: index.counts?.freshUploads ?? 0,
    modelCalls: 0,
    downloads: 0,
  };
}
