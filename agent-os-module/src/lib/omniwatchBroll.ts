// B-roll from Wan, through kie.ai.
//
// Why this exists: the Director knows two b-roll engines, MiniMax and Grok, and both are
// an OAuth sign-in this machine does not have. A run therefore produced a film with an
// empty background, and the only way anyone got footage into it was by pasting URLs in by
// hand, which is not a pipeline. Wan answers in the frame it was asked for — a 9:16
// request comes back 720x1280 — so a portrait reference no longer has to be cropped.
//
// kie.ai rather than fal.ai on the owner's instruction: same models, materially cheaper.
// The call shape is Agent OS's existing one for images (createTask → recordInfo), kept
// deliberately identical so there is one way this project talks to kie.
//
// The clip is downloaded into OmniWatch's own asset store rather than passed on as a
// provider URL: those expire, and an edit that stops rendering next week because a CDN
// forgot the file is worse than the disk it costs.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newAssetName, saveAssetBytes, sniffMedia, MAX_ASSET_BYTES } from "@/lib/omniwatchAssets";

const KIE_BASE = "https://api.kie.ai/api/v1";
/** Wan 2.2 A14B turbo: Alibaba's fast tier. */
export const WAN_MODEL = "wan/2-2-a14b-text-to-video-turbo";
/** Grok Imagine 1.5: the default, because it is materially cheaper per clip and testing a
 *  format means making the same clip many times over. Wan stays reachable for a slot that
 *  needs it. */
export const GROK_MODEL = "grok-imagine/text-to-video";

export type VideoModel = "grok" | "wan";
export const VIDEO_MODELS: VideoModel[] = ["grok", "wan"];
const VIDEO_MODEL_ID: Record<VideoModel, string> = { grok: GROK_MODEL, wan: WAN_MODEL };
/** Grok refuses anything under six seconds — measured, not read: a five-second request
 *  comes back "Value must be within the specified range". */
export const GROK_MIN_SECONDS = 6;

/** The still models kie serves, by the name we ask for them under.
 *
 *  Grok Imagine is the default for stills: same house as the default video model, and
 *  materially cheaper than GPT Image for the many layout pictures a format needs. GPT Image
 *  2.5 (Flare / Sunburst) stays reachable when a slot needs it; Nano Banana remains the
 *  rock-bottom tier for tiny throwaway graphics. */
export type StillModel = "grok" | "gpt-image-2.5" | "gpt-image-2.5-sunburst" | "nano-banana";
export const STILL_MODELS: StillModel[] = ["grok", "gpt-image-2.5", "gpt-image-2.5-sunburst", "nano-banana"];
const STILL_MODEL_ID: Record<StillModel, string> = {
  grok: "grok-imagine/text-to-image",
  "gpt-image-2.5": "gpt-image-2-5-flare-text-to-image",
  "gpt-image-2.5-sunburst": "gpt-image-2-5-sunburst-text-to-image",
  "nano-banana": "nano-banana-2",
};

/** The frames kie will render a still in. A region's rect rarely matches one exactly, so
 *  the caller picks the nearest and the composer's own box does the final cropping. */
export type StillAspect = "1:1" | "9:16" | "16:9" | "4:5" | "3:2" | "2:3";
export const STILL_ASPECTS: StillAspect[] = ["1:1", "9:16", "16:9", "4:5", "3:2", "2:3"];
const STILL_RATIO: Record<StillAspect, number> = {
  "1:1": 1, "9:16": 9 / 16, "16:9": 16 / 9, "4:5": 0.8, "3:2": 1.5, "2:3": 2 / 3,
};

/** The listed frame closest to a region's own shape, compared in log space so that being
 *  twice too wide and twice too tall are the same size of mistake. */
export function nearestStillAspect(w: number, h: number): StillAspect {
  if (!(w > 0) || !(h > 0)) return "1:1";
  const want = Math.log(w / h);
  return STILL_ASPECTS.reduce((best, a) =>
    Math.abs(Math.log(STILL_RATIO[a]) - want) < Math.abs(Math.log(STILL_RATIO[best]) - want) ? a : best, "1:1" as StillAspect);
}

export const MAX_PROMPT = 2000;
const POLL_MS = 5_000;
const MAX_WAIT_MS = 8 * 60_000;
const STILL_WAIT_MS = 4 * 60_000;

/** The frames each video model will render in. Measured against the provider, not assumed:
 *  a 1:1 request to Wan came back "aspect_ratio is not within the range of allowed
 *  options", while Grok takes it. A slot whose box fits neither is served by the nearest
 *  frame that model actually has. */
export type Aspect = "9:16" | "16:9" | "1:1" | "2:3" | "3:2";
export const VIDEO_ASPECTS: Record<VideoModel, Aspect[]> = {
  grok: ["9:16", "16:9", "1:1", "2:3", "3:2"],
  wan: ["9:16", "16:9"],
};
/** Every frame some video model will take; a request is still checked against its own. */
export const ASPECTS: Aspect[] = VIDEO_ASPECTS.grok;

/** Server-side only, never logged, never returned to a caller. The lookup order is the
 *  one Agent OS already uses for kie, duplicated rather than imported so that installing
 *  this module into a tree without that lib is a missing feature, not a build error. */
export async function kieKey(): Promise<string | null> {
  const env = process.env.KIE_API_KEY?.trim();
  if (env) return env;
  try {
    const k = JSON.parse(await readFile(path.join(os.homedir(), ".agentic-os", "kie", "credentials.json"), "utf8")).apiKey;
    if (typeof k === "string" && k.trim().length > 10) return k.trim();
  } catch { /* fall through */ }
  const hermes = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  for (const file of [path.join(hermes, ".env"), path.join(os.homedir(), ".fcc", ".env")]) {
    try {
      const m = (await readFile(file, "utf8")).match(/^KIE_API_KEY=(.+)$/m);
      if (m && m[1].trim().length > 10) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* not there — try the next one */ }
  }
  return null;
}

/** The download URL arrives in the provider's answer, so it is a value we did not choose.
 *  https only, and never a name that resolves inside this machine or a private network. */
export function resultUrlAllowed(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h === "[::1]") return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      const [a, b] = h.split(".").map(Number);
      if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return false;
    }
    return true;
  } catch { return false; }
}

async function kieJson(url: string, key: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || (typeof j.code === "number" && j.code !== 200)) {
    throw new Error(`kie.ai ${r.status}: ${String(j.msg ?? j.message ?? "request failed")}`);
  }
  return j;
}

export type ClipResult =
  | { ok: true; name: string; url: string; bytes: number }
  | { ok: false; error: string; status?: number };

const NOT_CONNECTED =
  "kie.ai is not connected — add KIE_API_KEY to ~/.hermes/.env (or ~/.agentic-os/kie/credentials.json).";

/** Submit a kie job, wait for it, fetch what it made, store it.
 *
 *  Video and stills differ only in the model and the family of bytes we will accept, so
 *  they share this: one way this module talks to kie, one place the deadline and the URL
 *  check live. `want` is checked against the BYTES, never the provider's word for them. */
async function kieAsset(
  model: string, input: Record<string, unknown>, want: "video" | "image", waitMs: number,
): Promise<ClipResult> {
  const key = await kieKey();
  if (!key) return { ok: false, status: 503, error: NOT_CONNECTED };

  let taskId: string;
  try {
    const created = await kieJson(`${KIE_BASE}/jobs/createTask`, key, { model, input });
    taskId = String((created.data as Record<string, string> | undefined)?.taskId ?? "");
  } catch (e) { return { ok: false, error: String((e as Error).message || e), status: 502 }; }
  if (!taskId) return { ok: false, error: "kie.ai returned no taskId", status: 502 };

  // Polled to a deadline rather than a count, so a slow queue is waited out and a stuck
  // one still ends.
  const deadline = Date.now() + waitMs;
  let src = "";
  while (Date.now() < deadline && !src) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let d: Record<string, unknown>;
    try {
      d = ((await kieJson(`${KIE_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, key)).data ?? {}) as Record<string, unknown>;
    } catch { continue; } // transient poll errors — keep waiting
    if (d.state === "fail") {
      return { ok: false, error: `${model} failed: ${String(d.failMsg || d.failCode || "unknown")}`, status: 502 };
    }
    if (d.state !== "success") continue;
    const rj = JSON.parse(String(d.resultJson || "{}")) as { resultUrls?: string[] };
    src = rj.resultUrls?.[0] ?? "";
    if (!src) return { ok: false, error: "kie.ai finished without a result URL", status: 502 };
  }
  if (!src) return { ok: false, error: `${model} did not finish in time`, status: 504 };
  if (!resultUrlAllowed(src)) return { ok: false, error: "The result URL is not a public https address", status: 502 };

  const dl = await fetch(src, { redirect: "error", signal: AbortSignal.timeout(180_000) }).catch(() => null);
  if (!dl || !dl.ok) return { ok: false, error: "Could not download the result", status: 502 };
  const buf = new Uint8Array(await dl.arrayBuffer());
  if (buf.byteLength === 0) return { ok: false, error: "The result came back empty", status: 502 };
  if (buf.byteLength > MAX_ASSET_BYTES) return { ok: false, error: "The result is larger than the asset cap", status: 413 };

  // The bytes decide the type, not the provider's word for it.
  const mime = sniffMedia(buf.subarray(0, 32));
  if (!mime || !mime.startsWith(`${want}/`)) return { ok: false, error: `What came back is not ${want === "video" ? "a video" : "an image"}`, status: 502 };
  const name = newAssetName(mime);
  if (!name) return { ok: false, error: "Unsupported media type", status: 502 };
  const saved = await saveAssetBytes(buf, name);
  return { ok: true, name: saved.name, url: `/api/omniwatch/assets?file=${encodeURIComponent(saved.name)}`, bytes: saved.bytes };
}

/** One clip, start to finish.
 *
 *  `seconds` is what the SLOT needs. It is passed on where the model takes a length and
 *  raised to that model's floor, because a clip shorter than its slot leaves the rest of
 *  the box frozen; anything still short is looped when the project is assembled. */
export function videoClip(
  prompt: string,
  aspect: Aspect = "9:16",
  opts: { model?: VideoModel; resolution?: "480p" | "720p"; seconds?: number } = {},
): Promise<ClipResult> {
  const model = opts.model ?? "grok";
  const resolution = opts.resolution ?? "720p";
  if (!VIDEO_ASPECTS[model].includes(aspect)) {
    return Promise.resolve({ ok: false, status: 400,
      error: `${model} renders ${VIDEO_ASPECTS[model].join(", ")}, not ${aspect}` });
  }
  const input: Record<string, unknown> = { prompt, aspect_ratio: aspect, resolution };
  if (model === "grok") {
    input.duration = Math.max(GROK_MIN_SECONDS, Math.round(opts.seconds ?? GROK_MIN_SECONDS));
  }
  return kieAsset(VIDEO_MODEL_ID[model], input, "video", MAX_WAIT_MS);
}

/** Wan specifically. Kept because a caller that wants Alibaba's model should be able to
 *  say so without knowing what the default happens to be this month. */
export function wanClip(
  prompt: string, aspect: Aspect = "9:16", resolution: "480p" | "720p" = "720p",
): Promise<ClipResult> {
  return videoClip(prompt, aspect, { model: "wan", resolution });
}

/** One still.
 *
 *  A blueprint asks for far more pictures than clips — a tier row, an inset card, a joke
 *  graphic — and paying video prices for something that never moves is waste. These are
 *  the slots a format leaves open, so this is the call that fills most of them. */
export function kieStill(
  prompt: string, aspect: StillAspect = "1:1", model: StillModel = "grok",
): Promise<ClipResult> {
  const input: Record<string, unknown> = { prompt, aspect_ratio: aspect };
  // GPT Image family wants an explicit resolution tier; Grok / Nano Banana do not.
  if (model === "gpt-image-2.5" || model === "gpt-image-2.5-sunburst") input.resolution = "1K";
  if (model === "nano-banana") input.output_format = "png";
  return kieAsset(STILL_MODEL_ID[model], input, "image", STILL_WAIT_MS);
}
