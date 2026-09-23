/**
 * Regressions for the QA findings (ISSUE-003/004/005).
 *
 * Each test reproduces what the live browser test found, on synthetic data, with no
 * network and no paid call:
 *   - ISSUE-004: a configured key with NO explicit API base must still reach the
 *     documented default endpoint - and the model and upload endpoints differ.
 *   - ISSUE-005: a freshly downloaded video must get real JPEG frames on demand.
 *   - ISSUE-003: a failed run must reach a terminal error state with retry, instead
 *     of leaving the "downloading" title, spinner and progress active.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DASHSCOPE_HOST,
  chatCompletionsUrl,
  dashscopeHost,
  uploadPolicyUrl,
} from "../../packages/omniwatch/src/contracts/endpoints.ts";
import { OmniWatchError } from "../../packages/omniwatch/src/contracts/errors.ts";
import { loadStandaloneConfig, runtimeConfigDocument } from "../../apps/standalone/config.mjs";
import { createFixtureSource, createRuntimeWiring } from "../../packages/omniwatch/src/runtime/poc.ts";
import { effectiveMaxFramesPerPart, partPlan } from "../../packages/omniwatch/src/sources/media.ts";
import {
  createStandaloneMediaTool,
  createStandaloneServer,
  frameTargetPath,
  usagePayload,
} from "../../apps/standalone/server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(repo, "test/fixtures/beta");
const pageHtml = fs.readFileSync(path.join(repo, "apps/standalone/static/index.html"), "utf8");
const pageI18n = fs.readFileSync(path.join(repo, "apps/standalone/static/i18n.json"), "utf8");

test("long Qwen3.8-Omni film uses short calls within the provider frame budget", () => {
  const config = loadStandaloneConfig({ appRoot: fs.mkdtempSync(path.join(os.tmpdir(), "omni-long-")), env: {} });
  assert.equal(config.maxFrames, 2400, "legacy setting remains visible");
  const effective = runtimeConfigDocument(config).maxFramesPerPart;
  assert.equal(effective, 480);
  // The engine (and the standalone pre-split) bound it again by the film's length:
  // a 34:21 film is sampled at 1 fps in 2-minute parts (LF2).
  const perPart = effectiveMaxFramesPerPart(config.model, effective, 2061);
  assert.equal(perPart, 120);
  const plan = partPlan(2061, { maxFramesPerPart: perPart });
  assert.equal(plan.length, 18);
  assert.ok(plan.every((part) => part.endSeconds - part.startSeconds <= 120));
  assert.equal(runtimeConfigDocument({ ...config, model: "other-model" }).maxFramesPerPart, 2400);
});

test("ISSUE-004: a key without an explicit base reaches the documented default endpoint", () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ep-"));
  fs.writeFileSync(
    path.join(appRoot, ".env"),
    "DASHSCOPE_API_KEY=fixture-not-a-secret\nOMNI_MODEL=fixture-omni\n",
  );
  const config = loadStandaloneConfig({ appRoot, env: {} });
  assert.equal(config.apiKeyPresent, true, "the key from .env must be recognised");
  assert.equal(config.apiKey, "fixture-not-a-secret");
  assert.equal(
    config.apiBase,
    DEFAULT_DASHSCOPE_HOST,
    "a key with no explicit base must resolve the documented default endpoint",
  );

  const document = runtimeConfigDocument(config);
  assert.equal(
    document.apiBaseUrlDefault,
    DEFAULT_DASHSCOPE_HOST,
    "the resolved endpoint must travel to the runtime, not just the variable name",
  );

  const dataDir = path.join(appRoot, "data");
  // The shell hands the runtime the effective environment (`.env` under process env),
  // because the documented beta configuration keeps the key in `.env`.
  const wiring = createRuntimeWiring({ config: document, dataDir, environment: config.effectiveEnv });
  try {
    assert.equal(wiring.deps.config.apiBaseUrl(), DEFAULT_DASHSCOPE_HOST);
    assert.equal(wiring.deps.config.apiKey(), "fixture-not-a-secret");
  } finally {
    wiring.close();
  }

  // And with only process.env (the previous behaviour) the key is genuinely absent -
  // this is the case the QA run hit before the shell passed the merged environment.
  const withoutMerged = createRuntimeWiring({ config: document, dataDir, environment: {} });
  try {
    assert.equal(withoutMerged.deps.config.apiBaseUrl(), DEFAULT_DASHSCOPE_HOST);
    assert.equal(withoutMerged.deps.config.apiKey(), null);
  } finally {
    withoutMerged.close();
  }
});

test("ISSUE-004: an explicit base still wins over the deployment default", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ep-"));
  const document = {
    protocol: "omniwatch.runtime-config.v1",
    dataDir,
    modelName: "fixture-omni",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    apiBaseUrlEnv: "DASHSCOPE_API",
    apiBaseUrlDefault: DEFAULT_DASHSCOPE_HOST,
    model: { kind: "stub" },
  };
  const wiring = createRuntimeWiring({
    config: document,
    dataDir,
    environment: { DASHSCOPE_API: "https://custom.example.invalid" },
  });
  try {
    assert.equal(wiring.deps.config.apiBaseUrl(), "https://custom.example.invalid");
  } finally {
    wiring.close();
  }
});

test("ISSUE-004: the model and upload endpoints are derived separately, like the beta", () => {
  assert.equal(
    chatCompletionsUrl(DEFAULT_DASHSCOPE_HOST),
    `${DEFAULT_DASHSCOPE_HOST}/compatible-mode/v1/chat/completions`,
  );
  assert.equal(
    uploadPolicyUrl(DEFAULT_DASHSCOPE_HOST, "qwen3.8-omni-flash"),
    `${DEFAULT_DASHSCOPE_HOST}/api/v1/uploads?action=getPolicy&model=qwen3.8-omni-flash`,
  );
  assert.equal(dashscopeHost(`${DEFAULT_DASHSCOPE_HOST}/compatible-mode/v1`), DEFAULT_DASHSCOPE_HOST);

  // An explicit model base must NOT break the upload endpoint.
  const compatible = `${DEFAULT_DASHSCOPE_HOST}/compatible-mode/v1`;
  assert.equal(uploadPolicyUrl(compatible, "m"), `${DEFAULT_DASHSCOPE_HOST}/api/v1/uploads?action=getPolicy&model=m`);
  assert.equal(chatCompletionsUrl(compatible), `${compatible}/chat/completions`);

  const full = `${DEFAULT_DASHSCOPE_HOST}/compatible-mode/v1/chat/completions`;
  assert.equal(chatCompletionsUrl(full), full);
  assert.equal(uploadPolicyUrl(full, "m"), `${DEFAULT_DASHSCOPE_HOST}/api/v1/uploads?action=getPolicy&model=m`);

  // Other OpenAI-compatible providers keep their generic /v1 shape.
  assert.equal(chatCompletionsUrl("https://api.openai.com"), "https://api.openai.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  // An empty base falls back to the documented default instead of an empty URL.
  assert.equal(chatCompletionsUrl(""), `${DEFAULT_DASHSCOPE_HOST}/compatible-mode/v1/chat/completions`);
});

/** A shell whose video is downloaded but whose frames directory does not exist yet. */
function freshDownloadShell() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-frame-"));
  const dataDir = path.join(appRoot, "data");
  fs.mkdirSync(path.join(appRoot, "static"), { recursive: true });
  for (const name of ["index.html", "i18n.json"]) {
    fs.copyFileSync(path.join(repo, "apps/standalone/static", name), path.join(appRoot, "static", name));
  }
  const cacheDir = path.join(dataDir, "cache", "SYNTHETIC01");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.copyFileSync(path.join(fixtures, "legacy/.cache/SYNTHETIC01/source.mp4"), path.join(cacheDir, "source.mp4"));
  return { appRoot, dataDir, cacheDir };
}

async function listenOrSkip(t, app) {
  try {
    return await app.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`binding a local socket is not permitted here (${error.code})`);
      return null;
    }
    throw error;
  }
}

test("ISSUE-005: a fresh video gets real frames generated on demand", async (t) => {
  const { appRoot, dataDir, cacheDir } = freshDownloadShell();
  const app = createStandaloneServer({ appRoot, dataDir, env: { OMNIWATCH_DATA_DIR: dataDir }, port: 0 });
  const address = await listenOrSkip(t, app);
  if (!address) return;
  try {
    const base = `http://127.0.0.1:${address.port}`;
    for (const sec of [1, 3, 31]) {
      const response = await fetch(`${base}/frame/SYNTHETIC01/${sec}.jpg`);
      assert.equal(response.status, 200, `frame ${sec}s must be produced for a freshly downloaded video`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 500, `frame ${sec}s must be a real image, got ${bytes.length} bytes`);
      assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8", `frame ${sec}s must be a JPEG`);
      assert.equal(bytes.subarray(-2).toString("hex"), "ffd9", `frame ${sec}s must be a complete JPEG`);
    }
    const again = await fetch(`${base}/frame/SYNTHETIC01/3.jpg`);
    assert.equal(again.status, 200);
    assert.equal(fs.existsSync(path.join(cacheDir, "frames", "3.jpg")), true, "the frame must be cached on disk");
  } finally {
    await app.close();
  }
});

test("ISSUE-005: a video that is not downloaded is an honest 404, not a blank image", async (t) => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-frame-"));
  const dataDir = path.join(appRoot, "data");
  fs.mkdirSync(path.join(appRoot, "static"), { recursive: true });
  fs.copyFileSync(path.join(repo, "apps/standalone/static/index.html"), path.join(appRoot, "static", "index.html"));
  const app = createStandaloneServer({ appRoot, dataDir, env: { OMNIWATCH_DATA_DIR: dataDir }, port: 0 });
  const address = await listenOrSkip(t, app);
  if (!address) return;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/frame/UNKNOWNFIX/3.jpg`);
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});

test("ISSUE-003: the UI wires a terminal error state, with a retry control", () => {
  const html = fs.readFileSync(path.join(repo, "apps/standalone/static/index.html"), "utf8");
  // Static wiring only: the BEHAVIOUR is covered by the script-execution tests below.
  assert.match(html, /on\('error', d => fail\(/, "the SSE error event must reach the terminal handler");
  assert.match(html, /stream\.onerror = \(\) => \{[\s\S]{0,500}?fail\(/, "a transport failure must also be terminal");
  assert.doesNotMatch(html, /es\.onerror = \(\) => \{ if \(es\) finish\(\); \}/, "the old silent finish must be gone");
  const i18n = JSON.parse(fs.readFileSync(path.join(repo, "apps/standalone/static/i18n.json"), "utf8"));
  for (const lang of Object.keys(i18n)) {
    for (const key of ["errorTitle", "retry", "errorGeneric", "errorConnection"]) {
      assert.ok(i18n[lang].ui[key], `${lang}.ui.${key} must exist`);
    }
  }
});

/* ------------------------------------------------------------------ ISSUE-003 -- */

/**
 * Behavioural regressions for the terminal error state.
 *
 * Regexes over index.html only prove that a handler was written. These tests run the
 * page's REAL inline script in a small DOM stand-in, deliver the same SSE frames the
 * server produces, and then inspect the resulting state: the stream is closed, the
 * running class is gone, the strip stops scanning, the "downloading" title is
 * replaced, the form is usable again, and retry re-issues the same request.
 */

function pageScript() {
  const matches = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(matches.length > 0, "index.html must contain an inline script");
  return matches[matches.length - 1][1];
}

function createElementStore() {
  const elements = new Map();
  const listeners = new Map();
  const dynamic = { query: () => null };
  function makeElement(id) {
    const classes = new Set();
    const el = {
      id,
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
      },
      style: {},
      dataset: {},
      textContent: "",
      innerHTML: "",
      value: "",
      disabled: false,
      children: [],
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      insertAdjacentHTML() {},
      /** `prepend`/`append` are used by the answer card and the stats block. */
      prepend(child) {
        el.children.unshift(child);
        return child;
      },
      append(child) {
        el.children.push(child);
        return child;
      },
      prependChild(child) {
        el.children.unshift(child);
        return child;
      },
      replaceChildren(...nodes) {
        el.children = [...nodes];
      },
      setAttribute() {},
      getAttribute: () => null,
      closest: () => null,
      play: async () => {},
      pause() {},
      load() {},
      addEventListenerOnce() {},
      addEventListener(type, fn) {
        const key = `${id}:${type}`;
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push(fn);
      },
      dispatch(type, event = {}) {
        if (type === "click" && typeof el.onclick === "function") el.onclick({ preventDefault() {}, ...event });
        for (const fn of listeners.get(`${id}:${type}`) ?? []) fn({ preventDefault() {}, ...event });
      },
      /** `span` mirrors the legend markup the page rewrites on load. */
      querySelector: (selector) =>
        (selector === "span" ? elements.get("#legendSpan") : dynamic.query(selector)) ?? null,
      querySelectorAll: () => [],
      remove() {},
      focus() {},
      requestSubmit() {
        el.dispatch("submit");
      },
      scrollIntoView() {},
    };
    elements.set(id, el);
    return el;
  }
  /**
   * Element ids come from the page itself, so the harness follows markup changes
   * instead of drifting. `#legendSpan` stands in for the nested `<span>` the page
   * rewrites through `$('#legend').querySelector('span')`.
   */
  const elementIds = [...new Set([...pageHtml.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => `#${m[1]}`))];
  elementIds.push("#legendSpan");
  for (const id of elementIds) {
    makeElement(id);
  }
  makeElement(".retry-action");
  return { elements, makeElement, setDynamicQuery: (fn) => (dynamic.query = fn) };
}

/** Run the page script with a stubbed EventSource and inspect the resulting state. */
function runPage() {
  const dom = createElementStore();
  const bodyClasses = new Set();
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      this.onerror = null;
      sources.push(this);
    }
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }
    close() {
      this.closed = true;
    }
    emit(type, data) {
      const fn = this.listeners.get(type);
      if (fn) fn({ data: JSON.stringify(data) });
    }
    fail() {
      if (this.onerror) this.onerror({});
    }
  }
  const documentStub = {
    body: {
      classList: {
        // `classList.add`/`remove` are variadic in the DOM, and the page uses that:
        // `fail()` adds "idle" AND "failed", `ask()` removes "idle", "failed" and
        // "done". A single-argument stub silently dropped every name after the first,
        // so the page looked like it never recorded the terminal state it did record.
        add: (...names) => names.forEach((name) => bodyClasses.add(name)),
        remove: (...names) => names.forEach((name) => bodyClasses.delete(name)),
        contains: (name) => bodyClasses.has(name),
      },
    },
    getElementById: (id) => dom.elements.get(id.startsWith("#") ? id : `#${id}`) ?? null,
    querySelector: (selector) => dom.elements.get(selector) ?? null,
    querySelectorAll: () => [],
    createElement: () => {
      const el = dom.makeElement(`#dyn-${dom.elements.size}`);
      el.querySelector = () => dom.elements.get(".retry-action") ?? null;
      return el;
    },
    addEventListener: () => {},
    documentElement: { lang: "pl" },
  };
  /** Resolves when the page's startup bootstrap (i18n + status) has completed. */
  const ready = [];
  const factory = new Function(
    "document",
    "window",
    "navigator",
    "EventSource",
    "setInterval",
    "clearInterval",
    "fetch",
    "localStorage",
    pageScript(),
  );
  factory(
    documentStub,
    { scrollTo: () => {}, addEventListener: () => {} },
    { language: "pl" },
    FakeEventSource,
    () => 1,
    () => {},
    async (url) => {
      // The page fetches /i18n.json and /api/omniwatch/status on load; serve the real
      // translations so the error strings under test are the shipped ones.
      if (String(url).includes("i18n")) {
        return { ok: true, json: async () => JSON.parse(pageI18n) };
      }
      return { ok: true, json: async () => ({}) };
    },
    { getItem: () => null, setItem: () => {} },
  );
  // Submit a URL through the page's own form handler.
  dom.elements.get("#url").value = "https://youtu.be/SYNTHETIC01";
  dom.setDynamicQuery((selector) => (selector === ".retry-action" ? dom.elements.get(".retry-action") : null));
  return { dom, bodyClasses, sources, ready, submit: () => dom.elements.get("#f").dispatch("submit") };
}

test("ISSUE-003 behaviour: an SSE error frame ends the run and re-enables the form", async () => {
  const { dom, bodyClasses, sources, submit } = runPage();
  // The page bootstraps i18n with a promise chain; let it settle before submitting.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  submit();
  const es = sources[sources.length - 1];
  assert.ok(es, "submitting a URL must open the analysis stream");
  dom.elements.get("#title").textContent = "Pobieram film…";
  dom.elements.get("#strip").classList.add("scanning");
  es.emit("stage", { step: "download" });
  es.emit("error", { error: "missing_config", message: "Brak adresu API modelu analizy." });

  assert.equal(es.closed, true, "the stream must be closed on a terminal error");
  assert.equal(bodyClasses.has("running"), false, "the running state must be cleared");
  assert.equal(dom.elements.get("#strip").classList.contains("scanning"), false, "the strip must stop scanning");
  assert.notEqual(
    dom.elements.get("#title").textContent,
    "Pobieram film…",
    "the misleading downloading title must be replaced by the error title",
  );
  assert.equal(dom.elements.get("#go").disabled, false, "the form must be usable again");
});

test("ISSUE-003 behaviour: a transport failure before any answer is terminal", async () => {
  const { bodyClasses, sources, submit } = runPage();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  submit();
  const es = sources[sources.length - 1];
  es.emit("stage", { step: "download" });
  es.fail();
  assert.equal(es.closed, true, "an interrupted stream must be closed, never auto-reconnected");
  assert.equal(bodyClasses.has("running"), false, "the running state must be cleared");
});

test("ISSUE-003 live: the server's own error frame reports missing_config", async (t) => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-sse-"));
  const dataDir = path.join(appRoot, "data");
  fs.mkdirSync(path.join(appRoot, "static"), { recursive: true });
  for (const name of ["index.html", "i18n.json"]) {
    fs.copyFileSync(path.join(repo, "apps/standalone/static", name), path.join(appRoot, "static", name));
  }
  const app = createStandaloneServer({ appRoot, dataDir, env: { OMNIWATCH_DATA_DIR: dataDir }, port: 0 });
  const address = await listenOrSkip(t, app);
  if (!address) return;
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/watch?url=${encodeURIComponent("https://youtu.be/SYNTHETIC01")}&lang=pl&mode=summary`,
    );
    const text = await response.text();
    assert.match(text, /event: error/, "the server must emit an SSE error frame");
    const frame = text
      .split("\n\n")
      .map((chunk) => chunk.trim())
      .find((chunk) => chunk.startsWith("event: error"));
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine.slice("data: ".length));
    assert.equal(payload.error, "missing_config", "the reason must name the missing model configuration");
    assert.ok(payload.message && payload.message.length > 0, "a human-readable reason must be present");
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------- ISSUE-003 (visible) -- */

/**
 * The live browser test that found ISSUE-003 measured `getClientRects().length === 0`:
 * the error text and the Retry button were in the DOM but the person could not see
 * them, because the only rule that displayed `main` was `body.running main{display:grid}`
 * and `fail()` dropped `running`. Asserting on element state alone cannot catch that.
 *
 * `mainVisible()` answers the question the browser answered: given the body classes the
 * page ends up with, is `main` displayed? It reads the shipped stylesheet instead of a
 * copy of the rules, so it fails if someone removes the terminal-state rule again.
 *
 * The selector is split so the `body` tag itself is never treated as a class. The
 * first version kept the whole matched prefix (`body.running `) and then asked whether
 * the class set contains "body" - which no class set ever does, so every guarded rule
 * was reported as not applying and the helper answered "hidden" for the two states
 * this very test exists to check.
 */
function mainVisible(bodyClasses) {
  // Strip CSS comments first: a comment immediately before a rule otherwise becomes
  // part of the selector text, so `body.failed` would never match and this helper
  // would report "hidden" for a rule that is actually there.
  const css = pageHtml.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  let display = null;
  for (const [, selectorList, declarations] of rules) {
    const value = /display\s*:\s*([a-z-]+)/i.exec(declarations)?.[1];
    if (!value) continue;
    for (const raw of selectorList.split(",")) {
      const selector = raw.trim();
      // `body.running main` / `body.idle.failed main` / bare `main`. The tag name is
      // matched literally and discarded; only the dot-separated classes are captured.
      const match = /^(?:body((?:\.[a-zA-Z-]+)*)\s+)?main$/.exec(selector);
      if (!match) continue;
      const required = (match[1] ?? "")
        .split(".")
        .filter(Boolean);
      if (required.every((name) => bodyClasses.has(name))) display = value;
    }
  }
  return { display, visible: display !== null && display !== "none" };
}

test("ISSUE-003 visible: a terminal error leaves the message and Retry on screen", async () => {
  const { dom, bodyClasses, sources, submit } = runPage();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  submit();
  const es = sources[sources.length - 1];
  assert.ok(es, "submitting a URL must open the analysis stream");

  // Before the error the page is mid-run: `main` is on screen via body.running.
  assert.equal(mainVisible(bodyClasses).visible, true, "a running page shows the work area");

  es.emit("error", { error: "missing_config", message: "Brak klucza modelu: ustaw DASHSCOPE_API_KEY." });

  const layout = mainVisible(bodyClasses);
  assert.equal(
    layout.visible,
    true,
    `the terminal error must keep the work area displayed (display was "${layout.display}"); ` +
      "otherwise the message and Retry are in the DOM with no client rects",
  );
  assert.equal(bodyClasses.has("failed"), true, "the page must record the terminal failed state");
  assert.equal(bodyClasses.has("running"), false, "the running state must be cleared");

  // The card the error is written into is inside `main`, so a hidden `main` hides it.
  const card = dom.elements.get("#stripCard") ?? dom.elements.get("#newvid");
  assert.ok(pageHtml.includes('role="alert"'), "index.html must render the error as role=alert");
  assert.ok(card !== undefined, "the error card must exist in the shipped markup");

  // The progress clock is part of the run, not of the result: it must not stay frozen.
  assert.equal(dom.elements.get("#timer").textContent, "", "a terminal state must clear the timer");
  assert.equal(dom.elements.get("#progressLabel").textContent, "", "a terminal state must clear the progress label");
});

test("ISSUE-003 visible: a new run clears the failed state again", async () => {
  const { dom, bodyClasses, sources, submit } = runPage();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  submit();
  sources[sources.length - 1].emit("error", { error: "runtime_unavailable", message: "chwilowy blad" });
  assert.equal(bodyClasses.has("failed"), true, "the error marked the page");

  // Pressing Retry re-issues the same request and must return to the running state.
  dom.elements.get(".retry-action").dispatch("click");
  assert.equal(bodyClasses.has("failed"), false, "a retry must clear the failed state");
  assert.equal(bodyClasses.has("running"), true, "a retry must run again");
  assert.equal(mainVisible(bodyClasses).visible, true, "the retried run shows the work area");
});

test("ISSUE-010 UI: unknown outcome warns before retrying the same teardown operation", async () => {
  const { dom, bodyClasses, sources, submit } = runPage();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  dom.elements.get("#mTear").dispatch("click");
  dom.elements.get("#q").value = "rozbierz film";
  submit();
  assert.match(sources[0].url, /mode=teardown/);
  sources[0].emit("operation", { operationId: "op_fixture_010" });
  sources[0].emit("error", { error: "outcome_unknown", operationId: "op_fixture_010", message: "Wynik wywołania nieznany." });
  assert.equal(bodyClasses.has("failed"), true);
  assert.equal(sources.length, 1, "an error never starts a second provider request");
  assert.match(dom.elements.get(".retry-action").innerHTML, /możliwy dodatkowy koszt/);
  assert.match(pageHtml, /body\.failed \.follow\{display:none\}/, "follow-up controls stay hidden on failure");
  assert.doesNotMatch(pageHtml, /id="retryBtn"/, "error cards do not share a duplicate id");
  dom.elements.get(".retry-action").dispatch("click");
  assert.equal(sources.length, 2);
  assert.equal(dom.elements.get(".retry-action").disabled, true, "the old decision cannot be clicked twice");
  assert.match(sources[1].url, /mode=teardown/);
  assert.match(sources[1].url, /retryOperation=op_fixture_010&confirmRetry=1/);
  assert.equal(bodyClasses.has("failed"), false);
  assert.match(pageHtml, /body\.done \.hero\{display:none\}/, "a delivered result keeps the hero form out of view");
});

test("ISSUE-010 UI: configuration and URL errors return to the form without retrying", async () => {
  for (const error of ["missing_config", "invalid_input"]) {
    const { dom, bodyClasses, sources, submit } = runPage();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    submit();
    sources[0].emit("error", { error, message: "Popraw ustawienia." });
    dom.elements.get(".retry-action").dispatch("click");
    assert.equal(sources.length, 1, `${error} must not issue a new request`);
    assert.equal(bodyClasses.has("failed"), false);
  }
});

test("LF UI: several unknown parts stay visible and the retry names only the unfinished ones", async () => {
  const { dom, bodyClasses, sources, submit } = runPage();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  submit();
  sources[0].emit("operation", { operationId: "op_long_fixture" });
  sources[0].emit("parts", { n: 5, starts: [0, 120, 240, 360, 480] });
  // innerHTML does not build children in this stand-in; plant the five bars.
  const bars = Array.from({ length: 5 }, () => ({ className: "on" }));
  dom.elements.get("#parts").children = bars;
  for (const i of [0, 2, 4]) sources[0].emit("part_done", { i });
  for (const i of [1, 3]) sources[0].emit("part_unknown", { i });
  sources[0].emit("error", { error: "outcome_unknown", operationId: "op_long_fixture", message: "Nie wiadomo, czy czesci 2, 4 (z 5) zostaly rozliczone." });
  assert.equal(bodyClasses.has("failed"), true);
  assert.deepEqual(bars.map((bar) => bar.className), ["ok", "bad", "ok", "bad", "ok"]);
  assert.notEqual(dom.elements.get("#parts").style.display, "none", "the part bar stays on screen after the failure");
  assert.equal(dom.elements.get("#wcount").textContent, "3/5");
  const card = dom.elements.get(".retry-action").innerHTML;
  assert.match(card, /Ponów tylko nieukończone części \(2 z 5\) — możliwy dodatkowy koszt/);
  assert.match(card, /Ukończone części \(3\/5\) są zapisane i nie będą opłacane ponownie/);
  dom.elements.get(".retry-action").dispatch("click");
  assert.equal(sources.length, 2);
  assert.match(sources[1].url, /retryOperation=op_long_fixture&confirmRetry=1/, "same operation: saved parts are reused");
});

test("LF: a long film runs its parts side by side; unknown parts are marked and a confirmed retry pays only for them", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const calls = [];
  let round = 1;
  const model = {
    modelName: "stub-long",
    async call(request) {
      calls.push({ round, part: request.partIndex });
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (round === 1 && (request.partIndex === 1 || request.partIndex === 3)) {
        throw new OmniWatchError("outcome_unknown", "Polaczenie z modelem przerwane (phase=headers code=UND_ERR_SOCKET).");
      }
      request.onResponseStarted?.();
      return {
        text: `[0:05] czesc ${request.partIndex}`,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    // 25 min at 1 fps (LF2 long-film sampling) and 300 frames -> 5 parts.
    source: createFixtureSource({ durationSeconds: 1500 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir, OMNI_MAX_FRAMES: "300" },
  });
  const url = "https://youtu.be/SYNTHETIC01";
  const first = await driveWatch(app, { url });
  const operationId = sseData(first.body, "operation")?.operationId;
  assert.equal(sseData(first.body, "parts")?.n, 5);
  assert.deepEqual(calls.map((call) => call.part).sort(), [0, 1, 2, 3, 4], "all parts attempted, no merge yet");
  const unknownFrames = first.body.split("\n\n").filter((frame) => frame.startsWith("event: part_unknown\n"));
  assert.equal(unknownFrames.length, 2, "each uncertain part is reported to the UI");
  const error = sseData(first.body, "error");
  assert.equal(error?.error, "outcome_unknown");
  assert.match(error.message, /czesci 2, 4 \(z 5\)/);
  assert.match(error.message, /Gotowe czesci \(3\/5\)/);

  // Coming back later with the same form: still gated, and still told which parts.
  const again = await driveWatch(app, { url });
  assert.equal(sseData(again.body, "error")?.error, "outcome_unknown");
  assert.match(sseData(again.body, "error").message, /czesci 2, 4 \(z 5\)/);
  assert.equal(calls.length, 5, "the ordinary resubmit pays nothing");

  round = 2;
  const retry = await driveWatch(app, { url, retryOperation: operationId, confirmRetry: true });
  assert.ok(sseData(retry.body, "done"), retry.body);
  assert.deepEqual(calls.filter((call) => call.round === 2).map((call) => call.part).sort(), [1, 3, 5],
    "only parts 2 and 4 and the merge are paid for again");
  const wiring = createRuntimeWiring({
    dataDir, config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })), environment: {},
  });
  try {
    const attempts = wiring.store.listAttempts(operationId);
    assert.equal(attempts.filter((attempt) => attempt.phase === "unknown").length, 2, "the uncertain calls stay in the audit trail");
    assert.equal(attempts.filter((attempt) => attempt.phase === "response").length, 6);
  } finally {
    wiring.close();
  }
});

test("LF2 standalone: a part the provider closed before headers is resent, the film is delivered and the close stays in the journal", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const calls = [];
  const model = {
    modelName: "stub-long",
    async call(request) {
      calls.push(request.partIndex);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (request.partIndex === 2 && calls.filter((index) => index === 2).length === 1) {
        throw new OmniWatchError("outcome_unknown",
          "Polaczenie z modelem przerwane; nie wiadomo, czy wywolanie doszlo do skutku. (phase=headers code=UND_ERR_SOCKET name=TypeError abort=none elapsed_ms=60040)",
          { transportPhase: "headers" });
      }
      return {
        text: request.mediaParts.length ? `[0:05] czesc ${request.partIndex}` : "## W skrocie\nscalone [3:00]",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 1500 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir, OMNI_MAX_FRAMES: "300" },
  });
  const run = await driveWatch(app, { url: "https://youtu.be/SYNTHETIC02" });
  assert.ok(sseData(run.body, "done"), run.body);
  assert.equal(sseData(run.body, "error"), null, "no state-transition error after a successful resend");
  const operationId = sseData(run.body, "operation")?.operationId;
  assert.deepEqual([...calls].sort((a, b) => a - b), [0, 1, 2, 2, 3, 4, 5], "part 2 twice, then one merge");
  const wiring = createRuntimeWiring({
    dataDir, config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })), environment: {},
  });
  try {
    assert.equal(wiring.store.getOperation(operationId).state, "delivered");
    const attempts = wiring.store.listAttempts(operationId);
    assert.equal(attempts.filter((attempt) => attempt.phase === "unknown").length, 1, "the closed call is still journaled");
    assert.equal(attempts.filter((attempt) => attempt.phase === "response").length, 6);
  } finally {
    wiring.close();
  }
});

test("LF2 standalone: a resend rejected after a pre-header close leaves the operation outcome_unknown, never failed", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const calls = [];
  const model = {
    modelName: "stub-long",
    async call(request) {
      calls.push(request.partIndex);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (request.partIndex === 1) {
        if (calls.filter((index) => index === 1).length === 1) {
          throw new OmniWatchError("outcome_unknown", "Polaczenie z modelem przerwane. (phase=headers code=UND_ERR_SOCKET abort=none)", { transportPhase: "headers" });
        }
        throw new OmniWatchError("provider_rejected", "Model odrzucil zadanie (400).");
      }
      return { text: `[0:05] czesc ${request.partIndex}`, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true }, completed: true };
    },
  };
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 1500 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir, OMNI_MAX_FRAMES: "300" },
  });
  const run = await driveWatch(app, { url: "https://youtu.be/SYNTHETIC03" });
  const error = sseData(run.body, "error");
  assert.equal(error?.error, "outcome_unknown", run.body);
  assert.match(error.message, /czesc 2\/5/);
  const wiring = createRuntimeWiring({
    dataDir, config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })), environment: {},
  });
  try {
    assert.equal(wiring.store.getOperation(error.operationId).state, "outcome_unknown");
  } finally {
    wiring.close();
  }
});

test("R2-08 standalone: a stream-copied part reports where its file really starts", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-slice-"));
  const commands = [];
  const media = createStandaloneMediaTool({
    cacheDir,
    runTool: async (cmd, args) => {
      commands.push(cmd);
      if (cmd === "ffmpeg") fs.writeFileSync(args[args.length - 1], "");
      return { stdout: cmd === "ffprobe" ? "34.610156\n" : "", stderr: "" };
    },
  });
  const sliced = await media.slice({ localPath: path.join(cacheDir, "adacd7b009d5bcd9", "source.mp4"), startSeconds: 29.268, endSeconds: 58.537, index: 1, count: 2 });
  assert.deepEqual(commands, ["ffmpeg", "ffprobe"]);
  assert.match(sliced.localPath, /part_2_1\.mp4$/);
  assert.ok(Math.abs(sliced.startSeconds - 23.927) < 0.01, `start ${sliced.startSeconds}`);
});

test("R2-03 standalone: a refresh upload ignores the cached oss:// entry", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-up-"));
  const dir = path.join(cacheDir, "SYNTH");
  fs.mkdirSync(dir, { recursive: true });
  const partPath = path.join(dir, "part_2_0.mp4");
  fs.writeFileSync(partPath, "video");
  fs.writeFileSync(path.join(dir, "oss.json"), JSON.stringify({ "part_2_0.mp4": { url: "oss://old/part_2_0.mp4", at: Math.floor(Date.now() / 1000) } }));
  const media = createStandaloneMediaTool({ cacheDir });
  const config = { apiKey: () => "fixture-key", apiBaseUrl: () => "https://dashscope-intl.aliyuncs.com", modelName: "qwen3.8-omni-flash" };
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes("getPolicy")) {
      return new Response(JSON.stringify({ data: { upload_dir: "new-dir", upload_host: "https://oss.invalid", oss_access_key_id: "a", signature: "s", policy: "p", x_oss_object_acl: "private", x_oss_forbid_overwrite: "true" } }), { status: 200 });
    }
    return new Response("", { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  assert.equal((await media.uploadPart({ localPath: partPath }, config)).url, "oss://old/part_2_0.mp4", "a normal call reuses the cache");
  assert.equal(requests.length, 0);
  const fresh = await media.uploadPart({ localPath: partPath }, config, { refresh: true });
  assert.equal(fresh.url, "oss://new-dir/part_2_0.mp4");
  assert.equal(fresh.reused, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "oss.json"), "utf8"))["part_2_0.mp4"].url, "oss://new-dir/part_2_0.mp4");
});

/* ------------------------------------------------------------------ ISSUE-007 -- */

/**
 * The live QA test ran ONE standalone process and hit it from two browser tabs: a
 * summary and a follow-up, plus a teardown of the same film. The follow-up died with
 * "Ten proces nie jest juz wlascicielem katalogu danych OmniWatch" while no server was
 * restarted and the host used its own data dir.
 *
 * Cause: every `/api/watch` request built its own runtime wiring and called
 * `acquireOwner`, but nothing refreshed that owner. A real Qwen analysis runs far
 * longer than the takeover window (30 s), so the request's heartbeat stayed frozen at
 * acquire time; the second concurrent request saw a stale heartbeat, took the data
 * directory over, and the first request then failed inside `assertOwnership` - with
 * its paid answer already on disk and the operation left in `running`.
 *
 * These tests drive the REAL handler over the real store with controlled timing. The
 * model blocks on a gate, so "a request that is still working" is deterministic
 * instead of a flaky sleep.
 */
function gatedModel() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  return {
    modelName: "stub-gated",
    calls,
    release: () => release(),
    async call(request) {
      calls.push(request.operationId);
      await gate;
      return {
        text: "## Summary\n- [0:05] punkt",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
}

function watchShell() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-own-"));
  const appRoot = path.join(dir, "app");
  const dataDir = path.join(dir, "data");
  const cacheDir = path.join(dir, "cache");
  for (const d of [appRoot, dataDir, cacheDir]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(appRoot, "static"), { recursive: true });
  for (const name of ["index.html", "i18n.json"]) {
    fs.copyFileSync(path.join(repo, "apps/standalone/static", name), path.join(appRoot, "static", name));
  }
  fs.writeFileSync(path.join(appRoot, ".env"), "DASHSCOPE_API_KEY=fixture-not-a-secret\nOMNI_MODEL=fixture\n");
  // A real cached film, so `prepare` resolves offline instead of shelling out to
  // yt-dlp. Without it the request fails at the download stage and never reaches the
  // model, which would make the ownership assertions test nothing. Same fixture the
  // frame tests use.
  plantCachedVideo(cacheDir, "SYNTHETIC01");
  return { dir, appRoot, dataDir, cacheDir };
}

/** Copy one fixture film (source.mp4 + info.json) into a fresh cache directory. */
function plantCachedVideo(cacheDir, id) {
  const target = path.join(cacheDir, id);
  fs.mkdirSync(target, { recursive: true });
  for (const name of ["source.mp4", "info.json"]) {
    fs.copyFileSync(path.join(fixtures, "legacy/.cache", id, name), path.join(target, name));
  }
  return target;
}

/**
 * Drive `/api/watch` through the app's own handler with no socket.
 *
 * `createStandaloneServer` exposes `handle(req, res)` for exactly this: the same code
 * path that sits behind `http.createServer`, minus the bind. That keeps the queue and
 * ownership assertions runnable even where binding loopback is not permitted, and it
 * is the last resort only because a real socket is a stronger test - the socket-based
 * tests above still cover the transport.
 */
async function driveWatch(app, { url, q = "", lang = "pl", mode = "summary", retryOperation = null, confirmRetry = false }) {
  const query = new URLSearchParams({ url, q, lang, mode });
  if (retryOperation) query.set("retryOperation", retryOperation);
  if (confirmRetry) query.set("confirmRetry", "1");
  const req = {
    method: "GET",
    url: `/api/watch?${query.toString()}`,
    headers: { host: `127.0.0.1:${app.port}` },
  };
  let body = "";
  const res = {
    headersSent: false,
    writeHead() {
      res.headersSent = true;
      return res;
    },
    write(chunk) {
      body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      res.headersSent = true;
      return true;
    },
    end(chunk) {
      if (typeof chunk === "string") body += chunk;
      else if (chunk) body += Buffer.from(chunk).toString("utf8");
      res.headersSent = true;
      return res;
    },
  };
  await app.handle(req, res);
  return { body };
}

function sseData(body, name) {
  const frame = body.split("\n\n").find((part) => part.startsWith(`event: ${name}\n`));
  return frame ? JSON.parse(frame.split("\n").find((line) => line.startsWith("data: ")).slice(6)) : null;
}

test("ISSUE-010: unknown outcome needs explicit same-operation retry and never auto-calls twice", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const calls = [];
  const model = {
    modelName: "stub-unknown-once",
    async call(request) {
      calls.push({ operationId: request.operationId, attemptId: request.attemptId });
      if (calls.length === 1) throw new OmniWatchError("outcome_unknown", "Polaczenie przerwane po wyslaniu.");
      return {
        text: "## Summary\n- [0:05] punkt",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 16 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  const url = "https://youtu.be/SYNTHETIC01";
  const first = await driveWatch(app, { url, q: "rozbierz film", mode: "teardown" });
  const operationId = sseData(first.body, "operation")?.operationId;
  assert.ok(operationId, "the UI receives the durable operation identity");
  assert.equal(sseData(first.body, "error")?.error, "outcome_unknown");
  assert.equal(sseData(first.body, "error")?.operationId, operationId);
  assert.equal(calls.length, 1);

  const ordinary = await driveWatch(app, { url, q: "rozbierz film", mode: "teardown" });
  assert.equal(sseData(ordinary.body, "error")?.error, "outcome_unknown");
  assert.equal(calls.length, 1, "ordinary Retry cannot repeat an uncertain paid call");
  const unconfirmed = await driveWatch(app, { url, retryOperation: operationId, mode: "summary" });
  assert.equal(sseData(unconfirmed.body, "error")?.error, "invalid_input");
  assert.equal(calls.length, 1, "an operation id alone is not consent");

  const explicit = await driveWatch(app, { url, retryOperation: operationId, confirmRetry: true, mode: "summary" });
  assert.ok(sseData(explicit.body, "done"), explicit.body);
  assert.deepEqual(calls.map((call) => call.operationId), [operationId, operationId], "the approved retry reuses the same operation");
  assert.notEqual(calls[0].attemptId, calls[1].attemptId, "retry gets a fresh attempt identity");
  const duplicate = await driveWatch(app, { url, retryOperation: operationId, confirmRetry: true });
  assert.equal(sseData(duplicate.body, "error")?.error, "invalid_input");
  assert.equal(calls.length, 2, "confirmation cannot launch the same completed operation twice");

  const wiring = createRuntimeWiring({
    dataDir, config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })), environment: {},
  });
  try {
    const operation = wiring.store.getOperation(operationId);
    assert.equal(operation.request.mode, "teardown", "form mode cannot replace the saved retry mode");
    assert.equal(operation.request.question, "rozbierz film");
    assert.equal(operation.state, "delivered");
    assert.deepEqual(wiring.store.listAttempts(operationId).map((attempt) => attempt.phase).sort(), ["response", "unknown"],
      "the first uncertain attempt remains in the audit trail after a paid retry");
  } finally {
    wiring.close();
  }
});

test("a confirmed retry reuses committed earlier parts and pays only for unfinished parts", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const calls = [];
  let failedOnce = false;
  const model = {
    modelName: "stub-checkpoint",
    async call(request) {
      calls.push(request.partIndex);
      if (request.partIndex === 1 && !failedOnce) {
        failedOnce = true;
        throw new OmniWatchError("outcome_unknown", "Przerwano druga czesc.");
      }
      return {
        text: `Potwierdzona odpowiedz ${request.partIndex}`,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 240 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir, OMNI_MAX_FRAMES: "300" },
  });
  const url = "https://youtu.be/SYNTHETIC01";
  const first = await driveWatch(app, { url, mode: "teardown" });
  const operationId = sseData(first.body, "operation")?.operationId;
  assert.ok(operationId);
  assert.equal(sseData(first.body, "error")?.error, "outcome_unknown");
  assert.deepEqual(calls, [0, 1]);

  const retry = await driveWatch(app, { url, retryOperation: operationId, confirmRetry: true });
  assert.ok(sseData(retry.body, "done"), retry.body);
  assert.deepEqual(calls, [0, 1, 1, 2], "part 0 is reused; only uncertain part 1 and merge call are paid");
  const wiring = createRuntimeWiring({
    dataDir, config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })), environment: {},
  });
  try {
    const attempts = wiring.store.listAttempts(operationId);
    assert.equal(attempts.filter((attempt) => attempt.partIndex === 0 && attempt.phase === "response").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.partIndex === 1 && attempt.phase === "unknown").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.partIndex === 1 && attempt.phase === "response").length, 1);
  } finally {
    wiring.close();
  }
});

test("one explicitly approved legacy response can be reused without enabling length-only caching", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const calls = [];
  const model = {
    modelName: "stub-legacy-checkpoint",
    async call(request) {
      calls.push(request.partIndex);
      if (request.partIndex === 1 && calls.length === 2) throw new OmniWatchError("outcome_unknown", "Druga czesc niepewna.");
      return {
        text: `Odpowiedz ${request.partIndex}`,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 240 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir, OMNI_MAX_FRAMES: "300" },
  });
  const url = "https://youtu.be/SYNTHETIC01";
  const first = await driveWatch(app, { url });
  const operationId = sseData(first.body, "operation")?.operationId;
  assert.equal(sseData(first.body, "error")?.error, "outcome_unknown");
  const wiring = createRuntimeWiring({
    dataDir, config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })), environment: {},
  });
  let oldId;
  try {
    const response = wiring.store.listAttempts(operationId).find((attempt) => attempt.phase === "response");
    assert.ok(response);
    oldId = response.id;
    // A pre-v2 summary had neither the digest nor the recorded prompt date.
    const { schema, contentHash, promptDate, ...legacySummary } = JSON.parse(response.requestSummary);
    assert.equal(schema, 2);
    assert.ok(contentHash);
    assert.match(promptDate, /^\d{4}-\d{2}-\d{2}$/);
    wiring.store.recordAttempt({
      id: response.id, operationId, phase: "response", partIndex: response.partIndex,
      model: response.model, requestSummary: JSON.stringify(legacySummary),
      responseSummary: response.responseSummary, usage: response.usage,
    });
  } finally {
    wiring.close();
  }
  app.config.effectiveEnv.OMNIWATCH_LEGACY_CHECKPOINT_ATTEMPT = oldId;
  const retry = await driveWatch(app, { url, retryOperation: operationId, confirmRetry: true });
  assert.ok(sseData(retry.body, "done"), retry.body);
  assert.deepEqual(calls, [0, 1, 1, 2], "only the approved legacy response is reused");
});

test("ISSUE-007: a live request keeps ownership, so a concurrent run is not a takeover", async (t) => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const model = gatedModel();
  const app = createStandaloneServer({
    appRoot,
    dataDir,
    cacheDir,
    model,
    source: createFixtureSource({ durationSeconds: 16 }),
    // Port 0: the OS picks a free port. A fixed port makes two concurrent test
    // processes collide with EADDRINUSE, which hides the behaviour under test behind
    // an unrelated bind failure.
    port: 0,
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  const address = await listenOrSkip(t, app);
  if (!address) return;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    // First request: starts, blocks in the model, holds the data directory.
    const first = fetch(`${base}/api/watch?url=${encodeURIComponent("https://youtu.be/SYNTHETIC01")}&lang=pl&mode=summary`);
    // Wait until the paid call is actually in flight.
    for (let i = 0; i < 200 && model.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(model.calls.length, 1, "the first request must reach the model");

    // The heartbeat must be refreshed while the request is still working. A frozen
    // heartbeat is exactly what let a second request steal the directory.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Second request while the first is still running: same process, same data dir.
    // It is a different question on the same film, so it is genuinely separate work -
    // and it must never take the directory away from the live first request.
    const second = fetch(
      `${base}/api/watch?url=${encodeURIComponent("https://youtu.be/SYNTHETIC01")}` +
        `&q=${encodeURIComponent("inny punkt")}&lang=pl&mode=summary`,
    );
    // A second tab waits its turn in the same process. Releasing the model lets both
    // operations finish, so neither caller is stranded with a pending operation.
    model.release();
    const secondBody = await (await second).text();

    assert.doesNotMatch(
      secondBody,
      /nie jest juz wlascicielem/,
      "no request may lose ownership while the process is alive",
    );

    const firstBody = await (await first).text();
    assert.doesNotMatch(
      firstBody,
      /nie jest juz wlascicielem/,
      "the long-running request must keep its ownership and deliver its paid answer",
    );
    assert.match(firstBody, /event: done/, "the first request must still deliver a result");
  } finally {
    await app.close();
  }
});

test("ISSUE-007: a genuinely stale owner is still replaceable, a fresh one is not", () => {
  const { appRoot, dataDir } = watchShell();
  const config = runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} }));
  // The takeover window is a property of the STORE, so the test configures the store
  // the same way `runWorker` does instead of going through the HTTP app: the previous
  // version built a zero-window server and then inspected an unrelated default-window
  // wiring, so its "replaceable" expectation could never hold and the D5 guarantee it
  // claimed to protect was never actually exercised.
  const wiring = createRuntimeWiring({ dataDir, config, environment: {}, ownerStaleAfterMs: 0 });
  try {
    assert.equal(wiring.store.acquireOwner("live_owner", process.pid, "2026-09-22T10:00:00.000Z"), true);

    // A fresh heartbeat belongs to a live process and must NOT be stolen, even though
    // this store has a zero-length window: the age check compares timestamps, and a
    // newer beat than the reference proves the owner is alive.
    assert.equal(
      wiring.store.acquireOwner("thief", process.pid, "2026-09-22T10:00:00.000Z"),
      false,
      "a live owner must keep the directory",
    );
    assert.equal(wiring.store.getOwner().token, "live_owner");

    // An owner whose last beat is older than the window is abandoned and may be
    // replaced. This is the D5 guarantee the fix must not remove.
    assert.equal(
      wiring.store.acquireOwner("new_owner", process.pid, "2026-09-22T10:00:05.000Z"),
      true,
      "an abandoned owner must still be replaceable",
    );
    assert.equal(wiring.store.getOwner().token, "new_owner");
    assert.equal(
      wiring.store.heartbeat("live_owner", "2026-09-22T10:00:05.000Z"),
      false,
      "the replaced owner is refused",
    );
  } finally {
    wiring.close();
  }
});

/* --------------------------------------------------------- ISSUE-007 (queue) -- */

/**
 * Root's second half of ISSUE-007: a heartbeat alone is not enough.
 *
 * The first version of the handler admitted work (`enqueueAnalysis`, which writes a
 * `pending` operation) and only then asked for ownership. When a second request lost
 * that race it was refused - correctly - but the queue kept a `pending` operation
 * that no consumer would ever pick up: the caller saw an error while the disk said
 * there was work waiting.
 *
 * These tests drive the real handler through the socket-free `handle()` path so the
 * assertion is about store state, not transport. A competing owner is installed in a
 * separate wiring over the SAME data directory, which is exactly the situation the
 * live QA run hit (a worker or another request already holding the directory).
 */
test("ISSUE-007 queue: a request refused ownership leaves NO pending operation behind", async (t) => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const app = createStandaloneServer({
    appRoot,
    dataDir,
    cacheDir,
    model: gatedModel(),
    source: createFixtureSource({ durationSeconds: 16 }),
    port: 0,
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });

  // Another consumer already owns this data directory and is still beating.
  const rival = createRuntimeWiring({
    dataDir,
    config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })),
    environment: {},
  });
  try {
    assert.equal(rival.store.acquireOwner("rival_owner", process.pid, new Date().toISOString()), true);

    const result = await driveWatch(app, {
      url: "https://youtu.be/SYNTHETIC02",
      lang: "pl",
      mode: "summary",
    });

    // The request must be refused visibly, with the actionable "another worker" reason.
    assert.match(result.body, /event: error/, "the competing request must end in an SSE error frame");
    assert.match(
      result.body,
      /runtime_unavailable/,
      "the error must name the refused-ownership class",
    );

    // And the queue must not hold work nobody can run. This is the regression: the
    // old order wrote a pending operation before the ownership check failed.
    const pending = rival.store.listOperations({ state: "pending" });
    assert.equal(
      pending.length,
      0,
      `a refused request must not leave consumer-less work, found ${pending.length} pending operation(s)`,
    );
  } finally {
    rival.close();
    await app.close();
  }
});

test("ISSUE-007 queue: the owner survives its own long request and the queue drains", async (t) => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const model = gatedModel();
  const app = createStandaloneServer({
    appRoot,
    dataDir,
    cacheDir,
    model,
    source: createFixtureSource({ durationSeconds: 16 }),
    port: 0,
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  try {
    // First request blocks inside the model, holding the directory.
    const first = driveWatch(app, { url: "https://youtu.be/SYNTHETIC01", lang: "pl", mode: "summary" });
    for (let i = 0; i < 200 && model.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(model.calls.length, 1, "the first request must reach the model");

    // Long enough for the heartbeat to tick at least once, well under the 30 s window.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The first run completes normally, with its answer, and leaves no pending work.
    model.release();
    const firstResult = await first;
    assert.match(firstResult.body, /event: done/, "the owned request must deliver its result");
    assert.doesNotMatch(
      firstResult.body,
      /nie jest juz wlascicielem/,
      "a live request must never lose its own directory",
    );

    const wiring = createRuntimeWiring({
      dataDir,
      config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })),
      environment: {},
    });
    try {
      assert.equal(
        wiring.store.listOperations({ state: "pending" }).length,
        0,
        "the queue must be drained once the request finishes",
      );
      assert.equal(wiring.store.getOwner(), null, "ownership must be released when the request ends");
    } finally {
      wiring.close();
    }
  } finally {
    await app.close();
  }
});

test("ISSUE-007 queue: two tabs complete distinct requests without orphaned work", async () => {
  const { appRoot, dataDir } = watchShell();
  const model = gatedModel();
  const app = createStandaloneServer({
    appRoot,
    dataDir,
    source: createFixtureSource({ durationSeconds: 16 }),
    model,
    port: 0,
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  try {
    const first = driveWatch(app, { url: "https://youtu.be/SYNTHETIC01", mode: "summary" });
    for (let i = 0; i < 200 && model.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(model.calls.length, 1, "first request reaches the model");
    const second = driveWatch(app, {
      url: "https://youtu.be/SYNTHETIC01",
      q: "Wyjasnij inny punkt",
      mode: "summary",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(model.calls.length, 1, "second request waits without making a paid call");
    model.release();
    const [a, b] = await Promise.all([first, second]);
    assert.match(a.body, /event: done/);
    assert.match(b.body, /event: done/);
    assert.equal(model.calls.length, 2, "each distinct request executes exactly once");
    const wiring = createRuntimeWiring({
      dataDir,
      config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })),
      environment: {},
    });
    try {
      assert.equal(wiring.store.listOperations({ state: "pending" }).length, 0);
      assert.equal(wiring.store.listOperations({ state: "running" }).length, 0);
      assert.equal(wiring.store.listOperations({ state: "delivered" }).length, 2);
      assert.equal(wiring.store.getOwner(), null);
    } finally {
      wiring.close();
    }
  } finally {
    model.release();
    await app.close();
  }
});

test("a prompt-template bump never re-pays for a film already analysed under the old prompt", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const calls = [];
  const model = {
    modelName: "stub-prompt-bump",
    async call(request) {
      calls.push(request.partIndex);
      return {
        text: "## W skrocie\n- [0:05] stary wynik",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
  const options = {
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 16 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  };
  const url = "https://youtu.be/SYNTHETIC01";
  const first = await driveWatch(createStandaloneServer(options), { url });
  const operationId = sseData(first.body, "operation")?.operationId;
  assert.ok(sseData(first.body, "done"), first.body);
  assert.deepEqual(calls, [0]);

  // Make the stored evidence look exactly like a result written by the previous
  // template version (prompt-v1, before the current-date rule existed).
  const wiring = createRuntimeWiring({
    dataDir, config: runtimeConfigDocument(loadStandaloneConfig({ appRoot, env: {} })), environment: {},
  });
  try {
    for (const attempt of wiring.store.listAttempts(operationId)) {
      if (!attempt.requestSummary) continue;
      wiring.store.recordAttempt({
        ...attempt, requestSummary: attempt.requestSummary.replace(/prompt-v\d+\//g, "prompt-v1/"),
      });
    }
    assert.ok(wiring.store.listAttempts(operationId).some((a) => /prompt-v1\//.test(a.requestSummary ?? "")));
  } finally {
    wiring.close();
  }

  // Pasting the same URL again on a fresh server process reads the saved result.
  const again = await driveWatch(createStandaloneServer(options), { url });
  const done = sseData(again.body, "done");
  assert.ok(done, again.body);
  // QA R2-07: a read of the saved result is labelled as such, with no new cost.
  assert.equal(done.usage.savedAnswer, true, "the saved result is returned, not recomputed");
  assert.equal(done.usage.costUsd, undefined, "the old bill is not presented as a new cost");
  assert.match(done.text, /stary wynik/);
  assert.deepEqual(calls, [0], "no new paid call after the template version changed");
});

/*
 * QA 2026-09-23 M09 / ISSUE-012: resubmitting an IDENTICAL form request (same URL,
 * topic, mode, language) after other questions about the same film paid again. The
 * form sends no conversation/parent, yet the core treated the question as an implicit
 * continuation of the newest answer in the source-derived conversation, so every new
 * answer changed contextKey -> analysisKey. Evidence: state.sqlite of the QA run,
 * op_3c2789ae (2 turns in context) vs op_252af0dc (16 turns), identical request_json.
 */
function countingModel() {
  const calls = [];
  return {
    modelName: "stub-counting",
    calls,
    async call(request) {
      calls.push(request.operationId);
      return {
        text: `## Odpowiedz\n- [0:05] odpowiedz ${calls.length}`,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
}

test("M09: an identical form question after other questions reads the saved answer, no new paid call", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const model = countingModel();
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 16 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  try {
    const url = "https://youtu.be/SYNTHETIC01";
    const first = await driveWatch(app, { url, q: "rozstaw dłoni", mode: "summary" });
    assert.ok(sseData(first.body, "done"), first.body);
    const firstOp = sseData(first.body, "operation")?.operationId;
    assert.equal(model.calls.length, 1);

    // Other questions about the same film write more turns into its conversation.
    await driveWatch(app, { url, q: "dieta i suplementacja", mode: "summary" });
    await driveWatch(app, { url, mode: "teardown" });
    assert.equal(model.calls.length, 3);

    const again = await driveWatch(app, { url, q: "rozstaw dłoni", mode: "summary" });
    assert.ok(sseData(again.body, "done"), again.body);
    assert.equal(sseData(again.body, "operation")?.operationId, firstOp, "same request -> same operation");
    assert.equal(sseData(again.body, "turn")?.reused, true, "the saved answer is shown");
    assert.equal(model.calls.length, 3, "no second paid call for an identical request");

    // Language is part of the key: the same topic in another language is new work.
    await driveWatch(app, { url, q: "rozstaw dłoni", mode: "summary", lang: "en" });
    assert.equal(model.calls.length, 4);
  } finally {
    await app.close();
  }
});

test("M07/M09: an identical request submitted while the first is running is not paid twice", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const model = gatedModel();
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 16 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  try {
    const url = "https://youtu.be/SYNTHETIC01";
    const first = driveWatch(app, { url, q: "jaki jest kat lokci", mode: "summary" });
    for (let i = 0; i < 200 && model.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(model.calls.length, 1);
    const second = driveWatch(app, { url, q: "jaki jest kat lokci", mode: "summary" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    model.release();
    const [a, b] = await Promise.all([first, second]);
    assert.match(a.body, /event: done/);
    assert.match(b.body, /event: done/, b.body);
    assert.equal(model.calls.length, 1, "the refresh-and-resubmit waits for and reuses the first answer");
    assert.equal(sseData(b.body, "operation")?.operationId, sseData(a.body, "operation")?.operationId);
  } finally {
    model.release();
    await app.close();
  }
});

test("an explicit follow-up (conversation + parent) still uses history and is its own analysis", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const model = countingModel();
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 16 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  try {
    const url = "https://youtu.be/SYNTHETIC01";
    const first = await driveWatch(app, { url, mode: "summary" });
    const turn = sseData(first.body, "turn");
    assert.ok(turn?.conversationId && turn?.turnId);
    const query = new URLSearchParams({ url, q: "rozwin punkt 2", lang: "pl", mode: "summary", conversation: turn.conversationId, parent: turn.turnId });
    let body = "";
    const res = { headersSent: false, writeHead() { return res; }, write(c) { body += String(c); return true; }, end(c) { if (c) body += String(c); return res; } };
    await app.handle({ method: "GET", url: `/api/watch?${query}`, headers: { host: "127.0.0.1" } }, res);
    assert.match(body, /event: done/, body);
    assert.equal(sseData(body, "turn")?.parentTurnId, turn.turnId);
    assert.equal(model.calls.length, 2);
  } finally {
    await app.close();
  }
});

/*
 * Integration 2026-09-23 (G + L + M together). Before L, other questions about the
 * same film changed the key of an identical form request, so resubmitting it after an
 * outcome_unknown admitted a NEW operation and paid again past the unknown gate. With
 * L the identical request keeps its key (no declared conversation -> no history), so
 * it lands on the same unknown operation; the confirmed retry (M/ISSUE-010) is the only
 * way to pay again, the worker's key check still agrees after the other turns, and the
 * retry on the next day keeps the first attempt's prompt date (G).
 */
test("integration: unknown stays gated after other questions; a confirmed next-day retry pays once with the first date", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  let nowIso = "2026-09-22T10:00:00.000Z";
  const clock = {
    now: () => new Date(nowIso),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const calls = [];
  const model = {
    modelName: "stub-integration",
    async call(request) {
      const date = JSON.stringify(request.messages).match(/TODAY'S DATE IS (\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
      calls.push({ operationId: request.operationId, date });
      if (calls.length === 1) throw new OmniWatchError("outcome_unknown", "Polaczenie przerwane po wyslaniu.");
      return {
        text: `## Odpowiedz\n- [0:05] odpowiedz ${calls.length}`,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true },
        completed: true,
      };
    },
  };
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model, clock,
    source: createFixtureSource({ durationSeconds: 16 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  try {
    const url = "https://youtu.be/SYNTHETIC01";
    const first = await driveWatch(app, { url, q: "rozstaw dloni", mode: "summary" });
    const operationId = sseData(first.body, "operation")?.operationId;
    assert.equal(sseData(first.body, "error")?.error, "outcome_unknown");
    assert.deepEqual(calls, [{ operationId, date: "2026-09-22" }]);

    // Another question about the same film is answered and writes a turn.
    const other = await driveWatch(app, { url, q: "dieta", mode: "summary" });
    assert.ok(sseData(other.body, "done"), other.body);
    assert.equal(calls.length, 2);

    // The identical request is still the same, uncertain operation: no new paid call.
    const again = await driveWatch(app, { url, q: "rozstaw dloni", mode: "summary" });
    assert.equal(sseData(again.body, "operation")?.operationId, operationId);
    assert.equal(sseData(again.body, "error")?.error, "outcome_unknown");
    assert.equal(calls.length, 2, "resubmitting the form never bypasses the unknown gate");

    // The next day the user confirms the retry: one paid call, same operation, first date.
    nowIso = "2026-09-23T09:00:00.000Z";
    const retry = await driveWatch(app, { url, retryOperation: operationId, confirmRetry: true });
    assert.ok(sseData(retry.body, "done"), retry.body);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2], { operationId, date: "2026-09-22" });
    assert.equal(calls[1].date, "2026-09-22", "every path carries the date");
  } finally {
    await app.close();
  }
});

/* ------------------------------------------ QA R2 (standalone shell, 2026-09-23) ---- */

/** A model that answers at once until `hold()` is called, then waits for `release()`. */
function holdableModel() {
  const calls = [];
  let gate = null;
  return {
    modelName: "stub-holdable",
    calls,
    hold() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      gate = { promise, release };
    },
    release() {
      gate?.release();
      gate = null;
    },
    async call(request) {
      calls.push(request.operationId);
      if (gate) await gate.promise;
      return {
        text: `## Odpowiedz\n- [0:05] odpowiedz ${calls.length}`,
        usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.0101, costKnown: true },
        completed: true,
      };
    },
  };
}

test("QA R2-06: a saved answer is read at once while another film's paid analysis is running", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const model = holdableModel();
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 16 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  try {
    const url = "https://youtu.be/SYNTHETIC01";
    const first = await driveWatch(app, { url, q: "kat lokci" });
    assert.ok(sseData(first.body, "done"), first.body);
    assert.equal(model.calls.length, 1);

    // Another film's long paid analysis occupies the queue.
    model.hold();
    const long = driveWatch(app, { url: "https://youtu.be/OTHERFILM01", q: "dlugie pytanie" });
    for (let i = 0; i < 200 && model.calls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(model.calls.length, 2, "the long analysis is running");

    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000));
    const read = await Promise.race([driveWatch(app, { url, q: "kat lokci" }), timeout]);
    assert.notEqual(read, "timeout", "the free read of a saved answer must not wait behind the running analysis");
    const done = sseData(read.body, "done");
    assert.ok(done, read.body);
    assert.match(done.text, /odpowiedz 1/);
    assert.equal(done.usage.savedAnswer, true);
    assert.doesNotMatch(read.body, /"step":"download"/, "no misleading 'downloading' stage for a saved read");
    assert.equal(model.calls.length, 2, "no new paid call");

    // New work that has to wait says so instead of showing a frozen download step.
    const waiting = driveWatch(app, { url, q: "nowe pytanie" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    model.release();
    const [longDone, waited] = await Promise.all([long, waiting]);
    assert.match(longDone.body, /event: done/);
    assert.match(waited.body, /event: done/, waited.body);
    const stages = waited.body.split("\n\n").filter((frame) => frame.startsWith("event: stage\n"));
    assert.match(stages[0] ?? "", /"step":"queued"/, "the first stage of a waiting request is 'queued'");
  } finally {
    model.release();
    await app.close();
  }
});

test("QA R2-07: reading a saved answer reports no new cost and is not labelled as a paid upload reuse", async () => {
  const { appRoot, dataDir, cacheDir } = watchShell();
  const model = holdableModel();
  const app = createStandaloneServer({
    appRoot, dataDir, cacheDir, model,
    source: createFixtureSource({ durationSeconds: 16 }),
    env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir },
  });
  try {
    const url = "https://youtu.be/SYNTHETIC01";
    const paid = sseData((await driveWatch(app, { url, q: "ile kosztuje" })).body, "done");
    assert.equal(paid.usage.costKnown, true);
    assert.equal(paid.usage.savedAnswer, undefined);
    const saved = sseData((await driveWatch(app, { url, q: "ile kosztuje" })).body, "done");
    assert.equal(saved.usage.savedAnswer, true);
    assert.equal(saved.usage.newCostUsd, 0);
    assert.equal(saved.usage.costUsd, undefined, "the old bill is not the cost of this read");
    assert.equal(saved.usage.costKnown, undefined);
    assert.equal(saved.usage.reused, false, "the upload-reuse label belongs to paid analyses");
    assert.equal(saved.usage.originalCostUsd, paid.usage.costUsd, "the original cost stays available");
  } finally {
    await app.close();
  }

  // The page shows "saved analysis - no new cost" for a read and the price for a paid run.
  const i18n = JSON.parse(pageI18n);
  for (const lang of Object.keys(i18n)) {
    assert.ok(i18n[lang].ui.statSaved, `statSaved in ${lang}`);
    assert.ok(i18n[lang].ui.pendingQueued, `pendingQueued in ${lang}`);
  }
  const previousMarked = globalThis.marked;
  globalThis.marked = { parse: (text) => text };
  try {
    const statsFor = async (usage) => {
      const { dom, sources, submit } = runPage();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      submit();
      const card = [...dom.elements.entries()].filter(([id]) => id.startsWith("#dyn-")).pop()[1];
      const html = [];
      card.insertAdjacentHTML = (_position, markup) => html.push(markup);
      const es = sources[sources.length - 1];
      es.emit("stage", { step: "queued", ahead: 1 });
      const pendingText = dom.elements.get(".retry-action").textContent;
      es.emit("done", { text: "## Odpowiedz\n- ok", usage });
      return { stats: html.join(""), pendingText };
    };
    const read = await statsFor({ in: 0, out: 0, parts: 1, reused: false, savedAnswer: true, newCostUsd: 0, originalCostUsd: 0.0101 });
    assert.match(read.stats, new RegExp(i18n.pl.ui.statSaved));
    assert.doesNotMatch(read.stats, /\$0\.010/, "no old bill on a saved read");
    assert.doesNotMatch(read.stats, new RegExp(i18n.pl.ui.statReused));
    assert.equal(read.pendingText, i18n.pl.ui.pendingQueued, "a queued request says it is waiting");
    const paidRun = await statsFor({ in: 1000, out: 500, parts: 1, reused: true, costUsd: 0.0101, costKnown: true });
    assert.match(paidRun.stats, /\$0\.010/);
    assert.match(paidRun.stats, new RegExp(i18n.pl.ui.statReused));
    assert.doesNotMatch(paidRun.stats, new RegExp(i18n.pl.ui.statSaved));
  } finally {
    globalThis.marked = previousMarked;
  }
});

test("QA R3-03: a retry says how many earlier calls have an unknown cost", async () => {
  // R3-03: after a conscious retry the run reports `costKnown: true` and the cost of
  // the calls it confirmed. That is correct for what it bills, but the operation may
  // also have been charged for calls of an earlier run that were never confirmed, so
  // the total must not read as the whole story.
  const i18n = JSON.parse(pageI18n);
  for (const lang of Object.keys(i18n)) {
    assert.ok(i18n[lang].ui.statUnknownCalls, `statUnknownCalls in ${lang}`);
    assert.match(i18n[lang].ui.statUnknownCalls, /\{n\}/, `statUnknownCalls in ${lang} is a template`);
  }

  // The wire shape: the count travels only when there is something to report.
  const confirmed = { inputTokens: 1000, outputTokens: 500, costUsd: 0.016, costKnown: true, unknownCostCalls: 2 };
  assert.equal(usagePayload(confirmed, 3, false).unknownCostCalls, 2);
  assert.equal(
    usagePayload({ inputTokens: 10, outputTokens: 5, costUsd: 0.001, costKnown: true }, 1, false).unknownCostCalls,
    undefined,
    "a run with nothing unconfirmed is unchanged",
  );
  assert.equal(
    usagePayload({ inputTokens: 10, outputTokens: 5, costUsd: null, costKnown: false, unknownCostCalls: 2 }, 1, false).unknownCostCalls,
    undefined,
    "with an unknown total, the extra count would only repeat what 'cost unknown' already says",
  );

  const previousMarked = globalThis.marked;
  globalThis.marked = { parse: (text) => text };
  try {
    const statsFor = async (usage) => {
      const { dom, sources, submit } = runPage();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      submit();
      const card = [...dom.elements.entries()].filter(([id]) => id.startsWith("#dyn-")).pop()[1];
      const html = [];
      card.insertAdjacentHTML = (_position, markup) => html.push(markup);
      sources[sources.length - 1].emit("done", { text: "## Odpowiedz\n- ok", usage });
      return html.join("");
    };

    // The retry of the D run: two earlier calls of unknown cost, one confirmed total.
    const retried = await statsFor({ in: 1000, out: 500, parts: 3, reused: false, costUsd: 0.016, costKnown: true, unknownCostCalls: 2 });
    assert.match(retried, /\$0\.016/, "the confirmed cost is still shown");
    assert.match(retried, /\+ 2 wywołań o nieznanym koszcie/, "and the two earlier calls are named");
    // A run with nothing unconfirmed says nothing extra: the note stays as it was.
    const clean = await statsFor({ in: 1000, out: 500, parts: 1, reused: false, costUsd: 0.0101, costKnown: true });
    assert.match(clean, /\$0\.010/);
    assert.doesNotMatch(clean, /nieznanym koszcie/, "no phantom warning on a clean run");
  } finally {
    globalThis.marked = previousMarked;
  }
});

test("QA R2 L1: frames for a beta-cached video are written to the new data directory, never into the beta tree", async (t) => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-l1-"));
  const dataDir = path.join(appRoot, "data");
  fs.mkdirSync(path.join(appRoot, "static"), { recursive: true });
  fs.copyFileSync(path.join(repo, "apps/standalone/static/index.html"), path.join(appRoot, "static", "index.html"));
  const betaDir = path.join(appRoot, ".cache", "SYNTHETIC01");
  fs.mkdirSync(betaDir, { recursive: true });
  fs.copyFileSync(path.join(fixtures, "legacy/.cache/SYNTHETIC01/source.mp4"), path.join(betaDir, "source.mp4"));

  const context = { config: { appRoot, cacheDir: path.join(dataDir, "cache") } };
  const target = frameTargetPath(context, "SYNTHETIC01", 3);
  assert.equal(target.file, path.join(dataDir, "cache", "SYNTHETIC01", "frames", "3.jpg"));
  assert.equal(frameTargetPath(context, "UNKNOWNFIX", 3), null, "no video, no frame target");

  const app = createStandaloneServer({ appRoot, dataDir, env: { OMNIWATCH_DATA_DIR: dataDir }, port: 0 });
  const address = await listenOrSkip(t, app);
  if (!address) return;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/frame/SYNTHETIC01/3.jpg`);
    assert.equal(response.status, 200);
    assert.ok(fs.existsSync(target.file), "the frame is in the new runtime's cache");
    assert.equal(fs.existsSync(path.join(betaDir, "frames")), false, "the beta .cache is not written");
    assert.deepEqual(fs.readdirSync(betaDir), ["source.mp4"]);
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------ R5: YouTube download failure -- */

/**
 * R5: yt-dlp refused QzTkVaC-da4 (429, then "Sign in to confirm you're not a bot").
 * The standalone must classify that, retry only a plain 429 (once, visibly), pass
 * browser cookies only when configured, and show ONE translated error with the raw
 * yt-dlp output behind "details" - never the raw text as the headline.
 */
const R5_BOT = [
  "WARNING: [youtube] QzTkVaC-da4: Unable to download API page: HTTP Error 429: Too Many Requests",
  "WARNING: [youtube] QzTkVaC-da4: Unable to fetch GVS PO Token for web client: Missing required Visitor Data.",
  "ERROR: [youtube] QzTkVaC-da4: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
].join("\n");
const R5_429 = "ERROR: [youtube] QzTkVaC-da4: Unable to download webpage: HTTP Error 429: Too Many Requests";
const r5Source = { platform: "youtube", sourceId: "QzTkVaC-da4", legacyId: "QzTkVaC-da4", canonicalUrl: "https://www.youtube.com/watch?v=QzTkVaC-da4" };

/** A runTool that plays back scripted yt-dlp outcomes and records every argument list. */
function r5Tool(script) {
  const calls = [];
  return {
    calls,
    runTool: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const next = script.shift() ?? "ok";
      if (next !== "ok") throw new Error(`${cmd} zakonczyl sie kodem 1: ${next}`);
      if (args.includes("-J")) return { stdout: JSON.stringify({ title: "T", duration: 12, extractor_key: "Youtube" }), stderr: "" };
      fs.writeFileSync(args[args.indexOf("-o") + 1], "mp4");
      return { stdout: "", stderr: "" };
    },
  };
}

test("R5 standalone: no cookie flag by default; the configured one reaches every yt-dlp call", async () => {
  const plain = r5Tool(["ok", "ok"]);
  await createStandaloneMediaTool({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "omni-r5-")), runTool: plain.runTool }).fetch(r5Source);
  assert.equal(plain.calls.length, 2);
  for (const call of plain.calls) assert.ok(!call.some((arg) => arg.startsWith("--cookies")), call.join(" "));

  const withCookies = r5Tool(["ok", "ok"]);
  await createStandaloneMediaTool({
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "omni-r5-")),
    runTool: withCookies.runTool,
    env: { OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER: "firefox" },
  }).fetch(r5Source);
  for (const call of withCookies.calls) assert.deepEqual(call.slice(0, 3), ["yt-dlp", "--cookies-from-browser", "firefox"]);

  // `.env` next to the launchers is where a standalone user sets it.
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-r5-env-"));
  fs.writeFileSync(path.join(appRoot, ".env"), "OMNIWATCH_YTDLP_COOKIES=/tmp/cookies.txt\n");
  const config = loadStandaloneConfig({ appRoot, env: {} });
  assert.equal(config.effectiveEnv.OMNIWATCH_YTDLP_COOKIES, "/tmp/cookies.txt");
});

test("R5 standalone: a 429 waits once and retries; a bot check fails at once, classified", async () => {
  const limited = r5Tool([R5_429, "ok", "ok"]);
  const waits = [];
  const sleeps = [];
  await createStandaloneMediaTool({
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "omni-r5-")),
    runTool: limited.runTool,
    sleep: async (ms) => { sleeps.push(ms); },
  }).fetch(r5Source, { onWait: (wait) => waits.push(wait) });
  assert.equal(limited.calls.length, 3, "metadata 429, metadata retry, download");
  assert.deepEqual(waits, [{ reason: "rate_limited_by_youtube", seconds: 30, attempt: 1 }]);
  assert.deepEqual(sleeps, [30_000]);

  const blocked = r5Tool([R5_BOT, "ok"]);
  await assert.rejects(
    createStandaloneMediaTool({
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "omni-r5-")),
      runTool: blocked.runTool,
      sleep: async () => assert.fail("a bot check must not wait"),
    }).fetch(r5Source),
    (error) => error.errorClass === "source_unavailable" && /nie jestem botem/.test(error.message),
  );
  assert.equal(blocked.calls.length, 1);
});

test("R5 standalone live: the SSE error names the reason, confirms no model call and keeps the raw text as detail", async (t) => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-r5-sse-"));
  const dataDir = path.join(appRoot, "data");
  fs.mkdirSync(path.join(appRoot, "static"), { recursive: true });
  for (const name of ["index.html", "i18n.json"]) {
    fs.copyFileSync(path.join(repo, "apps/standalone/static", name), path.join(appRoot, "static", name));
  }
  const tool = r5Tool([R5_BOT]);
  const media = createStandaloneMediaTool({ cacheDir: path.join(dataDir, "cache"), runTool: tool.runTool });
  const app = createStandaloneServer({
    appRoot,
    dataDir,
    env: { OMNIWATCH_DATA_DIR: dataDir, DASHSCOPE_API_KEY: "sk-test-not-used" },
    media,
    model: { modelName: "stub", call: async () => assert.fail("the model must never be called for a failed download") },
    port: 0,
  });
  const address = await listenOrSkip(t, app);
  if (!address) return;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/watch?url=${encodeURIComponent(r5Source.canonicalUrl)}&lang=pl&mode=summary`);
    const frames = (await response.text()).split("\n\n").map((chunk) => chunk.trim());
    const stages = frames.filter((frame) => frame.startsWith("event: stage"));
    assert.deepEqual(stages.map((frame) => JSON.parse(frame.split("data: ")[1]).step), ["download"],
      "only the download stage was reached - no upload/watch/answer before the failure");
    const error = frames.find((frame) => frame.startsWith("event: error"));
    const payload = JSON.parse(error.split("\n").find((line) => line.startsWith("data: ")).slice(6));
    assert.equal(payload.error, "source_unavailable");
    assert.equal(payload.sourceFailure.reason, "bot_check");
    assert.equal(payload.noModelCalls, true);
    assert.doesNotMatch(payload.message, /Sign in to confirm/, "the headline is not yt-dlp's text");
    assert.match(payload.sourceFailure.detail, /Sign in to confirm you're not a bot/);
    assert.equal(tool.calls.length, 1, "no retry for a bot check");
  } finally {
    await app.close();
  }
});

test("R5 standalone page: a real wait counts down; a failure is one translated error with raw text under details", async () => {
  const i18n = JSON.parse(pageI18n);
  for (const lang of Object.keys(i18n)) {
    for (const key of ["sourceError_bot_check", "sourceError_rate_limited_by_youtube", "sourceErrorNoCost", "errorDetails", "sourceWaitRetry"]) {
      assert.ok(i18n[lang].ui[key], `${lang}.ui.${key}`);
    }
  }
  const { dom, bodyClasses, sources, submit } = runPage();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  submit();
  const es = sources[sources.length - 1];
  const slot = dom.elements.get(".retry-action");
  es.emit("stage", { step: "download" });
  es.emit("source_wait", { reason: "rate_limited_by_youtube", seconds: 30 });
  assert.equal(slot.textContent, i18n.pl.ui.sourceWaitRetry.replace("{n}", "30"), "YouTube ogranicza — ponawiam za 30 s");

  es.emit("error", {
    error: "source_unavailable",
    message: "YouTube zablokowal pobieranie z tego komputera (weryfikacja \"nie jestem botem\").",
    noModelCalls: true,
    sourceFailure: { reason: "bot_check", retryable: false, detail: `${R5_BOT} <raw>` },
  });
  const html = slot.innerHTML;
  const headline = /<div class="err" role="alert">([^<]*)<\/div>/.exec(html)?.[1] ?? "";
  assert.match(headline, /YouTube zablokował pobieranie z tego komputera/);
  assert.match(headline, /Nic nie zostało wysłane do modelu i nic nie kosztowało\./);
  assert.doesNotMatch(headline, /Sign in to confirm/, "the raw yt-dlp text is not the headline");
  assert.match(html, /<details class="err-detail"><summary>szczegóły<\/summary><pre>[^<]*Sign in to confirm you're not a bot[^<]*&lt;raw><\/pre><\/details>/);
  assert.equal(es.closed, true);
  assert.equal(bodyClasses.has("failed"), true, "failed hides the steps (body.failed .steps{display:none})");
  assert.equal(bodyClasses.has("running"), false);
  assert.match(pageHtml, /body\.failed \.steps,body\.done \.steps\{display:none\}/);
});
