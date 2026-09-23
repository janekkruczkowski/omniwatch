/**
 * T01/T05: source validation, beta compatibility, media maths and the injected registry.
 * Stubs only - no network, no ffmpeg, no API key, no Vault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { OmniWatchError, legacyHashId } from "../src/contracts/index.ts";
import {
  capabilitiesFor,
  createSourceRegistry,
  evaluateUploadFreshness,
  formatDuration,
  fpsFor,
  normalizeLegacyInfo,
  parseLegacyInfoJson,
  parseSourceUrl,
  partCountFor,
  partPlan,
  prepareMany,
  resolveLegacyId,
  shiftTimestamps,
  strip,
} from "../src/sources/index.ts";

const FIXTURE_LEGACY_ID = "ade4dd11a0580e69";
/** Frozen clock from docs/omniwatch/work-orders/BETA-FIXTURES.md. */
const NOW_SECONDS = 1800000000;

/* ------------------------------------------------------------------ url ---- */

test("YouTube aliases collapse to one stable source id", () => {
  const urls = [
    "https://www.youtube.com/watch?v=SYNTHETIC01",
    "https://www.youtube.com/shorts/SYNTHETIC01",
    "https://www.youtube.com/live/SYNTHETIC01",
    "https://www.youtube.com/embed/SYNTHETIC01?autoplay=1",
    "https://youtu.be/SYNTHETIC01?si=abc123",
    "https://m.youtube.com/watch?v=SYNTHETIC01&list=PLxyz#frag",
  ];
  for (const url of urls) {
    const ref = parseSourceUrl(url);
    assert.equal(ref.platform, "youtube", url);
    assert.equal(ref.sourceId, "SYNTHETIC01", url);
    assert.equal(ref.legacyId, "SYNTHETIC01", url);
  }
});

test("YouTube canonicalization keeps the meaningful time parameter and drops the rest", () => {
  const plain = parseSourceUrl("https://www.youtube.com/watch?v=SYNTHETIC01&list=PLxyz#frag");
  assert.equal(plain.canonicalUrl, "https://www.youtube.com/watch?v=SYNTHETIC01");
  const withTime = parseSourceUrl("https://youtu.be/SYNTHETIC01?t=1m30s&si=x");
  assert.equal(withTime.canonicalUrl, "https://www.youtube.com/watch?v=SYNTHETIC01&t=90");
});

test("non-YouTube keeps the released beta identity", () => {
  const variants = [
    "https://example.test/video/alpha",
    "https://example.test/video/alpha?x=1",
    "https://example.test/video/alpha#clip",
    "https://example.test/video/alpha/",
  ];
  for (const url of variants) {
    const ref = parseSourceUrl(url);
    assert.equal(ref.platform, "generic", url);
    assert.equal(ref.canonicalUrl, "https://example.test/video/alpha", url);
    assert.equal(ref.legacyId, FIXTURE_LEGACY_ID, url);
    assert.equal(ref.sourceId, FIXTURE_LEGACY_ID, url);
  }
  assert.equal(legacyHashId("https://example.test/video/alpha"), FIXTURE_LEGACY_ID);
  assert.equal(resolveLegacyId("https://example.test/video/alpha?x=1#clip"), FIXTURE_LEGACY_ID);
});

test("platform detection keeps provider ids where the platform exposes one", () => {
  const tiktok = parseSourceUrl("https://www.tiktok.com/@someone/video/7412345678901234567?is_from_webapp=1");
  assert.equal(tiktok.platform, "tiktok");
  assert.equal(tiktok.sourceId, "7412345678901234567");
  assert.equal(tiktok.legacyId, legacyHashId(tiktok.canonicalUrl));
  assert.equal(tiktok.canonicalUrl, "https://www.tiktok.com/@someone/video/7412345678901234567");
  assert.equal(new URL(tiktok.canonicalUrl).hostname, "www.tiktok.com");

  const instagram = parseSourceUrl("https://www.instagram.com/reel/CxYz_123/?igsh=abc");
  assert.equal(instagram.platform, "instagram");
  assert.equal(instagram.sourceId, "CxYz_123");

  const x = parseSourceUrl("https://twitter.com/someone/status/1800000000000000000?s=20");
  assert.equal(x.platform, "x");
  assert.equal(x.sourceId, "1800000000000000000");
  assert.equal(x.canonicalUrl, "https://x.com/someone/status/1800000000000000000");

  const ad = parseSourceUrl("https://www.facebook.com/ads/library/?id=1234567890&sort=impressions");
  assert.equal(ad.platform, "meta-ads");
  assert.equal(ad.sourceId, "1234567890");
  assert.equal(ad.canonicalUrl, "https://www.facebook.com/ads/library/?id=1234567890");
});

test("every platform's canonical URL is a real, correctly-hosted URL", () => {
  const samples = [
    "https://www.youtube.com/watch?v=SYNTHETIC01",
    "https://www.tiktok.com/@someone/video/7412345678901234567",
    "https://www.instagram.com/reel/CxYz_123/?igsh=abc",
    "https://twitter.com/someone/status/1800000000000000000?s=20",
    "https://www.facebook.com/ads/library/?id=1234567890",
    "https://example.test/video/alpha",
  ];
  for (const raw of samples) {
    const ref = parseSourceUrl(raw);
    // A malformed concatenation (e.g. missing "/" before a "@handle") folds the
    // path into the host/userinfo and new URL() would throw or silently change
    // the hostname - this is exactly the class of bug this test guards against.
    const canonical = new URL(ref.canonicalUrl);
    assert.equal(canonical.protocol, "https:", raw);
    assert.ok(canonical.hostname.length > 0, raw);
    assert.doesNotMatch(canonical.hostname, /@/, `hostname must not contain '@': ${raw}`);
  }
});

/**
 * Regression for the TikTok canonical-URL bug: `tiktokCanonical` used to build
 * `https://www.tiktok.com${handle}/...` where `handle` is `@someone` (no leading
 * slash captured by the regex), producing `https://www.tiktok.com@someone/...`.
 * The WHATWG URL parser (and yt-dlp) reads `www.tiktok.com@someone` as userinfo
 * "www.tiktok.com" at host "someone", so the real host became "someone" - which
 * does not resolve in DNS ("nodename nor servname provided"). This test fails on
 * the old code because the hostname resolves to the handle instead of tiktok.com.
 */
test("TikTok canonical URL always has www.tiktok.com as its host, for every URL shape", () => {
  const cases = [
    {
      raw: "https://www.tiktok.com/@tiktok/video/7681695065927912735",
      expected: "https://www.tiktok.com/@tiktok/video/7681695065927912735",
    },
    {
      raw: "https://www.tiktok.com/@tiktok/photo/7681695065927912735",
      expected: "https://www.tiktok.com/@tiktok/photo/7681695065927912735",
    },
    {
      // Handle containing a dot and a hyphen.
      raw: "https://www.tiktok.com/@some.handle-name/video/7681695065927912735?is_from_webapp=1",
      expected: "https://www.tiktok.com/@some.handle-name/video/7681695065927912735",
    },
    {
      // No handle in the path at all, still a valid /video/<id> shape.
      raw: "https://www.tiktok.com/video/7681695065927912735",
      expected: "https://www.tiktok.com/video/7681695065927912735",
    },
  ];

  for (const { raw, expected } of cases) {
    const ref = parseSourceUrl(raw);
    assert.equal(ref.platform, "tiktok", raw);
    assert.equal(ref.canonicalUrl, expected, raw);
    const hostname = new URL(ref.canonicalUrl).hostname;
    assert.equal(hostname, "www.tiktok.com", `${raw} -> host was "${hostname}"`);
  }
});

test("TikTok short links without a resolvable id fall back to a valid, correctly-hosted URL", () => {
  const shortLinks = ["https://vm.tiktok.com/ZMabcdEFG/", "https://www.tiktok.com/t/ZTabcdEFG/"];
  for (const raw of shortLinks) {
    const ref = parseSourceUrl(raw);
    assert.equal(ref.platform, "tiktok", raw);
    const hostname = new URL(ref.canonicalUrl).hostname;
    assert.doesNotMatch(hostname, /@/, raw);
    assert.match(hostname, /tiktok\.com$/, `${raw} -> host was "${hostname}"`);
  }
});

test("unsafe, malformed and oversized input is rejected without starting any work", async () => {
  const rejected = [
    "",
    "   ",
    "ftp://example.test/video.mp4",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://localhost:8765/video/1",
    "http://127.0.0.1/video/1",
    "http://10.0.0.5/video/1",
    "http://172.16.5.5/video/1",
    "http://192.168.1.10/video/1",
    "http://169.254.1.1/video/1",
    "http://[::1]/video/1",
    "http://[fe80::1]/video/1",
    "http://omniwatch/video/1",
    "https://example.test/a/../../etc/passwd",
    "https://example.test/%2e%2e/%2e%2e/etc/passwd",
    `https://example.test/video/${"a".repeat(3000)}`,
    "https://www.youtube.com/@somechannel",
  ];

  const mediaCalls = { cached: 0, fetch: 0, slice: 0, readUploads: 0 };
  const modelCalls = { count: 0 };
  const media = {
    async cached() { mediaCalls.cached += 1; return null; },
    async fetch() { mediaCalls.fetch += 1; return { localPath: "/tmp/none.mp4" }; },
    async slice() { mediaCalls.slice += 1; return "/tmp/none.mp4"; },
    async readUploads() { mediaCalls.readUploads += 1; return null; },
  };
  const registry = createSourceRegistry({ media });
  const model = {
    modelName: "stub",
    async call() { modelCalls.count += 1; return { text: "", usage: { costKnown: false }, completed: true }; },
  };
  void model;

  for (const bad of rejected) {
    await assert.rejects(
      () => registry.resolve({ url: bad }),
      (error) => {
        assert.ok(error instanceof OmniWatchError, `${bad} should throw OmniWatchError`);
        assert.equal(error.errorClass, "invalid_input", `${bad} should be invalid_input`);
        return true;
      },
      `expected rejection for ${JSON.stringify(bad.slice(0, 60))}`,
    );
  }
  assert.deepEqual(mediaCalls, { cached: 0, fetch: 0, slice: 0, readUploads: 0 });
  assert.equal(modelCalls.count, 0);
});

/* --------------------------------------------------------------- legacy ---- */

test("legacy info.json normalises to extractor/channel with channel winning", () => {
  const a = normalizeLegacyInfo({
    id: "SYNTHETIC01",
    title: "Fixture A",
    channel: "Fixture Channel",
    uploader: "Fallback A",
    duration: 16,
    extractor_key: "Youtube",
  });
  assert.equal(a.channel, "Fixture Channel");
  assert.equal(a.uploader, "Fallback A");
  assert.equal(a.extractor, "Youtube");
  assert.equal(formatDuration(a.duration), "0:16");

  const b = normalizeLegacyInfo({
    id: FIXTURE_LEGACY_ID,
    title: "Fixture B",
    channel: null,
    uploader: "Fixture Uploader",
    duration: 16,
    extractor_key: "Generic",
  });
  assert.equal(b.channel, "Fixture Uploader");
  assert.equal(b.extractor, "Generic");

  const numericStrings = parseLegacyInfoJson(
    '{"id":"x","title":"t","channel":"c","duration":"16","extractor_key":"Youtube"}',
  );
  assert.equal(numericStrings.duration, 16);

  assert.throws(
    () => parseLegacyInfoJson("{broken"),
    (error) => error instanceof OmniWatchError && error.errorClass === "invalid_input",
  );
  assert.throws(() => normalizeLegacyInfo(null), (error) => error.errorClass === "invalid_input");
});

test("oss.json freshness uses a seconds timestamp, a cacheHours TTL and refuses the future", () => {
  const fresh = evaluateUploadFreshness({ url: "oss://fixture/source.mp4", at: NOW_SECONDS - 60 }, 48, NOW_SECONDS);
  assert.equal(fresh.valid, true);
  assert.equal(fresh.reason, "fresh");

  // 47 h old at a 48 h TTL is still valid; at the beta's own 47 h TTL it is not.
  const documented = evaluateUploadFreshness({ at: NOW_SECONDS - 47 * 3600 }, 48, NOW_SECONDS);
  assert.equal(documented.valid, true);
  const betaTtl = evaluateUploadFreshness({ at: NOW_SECONDS - 47 * 3600 }, 47, NOW_SECONDS);
  assert.equal(betaTtl.valid, false);
  assert.equal(betaTtl.reason, "expired");

  const future = evaluateUploadFreshness({ at: NOW_SECONDS + 60 }, 48, NOW_SECONDS);
  assert.equal(future.valid, false);
  assert.equal(future.reason, "future");

  assert.equal(evaluateUploadFreshness({ at: "not-a-time" }, 48, NOW_SECONDS).reason, "malformed");
  assert.equal(evaluateUploadFreshness(null, 48, NOW_SECONDS).valid, false);
});

/* ---------------------------------------------------------------- media ---- */

test("strip and duration formatting match the frozen beta output", () => {
  assert.deepEqual(strip(16), [0, 2, 2, 4, 4, 6, 6, 8, 8, 10, 10, 12, 12, 14, 14, 16]);
  assert.equal(formatDuration(16), "0:16");
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(3723), "1:02:03");
  assert.equal(fpsFor(180), 10);
  assert.equal(fpsFor(181), 2);
});

test("part splitting is driven by maxFramesPerPart, not by minutes", () => {
  assert.equal(partCountFor(2402, { maxFramesPerPart: 2400 }), 3);
  assert.equal(partCountFor(1200, { maxFramesPerPart: 2400 }), 1);
  assert.equal(partCountFor(1201, { maxFramesPerPart: 2400 }), 2);

  const plan = partPlan(2402, { maxFramesPerPart: 2400 });
  assert.equal(plan.length, 3);
  assert.ok(Math.abs(plan[0].startSeconds - 0) < 1e-9);
  assert.ok(Math.abs(plan[1].startSeconds - 2402 / 3) < 1e-9);
  assert.ok(Math.abs(plan[2].startSeconds - 4804 / 3) < 1e-9);
  assert.ok(Math.abs(plan[2].endSeconds - 2402) < 1e-9);

  // The documented beta README knob has no effect: the frame budget is the only input.
  assert.equal(partCountFor(2402, { maxFramesPerPart: 4800 }), 2);
});

test("timestamps shift into full-video time unless they are already absolute", () => {
  assert.equal(shiftTimestamps("[0:05] note", 60, 120), "[1:05] note");
  assert.equal(shiftTimestamps("[9:00] already absolute", 0, 120), "[9:00] already absolute");
});

/* ------------------------------------------------------------- registry ---- */

function stubMedia(options = {}) {
  const calls = { cached: 0, fetch: 0, slice: 0, readUploads: 0 };
  const media = {
    async cached() {
      calls.cached += 1;
      return options.cached ?? null;
    },
    async fetch() {
      calls.fetch += 1;
      if (options.fetchError) throw options.fetchError;
      return options.fetched ?? { localPath: "/tmp/omniwatch/source.mp4", durationSeconds: 16 };
    },
    async probeDuration() {
      return options.probedDuration ?? 0;
    },
    async readUploads() {
      calls.readUploads += 1;
      if (options.uploads === undefined) return null;
      return options.uploads;
    },
    async slice(input) {
      calls.slice += 1;
      return `${input.localPath.replace(/\.mp4$/, "")}_part${input.index}.mp4`;
    },
  };
  return { media, calls };
}

const SOURCE = parseSourceUrl("https://example.test/video/alpha");

test("prepare reuses the cache and only downloads on a miss", async () => {
  const hit = stubMedia({
    cached: { localPath: "/tmp/cache/source.mp4", title: "Cached", channel: "C", durationSeconds: 16, extractor: "Generic" },
  });
  const registry = createSourceRegistry({ media: hit.media });
  const info = await registry.prepare(SOURCE);
  assert.equal(info.title, "Cached");
  assert.equal(info.durationSeconds, 16);
  assert.equal(hit.calls.cached, 1);
  assert.equal(hit.calls.fetch, 0);

  const miss = stubMedia({ fetched: { localPath: "/tmp/cache/source.mp4", title: "Fetched" } });
  const registry2 = createSourceRegistry({ media: miss.media });
  const info2 = await registry2.prepare(SOURCE);
  assert.equal(info2.title, "Fetched");
  assert.equal(miss.calls.fetch, 1);
  // No duration from the extractor: the registry probes the file.
  assert.equal(info2.durationSeconds, 0);

  const probed = stubMedia({ fetched: { localPath: "/tmp/cache/source.mp4" }, probedDuration: 42 });
  const info3 = await createSourceRegistry({ media: probed.media }).prepare(SOURCE);
  assert.equal(info3.durationSeconds, 42);
});

test("prepare reports a missing video and a tool timeout as source_unavailable", async () => {
  const missing = stubMedia({ fetchError: new Error("video not in cache") });
  await assert.rejects(
    () => createSourceRegistry({ media: missing.media }).prepare(SOURCE),
    (error) => error instanceof OmniWatchError && error.errorClass === "source_unavailable",
  );

  const timeout = stubMedia({ fetchError: new Error("yt-dlp timed out") });
  await assert.rejects(
    () => createSourceRegistry({ media: timeout.media }).prepare(SOURCE),
    (error) => error.errorClass === "source_unavailable" && /timed out/.test(error.message),
  );
});

test("an unsupported ad type keeps its own error class instead of becoming a generic failure", async () => {
  const ad = parseSourceUrl("https://www.facebook.com/ads/library/?id=1234567890");
  const media = stubMedia({
    fetchError: new OmniWatchError("source_unavailable", "Reklama nie zawiera materialu wideo.", {
      action: { label: "wybierz inna reklame", kind: "none" },
    }),
  });
  await assert.rejects(
    () => createSourceRegistry({ media: media.media }).prepare(ad),
    (error) => error.errorClass === "source_unavailable" && /nie zawiera/.test(error.message),
  );
});

test("expired and future beta uploads are not reused, fresh ones are", async () => {
  const cached = { localPath: "/tmp/cache/source.mp4", durationSeconds: 16 };
  const fresh = stubMedia({
    cached,
    uploads: { "source.mp4": { url: "oss://fixture/source.mp4", at: NOW_SECONDS - 60 } },
  });
  const freshInfo = await createSourceRegistry({ media: fresh.media, cacheHours: () => 48, now: () => NOW_SECONDS })
    .prepare(SOURCE);
  assert.equal(freshInfo.reusedUpload, true);
  assert.equal(freshInfo.uploadedUrl, "oss://fixture/source.mp4");
  assert.equal(fresh.calls.readUploads, 1);

  const expired = stubMedia({
    cached,
    uploads: { "source.mp4": { url: "oss://fixture/source.mp4", at: NOW_SECONDS - 49 * 3600 } },
  });
  const expiredInfo = await createSourceRegistry({ media: expired.media, cacheHours: () => 48, now: () => NOW_SECONDS })
    .prepare(SOURCE);
  assert.equal(expiredInfo.reusedUpload, false);
  assert.equal(expiredInfo.uploadedUrl, null);

  const future = stubMedia({
    cached,
    uploads: { "source.mp4": { url: "oss://fixture/source.mp4", at: NOW_SECONDS + 120 } },
  });
  const futureInfo = await createSourceRegistry({ media: future.media, cacheHours: () => 48, now: () => NOW_SECONDS })
    .prepare(SOURCE);
  assert.equal(futureInfo.reusedUpload, false);
});

test("split only calls the injected slicer when there is more than one part", async () => {
  const single = stubMedia({});
  const singleParts = await createSourceRegistry({ media: single.media }).split(
    { sourceRef: SOURCE, title: "T", channel: null, durationSeconds: 16, extractor: "Generic", localPath: "/tmp/source.mp4" },
    { maxFramesPerPart: 2400 },
  );
  assert.equal(singleParts.length, 1);
  assert.equal(singleParts[0].localPath, "/tmp/source.mp4");
  assert.equal(single.calls.slice, 0);

  const many = stubMedia({});
  const manyParts = await createSourceRegistry({ media: many.media }).split(
    { sourceRef: SOURCE, title: "T", channel: null, durationSeconds: 2402, extractor: "Generic", localPath: "/tmp/source.mp4" },
    { maxFramesPerPart: 2400 },
  );
  assert.equal(manyParts.length, 3);
  assert.equal(many.calls.slice, 3);
  assert.deepEqual(manyParts.map((part) => part.index), [0, 1, 2]);
});

test("capabilities are honest per platform", () => {
  const youtube = capabilitiesFor("youtube");
  assert.equal(youtube.listing, "full");
  assert.equal(youtube.listingCost, "free");
  assert.equal(youtube.pagination, true);

  const instagram = capabilitiesFor("instagram");
  assert.equal(instagram.listing, "limited");
  assert.equal(instagram.listingScopeNote, "25 ostatnich");
  assert.equal(instagram.listingCost, "paid");
  assert.deepEqual(instagram.requiresConfig, ["APIFY_TOKEN"]);

  for (const platform of ["x", "meta-ads"]) {
    const caps = capabilitiesFor(platform);
    assert.equal(caps.listingCost, "paid", platform);
    assert.ok(caps.listingScopeNote && /jawn/i.test(caps.listingScopeNote), platform);
    assert.ok(caps.requiresConfig.length > 0, platform);
  }

  const tiktok = capabilitiesFor("tiktok");
  assert.equal(tiktok.listing, "limited");
  assert.equal(tiktok.listingCost, "free");

  assert.equal(capabilitiesFor("generic").listing, "none");
});

test("list refuses platforms without a lister and keeps listing failures distinguishable", async () => {
  const { media } = stubMedia({});
  const registry = createSourceRegistry({ media });
  await assert.rejects(
    () => registry.list(SOURCE, {}),
    (error) => error.errorClass === "invalid_input",
  );

  const broken = createSourceRegistry({
    media,
    listers: {
      youtube: {
        async list() {
          throw new Error("channel tab failed");
        },
      },
    },
  });
  const youtubeSource = parseSourceUrl("https://youtu.be/SYNTHETIC01");
  await assert.rejects(
    () => broken.list(youtubeSource, {}),
    (error) => error.errorClass === "incomplete_listing",
  );
});

test("one failed item does not destroy the other prepared results", async () => {
  const { media } = stubMedia({});
  const registry = createSourceRegistry({ media });
  const sources = [
    parseSourceUrl("https://example.test/video/alpha"),
    parseSourceUrl("https://example.test/video/beta"),
    parseSourceUrl("https://example.test/video/gamma"),
  ];
  const failing = new Set(["https://example.test/video/beta"]);
  const wrapped = {
    ...registry,
    async prepare(ref, options) {
      if (failing.has(ref.canonicalUrl)) throw new OmniWatchError("source_unavailable", "brak materialu");
      return registry.prepare(ref, options);
    },
  };
  const results = await prepareMany(wrapped, sources);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((entry) => entry.ok), [true, false, true]);
  assert.equal(results[1].error.errorClass, "source_unavailable");
});
