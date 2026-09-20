// A bounded excerpt of a video this engine has already downloaded.
//
//   GET  /api/omniwatch/clip?id=<cacheKey>&start=<s>&end=<e>   the clip (video/mp4, ranges ok)
//   GET  /api/omniwatch/clip?id=<cacheKey>&probe=1             what is on disk, and what a clip would be cut from
//   POST /api/omniwatch/clip { url }                           explicit preparation of a full-quality master
//
// Why this exists: the recreate brief records a per-scene `reference` so a person can
// see the moment a beat was read off — the frame, and for a review, the clip itself.
// The media route serves whole files; cutting the excerpt is a different job, and it is
// the one place where the difference between what the engine downloads and what a
// finished video needs becomes visible.
//
// That difference is real and measured. The engine downloads at `-S res:480` because
// that is what the model can read and what keeps a long video small — a cached vertical
// short's source.mp4 is 240x426. That file is an ANALYSIS PROXY. It is honest evidence
// for reviewing a video, and it is not a picture to cut a finished edit from, so every
// response here says which of the two files it used (`X-Omni-Clip-Quality`) and at what
// size, rather than letting a caller find out later.
//
// The master is never fetched implicitly. A GET only ever reads a file that is already
// in the cache; POST is the explicit preparation, it requires that the video was already
// analysed (its cache directory holds the proxy and info.json), and it writes
// master.mp4 BESIDE the proxy — the proxy is the file the teardown's timings were
// measured against and is never overwritten. Nothing here calls a model.
//
// Safety properties, stated because they are the point of a route that spawns ffmpeg:
//   * no shell. `run()` spawns with an argv array, and nothing user-supplied is ever
//     concatenated into a command string.
//   * no arbitrary paths. The only file this route can be made to read is
//     `<CACHE_ROOT>/<id>/{source,master}.mp4`, where `id` came through `videoDir()`'s
//     `/^[\w-]{1,64}$/` check, and `?file=` style parameters are refused outright.
//   * no crop, no scale. The ffmpeg argv below has no video filter at all, so the clip
//     keeps the source's frame exactly — a reference clip that silently reframed the
//     shot would be evidence of a different video.
//   * bounded. One request extracts at most MAX_CLIP_SECONDS, the download has a
//     timeout and a size cap, and an output that ffprobe cannot read is deleted rather
//     than published.

import { NextResponse } from "next/server";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { cacheKey, run, videoDir } from "@/lib/omniwatch";
import { parseByteRange } from "@/lib/omniwatchGraphic";
import {
  MAX_CLIP_SECONDS, MASTER_FILE, PROXY_FILE, probeVideo, sourceFileIn, sourceUrlAllowed,
} from "@/lib/omniwatchRecreate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a master download may take, and how big it may get. The cap is a format
 *  filter, not a promise: yt-dlp checks the size it is about to fetch and refuses when
 *  it is over, which is exactly the case worth refusing (a 4K two-hour upload is not a
 *  source excerpt). The timeout is the backstop for a server that stalls mid-transfer. */
const PREP_TIMEOUT_MS = 900_000;
const MAX_MASTER_FILESIZE = "500M";
/** The same cap in bytes, enforced AFTER the download. `--max-filesize` is a format
 *  filter: yt-dlp can only apply it to a size it knows before transferring, and live
 *  streams, HLS and some extractors report none. A cap that a caller can bypass by
 *  picking a URL whose size is unknown is not a cap, so the file on disk is measured
 *  too, and an oversized master is deleted rather than published. */
const MAX_MASTER_BYTES = 500 * 1024 * 1024;

/** Where a clip is cached, inside the video's own directory so it lives and dies with
 *  the source it was cut from (cleanup() removes the whole directory after the cache
 *  TTL). The name carries the quality, so preparing a master cannot be served from a
 *  clip that was cut from the proxy. */
function clipPath(dir: string, quality: string, start: number, end: number): string {
  return path.join(dir, "clips", `${quality}-${start.toFixed(2)}-${end.toFixed(2)}.mp4`);
}

function clipHeaders(quality: string, start: number, end: number, w: number, h: number, duration: number) {
  return {
    "Content-Type": "video/mp4",
    // NOT a long max-age. The bytes behind this URL can change identity without the URL
    // changing: the same id/start/end is a proxy cut before a master is prepared and a
    // master cut after, and a day-long browser cache would keep showing the proxy to a
    // person who just prepared the master. The filename is quality-versioned on disk,
    // but the URL a brief stored is not, so the response is revalidated instead.
    "Cache-Control": "no-cache, must-revalidate",
    "Accept-Ranges": "bytes",
    "X-Omni-Clip-Quality": quality,
    "X-Omni-Clip-Start": start.toFixed(2),
    "X-Omni-Clip-End": end.toFixed(2),
    "X-Omni-Clip-Source-Width": String(w),
    "X-Omni-Clip-Source-Height": String(h),
    "X-Omni-Clip-Source-Duration": duration ? duration.toFixed(2) : "",
  };
}

/** Extracts one clip, atomically: ffmpeg writes a uniquely named `.part` next to the
 *  final name and only a successful run renames it into place, so a request that dies
 *  mid-encode can never leave a half-file where the next reader will find it, and two
 *  concurrent identical requests cannot delete each other's work. */
async function extract(file: string, out: string, start: number, length: number): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  const part = `${out}.${process.pid}${Math.random().toString(36).slice(2, 8)}.part`;
  try {
    // `-ss` before `-i` seeks by keyframe and is re-encoded here, so the cut is frame
    // accurate; there is deliberately no `-vf`, which is what keeps the frame whole.
    // `0:a:0?` maps audio only when there is some — a silent source is a valid source.
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-ss", String(start), "-t", String(length),
      "-i", file,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-f", "mp4",
      part,
    ], 300_000);
    await rename(part, out);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}

/** Resolves the cache id from `?id=` or `?url=`. The id form is what the brief stores;
 *  the url form exists so a caller holding only the link is not forced to recompute the
 *  key, and it goes through exactly the same `cacheKey()` the download used. */
function resolveId(idParam: string | null, urlParam: string | null): { id?: string; error?: string } {
  if (idParam) {
    if (!/^[\w-]{1,64}$/.test(idParam)) return { error: "That is not a video id this cache can hold." };
    return { id: idParam };
  }
  if (urlParam) {
    if (!sourceUrlAllowed(urlParam)) return { error: "That is not a link this engine watches." };
    return { id: cacheKey(urlParam) };
  }
  return { error: "Which video? Pass id=<cache key> or url=<the link you watched>." };
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  // A filesystem path is not an input. Refused loudly rather than ignored, so a caller
  // that tries it learns the rule instead of getting an empty 200.
  if (q.has("file") || q.has("path")) {
    return new Response("this route serves cached sources by id, never by path", { status: 400 });
  }

  const { id, error } = resolveId(q.get("id"), q.get("url"));
  if (error || !id) return new Response(error || "bad request", { status: 400 });

  let dir: string;
  try { dir = videoDir(id); } catch { return new Response("bad video id", { status: 400 }); }
  if (!existsSync(dir)) return new Response("that video is not in the cache", { status: 404 });

  const { file, quality } = sourceFileIn(dir);
  if (!existsSync(file)) return new Response("that video is not in the cache", { status: 404 });
  const probe = await probeVideo(file);
  if (!probe) return new Response("the cached file could not be read", { status: 500 });

  // A caller that only wants to know what it would get — the UI's "is this the proxy?"
  // question — asks for it explicitly instead of paying for an encode.
  if (q.get("probe")) {
    return NextResponse.json({
      ok: true,
      id,
      quality,
      width: probe.width,
      height: probe.height,
      seconds: Number(probe.seconds.toFixed(2)),
      proxy: existsSync(path.join(dir, PROXY_FILE)),
      master: existsSync(path.join(dir, MASTER_FILE)),
      maxClipSeconds: MAX_CLIP_SECONDS,
    });
  }

  // Presence is checked before parsing: `Number(null)` is 0, so a missing start used to
  // be accepted as the beginning of the video instead of being refused.
  if (!q.has("start") || !q.has("end")) return new Response("start and end are seconds, both required", { status: 400 });
  const start = Number(q.get("start"));
  const end = Number(q.get("end"));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return new Response("start and end are seconds, both required", { status: 400 });
  if (q.get("start") === "" || q.get("end") === "") return new Response("start and end are seconds, both required", { status: 400 });
  if (start < 0) return new Response("start cannot be negative", { status: 400 });
  if (end <= start) return new Response("end must come after start", { status: 400 });
  if (end - start > MAX_CLIP_SECONDS) return new Response(`a clip may be at most ${MAX_CLIP_SECONDS} seconds`, { status: 400 });

  // The stored brief can name a moment a few hundred milliseconds past the end of the
  // file — a 47-second teardown over a 46.8-second download is rounding, not a mistake.
  // Clamping here is what keeps the last scene of such a brief playable, and the
  // response says which times were actually cut, so nothing claims the extra 200 ms.
  const duration = probe.seconds;
  let from = start;
  let to = end;
  if (duration > 0) {
    if (from >= duration) return new Response("that moment is past the end of the cached file", { status: 400 });
    to = Math.min(to, duration);
  }
  if (to - from < 0.05) return new Response("that is too short to cut", { status: 400 });

  const out = clipPath(dir, quality, from, to);
  if (!existsSync(out)) {
    try {
      await extract(file, out, from, to - from);
    } catch (e) {
      // The detail goes to the server log, not to the caller: ffmpeg's own message
      // quotes the absolute path it was given, and this route's contract is that no
      // filesystem path is ever part of a response.
      console.error("[omniwatch/clip] extract failed", e);
      return new Response("could not cut that clip from the cached source", { status: 500 });
    }
  }

  const s = await stat(out);
  const headers = clipHeaders(quality, from, to, probe.width, probe.height, duration);
  const range = req.headers.get("range");
  if (range) {
    const parsed = parseByteRange(range, s.size);
    if (parsed === "unsatisfiable") {
      return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${s.size}` } });
    }
    if (parsed) {
      const node = createReadStream(out, { start: parsed.start, end: parsed.end });
      return new Response(Readable.toWeb(node) as NodeReadableStream as ReadableStream, {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${parsed.start}-${parsed.end}/${s.size}`, "Content-Length": String(parsed.end - parsed.start + 1) },
      });
    }
  }

  const node = createReadStream(out);
  return new Response(Readable.toWeb(node) as NodeReadableStream as ReadableStream, {
    headers: { ...headers, "Content-Length": String(s.size) },
  });
}

/** Prepares a full-quality master for a video that has ALREADY been analysed.
 *
 *  This is the one place in OmniWatch that downloads something the model does not need,
 *  so it is explicit, it is a POST, and it refuses everything it is not certain about:
 *  a URL that is not http(s) on a host this engine watches, or a video that is not in
 *  the cache with its proxy still on disk. No cookies, no credentials, no browser
 *  profile — the argv below is fixed apart from the URL, which is passed after `--` so
 *  a URL that looks like a flag cannot become one.
 *
 *  The download lands in a scratch directory inside the video's own cache directory
 *  (same filesystem, so the final rename is atomic), is probed, and only then becomes
 *  master.mp4. The proxy is untouched either way. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const url = String(body?.url || "").trim();
  if (!url) return NextResponse.json({ error: "Which video? Pass the link you watched." }, { status: 400 });
  if (!sourceUrlAllowed(url)) {
    return NextResponse.json({ error: "Only http(s) links from a source this engine watches can be prepared." }, { status: 400 });
  }

  const id = cacheKey(url);
  const dir = videoDir(id);
  const proxy = path.join(dir, PROXY_FILE);
  // The gate is that this video was analysed here. A master for something nobody
  // watched is a download we have no reason to make and no cache entry to hang it on.
  if (!existsSync(proxy) || !existsSync(path.join(dir, "info.json"))) {
    return NextResponse.json({ error: "That video has not been watched here yet, so there is nothing to prepare." }, { status: 404 });
  }

  const master = path.join(dir, MASTER_FILE);
  if (existsSync(master)) {
    const have = await probeVideo(master);
    if (have) {
      return NextResponse.json({
        ok: true, reused: true, id, quality: "master",
        width: have.width, height: have.height, seconds: Number(have.seconds.toFixed(2)),
      });
    }
    // An unreadable master is not a master. Removed so this request can replace it.
    await rm(master, { force: true });
  }

  const scratch = await mkdtemp(path.join(dir, ".prepare-"));
  const target = path.join(scratch, "master.%(ext)s");
  try {
    await run("yt-dlp", [
      "--no-playlist", "-q", "--no-warnings",
      "-N", "8",
      "--max-filesize", MAX_MASTER_FILESIZE,
      "-S", "res:2160",
      "-f", "bv*+ba/b",
      "--merge-output-format", "mp4",
      "-o", target,
      "--", url,
    ], PREP_TIMEOUT_MS);

    const produced = path.join(scratch, "master.mp4");
    if (!existsSync(produced)) throw new Error("the download did not produce an mp4");
    const written = (await stat(produced)).size;
    if (written > MAX_MASTER_BYTES) {
      throw new Error(`the downloaded file is larger than ${MAX_MASTER_FILESIZE}`);
    }
    const probe = await probeVideo(produced);
    if (!probe) throw new Error("the downloaded file could not be read");
    // Identity check: the master must be the SAME video the analysis was made from, or
    // the brief's timings describe something else. The cache key already ties the URL to
    // this directory, so what is left to catch is a URL that now resolves to a different
    // cut (re-upload, replaced stream) — and the length is what gives that away.
    const proxyProbe = await probeVideo(proxy);
    if (proxyProbe && proxyProbe.seconds > 0 && probe.seconds > 0) {
      const drift = Math.abs(probe.seconds - proxyProbe.seconds);
      if (drift > Math.max(2, proxyProbe.seconds * 0.01)) {
        throw new Error("the downloaded master is not the same length as the analysed video");
      }
    }
    await rename(produced, master);

    return NextResponse.json({
      ok: true, reused: false, id, quality: "master",
      width: probe.width, height: probe.height, seconds: Number(probe.seconds.toFixed(2)),
    });
  } catch (e) {
    console.error("[omniwatch/clip] prepare failed", e);
    return NextResponse.json({ error: "Could not prepare a master for that video." }, { status: 502 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
