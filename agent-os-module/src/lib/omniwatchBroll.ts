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
/** Wan 2.2 A14B turbo: the cheap, fast text-to-video tier. */
export const WAN_MODEL = "wan/2-2-a14b-text-to-video-turbo";

export const MAX_PROMPT = 2000;
const POLL_MS = 5_000;
const MAX_WAIT_MS = 8 * 60_000;

export type Aspect = "9:16" | "16:9" | "1:1";
export const ASPECTS: Aspect[] = ["9:16", "16:9", "1:1"];

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

/** One clip, start to finish: submit, wait, fetch, store. */
export async function wanClip(
  prompt: string, aspect: Aspect = "9:16", resolution: "480p" | "720p" = "720p",
): Promise<ClipResult> {
  const key = await kieKey();
  if (!key) {
    return { ok: false, status: 503,
      error: "kie.ai is not connected — add KIE_API_KEY to ~/.hermes/.env (or ~/.agentic-os/kie/credentials.json)." };
  }

  let taskId: string;
  try {
    const created = await kieJson(`${KIE_BASE}/jobs/createTask`, key, {
      model: WAN_MODEL,
      input: { prompt, aspect_ratio: aspect, resolution },
    });
    taskId = String((created.data as Record<string, string> | undefined)?.taskId ?? "");
  } catch (e) { return { ok: false, error: String((e as Error).message || e), status: 502 }; }
  if (!taskId) return { ok: false, error: "kie.ai returned no taskId", status: 502 };

  // Polled to a deadline rather than a count, so a slow queue is waited out and a stuck
  // one still ends.
  const deadline = Date.now() + MAX_WAIT_MS;
  let src = "";
  while (Date.now() < deadline && !src) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let d: Record<string, unknown>;
    try {
      d = ((await kieJson(`${KIE_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, key)).data ?? {}) as Record<string, unknown>;
    } catch { continue; } // transient poll errors — keep waiting
    if (d.state === "fail") {
      return { ok: false, error: `Wan failed: ${String(d.failMsg || d.failCode || "unknown")}`, status: 502 };
    }
    if (d.state !== "success") continue;
    const rj = JSON.parse(String(d.resultJson || "{}")) as { resultUrls?: string[] };
    src = rj.resultUrls?.[0] ?? "";
    if (!src) return { ok: false, error: "kie.ai finished without a video URL", status: 502 };
  }
  if (!src) return { ok: false, error: "Wan did not finish in time", status: 504 };
  if (!resultUrlAllowed(src)) return { ok: false, error: "The clip URL is not a public https address", status: 502 };

  const dl = await fetch(src, { redirect: "error", signal: AbortSignal.timeout(180_000) }).catch(() => null);
  if (!dl || !dl.ok) return { ok: false, error: "Could not download the clip", status: 502 };
  const buf = new Uint8Array(await dl.arrayBuffer());
  if (buf.byteLength === 0) return { ok: false, error: "The clip came back empty", status: 502 };
  if (buf.byteLength > MAX_ASSET_BYTES) return { ok: false, error: "The clip is larger than the asset cap", status: 413 };

  // The bytes decide the type, not the provider's word for it.
  const mime = sniffMedia(buf.subarray(0, 32));
  if (!mime || !mime.startsWith("video/")) return { ok: false, error: "What came back is not a video", status: 502 };
  const name = newAssetName(mime);
  if (!name) return { ok: false, error: "Unsupported media type", status: 502 };
  const saved = await saveAssetBytes(buf, name);
  return { ok: true, name: saved.name, url: `/api/omniwatch/assets?file=${encodeURIComponent(saved.name)}`, bytes: saved.bytes };
}
