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

/** The SHAPE of the lettering, not a font name.
 *
 *  A vision model can tell a heavy geometric sans from a condensed grotesque from a slab;
 *  it cannot tell you the file was Montserrat Black. Asking for a family name would get a
 *  guess, and a guess in this field is a string going into a stylesheet. A closed set of
 *  shapes is what can honestly be observed AND safely rendered — and without any of it the
 *  renderer puts Inter under everything, which is how five tier letters came out in
 *  visibly the wrong lettering. */
export const FONT_SHAPES = ["sans", "sans-condensed", "sans-rounded", "display", "serif", "slab", "mono", "handwritten"] as const;
export type FontShape = (typeof FONT_SHAPES)[number];

export const TEXT_CASES = ["as-is", "upper", "lower", "title"] as const;
export type TextCase = (typeof TEXT_CASES)[number];

/** Whether an item is on screen from the first frame, or arrives partway through and stays.
 *
 *  Today's renderer only knows the first of these: a tile is drawn in its row from frame
 *  zero, whatever the reference does. That is why a cloned tier board is a wallpaper — the
 *  subject being talked about should first sit beside the presenter and only land in its row
 *  when the verdict is said, and there was no field to say so.
 *
 *  "from-start" is the default and is exactly today's behaviour: nothing about an existing
 *  blueprint changes by this field existing. "on-cue" is new: the item waits at `waitsAt`
 *  until it moves into place — see IR-CONTRACT-V2 §3. */
export const HOLD_KINDS = ["from-start", "on-cue"] as const;
export type Hold = (typeof HOLD_KINDS)[number];

/** How a thing enters or leaves — IR-CONTRACT-V2 §2.
 *
 *  A closed set, because that is the question a model answers reliably. How LONG it takes and
 *  how FAR it travels are not here: those are continuous quantities, and they belong to the
 *  code that clamps them. "cut" is the default everywhere and means today's behaviour — the
 *  element is simply there. */
export const MOVE_SHAPES = ["cut", "fade", "pop", "drift", "swell"] as const;
export type MoveShape = (typeof MOVE_SHAPES)[number];

/** The look of words, which is not decoration — it is how a format reads.
 *
 *  Measured against a reference: its title was BLACK ON WHITE and we drew white on black;
 *  its caption underlined the one word carrying the joke and we drew a flat line. A schema
 *  with no way to say either produces a video that is the right shape and the wrong film. */
export interface TextStyle {
  /** Hex, the glyphs themselves. */
  color?: string;
  /** Hex, a PLATE behind the whole line — a solid block the words sit on.
   *
   *  Not the same thing as `outline`, and a capture reported both at once for a caption
   *  that had only a stroke, which drew a black bar across a frame that had none. A plate
   *  is visible where there are no letters; a stroke is only ever touching them. */
  background?: string;
  /** Hex, a stroke around the glyphs — what keeps a caption readable over footage. */
  outline?: string;
  /** The shape of the lettering. */
  font?: FontShape;
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
  /** Where this one item sits, when that is not simply "all of its region".
   *
   *  Most items fill their region: a caption fills its band, a tile fills its slot. An INSERT
   *  does not. The reference drops a photograph over its tier board for two seconds, then a
   *  second one beside it, each a different size in a different place, and the region they
   *  share is only "the area inserts appear in". Without a box of its own, every insert in a
   *  film is drawn at the size of the area they all share — which is how a layer of five
   *  timed photographs came out as nothing at all, and then as one stretched rectangle.
   *
   *  A fraction of the CANVAS, exactly like a region's, so the two can be compared without
   *  knowing which region an item belongs to. */
  rect?: Rect;
  /** For kind "text": the exact words on screen. For image/video: what is depicted, as an
   *  instruction a generator can act on. For "color": a hex value. Never empty — an empty
   *  item is a gap, and a gap is expressed by not having an item. */
  value: string;
  /** Whether this item is on screen from the first frame, or waits and then lands.
   *  Absent means "from-start" — today's behaviour, unchanged. See `Hold` and
   *  IR-CONTRACT-V2 §3. */
  hold?: Hold;
  /** The id of the region this item waits AT before it lands, when `hold` is "on-cue".
   *  Not necessarily a region declared elsewhere in this blueprint — it may name a spot
   *  that only `omniwatchStage` knows how to place, the way `omniwatchStage.ts` derives a
   *  waiting box beside the presenter when nothing was declared for it. Absent or ignored
   *  when `hold` is "from-start". */
  waitsAt?: string;
  /** The second at which the item takes its final place, when `hold` is "on-cue".
   *
   *  `hold` and `waitsAt` say that an item waits and where — they never said for how long.
   *  Absent, the implementation took the landing moment to be `item.start`, so the icon
   *  appeared already moving instead of sitting beside the presenter for the reference's few
   *  seconds of "this is what we're talking about" before it drops. That absence is today's
   *  behaviour and stays the default: nothing about an existing blueprint changes.
   *
   *  Filled by the ALIGNER (`omniwatchCues`) from the window of words the item is anchored
   *  to — the sentence that introduces it, ending where the verdict is said — never by Omni,
   *  because a second is exactly the kind of continuous quantity Omni is not trusted with.
   *  See IR-CONTRACT-V2 §3. Must fall within `[start, end]`; a value outside that window is
   *  refused rather than clamped, the same way a malformed `rect` is refused — clamping it
   *  would quietly draw a landing that was never actually measured. */
  landsAt?: number;
  /** How this item enters, and how it leaves. Absent means "cut" on both — it is simply
   *  there and then simply gone, which is what every blueprint written before today did.
   *
   *  Held loosely on purpose: the validator settles the shape, and `omniwatchMotion`
   *  clamps the numbers. Nothing between them needs to know the ranges. */
  arrival?: unknown;
  departure?: unknown;
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

/** Absent, or said to be absent. A model writing this schema says "no outline" by leaving
 *  the field empty as often as by leaving it out, and elsewhere in this validator an empty
 *  string already means absent — parent, label. Refusing it only here made a capture that
 *  had correctly observed "this text has no stroke" fail to validate. */
const unset = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function readPaint(v: unknown, at: string): { paint?: RegionPaint; error?: string } {
  if (unset(v)) return {};
  if (!isObj(v)) return { error: `${at} must be an object` };
  const paint: RegionPaint = {};
  if (!unset(v.fill)) {
    const f = hex(v.fill);
    if (!f) return { error: `${at}.fill must be a hex colour` };
    paint.fill = f;
  }
  if (!unset(v.radius)) {
    const r = num(v.radius);
    if (r === null || r < 0 || r > 1) return { error: `${at}.radius must be 0..1 of the shorter side` };
    paint.radius = r;
  }
  if (!unset(v.border)) {
    if (!isObj(v.border)) return { error: `${at}.border must be { color, width }` };
    const c = hex(v.border.color), w = num(v.border.width);
    if (!c) return { error: `${at}.border.color must be a hex colour` };
    if (w === null || w <= 0 || w > 0.5) return { error: `${at}.border.width must be 0..0.5 of the shorter side` };
    paint.border = { color: c, width: w };
  }
  return { paint: Object.keys(paint).length ? paint : undefined };
}

function readStyle(v: unknown, at: string): { style?: TextStyle; error?: string } {
  if (unset(v)) return {};
  if (!isObj(v)) return { error: `${at} must be an object` };
  const st: TextStyle = {};
  for (const k of ["color", "background", "outline"] as const) {
    if (unset(v[k])) continue;
    const c = hex(v[k]);
    if (!c) return { error: `${at}.${k} must be a hex colour` };
    st[k] = c;
  }
  if (!unset(v.font)) {
    if (!FONT_SHAPES.includes(v.font as FontShape)) {
      return { error: `${at}.font must be one of ${FONT_SHAPES.join(", ")}` };
    }
    st.font = v.font as FontShape;
  }
  if (!unset(v.weight)) {
    const w = num(v.weight);
    if (w === null || w < 100 || w > 900) return { error: `${at}.weight must be 100..900` };
    st.weight = Math.round(w / 100) * 100;
  }
  if (!unset(v.size)) {
    const z = num(v.size);
    if (z === null || z <= 0 || z > 0.5) return { error: `${at}.size must be a fraction of canvas height up to 0.5` };
    st.size = z;
  }
  if (!unset(v.case)) {
    if (!TEXT_CASES.includes(v.case as TextCase)) {
      return { error: `${at}.case must be one of ${TEXT_CASES.join(", ")}` };
    }
    st.case = v.case as TextCase;
  }
  if (!unset(v.align)) {
    if (v.align !== "left" && v.align !== "center" && v.align !== "right") return { error: `${at}.align must be left, center or right` };
    st.align = v.align;
  }
  if (!unset(v.emphasis)) {
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

/** A check that passed may still have thrown something away.
 *
 *  Two different failures need two different answers. A measurement that would RENDER
 *  WRONGLY is refused outright — a colour that is not a colour, a cell with no place in its
 *  grid. Something merely redundant should not cost the whole capture: a style on an image
 *  track cannot affect a single pixel, and rejecting a twenty-region blueprint over it
 *  turns a modelling slip into a lost analysis. Those are dropped and NAMED, so a slip
 *  stays visible instead of becoming a silent habit. */
export type ValidateOpts = {
  /** Keep region rects as given — for measure-from-source. */
  preserveGeometry?: boolean;
  /**
   * Snap a tier list onto the authored 9:16 template below.
   *
   * Off by default, and that default changed deliberately. The template exists to rescue a
   * capture whose geometry was guessed: it hard-codes a banner height, a board top and five
   * equal rows, taken from one reference. Once the geometry is MEASURED off the source — the
   * board's grid counted in omniwatchBoardScan, the title plate's edges found in the frame —
   * the template is no longer a rescue, it is an overwrite: it put the banner at half its
   * real height and divided a board evenly that is not evenly divided.
   *
   * It stays available for a caller that has nothing better, and it is still what the
   * template's own tests exercise. It is not what a measured blueprint gets.
   */
  snapTemplate?: boolean;
};

export type BlueprintCheck =
  | { ok: true; blueprint: Blueprint; notes: string[] }
  | { ok: false; error: string };

/** How bright a hex is, 0..1. Used to tell a dark plate from a pale one without caring
 *  about the hue the model invents. */
function luminance(hexColour: string): number {
  const h = hexColour.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Same colour up to the laziness of a model that writes #fff and #ffffff for one plate. */
function sameColour(a: string, b: string): boolean {
  const norm = (h: string) => {
    const x = h.replace("#", "").toLowerCase();
    return x.length === 3 ? x.split("").map((c) => c + c).join("") : x.slice(0, 6);
  };
  return norm(a) === norm(b);
}

/** Capture slips that survive the schema and still draw the wrong film.
 *
 *  Measured on the HypeKit tier-list benchmark: a caption over footage came back with
 *  background "#000000" and no outline, so compose drew a black bar; a title banner that
 *  reaches the frame edges came back inset at x=0.06; and the same cream plate was named
 *  both as the region's paint and as the words' background, which stacked two plates.
 *  Each rule below is one of those, named in notes so a silent "fix" cannot hide it. */
function normalizeCapturedStyles(
  regions: BlueprintRegion[],
  tracks: BlueprintTrack[],
  notes: string[],
): BlueprintTrack[] {
  const byId = new Map(regions.map((r) => [r.id, r]));
  return tracks.map((t, i) => {
    if (t.kind !== "text" || !t.style) return t;
    const st = { ...t.style };
    const region = byId.get(t.region);
    const at = `tracks[${i}].style`;

    // Region already paints the plate — repeating it on the words draws a second bar.
    if (st.background && region?.paint?.fill && sameColour(st.background, region.paint.fill)) {
      notes.push(`${at}.background dropped — same plate as region "${t.region}" paint`);
      delete st.background;
    }

    // Dark plate under light words, no regional surface: that is almost always a stroke
    // the model misnamed. A real black title card would be the REGION's paint.
    if (st.background && !region?.paint?.fill) {
      const bgDark = luminance(st.background) < 0.2;
      const fgLight = !st.color || luminance(st.color) > 0.6;
      if (bgDark && fgLight) {
        if (!st.outline) st.outline = st.background;
        notes.push(`${at}.background was a dark plate over footage — kept as outline, dropped the plate`);
        delete st.background;
      }
    }

    // Both named at once: keep the stroke, drop the plate (prompt already says this; models
    // still emit both, and compose would draw the bar).
    if (st.background && st.outline) {
      notes.push(`${at} had both background and outline — kept outline, dropped the plate`);
      delete st.background;
    }

    const next: BlueprintTrack = { ...t, style: Object.keys(st).length ? st : undefined };
    if (!next.style) delete next.style;
    return next;
  });
}

/** Layout slips that leave a valid schema and a wrong film.
 *
 *  Measured on the HypeKit tier-list benchmark after prompt-only and Gemini-3.8-Flash
 *  captures: captions slid under the tier board (lower z / overlapping y), a backdrop was
 *  emitted full-frame under an opaque board, and the presenter figure was a floated portrait
 *  with empty margins that then got their own generated room. Each rule below is one of
 *  those, applied after the model speaks so every downstream path (verify, produce, clone)
 *  inherits the same geometry. Grounding can still tighten rects further; this only enforces
 *  invariants that do not need a detector. */
function normalizeLayoutGeometry(regions: BlueprintRegion[], notes: string[]): BlueprintRegion[] {
  const out = regions.map((r) => ({ ...r, rect: [...r.rect] as Rect }));
  const byId = new Map(out.map((r) => [r.id, r]));

  const isTierBoard = (r: BlueprintRegion) =>
    r.role === "panel" || /tier[-_]?(list|board)|leaderboard|bingo/i.test(r.id) || /tier[-_]?(list|board)/i.test(r.label || "");
  const isCaption = (r: BlueprintRegion) =>
    r.role === "text" && (/caption/i.test(r.id) || /caption/i.test(r.label || ""));
  const isFigure = (r: BlueprintRegion) =>
    r.role === "figure" || /^(host|presenter)$/i.test(r.id) || /^(host|presenter)-(stage|figure|video)$/i.test(r.id);
  const isBackdrop = (r: BlueprintRegion) =>
    r.role === "backdrop" || /backdrop/i.test(r.id);

  const boards = out.filter(isTierBoard).sort((a, b) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3]);
  const board = boards.length ? boards[boards.length - 1] : undefined; // largest panel-ish
  // Prefer an explicit tier-board / tier-list id when present.
  const boardPrefer = out.find((r) => /tier[-_]?(list|board)/i.test(r.id)) || board;

  const captions = out.filter(isCaption);
  if (boardPrefer) {
    const tierTop = boardPrefer.rect[1];
    for (const cap of captions) {
      const [x, y, w, h] = cap.rect;
      const bottom = y + h;
      if (bottom > tierTop + 1e-4) {
        // Keep height; slide up so the band ends at the board's top.
        const ny = Math.max(0, tierTop - h);
        notes.push(`region "${cap.id}" moved above "${boardPrefer.id}" — caption overlapped the board`);
        cap.rect = [x, ny, w, Math.min(h, tierTop - ny)];
      }
      if (cap.z <= boardPrefer.z) {
        notes.push(`region "${cap.id}" z raised above "${boardPrefer.id}" — caption must paint over the board`);
        cap.z = boardPrefer.z + 1;
      }
    }
  }

  const figures = out.filter(isFigure);
  const figure = figures[0];
  if (figure && boardPrefer) {
    const tierTop = boardPrefer.rect[1];
    // Upper stage: from below a typical title band (~0.08–0.14) down to the board.
    // If the figure is a floated portrait (width < 0.85 of frame) inside that stage,
    // expand it to the stage so generate fills the host area HypeKit-style.
    const [fx, fy, fw, fh] = figure.rect;
    const stageTop = Math.min(fy, 0.14);
    const stageH = Math.max(0.2, tierTop - stageTop);
    if (fw < 0.85 || fy + fh < tierTop - 0.02) {
      notes.push(`region "${figure.id}" expanded to upper stage above "${boardPrefer.id}" — floated host cannot fill the format`);
      figure.rect = [0, stageTop, 1, stageH];
    }
  }

  if (figure && boardPrefer) {
    const tierTop = boardPrefer.rect[1];
    for (const back of out.filter(isBackdrop)) {
      const [x, y, w, h] = back.rect;
      const full = w >= 0.99 && h >= 0.99 && x <= 0.01 && y <= 0.01;
      const underBoard = y + h > tierTop + 0.05;
      if (full || underBoard) {
        const [fx, fy, fw, fh] = figure.rect;
        notes.push(`region "${back.id}" clipped to figure stage — full-frame / under-board backdrop is not the set behind the host`);
        back.rect = [fx, fy, fw, fh];
        if (back.z >= figure.z) back.z = Math.max(0, figure.z - 1);
      }
    }
  }

  // Tier label text: prefer display face when the cell is a short single letter on paint.
  // (style lives on tracks — handled in normalizeTierLabelFonts.)

  return out;
}

/** Single-letter tier labels on a painted cell are heavy geometric faces in the wild
 *  (Impact-class), not body sans. Capture often says "sans"; snap the shape. */
function normalizeTierLabelFonts(
  regions: BlueprintRegion[],
  tracks: BlueprintTrack[],
  notes: string[],
): BlueprintTrack[] {
  const byId = new Map(regions.map((r) => [r.id, r]));
  return tracks.map((t, i) => {
    if (t.kind !== "text") return t;
    const region = byId.get(t.region);
    if (!region) return t;
    const looksLabel = /tier.*label|label.*tier|^[sabcd]-label$/i.test(t.region)
      || (/^[SABCD]$/.test((t.items[0]?.value || "").trim()) && !!region.paint?.fill);
    if (!looksLabel) return t;
    const st = { ...(t.style || {}) };
    let changed = false;
    if (!st.font || st.font === "sans" || st.font === "sans-condensed") {
      st.font = "display";
      changed = true;
    }
    if (st.weight == null || st.weight < 800) {
      st.weight = 900;
      changed = true;
    }
    // Label letter should fill a good fraction of the cell height (~0.55 of cell →
    // size ≈ 0.55 * cell.h of canvas). If missing or tiny, set from the cell.
    const cellH = region.rect[3];
    const want = Math.round(cellH * 0.38 * 1000) / 1000; // Hypit letters are small in the cell, not filling it
    if (st.size == null || st.size < want * 0.9) {
      st.size = want;
      changed = true;
    }
    if (!changed) return t;
    notes.push(`tracks[${i}].style snapped for tier label "${t.region}" — display/${st.weight}/size ${st.size}`);
    return { ...t, style: st };
  });
}

/** A painted title/caption BANNER that nearly spans the frame but sits inset is almost
 *  always a full-bleed strip with invented side margins. Snap it to the edges; the vertical
 *  placement (Dynamic Island gap) is left alone — that one is real. */

/** Tier-list 9:16 template — geometry source of truth (Hypit-style authored layout).
 *  VL/Omni may guess content; this snaps structure so we never ship crushed C/D rows,
 *  fat banners with letterbox, or floated hosts. Steal-like-an-artist: inspired by
 *  Hypit ranking-football proportions, not their code. */
function applyTierList9x16Template(regions: BlueprintRegion[], notes: string[]): BlueprintRegion[] {
  const out = regions.map((r) => ({ ...r, rect: [...r.rect] as Rect }));
  const hasTier = out.some((r) =>
    /tier[-_]?(list|board)|leaderboard/i.test(r.id) || r.role === "panel" && /tier|board|list/i.test(r.id + (r.label || "")),
  );
  if (!hasTier) return out;

  // Safe-area: short-form leaves a gap under status bar / Dynamic Island so the title stays readable.
  const SAFE_TOP = 0.045;
  const BANNER_H = 0.052;
  const BOARD_TOP = 0.56;
  const BOARD_H = 0.44;
  const LABEL_W = 0.14;
  const ROW_H = BOARD_H / 5;
  const CAP_H = 0.055;
  const CREAM = "#fff8e7";

  const byId = new Map(out.map((r) => [r.id, r]));
  const find = (...preds: ((r: BlueprintRegion) => boolean)[]) => out.find((r) => preds.every((p) => p(r)));

  // Title banner: thin, full-bleed, flush to top (kills kaszeta above text).
  const banner =
    find((r) => /banner|title/i.test(r.id)) ||
    find((r) => r.role === "text" && !!r.paint?.fill && r.rect[2] >= 0.7 && r.rect[1] < 0.2);
  if (banner) {
    const [,, , oh] = banner.rect;
    if (banner.rect[1] > 0.005 || Math.abs(banner.rect[2] - 1) > 0.01 || oh > BANNER_H + 0.02) {
      notes.push(`region "${banner.id}" snapped to TierList9x16 banner [0,0,1,${BANNER_H}] — thin full-bleed title`);
    }
    banner.rect = [0, SAFE_TOP, 1, BANNER_H];
    banner.z = Math.max(banner.z, 5);
    banner.paint = { fill: CREAM, radius: banner.paint?.radius };
    notes.push(`region "${banner.id}" cream safe-area banner — gap above for status bar / Dynamic Island`);
  }

  // Presenter / host: upper stage under banner, above board — cover-friendly 9:16 fill zone.
  const figure =
    find((r) => r.role === "figure") ||
    find((r) => /^(host|presenter)(-stage|-figure|-video)?$/i.test(r.id));
  if (figure) {
    const stageTop = SAFE_TOP + BANNER_H;
    const stageH = BOARD_TOP - stageTop;
    notes.push(`region "${figure.id}" snapped to TierList9x16 host stage [0,${stageTop},1,${stageH}] — TikTok cover zone`);
    figure.rect = [0, stageTop, 1, stageH];
    figure.z = Math.min(figure.z, 1);
  }

  // Tier board + 5 equal rows (S–D). Labels left, slots right.
  const board =
    find((r) => /tier[-_]?(list|board)/i.test(r.id)) ||
    find((r) => r.role === "panel");
  if (board) {
    board.rect = [0, BOARD_TOP, 1, BOARD_H];
    board.z = Math.max(board.z, 2);
    // Authored surface: dark board; thumbs sit on top (contain) — never generate a photo of a table.
    board.paint = { ...(board.paint || {}), fill: board.paint?.fill && board.paint.fill.toLowerCase() !== "#ffffff" ? board.paint.fill : "#1a1a1a" };
    notes.push(`region "${board.id}" snapped to TierList9x16 board [0,${BOARD_TOP},1,${BOARD_H}]`);
  }

  const tiers = ["s", "a", "b", "c", "d"] as const;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const y = BOARD_TOP + i * ROW_H;
    const lab =
      byId.get(`${t}-label`) ||
      byId.get(`tier-${t}-label`) ||
      find((r) => new RegExp(`^tier[-_]?${t}[-_]?label$`, "i").test(r.id));
    const slot =
      byId.get(`${t}-slot`) ||
      byId.get(`tier-${t}-slot`) ||
      find((r) => new RegExp(`^tier[-_]?${t}[-_]?slot$`, "i").test(r.id));
    if (lab) {
      lab.rect = [0, y, LABEL_W, ROW_H];
      lab.z = Math.max(lab.z, 3);
    }
    if (slot) {
      slot.rect = [LABEL_W, y, 1 - LABEL_W, ROW_H];
      slot.z = Math.max(slot.z, 3);
      // Keep role as-is if already valid; only author the dark slot surface for thumbs.
      if (board) {
        slot.parent = board.id;
        slot.at = { row: i + 1, col: 2 };
        if (slot.role !== "cell") slot.role = "cell";
      }
      slot.paint = { fill: "#1a1a1a", border: { color: "#000000", width: 0.012 } };
    }
  }
  notes.push("tier rows S–D equalized to TierList9x16 (5× equal height) — no crushed C/D");

  // Caption band just above the board, near-full width.
  const cap =
    find((r) => /caption/i.test(r.id)) ||
    find((r) => r.role === "text" && !/banner|title|label/i.test(r.id) && r.rect[1] > 0.3);
  if (cap) {
    const cy = BOARD_TOP - CAP_H;
    cap.rect = [0.08, cy, 0.84, CAP_H];
    cap.z = Math.max(cap.z, (board?.z ?? 2) + 1);
    notes.push(`region "${cap.id}" snapped to TierList9x16 caption above board`);
  }

  // Floating insets (Ronaldo/Messi cards): force near-square with soft corners via paint.radius.
  for (const r of out) {
    if (!/portrait|inset|floating|cr7|messi/i.test(r.id)) continue;
    const [x, y, w, h] = r.rect;
    const side = Math.min(w, h, 0.22);
    // keep left-anchored beside host
    r.rect = [x, y, side, side];
    r.paint = { ...(r.paint || {}), fill: r.paint?.fill || "#ffffff", radius: 0.12 };
    notes.push(`region "${r.id}" snapped to square floating inset — Hypit card is 1:1 rounded`);
  }

  // Drop full-frame junk overlays that compete with the HTML board.
  for (const r of out) {
    if (/board-overlay|insert-overlay/i.test(r.id)) {
      // Park off-canvas so compose can skip empty rects; produce should not generate for these.
      r.rect = [0, 0, 0.01, 0.01];
      notes.push(`region "${r.id}" parked — tier board is HTML-composed, not a generated overlay`);
    }
  }

  return out;
}


/** Captions over footage: outline ok, solid highlight plate is usually a capture hallucination
 *  (Hypit karaoke is stroke/weight, not a cyan band). Drop highlight → keep color as tint only
 *  via underline/color; wipe style.background on caption tracks. */
function normalizeCaptionChrome(
  regions: BlueprintRegion[], tracks: BlueprintTrack[], notes: string[],
): BlueprintTrack[] {
  const capIds = new Set(
    regions.filter((r) => /caption/i.test(r.id) || /caption/i.test(r.label || "")).map((r) => r.id),
  );
  if (!capIds.size) return tracks;
  return tracks.map((t) => {
    if (!capIds.has(t.region) || t.kind !== "text" || !t.style) return t;
    const st = { ...t.style };
    let changed = false;
    if (st.background) {
      notes.push(`track "${t.region}" dropped caption plate background — stroke/outline only over footage`);
      delete st.background;
      changed = true;
    }
    // Keep emphasis.highlight — Hypit punchlines use a solid plate on the words.
    // Only a track-level style.background (full caption band) is the bad "backdrop".
    if (!st.outline && st.color && st.color.toLowerCase() !== "#000000") {
      st.outline = "#000000";
      changed = true;
    }
    return changed ? { ...t, style: st } : t;
  });
}


/** Title banner: cream plate is on the REGION paint; words themselves have no plate. */
function normalizeTitleChrome(
  regions: BlueprintRegion[], tracks: BlueprintTrack[], notes: string[],
): BlueprintTrack[] {
  const titleIds = new Set(
    regions.filter((r) => /banner|title/i.test(r.id)).map((r) => r.id),
  );
  if (!titleIds.size) return tracks;
  return tracks.map((t) => {
    if (!titleIds.has(t.region) || t.kind !== "text" || !t.style) return t;
    const st = { ...t.style };
    let changed = false;
    if (st.background) {
      notes.push(`track "${t.region}" dropped title word-plate — cream lives on region.paint`);
      delete st.background;
      changed = true;
    }
    return changed ? { ...t, style: st } : t;
  });
}

function normalizeBannerRects(regions: BlueprintRegion[], notes: string[]): BlueprintRegion[] {
  return regions.map((r) => {
    if (r.role !== "text" || !r.paint?.fill) return r;
    const [x, y, w, h] = r.rect;
    if (w >= 0.8 && x > 0.02 && x + w < 0.98) {
      notes.push(`region "${r.id}" rect snapped to full width — painted text banner had invented side margins`);
      return { ...r, rect: [0, y, 1, h] };
    }
    return r;
  });
}

/** Never throws: a blueprint that came back malformed is a reason to say what is wrong,
 *  not a 500 from halfway through a render. */
export function validateBlueprint(raw: unknown, opts: ValidateOpts = {}): BlueprintCheck {
  const notes: string[] = [];
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

    // A cell is a subdivision of something, and a subdivision that cannot say WHICH
    // subdivision it is has given up the only thing the role is for. Measured: a capture
    // came back with five full-width "cells", no parent and no grid between them — a tier
    // board flattened into a colour chart, with nowhere for a single item to be placed.
    // Whatever that is, it is a panel or an overlay, and calling it a cell hid the loss.
    if (role === "cell" && (r.at === undefined || r.at === null)) {
      return { ok: false, error: `${at}.at is required on a cell — say which row and column it is, or make it a panel` };
    }
    if (role === "cell" && !parent) {
      return { ok: false, error: `${at}.parent is required on a cell — a subdivision belongs to something` };
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
      // A card's white face and dark border are the REGION's paint, not the words' style;
      // the model reaches for "style" for both. Nothing here can draw, so it is dropped.
      notes.push(`${at}.style was dropped — a ${kind} track has no words to set; that looks like the region's paint`);
      styleRead.style = undefined;
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
      let rect: Rect | undefined;
      if (!unset(it.rect)) {
        const bad = badRect(it.rect);
        if (bad) return { ok: false, error: `${atk}.rect ${bad}` };
        rect = (it.rect as number[]).slice(0, 4) as Rect;
      }
      // Optional, defaulting to today's behaviour — see IR-CONTRACT-V2 §3. A malformed
      // value is refused the same way a malformed rect is: something that would render
      // wrongly (or that `omniwatchStage` could not even attempt) is worth stopping for,
      // not silently approximating.
      let hold: Hold | undefined;
      if (!unset(it.hold)) {
        if (!(HOLD_KINDS as readonly string[]).includes(String(it.hold))) {
          return { ok: false, error: `${atk}.hold must be one of ${HOLD_KINDS.join(", ")}` };
        }
        hold = it.hold as Hold;
      }
      let waitsAt: string | undefined;
      if (!unset(it.waitsAt)) {
        if (typeof it.waitsAt !== "string") return { ok: false, error: `${atk}.waitsAt must be a region id` };
        const w = it.waitsAt.trim();
        if (!/^[a-z0-9_-]{1,40}$/.test(w)) {
          return { ok: false, error: `${atk}.waitsAt must look like a region id (lowercase letters, digits, _ or -)` };
        }
        waitsAt = w;
      }
      // landsAt, from IR-CONTRACT-V2 §3's own gap. Refused outside [start, end] rather than
      // clamped into range — a landing time that was not actually inside the item's own
      // window was not measured from anything, and clamping it would draw a number nobody
      // ever produced, exactly the shortcut the contract names and forbids.
      let landsAt: number | undefined;
      if (!unset(it.landsAt)) {
        const l = num(it.landsAt);
        if (l === null) return { ok: false, error: `${atk}.landsAt must be a second` };
        if (l < start || l > end) {
          return { ok: false, error: `${atk}.landsAt must fall between start and end` };
        }
        landsAt = l;
      }
      // Movement, from IR-CONTRACT-V2 §2. The schema's whole job here is to settle the SHAPE
      // of the answer; the numbers inside it are clamped by `omniwatchMotion`, which is the
      // one place that knows the ranges.
      //
      // Two forms are accepted on purpose. Our capture prompt asks Omni for a bare name —
      // "arrival": "pop" — because a single word from a fixed list is the most reliable thing
      // a model produces, while a measured or hand-authored blueprint carries the whole
      // object. The bare name is widened here, so everything downstream sees one shape and
      // nobody has to remember which producer it came from.
      const readMove = (v: unknown, where: string): { ok: true; move?: Record<string, unknown> } | { ok: false; error: string } => {
        if (unset(v)) return { ok: true };
        if (typeof v === "string") {
          const shape = v.trim();
          if (!(MOVE_SHAPES as readonly string[]).includes(shape)) {
            return { ok: false, error: `${where} must be one of ${MOVE_SHAPES.join(", ")}` };
          }
          return { ok: true, move: { shape } };
        }
        if (typeof v !== "object" || Array.isArray(v)) {
          return { ok: false, error: `${where} must be a name from ${MOVE_SHAPES.join(", ")}, or an object carrying one` };
        }
        const raw = v as Record<string, unknown>;
        if (!(MOVE_SHAPES as readonly string[]).includes(String(raw.shape))) {
          return { ok: false, error: `${where}.shape must be one of ${MOVE_SHAPES.join(", ")}` };
        }
        // Only the four fields the contract names survive, so a model cannot smuggle a
        // property into the renderer by inventing a key.
        return { ok: true, move: {
          shape: String(raw.shape),
          ...(Number.isFinite(raw.seconds) ? { seconds: Number(raw.seconds) } : {}),
          ...(Number.isFinite(raw.amount) ? { amount: Number(raw.amount) } : {}),
          ...(typeof raw.ease === "string" ? { ease: raw.ease } : {}),
        } };
      };
      const arrivalRead = readMove(it.arrival, `${atk}.arrival`);
      if (!arrivalRead.ok) return { ok: false, error: arrivalRead.error };
      const departureRead = readMove(it.departure, `${atk}.departure`);
      if (!departureRead.ok) return { ok: false, error: departureRead.error };
      items.push({
        start, end, value: value.slice(0, MAX_VALUE),
        ...(beat ? { beat } : {}), ...(rect ? { rect } : {}),
        ...(hold ? { hold } : {}), ...(waitsAt ? { waitsAt } : {}),
        ...(landsAt !== undefined ? { landsAt } : {}),
        ...(arrivalRead.move ? { arrival: arrivalRead.move } : {}),
        ...(departureRead.move ? { departure: departureRead.move } : {}),
      });
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
  // nothing of its own to paint, or unless it IS paint: a coloured backdrop, a tier row, a
  // rule between two halves. That last case only became possible when regions learned to
  // carry a surface, and until this rule caught up a capture that correctly described a
  // painted backdrop was thrown out for describing it.
  const used = new Set(tracks.map((t) => t.region));
  const hasChild = new Set(regions.map((r) => r.parent).filter(Boolean) as string[]);
  const idle = regions.find((r) => !used.has(r.id) && !hasChild.has(r.id) && !r.paint);
  if (idle) {
    return { ok: false, error: `region "${idle.id}" has no track, no paint and nothing inside it — every region must carry something` };
  }

  let regionsOut = regions;
  let tracksOut = tracks;
  if (opts.preserveGeometry) {
    notes.push("validate: preserveGeometry — region rects kept from measure/source (no TierList template snap)");
    tracksOut = normalizeCapturedStyles(regionsOut, tracks, notes);
  } else {
    const normalized = normalizeLayoutGeometry(normalizeBannerRects(regions, notes), notes);
    regionsOut = opts.snapTemplate ? applyTierList9x16Template(normalized, notes) : normalized;
    tracksOut = normalizeTitleChrome(regionsOut, normalizeCaptionChrome(regionsOut, normalizeTierLabelFonts(regionsOut, normalizeCapturedStyles(regionsOut, tracks, notes), notes), notes), notes);
  }
  return { ok: true, notes, blueprint: { version: BLUEPRINT_VERSION, canvas: { width, height, fps, seconds }, regions: regionsOut, tracks: tracksOut } };
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
                            "font": <font>,
                            "weight": <100..900>, "size": <fraction of canvas height>,
                            "case": ${TEXT_CASES.map((c) => `"${c}"`).join(" | ")},
                            "align": "left" | "center" | "right",
                            "emphasis": { "style": "highlight" | "underline" | "color",
                                          "color": "#rrggbb" } },   // text tracks only
                 "items": [ { "start": <s>, "end": <s>, "value": "<what>", "beat": <n, only if part of the repeating unit>,
                              "hold": "from-start" | "on-cue",   // only if the item waits before it lands
                              "waitsAt": "<region id it waits at, only with hold on-cue>" } ] } ]
}

role is exactly one of: ${REGION_ROLES.join(" | ")}
kind is exactly one of: ${TRACK_KINDS.join(" | ")}
fill is exactly one of: ${FILL_SOURCES.join(" | ")}
font is exactly one of: ${FONT_SHAPES.join(" | ")}

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
  cell region with "parent" and "at". A tier list, a 2-up comparison, a leaderboard, a bingo
  card and a side-by-side before/after are all this. Without it the structure is only a
  picture of itself and nothing can be placed into it.
- Count the columns honestly. A row that has a coloured block with a letter on the left and
  a darker area holding items on the right is TWO cells in two columns, not one cell across
  the row — the left one is a label and the right one is where things get placed, and a
  video of this format puts something different in that right-hand area every time. Five
  such rows is a 5x2 grid and ten cell regions.
- Every cell MUST carry "parent" and "at". A region that cannot say which row and column it
  occupies is not a cell; make it a panel or an overlay instead.
- Where individual items sit inside a cell — each headshot on a tier row, each logo in a
  line-up — give each one its own cell region too, with the column it occupies, so an
  episode can fill them one at a time.
- Every region must have at least one track, and every track at least one item.
- z decides what is painted over what. Give overlapping regions different z.
- A caption that changes word by word is many items on ONE caption track, each with its own
  start and end — not one item for the whole video, and NOT one item per sentence. Count
  the times the words on screen change and make that many items. If three words appear, then
  three more replace them, that is two items, even though it is one sentence. A caption
  track that holds a whole sentence for three seconds when the real one changed five times
  is a different video.
- For kind "text", value is the exact words on screen, verbatim, including emoji.
- For kind "image" or "video", value describes what is depicted, concretely enough that
  someone could recreate it without seeing the original.
- Describe only what is visibly there. Do not name a camera, a lens, or a brand you cannot
  read on screen. Do not describe mood, quality, or intent.
- If the video has no region of some kind, leave it out. Never invent one to look complete.

LAYOUT HARD CONSTRAINTS — forced by a measured HypeKit tier-list failure, not taste
- A tier BOARD is a DARK panel (#111–#222). Each row holds SMALL square thumbnails sitting
  on that panel — never one image stretched across the whole row. Slot regions are cells
  under the board; prompts describe a single square thumb, not a panorama of fruit/faces.
- Captions over footage: outline/stroke. Do NOT invent a solid cyan/coloured plate behind
  the whole caption line. A sparse per-word highlight is optional; a full-band backdrop is wrong.
- Captions that change over a presenter MUST sit in the gap ABOVE the bottom board
  (tier list, leaderboard, bingo). Require:
  caption.rect[1] + caption.rect[3] <= board.rect[1]
  If your first measurement violates that, you measured wrong — move the caption up.
  Never leave readable words under an opaque panel.
- When a caption and a board would still share pixels, give the caption a HIGHER z than
  the board. A caption with lower z than the board is how words disappear in the render.
- backdrop is the set BEHIND the figure, not a second full-frame film under the whole
  composition. If a figure owns the upper stage and a board owns the lower half,
  backdrop.rect matches the upper stage (same y/h band as the figure's stage), never
  [0, 0, 1, 1]. A full-bleed backdrop under an opaque board wastes a generate slot and
  shows as a weird movie under the host.
- A talking-head / presenter above a bottom board: the figure region is that upper stage
  (near the full width of the stage). Do not shrink it to a floated portrait with large
  empty margins that then get their own generated backdrop, unless the source clearly
  shows a small PiP bubble.
- Every coloured tier/label cell MUST carry paint.fill (the row colour as hex) AND a
  text style with measured font, weight, size (fraction of canvas height), and color.
  Leaving style empty is how S/A/B letters come out in the wrong face and size.
- Timed overlays that flash over the board (meme card, comparison graphic) are separate
  overlay regions with higher z and short items — not a permanent region covering the
  board for the whole runtime unless the source holds it that long.

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
- "background" and "outline" are different things and a line often has only one. A
  background is a solid PLATE the words sit on, visible in the gaps between letters and
  beyond the last one. An outline only ever touches the letters. If the words sit over
  footage with a dark edge around each letter, that is an outline and there is NO
  background — do NOT invent a black (or any) plate to fake a stroke. Giving both when
  the video has only a stroke draws a bar across the frame.
- If the REGION already has "paint.fill" that is the plate the words sit on (a cream
  title banner, a white card), put the colour on the region and leave style.background
  out. Repeating it on the words draws a second plate.
- "font" is the SHAPE of the lettering as you can see it, not a font you are guessing the
  name of. Heavy and geometric is "display"; ordinary is "sans"; narrow is
  "sans-condensed"; soft-cornered is "sans-rounded".
- Measure the top edge of a band that sits near the top of the frame. Short-form video
  leaves a margin above the first element for the phone's own clock, status bar and camera
  cutout, so a title strip usually does NOT start at y 0. If there is a gap above it, the
  rect starts below 0 — say where it really starts.
- A painted banner that reaches the left and right edges of the frame has x ≈ 0 and
  width ≈ 1. Do not invent side margins for a full-bleed strip; the only common inset is
  the gap ABOVE it for the status bar.

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

WHEN AN ITEM WAITS BEFORE IT LANDS — "hold" and "waitsAt"
- Leave both out unless the source clearly does this: the item is on screen the whole time it
  is relevant, no different from today.
- "hold": "on-cue" means the item is not in its place from the start — it waits somewhere
  else, then moves into place and stays. A tier list where the subject's icon first sits
  beside the presenter and only lands in its row once the verdict is said is exactly this.
- "waitsAt" names the id of the region it waits at first — where it is BEFORE it lands, not
  where it ends up. The item's own region/rect is still where it ends up.

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
