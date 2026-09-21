// Where the words actually are, in time.
//
// A caption track came out of the vision capture as seven sentence-long items for a video
// whose real captions change every few words. The result reads as a different video: the
// rhythm of a short-form caption IS the format, and a sentence held for three seconds is
// not the same thing as five cues landing on five beats.
//
// A vision model is the wrong instrument for this. It is being asked to notice, frame by
// frame, when a line changed — from a downsampled strip, while also describing a layout.
// The words and their times are in the AUDIO, and an aligner returns them exactly. So the
// layout comes from watching and the caption timing comes from listening, and each
// instrument answers the question it is good at.
//
// Word-level, never phrase-level: phrase mode throws away the sub-second gaps, and those
// gaps are what a karaoke caption is made of.
import { readFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "@/lib/omniwatch";
import type { BlueprintItem } from "@/lib/omniwatchBlueprint";

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL = process.env.OMNI_STT_MODEL || "scribe_v1";
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;

/** Server-side only. The lookup order is Agent OS's own for ElevenLabs, duplicated rather
 *  than imported so that installing this module into a tree without that lib is a missing
 *  feature and not a build error. */
export function elevenKey(): string | null {
  const env = process.env.ELEVENLABS_API_KEY?.trim();
  if (env) return env;
  try {
    const k = JSON.parse(readFileSync(path.join(os.homedir(), ".agentic-os", "elevenlabs", "credentials.json"), "utf8")).apiKey;
    if (typeof k === "string" && k.trim()) return k.trim();
  } catch { /* fall through */ }
  const hermes = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  for (const file of [path.join(hermes, ".env"), path.join(os.homedir(), ".fcc", ".env")]) {
    try {
      const m = readFileSync(file, "utf8").match(/^ELEVENLABS_API_KEY=(.+)$/m);
      if (m && m[1].trim().length > 10) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* not there — try the next one */ }
  }
  return null;
}

export interface Word { text: string; start: number; end: number }

export type TranscriptResult =
  | { ok: true; words: Word[]; text: string }
  | { ok: false; error: string; status?: number };

/** Pull the words out of a video's soundtrack. */
export async function wordsOf(video: string, tmpAudio: string): Promise<TranscriptResult> {
  const key = elevenKey();
  if (!key) return { ok: false, status: 503, error: "ElevenLabs is not connected — add ELEVENLABS_API_KEY to ~/.hermes/.env." };

  // Mono 16k is what an aligner wants, and it keeps the upload small.
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-vn",
      "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-q:a", "5", tmpAudio], 600_000);
  } catch { return { ok: false, status: 502, error: "could not read the soundtrack" }; }

  let audio: Buffer;
  try { audio = await readFile(tmpAudio); } catch { return { ok: false, status: 502, error: "the extracted audio is missing" }; }
  if (!audio.length) return { ok: false, status: 502, error: "that video has no sound" };
  if (audio.length > MAX_AUDIO_BYTES) return { ok: false, status: 413, error: "the soundtrack is too long to align" };

  const form = new FormData();
  form.append("model_id", MODEL);
  // Word level, explicitly. The default granularity loses the gaps between words, and the
  // gaps are the timing.
  form.append("timestamps_granularity", "word");
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "audio.mp3");

  let r: Response;
  try {
    r = await fetch(STT_URL, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(300_000),
      headers: { "xi-api-key": key }, body: form,
    });
  } catch (e) { return { ok: false, status: 502, error: `the aligner could not be reached: ${String(e)}` }; }
  finally { await unlink(tmpAudio).catch(() => {}); }
  if (!r.ok) return { ok: false, status: 502, error: `the aligner answered ${r.status}` };

  const j = (await r.json().catch(() => ({}))) as { text?: string; words?: { text?: string; start?: number; end?: number; type?: string }[] };
  const words: Word[] = (j.words ?? [])
    // Spacing entries carry no word; keeping them would put blanks in the caption.
    .filter((w) => w.type !== "spacing" && typeof w.text === "string" && w.text.trim()
      && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ text: w.text!.trim(), start: w.start as number, end: w.end as number }));
  if (!words.length) return { ok: false, status: 502, error: "the aligner returned no words" };
  return { ok: true, words, text: (j.text ?? words.map((w) => w.text).join(" ")).trim() };
}

/** One thing written on screen, as the vision pass reported it. */
export interface ScreenCue {
  start: number;
  end: number;
  text: string;
  where?: string;
  /** The word set apart inside it — boxed, underlined, in another colour. */
  marked?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, "");

/** Put the two measurements together.
 *
 *  They answer different questions and each is better at its own. What is WRITTEN can only
 *  be seen: the caption is usually shorter than the sentence, a title sits there in
 *  silence, and the one word in a box is a fact about pixels, not about speech. WHEN a word
 *  lands can only be heard accurately: the vision pass reads sampled frames and came back
 *  late by about four tenths of a second on the same cue an aligner placed to the
 *  hundredth.
 *
 *  So the screen decides the words and the mark; the soundtrack decides the clock. A cue
 *  whose words cannot be found in the speech — a title, a label, a number — keeps the times
 *  it was seen with, because there is nothing to align it to and dropping it would lose
 *  text that is really there.
 */
export function alignCues(screen: ScreenCue[], words: Word[]): { items: BlueprintItem[]; snapped: number; kept: number } {
  const seq = words.map((w) => ({ ...w, n: norm(w.text) })).filter((w) => w.n);
  const items: BlueprintItem[] = [];
  let at = 0, snapped = 0, kept = 0;

  const ordered = [...screen].sort((a, b) => a.start - b.start);
  for (let c = 0; c < ordered.length; c++) {
    const cue = ordered[c];
    const want = cue.text.split(/\s+/).map(norm).filter(Boolean);
    let from = -1, to = -1;
    // Searched forward from where the last cue ended, so a word repeated later in the
    // script cannot pull a cue backwards.
    for (let i = at; i + want.length <= seq.length && want.length; i++) {
      if (want.every((w, k) => seq[i + k].n === w)) { from = i; to = i + want.length - 1; break; }
    }
    const marked = cue.marked ? norm(cue.marked) : "";
    const value = marked && want.includes(marked)
      ? cue.text.split(/\s+/).map((w) => (norm(w) === marked ? `[[${w}]]` : w)).join(" ")
      : cue.text;

    if (from < 0) { items.push({ start: cue.start, end: cue.end, value }); kept++; continue; }
    at = to + 1;
    snapped++;
    // The cue holds until the next one is heard, not until its last word stops, so the
    // line does not blink out during a pause.
    const nextHeard = seq[to + 1]?.start;
    const end = Math.max(seq[to].end, Math.min(nextHeard ?? cue.end, cue.end > seq[to].end ? cue.end : seq[to].end));
    items.push({ start: seq[from].start, end: Math.max(end, seq[from].start + 0.04), value });
  }
  items.sort((a, b) => a.start - b.start);
  return { items, snapped, kept };
}

export interface CueOptions {
  /** A silence at least this long ends the cue on screen. */
  gap?: number;
  /** How many words a cue may show at once. */
  maxWords?: number;
  /** How many characters a cue may show at once, whichever limit comes first. */
  maxChars?: number;
  /** Mark the word being spoken, so a highlight can follow it. */
  karaoke?: boolean;
}

/** Turn aligned words into caption items.
 *
 *  Grouping is by the gaps the speaker actually left, not by punctuation: a short-form
 *  caption breaks where the delivery breaks. With `karaoke`, each WORD is its own item
 *  carrying the whole cue with that word marked, which is how the reference sets a
 *  coloured box on the word being said and moves it along. */
export function cuesFromWords(words: Word[], o: CueOptions = {}): BlueprintItem[] {
  const gap = o.gap ?? 0.35;
  const maxWords = o.maxWords ?? 4;
  const maxChars = o.maxChars ?? 34;

  const cues: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const wouldBe = [...cur, w].map((x) => x.text).join(" ");
    const breaks = prev && (w.start - prev.end >= gap || cur.length >= maxWords || wouldBe.length > maxChars);
    if (breaks) { cues.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) cues.push(cur);

  const items: BlueprintItem[] = [];
  for (const cue of cues) {
    const line = cue.map((w) => w.text).join(" ");
    if (!o.karaoke) {
      items.push({ start: cue[0].start, end: cue[cue.length - 1].end, value: line });
      continue;
    }
    cue.forEach((w, i) => {
      // The cue holds until the next word starts, so the line does not blink between
      // words — what moves is the mark, not the text.
      const end = i + 1 < cue.length ? cue[i + 1].start : w.end;
      const marked = cue.map((x, k) => (k === i ? `[[${x.text}]]` : x.text)).join(" ");
      items.push({ start: w.start, end: Math.max(end, w.start + 0.04), value: marked });
    });
  }
  return items;
}
