// The bridge: a video you watched becomes a video you are about to make.
//
// Everything OmniWatch produced until now ended on a page. You read the teardown, you
// closed the tab, and the next morning you rebuilt the thing from memory — which means
// you rebuilt the impression of it, not the thing. This file is what survives that
// night: the shape of a video, written down in the form the builder on the other side
// actually accepts.
//
// What crosses the bridge is RHYTHM, not content. How many shots, how long each one
// holds, and what job that shot was doing — hook, proof, turn, ask. What does not cross
// is a single one of their sentences. The "Your version" section was deleted from this
// module precisely because it read as "steal this video", and shipping a finished edit
// plan with their words in it would be the same thing wearing a different hat. So the
// narration lines here are EMPTY by construction, not by omission: the topic is yours,
// the words are yours, only the timing is borrowed.
//
// The brief is stored rather than passed in a URL. A scene plan for a 40-cut short is
// a few kilobytes, which no browser should be asked to carry in a query string, and
// storing it means the handoff survives a reload — the tab you land in can be opened
// twice, or tomorrow, without watching (and paying for) the video again.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { OMNI_ROOT } from "@/lib/omniwatch";

export const BRIEFS_ROOT = path.join(OMNI_ROOT, "recreate");

/** One shot of the planned video. `seconds` is the only thing measured from the source;
 *  everything else is either the person's or still to be written. */
export interface BriefScene {
  /** how long this shot holds — from ffmpeg's cut list where we have one, from the
   *  model's beat list where we do not */
  seconds: number;
  /** what the ORIGINAL was doing here, in a few words. Guidance for whoever writes the
   *  narration — never copy, and never rendered into the finished video. */
  role?: string;
  /** written later, from the person's own topic. Empty here on purpose. */
  narration_line: string;
  caption: string;
  /** what to put on screen: stock b-roll search, or a graphic we generate */
  visual?: { kind: "broll" | "graphic" | "avatar"; hint: string };
}

export interface Brief {
  id: string;
  at: string;
  /** where the shape came from, so a brief can always be traced back to what it watched */
  source: { url: string; title?: string; seconds?: number };
  /** the person's own subject and angle — the only content input that exists */
  topic: string;
  angle?: string;
  mode: "voiceover" | "avatar";
  /** true when the durations came from real cut detection rather than the model's prose;
   *  a brief built on parsed prose is a rough shape and the screen should not pretend
   *  otherwise (measured: a beat list capped at 12 bullets implied 2.1 cuts per 10 s on
   *  a video where ffmpeg found 40 cuts) */
  measured: boolean;
  /** which clock the rhythm was read off, and why. Worth keeping because the two
   *  disagree in a way that is itself informative — see `rhythmFrom` below. */
  rhythm?: { from: "cuts" | "beats"; why: string };
  scenes: BriefScene[];
  /** the teardown that produced this, kept whole so the video side can quote the card
   *  back at the person without a second request to the model */
  teardown?: string;
}

// ── which clock to read the rhythm off ─────────────────────────────────────────
//
// ffmpeg is the honest source for camera cuts and the wrong source for the format this
// community actually makes. Measured on two cached files at the same threshold (0.15):
// a TikTok explainer gives 34 detections in 128 s, while a 47-second talking-head short
// gives 2 — and the short is not slow, it is *fixed framing*. Its pace is carried by
// captions and graphics swapping inside a shot that never changes, and a detector that
// compares pixels between frames legitimately does not see those. Dropping the
// threshold to 0.08 finds 12 of them in the same file, and also finds noise elsewhere,
// so the answer is not a smaller number.
//
// So: when ffmpeg sees a nearly static video but the model listed far more moments than
// that, believe the model. It watched the screen, not the pixels between frames, and on
// this one format it is the better instrument.
const STATIC_SHOT_SECONDS = 6;

export function rhythmFrom(
  shots: { at: number; dur: number }[] | null,
  beats: { start: number; dur: number }[] | undefined,
  seconds: number,
): { from: "cuts" | "beats"; why: string } {
  const nShots = shots?.length ?? 0;
  const nBeats = beats?.length ?? 0;
  if (!nShots) {
    return { from: "beats", why: "The file was no longer in the cache, so the shape comes from the written teardown rather than from the picture." };
  }
  const avg = seconds > 0 && nShots ? seconds / nShots : 0;
  if (avg > STATIC_SHOT_SECONDS && nBeats > nShots * 2) {
    return {
      from: "beats",
      why: `The camera barely cuts (${nShots} shot${nShots === 1 ? "" : "s"} in ${Math.round(seconds)}s), but the teardown lists ${nBeats} moments — this is fixed framing where the captions and graphics carry the pace, not the edit.`,
    };
  }
  return { from: "cuts", why: `${nShots} shots detected in the picture itself.` };
}

export async function saveBrief(b: Brief): Promise<void> {
  await mkdir(BRIEFS_ROOT, { recursive: true });
  await writeFile(path.join(BRIEFS_ROOT, `${b.id}.json`), JSON.stringify(b, null, 2));
}

export async function readBrief(id: string): Promise<Brief | null> {
  // Ids are ours and generated below, but this function is reachable from a query
  // string, so anything with a separator in it is refused rather than resolved.
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(BRIEFS_ROOT, `${id}.json`), "utf8")) as Brief;
  } catch { return null; }
}

export async function listBriefs(limit = 30): Promise<Brief[]> {
  let names: string[];
  try { names = await readdir(BRIEFS_ROOT); } catch { return []; }
  const out: Brief[] = [];
  for (const n of names.filter((n) => n.endsWith(".json")).sort().reverse().slice(0, limit)) {
    const b = await readBrief(n.replace(/\.json$/, ""));
    if (b) out.push(b);
  }
  return out;
}

export const newBriefId = () => `br_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── turning a shape into a plan ────────────────────────────────────────────────
//
// Two things stand between a cut list and something a person can film. The first is
// that a fifty-shot edit is fifty shots of SOMETHING, and "something" has to be named
// or the plan is a column of numbers. The second is that not every shot deserves its
// own asset: three consecutive one-second shots of the same subject are one idea cut
// three times, and asking an image generator for three pictures there wastes money and
// looks worse than asking for one.

/** Shots shorter than this are almost always a rapid cut inside one idea rather than a
 *  new idea. Chosen from the one edit we measured end to end (shots 0.97–3.4 s, and the
 *  sub-second ones were all reframings of the same shot). Not a law — a knob with a
 *  reason, and the reason is written here so the next person can re-measure it. */
const SAME_IDEA_UNDER = 1.2;

/** Groups a cut list into ideas, so an asset is fetched per idea rather than per cut.
 *  The rhythm is untouched — every original shot keeps its own duration in the output,
 *  it just shares a visual with its neighbours when it is too short to be its own. */
export function groupIntoIdeas(scenes: BriefScene[]): BriefScene[][] {
  const groups: BriefScene[][] = [];
  for (const s of scenes) {
    const last = groups[groups.length - 1];
    if (last && s.seconds < SAME_IDEA_UNDER) last.push(s);
    else groups.push([s]);
  }
  return groups;
}

// ── what each scene should show ────────────────────────────────────────────────
//
// Not every beat of a video is footage. The format this audience makes is full of
// scenes that are a graphic and nothing else: a ranked list, one big number, a
// comparison, a quote held on screen. Generating stock b-roll for those is both more
// expensive and worse than drawing the card — HypeKit's own examples lean on exactly
// this kind of scene, and until now our pipeline could only ask for footage.
//
// The decision is made from what the model said was on screen at that moment, which is
// the only evidence available before a single asset is fetched. It is a hint, not a
// verdict: a scene marked "graphic" that turns out to want footage is one toggle away,
// and the words that end up on the card are written later, from the person's own
// script, never from the video that was watched.
const GRAPHIC_WORDS = /\b(text card|title card|caption|on[- ]screen text|graphic|chart|list|ranking|ranked|comparison|table|stat|number|price|score)\b/i;

export function visualFor(role: string | undefined): BriefScene["visual"] {
  if (!role) return { kind: "broll", hint: "" };
  if (GRAPHIC_WORDS.test(role)) return { kind: "graphic", hint: role };
  return { kind: "broll", hint: role };
}

/** The body /api/video/auto/assemble accepts. Durations are explicit: without them the
 *  route derives each scene's length from its narration word count, which is a fine
 *  default and the exact opposite of what we are doing here — we have the real timing
 *  and the words are not written yet, so weighting by word count would throw away the
 *  only thing we measured. */
export function toAssembleBody(b: Brief, narrationUrl: string, avatarUrl?: string) {
  return {
    title: b.topic,
    mode: b.mode,
    narrationUrl,
    ...(avatarUrl ? { avatarUrl } : {}),
    scenes: b.scenes.map((s) => ({
      seconds: Number(s.seconds.toFixed(2)),
      narration_line: s.narration_line,
      caption: s.caption,
    })),
  };
}
