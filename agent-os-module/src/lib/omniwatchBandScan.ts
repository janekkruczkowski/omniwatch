// The ink scan — finding the caption band from pixels alone, when locate has already
// failed twice.
//
// GRAPH-PLAN.md §2 names three steps for the caption-band gate after a bad first answer:
// try another frame, then scan for ink, then give up and say so. The frame retries already
// existed (omniwatchMeasure.ts). This file is the middle step, and it exists because of a
// concrete, measured failure: a band that is only ever LOCATED by a model is only as good
// as that one answer, and on the reference video the model's answer put the caption 3
// points of frame height low — 56% instead of the pixel-measured 52.8%. The rhythm counter
// downstream (measureCueRate in omniwatchCues.ts) is accurate to within a few percent when
// given the real band and off by HALF when given a guessed one, so the guess is not a
// rounding error, it is the whole defect.
//
// The method, verified against the real cached films rather than assumed:
//
//   Take the WHOLE frame down to a small grey raster (32 wide, 64 tall — few, wide columns
//   because this file is almost entirely a question of WHICH ROW, and many, thin rows
//   because that is the axis that needs resolving) at BAND_FPS, one ffmpeg call. Sum the
//   absolute difference between consecutive frames, per row. On a static shot (the ranking
//   film) this profile has a sharp, isolated peak exactly where the measured caption band
//   is — the scan reproduces the model's answer from pixels alone, for free.
//
// The catch is the whole difficulty, and it does not go away by wanting it to: on a
// handheld shot (the interview film) there is no isolated peak, because the entire frame
// is moving. A scan that looks for "the rows that change most" finds the camera, not the
// caption. Every fix tried for this is recorded below, including the ones that did not
// work — the point of writing them down is that nobody has to try them again.
//
// What DOES generalise, tested against three different real films (one static, one
// handheld, one with neither captions nor an isolated peak to find): a caption band is a
// GENUINE ISLAND in the frame's own activity, not merely the biggest bump in a landscape
// that is bumpy everywhere. An island has two properties a bump does not:
//
//   1. It carries a large share of the frame's single busiest moment — a bump that is only
//      "the biggest of several similar, smaller bumps" is not standing out, it is just
//      winning a comparison between near-equals.
//   2. At least one of its edges falls back to how quiet this FILM's own quietest rows get
//      — not quiet relative to the peak, quiet relative to the film's own noise floor. Only
//      one edge, deliberately: a caption sits against something genuinely still on one side
//      (a board, a margin, dead air) and against whatever else is happening in the frame on
//      the other, and the second of those is not disqualifying by itself.
//
// Tried and rejected — recorded so the next attempt does not repeat them:
//
//   - Requiring BOTH edges to be quiet. Kills the real caption on the ranking film too: the
//     row just above it sits on a slowly-rising plateau of presenter movement that never
//     drops near zero, only the row below it does. Rule 2 above is deliberately one-sided.
//   - Scoring a window by peak-relative isolation alone (windowMean / immediate shoulder,
//     with no absolute floor). A pair of merely-less-silent rows at the very top of a quiet
//     frame wins this trivially — a high RATIO between two small numbers is not evidence of
//     anything. Property 1 above (an absolute floor tied to the frame's own busiest row) is
//     what stops that.
//   - Per-row burst statistics: event counts, "quiet fraction" of frames, crest factor
//     (peak ÷ mean), lag-1 autocorrelation of the row's own activity. All four were tried
//     against real footage and NONE separated a caption row from ordinary handheld motion —
//     handheld shake is itself jittery, not smooth, so "bursty" does not mean "text". They
//     are not in this file because they did not earn their place, not because they were
//     never tried.
//
// The consequence, stated plainly rather than tuned away: this scan finds the ranking
// film's band and does not find the interview film's. That is not a bug to chase with a
// looser threshold — GRAPH-PLAN.md rule 2 is that a node with no defensible answer returns
// a hole, not a guess, and a threshold loosened until it also fires on handheld footage
// would very likely fire on OTHER handheld footage it was never tested against too. See the
// caller in omniwatchMeasure.ts and the executor's report for the actual numbers.

import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { run } from "@/lib/omniwatch";
import type { Rect } from "@/lib/omniwatchBlueprint";
import { BAND_FPS, NOISE_FLOOR } from "@/lib/omniwatchCues";

/** The whole frame, downsampled, for a run of consecutive moments.
 *
 *  `data` is `count` frames of `width*height` grey bytes, back to back, row-major — the
 *  same "read raw bytes from a file, never a pipe" shape `measureCueRate` and
 *  `omniwatchBoardScan.readPixels` already use, for the same reason: a JPEG or a raw frame
 *  decoded through a process helper that treats stdout as text turns every byte above 127
 *  into the same replacement character, which reads as "nothing ever changes". */
export interface GrayFrames {
  width: number;
  height: number;
  count: number;
  data: Buffer;
}

// Coarse on purpose. A caption line is a compositional feature the size of a fifth of the
// frame, not a texture, and averaging away single-pixel detail is what makes the signal
// survive re-encoding noise. 32 columns by 64 rows rather than something square: this file
// is almost entirely a question of WHICH ROW a band sits on, so most of the resolution
// budget goes there.
export const RASTER_W = 32;
export const RASTER_H = 64;

/** The shortest and tallest a candidate band may be, in raster rows.
 *
 *  2 rows is 3.1% of frame height — about as short as a single legible caption line gets
 *  once downsampled to RASTER_H. 10 rows is 15.6% — generous for two lines with padding.
 *  Past that the window is describing something taller than a caption line: a whole plate,
 *  a board, half the frame. Bounding the search keeps a big, slow-varying region (a wall
 *  that gradually brightens, say) from ever being considered a "band" in the first place. */
export const MIN_BAND_ROWS = 2;
export const MAX_BAND_ROWS = 10;

/** How much of the frame's single busiest row a candidate window has to carry, on average,
 *  to be taken seriously.
 *
 *  This is what stops "the two least-quiet rows in an otherwise dead stretch" from winning
 *  by isolation ratio alone — they can look perfectly isolated relative to their own tiny
 *  neighbourhood while being irrelevant in absolute terms. Verified stable rather than
 *  picked to fit: swept 0.35–0.55 against all three cached films used for this file's
 *  regression test (a static shot, a handheld shot, and a third with no caption rhythm at
 *  all) and the accepted/rejected outcome did not change anywhere in that range. 0.45 sits
 *  in the middle of it. */
export const PEAK_SHARE_MIN = 0.45;

/** Rows just outside a candidate window, sampled to test whether an edge is a real cliff.
 *  Swept 1–3 against the same three films with no change in outcome. */
export const SHOULDER_ROWS = 2;

/** Which percentile of a film's own row (or column) activity counts as "this film's
 *  quietest". A film-relative measure rather than an absolute one, because two films shot
 *  on different sensors at different bitrates do not share a noise floor — one film's
 *  quiet is another's compression artefact. */
export const QUIET_PERCENTILE = 0.10;

/** How many times the film's own quiet floor an edge may sit at and still count as "back to
 *  quiet". Multiplied against a per-film measurement, floored at NOISE_FLOOR (the same
 *  grey-level noise floor `measureCueRate` already uses for the same reason: below this,
 *  the codec's own compression noise is indistinguishable from a real change) so a nearly
 *  motionless film cannot produce a quiet floor of zero and make everything look isolated.
 *  Swept 2–6 against the same three films with no change in outcome. */
export const QUIET_EDGE_MULT = 4;

/** How many times a film's own column-activity quiet floor a column may sit at and still
 *  count as part of the band's width, when trimming dead margins off the left and right.
 *  Lower than QUIET_EDGE_MULT on purpose: caption text tapers toward the edges of its own
 *  box long before it reaches true silence (a short line does not reach the margins a long
 *  one does), and trimming aggressively there would cut real ink, not dead space. Swept
 *  1.5–2.5 with a stable result; degrades outside that range in the direction of cutting
 *  into real text, which is why it is kept low. */
export const ACTIVE_COL_MULT = 2;

/** GRAPH-PLAN.md §2's own bar for the rhythm gate one step downstream: a rhythm needs at
 *  least two changes to be a rhythm rather than a single, meaningless step. Applied here
 *  too, as a second, independent check on the accepted band — magnitude and isolation say
 *  "something stands out here"; this says "and it happens more than once". */
export const EVENTS_MIN = 2;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(s.length * p)))] ?? 0;
}

/** One ffmpeg call: the whole frame, shrunk to RASTER_W×RASTER_H grey, at BAND_FPS.
 *
 *  Through a temp file, not a pipe — see the type doc above for why. Returns null on
 *  anything short of a clean read: a source that will not decode, or too few frames to
 *  compare, is not this function's problem to solve, only to refuse. */
export async function readGrayFrames(sourcePath: string, workDir: string): Promise<GrayFrames | null> {
  const raw = path.join(workDir, "band-scan.raw");
  let buf: Buffer;
  try {
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", sourcePath,
      "-vf", `scale=${RASTER_W}:${RASTER_H},format=gray`,
      "-r", String(BAND_FPS), "-f", "rawvideo", raw,
    ], 120_000);
    buf = await readFile(raw);
  } catch {
    return null;
  } finally {
    await unlink(raw).catch(() => {});
  }
  const frame = RASTER_W * RASTER_H;
  const count = Math.floor(buf.length / frame);
  if (count < 4) return null;
  return { width: RASTER_W, height: RASTER_H, count, data: buf };
}

/** Per-transition frame baseline (median across every row) and, per row, how much MORE
 *  that row changed than the frame typically did at that same moment.
 *
 *  This is the one subtraction that makes the whole file work on a handheld shot: a raw
 *  sum of row activity finds the camera on that footage, because the camera moves every
 *  row a little on every frame. Subtracting out "how much did the frame move at this
 *  instant, typically" leaves only the EXCESS — a row doing something beyond what the rest
 *  of the frame is already doing. On a static shot the baseline is near zero throughout, so
 *  this reduces to the raw sum and changes nothing; on a handheld shot it is what stops
 *  ordinary camera shake from swamping everything else. */
function rowExcessSeries(frames: GrayFrames): number[][] {
  const { width: W, height: H, count: n, data } = frames;
  const frame = W * H;
  const series: number[][] = [];
  for (let t = 1; t < n; t++) {
    const row = new Array<number>(H).fill(0);
    for (let r = 0; r < H; r++) {
      let sum = 0;
      const base = r * W;
      for (let c = 0; c < W; c++) {
        const k = base + c;
        sum += Math.abs(data[t * frame + k] - data[(t - 1) * frame + k]);
      }
      row[r] = sum / W;
    }
    series.push(row);
  }
  const baseline = series.map((row) => median(row));
  return series.map((row, t) => row.map((v) => Math.max(0, v - baseline[t])));
}

/** Cumulative excess per row over the whole clip — the profile a candidate band is picked
 *  from. Exported on its own so a test can hand it synthetic activity directly, without
 *  spawning ffmpeg for every case. */
export function rowExcess(frames: GrayFrames): number[] {
  const excess = rowExcessSeries(frames);
  const E = new Array<number>(frames.height).fill(0);
  for (const row of excess) for (let r = 0; r < row.length; r++) E[r] += row[r];
  return E;
}

export interface RowBand { top: number; bot: number; }

/** Pick the row window that behaves like a genuine island in this film's own activity, or
 *  null when nothing here defends itself as one. See the file header for the full argument;
 *  this is the two-property test it ends on. */
export function findIsolatedBand(E: number[]): RowBand | null {
  const H = E.length;
  if (H < MIN_BAND_ROWS) return null;
  const globalPeak = Math.max(...E);
  if (globalPeak <= 0) return null;
  const quietFloor = percentile(E, QUIET_PERCENTILE);
  const quietCeiling = Math.max(NOISE_FLOOR, quietFloor * QUIET_EDGE_MULT);

  let best: (RowBand & { score: number }) | null = null;
  for (let k = MIN_BAND_ROWS; k <= Math.min(MAX_BAND_ROWS, H); k++) {
    for (let s = 0; s + k <= H; s++) {
      let windowSum = 0;
      for (let r = s; r < s + k; r++) windowSum += E[r];
      const windowMean = windowSum / k;
      if (windowMean < globalPeak * PEAK_SHARE_MIN) continue; // property 1

      const lo = E.slice(Math.max(0, s - SHOULDER_ROWS), s);
      const hi = E.slice(s + k, Math.min(H, s + k + SHOULDER_ROWS));
      const loShoulder = lo.length ? lo.reduce((a, b) => a + b, 0) / lo.length : quietFloor;
      const hiShoulder = hi.length ? hi.reduce((a, b) => a + b, 0) / hi.length : quietFloor;
      const quietestEdge = Math.min(loShoulder, hiShoulder); // one side only — see header
      if (quietestEdge > quietCeiling) continue; // property 2

      const score = windowMean / Math.max(1, quietestEdge);
      if (!best || score > best.score) best = { top: s, bot: s + k - 1, score };
    }
  }
  return best ? { top: best.top, bot: best.bot } : null;
}

/** How many times the band's own aggregate signal swings from quiet to loud — GRAPH-PLAN's
 *  rhythm bar, applied to the candidate before it is trusted. Same hysteresis shape
 *  `measureCueRate` uses (a loud run only counts once, on the way up), so "the band flickers
 *  between two grey levels for one whole frame" cannot inflate the count. */
function bandEvents(frames: GrayFrames, band: RowBand): number {
  const excess = rowExcessSeries(frames);
  const series = excess.map((row) => {
    let sum = 0;
    for (let r = band.top; r <= band.bot; r++) sum += row[r];
    return sum / (band.bot - band.top + 1);
  });
  if (!series.length) return 0;
  const loud = Math.max(NOISE_FLOOR, percentile(series, 0.9) / 2);
  let events = 0, wasLoud = false;
  for (const v of series) {
    const isLoud = v >= loud;
    if (isLoud && !wasLoud) events++;
    wasLoud = isLoud;
  }
  return events;
}

/** Cumulative excess per COLUMN, restricted to the rows a band was already found in —
 *  exported for the same testability reason as rowExcess. */
export function colExcess(frames: GrayFrames, band: RowBand): number[] {
  const { width: W, height: H, count: n, data } = frames;
  const frame = W * H;
  const bandRows = band.bot - band.top + 1;
  const colByT: number[][] = [];
  const rowBaseline: number[] = [];
  for (let t = 1; t < n; t++) {
    const row = new Array<number>(H).fill(0);
    const col = new Array<number>(W).fill(0);
    for (let r = 0; r < H; r++) {
      const base = r * W;
      let rsum = 0;
      for (let c = 0; c < W; c++) {
        const k = base + c;
        const d = Math.abs(data[t * frame + k] - data[(t - 1) * frame + k]);
        rsum += d;
        if (r >= band.top && r <= band.bot) col[c] += d;
      }
      row[r] = rsum / W;
    }
    rowBaseline.push(median(row));
    colByT.push(col.map((v) => v / bandRows));
  }
  const E = new Array<number>(W).fill(0);
  for (let t = 0; t < colByT.length; t++) {
    for (let c = 0; c < W; c++) E[c] += Math.max(0, colByT[t][c] - rowBaseline[t]);
  }
  return E;
}

export interface ColSpan { left: number; right: number; }

/** Trim dead margins off the left and right of a band's width — deliberately gentle (see
 *  ACTIVE_COL_MULT above): a caption's widest LINE reaches close to its box's true edges,
 *  but most lines are shorter, so this trims only columns that are quiet across the WHOLE
 *  clip, not merely quiet on any one line. */
export function widenColumns(colE: number[]): ColSpan {
  const W = colE.length;
  const quietFloor = percentile(colE, QUIET_PERCENTILE);
  const floor = Math.max(NOISE_FLOOR, quietFloor * ACTIVE_COL_MULT);
  let left = 0, right = W - 1;
  while (left < W && colE[left] < floor) left++;
  while (right >= 0 && colE[right] < floor) right--;
  if (left > right) return { left: 0, right: W - 1 }; // nothing cleared the floor — do not invent a crop
  return { left, right };
}

/** The whole scan: read the frame, find a band, widen it to its columns, check its rhythm.
 *  Returns null — a hole, not a guess — the moment any one of those steps has nothing to
 *  defend. `notes` gets exactly one line either way, for the run report this feeds. */
export async function scanCaptionBand(
  sourcePath: string, workDir: string, notes: string[],
): Promise<Rect | null> {
  const frames = await readGrayFrames(sourcePath, workDir);
  if (!frames) { notes.push("ink scan: the frame could not be read from the film"); return null; }

  const E = rowExcess(frames);
  const band = findIsolatedBand(E);
  if (!band) {
    notes.push("ink scan: nothing in the frame stands out as an isolated band — no defensible caption row");
    return null;
  }

  const events = bandEvents(frames, band);
  if (events < EVENTS_MIN) {
    notes.push(`ink scan: found a band at rows [${band.top},${band.bot}] but it only changes ${events} time(s) — not a rhythm`);
    return null;
  }

  const cols = widenColumns(colExcess(frames, band));
  const rect: Rect = [
    cols.left / frames.width,
    band.top / frames.height,
    (cols.right - cols.left + 1) / frames.width,
    (band.bot - band.top + 1) / frames.height,
  ];
  notes.push(
    `ink scan: found a caption band at ${JSON.stringify(rect.map((n) => Math.round(n * 1e4) / 1e4))} ` +
    `(rows [${band.top},${band.bot}] of ${frames.height}, ${events} change(s))`,
  );
  return rect;
}
