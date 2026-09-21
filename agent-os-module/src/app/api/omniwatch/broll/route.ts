import { NextResponse } from "next/server";
import { wanClip, kieKey, ASPECTS, MAX_PROMPT, type Aspect } from "@/lib/omniwatchBroll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A clip takes a minute or two; the default serverless budget would cut it off.
export const maxDuration = 600;

// GET  /api/omniwatch/broll                      → { available }  (is a key configured?)
// POST /api/omniwatch/broll { prompt, aspect? }  → { ok, url, name, provider: "wan" }
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

  // An unknown aspect is a refusal rather than a silent default: a clone rendered in the
  // wrong frame is the exact failure this route was added to stop.
  const rawAspect = body.aspect === undefined || body.aspect === null ? "9:16" : body.aspect;
  if (typeof rawAspect !== "string" || !ASPECTS.includes(rawAspect as Aspect)) {
    return NextResponse.json({ error: `aspect must be one of ${ASPECTS.join(", ")}` }, { status: 400 });
  }
  const rawRes = body.resolution === undefined || body.resolution === null ? "720p" : body.resolution;
  if (rawRes !== "480p" && rawRes !== "720p") {
    return NextResponse.json({ error: "resolution must be 480p or 720p" }, { status: 400 });
  }

  const r = await wanClip(prompt, rawAspect as Aspect, rawRes);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 502 });
  return NextResponse.json({ ok: true, provider: "wan", name: r.name, url: r.url, bytes: r.bytes });
}
