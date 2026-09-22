/**
 * Media preparation maths and text helpers (T1).
 *
 * Pure functions only: no file system, no ffmpeg, no network. The registry hands the
 * plan to an injected media tool, which is what makes the split testable with a stub.
 *
 * Split policy is driven by frames, not minutes. The beta README and `.env.example`
 * documented `OMNI_PART_MINUTES=40`, but the released code never read it: the beta
 * split on `OMNI_MAX_FRAMES=2400` (floor 300) against `duration * fps`, where fps is 10
 * for material up to 3 minutes and 2 above it. A cap in minutes cannot even be
 * equivalent, because the short-form material is the *larger* request (1800 frames for
 * a 3-minute short vs 1200 for a 10-minute talk). `maxFramesPerPart` is therefore the
 * only supported knob; `OMNI_PART_MINUTES` is documented as inert in the migration.
 */

import { OmniWatchError } from "../contracts/errors.ts";
import type { MediaInfo, MediaPart } from "../contracts/types.ts";

/** Thumbnails in the timeline strip, same as the beta's `STRIP`. */
export const STRIP_COUNT = 16;

/** Short-form material gets the API's maximum sampling rate. */
export const SHORT_MAX_SECONDS = 3 * 60;
export const FPS_SHORT = 10;
export const FPS_LONG = 2;

export const fpsFor = (seconds: number): number => (seconds <= SHORT_MAX_SECONDS ? FPS_SHORT : FPS_LONG);

/**
 * Python's `round()` breaks ties toward the even number; `Math.round` breaks them
 * upward. The frozen beta strip depends on the Python behaviour (a 16 s video yields
 * 0,2,2,4,4,... rather than 0,1,3,3,...), so it is reimplemented here on purpose.
 */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The beta's filmstrip: `round(seconds * (i + 0.5) / count)` for each slot.
 * Byte-compatible with the released Python so old timelines keep the same frames.
 */
export function strip(durationSeconds: number, count = STRIP_COUNT): number[] {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const slots = Number.isFinite(count) && count > 0 ? Math.floor(count) : STRIP_COUNT;
  const out: number[] = [];
  for (let i = 0; i < slots; i += 1) {
    out.push(roundHalfEven((safeDuration * (i + 0.5)) / slots));
  }
  return out;
}

/** `0:16`, `1:02:03` - the beta's `fmt()`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** `[0:42]` / `[1:02:03]` -> seconds, or null when the text is not a timestamp. */
export function parseTimestamp(label: string): number | null {
  const match = label.match(/^\[?(?:(\d+):)?(\d{1,2}):(\d{2})\]?$/);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function formatTimestamp(seconds: number): string {
  return formatDuration(seconds);
}

/**
 * Part notes are written with clip-relative timestamps; rewrite them as positions in
 * the full video. A timestamp past the end of the part is already absolute (the model
 * sometimes quotes the full video's clock) and is left alone - the beta's rule, kept.
 */
export function shiftTimestamps(text: string, offset: number, length: number): string {
  return text.replace(/\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/g, (_match, h, m, s) => {
    const seconds = Number(h || 0) * 3600 + Number(m) * 60 + Number(s);
    return `[${formatDuration(seconds > length + 5 ? seconds : offset + seconds)}]`;
  });
}

export interface PartPlan {
  index: number;
  startSeconds: number;
  endSeconds: number;
}

export interface SplitPolicy {
  /** Frames one model call may carry; the only knob that drives the split. */
  maxFramesPerPart: number;
  /** Injectable for tests that pin the beta's sampling rate. */
  fpsForSeconds?: (seconds: number) => number;
}

/** How many equal parts `durationSeconds` needs at this frame budget. */
export function partCountFor(durationSeconds: number, policy: SplitPolicy): number {
  const frames = Number(policy.maxFramesPerPart);
  if (!Number.isFinite(frames) || frames < 1) {
    throw new OmniWatchError("invalid_input", "maxFramesPerPart musi byc dodatnia liczba.", {
      action: { label: "sprawdz konfiguracje", kind: "fix_config" },
    });
  }
  const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const fps = (policy.fpsForSeconds ?? fpsFor)(seconds);
  // The epsilon absorbs floating-point noise on an exact boundary (1200 s at 2400
  // frames must stay one part, not round up to two).
  return Math.max(1, Math.ceil((seconds * fps) / frames - 1e-9));
}

/**
 * Equal parts, in the beta's shape: `n = ceil(duration * fps / maxFrames)`,
 * `length = duration / n`, starts at `i * length`. Pure - no ffmpeg.
 */
export function partPlan(durationSeconds: number, policy: SplitPolicy): PartPlan[] {
  const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const count = partCountFor(seconds, policy);
  if (count === 1) return [{ index: 0, startSeconds: 0, endSeconds: seconds }];
  const length = seconds / count;
  const plan: PartPlan[] = [];
  for (let i = 0; i < count; i += 1) {
    plan.push({
      index: i,
      startSeconds: i * length,
      endSeconds: i + 1 === count ? seconds : (i + 1) * length,
    });
  }
  return plan;
}

export interface MediaSliceRequest {
  localPath: string;
  startSeconds: number;
  endSeconds: number;
  index: number;
  count: number;
}

/**
 * Turn a prepared file into analysable parts with an injected slicer.
 * A single part is never re-encoded: the original file is handed over as-is.
 */
export async function splitParts(
  info: MediaInfo,
  policy: SplitPolicy,
  slice: (request: MediaSliceRequest) => Promise<string>,
): Promise<MediaPart[]> {
  if (!info.localPath) {
    throw new OmniWatchError("source_unavailable", "Brak lokalnego pliku do podzialu.", {
      action: { label: "pobierz material ponownie", kind: "none" },
    });
  }
  const plan = partPlan(info.durationSeconds, policy);
  if (plan.length === 1) {
    return [{ index: 0, startSeconds: 0, endSeconds: info.durationSeconds, localPath: info.localPath }];
  }
  const parts: MediaPart[] = [];
  for (const entry of plan) {
    const localPath = await slice({
      localPath: info.localPath,
      startSeconds: entry.startSeconds,
      endSeconds: entry.endSeconds,
      index: entry.index,
      count: plan.length,
    });
    parts.push({
      index: entry.index,
      startSeconds: entry.startSeconds,
      endSeconds: entry.endSeconds,
      localPath,
    });
  }
  return parts;
}
