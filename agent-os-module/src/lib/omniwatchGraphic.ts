// Graphic scenes — a ranking, a big number, a two-column comparison, a pull quote —
// rendered by ffmpeg alone, no browser/canvas/renderer dependency.
//
// Why this exists: a video that recreates the *shape* of another one (HypeKit's
// examples lean on this constantly — "top 5 footballers", "before/after", a single
// stat card) often needs a scene that is not footage at all. Until now this module
// could only fetch or generate b-roll, so those scenes had nothing to show. This file
// turns a GraphicSpec into an MP4 that slots into a scene's brollUrl exactly like any
// other clip.
//
// ffmpeg only, on purpose: ffmpeg is already a hard requirement of the module (see
// toolsPresent() in omniwatch.ts) — a browser, Playwright, node-canvas or any new npm
// dependency is not, and pulling one in here would break the "no setup" promise. So
// every frame is drawn with ffmpeg's own filters (`color`, `drawbox`, `drawtext`,
// `fade`) baked into a lavfi source — no headless browser, no image library.
//
// Escaping decision: every piece of text (including the module's own static labels,
// for consistency) is written to its own temp file and passed via drawtext's
// `textfile=` option rather than inline `text=`. drawtext's *filter option string* is
// parsed on ':' (key=value) and ',' (next filter) — with `text=` inline, a label
// containing a colon or an apostrophe (both required by the acceptance test, and both
// unremarkable in a title a model might write) would either break the filter graph or,
// worse, let a crafted label inject additional filter options. `textfile=` sidesteps
// that: the *content* of the file is never parsed as filter syntax, only the *path* to
// it is (and that path is ours, built from a hash, never user text). The one thing
// textfile= does NOT neutralize on its own is drawtext's own text-expansion syntax
// (`%{...}`, `%%`) — for that every drawtext call below also sets `expansion=none`,
// so a label that happens to contain a percent sign is rendered literally instead of
// being interpreted.
//
// Palette: this checkout of agent-os-module has no globals.css — OmniWatch.css (read
// before writing this file) consumes CSS custom properties (--gold, --cream, --bg-elev,
// …) that a host app supplies, and that host app is not part of this repo. The only
// concrete colors in OmniWatch.css are the three literal hex values used as text-on-
// fill (#1a1208 on gold, #2a1b00 on gold, #06200f on emerald) plus gold's own value,
// given as rgba(212,165,116, …) throughout. BG/GOLD below are those literals; the rest
// of the ramp (bg-elev, cream tones, line colors) is derived from the same warm/dark
// "Midnight Aubergine" hue by hand, not measured from a source that isn't in this repo
// — said plainly rather than passed off as exact.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { run, OMNI_ROOT } from "@/lib/omniwatch";

export const GRAPHICS_ROOT = path.join(OMNI_ROOT, "graphics");

export type GraphicSpec =
  | { kind: "ranking"; title: string; items: { label: string; value?: string }[]; seconds: number }
  | { kind: "stat"; title: string; value: string; caption?: string; seconds: number }
  | { kind: "compare"; title: string; left: { label: string; items: string[] }; right: { label: string; items: string[] }; seconds: number }
  | { kind: "quote"; text: string; attribution?: string; seconds: number };

// ── palette (see file header for provenance) ────────────────────────────────────
const BG = "1a1208";          // literal, from .ow-ts:hover's text-on-gold color
const BG_ELEV = "241b11";     // derived: BG lightened a few percent, for the card panel
const GOLD = "d4a574";        // literal, from rgba(212,165,116, …) throughout the CSS
const GOLD_SOFT = "e6c49a";   // derived: lighter gold, for secondary gold text
const GOLD_DEEP = "b8874f";   // derived: darker gold, for rank numbers/bullets
const CREAM = "f3ead9";       // derived: warm off-white body text
const CREAM_DIM = "cdbfa8";   // derived: dimmer body text
const LINE = "3a2e20";        // derived: subtle dividers/borders

const W = 1920, H = 1080, FPS = 30, MARGIN = 110;

// ── fonts ─────────────────────────────────────────────────────────────────────
// drawtext needs a real file on disk, not a family name — verified to exist rather
// than assumed, because launchd's minimal PATH already burned this module once for
// yt-dlp/ffmpeg (see BIN_PATH in omniwatch.ts) and a font is the same kind of trap.
// Arial.ttf under Supplemental is a plain TrueType file (not a .ttc collection, which
// drawtext's fontfile= cannot address by family), and macOS has shipped it there for
// as long as this module has needed to check.
const FONT_CANDIDATES = {
  regular: [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Verdana.ttf",
    "/Library/Fonts/Arial.ttf",
  ],
  bold: [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Verdana Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
  ],
};

function resolveFont(weight: "regular" | "bold"): string {
  for (const p of FONT_CANDIDATES[weight]) if (existsSync(p)) return p;
  throw new Error(
    `OmniWatch graphics need a ${weight} TrueType font and none of the usual macOS locations has one. ` +
    `Checked: ${FONT_CANDIDATES[weight].join(", ")}. ` +
    `Install Arial (macOS normally ships it at /System/Library/Fonts/Supplemental/Arial.ttf — ` +
    `if it's missing, reinstall the "Additional Fonts" component from System Settings) and try again.`,
  );
}

// ── hashing (memoized output) ────────────────────────────────────────────────────
// A fixed field order per kind, not JSON.stringify(spec) directly — object key order
// in the incoming spec depends on how the caller built it, and hashing that order
// would render the same card twice under two different filenames.
function canonical(spec: GraphicSpec): string {
  switch (spec.kind) {
    case "ranking":
      return JSON.stringify(["ranking", spec.title, spec.items.map((i) => [i.label, i.value ?? ""]), spec.seconds]);
    case "stat":
      return JSON.stringify(["stat", spec.title, spec.value, spec.caption ?? "", spec.seconds]);
    case "compare":
      return JSON.stringify([
        "compare", spec.title,
        [spec.left.label, spec.left.items], [spec.right.label, spec.right.items],
        spec.seconds,
      ]);
    case "quote":
      return JSON.stringify(["quote", spec.text, spec.attribution ?? "", spec.seconds]);
  }
}

function hashSpec(spec: GraphicSpec): string {
  return createHash("sha1").update(canonical(spec)).digest("hex").slice(0, 16);
}

// ── text wrapping ────────────────────────────────────────────────────────────────
// drawtext does not wrap; \n in the text is rendered as a line break, so wrapping is
// done here. The width-per-character figure is a heuristic (Arial averages close to
// 0.55× its point size per glyph) rather than a real text-measurement pass — ffmpeg
// gives no such API short of rendering — so every kind below errs toward generous
// column widths and was checked by eye in the acceptance test, not just trusted.
function wrapText(text: string, fontPx: number, maxWidthPx: number, maxLines: number): string[] {
  const maxChars = Math.max(4, Math.floor(maxWidthPx / (fontPx * 0.55)));
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (trial.length <= maxChars) { cur = trial; continue; }
    if (cur) { lines.push(cur); cur = w.length > maxChars ? w.slice(0, maxChars) : w; }
    else { lines.push(w.slice(0, maxChars)); cur = ""; }
  }
  if (cur) lines.push(cur);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1].replace(/\s+$/, "");
    kept[maxLines - 1] = (last.length >= maxChars ? last.slice(0, Math.max(0, maxChars - 1)) : last) + "\u2026";
    return kept;
  }
  return lines;
}

// ── ffmpeg filter assembly ───────────────────────────────────────────────────────
// Escapes a path used as a drawtext option *value* (fontfile=/textfile=). The filter
// option parser splits on ':' between key=value pairs and on ',' between filters, so
// those (plus '\' and the string terminator "'") need escaping in the path itself —
// distinct from, and much narrower than, escaping the *text content*, which textfile=
// avoids needing at all (see file header).
const escPath = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

interface TextCtx { dir: string; n: number; files: string[] }

async function textFile(ctx: TextCtx, lines: string[]): Promise<string> {
  const p = path.join(ctx.dir, `t${ctx.n++}.txt`);
  ctx.files.push(p);
  await writeFile(p, lines.join("\n"), "utf8");
  return p;
}

interface DrawOpts {
  file: string; font: string; sizePx: number; color: string; x: string; y: string; alpha?: number; lineSpacing?: number;
}
function drawtext(o: DrawOpts): string {
  const parts = [
    `fontfile=${escPath(o.font)}`,
    `textfile=${escPath(o.file)}`,
    `fontsize=${Math.round(o.sizePx)}`,
    `fontcolor=0x${o.color}${o.alpha !== undefined ? `@${o.alpha}` : ""}`,
    `x=${o.x}`,
    `y=${o.y}`,
    "expansion=none",
    `line_spacing=${o.lineSpacing ?? 6}`,
  ];
  return `drawtext=${parts.join(":")}`;
}

const centerX = () => "(w-tw)/2";
const midY = (top: number, height: number) => `${top}+(${height}-th)/2`;

/** A thin card frame + top accent bar, common to all four kinds — the closest ffmpeg's
 *  flat rectangles get to the rounded, gold-bordered "evidence" panels in the CSS. */
function frame(): string[] {
  const x0 = MARGIN - 40, panelW = W - 2 * (MARGIN - 40), panelH = H - 2 * (MARGIN - 40);
  return [
    `drawbox=x=0:y=0:w=${W}:h=8:color=0x${GOLD}:t=fill`,
    `drawbox=x=${x0}:y=${x0}:w=${panelW}:h=${panelH}:color=0x${BG_ELEV}@0.5:t=fill`,
    `drawbox=x=${x0}:y=${x0}:w=${panelW}:h=${panelH}:color=0x${LINE}:t=2`,
  ];
}

function fade(seconds: number): string[] {
  const d = Math.min(0.5, seconds / 4);
  return [`fade=t=in:st=0:d=${d}`, `fade=t=out:st=${Math.max(0, seconds - d)}:d=${d}`];
}

async function buildFilters(spec: GraphicSpec, font: { reg: string; bold: string }, ctx: TextCtx): Promise<string[]> {
  const f: string[] = [...frame()];

  if (spec.kind === "ranking") {
    const titleLines = wrapText(spec.title, 52, W - 2 * MARGIN, 1);
    f.push(drawtext({
      file: await textFile(ctx, titleLines), font: font.bold, sizePx: 52, color: GOLD,
      x: String(MARGIN), y: midY(70, 100),
    }));
    f.push(`drawbox=x=${MARGIN}:y=225:w=${W - 2 * MARGIN}:h=3:color=0x${GOLD}:t=fill`);

    const n = Math.max(1, spec.items.length);
    const areaTop = 280, areaH = 980 - areaTop;
    const rowH = Math.min(140, Math.max(56, areaH / n));
    const hasValue = spec.items.some((i) => i.value);
    const itemFont = Math.min(40, Math.max(20, rowH * 0.36));
    const rankFont = Math.min(40, Math.max(20, rowH * 0.4));
    const labelX = MARGIN + 150;
    const labelW = W - labelX - MARGIN - (hasValue ? 260 : 0);
    const labelMaxLines = rowH >= 100 ? 2 : 1;

    for (let i = 0; i < spec.items.length; i++) {
      const item = spec.items[i];
      const top = areaTop + i * rowH;
      const rankLabel = [String(i + 1).padStart(2, "0")];
      f.push(drawtext({
        file: await textFile(ctx, rankLabel), font: font.bold, sizePx: rankFont, color: GOLD_DEEP,
        x: String(MARGIN), y: midY(top, rowH),
      }));
      const labelLines = wrapText(item.label, itemFont, labelW, labelMaxLines);
      f.push(drawtext({
        file: await textFile(ctx, labelLines), font: font.reg, sizePx: itemFont, color: CREAM,
        x: String(labelX), y: midY(top, rowH),
      }));
      if (item.value) {
        const valueLines = wrapText(item.value, itemFont, 240, 1);
        f.push(drawtext({
          file: await textFile(ctx, valueLines), font: font.bold, sizePx: itemFont, color: GOLD_SOFT,
          x: `w-${MARGIN}-tw`, y: midY(top, rowH),
        }));
      }
      if (i < spec.items.length - 1) {
        f.push(`drawbox=x=${MARGIN}:y=${Math.round(top + rowH)}:w=${W - 2 * MARGIN}:h=1:color=0x${LINE}:t=fill`);
      }
    }
    return f;
  }

  if (spec.kind === "stat") {
    const titleLines = wrapText(spec.title, 40, W - 2 * MARGIN, 2);
    f.push(drawtext({
      file: await textFile(ctx, titleLines), font: font.bold, sizePx: 40, color: GOLD,
      x: centerX(), y: midY(90, 120),
    }));

    const len = spec.value.length;
    const valueFont = len <= 2 ? 340 : len <= 4 ? 260 : len <= 7 ? 190 : len <= 11 ? 130 : 90;
    const valueLines = wrapText(spec.value, valueFont, W - 2 * MARGIN - 40, len <= 11 ? 1 : 2);
    f.push(drawtext({
      file: await textFile(ctx, valueLines), font: font.bold, sizePx: valueFont, color: GOLD,
      x: centerX(), y: midY(260, 540),
    }));

    if (spec.caption) {
      const capLines = wrapText(spec.caption, 34, W - 2 * MARGIN - 200, 2);
      f.push(drawtext({
        file: await textFile(ctx, capLines), font: font.reg, sizePx: 34, color: CREAM_DIM,
        x: centerX(), y: midY(850, 130),
      }));
    }
    return f;
  }

  if (spec.kind === "compare") {
    const titleLines = wrapText(spec.title, 46, W - 2 * MARGIN, 1);
    f.push(drawtext({
      file: await textFile(ctx, titleLines), font: font.bold, sizePx: 46, color: GOLD,
      x: centerX(), y: midY(70, 100),
    }));
    f.push(`drawbox=x=${W / 2 - 1}:y=250:w=2:h=680:color=0x${GOLD}@0.5:t=fill`);
    f.push(drawtext({
      file: await textFile(ctx, ["VS"]), font: font.bold, sizePx: 30, color: GOLD,
      x: centerX(), y: "580",
    }));

    const colW = W / 2 - MARGIN - 40;
    const cols: { x0: number; col: { label: string; items: string[] } }[] = [
      { x0: MARGIN, col: spec.left },
      { x0: W / 2 + 40, col: spec.right },
    ];
    for (const { x0, col } of cols) {
      const headLines = wrapText(col.label, 36, colW, 1);
      f.push(drawtext({
        file: await textFile(ctx, headLines), font: font.bold, sizePx: 36, color: CREAM,
        x: `${x0}+(${colW}-tw)/2`, y: "260",
      }));
      const n = Math.max(1, col.items.length);
      const areaTop = 360, areaH = 980 - areaTop;
      const rowH = Math.min(110, Math.max(46, areaH / n));
      const itemFont = Math.min(32, Math.max(18, rowH * 0.5));
      for (let i = 0; i < col.items.length; i++) {
        const top = areaTop + i * rowH;
        f.push(drawtext({
          file: await textFile(ctx, ["\u2022"]), font: font.bold, sizePx: itemFont, color: GOLD_DEEP,
          x: String(x0), y: midY(top, rowH),
        }));
        const lines = wrapText(col.items[i], itemFont, colW - 45, rowH >= 90 ? 2 : 1);
        f.push(drawtext({
          file: await textFile(ctx, lines), font: font.reg, sizePx: itemFont, color: CREAM,
          x: String(x0 + 45), y: midY(top, rowH),
        }));
      }
    }
    return f;
  }

  // quote
  f.push(drawtext({
    file: await textFile(ctx, ["\u201C"]), font: font.bold, sizePx: 220, color: GOLD, alpha: 0.3,
    x: String(MARGIN + 20), y: "40",
  }));
  const len = spec.text.length;
  const qFont = len <= 40 ? 72 : len <= 90 ? 56 : len <= 160 ? 44 : 34;
  const qLines = wrapText(spec.text, qFont, W - 2 * MARGIN - 120, Math.max(2, Math.floor(520 / (qFont * 1.3))));
  f.push(drawtext({
    file: await textFile(ctx, qLines), font: font.reg, sizePx: qFont, color: CREAM,
    x: centerX(), y: midY(260, 520),
  }));
  if (spec.attribution) {
    const attrLines = wrapText(`\u2014 ${spec.attribution}`, 32, W - 2 * MARGIN - 200, 1);
    f.push(drawtext({
      file: await textFile(ctx, attrLines), font: font.reg, sizePx: 32, color: GOLD_SOFT,
      x: centerX(), y: "840",
    }));
  }
  return f;
}

// toolsPresent() in omniwatch.ts only checks `ffmpeg -version`, which a build with no
// text-rendering support still passes — measured on this machine: Homebrew's plain
// `ffmpeg` formula (both 9.0.2 and 8.1.2, the two installed here) links no libfreetype
// and rejects drawtext with "No such filter", while `ffmpeg-full` carries it. That
// failure must not surface as ffmpeg's raw stderr, so it is checked for up front.
let drawtextOk: Promise<boolean> | null = null;
async function hasDrawtext(): Promise<boolean> {
  if (!drawtextOk) {
    drawtextOk = run("ffmpeg", ["-filters"], 15_000)
      .then((out) => /\bdrawtext\b/.test(out))
      .catch(() => false);
  }
  return drawtextOk;
}

/** Renders a GraphicSpec to an MP4 with ffmpeg alone and returns its path. Same spec
 *  in, same file out — a hash of the spec is the filename, so a repeat request is a
 *  cache hit rather than a re-render. */
export async function renderGraphic(spec: GraphicSpec): Promise<string> {
  if (!Number.isFinite(spec.seconds) || spec.seconds <= 0) {
    throw new Error(`A graphic needs a positive duration; got ${spec.seconds}.`);
  }
  await mkdir(GRAPHICS_ROOT, { recursive: true });
  const hash = hashSpec(spec);
  const outPath = path.join(GRAPHICS_ROOT, `${spec.kind}-${hash}.mp4`);
  if (existsSync(outPath)) return outPath; // already rendered this exact card

  if (!(await hasDrawtext())) {
    throw new Error(
      "This machine's ffmpeg has no drawtext filter (it needs to be built with libfreetype). " +
      "On macOS with Homebrew, `brew install ffmpeg` alone does not include it — " +
      "run `brew install ffmpeg-full` and make sure that build is the one on PATH.",
    );
  }

  const font = { reg: resolveFont("regular"), bold: resolveFont("bold") };
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "omniwatch-graphic-"));
  const ctx: TextCtx = { dir: tmpDir, n: 0, files: [] };

  try {
    const filters = await buildFilters(spec, font, ctx);
    filters.push(...fade(spec.seconds));
    const vf = filters.join(",");

    const tmpOut = path.join(GRAPHICS_ROOT, `.${spec.kind}-${hash}.${process.pid}.mp4`);
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=0x${BG}:s=${W}x${H}:r=${FPS}:d=${spec.seconds}`,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", vf,
      "-t", String(spec.seconds),
      "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      tmpOut,
    ], 120_000);
    await rename(tmpOut, outPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  return outPath;
}
