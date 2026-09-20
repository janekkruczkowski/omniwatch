// Live checks for the local-voice endpoint. Needs the Agent OS dev server running:
//
//   node --test agent-os-module/test/local-voice.live.mjs          (OMNI_BASE to override)
//
// These are the cases that need a real `say` and a real HTTP handler: a script that
// begins with a flag, a body that is not an object, a voice name that is not a string,
// and several identical requests at once. Everything here is local — no paid API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.OMNI_BASE || "http://127.0.0.1:3000";
const URL_VOICE = `${BASE}/api/omniwatch/voiceover`;
const VOICE_ROOT = path.join(os.homedir(), ".agentic-os", "omniwatch", "voiceovers");

const post = async (raw) => {
  const r = await fetch(URL_VOICE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof raw === "string" ? raw : JSON.stringify(raw),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const audio = async (audioUrl) => {
  const r = await fetch(`${BASE}${audioUrl}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type"), bytes: buf.length };
};

let up = true;
try {
  const r = await fetch(URL_VOICE, { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  assert.equal(typeof j.available, "boolean");
} catch {
  up = false;
  console.log(`# SKIPPED: no dev server at ${BASE}`);
}

const maybe = (name, fn) => test(name, { skip: !up }, fn);

maybe("a body that is not an object is a 400, not a crash", async () => {
  for (const raw of ["null", "5", '"text"', "[]", "{}"]) {
    const r = await post(raw);
    assert.equal(r.status, 400, `body ${raw} → ${r.status}`);
    assert.ok(r.body?.error, `body ${raw} answered without an error message`);
  }
});

maybe("text and voice have to be the right types", async () => {
  assert.equal((await post({ text: { a: 1 } })).status, 400);
  assert.equal((await post({ text: 5 })).status, 400);
  assert.equal((await post({ text: "hello", voice: 5 })).status, 400);
  assert.equal((await post({ text: "hello", voice: "NoSuchVoiceZZZ" })).status, 400);
  assert.equal((await post({ text: "a".repeat(10001) })).status, 400);
});

maybe("a script that looks like a flag is spoken, not obeyed", async () => {
  // If this reached `say` as argv it would be read as -f <file> -o <file>: it would try to
  // read /etc/passwd as a script and write an aiff to /tmp. Neither may happen.
  const pwned = "/tmp/omniwatch-pwned";
  const r = await post({ text: `-f /etc/passwd -o ${pwned}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.provider, "local");
  assert.equal(existsSync(pwned), false, "the text was interpreted as options");
  const a = await audio(r.body.audioUrl);
  assert.equal(a.status, 200);
  assert.equal(a.type, "audio/mpeg");
  assert.ok(a.bytes > 500, `only ${a.bytes} bytes of audio`);
});

maybe("three identical requests at once all answer, and the audio survives them", async () => {
  const text = `parallel check ${Date.now()}`;
  const results = await Promise.all([post({ text }), post({ text }), post({ text })]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  const urls = new Set(results.map((r) => r.body.audioUrl));
  assert.equal(urls.size, 1, "same text, one file");

  const a = await audio(results[0].body.audioUrl);
  assert.equal(a.status, 200, "a sibling request deleted the finished file");
  assert.ok(a.bytes > 500);

  const leftovers = readdirSync(VOICE_ROOT).filter((f) => f.endsWith(".part"));
  assert.deepEqual(leftovers, [], "temp files left behind");
});
