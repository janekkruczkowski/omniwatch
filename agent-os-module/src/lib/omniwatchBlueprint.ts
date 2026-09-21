// The blueprint: what a watched video is made of, as data rather than prose.
//
// The teardown answers "how was this made" for a person to read. Nothing can be rebuilt
// from it: every beat comes back as one flat scene with a sentence attached, so a title
// bar, a presenter, a caption and a tier list all arrive as the same thing — "b-roll" —
// and the renderer has one layout to put them in. Measured: a reference in 720x1280 with
// four things on screen at once came out as a 1920x1080 film with one clip and a caption.
//
// So this is the other output, and its shape follows from that failure rather than from
// anyone else's schema. Three decisions, each with a reason:
//
//   REGIONS, because the missing information is WHERE. A tier list at the bottom and a
//   presenter above it are not two scenes, they are two places on one screen at once.
//
//   TRACKS HELD APART FROM BEATS, because the missing information is WHEN, at a finer
//   grain than a cut. A caption landing word by word over a frame that never changes is
//   the reference's whole rhythm, and a scene list cannot say it.
//
//   FRACTIONAL GEOMETRY, because a clone is rendered at whatever size the copy needs, and
//   a rect in pixels quietly means a different place on a different canvas.
//
// Layers, rectangles, paint order and time ranges are the ordinary vocabulary of putting
// pictures on a screen; the arrangement here is ours, written against this pipeline\'s own
// renderer. Prior art was read for what problems exist, never for code or schema — see the
// comparison note in the repo, and its licence findings.
//
// Two layers are meant here, and only the first is written down by the model. The CAPTURE
// is this: where things are and when, measured. The FORMAT — the same regions with the
// content taken out, plus named slots for what changes — is DERIVED from a capture, and
// that derivation is what makes a watched video reusable instead of merely copyable. Social
// formats repeat: a tier list is the layout plus "one subject per beat", and a second video
// in the same format differs only in the subjects.
//
// Three fields exist solely so that derivation never needs a second pass over the video:
// `parent` (a slot belongs to a board, so it has a place in a grid), `beat` (which
// repetition an item belongs to, so the repeating unit is visible), and `varies` (whether a
// track carries the format or the episode). Without them a format could only be recovered
// by analysing the same file again.
//
// One discipline is enforced rather than suggested: every field is required, values come
// from fixed lists, and something absent is left out rather than written as an empty
// string. A schema that is only sometimes filled in cannot be validated, and a blueprint
// that validates is the entire reason this exists.

export const BLUEPRINT_VERSION = "omniwatch.blueprint/1";

/** What a region DOES in the layout.
 *
 *  The first version of this list was written from one video and read like its table of
 *  contents: title_bar, presenter, board, sticker. That is a genre, not a vocabulary — a
 *  screen recording with a webcam bubble, a text-message story, an overhead recipe and a
 *  split-screen debate have none of those parts, and every new format would have needed a
 *  new word.
 *
 *  These six are layout functions instead, and they compose. A title strip and a word-timed
 *  caption are both `text`, told apart by where they sit and whether they change per beat —
 *  which is measured here anyway, and is more honest than a name. What a region is FOR in
 *  human terms goes in `label`, where it can be anything without the schema growing. */
export const REGION_ROLES = [
  "backdrop",  // fills the frame behind everything: colour, footage, a set
  "figure",    // a subject in shot: presenter, avatar, interviewee, hands
  "overlay",   // layered over another region: inset, bubble, logo, reaction, sticker
  "text",      // an area whose content is words: title, caption, label, ticker
  "panel",     // a bounded area holding structured content, often subdivided
  "cell",      // one subdivision of a panel, addressed by grid position
] as const;
export type RegionRole = (typeof REGION_ROLES)[number];

/** What kind of content a track puts into its region. */
export const TRACK_KINDS = ["text", "image", "video", "color"] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

/** Fractions of the canvas: [x, y, w, h], origin top-left. */
export type Rect = [number, number, number, number];

export interface BlueprintRegion {
  id: string;
  role: RegionRole;
  rect: Rect;
  /** Higher paints later. Explicit so two regions that overlap have a defined order. */
  z: number;
  /** The region this one sits inside, when that is the real relationship: a cell belongs to
   *  its panel, an overlay sits over a figure. Absent for a top-level region. `rect` stays a
   *  fraction of the CANVAS either way — nesting records structure, not a coordinate
   *  system, because a panel that moves should not silently move its cells. */
  parent?: string;
  /** What this area is called in the language of the format — "tier row S", "webcam
   *  bubble", "ingredient list", "reply from mum". Free text on purpose: the roles above
   *  have to stay closed to be laid out, and the endlessly varying part is a name. */
  label?: string;
  /** For a `panel` that is divided into a regular grid, how many rows and columns it has.
   *  Tier rows, a 2-up comparison, a 3x3 bingo card, a leaderboard are all this. */
  grid?: { rows: number; cols: number };
  /** For a `cell`, where it sits in its parent's grid, counting from 1. This is what makes
   *  a structure addressable: without it a tier list is a picture of a tier list, and a
   *  clone cannot know which row an item lands in. */
  at?: { row: number; col: number };
}

export interface BlueprintItem {
  start: number;
  end: number;
  /** Which repetition of the format's unit this belongs to, counting from 1 — the third
   *  ranked subject, the second tip. Absent for anything that is not part of the repeating
   *  structure, such as a title that holds for the whole video. This is the field that lets
   *  a format be lifted out later: the unit is whatever carries a beat. */
  beat?: number;
  /** For kind "text": the exact words on screen. For image/video: what is depicted, as an
   *  instruction a generator can act on. For "color": a hex value. Never empty — an empty
   *  item is a gap, and a gap is expressed by not having an item. */
  value: string;
}

export interface BlueprintTrack {
  region: string;
  kind: TrackKind;
  /** Does this track carry the FORMAT or the EPISODE?
   *  "fixed"   — the same in every video of this format (the tier rows, the frame colour).
   *  "episode" — changes with the subject (the title, the narration, each subject's image).
   *  Marked at capture because the model can see which is which and a later pass cannot. */
  varies: "fixed" | "episode";
  items: BlueprintItem[];
}

export interface BlueprintCanvas {
  width: number;
  height: number;
  fps: number;
  seconds: number;
}

export interface Blueprint {
  version: typeof BLUEPRINT_VERSION;
  canvas: BlueprintCanvas;
  regions: BlueprintRegion[];
  tracks: BlueprintTrack[];
}

const MAX_REGIONS = 24;
const MAX_TRACKS = 32;
const MAX_ITEMS = 400;
const MAX_VALUE = 600;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function badRect(r: unknown): string | null {
  if (!Array.isArray(r) || r.length !== 4) return "must be [x, y, w, h]";
  for (const n of r) if (num(n) === null) return "must be four numbers";
  const [x, y, w, h] = r as number[];
  if (w <= 0 || h <= 0) return "width and height must be above zero";
  // Slightly outside is allowed: things legitimately bleed off the canvas edge.
  if (x < -1 || y < -1 || x > 2 || y > 2 || w > 3 || h > 3) return "fractions must be near 0..1 of the canvas";
  return null;
}

export type BlueprintCheck = { ok: true; blueprint: Blueprint } | { ok: false; error: string };

/** Never throws: a blueprint that came back malformed is a reason to say what is wrong,
 *  not a 500 from halfway through a render. */
export function validateBlueprint(raw: unknown): BlueprintCheck {
  if (!isObj(raw)) return { ok: false, error: "the blueprint must be a JSON object" };
  if (raw.version !== BLUEPRINT_VERSION) return { ok: false, error: `version must be "${BLUEPRINT_VERSION}"` };

  if (!isObj(raw.canvas)) return { ok: false, error: "canvas is required" };
  const c = raw.canvas;
  const width = num(c.width), height = num(c.height), fps = num(c.fps), seconds = num(c.seconds);
  if (width === null || width < 16 || width > 8192) return { ok: false, error: "canvas.width is out of range" };
  if (height === null || height < 16 || height > 8192) return { ok: false, error: "canvas.height is out of range" };
  if (fps === null || fps <= 0 || fps > 240) return { ok: false, error: "canvas.fps is out of range" };
  if (seconds === null || seconds <= 0 || seconds > 7200) return { ok: false, error: "canvas.seconds is out of range" };

  if (!Array.isArray(raw.regions) || raw.regions.length === 0) return { ok: false, error: "at least one region is required" };
  if (raw.regions.length > MAX_REGIONS) return { ok: false, error: `too many regions (max ${MAX_REGIONS})` };
  const regions: BlueprintRegion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.regions.length; i++) {
    const r = raw.regions[i];
    const at = `regions[${i}]`;
    if (!isObj(r)) return { ok: false, error: `${at} must be an object` };
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!/^[a-z0-9_-]{1,40}$/.test(id)) return { ok: false, error: `${at}.id must be lowercase letters, digits, _ or -` };
    if (seen.has(id)) return { ok: false, error: `${at}.id "${id}" is used twice` };
    seen.add(id);
    if (!(REGION_ROLES as readonly string[]).includes(String(r.role))) {
      return { ok: false, error: `${at}.role must be one of ${REGION_ROLES.join(", ")}` };
    }
    const rectErr = badRect(r.rect);
    if (rectErr) return { ok: false, error: `${at}.rect ${rectErr}` };
    const z = num(r.z);
    if (z === null) return { ok: false, error: `${at}.z is required — overlapping regions need a defined order` };
    let parent: string | undefined;
    if (r.parent !== undefined && r.parent !== null && r.parent !== "") {
      if (typeof r.parent !== "string") return { ok: false, error: `${at}.parent must be a region id` };
      parent = r.parent.trim();
      if (parent === id) return { ok: false, error: `${at}.parent cannot be itself` };
    }
    let label: string | undefined;
    if (r.label !== undefined && r.label !== null && r.label !== "") {
      if (typeof r.label !== "string") return { ok: false, error: `${at}.label must be text` };
      label = r.label.trim().slice(0, 80) || undefined;
    }

    const role = r.role as RegionRole;
    let grid: { rows: number; cols: number } | undefined;
    if (r.grid !== undefined && r.grid !== null) {
      if (role !== "panel") return { ok: false, error: `${at}.grid belongs on a panel, not on a ${role}` };
      if (!isObj(r.grid)) return { ok: false, error: `${at}.grid must be { rows, cols }` };
      const rows = num(r.grid.rows), cols = num(r.grid.cols);
      if (rows === null || !Number.isInteger(rows) || rows < 1 || rows > 64) return { ok: false, error: `${at}.grid.rows is out of range` };
      if (cols === null || !Number.isInteger(cols) || cols < 1 || cols > 64) return { ok: false, error: `${at}.grid.cols is out of range` };
      grid = { rows, cols };
    }

    let cellAt: { row: number; col: number } | undefined;
    if (r.at !== undefined && r.at !== null) {
      if (role !== "cell") return { ok: false, error: `${at}.at belongs on a cell, not on a ${role}` };
      if (!isObj(r.at)) return { ok: false, error: `${at}.at must be { row, col }` };
      const row = num(r.at.row), col = num(r.at.col);
      if (row === null || !Number.isInteger(row) || row < 1) return { ok: false, error: `${at}.at.row must be a whole number from 1 up` };
      if (col === null || !Number.isInteger(col) || col < 1) return { ok: false, error: `${at}.at.col must be a whole number from 1 up` };
      cellAt = { row, col };
    }

    regions.push({
      id, role, rect: (r.rect as number[]).slice(0, 4) as Rect, z,
      ...(parent ? { parent } : {}), ...(label ? { label } : {}),
      ...(grid ? { grid } : {}), ...(cellAt ? { at: cellAt } : {}),
    });
  }

  // Parents are checked after the whole list, because a board may legitimately be declared
  // after the slot that names it.
  const byId = new Map(regions.map((r) => [r.id, r]));
  for (const r of regions) {
    if (!r.parent) continue;
    if (!byId.has(r.parent)) return { ok: false, error: `region "${r.id}".parent "${r.parent}" is not a declared region` };
    // A cycle would hang anything that walks the tree to lay a region out.
    const path = new Set([r.id]);
    let cur = byId.get(r.parent);
    while (cur) {
      if (path.has(cur.id)) return { ok: false, error: `regions form a parent loop at "${cur.id}"` };
      path.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }

  // A cell that names a place outside its panel's grid is a measurement that cannot be
  // rendered — row 9 of five tier rows puts the item nowhere.
  for (const r of regions) {
    if (!r.at) continue;
    const host = r.parent ? byId.get(r.parent) : undefined;
    if (!host) return { ok: false, error: `region "${r.id}" has a grid position but no parent panel` };
    if (!host.grid) return { ok: false, error: `region "${r.id}" sits at a grid position but "${host.id}" declares no grid` };
    if (r.at.row > host.grid.rows || r.at.col > host.grid.cols) {
      return { ok: false, error: `region "${r.id}" is at ${r.at.row},${r.at.col} but "${host.id}" is only ${host.grid.rows}x${host.grid.cols}` };
    }
  }

  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) return { ok: false, error: "at least one track is required" };
  if (raw.tracks.length > MAX_TRACKS) return { ok: false, error: `too many tracks (max ${MAX_TRACKS})` };
  const tracks: BlueprintTrack[] = [];
  for (let i = 0; i < raw.tracks.length; i++) {
    const t = raw.tracks[i];
    const at = `tracks[${i}]`;
    if (!isObj(t)) return { ok: false, error: `${at} must be an object` };
    const region = typeof t.region === "string" ? t.region.trim() : "";
    if (!seen.has(region)) return { ok: false, error: `${at}.region "${region}" is not a declared region` };
    if (!(TRACK_KINDS as readonly string[]).includes(String(t.kind))) {
      return { ok: false, error: `${at}.kind must be one of ${TRACK_KINDS.join(", ")}` };
    }
    if (t.varies !== "fixed" && t.varies !== "episode") {
      return { ok: false, error: `${at}.varies must be "fixed" or "episode" — a track that does not say which cannot become a format` };
    }
    if (!Array.isArray(t.items) || t.items.length === 0) return { ok: false, error: `${at}.items must not be empty` };
    if (t.items.length > MAX_ITEMS) return { ok: false, error: `${at}.items has too many entries (max ${MAX_ITEMS})` };
    const items: BlueprintItem[] = [];
    for (let k = 0; k < t.items.length; k++) {
      const it = t.items[k];
      const atk = `${at}.items[${k}]`;
      if (!isObj(it)) return { ok: false, error: `${atk} must be an object` };
      const start = num(it.start), end = num(it.end);
      if (start === null || start < 0) return { ok: false, error: `${atk}.start must be a second at or after zero` };
      if (end === null || end <= start) return { ok: false, error: `${atk}.end must come after start` };
      if (end > seconds + 1) return { ok: false, error: `${atk}.end is past the end of the video` };
      const value = typeof it.value === "string" ? it.value.trim() : "";
      if (!value) return { ok: false, error: `${atk}.value must say what is on screen` };
      let beat: number | undefined;
      if (it.beat !== undefined && it.beat !== null) {
        const b = num(it.beat);
        if (b === null || b < 1 || !Number.isInteger(b)) return { ok: false, error: `${atk}.beat must be a whole number from 1 up` };
        beat = b;
      }
      items.push({ start, end, value: value.slice(0, MAX_VALUE), ...(beat ? { beat } : {}) });
    }
    items.sort((a, b) => a.start - b.start);
    tracks.push({ region, kind: t.kind as TrackKind, varies: t.varies, items });
  }

  // A region nothing ever puts content into is a region that was imagined, not observed —
  // unless it is a container, because a board whose slots hold the content is real and has
  // nothing of its own to paint.
  const used = new Set(tracks.map((t) => t.region));
  const hasChild = new Set(regions.map((r) => r.parent).filter(Boolean) as string[]);
  const idle = regions.find((r) => !used.has(r.id) && !hasChild.has(r.id));
  if (idle) {
    return { ok: false, error: `region "${idle.id}" has no track and nothing inside it — every region must carry something` };
  }

  return { ok: true, blueprint: { version: BLUEPRINT_VERSION, canvas: { width, height, fps, seconds }, regions, tracks } };
}

/** The schema as the model is told it, kept beside the validator so the two cannot drift:
 *  whatever is described here is what validateBlueprint accepts. */
export const BLUEPRINT_SCHEMA_PROMPT = `Return ONE JSON object and nothing else — no prose, no markdown fence.

{
  "version": "${BLUEPRINT_VERSION}",
  "canvas": { "width": <px>, "height": <px>, "fps": <number>, "seconds": <number> },
  "regions": [ { "id": "<lowercase-id>", "role": <role>, "rect": [x, y, w, h], "z": <number>,
                 "label": "<what this area is, in plain words>",
                 "parent": "<region id, only if it sits inside one>",
                 "grid": { "rows": <n>, "cols": <n> },   // only on a panel that is divided
                 "at":   { "row": <n>, "col": <n> } } ], // only on a cell, counting from 1
  "tracks":  [ { "region": "<region id>", "kind": <kind>, "varies": "fixed" | "episode",
                 "items": [ { "start": <s>, "end": <s>, "value": "<what>", "beat": <n, only if part of the repeating unit> } ] } ]
}

role is exactly one of: ${REGION_ROLES.join(" | ")}
kind is exactly one of: ${TRACK_KINDS.join(" | ")}

RULES
- rect is FRACTIONS of the canvas, origin top-left: [0, 0, 1, 0.1] is a strip across the top.
  Never pixels. Measure where the thing actually sits, do not guess a tidy number.
- The six roles are LAYOUT FUNCTIONS, not genres, and they cover any composed video:
  backdrop is what is behind everything; figure is a subject in shot, whether a presenter,
  an avatar, an interviewee or a pair of hands; overlay is anything layered over another
  region; text is an area whose content is words, whether a fixed title or a caption that
  changes word by word; panel is a bounded area holding structured content; cell is one
  subdivision of a panel. Say what the area really is in "label" — "tier row S", "webcam
  bubble", "step 2 of the recipe", "reply from mum" — and keep "role" to the six.
- If a panel is divided into a regular structure, give it "grid" and give each part its own
  cell region with "at". A tier list, a 2-up comparison, a leaderboard, a bingo card and a
  side-by-side before/after are all this. Without it the structure is only a picture of
  itself and nothing can be placed into it.
- Every region must have at least one track, and every track at least one item.
- z decides what is painted over what. Give overlapping regions different z.
- A caption that changes word by word is many items on ONE caption track, each with its own
  start and end — not one item for the whole video.
- For kind "text", value is the exact words on screen, verbatim, including emoji.
- For kind "image" or "video", value describes what is depicted, concretely enough that
  someone could recreate it without seeing the original.
- Describe only what is visibly there. Do not name a camera, a lens, or a brand you cannot
  read on screen. Do not describe mood, quality, or intent.
- If the video has no region of some kind, leave it out. Never invent one to look complete.

THE REPEATING UNIT — this is what makes the video a FORMAT rather than one video
- Most short-form videos run a small structure several times: one ranked subject, one tip,
  one myth. Find that unit and number it. Every item belonging to the third repetition gets
  "beat": 3, whatever region it is in — the subject's image, its caption, its slot on the
  board. Items that are not part of it, such as a title held for the whole video, get no
  "beat" at all.
- "varies" says whether a track would be the same in the NEXT video made this way.
  "fixed"   — the scaffolding: the tier rows and their letters, a background, a frame.
  "episode" — anything that changes with the subject: the title, the narration, each
              image that is about this topic.
  Decide per track, by asking what a different episode of this same format would keep.`;

// ── the format layer ───────────────────────────────────────────────────────────
//
// A capture describes one episode. A format is the same layout with the episode taken out:
// the scaffolding kept verbatim, everything that changes reduced to a named slot, and time
// expressed as a SHARE rather than a second.
//
// That last part is what makes it reusable. The captured tier list ran 20 seconds over two
// subjects; the next one may rank five and run a minute. Absolute seconds would either
// truncate it or leave it hanging, so a per-beat item records where it sits inside its own
// beat (0..1) and how much of that beat it takes. Render-time multiplies those by whatever
// the new episode's beats turn out to be.
//
// Derived, never asked: the model already said which tracks vary and which beat each item
// belongs to, so this is arithmetic. Asking a second time would invite a second opinion.

export interface FormatSlot {
  /** Stable id: the region it fills plus its kind, which is unique per track. */
  id: string;
  region: string;
  kind: TrackKind;
  /** True when this slot is filled once per beat, false when it is filled once per episode
   *  (a title, a hook line). The difference decides how many values an episode must supply. */
  perBeat: boolean;
  /** How many values one beat TYPICALLY needs — the median across beats, not the maximum.
   *  One talkative subject should not set the bill for every other. */
  perUnit: number;
  /** What the busiest beat asked for. Kept so a filler can see the spread rather than
   *  discovering it when a beat runs out of room. */
  perUnitMax: number;
  /** Where each value sits, as shares of its beat (or of the whole video when not perBeat).
   *  Same length as perUnit. */
  timing: { at: number; forShare: number }[];
  /** One captured value, kept as guidance for whatever fills the slot next. Not content. */
  example: string;
}

export interface VideoFormat {
  version: typeof BLUEPRINT_VERSION;
  /** No seconds: a format has no duration until an episode gives it one. */
  canvas: { width: number; height: number; fps: number };
  regions: BlueprintRegion[];
  /** Scaffolding, kept as captured — tier rows, a backdrop, a frame. */
  fixed: BlueprintTrack[];
  slots: FormatSlot[];
  /** How many repetitions the captured episode ran. A different episode may run a different
   *  number; this is what it looked like, not a rule. */
  beats: number;
}

const share = (v: number) => Math.round(v * 10000) / 10000;

/** The window each beat occupied, taken across every track that mentioned it. */
export function beatWindows(bp: Blueprint): Map<number, { start: number; end: number }> {
  const w = new Map<number, { start: number; end: number }>();
  for (const t of bp.tracks) {
    for (const i of t.items) {
      if (!i.beat) continue;
      const cur = w.get(i.beat);
      if (!cur) w.set(i.beat, { start: i.start, end: i.end });
      else { cur.start = Math.min(cur.start, i.start); cur.end = Math.max(cur.end, i.end); }
    }
  }
  return w;
}

/** Lift the reusable shape out of one capture. */
export function deriveFormat(bp: Blueprint): VideoFormat {
  const windows = beatWindows(bp);
  const beats = windows.size;
  const whole = { start: 0, end: bp.canvas.seconds };

  const slots: FormatSlot[] = [];
  for (const t of bp.tracks) {
    if (t.varies === "fixed") continue;

    // An episode track either repeats per beat or is supplied once. Judged by its items,
    // not by a flag: a track whose items all carry a beat is per-beat, and one whose items
    // carry none is a per-episode field.
    //
    // Tagging is not always even, though. On a real capture the model numbered the caption
    // items and left the graphic that changes alongside them untagged, which classified an
    // obviously per-beat track as "supplied once". So when a track carries no beats at all
    // and the video has beat windows, each item is placed by WHERE IT FALLS: an item that
    // sits inside a beat's window belongs to that beat. Arithmetic, not a second opinion.
    const tagged = t.items.filter((i) => i.beat);
    let items = t.items;
    if (tagged.length === 0 && beats > 0) {
      // Containment, not midpoint. A headline that runs the whole video has its midpoint
      // inside whichever beat happens to sit in the middle, and would be mistaken for a
      // per-beat field; an item belongs to a beat only when that beat holds most of it.
      const placed = t.items.map((i) => {
        const span = Math.max(i.end - i.start, 0.001);
        for (const [n, w] of windows) {
          const inside = Math.min(i.end, w.end) - Math.max(i.start, w.start);
          if (inside / span >= 0.6) return { ...i, beat: n };
        }
        return i;
      });
      // Only adopt the inference when it actually explains the track.
      if (placed.filter((i) => i.beat).length >= Math.ceil(t.items.length * 0.8)) items = placed;
    }
    const beated = items.filter((i) => i.beat);
    const perBeat = beated.length > 0 && beated.length === items.length;

    // Per beat, the count is what ONE beat needs — the most any single beat asked for, so a
    // subject that got two captions is not quietly cut to the one another got.
    let perUnit: number, perUnitMax: number;
    let sample: BlueprintItem[];
    if (perBeat) {
      const byBeat = new Map<number, BlueprintItem[]>();
      for (const i of items) {
        const k = i.beat as number;
        byBeat.set(k, [...(byBeat.get(k) ?? []), i]);
      }
      const groups = [...byBeat.values()].sort((a, b) => a.length - b.length);
      const median = groups[Math.floor((groups.length - 1) / 2)];
      perUnit = median.length;
      perUnitMax = groups[groups.length - 1].length;
      // Timing comes off a beat of typical size, so the shares describe the usual shape.
      sample = median;
    } else {
      perUnit = items.length;
      perUnitMax = items.length;
      sample = items;
    }

    const timing = sample.map((i) => {
      const w = perBeat && i.beat ? windows.get(i.beat) ?? whole : whole;
      const span = Math.max(w.end - w.start, 0.001);
      return { at: share((i.start - w.start) / span), forShare: share((i.end - i.start) / span) };
    });

    slots.push({
      id: `${t.region}:${t.kind}`,
      region: t.region, kind: t.kind, perBeat, perUnit, perUnitMax, timing,
      example: sample[0]?.value ?? "",
    });
  }

  return {
    version: BLUEPRINT_VERSION,
    canvas: { width: bp.canvas.width, height: bp.canvas.height, fps: bp.canvas.fps },
    regions: bp.regions,
    fixed: bp.tracks.filter((t) => t.varies === "fixed"),
    slots,
    beats,
  };
}
