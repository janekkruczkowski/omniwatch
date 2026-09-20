// Real cut detection — ffmpeg's scene score, not the model's prose.
//
// The teardown's beat list is capped at twelve bullets by our own prompt, so it is a
// summary, not a record of the edit. Measured on a real answer for t5c28Hsvr_8 (a
// 47-second talking-head short, cached under ~/.agentic-os/omniwatch/cache): the card
// said "12 cuts per 10 s", the parsed beat list implied 2.1 — a six-fold error, and not
// even a stable one: the same 47-second file, torn down again, produced cards claiming
// 4, then 12, then 2–3 cuts per 10 s across separate runs. The model's stated pace is not
// a measurement, it is a guess dressed as one. ffmpeg's scene filter, run on the actual
// decoded frames, is the only number here that was measured rather than asked for.
//
// probeDuration exists because yt-dlp's metadata is not always there to ask: a direct
// MP4 (Meta ads, and the cached e651548f49c09bad — extractor "Generic", info.json
// duration 0) gets no duration from yt-dlp at all. ffprobe reads it off the file we
// already downloaded, which always has one.

import { spawn } from "node:child_process";

import { BIN_PATH } from "@/lib/omniwatch";

export interface Cut {
  /** seconds from the start of the video where this shot begins */
  at: number;
  /** seconds this shot holds */
  dur: number;
}

// ── measured, on the cached files, 2026-09-20 ────────────────────────────────────
//
// Dumped every frame's lavfi.scene_score (not just the ones a threshold would already
// have kept) via `-vf "select='gte(scene,0)',metadata=print"` and counted how many
// frames clear each candidate threshold, on every file then in
// ~/.agentic-os/omniwatch/cache/:
//
//   file                    len(s)  T=0.10  T=0.15  T=0.20  card says
//   Fz89dJTZsko (YT, long)   1286     575     464     427    (no card figure)
//   StKa9LhH_-k (YT, long)    511     247     125      87    (no card figure)
//   cd1586216ebd2b03 (TT)     128      39      34      24    "3-5 cuts/10s" -> matches
//                                                             well at T=0.15 (2.7/10s)
//   ymgH8jS6Wb8 (YT, long)    968      64      44      34    "Pace: 2, 45" (unclear)
//   t5c28Hsvr_8 (short)        47       3       2       2    "4-12 cuts/10s" across runs
//                                                             (see comment above — the
//                                                             card is not to be trusted
//                                                             here; this file's "cuts"
//                                                             are mostly caption/graphic
//                                                             swaps inside a fixed
//                                                             talking-head layout, not
//                                                             full-frame scene changes,
//                                                             so a pixel-difference
//                                                             detector legitimately sees
//                                                             few of them)
//   e651548f49c09bad (image)   46       1       0       0    single static photo — the
//                                                             one frame above 0.10 peaks
//                                                             at 0.129, camera/lighting
//                                                             noise, not a cut
//
// T=0.15 is the only threshold tried that returns exactly zero for the genuinely
// static file while still keeping a non-trivial count everywhere else — it is the
// threshold picked here. It is not tuned per-genre; a single global number
// under-detects the caption-driven short and probably over-detects nothing (no ground
// truth was available to check against, only the unreliable card figures above).
const SCENE_THRESHOLD = 0.15;

// showinfo fires once per selected frame, and a real transition sometimes lights up two
// consecutive frames (the outgoing and incoming frame both score high against their
// neighbour). Measured on Fz89dJTZsko and StKa9LhH_-k: of the detections above 0.15,
// 32/464 and 24/125 respectively land within one frame (1/30 s ≈ 0.033 s) of the
// previous one — clearly the same transition counted twice, not two shots 33 ms apart.
// Anything closer than this is folded into the earlier detection.
const MIN_GAP = 0.1;

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, PATH: BIN_PATH } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on("data", (d) => { stdout += d; });
    // Unlike omniwatch.ts's run(), stderr is kept in full rather than the last 4000
    // chars: showinfo's cut list lives in stderr, and on a long video it is the payload,
    // not a diagnostic tail.
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", (e) => { clearTimeout(timer); reject(new Error(`${cmd} could not start: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} failed:\n${stderr.slice(-1500)}`));
    });
  });
}

/** The file's real length, off the file itself. Returns 0 when ffprobe cannot say —
 *  a corrupt or unreadable file — rather than throwing: the caller decides whether a
 *  missing duration is fatal, and for a cost estimate $0 is already the honest answer
 *  when there is nothing to base one on. */
export async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await runCapture("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ], 30_000);
    const s = parseFloat(stdout.trim());
    return Number.isFinite(s) && s > 0 ? s : 0;
  } catch {
    return 0;
  }
}

/** Real shot boundaries, from ffmpeg's own pixel-difference scoring rather than
 *  anything the model said. Decodes the whole file once (30x+ real-time on the 480p
 *  files this engine downloads — a 21-minute video took 29 s), which is the cost of
 *  this being measured instead of guessed.
 *
 *  A video with no detectable cuts — a talking head, a static product photo — returns
 *  a single shot spanning the whole length, never an empty list and never a thrown
 *  error: "one shot, this long" is itself the correct rhythm for that video. */
export async function detectCuts(file: string): Promise<Cut[]> {
  const total = await probeDuration(file);

  let stderr = "";
  try {
    ({ stderr } = await runCapture("ffmpeg", [
      "-i", file,
      "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
      "-f", "null", "-",
    ], 300_000));
  } catch {
    // A decode failure (unsupported codec, truncated download) must not take the whole
    // teardown down with it. One shot the length of the file — when that length is even
    // known — is the same honest fallback as the no-cuts case below; when it is not
    // known either, there is nothing to report, so nothing is.
    return total > 0 ? [{ at: 0, dur: total }] : [];
  }

  // showinfo's cut lines look like:
  //   [Parsed_showinfo_1 @ 0x...] n:  12 pts: 361 pts_time:12.03 ...
  const raw: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const t = parseFloat(m[1]);
    if (Number.isFinite(t)) raw.push(t);
  }
  raw.sort((a, b) => a - b);

  // Frame 0 can never score against a previous frame, so ffmpeg never reports it as a
  // cut — but it is always where the first shot starts. Prepended unconditionally, then
  // folded together with whatever ffmpeg did detect near the start.
  const starts: number[] = [0];
  for (const t of raw) {
    if (t - starts[starts.length - 1] >= MIN_GAP) starts.push(t);
  }

  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  // The last shot's length is only a guess when even ffprobe could not say how long the
  // file is — the same median-of-gaps fallback parseSkeleton.ts uses for the same
  // reason, bounded rather than invented from nothing.
  const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 2;

  return starts.map((at, i) => {
    const next = i < starts.length - 1 ? starts[i + 1] : (total > at ? total : undefined);
    return { at, dur: Math.max(0.1, next !== undefined ? next - at : median) };
  });
}
