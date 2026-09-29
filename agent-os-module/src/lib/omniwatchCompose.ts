// A blueprint, drawn.
//
// The existing assembler has exactly one layout — a full-bleed clip with a caption under it
// — which is why a 720x1280 reference with four things on screen at once came back as a
// 1920x1080 film with one clip and a lower third. This draws what the blueprint actually
// says: every region a box at its own fraction of the canvas, in its own paint order, with
// its items appearing and leaving on their own clocks.
//
// The output is the same composition shape the assembler already emits, so the existing
// HyperFrames renderer takes it unchanged: a #stage carrying the canvas, and children
// carrying data-start / data-duration.
//
// What fills an image or video item is NOT decided here. `assetFor` is a seam: point it at
// crops of the watched file and the result is a trace of the original, which is how the
// geometry gets checked; point it at generated assets and the same layout carries a
// different subject. One renderer, both jobs.
import { splitEmphasis, type Blueprint, type BlueprintItem, type BlueprintTrack,
  type BlueprintRegion, type TextStyle } from "@/lib/omniwatchBlueprint";
import { FACE_STACKS, FACE_WIDTHS, type FormatRecipe, type TypeSpec } from "@/lib/omniwatchRecipe";
import { elementTweens, normalizeMove, GSAP_EASE } from "@/lib/omniwatchMotion";
import { needsStaging, stageItem } from "@/lib/omniwatchStage";

export interface ComposeSources {
  /** The URL to draw for one image/video item, or null to leave the slot empty. */
  assetFor(track: BlueprintTrack, item: BlueprintItem, index: number): string | null;
  /** Narration for the whole piece, if there is any. */
  audioUrl?: string | null;
  /** When set, only emit items active at this time (proof snapshots — no stacked captions). */
  activeAt?: number;
  /** Drawn faintly over every region with its id — for checking geometry, never for output. */
  debugRegions?: boolean;
  /** One finished clip for a whole region, used instead of its items.
   *
   *  A trace cuts a region once, for the whole piece, and that clip already carries its own
   *  timing. Drawing it once per item replayed it from the start seven times over — which
   *  is what turned a caption band into two captions sliding through each other. */
  regionAsset?(regionId: string): string | null;
  /** How the format LOOKS, as data.
   *
   *  With one in hand this file stops deciding anything: a tier row is a plate of the fill
   *  the recipe names, carrying a letter at the size the recipe gives, followed by as many
   *  tiles as there are things to put in it, each one the size the recipe says. Without one
   *  the old path still runs, which is what keeps every other format working. */
  recipe?: FormatRecipe | null;
  /** Skip text and colour items.
   *
   *  A trace cuts its regions out of the watched file, and those pixels ALREADY carry the
   *  title, the tier letters and the caption. Drawing them again put "S S" down the board
   *  and stacked two captions on top of each other. When the picture is the original,
   *  the only honest thing to add is nothing. */
  tracedPixels?: boolean;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** A URL reaches an attribute, so anything that could close it or start a script is refused
 *  rather than escaped — an asset that cannot be named safely is an asset we do not draw. */
const safeUrl = (u: string): string | null => {
  const t = u.trim();
  if (!t || /[\s"'<>\\]/.test(t)) return null;
  // The renderer resolves a src against the project directory on disk, so a project-root
  // relative path is the one that works — an absolute preview URL made it look for
  // <project>/api/video/preview/... and silently render a still frame instead.
  if (/^assets\/[A-Za-z0-9._-]+$/.test(t)) return t;
  if (/^(https?:)?\/\//i.test(t) || t.startsWith("/")) return t;
  return null;
};
const pct = (n: number) => `${Math.round(n * 1000000) / 10000}%`;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The composition's own id.
 *
 *  It is written twice — on the wrapper element and as the key the timeline is registered
 *  under — and the two MUST agree. A mismatch registers a timeline nobody reads, which from
 *  the outside is indistinguishable from having none at all: the render just quietly takes
 *  five times as long. One constant, so they cannot drift apart. */
const COMPOSITION_ID = "main";

/** One drawn element, remembered so the timeline can aim at it. */
interface Drawn {
  id: string;
  item: BlueprintItem;
  /** The element's own box in PIXELS — its rect when it has one, otherwise its region's.
   *  Motion needs pixels because a drift travels a fraction of the thing that is moving. */
  box: { width: number; height: number };
  region: string;
}

/** The statements that make a film move.
 *
 *  Two kinds, and they are not the same thing. An ARRIVAL or DEPARTURE is a manner — how a
 *  thing enters and leaves where it already belongs — and `omniwatchMotion` owns it end to
 *  end, including every number. A DROP is a journey: an icon that belongs in a row starts
 *  beside the presenter and travels there. Only the second needs to know two boxes, so only
 *  the second is written here.
 *
 *  A drop is a `set` followed by a `to`, never a bare `fromTo`. The runtime seeks a paused
 *  timeline to an arbitrary frame, and a tween that has not started yet leaves the element
 *  wherever the stylesheet put it — which, for a tile, is already in its row. The `set` at
 *  zero is what holds it at the waiting spot until its moment comes — and "its moment" is
 *  `outcome.stage.moves`, which is `item.landsAt` when the blueprint has one (IR-CONTRACT-V2
 *  §3: the second the verdict is said, not merely the second the icon appears) and
 *  `item.start` otherwise. Both are `omniwatchStage`'s call, not this file's; a held frame is
 *  still emitted as a real tween either way, never a static value, because the renderer's
 *  static-frame dedup only fires off real tweens.
 */
function tweenStatements(drawn: Drawn[], bp: Blueprint, W: number, H: number): string[] {
  const out: string[] = [];
  const px = (n: number) => Math.round(n * 100) / 100;

  for (const d of drawn) {
    const sel = JSON.stringify(`#${d.id}`);

    // ── the journey, when there is one ────────────────────────────────────────
    if (needsStaging(d.item)) {
      const track = bp.tracks.find((t) => t.region === d.region && t.items.includes(d.item));
      const outcome = track ? stageItem(bp, track, d.item) : null;
      if (outcome?.ok) {
        const { waiting, final, moves } = outcome.stage;
        // Centre to centre, in pixels, because the element is moved by transform rather than
        // by being re-laid-out: a tile that changes `left` would drag its neighbours with it.
        const dx = px(((waiting[0] + waiting[2] / 2) - (final[0] + final[2] / 2)) * W);
        const dy = px(((waiting[1] + waiting[3] / 2) - (final[1] + final[3] / 2)) * H);
        const scale = final[2] > 0 ? Math.round((waiting[2] / final[2]) * 1000) / 1000 : 1;
        const travel = normalizeMove(d.item.arrival, { shape: "drift", seconds: 0.35, ease: "soft-out", amount: 0 });
        const seconds = Math.min(Math.max(travel.seconds || 0.35, 0.08), Math.max((d.item.end - moves) / 2, 0.08));
        out.push(`  tl.set(${sel}, { x: ${dx}, y: ${dy}, scale: ${scale} }, 0);`);
        out.push(`  tl.to(${sel}, { x: 0, y: 0, scale: 1, duration: ${px(seconds)}, ease: ${JSON.stringify(GSAP_EASE[travel.ease])} }, ${px(moves)});`);
        continue; // a thing that travels does not also "arrive" where it started.
      }
    }

    // ── the manner of entering and leaving ────────────────────────────────────
    const { arrival, departure } = elementTweens(d.item, d.box);
    for (const spec of [arrival, departure]) {
      // A cut is the absence of movement, and an empty tween is worse than none: it is a
      // line of script that says nothing and still has to be read.
      if (spec.duration <= 0 || !Object.keys(spec.vars).length) continue;
      const from: Record<string, number> = {};
      const to: Record<string, number> = {};
      for (const [k, v] of Object.entries(spec.vars)) {
        if (Array.isArray(v)) { from[k] = v[0]; to[k] = v[1]; } else { from[k] = v as number; }
      }
      // Rounded, and written as one object rather than a spread: this script ends up in a
      // file a person opens when a film looks wrong, and it should read like something
      // somebody wrote.
      const round = (o: Record<string, number>) => Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
      const withTiming = (o: Record<string, number>) => JSON.stringify(
        { ...round(o), duration: px(spec.duration), ease: spec.ease }).replace(/"(\w+)":/g, "$1: ");
      const plain = (o: Record<string, number>) => JSON.stringify(round(o)).replace(/"(\w+)":/g, "$1: ");
      if (spec.method === "fromTo") {
        out.push(`  tl.fromTo(${sel}, ${plain(from)}, ${withTiming(to)}, ${px(spec.at)});`);
      } else if (spec.method === "from") {
        out.push(`  tl.from(${sel}, ${withTiming(from)}, ${px(spec.at)});`);
      } else {
        out.push(`  tl.set(${sel}, ${plain(from)}, ${px(spec.at)});`);
      }
    }
  }
  return out;
}


/** The renderer's contract, in two script tags.
 *
 *  HyperFrames drives a PAUSED GSAP timeline registered under the composition's id and
 *  seeks it per frame. Without one it spends the whole setup waiting for a timeline that
 *  never arrives. Measured on this project, same pixels out: setup 46.6 s against 1.8 s,
 *  whole render 1 min 47 s against 14.7 s.
 *
 *  The timeline is empty today, and the runtime says so in its own log: "static-frame
 *  dedup: disabled (no GSAP tweens)". So this buys the setup back, not the dedup — dedup
 *  needs real tweens, and arrives with the motion layer, which adds them to this same
 *  object.
 *
 *  If the library fails to load we register nothing and the runtime falls back to the slow
 *  path it uses today. Slow and right beats a half-built timeline. */
function timelineHtml(statements: string[] = []): string {
  return [
    '<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>',
    "<script>",
    '  if (typeof gsap !== "undefined") {',
    "    var tl = gsap.timeline({ paused: true });",
    ...statements.map((l) => `  ${l}`),
    "    window.__timelines = window.__timelines || {};",
    `    window.__timelines[${JSON.stringify(COMPOSITION_ID)}] = tl;`,
    "  }",
    "</script>",
  ].join("\n");
}

/** A hex that came through the validator, checked again here because this string is about
 *  to become part of a style attribute. */
const colour = (v: string | undefined): string | null =>
  v && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : null;

/** What a region's surface is, when a recipe has an opinion about that region.
 *
 *  The paint on the blueprint is a capture's guess and gets overwritten by the recipe
 *  anyway; reading it here as well is how a stale fill survived a re-measure. Null means the
 *  recipe says nothing about this region and its own paint stands. */
function recipeFill(rec: FormatRecipe | null, r: BlueprintRegion): string | null | undefined {
  if (!rec) return undefined;
  const id = r.id.toLowerCase();
  const part = tierPart(id);
  if (part?.kind === "label") return rec.tiers.find((t) => t.id.toLowerCase() === part.key)?.fill ?? undefined;
  if (part?.kind === "slot") return rec.board.slotBackground;
  if (/tier-board|tier-list|^board$/.test(id)) return rec.board.background;
  if (/banner|title/.test(id)) return rec.banner.plate;
  // A caption band paints nothing — the words carry their own stroke.
  if (/caption/.test(id)) return null;
  return undefined;
}

function boxStyle(r: BlueprintRegion, W: number, H: number, rec: FormatRecipe | null = null): string {
  const [x, y, w, h] = r.rect;
  const out = [`left:${pct(x)}`, `top:${pct(y)}`, `width:${pct(w)}`, `height:${pct(h)}`, `z-index:${Math.round(r.z)}`];
  const fromRecipe = recipeFill(rec, r);
  if (fromRecipe !== undefined) {
    const f = colour(fromRecipe ?? undefined);
    if (f) out.push(`background:${f}`);
    const part = tierPart(r.id.toLowerCase());
    if (part?.kind === "label" && rec && rec.label.radiusRatio > 0) {
      out.push(`border-radius:${Math.round(Math.min(w * W, h * H) * rec.label.radiusRatio)}px`);
    }
    return out.join(";");
  }
  // The region's own surface. A tier row IS a coloured rectangle; asked to generate one,
  // an image model produced a photograph of a tier list inside a single row.
  const p = r.paint;
  if (p) {
    const fill = colour(p.fill);
    if (fill) out.push(`background:${fill}`);
    // Radius and border are fractions of the shorter side, so they hold at any frame size.
    const short = Math.min(w * W, h * H);
    // Never round S–D letter plates — Hypit labels are sharp pastel rectangles.
    if (p.radius && p.radius > 0 && !/-label$/i.test(r.id)) out.push(`border-radius:${Math.round(p.radius * short)}px`);
    const bc = colour(p.border?.color);
    if (bc && p.border) out.push(`border:${Math.max(1, Math.round(p.border.width * short))}px solid ${bc}`);
  }
  return out.join(";");
}

/** The largest size at which these words still fit in this box.
 *
 *  A format states a size; an EPISODE states words, and a longer line in the same slot has
 *  to hold. Measured: a caption band 648x77 given "Built like a Greek god, plays like a
 *  Greek tragedy." at the captured 45px wrapped to two lines, and the region clips, so the
 *  viewer saw the middle of two half-lines. Shrinking is the only behaviour that keeps a
 *  format honest when the words change, which is the entire point of a format.
 *
 *  Glyph width is estimated, not measured — there is no layout engine here. 0.52 of the
 *  font size is a heavy sans average, and erring narrow would be the dangerous direction,
 *  so it errs wide. */
function fitSize(text: string, boxW: number, boxH: number, desired: number): number {
  const chars = Math.max(text.replace(/\s+/g, " ").trim().length, 1);
  // Headroom on both axes. A plate behind the line carries padding, and a display face's
  // line box is taller than its nominal size — measured: a two-line title computed to fit
  // at 1.15 line-height came out with its descenders cut off.
  // Display faces (Impact / Arial Black) have a taller line box than Inter; 1.15 was
  // measured to clip descenders on the HypeKit title, 1.32 still clipped a two-line
  // banner — 1.45 leaves room without shrinking the type into a different film.
  const usableW = Math.max(boxW * 0.92, 1), usableH = Math.max(boxH * 0.88, 1);
  for (let f = Math.round(desired); f > 8; f--) {
    const perLine = Math.max(Math.floor(usableW / (f * 0.55)), 1);
    const lines = Math.ceil(chars / perLine);
    if (lines * f * 1.45 <= usableH) return f;
  }
  return 8;
}

/** The words of one item, set the way the track says.
 *
 *  Emphasis is a span inside the value, so one string stays one string. A format that
 *  underlines the word carrying the joke — and the reference does — cannot otherwise be
 *  reproduced at all: it comes out as a flat line that reads wrong. */
function textHtml(st: TextStyle | undefined, value: string, H: number, box: { w: number; h: number }, plateFromRegion = false): string {
  const parts = splitEmphasis(value);
  const em = st?.emphasis;
  const emColour = colour(em?.color);
  const body = parts.map((p) => {
    const t = esc(p.text);
    if (!p.strong || !em || !emColour) return t;
    // Hypit karaoke rarely uses a full cyan plate; a heavy fill reads as "backdrop" noise.
    // Keep a subtle tint only — never a solid band behind the whole caption.
    if (em.style === "highlight") return `<mark style="background:${emColour}99;color:inherit;padding:0 .12em;border-radius:.08em;box-decoration-break:clone;-webkit-box-decoration-break:clone">${t}</mark>`;
    if (em.style === "underline") return `<span style="box-shadow:inset 0 -.22em 0 ${emColour}">${t}</span>`;
    return `<span style="color:${emColour}">${t}</span>`;
  }).join("");

  const css: string[] = [];
  // A closed set of shapes, each mapped to a stack that exists on a rendering machine. The
  // blueprint never carries a font name, so nothing a model invented reaches a stylesheet.
  // Single quotes inside the value: this string is embedded in style="…", and a
  // double-quoted family name ("Impact") closed the attribute early — measured: color
  // and weight after it were ignored, so a black-on-cream title rendered as white-on-cream.
  // Prefer HyperFrames-mapped families (Oswald / League Gothic / Montserrat) — Impact/
  // Haettenschweiler alias to the wrong face and read as "totally different font".
  const FONTS: Record<string, string> = {
    sans: "Inter, 'Helvetica Neue', Arial, sans-serif",
    "sans-condensed": "Oswald, 'Arial Narrow', 'Roboto Condensed', Inter, sans-serif",
    "sans-rounded": "'SF Pro Rounded', 'Varela Round', 'Trebuchet MS', Inter, sans-serif",
    display: "'League Gothic', Oswald, Montserrat, 'Arial Black', Inter, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    slab: "'Rockwell', 'Roboto Slab', Georgia, serif",
    mono: "'SF Mono', Menlo, Consolas, monospace",
    handwritten: "'Bradley Hand', 'Segoe Script', cursive",
  };
  if (st?.font && FONTS[st.font]) css.push(`font-family:${FONTS[st.font]}`);
  const TRANSFORM: Record<string, string> = { upper: "uppercase", lower: "lowercase", title: "capitalize" };
  const tr = st?.case ? TRANSFORM[st.case] : undefined;
  if (tr) css.push(`text-transform:${tr}`);
  const fg = colour(st?.color);
  if (fg) css.push(`color:${fg}`);
  // The weight is the weight that was asked for. It used to be clamped to 700 for a display
  // face, because one reference's tier letters were lighter than the capture claimed — which
  // is a fact about that video's recipe, not about display faces, and it silently overrode
  // every title that genuinely is set in black.
  if (st?.weight) css.push(`font-weight:${Math.round(st.weight)}`);
  if (st?.font === "display") css.push(`letter-spacing:0.02em`);
  // The plain text, for measuring: the brackets are markup, not words on screen.
  const plain = parts.map((p) => p.text).join("");
  const want = st?.size ? st.size * H : H * 0.032;
  css.push(`font-size:${fitSize(plain, box.w, box.h, want)}px`);
  // Thin glyph stroke — H*0.004 (~5px @1280) reads as a heavy backdrop plate.
  const outline = colour(st?.outline);
  if (outline) {
    const sw = typeof (st as TextStyle & { strokeWidth?: number }).strokeWidth === "number"
      ? Math.max(1, Math.round((st as TextStyle & { strokeWidth?: number }).strokeWidth!))
      : Math.max(2, Math.round(H * 0.003));
    css.push(`-webkit-text-stroke:${sw}px ${outline};paint-order:stroke fill`);
  }
  // Tier letters / titles: never invent a soft shadow (looks like double-draw).
  css.push(`text-shadow:none`);
  // The region's own paint already drew the plate. Repeating style.background here is
  // how a cream title banner grew a second cream bar around the words.
  const plate = plateFromRegion ? null : colour(st?.background);
  if (plate) css.push(`background:${plate};padding:.12em .4em`);
  let htmlBody = body;
  // Hypit title banners are two lines ("RANKING THE BEST" / "FOOTBALLERS …"), not one wrapped blob.
  if (st?.font === "display" && st?.case === "upper" && !parts.some((p) => p.strong)) {
    const titlePlain = parts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
    const words = titlePlain.split(" ");
    if (words.length >= 4 && !/<br/i.test(body)) {
      const mid = Math.ceil(words.length * 0.55);
      htmlBody = esc(words.slice(0, mid).join(" ")) + "<br>" + esc(words.slice(mid).join(" "));
      css.push(`line-height:1.05`);
      css.push(`white-space:normal`);
    }
  }
  return `<span${css.length ? ` style="${css.join(";")}"` : ""}>${htmlBody}</span>`;
}

// ── drawing from a recipe ──────────────────────────────────────────────────────
//
// Everything below draws from numbers instead of from judgement. There is no fitting, no
// fallback face, no "looks better at". If one of these frames comes out wrong, the number
// that made it wrong is in the recipe and can be read there.

/** "s-label" / "s-slot" → which tier, and which half of the row. */
function tierPart(id: string): { key: string; kind: "label" | "slot" } | null {
  const m = /^([a-z0-9]{1,4})-(label|slot)$/i.exec(id);
  return m ? { key: m[1].toLowerCase(), kind: m[2].toLowerCase() as "label" | "slot" } : null;
}

/** One run of words, set exactly as the recipe says, at a size in pixels.
 *
 *  `fitSize` above exists because an EPISODE can put longer words in a slot than the capture
 *  had, and a line that overflows its box is worse than a line one point smaller. That still
 *  applies here — but it applies to the recipe's size as the starting point, not to a guess. */
function recipeTypeCss(t: TypeSpec, sizePx: number, H: number): string[] {
  const css = [`font-family:${FACE_STACKS[t.face]}`, `font-weight:${Math.round(t.weight)}`,
    `font-size:${Math.round(sizePx)}px`, `line-height:${t.lineHeight}`];
  const ink = colour(t.ink);
  if (ink) css.push(`color:${ink}`);
  const TRANSFORM: Record<string, string> = { upper: "uppercase", lower: "lowercase", title: "capitalize" };
  if (t.case !== "as-is" && TRANSFORM[t.case]) css.push(`text-transform:${TRANSFORM[t.case]}`);
  if (t.tracking) css.push(`letter-spacing:${t.tracking}em`);
  const stroke = t.stroke ? colour(t.stroke.color) : null;
  if (stroke && t.stroke) {
    // The stroke is a fraction of the frame's height, so it holds at any render size — and
    // `paint-order` is what keeps it OUTSIDE the letters instead of eating into them.
    css.push(`-webkit-text-stroke:${Math.max(1, Math.round(t.stroke.width * H))}px ${stroke}`);
    css.push(`paint-order:stroke fill`);
  }
  const plate = colour(t.plate ?? undefined);
  if (plate) css.push(`background:${plate};padding:.1em .35em`);
  css.push(`text-shadow:none`);
  return css;
}

/** Roughly how wide a character is in this face, as a fraction of the em.
 *
 *  There is no layout engine here, so the line break has to be estimated, and the estimate
 *  has to know that a black grotesque is half again as wide as a condensed one. Using one
 *  number for every face is what put a title bar's second line off the side of the plate.
 *  The table lives with the recipe, because the measure step uses it in reverse: given
 *  lettering it has measured, it works out which face those widths belong to. */
const FACE_WIDTH = FACE_WIDTHS;

/** The largest size at which these words fit the box in the lines the recipe allows.
 *
 *  Same job as `fitSize`, done against the recipe's own line height and line count rather
 *  than against a constant that was tuned once against one title. */
function recipeFit(text: string, boxW: number, boxH: number, want: number, t: TypeSpec): number {
  const chars = Math.max(text.replace(/\s+/g, " ").trim().length, 1);
  const em = FACE_WIDTH[t.face];
  for (let f = Math.round(want); f > 8; f--) {
    const perLine = Math.max(Math.floor((boxW * 0.94) / (f * em)), 1);
    const lines = Math.ceil(chars / perLine);
    if (lines <= t.maxLines && lines * f * t.lineHeight <= boxH * 0.98) return f;
  }
  return 8;
}

/** The words themselves, broken over at most the lines the recipe allows.
 *
 *  A title set in two lines is a different design from the same title wrapped by accident,
 *  so the break is placed rather than left to the box — at the word nearest the middle, which
 *  is what a person does with a two-line title bar. */
function recipeTextHtml(
  t: TypeSpec, value: string, box: { w: number; h: number }, H: number,
  karaoke: { color: string } | null, keepSize = false,
): string {
  const parts = splitEmphasis(value);
  const plain = parts.map((p) => p.text).join("");
  const want = t.size * H;
  const size = keepSize ? Math.round(want) : recipeFit(plain, box.w, box.h, want, t);
  const css = recipeTypeCss(t, size, H);
  const marked = colour(karaoke?.color);
  let body = parts.map((p) => {
    const text = esc(p.text);
    if (!p.strong || !marked) return text;
    return `<mark style="background:${marked};color:inherit;padding:0 .12em;border-radius:.1em;box-decoration-break:clone;-webkit-box-decoration-break:clone">${text}</mark>`;
  }).join("");
  if (t.maxLines > 1 && !parts.some((p) => p.strong)) {
    const words = plain.replace(/\s+/g, " ").trim().split(" ");
    const perLine = Math.max(1, Math.floor((box.w * 0.94) / (size * FACE_WIDTH[t.face])));
    if (words.length > 1 && words.join(" ").length > perLine) {
      const lines: string[] = [];
      let line: string[] = [];
      for (const w of words) {
        if (line.length && (line.join(" ") + " " + w).length > perLine && lines.length < t.maxLines - 1) {
          lines.push(line.join(" "));
          line = [];
        }
        line.push(w);
      }
      lines.push(line.join(" "));
      body = lines.map((l) => esc(l)).join("<br>");
    }
  }
  return `<span style="${css.join(";")}">${body}</span>`;
}

/** A tier row's letter plate: a rectangle of one colour with one character on it. */
function labelRegionHtml(rec: FormatRecipe, r: BlueprintRegion, letter: string, W: number, H: number, timing: string): string {
  const rowH = r.rect[3] * H;
  const size = Math.max(6, rowH * rec.label.sizeRatioOfRow);
  const css = recipeTypeCss(rec.label.type, size, H);
  void W;
  return `      <div class="it txt" ${timing} style="display:flex;align-items:center;justify-content:center">` +
    `<span style="${css.join(";")}">${esc(letter)}</span></div>`;
}

/** A tier row's tiles: squares in a line, left to right, at the size the recipe gives.
 *
 *  This replaced a flex rule with three `!important` on it, which is the thing the handoff
 *  asked for by name. Position is arithmetic — first tile at the row's padding, every one
 *  after it a tile and a gap further along — so a row that comes out wrong is a number that
 *  can be read, not a cascade that has to be debugged. */
function slotRegionHtml(
  rec: FormatRecipe, r: BlueprintRegion, tiles: { url: string | null; timing: string; alt: string; slot: number }[],
  W: number, H: number,
): string {
  if (!tiles.length) return "";
  const rowH = r.rect[3] * H, slotW = r.rect[2] * W;
  const tileH = rowH * rec.thumb.heightRatio;
  const tileW = tileH * rec.thumb.aspect;
  const gap = rec.thumb.gap * W;
  const pad = rec.thumb.padX * W;
  const radius = Math.round(Math.min(tileW, tileH) * rec.thumb.radiusRatio);
  // How many tiles the row holds at once, which is not how many elements are emitted: a
  // twenty-second film emits every tile the row ever holds, each on its own clock. Counting
  // the elements put the second beat's pictures in the fourth, fifth and sixth positions —
  // a row that fills up and then keeps going sideways.
  const across = Math.max(...tiles.map((t) => t.slot)) + 1;
  const span = across * tileW + Math.max(0, across - 1) * gap;
  const left0 = rec.thumb.align === "center" ? Math.max(0, (slotW - span) / 2) : pad;
  const top = Math.max(0, (rowH - tileH) / 2);
  return tiles.map((t) => {
    const x = left0 + t.slot * (tileW + gap);
    const geo = `position:absolute;left:${r2(x)}px;top:${r2(top)}px;width:${r2(tileW)}px;height:${r2(tileH)}px;` +
      `border-radius:${radius}px;object-fit:${rec.thumb.fit};object-position:center center`;
    if (!t.url) {
      return `      <div class="it missing" ${t.timing} style="${geo}" title="${esc(t.alt.slice(0, 80))}"></div>`;
    }
    return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(t.url)
      ? `      <video class="med tile" src="${t.url}" muted playsinline ${t.timing} style="${geo}"></video>`
      : `      <img class="med tile" src="${t.url}" alt="" ${t.timing} style="${geo}">`;
  }).join("\n");
}

/** One item, as the element its kind needs. */
function itemHtml(
  t: BlueprintTrack, it: BlueprintItem, i: number, src: ComposeSources,
  H: number, box: { w: number; h: number }, regionPainted = false, id = "",
): string {
  const timing = `${id ? `id="${id}" ` : ""}data-start="${r2(it.start)}" data-duration="${r2(Math.max(it.end - it.start, 0.04))}" data-track-index="1"`;
  if (t.kind === "text") {
    if (src.tracedPixels) return "";
    const align = t.style?.align ?? "center";
    const just = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
    return `      <div class="it txt" style="justify-content:${just};text-align:${align}" ${timing}>${textHtml(t.style, it.value, H, box, regionPainted)}</div>`;
  }
  if (t.kind === "color") {
    if (src.tracedPixels) return "";
    // Only a plain hex is honoured; anything else would be a value going into a style.
    const hex = /^#[0-9a-fA-F]{3,8}$/.test(it.value.trim()) ? it.value.trim() : "#000000";
    return `      <div class="it fill" style="background:${hex}" ${timing}></div>`;
  }
  const raw = src.assetFor(t, it, i);
  const url = raw ? safeUrl(raw) : null;
  // The FILE decides the element, not the track's declared kind. A traced region is cut to
  // mp4 whatever the blueprint called it, and an <img> pointing at a video renders nothing
  // — measured: thirteen "images" that were all crops, none of which drew.
  const isVideo = url ? /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) : t.kind === "video";
  if (!url) {
    // Nothing to draw yet. The box stays, so a missing asset is visible as a gap rather
    // than silently collapsing the layout around it.
    return `      <div class="it missing" ${timing} title="${esc(it.value.slice(0, 80))}"></div>`;
  }
  if (isVideo) {
    return `      <video class="it med" src="${url}" muted playsinline ${timing}></video>`;
  }
  return `      <img class="it med" src="${url}" alt="" ${timing}>`;
}

export function composeBlueprint(bp: Blueprint, src: ComposeSources): string {
  const W = Math.round(bp.canvas.width), H = Math.round(bp.canvas.height);
  const total = r2(bp.canvas.seconds);
  const rec = src.recipe ?? null;
  const byRegion = new Map<string, BlueprintTrack[]>();
  for (const t of bp.tracks) byRegion.set(t.region, [...(byRegion.get(t.region) ?? []), t]);
  const letterFor = new Map((rec?.tiers ?? []).map((t) => [t.id.toLowerCase(), t.letter]));

  // Paint order is the blueprint's own: z first, and declaration order to break a tie.
  const ordered = [...bp.regions].sort((a, b) => a.z - b.z || bp.regions.indexOf(a) - bp.regions.indexOf(b));

  const drawn: Drawn[] = [];
  const regions = ordered.map((r) => {
    const tracks = byRegion.get(r.id) ?? [];
    // This used to skip any region whose id looked like an overlay, because one capture had
    // used that id for a duplicate of the tier board. In the reference it is the INSERT
    // layer — the photographs the film drops over the board, which are most of what happens
    // in it — and skipping it left a static board under a talking head. What is skipped now
    // is the thing the rule was written for: an overlay that covers the board and carries no
    // geometry of its own, which is a copy of the board and nothing else.
    if (/overlay|backdrop/i.test(r.id)) {
      const coversAll = r.rect[2] * r.rect[3] >= 0.28;
      const placed = tracks.some((t) => t.items.some((it) => it.rect));
      if (!placed && coversAll) return "";
    }
    const whole = src.regionAsset?.(r.id) ?? null;
    const wholeUrl = whole ? safeUrl(whole) : null;
    const at = typeof src.activeAt === "number" ? src.activeAt : null;
    const visible = (it: BlueprintItem) => {
      if (!(it.start < total && it.end > 0)) return false;
      if (at == null) return true;
      return it.start <= at && it.end > at;
    };
    const box = { w: r.rect[2] * W, h: r.rect[3] * H };
    // Every drawn element gets a name.
    //
    // A tween has to aim at something, and until now nothing in this document had an id but
    // the regions. The name is the region plus how many elements of it have been drawn, which
    // is stable for a given blueprint because this whole function is — the same blueprint
    // composes to the same document, element for element.
    let nth = 0;
    const elId = (it?: BlueprintItem) => {
      const id = `el-${esc(r.id)}-${nth++}`;
      // An element with a box of its own moves by its own size; one that fills its region
      // moves by the region's. Either way the number handed to motion is pixels.
      if (it) drawn.push({ id, item: it, region: r.id, box: {
        width: (it.rect ? it.rect[2] : r.rect[2]) * W,
        height: (it.rect ? it.rect[3] : r.rect[3]) * H,
      } });
      return id;
    };
    const timingOf = (it: BlueprintItem) =>
      `id="${elId(it)}" data-start="${r2(it.start)}" data-duration="${r2(Math.max(it.end - it.start, 0.04))}" data-track-index="1"`;

    // With a recipe in hand the known parts of the format are drawn from it, and the generic
    // path below never sees them. This is the whole point: one place decides how a tier row
    // looks, and it is a JSON file rather than a stylesheet.
    const part = rec ? tierPart(r.id) : null;
    let inner: string;
    if (wholeUrl) {
      inner = `      <video class="it med" src="${wholeUrl}" muted playsinline id="${elId()}" data-start="0" data-duration="${total}" data-track-index="1"></video>`;
    } else if (rec && part?.kind === "label" && !src.tracedPixels) {
      const track = tracks.find((t) => t.kind === "text");
      const items = (track?.items ?? []).filter(visible);
      const letter = letterFor.get(part.key) ?? items[0]?.value ?? part.key.toUpperCase();
      const it = items[0] ?? track?.items[0];
      inner = labelRegionHtml(rec, r, letter, W, H,
        it ? timingOf(it) : `id="${elId()}" data-start="0" data-duration="${total}" data-track-index="1"`);
    } else if (rec && part?.kind === "slot") {
      // One tile per thing the row holds right now, filled in the order the assets were
      // given. A row whose measured tile count is higher than the number of items it carries
      // is a row that was measured at a different moment — the items decide, not the count.
      //
      // The index handed to `assetFor` is the tile's POSITION in the row, not the item's
      // position in its track. A caller filling a tier list thinks in "the second picture in
      // the B row", and a row whose two pictures came from two items at different moments
      // otherwise asked for assets under indices nobody could predict.
      const tiles = tracks.flatMap((t) =>
        t.kind === "text" || t.kind === "color" ? [] : t.items.map((it) => ({ it, t })))
        .filter(({ it }) => visible(it))
        .map(({ it, t }, nth) => {
          // `beat` is which tile of the row this is — set when the measure step split a row
          // into the tiles it was counted to hold. Without one, the order they arrive in is
          // the order they sit in.
          const slot = typeof it.beat === "number" && it.beat > 0 ? it.beat - 1 : nth;
          const raw = src.assetFor(t, it, slot);
          return { url: raw ? safeUrl(raw) : null, timing: timingOf(it), alt: it.value, slot };
        })
        .filter((t) => t.slot < rec.thumb.maxCount);
      inner = slotRegionHtml(rec, r, tiles, W, H);
    } else if (rec && tracks.some((t) => t.items.some((it) => it.rect))) {
      // Items that carry their own box: an insert is placed and sized per appearance, so it
      // is drawn where it was measured rather than stretched over the area they all share.
      inner = tracks.flatMap((t) => (t.kind === "text" || t.kind === "color" ? [] : t.items.filter(visible).map((it, i) => {
        const raw = src.assetFor(t, it, i);
        const url = raw ? safeUrl(raw) : null;
        const box = it.rect ?? r.rect;
        // The region's own rect is the frame of reference; an item's is the canvas's.
        const left = ((box[0] - r.rect[0]) / r.rect[2]) * 100;
        const top = ((box[1] - r.rect[1]) / r.rect[3]) * 100;
        const w = (box[2] / r.rect[2]) * 100, h = (box[3] / r.rect[3]) * 100;
        const radius = Math.round(Math.min(box[2] * W, box[3] * H) * rec.card.radiusRatio);
        const shadow = rec.card.shadow ? `box-shadow:0 ${Math.round(H * 0.004)}px ${Math.round(H * 0.012)}px rgba(0,0,0,.45);` : "";
        const geo = `position:absolute;left:${r2(left)}%;top:${r2(top)}%;width:${r2(w)}%;height:${r2(h)}%;` +
          `object-fit:${rec.card.fit};object-position:center center;border-radius:${radius}px;${shadow}`;
        if (!url) return `      <div class="it missing" ${timingOf(it)} style="${geo}" title="${esc(it.value.slice(0, 80))}"></div>`;
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)
          ? `      <video class="med card" src="${url}" muted playsinline ${timingOf(it)} style="${geo}"></video>`
          : `      <img class="med card" src="${url}" alt="" ${timingOf(it)} style="${geo}">`;
      }))).join("\n");
    } else if (rec && !part && /inset|portrait|floating|presenter|host/i.test(r.id)) {
      // A card over the host, and the host itself: the same element, two sets of numbers.
      const card = /inset|portrait|floating/i.test(r.id);
      const fit = card ? rec.inset.fit : rec.presenter.fit;
      const position = card ? "center center" : rec.presenter.position;
      const radius = card ? Math.round(Math.min(box.w, box.h) * rec.inset.radiusRatio) : 0;
      const border = card && rec.inset.border && colour(rec.inset.border.color)
        ? `border:${Math.max(1, Math.round(Math.min(box.w, box.h) * rec.inset.border.width))}px solid ${rec.inset.border.color};`
        : "";
      const geo = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};` +
        `object-position:${position};border-radius:${radius}px;${border}`;
      inner = tracks.flatMap((t) => (t.kind === "text" || t.kind === "color" ? [] : t.items.filter(visible).map((it, i) => {
        const raw = src.assetFor(t, it, i);
        const url = raw ? safeUrl(raw) : null;
        if (!url) return `      <div class="it missing" ${timingOf(it)} title="${esc(it.value.slice(0, 80))}"></div>`;
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)
          ? `      <video class="med" src="${url}" muted playsinline ${timingOf(it)} style="${geo}"></video>`
          : `      <img class="med" src="${url}" alt="" ${timingOf(it)} style="${geo}">`;
      }))).join("\n");
    } else if (rec && !src.tracedPixels && /banner|title|caption/i.test(r.id)) {
      const caption = /caption/i.test(r.id);
      const type = caption ? rec.caption.type : rec.banner.type;
      // A caption this format shows in chunks is already cut to lines that fit; setting it
      // smaller "to be safe" is how the same film ended up with three caption sizes.
      const keepSize = caption && rec.caption.overflow === "chunk";
      const just = type.align === "left" ? "flex-start" : type.align === "right" ? "flex-end" : "center";
      const padX = caption ? 0.02 : rec.banner.padX;
      inner = tracks.filter((t) => t.kind === "text").flatMap((t) => t.items.filter(visible).map((it) =>
        `      <div class="it txt" ${timingOf(it)} style="justify-content:${just};text-align:${type.align};padding:0 ${pct(padX)}">` +
        `${recipeTextHtml(type, it.value, { w: box.w * (1 - padX * 2), h: box.h }, H, caption ? rec.caption.karaoke : null, keepSize)}</div>`,
      )).join("\n");
    } else {
      inner = tracks.flatMap((t) => t.items.filter(visible)
        .map((it, i) => itemHtml(t, it, i, src, H, box, !!r.paint?.fill, elId(it)))).filter(Boolean).join("\n");
    }
    const label = src.debugRegions ? `      <div class="dbg">${esc(r.id)}</div>\n` : "";
    return `    <div class="rg rg-${esc(r.role)}" id="rg-${esc(r.id)}" style="${boxStyle(r, W, H, rec)}">\n${label}${inner}\n    </div>`;
  }).filter(Boolean).join("\n");

  const audio = src.audioUrl && safeUrl(src.audioUrl)
    ? `    <audio src="${safeUrl(src.audioUrl)}" data-start="0" data-duration="${total}" data-track-index="9" data-volume="1"></audio>\n`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; background: #000; overflow: hidden; }
  #stage { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
  .rg { position: absolute; overflow: hidden; }
  .it { position: absolute; inset: 0; }
  /* Media fills its region without distorting: the blueprint's rect decides the frame. */
  /* hypit-like-media-fit
     Host/presenter fills its stage (cover). Tier slot thumbs sit ON a dark board (contain)
     — measured failure: cover on row-slots stretched fruit across the whole cell. */
  .med { width: 100%; height: 100%; object-fit: cover; object-position: center center; }
  /* A tile carries its own geometry — position, size, corner — written inline from the
     recipe. There used to be a rule here forcing that with three overrides, and the handoff
     named it as the thing to delete: a row that comes out wrong should be a number in a
     JSON file, not a cascade to debug. */
  .tile, .card { position: absolute; }
  .rg-figure .med { object-position: center top; }
  .rg-text .it.txt { pointer-events: none; }
  /* A traced crop must land exactly on its own box. Cropping is rounded to even pixels for
     h264, which shifts the aspect by a fraction, and object-fit cover answers that by
     rescaling — which showed as two captions sliding past each other. Filling maps the crop
     onto the rect it was cut from, which is what a reassembly means. */
  .traced .med { object-fit: fill; }
  .fill { width: 100%; height: 100%; }
  .missing { outline: 2px dashed rgba(255,255,255,.25); outline-offset: -2px; }
  .txt { display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 2%; }
  .txt span {
    font: 700 ${Math.round(H * 0.032)}px/1.1 Inter, "Helvetica Neue", Arial, sans-serif;
    color: #fff; text-shadow: none; letter-spacing: 0;
  }
  /* Caption karaoke: no soft shadow plate; stroke comes from inline style only. */
  #rg-caption-area .txt span, [id*="caption"] .txt span { text-shadow: none; }
  #rg-top-banner .txt span, [id*="banner"] .txt span, [id$="-label"] .txt span { text-shadow: none; }
  .dbg { position: absolute; left: 0; top: 0; font: 700 14px monospace; color: #0ff;
         background: rgba(0,0,0,.6); padding: 1px 4px; z-index: 99; }
</style></head><body>
<div id="stage" class="${src.tracedPixels ? 'traced' : ''}" data-composition-id="${COMPOSITION_ID}" data-start="0" data-width="${W}" data-height="${H}" data-duration="${total}" data-fps="${Math.round(bp.canvas.fps)}">
${regions}
${audio}</div>
${timelineHtml(tweenStatements(drawn, bp, W, H))}
</body></html>`;
}
