import { NextResponse } from "next/server";
import { buildClone, type CloneInput } from "@/lib/omniwatchClone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

// POST /api/omniwatch/clone
//   { blueprint, sourceId?, fill?: "trace" | "empty" | "assets",
//     assets?: { "<region>" | "<region>:<item>": "<asset store name>" },
//     audio?: "<asset store name>", output?: { width, height }, debugRegions?: boolean }
//   → { ok, slug, indexUrl, renderUrl, regions, cut, filled, cutFromSource, missingAssets }
//
// A thin door onto omniwatchClone: the decisions live there, so the orchestrator that
// fills a whole episode uses the same code path instead of a second copy of it.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) return NextResponse.json({ error: "Send a JSON object with a blueprint." }, { status: 400 });

  const r = await buildClone(parsed as unknown as CloneInput);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
