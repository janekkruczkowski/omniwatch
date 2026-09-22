/**
 * Shared offline harness for the OmniWatch Agent OS E2E tests (T6).
 *
 * Everything here runs with plain `node --test`: no Next, no React, no Playwright, no
 * network and no paid model. A real SQLite store, a real fixture source and a recording
 * stub model are enough to exercise the route handlers the way the panel does.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFixtureSource, createLocalMemory, createLogger, systemClock } from "../../packages/omniwatch/src/runtime/poc.ts";
import { openSqliteStore } from "../../packages/omniwatch/src/storage/index.ts";

export const tempDirs = [];

export function tempDir(prefix = "omniwatch-t6-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Deterministic model that records every call, so tests can inspect the real prompt. */
export function recordingModel(options = {}) {
  const calls = [];
  return {
    modelName: options.name ?? "stub-recording",
    calls,
    async call(request) {
      calls.push({
        operationId: request.operationId,
        attemptId: request.attemptId,
        partIndex: request.partIndex,
        messages: request.messages,
        text: request.messages.map((message) => message.text).join("\n"),
      });
      const body = (options.reply ?? "## Summary\n- [0:05] punkt pierwszy\n- [0:20] punkt drugi")
        .replace("{part}", String(request.partIndex));
      return {
        text: body,
        usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.002, costKnown: true },
        completed: true,
      };
    },
  };
}

export function configPort({ dataDir, memoryRoot, language = "pl", maxFramesPerPart = 1_000_000 }) {
  return {
    dataDir,
    memoryRoot,
    language,
    modelName: "stub-recording",
    apiKey: () => "test-key",
    apiBaseUrl: () => "https://example.invalid/v1",
    // One part by default, so a test asserts on the whole-video prompt (focus, history)
    // instead of a per-part notes prompt.
    maxFramesPerPart: () => maxFramesPerPart,
    cacheHours: () => 48,
  };
}

/** One runtime bundle over a temp data dir, plus the store so tests can inspect it. */
export function createHarness(options = {}) {
  const dir = options.dir ?? tempDir();
  const dataDir = join(dir, "data");
  const memoryRoot = join(dir, "vault");
  mkdirSync(dataDir, { recursive: true });
  const store = options.store ?? openSqliteStore({ path: join(dataDir, "state.sqlite"), ownerStaleAfterMs: 0 });
  store.migrate();
  const model = options.model ?? recordingModel();
  const source = options.source ?? createFixtureSource({
    title: options.title ?? "Synthetic clip",
    channel: options.channel ?? "Chan",
    durationSeconds: options.durationSeconds ?? 240,
  });
  const memory = options.memory ?? createLocalMemory({ root: memoryRoot });
  const clock = options.clock ?? systemClock();
  const logs = [];
  const logger = options.logger ?? createLogger({ sink: (line) => logs.push(line), level: "error" });
  const config = configPort({
    dataDir,
    memoryRoot,
    language: options.language ?? "pl",
    ...(options.maxFramesPerPart ? { maxFramesPerPart: options.maxFramesPerPart } : {}),
  });
  const deps = { clock, logger, config, store, source, model, memory };
  return { dir, dataDir, memoryRoot, store, model, source, memory, clock, logger, logs, config, deps };
}

/** A cached-video lookup that answers for the ids a test declares. */
export function cachedIds(ids) {
  const set = new Set(ids);
  return async (id) => set.has(id);
}

/** Media metadata lookup, cache-only: what the panel can show without downloading. */
export function mediaLookup(entries = {}) {
  return async (sourceRef) => {
    const key = sourceRef.legacyId ?? sourceRef.sourceId;
    return entries[key] ?? null;
  };
}

/** One listed material, shaped like the core's `ListingItem`. */
export function videoItem(id, seconds, title) {
  return {
    sourceRef: {
      platform: "youtube",
      sourceId: id,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      legacyId: id,
    },
    title: title ?? `Video ${id}`,
    durationSeconds: seconds,
    publishedAt: null,
    private: false,
  };
}

/**
 * A source that can both list an archive and prepare one video: what the host adapter
 * is in production. Listing a video ref returns that video; listing a channel ref
 * returns the whole stub archive.
 */
export function listableSource(options = {}) {
  const base = createFixtureSource({
    title: options.title ?? "Listed video",
    channel: options.channel ?? "Chan",
    durationSeconds: options.durationSeconds ?? 120,
  });
  const items = options.items ?? [];
  const calls = { list: 0 };
  return {
    calls,
    capabilities: (ref) => (options.capabilities
      ? options.capabilities(ref)
      : {
          platform: ref.platform,
          singleVideo: true,
          listing: "full",
          listingScopeNote: null,
          pagination: true,
          listingCost: "free",
          requiresConfig: [],
        }),
    resolve: (input) => base.resolve(input),
    prepare: (ref, opts) => base.prepare(ref, opts),
    split: (info, opts) => base.split(info, opts),
    async list(ref, opts = {}) {
      calls.list += 1;
      const matching = items.filter((item) => item.sourceRef.sourceId === ref.sourceId);
      const archive = matching.length > 0 ? matching : items;
      const limit = Math.min(opts.limit ?? 50, 50);
      const offset = opts.cursor ? Number(String(opts.cursor).replace("page-", "")) || 0 : 0;
      const page = archive.slice(offset, offset + limit);
      const next = offset + limit < archive.length ? `page-${offset + limit}` : null;
      return {
        items: page,
        cursor: next,
        completeness: next ? "partial" : "complete",
        note: null,
      };
    },
  };
}
