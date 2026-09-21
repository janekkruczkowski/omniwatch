// Checking a capture against the video it claims to describe.
//
// Why this exists, precisely: a capture put the caption band ninety pixels above the real
// caption, made the inset card twice its true size and missed that the title strip is black
// on white. Every one of those survived into a finished film, because nothing between the
// model and the render ever looked. The blueprint was taken on trust.
//
// So the pipeline looks. Each region's rectangle is drawn onto a real frame of the source
// in its own colour, the model is shown that picture together with what each colour claims
// to be, and it answers per region: does this box land on that thing, and if not, where is
// it really. A correction is a rect, so the answer goes straight back into the blueprint
// and can be validated like any other.
//
// This is deliberately a SEPARATE pass from the capture. Asking a model to be careful in
// the same breath as being thorough gets neither; asking it one narrow question about one
// picture it can see is the kind of question models answer well.
import { readFile } from "node:fs/promises";
import { apiKey, run } from "@/lib/omniwatch";
import { validateBlueprint, type Blueprint, type BlueprintRegion, type Rect } from "@/lib/omniwatchBlueprint";

const API = process.env.DASHSCOPE_API || "https://dashscope-intl.aliyuncs.com";
const MODEL = process.env.OMNI_VERIFY_MODEL || "qwen3.8-omni-flash";
/** Six boxes on one frame is already busy; more and the colours stop being tellable apart,
 *  which would make the check itself unreliable. */
export const PER_PASS = 6;
/** The frame is sent as data, so its size is the request's size. Measured: a 540px-wide
 *  JPEG is 78 KB and comes back in four seconds, while the full 720x1280 frame ran past
 *  three minutes and timed out. Boxes four pixels thick survive the downscale easily. */
const CHECK_WIDTH = 540;

const PENS = [
  { css: "#FF0000", name: "pure red" },
  { css: "#00FF00", name: "bright green" },
  { css: "#00FFFF", name: "cyan" },
  { css: "#FF00FF", name: "magenta" },
  { css: "#FFFF00", name: "yellow" },
  { css: "#FF8000", name: "orange" },
  { css: "#FFFFFF", name: "white" },
  { css: "#0080FF", name: "blue" },
];

export interface RegionCheck {
  id: string;
  ok: boolean;
  /** Where the thing really is, when the drawn box was wrong. */
  rect?: Rect;
  note?: string;
}

/** Draw one batch of rectangles onto a frame of the source. */
async function boxedFrame(src: string, at: number, ids: { id: string; rect: Rect }[], out: string): Promise<void> {
  const draws = ids.map((r, i) => {
    const pen = PENS[i % PENS.length].css;
    const [x, y, w, h] = r.rect;
    // iw/ih rather than pixels: the filter then works whatever the source's real size is,
    // which is the thing a capture routinely gets wrong.
    return `drawbox=x=iw*${x.toFixed(4)}:y=ih*${y.toFixed(4)}:w=iw*${w.toFixed(4)}:h=ih*${h.toFixed(4)}:color=${pen}@1:t=4`;
  });
  await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", at.toFixed(2), "-i", src,
    "-frames:v", "1", "-vf", `${draws.join(",")},scale=${CHECK_WIDTH}:-2`, "-q:v", "4", out], 120_000);
}

function legend(ids: { id: string; rect: Rect; label?: string }[]): string {
  return ids.map((r, i) =>
    `- the ${PENS[i % PENS.length].name} box claims to be "${r.id}"${r.label ? ` (${r.label})` : ""}`).join("\n");
}

const PROMPT = (lines: string, ids: string[]) => `This picture is one frame of a video with rectangles drawn on it.

${lines}

"id" in your answer must be one of these exact names, never the colour:
${ids.join(", ")}

For each box, answer whether it actually lands on the thing it claims to be. A box is WRONG
if it is shifted off the thing, much bigger or much smaller than it, or if the thing it
claims is not in the picture at all.

When a box is wrong, give the rectangle where that thing REALLY is, as fractions of the
frame: [x, y, width, height], origin top-left, so [0, 0, 1, 0.1] is a strip across the top.
Measure it; do not repeat the box you were shown and do not round to a tidy number.

For an area whose content is WORDS, give the area the words sit in, not a box drawn tightly
around the words that happen to be on screen now. A caption band is the same size when a
short line is showing as when a long one is.

If a thing is genuinely not visible in this frame — it appears later, or is hidden behind
something — say ok true and note that, rather than inventing a rectangle for it.

Return ONE JSON object and nothing else:
{"checks":[{"id":"<the id>","ok":true|false,"rect":[x,y,w,h],"note":"<a few words>"}]}
Include "rect" only when ok is false.`;

async function ask(key: string, jpeg: Buffer, prompt: string): Promise<string> {
  const r = await fetch(`${API}/compatible-mode/v1/chat/completions`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(240_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      // Omni answers streaming only; one modest answer is small enough to take in one piece.
      stream: true,
      stream_options: { include_usage: false },
      modalities: ["text"],
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  if (!r.ok) throw new Error(`the vision model answered ${r.status}`);
  const raw = await r.text();
  // Server-sent events: the text arrives as deltas across many lines.
  let text = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    try {
      const j = JSON.parse(body) as { choices?: { delta?: { content?: string } }[] };
      text += j.choices?.[0]?.delta?.content ?? "";
    } catch { /* a partial line — the next one completes it */ }
  }
  return text.trim();
}

function readChecks(text: string): RegionCheck[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: { checks?: unknown };
  try { parsed = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(parsed.checks)) return [];
  const out: RegionCheck[] = [];
  for (const c of parsed.checks) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) continue;
    const ok = o.ok !== false;
    let rect: Rect | undefined;
    if (!ok && Array.isArray(o.rect) && o.rect.length === 4 && o.rect.every((n) => typeof n === "number" && Number.isFinite(n))) {
      const [x, y, w, h] = o.rect as number[];
      // A "correction" that is not a rectangle on this canvas is not a correction.
      if (w > 0 && h > 0 && x >= -0.5 && y >= -0.5 && x + w <= 1.5 && y + h <= 1.5) rect = [x, y, w, h];
    }
    out.push({ id, ok, ...(rect ? { rect } : {}), ...(typeof o.note === "string" ? { note: o.note.slice(0, 160) } : {}) });
  }
  return out;
}

/** A grid says which regions are the same KIND of thing, so a correction to one of them is
 *  a correction to all of them.
 *
 *  Measured: the C and D tier labels were found too narrow and fixed, while S, A and B —
 *  identical cells in the same column, carrying the identical wrong width — were waved
 *  through. One frame, one model, five chances to be consistent and it took three. The grid
 *  already records that those five are one column; using it turns an inconsistent answer
 *  into a consistent one without asking again. */
function spreadAcrossSiblings(
  before: BlueprintRegion[], after: BlueprintRegion[], corrected: string[],
): BlueprintRegion[] {
  const was = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

  for (const id of corrected) {
    const old = was.get(id), fixed = now.get(id);
    if (!old || !fixed || !old.at || !old.parent) continue;
    for (const sib of after) {
      if (sib.id === id || sib.parent !== old.parent || !sib.at) continue;
      const sibWas = was.get(sib.id);
      if (!sibWas || corrected.includes(sib.id)) continue;
      // Same column: the horizontal measurement is shared. Same row: the vertical one.
      if (sib.at.col === old.at.col && near(sibWas.rect[0], old.rect[0]) && near(sibWas.rect[2], old.rect[2])) {
        now.set(sib.id, { ...sib, rect: [fixed.rect[0], sib.rect[1], fixed.rect[2], sib.rect[3]] });
      } else if (sib.at.row === old.at.row && near(sibWas.rect[1], old.rect[1]) && near(sibWas.rect[3], old.rect[3])) {
        now.set(sib.id, { ...sib, rect: [sib.rect[0], fixed.rect[1], sib.rect[2], fixed.rect[3]] });
      }
    }
  }
  return after.map((r) => now.get(r.id) ?? r);
}

export type VerifyResult =
  | { ok: true; blueprint: Blueprint; checks: RegionCheck[]; corrected: string[]; frames: number }
  | { ok: false; error: string; status?: number };

/** Look at the capture, region by region, and hand back a corrected blueprint.
 *
 *  `at` are the seconds to look at. More than one matters: an overlay that only appears
 *  halfway through cannot be judged from the opening frame, and judging it there would
 *  "correct" a perfectly good rectangle into nonsense. */
export async function verifyBlueprint(
  bp: Blueprint, source: string, at: number[], tmp: (name: string) => string,
): Promise<VerifyResult> {
  const key = await apiKey();
  if (!key) return { ok: false, status: 503, error: "No DashScope key, so nothing can be checked." };

  const byId = new Map(bp.regions.map((r) => [r.id, r]));
  const best = new Map<string, RegionCheck>();
  let frames = 0;

  for (const sec of at) {
    for (let i = 0; i < bp.regions.length; i += PER_PASS) {
      const batch = bp.regions.slice(i, i + PER_PASS)
        .map((r) => ({ id: r.id, rect: r.rect, label: r.label }));
      const file = tmp(`check-${Math.round(sec * 100)}-${i}.jpg`);
      try { await boxedFrame(source, sec, batch, file); } catch { continue; }
      frames++;
      let answer: string;
      try { answer = await ask(key, await readFile(file), PROMPT(legend(batch), batch.map((b) => b.id))); }
      catch (e) { return { ok: false, status: 502, error: String((e as Error).message || e) }; }
      for (const c of readChecks(answer)) {
        if (!byId.has(c.id)) continue;
        const had = best.get(c.id);
        // A region only has to be right ONCE to be right: it may be absent from another
        // frame, and an absence must not overrule a sighting.
        if (had?.ok) continue;
        if (!had || (!c.ok && c.rect) || c.ok) best.set(c.id, c);
      }
    }
  }

  const corrected: string[] = [];
  let regions = bp.regions.map((r) => {
    const c = best.get(r.id);
    if (!c || c.ok || !c.rect) return r;
    // A text area is sized by the FORMAT; what is on screen is one line out of many. A
    // correction that only shrinks it is evidence about the words, not about the area —
    // measured: a caption band came back as the bounding box of "walks around", which
    // would have made every other line in that format overflow it.
    if (r.role === "text") {
      const [, , w, h] = r.rect;
      const [nx, ny, nw, nh] = c.rect;
      const kept: Rect = [nx, ny, Math.max(nw, w), Math.max(nh, h)];
      corrected.push(r.id);
      return { ...r, rect: kept };
    }
    corrected.push(r.id);
    return { ...r, rect: c.rect };
  });
  regions = spreadAcrossSiblings(bp.regions, regions, corrected);

  // Corrections go back through the same door as everything else: a "fix" that breaks the
  // blueprint is not applied, and says so.
  const checked = validateBlueprint({ ...bp, regions });
  if (!checked.ok) return { ok: false, status: 502, error: `the corrections do not validate: ${checked.error}` };
  return { ok: true, blueprint: checked.blueprint, checks: [...best.values()], corrected, frames };
}
