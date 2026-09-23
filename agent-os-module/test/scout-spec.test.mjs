// R6, Scout = the same OmniWatch channel scan on a schedule (SPEC F2–F11, F14).
//
//   node --test agent-os-module/test/scout-spec.test.mjs
//
// Offline: the real scout handler with in-memory ports, and the real ScoutView
// transpiled with stubbed imports. No browser, no network, no Hermes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  createScoutHandler, channelSettings, normaliseChannel, accountSourceRef,
} from "../src/app/api/omniwatch/scout/handler.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fakeStore() {
  const seen = [];
  return {
    seen,
    markSeenSource: (...args) => seen.push(args),
    listReports: () => [],
    getRun: () => null,
    listRunItems: () => ({ items: [], total: 0 }),
    getBuffer: () => null,
  };
}

function panel({ channels = [], listed = [] } = {}) {
  let config = { channels };
  const saved = [];
  const scans = [];
  const store = fakeStore();
  const deps = {
    store,
    runScan: async (input) => {
      scans.push(input);
      return { protocol: "x", runId: "", collectionId: input.collectionId, state: "completed", analysed: 0, failedItems: 0, pendingItems: 0, newItems: 0, modelCalls: 0, report: null, reportDecision: { report: false, reason: "" }, links: [], notes: [] };
    },
    reportsToHandOff: () => [],
    handOffRunReport: (id) => ({ id }),
    readRunReport: () => [],
    readConfig: async () => config,
    writeConfig: async (next) => { config = next; },
    toolsPresent: async () => ({ ytDlp: true, ffmpeg: true }),
    apiKeyPresent: async () => true,
    saveCollection: (input) => saved.push(input),
    accountRef: (platform, handle) => accountSourceRef({ platform, handle }),
    listChannel: async () => listed,
  };
  return { handler: createScoutHandler(deps), saved, scans, store, config: () => config };
}

const post = (handler, body) => handler.POST(new Request("http://localhost/api/omniwatch/scout", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

test("a channel with no goal chosen is a summary; teardown only when explicitly picked", () => {
  const plain = channelSettings(normaliseChannel({ platform: "youtube", handle: "@builtwithscience" }));
  assert.equal(plain.mode, "summary");
  assert.equal(plain.focus, null);
  assert.equal(plain.collectionId, "scout_youtube_builtwithscience");

  // A topic goal with an empty topic falls back to a plain summary, not a teardown.
  assert.equal(channelSettings(normaliseChannel({ handle: "a", goal: "topic", topic: "" })).mode, "summary");
  const topic = channelSettings(normaliseChannel({ handle: "a", goal: "topic", topic: "fat loss" }));
  assert.deepEqual([topic.mode, topic.focus], ["summary", "fat loss"]);
  assert.equal(channelSettings(normaliseChannel({ handle: "a", goal: "teardown" })).mode, "teardown");
  assert.equal(channelSettings(normaliseChannel({ handle: "a", goal: "anything-else" })).mode, "summary");
});

test("saving a channel stores its goal on the collection the cron scans; 'new only' baselines the archive", async () => {
  const p = panel({ listed: ["v1", "v2", "v3"] });
  const res = await post(p.handler, { action: "config", config: { channels: [{ platform: "youtube", handle: "creator", language: "pl", schedule: "daily" }] } });
  assert.equal(res.status, 200);
  const [save] = p.saved;
  assert.equal(save.collectionId, "scout_youtube_creator");
  assert.equal(save.settings.mode, "summary", "the saved (cron) goal is a summary by default");
  assert.equal(save.settings.language, "pl");
  assert.equal(save.sources[0].sourceId, "creator");
  // The existing archive is marked as seen for exactly this goal, so the cron only pays for new videos.
  assert.deepEqual(p.store.seen.map((s) => s[1]), ["v1", "v2", "v3"]);
  assert.deepEqual(p.store.seen[0].slice(2), ["summary", "", "", "pl"]);
  const channel = p.config().channels[0];
  assert.equal(channel.collectionId, "scout_youtube_creator", "the cron script finds the collection in the saved config");
  assert.equal(channel.schedule, "daily");
});

test("Run now scans the channel's collection with the saved goal, never a forced teardown", async () => {
  const p = panel({ channels: [{ id: "c1", platform: "youtube", handle: "creator", goal: "summary", firstRun: "all" }] });
  const res = await post(p.handler, { action: "scan", channelId: "c1" });
  assert.equal(res.status, 202);
  for (let i = 0; i < 50 && p.scans.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(p.scans.length, 1);
  assert.equal(p.scans[0].collectionId, "scout_youtube_creator");
  assert.equal(p.saved.at(-1).settings.mode, "summary");
  assert.equal(p.store.seen.length, 0, "whole-archive channels take no baseline");

  // Hermes names a collection id and nothing else: no prompt, no mode override.
  await post(p.handler, { action: "scan", collectionId: "scout_youtube_creator", trigger: "schedule" });
  for (let i = 0; i < 50 && p.scans.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(p.scans[1].trigger, "schedule");
  assert.equal(p.scans[1].settings, undefined, "the scheduled run reads the saved goal, it does not pass one");
});

// ── the tab itself ──────────────────────────────────────────────────────────────

const VIEW = path.join(HERE, "..", "src", "components", "ScoutView.tsx");
const source = readFileSync(VIEW, "utf8");

function loadView() {
  const req = createRequire(path.join(HERE, "..", "..", "package.json"));
  const ts = req("typescript");
  let out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), "omniwatch-r6-scout-"));
  const stub = "module.exports = new Proxy({ __esModule: true, default: () => null }, { get: (t, k) => (k in t ? t[k] : () => null) });";
  const map = { "react": "stub-react", "react/jsx-runtime": "stub-jsx", "lucide-react": "stub-lucide", "./OmniMarkdown": "stub-md", "@/lib/omniwatchI18n": "stub-i18n", "./OmniWatch.css": "stub-css" };
  for (const [spec, file] of Object.entries(map)) {
    out = out.split(`require("${spec}")`).join(`require("./${file}.js")`);
    writeFileSync(path.join(dir, `${file}.js`), stub);
  }
  writeFileSync(path.join(dir, "ScoutView.js"), out);
  return createRequire(path.join(dir, "x.js"))("./ScoutView.js");
}

test("the Scout tab has no Astros, ranking or 'outperformed' remnants; a new channel is a summary", () => {
  for (const gone of [/Astros/i, /outperform/i, /Who you are watching/i, /What your videos are about/i, /scout\/astros/, /Reads\b/]) {
    assert.doesNotMatch(source, gone);
  }
  const view = loadView();
  const parsed = view.parseChannelInput("https://www.youtube.com/@BuiltWithScience/videos");
  assert.deepEqual(parsed, { platform: "youtube", handle: "BuiltWithScience" });
  assert.deepEqual(view.parseChannelInput("https://www.tiktok.com/@someone"), { platform: "tiktok", handle: "someone" });
  const channel = view.newChannel("youtube", "BuiltWithScience", "pl");
  assert.equal(channel.goal, "summary");
  assert.equal(channel.schedule, "off");
  assert.equal(channel.firstRun, "new");
  assert.equal(view.scheduleEvery([channel]), "off");
  assert.equal(view.scheduleEvery([{ ...channel, schedule: "weekly" }]), "24");
});
