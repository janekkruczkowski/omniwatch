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


mounted = patch_hermes()
print(f"  · Hermes:  {mounted or 'could not mount — Scout stays a top-level tab'}")
print(f"  · Sidebar: {patch_sidebar(scout_top_level=mounted is None)}")
print(f"  · TopBar:  {patch_topbar(scout_top_level=mounted is None)}")
print(f"  · Astros:  {patch_astros() or 'skipped — AstrosView does not look the way we expect'}")
print(f"  · Assemble: {patch_assemble_route() or 'skipped — assemble/route.ts does not look the way we expect'}")
print(f"  · Assemble broll: {patch_assemble_route_broll() or 'skipped — assemble/route.ts does not look the way we expect'}")
