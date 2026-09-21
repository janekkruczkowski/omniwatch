import { NextResponse } from "next/server";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createProject } from "@/lib/videoProjects";
import { validateBlueprint, type BlueprintRegion } from "@/lib/omniwatchBlueprint";
import { composeBlueprint } from "@/lib/omniwatchCompose";
import { videoDir, run } from "@/lib/omniwatch";
import { assetPath } from "@/lib/omniwatchAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

// POST /api/omniwatch/clone
//   { blueprint, sourceId?, fill?: "trace" | "empty" | "assets",
//     assets?: { "<region>" | "<region>:<item>": "<asset store name>" },
//     audio?: "<asset store name>", output?: { width, height }, debugRegions?: boolean }
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
//   "assets" — the slots are filled with material we made: a generated presenter, generated
//              stills, and the blueprint's own text. This is the same geometry carrying a
//              different subject, which is what a format is FOR. Assets are named, never
//              pathed — a name from the OmniWatch store, copied into the project, so a
//              request cannot reach a file it was not given.
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

/** How long a file actually runs, or null if it is not a video at all. */
async function mediaSeconds(file: string): Promise<number | null> {
  try {
    const out = await run("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "format=duration", "-of", "csv=p=0", file], 60_000);
    const n = Number(String(out).trim().split(/\s+/)[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** Repeat a clip until it fills its slot.
 *
 *  Generators answer in their own length — Wan's turbo tier makes five seconds — and a
 *  slot asks for as long as the format says. Drawing a five-second clip in a twenty-second
 *  box leaves the last fifteen frozen, which is the same failure as an empty region, only
 *  harder to see. Looping is the honest default for a background or a presenter; a slot
 *  that must NOT repeat is one whose asset should have been made at full length. */
async function loopTo(src: string, dest: string, seconds: number): Promise<boolean> {
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-stream_loop", "-1", "-i", src,
      "-t", seconds.toFixed(2), "-an", "-c:v", "libx264", "-preset", "veryfast",
      "-pix_fmt", "yuv420p", dest], 600_000);
    return existsSync(dest);
  } catch { return false; }
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

  const fill = parsed.fill === "empty" ? "empty" : parsed.fill === "assets" ? "assets" : "trace";
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

  // Named assets, copied in. The renderer resolves a src against the project directory, so
  // the copy is what makes a generated clip reachable at all; it also means a finished
  // project keeps working after the asset store is cleared.
  const given = new Map<string, string>();
  const missing: string[] = [];
  const looped: string[] = [];
  if (fill === "assets" && isObj(parsed.assets)) {
    // How long each slot is on screen, so a clip that is too short can be made to fill it.
    // A key names either one item ("region:3") or a whole region, and a region's demand is
    // its longest item.
    const span = new Map<string, number>();
    for (const t of bp.tracks) {
      t.items.forEach((it, i) => {
        const d = Math.max(it.end - it.start, 0);
        span.set(`${t.region}:${i}`, d);
        span.set(t.region, Math.max(span.get(t.region) ?? 0, d));
      });
    }
    for (const [slot, raw] of Object.entries(parsed.assets)) {
      if (typeof raw !== "string") continue;
      const from = assetPath(raw.trim());
      if (!from || !existsSync(from)) { missing.push(slot); continue; }
      let name = path.basename(from);
      const want = span.get(slot) ?? 0;
      const have = /\.(mp4|webm|mov|m4v)$/i.test(name) ? await mediaSeconds(from) : null;
      if (have !== null && want > have + 0.25) {
        const out = `loop-${slot.replace(/[^a-z0-9_-]/gi, "")}-${name}`;
        if (await loopTo(from, path.join(assets, out), want)) { name = out; looped.push(slot); }
        else await copyFile(from, path.join(assets, name));
      } else {
        await copyFile(from, path.join(assets, name));
      }
      given.set(slot, `assets/${name}`);
    }
  }
  let audioUrl: string | null = null;
  if (typeof parsed.audio === "string" && parsed.audio.trim()) {
    const from = assetPath(parsed.audio.trim());
    if (from && existsSync(from)) {
      await copyFile(from, path.join(assets, path.basename(from)));
      audioUrl = `assets/${path.basename(from)}`;
    } else missing.push("audio");
  }

  // A trace is a reproduction, so it renders in the frame of the file it copies. The
  // reported canvas is what the model said and the two differ in practice — a capture of a
  // 720x1280 master came back as 576x1024, and rendering at the reported size would have
  // made the benchmark measure the model's guess instead of our geometry.
  // For anything else the caller may ask for a frame: the rects are fractions, so the same
  // blueprint renders at any size, and a capture's reported 576x1024 is a guess, not a
  // ceiling.
  const out = isObj(parsed.output) ? parsed.output : null;
  const asked = out && Number.isFinite(Number(out.width)) && Number.isFinite(Number(out.height))
    ? { w: Math.round(Number(out.width)), h: Math.round(Number(out.height)) } : null;
  const frameSize = size ?? asked;
  const framed: typeof bp = frameSize
    ? { ...bp, canvas: { ...bp.canvas, width: frameSize.w, height: frameSize.h } }
    : bp;

  const html = composeBlueprint(framed, {
    // A cut is the whole region for the whole piece; its timing is already in the pixels.
    // A generated asset is the opposite: it fills one item, on that item's own clock.
    regionAsset: (id) => cutFor.get(id) ?? null,
    assetFor: (t, _it, i) => given.get(`${t.region}:${i}`) ?? given.get(t.region) ?? cutFor.get(t.region) ?? null,
    audioUrl,
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
    filled: given.size,
    looped,
    // Said plainly rather than left as a gap in the picture for someone to find later.
    missingAssets: missing,
    cutFrom: fill === "trace" ? { file: path.basename(source), width: size?.w, height: size?.h } : null,
    indexUrl: `/api/video/preview/project/${encodeURIComponent(slug)}/index.html`,
    renderUrl: "/api/video/hyperframes/render",
  });
}
