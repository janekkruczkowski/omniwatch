import { NextResponse } from "next/server";
import { videoClip, kieStill, kieKey, VIDEO_ASPECTS, VIDEO_MODELS, STILL_ASPECTS, STILL_MODELS,
  MAX_PROMPT, type Aspect, type StillAspect, type StillModel, type VideoModel } from "@/lib/omniwatchBroll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A clip takes a minute or two; the default serverless budget would cut it off.
export const maxDuration = 600;

// GET  /api/omniwatch/broll                                 → { available }
// POST /api/omniwatch/broll { prompt, aspect?, kind?, model?, seconds? }
//                                                            → { ok, url, name, provider }
//
// kind "video" (the default) is Wan; kind "image" is a still. A blueprint asks for far
// more pictures than clips — rows, inset cards, joke graphics — and paying video prices
// for something that never moves is waste, so both live behind one route.
//
// The Director's two built-in b-roll engines are an OAuth sign-in away and neither is
// signed in here, which is why a run came out with an empty background. This is the third
// engine, and it lives under OmniWatch rather than inside Agent OS's own studio route so
// the module stays additive: a plain directory copy installs it.

export async function GET() {
  return NextResponse.json({ available: !!(await kieKey()), provider: "wan" });
}

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "Send a JSON object with a prompt." }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return NextResponse.json({ error: "prompt required" }, { status: 400 });
  if (prompt.length > MAX_PROMPT) {
    return NextResponse.json({ error: `prompt too long (max ${MAX_PROMPT})` }, { status: 413 });
  }

  const kind = body.kind === undefined || body.kind === null ? "video" : body.kind;
  if (kind !== "video" && kind !== "image") {
    return NextResponse.json({ error: 'kind must be "video" or "image"' }, { status: 400 });
  }

  // An unknown aspect is a refusal rather than a silent default: a clone rendered in the
  // wrong frame is the exact failure this route was added to stop.
  // A video model's frames are its own, so the model is settled before the frame is judged.
  const rawVideoModel = body.model === undefined || body.model === null || kind === "image"
    ? "grok" : body.model;
  if (kind === "video" && (typeof rawVideoModel !== "string" || !(VIDEO_MODELS as string[]).includes(rawVideoModel))) {
    return NextResponse.json({ error: `model must be one of ${VIDEO_MODELS.join(", ")}` }, { status: 400 });
  }
  const allowed: readonly string[] = kind === "image"
    ? STILL_ASPECTS : VIDEO_ASPECTS[rawVideoModel as VideoModel];
  const rawAspect = body.aspect === undefined || body.aspect === null ? "9:16" : body.aspect;
  if (typeof rawAspect !== "string" || !allowed.includes(rawAspect)) {
    return NextResponse.json({ error: `aspect must be one of ${allowed.join(", ")}` }, { status: 400 });
  }

  if (kind === "image") {
    const rawModel = body.model === undefined || body.model === null ? "gpt-image-2.5" : body.model;
    if (typeof rawModel !== "string" || !(STILL_MODELS as string[]).includes(rawModel)) {
      return NextResponse.json({ error: `model must be one of ${STILL_MODELS.join(", ")}` }, { status: 400 });
    }
    const s = await kieStill(prompt, rawAspect as StillAspect, rawModel as StillModel);
    if (!s.ok) return NextResponse.json({ error: s.error }, { status: s.status ?? 502 });
    return NextResponse.json({ ok: true, provider: rawModel, name: s.name, url: s.url, bytes: s.bytes });
  }

  const rawRes = body.resolution === undefined || body.resolution === null ? "720p" : body.resolution;
  if (rawRes !== "480p" && rawRes !== "720p") {
    return NextResponse.json({ error: "resolution must be 480p or 720p" }, { status: 400 });
  }

  // How long the slot is, so a model that takes a length is asked for the right one.
  const seconds = Number(body.seconds);
  const r = await videoClip(prompt, rawAspect as Aspect, {
    model: rawVideoModel as VideoModel,
    resolution: rawRes,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 502 });
  return NextResponse.json({ ok: true, provider: rawVideoModel, name: r.name, url: r.url, bytes: r.bytes });
}
