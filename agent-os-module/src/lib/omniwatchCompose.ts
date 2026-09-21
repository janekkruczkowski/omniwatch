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

export interface ComposeSources {
  /** The URL to draw for one image/video item, or null to leave the slot empty. */
  assetFor(track: BlueprintTrack, item: BlueprintItem, index: number): string | null;
  /** Narration for the whole piece, if there is any. */
  audioUrl?: string | null;
  /** Drawn faintly over every region with its id — for checking geometry, never for output. */
  debugRegions?: boolean;
  /** One finished clip for a whole region, used instead of its items.
   *
   *  A trace cuts a region once, for the whole piece, and that clip already carries its own
   *  timing. Drawing it once per item replayed it from the start seven times over — which
   *  is what turned a caption band into two captions sliding through each other. */
  regionAsset?(regionId: string): string | null;
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

/** A hex that came through the validator, checked again here because this string is about
 *  to become part of a style attribute. */
const colour = (v: string | undefined): string | null =>
  v && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : null;

function boxStyle(r: BlueprintRegion, W: number, H: number): string {
  const [x, y, w, h] = r.rect;
  const out = [`left:${pct(x)}`, `top:${pct(y)}`, `width:${pct(w)}`, `height:${pct(h)}`, `z-index:${Math.round(r.z)}`];
  // The region's own surface. A tier row IS a coloured rectangle; asked to generate one,
  // an image model produced a photograph of a tier list inside a single row.
  const p = r.paint;
  if (p) {
    const fill = colour(p.fill);
    if (fill) out.push(`background:${fill}`);
    // Radius and border are fractions of the shorter side, so they hold at any frame size.
    const short = Math.min(w * W, h * H);
    if (p.radius && p.radius > 0) out.push(`border-radius:${Math.round(p.radius * short)}px`);
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
  const usableW = Math.max(boxW * 0.94, 1), usableH = Math.max(boxH * 0.92, 1);
  for (let f = Math.round(desired); f > 8; f--) {
    const perLine = Math.max(Math.floor(usableW / (f * 0.52)), 1);
    const lines = Math.ceil(chars / perLine);
    if (lines * f * 1.32 <= usableH) return f;
  }
  return 8;
}

/** The words of one item, set the way the track says.
 *
 *  Emphasis is a span inside the value, so one string stays one string. A format that
 *  underlines the word carrying the joke — and the reference does — cannot otherwise be
 *  reproduced at all: it comes out as a flat line that reads wrong. */
function textHtml(st: TextStyle | undefined, value: string, H: number, box: { w: number; h: number }): string {
  const parts = splitEmphasis(value);
  const em = st?.emphasis;
  const emColour = colour(em?.color);
  const body = parts.map((p) => {
    const t = esc(p.text);
    if (!p.strong || !em || !emColour) return t;
    if (em.style === "highlight") return `<mark style="background:${emColour};color:inherit;padding:0 .18em;border-radius:.12em">${t}</mark>`;
    if (em.style === "underline") return `<span style="box-shadow:inset 0 -.22em 0 ${emColour}">${t}</span>`;
    return `<span style="color:${emColour}">${t}</span>`;
  }).join("");

  const css: string[] = [];
  // A closed set of shapes, each mapped to a stack that exists on a rendering machine. The
  // blueprint never carries a font name, so nothing a model invented reaches a stylesheet.
  const FONTS: Record<string, string> = {
    sans: 'Inter, "Helvetica Neue", Arial, sans-serif',
    "sans-condensed": '"Arial Narrow", "Helvetica Neue Condensed", "Roboto Condensed", Inter, sans-serif',
    "sans-rounded": '"SF Pro Rounded", "Varela Round", "Trebuchet MS", Inter, sans-serif',
    display: '"Impact", "Haettenschweiler", "Arial Black", Inter, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    slab: '"Rockwell", "Roboto Slab", Georgia, serif',
    mono: '"SF Mono", Menlo, Consolas, monospace',
    handwritten: '"Bradley Hand", "Segoe Script", cursive',
  };
  if (st?.font && FONTS[st.font]) css.push(`font-family:${FONTS[st.font]}`);
  const TRANSFORM: Record<string, string> = { upper: "uppercase", lower: "lowercase", title: "capitalize" };
  const tr = st?.case ? TRANSFORM[st.case] : undefined;
  if (tr) css.push(`text-transform:${tr}`);
  const fg = colour(st?.color);
  if (fg) css.push(`color:${fg}`);
  if (st?.weight) css.push(`font-weight:${Math.round(st.weight)}`);
  // The plain text, for measuring: the brackets are markup, not words on screen.
  const plain = parts.map((p) => p.text).join("");
  const want = st?.size ? st.size * H : H * 0.032;
  css.push(`font-size:${fitSize(plain, box.w, box.h, want)}px`);
  // A stroke around the glyphs, which is what keeps a caption readable over footage.
  const outline = colour(st?.outline);
  if (outline) css.push(`-webkit-text-stroke:${Math.max(1, Math.round(H * 0.004))}px ${outline};paint-order:stroke fill`);
  const plate = colour(st?.background);
  if (plate) css.push(`background:${plate};padding:.12em .4em`);
  return `<span${css.length ? ` style="${css.join(";")}"` : ""}>${body}</span>`;
}

/** One item, as the element its kind needs. */
function itemHtml(
  t: BlueprintTrack, it: BlueprintItem, i: number, src: ComposeSources,
  H: number, box: { w: number; h: number },
): string {
  const timing = `data-start="${r2(it.start)}" data-duration="${r2(Math.max(it.end - it.start, 0.04))}" data-track-index="1"`;
  if (t.kind === "text") {
    if (src.tracedPixels) return "";
    const align = t.style?.align ?? "center";
    const just = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
    return `      <div class="it txt" style="justify-content:${just};text-align:${align}" ${timing}>${textHtml(t.style, it.value, H, box)}</div>`;
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
  const byRegion = new Map<string, BlueprintTrack[]>();
  for (const t of bp.tracks) byRegion.set(t.region, [...(byRegion.get(t.region) ?? []), t]);

  // Paint order is the blueprint's own: z first, and declaration order to break a tie.
  const ordered = [...bp.regions].sort((a, b) => a.z - b.z || bp.regions.indexOf(a) - bp.regions.indexOf(b));

  const regions = ordered.map((r) => {
    const tracks = byRegion.get(r.id) ?? [];
    const whole = src.regionAsset?.(r.id) ?? null;
    const wholeUrl = whole ? safeUrl(whole) : null;
    const inner = wholeUrl
      ? `      <video class="it med" src="${wholeUrl}" muted playsinline data-start="0" data-duration="${total}" data-track-index="1"></video>`
      : tracks.flatMap((t) => t.items.map((it, i) => itemHtml(t, it, i, src, H, { w: r.rect[2] * W, h: r.rect[3] * H }))).filter(Boolean).join("\n");
    const label = src.debugRegions ? `      <div class="dbg">${esc(r.id)}</div>\n` : "";
    return `    <div class="rg rg-${esc(r.role)}" id="rg-${esc(r.id)}" style="${boxStyle(r, W, H)}">\n${label}${inner}\n    </div>`;
  }).join("\n");

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
  .med { width: 100%; height: 100%; object-fit: cover; }
  /* A traced crop must land exactly on its own box. Cropping is rounded to even pixels for
     h264, which shifts the aspect by a fraction, and object-fit cover answers that by
     rescaling — which showed as two captions sliding past each other. Filling maps the crop
     onto the rect it was cut from, which is what a reassembly means. */
  .traced .med { object-fit: fill; }
  .fill { width: 100%; height: 100%; }
  .missing { outline: 2px dashed rgba(255,255,255,.25); outline-offset: -2px; }
  .txt { display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 2%; }
  .txt span {
    font: 800 ${Math.round(H * 0.032)}px/1.15 Inter, "Helvetica Neue", Arial, sans-serif;
    color: #fff; text-shadow: 0 2px 10px rgba(0,0,0,.85); letter-spacing: -.01em;
  }
  .dbg { position: absolute; left: 0; top: 0; font: 700 14px monospace; color: #0ff;
         background: rgba(0,0,0,.6); padding: 1px 4px; z-index: 99; }
</style></head><body>
<div id="stage" class="${src.tracedPixels ? 'traced' : ''}" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${total}" data-fps="${Math.round(bp.canvas.fps)}">
${regions}
${audio}</div>
</body></html>`;
}
