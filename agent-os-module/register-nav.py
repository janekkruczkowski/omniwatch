#!/usr/bin/env python3
"""Register the OmniWatch tabs in Agent OS navigation.

Two tabs, two different homes:

* **OmniWatch** is a tool you reach for — a top-level entry in the sidebar, next to
  Thumbnails and Video.
* **Scout** runs on Hermes' scheduler, so it belongs inside the Hermes tab, beside
  Hermes Oracle and Hermes Astros, exactly like they do.

Putting Scout at the top level also trips an Agent OS quirk: the sidebar marks an item
active with `pathname.startsWith(href)`, so /omniwatch-scout lights up /omniwatch as
well and two entries look selected at once.

Everything here is idempotent, and re-running is how you repair the tabs after an Agent
OS update overwrites Sidebar.tsx, TopBar.tsx or hermes/page.tsx.

    python3 register-nav.py <agent-os>/source
"""
import re
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "."
sidebar = f"{src}/src/components/Sidebar.tsx"
topbar = f"{src}/src/components/TopBar.tsx"
hermes = f"{src}/src/app/hermes/page.tsx"

NAV_LINE = ('  { href: "/omniwatch", label: "OmniWatch", icon: <Eye size={16} />, '
            'accent: "#d4a574", dim: "rgba(212,165,116,0.16)" },\n')
TITLE_LINE = (
    '  "/omniwatch":   { numeral: "XI.",   label: "Self · OmniWatch",  title: "OmniWatch",'
    '               sub: "Paste a link to any video — YouTube, TikTok, Instagram, X, Reels, Shorts '
    '— and Qwen Omni watches it for you: every frame and every word, not a transcript. Ask it a '
    'question, or take the video apart to see how it is made and get a script for your own topic." },\n')

# Only used when Scout cannot be mounted inside Hermes.
SCOUT_NAV_LINE = ('  { href: "/omniwatch-scout", label: "Scout", icon: <Radar size={16} />, '
                  'accent: "#d4a574", dim: "rgba(212,165,116,0.16)" },\n')
SCOUT_TITLE_LINE = (
    '  "/omniwatch-scout": { numeral: "XI.",   label: "Self · Scout",      title: "OmniWatch Scout",'
    '         sub: "Name the accounts and hashtags worth watching. Hermes scrapes them through Apify every '
    'morning, Scout ranks the videos that beat their own baseline — not the ones with the biggest '
    'numbers — and the winners come back fully torn apart, with a script adapted to your topic." },\n')


CHIP = (
    '                    {t.competitor.url && (\n'
    '                      <a className="asx-act omni"\n'
    '                         href={`/omniwatch?url=${encodeURIComponent(t.competitor.url)}`}\n'
    '                         title="Astros read the title. OmniWatch opens the video and tells you how it was made.">\n'
    '                        <MonitorPlay size={14} /> OMNI WATCHES IT\n'
    '                      </a>\n'
    '                    )}\n')

CHIP_CSS = ('        .asx-act.omni{ color:#c58bff; border-color:rgba(197,139,255,.5); }'
            ' .asx-act.omni:hover{ box-shadow:0 0 18px rgba(197,139,255,.3); }\n')


def read(p):
    return open(p, encoding="utf-8").read()


def write(p, s):
    open(p, "w", encoding="utf-8").write(s)


def ensure_icons(s, icons):
    """Make sure every icon we reference is imported from lucide-react."""
    m = re.search(r'import \{([^}]*)\} from "lucide-react";', s)
    if not m:
        return s
    names = [n.strip() for n in m.group(1).split(",") if n.strip()]
    for icon in icons:
        if not any(n == icon or n.endswith(f" as {icon}") for n in names):
            names.append(icon)
    return s[:m.start()] + "import { " + ", ".join(names) + ' } from "lucide-react";' + s[m.end():]


def patch_hermes():
    """Mount Scout as a Hermes sub-tab. Returns a status string, or None when the file
    does not look the way we expect — the caller then falls back to a top-level tab."""
    try:
        s = read(hermes)
    except OSError:
        return None
    if '"scout"' in s and "ScoutView" in s:
        return "already mounted"

    original = s
    if "ScoutView" not in s:
        anchor = 'import AstrosView from "@/components/AstrosView";\n'
        if anchor not in s:
            return None
        s = s.replace(anchor, anchor + 'import ScoutView from "@/components/ScoutView";\n', 1)

    # The key appears twice before the tab bar: the HermesTab union, then the
    # deep-link allowlist. Both have to learn the new key.
    if s.count('"astros"') < 2:
        return None
    s = s.replace('"astros"', '"astros" | "scout"', 1)
    s = s.replace('"astros",', '"astros", "scout",', 1)

    bar = '{ key: "astros",    label: "Hermes Astros", icon: <Sparkles size={14} /> },'
    if bar not in s:
        return None
    s = s.replace(bar, bar + '\n          { key: "scout",     label: "OmniWatch Scout", icon: <Eye size={14} /> },', 1)

    render = ') : tab === "astros" ? (\n        <AstrosView />\n      '
    if render not in s:
        return None
    s = s.replace(render, render + ') : tab === "scout" ? (\n        <ScoutView />\n      ', 1)

    s = ensure_icons(s, ["Eye"])
    if s == original:
        return None
    write(hermes, s)
    return "Scout mounted as a Hermes sub-tab"


def drop_line(path, needle):
    """Remove a nav line an earlier version of this installer added."""
    lines = read(path).split("\n")
    kept = [l for l in lines if needle not in l]
    if len(kept) == len(lines):
        return False
    write(path, "\n".join(kept))
    return True


def patch_sidebar(scout_top_level):
    s = read(sidebar)
    added = []
    anchor = '  { href: "/thumbnails",'
    if '"/omniwatch"' not in s:
        if anchor in s:
            s = s.replace(anchor, NAV_LINE + anchor, 1)
        else:
            s = re.sub(r"\n\];\s*\n\s*const DEFAULT_ORDER",
                       "\n" + NAV_LINE + "];\n\nconst DEFAULT_ORDER", s, count=1)
        added.append("/omniwatch")
    if scout_top_level and '"/omniwatch-scout"' not in s and anchor in s:
        s = s.replace(anchor, SCOUT_NAV_LINE + anchor, 1)
        added.append("/omniwatch-scout")
    s = ensure_icons(s, ["Eye", "Radar"] if scout_top_level else ["Eye"])
    write(sidebar, s)
    if not scout_top_level and drop_line(sidebar, '"/omniwatch-scout"'):
        added.append("removed stale /omniwatch-scout")
    return ", ".join(added) if added else "already complete"


def patch_topbar(scout_top_level):
    s = read(topbar)
    added = []
    anchor = '  "/thumbnails":'
    if '"/omniwatch":' not in s:
        if anchor in s:
            s = s.replace(anchor, TITLE_LINE + anchor, 1)
        else:
            s = s.replace("const TITLES: Record<string, PageMeta> = {\n",
                          "const TITLES: Record<string, PageMeta> = {\n" + TITLE_LINE, 1)
        added.append("/omniwatch")
    if scout_top_level and '"/omniwatch-scout":' not in s and anchor in s:
        s = s.replace(anchor, SCOUT_TITLE_LINE + anchor, 1)
        added.append("/omniwatch-scout")
    write(topbar, s)
    if not scout_top_level and drop_line(topbar, '"/omniwatch-scout":'):
        added.append("removed stale /omniwatch-scout")
    return ", ".join(added) if added else "already complete"


def patch_astros():
    """Add a fourth chip to the row of actions on each Astros topic.

    Astros already sweeps YouTube and hands each topic onward — to the Video agent, to
    NotebookLM, to the SEO writer. NotebookLM even receives the competitor's video, but
    it reads the transcript; nothing in that row opens the picture. This chip does, and
    the two sitting side by side explain the difference better than any description.

    The label has to say who is watching: the row above already has a WATCH link, and
    that one means "you go watch it on YouTube".
    """
    astros = f"{src}/src/components/AstrosView.tsx"
    try:
        s = read(astros)
    except OSError:
        return None
    if "asx-act omni" in s:
        return "already added"

    anchor = '                    <button className="asx-act nb"'
    css_anchor = ".asx-act.seo:hover{ box-shadow:0 0 18px rgba(255,216,107,.3); }\n"
    if anchor not in s or css_anchor not in s:
        return None

    s = s.replace(anchor, CHIP + anchor, 1)
    s = s.replace(css_anchor, css_anchor + CHIP_CSS, 1)
    s = ensure_icons(s, ["MonitorPlay"])
    write(astros, s)
    return "chip added"


SCENE_SECONDS_INTERFACE_OLD = (
    'interface SceneIn { caption?: string; narration_line?: string; brollUrl?: string }')
SCENE_SECONDS_INTERFACE_NEW = (
    '// seconds is optional — when a caller (e.g. the S4 "copy the rhythm" pipeline)\n'
    '// already knows how long each cut should run, it overrides the word-count guess.\n'
    'interface SceneIn { caption?: string; narration_line?: string; brollUrl?: string; seconds?: number }')

SCENE_CAP_OLD = (
    '  const scenesIn: SceneIn[] = Array.isArray(body.scenes) ? body.scenes.slice(0, 12) : [];')
SCENE_CAP_NEW = (
    '  // 12 was a hard ceiling left over from an earlier fixed-cadence version. A short\n'
    '  // video cut every ~10s of narration already runs fifty-odd scenes, so 12 silently\n'
    '  // dropped most of them; 60 is a generous ceiling, not a measured ideal.\n'
    '  const scenesIn: SceneIn[] = Array.isArray(body.scenes) ? body.scenes.slice(0, 60) : [];')

SCENE_WEIGHTS_OLD = (
    '  // ---- caption time slices proportional to narration_line length ----\n'
    '  const weights = scenesIn.map((s) => Math.max(1, (s.narration_line ?? "").trim()'
    '.split(/\\s+/).filter(Boolean).length));')
SCENE_WEIGHTS_NEW = (
    '  // ---- caption time slices proportional to narration_line length ----\n'
    '  // If the caller already knows a scene\'s rhythm (S4: cuts copied from a watched\n'
    '  // video), that explicit `seconds` stands in for the word-count guess. It still\n'
    '  // goes through the same normalize-to-narrDur step below, so picture and audio\n'
    '  // can\'t drift apart even when the supplied seconds don\'t sum to narrDur exactly.\n'
    '  const weights = scenesIn.map((s) => {\n'
    '    if (typeof s.seconds === "number" && Number.isFinite(s.seconds) && s.seconds > 0) return s.seconds;\n'
    '    return Math.max(1, (s.narration_line ?? "").trim().split(/\\s+/).filter(Boolean).length);\n'
    '  });')


def patch_assemble_route():
    """Let an /api/video/auto/assemble caller pin a scene's length in seconds
    instead of leaving it to the word-count guess (S4: rhythm copied from a
    watched video). Not our file — Agent OS owns it — so this patches it the
    same way patch_astros() patches AstrosView.tsx: three anchored replacements
    guarded by a sentinel, safe to re-run after an Agent OS update overwrites it.
    """
    route = f"{src}/src/app/api/video/auto/assemble/route.ts"
    try:
        s = read(route)
    except OSError:
        return None
    if "seconds?: number" in s:
        return "already patched"

    if SCENE_SECONDS_INTERFACE_OLD not in s or SCENE_CAP_OLD not in s or SCENE_WEIGHTS_OLD not in s:
        return None

    s = s.replace(SCENE_SECONDS_INTERFACE_OLD, SCENE_SECONDS_INTERFACE_NEW, 1)
    s = s.replace(SCENE_CAP_OLD, SCENE_CAP_NEW, 1)
    s = s.replace(SCENE_WEIGHTS_OLD, SCENE_WEIGHTS_NEW, 1)
    write(route, s)
    return "seconds override + slice(0, 60) cap applied"


BROLL_HEADER_OLD = (
    '// Body:\n'
    '//   { title, brand?, mode: "avatar"|"voiceover",\n'
    '//     narrationUrl,            // avatar mp4 (avatar mode) OR voiceover audio (voiceover mode)\n'
    '//     avatarUrl?,              // avatar mp4 for the picture-in-picture bug (avatar mode)\n'
    '//     scenes: [{ caption, narration_line, brollUrl? }] }\n'
    '//\n'
    '// Layout: intro card → b-roll sequence (looped to narration length) full-bleed,\n'
    '// captions lower-third synced to narration, avatar PiP bottom-right, continuous\n'
    '// narration audio, outro card. Everything saved to the project\'s assets/.')
BROLL_HEADER_NEW = (
    '// Body:\n'
    '//   { title, brand?, mode: "avatar"|"voiceover",\n'
    '//     narrationUrl,            // avatar mp4 (avatar mode) OR voiceover audio (voiceover mode)\n'
    '//     avatarUrl?,              // avatar mp4 for the picture-in-picture bug (avatar mode)\n'
    '//     scenes: [{ caption, narration_line, brollUrl?, seconds? }] }\n'
    '//\n'
    '// Layout: intro card → b-roll full-bleed, captions lower-third synced to narration,\n'
    '// avatar PiP bottom-right, continuous narration audio, outro card. Everything saved\n'
    '// to the project\'s assets/.\n'
    '//\n'
    '// B-roll placement has two modes. Normally the downloaded clips are looped back to\n'
    '// back across the whole narration, independent of scene boundaries — there\'s no\n'
    '// per-scene timing to follow. But when every scene carries `seconds` AND at least\n'
    '// one carries `brollUrl`, the cut has to follow the copied rhythm too, not just the\n'
    '// captions: scene i\'s own clip fills exactly scene i\'s normalised window (see\n'
    '// per-scene branch in buildHtml).')

# Anchors below assume the S4 seconds patch (SCENE_*) already changed the doc
# comment's scenes line and the SceneIn interface — but this patch is guarded
# by its own sentinel (PLACEMENT_CEILING) and applies independently of whether
# that one has already run, so an install patched with an older register-nav.py
# (S4 only, no per-scene broll) still picks this up on the next run.
BROLL_INTERFACES_OLD = (
    'interface BrollClip { src: string; dur: number }\n'
    'interface SceneTimed { caption: string; start: number; dur: number }\n'
    '\n'
    'function buildHtml(opts: {\n'
    '  title: string; brand: string; total: number; narrDur: number;\n'
    '  hasAudio: boolean; audioSrc: string; pipSrc: string | null;\n'
    '  broll: BrollClip[]; scenes: SceneTimed[];\n'
    '}): string {\n'
    '  const { title, brand, total, narrDur, hasAudio, audioSrc, pipSrc, broll, scenes } = opts;\n'
    '\n'
    '  // ---- b-roll placements: loop the available clips back-to-back across the body ----\n'
    '  const bodyStart = INTRO, bodyEnd = INTRO + narrDur;\n'
    '  const placements: { src: string; start: number; dur: number; i: number }[] = [];\n'
    '  if (broll.length) {\n'
    '    let t = bodyStart, k = 0;\n'
    '    while (t < bodyEnd - 0.05) {\n'
    '      const clip = broll[k % broll.length];\n'
    '      const dur = Math.min(clip.dur, bodyEnd - t);\n'
    '      placements.push({ src: clip.src, start: r2(t), dur: r2(dur), i: placements.length });\n'
    '      t += dur; k++;\n'
    '      if (placements.length > 200) break; // safety\n'
    '    }\n'
    '  }')
BROLL_INTERFACES_NEW = (
    'interface BrollClip { src: string; dur: number }\n'
    '// brollSrc/brollDur are only populated for the per-scene placement mode below —\n'
    '// the plain "loop across the body" mode ignores them entirely.\n'
    'interface SceneTimed { caption: string; start: number; dur: number; brollSrc?: string; brollDur?: number }\n'
    '\n'
    '// Safety ceiling for the per-scene tiling loop. Worst case is bounded by\n'
    '// narrDur (clamped to 900s max) divided by the shortest possible clip (1.5s,\n'
    '// the floor applied when probing durations below) plus one short remainder\n'
    '// tile per scene (60 max) — about 900/1.5 + 60 = 660. 1000 leaves headroom\n'
    '// over that measured worst case without being effectively unlimited.\n'
    'const PLACEMENT_CEILING = 1000;\n'
    '\n'
    'function buildHtml(opts: {\n'
    '  title: string; brand: string; total: number; narrDur: number;\n'
    '  hasAudio: boolean; audioSrc: string; pipSrc: string | null;\n'
    '  broll: BrollClip[]; scenes: SceneTimed[]; perSceneBroll: boolean;\n'
    '}): string {\n'
    '  const { title, brand, total, narrDur, hasAudio, audioSrc, pipSrc, broll, scenes, perSceneBroll } = opts;\n'
    '\n'
    '  const bodyStart = INTRO, bodyEnd = INTRO + narrDur;\n'
    '  const placements: { src: string; start: number; dur: number; i: number }[] = [];\n'
    '  if (perSceneBroll) {\n'
    '    // ---- b-roll placements: scene i\'s own clip fills scene i\'s normalised window ----\n'
    '    // Tiled (looped) back-to-back within the scene when the clip is shorter than the\n'
    '    // slot, trimmed to the slot when longer. This is the whole point of accepting\n'
    '    // `seconds`: the picture now cuts on the same rhythm as the captions, not on its\n'
    '    // own independent schedule.\n'
    '    for (const s of scenes) {\n'
    '      if (!s.brollSrc) continue; // no clip and no earlier one to fall back to — aura shows through\n'
    '      const clipDur = s.brollDur || DEFAULT_BROLL;\n'
    '      const segEnd = s.start + s.dur;\n'
    '      let t = s.start;\n'
    '      while (t < segEnd - 0.05) {\n'
    '        const dur = Math.min(clipDur, segEnd - t);\n'
    '        placements.push({ src: s.brollSrc, start: r2(t), dur: r2(dur), i: placements.length });\n'
    '        t += dur;\n'
    '        if (placements.length > PLACEMENT_CEILING) break; // safety\n'
    '      }\n'
    '      if (placements.length > PLACEMENT_CEILING) break; // safety\n'
    '    }\n'
    '  } else if (broll.length) {\n'
    '    // ---- b-roll placements: loop the available clips back-to-back across the body ----\n'
    '    let t = bodyStart, k = 0;\n'
    '    while (t < bodyEnd - 0.05) {\n'
    '      const clip = broll[k % broll.length];\n'
    '      const dur = Math.min(clip.dur, bodyEnd - t);\n'
    '      placements.push({ src: clip.src, start: r2(t), dur: r2(dur), i: placements.length });\n'
    '      t += dur; k++;\n'
    '      if (placements.length > 200) break; // safety\n'
    '    }\n'
    '  }')

BROLL_DOWNLOAD_OLD = (
    '  // ---- pull b-roll clips down + probe durations ----\n'
    '  const broll: BrollClip[] = [];\n'
    '  for (let i = 0; i < scenesIn.length; i++) {\n'
    '    const url = scenesIn[i].brollUrl;\n'
    '    if (!url) continue;\n'
    '    const file = path.join(assets, `broll-${i}.mp4`);\n'
    '    if (await downloadTo(url, file, origin)) {\n'
    '      const d = (await probeDuration(file)) ?? DEFAULT_BROLL;\n'
    '      broll.push({ src: `assets/broll-${i}.mp4`, dur: r2(Math.max(1.5, Math.min(20, d))) });\n'
    '    }\n'
    '  }')
BROLL_DOWNLOAD_NEW = (
    '  // ---- pull b-roll clips down + probe durations ----\n'
    '  // brollByIndex mirrors scenesIn 1:1 (null where a scene has no clip or the\n'
    '  // download failed) so the per-scene placement mode below can find scene i\'s\n'
    '  // own clip; `broll` stays the flat compacted list the legacy loop-mode uses.\n'
    '  const broll: BrollClip[] = [];\n'
    '  const brollByIndex: (BrollClip | null)[] = new Array(scenesIn.length).fill(null);\n'
    '  for (let i = 0; i < scenesIn.length; i++) {\n'
    '    const url = scenesIn[i].brollUrl;\n'
    '    if (!url) continue;\n'
    '    const file = path.join(assets, `broll-${i}.mp4`);\n'
    '    if (await downloadTo(url, file, origin)) {\n'
    '      const d = (await probeDuration(file)) ?? DEFAULT_BROLL;\n'
    '      const clip = { src: `assets/broll-${i}.mp4`, dur: r2(Math.max(1.5, Math.min(20, d))) };\n'
    '      broll.push(clip);\n'
    '      brollByIndex[i] = clip;\n'
    '    }\n'
    '  }')

BROLL_SCENES_OLD = (
    '  const wsum = weights.reduce((a, b) => a + b, 0) || scenesIn.length;\n'
    '  let acc = INTRO;\n'
    '  const scenesTimed: SceneTimed[] = scenesIn.map((s, i) => {\n'
    '    const dur = (weights[i] / wsum) * narrDur!;\n'
    '    const seg = { caption: s.caption ?? "", start: r2(acc), dur: r2(dur) };\n'
    '    acc += dur;\n'
    '    return seg;\n'
    '  });\n'
    '\n'
    '  const total = r2(INTRO + narrDur + OUTRO);\n'
    '  const html = buildHtml({ title, brand, total, narrDur, hasAudio, audioSrc, pipSrc, broll, scenes: scenesTimed });')
BROLL_SCENES_NEW = (
    '  const wsum = weights.reduce((a, b) => a + b, 0) || scenesIn.length;\n'
    '  let acc = INTRO;\n'
    '  const scenesTimed: SceneTimed[] = scenesIn.map((s, i) => {\n'
    '    const dur = (weights[i] / wsum) * narrDur!;\n'
    '    const seg = { caption: s.caption ?? "", start: r2(acc), dur: r2(dur) };\n'
    '    acc += dur;\n'
    '    return seg;\n'
    '  });\n'
    '\n'
    '  // Per-scene b-roll only kicks in when the caller committed to a full rhythm\n'
    '  // (every scene has `seconds`, so scenesTimed\'s windows are the copied cuts, not a\n'
    '  // word-count guess) and there is at least one clip to place. A scene missing its\n'
    '  // own clip falls back to the nearest earlier one rather than leaving a hole.\n'
    '  const allHaveSeconds = scenesIn.length > 0 && scenesIn.every(\n'
    '    (s) => typeof s.seconds === "number" && Number.isFinite(s.seconds) && s.seconds > 0\n'
    '  );\n'
    '  const perSceneBroll = allHaveSeconds && broll.length > 0;\n'
    '  if (perSceneBroll) {\n'
    '    let lastClip: BrollClip | null = null;\n'
    '    for (let i = 0; i < scenesTimed.length; i++) {\n'
    '      const own = brollByIndex[i];\n'
    '      if (own) lastClip = own;\n'
    '      const clip = own ?? lastClip;\n'
    '      if (clip) { scenesTimed[i].brollSrc = clip.src; scenesTimed[i].brollDur = clip.dur; }\n'
    '    }\n'
    '  }\n'
    '\n'
    '  const total = r2(INTRO + narrDur + OUTRO);\n'
    '  const html = buildHtml({ title, brand, total, narrDur, hasAudio, audioSrc, pipSrc, broll, scenes: scenesTimed, perSceneBroll });')


def patch_assemble_route_broll():
    """Make b-roll follow the same copied rhythm as the captions.

    The S4 seconds patch (patch_assemble_route above) drives caption timing from
    `seconds` when every scene has one, but left the b-roll loop untouched — it
    still tiled clips back to back across the whole body, independent of scene
    boundaries. That means the picture kept cutting on its own schedule while the
    captions followed the copied one, and the cut point is the one thing this
    feature exists to transfer. This patch makes scene i's own clip fill exactly
    scene i's normalised window (tiled if short, trimmed if long, falling back to
    the nearest earlier clip when a scene has none) whenever every scene carries
    `seconds` and at least one carries `brollUrl`. Independent sentinel from the
    seconds patch, so it applies whether or not that one already ran.
    """
    route = f"{src}/src/app/api/video/auto/assemble/route.ts"
    try:
        s = read(route)
    except OSError:
        return None
    if "PLACEMENT_CEILING" in s:
        return "already patched"

    if BROLL_HEADER_OLD not in s or BROLL_INTERFACES_OLD not in s \
            or BROLL_DOWNLOAD_OLD not in s or BROLL_SCENES_OLD not in s:
        return None

    s = s.replace(BROLL_HEADER_OLD, BROLL_HEADER_NEW, 1)
    s = s.replace(BROLL_INTERFACES_OLD, BROLL_INTERFACES_NEW, 1)
    s = s.replace(BROLL_DOWNLOAD_OLD, BROLL_DOWNLOAD_NEW, 1)
    s = s.replace(BROLL_SCENES_OLD, BROLL_SCENES_NEW, 1)
    write(route, s)
    return "per-scene b-roll placement applied"


# ── framing, and a frame that is not the footage's shape ──────────────────────
#
# The root crop error: the composition used to fill a fixed 1920×1080 frame with
# `object-fit: cover` no matter what the caller sent, so a source excerpt — a slide, a
# screen recording — lost whatever ran past the edges. The reference construction this
# module reproduces is portrait, with the excerpt shown WHOLE in an upper panel.
#
# So: optional per-scene `framing { fit: "contain"|"cover", position? }`, with
# `excerpt: true` as the shorthand that keeps a source excerpt whole, and an optional
# project-level `output { width, height }` that decides the frame independently of the
# footage. Absent both, the output is what it always was, byte for byte.
FRAMING_SENTINEL = "framingStyle"

FRAMING_CONST_OLD = 'const DEFAULT_BROLL = 6;\n'
FRAMING_CONST_NEW = '''const DEFAULT_BROLL = 6;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

// How a piece of footage sits inside the composition. Absent means the legacy
// behaviour — the stage's own cover crop — which is right for b-roll generated for
// this edit and wrong for anything that carries information to its edges: a slide
// excerpt, a screen recording, a chart. `excerpt: true` is the shorthand for that
// case: keep the whole image (`contain`) on the composition's background instead of
// cropping the content away. The output size is a separate decision and is NOT taken
// from the footage — the reference decides the frame, not whatever fills it.
interface SceneFraming { fit?: "contain" | "cover"; position?: string }
'''

FRAMING_SCENEIN_OLD = 'interface SceneIn { caption?: string; narration_line?: string; brollUrl?: string; seconds?: number; graphic?: SceneGraphic }'
FRAMING_SCENEIN_NEW = ('// framing/excerpt are optional and per scene: the same edit can mix generated footage\n'
                       '// (cover, full-bleed) with a preserved excerpt (contain) in the next beat.\n'
                       'interface SceneIn { caption?: string; narration_line?: string; brollUrl?: string; seconds?: number; graphic?: SceneGraphic; framing?: SceneFraming; excerpt?: boolean }')

FRAMING_CLIP_OLD = 'interface BrollClip { src: string; dur: number }'
FRAMING_CLIP_NEW = ('// framing travels with the clip, not with the slot: the same source excerpt reused\n'
                    '// across three beats has to be framed the same way in all three.\n'
                    'interface BrollClip { src: string; dur: number; framing?: SceneFraming }')

FRAMING_TIMED_OLD = 'interface SceneTimed { caption: string; start: number; dur: number; brollSrc?: string; brollDur?: number; graphic?: SceneGraphic }'
FRAMING_TIMED_NEW = ('''interface SceneTimed { caption: string; start: number; dur: number; brollSrc?: string; brollDur?: number; brollFraming?: SceneFraming; graphic?: SceneGraphic }

// The `style` a piece of footage needs to be framed the way the caller asked, or ""
// for the legacy full-bleed cover — an empty string keeps the old output byte for byte,
// which is the whole reason this is a string and not a defaulted object.
function framingStyle(f: SceneFraming | undefined): string {
  if (!f) return "";
  const fit = f.fit === "contain" ? "contain" : "cover";
  return ` style="object-fit:${fit};object-position:${f.position ?? "50% 50%"}"`;
}

// An explicit `framing` wins; `excerpt: true` is the shorthand that keeps a source
// excerpt whole (contain) on the composition's background rather than cropping it.
function framingFor(s: SceneIn): SceneFraming | undefined {
  if (s.framing) return { fit: s.framing.fit, position: s.framing.position };
  if (s.excerpt) return { fit: "contain" };
  return undefined;
}''')

FRAMING_DIM_OLD = 'function r2(n: number): number { return Math.round(n * 100) / 100; }\n'
FRAMING_DIM_NEW = '''function r2(n: number): number { return Math.round(n * 100) / 100; }
// Output size is the caller's decision (the reference's aspect, a 9:16 short, a 16:9
// video) and is deliberately independent of the footage that fills it. Bounded and
// even-numbered so a typo cannot ask for a 4-pixel or a 100000-pixel stage; absent
// means the legacy 1920×1080, which keeps the old output byte for byte.
function dim(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n / 2) * 2));
}
'''

FRAMING_POSITION_OLD = 'const COMPARE_ITEM_CAP = 8;\n'
FRAMING_POSITION_NEW = '''const COMPARE_ITEM_CAP = 8;

// object-position is written straight into a style attribute, so it is matched against
// this rather than trusted: keywords, percentages and px offsets only — nothing that
// could close the attribute or add a declaration.
const SAFE_POSITION = /^(left|right|top|bottom|center|\\d{1,3}%|[\\d.]+px)(\\s+(left|right|top|bottom|center|\\d{1,3}%|[\\d.]+px))?$/;
'''

FRAMING_HTML_OLD = (
    '  broll: BrollClip[]; scenes: SceneTimed[]; perSceneBroll: boolean;\n'
    '}): string {\n'
    '  const { title, brand, total, narrDur, hasAudio, audioSrc, pipSrc, broll, scenes, perSceneBroll } = opts;')
FRAMING_HTML_NEW = (
    '  broll: BrollClip[]; scenes: SceneTimed[]; perSceneBroll: boolean;\n'
    '  width: number; height: number;\n'
    '}): string {\n'
    '  const { title, brand, total, narrDur, hasAudio, audioSrc, pipSrc, broll, scenes, perSceneBroll, width: W, height: H } = opts;')

FRAMING_PLACEMENTS_OLD = '  const placements: { src: string; start: number; dur: number; i: number }[] = [];'
FRAMING_PLACEMENTS_NEW = '  const placements: { src: string; start: number; dur: number; i: number; framing?: SceneFraming }[] = [];'

FRAMING_PUSH_SCENE_OLD = '        placements.push({ src: s.brollSrc, start: r2(t), dur: r2(dur), i: placements.length });'
FRAMING_PUSH_SCENE_NEW = '        placements.push({ src: s.brollSrc, start: r2(t), dur: r2(dur), i: placements.length, framing: s.brollFraming });'

FRAMING_PUSH_LOOP_OLD = '      placements.push({ src: clip.src, start: r2(t), dur: r2(dur), i: placements.length });'
FRAMING_PUSH_LOOP_NEW = '      placements.push({ src: clip.src, start: r2(t), dur: r2(dur), i: placements.length, framing: clip.framing });'

FRAMING_VIDEO_OLD = (
    '  const brollEls = placements.map((p) =>\n'
    '    `  <video class="bg" src="${p.src}" muted playsinline data-start="${p.start}" data-duration="${p.dur}" data-track-index="1"></video>`\n'
    '  ).join("\\n");')
FRAMING_VIDEO_NEW = (
    '  const brollEls = placements.map((p) =>\n'
    '    `  <video class="bg" src="${p.src}" muted playsinline${framingStyle(p.framing)} data-start="${p.start}" data-duration="${p.dur}" data-track-index="1"></video>`\n'
    '  ).join("\\n");')

FRAMING_CSS_OLD = (
    '  #stage { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #07020f; }\n'
    '  .bg { position: absolute; inset: 0; width: 1920px; height: 1080px; object-fit: cover; z-index: 1; }')
FRAMING_CSS_NEW = (
    '  #stage { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #07020f; }\n'
    '  .bg { position: absolute; inset: 0; width: ${W}px; height: ${H}px; object-fit: cover; z-index: 1; }')

FRAMING_STAGE_OLD = '<div id="stage" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="${r2(total)}" data-fps="30">'
FRAMING_STAGE_NEW = '<div id="stage" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${r2(total)}" data-fps="30">'

FRAMING_DOWNLOAD_OLD = '      const clip = { src: `assets/broll-${i}.mp4`, dur: r2(Math.max(1.5, Math.min(20, d))) };'
FRAMING_DOWNLOAD_NEW = '      const clip = { src: `assets/broll-${i}.mp4`, dur: r2(Math.max(1.5, Math.min(20, d))), framing: framingFor(scenesIn[i]) };'

FRAMING_ASSIGN_OLD = '      if (clip) { scenesTimed[i].brollSrc = clip.src; scenesTimed[i].brollDur = clip.dur; }'
FRAMING_ASSIGN_NEW = '      if (clip) { scenesTimed[i].brollSrc = clip.src; scenesTimed[i].brollDur = clip.dur; scenesTimed[i].brollFraming = clip.framing; }'

FRAMING_VALIDATE_OLD = '    const scene: SceneIn = {\n      caption: s.caption ?? undefined,\n      narration_line: s.narration_line ?? undefined,\n      brollUrl: s.brollUrl ?? undefined,\n      seconds: typeof s.seconds === "number" ? s.seconds : undefined,\n    };'
FRAMING_VALIDATE_NEW = '''    if (s.excerpt !== undefined && s.excerpt !== null && typeof s.excerpt !== "boolean") {
      return { error: `scenes[${i}].excerpt must be true or false` };
    }
    let framing: SceneFraming | undefined;
    if (s.framing !== undefined && s.framing !== null) {
      if (!isObj(s.framing)) return { error: `scenes[${i}].framing must be an object with { fit, position? }` };
      if (!optStr(s.framing.fit)) return { error: `scenes[${i}].framing.fit must be a string` };
      if (s.framing.fit !== undefined && s.framing.fit !== null && s.framing.fit !== "contain" && s.framing.fit !== "cover") {
        return { error: `scenes[${i}].framing.fit must be "contain" or "cover"` };
      }
      if (!optStr(s.framing.position)) return { error: `scenes[${i}].framing.position must be a string` };
      if (typeof s.framing.position === "string" && !SAFE_POSITION.test(s.framing.position)) {
        return { error: `scenes[${i}].framing.position must be one or two of left/right/top/bottom/center, a percentage or a px offset` };
      }
      framing = { fit: (s.framing.fit as "contain" | "cover" | undefined) ?? undefined, position: s.framing.position ?? undefined };
    }
    const scene: SceneIn = {
      caption: s.caption ?? undefined,
      narration_line: s.narration_line ?? undefined,
      brollUrl: s.brollUrl ?? undefined,
      seconds: typeof s.seconds === "number" ? s.seconds : undefined,
      excerpt: typeof s.excerpt === "boolean" ? s.excerpt : undefined,
      framing,
    };'''

FRAMING_POST_OLD = (
    '  const avatarUrl = String(body.avatarUrl ?? "").trim();\n')
FRAMING_POST_NEW = (
    '  const avatarUrl = String(body.avatarUrl ?? "").trim();\n'
    '  // The frame is the caller\'s decision and is independent of the footage: a portrait\n'
    '  // reference stays portrait even when the clip inside it is landscape, and a landscape\n'
    '  // render does not force a portrait excerpt to be cropped to fill it.\n'
    '  const out = isObj(body.output) ? body.output : {};\n'
    '  const outW = dim(out.width, DEFAULT_WIDTH, 320, 3840);\n'
    '  const outH = dim(out.height, DEFAULT_HEIGHT, 240, 2160);\n')

FRAMING_CALL_OLD = '  const html = buildHtml({ title, brand, total, narrDur, hasAudio, audioSrc, pipSrc, broll, scenes: scenesTimed, perSceneBroll });'
FRAMING_CALL_NEW = '  const html = buildHtml({ title, brand, total, narrDur, hasAudio, audioSrc, pipSrc, broll, scenes: scenesTimed, perSceneBroll, width: outW, height: outH });'


def patch_assemble_route_framing():
    """Let a scene keep its whole image, and let the frame be the caller's shape.

    One feature, one sentinel (`framingStyle`), anchored on the post-validation text.
    Must run after patch_assemble_route_graphics() and patch_assemble_route_validate():
    its anchors are the file those two leave behind.
    """
    route = f"{src}/src/app/api/video/auto/assemble/route.ts"
    try:
        s = read(route)
    except OSError:
        return None
    if FRAMING_SENTINEL in s:
        return "already patched"

    anchors = (
        FRAMING_CONST_OLD, FRAMING_SCENEIN_OLD, FRAMING_CLIP_OLD, FRAMING_TIMED_OLD,
        FRAMING_DIM_OLD, FRAMING_POSITION_OLD, FRAMING_HTML_OLD, FRAMING_PLACEMENTS_OLD,
        FRAMING_PUSH_SCENE_OLD, FRAMING_PUSH_LOOP_OLD, FRAMING_VIDEO_OLD, FRAMING_CSS_OLD,
        FRAMING_STAGE_OLD, FRAMING_DOWNLOAD_OLD, FRAMING_ASSIGN_OLD, FRAMING_VALIDATE_OLD,
        FRAMING_POST_OLD, FRAMING_CALL_OLD,
    )
    for anchor in anchors:
        if s.count(anchor) != 1:
            return None

    for old, new in (
        (FRAMING_CONST_OLD, FRAMING_CONST_NEW),
        (FRAMING_SCENEIN_OLD, FRAMING_SCENEIN_NEW),
        (FRAMING_CLIP_OLD, FRAMING_CLIP_NEW),
        (FRAMING_TIMED_OLD, FRAMING_TIMED_NEW),
        (FRAMING_DIM_OLD, FRAMING_DIM_NEW),
        (FRAMING_POSITION_OLD, FRAMING_POSITION_NEW),
        (FRAMING_HTML_OLD, FRAMING_HTML_NEW),
        (FRAMING_PLACEMENTS_OLD, FRAMING_PLACEMENTS_NEW),
        (FRAMING_PUSH_SCENE_OLD, FRAMING_PUSH_SCENE_NEW),
        (FRAMING_PUSH_LOOP_OLD, FRAMING_PUSH_LOOP_NEW),
        (FRAMING_VIDEO_OLD, FRAMING_VIDEO_NEW),
        (FRAMING_CSS_OLD, FRAMING_CSS_NEW),
        (FRAMING_STAGE_OLD, FRAMING_STAGE_NEW),
        (FRAMING_DOWNLOAD_OLD, FRAMING_DOWNLOAD_NEW),
        (FRAMING_ASSIGN_OLD, FRAMING_ASSIGN_NEW),
        (FRAMING_VALIDATE_OLD, FRAMING_VALIDATE_NEW),
        (FRAMING_POST_OLD, FRAMING_POST_NEW),
        (FRAMING_CALL_OLD, FRAMING_CALL_NEW),
    ):
        s = s.replace(old, new, 1)
    write(route, s)
    return "per-scene framing (contain/cover) + independent output size applied"


# ── graphic cards in the assembler ────────────────────────────────────────────
#
# A scene can carry `graphic` instead of footage, and the assembler draws a
# full-bleed HTML card in that scene's slot: ranking / stat / compare / quote.
# HTML rather than an ffmpeg drawtext overlay because this machine's ffmpeg has no
# libfreetype (`ffmpeg -filters | grep drawtext` returns nothing), while every video
# in this pipeline already goes through HyperFrames' HTML-to-MP4 render — so a card
# is another div in the same composition, not a separate rendered asset.
#
# This was in the route by hand before any installer carried it, which meant an Agent
# OS update that overwrote the route would silently drop the feature (and, worse,
# leave the validation patch below with nothing to type against). The sentinel is the
# marker that is already in the hand-applied code — `renderGraphicInner` — so an
# install that has it reports "already patched" instead of trying to add it twice.
GRAPH_SENTINEL = "renderGraphicInner"

GRAPH_INTERFACE_OLD = (
    '// seconds is optional — when a caller (e.g. the S4 "copy the rhythm" pipeline)\n'
    '// already knows how long each cut should run, it overrides the word-count guess.\n'
    'interface SceneIn { caption?: string; narration_line?: string; brollUrl?: string; seconds?: number }')
GRAPH_INTERFACE_NEW = (
    '// seconds is optional — when a caller (e.g. the S4 "copy the rhythm" pipeline)\n'
    '// already knows how long each cut should run, it overrides the word-count guess.\n'
    '// graphic is optional too — a full-bleed HTML card rendered in the scene\'s slot\n'
    '// instead of footage (see SceneGraphic below for why HTML instead of ffmpeg text).\n'
    'interface SceneIn { caption?: string; narration_line?: string; brollUrl?: string; seconds?: number; graphic?: SceneGraphic }')

GRAPH_TYPES_OLD = (
    'function r2(n: number): number { return Math.round(n * 100) / 100; }\n'
    '\n'
    'interface BrollClip { src: string; dur: number }\n'
    '// brollSrc/brollDur are only populated for the per-scene placement mode below —\n'
    '// the plain "loop across the body" mode ignores them entirely.\n'
    'interface SceneTimed { caption: string; start: number; dur: number; brollSrc?: string; brollDur?: number }')
GRAPH_TYPES_NEW = (
    'function r2(n: number): number { return Math.round(n * 100) / 100; }\n'
    '\n'
    + r'''// Full-bleed HTML graphic cards — the HyperFrames-native alternative to an
// ffmpeg drawtext overlay. This machine's ffmpeg has no libfreetype
// (`ffmpeg -filters | grep drawtext` returns nothing; the fix is
// `brew install ffmpeg-full`, not something to ask a non-technical Skool
// audience to do), but every video in this pipeline already goes through
// HyperFrames' HTML-to-MP4 render, so a graphic card is just another
// full-bleed div in the same composition, not a separate rendered asset.
type SceneGraphic =
  | { kind: "ranking"; title?: string; items: { label: string; value?: string }[] }
  | { kind: "stat"; title?: string; value: string; caption?: string }
  | { kind: "compare"; title?: string; left: { label: string; items: string[] }; right: { label: string; items: string[] } }
  | { kind: "quote"; text: string; attribution?: string };

// A ranking of 8 items (the spec's stated worst case) fits the 1920×1080 canvas
// at a legible size with the row sizing in .gfx-rank below (8 × ~90px of rows +
// title + padding ≈ 1006px, under 1080). More would need either a smaller,
// harder-to-read font or scrolling — which a single composited frame can't do —
// so extra items are capped here rather than shrunk without a floor.
const RANKING_ROW_CAP = 8;

// Builds the inner markup for one graphic card. Every piece of caller-supplied
// text goes through esc() — this text comes from a model, so an unescaped `<`
// is both a rendering bug and an injection into the composition HTML.
function renderGraphicInner(g: SceneGraphic, i: number): { className: string; bodyHtml: string; rowIds: string[] } {
  switch (g.kind) {
    case "ranking": {
      const items = Array.isArray(g.items) ? g.items.slice(0, RANKING_ROW_CAP) : [];
      const rowIds = items.map((_, j) => `gfx-${i}-row-${j}`);
      const rows = items.map((it, j) =>
        `      <div class="row" id="${rowIds[j]}"><span class="n">${j + 1}</span>` +
        `<span class="label">${esc(it.label ?? "")}</span>` +
        (it.value ? `<span class="value">${esc(it.value)}</span>` : "") +
        `</div>`
      ).join("\n");
      const bodyHtml =
        (g.title ? `    <div class="gfx-title">${esc(g.title)}</div>\n` : "") +
        `    <div class="gfx-rank">\n${rows}\n    </div>`;
      return { className: "gfx-rank-wrap", bodyHtml, rowIds };
    }
    case "stat": {
      const bodyHtml =
        (g.title ? `    <div class="gfx-title">${esc(g.title)}</div>\n` : "") +
        `    <div class="value">${esc(g.value ?? "")}</div>` +
        (g.caption ? `\n    <div class="caption">${esc(g.caption)}</div>` : "");
      return { className: "gfx-stat", bodyHtml, rowIds: [] };
    }
    case "compare": {
      const col = (side: { label: string; items: string[] } | undefined) => {
        const s2 = side ?? { label: "", items: [] };
        const lis = Array.isArray(s2.items) ? s2.items.map((it) => `<li>${esc(it)}</li>`).join("") : "";
        return `      <div class="col"><div class="col-label">${esc(s2.label ?? "")}</div><ul>${lis}</ul></div>`;
      };
      const bodyHtml =
        (g.title ? `    <div class="gfx-title">${esc(g.title)}</div>\n` : "") +
        `    <div class="gfx-cmp">\n${col(g.left)}\n${col(g.right)}\n    </div>`;
      return { className: "gfx-cmp-wrap", bodyHtml, rowIds: [] };
    }
    case "quote": {
      const bodyHtml =
        `    <div class="text">${esc(g.text ?? "")}</div>` +
        (g.attribution ? `\n    <div class="attribution">— ${esc(g.attribution)}</div>` : "");
      return { className: "gfx-quote", bodyHtml, rowIds: [] };
    }
    default:
      return { className: "", bodyHtml: "", rowIds: [] };
  }
}

'''
    'interface BrollClip { src: string; dur: number }\n'
    '// brollSrc/brollDur are only populated for the per-scene placement mode below —\n'
    '// the plain "loop across the body" mode ignores them entirely. graphic, when\n'
    '// set, takes over the scene\'s visual slot instead of footage (see buildHtml).\n'
    'interface SceneTimed { caption: string; start: number; dur: number; brollSrc?: string; brollDur?: number; graphic?: SceneGraphic }')

GRAPH_PLACEMENT_OLD = '      if (!s.brollSrc) continue; // no clip and no earlier one to fall back to — aura shows through'
GRAPH_PLACEMENT_NEW = ('      if (s.graphic) continue; // a scene with both prefers the graphic over footage\n'
                       + GRAPH_PLACEMENT_OLD)

GRAPH_ELEMENTS_OLD = (
    '  const brollEls = placements.map((p) =>\n'
    '    `  <video class="bg" src="${p.src}" muted playsinline data-start="${p.start}" data-duration="${p.dur}" data-track-index="1"></video>`\n'
    '  ).join("\\n");\n'
    '\n'
    '  const captionEls = scenes.map((s, i) =>')
GRAPH_ELEMENTS_NEW = (
    '  const brollEls = placements.map((p) =>\n'
    '    `  <video class="bg" src="${p.src}" muted playsinline data-start="${p.start}" data-duration="${p.dur}" data-track-index="1"></video>`\n'
    '  ).join("\\n");\n'
    '\n'
    + r'''  // ---- graphic cards: same data-start/data-duration discipline as the b-roll
  // placements above, on the same visual track, so a graphic scene occupies
  // exactly the slot footage would have used. ----
  const graphicScenes = scenes
    .map((s, i) => ({ s, i, r: s.graphic ? renderGraphicInner(s.graphic, i) : null }))
    .filter((x): x is { s: SceneTimed; i: number; r: { className: string; bodyHtml: string; rowIds: string[] } } => x.r !== null);

  const graphicEls = graphicScenes.map(({ s, i, r }) =>
    `  <div class="gfx ${r.className}" id="gfx-${i}" data-start="${r2(s.start)}" data-duration="${r2(s.dur)}" data-track-index="1">\n${r.bodyHtml}\n  </div>`
  ).join("\n");

  // ---- graphic GSAP: card fades/scales in like the intro/outro cards; a
  // ranking additionally reveals its rows one at a time — the whole point of
  // that card is a list that builds, not one that just appears. ----
  const graphicTweens = graphicScenes.map(({ s, i, r }) => {
    const at = r2(s.start + 0.08);
    const out = r2(s.start + s.dur - 0.35);
    let lines = `  tl.fromTo("#gfx-${i}", { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.6)" }, ${at});\n` +
                `  tl.to("#gfx-${i}", { opacity: 0, duration: 0.3, ease: "power1.in" }, ${out});`;
    if (r.rowIds.length) {
      const rowStart = r2(at + 0.15);
      lines += "\n" + r.rowIds.map((rid, j) =>
        `  tl.fromTo("#${rid}", { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4, ease: "power2.out" }, ${r2(rowStart + j * 0.12)});`
      ).join("\n");
    }
    return lines;
  }).join("\n");

  // Only emitted when at least one scene actually has a graphic — keeps the
  // no-graphic output byte-identical to before this feature existed.
  const graphicCss = graphicScenes.length ? `
  /* graphic cards — same palette/vocabulary as .card (intro/outro) so a scene's
     graphic reads as part of the same composition, not a pasted-in overlay. */
  .gfx { position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center; padding: 100px 140px;
    background: radial-gradient(70% 60% at 50% 30%, rgba(168,85,247,.22), transparent 60%), linear-gradient(160deg, #0a0118, #07020f); }
  .gfx-title { font-weight: 900; font-size: 46px; letter-spacing: .12em; text-transform: uppercase; color: #00f0ff;
    margin-bottom: 40px; text-align: center; text-shadow: 0 0 30px rgba(0,240,255,.4); }
  .gfx-rank { width: 100%; max-width: 1500px; display: flex; flex-direction: column; gap: 14px; }
  .gfx-rank .row { display: flex; align-items: center; gap: 28px; background: rgba(255,255,255,.05);
    border: 1px solid rgba(212,165,116,.25); border-radius: 14px; padding: 18px 32px; }
  .gfx-rank .row .n { font-weight: 900; font-size: 40px; color: #d4a574; width: 64px; text-align: center; flex-shrink: 0; }
  .gfx-rank .row .label { flex: 1; font-weight: 700; font-size: 34px; color: #fff; overflow-wrap: break-word; }
  .gfx-rank .row .value { font-weight: 900; font-size: 34px; color: #39ff14; flex-shrink: 0; }
  .gfx-stat .value { font-weight: 900; font-size: 220px; line-height: 0.9; color: #fff;
    text-shadow: 0 0 60px rgba(0,240,255,.5); text-align: center; }
  .gfx-stat .caption { margin-top: 28px; font-size: 36px; font-weight: 700; color: #d4a574; text-align: center; max-width: 1400px; }
  .gfx-cmp { display: flex; gap: 60px; width: 100%; max-width: 1600px; }
  .gfx-cmp .col { flex: 1; background: rgba(255,255,255,.04); border: 1px solid rgba(0,240,255,.25);
    border-radius: 20px; padding: 40px; }
  .gfx-cmp .col-label { font-weight: 900; font-size: 38px; text-transform: uppercase; color: #00f0ff;
    margin-bottom: 24px; text-align: center; }
  .gfx-cmp ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 16px; }
  .gfx-cmp li { font-size: 30px; font-weight: 700; color: #fff; padding-left: 36px; position: relative; }
  .gfx-cmp li::before { content: "—"; position: absolute; left: 0; color: #d4a574; }
  .gfx-quote .text { font-weight: 900; font-size: 64px; line-height: 1.15; color: #fff; text-align: center;
    max-width: 1500px; text-shadow: 0 4px 28px rgba(0,0,0,.85); }
  .gfx-quote .attribution { margin-top: 34px; font-size: 32px; font-weight: 700; color: #d4a574; text-align: center; }` : "";

'''
    '  const captionEls = scenes.map((s, i) =>')

GRAPH_CSS_OLD = 'text-transform:uppercase; letter-spacing:.02em; }'
GRAPH_CSS_NEW = GRAPH_CSS_OLD + '${graphicCss}'

GRAPH_BROLL_ELS_OLD = '${brollEls}'
GRAPH_BROLL_ELS_NEW = '${brollEls}${graphicEls ? "\\n" + graphicEls : ""}'

GRAPH_CAP_TWEENS_OLD = '${capTweens}'
GRAPH_CAP_TWEENS_NEW = '${capTweens}${graphicTweens ? "\\n  // graphics\\n" + graphicTweens : ""}'

GRAPH_SEG_OLD = '    const seg = { caption: s.caption ?? "", start: r2(acc), dur: r2(dur) };'
GRAPH_SEG_NEW = '    const seg: SceneTimed = { caption: s.caption ?? "", start: r2(acc), dur: r2(dur), graphic: s.graphic };'


def patch_assemble_route_graphics():
    """Draw a card instead of footage where the brief says the watched video held one.

    One coherent feature, so it is one function with one sentinel — the marker that is
    already in the hand-applied code (`renderGraphicInner`), which is what lets this
    report "already patched" on the install that has it and apply it everywhere else.
    Must run before patch_assemble_route_validate(), which types against the
    SceneGraphic type this inserts.
    """
    route = f"{src}/src/app/api/video/auto/assemble/route.ts"
    try:
        s = read(route)
    except OSError:
        return None
    if GRAPH_SENTINEL in s:
        return "already patched"

    anchors = (
        GRAPH_INTERFACE_OLD, GRAPH_TYPES_OLD, GRAPH_PLACEMENT_OLD, GRAPH_ELEMENTS_OLD,
        GRAPH_CSS_OLD, GRAPH_BROLL_ELS_OLD, GRAPH_CAP_TWEENS_OLD, GRAPH_SEG_OLD,
    )
    for anchor in anchors:
        if s.count(anchor) != 1:
            return None

    s = s.replace(GRAPH_INTERFACE_OLD, GRAPH_INTERFACE_NEW, 1)
    s = s.replace(GRAPH_TYPES_OLD, GRAPH_TYPES_NEW, 1)
    s = s.replace(GRAPH_PLACEMENT_OLD, GRAPH_PLACEMENT_NEW, 1)
    s = s.replace(GRAPH_ELEMENTS_OLD, GRAPH_ELEMENTS_NEW, 1)
    s = s.replace(GRAPH_CSS_OLD, GRAPH_CSS_NEW, 1)
    s = s.replace(GRAPH_BROLL_ELS_OLD, GRAPH_BROLL_ELS_NEW, 1)
    s = s.replace(GRAPH_CAP_TWEENS_OLD, GRAPH_CAP_TWEENS_NEW, 1)
    s = s.replace(GRAPH_SEG_OLD, GRAPH_SEG_NEW, 1)
    write(route, s)
    return "graphic cards (ranking/stat/compare/quote) applied"


# ── validation up front, and the audio requirement ────────────────────────────
#
# Three shapes used to reach the renderer and throw a 500 from halfway through the
# request — after the project directory existed and the downloads had run: a null in
# `scenes` (read as `scenesIn[i].brollUrl`), a numeric `narration_line` (read as
# `.trim()`), and a ranking whose `items` held a null (read as `it.label`). The body
# is now checked once, before anything touches the disk or the network, and a bad
# field comes back as a 400 naming it.
#
# The second half is not hardening, it is the goal: a caller that sent narration and
# got a failed download back was answered 200 with hasAudio:false — a silent film
# reported as a success, which only shows up when somebody watches it. That is now a
# 502, and the downloaded file is probed for an audio stream first, because
# downloadTo() only proves bytes arrived (an HTML error page passes it) and
# probeDuration() reports the container's duration either way.
#
# Same contract as the two patches above: not our file, anchored replacements, its own
# sentinel, safe to re-run after an Agent OS update overwrites the route.
ASSEMBLE_VALIDATE_SENTINEL = "omni-assemble-validate"

ASSEMBLE_IMPORT_OLD = 'import { writeFile, mkdir } from "node:fs/promises";\n'
ASSEMBLE_IMPORT_NEW = ('import { writeFile, mkdir } from "node:fs/promises";\n'
                       'import { spawn } from "node:child_process";\n')

ASSEMBLE_HELPERS_OLD = 'interface BrollClip { src: string; dur: number }\n'
# The validation block names SceneGraphic and RANKING_ROW_CAP, so it only makes sense
# on a route that already carries the graphic-card support. That support is not
# reproducible from any installer today — it lives in the route by hand — so on a
# route that lacks it this patch stays out of the way (skipped, not half-applied)
# rather than producing a file that does not compile.
ASSEMBLE_GRAPHICS_ANCHOR = 'const RANKING_ROW_CAP = 8;'
ASSEMBLE_HELPERS_NEW = '''// omni-assemble-validate
// A compare column holds 8 bullets at 30px inside the 1080px frame before the text
// runs under the edge; like RANKING_ROW_CAP above this is a layout limit, not taste.
// A caller that sends more gets a 400 naming the cap instead of a card that quietly
// drops rows.
const COMPARE_ITEM_CAP = 8;

// The body is caller-supplied JSON and nothing between here and the renderer used to
// look at it: `Array.isArray(body.scenes) ? … : []` kept whatever arrived, so a null
// scene reached `scenesIn[i].brollUrl`, a numeric narration_line reached `.trim()`,
// and a ranking whose items held a null reached `it.label`. All three came back as a
// 500 from halfway through the request — after the project directory existed and the
// downloads had run. Checked once, up front, so the caller gets the field name.
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
// null reads as "absent" rather than as a type error: the renderer already treats it
// that way (`s.caption ?? ""`), and JSON written by a model spells an empty field as
// null more often than it leaves the key out.
function optStr(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === "string";
}

function validateCompareSide(raw: unknown, at: string): { side: { label: string; items: string[] } } | { error: string } {
  // The renderer already tolerates a missing side (`side ?? { label: "", items: [] }`),
  // so an absent one stays legal and keeps the old output.
  if (raw === undefined || raw === null) return { side: { label: "", items: [] } };
  if (!isObj(raw)) return { error: `${at} must be an object with { label, items }` };
  if (!optStr(raw.label)) return { error: `${at}.label must be a string` };
  if (raw.items !== undefined && raw.items !== null && !Array.isArray(raw.items)) {
    return { error: `${at}.items must be an array of strings` };
  }
  const items = Array.isArray(raw.items) ? raw.items : [];
  if (items.length > COMPARE_ITEM_CAP) {
    return { error: `${at}.items holds ${items.length} lines — a compare column fits ${COMPARE_ITEM_CAP}` };
  }
  const lines: string[] = [];
  for (let j = 0; j < items.length; j++) {
    const it: unknown = items[j];
    if (typeof it !== "string") return { error: `${at}.items[${j}] must be a string` };
    lines.push(it);
  }
  return { side: { label: raw.label ?? "", items: lines } };
}

function validateGraphic(raw: unknown, i: number): { graphic: SceneGraphic } | { error: string } {
  const at = `scenes[${i}].graphic`;
  if (!isObj(raw)) return { error: `${at} must be an object` };
  if (!optStr(raw.title)) return { error: `${at}.title must be a string` };
  const title = raw.title ?? undefined;
  switch (raw.kind) {
    case "ranking": {
      if (!Array.isArray(raw.items)) return { error: `${at}.items must be an array of { label, value? }` };
      if (raw.items.length > RANKING_ROW_CAP) {
        return { error: `${at}.items holds ${raw.items.length} rows — a ranking card fits ${RANKING_ROW_CAP}` };
      }
      const items: { label: string; value?: string }[] = [];
      for (let j = 0; j < raw.items.length; j++) {
        const it: unknown = raw.items[j];
        if (!isObj(it)) return { error: `${at}.items[${j}] must be an object` };
        if (typeof it.label !== "string") return { error: `${at}.items[${j}].label must be a string` };
        if (!optStr(it.value)) return { error: `${at}.items[${j}].value must be a string` };
        items.push(it.value ? { label: it.label, value: it.value } : { label: it.label });
      }
      return { graphic: { kind: "ranking", title, items } };
    }
    case "stat": {
      if (typeof raw.value !== "string" || !raw.value.trim()) return { error: `${at}.value must be a non-empty string` };
      if (!optStr(raw.caption)) return { error: `${at}.caption must be a string` };
      return { graphic: { kind: "stat", title, value: raw.value, caption: raw.caption ?? undefined } };
    }
    case "compare": {
      const left = validateCompareSide(raw.left, `${at}.left`);
      if ("error" in left) return left;
      const right = validateCompareSide(raw.right, `${at}.right`);
      if ("error" in right) return right;
      return { graphic: { kind: "compare", title, left: left.side, right: right.side } };
    }
    case "quote": {
      if (typeof raw.text !== "string" || !raw.text.trim()) return { error: `${at}.text must be a non-empty string` };
      if (!optStr(raw.attribution)) return { error: `${at}.attribution must be a string` };
      return { graphic: { kind: "quote", text: raw.text, attribution: raw.attribution ?? undefined } };
    }
    default:
      return { error: `${at}.kind must be "ranking", "stat", "compare" or "quote"` };
  }
}

function validateScenes(raw: unknown[]): { scenes: SceneIn[] } | { error: string } {
  const scenes: SceneIn[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s: unknown = raw[i];
    if (!isObj(s)) return { error: `scenes[${i}] must be an object` };
    if (!optStr(s.caption)) return { error: `scenes[${i}].caption must be a string` };
    if (!optStr(s.narration_line)) return { error: `scenes[${i}].narration_line must be a string` };
    if (!optStr(s.brollUrl)) return { error: `scenes[${i}].brollUrl must be a string` };
    if (s.seconds !== undefined && s.seconds !== null) {
      if (typeof s.seconds !== "number" || !Number.isFinite(s.seconds) || s.seconds <= 0) {
        return { error: `scenes[${i}].seconds must be a positive number of seconds` };
      }
    }
    const scene: SceneIn = {
      caption: s.caption ?? undefined,
      narration_line: s.narration_line ?? undefined,
      brollUrl: s.brollUrl ?? undefined,
      seconds: typeof s.seconds === "number" ? s.seconds : undefined,
    };
    if (s.graphic !== undefined && s.graphic !== null) {
      const g = validateGraphic(s.graphic, i);
      if ("error" in g) return g;
      scene.graphic = g.graphic;
    }
    scenes.push(scene);
  }
  return { scenes };
}

// Does the downloaded narration actually carry an audio stream? downloadTo() only
// proves bytes arrived — an HTML error page saved as .mp4 passes it — and
// probeDuration() in videoAuto reports the container's duration either way. This asks
// ffprobe the one question the render depends on. `null` means ffprobe itself is
// unavailable, so a machine without it degrades to "unknown" instead of failing every
// request; the PATH is the same one videoAuto already assembles for probeDuration.
function probeAudioStream(absPath: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: (process.env.PATH ?? "") + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin" };
    const child = spawn("ffprobe", [
      "-v", "error", "-select_streams", "a",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", absPath,
    ], { env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(null); }, 15_000);
    child.stdout.on("data", (d) => { out += String(d); });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim().length > 0); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

''' + ASSEMBLE_HELPERS_OLD

ASSEMBLE_SCENES_OLD = (
    '  const scenesIn: SceneIn[] = Array.isArray(body.scenes) ? body.scenes.slice(0, 60) : [];\n'
    '  if (!scenesIn.length) return NextResponse.json({ error: "scenes required" }, { status: 400 });')
ASSEMBLE_SCENES_NEW = (
    '  const rawScenes: unknown[] = Array.isArray(body.scenes) ? body.scenes.slice(0, 60) : [];\n'
    '  // Validated before the project directory is created or a single URL is fetched —\n'
    '  // see validateScenes for the three shapes that used to reach the renderer and throw.\n'
    '  const checked = validateScenes(rawScenes);\n'
    '  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });\n'
    '  const scenesIn: SceneIn[] = checked.scenes;\n'
    '  if (!scenesIn.length) return NextResponse.json({ error: "scenes required" }, { status: 400 });')

ASSEMBLE_AUDIO_OLD = (
    '  // ---- pull narration audio + avatar PiP down to disk ----\n'
    '  let hasAudio = false, audioSrc = "", pipSrc: string | null = null;\n'
    '  if (mode === "avatar" && (avatarUrl || narrationUrl)) {\n'
    '    const src = avatarUrl || narrationUrl;\n'
    '    if (await downloadTo(src, path.join(assets, "avatar.mp4"), origin)) {\n'
    '      hasAudio = true; audioSrc = "assets/avatar.mp4"; pipSrc = "assets/avatar.mp4";\n'
    '    }\n'
    '  } else if (mode === "voiceover" && narrationUrl) {\n'
    '    const ext = /\\.mp4(\\?|$)/i.test(narrationUrl) ? "mp4" : "mp3";\n'
    '    if (await downloadTo(narrationUrl, path.join(assets, `voiceover.${ext}`), origin)) {\n'
    '      hasAudio = true; audioSrc = `assets/voiceover.${ext}`;\n'
    '    }\n'
    '  }')
ASSEMBLE_AUDIO_NEW = (
    '  // ---- pull narration audio + avatar PiP down to disk ----\n'
    '  // A caller that asked for narration and got a silent film back had no way to\n'
    '  // notice: the request answered 200, hasAudio came back false, and the render only\n'
    '  // looks wrong once somebody watches it. So when the body asked for audio, a download\n'
    '  // that fails — or a file that turns out to carry no audio stream — is an error\n'
    '  // naming the field, not a quietly muted success.\n'
    '  let hasAudio = false, audioSrc = "", pipSrc: string | null = null;\n'
    '  const wantAudio = mode === "avatar" ? Boolean(avatarUrl || narrationUrl) : Boolean(narrationUrl);\n'
    '  if (wantAudio) {\n'
    '    const isAvatar = mode === "avatar";\n'
    '    const ext = /\\.mp4(\\?|$)/i.test(narrationUrl) ? "mp4" : "mp3";\n'
    '    const src = isAvatar ? (avatarUrl || narrationUrl) : narrationUrl;\n'
    '    const field = isAvatar ? "avatarUrl/narrationUrl" : "narrationUrl";\n'
    '    const what = isAvatar ? "avatar video" : "voiceover";\n'
    '    const rel = isAvatar ? "assets/avatar.mp4" : `assets/voiceover.${ext}`;\n'
    '    if (!(await downloadTo(src, path.join(cwd, rel), origin))) {\n'
    '      return NextResponse.json({ error: `could not download ${field} — the ${what} did not arrive, so nothing was assembled` }, { status: 502 });\n'
    '    }\n'
    '    if ((await probeAudioStream(path.join(cwd, rel))) === false) {\n'
    '      return NextResponse.json({ error: `${field} downloaded but has no audio stream — the film would render silent, so nothing was assembled` }, { status: 502 });\n'
    '    }\n'
    '    hasAudio = true; audioSrc = rel;\n'
    '    if (isAvatar) pipSrc = rel;\n'
    '  }')


def patch_assemble_route_validate():
    """Reject a malformed body with a 400 naming the field, and stop reporting a
    silent film as a success.

    Independent sentinel from the seconds and per-scene b-roll patches above, so it
    applies whether or not those have already run — including on an install that was
    patched by hand before this function existed, which is why the anchors are the
    post-b-roll text rather than the file as it shipped.

    Requires the graphic-card support (ASSEMBLE_GRAPHICS_ANCHOR) because the validator
    types against SceneGraphic and RANKING_ROW_CAP. Without it the patch returns None
    and the route keeps compiling with the seconds and b-roll patches alone.
    """
    route = f"{src}/src/app/api/video/auto/assemble/route.ts"
    try:
        s = read(route)
    except OSError:
        return None
    if ASSEMBLE_VALIDATE_SENTINEL in s:
        return "already patched"

    for anchor in (ASSEMBLE_IMPORT_OLD, ASSEMBLE_HELPERS_OLD, ASSEMBLE_SCENES_OLD, ASSEMBLE_AUDIO_OLD,
                   ASSEMBLE_GRAPHICS_ANCHOR):
        if anchor not in s:
            return None

    s = s.replace(ASSEMBLE_IMPORT_OLD, ASSEMBLE_IMPORT_NEW, 1)
    s = s.replace(ASSEMBLE_HELPERS_OLD, ASSEMBLE_HELPERS_NEW, 1)
    s = s.replace(ASSEMBLE_SCENES_OLD, ASSEMBLE_SCENES_NEW, 1)
    s = s.replace(ASSEMBLE_AUDIO_OLD, ASSEMBLE_AUDIO_NEW, 1)
    write(route, s)
    return "body validation (400) + audio-required (502) applied"


mounted = patch_hermes()
print(f"  · Hermes:  {mounted or 'could not mount — Scout stays a top-level tab'}")
print(f"  · Sidebar: {patch_sidebar(scout_top_level=mounted is None)}")
print(f"  · TopBar:  {patch_topbar(scout_top_level=mounted is None)}")
print(f"  · Astros:  {patch_astros() or 'skipped — AstrosView does not look the way we expect'}")
print(f"  · Assemble: {patch_assemble_route() or 'skipped — assemble/route.ts does not look the way we expect'}")
print(f"  · Assemble broll: {patch_assemble_route_broll() or 'skipped — assemble/route.ts does not look the way we expect'}")
print(f"  · Assemble graphics: {patch_assemble_route_graphics() or 'skipped — assemble/route.ts does not look the way we expect'}")
print(f"  · Assemble validate: {patch_assemble_route_validate() or 'skipped — assemble/route.ts does not look the way we expect'}")
print(f"  · Assemble framing: {patch_assemble_route_framing() or 'skipped — assemble/route.ts does not look the way we expect'}")
