// Where an icon waits before it lands.
//
// A cloned tier board draws every tile lying in its row from the first frame, so the board
// is a static wallpaper: nothing on screen says which subject a sentence is about. The
// reference does the opposite — the icon of the subject being talked about sits beside the
// presenter first, and only lands in its row when the verdict is said. IR-CONTRACT-V2 §3
// gives the blueprint two new fields for this, `hold` and `waitsAt` (see omniwatchBlueprint),
// and this file answers the geometry question that follows from them: where does the icon
// wait, where does it end up, and when does it move?
//
// The house rule from omniwatchBoardScan applies here too, even though there are no pixels
// to scan: never ask a model for a continuous quantity when something MEASURED can answer
// instead. The waiting box is not invented — it comes from a region the blueprint already
// carries a measured rect for, either the region named by `waitsAt` itself or, failing that,
// a box read off the presenter's own measured stage. A named constant is used only for the
// one thing nothing in the blueprint can measure — how big a bare corner of the presenter's
// stage the icon should claim — and every use of it is written to `notes`, the same way
// omniwatchCues and omniwatchBoardScan report a fallback instead of hiding it.
//
// Nothing here decides HOW the icon moves — no easing, no duration, no tween. That is
// `Move` (IR-CONTRACT-V2 §2), owned by a sibling package. This file stops at the two boxes
// and the moment between them.

import type { Blueprint, BlueprintItem, BlueprintRegion, BlueprintTrack, Rect } from "@/lib/omniwatchBlueprint";

/** How big a corner of the presenter's own stage the waiting icon claims, as a fraction of
 *  the presenter region's shorter side, used only when the item's final box cannot size it
 *  (no track region found, no item rect). Chosen so the icon reads as "something beside the
 *  head", not "the size of the stage itself" — small enough to leave the presenter visible. */
export const FALLBACK_ICON_FRACTION = 0.32;

/** The largest the waiting icon may be, as a fraction of the presenter region's shorter
 *  side, even when the item's own final box is bigger — an icon waiting beside a head does
 *  not get to be half the stage just because its landed tile is large. */
export const MAX_ICON_FRACTION = 0.5;

/** The smallest the waiting icon may be, same units — below this it would not read as an
 *  icon at all. */
export const MIN_ICON_FRACTION = 0.1;

/** How far the waiting box sits in from the presenter region's own edges, as a fraction of
 *  the presenter's width/height — enough that the icon does not touch the frame edge or the
 *  presenter's own outline. */
export const STAGE_INSET_FRACTION = 0.06;

/** Where the two boxes came from, kept on the result so a caller (and a test) can tell a
 *  measured answer from a derived one without re-deriving it. */
export type StageSource = "waits-at-region" | "presenter-corner";

export interface Stage {
  /** Where the item sits before it lands — canvas-fraction rect, same shape as a region's. */
  waiting: Rect;
  /** Where the item ends up — canvas-fraction rect, inside its own row. Either the item's
   *  own `rect` (when it has one — an insert-shaped item does) or the rect of the region its
   *  track paints into (a tier row's cell, most of the time). */
  final: Rect;
  /** The second, on the video's own clock, the item leaves `waiting` for `final`.
   *
   *  `item.landsAt` when the blueprint carries one — the aligner's answer (IR-CONTRACT-V2
   *  §3) to "when is the verdict said", clamped into `[start, end]` defensively even though
   *  `validateBlueprint` already refuses a value outside that range, because this function
   *  also has to survive a hand-built blueprint that skipped validation. `item.start`
   *  otherwise, which is today's behaviour: the item moves the instant it appears. Either
   *  way, a measured number, never invented here. */
  moves: number;
  /** How `waiting` was obtained. */
  source: StageSource;
}

export type StageOutcome =
  | { ok: true; stage: Stage; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

const round4 = (n: number) => Math.round(n * 10000) / 10000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A rect is well-formed enough to measure from: four finite numbers, a positive size. Kept
 *  local and permissive on purpose — a region that already passed `validateBlueprint` is
 *  fine, and this only guards against a blueprint assembled by hand (as the tests do) or
 *  edited after validation. */
function usableRect(r: unknown): r is Rect {
  return Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number" && Number.isFinite(n)) && r[2] > 0 && r[3] > 0;
}

/** Whichever region the blueprint calls its presenter, or null when there isn't one.
 *
 *  `role: "figure"` is the honest answer — that is what the role exists to say, a subject in
 *  shot. A handful of older captures name the region "host" or "presenter" instead of
 *  setting the role, so those ids are read too, the same tolerance omniwatchBlueprint's own
 *  normalisation already gives them. First match wins; a blueprint with two figures is not
 *  this function's problem to solve. */
export function findPresenter(blueprint: Blueprint): BlueprintRegion | null {
  const byRole = blueprint.regions.find((r) => r.role === "figure" && usableRect(r.rect));
  if (byRole) return byRole;
  const byName = blueprint.regions.find((r) => /^(host|presenter)(-(stage|figure|video))?$/i.test(r.id) && usableRect(r.rect));
  return byName ?? null;
}

/** Whether an item actually asks to be staged — defensively, because a blueprint built by
 *  hand (every test in this repo builds its own) carries none of the type-checking that
 *  `validateBlueprint` already did on a real capture. Junk in either field — the wrong type,
 *  an empty string, a value that is not exactly "on-cue" — reads as "no", which is exactly
 *  today's behaviour: an item this function will not touch. */
export function needsStaging(item: BlueprintItem): boolean {
  return item.hold === "on-cue" && typeof item.waitsAt === "string" && item.waitsAt.trim().length > 0;
}

/** The second `stageItem` moves an item from `waiting` to `final` — see `Stage.moves`. Its
 *  own function because both return sites in `stageItem` need it, and because the clamp is
 *  worth naming: a `landsAt` outside `[start, end]` should never reach here on a real
 *  capture (the validator refuses it), but a test or a hand-built blueprint can, and
 *  arithmetic that silently produced a drop before an item appears or after it is gone would
 *  be a worse failure than clamping it back into the window it is supposed to describe. */
function landingMoment(item: BlueprintItem): number {
  if (typeof item.landsAt === "number" && Number.isFinite(item.landsAt)) {
    return clamp(item.landsAt, item.start, item.end);
  }
  return item.start;
}

/** The box an item ends up in: its own `rect` when it has one, otherwise the rect of the
 *  region its track paints into. Null when neither can be found — a track whose region was
 *  never declared, which `validateBlueprint` would already have refused on a real capture. */
function finalBoxOf(blueprint: Blueprint, track: BlueprintTrack, item: BlueprintItem): Rect | null {
  if (usableRect(item.rect)) return item.rect;
  const region = blueprint.regions.find((r) => r.id === track.region);
  return region && usableRect(region.rect) ? region.rect : null;
}

/** A square box anchored in a corner of the presenter's stage, sized to match the item's own
 *  final box when that is a sane size, and clamped between `MIN_ICON_FRACTION` and
 *  `MAX_ICON_FRACTION` of the presenter's shorter side either way. Anchored top-right: the
 *  reference places the waiting icon high, beside the head rather than at chest height, and
 *  a fixed side keeps this function deterministic rather than guessing which side a given
 *  episode prefers — a later package with the actual frame is free to move it. */
function presenterCorner(presenter: BlueprintRegion, finalBox: Rect | null, notes: string[]): Rect {
  const [px, py, pw, ph] = presenter.rect;
  const short = Math.min(pw, ph);

  let side: number;
  if (finalBox) {
    side = clamp(Math.min(finalBox[2], finalBox[3]), short * MIN_ICON_FRACTION, short * MAX_ICON_FRACTION);
    notes.push(`stage: waiting icon sized from its own final box (${round4(side)} of the presenter's shorter side)`);
  } else {
    side = short * FALLBACK_ICON_FRACTION;
    notes.push(`stage: no final box to size the waiting icon from — fell back to ${FALLBACK_ICON_FRACTION} of the presenter's shorter side`);
  }

  const insetX = pw * STAGE_INSET_FRACTION;
  const insetY = ph * STAGE_INSET_FRACTION;
  const x = clamp(px + pw - insetX - side, px, px + pw - side);
  const y = py + insetY;
  return [round4(x), round4(y), round4(side), round4(side)];
}

/** The two boxes a staged item occupies, and the moment it moves between them.
 *
 *  Never throws: a blueprint assembled by hand, missing the region `waitsAt` names, or
 *  missing a presenter altogether, is a reason to say why staging did not happen — not a
 *  crash. Every one of those keeps the item exactly as it would render today (wherever its
 *  track already puts it) and pushes a note explaining the gap. */
export function stageItem(blueprint: Blueprint, track: BlueprintTrack, item: BlueprintItem): StageOutcome {
  const notes: string[] = [];
  try {
    if (!needsStaging(item)) {
      return { ok: false, reason: `hold is "${item.hold ?? "from-start"}", not "on-cue" — nothing to stage`, notes };
    }
    const waitsAt = (item.waitsAt as string).trim();

    const finalBox = finalBoxOf(blueprint, track, item);
    if (!finalBox) {
      notes.push(`stage: track region "${track.region}" was not found — item keeps today's behaviour`);
      return { ok: false, reason: `region "${track.region}" has no measured rect to land in`, notes };
    }

    // First choice: the region `waitsAt` names is itself measured, so its rect IS the
    // waiting box — no derivation needed, exactly the way a `rect` on the item itself would
    // be used as-is rather than recomputed.
    const named = blueprint.regions.find((r) => r.id === waitsAt);
    if (named && usableRect(named.rect)) {
      notes.push(`stage: waiting box for "${track.region}" is region "${waitsAt}" — measured, not derived`);
      return {
        ok: true,
        notes,
        stage: { waiting: named.rect, final: finalBox, moves: landingMoment(item), source: "waits-at-region" },
      };
    }

    // Second choice: `waitsAt` named something that is not (or is no longer) a declared
    // region — common, since the contract lets it name a spot nothing else measures.
    // Fall back to a box read off the presenter's own measured stage.
    const presenter = findPresenter(blueprint);
    if (!presenter) {
      notes.push(
        `stage: waitsAt "${waitsAt}" is not a declared region and this blueprint has no presenter ` +
        `("figure" role, or a region named host/presenter) to derive a waiting box from`,
      );
      return { ok: false, reason: "no region to measure a waiting box from", notes };
    }
    if (!named) {
      notes.push(`stage: waitsAt "${waitsAt}" is not a declared region — derived a waiting box from the presenter's stage instead`);
    } else {
      notes.push(`stage: waitsAt "${waitsAt}" has no usable rect — derived a waiting box from the presenter's stage instead`);
    }
    const waiting = presenterCorner(presenter, finalBox, notes);
    return { ok: true, notes, stage: { waiting, final: finalBox, moves: landingMoment(item), source: "presenter-corner" } };
  } catch (err) {
    // Geometry here is plain arithmetic and should never throw, but the rule this whole
    // pipeline is written against is that a blueprint's own shape is never trusted blindly —
    // see omniwatchBlueprint's validator. Catching keeps that rule true of this file too.
    notes.push(`stage: unexpected error, item kept today's behaviour — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "unexpected error while staging", notes };
  }
}

/** Every item across the whole blueprint that asks to be staged, with its outcome. A
 *  convenience for a caller that wants to walk a blueprint once rather than know which
 *  tracks to look in — `stageItem` itself needs nothing this does not already have. */
export function stageBlueprint(blueprint: Blueprint): { region: string; item: BlueprintItem; outcome: StageOutcome }[] {
  const out: { region: string; item: BlueprintItem; outcome: StageOutcome }[] = [];
  for (const track of blueprint.tracks) {
    for (const item of track.items) {
      if (!needsStaging(item)) continue;
      out.push({ region: track.region, item, outcome: stageItem(blueprint, track, item) });
    }
  }
  return out;
}
