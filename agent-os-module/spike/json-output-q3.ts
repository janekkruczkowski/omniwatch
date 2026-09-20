// Retry-only companion for Q3/Q4 (the long-video prose vs JSON comparison), because the
// first full run hit a transient socket error partway through Q3. Reuses the same
// functions/prompts, just skips Q1/Q2 so we don't re-pay for them. Still owned by spike/.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API = "https://dashscope-intl.aliyuncs.com";
const MODEL = "qwen3.8-omni-flash";
const CACHE = path.join(os.homedir(), ".agentic-os", "omniwatch", "cache");
const PRICE_IN = 0.15 / 1e6, PRICE_OUT = 0.47 / 1e6;

async function apiKey(): Promise<string> {
  const env = process.env.DASHSCOPE_API_KEY?.trim();
  if (env) return env;
  const m = (await readFile(path.join(os.homedir(), ".hermes", ".env"), "utf8")).match(/^DASHSCOPE_API_KEY=(.+)$/m);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  throw new Error("no key");
}
async function cachedUpload(id: string) {
  const dir = path.join(CACHE, id);
  const info = JSON.parse(await readFile(path.join(dir, "info.json"), "utf8"));
  const oss = JSON.parse(await readFile(path.join(dir, "oss.json"), "utf8"));
  const key = Object.keys(oss).find((k) => k === "source.mp4") || Object.keys(oss)[0];
  const fps = (info.duration || 0) <= 180 ? 10 : 2;
  return { url: oss[key].url, fps, duration: info.duration || 0, title: info.title };
}
async function callOmni(key: string, content: any[], maxTokens: number, attempts = 3) {
  for (let a = 1; a <= attempts; a++) {
    try {
      const r = await fetch(`${API}/compatible-mode/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-DashScope-OssResourceResolve": "enable" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }], modalities: ["text"], stream: true,
          stream_options: { include_usage: true }, enable_thinking: false, max_tokens: maxTokens }),
      });
      if (!r.ok || !r.body) { const t = await r.text(); return { text: "", usage: { in: 0, out: 0 }, status: r.status, rawError: t.slice(0, 800) }; }
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let buf = "", text = ""; const usage = { in: 0, out: 0 };
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim(); if (!payload || payload === "[DONE]") continue;
          let ev: any; try { ev = JSON.parse(payload); } catch { continue; }
          const delta = ev.choices?.[0]?.delta?.content; if (delta) text += delta;
          if (ev.usage) { usage.in += ev.usage.prompt_tokens || 0; usage.out += ev.usage.completion_tokens || 0; }
        }
      }
      return { text, usage, status: r.status };
    } catch (e) {
      if (a === attempts) throw e;
      await new Promise((res) => setTimeout(res, 3000 * a));
    }
  }
  throw new Error("unreachable");
}
function tryParseJson(text: string) {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)```$/); if (fence) t = fence[1].trim();
  try { JSON.parse(t); return { ok: true, err: undefined as string | undefined }; } catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
}
function degenerationHits(text: string) {
  const chunks = text.split(/(?<=[.!?"])\s+|\\n/); let hits = 0;
  for (const c of chunks) { const words = c.split(/\s+/).filter(Boolean); if (words.length > 120 && !/[.!?]["']?$/.test(c.trim())) hits++; }
  return hits;
}
function fmt(sec: number) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; }

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
function prosePrompt(v: { title: string; duration: string }) {
  return `You are watching the whole video "${v.title}" (${v.duration}). Watch AND listen.
${TEARDOWN_TASK}
Write Markdown with a card as exactly ten lines "**Field:** value — [ts] evidence" for these fields:
${CARD_FIELDS.replace(/^- /gm, "**").replace(/: /, ":** ")}
Then a "## Beats" section: 5-12 bullets starting with [ts], every beat/shot — what is shown, what is said.
Then a "## On-screen text" section: every piece of on-screen text worth copying, with [ts].
Timestamps written like [m:ss].`;
}
function jsonPrompt(v: { title: string; duration: string }) {
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

async function main() {
  const key = await apiKey();
  const out: string[] = [];
  const say = (s: string) => { console.log(s); out.push(s); };
  let inTok = 0, outTok = 0;

  const longId = "ymgH8jS6Wb8";
  const long = await cachedUpload(longId);
  say(`## Q3/Q4 retry — ${longId} "${long.title}" (${long.duration}s, fps ${long.fps})\n`);

  say("Calling PROSE variant...");
  const prose = await callOmni(key, [
    { type: "video_url", video_url: { url: long.url }, fps: long.fps },
    { type: "text", text: prosePrompt({ title: long.title, duration: fmt(long.duration) }) },
  ], 4000);
  inTok += prose.usage.in; outTok += prose.usage.out;
  say(`  status ${prose.status}, ${prose.usage.in} in / ${prose.usage.out} out`);

  say("Calling JSON variant...");
  const jsonCard = await callOmni(key, [
    { type: "video_url", video_url: { url: long.url }, fps: long.fps },
    { type: "text", text: jsonPrompt({ title: long.title, duration: fmt(long.duration) }) },
  ], 4000);
  inTok += jsonCard.usage.in; outTok += jsonCard.usage.out;
  say(`  status ${jsonCard.status}, ${jsonCard.usage.in} in / ${jsonCard.usage.out} out`);

  say("\n### PROSE variant — raw output\n```\n" + prose.text + "\n```\n");
  say("### JSON variant — raw output\n```\n" + jsonCard.text + "\n```\n");

  const jsonParse = tryParseJson(jsonCard.text);
  say(`JSON variant parses: ${jsonParse.ok ? "yes" : `no (${jsonParse.err})`}`);
  say(`Degeneration hits — prose: ${degenerationHits(prose.text)}, JSON: ${degenerationHits(jsonCard.text)}`);
  say(`Output length — prose: ${prose.text.length} chars / ${prose.usage.out} tokens, JSON: ${jsonCard.text.length} chars / ${jsonCard.usage.out} tokens`);
  say(`\nThis retry's cost: $${(inTok * PRICE_IN + outTok * PRICE_OUT).toFixed(4)} (${inTok} in / ${outTok} out tokens)`);

  await appendFile(path.join(path.dirname(new URL(import.meta.url).pathname), "report.md"), "\n\n" + out.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
