import { NextResponse } from "next/server";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { validateBlueprint } from "@/lib/omniwatchBlueprint";
import { verifyBlueprint } from "@/lib/omniwatchVerify";
import { videoDir } from "@/lib/omniwatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

// POST /api/omniwatch/verify { blueprint, sourceId, at?: [seconds] }
//   → { ok, blueprint, checks, corrected, frames }
//
// The step between watching and building. A capture is a claim about where things are, and
// until now it went into a render unexamined — which is how a caption band ended up ninety
// pixels above the caption and nobody found out until the film was finished.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const MAX_AT = 6;

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) return NextResponse.json({ error: "Send a JSON object with a blueprint and a sourceId." }, { status: 400 });

  const checked = validateBlueprint(parsed.blueprint);
  if (!checked.ok) return NextResponse.json({ error: `blueprint: ${checked.error}` }, { status: 400 });
  const bp = checked.blueprint;

  const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId.trim() : "";
  if (!sourceId) return NextResponse.json({ error: "sourceId required — the watched video to check against" }, { status: 400 });
  let dir: string;
  try { dir = videoDir(sourceId); } catch { return NextResponse.json({ error: "bad sourceId" }, { status: 400 }); }
  let source = "";
  for (const f of ["master.mp4", "source.mp4"]) {
    if (existsSync(path.join(dir, f))) { source = path.join(dir, f); break; }
  }
  if (!source) return NextResponse.json({ error: "that video is not in the cache any more" }, { status: 404 });

  // Default to a third and two thirds of the way in: far enough from the opening for the
  // format to be fully on screen, and two of them so a region that comes and goes is seen.
  const asked = Array.isArray(parsed.at) ? parsed.at : null;
  const at = (asked ?? [bp.canvas.seconds / 3, (bp.canvas.seconds * 2) / 3])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < bp.canvas.seconds)
    .slice(0, MAX_AT);
  if (!at.length) return NextResponse.json({ error: "no usable seconds to look at" }, { status: 400 });

  const work = await mkdtemp(path.join(tmpdir(), "omni-verify-"));
  const r = await verifyBlueprint(bp, source, at, (name) => path.join(work, name));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 502 });
  return NextResponse.json({
    ok: true, blueprint: r.blueprint, checks: r.checks, corrected: r.corrected,
    frames: r.frames, lookedAt: at,
  });
}
