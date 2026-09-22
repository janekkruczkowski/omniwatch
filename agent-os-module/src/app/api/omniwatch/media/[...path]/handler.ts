/**
 * GET /api/omniwatch/media/... — the video and its evidence frames (T6).
 *
 * Same URLs as before, so the existing UI keeps working:
 *   /api/omniwatch/media/video/<id>        the file itself, with range support
 *   /api/omniwatch/media/frame/<id>/<sec>  one real frame
 *
 * The file lookup is injected, which keeps the route free of the host's cache layout
 * and lets the offline test serve from a temp directory.
 */

import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

export interface MediaHandlerDeps {
  /** Directory holding `<id>/source.mp4` for a cached video. */
  videoDir(id: string): string;
  /** Produces (or finds) one frame at `sec`; returns the absolute path. */
  frameJpeg(id: string, sec: number): Promise<string>;
}

export function createMediaHandler(deps: MediaHandlerDeps) {
  return {
    async GET(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
      const { path: segments } = await context.params;
      if (!Array.isArray(segments) || segments.length < 2) return new Response("bad path", { status: 400 });

      const [kind, rawId, rawSec] = segments.map((segment) => decodeURIComponent(segment));
      const id = rawId.replace(/\.(mp4|jpg)$/, "");

      let file: string;
      let mime: string;
      let cache: string;
      try {
        if (kind === "video") {
          file = join(deps.videoDir(id), "source.mp4");
          mime = "video/mp4";
          cache = "no-store";
        } else if (kind === "frame") {
          const sec = Number((rawSec ?? "0").replace(/\.jpg$/, ""));
          if (!Number.isFinite(sec)) return new Response("bad timestamp", { status: 400 });
          file = await deps.frameJpeg(id, sec);
          mime = "image/jpeg";
          cache = "max-age=86400"; // a frame of a given second never changes
        } else {
          return new Response("not found", { status: 404 });
        }
      } catch {
        return new Response("not found", { status: 404 });
      }
      if (!existsSync(file)) return new Response("not found", { status: 404 });

      const info = await stat(file);
      const total = info.size;
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Cache-Control": cache,
        "Accept-Ranges": "bytes",
      };
      const range = request.headers.get("range");

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          const start = match[1] === "" ? 0 : Number(match[1]);
          const end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
          if (start <= end && start < total) {
            const node = createReadStream(file, { start, end });
            return new Response(Readable.toWeb(node) as ReadableStream, {
              status: 206,
              headers: {
                ...headers,
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Content-Length": String(end - start + 1),
              },
            });
          }
          return new Response("range not satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${total}` },
          });
        }
      }

      const node = createReadStream(file);
      return new Response(Readable.toWeb(node) as ReadableStream, {
        headers: { ...headers, "Content-Length": String(total) },
      });
    },
  };
}
