// Per-scene assets — the footage a person brings themselves.
//
// The Director can copy a watched video's rhythm, but some scenes should be the person's
// own shot: their product, their face, a screen recording. Those files are uploaded here
// and served back to the same page for preview and to the assembler for the cut.
//
// Two rules shape this file. The name on disk is one we make (random hex + an extension
// taken from the *content type*, never from the client's filename), so nothing a caller
// sends can name a path. And the only thing that can be served is a name that matches that
// shape and an extension on the allow-list — no HTML, no SVG, no scripts, ever.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { OMNI_ROOT } from "@/lib/omniwatch";

export const ASSETS_ROOT = path.join(OMNI_ROOT, "assets");

/** 200 MB is a short 4K clip or a long 1080p one; past that it belongs in an editor. */
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;

/** What may be uploaded, and what it is called once it lands. The extension comes from
 *  here rather than from the upload's own name, so `clip.mp4.html` cannot be stored. */
const ALLOWED: Record<string, { ext: string; kind: "video" | "image" }> = {
  "video/mp4": { ext: ".mp4", kind: "video" },
  "video/quicktime": { ext: ".mov", kind: "video" },
  "video/webm": { ext: ".webm", kind: "video" },
  "image/jpeg": { ext: ".jpg", kind: "image" },
  "image/png": { ext: ".png", kind: "image" },
  "image/webp": { ext: ".webp", kind: "image" },
};

const SERVED: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** `abc123….mp4` — 32 hex characters and an allowed extension, nothing else. */
const NAME_RE = /^[a-f0-9]{32}\.(mp4|mov|webm|jpg|png|webp)$/;

export function assetKindFor(mime: string): "video" | "image" | null {
  return ALLOWED[String(mime || "").toLowerCase().split(";")[0].trim()]?.kind ?? null;
}

/** The name a file gets on disk: ours, not the caller's. */
export function newAssetName(mime: string): string | null {
  const hit = ALLOWED[String(mime || "").toLowerCase().split(";")[0].trim()];
  if (!hit) return null;
  return `${randomBytes(16).toString("hex")}${hit.ext}`;
}

/** A name we made, resolved inside the assets folder. Anything else is null — this is the
 *  only path into that folder, so a traversal never reaches the filesystem at all. */
export function assetPath(name: string): string | null {
  if (!NAME_RE.test(String(name || ""))) return null;
  return path.join(ASSETS_ROOT, name);
}

/** What the response says it is. Null means "do not serve this". */
export function contentTypeFor(name: string): string | null {
  if (!NAME_RE.test(String(name || ""))) return null;
  return SERVED[path.extname(name)] ?? null;
}

/** The media type is decided by the bytes, not by what the upload claims to be. A file
 *  named `.mp4` with a JPEG inside is a JPEG, and a file with neither shape is refused. */
export function sniffMedia(head: Uint8Array): string | null {
  const b = head;
  const ascii = (at: number, s: string) => s.split("").every((c, i) => b[at + i] === c.charCodeAt(0));
  if (b.length >= 12 && ascii(4, "ftyp")) {
    // ISO base media: mp4 and mov share the box. The brand says which, when it is there.
    return ascii(8, "qt  ") ? "video/quicktime" : "video/mp4";
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, "PNG")) return "image/png";
  if (b.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

export async function saveAssetBytes(bytes: Uint8Array, name: string): Promise<{ name: string; bytes: number }> {
  await mkdir(ASSETS_ROOT, { recursive: true });
  const dest = assetPath(name);
  if (!dest) throw new Error("bad asset name");
  await writeFile(dest, bytes);
  return { name, bytes: bytes.byteLength };
}

export function assetExists(name: string): boolean {
  const p = assetPath(name);
  return !!p && existsSync(p);
}
