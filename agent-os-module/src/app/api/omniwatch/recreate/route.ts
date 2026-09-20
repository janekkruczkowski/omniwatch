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
import path from "node:path";

import { cacheKey, videoDir, lang } from "@/lib/omniwatch";
import { parseSkeleton, type Skeleton } from "@/lib/omniwatchSkeleton";
import {
  newBriefId, readBrief, listBriefs, saveBrief, groupIntoIdeas, rhythmFrom, visualFor,
  type Brief, type BriefScene,
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
 *  other's job. */
function layTextOnCuts(shots: { at: number; dur: number }[], sk: Skeleton | null): BriefScene[] {
  return shots.map((s) => {
    const beat = sk?.beats.filter((b) => b.start <= s.at + 0.5).slice(-1)[0];
    return { seconds: s.dur, role: beat?.text?.slice(0, 120), narration_line: "", caption: "" };
  });
}

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
  const l = lang(String(body.lang || "en"));
  const sk = teardown ? parseSkeleton(teardown, Number(body.seconds) || 0, l.sections.beats) : null;

  const src = path.join(videoDir(cacheKey(url)), "source.mp4");
  const shots = existsSync(src) ? await cuts(src) : null;

  const seconds = Number(body.seconds) || sk?.seconds || 0;
  const rhythm = rhythmFrom(shots, sk?.beats, seconds);

  let scenes: BriefScene[];
  if (rhythm.from === "cuts" && shots && shots.length) {
    scenes = layTextOnCuts(shots, sk);
  } else if (sk && sk.beats.length) {
    scenes = sk.beats.map((b) => ({ seconds: b.dur, role: b.text.slice(0, 120), narration_line: "", caption: "" }));
  } else if (shots && shots.length) {
    // ffmpeg says one long shot and there is no teardown to disagree with it. That is a
    // real answer for a static video, not a failure.
    scenes = layTextOnCuts(shots, sk);
  } else {
    return NextResponse.json({ error: "Nothing to copy the shape of — watch the video first." }, { status: 400 });
  }
  const measured = rhythm.from === "cuts";

  // One asset per idea, not per cut. Three one-second shots of the same subject are one
  // idea cut three times; asking a video generator for three clips there costs three
  // times as much and looks worse. Every original shot keeps its own duration — the
  // grouping decides what to fetch, never how long anything holds.
  const ideas = groupIntoIdeas(scenes).map((g) => {
    const role = g.find((s) => s.role)?.role;
    return {
      seconds: Number(g.reduce((a, s) => a + s.seconds, 0).toFixed(2)),
      role,
      narration_line: "",
      caption: "",
      visual: visualFor(role),
    };
  });

  const brief: Brief = {
    id: newBriefId(),
    at: new Date().toISOString(),
    source: { url, title: String(body.title || "") || undefined, seconds: seconds || undefined },
    topic,
    angle: String(body.angle || "").trim() || undefined,
    mode,
    measured,
    rhythm,
    scenes: ideas,
    teardown: teardown || undefined,
  };
  await saveBrief(brief);

  return NextResponse.json({
    ok: true,
    id: brief.id,
    measured,
    rhythm: brief.rhythm,
    scenes: brief.scenes.length,
    shots: scenes.length,
    seconds: Number(brief.scenes.reduce((a, s) => a + s.seconds, 0).toFixed(1)),
    // Where to send the person. The Director reads this parameter and fills its brief
    // stage from the stored plan.
    next: `/video?brief=${brief.id}`,
  });
}
