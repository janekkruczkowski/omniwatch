// The capture prompt: what Omni is actually good at, and nothing else.
//
// The prompt this replaces asked Omni to measure the frame — a caption's size as a fraction of
// the canvas, how many seconds a card holds, what a stroke's colour is. Omni answered 0.028
// where the pixels measured 0.038, and it answered "the format shrinks the caption" from a
// single frame when the truth was "the format cuts it into chunks" (see IR-CONTRACT-V2.md §0
// and §1, and RESEARCH-CLONE-ARCHITECTURES.md §2's OpenShorts evidence: "a categorical choice
// from a closed set is stable; a continuous measurement is not — 94/92/96% in three runs of
// asking for the decision instead of the number"). Geometry now comes from a pixel scan
// (omniwatchBoardScan) and word times from an aligner (omniwatchCues). What is left for Omni is
// the part a scan cannot do: watching the whole thing, with sound, and saying what happened —
// which element this is, when in the ordering it shows up, what it belongs to.
//
// So every question this file asks has three properties, all borrowed as DESIGN PRINCIPLES from
// OpenShorts' `layout_picker.py` (not its wording — every sentence below is written fresh
// against our own field names from IR-CONTRACT-V2.md):
//
//   A CLOSED SET. The model picks a name off a fixed list, or an id off a list of ids it (or we)
//   already produced. It never writes a number.
//
//   A STRONG DEFAULT, said as an instruction ("if you are unsure, answer X"), not left to be
//   inferred from "most videos do Y". OpenShorts' own account of why this worked: naming the
//   overwhelmingly common answer up front turns "I'm not sure" into "then it's the default"
//   instead of into a guess.
//
//   NAMED DISTRACTORS. The things every short-form export carries that are not the format —
//   the platform's own chrome, a watermark, a follower counter, burned-in platform captions —
//   are called out so they are never reported as elements of what this video is teaching us to
//   build.
//
// Four questions map onto IR-CONTRACT-V2.md §2–§5, and nothing else is asked:
//
//   ARRIVAL / DEPARTURE  → item.arrival.shape / item.departure.shape (§2). Only `shape` is
//   Omni's to answer; `seconds`, `amount` and `ease` are the code's, per the contract's §1
//   instrument table, and this prompt never asks for them.
//
//   HOLD / WAITS-AT       → item.hold / item.waitsAt (§3). Whether an element is the format's
//   furniture or arrives partway through, and if the latter, where it sits before it lands.
//
//   SUBJECT               → also §3: which of the things the video discusses, in turn, an
//   on-cue element goes with. The subjects are not a set we hand in — the video defines its own
//   as it goes, so Omni names them first (a closed set of the model's own making, same as it
//   names its own elements) and then every element question answers into THAT list, never a
//   free sentence.
//
//   LAYER ORDER           → item.layer (§5). An order, not a number: which of the elements that
//   share a region is drawn on top of which other one.
//
// The JSON this asks for:
//
//   {
//     "elements": [
//       {
//         "id": string,                          // a known region id, or one Omni invents
//         "arrival": MoveShape,
//         "departure": MoveShape,
//         "hold": HoldKind,
//         "waitsAt": string,                      // a region id, or "none"
//         "subject": string                       // a subject id (see below), or "none"
//       }
//     ],
//     "subjects": [ { "id": string, "name": string } ],
//     "layerOrder": string[]                      // element ids that overlap something else,
//                                                  // back (drawn first) to front (drawn last)
//   }
//
// Licence note: every sentence in buildCapturePrompt() below was written from scratch for this
// file. The design principles above (strong default, named distractors, closed set) are read
// off OpenShorts (MIT) as ideas; no string of theirs, or of Hypit's or video-use's, is reused.

/** How an element first appears, or how it leaves. A closed set because "how much did it move"
 *  is exactly the question Omni gets wrong — this only asks WHICH of five shapes it was. */
export const MOVE_SHAPES = ["cut", "fade", "pop", "drift", "swell"] as const;
export type MoveShape = (typeof MOVE_SHAPES)[number];

/** Whether an element is on screen for the whole film, or shows up partway through. */
export const HOLD_KINDS = ["from-start", "on-cue"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

/** The overwhelmingly common answer for each closed-set question, said to the model as an
 *  instruction rather than left for it to infer. Most elements in most short-form video are cut
 *  in, sit still, and were there from the first frame — a format that behaves otherwise is the
 *  exception, and the exception is exactly what a careful watch should still find. */
export const DEFAULT_MOVE_SHAPE: MoveShape = "cut";
export const DEFAULT_HOLD_KIND: HoldKind = "from-start";
export const DEFAULT_WAITS_AT = "none";
export const DEFAULT_SUBJECT = "none";

/** Things every short-form export carries that are not part of the format being watched.
 *  Named explicitly, the way OpenShorts names a corner logo and a subscriber count, so the
 *  model does not report the platform's own furniture as if the video had authored it. */
export const DISTRACTORS = [
  "the platform's own interface chrome — like/comment/share icons, a seek bar, a mute button",
  "a watermark or logo stamped on by the recording or export tool",
  "a follower or subscriber counter laid over the video by the platform",
  "captions burned in by the platform itself, as opposed to an on-screen caption the format authored",
] as const;

export const CAPTURE_PROMPT_VERSION = "omniwatch.capture-prompt/1";

/** A region Omni already has an id for — typically from a locate pass that ran before this
 *  prompt is sent. Passing these in lets WAITS-AT and LAYER ORDER answer with ids a later
 *  package can actually look up, instead of prose a validator would have to parse. Optional:
 *  the prompt still reads correctly with none, and simply tells Omni to invent its own ids. */
export interface CaptureRegion {
  id: string;
  /** A few words a human would use for the region, e.g. "the title banner". Optional. */
  label?: string;
}

/** One thing Omni named while watching, with its four categorical answers. This is what a
 *  parsed reply is expected to contain per element — exported so a later validator package can
 *  type-check a parsed reply against the same shape the prompt asked for. */
export interface CaptureElement {
  id: string;
  arrival: MoveShape;
  departure: MoveShape;
  hold: HoldKind;
  /** A region id, or "none". */
  waitsAt: string;
  /** A subject id, or "none". */
  subject: string;
}

/** One thing the video's narration discusses, in the order it comes up. Named by Omni, not
 *  handed in — the video defines its own subjects, and this is the closed set every element's
 *  "subject" answer must point into. */
export interface CaptureSubject {
  id: string;
  name: string;
}

/** The full parsed shape this prompt asks for. Exported for a later validator package; nothing
 *  in this file parses a reply, it only asks the question. */
export interface CaptureAnswer {
  elements: CaptureElement[];
  subjects: CaptureSubject[];
  /** Element ids that share a region with another element, back (drawn first) to front. */
  layerOrder: string[];
}

/** The prompt, built fresh each time so a later package can hand in the regions a locate pass
 *  already found. With none given, Omni is told to invent its own short ids — the questions
 *  read exactly the same either way, only the region list at the top changes.
 *
 *  Every sentence below is written for this file; see the header comment for the licence note
 *  and for why each question is shaped the way it is. */
export function buildCapturePrompt(regions: CaptureRegion[] = []): string {
  const regionList = regions.length
    ? regions.map((r) => `"${r.id}"${r.label ? ` — ${r.label}` : ""}`).join(", ")
    : '(none known yet — invent a short id for each element yourself, e.g. "title-banner")';

  const shapeList = MOVE_SHAPES.join(" | ");
  const holdList = HOLD_KINDS.join(" | ");

  return `You are watching ONE short-form video, start to finish, with its picture and its sound together.

Answer only the questions below, and only with a NAME from a fixed list or a short id — never a
measurement. Measurements — how big something is, what shade it is, or exactly when it happens —
are worked out afterwards by a different, more exact tool, from the file itself. Your job is
meaning and structure only: what a thing IS, when in the order of things it happens, what it
belongs to.

Known regions of the frame (fixed ids — reuse one of these for an element that IS that region,
rather than inventing a new id for it): ${regionList}

Do NOT report any of the following as an element of the format. They are added by the recording
or the platform, not authored by this video:
${DISTRACTORS.map((d) => `- ${d}`).join("\n")}

First, name every element the format actually puts on screen — a caption, a title plate, a row
of a board, a photo card, a small inset portrait, and so on. Skip the distractors above. For
EACH element you name, answer four questions.

1) ARRIVAL — how does this element first appear?
   Answer with exactly one of: ${shapeList}.
   - "cut": it is simply there, nothing leads into it.
   - "fade": it grows visible in place, without moving or changing shape.
   - "pop": it snaps into place and overshoots a little before settling.
   - "drift": it comes in from off its final spot and settles into it.
   - "swell": it grows smoothly into its final place, with no overshoot.
   Most elements in most short-form video are simply cut in. If you are unsure, answer
   "${DEFAULT_MOVE_SHAPE}".

2) DEPARTURE — how does this element leave, at the end of ITS OWN time on screen (not necessarily
   the end of the video)? Answer with exactly one of: ${shapeList} — same meanings as ARRIVAL,
   read backwards (a "drift" departure slides away rather than in). Most elements are simply cut
   out. If you are unsure, answer "${DEFAULT_MOVE_SHAPE}".

3) HOLD — is this element on screen for the whole video, or does it show up partway through?
   Answer with exactly one of: ${holdList}.
   - "from-start": on screen from the first frame — part of the format's furniture (a board, a
     background, a frame around the presenter).
   - "on-cue": it was not there yet, and then it was — something the video brings in at a
     particular moment.
   Only answer "on-cue" when you can point to the moment it was not there yet and then was.
   If you are unsure, answer "${DEFAULT_HOLD_KIND}".

4) WAITS-AT — only for an element you called "on-cue": before it settles into the spot it ends up
   in, does it sit and wait somewhere else first (for example, a photo that appears beside the
   presenter before moving into a row of a board)? Answer with the id of the region it waits in,
   taken from the known-regions list above, or "${DEFAULT_WAITS_AT}". Most on-cue elements go
   straight to their final spot. If you are unsure, answer "${DEFAULT_WAITS_AT}".

Then, SUBJECTS: name the distinct things this video's narration talks about, one after another,
as it moves from one to the next (a ranking or countdown video usually has one subject per rank;
a single-topic explainer may have only one subject for the whole video). Give each a short id —
"subject-1", "subject-2", and so on — and a few words naming it.

Then go back over the elements you named and, for each one that goes with one particular subject
rather than sitting on screen the whole video, answer:

5) SUBJECT — which subject id (from the list you just made) does this element go with? Answer
   with a subject id, or "${DEFAULT_SUBJECT}". Most elements — the board itself, the background,
   the caption band — are not tied to any one subject; only a card, label or photo that changes
   with what is being said right then gets a subject id. If you are unsure, answer
   "${DEFAULT_SUBJECT}".

Finally, LAYER ORDER: wherever two of the elements you named occupy the same region at the same
time, one is drawn over the other. List every element that overlaps another element, in order
from the one drawn first (underneath) to the one drawn last (on top). Leave out any element that
never overlaps another one. If you cannot tell which of two is on top, keep them in the order you
first named them.

Answer with ONE JSON object, no other text, exactly this shape:

{
  "elements": [
    {
      "id": "a region id from the list above, or a short id you invent",
      "arrival": "${shapeList}",
      "departure": "${shapeList}",
      "hold": "${holdList}",
      "waitsAt": "a region id, or \\"${DEFAULT_WAITS_AT}\\"",
      "subject": "a subject id from the list below, or \\"${DEFAULT_SUBJECT}\\""
    }
  ],
  "subjects": [ { "id": "subject-1", "name": "a few words naming it" } ],
  "layerOrder": ["element ids that overlap another element, first-drawn to last-drawn"]
}

Report what you actually saw and heard happen in THIS video, not what this kind of video usually
looks like.`;
}
