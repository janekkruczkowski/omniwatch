// POST /api/omniwatch/assets            multipart `file` → { ok, url, kind, name, bytes }
// GET  /api/omniwatch/assets?file=NAME  → the file itself, inline
//
// The upload behind a scene that uses the person's own footage instead of generated
// b-roll. The file is stored under a name this server invents, and served back only when
// the name matches that shape and the extension is a video or image we allow — so a
// browser can preview it and the assembler can fetch it, and nothing else is reachable.

import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  MAX_ASSET_BYTES, assetExists, assetPath, contentTypeFor, newAssetName, saveAssetBytes, sniffMedia,
} from "@/lib/omniwatchAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("file") || "";
  const type = contentTypeFor(name);
  const abs = assetPath(name);
  if (!type || !abs || !assetExists(name)) return new Response("not found", { status: 404 });

  const s = await stat(abs);
  const total = s.size;
  const headers: Record<string, string> = {
    "Content-Type": type,
    // inline, and never sniffed into something else: an upload is footage, not a page.
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "max-age=86400",
    "Accept-Ranges": "bytes",
  };

  // Range support, so the person can scrub their own clip in the preview. Same shape as
  // the OmniWatch media route, which serves the downloaded video the same way.
  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
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

  const node = createReadStream(abs);
  return new Response(Readable.toWeb(node) as NodeReadableStream as ReadableStream, {
    headers: { ...headers, "Content-Length": String(total) },
  });
}

export async function POST(req: Request) {
  // Refuse an oversized body before it is buffered. The multipart envelope adds a little on
  // top of the file itself, so the ceiling here is deliberately generous — it is there to
  // stop an obvious allocation, not to be the exact limit (that is checked on the file).
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_ASSET_BYTES + 1024 * 1024) {
    return NextResponse.json({
      error: `too large (max ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB)`,
    }, { status: 413 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart form-data required" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file field" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });
  if (file.size > MAX_ASSET_BYTES) {
    return NextResponse.json({ error: `too large (max ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MB)` }, { status: 413 });
  }

  // The bytes decide, not the client's claim: a mislabelled or disguised file is refused
  // here with an accurate message instead of being stored under a type it is not.
  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffMedia(bytes.subarray(0, 32));
  if (!sniffed) {
    return NextResponse.json({
      error: `that file is not a video or image we can use (mp4, mov, webm, jpg, png, webp) — it was read as ${file.type || "an unknown type"}`,
    }, { status: 415 });
  }
  const kind = sniffed.startsWith("video/") ? "video" : "image";
  const name = newAssetName(sniffed);
  if (!name) return NextResponse.json({ error: "unsupported media type" }, { status: 415 });

  try {
    const saved = await saveAssetBytes(bytes, name);
    return NextResponse.json({
      ok: true,
      kind,
      type: sniffed,
      name: saved.name,
      bytes: saved.bytes,
      url: `/api/omniwatch/assets?file=${saved.name}`,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "could not store that file" }, { status: 500 });
  }
}
