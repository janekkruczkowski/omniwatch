import { NextResponse } from "next/server";
import { validateBlueprint } from "@/lib/omniwatchBlueprint";
import { writeEpisode, slotsOf } from "@/lib/omniwatchEpisode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/omniwatch/episode { blueprint, topic, host? }
//   → { ok, title, blueprint, changed, slots }
//
// The step between watching and making: a captured blueprint plus a new subject comes back
// as the same blueprint with new values in its slots. Geometry and timing are untouched, so
// what returns can go straight to /api/omniwatch/clone with fill:"assets".

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const MAX_TOPIC = 400;

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) return NextResponse.json({ error: "Send a JSON object with a blueprint and a topic." }, { status: 400 });

  const checked = validateBlueprint(parsed.blueprint);
  if (!checked.ok) return NextResponse.json({ error: `blueprint: ${checked.error}` }, { status: 400 });

  const topic = typeof parsed.topic === "string" ? parsed.topic.trim() : "";
  if (!topic) return NextResponse.json({ error: "topic required" }, { status: 400 });
  if (topic.length > MAX_TOPIC) return NextResponse.json({ error: `topic too long (max ${MAX_TOPIC})` }, { status: 413 });
  const host = typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim().slice(0, MAX_TOPIC) : "a different presenter from the reference";

  const r = await writeEpisode(checked.blueprint, topic, host);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 502 });
  return NextResponse.json({
    ok: true, title: r.title, blueprint: r.blueprint,
    changed: r.changed, slots: slotsOf(checked.blueprint).length,
  });
}
