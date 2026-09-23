// R5, the panel card: what one poll means, decided from the server's words only.
//
//   node --test agent-os-module/test/source-failure-view.test.mjs
//
// Loads the real OmniWatchView the same way card-source.test.mjs does (TypeScript
// borrowed from the Agent OS install, AGENT_OS_SOURCE) and drives its exported pure
// functions with the real translations. No browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import I18N from "../src/lib/omniwatchI18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = process.env.OMNIWATCH_VIEW || path.join(HERE, "..", "src", "components", "OmniWatchView.tsx");
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const source = readFileSync(VIEW, "utf8");
const req = createRequire(path.join(AGENT_OS, "package.json"));

function loadView() {
  const ts = req("typescript");
  const out = ts.transpileModule(source, {
    fileName: VIEW,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), "omniwatch-r5-view-"));
  writeFileSync(path.join(dir, "OmniWatchView.js"), out);
  for (const stub of ["OmniMarkdown", "ChannelScan", "OmniLibrary"]) {
    writeFileSync(path.join(dir, `${stub}.js`),
      "module.exports = { __esModule: true, default: () => null, TS_RE: /x/g, toSec: () => 0 };");
  }
  req.extensions[".css"] = () => {};
  writeFileSync(path.join(dir, "OmniWatch.css"), "");
  process.env.NODE_PATH = [path.join(AGENT_OS, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  req("node:module").Module._initPaths();
  return req(path.join(dir, "OmniWatchView.js"));
}

const view = loadView();
const pl = I18N.pl.ui;
const en = I18N.en.ui;

// Exactly what the jobs endpoint returned for the live QzTkVaC-da4 failure after R5.
const FAILED_POLL = {
  state: "error",
  stage: "failed",
  errorClass: "source_unavailable",
  error: "YouTube zablokowal pobieranie z tego komputera ...",
  noModelCalls: true,
  sourceFailure: {
    reason: "bot_check",
    retryable: false,
    detail: "ERROR: [youtube] QzTkVaC-da4: Sign in to confirm you're not a bot.",
  },
};

test("a failed poll is terminal before anything else: no step is lit", () => {
  const read = view.readPoll(FAILED_POLL);
  assert.equal(read.terminal, "error");
  assert.equal(read.step, "failed");
  assert.notEqual(read.step, "answer", "the old view drew 'writing the answer' here");
  assert.equal(read.wait, null);
  // Even an old server that still labels a failure "answer" cannot light a step.
  assert.equal(view.readPoll({ state: "error", stage: "answer" }).step, "failed");
});

test("the step shown is only the one the server sent", () => {
  assert.equal(view.readPoll({ state: "running", stage: "download" }).step, "download");
  assert.equal(view.readPoll({ state: "running" }).step, "", "no stage from the server, no step on the card");
  assert.equal(view.readPoll({ state: "running", stage: "queued" }).step, "queued");
  assert.equal(view.readPoll({ state: "running", stage: "merge" }).step, "watch");
  assert.equal(view.readPoll({ state: "done", stage: "answer" }).terminal, "done");
});

test("the error card says the classified reason in the UI language, and 'no cost' only when confirmed", () => {
  const text = view.failureText(FAILED_POLL, pl, "fallback");
  assert.match(text, /^YouTube zablokował pobieranie z tego komputera/);
  assert.match(text, /Nic nie zostało wysłane do modelu i nic nie kosztowało\./);
  assert.match(text, /Spróbuj za kilka–kilkanaście minut albo włącz pobieranie z ciasteczkami przeglądarki/);
  assert.doesNotMatch(text, /Sign in to confirm/, "raw yt-dlp text is not the headline");
  assert.doesNotMatch(text, /\{noCost\}/);

  const unconfirmed = view.failureText({ ...FAILED_POLL, noModelCalls: undefined }, pl, "fallback");
  assert.doesNotMatch(unconfirmed, /nic nie kosztowało/, "never claim 'no cost' without the server saying so");

  assert.match(view.failureText({ ...FAILED_POLL, sourceFailure: { reason: "rate_limited_by_youtube" } }, en, "x"),
    /^YouTube is rate-limiting downloads from this computer/);
  assert.equal(view.failureText({ error: "boom" }, pl, "boom"), "boom", "an unclassified failure keeps its own message");
});

test("every reason has a translation in every panel language", () => {
  const reasons = ["rate_limited_by_youtube", "rate_limited", "bot_check", "private", "unavailable", "geo_blocked", "network", "unknown"];
  for (const [lang, locale] of Object.entries(I18N)) {
    for (const reason of reasons) {
      assert.ok(locale.ui[`sourceError_${reason}`], `${lang}.sourceError_${reason}`);
      assert.match(locale.ui[`sourceError_${reason}`], /\{noCost\}/, `${lang}.sourceError_${reason} has the no-cost slot`);
    }
    for (const key of ["sourceErrorNoCost", "errorDetails", "sourceWaitRetry", "sourceWaitRetryGeneric", "pendingStart", "pendingQueued"]) {
      assert.ok(locale.ui[key], `${lang}.${key}`);
    }
  }
  assert.equal(pl.errorDetails, "szczegóły");
});

test("a real wait reads 'retrying in N s'; the running card claims nothing the server did not report", () => {
  const wait = { reason: "rate_limited_by_youtube", seconds: 30, remainingSeconds: 17 };
  assert.equal(view.waitText(wait, pl), "YouTube ogranicza — ponawiam za 17 s");
  assert.equal(view.pendingText("download", wait, 0, pl), "YouTube ogranicza — ponawiam za 17 s");
  assert.equal(view.pendingText("", null, 0, pl), pl.pendingStart, "before the first report: 'starting', not 'downloading'");
  assert.equal(view.pendingText("queued", null, 0, pl), pl.pendingQueued);
  assert.equal(view.pendingText("download", null, 0, pl), pl.pendingDownload);
  assert.equal(view.readPoll({ state: "running", stage: "download", wait: { ...wait, remainingSeconds: 0 } }).wait, null);
});

test("the component applies the terminal state before stage and meta, and hides the steps on failure", () => {
  const poll = source.slice(source.indexOf("pollRef.current = setInterval"), source.indexOf("}, 700);"));
  const terminal = poll.indexOf('view.terminal === "error"');
  assert.ok(terminal > 0, "the poll checks for a terminal error");
  assert.ok(terminal < poll.indexOf("if (d.meta)"), "before it takes any meta");
  assert.ok(terminal < poll.indexOf("setStep(view.step)"), "and before it lights any step");
  assert.match(source, /step !== "failed" && \(/, "the progress panel is not drawn for a failed run");
  assert.match(source, /setRunning\(true\); setStep\(""\)/, "a new run lights no step until the server reports one");
  assert.match(source, /data-omniwatch-detail/, "the raw output sits behind a details toggle");
});
