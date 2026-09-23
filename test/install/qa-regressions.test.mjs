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
import { partPlan } from "../../packages/omniwatch/src/sources/media.ts";
import { createStandaloneServer } from "../../apps/standalone/server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(repo, "test/fixtures/beta");
const pageHtml = fs.readFileSync(path.join(repo, "apps/standalone/static/index.html"), "utf8");
const pageI18n = fs.readFileSync(path.join(repo, "apps/standalone/static/i18n.json"), "utf8");

test("long Qwen3.8-Omni film uses short calls within the provider frame budget", () => {
  const config = loadStandaloneConfig({ appRoot: fs.mkdtempSync(path.join(os.tmpdir(), "omni-long-")), env: {} });
  assert.equal(config.maxFrames, 2400, "legacy setting remains visible");
  const effective = runtimeConfigDocument(config).maxFramesPerPart;
  assert.equal(effective, 480);
  const plan = partPlan(2061, { maxFramesPerPart: effective });
  assert.equal(plan.length, 9);
  assert.ok(plan.every((part) => part.endSeconds - part.startSeconds <= 240));
  assert.ok(plan.every((part) => (part.endSeconds - part.startSeconds) * 2 < 2048));
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
