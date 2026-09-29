// Counting the board off the pixels, instead of asking a model what it probably looks like.
//
// A vision model is good at "the tier board is the dark thing at the bottom" and bad at
// "the letter column is 24.2% of the board wide". The first is a question about meaning and
// the second is a question about counting, and we had been asking the same model both — so
// the label column was 16% because that number once looked right, the row gap was whatever
// CSS did, and the tiles were sized by a flexbox rule with three !important on it.
//
// All of that is measurable. A tier board is the most measurable thing in the frame: flat
// plates of colour, a hard edge where the plate stops, a regular grid of square tiles on a
// uniform slot. This file walks the frame and reports what is there — column edge, row
// pitch, gap, plate colours, letter ink, tile size and how many tiles each row actually
// holds — and those numbers go into the recipe ahead of anything a model said.
//
// Nothing here is clever. It is a run-length scan, and every threshold is a colour distance
// in plain RGB, which is enough because the thing being measured is flat colour. Where the
// scan cannot find something it says so and the caller keeps the modelled value: a wrong
// measurement is worse than a stated absence.

import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { run } from "@/lib/omniwatch";
import type { Rect } from "@/lib/omniwatchBlueprint";

export interface Pixels {
  width: number;
  height: number;
  data: Buffer;
}

export interface TierRowMeasure {
  id: string;
  /** Whole row, canvas fractions. */
  rect: Rect;
  /** The coloured letter plate. */
  label: Rect;
  /** Where the tiles go. */
  slot: Rect;
  /** Hex of the plate. */
  fill: string;
  /** Hex of the letter, when one was found. */
  ink: string | null;
  /** The letter's drawn height over the row's height. A capital has no descender, so this is
   *  its cap height — which is about 0.72 of the font size in a grotesque, and that is the
   *  conversion the recipe does. Null when no letter was found. */
  letterRatio: number | null;
  /** Every tile found in the slot, left to right, canvas fractions. */
  thumbs: Rect[];
}

export interface BoardMeasure {
  /** The board as the scan found it — its top edge is usually a few pixels off what locate
   *  reported, and a few pixels is a visible seam at the top of the first row. */
  board: Rect;
  rows: TierRowMeasure[];
  /** Label column width over board width. */
  labelRatio: number;
  /** Gap between rows, as a fraction of canvas height. */
  rowGap: number;
  /** Behind the tiles. */
  slotBackground: string;
  /** Between the rows — the grid lines. */
  boardBackground: string;
  /** The tier letter's cap height over its row's height, taken across the rows. Null when no
   *  letters were found. */
  letterCapRatio: number | null;
  /** The tier letter's ink, taken across the rows. */
  letterInk: string | null;
  thumb: {
    /** Tile height over row height. */
    heightRatio: number;
    /** Width over height. */
    aspect: number;
    /** Between tiles, as a fraction of canvas width. */
    gap: number;
    /** Before the first tile, as a fraction of canvas width. */
    padX: number;
  };
  notes: string[];
}

type RGB = [number, number, number];

const dist = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const toHex = (c: RGB) => `#${c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;

/** One frame as raw RGB.
 *
 *  Through a file rather than a pipe: the process helper collects stdout as a string, and a
 *  JPEG decoded into a JavaScript string is not the bytes any more. */
export async function readPixels(framePath: string): Promise<Pixels | null> {
  const probe = await run("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", framePath], 30_000).catch(() => "");
  const m = String(probe).trim().match(/^(\d+)x(\d+)/);
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  const raw = path.join(os.tmpdir(), `omniwatch-scan-${process.pid}-${Date.now()}.raw`);
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", framePath,
      "-f", "rawvideo", "-pix_fmt", "rgb24", raw], 60_000);
    const data = await readFile(raw);
    if (data.length < width * height * 3) return null;
    return { width, height, data };
  } catch {
    return null;
  } finally {
    await unlink(raw).catch(() => {});
  }
}

export function pixelAt(px: Pixels, x: number, y: number): RGB {
  const cx = Math.max(0, Math.min(px.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(px.height - 1, Math.round(y)));
  const i = (cy * px.width + cx) * 3;
  return [px.data[i], px.data[i + 1], px.data[i + 2]];
}

/** The colour most of an area is, rather than the colour it averages to.
 *
 *  A mean over a plate with a letter on it lands between the plate and the ink, which is a
 *  colour that appears nowhere in the frame — the sampling mistake this whole pipeline has
 *  been told twice not to repeat. Buckets of 12 are coarse enough that compression noise
 *  falls into one bucket and fine enough that two pastels do not. */
export function modalColour(px: Pixels, box: Rect, filter?: (c: RGB) => boolean): RGB | null {
  const x0 = Math.round(box[0] * px.width), y0 = Math.round(box[1] * px.height);
  const x1 = Math.round((box[0] + box[2]) * px.width), y1 = Math.round((box[1] + box[3]) * px.height);
  const step = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) / 60));
  const bins = new Map<number, { n: number; sum: [number, number, number] }>();
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const c = pixelAt(px, x, y);
      if (filter && !filter(c)) continue;
      const key = (c[0] >> 4) * 256 + (c[1] >> 4) * 16 + (c[2] >> 4);
      const b = bins.get(key) || { n: 0, sum: [0, 0, 0] as [number, number, number] };
      b.n++; b.sum[0] += c[0]; b.sum[1] += c[1]; b.sum[2] += c[2];
      bins.set(key, b);
    }
  }
  let best: { n: number; sum: [number, number, number] } | null = null;
  for (const b of bins.values()) if (!best || b.n > best.n) best = b;
  if (!best || best.n < 4) return null;
  return [best.sum[0] / best.n, best.sum[1] / best.n, best.sum[2] / best.n];
}

/** Runs of one colour down a vertical strip, and the gaps between them.
 *
 *  This is how the rows are found: a tier board is five flat plates with a dark rule between
 *  them, so a strip through the letter column is five long runs of stable colour. */
function verticalRuns(px: Pixels, x: number, y0: number, y1: number, tol = 60): { start: number; end: number; colour: RGB }[] {
  const out: { start: number; end: number; colour: RGB }[] = [];
  let start = -1;
  let ref: RGB | null = null;
  for (let y = y0; y <= y1; y++) {
    const c = pixelAt(px, x, y);
    if (ref && dist(c, ref) <= tol) continue;
    if (start >= 0 && ref) out.push({ start, end: y - 1, colour: ref });
    start = y; ref = c;
  }
  if (start >= 0 && ref) out.push({ start, end: y1, colour: ref });
  return out;
}

export interface ScanOptions {
  /** Row ids, top to bottom. Defaults to S–D. */
  ids?: string[];
  /** How many rows to expect. Defaults to ids.length. */
  rows?: number;
  /** How much of the given box the rows must fill to count as the board in it.
   *
   *  Half, when the box is an answer from locate and the rows had better be most of it. Zero
   *  when the box is the whole frame and we are looking for the board wherever it is — there
   *  the regularity checks do the work, and demanding coverage would refuse every real board
   *  for the crime of not filling the screen. */
  coverage?: number;
}

/**
 * Measure a tier board inside a located rectangle.
 *
 * `board` is the locate pass's answer and is treated as a hint: the scan looks a little
 * above and below it for the real first and last row, because locate is reliably right
 * about WHICH thing and reliably a few pixels out about where it starts.
 */
/** The fewest rows that can EVIDENCE a grid.
 *
 *  Not a claim that no board has two rows — a claim that two rows cannot prove they are one.
 *  Regularity is the whole test, and regularity needs at least two gaps to be regular in. */
export const MIN_ROWS = 3;

export function scanBoard(px: Pixels, board: Rect, opts: ScanOptions = {}): BoardMeasure | null {
  const ids = opts.ids?.length ? opts.ids : ["s", "a", "b", "c", "d"];
  const want = opts.rows ?? ids.length;
  const notes: string[] = [];
  const W = px.width, H = px.height;

  const bx0 = Math.max(0, Math.round(board[0] * W));
  const bx1 = Math.min(W - 1, Math.round((board[0] + board[2]) * W));
  // A search window with a little slack either side of where locate said the board is. Slack,
  // not a free hand: a wall behind the presenter is as flat as a tier plate, and a window
  // half the board tall found five "rows" of bedroom.
  const searchTop = Math.max(0, Math.round((board[1] - board[3] * 0.12) * H));
  const searchBot = Math.min(H - 1, Math.round((board[1] + board[3] * 1.12) * H));
  if (bx1 - bx0 < 40 || searchBot - searchTop < 40) return null;

  // The strip runs through the letter column. 3% of the frame's width in from the board's
  // left edge is inside any label column wide enough to hold a letter, and clear of the
  // rule that draws the board's own border.
  const stripX = Math.min(bx1 - 2, bx0 + Math.max(4, Math.round(W * 0.03)));
  const runs = verticalRuns(px, stripX, searchTop, searchBot)
    .filter((r) => r.end - r.start >= Math.round(H * 0.02))
    // A plate is a plate because it is not the dark rule between plates.
    .filter((r) => luma(r.colour) > 45);

  if (runs.length < 2) {
    notes.push(`board scan: only ${runs.length} plate runs down x=${stripX} — keeping located geometry`);
    return null;
  }

  // Which runs are the board. More than `want` will be found whenever something above the
  // board holds still — a wall, a jersey, a door — and taking the first five got a render
  // whose "S row" was the bedroom. Tier rows are the five in a row that are the SAME HEIGHT
  // and evenly spaced, which nothing else in a frame is, so every window of that many
  // consecutive runs is scored on how regular it is and how much of the located box it
  // covers, and the best one wins.
  const width = Math.min(want, runs.length);
  let rowsFound = runs.slice(0, width);
  let bestScore = -Infinity;
  const locTop = board[1] * H, locBot = (board[1] + board[3]) * H;
  for (let i = 0; i + width <= runs.length; i++) {
    const w = runs.slice(i, i + width);
    const heights = w.map((r) => r.end - r.start + 1);
    const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
    const spread = Math.max(...heights) - Math.min(...heights);
    // Evenly spaced: the distance from one plate's top to the next never changes.
    const pitches = w.slice(1).map((r, k) => r.start - w[k].start);
    const pitchSpread = pitches.length ? Math.max(...pitches) - Math.min(...pitches) : 0;
    const covered = Math.max(0, Math.min(w[w.length - 1].end, locBot) - Math.max(w[0].start, locTop));
    const score = covered / Math.max(1, locBot - locTop)
      - (spread / Math.max(1, mean)) * 1.5
      - (pitchSpread / Math.max(1, mean)) * 1.5;
    if (score > bestScore) { bestScore = score; rowsFound = w; }
  }
  if (rowsFound.length < want) {
    notes.push(`board scan: found ${rowsFound.length} of ${want} rows`);
  }

  // Is this a board at all? Ranking the windows finds the best one; it does not ask whether
  // the best one is any good, and run against footage with no tier list in it — a wall, a
  // gradient, a desk — the best window is still five stripes of something. Checked against
  // four cached videos: two have boards, two do not, and without this gate all four
  // "measured" one. A board is rows of the SAME height at the SAME pitch, and nothing else
  // in a frame is; a window that is not that is a window we did not find a board in.
  {
    const heights = rowsFound.map((r) => r.end - r.start + 1);
    const meanH = heights.reduce((a, b) => a + b, 0) / heights.length;
    const spreadH = (Math.max(...heights) - Math.min(...heights)) / Math.max(1, meanH);
    const pitches = rowsFound.slice(1).map((r, k) => r.start - rowsFound[k].start);
    const meanP = pitches.length ? pitches.reduce((a, b) => a + b, 0) / pitches.length : 0;
    const spreadP = pitches.length ? (Math.max(...pitches) - Math.min(...pitches)) / Math.max(1, meanP) : 0;
    const covered = (rowsFound[rowsFound.length - 1].end - rowsFound[0].start) / Math.max(1, locBot - locTop);
    const wantCover = opts.coverage ?? 0.5;
    if (rowsFound.length < MIN_ROWS) {
      // Two bands are not a grid, and the test above cannot tell you otherwise: with two
      // rows there is a single pitch, and a single pitch is always perfectly even. The
      // evidence is vacuous, so the answer comes out yes for anything split in half — a
      // podcast with two speakers stacked, a frame with a horizon in it.
      notes.push(`board scan: only ${rowsFound.length} row(s) — too few to be a grid rather than a split`);
      return null;
    }
    if (spreadH > 0.25 || spreadP > 0.2 || covered < wantCover || meanH < H * 0.03) {
      notes.push(
        `board scan: rows are not a grid (height spread ${spreadH.toFixed(2)}, pitch spread ${spreadP.toFixed(2)}, ` +
        `covers ${covered.toFixed(2)} of the located board) — this is not a tier board`,
      );
      return null;
    }
  }

  // The rule between two plates, sampled in the gap rather than assumed to be black.
  const gaps: number[] = [];
  for (let i = 1; i < rowsFound.length; i++) gaps.push(rowsFound[i].start - rowsFound[i - 1].end - 1);
  const rowGapPx = gaps.length ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)) : 0;
  const boardBg = (rowGapPx > 0
    ? modalColour(px, [
        bx0 / W,
        (rowsFound[0].end + 1) / H,
        (bx1 - bx0 + 1) / W,
        Math.max(1, rowGapPx) / H,
      ])
    : null) || ([20, 20, 22] as RGB);

  const top = rowsFound[0].start;
  const bottom = rowsFound[rowsFound.length - 1].end;
  // The scan sees the plates; the board is the plates plus the rules around them.
  const boardTop = Math.max(0, top - rowGapPx);
  const boardBottom = Math.min(H - 1, bottom + rowGapPx);

  // Where the letter column ends: walk right along the middle of a row until the plate's
  // colour stops, and confirm it stops for good rather than for one compressed pixel. The
  // walk starts INSIDE the plate, at the same strip the rows were found down — starting at
  // the board's left edge read the board's own dark rule as "not the plate" and reported a
  // letter column eight pixels wide.
  //
  // A whole column at a time, not one scanline: the letter sits in the middle of the plate,
  // and a scanline through it stops at the "S" and reports a column 79px wide instead of
  // 174. A column that is a quarter plate is still the plate; a column in the slot has none
  // of it at all, whatever photograph happens to be there.
  const labelEdge = (r: { start: number; end: number; colour: RGB }): number => {
    const y0 = r.start + 3, y1 = r.end - 3;
    const plateFrac = (x: number) => {
      let on = 0, n = 0;
      for (let y = y0; y <= y1; y += 2) { n++; if (dist(pixelAt(px, x, y), r.colour) < 70) on++; }
      return n ? on / n : 0;
    };
    let off = 0;
    for (let x = stripX; x <= bx1; x++) {
      if (plateFrac(x) < 0.25) {
        off++;
        if (off >= 4) return x - off + 1;
      } else off = 0;
    }
    return bx1;
  };
  const edges = rowsFound.map(labelEdge).sort((a, b) => a - b);
  const labelRight = edges[Math.floor(edges.length / 2)];
  const labelW = Math.max(8, labelRight - bx0);

  // The slot's own colour: what most of the area right of the tiles is. Filtered to the dark
  // half, because a row packed with photographs has more photograph in it than background.
  const slotX = Math.min(W - 2, labelRight + Math.max(1, rowGapPx));
  const slotBox: Rect = [slotX / W, boardTop / H, Math.max(0.02, (bx1 - slotX) / W), (boardBottom - boardTop) / H];
  const slotBg = modalColour(px, slotBox, (c) => luma(c) < 120) || ([40, 40, 44] as RGB);

  const rows: TierRowMeasure[] = [];
  const tileHeights: number[] = [];
  const tileAspects: number[] = [];
  const tileGaps: number[] = [];
  const tilePads: number[] = [];

  rowsFound.forEach((r, i) => {
    const rowTop = r.start, rowBot = r.end;
    const rowH = rowBot - rowTop + 1;
    const fill = modalColour(px, [bx0 / W, rowTop / H, labelW / W, rowH / H]) || r.colour;
    // The letter is whatever on the plate is not the plate.
    const inkPixels: RGB[] = [];
    let inkTop = Infinity, inkBot = -Infinity;
    for (let y = rowTop + 3; y < rowBot - 3; y += 2) {
      for (let x = bx0 + 4; x < labelRight - 4; x += 2) {
        const c = pixelAt(px, x, y);
        if (dist(c, fill) > 110) {
          inkPixels.push(c);
          if (y < inkTop) inkTop = y;
          if (y > inkBot) inkBot = y;
        }
      }
    }
    // The letter's own colour, not the average of the letter and the ramp around it. Every
    // glyph is mostly edge at this size, and averaging the anti-aliasing in reported a dark
    // brown for ink that is charcoal — the same mistake as sampling a mean over a photograph.
    const ink = (() => {
      if (inkPixels.length < 12) return null;
      // Furthest from the plate, not darkest: a white letter on a dark plate is the same
      // measurement seen from the other side.
      const core = [...inkPixels].sort((a, b) => dist(b, fill) - dist(a, fill))
        .slice(0, Math.max(6, Math.round(inkPixels.length * 0.3)));
      return core.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]] as RGB, [0, 0, 0] as RGB)
        .map((n) => n / core.length) as RGB;
    })();

    // Tiles: a column belongs to a tile when most of the row's height at that x is not the
    // slot's background. Sampling the whole column rather than one scanline is what stopped
    // a dark photograph from being read as two tiles with a hole in the middle.
    const occ: number[] = [];
    for (let x = slotX; x <= bx1; x++) {
      let on = 0, n = 0;
      for (let y = rowTop + 3; y < rowBot - 3; y += 2) { n++; if (dist(pixelAt(px, x, y), slotBg) > 55) on++; }
      occ.push(n ? on / n : 0);
    }
    const candidates: { x0: number; x1: number }[] = [];
    let s = -1;
    occ.forEach((f, k) => {
      const on = f > 0.45;
      if (on && s < 0) s = k;
      if (!on && s >= 0) {
        if (k - s >= Math.round(rowH * 0.35)) candidates.push({ x0: slotX + s, x1: slotX + k - 1 });
        s = -1;
      }
    });
    if (s >= 0 && occ.length - s >= Math.round(rowH * 0.35)) candidates.push({ x0: slotX + s, x1: bx1 });

    let thumbs: Rect[] = [];
    if (candidates.length) {
      // Vertical extent of the first tile gives the tile's height and the row's padding.
      const first = candidates[0];
      const xc = Math.round((first.x0 + first.x1) / 2);
      // An edge is three pixels of tile, not one. A single differing pixel at the row's own
      // boundary is the board's rule bleeding in, and reading that as the tile's edge made
      // every tile exactly as tall as its row — which is the one thing tiles never are.
      const solid = (y: number) => [0, 1, 2].every((d) => dist(pixelAt(px, xc, y + d), slotBg) > 55);
      let tTop = rowTop, tBot = rowBot;
      for (let y = rowTop; y <= rowBot - 2; y++) { if (solid(y)) { tTop = y; break; } }
      for (let y = rowBot - 2; y >= rowTop; y--) { if (solid(y - 2)) { tBot = y; break; } }
      const tileH = Math.max(8, tBot - tTop + 1);
      // A tile is square unless the widest clean candidate says otherwise. The widest is the
      // one least likely to be a photograph that merged with its neighbour or split in two.
      const clean = candidates.map((c) => c.x1 - c.x0 + 1).filter((w) => w >= tileH * 0.6 && w <= tileH * 1.6);
      const tileW = clean.length ? Math.round(clean.reduce((a, b) => a + b, 0) / clean.length) : tileH;
      // The gap: from the first pair of tiles that are a tile apart.
      let gapPx = rowGapPx;
      for (let k = 1; k < candidates.length; k++) {
        const g = candidates[k].x0 - candidates[k - 1].x1 - 1;
        if (g >= 0 && g <= tileW * 0.4) { gapPx = g; break; }
      }
      const pitch = tileW + gapPx;
      const padPx = first.x0 - slotX;
      // Walk the grid the tiles imply and keep the cells that are actually filled. Reading
      // the runs directly would have counted a two-tone photograph twice.
      const maxCells = Math.max(1, Math.floor((bx1 - first.x0 + gapPx) / Math.max(1, pitch)));
      for (let k = 0; k < maxCells; k++) {
        const x0 = first.x0 + k * pitch;
        if (x0 + tileW * 0.6 > bx1) break;
        let on = 0, n = 0;
        for (let y = tTop + 2; y < tBot - 2; y += 2) {
          for (let x = x0 + 2; x < Math.min(bx1, x0 + tileW - 2); x += 2) { n++; if (dist(pixelAt(px, x, y), slotBg) > 55) on++; }
        }
        if (!n || on / n < 0.35) break;
        thumbs.push([x0 / W, tTop / H, tileW / W, tileH / H]);
      }
      // A row of forty "tiles" is a texture being read as a grid. A tier row holds a handful
      // of pictures; past that, the scan has found a pattern rather than a row, and saying
      // nothing about this row is better than filling it with noise.
      if (thumbs.length > 12) {
        notes.push(`row ${ids[i] ?? i}: ${thumbs.length} candidate tiles — too many to be pictures, ignored`);
        thumbs = [];
      }
      if (thumbs.length) {
        tileHeights.push(tileH / rowH);
        tileAspects.push(tileW / tileH);
        tileGaps.push(gapPx / W);
        tilePads.push(padPx / W);
      }
    }

    rows.push({
      id: ids[i] ?? String.fromCharCode(97 + i),
      rect: [bx0 / W, rowTop / H, (bx1 - bx0 + 1) / W, rowH / H],
      label: [bx0 / W, rowTop / H, labelW / W, rowH / H],
      slot: [slotX / W, rowTop / H, Math.max(0.02, (bx1 - slotX + 1) / W), rowH / H],
      fill: toHex(fill),
      ink: ink ? toHex(ink) : null,
      letterRatio: ink && inkBot > inkTop ? (inkBot - inkTop + 1) / rowH : null,
      thumbs,
    });
  });

  const mid = (xs: number[], fallback: number) => {
    if (!xs.length) return fallback;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  notes.push(
    `board scan: ${rows.length} rows, pitch ${(rows.length > 1 ? Math.round((rows[1].rect[1] - rows[0].rect[1]) * H) : 0)}px, ` +
    `label ${labelW}px (${(labelW / Math.max(1, bx1 - bx0)).toFixed(4)} of board), gap ${rowGapPx}px, ` +
    `tiles ${rows.map((r) => r.thumbs.length).join("/")}`,
  );

  return {
    board: [bx0 / W, boardTop / H, (bx1 - bx0 + 1) / W, (boardBottom - boardTop + 1) / H],
    rows,
    labelRatio: labelW / Math.max(1, bx1 - bx0 + 1),
    rowGap: rowGapPx / H,
    slotBackground: toHex(slotBg),
    boardBackground: toHex(boardBg),
    // The median across rows, not the first row's: a caption that overhangs the top row lands
    // inside its plate and reads as a letter three times the height of the real one.
    letterCapRatio: (() => {
      const xs = rows.map((r) => r.letterRatio).filter((v): v is number => typeof v === "number");
      return xs.length ? mid(xs, 0.22) : null;
    })(),
    letterInk: (() => {
      const inks = rows.map((r) => r.ink).filter((v): v is string => !!v);
      if (!inks.length) return null;
      const ch = (i: number) => mid(inks.map((h) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)), 40);
      return toHex([ch(0), ch(1), ch(2)]);
    })(),
    thumb: {
      heightRatio: Math.min(1, mid(tileHeights, 0.945)),
      aspect: mid(tileAspects, 1),
      gap: mid(tileGaps, 0.0055),
      padX: mid(tilePads, 0),
    },
    notes,
  };
}

/** What is covering the board that is not the board.
 *
 *  The reference drops photographs over its tier list — hair gel and a trophy, a Greek statue,
 *  a mocked-up Instagram profile — for a couple of seconds each. They are the film's whole
 *  action, and the pipeline was throwing them away: a rule in the composer skipped any region
 *  whose id looked like "board-overlay", because in one earlier capture that id had been a
 *  duplicate of the board. Here it is the insert layer, and dropping it left a static board
 *  under a talking head.
 *
 *  An insert is found the same way everything else here is: by what it is NOT. The board is
 *  flat colour — plates on the left, one charcoal behind the tiles — so anything covering a
 *  large part of the board's HEIGHT in a given column is something that was put on top of it.
 *  Tiles fail that test by construction: a tile is one row tall, an insert is several.
 *
 *  Returns the box the insert occupies, or null when the board is just the board.
 */
export function scanOverlay(px: Pixels, board: BoardMeasure, opts: { minWidth?: number } = {}): Rect | null {
  const W = px.width, H = px.height;
  const x0 = Math.max(0, Math.round(board.board[0] * W));
  const x1 = Math.min(W - 1, Math.round((board.board[0] + board.board[2]) * W));
  if (x1 - x0 < 40 || board.rows.length < 2) return null;

  const hex2rgb = (h: string, fallback: RGB): RGB => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h);
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const boardBg = hex2rgb(board.boardBackground, [20, 20, 22]);
  const slotBg = hex2rgb(board.slotBackground, [43, 43, 47]);
  const labelRight = x0 + board.labelRatio * (x1 - x0);
  const plateAt = (y: number): RGB => {
    const row = board.rows.find((r) => y >= r.rect[1] * H && y <= (r.rect[1] + r.rect[3]) * H);
    return row ? hex2rgb(row.fill, slotBg) : slotBg;
  };

  // The rules BETWEEN the rows, and nothing else. An insert is laid over the board and covers
  // them; a thumbnail cannot, because a thumbnail is one row tall and the rule is the edge of
  // its row. Looking at the board as a whole instead read the column of first thumbnails —
  // one per row, five rows — as an insert running the height of the board.
  const gaps: number[] = [];
  for (let i = 1; i < board.rows.length; i++) {
    const prevBottom = (board.rows[i - 1].rect[1] + board.rows[i - 1].rect[3]) * H;
    const top = board.rows[i].rect[1] * H;
    const mid = Math.round((prevBottom + top) / 2);
    if (mid > 0 && mid < H) gaps.push(mid);
  }
  if (!gaps.length) return null;

  const minRun = Math.max(20, Math.round((x1 - x0) * (opts.minWidth ?? 0.12)));
  // The longest covered stretch of any rule, and which rule it was on. The vertical reach is
  // measured from THERE — measured failure: starting from the first rule in the list and
  // finding the board perfectly intact at it, because the insert was two rules lower.
  let left = -1, right = -1, crossed = 0;
  let seed: { y: number; cx: number; width: number } | null = null;
  for (const y of gaps) {
    let runStart = -1;
    let best: [number, number] | null = null;
    for (let x = x0; x <= x1 + 1; x++) {
      const odd = x <= x1 && dist(pixelAt(px, x, y), boardBg) > 60;
      if (odd && runStart < 0) runStart = x;
      if (!odd && runStart >= 0) {
        if (x - runStart >= minRun && (!best || x - runStart > best[1] - best[0])) best = [runStart, x - 1];
        runStart = -1;
      }
    }
    if (!best) continue;
    crossed++;
    if (left < 0 || best[0] < left) left = best[0];
    if (best[1] > right) right = best[1];
    const width = best[1] - best[0];
    if (!seed || width > seed.width) seed = { y, cx: Math.round((best[0] + best[1]) / 2), width };
  }
  if (crossed === 0 || left < 0 || !seed) return null;

  // How far the card reaches above and below that rule — measured a ROW at a time, not down
  // one column. A photograph is not uniformly unlike a dark board: walking down the middle of
  // a picture of black hair, the walk decided the card had ended after fifty pixels. Most of
  // a row being unlike the board is a fact about the row, and survives a dark patch in it.
  const boardTop = Math.round(board.board[1] * H);
  const boardBot = Math.round((board.board[1] + board.board[3]) * H);
  const rowIsCard = (y: number) => {
    let odd = 0, n = 0;
    for (let x = left; x <= right; x += 2) {
      const expect = x < labelRight ? plateAt(y) : slotBg;
      n++;
      if (dist(pixelAt(px, x, y), expect) > 70) odd++;
    }
    return n > 0 && odd / n > 0.6;
  };
  const SLACK = 6;
  let top = seed.y, bot = seed.y;
  for (let y = seed.y, miss = 0; y - 1 >= boardTop; y--) {
    if (rowIsCard(y - 1)) { top = y - 1; miss = 0; } else if (++miss > SLACK) break;
  }
  for (let y = seed.y, miss = 0; y + 1 <= boardBot; y++) {
    if (rowIsCard(y + 1)) { bot = y + 1; miss = 0; } else if (++miss > SLACK) break;
  }
  if (bot - top < (boardBot - boardTop) * 0.08) return null;

  return [left / W, top / H, (right - left + 1) / W, (bot - top + 1) / H];
}

/** What a run of words actually occupies, and how big it is set.
 *
 *  Locate answers "the caption is about here" and is routinely half the size of the words —
 *  measured on the reference: a box 40px tall around lettering with a 36px cap height, which
 *  then had the type shrunk to fit the box it was wrongly given. A model asked for a font
 *  size answers with one that looks plausible; the glyphs themselves are on the frame and can
 *  be counted, exactly like the board.
 *
 *  `ink` is the colour the recipe says the words are, so this is not a white-text detector —
 *  it finds whatever colour was reported, dark title on a cream plate included.
 *
 *  Nothing is returned unless the result looks like lettering: a run that fills most of the
 *  window, or one that spans a handful of pixels, is something else in the frame and the
 *  located box is the better answer.
 */
export function scanInkLines(
  px: Pixels, seed: Rect, ink: string,
  opts: { grow?: number; tolerance?: number; stroke?: string | null } = {},
): { rect: Rect; lines: number; capHeight: number } | null {
  const W = px.width, H = px.height;
  const parse = (h: string): RGB | null => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const target = parse(ink);
  if (!target) return null;
  const stroke = opts.stroke ? parse(opts.stroke) : null;
  const tol = opts.tolerance ?? 90;
  const grow = opts.grow ?? 0.6;

  const seedH = seed[3] * H;
  const y0 = Math.max(0, Math.round((seed[1] * H) - seedH * grow));
  const y1 = Math.min(H - 1, Math.round(((seed[1] + seed[3]) * H) + seedH * grow));
  const x0 = Math.max(0, Math.round((seed[0] - seed[2] * 0.15) * W));
  const x1 = Math.min(W - 1, Math.round((seed[0] + seed[2] * 1.15) * W));
  if (y1 - y0 < 6 || x1 - x0 < 20) return null;

  // When the words are outlined, the outline is what tells them apart from everything else
  // the same colour. Measured: a white laptop behind the presenter sits four pixels above a
  // white caption, and without this test it was read as the caption's first line.
  const reach = Math.max(3, Math.round(seedH * 0.3));
  const isInk = (x: number, y: number): boolean => {
    if (dist(pixelAt(px, x, y), target) >= tol) return false;
    if (!stroke) return true;
    for (const [dx, dy] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (dist(pixelAt(px, nx, ny), stroke) < tol) return true;
    }
    return false;
  };

  const rowInk: number[] = [];
  for (let y = y0; y <= y1; y++) {
    let n = 0;
    for (let x = x0; x <= x1; x++) if (isInk(x, y)) n++;
    rowInk.push(n);
  }
  const runs: { start: number; end: number }[] = [];
  let s = -1;
  rowInk.forEach((n, i) => {
    const on = n >= 4;
    if (on && s < 0) s = i;
    if (!on && s >= 0) { if (i - s >= 4) runs.push({ start: y0 + s, end: y0 + i - 1 }); s = -1; }
  });
  if (s >= 0 && rowInk.length - s >= 4) runs.push({ start: y0 + s, end: y1 });
  if (!runs.length) return null;

  // Lines of ONE run of words are the runs that sit inside the located box; anything else in
  // the window is something else on screen — the reference's caption overhangs a white tile,
  // and taking every run would have measured the tile as a second line.
  const seedTop = seed[1] * H, seedBot = (seed[1] + seed[3]) * H;
  const inSeed = runs.filter((r) => r.end >= seedTop - seedH * 0.25 && r.start <= seedBot + seedH * 0.25);
  const near = inSeed.length ? inSeed : [runs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))];
  // Lines of one run of words are all set at one size, so a run that is half again as tall as
  // the others is not a line of it. Measured: the caption overhangs a white thumbnail, and
  // without this the tile was read as a second line — which made the caption wrap in two.
  const primary = near.reduce((a, b) => {
    const mid = (seedTop + seedBot) / 2;
    const da = a.start <= mid && a.end >= mid ? 0 : Math.min(Math.abs(a.start - mid), Math.abs(a.end - mid));
    const db = b.start <= mid && b.end >= mid ? 0 : Math.min(Math.abs(b.start - mid), Math.abs(b.end - mid));
    return db < da ? b : a;
  });
  const primaryH = primary.end - primary.start + 1;
  const extent = (r: { start: number; end: number }): { min: number; max: number } => {
    let min = x1, max = x0;
    for (let y = r.start; y <= r.end; y++) {
      for (let x = x0; x <= x1; x++) if (isInk(x, y)) { if (x < min) min = x; if (x > max) max = x; }
    }
    return { min, max };
  };
  const primaryX = extent(primary);
  // Another line of the SAME words is set at the same size, sits a line apart, and stands
  // over roughly the same stretch of the frame. Anything else that happens to be this colour
  // fails one of the three.
  const kept = near.filter((r) => {
    if (r === primary) return true;
    const h = r.end - r.start + 1;
    if (h < primaryH * 0.55 || h > primaryH * 1.6) return false;
    const gap = r.start > primary.end ? r.start - primary.end : primary.start - r.end;
    if (gap > primaryH * 1.2) return false;
    const e = extent(r);
    const over = Math.min(e.max, primaryX.max) - Math.max(e.min, primaryX.min);
    return over > (primaryX.max - primaryX.min) * 0.4;
  });
  const chosen = kept.sort((a, b) => a.start - b.start);
  if (!chosen.length) return null;

  const top = chosen[0].start, bot = chosen[chosen.length - 1].end;
  if (bot - top > (y1 - y0) * 0.9) return null;

  let minx = x1, maxx = x0;
  for (const r of chosen) {
    const e = extent(r);
    if (e.min < minx) minx = e.min;
    if (e.max > maxx) maxx = e.max;
  }
  if (maxx - minx < W * 0.08) return null;

  const heights = chosen.map((r) => r.end - r.start + 1).sort((a, b) => a - b);
  const capHeight = heights[Math.floor(heights.length / 2)];
  return {
    rect: [minx / W, top / H, (maxx - minx + 1) / W, (bot - top + 1) / H],
    lines: chosen.length,
    capHeight,
  };
}

/** Snap a located band to the edges of the flat plate inside it, and report its colour.
 *
 *  Locate answers a title bar to within a few pixels, and a few pixels of the footage left
 *  showing above a cream plate reads as a mistake rather than as a measurement error. The
 *  band is searched, not assumed: if there is no flat plate in there, nothing is returned and
 *  the located box stands. */
export function scanPlate(px: Pixels, band: Rect): { rect: Rect; fill: string } | null {
  const W = px.width, H = px.height;
  const x0 = Math.max(0, Math.round(band[0] * W));
  const x1 = Math.min(W - 1, Math.round((band[0] + band[2]) * W));
  const y0 = Math.max(0, Math.round((band[1] - band[3] * 0.5) * H));
  const y1 = Math.min(H - 1, Math.round((band[1] + band[3] * 1.5) * H));
  if (x1 - x0 < 20 || y1 - y0 < 6) return null;
  const fill = modalColour(px, [band[0], band[1], band[2], band[3]]);
  if (!fill) return null;
  // Down a column, not across a line. A title bar is mostly words in the middle of its
  // height, so a horizontal test fails exactly where the plate is thickest — measured: a
  // 95px cream bar came back as 19px, because the two lines of type interrupted it. The
  // margin beside the words is uninterrupted plate, so the column that is most plate is the
  // one to measure down.
  const centre = Math.round((band[1] + band[3] / 2) * H);
  const colScore = (x: number) => {
    let on = 0, n = 0;
    const y0b = Math.round(band[1] * H), y1b = Math.round((band[1] + band[3]) * H);
    for (let y = y0b; y <= y1b; y++) { n++; if (dist(pixelAt(px, x, y), fill) < 48) on++; }
    return n ? on / n : 0;
  };
  let probe = -1;
  for (let x = x0; x <= x1; x += Math.max(1, Math.round((x1 - x0) / 120))) {
    if (colScore(x) > 0.9) { probe = x; break; }
  }
  if (probe < 0) return null;
  const isPlateLine = (y: number) => dist(pixelAt(px, probe, y), fill) < 48;
  if (!isPlateLine(centre)) return null;
  let top = centre, bot = centre;
  while (top - 1 >= y0 && isPlateLine(top - 1)) top--;
  while (bot + 1 <= y1 && isPlateLine(bot + 1)) bot++;
  if (bot - top < 6) return null;
  return { rect: [x0 / W, top / H, (x1 - x0 + 1) / W, (bot - top + 1) / H], fill: toHex(fill) };
}
