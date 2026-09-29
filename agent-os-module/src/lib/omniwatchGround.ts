// Geometry locate on SOURCE frames — Hypit-style one-question boxes, not free-form VL CSS.
//
// Default detector: OpenRouter google/gemini-3.8-flash with the Hypit locate.auto prompt
// (box_2d as [ymin,xmin,ymax,xmax] 0..1000). Fall back to DashScope Qwen only if no OR key.
// Pass 2: same model authors a Hypit-like appearance RECIPE (colors, caption stroke, thumb radius)
// so we do not trust Omni track.style or naive mean-pixel sampling over text/thumbs.
// No HyperFrames locate.mjs code copied.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { apiKey, run } from "@/lib/omniwatch";
import {
  validateBlueprint,
  type Blueprint,
  type BlueprintRegion,
  type Rect,
} from "@/lib/omniwatchBlueprint";
import {
  applyMeasure,
  applyRecipe,
  CAP_OF_EM,
  defaultRecipe,
  FACE_WIDTHS,
  faceFromWidth,
  normalizeRecipe,
  recipePrompt,
  type FormatRecipe,
} from "@/lib/omniwatchRecipe";
import { readPixels, scanBoard, scanInkLines, scanOverlay, scanPlate, type BoardMeasure, type Pixels } from "@/lib/omniwatchBoardScan";
import { runNode, type Node, type GateRecord } from "@/lib/omniwatchNode";

const FRAME_WIDTH = 720;

/** OpenRouter model for locate + recipe. Override with GROUND_MODEL. */
export const GROUND_MODEL = process.env.GROUND_MODEL || "google/gemini-3.8-flash";
const OPENROUTER_URL = process.env.OPENROUTER_API || "https://openrouter.ai/api/v1/chat/completions";
const DASHSCOPE_API = process.env.DASHSCOPE_API || "https://dashscope-intl.aliyuncs.com";

export type GroundTarget = { id: string; query: string };
export type GroundHit = { id: string; rect: Rect; raw?: number[]; via?: string; paint?: string };

/** Where a region's CURRENT rect came from — the fact the caption-band defect showed we were
 *  not keeping anywhere.
 *
 *  "guess" is not a value this map ever stores; it is what absence means. A rect starts as
 *  whatever the capture guessed, and nothing here writes "guess" for that — the map only ever
 *  gets an entry at the moment something actually measures a region, so a region nobody has
 *  measured yet simply has no key. That is what makes a tidy-up pass safe by construction: a
 *  pass like `sanitizeCaptionVsBanner` moves a rect without ever touching this map, so a nudge
 *  to a guess leaves no entry behind either — it is still a guess, exactly as far as a caller
 *  asking `origins.get(id)` can tell, whether or not the number changed.
 *
 *  "located" is a model's answer (locate, via OpenRouter/DashScope) taken as-is: a real
 *  observation, but of a single frame, in the words of a model that gets a caption's height
 *  wrong by ten pixels more often than it gets it right.
 *
 *  "scanned" is pixels counted, not asked about: the board's grid (omniwatchBoardScan), a
 *  title plate's edges, letters found by `fitTypeToInk`'s ink scan, or the whole-frame band
 *  scan in omniwatchBandScan.ts. Nothing here ranks "scanned" over "located" — both count as
 *  measured for a gate that only needs to tell "was this looked at" from "was this never
 *  looked at" — but a caller with a reason to prefer one kind of evidence over another has
 *  the distinction to work with instead of one flat boolean. */
export type RegionOrigin = "located" | "scanned";
/** Per-region-id provenance, threaded through `refineBlueprint` alongside `hits`, `notes` and
 *  `log`. Deliberately keyed by region id rather than folded into `BlueprintRegion` itself —
 *  the blueprint schema is validated and rebuilt field-by-field in a dozen places
 *  (omniwatchBlueprint.ts's `validateBlueprint`), and every one of them would have had to
 *  learn a new field for this. A side map costs nothing there and works for every region a
 *  gate might ever want to ask about, not only the caption band. */
export type RegionOrigins = Map<string, RegionOrigin>;

export type GroundResult =
  | { ok: true; blueprint: Blueprint; hits: GroundHit[]; notes: string[]; frames: string[];
      recipe?: FormatRecipe | null; measure?: BoardMeasure | null; log: GateRecord[]; origins: RegionOrigins }
  | { ok: false; error: string; status?: number };

/** The appearance contract now lives in omniwatchRecipe, where it is a full authored IR
 *  rather than the handful of colours this file used to carry. Re-exported because the
 *  measure layer and the routes name the type. */
export type StyleRecipe = FormatRecipe;

/** Hypit locate.auto prompt — exact contract. */
export function hypitLocatePrompt(target: string): string {
  return `Detect "${target}". Return ONLY {"box_2d":[ymin,xmin,ymax,xmax]} integers 0-1000.`;
}

/** Structural targets for measure — not every cell letter (board → 5 equal rows after). */
export function targetsFromBlueprint(bp: Blueprint): GroundTarget[] {
  const out: GroundTarget[] = [];
  const seen = new Set<string>();
  const add = (id: string, query: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, query });
  };

  for (const r of bp.regions) {
    const lab = `${r.id} ${r.label || ""}`;
    if (/caption/i.test(lab)) {
      add(r.id, "the karaoke caption (white outlined words) sitting just ABOVE the dark tier-list board — NOT the top title banner");
    } else if (/banner|title-bar|title_banner|top-banner/i.test(lab)) {
      add(r.id, "the white title banner at the top of the frame");
    } else if (/tier[-_]?(list|board)|leaderboard/i.test(lab) || (r.role === "panel" && /tier|board|list/i.test(lab))) {
      add(r.id, "the dark tier list board occupying the bottom of the frame");
    } else if (/inset|portrait|cr7|messi|floating/i.test(lab)) {
      add(r.id === "cr7-portrait" || r.id === "messi-portrait" ? "inset-card" : r.id,
        "the floating square portrait card of a footballer on the left");
    }
  }

  if (![...seen].some((id) => /banner|title/i.test(id))) {
    add("top-banner", "the white title banner at the top of the frame");
  }
  if (![...seen].some((id) => /caption/i.test(id))) {
    add("caption-area", "the karaoke caption (white outlined words) sitting just ABOVE the dark tier-list board — NOT the top title banner");
  }
  if (![...seen].some((id) => /board|tier-list|leaderboard/i.test(id))) {
    add("tier-board", "the dark tier list board occupying the bottom of the frame");
  }
  if (![...seen].some((id) => /inset|portrait/i.test(id))) {
    add("inset-card", "the floating square portrait card of a footballer on the left");
  }

  return out;
}

async function openRouterKey(): Promise<string | null> {
  const env = process.env.OPENROUTER_API_KEY?.trim();
  if (env) return env;
  const hermes = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  for (const file of [
    path.join(hermes, ".env"),
    path.join(hermes, "profiles", "fusion", ".env"),
    path.join(os.homedir(), ".fcc", ".env"),
  ]) {
    try {
      const m = readFileSync(file, "utf8").match(/^OPENROUTER_API_KEY=(.+)$/m);
      if (m && m[1]!.trim().length > 10) return m[1]!.trim().replace(/^["']|["']$/g, "");
    } catch { /* next */ }
  }
  return null;
}

/** How many extra moments to look for the board in, when the first one is obstructed.
 *  Eight covers a twenty-second short at better than two-second spacing, and each one costs
 *  a frame grab and an arithmetic scan — no model, no network. */
const BOARD_SWEEP = 8;
/** Stop sweeping once a frame shows this many rows: no tier board has more, so a frame that
 *  shows them all cannot be beaten. */
const EXPECTED_MAX_ROWS = 5;

async function frameAt(src: string, at: number, out: string): Promise<void> {
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-ss", at.toFixed(2), "-i", src,
    "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "3", out,
  ], 60_000);
}

/**
 * Hypit/Gemini box_2d = [ymin,xmin,ymax,xmax] in 0..1000 → our [x,y,w,h] fractions.
 */
export function box2dToRect(b: number[]): Rect | null {
  if (!Array.isArray(b) || b.length < 4) return null;
  const nums = b.map(Number);
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const [a, c, d, e] = nums as [number, number, number, number];
  const scale = Math.max(a, c, d, e) > 1.5 ? 1000 : 1;
  let y0 = a / scale, x0 = c / scale, y1 = d / scale, x1 = e / scale;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  const w = x1 - x0, h = y1 - y0;
  if (!(w > 0.01 && h > 0.01 && w <= 1.05 && h <= 1.05)) return null;
  const rx = Math.max(0, Math.min(1, x0));
  const ry = Math.max(0, Math.min(1, y0));
  const rw = Math.max(0.01, Math.min(1 - rx, w));
  const rh = Math.max(0.01, Math.min(1 - ry, h));
  return [rx, ry, rw, rh];
}

function parseLocateJson(text: string): number[] | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const b = (j.box_2d || j.bbox_2d || j.box || j.bbox) as unknown;
    if (Array.isArray(b) && typeof b[0] === "number") return b.map(Number);
    if (Array.isArray(b) && Array.isArray(b[0])) return (b[0] as number[]).map(Number);
    return null;
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function locateOpenRouter(key: string, model: string, jpeg: Buffer, target: string): Promise<number[] | null> {
  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://agentic-os.local",
      "X-Title": "OmniWatch measure locate",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          { type: "text", text: hypitLocatePrompt(target) },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`openrouter ${r.status}: ${t.slice(0, 220)}`);
  }
  const data = await r.json() as { choices?: { message?: { content?: string } }[] };
  return parseLocateJson(data.choices?.[0]?.message?.content || "");
}

async function locateDashScope(key: string, jpeg: Buffer, target: string): Promise<number[] | null> {
  const model = process.env.GROUND_FALLBACK_MODEL || "qwen-vl-max";
  const r = await fetch(`${DASHSCOPE_API}/compatible-mode/v1/chat/completions`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          { type: "text", text: hypitLocatePrompt(target) },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`dashscope ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json() as { choices?: { message?: { content?: string } }[] };
  return parseLocateJson(data.choices?.[0]?.message?.content || "");
}

async function openRouterVision(
  key: string,
  model: string,
  jpeg: Buffer,
  prompt: string,
  title: string,
): Promise<string> {
  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://agentic-os.local",
      "X-Title": title,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`openrouter ${r.status}: ${t.slice(0, 220)}`);
  }
  const data = await r.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || "";
}


/** Pass 2: the model authors the appearance recipe from the same frame the boxes came from.
 *
 *  It is given whatever the pixel scan already counted, as facts it may not contradict, so
 *  the question it is left with is the one it is actually good at: what KIND of face is this,
 *  what colour is that stroke, is there a plate behind the caption. Everything countable has
 *  already been counted by then.
 *
 *  It always returns a recipe. With no key, or a reply that does not parse, the defaults
 *  stand and the render is still drawn from one contract instead of from the composer's
 *  opinions — which is the whole change. */
export async function authorRecipe(
  framePath: string,
  hits: GroundHit[],
  measured: BoardMeasure | null,
  canvas: { width: number; height: number },
  notes: string[],
): Promise<FormatRecipe> {
  const base = defaultRecipe(canvas);
  const orKey = await openRouterKey();
  if (!orKey) {
    notes.push("recipe: no OpenRouter key — measured values over defaults");
    return measured ? applyMeasure(base, measured, notes) : base;
  }
  const slim = hits.map((h) => ({ id: h.id, rect: h.rect.map((n) => Math.round(n * 1000) / 1000) }));
  const facts = measured
    ? JSON.stringify({
        labelRatio: Math.round(measured.labelRatio * 1e4) / 1e4,
        rowGap: Math.round(measured.rowGap * 1e4) / 1e4,
        slotBackground: measured.slotBackground,
        boardBackground: measured.boardBackground,
        tierFills: measured.rows.map((r) => r.fill),
        tilesPerRow: measured.rows.map((r) => r.thumbs.length),
        thumb: measured.thumb,
        letterCapRatio: measured.letterCapRatio,
      }, null, 2)
    : undefined;
  try {
    const text = await openRouterVision(
      orKey, GROUND_MODEL, await readFile(framePath),
      recipePrompt(JSON.stringify(slim, null, 2), facts),
      "OmniWatch appearance recipe",
    );
    const raw = parseJsonObject(text);
    if (!raw) {
      notes.push("recipe: reply did not parse — measured values over defaults");
      return measured ? applyMeasure(base, measured, notes) : base;
    }
    const authored = normalizeRecipe({ ...raw, canvas }, canvas);
    notes.push(
      `recipe via openrouter:${GROUND_MODEL} — banner ${authored.banner.type.face}/${authored.banner.type.weight}` +
      ` caption ${authored.caption.type.face} stroke ${authored.caption.type.stroke ? authored.caption.type.stroke.width.toFixed(4) : "none"}` +
      ` label ${authored.label.type.face}/${authored.label.type.weight}`,
    );
    return measured ? applyMeasure(authored, measured, notes) : authored;
  } catch (e) {
    notes.push(`recipe failed: ${e instanceof Error ? e.message : String(e)} — measured values over defaults`);
    return measured ? applyMeasure(base, measured, notes) : base;
  }
}

/** Kept under its old name because the measure layer calls it: the recipe's typography and
 *  paints, put onto the blueprint's own regions and tracks. */
export function applyRecipeToBlueprint(bp: Blueprint, recipe: FormatRecipe, notes: string[]): Blueprint {
  return applyRecipe(bp, recipe, notes);
}


async function drawHit(srcFrame: string, rect: Rect, out: string): Promise<void> {
  const [x, y, w, h] = rect;
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", srcFrame,
    "-vf", `drawbox=x=iw*${x.toFixed(4)}:y=ih*${y.toFixed(4)}:w=iw*${w.toFixed(4)}:h=ih*${h.toFixed(4)}:color=red@1:t=4`,
    "-frames:v", "1", "-q:v", "3", out,
  ], 30_000);
}

/** After board is located: 5 equal S–D rows + label column (~16% width). */
export function synthesizeTierRowsFromBoard(
  board: Rect,
  labelW = 0.16,
): { id: string; rect: Rect }[] {
  const [bx, by, bw, bh] = board;
  const rowH = bh / 5;
  const lw = Math.min(0.22, Math.max(0.1, labelW)) * (bw <= 1 ? 1 : 1);
  const labW = Math.min(bw * 0.35, Math.max(0.1, labelW));
  const letters = ["s", "a", "b", "c", "d"] as const;
  const out: { id: string; rect: Rect }[] = [];
  for (let i = 0; i < 5; i++) {
    const y = by + i * rowH;
    out.push({ id: `${letters[i]}-label`, rect: [bx, y, labW, rowH] });
    out.push({ id: `${letters[i]}-slot`, rect: [bx + labW, y, Math.max(0.05, bw - labW), rowH] });
  }
  void lw;
  return out;
}

export function applyHits(
  bp: Blueprint, hits: GroundHit[], notes: string[], measured?: BoardMeasure | null,
  origins?: RegionOrigins,
): Blueprint {
  const by = new Map(hits.map((h) => [h.id, h]));
  if (by.has("inset-card")) {
    for (const id of ["cr7-portrait", "messi-portrait", "inset-ronaldo"]) {
      if (bp.regions.some((r) => r.id === id) && !by.has(id)) {
        by.set(id, { ...by.get("inset-card")!, id });
      }
    }
  }

  let regions = bp.regions.map((r) => {
    const hit = by.get(r.id);
    if (!hit) return r;
    notes.push(`region "${r.id}" rect located ${JSON.stringify(r.rect)} → ${JSON.stringify(hit.rect)}`);
    origins?.set(r.id, "located");
    // Geometry only here — paints come from recipe pass 2.
    return { ...r, rect: hit.rect };
  });

  for (const h of hits) {
    if (regions.some((r) => r.id === h.id)) continue;
    if (h.id === "inset-card") {
      regions.push({
        id: "inset-card",
        role: "figure",
        rect: h.rect,
        z: 4,
        paint: { fill: "#ffffff", radius: 0.12 },
        label: "floating inset measured from film",
      });
      origins?.set("inset-card", "located");
      notes.push(`added region "inset-card" from locate`);
    }
  }

  const boardHit = hits.find((h) => /tier-board|tier-list|board/i.test(h.id));
  const boardRegionId = boardHit?.id
    ?? regions.find((r) => /tier-board|tier-list|board/i.test(r.id) && !/overlay/i.test(r.id))?.id;
  // Rows are built from the SCAN, and from nothing else.
  //
  // This used to run when a model had merely POINTED at a board, falling back to five equal
  // rows and a column a sixth of the width — numbers nobody had counted. On a podcast, which
  // has no board of any kind, that produced a tier list: five rows, parented to a region that
  // was never declared, and a blueprint that failed its own validator.
  //
  // The scan is a test, not an opinion: either there is a grid of equal rows in this film or
  // there is not. When there is not, the honest output is a film without a board, which is
  // what the film is.
  if (measured) {
    const boardRect = measured.board;
    const parentId = boardRegionId ?? "tier-board";
    // A grid found in a film that never declared a board still needs somewhere to hang.
    if (!regions.some((r) => r.id === parentId)) {
      regions.push({ id: parentId, role: "panel", rect: boardRect, z: 2,
        grid: { rows: measured.rows.length, cols: 2 } });
      notes.push(`board region "${parentId}" declared from the grid the scan found`);
    }
    origins?.set(parentId, "scanned");
    const cells = measured.rows.flatMap((r) => [{ id: `${r.id}-label`, rect: r.label }, { id: `${r.id}-slot`, rect: r.slot }]);
    notes.push(`tier grid from the pixel scan, not an even division of the board`);
    const cellIds = new Set(cells.map((c) => c.id));
    regions = regions.filter((r) => !cellIds.has(r.id));
    for (const c of cells) {
      const letter = c.id[0]!;
      const isLabel = c.id.endsWith("-label");
      regions.push({
        id: c.id,
        role: "cell",
        parent: parentId,
        at: {
          row: (["s","a","b","c","d"].indexOf(letter) + 1) as 1|2|3|4|5,
          col: (isLabel ? 1 : 2) as 1|2,
        },
        rect: c.rect,
        z: 3,
        paint: isLabel
          ? { fill: ({ s: "#E85D4C", a: "#F0A04B", b: "#E8C84A", c: "#C5D35C", d: "#6BBF8A" } as Record<string, string>)[letter] || "#888", border: { color: "#000000", width: 0.012 } }
          : { fill: "#1a1a1a", border: { color: "#000000", width: 0.01 } },
        label: isLabel ? `tier ${letter.toUpperCase()} label` : `tier ${letter.toUpperCase()} thumbs`,
      });
      origins?.set(c.id, "scanned");
    }
    regions = regions.map((r) => r.id === boardRegionId || /tier-board|tier-list/i.test(r.id)
      ? { ...r, rect: boardRect, paint: { ...(r.paint || {}), fill: r.paint?.fill || "#1a1a1a" },
          grid: { rows: cells.length / 2, cols: 2 } }
      : r);
    notes.push(`${cells.length / 2} tier rows over board ${JSON.stringify(boardRect.map((n) => Math.round(n * 1e4) / 1e4))}`);
  }

  const checked = validateBlueprint({ ...bp, regions, tracks: bp.tracks }, { preserveGeometry: true });
  if (!checked.ok) {
    notes.push(`locate merge failed validation: ${checked.error} — kept pre-validate regions`);
    return { ...bp, regions };
  }
  notes.push(...checked.notes);
  return checked.blueprint;
}

/** Locate named targets on source frames, then Gemini style-recipe pass 2. */

/** Caption must not land on the title banner. If locate confused them, park caption above the board. */
export function sanitizeCaptionVsBanner(bp: Blueprint, hits: GroundHit[], notes: string[]): Blueprint {
  void hits;
  const banner = bp.regions.find((r) => /banner|title/i.test(r.id));
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  const board = bp.regions.find((r) => /tier-board|tier-list|board/i.test(r.id) && !/overlay/i.test(r.id));
  if (!caption) return bp;
  const [, cy, , ch] = caption.rect;
  const overlapsBanner = banner
    ? !(caption.rect[0] + caption.rect[2] <= banner.rect[0] || banner.rect[0] + banner.rect[2] <= caption.rect[0] ||
        caption.rect[1] + caption.rect[3] <= banner.rect[1] || banner.rect[1] + banner.rect[3] <= caption.rect[1])
    : false;
  const tooHigh = cy < 0.2;
  const boardTop = board ? board.rect[1] : 0.55;
  // Overlapping the board is not a mistake — the reference's caption sits ON the top row,
  // and pushing it clear of the board was moving it away from where it was measured. Only a
  // caption that has STARTED below the board's top edge is lost.
  const intoBoard = cy > boardTop + 0.01;
  if (!overlapsBanner && !tooHigh && !intoBoard) return bp;
  const h = Math.max(0.04, Math.min(ch || 0.05, 0.07));
  const y = Math.max(0.35, boardTop - h - 0.01);
  const rect: Rect = [0.12, y, 0.76, h];
  notes.push(
    `caption sanitize: locate put caption at ${JSON.stringify(caption.rect)} (banner-overlap/too-high) → ${JSON.stringify(rect)}`,
  );
  return {
    ...bp,
    regions: bp.regions.map((r) => (r.id === caption.id ? { ...r, rect } : r)),
  };
}

/** inset-card often has paint but no track — mirror cr7/messi portrait content onto it. */
export function ensureInsetAlias(bp: Blueprint, notes: string[]): Blueprint {
  const inset = bp.regions.find((r) => r.id === "inset-card");
  if (!inset) return bp;
  if (bp.tracks.some((t) => t.region === "inset-card")) return bp;
  const donor = bp.tracks.find((t) => /cr7-portrait|messi-portrait/i.test(t.region) && t.kind !== "text");
  if (!donor) return bp;
  notes.push(`inset-card: aliased track from "${donor.region}" (was paint-only white card)`);
  const regions = bp.regions.map((r) => {
    if (r.id !== "inset-card") return r;
    const paint = { ...(r.paint || {}) } as Record<string, unknown>;
    delete paint.fill;
    return { ...r, paint: { ...paint, radius: (paint.radius as number | undefined) ?? 0.12 } as typeof r.paint };
  });
  return {
    ...bp,
    regions,
    tracks: [...bp.tracks, { ...donor, region: "inset-card", items: donor.items.map((it) => ({ ...it })) }],
  };
}



/** The type, sized by the letters that are on the frame rather than by a model's estimate.
 *
 *  Locate gives a box that is "about where the words are", and for a caption that box came
 *  back 40 pixels tall around lettering with a 36-pixel cap — so the composer, doing as it
 *  was told, shrank the type to fit a box that was wrong. The words themselves are countable:
 *  the scan finds the rows of ink, which gives both the box the words really fill and the cap
 *  height they are set at, and the size follows by arithmetic.
 *
 *  The box is then made big enough to HOLD that size — cap height is not a line box — so the
 *  fit in the composer has nothing left to correct. Where the scan finds nothing that looks
 *  like lettering, the located box stands and the model's size with it.
 */
export function fitTypeToInk(
  bp: Blueprint, recipe: FormatRecipe, px: Pixels, notes: string[], measured?: BoardMeasure | null,
  origins?: RegionOrigins,
): { blueprint: Blueprint; recipe: FormatRecipe; captionCap?: number; captionText?: string } {
  const H = bp.canvas.height || px.height;
  const W = bp.canvas.width || px.width;
  let regions = bp.regions;
  let next = recipe;

  const measureRun = (region: BlueprintRegion | undefined, type: typeof recipe.caption.type) => {
    if (!region) return null;
    return scanInkLines(px, region.rect, type.ink, { stroke: type.stroke?.color ?? null });
  };
  /** The words this region carries, for the one thing that needs them: how many characters
   *  the measured width is spread over. */
  const wordsIn = (regionId: string): string => {
    const track = bp.tracks.find((t) => t.region === regionId && t.kind === "text");
    const it = track?.items[0];
    return it ? it.value.replace(/\[\[|\]\]/g, "") : "";
  };

  // The caption: its box is the words, so both the box and the size come from the scan.
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  const capRunRaw = measureRun(caption, recipe.caption.type);
  // A measurement is only worth having if it could be the thing it claims to be. Locate put
  // the caption inside the tier board on one run, the scan dutifully found five pixels of
  // white next to a thumbnail there, and the whole caption band was rebuilt around it at a
  // seven-pixel type size. Lettering a viewer reads is not five pixels tall, and a caption
  // starts above the board even when it hangs over it.
  const capRun = (() => {
    if (!capRunRaw) return null;
    const H0 = bp.canvas.height || px.height;
    if (capRunRaw.capHeight < H0 * 0.012) {
      notes.push(`caption ink ${capRunRaw.capHeight}px tall — too small to be lettering, keeping the located box`);
      return null;
    }
    if (measured && capRunRaw.rect[1] > measured.board[1]) {
      notes.push(`caption ink found inside the board at y=${capRunRaw.rect[1].toFixed(3)} — not the caption, keeping the located box`);
      return null;
    }
    return capRunRaw;
  })();
  if (caption && capRun) {
    const size = Math.min(0.3, capRun.capHeight / CAP_OF_EM / H);
    const text = wordsIn(caption.id);
    const face = faceFromWidth(
      next.caption.type.face,
      Math.ceil(text.length / Math.max(1, capRun.lines)),
      capRun.rect[2] * W,
      size * H,
    );
    if (face) notes.push(`caption face ${next.caption.type.face} → ${face}: the lettering measured narrower than that face sets`);
    const type = { ...next.caption.type, size, maxLines: Math.max(1, capRun.lines), ...(face ? { face } : {}) };
    const strokePx = type.stroke ? type.stroke.width * H : 0;
    // A line box is taller than a capital, and the region clips: the box has to hold the
    // type it was measured from, or the composer shrinks it straight back down again.
    const lineBox = size * H * type.lineHeight * Math.max(1, capRun.lines) + strokePx * 2;
    const cx = capRun.rect[0] + capRun.rect[2] / 2, cy = capRun.rect[1] + capRun.rect[3] / 2;
    // The BAND, not the box of this one line. What was measured is where captions sit and how
    // big they are set; how wide they may run is a property of the frame, and sizing the band
    // to the shortest caption in the film is what made every longer one shrink to fit it.
    const measuredW = capRun.rect[2] + (strokePx * 4 + capRun.capHeight * 0.4) / W;
    const w = Math.min(1, Math.max(measuredW, 0.92));
    const h = Math.max(capRun.rect[3], lineBox / H);
    const centre = Math.min(Math.max(cx, w / 2), 1 - w / 2);
    const rect: Rect = [Math.max(0, centre - w / 2), Math.max(0, cy - h / 2), w, h];
    notes.push(
      `caption measured from its own letters: cap ${capRun.capHeight}px over ${capRun.lines} line(s) → ` +
      `size ${size.toFixed(4)} (was ${recipe.caption.type.size.toFixed(4)}), box ${JSON.stringify(rect.map((n) => Math.round(n * 1e4) / 1e4))}`,
    );
    next = { ...next, caption: { ...next.caption, type } };
    regions = regions.map((r) => (r.id === caption.id ? { ...r, rect } : r));
    origins?.set(caption.id, "scanned");
  }

  // The title: its box is the plate, which was measured already, so only the size is taken.
  const banner = bp.regions.find((r) => /banner|title/i.test(r.id));
  const bannerRun = measureRun(banner, recipe.banner.type);
  if (banner && bannerRun) {
    const size = Math.min(0.3, bannerRun.capHeight / CAP_OF_EM / H);
    const text = wordsIn(banner.id);
    const face = faceFromWidth(
      next.banner.type.face,
      Math.ceil(text.length / Math.max(1, bannerRun.lines)),
      bannerRun.rect[2] * W,
      size * H,
    );
    notes.push(
      `banner measured from its own letters: cap ${bannerRun.capHeight}px over ${bannerRun.lines} line(s) → ` +
      `size ${size.toFixed(4)} (was ${recipe.banner.type.size.toFixed(4)})` +
      (face ? `, face ${next.banner.type.face} → ${face}` : ""),
    );
    next = {
      ...next,
      banner: {
        ...next.banner,
        type: { ...next.banner.type, size, maxLines: Math.max(1, bannerRun.lines), ...(face ? { face } : {}) },
      },
    };
  }

  const measuredCaption = caption && capRun
    ? { captionCap: capRun.capHeight, captionText: wordsIn(caption.id) }
    : {};
  if (regions === bp.regions) return { blueprint: bp, recipe: next, ...measuredCaption };
  const checked = validateBlueprint({ ...bp, regions }, { preserveGeometry: true });
  return { blueprint: checked.ok ? checked.blueprint : { ...bp, regions }, recipe: next, ...measuredCaption };
}




/** The layer the film actually moves in: photographs dropped over the board, in turn.
 *
 *  The reference is not a static board under a talking head. For two or three seconds at a
 *  time it lays a picture over the tier list — hair gel beside a trophy, a Greek statue, a
 *  mocked-up Instagram profile with 679 million followers, Maradona with the cup — and those
 *  inserts are the film. The capture had them all along, timed, under the id "board-overlay",
 *  and the composer threw the whole track away: an earlier capture had used that id for a
 *  duplicate of the board, so a rule was written to skip it, and the rule outlived its reason.
 *
 *  What the capture does NOT have is where each insert sits, because that is geometry, and a
 *  model describing a frame says "split image showing hair gel next to a trophy" for two cards
 *  that arrive a second apart. So each insert is measured on its own: a frame from inside its
 *  span, the board subtracted, and what is left is the card. An insert whose box grows during
 *  its span is two cards arriving in turn, and is split into two.
 */
/** How many times to look at an insert across its life. Eight steps separate two cards
 *  arriving a fifth of a span apart, and each step is a frame grab and an arithmetic scan —
 *  no model, no network. */
const SPAN_STEPS = 8;
/** Two boxes are the same arrangement when every edge agrees to within this much of the
 *  frame. A comparison tolerance, not a fitted threshold: it is the width of the scan's own
 *  uncertainty, and nothing about any particular film. */
const SAME_EDGE = 0.02;
/** How much of its ground a box has to keep to still be the same picture.
 *
 *  Shared area over combined area — the standard way to ask whether two rectangles are the
 *  same rectangle. A card settling into place keeps most of it; a second card beside it, or
 *  a different card in a different place, does not. One measure for both, because from the
 *  pixels' side they are the same question. */
export const SAME_PICTURE = 0.6;
/** Below this share of the biggest sighting, a box is a card still being drawn rather than
 *  a card. Relative, so it means the same on a format with big cards and one with small. */
export const HALF_DRAWN = 0.45;

/** Shared area over combined area, for two boxes. */
export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

function sameBox(a: Rect, b: Rect): boolean {
  return a.every((n, i) => Math.abs(n - b[i]) <= SAME_EDGE);
}

/** The ground a box gained — the strip the newly arrived card occupies.
 *
 *  Returning the pair's whole outline instead would stretch one picture across both, which
 *  is what a single grown rectangle looked like on screen. Whichever side grew more is the
 *  side the new card is on. */
export function gained(before: Rect, after: Rect): Rect {
  const below = (after[1] + after[3]) - (before[1] + before[3]);
  const above = before[1] - after[1];
  const right = (after[0] + after[2]) - (before[0] + before[2]);
  const left = before[0] - after[0];
  const best = Math.max(below, above, right, left);
  if (best <= 0) return after;
  if (best === below) return [after[0], before[1] + before[3], after[2], below];
  if (best === above) return [after[0], after[1], after[2], above];
  if (best === right) return [before[0] + before[2], after[1], right, after[3]];
  return [after[0], after[1], left, after[3]];
}

export async function measureInserts(
  bp: Blueprint, measured: BoardMeasure, sourcePath: string, workDir: string, notes: string[],
  log: GateRecord[] = [],
): Promise<Blueprint> {
  const region = bp.regions.find((r) => /overlay|insert/i.test(r.id) && !/caption|banner/i.test(r.id));
  if (!region) return bp;
  const track = bp.tracks.find((t) => t.region === region.id && (t.kind === "image" || t.kind === "video"));
  if (!track || !track.items.length) return bp;

  const seconds = bp.canvas.seconds;
  const boxAt = async (at: number): Promise<Rect | null> => {
    const t = Math.max(0, Math.min(seconds - 0.05, at));
    try {
      const framePath = path.join(workDir, `insert-${t.toFixed(2)}.jpg`);
      await frameAt(sourcePath, t, framePath);
      const px = await readPixels(framePath);
      return px ? scanOverlay(px, measured) : null;
    } catch { return null; }
  };

  const items: typeof track.items = [];
  let found = 0, split = 0;
  for (const it of track.items) {
    const span = Math.max(it.end - it.start, 0.2);
    // Walk the span instead of sampling two points of it.
    //
    // The rule here used to look at the box at 30% and at 75% and call it two cards if the
    // WIDTH had grown by a quarter. Three numbers, all of them read off one film, and all
    // three wrong on the next one: the reference's last insert puts its second card BELOW
    // the first, so the width grows by a tenth while the height nearly doubles, and the pair
    // came out as a single stretched picture.
    //
    // Nothing needs to be assumed. The box is a measurement and time is cheap: take the
    // whole span in even steps, group the steps that show the same box, and what is left is
    // this film's own account of how many arrangements there were and when each began.
    // No retry here — a span is walked once. As a node it is still worth a GateRecord: the
    // acceptance condition (something sighted somewhere in the span) is the whole gate, and
    // an insert that fails it is a hole in the log exactly as it is a hole in the track below.
    type Shots = { at: number; box: Rect | null }[];
    const spanWalk: Node<null, { shots: Shots; sighted: Shots }> = {
      name: "insert-span",
      describe: () => `${it.start.toFixed(1)}-${it.end.toFixed(1)}s`,
      detail: (out) => (out ? `${out.sighted.length}/${out.shots.length} shot(s) sighted` : "nothing sighted"),
      async run() {
        const shots: Shots = [];
        for (let k = 0; k < SPAN_STEPS; k++) {
          const at = it.start + (span * (k + 0.5)) / SPAN_STEPS;
          shots.push({ at, box: await boxAt(at) });
        }
        return { shots, sighted: shots.filter((s) => s.box) };
      },
      accepts: (out) => out.sighted.length > 0,
    };
    const walked = await runNode(spanWalk, null, log);
    if (!walked) {
      notes.push(`insert ${it.start.toFixed(1)}–${it.end.toFixed(1)}s: nothing over the board there — dropped`);
      continue;
    }
    const sighted = walked.sighted;
    found++;
    // A card caught mid-reveal is a fraction of itself: the reference wipes one in from
    // below, and the frame that lands on the wipe shows a strip a third of the height it
    // settles at. That strip is a moment, not a picture.
    //
    // It is tempting to fix this by ignoring the first and last sighting — and that was
    // tried, and it cost a real second card that happened to arrive near the end of its
    // insert's life. Position in time says nothing; SIZE does. A sighting far smaller than
    // the biggest thing this insert ever showed is that same thing, half drawn.
    const biggest = Math.max(...sighted.map((s) => s.box![2] * s.box![3]));
    const seen = sighted.filter((s) => s.box![2] * s.box![3] >= biggest * HALF_DRAWN);

    // What counts as "still the same picture" is overlap, not size. A card settling keeps
    // almost all of its ground; a different card lands somewhere else, or beside it. This
    // one measure covers both ways the reference changes its inserts — a second card joining
    // the first, and a card replacing one in a different place — and neither had to be
    // guessed at in advance.
    const runs: { from: number; to: number; box: Rect }[] = [];
    for (const s of seen) {
      const last = runs[runs.length - 1];
      if (last && overlap(last.box, s.box!) >= SAME_PICTURE) {
        // Keep the fuller view of a card that is still settling.
        if (s.box![2] * s.box![3] > last.box[2] * last.box[3]) last.box = s.box!;
        last.to = s.at;
        continue;
      }
      runs.push({ from: s.at, to: s.at, box: s.box! });
    }
    notes.push(`insert ${it.start.toFixed(1)}–${it.end.toFixed(1)}s: ${runs.length} picture(s) — ` +
      runs.map((r) => `${r.from.toFixed(1)}s ${r.box.map((n) => n.toFixed(2)).join("/")}`).join("  "));

    if (runs.length > 1) {
      split++;
      runs.forEach((r, i) => {
        const prev = runs[i - 1];
        // Joined, or replaced? A card that lands ON TOP of the ground the last one holds is
        // a second picture beside it, and the first one stays; a card somewhere else has
        // taken its place, and the first one goes.
        const joined = prev ? overlap(prev.box, r.box) > 0 : false;
        const rect = prev && joined ? gained(prev.box, r.box) : r.box;
        const ends = !prev || joined ? it.end : runs[i + 1]?.from ?? it.end;
        items.push({ ...it, start: i === 0 ? it.start : r.from, end: ends, rect, beat: i + 1 });
        if (prev && !joined) items[items.length - 2].end = r.from;
      });
    } else {
      const rect = runs[0].box;
      items.push({ ...it, rect });
      notes.push(`insert ${it.start.toFixed(1)}–${it.end.toFixed(1)}s measured at ${JSON.stringify(rect.map((n) => Math.round(n * 1e3) / 1e3))}`);
    }
  }
  if (!items.length) {
    notes.push(`insert layer: nothing measurable over the board — the track is dropped`);
    return { ...bp, tracks: bp.tracks.filter((t) => t !== track) };
  }

  // The region becomes the area its inserts actually use, so a renderer that clips to it
  // clips to the right thing.
  const union: Rect = [
    Math.min(...items.map((i) => i.rect![0])),
    Math.min(...items.map((i) => i.rect![1])),
    0, 0,
  ];
  union[2] = Math.max(...items.map((i) => i.rect![0] + i.rect![2])) - union[0];
  union[3] = Math.max(...items.map((i) => i.rect![1] + i.rect![3])) - union[1];
  notes.push(`insert layer: ${found} of ${track.items.length} inserts measured${split ? `, ${split} split in two` : ""}, over ${JSON.stringify(union.map((n) => Math.round(n * 1e3) / 1e3))}`);

  const regions = bp.regions.map((r) => (r.id === region.id
    ? { ...r, rect: union, z: Math.max(r.z, 6), role: "overlay" as const }
    : r));
  const tracks = bp.tracks.map((t) => (t === track ? { ...t, items } : t));
  const checked = validateBlueprint({ ...bp, regions, tracks }, { preserveGeometry: true });
  return checked.ok ? checked.blueprint : { ...bp, regions, tracks };
}

/** Does this format shrink a long caption, or show it a few words at a time?
 *
 *  A single frame cannot answer it and a model asked anyway will guess from the sentence it
 *  can see: shown "Ronaldo is D tier." — a complete sentence that fits — it answers "shrink",
 *  which is true of that frame and false of the film.
 *
 *  Two frames answer it outright. Find a moment when the narration is much longer, measure
 *  the capital height there, and compare: type set at the same size for a sentence three times
 *  as long is a format that never shrinks, and one that got smaller is a format that does.
 *  The cost is one frame and one scan — no model, no API call.
 */
export async function measureCaptionOverflow(
  bp: Blueprint, recipe: FormatRecipe, sourcePath: string, workDir: string,
  firstCap: number, firstText: string, notes: string[],
): Promise<"chunk" | "shrink" | null> {
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  if (!caption) return null;
  const track = bp.tracks.find((t) => t.kind === "text" && /caption/i.test(t.region));
  if (!track) return null;
  const longer = track.items
    .filter((it) => it.value.replace(/\s+/g, " ").trim().length > firstText.length * 1.5)
    .sort((a, b) => b.value.length - a.value.length)[0];
  if (!longer) {
    notes.push("caption overflow: every caption is about the same length — nothing to compare, keeping the model's answer");
    return null;
  }
  const at = Math.min(bp.canvas.seconds - 0.05, (longer.start + longer.end) / 2);
  try {
    const framePath = path.join(workDir, `caption-${at.toFixed(2)}.jpg`);
    await frameAt(sourcePath, at, framePath);
    const px = await readPixels(framePath);
    if (!px) return null;
    const run = scanInkLines(px, caption.rect, recipe.caption.type.ink, {
      stroke: recipe.caption.type.stroke?.color ?? null,
    });
    if (!run) {
      notes.push(`caption overflow: no lettering found at t=${at.toFixed(2)} — keeping the model's answer`);
      return null;
    }
    const ratio = run.capHeight / Math.max(1, firstCap);
    const verdict: "chunk" | "shrink" = ratio > 0.8 ? "chunk" : "shrink";
    notes.push(
      `caption overflow measured: ${firstText.length} chars at cap ${firstCap}px vs ` +
      `${longer.value.length} chars at cap ${run.capHeight}px (${ratio.toFixed(2)}×) → ${verdict}`,
    );
    return verdict;
  } catch (e) {
    notes.push(`caption overflow: second frame failed (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

/** A caption that does not fit one line becomes several captions, in turn.
 *
 *  The reference never shrinks its captions and never wraps them: it shows "Built like" then
 *  "a Greek god," then "plays like a Greek tragedy" — a few words at a time, always at the
 *  same size, in time with the speaker. A capture writes the whole sentence as one item
 *  because that is what a sentence is, and the composer, told to fit it into one line, set it
 *  at a third of the measured size. Three captions in one film, three different sizes.
 *
 *  So the sentence is cut into the lines the band can actually hold, and the item's own span
 *  is divided between them in proportion to their length — which is as close to the rhythm of
 *  speech as anything without word timings can be, and is a great deal closer than one line
 *  of six-point type. A format that really does shrink says so in the recipe and skips this.
 */
export function chunkCaptionsToBand(bp: Blueprint, recipe: FormatRecipe, notes: string[]): Blueprint {
  if (recipe.caption.overflow !== "chunk") return bp;
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  if (!caption) return bp;
  const W = bp.canvas.width, H = bp.canvas.height;
  const type = recipe.caption.type;
  const sizePx = type.size * H;
  const perLine = Math.max(6, Math.floor((caption.rect[2] * W * 0.94) / (sizePx * FACE_WIDTHS[type.face])));

  let split = 0;
  const tracks = bp.tracks.map((t) => {
    if (t.kind !== "text" || t.region !== caption.id) return t;
    const items = t.items.flatMap((it) => {
      const words = it.value.replace(/\[\[|\]\]/g, "").split(/\s+/).filter(Boolean);
      if (!words.length) return [it];
      const lines: string[] = [];
      let line: string[] = [];
      for (const w of words) {
        if (line.length && (line.join(" ") + " " + w).length > perLine) { lines.push(line.join(" ")); line = []; }
        line.push(w);
      }
      lines.push(line.join(" "));
      if (lines.length < 2) return [it];
      split++;
      const total = lines.reduce((a, l) => a + l.length, 0) || 1;
      let at = it.start;
      const span = Math.max(it.end - it.start, 0.2);
      return lines.map((l, i) => {
        const share = span * (l.length / total);
        const start = at;
        at = i === lines.length - 1 ? it.end : at + share;
        // The pill sits on the word being said, and a chunk ends on it — so the last word of
        // each chunk is the one marked. Nothing is marked when the format has no pill.
        const value = recipe.caption.karaoke
          ? l.replace(/(\s|^)(\S+)$/, (_m, sp: string, last: string) => `${sp}[[${last}]]`)
          : l;
        return { ...it, start, end: i === lines.length - 1 ? it.end : at, value };
      });
    });
    return { ...t, items };
  });
  if (!split) return bp;
  // The cut is made between WORDS; the character count is only how many of them fit the
  // band. The times handed out here are provisional — a share of the span proportional to
  // length — and the aligner replaces them with the real ones a moment later.
  notes.push(`caption: ${split} line(s) wider than the band split at word boundaries (~${perLine} characters fit), timed provisionally`);
  const checked = validateBlueprint({ ...bp, tracks }, { preserveGeometry: true });
  return checked.ok ? checked.blueprint : { ...bp, tracks };
}

/** One item per tile the row actually holds.
 *
 *  A capture describes a row as one thing — "three portraits side by side" — because that is
 *  what it looks like to describe. The renderer needs three, because three is how many
 *  pictures go in it, and the caller needs three keys to hand three assets to. The scan has
 *  already counted them, so the row is split to match rather than left for a CSS rule to
 *  stretch one picture across the whole slot.
 *
 *  Rows that already carry enough items are left exactly as they are: the capture watched
 *  the film and this did not. */
export function fitSlotItemsToTiles(bp: Blueprint, recipe: FormatRecipe, notes: string[]): Blueprint {
  const want = new Map(
    recipe.tiers.filter((t) => typeof t.count === "number" && t.count! > 0).map((t) => [t.id.toLowerCase(), t.count!]),
  );
  if (!want.size) return bp;
  let changed = 0;
  const tracks = bp.tracks.map((t) => {
    const m = /^([a-z0-9]{1,4})-slot$/i.exec(t.region);
    if (!m || t.kind === "text" || t.kind === "color") return t;
    const n = want.get(m[1].toLowerCase());
    if (!n || !t.items.length || t.items.length >= n) return t;
    // Each item becomes n tiles on ITS OWN clock, rather than the row's items being dealt
    // out one per tile. A row holds n pictures for as long as it holds anything; spreading
    // two items across three tiles drew one tile at a time, because only one of the two was
    // on screen at the moment the frame was taken.
    const items = t.items.flatMap((it) => Array.from({ length: n }, (_, i) => ({ ...it, beat: i + 1 })));
    changed++;
    notes.push(`row "${t.region}": ${t.items.length} item(s) → ${n} tiles, as counted in the frame`);
    return { ...t, items };
  });
  if (!changed) return bp;
  const checked = validateBlueprint({ ...bp, tracks }, { preserveGeometry: true });
  return checked.ok ? checked.blueprint : { ...bp, tracks };
}

/** A title plate that does not reach the top edge.
 *
 *  This used to move the plate up, because the frame behind it was black and the gap read as
 *  a letterbox bar. Measured on the reference: there IS footage above the plate — a strip of
 *  the room — and flushing the plate to the top is a visible difference from the source. So
 *  the gap is filled by the thing that belongs there instead, and the plate stays where it
 *  was measured. Only when nothing is behind it does the old behaviour apply.
 */
export function flushBannerToTop(bp: Blueprint, notes: string[]): Blueprint {
  const banner = bp.regions.find((r) => /banner|title/i.test(r.id));
  if (!banner) return bp;
  const [, y, , h] = banner.rect;
  if (y <= 0.005) return bp;
  const covered = bp.regions.some((r) =>
    r.id !== banner.id && r.z < banner.z && r.rect[1] <= y + 0.005 && r.rect[1] + r.rect[3] >= y + h);
  if (covered) {
    notes.push(`banner left at y ${y.toFixed(3)} — the host covers the strip above it`);
    return bp;
  }
  const nh = Math.min(1, y + h);
  notes.push(`banner flush to top: y ${y.toFixed(3)}→0 height ${h.toFixed(3)}→${nh.toFixed(3)} (nothing behind it)`);
  return {
    ...bp,
    regions: bp.regions.map((r) =>
      r.id === banner.id ? { ...r, rect: [0, 0, 1, nh] as Rect } : r,
    ),
  };
}


/** The host fills the frame behind everything, from the top edge down to the board.
 *
 *  Not "between the banner and the board": the banner sits OVER the footage in the reference,
 *  and a host that starts below it leaves a strip of black at the top and forces the banner
 *  to be moved to hide it. Covering from zero is both simpler and what the source does — and
 *  it retires the padded host image that was standing in for it. */
export function fillPresenterBetween(bp: Blueprint, notes: string[]): Blueprint {
  const board = bp.regions.find((r) => /tier-board|tier-list/i.test(r.id) && !/overlay/i.test(r.id));
  const host = bp.regions.find((r) => /presenter|host/i.test(r.id) || r.role === "figure");
  if (!host || !board) return bp;
  const bot = board.rect[1];
  if (!(bot > 0.1)) return bp;
  const rect: Rect = [0, 0, 1, bot];
  if (Math.abs(host.rect[0]) < 1e-3 && Math.abs(host.rect[1]) < 1e-3
    && Math.abs(host.rect[2] - 1) < 1e-3 && Math.abs(host.rect[3] - bot) < 1e-3) return bp;
  notes.push(`presenter covers top→board ${JSON.stringify(host.rect)} → ${JSON.stringify(rect)}`);
  return { ...bp, regions: bp.regions.map((r) => (r.id === host.id ? { ...r, rect } : r)) };
}

export async function refineBlueprint(
  bp: Blueprint,
  sourcePath: string,
  opts: { at?: number[]; targets?: GroundTarget[]; workDir: string; skipRecipe?: boolean },
): Promise<GroundResult> {
  const orKey = await openRouterKey();
  const dsKey = orKey ? null : await apiKey();
  if (!orKey && !dsKey) {
    return { ok: false, error: "No OpenRouter (or DashScope) key for locate.", status: 503 };
  }

  await mkdir(opts.workDir, { recursive: true });
  const seconds = bp.canvas.seconds;
  const at = (opts.at?.length ? opts.at : [seconds * 0.35]).map((n) =>
    Math.max(0, Math.min(seconds - 0.05, n)));
  const targets = opts.targets?.length ? opts.targets : targetsFromBlueprint(bp);
  if (!targets.length) return { ok: false, error: "no locate targets", status: 400 };

  const hits: GroundHit[] = [];
  const frames: string[] = [];
  const notes: string[] = [];
  const log: GateRecord[] = [];
  // Provenance for every region this pass touches. Nothing seeds it — a rect the capture
  // guessed has no entry until something here actually measures it, which is the whole point.
  const origins: RegionOrigins = new Map();
  const via = orKey ? `openrouter:${GROUND_MODEL}` : `dashscope:${process.env.GROUND_FALLBACK_MODEL || "qwen-vl-max"}`;
  notes.push(`locate via ${via}`);

  let primaryFrame: string | undefined;

  for (const tSec of at) {
    const framePath = path.join(opts.workDir, `frame-${tSec.toFixed(2)}.jpg`);
    await frameAt(sourcePath, tSec, framePath);
    frames.push(framePath);
    if (!primaryFrame) primaryFrame = framePath;
    const jpeg = await readFile(framePath);
    for (const t of targets) {
      if (hits.some((h) => h.id === t.id)) continue;
      try {
        const raw = orKey
          ? await locateOpenRouter(orKey, GROUND_MODEL, jpeg, t.query)
          : await locateDashScope(dsKey!, jpeg, t.query);
        const rect = raw ? box2dToRect(raw) : null;
        if (!rect) {
          notes.push(`no box for "${t.id}" at t=${tSec.toFixed(2)}`);
          continue;
        }
        hits.push({ id: t.id, rect, raw: raw || undefined, via });
        const mark = path.join(opts.workDir, `hit-${t.id}.jpg`);
        await drawHit(framePath, rect, mark);
        frames.push(mark);
        notes.push(`located "${t.id}" @ t=${tSec.toFixed(2)} → ${JSON.stringify(rect)}`);
      } catch (e) {
        notes.push(`locate "${t.id}" failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (!hits.length) return { ok: false, error: `no targets located (${notes.join("; ")})`, status: 502 };

  // Between locate and the recipe: count what can be counted. The board's grid, its plate
  // colours, its tile size and how many tiles each row holds are arithmetic, and asking a
  // model for them was the reason the render kept being nearly right.
  let pixels: Pixels | null = null;
  let measured: BoardMeasure | null = null;
  const boardHit = hits.find((h) => /tier-board|tier-list|board/i.test(h.id));
  if (primaryFrame) {
    pixels = await readPixels(primaryFrame);
    if (!pixels) notes.push("pixel scan: could not decode the frame — model values stand");
  }
  const boardRegion = bp.regions.find((r) => /tier-board|tier-list|board/i.test(r.id) && !/overlay/i.test(r.id));
  if (pixels && (boardHit || boardRegion)) {
    // Locate is asked where the board is, and sometimes answers with the same four numbers in
    // the other order — a horizontal board comes back as a vertical strip down the right of
    // the frame, and every row synthesised inside it is nonsense. Measured on one run of this
    // very film: the board located as [0.551, 0, 0.449, 1].
    //
    // The scan can settle it, because it is a test and not an opinion: either there is a grid
    // of equal rows in that box or there is not. So the box is not trusted, it is TRIED —
    // as given, as its own transposition, and finally anywhere in the frame — and whichever
    // one actually contains a board is the one that wins.
    // Locate is a hint, and sometimes not even that: on one run of this film it returned no
    // board at all, and the scan — which was only being asked when locate had answered — never
    // ran, so the render fell back to the capture's guessed rows. The scan is the authority
    // here; it is asked whether or not anything pointed it at a box.
    const tries: { rect: Rect; how: string; coverage?: number }[] = [];
    if (boardHit) {
      const [bx, by, bw, bh] = boardHit.rect;
      const transposed: Rect = [by, bx, bh, bw];
      tries.push({ rect: boardHit.rect, how: "as located" });
      if (transposed[0] + transposed[2] <= 1.05 && transposed[1] + transposed[3] <= 1.05) {
        tries.push({ rect: transposed, how: "with its sides read the other way round" });
      }
    }
    tries.push({ rect: [0, 0, 1, 1] as Rect, how: "searched over the whole frame", coverage: 0 });
    for (const t of tries) {
      measured = scanBoard(pixels, t.rect, t.coverage === undefined ? {} : { coverage: t.coverage });
      if (measured) {
        if (t.how !== "as located") {
          const from = boardHit ? JSON.stringify(boardHit.rect.map((n) => Math.round(n * 1e4) / 1e4)) : "nothing";
          notes.push(`board ${t.how}: locate gave ${from}, the grid is at ` +
            `${JSON.stringify(measured.board.map((n) => Math.round(n * 1e4) / 1e4))}`);
        }
        notes.push(...measured.notes);
        break;
      }
    }
    // One frame is not a measurement of a film.
    //
    // The board is scanned at the locus Omni chose, and that locus is chosen because
    // something INTERESTING happens there — which, in this format, means a photograph is
    // lying across the board. Measured on the reference: at t=8.5 a mock profile card covers
    // four of the five rows, the scan correctly reports "no grid", and the whole measurement
    // collapses. Worse, it collapses silently into "the model's numbers stand", and the
    // inserts lose their boxes too, because an insert is found by the board rules it crosses.
    //
    // So the board is looked for across the film rather than at one moment, and the frame
    // that shows the MOST rows wins. A board is furniture: it does not change between
    // seconds, so any frame that can see all of it is as good as any other — and a frame
    // with something lying on it can only ever see less.
    const scanCandidates: { rect: Rect; how: string; coverage?: number }[] = tries;
    const sweepAt = "the frame that was already open";
    const sweep: number[] = [];
    for (let k = 0; k < BOARD_SWEEP; k++) sweep.push(((k + 0.5) / BOARD_SWEEP) * seconds);
    let sweepIdx = 0;

    // As a node: the frame Omni already opened is `attempt` 1 — no extra frame grab — and
    // each retry after that is the next frame in `sweep`. `accepts` is the same test the
    // hand-written loop broke on (rows >= EXPECTED_MAX_ROWS); giving up after the eighth
    // keeps whichever frame found the most rows, which may still be short of a full board
    // but is a measurement, not a guess.
    let best: { measure: BoardMeasure; at: string } | null = measured ? { measure: measured, at: sweepAt } : null;
    const boardSweep: Node<number, { measure: BoardMeasure; at: string }> = {
      name: "board-sweep",
      describe: (tSec) => (Number.isNaN(tSec) ? sweepAt : `t=${tSec.toFixed(2)}`),
      detail: (out) => (out ? `${out.measure.rows.length} row(s) at ${out.at}` : "no grid this frame"),
      async run(tSec, attempt) {
        if (attempt === 1) return best;
        let px: Pixels | null = null;
        try {
          const sweepFrame = path.join(opts.workDir, `board-${tSec.toFixed(2)}.jpg`);
          await frameAt(sourcePath, tSec, sweepFrame);
          px = await readPixels(sweepFrame);
        } catch { /* a frame that will not decode is simply not a candidate */ }
        if (!px) return null;
        let frameBest: BoardMeasure | null = null;
        for (const t of scanCandidates) {
          const got = scanBoard(px, t.rect, t.coverage === undefined ? {} : { coverage: t.coverage });
          if (got && (!frameBest || got.rows.length > frameBest.rows.length)) frameBest = got;
        }
        if (!frameBest) return null;
        if (!best || frameBest.rows.length > best.measure.rows.length) {
          best = { measure: frameBest, at: `t=${tSec.toFixed(2)}` };
        }
        return best;
      },
      accepts: (out) => out.measure.rows.length >= EXPECTED_MAX_ROWS,
      retry: () => (sweepIdx < sweep.length ? sweep[sweepIdx++]! : null),
      onGiveUp: () => best,
    };

    const boardResult = await runNode(boardSweep, NaN, log);
    measured = boardResult ? boardResult.measure : null;
    if (measured && boardResult!.at !== sweepAt) {
      notes.push(`board measured from ${boardResult!.at}: ${measured.rows.length} rows — the frame Omni picked had something lying across it`);
      notes.push(...measured.notes);
    }
    if (!measured) notes.push(`pixel scan: no regular grid anywhere in the frame — model values stand`);
  }

  let next = applyHits(bp, hits, notes, measured, origins);
  // sanitizeCaptionVsBanner does not take `origins`: it repositions a caption using facts
  // already on hand (the board's top edge, the banner's box), never a new measurement of its
  // own. That omission is deliberate, not an oversight — see the file header on RegionOrigin.
  // A rect it nudges keeps whatever provenance it already had, which for a caption locate
  // never answered is none, and staying none through a nudge is the fix this type exists for.
  next = sanitizeCaptionVsBanner(next, hits, notes);

  // The title plate, snapped to its own edges. Locate is a few pixels out and a few pixels
  // of footage showing under a cream bar is the kind of wrong that reads as a bug.
  const bannerRegion = next.regions.find((r) => /banner|title/i.test(r.id));
  if (pixels && bannerRegion) {
    const plate = scanPlate(pixels, bannerRegion.rect);
    if (plate) {
      notes.push(`banner plate measured ${JSON.stringify(bannerRegion.rect.map((n) => Math.round(n * 1e4) / 1e4))} → ${JSON.stringify(plate.rect.map((n) => Math.round(n * 1e4) / 1e4))} fill ${plate.fill}`);
      next = { ...next, regions: next.regions.map((r) => (r.id === bannerRegion.id ? { ...r, rect: plate.rect } : r)) };
      origins.set(bannerRegion.id, "scanned");
    }
  }

  // The host first: whether the strip above the title plate needs closing depends on whether
  // anything is behind it, and the host is what goes behind it.
  next = fillPresenterBetween(next, notes);
  next = flushBannerToTop(next, notes);
  next = ensureInsetAlias(next, notes);

  let recipe: FormatRecipe | null = null;
  if (!opts.skipRecipe && primaryFrame) {
    recipe = await authorRecipe(primaryFrame, hits, measured, bp.canvas, notes);
    // The plate colour is one more thing that was counted rather than remembered.
    if (pixels && bannerRegion) {
      const plate = scanPlate(pixels, bannerRegion.rect);
      if (plate) recipe = { ...recipe, banner: { ...recipe.banner, plate: plate.fill } };
    }
    if (pixels) {
      const fitted = fitTypeToInk(next, recipe, pixels, notes, measured, origins);
      next = fitted.blueprint;
      recipe = fitted.recipe;
      // Whether this format shrinks a long caption or shows it in chunks: a second frame
      // settles it, and the model's guess from one frame is routinely the wrong way round.
      if (fitted.captionCap && fitted.captionText) {
        const overflow = await measureCaptionOverflow(
          next, recipe, sourcePath, opts.workDir, fitted.captionCap, fitted.captionText, notes,
        );
        if (overflow && overflow !== recipe.caption.overflow) {
          notes.push(`caption overflow: model said "${recipe.caption.overflow}", the frames say "${overflow}"`);
          recipe = { ...recipe, caption: { ...recipe.caption, overflow } };
        }
      }
    }
    next = applyRecipe(next, recipe, notes);
    next = fitSlotItemsToTiles(next, recipe, notes);
    next = chunkCaptionsToBand(next, recipe, notes);
    if (measured) next = await measureInserts(next, measured, sourcePath, opts.workDir, notes, log);
    try {
      await writeFile(path.join(opts.workDir, "recipe.json"), JSON.stringify(recipe, null, 2));
      notes.push(`wrote recipe.json`);
    } catch (e) {
      notes.push(`recipe.json write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ok: true, blueprint: next, hits, notes, frames, recipe, measure: measured, log, origins };
}
