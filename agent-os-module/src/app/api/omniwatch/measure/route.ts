import { NextResponse } from "next/server";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { validateBlueprint } from "@/lib/omniwatchBlueprint";
import { measureBlueprint } from "@/lib/omniwatchMeasure";
import { videoDir } from "@/lib/omniwatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// POST /api/omniwatch/measure
//   { blueprint, sourceId, at?: number[] }
//   → { ok, format, blueprint, layout, segments, loci, notes, frame? }
//
// Omni says WHAT/WHEN; measure samples the SOURCE film at those timeline loci and
// returns boxes. No authored template substitute.

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) {
    return NextResponse.json({ error: "Send JSON with a blueprint (Omni) and sourceId (film)." }, { status: 400 });
  }
  const checked = validateBlueprint(parsed.blueprint, { preserveGeometry: true });
  if (!checked.ok) return NextResponse.json({ error: `blueprint: ${checked.error}` }, { status: 400 });

  const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId.trim() : "";
  if (!sourceId) {
    return NextResponse.json({ error: "sourceId required — measure needs the original film" }, { status: 400 });
  }
  let sourcePath: string | undefined;
  try {
    const dir = videoDir(sourceId);
    for (const f of ["master.mp4", "source.mp4"]) {
      const pth = path.join(dir, f);
      if (existsSync(pth)) { sourcePath = pth; break; }
    }
  } catch {
    return NextResponse.json({ error: "bad sourceId" }, { status: 400 });
  }
  if (!sourcePath) {
    return NextResponse.json({ error: "that video is not in the cache any more" }, { status: 404 });
  }

  const at = Array.isArray(parsed.at)
    ? parsed.at.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : undefined;

  const work = await mkdtemp(path.join(tmpdir(), "omni-measure-"));
  const r = await measureBlueprint(checked.blueprint, { sourcePath, workDir: work, at });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 500 });
  return NextResponse.json({
    ok: true,
    format: r.format,
    blueprint: r.blueprint,
    layout: r.layout,
    segments: r.segments.map((s) => ({
      at: s.at, start: s.start, end: s.end,
      regions: s.regions,
      hits: s.hits,
    })),
    loci: r.loci,
    contentTracks: r.contentTracks,
    notes: [...checked.notes, ...r.notes],
    frame: r.frame,
    workDir: work,
  });
}
