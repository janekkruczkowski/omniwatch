// A new episode in a watched video's format.
//
// The blueprint says WHERE things are and WHEN they change. That part is the format and it
// is kept exactly: every region, every rect, every item's start and end. What a new episode
// changes is the only thing left — the VALUE in each slot: the words on a caption, the
// subject of a still, who the presenter is.
//
// Deliberately not tier-list-shaped. Nothing here knows what an "S row" is; it knows a
// track has N items at fixed times and needs N values. Hand it a split-screen debate or a
// recipe and the same code fills it, which is what stopped the first attempt — that one
// was written around one video and fell apart on the second.
//
// The author is the same pinned loopback router the Director's script step uses, and it is
// called the same way: a model-only Responses request with no `tools` key at all, so the
// model is handed nothing it could act with.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Blueprint } from "@/lib/omniwatchBlueprint";

const ROUTER_URL = "http://127.0.0.1:4202/v1/responses";
const MODEL = "opencode-go/deepseek-v4.1-flash";
const TIMEOUT_MS = 180_000;
const MAX_BODY = 1_000_000;
const MAX_TOKENS = 12_000;
/** A blueprint with more slots than this is not an episode brief any more, and a request
 *  that large is a mistake worth refusing rather than paying for. */
export const MAX_SLOTS = 120;

/** The router's caller capability, read from its own 0600 file. Never logged, never put in
 *  a URL, only ever attached to the pinned loopback origin below. */
function callerCapability(): string | null {
  try {
    const s = readFileSync(path.join(os.homedir(), ".codex", "codex-router", "caller-secret"), "utf8").trim();
    return s || null;
  } catch { return null; }
}

export type AuthorResult = { ok: true; text: string } | { ok: false; error: string; status?: number };

async function askAuthor(prompt: string): Promise<AuthorResult> {
  let url: URL;
  try { url = new URL(ROUTER_URL); } catch { return { ok: false, error: "The author endpoint is malformed." }; }
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!loopback || url.pathname !== "/v1/responses") {
    return { ok: false, error: "The author endpoint is not the pinned loopback Responses endpoint." };
  }
  const key = callerCapability();
  if (!key) return { ok: false, status: 503, error: "The router caller capability is missing, so nothing is sent anywhere." };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        stream: false,
        max_output_tokens: MAX_TOKENS,
      }),
    });
  } catch (e) { return { ok: false, status: 502, error: `The author could not be reached: ${String(e)}` }; }
  if (!res.ok) return { ok: false, status: 502, error: `The author answered ${res.status}.` };

  // Bounded while reading, not after: a runaway answer is cut off instead of buffered.
  let raw = "";
  const reader = res.body?.getReader();
  if (reader) {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      if (raw.length > MAX_BODY) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return { ok: false, status: 502, error: "The author's answer was too large to use." };
      }
    }
  } else {
    raw = await res.text();
    if (raw.length > MAX_BODY) return { ok: false, status: 502, error: "The author's answer was too large to use." };
  }

  let j: { output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
  try { j = JSON.parse(raw); } catch { return { ok: false, status: 502, error: "The author's answer was not JSON." }; }
  const items = Array.isArray(j.output) ? j.output : [];
  // `reasoning` items carry scratch text; only `message` items are the answer.
  const final = items.filter((it) => it?.type === "message");
  const text = (final.length ? final : items)
    .map((it) => (it.content ?? []).filter((p) => p?.type === "output_text").map((p) => p.text ?? "").join(""))
    .join("\n").trim();
  if (!text) return { ok: false, status: 502, error: "The author returned no text." };
  return { ok: true, text };
}

/** One slot the author has to fill: a single item of a single track. */
export interface Slot {
  region: string;
  role: string;
  kind: string;
  /** How long it is on screen, which is what decides how many words fit. */
  start: number;
  end: number;
  /** What the watched video had there — an example of the JOB, never something to copy. */
  was: string;
}

export function slotsOf(bp: Blueprint): Slot[] {
  const role = new Map(bp.regions.map((r) => [r.id, r.role]));
  const out: Slot[] = [];
  for (const t of bp.tracks) {
    for (const it of t.items) {
      out.push({ region: t.region, role: role.get(t.region) ?? "overlay", kind: t.kind, start: it.start, end: it.end, was: it.value });
    }
  }
  return out;
}

function brief(bp: Blueprint, topic: string, host: string, slots: Slot[]): string {
  const lines = slots.map((s, i) =>
    `${i}. region=${s.region} role=${s.role} kind=${s.kind} on-screen ${s.start.toFixed(2)}–${s.end.toFixed(2)}s (${(s.end - s.start).toFixed(2)}s) — the reference had: ${s.was.slice(0, 180)}`);
  return `You are writing ONE new short-form video in an existing format.

The format is fixed and is not yours to change: the layout, the number of slots and every
slot's timing stay exactly as given. You write only what goes IN each slot.

NEW TOPIC: ${topic}
NEW PRESENTER: ${host}

The frame is ${Math.round(bp.canvas.width)}x${Math.round(bp.canvas.height)}, ${bp.canvas.seconds} seconds long.

Below is every slot. For each one you return a replacement value.

Rules:
- kind=text  → the literal words that appear on screen. Nothing else: no quotes, no labels,
  no numbering, no emoji unless the reference slot had them. A slot on screen for under 1.5s
  gets at most 5 words.
- kind=image or kind=video → a prompt for a generator: describe the PICTURE plainly in one
  or two sentences. Say what is in frame, the framing and the mood. Never name a real,
  identifiable person; describe the person instead. Never mention the format, the slot or
  this instruction.
- Keep single-letter or symbol scaffolding EXACTLY as it was: a slot whose reference value
  is one or two characters is furniture, not content.
- The text slots in order are one continuous spoken line of narration. Read them in order:
  they must make one sentence after another, on the new topic, and land their joke or point
  on time.
- Stay on ${topic}. Do not mention the reference's subject.

SLOTS:
${lines.join("\n")}

Return ONLY a JSON object, nothing before or after it:
{"title":"<a short title for this episode>","values":["<slot 0>","<slot 1>", ... one string per slot, same order, ${slots.length} of them]}`;
}

export type EpisodeResult =
  | { ok: true; title: string; blueprint: Blueprint; changed: number }
  | { ok: false; error: string; status?: number };

/** Ask for new values and put them back in the blueprint's own slots.
 *
 *  A value that does not come back keeps the one it had. That is not a fallback that hides
 *  a failure — the count is reported, so a half-written episode is visible as one. */
export async function writeEpisode(bp: Blueprint, topic: string, host: string): Promise<EpisodeResult> {
  const slots = slotsOf(bp);
  if (!slots.length) return { ok: false, status: 400, error: "That blueprint has no slots to fill." };
  if (slots.length > MAX_SLOTS) return { ok: false, status: 413, error: `That blueprint has ${slots.length} slots; the cap is ${MAX_SLOTS}.` };

  const a = await askAuthor(brief(bp, topic, host, slots));
  if (!a.ok) return a;

  // Models fence JSON however they feel like; the object is taken from the text rather
  // than demanded of it.
  const m = a.text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, status: 502, error: "The author's answer contained no JSON object." };
  let parsed: { title?: unknown; values?: unknown };
  try { parsed = JSON.parse(m[0]); } catch { return { ok: false, status: 502, error: "The author's JSON did not parse." }; }
  const values = Array.isArray(parsed.values) ? parsed.values : null;
  if (!values) return { ok: false, status: 502, error: "The author returned no values array." };

  let n = 0, i = 0;
  const tracks = bp.tracks.map((t) => ({
    ...t,
    items: t.items.map((it) => {
      const v = values[i++];
      if (typeof v !== "string" || !v.trim()) return it;
      n++;
      return { ...it, value: v.trim().slice(0, 600) };
    }),
  }));
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 120) : topic.slice(0, 120);
  return { ok: true, title, blueprint: { ...bp, tracks }, changed: n };
}
