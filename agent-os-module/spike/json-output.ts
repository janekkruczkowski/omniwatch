// S7 spike — can Qwen3-Omni-Flash answer JSON instead of prose, and does it cost quality?
// Throwaway. Reads cached uploads from ~/.agentic-os/omniwatch/cache (never re-uploads),
// hits dashscope-intl directly, prints numbers. Nothing here is imported by src/.
//
// Run: node --experimental-strip-types spike/json-output.ts
//
// Owns exactly this file (and the report it writes next to itself). Touches nothing
// under src/, no git writes.

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API = "https://dashscope-intl.aliyuncs.com";
const MODEL = "qwen3.8-omni-flash"; // same model omniwatch.ts uses
const CACHE = path.join(os.homedir(), ".agentic-os", "omniwatch", "cache");
const PRICE_IN = 0.15 / 1e6;
const PRICE_OUT = 0.47 / 1e6;

let totalIn = 0, totalOut = 0, totalCalls = 0;
const log: string[] = [];
function say(s: string) { console.log(s); log.push(s); }

async function apiKey(): Promise<string> {
  const env = process.env.DASHSCOPE_API_KEY?.trim();
  if (env) return env;
  const hermesEnv = path.join(os.homedir(), ".hermes", ".env");
  const m = (await readFile(hermesEnv, "utf8")).match(/^DASHSCOPE_API_KEY=(.+)$/m);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  throw new Error("no DASHSCOPE_API_KEY found (checked env and ~/.hermes/.env)");
}

async function cachedUpload(id: string): Promise<{ url: string; fps: number; duration: number; title: string }> {
  const dir = path.join(CACHE, id);
  const info = JSON.parse(await readFile(path.join(dir, "info.json"), "utf8"));
  const oss = JSON.parse(await readFile(path.join(dir, "oss.json"), "utf8"));
  const key = Object.keys(oss).find((k) => k === "source.mp4") || Object.keys(oss)[0];
  const fps = (info.duration || 0) <= 180 ? 10 : 2;
  return { url: oss[key].url, fps, duration: info.duration || 0, title: info.title };
}

// A minimal, non-retrying version of omniwatch.ts's attemptOmni — this spike does not
// need the retry/backoff machinery, only the request shape and the ability to see raw
// errors (a retry would hide exactly the "does it reject this combination" signal Q1 wants).
async function callOmni(key: string, content: unknown[], opts: {
  responseFormatJson?: boolean; maxTokens?: number;
}): Promise<{ text: string; usage: { in: number; out: number }; status: number; rawError?: string }> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "user", content }],
    modalities: ["text"],
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: false,
    max_tokens: opts.maxTokens ?? 4000,
  };
  if (opts.responseFormatJson) body.response_format = { type: "json_object" };

  const r = await fetch(`${API}/compatible-mode/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    const t = await r.text();
    return { text: "", usage: { in: 0, out: 0 }, status: r.status, rawError: t.slice(0, 800) };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
  const usage = { in: 0, out: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: any;
      try { ev = JSON.parse(payload); } catch { continue; }
      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) text += delta;
      if (ev.usage) { usage.in += ev.usage.prompt_tokens || 0; usage.out += ev.usage.completion_tokens || 0; }
    }
  }
  return { text, usage, status: r.status };
}

function track(usage: { in: number; out: number }) {
  totalIn += usage.in; totalOut += usage.out; totalCalls++;
}

function cost() { return totalIn * PRICE_IN + totalOut * PRICE_OUT; }

// Strip ```json fences a model sometimes adds even when asked for raw JSON.
function tryParseJson(text: string): { ok: boolean; err?: string } {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fence) t = fence[1].trim();
  try { JSON.parse(t); return { ok: true }; } catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
}

// Same degeneration signal omniwatch.ts's trimRunOn() looks for: a "sentence" (here, a
// run of words inside a JSON string value) longer than 120 words with no terminal
// punctuation — the thesaurus-chain collapse, not just a long paragraph.
function degenerationHits(text: string): number {
  const chunks = text.split(/(?<=[.!?"])\s+|\\n/);
  let hits = 0;
  for (const c of chunks) {
    const words = c.split(/\s+/).filter(Boolean);
    if (words.length > 120 && !/[.!?]["']?$/.test(c.trim())) hits++;
  }
  return hits;
}

const TEARDOWN_TASK = `Take this video apart like a creator who wants to make something as good in their own niche.
Record HOW it is made. Base everything strictly on what is said and shown — never invent.
Banned, because they are true of almost every video and so describe none of it: "hard cuts", "fast-paced",
"engaging", "dynamic", "high energy", "keeps the viewer hooked", "modern editing". Say the concrete thing or
say nothing.`;

const CARD_FIELDS = `Exactly these ten fields. Pick the value from the list given for each. Never invent a value.
If the video does not show enough to tell, the value is "unclear". Evidence is at most 20 words and names
something actually seen or heard, with a timestamp in seconds (a number, not a string like "0:13").

- hook_type: one of [bold claim, contradiction, question, result first, problem named, cold demo, number, story open]
- hook_proof: one of [on-screen text, screen recording, physical demo, face only, number on screen, none]
- information_lives_in: one of [speech, what is shown, both same thing, what is shown unsaid]
- pace: string, e.g. "3 cuts/10s, longest shot 6s"
- on_screen: array of any of [talking head, screen recording, b-roll, text cards, product, hands, charts]
- captions: one of [burned-in word by word, burned-in phrases, none, platform auto]
- payoff_lands: one of [within 5s, midway, at the end, never]
- asks_viewer_to: one of [nothing, follow, link in bio, comment a keyword, watch next, buy]
- floor_to_reproduce: one of [phone and captions, screen recorder and captions, camera and lighting, heavy edit]
- load_bearing_choice: one sentence naming the single decision the video would fail without`;

function prosePrompt(v: { title: string; channel: string; duration: string }) {
  return `You are watching the whole video "${v.title}" (${v.duration}). Watch AND listen.
${TEARDOWN_TASK}
Write Markdown with a card as exactly ten lines "**Field:** value — [ts] evidence" for these fields:
${CARD_FIELDS.replace(/^- /gm, "**").replace(/: /, ":** ")}
Then a "## Beats" section: 5-12 bullets starting with [ts], every beat/shot — what is shown, what is said.
Then a "## On-screen text" section: every piece of on-screen text worth copying, with [ts].
Timestamps written like [m:ss].`;
}

function jsonPrompt(v: { title: string; channel: string; duration: string }) {
  return `You are watching the whole video "${v.title}" (${v.duration}). Watch AND listen.
${TEARDOWN_TASK}
Reply with ONLY a single valid JSON object, no markdown fences, no prose before or after. Shape:
{
  "card": { ${CARD_FIELDS.split("\n").filter((l) => l.startsWith("- ")).map((l) => `"${l.slice(2).split(":")[0]}": <value or {"value":...,"ts":<seconds>,"evidence":"..."}>`).join(", ")} },
  "beats": [ {"ts": <seconds>, "text": "what is shown, what is said"} ],
  "on_screen_text": [ {"ts": <seconds>, "text": "..."} ]
}
5-12 beats, covering the whole video. Every ts is a number of seconds, not a formatted string.`;
}

function jsonOnlyPrompt10x(v: { title: string; duration: string }) {
  // Shorter card used for the 10x repeatability test — same risk (does the model hold
  // valid JSON to the end) without paying for the full beats/on_screen_text arrays ten times.
  return `You are watching the whole video "${v.title}" (${v.duration}). Watch AND listen.
${TEARDOWN_TASK}
Reply with ONLY a single valid JSON object, no markdown fences, no prose before or after. Shape:
{ "card": { ${CARD_FIELDS.split("\n").filter((l) => l.startsWith("- ")).map((l) => `"${l.slice(2).split(":")[0]}": "..."`).join(", ")} },
  "beats": [ {"ts": <seconds>, "text": "..."} ] }
3-8 beats. Every ts is a number of seconds.`;
}

function fmt(sec: number) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; }

async function main() {
  const key = await apiKey();
  say(`# S7 spike report — ${new Date().toISOString()}\n`);

  // ── Q1: response_format json_object + stream + modalities:text + video, all at once ──
  say("## Q1 — response_format:json_object together with stream, modalities:text, video input\n");
  const shortId = "t5c28Hsvr_8"; // 47s, cheapest cached video
  const short = await cachedUpload(shortId);
  say(`Using cached video ${shortId} — "${short.title}" (${short.duration}s, fps ${short.fps}).`);
  const q1 = await callOmni(key, [
    { type: "video_url", video_url: { url: short.url }, fps: short.fps },
    { type: "text", text: `Reply with a JSON object {"summary": "one sentence about this video"}.` },
  ], { responseFormatJson: true, maxTokens: 200 });
  track(q1.usage);
  if (q1.status !== 200 && !q1.text) {
    say(`REJECTED — HTTP ${q1.status}: ${q1.rawError}`);
    say(`\n**Answer: no**, dashscope-intl compat mode refused this combination. This settles S7 in favor of "prompt for JSON, don't force it" (see Q2).`);
  } else {
    const parsed = tryParseJson(q1.text);
    say(`ACCEPTED — HTTP ${q1.status}. Response: ${q1.text.slice(0, 300)}`);
    say(`Parses as JSON: ${parsed.ok ? "yes" : `no (${parsed.err})`}`);
    say(`\n**Answer: yes**, the three conditions can be combined.`);
  }
  say(`Cost so far: $${cost().toFixed(4)} (${totalCalls} call${totalCalls === 1 ? "" : "s"}, ${totalIn} in / ${totalOut} out tokens)\n`);

  // ── Q2: prompt-only JSON, 10 tries on the same cached video ──
  say("## Q2 — prompt-only JSON (no response_format), 10 tries on the same video\n");
  let parsedCount = 0;
  const failures: string[] = [];
  const q2Texts: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const r = await callOmni(key, [
      { type: "video_url", video_url: { url: short.url }, fps: short.fps },
      { type: "text", text: jsonOnlyPrompt10x({ title: short.title, duration: fmt(short.duration) }) },
    ], { responseFormatJson: false, maxTokens: 1200 });
    track(r.usage);
    if (r.status !== 200 && !r.text) { say(`  try ${i}: HTTP ${r.status} — ${r.rawError?.slice(0, 200)}`); failures.push(`try ${i}: HTTP error`); continue; }
    const parsed = tryParseJson(r.text);
    q2Texts.push(r.text);
    if (parsed.ok) { parsedCount++; say(`  try ${i}: OK (${r.text.length} chars)`); }
    else { say(`  try ${i}: FAILED to parse — ${parsed.err}`); failures.push(`try ${i}: ${parsed.err} — tail: ${r.text.slice(-150)}`); }
  }
  say(`\n**${parsedCount}/10 parsed as valid JSON first try.**`);
  if (failures.length) say(`Failures:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  const degen10 = q2Texts.reduce((a, t) => a + degenerationHits(t), 0);
  say(`Degeneration hits (120+ word run-on with no terminal punctuation) across the 10 JSON tries: ${degen10}`);
  say(`Cost so far: $${cost().toFixed(4)} (${totalCalls} calls, ${totalIn} in / ${totalOut} out tokens)\n`);

  // ── Q3 & Q4: prose vs JSON, same longer video, side by side ──
  say("## Q3/Q4 — same card, prose vs JSON, on one longer video (content quality + degeneration)\n");
  const longId = "ymgH8jS6Wb8"; // 968s, talking head — has clothing/room to notice
  const long = await cachedUpload(longId);
  say(`Using cached video ${longId} — "${long.title}" (${long.duration}s, fps ${long.fps}).\n`);

  const prose = await callOmni(key, [
    { type: "video_url", video_url: { url: long.url }, fps: long.fps },
    { type: "text", text: prosePrompt({ title: long.title, channel: "", duration: fmt(long.duration) }) },
  ], { responseFormatJson: false, maxTokens: 4000 });
  track(prose.usage);

  const jsonCard = await callOmni(key, [
    { type: "video_url", video_url: { url: long.url }, fps: long.fps },
    { type: "text", text: jsonPrompt({ title: long.title, channel: "", duration: fmt(long.duration) }) },
  ], { responseFormatJson: false, maxTokens: 4000 });
  track(jsonCard.usage);

  say("### PROSE variant — raw output\n```\n" + prose.text + "\n```\n");
  say("### JSON variant — raw output\n```\n" + jsonCard.text + "\n```\n");

  const jsonParse = tryParseJson(jsonCard.text);
  say(`JSON variant parses: ${jsonParse.ok ? "yes" : `no (${jsonParse.err})`}`);
  const proseDegen = degenerationHits(prose.text);
  const jsonDegen = degenerationHits(jsonCard.text);
  say(`Degeneration hits — prose: ${proseDegen}, JSON: ${jsonDegen}`);
  say(`Output length — prose: ${prose.text.length} chars / ${prose.usage.out} tokens, JSON: ${jsonCard.text.length} chars / ${jsonCard.usage.out} tokens`);

  say(`\nFinal cost: $${cost().toFixed(4)} — ${totalCalls} calls total, ${totalIn} input tokens, ${totalOut} output tokens.`);

  const outFile = path.join(path.dirname(new URL(import.meta.url).pathname), "report.md");
  await writeFile(outFile, log.join("\n"));
  say(`\nFull log written to ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
