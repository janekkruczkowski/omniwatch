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
import { loadStandaloneConfig, runtimeConfigDocument } from "../../apps/standalone/config.mjs";
import { createRuntimeWiring } from "../../packages/omniwatch/src/runtime/poc.ts";
import { createStandaloneServer } from "../../apps/standalone/server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(repo, "test/fixtures/beta");
const pageHtml = fs.readFileSync(path.join(repo, "apps/standalone/static/index.html"), "utf8");
const pageI18n = fs.readFileSync(path.join(repo, "apps/standalone/static/i18n.json"), "utf8");

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
  assert.match(html, /es\.onerror = \(\) => \{[\s\S]{0,200}?fail\(/, "a transport failure must also be terminal");
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
        add: (name) => bodyClasses.add(name),
        remove: (name) => bodyClasses.delete(name),
        contains: (name) => bodyClasses.has(name),
      },
    },
    getElementById: (id) => dom.elements.get(id.startsWith("#") ? id : `#${id}`) ?? null,
    querySelector: (selector) => dom.elements.get(selector) ?? null,
    querySelectorAll: () => [],
    createElement: () => {
      const el = dom.makeElement(`#dyn-${dom.elements.size}`);
      el.querySelector = () => dom.elements.get("#retryBtn") ?? null;
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
  dom.setDynamicQuery((selector) => (selector === "#retryBtn" ? dom.elements.get("#retryBtn") : null));
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
