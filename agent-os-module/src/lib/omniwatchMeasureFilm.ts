// Pixel measure on a SOURCE frame — structural geometry from the film itself.
// Tier-list: white title band + pastel left column → 5 equal rows. No Hypit code.
// Used at Omni-chosen timeline loci (prefer frames where overlays do not cover the board).

import sharp from "sharp";
import type { BlueprintRegion, Rect } from "@/lib/omniwatchBlueprint";

export type FilmMeasure = {
  regions: BlueprintRegion[];
  notes: string[];
  banner: Rect;
  board: Rect;
  labelW: number;
};

function rgb(data: Buffer, w: number, x: number, y: number): [number, number, number] {
  const i = (y * w + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

function rowWhiteFrac(data: Buffer, w: number, y: number): number {
  let hit = 0, n = 0;
  for (let x = 0; x < w; x += 2) {
    const [R, G, B] = rgb(data, w, x, y);
    const L = 0.299 * R + 0.587 * G + 0.114 * B;
    const sat = Math.max(R, G, B) - Math.min(R, G, B);
    if ((L > 200 && sat < 40) || (L < 50 && sat < 40)) hit++;
    n++;
  }
  return hit / n;
}

function leftColor(data: Buffer, w: number, y: number, x1: number) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let x = 2; x < x1; x += 2) {
    const [R, G, B] = rgb(data, w, x, y);
    r += R; g += G; b += B; n++;
  }
  r /= n; g /= n; b /= n;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  const L = 0.299 * r + 0.587 * g + 0.114 * b;
  return { r, g, b, sat, L };
}

function hex(r: number, g: number, b: number) {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Measure tier-list structure from one decoded frame buffer. */
export function measureTierListPixels(data: Buffer, w: number, h: number): FilmMeasure {
  const notes: string[] = [];

  // Banner: white/cream paper (+ black ink) band under optional dark status strip.
  let y = 0;
  while (y < h * 0.05 && rowWhiteFrac(data, w, y) < 0.55) y++;
  const bTop = y;
  while (y < h * 0.25 && rowWhiteFrac(data, w, y) > 0.45) y++;
  const bBot = Math.max(bTop + Math.floor(h * 0.04), y);
  const banner: Rect = [0, bTop / h, 1, (bBot - bTop) / h];
  notes.push(
    `film banner [0,${banner[1].toFixed(3)},1,${banner[3].toFixed(3)}] from white-band scan`,
  );

  // Board top: first pastel left-column cell in lower half.
  const xProbe = Math.floor(w * 0.18);
  let boardTopPx = -1;
  for (let yy = Math.floor(h * 0.45); yy < h * 0.95; yy++) {
    const c = leftColor(data, w, yy, xProbe);
    if (c.sat > 40 && c.L > 80 && c.L < 210) {
      boardTopPx = yy;
      break;
    }
  }
  if (boardTopPx < 0) {
    notes.push("film: no pastel tier column found — cannot measure board from pixels");
    return {
      regions: [],
      notes,
      banner,
      board: [0, 0.56, 1, 0.44],
      labelW: 0.14,
    };
  }

  // Label width: walk right from pastel until dark board / thumb.
  const midY = Math.min(h - 2, boardTopPx + Math.floor((h - boardTopPx) / 10));
  let x = 4;
  for (; x < w * 0.4; x++) {
    const [R, G, B] = rgb(data, w, x, midY);
    const sat = Math.max(R, G, B) - Math.min(R, G, B);
    const L = 0.299 * R + 0.587 * G + 0.114 * B;
    if (x > w * 0.08 && (L < 55 || (sat < 20 && L < 100))) break;
  }
  // Cap label column — Hypit refs are ~15–20% wide; overshoot usually ate first thumb.
  const labelW = Math.min(0.2, Math.max(0.1, x / w));

  const boardTop = boardTopPx / h;
  const boardH = 1 - boardTop;
  const board: Rect = [0, boardTop, 1, boardH];
  const rowH = boardH / 5;
  notes.push(
    `film board [0,${boardTop.toFixed(3)},1,${boardH.toFixed(3)}] labelW=${labelW.toFixed(3)} 5×equal rows from pixels`,
  );

  const letters = ["s", "a", "b", "c", "d"] as const;
  const regions: BlueprintRegion[] = [
    {
      id: "top-banner",
      role: "text",
      rect: banner,
      z: 5,
      paint: { fill: "#ffffff" },
      label: "title banner measured from film",
    },
    {
      id: "presenter-stage",
      role: "figure",
      rect: [0, bBot / h, 1, Math.max(0.1, boardTop - bBot / h)],
      z: 1,
      label: "host stage between banner and board",
    },
    {
      id: "caption-area",
      role: "text",
      rect: [0.08, Math.max(bBot / h, boardTop - 0.055), 0.84, 0.055],
      z: 10,
      label: "caption band just above board",
    },
    {
      id: "tier-board",
      role: "panel",
      rect: board,
      z: 2,
      paint: { fill: "#1a1a1a" },
      grid: { rows: 5, cols: 2 },
      label: "tier board measured from film",
    },
  ];

  for (let i = 0; i < 5; i++) {
    const y0 = boardTop + i * rowH;
    const sampleY = Math.min(h - 1, Math.floor((y0 + rowH * 0.5) * h));
    const col = leftColor(data, w, sampleY, Math.floor(w * labelW * 0.85));
    const fill = hex(col.r, col.g, col.b);
    regions.push({
      id: `${letters[i]}-label`,
      role: "cell",
      parent: "tier-board",
      at: { row: i + 1, col: 1 },
      rect: [0, y0, labelW, rowH],
      z: 3,
      paint: { fill, border: { color: "#000000", width: 0.012 } },
      label: `tier ${letters[i]!.toUpperCase()} label`,
    });
    regions.push({
      id: `${letters[i]}-slot`,
      role: "cell",
      parent: "tier-board",
      at: { row: i + 1, col: 2 },
      rect: [labelW, y0, 1 - labelW, rowH],
      z: 3,
      paint: { fill: "#1a1a1a", border: { color: "#000000", width: 0.01 } },
      label: `tier ${letters[i]!.toUpperCase()} thumbs`,
    });
  }

  // Floating inset: high edge-energy square in upper-left of stage (optional).
  const sy0 = bBot + 8;
  const sy1 = Math.floor(boardTopPx - 8);
  const sx0 = Math.floor(w * 0.02);
  const sx1 = Math.floor(w * 0.4);
  const win = Math.floor(w * 0.17);
  let best: { x: number; y: number; score: number } | null = null;
  const lumAt = (xx: number, yy: number) => {
    const [R, G, B] = rgb(data, w, xx, yy);
    return 0.299 * R + 0.587 * G + 0.114 * B;
  };
  if (sy1 - sy0 > win && sx1 - sx0 > win) {
    for (let yy = sy0; yy < sy1 - win; yy += 6) {
      for (let xx = sx0; xx < sx1 - win; xx += 6) {
        let edge = 0, n = 0;
        for (let k = 0; k < win; k += 4) {
          edge += Math.abs(lumAt(xx + k, yy) - lumAt(xx + k, yy + win - 1));
          edge += Math.abs(lumAt(xx, yy + k) - lumAt(xx + win - 1, yy + k));
          n += 2;
        }
        const score = edge / n;
        if (!best || score > best.score) best = { x: xx, y: yy, score };
      }
    }
  }
  if (best && best.score > 28) {
    regions.push({
      id: "inset-card",
      role: "figure",
      rect: [best.x / w, best.y / h, win / w, win / h],
      z: 4,
      paint: { fill: "#ffffff", radius: 0.12 },
      label: "floating inset measured from film",
    });
    notes.push(
      `film inset-card [${(best.x / w).toFixed(3)},${(best.y / h).toFixed(3)},${(win / w).toFixed(3)},${(win / h).toFixed(3)}]`,
    );
  }

  return { regions, notes, banner, board, labelW };
}

/** Load a JPEG/PNG frame and measure tier-list geometry. */
export async function measureTierListFrame(framePath: string): Promise<FilmMeasure> {
  const { data, info } = await sharp(framePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return measureTierListPixels(data, info.width, info.height);
}
