// The recipe: everything a dumb compositor needs in order to draw, and nothing it has to guess.
//
// The blueprint says WHERE things are and WHEN they are on screen. It deliberately says
// almost nothing about how they LOOK, because the model that writes it cannot be trusted
// with a stylesheet — it invents font names, backdrops and shadows that were never in the
// frame. So appearance was left to the composer, and the composer guessed: a condensed face
// for tier letters that are set in plain regular grotesque, a caption stroke of "about three
// pixels", a label column of "about sixteen percent". Every one of those guesses was a CSS
// constant with a comment explaining why this particular number looked better than the last
// one, and the render still did not match the reference.
//
// The diagnosis (Janek, 2026-09-21) was that the recipe carried too little, not that the
// composer implemented it badly. This file is the answer: one authored contract, rich enough
// that drawing is arithmetic. Two things fill it — a vision pass that reads the frame, and a
// pixel scan that measures it (see omniwatchBoardScan) — and the measured values always win,
// because a number counted off the source beats a number a model remembered.
//
// Three rules hold the shape together:
//
//   EVERY SIZE IS A FRACTION, of the canvas or of the box it sits in, so one recipe renders
//   at 720x1280 and at 1080x1920 and means the same thing.
//
//   EVERY FACE IS A NAME FROM A CLOSED SET, never a family string. A model asked for a font
//   answers "Impact" for a face that is not Impact, and that string would reach a stylesheet.
//   A shape it CAN see — heavy grotesque, condensed, rounded — maps here to a stack that
//   exists on the rendering machine.
//
//   EVERY COLOUR IS A PLAIN HEX, checked here and checked again at the point of use.
//
// What is absent is as deliberate: no selectors, no CSS, no per-element hacks. If the render
// is wrong, a number in here is wrong, and that is a thing you can look at.

import type { Blueprint, FontShape, TextStyle } from "@/lib/omniwatchBlueprint";
import { validateBlueprint } from "@/lib/omniwatchBlueprint";
import type { BoardMeasure } from "@/lib/omniwatchBoardScan";

export const RECIPE_VERSION = "omniwatch.recipe/1";

/** The SHAPE of a face, as a closed vocabulary.
 *
 *  Named for what a vision model can honestly see in a frame: weight, width and terminal.
 *  "grotesque-black" is the heavy neutral sans a title bar is set in (Arial Black and its
 *  kin); "condensed-black" is the tall narrow poster face; "grotesque" is the plain regular
 *  sans a tier letter is set in — which is what the reference uses, and which four rounds of
 *  CSS tuning kept overriding with a display face because the recipe never said otherwise. */
export const FACES = [
  "grotesque",
  "grotesque-black",
  "condensed",
  "condensed-black",
  "rounded",
  "serif",
  "slab",
  "mono",
] as const;
export type Face = (typeof FACES)[number];

/** The stacks these names mean on a rendering machine.
 *
 *  First entry is the one that was measured against the reference; the rest are fallbacks
 *  for machines that lack it. Quoting is single, because this string ends up inside a
 *  style="…" attribute and a double quote there closes it early — which once silently
 *  dropped the colour and weight that followed it. */
export const FACE_STACKS: Record<Face, string> = {
  grotesque: "'Helvetica Neue', Helvetica, Arial, Inter, sans-serif",
  "grotesque-black": "'Arial Black', 'Helvetica Neue', Montserrat, Inter, sans-serif",
  condensed: "'Arial Narrow', Oswald, 'Roboto Condensed', Inter, sans-serif",
  "condensed-black": "Anton, 'League Gothic', Oswald, 'Arial Narrow', sans-serif",
  rounded: "'SF Pro Rounded', 'Varela Round', 'Trebuchet MS', Inter, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  slab: "Rockwell, 'Roboto Slab', Georgia, serif",
  mono: "'SF Mono', Menlo, Consolas, monospace",
};

/** How one run of words is set. Sizes are fractions of the CANVAS height unless the field
 *  that holds this spec says otherwise (a tier letter is a fraction of its row). */
export interface TypeSpec {
  face: Face;
  /** 100..900. */
  weight: number;
  /** Fraction of canvas height. */
  size: number;
  /** Hex. */
  ink: string;
  case: "as-is" | "upper" | "lower" | "title";
  align: "left" | "center" | "right";
  /** Multiple of size. */
  lineHeight: number;
  /** How many lines the words may take before they are shrunk to fit. */
  maxLines: number;
  /** Letter-spacing in em. */
  tracking: number;
  /** A stroke around the glyphs; width is a fraction of canvas height. Null means none —
   *  said explicitly, because "absent" and "none" were being conflated and a caption with no
   *  stroke still got one. */
  stroke: { color: string; width: number } | null;
  /** A solid plate behind the whole line. Null means the words sit on whatever is behind
   *  them — which is what a karaoke caption does, and drawing a plate there put a black bar
   *  across a frame that had none. */
  plate: string | null;
}

/** One tile in a tier row. */
export interface ThumbSpec {
  /** Width over height. Square in every tier list measured so far, but a format that used
   *  portrait cards would say 0.75 here rather than needing new code. */
  aspect: number;
  /** Tile height as a fraction of the ROW height. */
  heightRatio: number;
  /** Corner rounding as a fraction of the tile's shorter side. */
  radiusRatio: number;
  /** Space between tiles, as a fraction of canvas width. */
  gap: number;
  /** Space before the first tile, as a fraction of canvas width. */
  padX: number;
  fit: "cover" | "contain";
  align: "left" | "center";
  /** Tiles a row may hold. Beyond this the row is full and the rest are dropped rather than
   *  squeezed — a format that overflows is a format that was measured wrong. */
  maxCount: number;
}

export interface TierSpec {
  /** "s", "a", … — matches the "<id>-label" / "<id>-slot" region ids. */
  id: string;
  /** What is printed on the plate. */
  letter: string;
  /** Hex, the plate itself. */
  fill: string;
  /** How many tiles this row carries, when that was measured. */
  count?: number;
}

export interface FormatRecipe {
  version: typeof RECIPE_VERSION;
  /** Free text: "tier-list-9x16". Not dispatched on — the regions decide what gets drawn. */
  format: string;
  canvas: { width: number; height: number };
  film: { background: string };
  banner: {
    /** The plate behind the title, or null when the title sits straight on the footage. */
    plate: string | null;
    type: TypeSpec;
    /** Insets, as fractions of the banner box. */
    padX: number;
    padY: number;
  };
  caption: {
    type: TypeSpec;
    /** The pill behind the word being spoken, or null for a caption that has none. */
    karaoke: { color: string } | null;
    /**
     * What this format does when a line of narration is longer than one line of caption.
     *
     * "chunk" — it shows a few words at a time, at the same size, in time with the speech.
     *           This is what the reference does, and measuring it is simple: two captions of
     *           very different lengths, sampled seconds apart, are set at the SAME cap height.
     * "shrink" — it sets the whole line smaller so that it fits.
     *
     * The difference is not cosmetic. Told to shrink, a twelve-word line came out at a third
     * of the size of a four-word one, three times in the same film — the caption changing
     * size every time the speaker draws breath, which no format does.
     */
    overflow: "chunk" | "shrink";
  };
  presenter: { fit: "cover" | "contain"; position: string };
  board: {
    /** Behind the whole board — visible as the grid lines between rows. */
    background: string;
    /** Behind the tiles in a row. */
    slotBackground: string;
    /** Label column width as a fraction of the BOARD width. */
    labelRatio: number;
    /** Space between rows, as a fraction of canvas height. */
    rowGap: number;
  };
  label: {
    type: TypeSpec;
    /** Letter size as a fraction of the ROW height — the one size that is not canvas-relative,
     *  because a tier letter is sized by its plate and nothing else. */
    sizeRatioOfRow: number;
    /** Corner rounding of the plate. Sharp in every reference measured; kept as a number so
     *  a format with rounded plates does not need a code change. */
    radiusRatio: number;
  };
  thumb: ThumbSpec;
  tiers: TierSpec[];
  inset: {
    radiusRatio: number;
    border: { color: string; width: number } | null;
    fit: "cover" | "contain";
  };
  /** A picture laid over the rest for a moment — the insert layer.
   *
   *  Distinct from `inset`, which is the small portrait that sits by the presenter's head for
   *  the whole film. A card arrives, holds for a beat and goes; it is the thing that makes a
   *  tier list a video rather than a screenshot, and it is drawn at the size and place it was
   *  measured at, so all this carries is how it is finished. */
  card: {
    radiusRatio: number;
    shadow: boolean;
    fit: "cover" | "contain";
  };
  notes: string[];
}

/** A capital's height as a share of the em.
 *
 *  Cap height is not font size, and treating the two as the same is how a tier letter came
 *  out a third too small. Every measurement in this pipeline counts drawn pixels — a letter's
 *  height, a caption's — and every one of them has to be divided by this to get back to the
 *  size a stylesheet is set in. 0.72 is the figure for the grotesques these formats use; it
 *  is a property of type, not of any one video. */
export const CAP_OF_EM = 0.72;

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hex = (v: unknown, fallback: string): string => {
  if (typeof v !== "string") return fallback;
  const t = v.trim();
  return HEX.test(t) ? t : HEX.test(`#${t}`) ? `#${t}` : fallback;
};
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** A face name, accepting the words a model reaches for when it is describing one.
 *
 *  Asked for a closed set it mostly complies, and then answers "display" or "impact" or
 *  "sans-serif" anyway. Mapping those to the nearest member is honest — they are all
 *  descriptions of a shape — and refusing them would mean falling back to the default face
 *  for a frame the model actually read correctly. */
export function readFace(v: unknown, fallback: Face = "grotesque"): Face {
  if (typeof v !== "string") return fallback;
  const t = v.trim().toLowerCase();
  if ((FACES as readonly string[]).includes(t)) return t as Face;
  if (/impact|anton|league|poster|condensed[- ]?(black|bold|heavy)|gothic/.test(t)) return "condensed-black";
  if (/narrow|condensed/.test(t)) return "condensed";
  if (/black|heavy|ultra|extra[- ]?bold|display/.test(t)) return "grotesque-black";
  if (/round/.test(t)) return "rounded";
  if (/slab/.test(t)) return "slab";
  if (/serif/.test(t) && !/sans/.test(t)) return "serif";
  if (/mono/.test(t)) return "mono";
  return fallback;
}

function readType(v: unknown, base: TypeSpec): TypeSpec {
  const o = isObj(v) ? v : {};
  const strokeRaw = o.stroke;
  let stroke: TypeSpec["stroke"] = null;
  if (isObj(strokeRaw)) {
    const w = clamp(strokeRaw.width, 0, 0.02, base.stroke?.width ?? 0.004);
    if (w > 0) stroke = { color: hex(strokeRaw.color, base.stroke?.color ?? "#000000"), width: w };
  } else if (strokeRaw === undefined) {
    stroke = base.stroke;
  }
  const plateRaw = o.plate;
  const plate = plateRaw === null ? null
    : plateRaw === undefined ? base.plate
    : typeof plateRaw === "string" && HEX.test(plateRaw.trim()) ? plateRaw.trim()
    : null;
  return {
    face: readFace(o.face ?? o.fontFamily ?? o.fontHint, base.face),
    weight: Math.round(clamp(o.weight, 100, 900, base.weight) / 100) * 100,
    size: clamp(o.size ?? o.sizeRatio, 0.004, 0.3, base.size),
    ink: hex(o.ink ?? o.color ?? o.textColor, base.ink),
    case: pick(o.case, ["as-is", "upper", "lower", "title"] as const, base.case),
    align: pick(o.align, ["left", "center", "right"] as const, base.align),
    lineHeight: clamp(o.lineHeight, 0.7, 2.5, base.lineHeight),
    maxLines: Math.round(clamp(o.maxLines, 1, 6, base.maxLines)),
    tracking: clamp(o.tracking, -0.1, 0.4, base.tracking),
    stroke,
    plate,
  };
}

const TIER_FALLBACK: TierSpec[] = [
  { id: "s", letter: "S", fill: "#EC5D4F" },
  { id: "a", letter: "A", fill: "#EB9E4C" },
  { id: "b", letter: "B", fill: "#EDCB4B" },
  { id: "c", letter: "C", fill: "#E8EA5C" },
  { id: "d", letter: "D", fill: "#96DE7F" },
];

/** The recipe a tier list gets when nothing has been measured yet.
 *
 *  Not a house style: every number here was counted off the reference frame that this
 *  pipeline is built against (720x1280, board grid measured in omniwatchBoardScan), so an
 *  un-measured render is already in the right neighbourhood and a measured one only has to
 *  correct it. A default that was invented would hide the difference. */
export function defaultRecipe(canvas?: { width: number; height: number }): FormatRecipe {
  const type = (over: Partial<TypeSpec>): TypeSpec => ({
    face: "grotesque",
    weight: 400,
    size: 0.032,
    ink: "#111111",
    case: "as-is",
    align: "center",
    lineHeight: 1.08,
    maxLines: 2,
    tracking: 0,
    stroke: null,
    plate: null,
    ...over,
  });
  return {
    version: RECIPE_VERSION,
    format: "tier-list-9x16",
    canvas: { width: Math.round(canvas?.width || 720), height: Math.round(canvas?.height || 1280) },
    film: { background: "#000000" },
    banner: {
      plate: "#F0EFE9",
      // Measured: two lines of 41px on a 1280-high frame, black on cream, heavy neutral sans.
      type: type({ face: "grotesque-black", weight: 900, size: 0.034, ink: "#111111", case: "upper", maxLines: 2, lineHeight: 1.06 }),
      padX: 0.04,
      padY: 0.08,
    },
    caption: {
      // White with a heavy black stroke — measured at ~5px on 1280, which is 0.004.
      type: type({ face: "grotesque-black", weight: 900, size: 0.036, ink: "#FFFFFF", case: "as-is", maxLines: 1, stroke: { color: "#000000", width: 0.0042 } }),
      karaoke: null,
      overflow: "chunk",
    },
    presenter: { fit: "cover", position: "center top" },
    board: {
      background: "#141417",
      slotBackground: "#2B2B2F",
      labelRatio: 0.2417,
      rowGap: 0.0023,
    },
    label: {
      // Plain regular grotesque, dark ink, a little over half the row's height. The render
      // that missed used a condensed display face at nearly the full row height.
      type: type({ face: "grotesque", weight: 400, ink: "#27272A", case: "upper", maxLines: 1 }),
      sizeRatioOfRow: 0.46,
      radiusRatio: 0,
    },
    thumb: {
      aspect: 1,
      heightRatio: 0.945,
      radiusRatio: 0.11,
      gap: 0.0055,
      padX: 0,
      fit: "cover",
      align: "left",
      maxCount: 6,
    },
    tiers: TIER_FALLBACK.map((t) => ({ ...t })),
    inset: { radiusRatio: 0.11, border: null, fit: "cover" },
    card: { radiusRatio: 0.03, shadow: true, fit: "cover" },
    notes: [],
  };
}

/** Whatever the model (or a sidecar file) wrote, turned into a recipe that can be drawn.
 *
 *  Nothing here refuses: a field that is missing, out of range or a colour word instead of a
 *  hex falls back to the default, and the render carries on. A recipe that failed validation
 *  would leave the composer with nothing at all, which is strictly worse than a recipe with
 *  one wrong number in it — and the wrong number is visible in the frame, which is where it
 *  gets found. */
export function normalizeRecipe(raw: unknown, canvas?: { width: number; height: number }): FormatRecipe {
  const base = defaultRecipe(canvas);
  if (!isObj(raw)) return base;
  const o = raw;

  const bannerRaw = isObj(o.banner) ? o.banner : {};
  const captionRaw = isObj(o.caption) ? o.caption : {};
  const boardRaw = isObj(o.board) ? o.board : {};
  const labelRaw = isObj(o.label) ? o.label : {};
  const thumbRaw = isObj(o.thumb) ? o.thumb : isObj(o.thumbs) ? o.thumbs : {};
  const insetRaw = isObj(o.inset) ? o.inset : {};
  const cardRaw = isObj(o.card) ? o.card : {};
  const filmRaw = isObj(o.film) ? o.film : {};
  const presenterRaw = isObj(o.presenter) ? o.presenter : {};

  const tiers: TierSpec[] = Array.isArray(o.tiers)
    ? o.tiers.flatMap((t, i): TierSpec[] => {
        if (!isObj(t)) return [];
        const fallback = TIER_FALLBACK[i] ?? TIER_FALLBACK[TIER_FALLBACK.length - 1];
        const id = typeof t.id === "string" && /^[a-z0-9]{1,4}$/i.test(t.id.trim())
          ? t.id.trim().toLowerCase() : fallback.id;
        const letter = typeof t.letter === "string" && t.letter.trim()
          ? t.letter.trim().slice(0, 4)
          : typeof t.label === "string" && t.label.trim() ? t.label.trim().slice(0, 4) : id.toUpperCase();
        const count = t.count === undefined ? undefined : Math.round(clamp(t.count, 0, 12, 0));
        return [{ id, letter, fill: hex(t.fill ?? t.color, fallback.fill), ...(count === undefined ? {} : { count }) }];
      })
    : base.tiers;

  // A plate said to be absent is absent; a plate field that is simply missing keeps the
  // default. "hasPlate: false" is how the first recipe pass said "no plate", and honouring
  // it is the difference between a title on cream and a title on the footage.
  const bannerPlate = bannerRaw.hasPlate === false ? null
    : bannerRaw.plate === null ? null
    : typeof bannerRaw.plate === "string" || typeof bannerRaw.fill === "string"
      ? hex(bannerRaw.plate ?? bannerRaw.fill, base.banner.plate ?? "#F0EFE9")
      : base.banner.plate;

  // The caption's stroke arrives as its own fields as often as inside a `stroke` object, and
  // the width is quoted in pixels of a 1280-high frame rather than as a fraction.
  const captionStroke = (() => {
    if (isObj(captionRaw.stroke)) return captionRaw.stroke;
    const w = captionRaw.strokeWidth;
    if (w === undefined && captionRaw.strokeColor === undefined) return undefined;
    const px = clamp(w, 0, 16, 5);
    return { color: captionRaw.strokeColor, width: px > 0.05 ? px / 1280 : px };
  })();

  const karaokeRaw = captionRaw.karaoke ?? captionRaw.karaokeActiveBox;
  const karaoke = karaokeRaw === null || karaokeRaw === undefined || karaokeRaw === false
    ? base.caption.karaoke
    : isObj(karaokeRaw)
      ? { color: hex(karaokeRaw.color, "#00BFFF") }
      : typeof karaokeRaw === "string" && HEX.test(karaokeRaw.trim())
        ? { color: karaokeRaw.trim() }
        : base.caption.karaoke;

  return {
    version: RECIPE_VERSION,
    format: typeof o.format === "string" && o.format.trim() ? o.format.trim().slice(0, 60) : base.format,
    canvas: {
      width: Math.round(clamp(isObj(o.canvas) ? o.canvas.w ?? o.canvas.width : undefined, 16, 8192, base.canvas.width)),
      height: Math.round(clamp(isObj(o.canvas) ? o.canvas.h ?? o.canvas.height : undefined, 16, 8192, base.canvas.height)),
    },
    film: { background: hex(filmRaw.background, base.film.background) },
    banner: {
      plate: bannerPlate,
      type: readType({
        ...bannerRaw,
        ink: bannerRaw.ink ?? bannerRaw.textColor,
        face: bannerRaw.face ?? bannerRaw.fontHint ?? bannerRaw.fontFamily,
        // The band is the REGION's colour; the words must not carry it too. Passing the
        // banner's fields straight through handed `plate` to the type as well, and the title
        // came out on a second, narrower plate of the same colour sitting on the first — the
        // same double-plate the blueprint validator has a rule against, one layer up. A
        // separate plate behind the words alone has to be named separately.
        plate: bannerRaw.textPlate ?? null,
      }, base.banner.type),
      padX: clamp(isObj(bannerRaw.padding) ? bannerRaw.padding.x : bannerRaw.padX, 0, 0.4, base.banner.padX),
      padY: clamp(isObj(bannerRaw.padding) ? bannerRaw.padding.y : bannerRaw.padY, 0, 0.4, base.banner.padY),
    },
    caption: {
      type: readType({
        ...captionRaw,
        ink: captionRaw.ink ?? captionRaw.fill ?? captionRaw.color,
        face: captionRaw.face ?? captionRaw.fontHint ?? captionRaw.fontFamily,
        stroke: captionStroke,
        // "background: #00000000" is the model's way of saying "no plate"; a transparent hex
        // reaching a background declaration is a plate that paints nothing but still counts
        // as one everywhere downstream.
        plate: typeof captionRaw.plate === "string" ? captionRaw.plate
          : captionRaw.hasBackdropPlate === false ? null
          : typeof captionRaw.background === "string" && !/^#?0{6,8}$/.test(captionRaw.background.replace("#", "")) && captionRaw.background.length <= 7
            ? captionRaw.background
            : null,
      }, base.caption.type),
      karaoke,
      overflow: pick(captionRaw.overflow, ["chunk", "shrink"] as const, base.caption.overflow),
    },
    presenter: {
      fit: pick(presenterRaw.fit ?? presenterRaw.objectFit, ["cover", "contain"] as const, base.presenter.fit),
      position: typeof presenterRaw.position === "string" && /^[a-z %]{1,24}$/i.test(presenterRaw.position)
        ? presenterRaw.position : base.presenter.position,
    },
    board: {
      background: hex(boardRaw.background, base.board.background),
      slotBackground: hex(boardRaw.slotBackground ?? boardRaw.rowBackground, base.board.slotBackground),
      labelRatio: clamp(boardRaw.labelRatio ?? boardRaw.labelColumn, 0.05, 0.5, base.board.labelRatio),
      rowGap: clamp(boardRaw.rowGap, 0, 0.05, base.board.rowGap),
    },
    label: {
      type: readType({ ...labelRaw, ink: labelRaw.ink ?? labelRaw.color ?? (o as Record<string, unknown>).labelTextColor }, base.label.type),
      sizeRatioOfRow: clamp(labelRaw.sizeRatioOfRow, 0.1, 1.2, base.label.sizeRatioOfRow),
      radiusRatio: clamp(labelRaw.radiusRatio, 0, 0.5, base.label.radiusRatio),
    },
    thumb: {
      aspect: clamp(thumbRaw.aspect, 0.2, 5, base.thumb.aspect),
      heightRatio: clamp(thumbRaw.heightRatio ?? thumbRaw.sizeRatioOfRow, 0.2, 1, base.thumb.heightRatio),
      radiusRatio: clamp(thumbRaw.radiusRatio, 0, 0.5, base.thumb.radiusRatio),
      gap: clamp(thumbRaw.gap, 0, 0.1, base.thumb.gap),
      padX: clamp(isObj(thumbRaw.padding) ? thumbRaw.padding.x : thumbRaw.padX, 0, 0.2, base.thumb.padX),
      fit: pick(thumbRaw.fit, ["cover", "contain"] as const, base.thumb.fit),
      align: pick(thumbRaw.align, ["left", "center"] as const, base.thumb.align),
      maxCount: Math.round(clamp(thumbRaw.maxCount, 1, 12, base.thumb.maxCount)),
    },
    tiers: tiers.length ? tiers : base.tiers,
    inset: {
      radiusRatio: clamp(insetRaw.radiusRatio, 0, 0.5, base.inset.radiusRatio),
      border: isObj(insetRaw.border) && typeof insetRaw.border.color === "string"
        ? { color: hex(insetRaw.border.color, "#FFFFFF"), width: clamp(insetRaw.border.width, 0, 0.2, 0.03) }
        : typeof insetRaw.borderColor === "string" && HEX.test(insetRaw.borderColor.trim())
          ? { color: insetRaw.borderColor.trim(), width: 0.03 }
          : base.inset.border,
      fit: pick(insetRaw.fit, ["cover", "contain"] as const, base.inset.fit),
    },
    card: {
      radiusRatio: clamp(cardRaw.radiusRatio, 0, 0.5, base.card.radiusRatio),
      shadow: typeof cardRaw.shadow === "boolean" ? cardRaw.shadow : base.card.shadow,
      fit: pick(cardRaw.fit, ["cover", "contain"] as const, base.card.fit),
    },
    notes: Array.isArray(o.notes)
      ? o.notes.filter((n): n is string => typeof n === "string").slice(0, 12).map((n) => n.slice(0, 200))
      : [],
  };
}

/** Roughly how wide a character is in a face, as a share of the em.
 *
 *  Shared with the composer, which uses it to decide where a line breaks, and used here to
 *  answer a question no model can: WHICH of the faces is this. A heavy grotesque and a heavy
 *  condensed look alike described in words, and are half again apart in width — which is the
 *  difference between a caption on one line and the same caption wrapped onto two. */
export const FACE_WIDTHS: Record<Face, number> = {
  grotesque: 0.53,
  "grotesque-black": 0.62,
  condensed: 0.44,
  "condensed-black": 0.46,
  rounded: 0.54,
  serif: 0.5,
  slab: 0.55,
  mono: 0.6,
};

/** The face whose width matches lettering that has been measured.
 *
 *  Given the words, the box they fill and the size they are set at, the average character
 *  width falls out — and that is the one property of a face that a vision model cannot
 *  report and a scan can. The weight class is kept: a heavy face stays heavy, so this only
 *  ever chooses between shapes the model already agreed the lettering has.
 *
 *  Null when the evidence is too thin to act on: a few characters, or a measurement the
 *  current face already explains. */
export function faceFromWidth(current: Face, chars: number, widthPx: number, emPx: number): Face | null {
  if (chars < 6 || emPx <= 1 || widthPx <= 1) return null;
  const measured = widthPx / (chars * emPx);
  if (!(measured > 0.2 && measured < 1.2)) return null;
  if (Math.abs(measured - FACE_WIDTHS[current]) < 0.06) return null;
  const heavy = current === "grotesque-black" || current === "condensed-black";
  const pool: Face[] = heavy
    ? ["condensed-black", "grotesque-black"]
    : ["condensed", "grotesque", "rounded", "serif", "slab", "mono"];
  let best = current, bestGap = Infinity;
  for (const f of pool) {
    const gap = Math.abs(FACE_WIDTHS[f] - measured);
    if (gap < bestGap) { bestGap = gap; best = f; }
  }
  return best === current ? null : best;
}

/** Counted beats described.
 *
 *  Where the pixel scan and the vision pass disagree, the scan wins — not because the model
 *  is bad at this frame but because it is answering from a description of the frame while the
 *  scan is answering from the frame. Everything the scan does not cover (faces, weights, what
 *  the caption's stroke colour is) is left exactly as the model wrote it. */
export function applyMeasure(recipe: FormatRecipe, m: BoardMeasure, notes: string[]): FormatRecipe {
  const tiers = recipe.tiers.map((t, i) => {
    const row = m.rows[i];
    if (!row) return t;
    return { ...t, fill: row.fill, count: row.thumbs.length };
  });
  const sizeRatioOfRow = m.letterCapRatio ? Math.min(1.2, m.letterCapRatio / CAP_OF_EM) : recipe.label.sizeRatioOfRow;

  notes.push(
    `measured board: labelRatio ${recipe.board.labelRatio.toFixed(4)}→${m.labelRatio.toFixed(4)}, ` +
    `rowGap ${recipe.board.rowGap.toFixed(4)}→${m.rowGap.toFixed(4)}, ` +
    `letter ${recipe.label.sizeRatioOfRow.toFixed(3)}→${sizeRatioOfRow.toFixed(3)} of row, ` +
    `tiles ${m.rows.map((r) => r.thumbs.length).join("/")}`,
  );

  return {
    ...recipe,
    board: {
      background: m.boardBackground,
      slotBackground: m.slotBackground,
      labelRatio: m.labelRatio,
      rowGap: m.rowGap,
    },
    label: {
      ...recipe.label,
      type: { ...recipe.label.type, ink: m.letterInk || recipe.label.type.ink },
      sizeRatioOfRow,
    },
    thumb: {
      ...recipe.thumb,
      heightRatio: m.thumb.heightRatio,
      aspect: m.thumb.aspect,
      gap: m.thumb.gap,
      padX: m.thumb.padX,
    },
    tiers,
  };
}

/** The face a blueprint TextStyle can carry, for the tracks that still go through it. */
const FACE_TO_SHAPE: Record<Face, FontShape> = {
  grotesque: "sans",
  "grotesque-black": "sans",
  condensed: "sans-condensed",
  "condensed-black": "display",
  rounded: "sans-rounded",
  serif: "serif",
  slab: "slab",
  mono: "mono",
};

/** What the recipe asks Gemini for, written as the contract rather than as advice.
 *
 *  The previous prompt asked for colours and a couple of ratios and then told the model, in
 *  prose, what a Hypit frame usually looks like — which is how a model ends up answering
 *  from its memory of tier lists instead of from the frame in front of it. This one asks for
 *  every number the compositor will use, says what each is a fraction OF, and says nothing
 *  about what the answer ought to be. */
export function recipePrompt(layoutHint: string, measuredHint?: string): string {
  return `You are reading ONE frame of a vertical short-form video and writing the appearance RECIPE that will redraw it.

Measured region boxes (normalized [x,y,w,h] of the canvas) — do NOT invent geometry, these ids are fixed:
${layoutHint}
${measuredHint ? `\nAlready measured off the pixels (these are FACTS — do not contradict them):\n${measuredHint}\n` : ""}
Answer with ONE JSON object, no markdown, exactly this shape:

{
  "format": "short description, e.g. tier-list-9x16",
  "film": { "background": "#rrggbb" },
  "banner": {
    "plate": "#rrggbb or null if the title sits straight on the footage",
    "padX": 0.0-0.3, "padY": 0.0-0.3,
    "face": "grotesque|grotesque-black|condensed|condensed-black|rounded|serif|slab|mono",
    "weight": 100-900, "size": 0.01-0.12, "ink": "#rrggbb",
    "case": "upper|as-is|lower|title", "align": "left|center|right",
    "lineHeight": 0.8-1.6, "maxLines": 1-3, "tracking": -0.05-0.2,
    "stroke": null or { "color": "#rrggbb", "width": 0.0-0.01 }
  },
  "caption": {
    "face": "...", "weight": 100-900, "size": 0.01-0.12, "ink": "#rrggbb",
    "case": "...", "align": "...", "lineHeight": 0.8-1.6, "maxLines": 1-3, "tracking": -0.05-0.2,
    "stroke": null or { "color": "#rrggbb", "width": 0.0-0.01 },
    "plate": null or "#rrggbb",
    "karaoke": null or { "color": "#rrggbb" },
    "overflow": "chunk" or "shrink"
  },
  "presenter": { "fit": "cover|contain", "position": "center top|center center" },
  "board": {
    "background": "#rrggbb", "slotBackground": "#rrggbb",
    "labelRatio": 0.05-0.5, "rowGap": 0.0-0.02
  },
  "label": {
    "face": "...", "weight": 100-900, "ink": "#rrggbb", "case": "upper|as-is",
    "sizeRatioOfRow": 0.1-1.0, "radiusRatio": 0.0-0.3, "tracking": -0.05-0.2
  },
  "thumb": {
    "aspect": 0.5-2, "heightRatio": 0.5-1, "radiusRatio": 0.0-0.3,
    "gap": 0.0-0.05, "padX": 0.0-0.1, "fit": "cover|contain", "align": "left|center", "maxCount": 1-8
  },
  "tiers": [ { "id": "s", "letter": "S", "fill": "#rrggbb", "count": 0-8 } ],
  "inset": { "radiusRatio": 0.0-0.3, "border": null or { "color": "#rrggbb", "width": 0.0-0.1 }, "fit": "cover|contain" },
  "card": { "radiusRatio": 0.0-0.2, "shadow": true or false, "fit": "cover|contain" },
  "notes": ["one short sentence per thing you noticed that the fields above cannot carry"]
}

What each number is a fraction OF:
- every "size" is the font size as a fraction of the FRAME HEIGHT
- "stroke.width" is a fraction of the FRAME HEIGHT (a 5px stroke on a 1280-high frame is 0.004)
- "labelRatio" is the tier-letter column width over the BOARD width
- "rowGap" is the gap between tier rows over the FRAME HEIGHT
- "label.sizeRatioOfRow" is the letter's size over ONE ROW's height
- "thumb.heightRatio" is a tile's height over its ROW's height; "gap" and "padX" are fractions of the FRAME WIDTH
- every "radiusRatio" is over the shorter side of the thing being rounded
- "card" is a picture laid OVER the rest for a few seconds (an insert), not the small portrait
  that stays by the presenter all film — that one is "inset"

"caption.overflow" is about what happens to a line too long for one line of caption: answer
"chunk" if what is on screen is a FRAGMENT of a sentence (a few words, the rest still to come),
"shrink" if it is a whole sentence set small enough to fit.

Report what this frame shows, not what this kind of video usually looks like. Tier letters are often plain regular-weight sans, not a poster face — say what you see. If something is not present, write null.`;
}

/** Put the recipe's typography onto the blueprint's own text tracks.
 *
 *  The composer reads the recipe directly for the parts it knows — banner, caption, tier
 *  letters — so this exists for everything downstream that still reads a TextStyle: the
 *  validator, the episode pass, anything that renders a blueprint without a recipe in hand.
 *  Keeping both in step is why appearance has ONE source: change the recipe and this follows.
 *
 *  Geometry is never touched here. */
export function applyRecipe(bp: Blueprint, recipe: FormatRecipe, notes: string[]): Blueprint {
  const H = bp.canvas.height || recipe.canvas.height || 1280;
  const tierFill = new Map(recipe.tiers.map((t) => [t.id.toLowerCase(), t.fill]));
  const tierLetter = new Map(recipe.tiers.map((t) => [t.id.toLowerCase(), t.letter]));

  const regions = bp.regions.map((r) => {
    const id = r.id.toLowerCase();
    const paint = { ...(r.paint || {}) };
    const tierOf = id.match(/^([a-z0-9]{1,4})-(label|slot)$/);
    if (/banner|title/i.test(id)) {
      if (recipe.banner.plate) paint.fill = recipe.banner.plate;
      else delete paint.fill;
    } else if (/caption/i.test(id)) {
      // The caption band paints nothing: its words carry their own stroke, and a fill here
      // is the black bar that kept appearing across a frame that had none.
      delete paint.fill;
      delete paint.radius;
      delete paint.border;
    } else if (tierOf && tierOf[2] === "label") {
      const fill = tierFill.get(tierOf[1]);
      if (fill) paint.fill = fill;
      if (recipe.label.radiusRatio > 0) paint.radius = recipe.label.radiusRatio;
      else delete paint.radius;
      delete paint.border;
    } else if (tierOf && tierOf[2] === "slot") {
      paint.fill = recipe.board.slotBackground;
      delete paint.radius;
      delete paint.border;
    } else if (/tier-board|tier-list|^board$/i.test(id)) {
      paint.fill = recipe.board.background;
    } else if (/inset|portrait|floating/i.test(id)) {
      // A card that carries a picture must not also carry a plate — a white fill under a
      // missing asset is how an empty inset came out as a blank card.
      delete paint.fill;
      paint.radius = recipe.inset.radiusRatio;
      if (recipe.inset.border) paint.border = recipe.inset.border;
      else delete paint.border;
    }
    return { ...r, paint };
  });

  const asStyle = (t: TypeSpec, sizeOverride?: number): TextStyle => {
    const st: TextStyle = {
      color: t.ink,
      font: FACE_TO_SHAPE[t.face],
      weight: t.weight,
      size: Math.min(0.5, sizeOverride ?? t.size),
      case: t.case,
      align: t.align,
    };
    if (t.stroke) st.outline = t.stroke.color;
    if (t.plate) st.background = t.plate;
    return st;
  };

  const tracks = bp.tracks.map((t) => {
    if (t.kind !== "text") return t;
    const region = String(t.region || "").toLowerCase();
    const tierOf = region.match(/^([a-z0-9]{1,4})-label$/);
    if (/caption|karaoke/i.test(region)) {
      const style = asStyle(recipe.caption.type) as TextStyle & { strokeWidth?: number };
      if (recipe.caption.type.stroke) style.strokeWidth = Math.max(1, Math.round(recipe.caption.type.stroke.width * H));
      if (recipe.caption.karaoke) style.emphasis = { style: "highlight", color: recipe.caption.karaoke.color };
      else delete style.emphasis;
      notes.push(`recipe → caption: ${recipe.caption.type.face} ${recipe.caption.type.weight} size ${recipe.caption.type.size} stroke ${style.strokeWidth ?? 0}px`);
      return { ...t, style };
    }
    if (/banner|title/i.test(region)) {
      const style = asStyle(recipe.banner.type);
      notes.push(`recipe → banner: ${recipe.banner.type.face} ${recipe.banner.type.weight} size ${recipe.banner.type.size}`);
      return { ...t, style };
    }
    if (tierOf) {
      const row = bp.regions.find((r) => r.id.toLowerCase() === region);
      const rowH = row ? row.rect[3] : 0.09;
      const style = asStyle(recipe.label.type, rowH * recipe.label.sizeRatioOfRow);
      const letter = tierLetter.get(tierOf[1]);
      const items = letter ? t.items.map((it) => ({ ...it, value: letter })) : t.items;
      return { ...t, style, items };
    }
    return t;
  });

  notes.push(
    `recipe: labelRatio=${recipe.board.labelRatio.toFixed(4)} rowGap=${recipe.board.rowGap.toFixed(4)} ` +
    `thumb=${recipe.thumb.heightRatio.toFixed(3)}h/${recipe.thumb.radiusRatio.toFixed(2)}r gap=${recipe.thumb.gap.toFixed(4)} ` +
    `tiers=${recipe.tiers.map((t) => t.fill).join(",")}`,
  );

  const checked = validateBlueprint({ ...bp, regions, tracks }, { preserveGeometry: true });
  if (!checked.ok) {
    notes.push(`recipe merge failed validation: ${checked.error} — kept the unvalidated merge`);
    return { ...bp, regions, tracks };
  }
  notes.push(...checked.notes);
  return checked.blueprint;
}
