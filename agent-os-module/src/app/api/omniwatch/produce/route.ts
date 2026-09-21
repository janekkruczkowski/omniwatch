import { NextResponse } from "next/server";
import { validateBlueprint } from "@/lib/omniwatchBlueprint";
import { writeEpisode } from "@/lib/omniwatchEpisode";
import { produce } from "@/lib/omniwatchProduce";
import { STILL_MODELS, VIDEO_MODELS, type StillModel, type VideoModel } from "@/lib/omniwatchBroll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

// POST /api/omniwatch/produce
//   { blueprint, sourceId?, topic?, host?, assets?, audio?, output?, title?,
//     generate?: boolean, videoModel?, stillModel? }
//   → { ok, title, slug, renderUrl, made, supplies, clone }
//
// The whole way from a watched video to a finished project, in one call. A topic rewrites
// the slot values first; then every slot is filled the way the blueprint says it should
// be — drawn for nothing, generated, cut from the source, or left empty and named when it
// needs a file only a person can supply.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const MAX_TOPIC = 400;

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) return NextResponse.json({ error: "Send a JSON object with a blueprint." }, { status: 400 });

  const checked = validateBlueprint(parsed.blueprint);
  if (!checked.ok) return NextResponse.json({ error: `blueprint: ${checked.error}` }, { status: 400 });
  let bp = checked.blueprint;
  const notes = [...checked.notes];

  const topic = typeof parsed.topic === "string" ? parsed.topic.trim() : "";
  if (topic.length > MAX_TOPIC) return NextResponse.json({ error: `topic too long (max ${MAX_TOPIC})` }, { status: 413 });
  let title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "";
  let changed = 0;

  // No topic means a straight reproduction: the captured values stand.
  if (topic) {
    const host = typeof parsed.host === "string" && parsed.host.trim()
      ? parsed.host.trim().slice(0, MAX_TOPIC) : "a different presenter from the reference";
    const w = await writeEpisode(bp, topic, host);
    if (!w.ok) return NextResponse.json({ error: w.error }, { status: w.status ?? 502 });
    bp = w.blueprint;
    changed = w.changed;
    title = title || w.title;
  }

  const videoModel = typeof parsed.videoModel === "string" && (VIDEO_MODELS as string[]).includes(parsed.videoModel)
    ? (parsed.videoModel as VideoModel) : undefined;
  const stillModel = typeof parsed.stillModel === "string" && (STILL_MODELS as string[]).includes(parsed.stillModel)
    ? (parsed.stillModel as StillModel) : undefined;

  const r = await produce(bp, {
    sourceId: typeof parsed.sourceId === "string" ? parsed.sourceId.trim() : undefined,
    title: title || "episode",
    output: isObj(parsed.output) ? parsed.output : null,
    assets: isObj(parsed.assets) ? parsed.assets : undefined,
    audio: typeof parsed.audio === "string" ? parsed.audio : undefined,
    generate: parsed.generate !== false,
    cutSupplies: parsed.cutSupplies === true,
    onlyRegions: Array.isArray(parsed.onlyRegions)
      ? parsed.onlyRegions.filter((r): r is string => typeof r === "string") : undefined,
    resolution: parsed.resolution === "480p" ? "480p" : parsed.resolution === "720p" ? "720p" : undefined,
    videoModel, stillModel,
  });

  if (!r.clone.ok) return NextResponse.json({ error: r.clone.error, made: r.made }, { status: r.clone.status });
  return NextResponse.json({
    ok: true,
    title: title || "episode",
    notes,
    changed,
    slug: r.clone.slug,
    frame: r.clone.frame,
    made: r.made.map((m) => ({ slot: m.slot, kind: m.kind, aspect: m.aspect, seconds: Math.round(m.seconds * 100) / 100, name: m.name, error: m.error, ms: m.ms })),
    supplies: r.supplies,
    cutFromSource: r.clone.cutFromSource,
    missingAssets: r.clone.missingAssets,
    looped: r.clone.looped,
    indexUrl: r.clone.indexUrl,
    renderUrl: "/api/video/hyperframes/render",
    blueprint: bp,
  });
}
