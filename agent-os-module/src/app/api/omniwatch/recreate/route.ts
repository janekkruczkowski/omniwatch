// POST /api/omniwatch/recreate — a watched video becomes a brief for making your own.
// GET  /api/omniwatch/recreate?id=…  — read one back (this is what the video tab calls)
// GET  /api/omniwatch/recreate       — list recent briefs
//
// This is the join between the two halves of the product. Until now OmniWatch ended at
// "here is how that video is built" and the person went off to build theirs by hand,
// which meant rebuilding their memory of the teardown rather than the teardown. The
// brief is what crosses: the shape of the thing, in the form the Director on the other
// side already accepts.
//
// Where the rhythm comes from is decided per video, and the decision is recorded in the
// brief rather than assumed. ffmpeg is the honest source for camera cuts, and the model
// is not: its beat list is capped at twelve bullets by our own prompt, and asked three
// times about the same 47-second file it answered 4, then 12, then 2-3 cuts per 10 s.
//
// But ffmpeg is blind to the format this audience actually makes. On the same file at
// the same threshold it finds 2 cuts, because the framing never changes — the pace is
// carried by captions and graphics swapping inside one static shot, which a
// pixel-difference detector correctly does not see as a cut. There the model, which
// watched the screen, is the better instrument. `rhythmFrom` picks between them and
// says why; when the file has aged out of the cache there is only the prose, and the
// brief says that too.

import { NextResponse } from "next/server";
import { existsSync } from "node:fs";

import { cacheKey, videoDir, lang } from "@/lib/omniwatch";
import { parseSkeleton, type Skeleton } from "@/lib/omniwatchSkeleton";
import {
  newBriefId, readBrief, listBriefs, saveBrief, ideaIds, rhythmFrom, visualFor, MAX_SCENES,
  beatRole, evidenceFrom, normalizePurpose, probeSize, referenceFor, sourceFileIn,
  type Brief, type BriefScene, type ClipQuality,
} from "@/lib/omniwatchRecreate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The cut detector lives in a file another stream owns and may not be installed in an
 *  older copy of the module. Importing it lazily means the bridge degrades to the prose
 *  path instead of failing to build. */
async function cuts(file: string): Promise<{ at: number; dur: number }[] | null> {
  try {
    const mod = await import("@/lib/omniwatchCuts");
    return await mod.detectCuts(file);
  } catch { return null; }
}

/** Pairs each shot with whatever the model said was happening at that second. The
 *  timing is ffmpeg's, the words are the model's, and neither is asked to do the
 *  other's job. The start is kept explicitly — `at` is the measurement, and a shot
 *  list that is ever non-contiguous must not have its references shifted by summing
 *  durations. */
function layTextOnCuts(shots: { at: number; dur: number }[], sk: Skeleton | null): BriefScene[] {
  return shots.map((s) => {
    const beat = sk?.beats.filter((b) => b.start <= s.at + 0.5).slice(-1)[0];
    return { seconds: s.dur, start: s.at, role: beatRole(beat?.text), narration_line: "", caption: "" };
  });
}

/** Which clock the references' bounds came off, for the brief to record per scene:
 *  ffmpeg's cut list is a measurement, the parsed beat list is the model's own
 *  timestamps, and the two are not interchangeable (see rhythmFrom). */
type SceneTiming = "measured" | "estimated";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: true, briefs: await listBriefs() });
  const brief = await readBrief(id);
  if (!brief) return NextResponse.json({ error: "No such brief. It may have been from another machine." }, { status: 404 });
  return NextResponse.json({ ok: true, brief });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  const topic = String(body.topic || "").trim();
  const teardown = String(body.text || "");

  if (!url) return NextResponse.json({ error: "Which video? Pass the link you watched." }, { status: 400 });
  if (!topic) {
    // Deliberately a hard stop rather than a default. A brief with no subject of its own
    // is just the other person's video with the serial numbers filed off, and the whole
    // design of this module says we do not do that.
    return NextResponse.json({ error: "Say what YOUR video is about first — the rhythm is copied, the subject is yours." }, { status: 400 });
  }

  const mode = body.mode === "voiceover" ? "voiceover" : "avatar";
  // What the narration is allowed to be. Anything that is not "review" is "pattern",
  // which is the shape this bridge has always had — see normalizePurpose.
  const purpose = normalizePurpose(body.purpose);
  const l = lang(String(body.lang || "en"));
  const sk = teardown ? parseSkeleton(teardown, Number(body.seconds) || 0, l.sections.beats) : null;

  // The cache key is the id every other OmniWatch route already uses, and the only
  // name a clip or frame URL is ever built from.
  const id = cacheKey(url);
  const dir = videoDir(id);
  const cached = existsSync(dir) ? sourceFileIn(dir) : null;
  const shots = cached ? await cuts(cached.file) : null;
  const size = cached ? await probeSize(cached.file) : null;

  const seconds = Number(body.seconds) || sk?.seconds || 0;
  const rhythm = rhythmFrom(shots, sk?.beats, seconds);

  let scenes: BriefScene[];
  let timing: SceneTiming;
  if (rhythm.from === "cuts" && shots && shots.length) {
    scenes = layTextOnCuts(shots, sk);
    timing = "measured";
  } else if (sk && sk.beats.length) {
    scenes = sk.beats.map((b) => ({ seconds: b.dur, start: b.start, role: beatRole(b.text), narration_line: "", caption: "" }));
    timing = "estimated";
  } else if (shots && shots.length) {
    // ffmpeg says one long shot and there is no teardown to disagree with it. That is a
    // real answer for a static video, not a failure.
    scenes = layTextOnCuts(shots, sk);
    timing = "measured";
  } else {
    return NextResponse.json({ error: "Nothing to copy the shape of — watch the video first." }, { status: 400 });
  }
  const measured = rhythm.from === "cuts";

  // Every shot stays its own scene, with its own `seconds`. This used to merge
  // consecutive short shots into one scene and sum their durations, which turned the
  // format this bridge exists for — a 47-second edit cut every 0.8 s — into a single
  // scene, and gave a 2 s shot followed by three 0.5 s cuts back as one 3.5 s hold.
  // The asset decision is metadata now: `idea` says which shots may share one fetched
  // clip, and nothing is allowed to move the timing.
  const ids = ideaIds(scenes);
  // Each scene's evidence is attached here, from the start the clock gave us rather
  // than from a running total. Nothing is clamped or rounded to fit: a 47-second brief
  // over a 46.8-second file is rounding, and the stored estimate is what the teardown
  // and the cut list actually said. The clip route is where that gets reconciled with
  // the file, by clamping the request to the real duration and saying so in the
  // response — the record keeps the number it was given.
  const quality: ClipQuality | undefined = cached?.quality;
  const plan: BriefScene[] = scenes.map((s, i) => ({
    ...s,
    idea: ids[i],
    visual: visualFor(s.role),
    ...(cached
      ? {
          reference: referenceFor({
            sourceUrl: url,
            cacheId: id,
            start: s.start ?? 0,
            end: (s.start ?? 0) + s.seconds,
            description: s.role,
            timing,
            quality,
          }),
        }
      : {}),
  }));
  const ideaCount = ids.length ? Math.max(...ids) + 1 : 0;
  // A shot list longer than the pipeline's 60-scene ceiling is stored whole and the
  // ceiling is recorded, so the Director can say so instead of dropping the tail in
  // silence. The stored plan is never shortened.
  const capped = plan.length > MAX_SCENES ? { max: MAX_SCENES, total: plan.length } : undefined;

  const brief: Brief = {
    id: newBriefId(),
    at: new Date().toISOString(),
    source: {
      url,
      title: String(body.title || "") || undefined,
      seconds: seconds || undefined,
      ...(cached ? { id, ...(size ? { width: size.width, height: size.height } : {}) } : {}),
    },
    topic,
    angle: String(body.angle || "").trim() || undefined,
    mode,
    purpose,
    measured,
    rhythm,
    scenes: plan,
    ...(capped ? { capped } : {}),
    teardown: teardown || undefined,
    evidence: evidenceFrom(teardown, l.sections),
  };
  await saveBrief(brief);

  return NextResponse.json({
    ok: true,
    id: brief.id,
    purpose: brief.purpose,
    measured,
    rhythm: brief.rhythm,
    scenes: brief.scenes.length,
    shots: scenes.length,
    ideas: ideaCount,
    // Whether the source is still on disk and, if so, what the clips would be cut
    // from. A `proxy` answer is the ~480p analysis download — fine to review against,
    // not what a finished video should be cut from; POST /api/omniwatch/clip prepares
    // a master beside it.
    source: { cached: !!cached, ...(cached ? { id, quality } : {}), ...(size ? { width: size.width, height: size.height } : {}) },
    references: brief.scenes.filter((s) => s.reference).length,
    ...(capped ? { capped } : {}),
    seconds: Number(brief.scenes.reduce((a, s) => a + s.seconds, 0).toFixed(1)),
    // Where to send the person. The Director reads this parameter and fills its brief
    // stage from the stored plan.
    next: `/video?brief=${brief.id}`,
  });
}
