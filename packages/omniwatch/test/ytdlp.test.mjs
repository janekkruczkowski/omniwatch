// R5: a YouTube download failure is classified, retried once only when that can help,
// and never reaches the model. Offline: yt-dlp is a stub `run`, nothing is spawned.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_YTDLP_RETRY_SECONDS,
  SOURCE_DETAIL_MARKER,
  classifyYtDlpFailure,
  createYtDlpRetryBudget,
  describeSourceFailure,
  runYtDlpResilient,
  sourceFailureError,
  ytDlpCookieArgs,
  ytDlpRetrySeconds,
} from "../src/sources/ytdlp.ts";
import { createSourceRegistry } from "../src/sources/registry.ts";
import { parseSourceUrl } from "../src/sources/url.ts";

/** The live failure the user hit on QzTkVaC-da4 (stderr as the host `run` reports it). */
export const LIVE_BOT_CHECK = [
  "yt-dlp failed:",
  "WARNING: [youtube] QzTkVaC-da4: Unable to download API page: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)",
  "WARNING: [youtube] QzTkVaC-da4: Unable to fetch GVS PO Token for web client: Missing required Visitor Data. You may need to pass Visitor Data with --extractor-args \"youtube:visitor_data=XXX\"",
  "ERROR: [youtube] QzTkVaC-da4: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies. Also see  https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies  for tips on effectively exporting YouTube cookies",
].join("\n");

const PLAIN_429 = "yt-dlp failed:\nERROR: [youtube] QzTkVaC-da4: Unable to download webpage: HTTP Error 429: Too Many Requests";

const failWith = (text) => Object.assign(new Error(text), {});

test("classification: the live QzTkVaC-da4 output is a bot check, even though a 429 came first", () => {
  assert.deepEqual(classifyYtDlpFailure(LIVE_BOT_CHECK), { reason: "bot_check", retryable: false });
});

test("classification: every reason the card explains", () => {
  const cases = [
    [PLAIN_429, "rate_limited_by_youtube", true],
    ["ERROR: [TikTok] 7300000000000000000: HTTP Error 429: Too Many Requests", "rate_limited", true],
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video", "private", false],
    ["ERROR: [youtube] abc: Join this channel to get access to members-only content like this video", "private", false],
    ["ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.", "private", false],
    ["ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "unavailable", false],
    ["ERROR: [youtube] abc: Video unavailable. The uploader has not made this video available in your country", "geo_blocked", false],
    ["ERROR: [generic] Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known>", "network", false],
    ["yt-dlp timed out", "network", false],
    ["ERROR: something nobody has seen before", "unknown", false],
  ];
  for (const [text, reason, retryable] of cases) {
    assert.deepEqual(classifyYtDlpFailure(text), { reason, retryable }, text);
  }
});

test("the thrown error is source_unavailable, friendly first, raw yt-dlp output behind the marker", () => {
  const error = sourceFailureError(LIVE_BOT_CHECK);
  assert.equal(error.errorClass, "source_unavailable");
  const [friendly, raw] = error.message.split(SOURCE_DETAIL_MARKER);
  assert.match(friendly, /weryfikacja "nie jestem botem"/);
  assert.match(friendly, /Nic nie zostalo wyslane do modelu i nic nie kosztowalo/);
  assert.doesNotMatch(friendly, /Sign in to confirm/, "the raw text is not the headline");
  assert.match(raw, /Sign in to confirm you're not a bot/);
  assert.doesNotMatch(raw, /^yt-dlp failed:/, "the host prefix is dropped from the details");

  const view = describeSourceFailure(error.errorClass, error.message);
  assert.equal(view.reason, "bot_check");
  assert.equal(view.retryable, false);
  assert.equal(view.message, friendly.trim());
  assert.match(view.detail, /HTTP Error 429/);
});

test("an operation stored before R5 (raw message only) is still explained", () => {
  const view = describeSourceFailure("source_unavailable", PLAIN_429);
  assert.equal(view.reason, "rate_limited_by_youtube");
  assert.match(view.message, /HTTP 429/);
  assert.match(view.detail, /Too Many Requests/);
  assert.equal(describeSourceFailure("outcome_unknown", PLAIN_429), null, "only source failures are described");
});

test("retry: a plain 429 waits once (visibly) and then succeeds", async () => {
  const calls = [];
  const waits = [];
  const sleeps = [];
  const result = await runYtDlpResilient(["-J", "url"], {
    run: async (args) => {
      calls.push(args);
      if (calls.length === 1) throw failWith(PLAIN_429);
      return "{\"title\":\"ok\"}";
    },
    retrySeconds: 25,
    onWait: (wait) => waits.push(wait),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result, "{\"title\":\"ok\"}");
  assert.equal(calls.length, 2, "exactly one retry");
  assert.deepEqual(waits, [{ reason: "rate_limited_by_youtube", seconds: 25, attempt: 1 }]);
  assert.deepEqual(sleeps, [25_000]);
});

test("retry: a second 429 is not retried again - it fails, classified", async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    runYtDlpResilient(["-J", "url"], {
      run: async () => { calls += 1; throw failWith(PLAIN_429); },
      sleep: async (ms) => { sleeps.push(ms); },
    }),
    (error) => error.errorClass === "source_unavailable" && describeSourceFailure(error.errorClass, error.message).reason === "rate_limited_by_youtube",
  );
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [DEFAULT_YTDLP_RETRY_SECONDS * 1000]);
});

test("retry: a bot check is never retried and never waits", async () => {
  let calls = 0;
  let waited = false;
  await assert.rejects(
    runYtDlpResilient(["-J", "url"], {
      run: async () => { calls += 1; throw failWith(LIVE_BOT_CHECK); },
      onWait: () => { waited = true; },
      sleep: async () => { waited = true; },
    }),
    (error) => error.errorClass === "source_unavailable",
  );
  assert.equal(calls, 1);
  assert.equal(waited, false);
});

test("retry: one budget per fetch - metadata and download never retry twice in total", async () => {
  const budget = createYtDlpRetryBudget(1);
  let sleeps = 0;
  const options = (fails) => ({
    run: async () => { if (fails.n-- > 0) throw failWith(PLAIN_429); return "ok"; },
    budget,
    sleep: async () => { sleeps += 1; },
  });
  assert.equal(await runYtDlpResilient(["-J"], options({ n: 1 })), "ok");
  await assert.rejects(runYtDlpResilient(["-o", "x"], options({ n: 1 })), /HTTP 429/);
  assert.equal(sleeps, 1);
});

test("cookies: off by default, plumbed only when configured", () => {
  assert.deepEqual(ytDlpCookieArgs({}), []);
  assert.deepEqual(ytDlpCookieArgs({ OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER: "" }), []);
  assert.deepEqual(ytDlpCookieArgs({ OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER: "chrome" }), ["--cookies-from-browser", "chrome"]);
  assert.deepEqual(
    ytDlpCookieArgs({ OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER: "firefox:default-release" }),
    ["--cookies-from-browser", "firefox:default-release"],
  );
  assert.deepEqual(
    ytDlpCookieArgs({ OMNIWATCH_YTDLP_COOKIES: "/tmp/cookies.txt", OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER: "chrome" }),
    ["--cookies", "/tmp/cookies.txt"],
    "the cookies file (narrower permission) wins",
  );
  assert.deepEqual(ytDlpCookieArgs({ OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER: "--exec rm" }), [], "no flag injection");
  assert.deepEqual(ytDlpCookieArgs({ OMNIWATCH_YTDLP_COOKIES: "--exec" }), []);
});

test("retry seconds: env override, clamped", () => {
  assert.equal(ytDlpRetrySeconds({}), DEFAULT_YTDLP_RETRY_SECONDS);
  assert.equal(ytDlpRetrySeconds({ OMNIWATCH_YTDLP_RETRY_SECONDS: "0" }), 0);
  assert.equal(ytDlpRetrySeconds({ OMNIWATCH_YTDLP_RETRY_SECONDS: "999" }), 120);
  assert.equal(ytDlpRetrySeconds({ OMNIWATCH_YTDLP_RETRY_SECONDS: "abc" }), DEFAULT_YTDLP_RETRY_SECONDS);
});

test("the registry hands prepare()'s onWait to the media tool and keeps the classified error", async () => {
  let seen = null;
  const registry = createSourceRegistry({
    media: {
      cached: async () => null,
      fetch: async (_source, options) => {
        seen = options;
        options?.onWait?.({ reason: "rate_limited_by_youtube", seconds: 30, attempt: 1 });
        throw sourceFailureError(LIVE_BOT_CHECK);
      },
      slice: async () => { throw new Error("not used"); },
    },
  });
  const waits = [];
  await assert.rejects(
    registry.prepare(parseSourceUrl("https://youtu.be/QzTkVaC-da4"), { onWait: (wait) => waits.push(wait) }),
    (error) => error.errorClass === "source_unavailable" && describeSourceFailure(error.errorClass, error.message).reason === "bot_check",
  );
  assert.equal(typeof seen?.onWait, "function");
  assert.equal(waits.length, 1);
});
