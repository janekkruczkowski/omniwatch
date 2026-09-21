import { NextResponse } from "next/server";
import { validateBlueprint, deriveFormat } from "@/lib/omniwatchBlueprint";
import { saveFormat, readFormat, listFormats, describeFormat } from "@/lib/omniwatchFormats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/omniwatch/formats              → { formats: [...] }
// GET  /api/omniwatch/formats?id=x         → the stored format
// GET  /api/omniwatch/formats?id=x&as=text → the same, for a person to read
// POST /api/omniwatch/formats { blueprint, name, fromSource? } → { ok, id, format }
//
// One capture is one episode. What is worth keeping is the shape it shares with the next
// one, and keeping it on disk is what turns a teardown into a library — which is also the
// only real test of whether the schema is general, because twenty formats from twenty
// different videos show at once what it cannot express.

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ formats: await listFormats() });
  const s = await readFormat(id);
  if (!s) return NextResponse.json({ error: "no such format" }, { status: 404 });
  if (url.searchParams.get("as") === "text") {
    return new NextResponse(describeFormat(s), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return NextResponse.json(s);
}

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!isObj(parsed)) return NextResponse.json({ error: "Send a JSON object with a blueprint and a name." }, { status: 400 });

  const checked = validateBlueprint(parsed.blueprint);
  if (!checked.ok) return NextResponse.json({ error: `blueprint: ${checked.error}` }, { status: 400 });

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required — a format nobody can name is a format nobody will reuse" }, { status: 400 });
  const fromSource = typeof parsed.fromSource === "string" ? parsed.fromSource.trim() : undefined;

  const stored = await saveFormat(name, deriveFormat(checked.blueprint), fromSource);
  return NextResponse.json({ ok: true, id: stored.id, format: stored.format });
}
