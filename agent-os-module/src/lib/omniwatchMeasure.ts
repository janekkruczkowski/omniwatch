// Measure layer — geometry from the SOURCE film at Omni-chosen timeline loci.
//
// Contract (Janek 2026-09-21):
//   Omni understands WHAT is on screen and WHEN the layout changes.
//   Measure samples the ORIGINAL video at those times and returns boxes.
//   Authored TierList templates are NOT a substitute for measuring the film.
//
// Inspired by Hypit / VideoUse / Qwen grounding *ideas*. No Hypit code.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateBlueprint,
  type Blueprint,
  type BlueprintRegion,
  type BlueprintTrack,
  type Rect,
} from "@/lib/omniwatchBlueprint";
import {
  refineBlueprint,
  targetsFromBlueprint,
  applyRecipeToBlueprint,
  ensureInsetAlias,
  chunkCaptionsToBand,
  fitSlotItemsToTiles,
  measureInserts,
  type GroundHit,
  type StyleRecipe,
  type RegionOrigin,
  type RegionOrigins,
} from "@/lib/omniwatchGround";
import type { BoardMeasure } from "@/lib/omniwatchBoardScan";
import { FACE_WIDTHS } from "@/lib/omniwatchRecipe";
import { wordTimes, recutCaptions, measureCueRate, captionFromSpeech, snapCaptionsToWords, snapSpansToWords, landItemsOnWords } from "@/lib/omniwatchCues";
import { runNode, type Node, type GateRecord } from "@/lib/omniwatchNode";
import { scanCaptionBand } from "@/lib/omniwatchBandScan";

/** How many other moments to look for a caption band in before giving up on measuring it.
 *  Each one is a locate call, so the number is small and the spacing is wide. */
const CAPTION_RETRIES = 2;

export type LayoutFormat = "tier-list-9x16" | "unknown";

export type LayoutSegment = {
  /** Seconds on the source timeline where this geometry was measured. */
  at: number;
  /** Inclusive start of the span this layout covers (until next segment). */
  start: number;
  /** Exclusive end. */
  end: number;
  regions: BlueprintRegion[];
  hits: GroundHit[];
};

export type MeasureResult =
  | {
      ok: true;
      format: LayoutFormat;
      blueprint: Blueprint;
      /** Primary layout (first / dominant segment). */
      layout: { format: LayoutFormat; regions: BlueprintRegion[]; source: "film" };
      /** All measured layouts along the timeline. */
      segments: LayoutSegment[];
      contentTracks: number;
      /** How the format looks, as the recipe the compositor draws from. */
      recipe: StyleRecipe | null;
      notes: string[];
      /** Every gate this run drove through omniwatchNode, in the order it ran. */
      log: GateRecord[];
      frame?: string;
      loci: number[];
    }
  | { ok: false; error: string; status?: number };

const REGION_ALIASES: Record<string, string[]> = {
  "top-banner": ["top-banner", "title-banner", "title", "title-bar", "banner"],
  "presenter-stage": ["presenter-stage", "presenter", "host", "host-stage", "figure"],
  "caption-area": ["caption-area", "caption", "caption-band", "captions"],
  "tier-board": ["tier-board", "tier-list", "board"],
  "s-label": ["s-label", "tier-s-label"],
  "a-label": ["a-label", "tier-a-label"],
  "b-label": ["b-label", "tier-b-label"],
  "c-label": ["c-label", "tier-c-label"],
  "d-label": ["d-label", "tier-d-label"],
  "s-slot": ["s-slot", "tier-s-slot"],
  "a-slot": ["a-slot", "tier-a-slot"],
  "b-slot": ["b-slot", "tier-b-slot"],
  "c-slot": ["c-slot", "tier-c-slot"],
  "d-slot": ["d-slot", "tier-d-slot"],
  "inset-card": ["inset-card", "cr7-portrait", "messi-portrait", "floating-photo", "inset-ronaldo", "inset"],
};

export function detectFormat(bp: Blueprint): LayoutFormat {
  const ids = bp.regions.map((r) => `${r.id} ${r.label || ""} ${r.role}`).join(" ").toLowerCase();
  const hasTier =
    /tier[-_ ]?(list|board)|leaderboard/.test(ids) ||
    (bp.regions.some((r) => /^(s|a|b|c|d)[-_]?label$/i.test(r.id)) &&
      bp.regions.some((r) => /slot|board|panel/i.test(r.id)));
  if (hasTier) return "tier-list-9x16";
  return "unknown";
}

/**
 * Omni's job: say WHEN layout should be measured on the timeline.
 * Prefer explicit layoutAt / layoutKeyframes if present; else cluster item
 * boundaries where many tracks switch together (layout cut); else one mid sample
 * when the film looks geometrically static.
 */
export function layoutLociFromOmni(bp: Blueprint): { loci: number[]; notes: string[] } {
  const notes: string[] = [];
  const seconds = Math.max(0.1, bp.canvas.seconds);
  const raw = bp as Blueprint & {
    layoutAt?: unknown;
    layoutKeyframes?: unknown;
  };

  const explicit: number[] = [];
  for (const key of ["layoutAt", "layoutKeyframes"] as const) {
    const v = raw[key];
    if (Array.isArray(v)) {
      for (const n of v) {
        if (typeof n === "number" && Number.isFinite(n)) explicit.push(n);
        else if (typeof n === "object" && n && typeof (n as { t?: number }).t === "number") {
          explicit.push((n as { t: number }).t);
        }
      }
    }
  }
  if (explicit.length) {
    const loci = uniqSorted(
      explicit.map((t) => clamp(t, 0, seconds - 0.05)),
    ).slice(0, 8);
    notes.push(`measure loci from Omni layoutAt/keyframes: ${loci.map((t) => t.toFixed(2)).join(", ")}`);
    return { loci, notes };
  }

  // Count how many tracks start/end at each boundary — a burst ≈ possible layout cut.
  const counts = new Map<number, number>();
  for (const t of bp.tracks) {
    for (const it of t.items) {
      const a = roundTenths(it.start);
      const b = roundTenths(it.end);
      counts.set(a, (counts.get(a) || 0) + 1);
      counts.set(b, (counts.get(b) || 0) + 1);
    }
  }
  const busy = [...counts.entries()]
    .filter(([t, c]) => t > 0.05 && t < seconds - 0.05 && c >= Math.max(3, Math.ceil(bp.tracks.length * 0.35)))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([t]) => t);

  if (busy.length >= 2) {
    // Measure just after each candidate cut, plus a mid if gaps are large.
    const loci = uniqSorted(
      busy.slice(0, 5).map((t) => clamp(t + 0.15, 0, seconds - 0.05)),
    );
    notes.push(
      `measure loci from Omni track-boundary bursts (layout may change): ${loci.map((t) => t.toFixed(2)).join(", ")}`,
    );
    return { loci, notes };
  }

  // Static geometry film (this Hypit ranking): one sample mid-clip is enough.
  const mid = clamp(seconds * 0.35, 0.05, seconds - 0.05);
  notes.push(
    `measure loci: single sample t=${mid.toFixed(2)} — Omni track boundaries look geometrically static (not one-frame-forever policy; more loci if Omni marks layoutAt)`,
  );
  return { loci: [mid], notes };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function roundTenths(n: number) {
  return Math.round(n * 10) / 10;
}
function uniqSorted(xs: number[]) {
  return [...new Set(xs.map((n) => Math.round(n * 100) / 100))].sort((a, b) => a - b);
}

function rectDist(a: Rect, b: Rect) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
}

function layoutsSimilar(a: BlueprintRegion[], b: BlueprintRegion[], eps = 0.08) {
  const mb = new Map(b.map((r) => [r.id, r]));
  let compared = 0;
  for (const r of a) {
    const o = mb.get(r.id);
    if (!o) continue;
    compared++;
    if (rectDist(r.rect, o.rect) > eps) return false;
  }
  return compared > 0;
}

function mapTrackRegion(region: string, layoutIds: Set<string>): string | null {
  if (layoutIds.has(region)) return region;
  for (const [canonical, aliases] of Object.entries(REGION_ALIASES)) {
    if (aliases.includes(region) && layoutIds.has(canonical)) return canonical;
  }
  for (const id of layoutIds) {
    if (region.includes(id) || id.includes(region)) return id;
  }
  return null;
}

/** Merge Omni content onto measured (film) geometry — words/timing from Omni, rects from film. */
export function mergeContentOntoLayout(
  layoutRegions: BlueprintRegion[],
  omni: Blueprint,
  notes: string[],
): { regions: BlueprintRegion[]; tracks: BlueprintTrack[] } {
  const layoutIds = new Set(layoutRegions.map((r) => r.id));
  const omniByRegion = new Map<string, BlueprintTrack[]>();
  for (const t of omni.tracks) {
    const list = omniByRegion.get(t.region) ?? [];
    list.push(t);
    omniByRegion.set(t.region, list);
  }

  const tracks: BlueprintTrack[] = [];
  const usedOmni = new Set<string>();

  for (const lr of layoutRegions) {
    let matched: BlueprintTrack[] = [];
    for (const [oid, ots] of omniByRegion) {
      const mapped = mapTrackRegion(oid, layoutIds);
      if (mapped === lr.id) {
        matched = matched.concat(ots);
        usedOmni.add(oid);
      }
    }
    if (!matched.length) {
      if (/^[sabcd]-label$/i.test(lr.id)) {
        const letter = lr.id[0]!.toUpperCase();
        tracks.push({
          region: lr.id,
          kind: "text",
          varies: "fixed",
          fill: "draw",
          style: {
            color: "#000000",
            font: "display",
            weight: 400, // League Gothic is already heavy; 900 blobs the glyph
            size: Math.round(lr.rect[3] * 0.72 * 1000) / 1000, // Hypit letters fill most of the pastel rect
            align: "center",
            case: "upper",
          },
          items: [{ start: 0, end: omni.canvas.seconds, value: letter }],
        });
        notes.push(`layout "${lr.id}" drew letter ${letter} — Omni had no track`);
      }
      continue;
    }
    for (const ot of matched) {
      const nt: BlueprintTrack = {
        ...ot,
        region: lr.id,
        items: ot.items.map((it) => ({ ...it })),
      };
      if (nt.kind === "text" && nt.style) {
        const st = { ...nt.style };
        if (lr.id === "top-banner" && st.background) {
          notes.push(`content→layout: stripped title word-plate on "${lr.id}"`);
          delete st.background;
        }
        if (/^[sabcd]-label$/i.test(lr.id)) {
          st.font = "display";
          st.weight = 400;
          st.size = Math.round(lr.rect[3] * 0.72 * 1000) / 1000;
          st.align = "center";
          delete st.background;
        }
        nt.style = st;
      }
      tracks.push(nt);
    }
  }

  // The overlay layer is NOT junk, and calling it that cost this pipeline the film.
  //
  // A capture writes its timed inserts — the photographs a tier list drops over its board for
  // two seconds at a time — under the id "board-overlay". One early capture used the same id
  // for a full-board bitmap, which drew a second set of tier letters under the real ones, so a
  // filter was added here to throw the id away. It has been throwing away the insert layer
  // ever since: five timed pictures, the only thing that moves in the whole format.
  //
  // What is dropped now is the case the filter was written for, told apart by what it is: a
  // track of pictures that each cover the board is a copy of the board. Anything smaller is
  // the film.
  const boardRegion = layoutRegions.find((r) => /tier-board|tier-list/i.test(r.id) && !/overlay/i.test(r.id));
  const boardArea = boardRegion ? boardRegion.rect[2] * boardRegion.rect[3] : 0.3;
  const isBoardCopy = (id: string) => {
    const r = layoutRegions.find((x) => x.id === id);
    if (!r) return true;
    return r.rect[2] * r.rect[3] >= boardArea * 0.9;
  };
  const drop = new Set(
    layoutRegions.filter((r) => /board-overlay|insert-overlay|backdrop/i.test(r.id) && isBoardCopy(r.id)).map((r) => r.id),
  );
  const cleanRegions = layoutRegions.filter((r) => !drop.has(r.id));
  const cleanTracks = tracks.filter((t) => !drop.has(t.region));
  for (const id of drop) {
    notes.push(`dropped "${id}" — it covers the whole board, so it is a copy of it, not an insert`);
  }
  const kept = layoutRegions.filter((r) => /board-overlay|insert-overlay/i.test(r.id) && !drop.has(r.id));
  for (const r of kept) {
    notes.push(`kept the insert layer "${r.id}" — the pictures this film lays over its board`);
  }
  notes.push(
    `measure merge: ${cleanTracks.length} content tracks onto ${cleanRegions.length} FILM-measured regions`,
  );
  return { regions: cleanRegions, tracks: cleanTracks };
}

/**
 * Measure = Omni loci → sample SOURCE frames → boxes from film → merge content.
 * sourcePath is REQUIRED. Without the film we refuse to invent geometry.
 */
/** How many characters of this format's caption fit across its band.
 *
 *  The same arithmetic the width-based chunker uses, lifted out so the re-cut and the
 *  fallback cannot drift apart: the band's width in pixels over the width of one character
 *  at the size the letters were measured to be. */
function captionBudget(bp: Blueprint, recipe: StyleRecipe): number {
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  const type = (recipe as { caption?: { type?: { size?: number; face?: string } } }).caption?.type;
  if (!caption || !type?.size) return 0;
  const px = type.size * bp.canvas.height;
  const perChar = px * (FACE_WIDTHS[(type.face ?? "grotesque") as keyof typeof FACE_WIDTHS] ?? 0.5);
  return Math.max(6, Math.floor((caption.rect[2] * bp.canvas.width * 0.94) / perChar));
}

export async function measureBlueprint(
  omniBp: Blueprint,
  opts: { sourcePath?: string; workDir?: string; at?: number[] } = {},
): Promise<MeasureResult> {
  const notes: string[] = [];
  const log: GateRecord[] = [];
  const checkedIn = validateBlueprint(omniBp, { preserveGeometry: true });
  if (!checkedIn.ok) return { ok: false, error: checkedIn.error, status: 400 };
  const omni = checkedIn.blueprint;
  notes.push(...checkedIn.notes);

  if (!opts.sourcePath) {
    return {
      ok: false,
      error:
        "measure needs the source film (sourcePath / sourceId) — we do not invent geometry from an authored template",
      status: 400,
    };
  }

  const format = detectFormat(omni);
  notes.push(`measure format hint=${format} (from Omni semantics; geometry still from film)`);

  const { loci: autoLoci, notes: locusNotes } = layoutLociFromOmni(omni);
  notes.push(...locusNotes);
  const loci = (opts.at?.length ? opts.at : autoLoci).map((t) =>
    clamp(t, 0, Math.max(0.05, omni.canvas.seconds - 0.05)),
  );

  const workDir = opts.workDir || path.join("/tmp", `omni-measure-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  const segments: LayoutSegment[] = [];
  // Provenance per segment, index-aligned with `segments` — a region's origin as of the pass
  // that grounded that segment. Kept local rather than folded into `LayoutSegment` itself:
  // nothing outside the caption-band gate below needs to ask "was this measured", and
  // `LayoutSegment` is written to `layout.json` and read by other code that has no reason to
  // learn a new field for a question only this gate is asking.
  const segmentOrigins: RegionOrigins[] = [];
  let lastFrame: string | undefined;
  let lastRecipe: StyleRecipe | null = null;
  let lastMeasure: BoardMeasure | null = null;

  for (let i = 0; i < loci.length; i++) {
    const at = loci[i]!;
    const sliceDir = path.join(workDir, `t-${at.toFixed(2)}`);
    await mkdir(sliceDir, { recursive: true });
    const grounded = await refineBlueprint(omni, opts.sourcePath, {
      at: [at],
      targets: targetsFromBlueprint(omni),
      workDir: sliceDir,
    });
    if (!grounded.ok) {
      notes.push(`locus t=${at.toFixed(2)} ground failed: ${grounded.error}`);
      continue;
    }
    notes.push(...grounded.notes.map((n) => `[t=${at.toFixed(2)}] ${n}`));
    log.push(...grounded.log);
    const start = i === 0 ? 0 : (loci[i - 1]! + at) / 2;
    const end = i === loci.length - 1 ? omni.canvas.seconds : (at + loci[i + 1]!) / 2;
    segments.push({
      at,
      start,
      end,
      regions: grounded.blueprint.regions,
      hits: grounded.hits,
    });
    segmentOrigins.push(grounded.origins);
    lastFrame = grounded.frames[0];
    if (grounded.recipe) lastRecipe = grounded.recipe;
    if (grounded.measure) lastMeasure = grounded.measure;
  }


  // ── the caption band has to be MEASURED, not inherited ──────────────────────
  //
  // The first gate written against the graph plan, and it exists because of a defect that
  // was visible on a frame and invisible in every log: locate is asked where the caption
  // band is, and when it does not answer, the band keeps the box the capture guessed. On
  // the reference that is 56% of the frame against a measured 52.8% — the line sits inside
  // the board instead of on its edge, and nothing anywhere says so.
  //
  // The gate used to test this by asking whether the box CHANGED from what Omni asked for.
  // That is the wrong test, proven wrong on this same film: with no answer possible from any
  // provider, `sanitizeCaptionVsBanner` still moved the caption away from the asked rect on
  // its own — a tidy-up pass repositioning a guess using a hard-coded board-top fraction,
  // not a measurement of anything — and a box that differs from the input for THAT reason
  // passed the old test every time. "Moved" and "measured" are not the same fact, and the
  // whole point of this gate is to keep them apart.
  //
  // So the node's `Out` carries where the box came from, not just the box: `omniwatchGround`
  // now threads a `RegionOrigins` map alongside `hits` through every pass that can change a
  // region's rect, and every tidy-up pass (`sanitizeCaptionVsBanner`, `fillPresenterBetween`,
  // `flushBannerToTop`, `ensureInsetAlias`) is deliberately left out of that threading — a
  // rect they move keeps whatever origin it already had, which for a caption locate never
  // answered is none. `accepts` reads that origin instead of comparing rects, so a nudge to
  // an untouched guess is rejected exactly when it should be, and a real locate or ink-scan
  // answer is accepted exactly when it should be too — including the ordinary case, since
  // most of the time locate or `fitTypeToInk`'s own ink measurement DOES genuinely answer,
  // and this gate has no reason to doubt work it can independently verify was done.
  //
  // `run` reuses the segment already measured on the first try, then re-grounds at another
  // moment on each retry; `retry` walks the same candidate moments the hand-written loop
  // used to, skipping any that coincide with a locus already tried.
  if (segments.length && opts.sourcePath) {
    const asked = omni.regions.find((r) => /caption/i.test(r.id));
    if (asked) {
      const sourcePath = opts.sourcePath;
      const seconds = omni.canvas.seconds;
      const tried = new Set(loci.map((t) => t.toFixed(2)));
      let nextK = 1;

      type CaptionMeasurement = { rect: Rect; origin: RegionOrigin | null };

      const captionBand: Node<number, CaptionMeasurement> = {
        name: "caption-band",
        describe: (at) => `t=${at.toFixed(2)}`,
        detail: (m) => (m ? `${m.origin}: ${JSON.stringify(m.rect.map((n) => Math.round(n * 1e4) / 1e4))}` : "no answer"),
        async run(at, attempt) {
          if (attempt === 1) {
            const got = segments[0]!.regions.find((r) => /caption/i.test(r.id));
            if (!got) return null;
            return { rect: got.rect, origin: segmentOrigins[0]?.get(got.id) ?? null };
          }
          const sliceDir = path.join(workDir, `caption-${at.toFixed(2)}`);
          await mkdir(sliceDir, { recursive: true });
          const again = await refineBlueprint(omni, sourcePath, {
            at: [at], targets: targetsFromBlueprint(omni), workDir: sliceDir,
          });
          if (!again.ok) return null;
          const got = again.blueprint.regions.find((r) => /caption/i.test(r.id));
          if (!got) return null;
          return { rect: got.rect, origin: again.origins.get(got.id) ?? null };
        },
        // The one condition that matters, and it is a fact about PROVENANCE, never about
        // whether the number is different from the one Omni guessed.
        accepts: (m) => m.origin !== null,
        // Retry changes the INPUT, not the wording: other moments of the same film, spread so
        // that a band hidden at one second is unlikely to be hidden at the next.
        retry() {
          while (nextK <= CAPTION_RETRIES) {
            const at = clamp((seconds * nextK) / (CAPTION_RETRIES + 1), 0.05, seconds - 0.05);
            nextK++;
            const key = at.toFixed(2);
            if (tried.has(key)) continue;
            tried.add(key);
            return at;
          }
          return null;
        },
      };

      const found = await runNode(captionBand, segments[0]!.at, log);
      const record = log[log.length - 1]!;
      if (found === null) {
        // GRAPH-PLAN.md §2's third step for this gate, after the frame retries above have
        // both failed: scan the film's own pixels for an ink band before giving up. Reached
        // whenever nothing above ever produced a box with a known origin — locate came back
        // empty and `fitTypeToInk` found no ink of its own at every moment tried — which is
        // the case that actually broke the reference: no answer at all, and a guess left
        // standing with nothing to say it was never measured.
        const scanned = await scanCaptionBand(sourcePath, workDir, notes);
        if (scanned) {
          for (const seg of segments) {
            seg.regions = seg.regions.map((r) => (/caption/i.test(r.id) ? { ...r, rect: [...scanned] as Rect } : r));
          }
          notes.push(`caption band origin: scanned — locate and its retries never measured anything; the whole-frame ink scan found a band on its own`);
        } else {
          notes.push("caption band origin: guess — never measured; locate, its retries and the ink scan all came back empty, so the box it keeps is the one it was given, not one that was found");
        }
      } else {
        notes.push(
          `caption band origin: ${found.origin} — ` +
          (record.attempts.length > 1
            ? `found at ${record.attempts[record.attempts.length - 1]!.input} after ${record.attempts.length} attempt(s)`
            : "found on the first attempt"),
        );
        if (record.attempts.length > 1) {
          notes.push(
            `caption band was not found at the chosen moment — measured at ${record.attempts[record.attempts.length - 1]!.input} instead: ` +
              `${JSON.stringify(found.rect.map((n) => Math.round(n * 1e4) / 1e4))}`,
          );
          for (const seg of segments) {
            seg.regions = seg.regions.map((r) => (/caption/i.test(r.id) ? { ...r, rect: [...found.rect] as Rect } : r));
          }
        }
      }
    }
  }

  if (!segments.length) {
    return {
      ok: false,
      error: `measure grounded nothing on source at loci [${loci.join(", ")}]: ${notes.slice(-6).join("; ")}`,
      status: 502,
    };
  }

  // Collapse near-identical layouts (static film → one segment).
  const unique: LayoutSegment[] = [];
  for (const seg of segments) {
    const prev = unique[unique.length - 1];
    if (prev && layoutsSimilar(prev.regions, seg.regions)) {
      prev.end = seg.end;
      notes.push(
        `locus t=${seg.at.toFixed(2)} ≈ previous layout — extended span to ${prev.end.toFixed(2)} (geometry static)`,
      );
      continue;
    }
    unique.push({ ...seg, regions: seg.regions.map((r) => ({ ...r, rect: [...r.rect] as Rect })) });
  }

  const primary = unique[0]!;
  const merged = mergeContentOntoLayout(primary.regions, omni, notes);
  let raw: Blueprint = {
    version: omni.version,
    canvas: omni.canvas,
    regions: merged.regions,
    tracks: merged.tracks,
  };
  // Omni content merge re-injects track.style — re-apply Gemini recipe after merge.
  // The words come first now, because the CUT depends on them. A caption broken before
  // anyone has listened can only be broken by counting characters, and a piece that already
  // fits the band gives a re-cut nothing to work with — the damage is done by then.
  const words = opts.sourcePath ? await wordTimes(opts.sourcePath, workDir, notes) : null;

  if (lastRecipe) {
    raw = applyRecipeToBlueprint(raw, lastRecipe, notes);
    // The merge rebuilds the tracks from Omni, which undoes the split of a row into the
    // tiles that were counted in it — the same trap as the styles, one layer down.
    raw = fitSlotItemsToTiles(raw, lastRecipe, notes);
    // Two ways to break a caption, and the better one needs a soundtrack. With word times
    // in hand the pieces come out even and the breaks land where the voice stopped; without
    // them, the band's width is the only fact available and greedy packing is what is left.
    // Two ceilings, and the film's own is usually the lower one. The band says how much
    // COULD fit; counting the band's changes says how much this format actually puts in it,
    // which on the reference is fourteen characters against a room for twenty-two. Aiming at
    // the room is how a caption ends up reading like a paragraph.
    // Before anything is cut, make sure there is something real to cut.
    if (words) raw = captionFromSpeech(raw, words, notes);
    const band = raw.regions.find((r) => /caption/i.test(r.id));
    const karaoke = Boolean((lastRecipe as { caption?: { karaoke?: unknown } }).caption?.karaoke);
    const rate = words && opts.sourcePath && band
      ? await measureCueRate(opts.sourcePath, band.rect, raw.canvas.seconds, workDir, notes)
      : null;
    if (words) {
      const room = captionBudget(raw, lastRecipe);
      const spoken = raw.tracks
        .filter((t) => t.kind === "text" && t.region === band?.id)
        .flatMap((t) => t.items).map((it) => it.value.replace(/\[\[|\]\]/g, "")).join(" ");
      if (rate) {
        // The film said how many things it puts on screen. A character budget is a CEILING,
        // and a ceiling set to the average produces pieces below it — so instead of guessing
        // a fudge factor, the ceiling is searched for: try each one, keep the one whose piece
        // count lands nearest the count the film itself showed. One measured objective, no
        // constant to tune.
        let bestCap = room, bestMiss = Infinity;
        for (let cap = 6; cap <= room; cap++) {
          const tried = recutCaptions(raw, words, cap, [], karaoke);
          const band2 = tried.regions.find((r) => /caption/i.test(r.id));
          const made = tried.tracks.filter((t) => t.kind === "text" && t.region === band2?.id)
            .reduce((n, t) => n + t.items.length, 0);
          const miss = Math.abs(made - rate.cues);
          // Ties go to the roomier ceiling: the same rhythm with calmer breaks.
          if (miss <= bestMiss) { bestMiss = miss; bestCap = cap; }
        }
        notes.push(`caption: the film changes its band ${rate.cues} time(s); a ceiling of ${bestCap} characters lands nearest that (the band itself would allow ${room})`);
        raw = recutCaptions(raw, words, bestCap, notes, karaoke);
      } else {
        raw = recutCaptions(raw, words, room, notes, karaoke);
      }
    } else {
      raw = chunkCaptionsToBand(raw, lastRecipe, notes);
    }
    // The merge rebuilds the tracks out of the capture, and the capture has no idea where its
    // inserts sit — so the boxes measured for them a moment ago are gone with everything else
    // and have to be measured again. Same trap as the styles and the tile counts, third layer.
    if (lastMeasure) raw = await measureInserts(raw, lastMeasure, opts.sourcePath, workDir, notes, log);
    notes.push("re-applied recipe, tile counts, caption chunking and insert boxes after content merge");
  }

  // The clock, last, over everything the eye settled.
  //
  // Up to here every time came from watching: the capture said roughly when a line was up,
  // and the chunker divided that span by how many letters each piece had. Both are guesses
  // about sound made from pictures. The aligner is asked once per source and its answer
  // overrides them — but only where it actually found the words, so a title nobody says
  // keeps the time it was seen with.
  if (words) {
    raw = snapCaptionsToWords(raw, words, notes);
    raw = snapSpansToWords(raw, words, notes);
    // Last, because it reads item.start and snapping is what last moved it. An item that
    // waits beside the presenter is told WHEN to stop waiting, from the pause that ends the
    // sentence it was anchored to — the number IR-CONTRACT-V2 §3 named and nothing filled,
    // which is why the icon used to appear already in motion.
    raw = landItemsOnWords(raw, words, notes);
  }
  // merge rebuilds tracks from Omni only — re-alias inset-card so the swap asset can land.
  raw = ensureInsetAlias(raw, notes);
  const checked = validateBlueprint(raw, { preserveGeometry: true });
  if (!checked.ok) {
    return { ok: false, error: `measure layout invalid: ${checked.error}`, status: 500 };
  }
  notes.push(...checked.notes);
  notes.push(
    `measure: ${unique.length} distinct layout(s) from film across ${loci.length} Omni locus/loci`,
  );

  if (opts.workDir) {
    await writeFile(
      path.join(opts.workDir, "layout.json"),
      JSON.stringify(
        {
          format,
          source: "film",
          loci,
          segments: unique.map((s) => ({
            at: s.at,
            start: s.start,
            end: s.end,
            regions: s.regions,
            hits: s.hits,
          })),
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(opts.workDir, "content-tracks.json"),
      JSON.stringify(omni.tracks, null, 2),
    );
    // Bubble recipe from first locus slice if Gemini wrote one
    try {
      const { copyFile, access } = await import("node:fs/promises");
      const sliceRecipe = path.join(workDir, `t-${primary.at.toFixed(2)}`, "recipe.json");
      await access(sliceRecipe);
      await copyFile(sliceRecipe, path.join(opts.workDir, "recipe.json"));
      notes.push("copied recipe.json to measure workDir");
    } catch { /* no recipe */ }
  }

  return {
    ok: true,
    format,
    blueprint: checked.blueprint,
    layout: { format, regions: checked.blueprint.regions, source: "film" },
    segments: unique,
    contentTracks: omni.tracks.length,
    recipe: lastRecipe,
    notes,
    log,
    frame: lastFrame,
    loci,
  };
}
