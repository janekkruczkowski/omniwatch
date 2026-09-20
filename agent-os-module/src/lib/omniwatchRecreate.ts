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

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { OMNI_ROOT, run } from "@/lib/omniwatch";

export const BRIEFS_ROOT = path.join(OMNI_ROOT, "recreate");

/** What the brief is FOR, which is not the same question as how it is narrated.
 *
 *  `pattern` is the original deal: the rhythm and the role of each shot cross the
 *  bridge, the words do not, and the person writes their own video about their own
 *  subject. `review` is the case that made this field necessary — a person who wants
 *  to talk ABOUT the video, quoting the moments that matter, and who would otherwise
 *  have to either re-watch it or rebuild it from memory. Both are legitimate; they are
 *  not the same product, and a brief that does not say which one it is gets read as
 *  the first one and quietly turns a commentary into a copy.
 *
 *  `mode` (voiceover/avatar) stays what it was: who speaks the narration. Purpose is
 *  what the narration is allowed to contain. */
export type BriefPurpose = "pattern" | "review";

/** Only two values, and anything else is the default rather than an error: this is
 *  reachable from a form field, and a brief that silently becomes "pattern" is
 *  recoverable while a request that 400s because a select sent `""` is not. */
export function normalizePurpose(v: unknown): BriefPurpose {
  return v === "review" ? "review" : "pattern";
}

/** How much of one beat's description is kept. The old 120-character cut was small
 *  enough to drop the part of the sentence that says what is actually on screen — a
 *  47-second teardown's beats routinely run 150–250 characters, and the tail is the
 *  evidence ("...Bottom: Speaker in medium close-up"), not decoration. This is a
 *  bound, not a summary: it is here so one pathological model answer cannot put a
 *  megabyte of prose into a scene, not to shorten what the model wrote. */
export const MAX_ROLE_CHARS = 600;

export function beatRole(text: string | undefined): string {
  return (text || "").trim().slice(0, MAX_ROLE_CHARS);
}

/** One moment of the source, as evidence rather than as instruction.
 *
 *  This is deliberately neutral for both purposes. `pattern` reads it to know what a
 *  shot was doing before writing something of its own; `review` plays the clip itself.
 *
 *  What each field actually is, stated without rounding up:
 *
 *  `start`/`end` are where the bridge says the beat is, and `timing` says where THAT
 *  came from — `measured` is ffmpeg's own scene detection reading the decoded file,
 *  `estimated` is the model's beat list, which is a description with timestamps in it
 *  rather than a measurement, and the two disagree by design (see rhythmFrom above).
 *  Neither is a transcript alignment: there is no transcript here and nothing is
 *  snapped to word boundaries, so these bounds are the honest ones we have, not
 *  frame-exact ones.
 *
 *  `description` is what the teardown wrote about that second, verbatim and bounded.
 *  It is a model's account of the screen, not a caption track.
 *
 *  `frameUrl` points at a real frame of the downloaded file, served by the media
 *  route; it is evidence for a person to look at, and no claim is made that the model
 *  was shown that exact frame at that exact second.
 *
 *  `url` is the bounded clip when the source is still cached (`available: true`) and
 *  otherwise the original page, which is provenance rather than playable media — a
 *  caller must not treat it as an asset to fetch. `quality` says what the cached file
 *  is: `proxy` is the ~480p analysis download the engine makes, and is not good enough
 *  to cut a finished video from; `master` means an explicit preparation has
 *  materialised a full-quality copy alongside it.
 *
 *  There is no `file`, no absolute path, and no way to ask this shape for a file that
 *  is not a cached source: every URL is built by the functions below, from an id that
 *  `videoDir()` re-validates on the way back in. */
export interface SceneReference {
  /** the bounded clip when the source is still cached, otherwise the original link */
  url: string;
  /** false when only the original link is left — the caller must not auto-play it */
  available: boolean;
  /** where the timings came from: ffmpeg's cuts, or the model's beat list */
  timing: "measured" | "estimated";
  /** what the cached file is. Absent when nothing is cached. */
  quality?: "proxy" | "master";
  /** seconds into the source where this beat begins */
  start: number;
  /** seconds into the source where it ends — `start + seconds`, so the reference and
   *  the scene it belongs to can never drift apart */
  end: number;
  /** one real frame at `start`, from the existing media route. Absent when the source
   *  has aged out of the cache, because then there is no frame to show. */
  frameUrl?: string;
  /** what the teardown said was happening here, kept whole (bounded by MAX_ROLE_CHARS) */
  description: string;
}

/** Longest clip the clip endpoint will extract in one request. The material this
 *  serves is a beat of a short — the cached 47-second file's beats are 0.5–3 s — so a
 *  cap well under a minute covers every real use and still refuses a request that
 *  would re-encode an entire 40-minute download through a GET. */
export const MAX_CLIP_SECONDS = 30;

/** The two files a cache directory can hold, and they are never the same file.
 *
 *  `source.mp4` is what the engine downloads to have something to analyse: 480p, chosen
 *  because that is what the model can read and what keeps a 40-minute upload small. It
 *  is an analysis proxy, and measured on the cached files it is small enough to matter —
 *  a cached vertical short's source.mp4 is 240x426, which is not a picture anyone should
 *  put in a finished video.
 *
 *  `master.mp4` is the same video at the best quality the source offers, fetched by an
 *  explicit preparation (POST on the clip route) and written BESIDE the proxy. The
 *  proxy is never overwritten: it is the file the teardown's timings were measured
 *  against, and re-downloading over it would invalidate the brief that already exists.
 *  A clip is cut from whichever of the two is present. */
export const PROXY_FILE = "source.mp4";
export const MASTER_FILE = "master.mp4";
export type ClipQuality = "proxy" | "master";

export function sourceFileIn(dir: string): { file: string; quality: ClipQuality } {
  const master = path.join(dir, MASTER_FILE);
  if (existsSync(master)) return { file: master, quality: "master" };
  return { file: path.join(dir, PROXY_FILE), quality: "proxy" };
}

/** The hosts this engine knows how to watch. Not a security boundary on its own —
 *  the real gate on preparing a master is that the video was already analysed and its
 *  cache directory is on disk — but a request that names a host we never download from
 *  is a mistake or an attempt, and both deserve the same 400 before anything is
 *  spawned. Suffix-matched against the parsed hostname, so `notyoutube.com` fails. */
const SOURCE_HOSTS = [
  "youtube.com", "youtu.be", "tiktok.com", "instagram.com",
  "facebook.com", "fb.watch", "x.com", "twitter.com",
];

/** http(s), no credentials in the URL, no literal address, and a host we watch.
 *  `file:`, `data:`, and anything with a userinfo section are refused before yt-dlp
 *  ever sees them. */
export function sourceUrlAllowed(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false; // IPv4/IPv6 literal
  return SOURCE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The clip endpoint's own URL for a cached source. Kept here so the route that stores
 *  the reference and the route that serves it cannot disagree about the shape. */
export function clipUrl(id: string, start: number, end: number): string {
  return `/api/omniwatch/clip?id=${encodeURIComponent(id)}&start=${start.toFixed(2)}&end=${end.toFixed(2)}`;
}

/** A frame at a whole second, from the media route that already serves frames out of
 *  the cache (`/api/omniwatch/media/frame/<id>/<sec>`). Floored because that route
 *  floors too, and a URL that names the file it will actually read is easier to cache. */
export function frameUrl(id: string, sec: number): string {
  return `/api/omniwatch/media/frame/${encodeURIComponent(id)}/${Math.max(0, Math.floor(sec))}`;
}

export interface ReferenceInput {
  /** the link the video was watched from — provenance, and the fallback when the cache
   *  has been cleaned up */
  sourceUrl: string;
  /** the cache key, when the source file is still on disk */
  cacheId?: string;
  start: number;
  end: number;
  description?: string;
  /** which clock the bounds came off — see SceneReference.timing */
  timing: "measured" | "estimated";
  /** the file the clip would be cut from, when the source is cached */
  quality?: "proxy" | "master";
}

/** Builds the per-scene evidence. Timings are rounded to 2dp, which is the precision
 *  the scene durations already carry — writing 12.039999999 as a start time would be
 *  invented precision about a measurement that has none.
 *
 *  The only repair done here is against values that are not numbers at all: a NaN or a
 *  negative start becomes 0, and an end that is not finite or has fallen behind the
 *  start becomes the start. A finite `end > start` is left exactly as the caller gave
 *  it. The upstream invariant is that a scene holds for a positive, finite number of
 *  seconds, and quietly widening a real 0.4 s beat to 0.1 s (or padding a short one to
 *  reach a minimum) would be inventing timing rather than preserving it. Rounding at
 *  the end of a 47-second file is the clip route's problem, and it solves it by
 *  clamping against the file's real duration rather than by moving the stored number. */
export function referenceFor(r: ReferenceInput): SceneReference {
  const rawStart = Number.isFinite(r.start) ? r.start : 0;
  const start = Math.max(0, Number(rawStart.toFixed(2)));
  const end = Number.isFinite(r.end) && r.end > start ? Number(r.end.toFixed(2)) : start;
  const id = r.cacheId && /^[\w-]{1,64}$/.test(r.cacheId) ? r.cacheId : undefined;
  return {
    url: id ? clipUrl(id, start, end) : r.sourceUrl,
    available: !!id,
    timing: r.timing,
    ...(id && r.quality ? { quality: r.quality } : {}),
    start,
    end,
    ...(id ? { frameUrl: frameUrl(id, start) } : {}),
    description: beatRole(r.description),
  };
}

/** The teardown's own sections, kept verbatim.
 *
 *  A scene carries the one beat that belongs to it; this carries the parts of the
 *  answer that are about the video as a whole — what the on-screen text actually said,
 *  how it was cut, what the audio was doing. They are stored as written, not
 *  re-summarised, because the whole point of the evidence is that it is the model's
 *  observation rather than ours, and a second summarisation is a second chance to
 *  invent something the video did not do. Bounded per section for the same reason
 *  MAX_ROLE_CHARS is bounded. */
export interface BriefEvidence {
  hook?: string;
  beats?: string;
  edit?: string;
  text?: string;
  audio?: string;
  cta?: string;
}

export const EVIDENCE_SECTION_CHARS = 4000;

/** The body of one `## <heading>` section, up to the next heading. Duplicated from
 *  omniwatchSkeleton's private helper rather than exported from there, so this file's
 *  shape does not depend on another stream's internals. */
function sectionOf(text: string, heading?: string): string {
  if (!heading) return "";
  const lines = text.split("\n");
  const want = heading.trim().toLowerCase();
  const from = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s*/, "").trim().toLowerCase() === want);
  if (from === -1) return "";
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => /^##\s/.test(l));
  return (to === -1 ? rest : rest.slice(0, to)).join("\n").trim().slice(0, EVIDENCE_SECTION_CHARS);
}

export function evidenceFrom(text: string, headings: Record<string, string>): BriefEvidence | undefined {
  if (!text) return undefined;
  const out: BriefEvidence = {};
  const keys: (keyof BriefEvidence)[] = ["hook", "beats", "edit", "text", "audio", "cta"];
  for (const k of keys) {
    const body = sectionOf(text, headings[k]);
    if (body) out[k] = body;
  }
  return Object.keys(out).length ? out : undefined;
}

/** What ffprobe can say about a file we hold: its real length and its real frame size.
 *  Both are read off the file rather than taken from metadata (yt-dlp's duration is
 *  sometimes 0, and a proxy's dimensions are the whole point of asking). Returns null
 *  rather than throwing — a brief is still correct without a size, and a clip route can
 *  say "unreadable" instead of failing with a stack trace. */
export interface VideoProbe { seconds: number; width: number; height: number }

export async function probeVideo(file: string): Promise<VideoProbe | null> {
  try {
    const out = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json",
      file,
    ], 30_000);
    const parsed = JSON.parse(out) as { streams?: { width?: unknown; height?: unknown }[]; format?: { duration?: unknown } };
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined;
    const width = Number(stream?.width), height = Number(stream?.height);
    if (!(width > 0 && height > 0)) return null;
    const seconds = Number(parsed.format?.duration);
    return { width, height, seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0 };
  } catch { return null; }
}

/** Just the frame size, for callers that only label a source. */
export async function probeSize(file: string): Promise<{ width: number; height: number } | null> {
  const p = await probeVideo(file);
  return p ? { width: p.width, height: p.height } : null;
}

/** One shot of the planned video. `seconds` is the only thing measured from the source;
 *  everything else is either the person's or still to be written. */
export interface BriefScene {
  /** how long this shot holds — from ffmpeg's cut list where we have one, from the
   *  model's beat list where we do not */
  seconds: number;
  /** seconds into the source where this shot begins, when the clock it came from said
   *  so. Recorded rather than accumulated: a beat list can leave a gap between two
   *  entries, and adding up `seconds` would move every reference after that gap. */
  start?: number;
  /** which asset group this shot belongs to. Metadata only: consecutive shots that are
   *  all too short to be their own picture share one fetched clip, and every one of them
   *  still keeps its own `seconds` in the plan. Assigned by `ideaIds` below. */
  idea?: number;
  /** what the ORIGINAL was doing here, in a few words. Guidance for whoever writes the
   *  narration — never copy, and never rendered into the finished video. */
  role?: string;
  /** written later, from the person's own topic. Empty here on purpose. */
  narration_line: string;
  caption: string;
  /** what to put on screen: stock b-roll search, or a graphic we generate. `hint` is
   *  structure — what the original had there — and never text to copy. */
  visual?: { kind: "broll" | "graphic"; hint: string };
  /** the source moment this scene was read off: its clip, its frame and what the
   *  teardown said was on screen there. Evidence for the person, never text to copy,
   *  and never required — a brief can be stored with no cache and no teardown. */
  reference?: SceneReference;
}

export interface Brief {
  id: string;
  at: string;
  /** where the shape came from, so a brief can always be traced back to what it watched.
   *  `id` is the cache key (the same key the media and clip routes take) and is present
   *  only while the downloaded file is; `width`/`height` are ffprobe's numbers off that
   *  file, so a caller can tell a 9:16 short from a 16:9 talk without opening it. */
  source: { url: string; title?: string; seconds?: number; id?: string; width?: number; height?: number };
  /** the person's own subject and angle — the only content input that exists */
  topic: string;
  angle?: string;
  mode: "voiceover" | "avatar";
  /** what the narration is allowed to be: a new video shaped like the source
   *  (`pattern`), or a commentary that quotes it (`review`). Defaults to `pattern`. */
  purpose: BriefPurpose;
  /** true when the durations came from real cut detection rather than the model's prose;
   *  a brief built on parsed prose is a rough shape and the screen should not pretend
   *  otherwise (measured: a beat list capped at 12 bullets implied 2.1 cuts per 10 s on
   *  a video where ffmpeg found 40 cuts) */
  measured: boolean;
  /** which clock the rhythm was read off, and why. Worth keeping because the two
   *  disagree in a way that is itself informative — see `rhythmFrom` below. */
  rhythm?: { from: "cuts" | "beats"; why: string };
  scenes: BriefScene[];
  /** set only when the shot list exceeds the scene limit the rest of the pipeline
   *  supports (`MAX_SCENES`), so the ceiling is visible on screen instead of silent.
   *  `scenes` always holds every shot — this is a record, not a truncation of the stored
   *  plan — and the Director refuses to generate until the person chooses a crop. */
  capped?: { max: number; total: number };
  /** the teardown that produced this, kept whole so the video side can quote the card
   *  back at the person without a second request to the model */
  teardown?: string;
  /** the teardown's own sections, verbatim and neutral: what the on-screen text said,
   *  how it was cut, what the audio was doing. Present only when the answer had them. */
  evidence?: BriefEvidence;
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

/** The number of scenes the rest of the pipeline will actually carry: `/api/video/auto/script`
 *  slices its answer to 60 and `/api/video/auto/assemble` slices its input to 60. A shot list
 *  longer than this is stored whole and the ceiling is written into the brief as `capped`, so
 *  the Director can say "first 60 of 73 shots" rather than quietly dropping the tail. */
export const MAX_SCENES = 60;

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

/** Labels each shot with the asset group it belongs to. Metadata only — the shot list
 *  comes back the same length, with the same `seconds`, and no shot is ever merged away.
 *
 *  A shot shares the previous shot's idea only when BOTH are too short to be their own
 *  picture. That is the whole rule: a long shot never absorbs the quick cuts after it,
 *  and a run of quick cuts is one idea however long the run is. The earlier version
 *  appended every short shot to whatever came before it, so a 47-second edit cut every
 *  0.8 s — the format this bridge exists for — collapsed into a single scene, and a
 *  2 s shot followed by three 0.5 s cuts became one 3.5 s hold. The rhythm is the point
 *  of the bridge; it does not get spent to save an asset.
 *
 *  The returned ids are dense (0,1,2…) in order of first appearance. */
export function ideaIds(scenes: BriefScene[]): number[] {
  const ids: number[] = [];
  let next = 0;
  for (let i = 0; i < scenes.length; i++) {
    const prev = scenes[i - 1];
    const sharesPrev = !!prev && prev.seconds < SAME_IDEA_UNDER && scenes[i].seconds < SAME_IDEA_UNDER;
    if (sharesPrev) ids.push(ids[i - 1]);
    else { ids.push(next); next++; }
  }
  return ids;
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
//
// The rule that was wrong before: the old test was one regex of graphic-ish nouns, so
// "top graphic changes to a colourful logo" and "text overlay: ..." both matched and
// became a full-screen card. On the format this audience actually makes — a talking
// head with a caption band and a graphic in the top half — that turned EVERY beat of a
// 47-second short into a card, which is the opposite of what the video does. A graphic
// that sits on top of a shot is not a graphic scene; it is a shot with something over
// it, and the base image is still the person.
//
// So the question is not "is there a graphic here" but "is there anything else here".
// Overlay evidence (captions, text overlays, split screens, a speaker) wins, and a card
// is only claimed when the description says the card IS the frame — either explicitly
// full-screen, or a card described with no shot behind it at all.
const OVERLAY_WORDS = /\b(caption|captions|subtitle|subtitles|overlay|on[- ]screen text|text overlay|lower third|top (?:half|third|graphic)|bottom (?:half|third)|split[- ]screen|split screen|speaker|talking head|webcam|face cam|b-?roll|picture[- ]in[- ]picture)\b/i;
const FULLSCREEN_WORDS = /\b(full[- ]?screen|full[- ]?frame|whole (?:frame|screen)|entire (?:frame|screen)|fills? the (?:frame|screen))\b/i;
const CARD_WORDS = /\b(text card|title card|quote card|stat card|number card|infographic|ranking|ranked list|chart|graph|table|comparison|list of \w+|one big number)\b/i;

export function visualFor(role: string | undefined): BriefScene["visual"] {
  const text = beatRole(role);
  if (!text) return { kind: "broll", hint: "" };
  const fullscreen = FULLSCREEN_WORDS.test(text);
  const overlay = OVERLAY_WORDS.test(text);
  if (overlay && !fullscreen) return { kind: "broll", hint: text };
  if (CARD_WORDS.test(text)) return { kind: "graphic", hint: text };
  return { kind: "broll", hint: text };
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
