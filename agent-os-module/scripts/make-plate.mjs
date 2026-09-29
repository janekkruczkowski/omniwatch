#!/usr/bin/env node
// A host plate: one still picture, the film's own length, the film's own sound.
//
//   node agent-os-module/scripts/make-plate.mjs --source <id|path> [--out name.mp4]
//        [--top 0.0] [--bottom 0.42]   the slice of frame to keep
//   node agent-os-module/scripts/clone-film.mjs --source <id> --host <that file> --film
//
// Why this exists. Testing a clone needs somebody on screen, and the two ways of getting one
// are both bad for testing: cutting the original brings its burned-in captions along, and
// asking a video model costs real money for a thing nobody is going to watch. Neither is
// paying for anything the test is actually about — the test is about whether the FORMAT came
// out right, and a format does not care whether its host moves.
//
// So: find the second of the film where its caption band is quietest, take the picture from
// there, hold it for the whole duration, and put the original soundtrack under it. One frame
// grab and one encode. Nothing is generated and nothing is spent.
//
// Two things make the picture usable. It is taken from the quietest second — the band's own
// pixels say which frames carry lettering — and it is CROPPED above the lettering, because
// on a film that captions almost every second there is no quiet frame to find. The first
// attempt skipped the crop and produced a plate with the original's caption still in it,
// which the clone then drew its own caption on top of: two lines sliding through each other.
//
// When there are credits to spend, the better plate is a generated one — the same framing
// with a subject of your own — and that is a swap rather than a stand-in. This is the
// version that costs nothing.
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";

const CACHE = path.join(homedir(), ".agentic-os", "omniwatch", "cache");
const PLATES = path.join(homedir(), ".agentic-os", "omniwatch", "plates");

const arg = (name, fallback = "") => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const SOURCE_ARG = arg("source");
if (!SOURCE_ARG) { console.error("--source <id|path> is required"); process.exit(2); }
const SOURCE = existsSync(SOURCE_ARG) ? path.resolve(SOURCE_ARG) : path.join(CACHE, SOURCE_ARG, "source.mp4");
if (!existsSync(SOURCE)) { console.error(`no such film: ${SOURCE}`); process.exit(2); }

const seconds = Number(execFileSync("ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", SOURCE], { encoding: "utf8" }).trim()) || 20;
const [W, H] = execFileSync("ffprobe",
  ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", SOURCE],
  { encoding: "utf8" }).trim().split(",").map(Number);

const work = mkdtempSync(path.join(tmpdir(), "plate-"));
mkdirSync(PLATES, { recursive: true });

/** Where a short-form caption sits, as a band to watch rather than a box to trust.
 *
 *  Deliberately generous — the lower half, minus the very bottom where a tier board or a
 *  platform's own chrome lives. The exact box does not matter here: the question is only
 *  which SECOND has the least lettering in it, and a band wider than the caption answers
 *  that just as well. */
const BAND = { y: 0.42, h: 0.28 };
const STEPS = 24;

// One pass, one call: the band cropped, shrunk to a strip, at a fixed rate.
const strip = path.join(work, "band.raw");
const SW = 96, SH = 12;
const fps = STEPS / seconds;
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", SOURCE,
  "-vf", `crop=iw:ih*${BAND.h}:0:ih*${BAND.y},scale=${SW}:${SH},format=gray`,
  "-r", String(fps), "-f", "rawvideo", strip]);
const buf = readFileSync(strip);
const frame = SW * SH;
const n = Math.floor(buf.length / frame);
if (n < 2) { console.error("the band could not be read"); process.exit(1); }

// Lettering is high CONTRAST against its band, not high brightness: white letters with a
// black stroke swing both ways. So the measure is how much neighbouring pixels differ,
// which text has a great deal of and an empty band has almost none.
let quietest = 0, least = Infinity;
for (let i = 0; i < n; i++) {
  let edges = 0;
  for (let row = 0; row < SH; row++) {
    for (let c = 1; c < SW; c++) {
      const k = i * frame + row * SW + c;
      edges += Math.abs(buf[k] - buf[k - 1]);
    }
  }
  if (edges < least) { least = edges; quietest = i; }
}
const at = Math.min(seconds - 0.05, (quietest + 0.5) / fps);
console.log(`the band is quietest at t=${at.toFixed(2)}s (${n} moments looked at)`);

// Keep the slice the host lives in, and nothing below it. Everything under this line — the
// caption, a board, a platform's own chrome — is drawn by the clone itself, from its own
// measurements, and a plate carrying the original's version of it can only collide.
const TOP = Number(arg("top", "0"));
const BOTTOM = Number(arg("bottom", String(BAND.y)));
const keep = Math.max(0.05, BOTTOM - TOP);
const still = path.join(work, "plate.png");
execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", at.toFixed(2), "-i", SOURCE, "-frames:v", "1",
  "-vf", `crop=iw:ih*${keep.toFixed(4)}:0:ih*${TOP.toFixed(4)}`, still]);
console.log(`keeping the frame from ${(TOP * 100).toFixed(0)}% to ${(BOTTOM * 100).toFixed(0)}% — below that is the clone's own to draw`);

const out = path.resolve(arg("out", path.join(PLATES, `${path.basename(path.dirname(SOURCE))}.mp4`)));
// A held frame with the film's own sound: the same length, the same rhythm to cut against,
// and nothing moving to distract from whether the format is right.
execFileSync("ffmpeg", ["-y", "-v", "error",
  "-loop", "1", "-i", still, "-i", SOURCE,
  "-map", "0:v", "-map", "1:a?", "-t", String(seconds),
  "-vf", `scale=${W}:${Math.max(2, Math.round((H * keep) / 2) * 2)}`, "-r", "30", "-pix_fmt", "yuv420p", "-shortest", out]);

console.log(`plate: ${out}`);
console.log(`use it with:  --host ${out}`);
