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

import { renderGraphic, GRAPHICS_ROOT, type GraphicSpec } from "@/lib/omniwatchGraphic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set(["ranking", "stat", "compare", "quote"]);

function badSpec(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be a GraphicSpec object.";
  const b = body as Record<string, unknown>;
  if (!KINDS.has(String(b.kind))) return `kind must be one of ${[...KINDS].join(", ")}.`;
  if (!Number.isFinite(b.seconds) || Number(b.seconds) <= 0) return "seconds must be a positive number.";
  if (b.kind === "ranking") {
    if (typeof b.title !== "string" || !b.title.trim()) return "ranking needs a title.";
    if (!Array.isArray(b.items) || !b.items.length) return "ranking needs at least one item.";
    if (b.items.some((i) => typeof i !== "object" || typeof (i as { label?: unknown }).label !== "string")) {
      return "every ranking item needs a string label.";
    }
  }
  if (b.kind === "stat") {
    if (typeof b.title !== "string" || !b.title.trim()) return "stat needs a title.";
    if (typeof b.value !== "string" || !b.value.trim()) return "stat needs a value.";
  }
  if (b.kind === "compare") {
    if (typeof b.title !== "string" || !b.title.trim()) return "compare needs a title.";
    for (const side of ["left", "right"] as const) {
      const s = b[side] as { label?: unknown; items?: unknown } | undefined;
      if (!s || typeof s.label !== "string" || !s.label.trim()) return `compare.${side} needs a label.`;
      if (!Array.isArray(s.items) || !s.items.every((x) => typeof x === "string")) {
        return `compare.${side}.items must be a list of strings.`;
      }
    }
  }
  if (b.kind === "quote") {
    if (typeof b.text !== "string" || !b.text.trim()) return "quote needs text.";
  }
  return null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const err = badSpec(body);
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
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] === "" ? 0 : Number(m[1]);
      const end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
      if (start <= end && start < total) {
        const node = createReadStream(abs, { start, end });
        return new Response(Readable.toWeb(node) as NodeReadableStream as ReadableStream, {
          status: 206,
          headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) },
        });
      }
      return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
  }

  const node = createReadStream(abs);
  return new Response(Readable.toWeb(node) as NodeReadableStream as ReadableStream, {
    headers: { ...headers, "Content-Length": String(total) },
  });
}
