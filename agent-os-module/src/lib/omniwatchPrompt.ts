// What to ask a picture provider for, and why.
//
// This file exists because of a bad answer given while building it. The tier tiles came back
// as stock photographs of distant figures, unreadable at the size they are drawn, and the fix
// typed in was "tight head-and-shoulders portrait, face filling the frame". It worked, and it
// was wrong: it does not know that the tiles are faces. The next format's tiles are cars, or
// album covers, or flying fairies, and it would have asked all of them to be faces.
//
// The distinction this file keeps is between two things that look alike in a prompt:
//
//   WHAT is in the picture — the film said it, we repeat it, we do not embellish it.
//   HOW it must be framed — we MEASURED it, from the box the picture goes in.
//
// "The subject fills the frame" is not a guess about content. A hundred-pixel tile in a
// seven-hundred-pixel frame cannot show anything that does not fill it, whether that is a
// footballer or a fairy. That argument is about the box, so it is ours to make. "It is a
// face" is about the content, so it is the film's to say, and if the film did not say it we
// do not either.
import type { Blueprint, BlueprintItem, BlueprintTrack } from "@/lib/omniwatchBlueprint";

/** How tightly the subject has to be held to survive the size it is drawn at. */
export type Framing = "fills" | "close" | "open";

/** Below this fraction of the canvas WIDTH, a picture is a thumbnail: whatever is in it has
 *  to reach the edges or it will not read at all. Measured against our own board — a tier
 *  tile is about an eighth of the frame. */
export const THUMB_OF_CANVAS = 0.18;
/** Below this, the picture is an inset rather than a scene: the subject should still be the
 *  clear centre of it, but it can breathe. */
export const INSET_OF_CANVAS = 0.5;

/** The framing a box of this width demands. Nothing here looks at the content. */
export function framingFor(boxFractionOfWidth: number): Framing {
  if (!(boxFractionOfWidth > 0)) return "open";
  if (boxFractionOfWidth < THUMB_OF_CANVAS) return "fills";
  if (boxFractionOfWidth < INSET_OF_CANVAS) return "close";
  return "open";
}

const FRAMING_CLAUSE: Record<Framing, string> = {
  fills: "the subject fills the frame edge to edge, tightly cropped, plain uncluttered background",
  close: "the subject centred and large in frame, uncluttered background",
  open: "",
};

/** True when a run of capitalised words is a name rather than a sentence starting.
 *
 *  Deliberately crude and deliberately OFF by default. It cannot tell a person from a
 *  tournament, so it is policy a caller turns on knowingly — never a silent rewrite of what
 *  the film said. */
const NAME_RUN = /(?<![.!?]\s)(?<!^)\b\p{Lu}\p{Ll}+(?:\s+(?:Jr\.?|van|de|da|von|\p{Lu}\p{Ll}+))+/gu;

/** The film's own words about the picture, with named individuals taken out.
 *
 *  For a REPRODUCTION this is wrong and should stay off: the film means that person. For a
 *  SWAP it is the whole point — we are making our film in their format, and their cast is
 *  not ours to render. */
export function anonymise(value: string): string {
  return value.replace(NAME_RUN, "an unnamed person").replace(/\s{2,}/g, " ").trim();
}

export interface PromptOptions {
  /** The picture's own width as a fraction of the canvas width. The only number that
   *  changes the framing, and it comes from the measurement, not from a model. */
  boxFractionOfWidth: number;
  /** The slot holds exactly ONE picture. True whenever the row was split into tiles, which
   *  is a counted fact — so "no collage" is a measurement too, not a taste. */
  single?: boolean;
  /** Take named individuals out of the description. Off by default. */
  swapCast?: boolean;
}

/** Everything we are entitled to say to a picture provider about one slot. */
export function promptFor(value: string, o: PromptOptions): string {
  const subject = (o.swapCast ? anonymise(value) : value).trim();
  const clauses: string[] = [];
  const framing = FRAMING_CLAUSE[framingFor(o.boxFractionOfWidth)];
  if (framing) clauses.push(framing);
  if (o.single) clauses.push("one single subject, not a collage, no side-by-side panels");
  // True of every slot this pipeline fills: the words on screen are drawn by the composer
  // from the blueprint, so a provider putting its own text in the picture can only ever be
  // a second, wrong caption.
  clauses.push("no text, no watermark");
  return clauses.length ? `${subject} — ${clauses.join(", ")}` : subject;
}

/** The prompt for one item of one track, with the numbers looked up rather than passed in. */
export function promptForItem(
  bp: Blueprint, track: BlueprintTrack, item: BlueprintItem, o: { swapCast?: boolean } = {},
): string {
  const region = bp.regions.find((r) => r.id === track.region);
  // An item with a box of its own is drawn at exactly that size, and there is nothing to
  // work out.
  if (item.rect) {
    return promptFor(item.value, { boxFractionOfWidth: item.rect[2], single: true, swapCast: o.swapCast });
  }
  const width = region?.rect[2] ?? 1;
  const height = region?.rect[3] ?? 1;
  const siblings = track.items.length || 1;
  // Two ways a tile can be narrower than the row it sits in, and the tighter one wins.
  //
  // Sharing: several tiles side by side each get a share of the width. Squareness: a tile in
  // a row is as wide as the row is TALL, which on a 9:16 canvas is a much smaller fraction
  // of the width than of the height — 0.09 of the height is 115 px, which is 0.16 of a
  // 720 px width, not 0.09. Dividing the row's width alone said a tile was half again
  // wider than it is, which is the difference between asking for a filled frame and not.
  const shared = siblings > 1 ? width / siblings : width;
  const square = height * (bp.canvas.height / Math.max(bp.canvas.width, 1));
  const perItem = Math.min(shared, square);
  return promptFor(item.value, {
    boxFractionOfWidth: perItem,
    single: siblings > 1,
    swapCast: o.swapCast,
  });
}
