/**
 * T12 / T14 (offline): the channel route handler.
 *
 * The listing gate, the batch paging and the resume all run against a real SQLite
 * store and the real shared `runScan` — there is no second scan in the panel. The
 * source is a stub that counts its own lister calls, so "refusing a paid listing
 * performs zero paid calls" is a counted fact, not a promise.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";

import { createFixtureSource } from "../../packages/omniwatch/src/runtime/poc.ts";
import { runScan, saveCollection } from "../../packages/omniwatch/src/collections/scan.ts";
import { createChannelHandler } from "../../agent-os-module/src/app/api/omniwatch/channel/handler.ts";
import { cleanupTempDirs, createHarness } from "./omniwatch-harness.mjs";

after(cleanupTempDirs);

function videoItem(id, seconds) {
  return {
    sourceRef: { platform: "youtube", sourceId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`, legacyId: id },
    title: `Video ${id}`,
    durationSeconds: seconds,
    publishedAt: null,
    private: false,
  };
}

/** A source that can list, counting every lister call it is asked to make. */
function listableSource(options = {}) {
  const base = createFixtureSource({
    title: options.title ?? "Listed video",
    channel: "Chan",
    durationSeconds: options.durationSeconds ?? 120,
  });
  const items = options.items ?? [videoItem("AAAAAAAAAAA", 120), videoItem("BBBBBBBBBBB", 300)];
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
    async list(_ref, opts = {}) {
      calls.list += 1;
      const limit = Math.min(opts.limit ?? 50, 50);
      const offset = opts.cursor ? Number(String(opts.cursor).replace("page-", "")) || 0 : 0;
      const page = items.slice(offset, offset + limit);
      const next = offset + limit < items.length ? `page-${offset + limit}` : null;
      return {
        items: page,
        cursor: options.more ? (next ?? `page-${offset + limit}`) : next,
        completeness: next || options.more ? "partial" : "complete",
        note: options.note ?? null,
      };
    },
  };
}

function channelPanel(h, source, overrides = {}) {
  const scans = [];
  const saved = [];
  const deps = {
    store: h.store,
    memory: h.memory,
    source,
    parseAccount: (input, hint) => {
      const handle = String(input).replace(/^.*\//, "").replace(/^@/, "").trim();
      if (!handle) return null;
      return { platform: hint ?? "youtube", handle };
    },
    estimateCost: (seconds) =>
      typeof seconds === "number" && seconds > 0 ? Number((seconds * 0.00005).toFixed(6)) : null,
    saveCollection: (input) => {
      saved.push(input);
      return saveCollection(h.store, input);
    },
    startScan: async (input) => {
      scans.push(input);
      // Admit and return; the scan itself keeps running, exactly like the spawned worker.
      scans.running = runScan({
        deps: h.deps,
        request: {
          collectionId: input.collectionId,
          runId: input.runId,
          trigger: input.trigger === "cli" ? "cli" : "manual",
          sources: input.sources,
          confirmPaidListing: input.confirmPaidListing,
          settings: {
            mode: input.settings.mode,
            focus: input.settings.focus,
            question: input.settings.question,
            language: input.settings.language,
          },
        },
      });
    },
    listSavedScans: async () => [{ id: "legacy-1", account: "old", videos: 2, failed: 0, cost: 0.01 }],
    readSavedScan: async (id) => (id === "legacy-1" ? { id, account: "old", results: [] } : null),
    defaultLanguage: "en",
    languages: ["en", "pl"],
    ...overrides,
  };
  return { handler: createChannelHandler(deps), deps, scans, saved };
}

const get = (handler, query) => handler.GET(new Request(`http://localhost/api/omniwatch/channel?${query}`));
const post = (handler, body) => handler.POST(new Request("http://localhost/api/omniwatch/channel", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

const PAID_CAPABILITIES = (ref) => ({
  platform: ref.platform,
  singleVideo: true,
  listing: "limited",
  listingScopeNote: "ostatnie posty; listowanie platne",
  pagination: true,
  listingCost: "paid",
  requiresConfig: ["APIFY_TOKEN"],
});

test("T12: the listing shows honest scope and cost before anything is requested", async () => {
  const h = createHarness();
  const source = listableSource();
  const { handler } = channelPanel(h, source);

  const response = await get(handler, "url=https://youtube.com/@chan&platform=youtube");
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.scope, "full");
  assert.equal(view.listingCost, "free");
  assert.equal(view.needsConfirmation, false);
  assert.equal(view.batchSize, 50);
  assert.equal(view.videos.length, 2);
  assert.equal(view.videos[0].cost > 0, true, "every listed video carries its own estimate");
  assert.equal(view.cost > 0, true);
  assert.equal(view.unpriced, 0);
  assert.equal(source.calls.list, 1, "a free listing is listed once");
});

test("T12: refusing a paid listing performs zero paid calls", async () => {
  const h = createHarness();
  const source = listableSource({ capabilities: PAID_CAPABILITIES });
  const { handler } = channelPanel(h, source);

  const response = await get(handler, "url=https://x.com/someone&platform=x");
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.needsConfirmation, true);
  assert.equal(view.listingCost, "paid");
  assert.deepEqual(view.videos, []);
  assert.match(view.note, /platne/i);
  assert.equal(source.calls.list, 0, "not one lister call without explicit confirmation");
});

test("T12: an explicit confirmation lets the paid listing run, and it is still priced", async () => {
  const h = createHarness();
  const source = listableSource({ capabilities: PAID_CAPABILITIES });
  const { handler } = channelPanel(h, source);

  const view = await (await get(handler, "url=https://x.com/someone&platform=x&confirm=1")).json();
  assert.equal(view.needsConfirmation, false);
  assert.equal(view.videos.length, 2);
  assert.equal(source.calls.list, 1);
  assert.match(view.note ?? "", /zakres ograniczony/);
});

test("T12: `all` larger than one batch is reported honestly instead of as the whole archive", async () => {
  const h = createHarness();
  const source = listableSource({ more: true });
  const { handler } = channelPanel(h, source);

  const view = await (await get(handler, "url=https://youtube.com/@chan&platform=youtube&limit=all")).json();
  assert.equal(view.hasMore, true);
  assert.equal(view.completeness, "partial");
  assert.equal(typeof view.nextCursor, "string", "the cursor of the next batch travels with the answer");
  assert.match(view.note, /ALL nie miesci sie w jednej partii/);
  assert.equal(view.batchSize, 50, "one batch is 50 metadata rows, not the archive");
});

test("T12: a listed video with no length is priced as unknown, never as zero", async () => {
  const h = createHarness();
  const source = listableSource({ items: [videoItem("AAAAAAAAAAA", null)] });
  const { handler } = channelPanel(h, source);

  const view = await (await get(handler, "url=https://youtube.com/@chan&platform=youtube")).json();
  assert.equal(view.unpriced, 1);
  assert.equal(view.videos[0].cost, null);
  assert.equal(view.videos[0].atMost, true);
  assert.match(view.note, /koszt jest nieznany/);
});

test("T14: the manual scan is the shared runScan, and its progress pages 50 metadata rows", async () => {
  const source = listableSource({
    items: Array.from({ length: 60 }, (_, i) => videoItem(String(i).padStart(11, "0"), 60)),
  });
  // The same adapter lists the account and prepares the media: one host source, as in
  // production, so the scan enumerates through the very adapter the listing used.
  const h = createHarness({ source });
  const { handler, scans } = channelPanel(h, source);

  const started = await post(handler, {
    urls: Array.from({ length: 60 }, (_, i) => `https://www.youtube.com/watch?v=${String(i).padStart(11, "0")}`),
    account: "@chan",
  });
  assert.equal(started.status, 202);
  const { id, runId } = await started.json();
  assert.equal(id, runId);
  assert.equal(scans.length, 1, "the panel admits exactly one shared scan");

  const outcome = await scans.running;
  assert.equal(outcome.protocol, "omniwatch.scan.v1");
  assert.equal(outcome.analysed, 60);

  const page = await (await get(handler, `run=${runId}`)).json();
  assert.equal(page.total, 60);
  assert.equal(page.items.length, 50, "metadata moves in pages of 50 (D11)");
  assert.equal(page.hasMore, true);
  assert.equal("text" in page.items[0], false, "the progress page never carries analysis text");

  const page2 = await (await get(handler, `run=${runId}&offset=50&limit=50`)).json();
  assert.equal(page2.items.length, 10);
  assert.equal(page2.hasMore, false);

  const opened = await (await get(handler, `run=${runId}&open=0`)).json();
  assert.equal(opened.ordinal, 0);
  assert.match(opened.text, /punkt pierwszy/, "the text arrives only when the item is opened");
  assert.equal(typeof opened.analysisId, "string");
});

test("T14: a resume by run id continues the same run and pays for nothing twice", async () => {
  const source = listableSource({ items: [videoItem("AAAAAAAAAAA", 120)] });
  const h = createHarness({ source });
  const { handler, scans } = channelPanel(h, source);

  const started = await post(handler, { urls: ["https://www.youtube.com/watch?v=AAAAAAAAAAA"], account: "@chan" });
  const { runId } = await started.json();
  await scans.running;
  const callsAfterFirst = h.model.calls.length;
  assert.equal(callsAfterFirst, 1);

  const resumed = await post(handler, { resume: runId });
  assert.equal(resumed.status, 202);
  assert.equal((await resumed.json()).runId, runId);
  assert.equal(scans.length, 2, "the resume runs the same shared scan again");
  await scans.running;

  assert.equal(h.model.calls.length, callsAfterFirst, "an already-analysed video is not paid for twice");
});

test("T12: an unknown run id is gone, not an empty scan", async () => {
  const h = createHarness();
  const { handler } = channelPanel(h, listableSource());
  const response = await get(handler, "run=run_missing");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { state: "gone" });
});

test("legacy: the on-disk scan history and a single saved scan stay readable", async () => {
  const h = createHarness();
  const { handler } = channelPanel(h, listableSource());
  const history = await (await get(handler, "history=1")).json();
  assert.equal(history.scans.length, 1);
  const one = await (await get(handler, "scan=legacy-1")).json();
  assert.equal(one.id, "legacy-1");
  assert.equal((await get(handler, "scan=nope")).status, 404);
});
