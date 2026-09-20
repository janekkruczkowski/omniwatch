import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seenUrls } from "@/lib/omniwatchScout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hermes Astros already sweeps YouTube for what competitors are publishing — but it
// works from titles and view counts, because nothing in Agent OS can open a video.
// This reads what it found so Scout can do the part Astros cannot: watch the thing.
//
// No scraping happens here. Astros owns discovery on YouTube; duplicating it would
// cost the user API quota to learn what is already sitting in a file.

const LATEST = path.join(os.homedir(), ".agentic-os", "astros", "latest.json");

interface AstroTopic {
  topic?: string;
  why_hot?: string;
  heat?: number;
  competitor?: { channel?: string; video_title?: string; url?: string; views?: string; age?: string };
}

export async function GET() {
  let raw: { topics?: AstroTopic[]; scannedAt?: string } | AstroTopic[];
  try {
    raw = JSON.parse(await readFile(LATEST, "utf8"));
  } catch {
    return NextResponse.json({ available: false, topics: [] });
  }

  const list: AstroTopic[] = Array.isArray(raw) ? raw : (raw.topics || []);
  const seen = await seenUrls();

  const topics = list
    .filter((t) => t.competitor?.url?.startsWith("http"))
    .slice(0, 12)
    .map((t) => ({
      topic: t.topic || "",
      whyHot: t.why_hot || "",
      heat: t.heat ?? null,
      channel: t.competitor?.channel || "",
      title: t.competitor?.video_title || "",
      url: t.competitor!.url!,
      views: t.competitor?.views || "",
      age: t.competitor?.age || "",
      watched: seen.has(t.competitor!.url!),
    }));

  return NextResponse.json({
    available: true,
    scannedAt: Array.isArray(raw) ? null : raw.scannedAt || null,
    topics,
  });
}
