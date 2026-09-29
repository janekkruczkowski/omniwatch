// The clock the captions run on.
//
// The aligner has been in this tree the whole time — word-level Scribe, with `alignCues` and
// `cuesFromWords` already written and tested — and exactly one route called it. The cloning
// path never did. So a caption that the film changes on a word changed on a fraction of a
// character count instead: the chunker divided a cue's span in proportion to how many letters
// each piece had, which is a decent guess and is wrong by a tenth of a second every time.
//
// This file is the missing call. It answers one question — WHEN does a word land — and it
// answers it from the soundtrack, because that is the only place the answer is. Nothing here
// decides what is written or where it sits; the screen already settled that.
//
// Everything degrades to today's behaviour. No key, no sound, no match: the times that were
// already there stay, and a note says why. A clone without an aligner should be slightly out
// of sync, not broken.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "@/lib/omniwatch";
import { wordsOf, alignCues, type Word, type ScreenCue } from "@/lib/omniwatchTranscript";
import type { Blueprint, BlueprintItem } from "@/lib/omniwatchBlueprint";
import { needsStaging } from "@/lib/omniwatchStage";

/** How far outside a word a cut may sit and still be called that word's edge.
 *
 *  Timestamps drift by 50–100 ms between an aligner and a renderer, so a cut is placed a
 *  hair outside the word rather than exactly on it — otherwise the first consonant clips.
 *  The window is deliberately narrow: this is a nudge onto a boundary, not a re-timing. */
export const PAD = 0.06;
/** The furthest a time may be moved to reach a word edge. Beyond this the item genuinely
 *  starts mid-phrase and moving it would be inventing a sync that is not there. */
export const SNAP_WINDOW = 0.35;
/** How much of what a caption band claims to say has to be audible before we believe it was
 *  read off the screen rather than invented. */
export const SPOKEN_ENOUGH = 0.3;
/** How much of a film's speech a caption band has to account for before we believe it was
 *  read off the screen. A caption track is nearly all of what is said, not a sample of it. */
export const COVERS_ENOUGH = 0.5;

const stripMarks = (s: string) => s.replace(/\[\[|\]\]/g, "");
const markedWord = (s: string) => s.match(/\[\[(.+?)\]\]/)?.[1];

/** The words of a source's soundtrack, fetched once and kept.
 *
 *  The cache lives beside the source rather than in a working directory, because the thing
 *  being cached is a property of that file and nothing else. Measuring a film four times —
 *  which the outer loop does — must not mean paying an aligner four times.
 *
 *  Returns null whenever the words cannot be had. That is a normal outcome, not an error:
 *  every caller has something reasonable to do without them. */
export async function wordTimes(
  sourcePath: string, workDir: string | undefined, notes: string[],
): Promise<Word[] | null> {
  const cache = path.join(path.dirname(sourcePath), "words.json");
  try {
    const cached = JSON.parse(await readFile(cache, "utf8")) as unknown;
    const words = asWords(cached);
    if (words) { notes.push(`aligner: ${words.length} word times from cache`); return words; }
  } catch { /* nothing cached yet — go and listen */ }

  const scratch = workDir ?? path.join(tmpdir(), "omni-align");
  try { await mkdir(scratch, { recursive: true }); } catch { /* it may already be there */ }
  const got = await wordsOf(sourcePath, path.join(scratch, "align-audio.mp3"));
  if (!got.ok) { notes.push(`aligner unavailable, caption times left as measured: ${got.error}`); return null; }

  notes.push(`aligner: ${got.words.length} word times from the soundtrack`);
  try { await writeFile(cache, JSON.stringify(got.words)); }
  catch { notes.push("aligner: could not cache the word times beside the source"); }
  return got.words;
}

function asWords(v: unknown): Word[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out: Word[] = [];
  for (const w of v) {
    if (!w || typeof w !== "object") return null;
    const { text, start, end } = w as Record<string, unknown>;
    if (typeof text !== "string" || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    out.push({ text, start: start as number, end: end as number });
  }
  return out;
}

/** Put the caption's own chunks on the words they are made of.
 *
 *  The text and the highlight come from the screen — they were read off the film and this
 *  does not second-guess them. Only the two numbers change.
 *
 *  `alignCues` does the searching, and it returns items sorted by start, so the results are
 *  matched back to the originals by position and then CHECKED by text. A mismatch means the
 *  order moved under us, and the honest answer there is to keep the times we already had. */
export function snapCaptionsToWords(bp: Blueprint, words: Word[], notes: string[]): Blueprint {
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  if (!caption) return bp;

  let moved = 0, heard = 0, unheard = 0;
  const tracks = bp.tracks.map((t) => {
    if (t.kind !== "text" || t.region !== caption.id || t.items.length === 0) return t;

    const ordered = [...t.items].sort((a, b) => a.start - b.start);
    const screen: ScreenCue[] = ordered.map((it) => ({
      start: it.start, end: it.end, text: stripMarks(it.value), marked: markedWord(it.value),
    }));
    const got = alignCues(screen, words);
    if (got.items.length !== ordered.length) {
      notes.push("aligner: cue count changed under the caption track — times left as measured");
      return t;
    }
    // The zip is only safe if every slot still holds the same words.
    for (let i = 0; i < ordered.length; i++) {
      if (stripMarks(got.items[i].value) !== stripMarks(ordered[i].value)) {
        notes.push("aligner: cues came back in a different order — times left as measured");
        return t;
      }
    }

    const items: BlueprintItem[] = ordered.map((it, i) => {
      const a = got.items[i];
      if (Math.abs(a.start - it.start) > 0.005 || Math.abs(a.end - it.end) > 0.005) moved++;
      // The item keeps everything else it carries — its beat, its box, its marked word.
      return { ...it, start: a.start, end: a.end };
    });
    heard += got.snapped; unheard += got.kept;
    return { ...t, items };
  });

  if (!moved) return bp;
  notes.push(
    `caption: ${moved} cue(s) moved onto word boundaries from the soundtrack ` +
    `(${heard} heard, ${unheard} not spoken and left as seen)`,
  );
  return { ...bp, tracks };
}

/** Pull a timed overlay onto the nearest word edge.
 *
 *  An insert that appears a fifth of a second into a word reads as a mistake, because the
 *  ear has already committed to the sentence. The rule is the one the editing craft uses:
 *  cut on a word boundary, never inside a word, and leave a small pad so the consonant is
 *  not clipped.
 *
 *  Only times that are ALREADY close to a boundary are moved. An overlay that genuinely
 *  starts mid-phrase keeps its time — snapping it would be inventing a sync that the film
 *  does not have. */
export function snapSpansToWords(bp: Blueprint, words: Word[], notes: string[]): Blueprint {
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  const starts = words.map((w) => w.start).sort((a, b) => a - b);
  const ends = words.map((w) => w.end).sort((a, b) => a - b);
  const full = bp.canvas.seconds;

  let moved = 0;
  const tracks = bp.tracks.map((t) => {
    // Captions have their own rule, above. A track that holds for the whole film is the
    // format's furniture — a board, a banner — and has no cut to place.
    if (t.region === caption?.id) return t;
    const items = t.items.map((it) => {
      if (it.end - it.start >= full - 0.05) return it;
      const start = nearest(starts, it.start);
      const end = nearest(ends, it.end);
      let s = start === null ? it.start : Math.max(0, start - PAD);
      let e = end === null ? it.end : Math.min(full, end + PAD);
      if (e <= s + 0.04) { s = it.start; e = it.end; }
      if (Math.abs(s - it.start) < 0.005 && Math.abs(e - it.end) < 0.005) return it;
      moved++;
      return { ...it, start: s, end: e };
    });
    return { ...t, items };
  });

  if (!moved) return bp;
  notes.push(`overlays: ${moved} span(s) pulled onto word boundaries with a ${Math.round(PAD * 1000)} ms pad`);
  return { ...bp, tracks };
}

/** The closest value in a sorted list, or null when nothing is close enough. */
function nearest(sorted: number[], want: number): number | null {
  if (!sorted.length) return null;
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < want) lo = mid + 1; else hi = mid;
  }
  const after = sorted[lo];
  const before = lo > 0 ? sorted[lo - 1] : after;
  const pick = Math.abs(after - want) <= Math.abs(want - before) ? after : before;
  return Math.abs(pick - want) <= SNAP_WINDOW ? pick : null;
}

/** Fill `landsAt` on an item that waits beside the presenter before it lands — the gap
 *  IR-CONTRACT-V2 §3 named after it was integrated: `hold: "on-cue"` says the item WAITS and
 *  `waitsAt` says WHERE, but neither says WHEN it stops waiting, so the implementation took
 *  that moment to be `item.start` and the icon appeared already moving. In the reference the
 *  icon sits through the sentence that introduces it and drops the instant that sentence is
 *  done being said — the verdict lands, then the icon does.
 *
 *  `item.start` marks where that sentence begins (the icon has just appeared), but `item.end`
 *  is not where it ends — an item that lands and then holds its row for the rest of the film
 *  can have an `end` far beyond the one sentence it is anchored to, and taking the last word
 *  before THAT would land the icon at the end of the video, not the end of the sentence.
 *  What actually bounds the sentence is the same thing `recutCaptions` already uses to find a
 *  free break: the film's own rhythm. Words are walked forward from `start` for as long as
 *  they keep coming without a pause; the first pause — or the item's own `end`, whichever
 *  comes first — is where the sentence, and the wait, stop.
 *
 *  Skips an item that already carries a `landsAt` (a measurement is not overwritten by
 *  another pass) and leaves one alone when no word falls inside its window at all — that item
 *  keeps today's behaviour rather than being given an invented number. */
export function landItemsOnWords(bp: Blueprint, words: Word[], notes: string[]): Blueprint {
  if (!words.length) return bp;
  const gate = pauseThreshold(words);
  let landed = 0;
  const tracks = bp.tracks.map((t) => {
    const items = t.items.map((it) => {
      if (it.landsAt !== undefined || !needsStaging(it)) return it;
      const first = words.findIndex((w) => w.end > it.start);
      if (first < 0 || words[first].start >= it.end) return it; // nothing spoken in this window
      let last = words[first];
      for (let k = first + 1; k < words.length && words[k].start < it.end; k++) {
        if (words[k].start - last.end >= gate) break; // the speaker paused — the sentence ended here
        last = words[k];
      }
      landed++;
      return { ...it, landsAt: Math.min(last.end, it.end) };
    });
    return { ...t, items };
  });

  if (!landed) return bp;
  notes.push(`stage: ${landed} on-cue item(s) given landsAt from the pause after the sentence in their window`);
  return { ...bp, tracks };
}

// ── where a caption breaks ─────────────────────────────────────────────────────

/** A gap this many times the film's own median gap is a pause the speaker MEANT.
 *
 *  A multiple rather than a number of seconds, because a fast talker's pause is shorter
 *  than a slow one's and both are pauses. The film supplies the scale; this supplies only
 *  "noticeably longer than usual". */
export const PAUSE_OF_MEDIAN = 3;
/** What a break at a real pause costs, against a break made mid-phrase. Breaking where the
 *  voice already stopped is nearly free — the viewer's eye and ear move together. */
export const PAUSE_DISCOUNT = 0.2;

/** The gap above which this film's silences count as pauses. Measured, per film. */
export function pauseThreshold(words: Word[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < words.length; i++) gaps.push(Math.max(0, words[i].start - words[i - 1].end));
  if (!gaps.length) return Infinity;
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1];
  return Math.max(median * PAUSE_OF_MEDIAN, 0.08);
}

/** Break a line of words into pieces that fit a band, as EVENLY as possible.
 *
 *  The rule this replaces filled each piece to the brim and started a new one — which is how
 *  a sentence came out as two full pieces and a stub of one word, broken in the middle of a
 *  phrase both times. Greedy packing optimises the wrong thing: it makes the first piece as
 *  long as possible, when what a caption needs is for NO piece to be odd.
 *
 *  So every possible set of breaks is costed and the cheapest wins. A piece pays for the
 *  room it leaves empty, squared, so two half-empty pieces cost more than several evenly
 *  filled ones. A break where the speaker already paused pays a fraction of that, because
 *  the viewer was going to stop there anyway.
 *
 *  Both numbers going in are measurements: the budget is the band's width in characters at
 *  the size we measured the letters to be, and the pauses are the film's own silences.
 *  Nothing here knows what the film is about.
 */
export function evenBreaks(
  words: string[], budget: number, pauseAfter: (i: number) => boolean,
): number[][] {
  const n = words.length;
  if (!n) return [];
  const len = words.map((w) => w.length);
  // A single word longer than the band cannot be helped by breaking, so the budget bends
  // rather than the word: there is no such thing as half a word on screen.
  const cap = Math.max(budget, Math.max(...len));

  const best = new Array<number>(n + 1).fill(Infinity);
  const from = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let end = 1; end <= n; end++) {
    for (let start = end - 1; start >= 0; start--) {
      let width = 0;
      for (let k = start; k < end; k++) width += len[k] + (k > start ? 1 : 0);
      if (width > cap && end - start > 1) break;      // any longer piece is worse
      const slack = cap - width;
      const free = end < n && pauseAfter(end - 1);
      const cost = best[start] + slack * slack * (free ? PAUSE_DISCOUNT : 1);
      if (cost < best[end]) { best[end] = cost; from[end] = start; }
    }
  }
  const cuts: number[][] = [];
  for (let end = n; end > 0; end = from[end]) {
    if (from[end] < 0) break;
    cuts.unshift([from[end], end - 1]);
  }
  return cuts.length ? cuts : [[0, n - 1]];
}

/** Re-cut the caption band using the words as they were actually spoken.
 *
 *  Runs after the aligner, so it has both halves of the problem: how much room there is (a
 *  pixel measurement) and where the voice stops (an audio measurement). The chunker that ran
 *  before it, which has neither, stays as the path for a film with no soundtrack. */
export function recutCaptions(
  bp: Blueprint, words: Word[], perLine: number, notes: string[], karaoke = false,
): Blueprint {
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  if (!caption || !words.length || !(perLine > 0)) return bp;
  const gate = pauseThreshold(words);
  const seq = words.map((w, i) => ({ ...w, i }));

  let before = 0, after = 0;
  const tracks = bp.tracks.map((t) => {
    if (t.kind !== "text" || t.region !== caption.id || !t.items.length) return t;
    const ordered = [...t.items].sort((a, b) => a.start - b.start);
    before += ordered.length;
    const out: BlueprintItem[] = [];
    let cursor = 0;

    for (const it of ordered) {
      const plain = it.value.replace(/\[\[|\]\]/g, "").split(/\s+/).filter(Boolean);
      if (plain.length < 2) { out.push(it); continue; }
      // Find this line in the spoken sequence, so each piece can take its own clock.
      const want = plain.map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, ""));
      let at = -1;
      for (let i = cursor; i + want.length <= seq.length; i++) {
        if (want.every((w, k) => !w || seq[i + k].text.toLowerCase().replace(/[^a-z0-9']/g, "") === w)) { at = i; break; }
      }
      const pauseAfter = (k: number) =>
        at >= 0 && at + k + 1 < seq.length && seq[at + k + 1].start - seq[at + k].end >= gate;

      const pieces = evenBreaks(plain, perLine, pauseAfter);
      if (pieces.length < 2) { out.push(it); continue; }
      if (at >= 0) cursor = at + plain.length;

      pieces.forEach(([a, b], n) => {
        const words = plain.slice(a, b + 1);
        // The mark sits on the word being said, and a piece ends on it — so the last word
        // of each piece is the marked one. Formats without a mark get plain text; this is
        // carried over from the cutter this replaced, where losing it silently turned a
        // karaoke caption into a plain one.
        const text = karaoke
          ? words.map((w, k) => (k === words.length - 1 ? `[[${w}]]` : w)).join(" ")
          : words.join(" ");
        const start = at >= 0 ? seq[at + a].start : it.start + (it.end - it.start) * (a / plain.length);
        const nextAt = pieces[n + 1]?.[0];
        const end = n === pieces.length - 1
          ? it.end
          : (at >= 0 && nextAt !== undefined ? seq[at + nextAt].start : it.start + (it.end - it.start) * ((b + 1) / plain.length));
        out.push({ ...it, start, end: Math.max(end, start + 0.04), value: text });
      });
    }
    after += out.length;
    return { ...t, items: out.sort((a, b) => a.start - b.start) };
  });

  if (after === before) return bp;
  notes.push(
    `caption: re-cut into ${after} piece(s) from ${before}, evenly rather than greedily, ` +
    `with a free break wherever the speaker paused longer than ${gate.toFixed(2)}s`,
  );
  return { ...bp, tracks };
}

// ── how often THIS film changes its caption ────────────────────────────────────

/** Frames per second to watch the caption band at. Fast enough to separate two cues a
 *  fifth of a second apart, slow enough that a twenty-second film is two hundred tiny
 *  frames rather than six hundred full ones. */
export const BAND_FPS = 10;
/** Below this, a column's change is encoding noise rather than ink moving. */
export const NOISE_FLOOR = 8;
/** The share of the band that has to change at once for it to be a NEW caption rather than
 *  something moving inside the old one. Half the line is a deliberately blunt line to draw,
 *  and it is the only thing separating "the format put up a new cue" from "the karaoke mark
 *  stepped onto the next word". */
export const LINE_REPLACED = 0.5;

/** Count the caption changes in the film itself.
 *
 *  Every attempt to work out how a format breaks its captions from the BAND's width was
 *  wrong, and wrong in the same direction: the band fits far more than the format ever puts
 *  in it. The reference fits twenty-two characters and shows about fourteen. Width is a
 *  ceiling, not a rhythm.
 *
 *  The rhythm is in the film, and it is visible: the caption band's pixels change when the
 *  caption changes. So the band is cropped out, shrunk to a thumbnail strip, and walked —
 *  one ffmpeg call, a few kilobytes, no model. What comes back is this film's own count of
 *  how many things it said on screen, which is exactly the number a re-cut should aim for.
 *
 *  Returns null when the band cannot be read. A caller with no count falls back to the
 *  width, which is where it was before. */
export async function measureCueRate(
  sourcePath: string, band: [number, number, number, number], seconds: number,
  workDir: string, notes: string[],
): Promise<{ cues: number; perCue: number } | null> {
  const [x, y, w, h] = band;
  if (!(w > 0 && h > 0 && seconds > 0)) return null;
  const crop = `crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)}`;
  const W = 96, H = 12;
  // Through a file, never through a pipe. Raw frames are bytes, and a process helper that
  // decodes its output as text turns every byte above 127 into the same replacement
  // character — which reads as "the band never changes".
  let buf: Buffer;
  const strip = path.join(workDir, "caption-band.raw");
  try {
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", sourcePath,
      "-vf", `${crop},scale=${W}:${H},format=gray`,
      "-r", String(BAND_FPS), "-f", "rawvideo", strip,
    ], 120_000);
    buf = await readFile(strip);
  } catch { notes.push("caption rhythm: the band could not be read from the film"); return null; }

  const frame = W * H;
  const n = Math.floor(buf.length / frame);
  if (n < 4) { notes.push("caption rhythm: too few frames of the band to count"); return null; }

  // WHAT changed matters more than how much. Replacing a caption redraws the whole line, so
  // the difference is spread across the band; moving a karaoke mark along one word changes a
  // few columns and leaves the rest identical. Both are real changes and both are large in
  // total — only their EXTENT tells them apart, so extent is what is measured.
  const cols = new Array<number>(W);
  const spread: number[] = [];
  for (let i = 1; i < n; i++) {
    cols.fill(0);
    for (let row = 0; row < H; row++) {
      for (let c = 0; c < W; c++) {
        const k = row * W + c;
        cols[c] += Math.abs(buf[i * frame + k] - buf[(i - 1) * frame + k]);
      }
    }
    let touched = 0;
    for (let c = 0; c < W; c++) if (cols[c] / H >= NOISE_FLOOR) touched++;
    spread.push(touched / W);
  }
  // More than half the band redrawn at once is a new caption. Below that the line is still
  // the same line, however brightly something inside it moved.
  let changes = 0, wasLoud = false;
  for (const s of spread) {
    const loud = s >= LINE_REPLACED;
    if (loud && !wasLoud) changes++;
    wasLoud = loud;
  }
  if (changes < 2) { notes.push("caption rhythm: the band never changes — nothing to count"); return null; }
  const cues = changes + 1;
  notes.push(`caption rhythm measured from the film: ${cues} change(s) of the band, one every ${(seconds / cues).toFixed(2)}s`);
  return { cues, perCue: seconds / cues };
}

/** Give the caption band the words that were actually said, when nothing else has.
 *
 *  A capture describes what it can SEE, and a pass busy measuring a layout can come back
 *  with a caption band and no idea what is written in it — or with a placeholder, which is
 *  worse, because it looks like content. Either way the band is real: the film has one, we
 *  measured it, and leaving it holding a guess is how a clone ends up captioned with a
 *  sentence nobody says.
 *
 *  The soundtrack knows. This only fires when what the band holds bears no relation to what
 *  is spoken — a caption read off the SCREEN is better than one inferred from audio, because
 *  the screen is where captions are — and it hands over one unbroken line, so the ordinary
 *  cutting path is what decides where it breaks.
 */
export function captionFromSpeech(bp: Blueprint, words: Word[], notes: string[]): Blueprint {
  const caption = bp.regions.find((r) => /caption/i.test(r.id));
  if (!caption || words.length < 4) return bp;
  const track = bp.tracks.find((t) => t.kind === "text" && t.region === caption.id);
  if (!track) return bp;

  const plain = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  // Compared as PAIRS of neighbouring words, not as a bag of words.
  //
  // A bag was tried first and was fooled immediately: a placeholder reading "a line of the
  // narration" shares "a", "of" and "the" with any soundtrack in the language, and scored
  // well enough to be mistaken for a real caption. What a real caption has and a stand-in
  // does not is the ORDER — "hair gel", "gel than", "than trophies" all occur, in that
  // order, in the speech. Function words cannot fake that.
  const spoken = words.map((w) => plain(w.text)).filter(Boolean);
  const pairs = new Set(spoken.slice(1).map((w, i) => `${spoken[i]} ${w}`));
  const held = track.items
    .flatMap((it) => stripMarks(it.value).split(/\s+/))
    .map(plain).filter(Boolean);
  const heldPairs = held.slice(1).map((w, i) => `${held[i]} ${w}`);
  const audible = heldPairs.filter((p) => pairs.has(p)).length;

  // Two ways a band can be holding nothing, and both have to be caught.
  //
  // It can hold the WRONG words — caught by the pairs above. Or it can hold a few RIGHT
  // ones and stop: four words standing in for a film with sixty-eight spoken in it. The
  // second fooled the first, because a four-word stand-in only has to contain one real
  // phrase to look genuine, and "what is" occurs in almost any conversation.
  //
  // A caption track is not a sample of a film's speech; it is nearly all of it. So the
  // question that settles it is how MUCH of what was said the band accounts for.
  const covers = held.length / spoken.length;
  const phrasing = heldPairs.length ? audible / heldPairs.length : 0;
  if (covers >= COVERS_ENOUGH && phrasing >= SPOKEN_ENOUGH) return bp;

  const value = words.map((w) => w.text).join(" ");
  const what = held.length
    ? `${held.length} word(s) — ${Math.round(covers * 100)}% of what is said, ${audible} of ${heldPairs.length} phrase(s) audible`
    : "nothing";
  notes.push(`caption: the band held ${what} — taking its ${words.length} words from the soundtrack instead`);
  return {
    ...bp,
    tracks: bp.tracks.map((t) => (t === track
      ? { ...t, items: [{ ...(t.items[0] ?? { start: 0, end: 0, value: "" }),
          start: words[0].start, end: words[words.length - 1].end, value }] }
      : t)),
  };
}
