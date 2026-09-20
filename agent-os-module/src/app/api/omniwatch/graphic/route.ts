// POST /api/omniwatch/graphic — render a GraphicSpec (ranking / stat / compare / quote)
// to an MP4 and hand back the URL a scene's brollUrl can point at directly.
//
// The existing media route (src/app/api/omniwatch/media/[...path]/route.ts) does not
// fit as-is: it is a catch-all keyed to CACHE_ROOT (video/frame under a video id), and
// this module's file-ownership rule for this task is exactly two new files — this one
// and omniwatchGraphic.ts — so a third file for a [...path] segment under
// api/omniwatch/graphic/ is not an option here. Instead this single route file serves
// its own output too: GET with ?file=<name> streams it back from GRAPHICS_ROOT, same
// range-request/caching shape as the media route's video branch, just without the
// extra path segment that would need a folder of its own.

import { NextResponse } from "next/server";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import path from "node:path";

import { renderGraphic, parseByteRange, validateGraphicSpec, GRAPHICS_ROOT, type GraphicSpec } from "@/lib/omniwatchGraphic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  // Validated in omniwatchGraphic.ts, next to the renderer that depends on the
  // shape, and defensively non-throwing: this call sits outside the try below,
  // so anything that throws here is a 500 instead of a 400 (that was the
  // `items:[null]` bug — `typeof null === "object"` slipped past the item test).
  const err = validateGraphicSpec(body);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  try {
    const file = await renderGraphic(body as GraphicSpec);
    return NextResponse.json({ ok: true, url: `/api/omniwatch/graphic?file=${encodeURIComponent(path.basename(file))}` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not render the graphic." }, { status: 500 });
  }
}

/** Serves a rendered card back out. Mirrors the video branch of
 *  src/app/api/omniwatch/media/[...path]/route.ts (range support, no-store) — this
 *  route only ever serves its own GRAPHICS_ROOT, so it stays a flat GET keyed by a
 *  query param rather than a catch-all path segment (see the file-ownership note
 *  above for why there is no [...path] folder here). */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("file") || "";
  if (!/^[\w-]{1,80}\.mp4$/.test(name)) return new Response("bad path", { status: 400 });
  const abs = path.join(GRAPHICS_ROOT, name);
  if (!existsSync(abs)) return new Response("not found", { status: 404 });

  const s = await stat(abs);
  const total = s.size;
  const headers: Record<string, string> = { "Content-Type": "video/mp4", "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
  const range = req.headers.get("range");

  if (range) {
    const parsed = parseByteRange(range, total);
    if (parsed === "unsatisfiable") {
      return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    if (parsed) {
      const node = createReadStream(abs, { start: parsed.start, end: parsed.end });
      return new Response(Readable.toWeb(node) as NodeReadableStream as ReadableStream, {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${parsed.start}-${parsed.end}/${total}`, "Content-Length": String(parsed.end - parsed.start + 1) },
      });
    }
  }

  const node = createReadStream(abs);
  return new Response(Readable.toWeb(node) as NodeReadableStream as ReadableStream, {
    headers: { ...headers, "Content-Length": String(total) },
  });
}
