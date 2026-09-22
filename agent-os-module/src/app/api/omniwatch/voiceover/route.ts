// POST /api/omniwatch/voiceover { text }  → { ok, audioUrl, provider: "local" }
// GET  /api/omniwatch/voiceover           → { available }
// GET  /api/omniwatch/voiceover?file=…mp3 → the audio itself
//
// The Mac's own voice, so a script can be heard without paying a narrator or sending
// the text anywhere. The answer says `provider: "local"` out loud, because a caller
// that later switches to a cloud voice has to be able to tell which one it got.

import { NextResponse } from "next/server";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import path from "node:path";

import { MAX_TEXT, VOICE_ROOT, installedVoices, synthesize, voiceAvailable } from "@/lib/omniwatchVoice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const file = new URL(req.url).searchParams.get("file");
  if (!file) return NextResponse.json({ available: await voiceAvailable() });

  // The name is a hash we made ourselves, so it is checked rather than trusted: nothing
  // here may be talked into reading a path.
  if (!/^[a-f0-9]{32}\.mp3$/.test(file)) return new Response("bad name", { status: 400 });
  const abs = path.join(VOICE_ROOT, file);
  if (!existsSync(abs)) return new Response("not found", { status: 404 });

  const s = await stat(abs);
  const node = createReadStream(abs);
  return new Response(Readable.toWeb(node) as NodeReadableStream as ReadableStream, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(s.size),
      "Cache-Control": "max-age=86400", // the same text is always the same audio
    },
  });
}

export async function POST(req: Request) {
  // `await req.json()` answers null for a body of "null" and a number for "5", so the
  // shape is checked rather than assumed: reading `.text` off null is a 500, not a 400.
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Send a JSON object with the text to read aloud." }, { status: 400 });
  }
  const { text: rawText, voice: rawVoice } = body as { text?: unknown; voice?: unknown };
  if (rawText !== undefined && typeof rawText !== "string") {
    return NextResponse.json({ error: "text must be a string." }, { status: 400 });
  }
  const text = (rawText || "").trim();
  if (!text) return NextResponse.json({ error: "Nothing to read aloud — pass the text." }, { status: 400 });
  if (text.length > MAX_TEXT) {
    return NextResponse.json({
      error: `That is ${text.length} characters; one request is capped at ${MAX_TEXT}.`,
    }, { status: 400 });
  }
  if (rawVoice !== undefined && rawVoice !== null && typeof rawVoice !== "string") {
    return NextResponse.json({ error: "voice must be a string." }, { status: 400 });
  }
  const voice = (rawVoice || "").trim();
  if (voice.length > 64) return NextResponse.json({ error: "That is not a voice name." }, { status: 400 });
  if (!(await voiceAvailable())) {
    return NextResponse.json({
      error: "The Mac's own voice needs macOS, with `say` and ffmpeg available.",
    }, { status: 503 });
  }
  // A voice has to be one this Mac already has: nothing is installed on request, and a
  // free-text name is the other half of the argument-injection question.
  if (voice && !(await installedVoices()).includes(voice)) {
    return NextResponse.json({ error: `This Mac has no voice called "${voice}".` }, { status: 400 });
  }

  try {
    const out = await synthesize(text, voice);
    return NextResponse.json({
      ok: true,
      audioUrl: `/api/omniwatch/voiceover?file=${path.basename(out.file)}`,
      provider: "local",
      cached: out.cached,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read that aloud" }, { status: 500 });
  }
}
