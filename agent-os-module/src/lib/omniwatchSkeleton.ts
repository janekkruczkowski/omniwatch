// The skeleton: a watched video reduced to its shape, as data rather than prose.
//
// Everything else OmniWatch produces is for a person to read. This is the one thing
// meant for another program — the rhythm of a video in a form that a builder can act
// on: how many beats, where each one starts, how long it holds, and what was on screen.
//
// Two ways to build one, in order of preference:
//
//   buildSkeleton(text, cuts, ...) — the real path. `cuts` comes from
//   omniwatchCuts.detectCuts(), ffmpeg's own scene-change score run against the decoded
//   frames. The rhythm (how many shots, where, how long) is real, measured off the
//   video; the model's beat list is only laid on top of it, by timestamp, to say what
//   each shot showed. Semantics from the model, rhythm from ffmpeg.
//
//   parseSkeleton(text, ...) — the fallback. It reads the beat list out of the
//   teardown's prose the way this file always has, which means the durations it
//   produces are only as good as that list — capped at twelve bullets by our own
//   prompt, so a fast-cut video's real rhythm is not in it at all. Measured on a real
//   answer for t5c28Hsvr_8 (cached, 47 s): the card claimed "12 cuts per 10 s", this
//   parse of the same answer's beat list implied 2.1 — a six-fold error. Kept only
//   because /api/omniwatch/channel/route.ts calls it directly and is not this file's
//   to change; every new caller should prefer buildSkeleton.

export interface Beat {
  /** seconds from the start of the video */
  start: number;
  /** seconds this beat holds — the gap to the next one, or to the end */
  dur: number;
  /** what happens in it, as the teardown described it */
  text: string;
}

export interface Skeleton {
  /** total length in seconds, when known */
  seconds: number;
  beats: Beat[];
  /** cuts per 10 s, computed from the beats rather than asked for */
  pace: number | null;
  /** the longest single hold, in seconds */
  longest: number | null;
}

const TS = /\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/;

/** The text under one `## heading`, up to the next one. The heading is localised, so it
 *  is passed in rather than guessed. Without a heading — or when it is not in the
 *  document — the whole text is used, which is right for a teardown-only answer where
 *  the beat list is the only timestamped list there is. */
function section(text: string, heading?: string): string {
  if (!heading) return text;
  const lines = text.split("\n");
  const want = heading.trim().toLowerCase();
  const from = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s*/, "").trim().toLowerCase() === want);
  if (from === -1) return text;
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => /^##\s/.test(l));
  return (to === -1 ? rest : rest.slice(0, to)).join("\n");
}

/** What the model said happened, and when — timestamp and text, no durations yet.
 *  Shared by both parseSkeleton (which times the beats off each other) and buildSkeleton
 *  (which times them off ffmpeg's real cuts instead). Returns [] rather than throwing
 *  when the document has no usable list — a summary-only answer is not an error, just
 *  nothing to lay onto the rhythm. */
function extractBeats(text: string, heading?: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  for (const line of section(text, heading).split("\n")) {
    // Only list items: prose elsewhere in the document cites timestamps too, and those
    // are references to moments, not beats of their own.
    const item = line.match(/^\s*(?:[*\-+]|\d+\.)\s+(.*)$/);
    if (!item) continue;
    const m = item[1].match(TS);
    if (!m || item[1].indexOf(m[0]) > 2) continue; // the timestamp must open the bullet
    const at = (parseInt(m[1] || "0", 10)) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    const rest = item[1].slice(item[1].indexOf(m[0]) + m[0].length).replace(/^[\s:—–-]+/, "").trim();
    if (rest) out.push({ start: at, text: rest });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** cuts-per-10s and the longest hold, computed the same way regardless of where the
 *  beats' durations came from. */
function stats(beats: Beat[], seconds: number): { pace: number | null; longest: number | null } {
  if (!beats.length) return { pace: null, longest: null };
  const last = beats[beats.length - 1];
  const span = (seconds || last.start + last.dur) - beats[0].start;
  return {
    pace: span > 0 ? Number(((beats.length / span) * 10).toFixed(1)) : null,
    longest: Math.max(...beats.map((b) => b.dur)),
  };
}

/** Pull the beat list out of a finished teardown and time each beat off the next one.
 *  Returns null when there is no usable list — a summary-only answer has no beats, and
 *  inventing them would be worse. This is the fallback: it can only ever reproduce what
 *  the model chose to write down, capped at twelve bullets by the teardown prompt, so a
 *  video with forty real cuts still comes back with at most twelve beats. Prefer
 *  buildSkeleton() when a real cut list is available. */
export function parseSkeleton(text: string, seconds = 0, heading?: string): Skeleton | null {
  // Scope to the beat list, and nothing else. A "both" answer carries two timestamped
  // lists — the summary's timeline and the card's beats — and reading them together
  // produced exactly the nonsense you would expect: the same second appearing three
  // times, beats 0.1 s long, and a computed pace of 14.3 cuts per 10 s in a document
  // whose own card said 12. Measured on real output before this line existed.
  const found = extractBeats(text, heading);
  if (found.length < 2) return null;

  const beats: Beat[] = found.map((b) => ({ ...b, dur: 0 }));
  // A beat holds until the next one begins. The last one holds to the end of the video
  // when we know the length, and otherwise gets the median of the others — a guess, but
  // a bounded one, and only ever about the final beat.
  const gaps: number[] = [];
  for (let i = 0; i < beats.length - 1; i++) {
    beats[i].dur = Math.max(0.1, beats[i + 1].start - beats[i].start);
    gaps.push(beats[i].dur);
  }
  const last = beats[beats.length - 1];
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 2;
  last.dur = seconds > last.start ? Math.max(0.1, seconds - last.start) : median;

  return { seconds: seconds || Math.round(last.start + last.dur), beats, ...stats(beats, seconds) };
}

/** A cut, as omniwatchCuts.detectCuts() reports it — real shot boundaries measured off
 *  the decoded video, not read out of anyone's prose. Duplicated here rather than
 *  imported so this file's public shape does not change if that one's internals do;
 *  structurally identical to omniwatchCuts.Cut. */
export interface RealCut { at: number; dur: number }

/** The real path: a skeleton built from ffmpeg's own cut list, with the model's scene
 *  descriptions laid onto it by timestamp. `cuts` should come from
 *  omniwatchCuts.detectCuts() — including the single-shot case for a video with no
 *  detected cuts, which is a valid one-beat skeleton here, not an error.
 *
 *  Text assignment is nearest-timestamp, not one-to-one: the teardown's beat list is
 *  capped at twelve entries while a real cut list commonly runs into the dozens, so
 *  several consecutive real shots will legitimately share the one description the model
 *  wrote for the passage they belong to. When the document has no usable beat list at
 *  all (extractBeats returns none — a summary-only answer, or a heading that is not
 *  there), every beat's text is left empty rather than guessed. */
export function buildSkeleton(text: string, cuts: RealCut[], seconds = 0, heading?: string): Skeleton | null {
  if (!cuts.length) return null;

  const described = extractBeats(text, heading);
  const nearest = (at: number): string => {
    if (!described.length) return "";
    let best = described[0], bestDiff = Math.abs(described[0].start - at);
    for (const d of described.slice(1)) {
      const diff = Math.abs(d.start - at);
      if (diff < bestDiff) { best = d; bestDiff = diff; }
    }
    return best.text;
  };

  const beats: Beat[] = cuts.map((c) => ({ start: c.at, dur: c.dur, text: nearest(c.at) }));
  const last = beats[beats.length - 1];
  return { seconds: seconds || Math.round(last.start + last.dur), beats, ...stats(beats, seconds) };
}

/** The shape /api/video/auto/assemble accepts, with the durations it will honour when
 *  the optional field is present. Captions are left empty on purpose: these are the
 *  ORIGINAL video's beats, and putting someone else's words on your screen is the thing
 *  this tool has refused to do since the day the "Your version" section was deleted.
 *  What transfers is the rhythm; the words are yours to write. */
export function toScenePlan(s: Skeleton): { seconds: number; narration_line: string; caption: string }[] {
  return s.beats.map((b) => ({ seconds: Number(b.dur.toFixed(2)), narration_line: "", caption: "" }));
}
