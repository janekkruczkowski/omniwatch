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
import type { Blueprint, BlueprintItem, BlueprintTrack, BlueprintRegion } from "@/lib/omniwatchBlueprint";

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

function boxStyle(r: BlueprintRegion): string {
  const [x, y, w, h] = r.rect;
  return `left:${pct(x)};top:${pct(y)};width:${pct(w)};height:${pct(h)};z-index:${Math.round(r.z)}`;
}

/** One item, as the element its kind needs. */
function itemHtml(t: BlueprintTrack, it: BlueprintItem, i: number, src: ComposeSources): string {
  const timing = `data-start="${r2(it.start)}" data-duration="${r2(Math.max(it.end - it.start, 0.04))}" data-track-index="1"`;
  if (t.kind === "text") {
    if (src.tracedPixels) return "";
    return `      <div class="it txt" ${timing}><span>${esc(it.value)}</span></div>`;
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
      : tracks.flatMap((t) => t.items.map((it, i) => itemHtml(t, it, i, src))).filter(Boolean).join("\n");
    const label = src.debugRegions ? `      <div class="dbg">${esc(r.id)}</div>\n` : "";
    return `    <div class="rg rg-${esc(r.role)}" id="rg-${esc(r.id)}" style="${boxStyle(r)}">\n${label}${inner}\n    </div>`;
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
