import { stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import path from "node:path";
import { videoDir, frameJpeg } from "@/lib/omniwatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves the downloaded video and single frames out of the OmniWatch cache:
//   /api/omniwatch/media/video/<id>        the file itself, with range support so
//                                          clicking a timestamp can seek
//   /api/omniwatch/media/frame/<id>/<sec>  one real frame — the evidence next to
//                                          each bullet of the answer
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: seg } = await ctx.params;
  if (!Array.isArray(seg) || seg.length < 2) return new Response("bad path", { status: 400 });

  const [kind, rawId, rawSec] = seg.map((s) => decodeURIComponent(s));
  const id = rawId.replace(/\.(mp4|jpg)$/, "");

  let abs: string, mime: string, cache: string;
  try {
    if (kind === "video") {
      abs = path.join(videoDir(id), "source.mp4");
      mime = "video/mp4";
      cache = "no-store";
    } else if (kind === "frame") {
      const sec = Number((rawSec || "0").replace(/\.jpg$/, ""));
      if (!Number.isFinite(sec)) return new Response("bad timestamp", { status: 400 });
      abs = await frameJpeg(id, sec);
      mime = "image/jpeg";
      cache = "max-age=86400"; // a frame of a given second never changes
    } else {
      return new Response("not found", { status: 404 });
    }
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!existsSync(abs)) return new Response("not found", { status: 404 });

  const s = await stat(abs);
  const total = s.size;
  const headers: Record<string, string> = { "Content-Type": mime, "Cache-Control": cache, "Accept-Ranges": "bytes" };
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
