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

/** What a host slicer returns: a path, or a path plus where that file really starts. */
export type SliceResult = string | { localPath: string; startSeconds?: number };

/** Thumbnails in the timeline strip, same as the beta's `STRIP`. */
export const STRIP_COUNT = 16;

/** Short-form material gets the API's maximum sampling rate. */
export const SHORT_MAX_SECONDS = 3 * 60;
export const FPS_SHORT = 10;
export const FPS_LONG = 2;

export const fpsFor = (seconds: number): number => (seconds <= SHORT_MAX_SECONDS ? FPS_SHORT : FPS_LONG);

/**
 * Frames one Qwen3.8-Omni-Flash call may carry (2 minutes at 2 fps, about 46k input
 * tokens at 480p).
 *
 * Measured live on 2026-09-23 (qa-omniwatch-20260923/LF-long-film): DashScope's
 * compatible-mode endpoint sends response headers only with the first generated token
 * and closes a connection that has produced no headers after ~60 s (reproduced with a
 * plain non-streaming text request, no video). Time to headers grows with the input:
 * ~90k-token parts (the old 480-frame cap) failed 4 of 4 fresh attempts, ~46k-token
 * parts answered in a median ~20 s with 2 of 15 solo attempts lost to the provider's
 * random queueing tail. The cap is enforced in the engine so both shells get it.
 */
export const QWEN38_OMNI_FLASH_MAX_FRAMES_PER_PART = 240;

/** The configured frame budget, bounded for models with a measured provider limit. */
export function effectiveMaxFramesPerPart(modelName: string | null | undefined, configured: number): number {
  if (/^qwen3\.8-omni-flash(?:$|-)/i.test(String(modelName ?? ""))) {
    return Math.min(configured, QWEN38_OMNI_FLASH_MAX_FRAMES_PER_PART);
  }
  return configured;
}

/**
 * Where a stream-copied cut really starts. `ffmpeg -ss S -t L -i in -c copy` begins at
 * the keyframe at or before S and still ends at S + L, so the file is longer than
 * planned by exactly the distance to that keyframe. Timestamps the model reads from
 * such a file are relative to the keyframe, not to S (R2-08: a TikTok part planned at
 * 0:29 really began at 0:23, and a note at 0:32 became 1:01 in a 0:58 film).
 */
export function keyframeAlignedStart(plannedStart: number, plannedEnd: number, actualDuration: number): number {
  if (!Number.isFinite(actualDuration) || actualDuration <= 0) return plannedStart;
  const planned = plannedEnd - plannedStart;
  // Ignore container rounding; only a real extension moves the start.
  if (actualDuration <= planned + 0.25) return plannedStart;
  return Math.max(0, plannedEnd - actualDuration);
}

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
  const partEnd = offset + length;
  const toSeconds = (h: string | undefined, m: string, s: string): number =>
    Number(h || 0) * 3600 + Number(m) * 60 + Number(s);
  // A clip-relative position lands inside this part: a model that overruns the clip's
  // own length (it sometimes quotes 0:25 in a 19 s clip) must not push the film's
  // clock past the part's end - for the last part that is past the film (R3 M19).
  const shift = (seconds: number): number => Math.min(offset + seconds, partEnd);
  // Ranges (`[0:05–0:07]`, `[0:05-0:07]`) are shifted as a whole, decided by their
  // start; the prompt asks for single timestamps, but the model does not always obey,
  // and an unshifted range reads as a position near the start of the film.
  return text.replace(
    /\[(?:(\d+):)?(\d{1,2}):(\d{2})(?:\s*[-–—]\s*(?:(\d+):)?(\d{1,2}):(\d{2}))?\]/g,
    (_match, h, m, s, h2, m2, s2) => {
      const start = toSeconds(h, m, s);
      const absolute = start > length + 5;
      const first = formatDuration(absolute ? start : shift(start));
      if (m2 === undefined) return `[${first}]`;
      const end = toSeconds(h2, m2, s2);
      return `[${first}–${formatDuration(absolute ? end : shift(end))}]`;
    },
  );
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
  slice: (request: MediaSliceRequest) => Promise<SliceResult>,
): Promise<MediaPart[]> {
  if (!info.localPath) {
    throw new OmniWatchError("source_unavailable", "Brak lokalnego pliku do podzialu.", {
      action: { label: "pobierz material ponownie", kind: "none" },
    });
  }
  const plan = partPlan(info.durationSeconds, policy);
  const fps = (policy.fpsForSeconds ?? fpsFor)(Number.isFinite(info.durationSeconds) ? info.durationSeconds : 0);
  if (plan.length === 1) {
    return [{ index: 0, startSeconds: 0, endSeconds: info.durationSeconds, localPath: info.localPath, fps }];
  }
  const parts: MediaPart[] = [];
  for (const entry of plan) {
    const sliced = await slice({
      localPath: info.localPath,
      startSeconds: entry.startSeconds,
      endSeconds: entry.endSeconds,
      index: entry.index,
      count: plan.length,
    });
    const localPath = typeof sliced === "string" ? sliced : sliced.localPath;
    const reported = typeof sliced === "string" ? undefined : sliced.startSeconds;
    // Only an earlier start inside this part's range is believable: a cut can snap
    // back to a keyframe, never forward past the planned start.
    const startSeconds =
      typeof reported === "number" && Number.isFinite(reported) && reported >= 0 && reported <= entry.startSeconds
        ? reported
        : entry.startSeconds;
    parts.push({
      index: entry.index,
      startSeconds,
      endSeconds: entry.endSeconds,
      localPath,
      fps,
    });
  }
  return parts;
}
