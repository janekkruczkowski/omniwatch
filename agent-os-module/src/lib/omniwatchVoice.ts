// Local voice — the Mac reads the script aloud, and nothing leaves the machine.
//
// This is the cheap half of narration: `say` is already on macOS, ffmpeg is already
// required by the rest of OmniWatch, and neither one is asked to download a voice. It
// is not a voice clone and it is not the good-sounding one; it is the one that costs
// nothing, works offline, and is honest about being the system voice. A cloud voice
// belongs in whatever tool already bills for it.
//
// Every call is exec-with-args, never a shell: the text is the user's, and it must not
// be able to become a command.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { run, OMNI_ROOT } from "@/lib/omniwatch";

export const VOICE_ROOT = path.join(OMNI_ROOT, "voiceovers");

/** One request is one utterance. Past this the caller should be cutting scenes, not
 *  handing us a screenplay: 10 000 characters is already several minutes of speech. */
export const MAX_TEXT = 10_000;

/** launchd starts the dev server with a thin PATH, and `say` is not on it. */
const SAY = existsSync("/usr/bin/say") ? "/usr/bin/say" : "say";

/** The voices this Mac already has. Nothing is installed by us, and a name that is not
 *  on this list is refused rather than handed to `say`. */
export async function installedVoices(): Promise<string[]> {
  try {
    // one voice per line: `Name                en_US    # comment`, and names may contain
    // spaces ("Eddy (English (UK))"), so the columns are split on runs of spaces.
    const out = await run(SAY, ["-v", "?"], 15_000);
    return out.split("\n").map((l) => l.split(/\s{2,}/)[0].trim()).filter(Boolean);
  } catch { return []; }
}

/** Is the Mac's own voice usable here? macOS only, and it needs ffmpeg for the mp3. */
export async function voiceAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const hasFfmpeg = async () => { try { await run("ffmpeg", ["-version"], 15_000); return true; } catch { return false; } };
  const [voices, ffmpeg] = await Promise.all([installedVoices(), hasFfmpeg()]);
  return voices.length > 0 && ffmpeg;
}

/** The cache key is the whole request: same words, same voice, same file. */
export function voiceKey(text: string, voice: string): string {
  return createHash("sha256").update(`${voice}\u0000${text}`).digest("hex").slice(0, 32);
}

export function voiceFile(key: string): string {
  return path.join(VOICE_ROOT, `${key}.mp3`);
}

export interface Utterance { key: string; file: string; cached: boolean }

/** Say the text and leave an mp3 at the cache path.
 *
 *  Same text twice costs one synthesis: the file is named after the text, so the second
 *  caller is served the first one. The audio is written to a temp directory and moved
 *  into place, so a request that dies halfway cannot leave a half-file that later reads
 *  as a cache hit, and the temp directory is removed either way. */
export async function synthesize(text: string, voice = ""): Promise<Utterance> {
  const key = voiceKey(text, voice);
  const file = voiceFile(key);
  if (existsSync(file)) return { key, file, cached: true };

  await mkdir(VOICE_ROOT, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "omniwatch-voice-"));
  // The part file is unique to this request. Two people asking for the same text at the
  // same time used to write — and then delete — each other's file, because both were
  // called `<key>.mp3.part` and both finally-blocks removed that name. It sits beside the
  // target so the rename is atomic on one filesystem.
  const part = `${file}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.part`;
  try {
    // The text goes into a file, not into argv. `say` reads options from anywhere in its
    // arguments, so a script that begins with "-f /etc/passwd" would have been obeyed as
    // a flag instead of spoken.
    const script = path.join(tmp, "script.txt");
    await writeFile(script, text, "utf8");
    const aiff = path.join(tmp, "speech.aiff");
    // No -v means the system default voice: naming a voice here would fail on a Mac that
    // does not happen to have it installed, and installing one is not our business.
    await run(SAY, [
      "-o", aiff,
      ...(voice ? ["-v", voice] : []),
      "-f", script,
    ], 300_000);
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", aiff,
      "-codec:a", "libmp3lame", "-b:a", "128k", "-ar", "44100",
      // Named explicitly: the temp file is ".part", which ffmpeg will not read as mp3.
      "-f", "mp3",
      part,
    ], 300_000);
    await rename(part, file);
    return { key, file, cached: false };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    await rm(part, { force: true }).catch(() => {});
  }
}
