// The blueprint: what a watched video is made of, as data rather than prose.
//
// The teardown answers "how was this made" for a person to read. Nothing can be rebuilt
// from it: every beat comes back as one flat scene with a sentence attached, so a title
// bar, a presenter, a caption and a tier list all arrive as the same thing — "b-roll" —
// and the renderer has one layout to put them in. Measured: a reference in 720x1280 with
// four things on screen at once came out as a 1920x1080 film with one clip and a caption.
//
// So this is the other output, and its shape follows from that failure rather than from
// anyone else's schema. Three decisions, each with a reason:
//
//   REGIONS, because the missing information is WHERE. A tier list at the bottom and a
//   presenter above it are not two scenes, they are two places on one screen at once.
//
//   TRACKS HELD APART FROM BEATS, because the missing information is WHEN, at a finer
//   grain than a cut. A caption landing word by word over a frame that never changes is
//   the reference's whole rhythm, and a scene list cannot say it.
//
//   FRACTIONAL GEOMETRY, because a clone is rendered at whatever size the copy needs, and
//   a rect in pixels quietly means a different place on a different canvas.
//
// Layers, rectangles, paint order and time ranges are the ordinary vocabulary of putting
// pictures on a screen; the arrangement here is ours, written against this pipeline\'s own
// renderer. Prior art was read for what problems exist, never for code or schema — see the
// comparison note in the repo, and its licence findings.
//
// Two layers are meant here, and only the first is written down by the model. The CAPTURE
// is this: where things are and when, measured. The FORMAT — the same regions with the
// content taken out, plus named slots for what changes — is DERIVED from a capture, and
// that derivation is what makes a watched video reusable instead of merely copyable. Social
// formats repeat: a tier list is the layout plus "one subject per beat", and a second video
// in the same format differs only in the subjects.
//
// Three fields exist solely so that derivation never needs a second pass over the video:
// `parent` (a slot belongs to a board, so it has a place in a grid), `beat` (which
// repetition an item belongs to, so the repeating unit is visible), and `varies` (whether a
// track carries the format or the episode). Without them a format could only be recovered
// by analysing the same file again.
//
// One discipline is enforced rather than suggested: every field is required, values come
// from fixed lists, and something absent is left out rather than written as an empty
// string. A schema that is only sometimes filled in cannot be validated, and a blueprint
// that validates is the entire reason this exists.

export const BLUEPRINT_VERSION = "omniwatch.blueprint/1";

/** What a region DOES in the layout.
 *
 *  The first version of this list was written from one video and read like its table of
 *  contents: title_bar, presenter, board, sticker. That is a genre, not a vocabulary — a
 *  screen recording with a webcam bubble, a text-message story, an overhead recipe and a
 *  split-screen debate have none of those parts, and every new format would have needed a
 *  new word.
 *
 *  These six are layout functions instead, and they compose. A title strip and a word-timed
 *  caption are both `text`, told apart by where they sit and whether they change per beat —
 *  which is measured here anyway, and is more honest than a name. What a region is FOR in
 *  human terms goes in `label`, where it can be anything without the schema growing. */
export const REGION_ROLES = [
  "backdrop",  // fills the frame behind everything: colour, footage, a set
  "figure",    // a subject in shot: presenter, avatar, interviewee, hands
  "overlay",   // layered over another region: inset, bubble, logo, reaction, sticker
  "text",      // an area whose content is words: title, caption, label, ticker
  "panel",     // a bounded area holding structured content, often subdivided
  "cell",      // one subdivision of a panel, addressed by grid position
] as const;
export type RegionRole = (typeof REGION_ROLES)[number];

/** What kind of content a track puts into its region. */
export const TRACK_KINDS = ["text", "image", "video", "color"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

/** Where a slot's content COMES FROM — the decision that was missing, and it cost a film.
 *
 *  A tier row is a coloured rectangle with a letter on it. Asked to GENERATE that, an image
 *  model produced a picture of a whole tier list squeezed into one row, complete with its
 *  own letters. The row was never a photograph; it was a shape, and shapes belong to the
 *  renderer. Meanwhile a presenter cannot be drawn and a product demo's b-roll should not be
 *  invented at all — it already exists inside the video being analysed.
 *
 *  So the source is recorded per track rather than inferred from the kind:
 *    draw     — the renderer makes it out of the blueprint itself: words, colours, boxes,
 *               rules, a card's rounded corner. Costs nothing, is exact, and is the right
 *               answer for all structure.
 *    generate — a model makes a picture or a clip from `value`. For anything photographic
 *               that does not exist yet: a presenter, a set, an illustration.
 *    cut      — taken from a source video that was analysed. A product demo's b-roll is the
 *               demo; generating a lookalike would be both worse and dishonest.
 *    supply   — a file the caller provides: a logo, a brand asset, a real screenshot. The
 *               pipeline must not invent these and must not pretend it can.
 *
 *  Absent, it is read from the kind: words and colours are drawn, pictures are generated.
 *  That keeps older captures valid while making the choice sayable. */
export const FILL_SOURCES = ["draw", "generate", "cut", "supply"] as const;
export type FillSource = (typeof FILL_SOURCES)[number];
export function defaultFill(kind: TrackKind): FillSource {
  return kind === "text" || kind === "color" ? "draw" : "generate";
}

/** How a region's own surface is painted, before any track content lands on it.
 *
 *  Without this a coloured tier row, a white title strip and a rounded inset card can only
 *  be reproduced by generating a BITMAP of a rectangle — which is what turned five tier
 *  rows into five wrong photographs. A rectangle is not something to photograph. */
export interface RegionPaint {
  /** Hex. The region's background. */
  fill?: string;
  /** Corner rounding, as a fraction of the region's shorter side, so it survives a resize. */
  radius?: number;
  /** An outline, its width a fraction of the region's shorter side. */
  border?: { color: string; width: number };
}

export const TEXT_CASES = ["as-is", "upper", "lower", "title"] as const;
export type TextCase = (typeof TEXT_CASES)[number];

/** The look of words, which is not decoration — it is how a format reads.
 *
 *  Measured against a reference: its title was BLACK ON WHITE and we drew white on black;
 *  its caption underlined the one word carrying the joke and we drew a flat line. A schema
 *  with no way to say either produces a video that is the right shape and the wrong film. */
export interface TextStyle {
  /** Hex, the glyphs themselves. */
  color?: string;
  /** Hex, a plate behind the whole line. */
  background?: string;
  /** Hex, a stroke around the glyphs — what keeps a caption readable over footage. */
  outline?: string;
  /** 400-900. */
  weight?: number;
  /** Height of a line as a fraction of the CANVAS height, so it scales with the frame. */
  size?: number;
  /** How the words are cased on screen.
   *
   *  Four, not two. The first format this schema met shouts in capitals, so "upper" and
   *  "as-is" looked like the whole world; the second one sets every caption in lower case
   *  and was REFUSED by the validator. A vocabulary drawn from one video is the failure
   *  this field is now a record of. */
  case?: "as-is" | "upper" | "lower" | "title";
  align?: "left" | "center" | "right";
  /** How a marked span is set apart. In `value`, the span is wrapped in [[double
   *  brackets]] — one string stays one string, and a format that emphasises nothing simply
   *  never uses them. */
  emphasis?: { style: "highlight" | "underline" | "color"; color: string };
}

/** The words of a text item, split into the plain and the emphasised, in order. */
export function splitEmphasis(value: string): { text: string; strong: boolean }[] {
  const out: { text: string; strong: boolean }[] = [];
  const re = /\[\[([\s\S]*?)\]\]/g;
  let at = 0, m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (m.index > at) out.push({ text: value.slice(at, m.index), strong: false });
    if (m[1]) out.push({ text: m[1], strong: true });
    at = m.index + m[0].length;
  }
  if (at < value.length) out.push({ text: value.slice(at), strong: false });
  return out.length ? out : [{ text: value, strong: false }];
}

/** Fractions of the canvas: [x, y, w, h], origin top-left. */
export type Rect = [number, number, number, number];

export interface BlueprintRegion {
  id: string;
  role: RegionRole;
  rect: Rect;
  /** Higher paints later. Explicit so two regions that overlap have a defined order. */
  z: number;
  /** The region this one sits inside, when that is the real relationship: a cell belongs to
   *  its panel, an overlay sits over a figure. Absent for a top-level region. `rect` stays a
   *  fraction of the CANVAS either way — nesting records structure, not a coordinate
   *  system, because a panel that moves should not silently move its cells. */
  parent?: string;
  /** What this area is called in the language of the format — "tier row S", "webcam
   *  bubble", "ingredient list", "reply from mum". Free text on purpose: the roles above
   *  have to stay closed to be laid out, and the endlessly varying part is a name. */
  label?: string;
  /** For a `panel` that is divided into a regular grid, how many rows and columns it has.
   *  Tier rows, a 2-up comparison, a 3x3 bingo card, a leaderboard are all this. */
  grid?: { rows: number; cols: number };
  /** For a `cell`, where it sits in its parent's grid, counting from 1. This is what makes
   *  a structure addressable: without it a tier list is a picture of a tier list, and a
   *  clone cannot know which row an item lands in. */
  at?: { row: number; col: number };
  /** The region's own surface: its colour, its corner, its outline. */
  paint?: RegionPaint;
}

export interface BlueprintItem {
  start: number;
  end: number;
  /** Which repetition of the format's unit this belongs to, counting from 1 — the third
   *  ranked subject, the second tip. Absent for anything that is not part of the repeating
   *  structure, such as a title that holds for the whole video. This is the field that lets
   *  a format be lifted out later: the unit is whatever carries a beat. */
  beat?: number;
  /** For kind "text": the exact words on screen. For image/video: what is depicted, as an
   *  instruction a generator can act on. For "color": a hex value. Never empty — an empty
   *  item is a gap, and a gap is expressed by not having an item. */
  value: string;
}

export interface BlueprintTrack {
  region: string;
  kind: TrackKind;
  /** Does this track carry the FORMAT or the EPISODE?
   *  "fixed"   — the same in every video of this format (the tier rows, the frame colour).
   *  "episode" — changes with the subject (the title, the narration, each subject's image).
   *  Marked at capture because the model can see which is which and a later pass cannot. */
  varies: "fixed" | "episode";
  /** Where this track's content comes from. Absent means the kind decides. */
  fill?: FillSource;
  /** For kind "text": how the words are set. */
  style?: TextStyle;
  items: BlueprintItem[];
}

export interface BlueprintCanvas {
  width: number;
  height: number;
  fps: number;
  seconds: number;
}

export interface Blueprint {
  version: typeof BLUEPRINT_VERSION;
  canvas: BlueprintCanvas;
  regions: BlueprintRegion[];
  tracks: BlueprintTrack[];
}

const MAX_REGIONS = 24;
const MAX_TRACKS = 32;
const MAX_ITEMS = 400;
const MAX_VALUE = 600;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function badRect(r: unknown): string | null {
  if (!Array.isArray(r) || r.length !== 4) return "must be [x, y, w, h]";
  for (const n of r) if (num(n) === null) return "must be four numbers";
  const [x, y, w, h] = r as number[];
  if (w <= 0 || h <= 0) return "width and height must be above zero";
  // Slightly outside is allowed: things legitimately bleed off the canvas edge.
  if (x < -1 || y < -1 || x > 2 || y > 2 || w > 3 || h > 3) return "fractions must be near 0..1 of the canvas";
  return null;
}

/** A colour is only ever a plain hex. It reaches a style attribute in the end, and a value
 *  we did not choose does not belong there — refused rather than escaped. */
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const hex = (v: unknown): string | null =>
  typeof v === "string" && HEX.test(v.trim()) ? v.trim() : null;

function readPaint(v: unknown, at: string): { paint?: RegionPaint; error?: string } {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) return { error: `${at} must be an object` };
  const paint: RegionPaint = {};
  if (v.fill !== undefined && v.fill !== null) {
    const f = hex(v.fill);
    if (!f) return { error: `${at}.fill must be a hex colour` };
    paint.fill = f;
  }
  if (v.radius !== undefined && v.radius !== null) {
    const r = num(v.radius);
    if (r === null || r < 0 || r > 1) return { error: `${at}.radius must be 0..1 of the shorter side` };
    paint.radius = r;
  }
  if (v.border !== undefined && v.border !== null) {
    if (!isObj(v.border)) return { error: `${at}.border must be { color, width }` };
    const c = hex(v.border.color), w = num(v.border.width);
    if (!c) return { error: `${at}.border.color must be a hex colour` };
    if (w === null || w <= 0 || w > 0.5) return { error: `${at}.border.width must be 0..0.5 of the shorter side` };
    paint.border = { color: c, width: w };
  }
  return { paint: Object.keys(paint).length ? paint : undefined };
}

function readStyle(v: unknown, at: string): { style?: TextStyle; error?: string } {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) return { error: `${at} must be an object` };
  const st: TextStyle = {};
  for (const k of ["color", "background", "outline"] as const) {
    if (v[k] === undefined || v[k] === null) continue;
    const c = hex(v[k]);
    if (!c) return { error: `${at}.${k} must be a hex colour` };
    st[k] = c;
  }
  if (v.weight !== undefined && v.weight !== null) {
    const w = num(v.weight);
    if (w === null || w < 100 || w > 900) return { error: `${at}.weight must be 100..900` };
    st.weight = Math.round(w / 100) * 100;
  }
  if (v.size !== undefined && v.size !== null) {
    const z = num(v.size);
    if (z === null || z <= 0 || z > 0.5) return { error: `${at}.size must be a fraction of canvas height up to 0.5` };
    st.size = z;
  }
  if (v.case !== undefined && v.case !== null) {
    if (!TEXT_CASES.includes(v.case as TextCase)) {
      return { error: `${at}.case must be one of ${TEXT_CASES.join(", ")}` };
    }
    st.case = v.case as TextCase;
  }
  if (v.align !== undefined && v.align !== null) {
    if (v.align !== "left" && v.align !== "center" && v.align !== "right") return { error: `${at}.align must be left, center or right` };
    st.align = v.align;
  }
  if (v.emphasis !== undefined && v.emphasis !== null) {
    if (!isObj(v.emphasis)) return { error: `${at}.emphasis must be { style, color }` };
    const style = v.emphasis.style;
    if (style !== "highlight" && style !== "underline" && style !== "color") {
      return { error: `${at}.emphasis.style must be highlight, underline or color` };
    }
    const c = hex(v.emphasis.color);
    if (!c) return { error: `${at}.emphasis.color must be a hex colour` };
    st.emphasis = { style, color: c };
  }
  return { style: Object.keys(st).length ? st : undefined };
}

export type BlueprintCheck = { ok: true; blueprint: Blueprint } | { ok: false; error: string };

/** Never throws: a blueprint that came back malformed is a reason to say what is wrong,
 *  not a 500 from halfway through a render. */
export function validateBlueprint(raw: unknown): BlueprintCheck {
  if (!isObj(raw)) return { ok: false, error: "the blueprint must be a JSON object" };
  if (raw.version !== BLUEPRINT_VERSION) return { ok: false, error: `version must be "${BLUEPRINT_VERSION}"` };

  if (!isObj(raw.canvas)) return { ok: false, error: "canvas is required" };
  const c = raw.canvas;
  const width = num(c.width), height = num(c.height), fps = num(c.fps), seconds = num(c.seconds);
  if (width === null || width < 16 || width > 8192) return { ok: false, error: "canvas.width is out of range" };
  if (height === null || height < 16 || height > 8192) return { ok: false, error: "canvas.height is out of range" };
  if (fps === null || fps <= 0 || fps > 240) return { ok: false, error: "canvas.fps is out of range" };
  if (seconds === null || seconds <= 0 || seconds > 7200) return { ok: false, error: "canvas.seconds is out of range" };

  if (!Array.isArray(raw.regions) || raw.regions.length === 0) return { ok: false, error: "at least one region is required" };
  if (raw.regions.length > MAX_REGIONS) return { ok: false, error: `too many regions (max ${MAX_REGIONS})` };
  const regions: BlueprintRegion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.regions.length; i++) {
    const r = raw.regions[i];
    const at = `regions[${i}]`;
    if (!isObj(r)) return { ok: false, error: `${at} must be an object` };
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!/^[a-z0-9_-]{1,40}$/.test(id)) return { ok: false, error: `${at}.id must be lowercase letters, digits, _ or -` };
    if (seen.has(id)) return { ok: false, error: `${at}.id "${id}" is used twice` };
    seen.add(id);
    if (!(REGION_ROLES as readonly string[]).includes(String(r.role))) {
      return { ok: false, error: `${at}.role must be one of ${REGION_ROLES.join(", ")}` };
    }
    const rectErr = badRect(r.rect);
    if (rectErr) return { ok: false, error: `${at}.rect ${rectErr}` };
    const z = num(r.z);
    if (z === null) return { ok: false, error: `${at}.z is required — overlapping regions need a defined order` };
    let parent: string | undefined;
    if (r.parent !== undefined && r.parent !== null && r.parent !== "") {
      if (typeof r.parent !== "string") return { ok: false, error: `${at}.parent must be a region id` };
      parent = r.parent.trim();
      if (parent === id) return { ok: false, error: `${at}.parent cannot be itself` };
    }
    let label: string | undefined;
    if (r.label !== undefined && r.label !== null && r.label !== "") {
      if (typeof r.label !== "string") return { ok: false, error: `${at}.label must be text` };
      label = r.label.trim().slice(0, 80) || undefined;
    }

    const role = r.role as RegionRole;
    let grid: { rows: number; cols: number } | undefined;
    if (r.grid !== undefined && r.grid !== null) {
      if (role !== "panel") return { ok: false, error: `${at}.grid belongs on a panel, not on a ${role}` };
      if (!isObj(r.grid)) return { ok: false, error: `${at}.grid must be { rows, cols }` };
      const rows = num(r.grid.rows), cols = num(r.grid.cols);
      if (rows === null || !Number.isInteger(rows) || rows < 1 || rows > 64) return { ok: false, error: `${at}.grid.rows is out of range` };
      if (cols === null || !Number.isInteger(cols) || cols < 1 || cols > 64) return { ok: false, error: `${at}.grid.cols is out of range` };
      grid = { rows, cols };
    }

    let cellAt: { row: number; col: number } | undefined;
    if (r.at !== undefined && r.at !== null) {
      if (role !== "cell") return { ok: false, error: `${at}.at belongs on a cell, not on a ${role}` };
      if (!isObj(r.at)) return { ok: false, error: `${at}.at must be { row, col }` };
      const row = num(r.at.row), col = num(r.at.col);
      if (row === null || !Number.isInteger(row) || row < 1) return { ok: false, error: `${at}.at.row must be a whole number from 1 up` };
      if (col === null || !Number.isInteger(col) || col < 1) return { ok: false, error: `${at}.at.col must be a whole number from 1 up` };
      cellAt = { row, col };
    }

    const paintRead = readPaint(r.paint, `${at}.paint`);
    if (paintRead.error) return { ok: false, error: paintRead.error };

    regions.push({
      id, role, rect: (r.rect as number[]).slice(0, 4) as Rect, z,
      ...(parent ? { parent } : {}), ...(label ? { label } : {}),
      ...(grid ? { grid } : {}), ...(cellAt ? { at: cellAt } : {}),
      ...(paintRead.paint ? { paint: paintRead.paint } : {}),
    });
  }

  // Parents are checked after the whole list, because a board may legitimately be declared
  // after the slot that names it.
  const byId = new Map(regions.map((r) => [r.id, r]));
  for (const r of regions) {
    if (!r.parent) continue;
    if (!byId.has(r.parent)) return { ok: false, error: `region "${r.id}".parent "${r.parent}" is not a declared region` };
    // A cycle would hang anything that walks the tree to lay a region out.
    const path = new Set([r.id]);
    let cur = byId.get(r.parent);
    while (cur) {
      if (path.has(cur.id)) return { ok: false, error: `regions form a parent loop at "${cur.id}"` };
      path.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }

  // A cell that names a place outside its panel's grid is a measurement that cannot be
  // rendered — row 9 of five tier rows puts the item nowhere.
  for (const r of regions) {
    if (!r.at) continue;
    const host = r.parent ? byId.get(r.parent) : undefined;
    if (!host) return { ok: false, error: `region "${r.id}" has a grid position but no parent panel` };
    if (!host.grid) return { ok: false, error: `region "${r.id}" sits at a grid position but "${host.id}" declares no grid` };
    if (r.at.row > host.grid.rows || r.at.col > host.grid.cols) {
      return { ok: false, error: `region "${r.id}" is at ${r.at.row},${r.at.col} but "${host.id}" is only ${host.grid.rows}x${host.grid.cols}` };
    }
  }

  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) return { ok: false, error: "at least one track is required" };
  if (raw.tracks.length > MAX_TRACKS) return { ok: false, error: `too many tracks (max ${MAX_TRACKS})` };
  const tracks: BlueprintTrack[] = [];
  for (let i = 0; i < raw.tracks.length; i++) {
    const t = raw.tracks[i];
    const at = `tracks[${i}]`;
    if (!isObj(t)) return { ok: false, error: `${at} must be an object` };
    const region = typeof t.region === "string" ? t.region.trim() : "";
    if (!seen.has(region)) return { ok: false, error: `${at}.region "${region}" is not a declared region` };
    if (!(TRACK_KINDS as readonly string[]).includes(String(t.kind))) {
      return { ok: false, error: `${at}.kind must be one of ${TRACK_KINDS.join(", ")}` };
    }
    if (t.varies !== "fixed" && t.varies !== "episode") {
      return { ok: false, error: `${at}.varies must be "fixed" or "episode" — a track that does not say which cannot become a format` };
    }
    const kind = t.kind as TrackKind;
    let fillSource: FillSource | undefined;
    if (t.fill !== undefined && t.fill !== null) {
      if (!(FILL_SOURCES as readonly string[]).includes(String(t.fill))) {
        return { ok: false, error: `${at}.fill must be one of ${FILL_SOURCES.join(", ")}` };
      }
      fillSource = t.fill as FillSource;
      // Words and colours are made by the renderer out of the blueprint. Saying they come
      // from a generator would send a rectangle to an image model, which is the mistake
      // this field exists to stop.
      if ((kind === "text" || kind === "color") && fillSource !== "draw") {
        return { ok: false, error: `${at}.fill must be "draw" for a ${kind} track` };
      }
      if (kind !== "text" && kind !== "color" && fillSource === "draw") {
        return { ok: false, error: `${at}.fill "draw" needs a text or color track — a ${kind} track has nothing to draw from` };
      }
    }
    const styleRead = readStyle(t.style, `${at}.style`);
    if (styleRead.error) return { ok: false, error: styleRead.error };
    if (styleRead.style && kind !== "text") {
      return { ok: false, error: `${at}.style belongs on a text track, not on a ${kind} track` };
    }
    if (!Array.isArray(t.items) || t.items.length === 0) return { ok: false, error: `${at}.items must not be empty` };
    if (t.items.length > MAX_ITEMS) return { ok: false, error: `${at}.items has too many entries (max ${MAX_ITEMS})` };
    const items: BlueprintItem[] = [];
    for (let k = 0; k < t.items.length; k++) {
      const it = t.items[k];
      const atk = `${at}.items[${k}]`;
      if (!isObj(it)) return { ok: false, error: `${atk} must be an object` };
      const start = num(it.start), end = num(it.end);
      if (start === null || start < 0) return { ok: false, error: `${atk}.start must be a second at or after zero` };
      if (end === null || end <= start) return { ok: false, error: `${atk}.end must come after start` };
      if (end > seconds + 1) return { ok: false, error: `${atk}.end is past the end of the video` };
      const value = typeof it.value === "string" ? it.value.trim() : "";
      if (!value) return { ok: false, error: `${atk}.value must say what is on screen` };
      let beat: number | undefined;
      if (it.beat !== undefined && it.beat !== null) {
        const b = num(it.beat);
        if (b === null || b < 1 || !Number.isInteger(b)) return { ok: false, error: `${atk}.beat must be a whole number from 1 up` };
        beat = b;
      }
      items.push({ start, end, value: value.slice(0, MAX_VALUE), ...(beat ? { beat } : {}) });
    }
    items.sort((a, b) => a.start - b.start);
    tracks.push({
      region, kind, varies: t.varies, items,
      ...(fillSource ? { fill: fillSource } : {}),
      ...(styleRead.style ? { style: styleRead.style } : {}),
    });
  }

  // A region nothing ever puts content into is a region that was imagined, not observed —
  // unless it is a container, because a board whose slots hold the content is real and has
  // nothing of its own to paint.
  const used = new Set(tracks.map((t) => t.region));
  const hasChild = new Set(regions.map((r) => r.parent).filter(Boolean) as string[]);
  const idle = regions.find((r) => !used.has(r.id) && !hasChild.has(r.id));
  if (idle) {
    return { ok: false, error: `region "${idle.id}" has no track and nothing inside it — every region must carry something` };
  }

  return { ok: true, blueprint: { version: BLUEPRINT_VERSION, canvas: { width, height, fps, seconds }, regions, tracks } };
}

/** The schema as the model is told it, kept beside the validator so the two cannot drift:
 *  whatever is described here is what validateBlueprint accepts. */
export const BLUEPRINT_SCHEMA_PROMPT = `Return ONE JSON object and nothing else — no prose, no markdown fence.

{
  "version": "${BLUEPRINT_VERSION}",
  "canvas": { "width": <px>, "height": <px>, "fps": <number>, "seconds": <number> },
  "regions": [ { "id": "<lowercase-id>", "role": <role>, "rect": [x, y, w, h], "z": <number>,
                 "label": "<what this area is, in plain words>",
                 "parent": "<region id, only if it sits inside one>",
                 "grid": { "rows": <n>, "cols": <n> },   // only on a panel that is divided
                 "at":   { "row": <n>, "col": <n> },     // only on a cell, counting from 1
                 "paint": { "fill": "#rrggbb",           // the area's own colour, if it has one
                            "radius": <0..1 of its shorter side>,
                            "border": { "color": "#rrggbb", "width": <0..0.5 of shorter side> } } } ],
  "tracks":  [ { "region": "<region id>", "kind": <kind>, "varies": "fixed" | "episode",
                 "fill": <fill>,                          // where the content comes from
                 "style": { "color": "#rrggbb", "background": "#rrggbb", "outline": "#rrggbb",
                            "weight": <100..900>, "size": <fraction of canvas height>,
                            "case": ${TEXT_CASES.map((c) => `"${c}"`).join(" | ")},
                            "align": "left" | "center" | "right",
                            "emphasis": { "style": "highlight" | "underline" | "color",
                                          "color": "#rrggbb" } },   // text tracks only
                 "items": [ { "start": <s>, "end": <s>, "value": "<what>", "beat": <n, only if part of the repeating unit> } ] } ]
}

role is exactly one of: ${REGION_ROLES.join(" | ")}
kind is exactly one of: ${TRACK_KINDS.join(" | ")}
fill is exactly one of: ${FILL_SOURCES.join(" | ")}

RULES
- rect is FRACTIONS of the canvas, origin top-left: [0, 0, 1, 0.1] is a strip across the top.
  Never pixels. Measure where the thing actually sits, do not guess a tidy number.
- The six roles are LAYOUT FUNCTIONS, not genres, and they cover any composed video:
  backdrop is what is behind everything; figure is a subject in shot, whether a presenter,
  an avatar, an interviewee or a pair of hands; overlay is anything layered over another
  region; text is an area whose content is words, whether a fixed title or a caption that
  changes word by word; panel is a bounded area holding structured content; cell is one
  subdivision of a panel. Say what the area really is in "label" — "tier row S", "webcam
  bubble", "step 2 of the recipe", "reply from mum" — and keep "role" to the six.
- If a panel is divided into a regular structure, give it "grid" and give each part its own
  cell region with "at". A tier list, a 2-up comparison, a leaderboard, a bingo card and a
  side-by-side before/after are all this. Without it the structure is only a picture of
  itself and nothing can be placed into it.
- Every region must have at least one track, and every track at least one item.
- z decides what is painted over what. Give overlapping regions different z.
- A caption that changes word by word is many items on ONE caption track, each with its own
  start and end — not one item for the whole video.
- For kind "text", value is the exact words on screen, verbatim, including emoji.
- For kind "image" or "video", value describes what is depicted, concretely enough that
  someone could recreate it without seeing the original.
- Describe only what is visibly there. Do not name a camera, a lens, or a brand you cannot
  read on screen. Do not describe mood, quality, or intent.
- If the video has no region of some kind, leave it out. Never invent one to look complete.

COLOUR AND TYPE — without these the layout is right and the video is wrong
- "paint" records the area's OWN surface: the colour of a tier row, the white strip a title
  sits on, the rounded white card around an inset portrait. If an area is just a window onto
  footage, it has no paint. Read the colours off the picture as hex.
- "style" records how the words are SET: their colour, the plate behind them, the stroke
  that keeps them readable over footage, their weight, their size as a fraction of the
  canvas height, whether they are upper-cased, and how they are aligned.
- If one word in a line is set apart — boxed, underlined, in another colour — say so in
  "emphasis" and wrap that word in the value with double square brackets:
  "plays like a Greek [[tragedy.]]". Do not use the brackets anywhere else.
- Black text on white is not the same format as white text on black. Say which it is.

WHERE EACH SLOT'S CONTENT COMES FROM — "fill"
- "draw"     the renderer makes it from this blueprint: words, colours, a coloured row, a
             bordered card. EVERY structural graphic is this. A tier row is a rectangle with
             a letter on it, not a photograph of one — say "draw" and record its colour in
             the region's "paint", and the row becomes reproducible instead of a picture.
- "generate" a model must invent a picture or a clip that does not exist: a presenter, a
             set, an illustrative or joke image.
- "cut"      it is footage taken from a source video, including this one — a demo, a replay,
             a clip being reacted to.
- "supply"   it is a real file someone must provide: a logo, a real person's photograph, a
             screenshot. Say "supply" rather than "generate" when the thing must be the
             genuine article, because a generated lookalike would be wrong.
- Text and colour tracks are always "draw". If you leave "fill" out, pictures are assumed to
  be generated, which is usually not what a structural area needs.

THE REPEATING UNIT — this is what makes the video a FORMAT rather than one video
- Most short-form videos run a small structure several times: one ranked subject, one tip,
  one myth. Find that unit and number it. Every item belonging to the third repetition gets
  "beat": 3, whatever region it is in — the subject's image, its caption, its slot on the
  board. Items that are not part of it, such as a title held for the whole video, get no
  "beat" at all.
- "varies" says whether a track would be the same in the NEXT video made this way.
  "fixed"   — the scaffolding: the tier rows and their letters, a background, a frame.
  "episode" — anything that changes with the subject: the title, the narration, each
              image that is about this topic.
  Decide per track, by asking what a different episode of this same format would keep.`;

// ── the format layer ───────────────────────────────────────────────────────────
//
// A capture describes one episode. A format is the same layout with the episode taken out:
// the scaffolding kept verbatim, everything that changes reduced to a named slot, and time
// expressed as a SHARE rather than a second.
//
// That last part is what makes it reusable. The captured tier list ran 20 seconds over two
// subjects; the next one may rank five and run a minute. Absolute seconds would either
// truncate it or leave it hanging, so a per-beat item records where it sits inside its own
// beat (0..1) and how much of that beat it takes. Render-time multiplies those by whatever
// the new episode's beats turn out to be.
//
// Derived, never asked: the model already said which tracks vary and which beat each item
// belongs to, so this is arithmetic. Asking a second time would invite a second opinion.

export interface FormatSlot {
  /** Stable id: the region it fills plus its kind, which is unique per track. */
  id: string;
  region: string;
  kind: TrackKind;
  /** True when this slot is filled once per beat, false when it is filled once per episode
   *  (a title, a hook line). The difference decides how many values an episode must supply. */
  perBeat: boolean;
  /** How many values one beat TYPICALLY needs — the median across beats, not the maximum.
   *  One talkative subject should not set the bill for every other. */
  perUnit: number;
  /** What the busiest beat asked for. Kept so a filler can see the spread rather than
   *  discovering it when a beat runs out of room. */
  perUnitMax: number;
  /** Where each value sits, as shares of its beat (or of the whole video when not perBeat).
   *  Same length as perUnit. */
  timing: { at: number; forShare: number }[];
  /** One captured value, kept as guidance for whatever fills the slot next. Not content. */
  example: string;
  /** Where the content comes from — drawn, generated, cut from a source, or supplied. This
   *  belongs to the FORMAT, not to the episode: a tier row is drawn in every episode, and a
   *  presenter is generated in every episode. Without it, whatever fills the format has to
   *  guess, and guessing is what sent five rectangles to an image model. */
  fill: FillSource;
  /** For a text slot, how the words are set. Also the format's, not the episode's: the
   *  episode supplies words, the format supplies the look they are set in. */
  style?: TextStyle;
}

export interface VideoFormat {
  version: typeof BLUEPRINT_VERSION;
  /** No seconds: a format has no duration until an episode gives it one. */
  canvas: { width: number; height: number; fps: number };
  regions: BlueprintRegion[];
  /** Scaffolding, kept as captured — tier rows, a backdrop, a frame. */
  fixed: BlueprintTrack[];
  slots: FormatSlot[];
  /** How many repetitions the captured episode ran. A different episode may run a different
   *  number; this is what it looked like, not a rule. */
  beats: number;
}

const share = (v: number) => Math.round(v * 10000) / 10000;

/** The window each beat occupied, taken across every track that mentioned it. */
export function beatWindows(bp: Blueprint): Map<number, { start: number; end: number }> {
  const w = new Map<number, { start: number; end: number }>();
  for (const t of bp.tracks) {
    for (const i of t.items) {
      if (!i.beat) continue;
      const cur = w.get(i.beat);
      if (!cur) w.set(i.beat, { start: i.start, end: i.end });
      else { cur.start = Math.min(cur.start, i.start); cur.end = Math.max(cur.end, i.end); }
    }
  }
  return w;
}

/** Lift the reusable shape out of one capture. */
export function deriveFormat(bp: Blueprint): VideoFormat {
  const windows = beatWindows(bp);
  const beats = windows.size;
  const whole = { start: 0, end: bp.canvas.seconds };

  const slots: FormatSlot[] = [];
  for (const t of bp.tracks) {
    if (t.varies === "fixed") continue;

    // An episode track either repeats per beat or is supplied once. Judged by its items,
    // not by a flag: a track whose items all carry a beat is per-beat, and one whose items
    // carry none is a per-episode field.
    //
    // Tagging is not always even, though. On a real capture the model numbered the caption
    // items and left the graphic that changes alongside them untagged, which classified an
    // obviously per-beat track as "supplied once". So when a track carries no beats at all
    // and the video has beat windows, each item is placed by WHERE IT FALLS: an item that
    // sits inside a beat's window belongs to that beat. Arithmetic, not a second opinion.
    const tagged = t.items.filter((i) => i.beat);
    let items = t.items;
    if (tagged.length === 0 && beats > 0) {
      // Containment, not midpoint. A headline that runs the whole video has its midpoint
      // inside whichever beat happens to sit in the middle, and would be mistaken for a
      // per-beat field; an item belongs to a beat only when that beat holds most of it.
      const placed = t.items.map((i) => {
        const span = Math.max(i.end - i.start, 0.001);
        for (const [n, w] of windows) {
          const inside = Math.min(i.end, w.end) - Math.max(i.start, w.start);
          if (inside / span >= 0.6) return { ...i, beat: n };
        }
        return i;
      });
      // Only adopt the inference when it actually explains the track.
      if (placed.filter((i) => i.beat).length >= Math.ceil(t.items.length * 0.8)) items = placed;
    }
    const beated = items.filter((i) => i.beat);
    const perBeat = beated.length > 0 && beated.length === items.length;

    // Per beat, the count is what ONE beat needs — the most any single beat asked for, so a
    // subject that got two captions is not quietly cut to the one another got.
    let perUnit: number, perUnitMax: number;
    let sample: BlueprintItem[];
    if (perBeat) {
      const byBeat = new Map<number, BlueprintItem[]>();
      for (const i of items) {
        const k = i.beat as number;
        byBeat.set(k, [...(byBeat.get(k) ?? []), i]);
      }
      const groups = [...byBeat.values()].sort((a, b) => a.length - b.length);
      const median = groups[Math.floor((groups.length - 1) / 2)];
      perUnit = median.length;
      perUnitMax = groups[groups.length - 1].length;
      // Timing comes off a beat of typical size, so the shares describe the usual shape.
      sample = median;
    } else {
      perUnit = items.length;
      perUnitMax = items.length;
      sample = items;
    }

    const timing = sample.map((i) => {
      const w = perBeat && i.beat ? windows.get(i.beat) ?? whole : whole;
      const span = Math.max(w.end - w.start, 0.001);
      return { at: share((i.start - w.start) / span), forShare: share((i.end - i.start) / span) };
    });

    slots.push({
      id: `${t.region}:${t.kind}`,
      region: t.region, kind: t.kind, perBeat, perUnit, perUnitMax, timing,
      example: sample[0]?.value ?? "",
      fill: t.fill ?? defaultFill(t.kind),
      ...(t.style ? { style: t.style } : {}),
    });
  }

  return {
    version: BLUEPRINT_VERSION,
    canvas: { width: bp.canvas.width, height: bp.canvas.height, fps: bp.canvas.fps },
    regions: bp.regions,
    fixed: bp.tracks.filter((t) => t.varies === "fixed"),
    slots,
    beats,
  };
}
