import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createProject } from "@/lib/videoProjects";
import { validateBlueprint, type BlueprintRegion } from "@/lib/omniwatchBlueprint";
import { composeBlueprint } from "@/lib/omniwatchCompose";
import { videoDir, run } from "@/lib/omniwatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

// POST /api/omniwatch/clone
//   { blueprint, sourceId?, fill?: "trace" | "empty", debugRegions?: boolean }
//   → { ok, slug, indexUrl, renderUrl, regions, cut }
//
// Builds a HyperFrames project from a blueprint, in the blueprint's own frame. Two ways to
// fill the picture regions:
//
//   "trace"  — each region is cut out of the watched file at its own rectangle. Nothing is
//              generated and nothing is invented, so what comes back is the original
//              reassembled from the blueprint's own geometry. That makes it a measurement:
//              if the rects are wrong, the trace looks wrong in exactly the way they are.
//   "empty"  — the boxes are drawn and left unfilled, for checking a layout without cutting
//              anything. Text and colour still render either way.
//
// Rendering is the existing endpoint: POST /api/video/hyperframes/render { slug }.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What the file on disk actually is. The blueprint's canvas is what the model reported and
 *  the two are routinely different — a capture said 576x1024 for a 720x1280 master — so
 *  cropping by the reported size would offset every rectangle. Fractions are fractions; the
 *  pixels they mean belong to the file being cut. */
async function sourceSize(src: string): Promise<{ w: number; h: number } | null> {
  try {
    const out = await run("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", src], 60_000);
    const m = String(out).trim().match(/^(\d+)x(\d+)/);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  } catch { return null; }
}

/** Cut one region's rectangle out of the source for the whole piece. Fractions are turned
 *  into even pixel counts because h264 chroma subsampling refuses odd dimensions. */
async function cutRegion(src: string, dest: string, r: BlueprintRegion, size: { w: number; h: number }): Promise<boolean> {
  const [fx, fy, fw, fh] = r.rect;
  const W = size.w, H = size.h;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  // Clamped to the canvas: a rect may legitimately bleed off the edge, but ffmpeg cannot
  // crop outside the frame.
  const x = Math.min(Math.max(Math.round(fx * W), 0), W - 2);
  const y = Math.min(Math.max(Math.round(fy * H), 0), H - 2);
  const w = even(Math.min(Math.round(fw * W), W - x));
  const h = even(Math.min(Math.round(fh * H), H - y));
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src,
      "-vf", `crop=${w}:${h}:${x}:${y}`, "-an", "-c:v", "libx264", "-preset", "veryfast",
      "-pix_fmt", "yuv420p", dest], 600_000);
    return existsSync(dest);
  } catch { return false; }
}

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) return NextResponse.json({ error: "Send a JSON object with a blueprint." }, { status: 400 });

  const checked = validateBlueprint(parsed.blueprint);
  if (!checked.ok) return NextResponse.json({ error: `blueprint: ${checked.error}` }, { status: 400 });
  const bp = checked.blueprint;

  const fill = parsed.fill === "empty" ? "empty" : "trace";
  const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId.trim() : "";
  if (fill === "trace" && !sourceId) {
    return NextResponse.json({ error: "trace needs sourceId — the watched video to cut from" }, { status: 400 });
  }

  let source = "";
  if (fill === "trace") {
    let dir: string;
    try { dir = videoDir(sourceId); } catch { return NextResponse.json({ error: "bad sourceId" }, { status: 400 }); }
    // The master if it was fetched, otherwise the analysis copy. Said plainly in the answer
    // rather than left for someone to discover in the pixels.
    for (const f of ["master.mp4", "source.mp4"]) {
      if (existsSync(path.join(dir, f))) { source = path.join(dir, f); break; }
    }
    if (!source) return NextResponse.json({ error: "that video is not in the cache any more" }, { status: 404 });
  }

  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "clone";
  const { slug, cwd } = await createProject(title);
  const assets = path.join(cwd, "assets");
  await mkdir(assets, { recursive: true });

  // In a trace EVERY region is cut, not only the ones the model tagged as media. A region
  // whose track was called "text" still occupies a rectangle of the original, and leaving it
  // empty put holes in the picture — nine of seventeen regions drew on the first attempt.
  const cutFor = new Map<string, string>();
  let size: { w: number; h: number } | null = null;
  if (fill === "trace") {
    size = await sourceSize(source);
    if (!size) return NextResponse.json({ error: "could not read the source's dimensions" }, { status: 502 });
    // A region that covers the whole frame is the original, not a part of it. Cutting it and
    // drawing the others on top hid every geometry error underneath a perfect copy — and
    // showed the caption twice, once from the full-frame cut and once from its own. Left
    // out, the trace is a genuine reassembly: a rect that is wrong shows as a gap or a
    // displacement, which is the whole point of measuring this way.
    const covering = (r: BlueprintRegion) => r.rect[2] * r.rect[3] >= 0.95;
    for (const r of bp.regions) {
      if (covering(r)) continue;
      const name = `rg-${r.id.replace(/[^a-z0-9_-]/gi, "")}.mp4`;
      if (await cutRegion(source, path.join(assets, name), r, size)) {
        // Project-root relative: the renderer resolves a src against the project directory,
        // not against the preview server.
        cutFor.set(r.id, `assets/${name}`);
      }
    }
  }

  // A trace is a reproduction, so it renders in the frame of the file it copies. The
  // reported canvas is what the model said and the two differ in practice — a capture of a
  // 720x1280 master came back as 576x1024, and rendering at the reported size would have
  // made the benchmark measure the model's guess instead of our geometry.
  const framed: typeof bp = size
    ? { ...bp, canvas: { ...bp.canvas, width: size.w, height: size.h } }
    : bp;

  const html = composeBlueprint(framed, {
    // A cut is the whole region for the whole piece; its timing is already in the pixels.
    regionAsset: (id) => cutFor.get(id) ?? null,
    assetFor: (t) => cutFor.get(t.region) ?? null,
    debugRegions: parsed.debugRegions === true,
    tracedPixels: fill === "trace",
  });
  await writeFile(path.join(cwd, "index.html"), html);
  await writeFile(path.join(cwd, "hyperframes.json"), JSON.stringify({
    name: slug, composition: "index.html",
    width: Math.round(framed.canvas.width), height: Math.round(framed.canvas.height),
    fps: Math.round(framed.canvas.fps), duration: framed.canvas.seconds,
  }, null, 2));

  return NextResponse.json({
    ok: true, slug, cwd, fill,
    frame: { width: framed.canvas.width, height: framed.canvas.height, seconds: framed.canvas.seconds },
    regions: bp.regions.length,
    cut: cutFor.size,
    cutFrom: fill === "trace" ? { file: path.basename(source), width: size?.w, height: size?.h } : null,
    indexUrl: `/api/video/preview/project/${encodeURIComponent(slug)}/index.html`,
    renderUrl: "/api/video/hyperframes/render",
  });
}
