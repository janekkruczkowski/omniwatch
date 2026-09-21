// The format library.
//
// A capture describes one episode of something. deriveFormat() lifts out the part that
// would be the same next time. Until now that lifted shape existed only for as long as one
// request, which meant the project had a teardown and no library — and a library is the
// only honest test of whether the schema is general. One format proves nothing; twenty
// formats from twenty different videos show immediately what the schema cannot say.
//
// Stored as one validated JSON document per format, under the OmniWatch root beside the
// video cache. JSON rather than a prettier format because this file is read back by the
// validator: a format sheet that cannot be checked is a format sheet that rots. A readable
// rendering is a view of it, not a second copy of it.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { OMNI_ROOT } from "@/lib/omniwatch";
import { BLUEPRINT_VERSION, defaultFill, type VideoFormat } from "@/lib/omniwatchBlueprint";

export const FORMATS_ROOT = path.join(OMNI_ROOT, "formats");

export interface StoredFormat {
  id: string;
  name: string;
  /** The video this was lifted from, so a format can always be traced back to evidence. */
  fromSource?: string;
  savedAt: number;
  format: VideoFormat;
}

/** A name a human chose, reduced to something safe to be a filename. */
export function formatId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  // A short hash keeps two formats with the same obvious name apart without making the
  // filename unreadable.
  return `${slug || "format"}-${createHash("sha1").update(name).digest("hex").slice(0, 6)}`;
}

const safeId = (id: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);

export async function saveFormat(name: string, format: VideoFormat, fromSource?: string): Promise<StoredFormat> {
  await mkdir(FORMATS_ROOT, { recursive: true });
  const stored: StoredFormat = {
    id: formatId(name), name: name.slice(0, 120), savedAt: Date.now(),
    ...(fromSource ? { fromSource } : {}), format,
  };
  await writeFile(path.join(FORMATS_ROOT, `${stored.id}.json`), JSON.stringify(stored, null, 2));
  return stored;
}

export async function readFormat(id: string): Promise<StoredFormat | null> {
  if (!safeId(id)) return null;
  try {
    const j = JSON.parse(await readFile(path.join(FORMATS_ROOT, `${id}.json`), "utf8")) as StoredFormat;
    return j?.format?.version === BLUEPRINT_VERSION ? j : null;
  } catch { return null; }
}

export async function listFormats(): Promise<{ id: string; name: string; savedAt: number; regions: number; slots: number; beats: number }[]> {
  let names: string[];
  try { names = await readdir(FORMATS_ROOT); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const s = await readFormat(f.slice(0, -5));
    if (!s) continue;
    out.push({
      id: s.id, name: s.name, savedAt: s.savedAt,
      regions: s.format.regions.length, slots: s.format.slots.length, beats: s.format.beats,
    });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** The same document, for a person to read.
 *
 *  Not a second source of truth and never parsed back — it exists because a format you
 *  cannot read is a format nobody will notice is wrong. */
export function describeFormat(s: StoredFormat): string {
  const f = s.format;
  const L: string[] = [
    `${s.name}`,
    `${f.canvas.width}x${f.canvas.height} at ${f.canvas.fps}fps · ${f.beats} beat${f.beats === 1 ? "" : "s"} · ${f.regions.length} regions · ${f.slots.length} slots`,
    "",
    "LAYOUT",
  ];
  for (const r of [...f.regions].sort((a, b) => a.z - b.z)) {
    const [x, y, w, h] = r.rect;
    const bits = [`z${r.z}`];
    if (r.parent) bits.push(`in ${r.parent}`);
    if (r.grid) bits.push(`${r.grid.rows}x${r.grid.cols} grid`);
    if (r.at) bits.push(`row ${r.at.row} col ${r.at.col}`);
    if (r.paint?.fill) bits.push(`fill ${r.paint.fill}`);
    if (r.paint?.border) bits.push(`border ${r.paint.border.color}`);
    L.push(`  ${r.id} (${r.role}) — ${(x * 100).toFixed(1)}%,${(y * 100).toFixed(1)}% ${(w * 100).toFixed(1)}x${(h * 100).toFixed(1)} · ${bits.join(" · ")}`
      + (r.label ? `\n      "${r.label}"` : ""));
  }
  L.push("", "SCAFFOLDING — the same in every episode");
  for (const t of f.fixed) {
    L.push(`  ${t.region} (${t.kind}, ${t.fill ?? defaultFill(t.kind)}) — ${t.items.length} item${t.items.length === 1 ? "" : "s"}`
      + `\n      e.g. ${t.items[0]?.value.slice(0, 90) ?? ""}`);
  }
  L.push("", "SLOTS — what an episode has to supply");
  for (const s2 of f.slots) {
    const when = s2.perBeat ? `${s2.perUnit} per beat (up to ${s2.perUnitMax})` : `${s2.perUnit} for the whole video`;
    L.push(`  ${s2.id} — ${when} · ${s2.fill}`
      + (s2.style?.emphasis ? ` · emphasis ${s2.style.emphasis.style}` : "")
      + `\n      timing: ${s2.timing.slice(0, 6).map((t) => `${(t.at * 100).toFixed(0)}%+${(t.forShare * 100).toFixed(0)}%`).join(" ")}`
      + `${s2.timing.length > 6 ? " …" : ""}`
      + `\n      e.g. ${s2.example.slice(0, 90)}`);
  }
  return L.join("\n");
}
