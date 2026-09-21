// One video, made the way the blueprint says.
//
// Everything before this was a step you had to know about: watch, then check, then rewrite
// the values, then work out for each slot whether it wanted a picture or a clip or a crop,
// then ask the right provider in the right frame, then build, then render. Doing that by
// hand is how a presenter ended up generated at the wrong aspect and five rectangles were
// sent to an image model.
//
// The blueprint already knows all of it. Each track says where its content comes from, each
// region says what shape it is, each item says how long it is on screen. So this walks the
// blueprint and does what it says — and, crucially, does NOTHING that the blueprint does
// not ask for. A slot marked "draw" costs nothing. A slot marked "cut" is taken from the
// source. A slot marked "supply" is left empty and REPORTED, because the one thing worse
// than a missing logo is an invented one.
import {
  defaultFill, type Blueprint, type BlueprintTrack, type FillSource,
} from "@/lib/omniwatchBlueprint";
import { kieStill, videoClip, nearestStillAspect, VIDEO_ASPECTS, MAX_PROMPT,
  type StillModel, type VideoModel, type Aspect } from "@/lib/omniwatchBroll";
import { buildClone, type CloneOut } from "@/lib/omniwatchClone";

/** How many providers to keep busy at once. Enough to matter on a layout with a dozen
 *  pictures, low enough not to trip a rate limit. */
const LANES = 5;

export interface SlotJob {
  slot: string;
  region: string;
  kind: string;
  fill: FillSource;
  aspect: string;
  seconds: number;
  prompt: string;
}

export interface SlotDone extends SlotJob {
  name?: string;
  error?: string;
  ms: number;
}

/** The frame closest to a region's own shape, out of the frames that provider will render.
 *
 *  Not decoration: a presenter asked for in the wrong aspect comes back cropped through the
 *  face, and the first run of this pipeline asked Wan for 1:1 and was refused outright. */
function videoAspect(w: number, h: number, model: VideoModel): Aspect {
  const want = Math.log(w / h);
  const R: Record<string, number> = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1, "2:3": 2 / 3, "3:2": 1.5 };
  return VIDEO_ASPECTS[model].reduce((best, a) =>
    Math.abs(Math.log(R[a]) - want) < Math.abs(Math.log(R[best]) - want) ? a : best, VIDEO_ASPECTS[model][0]);
}

/** Every slot the blueprint asks a provider for — and only those. */
export function jobsFor(bp: Blueprint, videoModel: VideoModel): SlotJob[] {
  const W = bp.canvas.width, H = bp.canvas.height;
  const rect = new Map(bp.regions.map((r) => [r.id, r.rect]));
  const out: SlotJob[] = [];
  for (const t of bp.tracks) {
    const fill: FillSource = t.fill ?? defaultFill(t.kind);
    if (fill !== "generate") continue;
    const [, , fw, fh] = rect.get(t.region) ?? [0, 0, 1, 1];
    const w = Math.max(fw * W, 1), h = Math.max(fh * H, 1);
    t.items.forEach((it, i) => {
      out.push({
        slot: `${t.region}:${i}`, region: t.region, kind: t.kind, fill,
        aspect: t.kind === "video" ? videoAspect(w, h, videoModel) : nearestStillAspect(w, h),
        seconds: Math.max(it.end - it.start, 0.04),
        prompt: it.value.slice(0, MAX_PROMPT),
      });
    });
  }
  return out;
}

/** What the blueprint asks for that nobody can make: a real logo, a real person's
 *  photograph, a screenshot of the actual thing. Named so the caller can supply them
 *  instead of discovering a hole in the picture. */
export function neededSupplies(bp: Blueprint): string[] {
  const out: string[] = [];
  for (const t of bp.tracks) {
    if ((t.fill ?? defaultFill(t.kind)) !== "supply") continue;
    t.items.forEach((_, i) => out.push(`${t.region}:${i}`));
  }
  return out;
}

async function pool<T>(items: T[], lanes: number, work: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await work(items[i]);
    }
  }));
}

export interface ProduceOptions {
  sourceId?: string;
  title?: string;
  output?: { width?: unknown; height?: unknown } | null;
  /** Assets the caller supplies for "supply" slots, keyed the same way. */
  assets?: Record<string, unknown>;
  audio?: string;
  videoModel?: VideoModel;
  stillModel?: StillModel;
  /** Set false to build the project without asking any provider for anything — the drawn
   *  layer alone, which is the cheapest way to see whether a capture is any good. */
  generate?: boolean;
  /** Rebuild the watched video: slots that ask to be supplied are cut from it instead of
   *  left empty. For a reproduction, not for a new episode. */
  cutSupplies?: boolean;
}

export interface ProduceResult {
  made: SlotDone[];
  supplies: { needed: string[]; missing: string[] };
  clone: CloneOut;
}

export async function produce(bp: Blueprint, o: ProduceOptions = {}): Promise<ProduceResult> {
  const videoModel = o.videoModel ?? "grok";
  const stillModel = o.stillModel ?? "gpt-image-2.5";
  const jobs = o.generate === false ? [] : jobsFor(bp, videoModel);
  const made: SlotDone[] = [];
  const assets: Record<string, unknown> = { ...(o.assets ?? {}) };

  await pool(jobs, LANES, async (j) => {
    const t0 = Date.now();
    const r = j.kind === "video"
      ? await videoClip(j.prompt, j.aspect as Aspect, { model: videoModel, seconds: j.seconds })
      : await kieStill(j.prompt, j.aspect as never, stillModel);
    if (r.ok) {
      assets[j.slot] = r.name;
      made.push({ ...j, name: r.name, ms: Date.now() - t0 });
    } else {
      // A provider that refused is reported, not retried into a different picture: the
      // slot stays visibly empty and the answer says which one and why.
      made.push({ ...j, error: r.error, ms: Date.now() - t0 });
    }
  });

  const needed = neededSupplies(bp);
  // A slot that will be cut from the source is not missing; it is coming from somewhere.
  const missing = o.cutSupplies ? [] : needed.filter((s) => !(s in assets));

  const clone = await buildClone({
    blueprint: bp,
    sourceId: o.sourceId,
    fill: "assets",
    assets,
    audio: o.audio,
    output: o.output,
    title: o.title,
    cutSupplies: o.cutSupplies,
  });

  return { made, supplies: { needed, missing }, clone };
}

/** Which slots a track will ask a provider for — exported for the tests, which is where
 *  the "does it ask for exactly what the blueprint says" question actually gets settled. */
export const fillOf = (t: BlueprintTrack): FillSource => t.fill ?? defaultFill(t.kind);
