// OmniWatch — Qwen3.8-Omni-Flash watches a video for you (picture AND sound, not a
// transcript) and answers with timestamps plus the real frames as evidence.
//
// Two modes: Ask (a question about the video) and Teardown (how the video is MADE:
// hook, beat by beat, editing, on-screen text, sound, CTA + a ready script for your
// own topic). Teardown is the competitor-research one.
//
// Pipeline: yt-dlp downloads ≤480p → the file is uploaded to Model Studio temporary
// storage (oss://, 48 h, free) → ONE request with the whole video. Videos longer than
// PART_MAX are split into equal parts, watched in parallel, then merged.
//
// Measured limits (not guessed): a YouTube link passed straight to the API is rejected,
// base64 video input caps at 10 MB, an oss:// URL takes up to 2 h / 2 GB, fps is only
// accepted between 0.1 and 10, and 480p @ 2 fps costs ~350 video tokens per second —
// which is what puts the one-request ceiling at ~40 minutes.

import { spawn } from "node:child_process";
import { existsSync, openAsBlob, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, stat, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import I18N from "@/lib/omniwatchI18n";

export const OMNI_ROOT = path.join(os.homedir(), ".agentic-os", "omniwatch");
export const CACHE_ROOT = path.join(OMNI_ROOT, "cache");
export const OUT_ROOT = path.join(OMNI_ROOT, "summaries");

const MODEL = process.env.OMNI_MODEL || "qwen3.8-omni-flash";
const API = process.env.DASHSCOPE_API || "https://dashscope-intl.aliyuncs.com";

export const DEFAULT_LANG = process.env.OMNI_LANG || "en";
// How big one request is allowed to get, counted in frames rather than minutes.
//
// Minutes are the wrong unit: the model is billed and bounded by frames, and frames are
// duration × fps. Because fpsFor() jumps to 10 fps below SHORT_MAX, a 3-minute short is
// 1800 frames while a 10-minute talk is 1200 — the short is the bigger request, and a
// cap in minutes cannot see that at all.
//
// Measured at ~120 tokens per frame: 494 frames (59k tokens) went through, 2572 frames
// were dropped by the server mid-request, and the same video split into 858-frame parts
// went through. 2400 sits below the size we saw fail and above every size we saw work.
const MAX_FRAMES = Math.max(300, Number(process.env.OMNI_MAX_FRAMES || 2400));
const OSS_TTL = 47 * 3600 * 1000; // oss:// URLs live 48 h; refresh an hour early
const CACHE_TTL = parseFloat(process.env.OMNI_CACHE_HOURS || "48") * 3600 * 1000;
const MAX_TOKENS = Number(process.env.OMNI_MAX_TOKENS || 4000);
const PRESENCE_PENALTY = Number(process.env.OMNI_PRESENCE_PENALTY ?? 0.3);
const SHORT_MAX = 3 * 60; // shorts/reels/TikToks: fast cuts, so sample at the API maximum
const FPS_SHORT = 10;
const FPS_LONG = 2; // the API default for normal videos

export const PRICE_IN = 0.15 / 1e6;
export const PRICE_OUT = 0.47 / 1e6;
export const STRIP = 16; // thumbnails in the timeline strip

// Why you are watching, which is not one question.
//
// "ask" is what is in the video — the case where you will not sit through an hour and
// want the content. "teardown" is how it was built, which is a different reader with a
// different job. Scanning a channel exposed that the two are not alternatives: someone
// studying a fitness channel wants the knowledge, someone studying a channel they mean
// to compete with wants both, and a scan that assumed one of them was wrong half the time.
//
// "both" is one request, not two. The frames are what cost money and they are the same
// frames; asking for a second document off the same upload adds output tokens only —
// fractions of a cent — while running it twice would pay for the whole video again.
export type Mode = "ask" | "teardown" | "both";
export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  duration: number;
  extractor: string;
}
export interface WatchStats { parts: number; fps: number; reused: boolean; in: number; out: number }

// ── shelling out ───────────────────────────────────────────────────────────────
// launchd starts the dev server with a minimal PATH, so yt-dlp and ffmpeg have to be
// found explicitly — same approach as the Video Editor tab.
export const BIN_PATH = [
  path.join(os.homedir(), ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".npm-global/bin"),
  process.env.PATH || "",
].filter(Boolean).join(path.delimiter);

export function run(cmd: string, args: string[], timeoutMs = 1_800_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, PATH: BIN_PATH } });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    p.on("error", (e) => { clearTimeout(timer); reject(new Error(`${cmd} could not start: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed:\n${err.slice(-1500)}`));
    });
  });
}

/** Which of the three external tools are missing — drives the onboarding screen. */
export async function toolsPresent(): Promise<{ ytDlp: boolean; ffmpeg: boolean }> {
  const has = async (cmd: string, arg: string) => { try { await run(cmd, [arg], 15_000); return true; } catch { return false; } };
  const [ytDlp, ffmpeg] = await Promise.all([has("yt-dlp", "--version"), has("ffmpeg", "-version")]);
  return { ytDlp, ffmpeg };
}

// ── the API key ────────────────────────────────────────────────────────────────
// Same resolution order as the rest of Agent OS: environment first, then the Hermes
// profile .env, then ~/.agentic-os/config.json.
export async function apiKey(): Promise<string | null> {
  const env = process.env.DASHSCOPE_API_KEY?.trim();
  if (env) return env;
  const hermes = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  for (const file of [path.join(hermes, ".env"), path.join(os.homedir(), ".fcc", ".env")]) {
    try {
      const m = (await readFile(file, "utf8")).match(/^DASHSCOPE_API_KEY=(.+)$/m);
      if (m && m[1].trim().length > 10) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* not there — try the next one */ }
  }
  try {
    const cfg = JSON.parse(await readFile(path.join(os.homedir(), ".agentic-os", "config.json"), "utf8"));
    const k = (cfg.dashscopeApiKey || cfg.qwenApiKey || "").trim();
    if (k.length > 10) return k;
  } catch { /* no config.json */ }
  return null;
}

// ── cache ──────────────────────────────────────────────────────────────────────
/** Delete downloaded videos not used for CACHE_TTL. Answers in summaries/ are kept. */
export async function cleanup(): Promise<string[]> {
  const gone: string[] = [];
  let dirs: string[];
  try { dirs = await readdir(CACHE_ROOT); } catch { return gone; }
  for (const name of dirs) {
    const dir = path.join(CACHE_ROOT, name);
    try {
      const info = path.join(dir, "info.json");
      const s = await stat(existsSync(info) ? info : dir);
      if (Date.now() - s.mtimeMs > CACHE_TTL) { await rm(dir, { recursive: true, force: true }); gone.push(name); }
    } catch { /* vanished under us */ }
  }
  return gone;
}

/** yt-dlp handles YouTube, TikTok, Instagram, Facebook, X… so key the cache by URL. */
export function cacheKey(url: string): string {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return m[1];
  const norm = url.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  // djb2 over the normalized URL — short, stable, filesystem-safe.
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < norm.length; i++) { h1 = (h1 * 33) ^ norm.charCodeAt(i); h2 = (h2 * 33) ^ norm.charCodeAt(norm.length - 1 - i); }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, "0");
}

export function videoDir(id: string): string {
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error("bad video id");
  return path.join(CACHE_ROOT, id);
}

export const fpsFor = (seconds: number) => (seconds <= SHORT_MAX ? FPS_SHORT : FPS_LONG);

export function fmt(sec: number): string {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// ── download ───────────────────────────────────────────────────────────────────
/** Download once; follow-up questions about the same video reuse the cache. */
export async function fetchVideo(url: string): Promise<{ info: VideoInfo; src: string }> {
  await cleanup();
  const dir = videoDir(cacheKey(url));
  const infoFile = path.join(dir, "info.json");
  const src = path.join(dir, "source.mp4");
  let info: VideoInfo;

  if (existsSync(infoFile) && existsSync(src)) {
    info = JSON.parse(await readFile(infoFile, "utf8"));
    const now = new Date();
    await utimes(infoFile, now, now); // keep a video you're still asking about alive
  } else {
    const raw = JSON.parse(await run("yt-dlp", ["-J", "--no-playlist", url], 180_000));
    info = {
      id: path.basename(dir),
      title: raw.title || "?",
      channel: raw.channel || raw.uploader || "?",
      duration: Math.round(raw.duration || 0),
      extractor: raw.extractor_key || "",
    };
    await mkdir(dir, { recursive: true });
    await writeFile(infoFile, JSON.stringify(info));
  }
  if (!existsSync(src)) {
    // 480p reads slides and code fine and keeps even a long part well under the 1 GB limit.
    //
    // This sorts rather than filters, because a filter on `height` silently fails on
    // vertical video: a 1080x1920 TikTok has a *height* of 1920, so `height<=480` matches
    // nothing and the old fallback chain quietly fetched the best available instead —
    // five times the pixels per frame, on exactly the short-form material we scan most.
    // yt-dlp's `res` sort key is the smaller of the two dimensions, so one rule covers
    // both orientations and there is no uncapped branch left to fall through to.
    await run("yt-dlp", ["--no-playlist", "-q", "--no-warnings", "-N", "8",
      "-S", "res:480", "-f", "bv*+ba/b",
      "--merge-output-format", "mp4", "-o", src, url]);
  }
  return { info, src };
}

/** The whole video if it fits one request, otherwise equal parts of at most MAX_FRAMES. */
export async function splitParts(info: VideoInfo, src: string): Promise<{ start: number; file: string }[]> {
  const seconds = info.duration || 0;
  const n = Math.max(1, Math.ceil((seconds * fpsFor(seconds)) / MAX_FRAMES));
  if (n === 1) return [{ start: 0, file: src }];
  const length = seconds / n;
  const out: { start: number; file: string }[] = [];
  for (let i = 0; i < n; i++) {
    const dst = path.join(path.dirname(src), `part_${n}_${i}.mp4`);
    if (!existsSync(dst)) {
      // stream copy: no re-encode, cuts land on the nearest keyframe
      await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(i * length), "-t", String(length),
        "-i", src, "-c", "copy", "-avoid_negative_ts", "make_zero", dst]);
    }
    out.push({ start: i * length, file: dst });
  }
  return out;
}

/** One real frame from the downloaded video — visual proof of what the model saw. */
export async function frameJpeg(id: string, sec: number): Promise<string> {
  const dir = videoDir(id);
  const src = path.join(dir, "source.mp4");
  if (!existsSync(src)) throw new Error("video not in cache");
  const out = path.join(dir, "frames", `${Math.max(0, Math.floor(sec))}.jpg`);
  if (!existsSync(out)) {
    await mkdir(path.dirname(out), { recursive: true });
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, Math.floor(sec))),
      "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out], 60_000);
  }
  return out;
}

// ── upload to Model Studio temporary storage ───────────────────────────────────
/** Returns the oss:// URL and whether it was reused. Cached so follow-ups don't re-upload. */
export async function upload(src: string, key: string): Promise<{ url: string; reused: boolean }> {
  const meta = path.join(path.dirname(src), "oss.json");
  let known: Record<string, { url: string; at: number }> = {};
  try { known = JSON.parse(await readFile(meta, "utf8")); } catch { /* first upload */ }
  const hit = known[path.basename(src)];
  if (hit && Date.now() - hit.at < OSS_TTL) return { url: hit.url, reused: true };

  const auth = { Authorization: `Bearer ${key}` };
  const r = await fetch(`${API}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(MODEL)}`, { headers: auth });
  if (!r.ok) throw new Error(`Model Studio refused the upload policy (${r.status}). Is the key a pay-as-you-go key?`);
  const d = (await r.json()).data;
  const objectKey = `${d.upload_dir}/${path.basename(src)}`;

  // Field order matters to OSS: every policy field, then key, then the file last.
  const form = new FormData();
  form.append("OSSAccessKeyId", d.oss_access_key_id);
  form.append("Signature", d.signature);
  form.append("policy", d.policy);
  form.append("x-oss-object-acl", d.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", d.x_oss_forbid_overwrite);
  form.append("key", objectKey);
  form.append("success_action_status", "200");
  form.append("file", await openAsBlob(src), path.basename(src)); // lazy blob: never loads the whole file

  const up = await fetch(d.upload_host, { method: "POST", body: form });
  if (!up.ok) throw new Error(`Upload to Model Studio failed (${up.status})`);

  const url = `oss://${objectKey}`;
  known[path.basename(src)] = { url, at: Date.now() };
  await writeFile(meta, JSON.stringify(known));
  return { url, reused: false };
}

// ── Omni ───────────────────────────────────────────────────────────────────────
type Content = { type: "video_url"; video_url: { url: string }; fps: number } | { type: "text"; text: string };

/** A failure worth trying again: the network blinked, not the request being wrong. */
class Transient extends Error {}

const RETRIES = Math.max(0, Number(process.env.OMNI_RETRIES ?? 3));

/**
 * Omni only supports streaming. Calls onToken with the text so far.
 *
 * One dropped connection used to lose the whole run — after the download and after the
 * upload, so the money and the minutes were already spent and the user got a stack
 * trace. That is survivable in a tab where someone is watching; it is fatal for anything
 * on a schedule, where nobody is there to press the button again.
 *
 * onToken receives the answer so far rather than each delta, so a retry that starts the
 * answer over just rewrites what is on screen — nothing to undo.
 */
async function streamOmni(key: string, content: Content[], onToken?: (s: string) => void):
  Promise<{ text: string; usage: { in: number; out: number } }> {
  let last: Error = new Error("never ran");
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      return await attemptOmni(key, content, onToken);
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      if (!(e instanceof Transient)) throw last;
    }
  }
  throw new Error(`${last.message} (gave up after ${RETRIES + 1} attempts)`);
}

async function attemptOmni(key: string, content: Content[], onToken?: (s: string) => void):
  Promise<{ text: string; usage: { in: number; out: number } }> {
  let r: Response;
  try {
    r = await fetch(`${API}/compatible-mode/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // lets the compatible-mode endpoint resolve oss:// temporary URLs
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content }],
      modalities: ["text"],
      stream: true,
      stream_options: { include_usage: true },
      // thinking is ON by default and only adds latency here: ~17 s to first token vs a couple
      enable_thinking: false,
      // A ceiling, because the model can occasionally collapse into a repetition loop.
      // Seen once in testing: a teardown ran five minutes emitting an endless list of
      // unrelated words. Without a cap that burns wall-clock and money with nothing to
      // show. A full teardown lands around 2.5k tokens, so 4k leaves real headroom.
      max_tokens: MAX_TOKENS,
      // Was 1.05, to push the model out of a repetition loop. That reasoning does not
      // survive looking at the actual failure: the collapse is not repetition, it is a
      // thesaurus chain, each word different from the last. presence_penalty punishes
      // tokens that have already appeared, so against this symptom it is not neutral —
      // it rewards reaching for rarer and rarer vocabulary, which is the drift itself.
      // Lowered, and left adjustable so the two can be compared on the same video
      // rather than argued about. trimRunOn() is the guard that does not depend on
      // getting this number right.
      presence_penalty: PRESENCE_PENALTY,
      }),
    });
  } catch (e) {
    // Node's fetch reports every transport problem as a bare "fetch failed"; the real
    // reason is on .cause and is the difference between "you are offline" and
    // "the connection was dropped mid-answer".
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code || cause?.message || (e instanceof Error ? e.message : String(e));
    // Every transport failure lands here: offline, DNS, refused, or the server hanging up
    // before it answered. All of them are worth one more go.
    throw new Transient(`Could not reach Qwen (${detail}).`);
  }
  if (!r.ok || !r.body) {
    const body = (await r.text()).slice(0, 400);
    // 429 means slow down and 5xx means their side; a 4xx is us, and repeating it would
    // only waste the upload again.
    const Err = r.status === 429 || r.status >= 500 ? Transient : Error;
    throw new Err(`Qwen returned ${r.status}: ${body}`);
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
  const usage = { in: 0, out: 0 };
  for (;;) {
    // A stream that dies halfway leaves a truncated answer that reads like a complete
    // one, which is worse than an error. Treat it as transient and start over.
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      throw new Transient(`Qwen dropped the connection while answering (${e instanceof Error ? e.message : String(e)}).`);
    }
    const { done, value } = chunk;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      try { ev = JSON.parse(payload); } catch { continue; }
      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) { text += delta; onToken?.(text); }
      if (ev.usage) { usage.in += ev.usage.prompt_tokens || 0; usage.out += ev.usage.completion_tokens || 0; }
    }
  }
  return { text, usage };
}

// ── prompts ────────────────────────────────────────────────────────────────────
const SECTIONS_SUMMARY = `## {tldr}
2-3 sentences.

## {takeaways}
5-8 bullets, concrete and actionable.

## {visual}
4-7 bullets of things that come from the visuals (screens, demos, slides, code, charts, on-screen text) —
not from what is said. Start every bullet with the \`[{ts}]\` where it appears.

## {timeline}
Bullets starting with \`[{ts}]\` + one line, max ~12, covering the whole video.

## {verdict}
One line verdict + which timestamp to jump to.`;

const SECTIONS_QUESTION = `## {answer}
A direct answer in 2-6 sentences. If the video does not answer the question (or only partly), say so plainly first.

## {evidence}
3-8 bullets, each starting with \`[{ts}]\`: what is said or SHOWN at that moment (screens, UI, code, slides,
charts, on-screen text) that supports the answer. Prefer moments where something relevant is visible.

## {gaps}
1-3 bullets: gaps, caveats, or what you'd still need to check. Skip the section if there are none.

## {jump}
1-3 bullets starting with a single \`[{ts}]\` (no ranges) + why — the moments worth watching yourself for this question.`;

// A fixed card rather than free prose, and this is the whole argument for the mode.
//
// The version before this asked for "cuts per 10 s, average shot length, camera moves,
// zooms, b-roll, captions style, aspect ratio, transitions" and got back exactly what
// that invites: "hard cuts dominate", "fast-paced", "engaging". True of most videos,
// therefore useless about any of them. A reader's verdict, unimproved: it says nothing.
//
// The fix is the rule this project already wrote down: the value is not in the model's
// analysis, it is in the schema you force it into. Forty free-text labels across forty
// videos cannot be compared; ten fields with closed values can be read side by side, and
// what an account does EVERY time — the thing no single teardown can show you — falls
// out of the column. So the fields never vary, the values come from a list, and "unclear"
// is available so the model can decline instead of inventing.
//
// The field names and values stay in English even when the prose does not. A schema
// whose keys change per language is not a schema.
const SECTIONS_TEARDOWN = `## {card}
Exactly these ten lines, in this order, each as \`**Field:** value — [{ts}] evidence\`.
Pick the value from the list given. Never invent a value, never add a field, never drop one.
If the video does not show enough to tell, the value is \`unclear\`.
The evidence after the dash is at most 20 words and names something actually seen or heard.

*   **Hook type:** bold claim | contradiction | question | result first | problem named | cold demo | number | story open
*   **Hook proof:** on-screen text | screen recording | physical demo | face only | number on screen | none
*   **Information lives in:** speech | what is shown | both, saying the same thing | what is shown, unsaid
*   **Pace:** cuts per 10 s as a number, then the longest single shot in seconds
*   **On screen:** talking head | screen recording | b-roll | text cards | product | hands | charts — list every one that appears
*   **Captions:** burned-in word by word | burned-in phrases | none | platform auto
*   **Payoff lands:** within 5 s | midway | at the end | never
*   **Asks viewer to:** nothing | follow | link in bio | comment a keyword | watch next | buy
*   **Floor to reproduce:** phone and captions | screen recorder and captions | camera and lighting | heavy edit
*   **Load-bearing choice:** one sentence naming the single decision the video would fail without

## {beats}
5-12 bullets starting with \`[{ts}]\`: every beat/shot — what is shown, what is said, what changes. This is the skeleton.

## {text}
Every piece of on-screen text worth copying (hook text, labels, numbers), with \`[{ts}]\`.`;

/** Only when a topic is given. Two short lists and nothing else — the reader asked which
 *  choices move to their subject, not for a rewritten version of somebody else's video. */
const SECTION_TRANSFER = `## {transfer}
Two lists, at most four bullets each, no preamble.
*   **Transfers:** a choice above that works regardless of subject, and the one-line reason.
*   **Does not:** a choice that only worked because of THEIR material, and what it depended on.`;
// There used to be an "{adapt}" section here: a ready shot-by-shot script for your own
// topic, following the same beats. It is gone for two reasons.
//
// It reads as "steal this video", because that is what a beat-for-beat rewrite is, and it
// duplicated work Astros already does better (it proposes the angle; we explain the craft).
//
// It also broke the document. With no topic given the model picked one at random, then
// wrote the whole script under the SAME headings — so a teardown came back looking like two
// teardowns glued together, which is why the output read as unusable.
//
// What replaces it is the rest of this file: the constraints, not the content.

const TS_RULE = "Timestamps must be real positions in the video, written exactly like `[{ts}]`, one per bullet, no ranges.";

const TEARDOWN_TASK = `Take this video apart like a creator who wants to make something as good in their own niche.
Record HOW it is made, as a filled-in card plus the beats and the on-screen text.
Keep every field name and every chosen value in English exactly as listed, even if the rest is in another language.
Banned, because they are true of almost every video and so describe none of it: "hard cuts", "fast-paced",
"engaging", "dynamic", "high energy", "keeps the viewer hooked", "modern editing". Say the concrete thing or
say nothing. If a line has nothing left to say, end it — never pad a line to make it look complete.`;

const WHOLE = `You are watching the whole video "{title}" by {channel} ({duration}) — video AND audio.
{task}
Base everything strictly on what is said and shown — never invent. Write in {lang}. Markdown, exactly these
sections, with the headings exactly as written (they are in {lang}):

{sections}

{ts_rule}`;

const PART = `You are watching part {i}/{n} of the video "{title}" by {channel}. Watch AND listen.
{focus}
Write dense notes in {lang}. Prefix each note with its timestamp in THIS clip (it starts at [0:00]), like [12:34].
Max 15 notes. No intro, no outro.`;

const FOCUS_SUMMARY = `Note what is said (key claims, numbers, names, steps) and what is SHOWN that audio alone would miss
(slides, UI/screens, code, charts, demos, on-screen text). Be concrete.`;

const FOCUS_TEARDOWN = `Note HOW this part is made: every shot/beat, what is shown, what is said, on-screen text,
cuts and pacing, camera moves, music and sound, and any call to action. Be concrete and visual.`;

const FOCUS_QUESTION = `The user wants to know: {question}
Note only material that helps answer it — what is said and what is SHOWN (screens, UI, code, slides, charts,
on-screen text). Quote key phrases when they matter. If nothing in this part is relevant, reply with exactly one line:
NOTHING RELEVANT — <what this part is about, max 12 words>`;

const MERGE = `Below are timestamped notes an AI took while watching the video "{title}" by {channel}
({duration}) in {n} parts — video AND audio. Timestamps are already positions in the full video.
{task}
Base everything strictly on the notes — never invent. Write in {lang}. Markdown, exactly these sections,
with the headings exactly as written (they are in {lang}):

{sections}

{ts_rule}

NOTES:
{notes}`;

const tpl = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

export const lang = (l: string) => I18N[l] || I18N[DEFAULT_LANG] || I18N.en;

function promptVars(info: VideoInfo, question: string, l: string, mode: Mode) {
  const loc = lang(l);
  const ts = (info.duration || 0) >= 3600 ? "h:mm:ss" : "m:ss";
  const q = question.trim();
  let sections: string, task: string;
  if (mode === "both") {
    // Content first, then the card. That order on purpose: what the video says is what
    // you read, and how it was made is what you consult.
    sections = `${SECTIONS_SUMMARY}\n\n${SECTIONS_TEARDOWN}${q ? `\n\n${SECTION_TRANSFER}` : ""}`;
    task = `Two jobs in one pass, for a reader studying this channel.
First, what the video actually says, for someone who will NOT watch it.
Then, how it is made, as the filled-in card.
${TEARDOWN_TASK}`
      + (q ? `\nThe reader is about to film about: ${q}\nWhere a choice would not survive that move, say so and say why. Do not write their script.` : "");
  }
  else if (mode === "teardown") {
    // A topic no longer buys a rewritten script (see SECTIONS_TEARDOWN). It buys judgement:
    // which of these choices survive a move to your subject and which were load-bearing for
    // theirs. That is the difference between a formula and a copy. It is a section of its
    // own so that the card above stays identical across every video — a card that grows an
    // extra field when a topic happens to be filled in is no longer comparable.
    sections = q ? `${SECTIONS_TEARDOWN}\n\n${SECTION_TRANSFER}` : SECTIONS_TEARDOWN;
    task = q
      ? `${TEARDOWN_TASK}\nThe reader is about to film about: ${q}\nWhere a choice would not survive that move, say so and say why. Do not write their script.`
      : TEARDOWN_TASK;
  }
  else if (q) { sections = SECTIONS_QUESTION; task = `The user will NOT watch it. They want to know:\n\nQUESTION: ${q}\n`; }
  else { sections = SECTIONS_SUMMARY; task = "Write a summary for someone who will NOT watch it."; }
  return {
    title: info.title, channel: info.channel, duration: fmt(info.duration || 0),
    lang: loc.name, question: q, ts_rule: tpl(TS_RULE, { ts }), task,
    sections: tpl(sections, { ts, topic: q || "the same niche as this video", ...loc.sections }),
  };
}

/** Part notes use part-relative [m:ss]; rewrite them as positions in the full video.
 *  A timestamp past the end of the part must already be absolute, so it is left alone. */
export function shiftTimestamps(text: string, offset: number, length: number): string {
  return text.replace(/\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/g, (_m, h, m, s) => {
    const t = (parseInt(h || "0", 10)) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10);
    return `[${fmt(t > length + 5 ? t : offset + t)}]`;
  });
}

/** Cut a line that has stopped saying anything.
 *
 *  The failure looks like this, verbatim from a real run: a bullet about transitions
 *  runs out of substance and keeps going — "thusly therefore consequently subsequently
 *  thereafter followingward onwards upward onward forward ahead aheadward foreward" —
 *  emitting a thesaurus chain until it hits the token ceiling. The reader's verdict was
 *  that it says nothing, and they were right: past a point it literally does not.
 *
 *  This is a guard, not a cure, and it is deliberately dumb: whatever makes the model
 *  drift, a clause running this long without punctuation is not prose any more. Cutting
 *  at the last sentence that ended properly leaves the part that was still saying
 *  something and drops the rest, with a line admitting it happened — a silent truncation
 *  would just be a quieter way of printing nonsense.
 */
export function trimRunOn(text: string, maxSentenceWords = 120): string {
  let cut = false;
  const out = text.split("\n").map((line) => {
    // Length alone is the wrong test — a healthy paragraph can run long, and an early
    // version of this guard mangled good text for exactly that reason. The signal that
    // actually separates the two is punctuation: normal prose comes up for air, and the
    // collapse does not. Six hundred words without a full stop is the collapse; six
    // hundred words containing forty sentences is just a long paragraph.
    //
    // 120 is chosen from the gap, not from taste: across the saved runs the longest
    // sentence anyone actually wrote was 69 words, and the collapse was 602. There is
    // no real prose in between, so the threshold sits in the empty middle with room
    // on both sides.
    const sentences = line.split(/(?<=[.!?])\s+/);
    const bad = sentences.findIndex((s) => s.split(/\s+/).filter(Boolean).length > maxSentenceWords);
    if (bad === -1) return line;
    cut = true;
    const kept = sentences.slice(0, bad).join(" ").trimEnd();
    // Keep the opening words of the offending sentence: it usually starts as a real
    // answer ("Hard cuts dominate…") and only drifts later, and throwing the whole
    // thing away would lose the part that was true.
    const opening = sentences[bad].split(/\s+/).filter(Boolean).slice(0, 25).join(" ");
    return `${kept}${kept ? " " : ""}${opening} …`.trimStart();
  }).join("\n");
  return cut
    ? `${out}\n\n_One passage was cut here: the model stopped forming sentences and ran on into unrelated words._`
    : out;
}

const videoPart = (url: string, fps: number): Content => ({ type: "video_url", video_url: { url }, fps });

// ── the main job ───────────────────────────────────────────────────────────────
export interface WatchEvents {
  onEvent?: (name: string, data: Record<string, unknown>) => void;
  onToken?: (text: string) => void;
}

export async function watch(
  key: string, info: VideoInfo, src: string,
  question: string, l: string, mode: Mode, ev: WatchEvents = {},
): Promise<{ answer: string; stats: WatchStats }> {
  const v = promptVars(info, question, l, mode);
  const fps = fpsFor(info.duration || 0);
  const ps = await splitParts(info, src);
  ev.onEvent?.("parts", { n: ps.length, starts: ps.map((p) => p.start) });

  const uploads = await Promise.all(ps.map((p) => upload(p.file, key)));
  const reused = uploads.every((u) => u.reused);
  ev.onEvent?.("uploaded", { reused });

  const tokens = { in: 0, out: 0 };
  ev.onEvent?.("watch", { n: ps.length, fps });

  let answer: string;
  if (ps.length === 1) {
    const r = await streamOmni(key, [videoPart(uploads[0].url, fps), { type: "text", text: tpl(WHOLE, v) }], ev.onToken);
    answer = r.text; tokens.in += r.usage.in; tokens.out += r.usage.out;
  } else {
    const seconds = info.duration || 0;
    // Notes taken per part have to carry whatever the final document will need, so a
    // "both" run must not come back with only half of it recorded.
    const focus = mode === "teardown" ? FOCUS_TEARDOWN
      : mode === "both" ? `${FOCUS_SUMMARY}\n${FOCUS_TEARDOWN}`
      : v.question ? tpl(FOCUS_QUESTION, { question: v.question }) : FOCUS_SUMMARY;

    const notes = await Promise.all(ps.map(async (p, i) => {
      const end = i + 1 < ps.length ? ps[i + 1].start : seconds;
      const text = tpl(PART, { ...v, i: i + 1, n: ps.length, focus });
      const r = await streamOmni(key, [videoPart(uploads[i].url, fps), { type: "text", text }]);
      ev.onEvent?.("part_done", { i });
      tokens.in += r.usage.in; tokens.out += r.usage.out;
      return shiftTimestamps(r.text, p.start, end - p.start);
    }));

    ev.onEvent?.("merge", {});
    const joined = notes.map((n, i) => `### Part ${i + 1} (from ${fmt(ps[i].start)})\n${n}`).join("\n\n");
    const r = await streamOmni(key, [{ type: "text", text: tpl(MERGE, { ...v, n: ps.length, notes: joined }) }], ev.onToken);
    answer = r.text; tokens.in += r.usage.in; tokens.out += r.usage.out;
  }
  // Last thing before it is shown, cached or written to the vault: a collapsed passage
  // must not reach any of the three, because all three are read as if they meant something.
  return { answer: trimRunOn(answer), stats: { parts: ps.length, fps, reused, ...tokens } };
}

// ── the Obsidian vault ─────────────────────────────────────────────────────────
// Every other Agent OS tab logs what it produced into the user's vault, so the
// agents can read each other's work and the user keeps it after the dashboard is
// closed. Same resolution order as Agent OS itself, reimplemented here so the module
// stays free of imports from the host.

let VAULT: string | null | undefined;

export function vaultRoot(): string | null {
  if (VAULT !== undefined) return VAULT;
  const candidates: string[] = [];
  try {
    const cfg = JSON.parse(readFileSync(
      path.join(os.homedir(), ".agentic-os", "config.json"), "utf8"));
    if (typeof cfg.vaultRoot === "string") candidates.push(cfg.vaultRoot);
  } catch { /* no config.json */ }
  if (process.env.AGENTIC_OS_VAULT) candidates.push(process.env.AGENTIC_OS_VAULT);
  candidates.push(
    path.join(os.homedir(), "Documents", "Obsidian Vault"),
    path.join(os.homedir(), "Obsidian"),
    path.join(os.homedir(), "Obsidian Vault"),
  );
  VAULT = candidates.find((c) => c && existsSync(c)) || null;
  return VAULT;
}

/** Append a block to <vault>/<folder>/<YYYY-MM-DD>.md, creating the day's file with a
 *  one-line explanation of where it came from. Best effort: no vault, no problem. */
export async function logToVault(folder: string, block: string, intro: string): Promise<string | null> {
  const root = vaultRoot();
  if (!root) return null;
  try {
    const dir = path.join(root, folder);
    await mkdir(dir, { recursive: true });
    const d = new Date();
    const day = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const file = path.join(dir, `${day}.md`);
    if (!existsSync(file)) {
      await writeFile(file, `# ${folder} — ${day}\n\n> ${intro}\n\n${block}`);
    } else {
      await writeFile(file, `\n${block}`, { flag: "a" });
    }
    return file;
  } catch {
    return null; // the vault may be read-only or syncing; never fail a run over it
  }
}

/** One markdown file per video; every question is appended as its own section. */
export async function save(info: VideoInfo, url: string, question: string, answer: string, l: string, mode: Mode) {
  await mkdir(OUT_ROOT, { recursive: true });
  const md = path.join(OUT_ROOT, `${info.id}.md`);
  if (!existsSync(md)) {
    await writeFile(md, `# ${info.title}\n\n${info.channel} · ${fmt(info.duration || 0)} · ${url}\n`);
  }
  const loc = lang(l);
  const q = question.trim();
  const heading = mode === "both"
    ? `📼 ${loc.ui.bothCard || "What it says, and how it is made"}${q ? ` — ${q}` : ""}`
    : mode === "teardown"
    ? `🔧 ${loc.ui.teardownCard}${q ? ` — ${q}` : ""}`
    : q ? `❓ ${q}` : `📋 ${loc.ui.summaryCard}`;
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  await writeFile(md, `\n---\n\n# ${heading}\n\n_${when}_\n\n${answer}\n`, { flag: "a" });

  // Also into the vault, the way every other Agent OS tab logs its work, so the
  // agents can read it and it outlives the dashboard.
  await logToVault(
    "OmniWatch",
    `## ${heading}\n\n**${info.title}** — ${info.channel} · ${fmt(info.duration || 0)}\n${url}\n\n${answer}\n`,
    "Auto-logged by OmniWatch (Agent OS) — what Qwen Omni saw and heard in each video, appended per run.",
  );
  return md;
}
