import { NextResponse } from "next/server";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { validateBlueprint } from "@/lib/omniwatchBlueprint";
import { refineBlueprint } from "@/lib/omniwatchGround";
import { videoDir } from "@/lib/omniwatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

// POST /api/omniwatch/ground { blueprint, sourceId, at?: number[] }
//   → { ok, blueprint, hits, notes, frames }
//
// Measure region boxes on real frames (Qwen VL grounding) and merge into the blueprint.
// Complements /verify: verify checks drawn claims; ground proposes measured boxes.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) return NextResponse.json({ error: "Send a JSON object with a blueprint and a sourceId." }, { status: 400 });

  const checked = validateBlueprint(parsed.blueprint, { preserveGeometry: true });
  if (!checked.ok) return NextResponse.json({ error: `blueprint: ${checked.error}` }, { status: 400 });

  const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId.trim() : "";
  if (!sourceId) return NextResponse.json({ error: "sourceId required" }, { status: 400 });
  let dir: string;
  try { dir = videoDir(sourceId); } catch { return NextResponse.json({ error: "bad sourceId" }, { status: 400 }); }
  let source = "";
  for (const f of ["master.mp4", "source.mp4"]) {
    if (existsSync(path.join(dir, f))) { source = path.join(dir, f); break; }
  }
  if (!source) return NextResponse.json({ error: "video not in cache" }, { status: 404 });

  const at = Array.isArray(parsed.at)
    ? parsed.at.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : undefined;

  const work = await mkdtemp(path.join(tmpdir(), "omni-ground-"));
  const r = await refineBlueprint(checked.blueprint, source, { at, workDir: work });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 502 });
  return NextResponse.json({
    ok: true,
    blueprint: r.blueprint,
    hits: r.hits,
    notes: [...checked.notes, ...r.notes],
    frames: r.frames,
  });
}
