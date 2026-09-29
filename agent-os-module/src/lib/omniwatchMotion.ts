// The vocabulary of arriving and leaving.
//
// Today an element is either on screen or it is not — the composer draws it at its own
// `start` and erases it at its own `end`, and nothing happens at either edge. That is
// `cut`, and it is a legitimate choice (a caption that should not draw the eye), but it is
// the ONLY choice, which is why a card that the source shows sliding in with a bounce
// renders standing still.
//
// This file is what makes the other four shapes possible, and it is deliberately split
// into two jobs that must never blend into one function:
//
//   normalizeMove   — a model said `{shape:"pop"}` or `{shape:"BOUNCE!!"}` or `null` or
//                      nothing at all. This turns that into a `Move` that is always valid,
//                      by construction, never by hoping the caller checked first.
//   arrivalTween /
//   departureTween  — a `Move` plus an element's own timing becomes a plain description of
//                      a GSAP tween. Not a call into GSAP — GSAP is not imported here, and
//                      never will be — a DATA STRUCTURE the renderer reads and calls GSAP
//                      with, so this file stays testable without a DOM and stays honest
//                      about the fact that it makes no pixels.
//
// The reason these are separate functions is IR-CONTRACT-V2 §1's division of instruments:
// Omni chooses the shape (a category, from a closed set — the one thing a model is
// reliably good at), and CODE decides every number, because a model asked for a continuous
// quantity drifts by an order of magnitude between two runs of the same question. `seconds`
// and `amount` are dictated here, not requested from anyone.
//
// Every number a model could have supplied is clamped in this file. Nothing here throws —
// a blueprint that fails to validate should degrade to `cut`, the same as an element that
// never had a `Move` at all, not take the render down with it.
//
// Deliberately no import from `omniwatchBlueprint` or anywhere else in this tree: this file
// owns its own small vocabulary (`ElementTiming`, `ElementBox`) rather than reaching for
// `BlueprintItem` / `Rect`, because both of those describe FRACTIONS of a canvas and this
// file needs PIXELS (`ElementBox`, below, says why) — importing the fractional type would
// invite silently mixing the two units.

// ---------------------------------------------------------------------------------------
// The shape vocabulary (IR-CONTRACT-V2 §2)
// ---------------------------------------------------------------------------------------

/** A closed set, because this is the one thing Omni is asked to name — never a number. */
export const MOVE_SHAPES = ["cut", "fade", "pop", "drift", "swell"] as const;
export type MoveShape = (typeof MOVE_SHAPES)[number];

/** Also closed, and note what is missing: there is no "linear" and no "none". A model
 *  cannot ask for one because the type does not offer it, and this file has no branch that
 *  could produce one either — see `GSAP_EASE` below, which is total over this set. */
export const MOVE_EASES = ["soft-out", "soft-in-out", "overshoot"] as const;
export type MoveEase = (typeof MOVE_EASES)[number];

export interface Move {
  /** From the closed set. Omni's field — it never carries a number. */
  shape: MoveShape;
  /** Seconds. Dictated by code: 0.08–0.6, clamped in `normalizeMove`, then clamped again
   *  in `arrivalTween` / `departureTween` against the element's own lifetime. */
  seconds: number;
  /** Never linear — see `MOVE_EASES`. */
  ease: MoveEase;
  /** 0..0.35: distance for `drift`, scale for `pop` / `swell`. Dictated by code. */
  amount: number;
}

/** `seconds` never leaves this window. Below 0.08s a move is a flicker, not a motion;
 *  above 0.6s it reads as the element being slow to load rather than arriving on purpose. */
export const MOVE_SECONDS_MIN = 0.08;
export const MOVE_SECONDS_MAX = 0.6;

/** `amount` never leaves this window. Above ~0.35 a `pop` scales from under half size and
 *  a `drift` crosses most of its own box — both read as broken layout, not as craft. */
export const MOVE_AMOUNT_MIN = 0;
export const MOVE_AMOUNT_MAX = 0.35;

/** Today's behaviour, written down as the value it always was: no motion, no delay. This is
 *  what an absent `Move` becomes, and what an unrecognised `shape` becomes — the contract's
 *  "when in doubt, do nothing" default, which is the one wrong answer that never looks
 *  broken on screen. */
export const CUT_MOVE: Readonly<Move> = Object.freeze({ shape: "cut", seconds: 0, ease: "soft-out", amount: 0 });

// Per-shape defaults. Named individually, not buried in a literal, because each one is a
// craft decision someone should be able to point at and change without reading the rest of
// the file. Fade and drift favour `soft-out` — a calm settle, the safe default for
// something entering a busy frame. Pop favours `overshoot` — the little bounce is the
// entire point of the shape. Swell favours `soft-in-out` — the contract's "without the
// overshoot" is a request for a curve that eases both ends, not just the exit.
const FADE_SECONDS = 0.25;
const FADE_AMOUNT = 0; // fade has no distance and no scale — opacity is the whole effect
const POP_SECONDS = 0.35;
const POP_AMOUNT = 0.18;
const DRIFT_SECONDS = 0.3;
const DRIFT_AMOUNT = 0.12;
const SWELL_SECONDS = 0.4;
const SWELL_AMOUNT = 0.1;

const SHAPE_DEFAULTS: Readonly<Record<MoveShape, Move>> = Object.freeze({
  cut: CUT_MOVE,
  fade: Object.freeze({ shape: "fade", seconds: FADE_SECONDS, ease: "soft-out", amount: FADE_AMOUNT }),
  pop: Object.freeze({ shape: "pop", seconds: POP_SECONDS, ease: "overshoot", amount: POP_AMOUNT }),
  drift: Object.freeze({ shape: "drift", seconds: DRIFT_SECONDS, ease: "soft-out", amount: DRIFT_AMOUNT }),
  swell: Object.freeze({ shape: "swell", seconds: SWELL_SECONDS, ease: "soft-in-out", amount: SWELL_AMOUNT }),
});

/** How much of an easing curve's overshoot GSAP's `back.out` gets, when `ease` is
 *  `"overshoot"`. 1.7 is a gentle bounce — enough to read as intentional on a card, not
 *  enough to look like the element missed its mark. Our own choice, not anyone else's. */
const OVERSHOOT_STRENGTH = 1.7;

/** The only place a `MoveEase` becomes a string GSAP understands. Total over `MOVE_EASES`,
 *  so there is no code path anywhere in this file that can hand the renderer `"linear"` or
 *  `"none"` — Hard Rule 3 of IR-CONTRACT-V2 §6 enforced by there being no fourth branch. */
export const GSAP_EASE: Readonly<Record<MoveEase, string>> = Object.freeze({
  "soft-out": "power2.out",
  "soft-in-out": "power2.inOut",
  overshoot: `back.out(${OVERSHOOT_STRENGTH})`,
});

// ---------------------------------------------------------------------------------------
// Job 1 — clamp whatever a model produced into a valid Move
// ---------------------------------------------------------------------------------------

function isMoveShape(v: unknown): v is MoveShape {
  return typeof v === "string" && (MOVE_SHAPES as readonly string[]).includes(v);
}
function isMoveEase(v: unknown): v is MoveEase {
  return typeof v === "string" && (MOVE_EASES as readonly string[]).includes(v);
}
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Turn whatever a model produced for one `arrival` or `departure` into a `Move` that is
 *  always safe to render. Never throws, whatever `raw` is.
 *
 *  `raw` not being an object at all — `null`, a string, a number, an array, `undefined` —
 *  means there is nothing here to read a shape out of, and that is treated exactly the same
 *  as a `shape` the closed set does not contain: both return `fallback` (which defaults to
 *  `CUT_MOVE`, the contract's own answer for "absent"). A caller that wants a different
 *  absent-state default for a particular kind of element may pass one; the file does not
 *  need to know why.
 *
 *  Once a real `shape` is in hand, `cut` is a sentinel — no distance, no time, nothing to
 *  clamp — and every other shape gets `seconds` / `amount` / `ease` filled from that
 *  shape's own defaults where the model left them out, then pressed into the ranges above
 *  where the model supplied something out of bounds. A model asking for 50x the normal
 *  distance is not a request to honour, it is the exact failure mode this function exists
 *  to catch. */
export function normalizeMove(raw: unknown, fallback: Move = CUT_MOVE): Move {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...fallback };
  const r = raw as Record<string, unknown>;
  if (!isMoveShape(r.shape)) return { ...fallback };
  const shape = r.shape;
  if (shape === "cut") return { ...CUT_MOVE };

  const base = SHAPE_DEFAULTS[shape];
  return {
    shape,
    seconds: clamp(finiteOr(r.seconds, base.seconds), MOVE_SECONDS_MIN, MOVE_SECONDS_MAX),
    amount: clamp(finiteOr(r.amount, base.amount), MOVE_AMOUNT_MIN, MOVE_AMOUNT_MAX),
    ease: isMoveEase(r.ease) ? r.ease : base.ease,
  };
}

// ---------------------------------------------------------------------------------------
// Job 2 — a Move, plus an element's own timing, becomes a tween the renderer can run
// ---------------------------------------------------------------------------------------

/** Only these ten may appear in a tween's `vars`. HyperFrames' GSAP timeline supports
 *  exactly this set (IR-CONTRACT-V2 §2, "Renderowanie") — anything else is a property the
 *  renderer has never been asked to animate, and a tween carrying one would be silently
 *  ignored at best or throw inside the renderer at worst. Total over this file's own
 *  output: every `vars` object built below draws only from here. */
export const MOTION_VARS = [
  "opacity", "x", "y", "scale", "scaleX", "scaleY", "rotation", "width", "height", "visibility",
] as const;
export type MotionVar = (typeof MOTION_VARS)[number];

/** A plain number for `"from"` / `"set"` (the value to start at, or to set outright); a
 *  `[from, to]` pair for `"fromTo"`, because a departure is an explicit exit and there is
 *  no `"to"` method here to animate away from an implicit current value — see the note on
 *  `TweenMethod` below. */
export type MotionVarValue = number | [number, number];
export type TweenVars = Partial<Record<MotionVar, MotionVarValue>>;

/** Deliberately not `"to"`. An arrival always has a natural resting state — the position
 *  and size the composer already draws the element at — so `"from"` (animate FROM the
 *  Move's offset state TO that already-correct resting state) is both sufficient and
 *  cannot drift out of sync with the layout. A departure has no such implicit target: the
 *  offset state it is leaving TOWARD is not drawn anywhere else, so it must be spelled out
 *  as both ends of a `"fromTo"`. `"set"` is `cut`'s method: nothing to animate, a single
 *  instantaneous (and for `cut`, empty) assignment. */
export type TweenMethod = "from" | "fromTo" | "set";

export interface TweenSpec {
  method: TweenMethod;
  vars: TweenVars;
  /** Seconds on the element's own absolute clock — the same clock `start` / `end` live on
   *  — at which the tween begins. */
  at: number;
  /** Seconds. Already clamped against `MOVE_SECONDS_MIN`/`MAX` (in `normalizeMove`) AND
   *  against half the element's lifetime (here) — whichever is smaller wins. */
  duration: number;
  /** A GSAP ease name or call, e.g. `"power2.out"` or `"back.out(1.7)"`. Never `"linear"`,
   *  never `"none"` — see `GSAP_EASE`. */
  ease: string;
}

export interface ElementTiming {
  /** Seconds, absolute — the same field as `BlueprintItem.start`. */
  start: number;
  /** Seconds, absolute — the same field as `BlueprintItem.end`. */
  end: number;
}

/** The element's own rendered box, in PIXELS, at whatever size the renderer is drawing it —
 *  never a fraction of the canvas like `Rect`. `drift`'s `amount` is a fraction of this
 *  box (IR-CONTRACT-V2 §2: "wyrażony w pikselach przez wywołującego"), and the caller is
 *  the only party that knows what those pixels are — this file does not have a canvas size
 *  or a `Rect` to convert from, and guessing one would be exactly the kind of number this
 *  file exists to refuse to invent. */
export interface ElementBox {
  width: number;
  height: number;
}

/** Half of an element's lifetime, defensively: a negative or non-finite span (an item whose
 *  `end` precedes its `start`, or NaN timing from somewhere upstream) becomes zero rather
 *  than a negative cap, which would otherwise flip every `Math.min` below into handing back
 *  a full-length move instead of none at all. */
function halfLifetime(timing: ElementTiming): number {
  const start = finiteOr(timing?.start, 0);
  const end = finiteOr(timing?.end, 0);
  return Math.max(0, end - start) / 2;
}

/** Hard limit from IR-CONTRACT-V2 §6.6: a move never exceeds half the element's lifetime.
 *  Not a suggestion for the model to honour — `seconds` never reaches this function un-
 *  clamped, because `normalizeMove` has no lifetime to check against; this is the second,
 *  and final, clamp. */
function clampToLifetime(seconds: number, timing: ElementTiming): number {
  return Math.max(0, Math.min(seconds, halfLifetime(timing)));
}

/** `drift` moves along x by `amount` of the box's own width — "wjeżdża z boku", enters
 *  from the side, per the contract's description of the shape. A box with no usable width
 *  (missing, zero, negative, NaN) drifts by zero pixels rather than by `NaN` pixels: the
 *  element still arrives, just without the slide, which is the graceful-degradation half
 *  of "never guess a size", not a bug to fix by inventing one. */
const DRIFT_FROM_LEFT = -1;
function driftPixels(amount: number, box: ElementBox): number {
  const width = typeof box?.width === "number" && Number.isFinite(box.width) && box.width > 0 ? box.width : 0;
  // `-1 * 0 * 0` is `-0` in IEEE 754, and `-0` is a perfectly valid pixel offset that no
  // caller should have to special-case. Normalized away here rather than left for GSAP (or
  // a test's strict equality) to trip over.
  return (DRIFT_FROM_LEFT * amount * width) || 0;
}

/** `pop` and `swell` both scale from smaller-than-final; only their easing (chosen by
 *  `normalizeMove`'s per-shape default, or by whatever the model asked for) tells them
 *  apart, which is exactly the contract's own distinction ("z przeskoczeniem" vs "bez
 *  przeskoczenia" — the difference is the curve, not the geometry). Floored well above
 *  zero so a `Move` built by hand outside `normalizeMove` cannot produce a vanishing or
 *  inverted scale. */
function shrunkScale(amount: number): number {
  return clamp(1 - amount, 0.5, 1);
}

function enterSpec(move: Move, box: ElementBox): { method: TweenMethod; vars: TweenVars } {
  switch (move.shape) {
    case "cut": return { method: "set", vars: {} };
    case "fade": return { method: "from", vars: { opacity: 0 } };
    case "pop": return { method: "from", vars: { opacity: 0, scale: shrunkScale(move.amount) } };
    case "swell": return { method: "from", vars: { opacity: 0, scale: shrunkScale(move.amount) } };
    case "drift": return { method: "from", vars: { opacity: 0, x: driftPixels(move.amount, box) } };
    /* istanbul ignore next -- MOVE_SHAPES is exhaustive; kept for a future shape that
       forgets to update this switch, so it degrades to `cut` instead of returning undefined. */
    default: return { method: "set", vars: {} };
  }
}

function exitSpec(move: Move, box: ElementBox): { method: TweenMethod; vars: TweenVars } {
  switch (move.shape) {
    case "cut": return { method: "set", vars: {} };
    case "fade": return { method: "fromTo", vars: { opacity: [1, 0] } };
    case "pop": return { method: "fromTo", vars: { opacity: [1, 0], scale: [1, shrunkScale(move.amount)] } };
    case "swell": return { method: "fromTo", vars: { opacity: [1, 0], scale: [1, shrunkScale(move.amount)] } };
    case "drift": {
      // Leaves toward the side it did not arrive from — the same read as a card sliding
      // off-stage rather than retreating the way it came.
      const px = driftPixels(move.amount, box);
      return { method: "fromTo", vars: { opacity: [1, 0], x: [0, (-px) || 0] } };
    }
    /* istanbul ignore next */
    default: return { method: "set", vars: {} };
  }
}

/** The entrance half of a `Move`: runs from the element's own `start`, for a duration
 *  clamped to at most half its lifetime. Pass an already-normalized `Move` — this function
 *  does not call `normalizeMove` itself, so a caller that already has a valid `Move` (from
 *  a blueprint that was built, not one straight off a model) is not paying to re-validate
 *  it every frame. */
export function arrivalTween(move: Move, timing: ElementTiming, box: ElementBox): TweenSpec {
  const duration = clampToLifetime(move.seconds, timing);
  const { method, vars } = enterSpec(move, box);
  return { method, vars, at: finiteOr(timing?.start, 0), duration, ease: GSAP_EASE[move.ease] };
}

/** The exit half of a `Move`: ends exactly at the element's own `end`, so a departure never
 *  visibly outlives the item it belongs to. */
export function departureTween(move: Move, timing: ElementTiming, box: ElementBox): TweenSpec {
  const duration = clampToLifetime(move.seconds, timing);
  const { method, vars } = exitSpec(move, box);
  const end = finiteOr(timing?.end, 0);
  const start = finiteOr(timing?.start, 0);
  // Never starts before the element itself does, however timing is clamped above.
  const at = Math.max(start, end - duration);
  return { method, vars, at, duration, ease: GSAP_EASE[move.ease] };
}

/** One element, one arrival, one departure — by construction, not by convention.
 *
 *  IR-CONTRACT-V2 §2's "at most one arrival and one departure per element" is not a rule
 *  this function checks; it is a rule this function's SIGNATURE makes impossible to break.
 *  `arrival` and `departure` are single fields, not lists — there is no way to hand this
 *  function three arrivals, so there is no code path that could emit three.
 *
 *  This is the one function in the file that takes raw, unvalidated model output directly
 *  (it normalizes `item.arrival` / `item.departure` itself); `arrivalTween` /
 *  `departureTween` stay available separately for a caller that has already normalized. */
export interface MotionItem {
  /** Whatever the model wrote for this element's entrance. Anything at all. */
  arrival?: unknown;
  /** Whatever the model wrote for this element's exit. Anything at all. */
  departure?: unknown;
  start: number;
  end: number;
}

export function elementTweens(item: MotionItem, box: ElementBox): { arrival: TweenSpec; departure: TweenSpec } {
  const timing: ElementTiming = { start: finiteOr(item?.start, 0), end: finiteOr(item?.end, 0) };
  return {
    arrival: arrivalTween(normalizeMove(item?.arrival), timing, box),
    departure: departureTween(normalizeMove(item?.departure), timing, box),
  };
}
