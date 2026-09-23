/**
 * T06: provider transport + the engine's attempt/usage contract.
 *
 * Every test uses a stub fetch, a stub ModelPort or a loopback HTTP/SSE stub. No external
 * network, no API key, no ffmpeg.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { ANALYSIS_VERSION, OmniWatchError, computeAnalysisKey } from "../src/contracts/index.ts";
import { analyze } from "../src/analysis/engine.ts";
import { chatCompletionsUrl, createOpenAiModelPort } from "../src/analysis/provider-openai.ts";
import { capabilitiesFor, parseSourceUrl } from "../src/sources/index.ts";

const encoder = new TextEncoder();

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(chunks, init = {}) {
  return new Response(streamOf(chunks), {
    status: init.status ?? 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function dataLine(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const OK_CHUNKS = [
  dataLine({ choices: [{ delta: { content: "## Answer\n" } }] }),
  dataLine({ choices: [{ delta: { content: "[0:03] Synthetic screen: 7." } }] }),
  dataLine({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
  "data: [DONE]\n\n",
];

const UNTERMINATED_CHUNKS = [
  dataLine({ choices: [{ delta: { content: "## Answer\npartial" } }] }),
  dataLine({ choices: [{ delta: { content: " answer" } }] }),
];

function makeConfig(overrides = {}) {
  return {
    dataDir: "/tmp/omniwatch",
    memoryRoot: "/tmp/omniwatch/memory",
    language: "pl",
    modelName: overrides.modelName ?? "fixture-omni",
    apiKey: () => (overrides.apiKey === undefined ? "test-key-not-a-secret" : overrides.apiKey),
    apiBaseUrl: () => (overrides.apiBaseUrl === undefined ? "https://provider.example.invalid/v1" : overrides.apiBaseUrl),
    maxFramesPerPart: () => overrides.maxFramesPerPart ?? 2400,
    cacheHours: () => overrides.cacheHours ?? 48,
  };
}

function makeClock() {
  return {
    now: () => new Date("2026-01-01T12:00:00.000Z"),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

function makeLogger() {
  const lines = [];
  const push = (level) => (message, fields) => lines.push({ level, message, fields });
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

function makeSink() {
  const phases = [];
  const attempts = [];
  return {
    phases,
    attempts,
    async intent(record) { phases.push("intent"); attempts.push({ ...record, phase: "intent" }); },
    async started() { phases.push("started"); },
    async response() { phases.push("response"); },
    async unknown() { phases.push("unknown"); },
    async failed() { phases.push("failed"); },
  };
}

function makeProvider(options = {}) {
  const fetches = [];
  const port = createOpenAiModelPort({
    config: options.config ?? makeConfig(options.configOverrides ?? {}),
    fetchImpl: async (url, init) => {
      fetches.push({ url, init, body: JSON.parse(init.body) });
      if (options.fetchError) throw options.fetchError;
      return options.respond
        ? await options.respond(url, init, fetches.length)
        : sseResponse(OK_CHUNKS);
    },
    timeoutMs: 0,
    idleTimeoutMs: 0,
    resolveMediaUrl: options.resolveMediaUrl,
    costForUsage: options.costForUsage,
  });
  return { port, fetches };
}

function modelRequest(overrides = {}) {
  return {
    operationId: "op-1",
    attemptId: "att-1",
    partIndex: 0,
    messages: [{ role: "system", text: "system" }, { role: "user", text: "user" }],
    mediaParts: [],
    language: "pl",
    ...overrides,
  };
}

/* -------------------------------------------------------------- provider ---- */

test("provider sends one request per call and maps a completed stream", async () => {
  const { port, fetches } = makeProvider();
  const sink = makeSink();
  const response = await port.call(modelRequest(), sink);

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "https://provider.example.invalid/v1/chat/completions");
  assert.equal(fetches[0].init.headers.Authorization, "Bearer test-key-not-a-secret");
  assert.equal(fetches[0].body.stream, true);
  assert.equal(fetches[0].body.model, "fixture-omni");
  assert.equal(response.completed, true);
  assert.equal(response.text, "## Answer\n[0:03] Synthetic screen: 7.");
  assert.equal(response.usage.inputTokens, 1000);
  assert.equal(response.usage.outputTokens, 200);
  // No cost reported by the provider and no host pricing: unknown, never zero.
  assert.equal(response.usage.costUsd, null);
  assert.equal(response.usage.costKnown, false);
  // The transport itself does not write attempt records; the engine owns those.
  assert.deepEqual(sink.phases, []);
});

test("provider maps host pricing to a known cost", async () => {
  const { port } = makeProvider({ costForUsage: () => 0.0002 });
  const response = await port.call(modelRequest(), makeSink());
  assert.equal(response.usage.costKnown, true);
  assert.equal(response.usage.costUsd, 0.0002);
});

test("Qwen3.8 Omni requests low reasoning effort to avoid a long pre-header wait", async () => {
  const qwen = makeProvider({ configOverrides: { modelName: "qwen3.8-omni-flash" } });
  await qwen.port.call(modelRequest(), makeSink());
  assert.equal(qwen.fetches[0].body.reasoning_effort, "low");
  const other = makeProvider();
  await other.port.call(modelRequest(), makeSink());
  assert.equal("reasoning_effort" in other.fetches[0].body, false);
});

test("provider classifies 4xx, 429 and 5xx without retrying", async () => {
  const cases = [
    { status: 400, expected: "provider_rejected" },
    { status: 404, expected: "provider_rejected" },
    { status: 429, expected: "rate_limited" },
    { status: 500, expected: "outcome_unknown" },
    { status: 503, expected: "outcome_unknown" },
  ];
  for (const item of cases) {
    const { port, fetches } = makeProvider({ respond: async () => new Response("provider said no", { status: item.status }) });
    await assert.rejects(
      () => port.call(modelRequest(), makeSink()),
      (error) => error instanceof OmniWatchError && error.errorClass === item.expected,
      `status ${item.status} should be ${item.expected}`,
    );
    assert.equal(fetches.length, 1, `status ${item.status} must issue exactly one request`);
  }
});

test("a reset after send is an unknown outcome, a provably unsent request is not", async () => {
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const resetProvider = makeProvider({ fetchError: reset });
  await assert.rejects(
    () => resetProvider.port.call(modelRequest(), makeSink()),
    (error) => error.errorClass === "outcome_unknown" &&
      /phase=headers code=ECONNRESET name=TypeError abort=none elapsed_ms=\d+/.test(error.message),
  );
  assert.equal(resetProvider.fetches.length, 1);

  const secret = "https://oss.example.invalid/private?signature=secret";
  const hidden = makeProvider({ fetchError: Object.assign(new TypeError(secret), { cause: { code: "ECONNRESET", message: secret } }) });
  await assert.rejects(() => hidden.port.call(modelRequest(), makeSink()), (error) =>
    error.errorClass === "outcome_unknown" && !error.message.includes(secret),
  );

  const unsent = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  const unsentProvider = makeProvider({ fetchError: unsent });
  await assert.rejects(
    () => unsentProvider.port.call(modelRequest(), makeSink()),
    (error) => error.errorClass === "provider_rejected",
  );
  assert.equal(unsentProvider.fetches.length, 1);
});

test("an unterminated stream is not a success; partial text is preserved", async () => {
  const { port, fetches } = makeProvider({ respond: async () => sseResponse(UNTERMINATED_CHUNKS) });
  const response = await port.call(modelRequest(), makeSink());
  assert.equal(fetches.length, 1);
  assert.equal(response.completed, false);
  assert.equal(response.text, "## Answer\npartial answer");
  assert.match(response.failureDetail, /phase=stream code=EOF data_events=2 marker=missing/);
});

test("a finish_reason is a valid protocol end", async () => {
  const chunks = [
    dataLine({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
  ];
  const { port } = makeProvider({ respond: async () => sseResponse(chunks) });
  const response = await port.call(modelRequest(), makeSink());
  assert.equal(response.completed, true);
  assert.equal(response.text, "done");
});

test("provider accepts a final SSE marker or finish_reason without a trailing newline", async () => {
  const lastMarker = makeProvider({ respond: async () => sseResponse([
    dataLine({ choices: [{ delta: { content: "saved text" } }] }),
    "data: [DONE]",
  ]) });
  const marked = await lastMarker.port.call(modelRequest(), makeSink());
  assert.equal(marked.completed, true);
  assert.equal(marked.text, "saved text");

  const lastFinish = makeProvider({ respond: async () => sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "final" }, finish_reason: "stop" }] })}`,
  ]) });
  const finished = await lastFinish.port.call(modelRequest(), makeSink());
  assert.equal(finished.completed, true);
  assert.equal(finished.text, "final");
});

test("missing usage is reported as unknown cost, not as zero", async () => {
  const chunks = [dataLine({ choices: [{ delta: { content: "no usage here" } }] }), "data: [DONE]\n\n"];
  const { port } = makeProvider({ respond: async () => sseResponse(chunks) });
  const response = await port.call(modelRequest(), makeSink());
  assert.equal(response.completed, true);
  assert.equal(response.usage.inputTokens, null);
  assert.equal(response.usage.outputTokens, null);
  assert.equal(response.usage.costUsd, null);
  assert.equal(response.usage.costKnown, false);
});

test("missing configuration fails in preflight and before any request", async () => {
  const { port, fetches } = makeProvider({ configOverrides: { apiKey: null } });
  assert.throws(() => port.preflight(), (error) => error.errorClass === "missing_config");
  await assert.rejects(
    () => port.call(modelRequest(), makeSink()),
    (error) => error.errorClass === "missing_config",
  );
  assert.equal(fetches.length, 0);

  const noBase = makeProvider({ configOverrides: { apiBaseUrl: null } });
  assert.throws(() => noBase.port.preflight(), (error) => error.errorClass === "missing_config");
});

test("media parts without a resolver fail loudly instead of silently analysing text only", async () => {
  const { port, fetches } = makeProvider({ configOverrides: {} });
  await assert.rejects(
    () =>
      port.call(
        modelRequest({ mediaParts: [{ index: 0, startSeconds: 0, endSeconds: 16, localPath: "/tmp/part0.mp4" }] }),
        makeSink(),
      ),
    (error) => error.errorClass === "missing_config",
  );
  assert.equal(fetches.length, 0);
});

test("media parts are sent as video_url when the host maps them, and endpoint shapes are normalised", async () => {
  const { port, fetches } = makeProvider({ resolveMediaUrl: async (part) => `oss://fixture/part${part.index}.mp4` });
  await port.call(
    modelRequest({ mediaParts: [{ index: 0, startSeconds: 0, endSeconds: 16, localPath: "/tmp/part0.mp4" }] }),
    makeSink(),
  );
  const content = fetches[0].body.messages.find((message) => Array.isArray(message.content)).content;
  assert.equal(fetches[0].body.messages[0].role, "system");
  const system = fetches[0].body.messages.find((message) => message.role === "system");
  assert.equal(system.content, "system", "the system message keeps its role and text");
  assert.equal(content[0].type, "video_url");
  assert.equal(content[0].video_url.url, "oss://fixture/part0.mp4");
  assert.equal(content[1].type, "text");

  assert.equal(chatCompletionsUrl("https://provider.example.invalid"), "https://provider.example.invalid/v1/chat/completions");
  assert.equal(
    chatCompletionsUrl("https://dashscope.example/compatible-mode/v1"),
    "https://dashscope.example/compatible-mode/v1/chat/completions",
  );
  assert.equal(
    chatCompletionsUrl("https://provider.example.invalid/v1/chat/completions"),
    "https://provider.example.invalid/v1/chat/completions",
  );
});

/* ---------------------------------------------------------------- engine ---- */

function makeSourceStub(options = {}) {
  const sourceRef = parseSourceUrl(options.url ?? "https://example.test/video/alpha");
  const parts = options.parts ?? [
    { index: 0, startSeconds: 0, endSeconds: 16, localPath: "/tmp/omniwatch/part0.mp4" },
  ];
  const calls = { prepare: 0, split: 0 };
  const source = {
    calls,
    capabilities: () => capabilitiesFor(sourceRef.platform),
    async resolve() { return sourceRef; },
    async prepare() {
      calls.prepare += 1;
      return {
        sourceRef,
        title: options.title ?? "Fixture",
        channel: "Fixture Channel",
        durationSeconds: options.durationSeconds ?? 16,
        extractor: "Generic",
        localPath: parts[0].localPath,
        uploadedUrl: null,
        reusedUpload: false,
      };
    },
    async split() {
      calls.split += 1;
      return parts;
    },
  };
  return { source, sourceRef, parts, calls };
}

function makeModelStub(handler) {
  const state = { count: 0, requests: [], inFlight: 0, maxInFlight: 0 };
  const model = {
    modelName: "fixture-omni",
    state,
    async call(request, sink) {
      state.count += 1;
      state.requests.push(request);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        return await handler(request, sink);
      } finally {
        state.inFlight -= 1;
      }
    },
  };
  return model;
}

function engineDeps(model, sourceStub, overrides = {}) {
  const sink = overrides.sink ?? makeSink();
  const events = [];
  const deps = {
    clock: makeClock(),
    logger: makeLogger(),
    config: makeConfig(overrides.configOverrides ?? {}),
    source: sourceStub.source,
    model,
    attempts: sink,
    progress: (event) => events.push(event),
  };
  if (overrides.turns) deps.turns = overrides.turns;
  if (overrides.operationId) deps.operationId = overrides.operationId;
  if (overrides.conversationBudgetTokens) deps.conversationBudgetTokens = overrides.conversationBudgetTokens;
  return { deps, sink, events };
}

function requestFor(sourceRef, overrides = {}) {
  return {
    sourceRef,
    mode: "summary",
    focus: null,
    question: null,
    language: "pl",
    analysisVersion: ANALYSIS_VERSION,
    ...overrides,
  };
}

const COMPLETE_USAGE = { inputTokens: 1200, outputTokens: 300, costUsd: 0.0004, costKnown: true };

test("engine: one call, intent before the call, monotonic progress, aggregated usage", async () => {
  const sourceStub = makeSourceStub();
  const model = makeModelStub(async () => ({
    text: "## In short\n7. [0:03] screen",
    usage: COMPLETE_USAGE,
    completed: true,
  }));
  const { deps, sink, events } = engineDeps(model, sourceStub);

  const result = await analyze(requestFor(sourceStub.sourceRef), deps);

  assert.equal(model.state.count, 1);
  assert.deepEqual(sink.phases, ["intent", "started", "response"]);
  assert.equal(result.content, "## In short\n7. [0:03] screen");
  assert.equal(result.parts, 1);
  assert.equal(result.incomplete, undefined);
  assert.equal(result.errorClass, null);
  assert.equal(result.usage.costKnown, true);
  assert.equal(result.usage.costUsd, 0.0004);
  assert.equal(result.usage.inputTokens, 1200);
  assert.deepEqual(result.highlights.map((highlight) => highlight.label), ["0:03"]);
  assert.equal(result.analysisKey, computeAnalysisKey(requestFor(sourceStub.sourceRef), "ctx_none"));
  assert.equal(result.analysisId, `omni_${result.analysisKey.slice(0, 16)}`);
  assert.equal(sourceStub.calls.prepare, 1);
  assert.equal(sourceStub.calls.split, 1);

  const versions = events.map((event) => event.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(events[events.length - 1].state, "result_ready");
  assert.equal(events[events.length - 1].usage.costKnown, true);
});

test("engine: an unknown outcome is not retried and keeps the partial text", async () => {
  const sourceStub = makeSourceStub();
  const model = makeModelStub(async () => {
    throw new OmniWatchError("outcome_unknown", "timeout po wyslaniu", {});
  });
  const { deps, sink, events } = engineDeps(model, sourceStub);

  const result = await analyze(requestFor(sourceStub.sourceRef), deps);

  assert.equal(model.state.count, 1, "a paid call with an unknown outcome must not be retried");
  assert.deepEqual(sink.phases, ["intent", "started", "unknown"]);
  assert.equal(result.incomplete, true);
  assert.equal(result.errorClass, "outcome_unknown");
  assert.match(result.content, /Analiza niekompletna/);
  assert.equal(result.usage.costKnown, false);
  assert.equal(result.usage.costUsd, null);
  assert.equal(events[events.length - 1].state, "outcome_unknown");
  assert.equal(events[events.length - 1].errorClass, "outcome_unknown");
  assert.equal(events[events.length - 1].usage.costKnown, false);
  assert.match(events[events.length - 1].partialText, /Analiza niekompletna/);
});

test("engine: an unterminated stream is incomplete, keeps the text and is not retried", async () => {
  const sourceStub = makeSourceStub();
  const model = makeModelStub(async () => ({
    text: "## In short\npartial answer",
    usage: { inputTokens: 10, outputTokens: 0, costUsd: null, costKnown: false },
    completed: false,
  }));
  const { deps, sink } = engineDeps(model, sourceStub);

  const result = await analyze(requestFor(sourceStub.sourceRef), deps);

  assert.equal(model.state.count, 1);
  assert.deepEqual(sink.phases, ["intent", "started", "unknown"]);
  assert.equal(result.incomplete, true);
  assert.equal(result.errorClass, "outcome_unknown");
  assert.match(result.content, /partial answer/);
  assert.match(result.content, /Analiza niekompletna/);
});

test("engine: a rejected or rate limited call fails without a retry", async () => {
  for (const errorClass of ["provider_rejected", "rate_limited"]) {
    const sourceStub = makeSourceStub();
    const model = makeModelStub(async () => {
      throw new OmniWatchError(errorClass, `${errorClass} from stub`, {});
    });
    const { deps, sink } = engineDeps(model, sourceStub);

    await assert.rejects(
      () => analyze(requestFor(sourceStub.sourceRef), deps),
      (error) => error.errorClass === errorClass,
    );
    assert.equal(model.state.count, 1, `${errorClass} must not be retried`);
    assert.deepEqual(sink.phases, ["intent", "started", "failed"]);
  }
});

test("engine: parts are analysed one at a time, then merged", async () => {
  const parts = [
    { index: 0, startSeconds: 0, endSeconds: 800.67, localPath: "/tmp/part0.mp4" },
    { index: 1, startSeconds: 800.67, endSeconds: 1601.33, localPath: "/tmp/part1.mp4" },
    { index: 2, startSeconds: 1601.33, endSeconds: 2402, localPath: "/tmp/part2.mp4" },
  ];
  const sourceStub = makeSourceStub({ parts, durationSeconds: 2402 });
  const model = makeModelStub(async (request) => ({
    text: request.mediaParts.length ? `notes for part ${request.partIndex} [0:05]` : "## In short\nmerged",
    usage: COMPLETE_USAGE,
    completed: true,
  }));
  const { deps, events } = engineDeps(model, sourceStub);

  const result = await analyze(requestFor(sourceStub.sourceRef), deps);

  assert.equal(model.state.count, 4, "three part calls plus one merge call");
  assert.deepEqual(model.state.requests.map((request) => request.partIndex), [0, 1, 2, 3]);
  assert.equal(model.state.maxInFlight, 1, "D11: one model call at a time");
  assert.deepEqual(model.state.requests.map((request) => request.mediaParts.length), [1, 1, 1, 0]);
  assert.equal(result.parts, 3);
  assert.equal(result.content, "## In short\nmerged");
  assert.ok(events.some((event) => event.stage === "merge"));

  const mergePrompt = model.state.requests[3].messages.map((message) => message.text).join("\n");
  assert.match(mergePrompt, /notes for part 0/);
  assert.match(mergePrompt, /notes for part 2/);
  // Part notes are rewritten into full-video time before the merge.
  assert.match(mergePrompt, /\[13:25\]/);
});

test("engine: an unknown outcome on one part keeps the other parts' notes and skips the merge", async () => {
  const parts = [
    { index: 0, startSeconds: 0, endSeconds: 800.67, localPath: "/tmp/part0.mp4" },
    { index: 1, startSeconds: 800.67, endSeconds: 1601.33, localPath: "/tmp/part1.mp4" },
    { index: 2, startSeconds: 1601.33, endSeconds: 2402, localPath: "/tmp/part2.mp4" },
  ];
  const sourceStub = makeSourceStub({ parts, durationSeconds: 2402 });
  const model = makeModelStub(async (request) => {
    if (request.partIndex === 1) {
      throw new OmniWatchError("outcome_unknown", "stream reset", {});
    }
    return { text: `notes for part ${request.partIndex} [0:07]`, usage: COMPLETE_USAGE, completed: true };
  });
  const { deps } = engineDeps(model, sourceStub);

  const result = await analyze(requestFor(sourceStub.sourceRef), deps);

  // LF (2026-09-23): the other parts are still attempted - they are separate calls the
  // film needs anyway, and a confirmed retry then pays only for part 1 and the merge.
  assert.equal(model.state.count, 3, "every part attempted once, no merge after an unknown outcome");
  assert.equal(result.incomplete, true);
  assert.equal(result.errorClass, "outcome_unknown");
  assert.deepEqual(result.unknownParts, [1]);
  assert.match(result.content, /notes for part 0/);
  assert.match(result.content, /notes for part 2/);
  assert.match(result.content, /Analiza niekompletna/);
});

test("engine: a stub without usage records an unknown cost, never zero", async () => {
  const sourceStub = makeSourceStub();
  const model = makeModelStub(async () => ({ text: "answer", usage: { costKnown: false }, completed: true }));
  const { deps } = engineDeps(model, sourceStub);

  const result = await analyze(requestFor(sourceStub.sourceRef), deps);
  assert.equal(result.usage.costKnown, false);
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.usage.inputTokens, null);
  assert.notEqual(result.usage.costUsd, 0);
});

test("engine: missing config is visible before any media or model work", async () => {
  const sourceStub = makeSourceStub();
  const model = makeModelStub(async () => ({ text: "never", usage: { costKnown: false }, completed: true }));
  model.preflight = () => {
    throw new OmniWatchError("missing_config", "Brak klucza API.", {});
  };
  const { deps } = engineDeps(model, sourceStub);

  await assert.rejects(
    () => analyze(requestFor(sourceStub.sourceRef), deps),
    (error) => error.errorClass === "missing_config",
  );
  assert.equal(sourceStub.calls.prepare, 0);
  assert.equal(sourceStub.calls.split, 0);
  assert.equal(model.state.count, 0);
});

/*
 * QA 2026-09-23 ISSUE-010 transport: real sockets against a local HTTP/SSE stub, with
 * scaled-down timers (same code path as the 600 s / 120 s production defaults).
 */

async function sseStub(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    req.resume();
    handler(req, res);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`binding a local socket is not permitted here (${error.code})`);
      return null;
    }
    throw error;
  }
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { hits, base: `http://127.0.0.1:${server.address().port}/v1` };
}

const sseEvent = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

function stubPort(base, timing) {
  return createOpenAiModelPort({
    config: { modelName: "stub-sse", apiKey: () => "k", apiBaseUrl: () => base },
    ...timing,
  });
}

const PLAIN_REQUEST = { messages: [{ role: "user", text: "hi" }], mediaParts: [] };

test("a stream that keeps making progress is not cut by the start-up deadline", async (t) => {
  const stub = await sseStub(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const tick = setInterval(() => {
      n += 1;
      res.write(sseEvent({ choices: [{ delta: { content: "." } }] }));
      if (n === 12) {
        clearInterval(tick);
        res.end(sseEvent({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 12 } }));
      }
    }, 50);
  });
  if (!stub) return;
  // 12 x 50 ms = ~600 ms of active streaming, well past a 250 ms deadline.
  const result = await stubPort(stub.base, { timeoutMs: 250, idleTimeoutMs: 200 }).call(PLAIN_REQUEST, {});
  assert.equal(result.completed, true, result.failureDetail);
  assert.equal(result.text, "............");
  assert.equal(stub.hits.length, 1);
});

test("a stream that stalls after headers ends on the idle limit as an unknown outcome", async (t) => {
  const stub = await sseStub(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseEvent({ choices: [{ delta: { content: "czesc" } }] }));
    // ...and then silence, connection left open.
  });
  if (!stub) return;
  const result = await stubPort(stub.base, { timeoutMs: 0, idleTimeoutMs: 150 }).call(PLAIN_REQUEST, {});
  assert.equal(result.completed, false);
  assert.equal(result.text, "czesc", "partial text is kept");
  assert.match(result.failureDetail, /phase=stream .*abort=idle/);
  assert.equal(stub.hits.length, 1, "no retry inside the transport");
});

test("slow response headers still hit the start-up deadline", async (t) => {
  const stub = await sseStub(t, () => { /* never answers */ });
  if (!stub) return;
  await assert.rejects(
    () => stubPort(stub.base, { timeoutMs: 150, idleTimeoutMs: 0 }).call(PLAIN_REQUEST, {}),
    (error) => error.errorClass === "outcome_unknown" && /phase=headers .*abort=deadline/.test(error.message),
  );
  assert.equal(stub.hits.length, 1);
});

test("the provider closing the socket before headers is UND_ERR_SOCKET, unknown, sent once", async (t) => {
  // The live 60.5 s failure had exactly this signature (abort=none): the peer closed,
  // not one of our timers. Reproduced here after 100 ms instead of 60 s.
  const stub = await sseStub(t, (req) => setTimeout(() => req.socket.destroy(), 100));
  if (!stub) return;
  await assert.rejects(
    () => stubPort(stub.base, { timeoutMs: 5000, idleTimeoutMs: 5000 }).call(PLAIN_REQUEST, {}),
    (error) => error.errorClass === "outcome_unknown" && /phase=headers code=UND_ERR_SOCKET .*abort=none/.test(error.message),
  );
  assert.equal(stub.hits.length, 1, "an uncertain paid call is never retried blindly");
});

test("a peer that ends the stream without a marker is EOF marker=missing, not success", async (t) => {
  const stub = await sseStub(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 384; i += 1) res.write(sseEvent({ choices: [{ delta: { reasoning_content: "x" } }] }));
    res.end();
  });
  if (!stub) return;
  const result = await stubPort(stub.base, { timeoutMs: 5000, idleTimeoutMs: 5000 }).call(PLAIN_REQUEST, {});
  assert.equal(result.completed, false);
  assert.equal(result.failureDetail, "phase=stream code=EOF data_events=384 marker=missing");
});
