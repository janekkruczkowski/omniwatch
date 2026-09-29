// The template library — measure a format once, keep it, make many films in it.
//
// clone-film.mjs measures a watched film from scratch on every run: geometry from pixels,
// word times from the soundtrack, categories from a capture. That is the wrong shape for how
// a format is actually used. Nobody clones a new film every time they post — they work out a
// format once and then make many films in it. Measuring the same film on every run pays
// repeatedly for an answer already on disk, and it has a second cost, seen directly in this
// session: the style recipe is partly AUTHORED by a model, so two measurements of the SAME
// film at the SAME frame produced different typography — banner face `grotesque-black` /
// `maxLines: 2` / `tracking: 0.01` on one run, `condensed-black` / `maxLines: 3` /
// `tracking: 0` on the next — while the one value that is actually MEASURED from pixels, the
// letter size (0.033637152777777776), was identical to the last digit both times. That drift
// is not a bug to stamp out — a model looking twice at a frame is allowed to phrase what it
// sees two ways, the same as a person would — but it is exactly why the answer should be
// decided ONCE, by a run that can afford to look carefully, and then kept, rather than asked
// again on every render.
//
// ── the structure/content boundary, and the rule used to draw it ──────────────────────────
//
// Everything here turns on one question, asked field by field of a measured Blueprint: would
// the NEXT film made in this format keep this value, or replace it?
//
//   STRUCTURE — kept verbatim, becomes part of the template:
//     · every region: its rect, z, paint, grid, parent, at, label. A tier board's five rows
//       and their geometry are the format; the footballers sitting in them are not.
//     · the recipe. It is already content-free by construction — omniwatchRecipe.ts's own
//       header says it is "everything a dumb compositor needs in order to draw, and nothing
//       it has to guess", i.e. HOW things look, never WHAT they say — so it carries over
//       whole, unlike a blueprint's tracks, which mix the two.
//     · a `fixed` track's items, VALUES included. `varies: "fixed"` is the schema's own
//       word for "the same in every episode of this format" (omniwatchBlueprint.ts), so a
//       tier letter, a frame colour, a rule that never changes is structure down to its text.
//     · an `episode` track's TIMING and BEHAVIOUR policy: start, end, beat, rect, and the
//       cue/motion fields IR-CONTRACT-V2 §2-3 added — hold, waitsAt, landsAt, arrival,
//       departure. The reference's icon always waits beside the presenter and always lands
//       when the verdict is said, whichever footballer is being discussed; WHEN and HOW an
//       item behaves is a property of the format, not of the one episode it was measured on.
//
//   CONTENT — held out, becomes a slot the next episode has to fill:
//     · an `episode` track's item VALUES: the words of a caption, what an image depicts.
//       This is the one thing a different episode of the same format actually changes.
//
// The captured value is not thrown away — it is kept as `example`, the same word and the
// same idea omniwatchBlueprint.ts's own `FormatSlot.example` already uses for exactly this:
// "kept as guidance for whatever fills the slot next. Not content." Filling nothing in
// reproduces the measured episode; filling something new makes a different one. That is also
// what lets `saveTemplate` prove a template renders before it is written down — see below.
//
// `deriveFormat` in omniwatchBlueprint.ts already lifts a reusable shape out of a capture,
// and reusing it here would have avoided rebuilding region/track separation. It is not reused
// because it drops exactly the fields a template needs most: motion and cue policy never
// reach `FormatSlot`, and it carries no recipe at all — the two things a model gets wrong
// twice on the same frame, which is the entire reason this file exists. `deriveFormat` also
// serves a different job (an editable format sheet behind /api/omniwatch/formats) and is left
// untouched.
//
// ── licence ─────────────────────────────────────────────────────────────────────────────
// HypeKit / Hypit has a comparable idea under a modified Apache-2.0 licence that forbids
// this. No code and no schema were read from it for this file. The shape here follows from
// OUR contract (docs/IR-CONTRACT-V2.md) and this pipeline's own Blueprint/FormatRecipe types,
// with our own field names.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { OMNI_ROOT } from "@/lib/omniwatch";
import {
  validateBlueprint,
  defaultFill,
  BLUEPRINT_VERSION,
  type Blueprint,
  type BlueprintRegion,
  type BlueprintCanvas,
  type TrackKind,
  type FillSource,
  type TextStyle,
  type Rect,
  type Hold,
} from "@/lib/omniwatchBlueprint";
import type { FormatRecipe } from "@/lib/omniwatchRecipe";

export const TEMPLATE_VERSION = "omniwatch.template/1";
export const TEMPLATES_ROOT = path.join(OMNI_ROOT, "templates");

/** One item of a track that VARIES between episodes, content held out.
 *
 *  Everything except `value`/`example` is WHEN and HOW, not WHAT — see the header. Optional
 *  fields are left OUT rather than written `undefined`, the same discipline
 *  omniwatchBlueprint.ts enforces on the blueprint itself, so a stored template round-trips
 *  through JSON without inventing fields nobody set. */
export interface TemplateSlotItem {
  start: number;
  end: number;
  beat?: number;
  rect?: Rect;
  hold?: Hold;
  waitsAt?: string;
  landsAt?: number;
  arrival?: unknown;
  departure?: unknown;
  /** What this item said when the format was measured. Guidance for whatever fills the
   *  slot next — used as-is when no new content is supplied, never treated as authored
   *  when it is. Not content, in the same sense `FormatSlot.example` is not. */
  example: string;
}

export interface TemplateTrack {
  region: string;
  kind: TrackKind;
  varies: "fixed" | "episode";
  fill?: FillSource;
  style?: TextStyle;
  /** `varies: "fixed"` — every item's `example` IS what renders, always; filling a
   *  template never asks for these. `varies: "episode"` — `example` is a fallback only;
   *  new content, keyed by this track's slot id (`slotId`), replaces it. */
  items: TemplateSlotItem[];
}

/** Where this template's numbers came from, and when. A template that cannot say this is a
 *  guess wearing a measurement's clothes — the whole reason this field is required, not
 *  optional. `measured` is a copy of the notes the measuring run actually produced (the
 *  ones clone-film.mjs already prints under "gates" and in its verbose log), not a summary
 *  written after the fact. */
export interface TemplateProvenance {
  /** The film this was measured from — whatever `--source` was given: a cache id or a path. */
  source: string;
  /** ISO timestamp of the run that measured it. */
  measuredAt: string;
  /** Notes from that run: which gates passed, which fell back, what the recipe noticed.
   *  Kept verbatim so a reader can tell a measured number from a guessed one without
   *  opening the film again. */
  measured: string[];
}

export interface Template {
  version: typeof TEMPLATE_VERSION;
  name: string;
  canvas: BlueprintCanvas;
  regions: BlueprintRegion[];
  /** Content-free by construction — see the header. Null only when the measuring run had
   *  no recipe at all (no vision pass reached), which the compositor already treats as
   *  "use the built-in default". */
  recipe: FormatRecipe | null;
  tracks: TemplateTrack[];
  provenance: TemplateProvenance;
}

/** A track's address for content purposes — the same convention `FormatSlot.id` already
 *  uses in omniwatchBlueprint.ts, so a reader who knows one library recognises the other. */
export function slotId(region: string, kind: TrackKind): string {
  return `${region}:${kind}`;
}

/** Lift a template out of one measured blueprint + its recipe. Pure: no film is touched,
 *  nothing is validated here (that happens once, at save time — see `saveTemplate`). */
export function deriveTemplate(
  name: string,
  bp: Blueprint,
  recipe: FormatRecipe | null,
  provenance: TemplateProvenance,
): Template {
  return {
    version: TEMPLATE_VERSION,
    name,
    canvas: { ...bp.canvas },
    regions: bp.regions.map((r) => ({ ...r, rect: [...r.rect] as Rect })),
    recipe: recipe ? { ...recipe } : null,
    tracks: bp.tracks.map((t) => ({
      region: t.region,
      kind: t.kind,
      varies: t.varies,
      ...(t.fill ? { fill: t.fill } : {}),
      ...(t.style ? { style: t.style } : {}),
      items: t.items.map((it) => {
        const slot: TemplateSlotItem = { start: it.start, end: it.end, example: it.value };
        if (it.beat !== undefined) slot.beat = it.beat;
        if (it.rect) slot.rect = it.rect;
        if (it.hold) slot.hold = it.hold;
        if (it.waitsAt) slot.waitsAt = it.waitsAt;
        if (it.landsAt !== undefined) slot.landsAt = it.landsAt;
        if (it.arrival !== undefined) slot.arrival = it.arrival;
        if (it.departure !== undefined) slot.departure = it.departure;
        return slot;
      }),
    })),
    provenance,
  };
}

/** New words/pictures for an episode's tracks, keyed by `slotId`. One entry per captured
 *  item, in the same order — a template does not yet stretch to a different beat count than
 *  it was measured with (see the error `hydrateTemplate` gives when the counts disagree);
 *  that is a real limit, not an oversight, and is future work rather than a silent guess. */
export type TemplateContent = Record<string, string[]>;

export type HydrateResult =
  | { ok: true; blueprint: Blueprint; notes: string[] }
  | { ok: false; error: string };

/** A template plus new content, turned back into a real, checked Blueprint.
 *
 *  No film is opened and no model is asked anything — every number here already lives in
 *  the template. Called with no `content` at all, this reproduces the measured episode
 *  (every slot keeps its `example`), which is what makes it useful as the save-time check:
 *  a template that cannot hydrate itself cannot possibly hydrate someone else's words. */
export function hydrateTemplate(t: Template, content: TemplateContent = {}): HydrateResult {
  const tracks: Record<string, unknown>[] = [];
  for (const tt of t.tracks) {
    const id = slotId(tt.region, tt.kind);
    const supplied = tt.varies === "episode" ? content[id] : undefined;
    if (supplied && supplied.length !== tt.items.length) {
      return {
        ok: false,
        error: `content for "${id}" has ${supplied.length} value(s) — this template was measured with ${tt.items.length}`,
      };
    }
    const items = tt.items.map((it, i) => {
      const value = supplied ? supplied[i] : it.example;
      const item: Record<string, unknown> = { start: it.start, end: it.end, value };
      if (it.beat !== undefined) item.beat = it.beat;
      if (it.rect) item.rect = it.rect;
      if (it.hold) item.hold = it.hold;
      if (it.waitsAt) item.waitsAt = it.waitsAt;
      if (it.landsAt !== undefined) item.landsAt = it.landsAt;
      if (it.arrival !== undefined) item.arrival = it.arrival;
      if (it.departure !== undefined) item.departure = it.departure;
      return item;
    });
    const track: Record<string, unknown> = { region: tt.region, kind: tt.kind, varies: tt.varies, items };
    if (tt.fill) track.fill = tt.fill;
    if (tt.style) track.style = tt.style;
    tracks.push(track);
  }
  const raw = { version: BLUEPRINT_VERSION, canvas: { ...t.canvas }, regions: t.regions, tracks };
  // preserveGeometry: a template's regions were already measured off a film once; the
  // TierList9x16 rescue template exists for a guess with nothing better, which this is not.
  const checked = validateBlueprint(raw, { preserveGeometry: true });
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, blueprint: checked.blueprint, notes: checked.notes };
}

// ── the seam for a later feature ───────────────────────────────────────────────────────
//
// Not built here — the user wants the option, LATER, to refine a saved template by talking
// to a model ("make the banner two lines", "move the caption up"). It is out of scope for
// this pass. What is in scope is making sure it drops in without plumbing:
//
//   const t = await loadTemplate(id);
//   const refined = await refineTemplate(t, "move the caption up");   // <- would go here
//   const hydrated = hydrateTemplate(refined, content);
//
// One function, Template in and Template out, sitting between `loadTemplate` and
// `hydrateTemplate`. Neither of those needs to know it ran. It is not implemented, and
// nothing below depends on it existing.
export type RefineTemplate = (t: Template, instruction: string) => Promise<Template>;

// ── the library on disk ────────────────────────────────────────────────────────────────
// One validated JSON document per template, human-readable, under the OmniWatch root beside
// the video cache and the format library. Same pattern as omniwatchFormats.ts, on purpose —
// this project already has one library that works this way, and a second one that looks
// different for no reason is a second thing to learn.

const safeId = (id: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);

/** A name a human chose, reduced to something safe to be a filename. A short hash keeps two
 *  templates with the same obvious name ("tier-list") apart without making the id unreadable. */
export function templateId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `${slug || "template"}-${createHash("sha1").update(name).digest("hex").slice(0, 6)}`;
}

/** Refuses rather than writes when the template cannot hydrate itself — see `hydrateTemplate`
 *  above. A template that only fails at render time has already cost a whole run to find
 *  that out; refusing here costs nothing, because hydrating is pure JS, no film, no model. */
export async function saveTemplate(t: Template): Promise<{ ok: true; id: string; path: string } | { ok: false; error: string }> {
  const proof = hydrateTemplate(t);
  if (!proof.ok) return { ok: false, error: `template would not produce a valid blueprint: ${proof.error}` };
  await mkdir(TEMPLATES_ROOT, { recursive: true });
  const id = templateId(t.name);
  const file = path.join(TEMPLATES_ROOT, `${id}.json`);
  await writeFile(file, JSON.stringify(t, null, 2));
  return { ok: true, id, path: file };
}

export async function loadTemplate(id: string): Promise<Template | null> {
  if (!safeId(id)) return null;
  try {
    const t = JSON.parse(await readFile(path.join(TEMPLATES_ROOT, `${id}.json`), "utf8")) as Template;
    return t?.version === TEMPLATE_VERSION ? t : null;
  } catch {
    return null;
  }
}

export interface TemplateListing {
  id: string;
  name: string;
  source: string;
  measuredAt: string;
  regions: number;
  episodeSlots: number;
}

export async function listTemplates(): Promise<TemplateListing[]> {
  let names: string[];
  try {
    names = await readdir(TEMPLATES_ROOT);
  } catch {
    return [];
  }
  const out: TemplateListing[] = [];
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const t = await loadTemplate(f.slice(0, -5));
    if (!t) continue;
    out.push({
      id: f.slice(0, -5),
      name: t.name,
      source: t.provenance.source,
      measuredAt: t.provenance.measuredAt,
      regions: t.regions.length,
      episodeSlots: t.tracks.filter((tr) => tr.varies === "episode").length,
    });
  }
  return out.sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
}

/** Accepts either the exact id (`ranking-4f21a0`) or the plain name a human typed
 *  (`ranking`), because a CLI flag is easier to use when it does not require the hash. */
export async function findTemplate(idOrName: string): Promise<Template | null> {
  const byId = await loadTemplate(idOrName);
  if (byId) return byId;
  const byDerivedId = await loadTemplate(templateId(idOrName));
  if (byDerivedId) return byDerivedId;
  for (const entry of await listTemplates()) {
    if (entry.name === idOrName) return loadTemplate(entry.id);
  }
  return null;
}

/** The same document, for a person to read — never parsed back, so it is free to be loose
 *  where the JSON has to be strict. Answers "what is this and where did it come from"
 *  without opening the film, which is the whole point of keeping provenance at all. */
export function describeTemplate(t: Template): string {
  const fixed = t.tracks.filter((tr) => tr.varies === "fixed");
  const episode = t.tracks.filter((tr) => tr.varies === "episode");
  const L: string[] = [
    t.name,
    `${t.canvas.width}x${t.canvas.height} at ${t.canvas.fps}fps, ${t.canvas.seconds}s · ${t.regions.length} region(s) · `
      + `${fixed.length} fixed track(s), ${episode.length} episode slot(s)`,
    `from ${t.provenance.source} · measured ${t.provenance.measuredAt}`,
  ];
  if (t.provenance.measured.length) {
    L.push("", "measured:");
    for (const n of t.provenance.measured.slice(0, 8)) L.push(`  · ${n}`);
  }
  if (episode.length) {
    L.push("", "slots — need content to render a new episode:");
    for (const tr of episode) {
      L.push(`  ${slotId(tr.region, tr.kind)} (${tr.fill ?? defaultFill(tr.kind)}) — ${tr.items.length} item(s)`
        + `\n      e.g. ${tr.items[0]?.example.slice(0, 90) ?? ""}`);
    }
  }
  return L.join("\n");
}
