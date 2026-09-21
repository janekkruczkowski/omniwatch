import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateBlueprint } from "@/lib/omniwatchBlueprint";
import { wordsOf, cuesFromWords, alignCues, type ScreenCue } from "@/lib/omniwatchTranscript";
import { videoDir } from "@/lib/omniwatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

// POST /api/omniwatch/captions
//   { blueprint, sourceId, region?, screen?, karaoke?, gap?, maxWords?, maxChars? }
//   → { ok, blueprint, region, words, items, snapped, kept, text }
//
// Times a caption track by LISTENING, and — when the vision pass has also read the screen —
// words it by LOOKING. Neither alone is right: the caption on screen is usually shorter
// than the sentence and one word in it is boxed, which only something that can see knows;
// and the moment a word lands is something only an aligner gets to the hundredth.
//
// Without `screen` it falls back to cutting the speech into cues, which is what a tool
// with no vision model can do.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) return NextResponse.json({ error: "Send a JSON object with a blueprint and a sourceId." }, { status: 400 });

  const checked = validateBlueprint(parsed.blueprint);
  if (!checked.ok) return NextResponse.json({ error: `blueprint: ${checked.error}` }, { status: 400 });
  const bp = checked.blueprint;

  const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId.trim() : "";
  if (!sourceId) return NextResponse.json({ error: "sourceId required — the video to listen to" }, { status: 400 });
  let dir: string;
  try { dir = videoDir(sourceId); } catch { return NextResponse.json({ error: "bad sourceId" }, { status: 400 }); }
  let source = "";
  for (const f of ["master.mp4", "source.mp4"]) {
    if (existsSync(path.join(dir, f))) { source = path.join(dir, f); break; }
  }
  if (!source) return NextResponse.json({ error: "that video is not in the cache any more" }, { status: 404 });

  // Which track carries the narration. Named, or else the text track that changes most —
  // which is what a word-timed caption looks like from the outside.
  const asked = typeof parsed.region === "string" ? parsed.region.trim() : "";
  const spoken = bp.tracks
    .filter((t) => t.kind === "text" && (asked ? t.region === asked : t.varies === "episode"))
    .sort((a, b) => b.items.length - a.items.length)[0];
  if (!spoken) return NextResponse.json({ error: "no caption track to re-time" }, { status: 400 });

  const work = await mkdtemp(path.join(tmpdir(), "omni-stt-"));
  const w = await wordsOf(source, path.join(work, "audio.mp3"));
  if (!w.ok) return NextResponse.json({ error: w.error }, { status: w.status ?? 502 });

  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

  // What the vision pass read off the screen, if it was run. Anything malformed is simply
  // not a cue; a bad row must not take the whole caption track with it.
  const screen: ScreenCue[] = (Array.isArray(parsed.screen) ? parsed.screen : [])
    .filter((r): r is Record<string, unknown> => isObj(r))
    .filter((r) => typeof r.text === "string" && r.text.trim()
      && Number.isFinite(Number(r.start)) && Number.isFinite(Number(r.end)))
    .map((r) => ({
      start: Number(r.start), end: Number(r.end), text: String(r.text).trim(),
      where: typeof r.where === "string" ? r.where : undefined,
      marked: typeof r.marked === "string" && r.marked.trim() ? r.marked.trim() : undefined,
    }));

  if (screen.length) {
    const a = alignCues(screen, w.words);
    const tracks2 = bp.tracks.map((t) => (t === spoken ? { ...t, items: a.items.filter((i) => i.start < bp.canvas.seconds) } : t));
    const out2 = validateBlueprint({ ...bp, tracks: tracks2 });
    if (!out2.ok) return NextResponse.json({ error: `aligned caption does not validate: ${out2.error}` }, { status: 502 });
    return NextResponse.json({
      ok: true, region: spoken.region, words: w.words.length, source: "screen+speech",
      items: a.items.length, was: spoken.items.length, snapped: a.snapped, kept: a.kept,
      text: w.text, blueprint: out2.blueprint,
    });
  }

  const items = cuesFromWords(w.words, {
    karaoke: parsed.karaoke !== false,
    gap: num(parsed.gap, 0.35),
    maxWords: num(parsed.maxWords, 4),
    maxChars: num(parsed.maxChars, 34),
  }).filter((i) => i.start < bp.canvas.seconds);

  const tracks = bp.tracks.map((t) => (t === spoken ? { ...t, items } : t));
  const out = validateBlueprint({ ...bp, tracks });
  if (!out.ok) return NextResponse.json({ error: `re-timed caption does not validate: ${out.error}` }, { status: 502 });

  return NextResponse.json({
    ok: true, region: spoken.region, words: w.words.length, source: "speech",
    items: items.length, was: spoken.items.length, text: w.text,
    blueprint: out.blueprint,
  });
}
