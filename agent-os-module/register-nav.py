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


mounted = patch_hermes()
print(f"  · Hermes:  {mounted or 'could not mount — Scout stays a top-level tab'}")
print(f"  · Sidebar: {patch_sidebar(scout_top_level=mounted is None)}")
print(f"  · TopBar:  {patch_topbar(scout_top_level=mounted is None)}")
print(f"  · Astros:  {patch_astros() or 'skipped — AstrosView does not look the way we expect'}")
