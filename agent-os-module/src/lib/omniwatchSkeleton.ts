// The skeleton: a watched video reduced to its shape, as data rather than prose.
//
// Everything else OmniWatch produces is for a person to read. This is the one thing
// meant for another program — the rhythm of a video in a form that a builder can act
// on: how many beats, where each one starts, how long it holds, and what was on screen.
//
// It is parsed, not generated. The teardown already emits a beat list where every line
// begins with a real timestamp, so the shape is extracted deterministically from text
// the model has already been paid for. No second request, no second opinion, and no
// chance of the numbers disagreeing with the document they came from.
//
// Why it exists: the card can say "12 cuts per 10 s, longest shot 3 seconds", and that
// sentence is useless to a program. Reproducing a rhythm means handing the assembler
// the actual durations, and that means keeping them.

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

/** Pull the beat list out of a finished teardown. Returns null when there is no usable
 *  one — a summary-only answer has no beats, and inventing them would be worse. */
export function parseSkeleton(text: string, seconds = 0, heading?: string): Skeleton | null {
  // Scope to the beat list, and nothing else. A "both" answer carries two timestamped
  // lists — the summary's timeline and the card's beats — and reading them together
  // produced exactly the nonsense you would expect: the same second appearing three
  // times, beats 0.1 s long, and a computed pace of 14.3 cuts per 10 s in a document
  // whose own card said 12. Measured on real output before this line existed.
  const beats: Beat[] = [];
  for (const line of section(text, heading).split("\n")) {
    // Only list items: prose elsewhere in the document cites timestamps too, and those
    // are references to moments, not beats of their own.
    const item = line.match(/^\s*(?:[*\-+]|\d+\.)\s+(.*)$/);
    if (!item) continue;
    const m = item[1].match(TS);
    if (!m || item[1].indexOf(m[0]) > 2) continue; // the timestamp must open the bullet
    const at = (parseInt(m[1] || "0", 10)) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    const rest = item[1].slice(item[1].indexOf(m[0]) + m[0].length).replace(/^[\s:—–-]+/, "").trim();
    if (rest) beats.push({ start: at, dur: 0, text: rest });
  }
  if (beats.length < 2) return null;

  beats.sort((a, b) => a.start - b.start);
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

  const span = (seconds || last.start + last.dur) - beats[0].start;
  return {
    seconds: seconds || Math.round(last.start + last.dur),
    beats,
    pace: span > 0 ? Number(((beats.length / span) * 10).toFixed(1)) : null,
    longest: Math.max(...beats.map((b) => b.dur)),
  };
}

/** The shape /api/video/auto/assemble accepts, with the durations it will honour when
 *  the optional field is present. Captions are left empty on purpose: these are the
 *  ORIGINAL video's beats, and putting someone else's words on your screen is the thing
 *  this tool has refused to do since the day the "Your version" section was deleted.
 *  What transfers is the rhythm; the words are yours to write. */
export function toScenePlan(s: Skeleton): { seconds: number; narration_line: string; caption: string }[] {
  return s.beats.map((b) => ({ seconds: Number(b.dur.toFixed(2)), narration_line: "", caption: "" }));
}
