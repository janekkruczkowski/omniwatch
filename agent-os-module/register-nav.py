#!/usr/bin/env python3
"""Register the OmniWatch integration in an Agent OS checkout (T8 / D5).

What this registrar owns:

* **OmniWatch** - a top-level sidebar entry, next to Thumbnails and Video.
* **Scout** - mounted as a Hermes sub-tab when `app/hermes/page.tsx` still has the
  anchors to mount it; otherwise it falls back to a top-level tab.
* **The Astros link (SPEC F12)** - a fourth action chip on an Astros topic that opens
  OmniWatch for that video, so refreshing Astros does not start another paid analysis.
* **The Memory Vault label** - `MemoryPanel.tsx` printed a fixed
  "~/Documents/Obsidian Vault"; it now shows the Vault actually resolved at runtime
  (`OmniVaultLabel`, which reads `/api/omniwatch/library`).

It does **not** touch the Video Director, Blueprint or the film-production
`api/video/auto/assemble` route: those stay in the film project, and the analysis
release installs without deploying them.

    python3 register-nav.py <agent-os>/source [--only sidebar,topbar,hermes,astros,memory]
                            [--dry-run] [--path-prefix <p>] [--json]

Every edit is idempotent and re-running repairs the tabs and the chip. A requested
section whose anchor is missing is reported as an error, that file is left untouched
(never a half-patched file) and the script exits non-zero - which is what lets the
Node installer refuse before it changes anything.
"""
import argparse
import hashlib
import json
import re
import sys

NAV_LINE = ('  { href: "/omniwatch", label: "OmniWatch", icon: <Eye size={16} />, '
            'accent: "#d4a574", dim: "rgba(212,165,116,0.16)" },\n')
TITLE_LINE = (
    '  "/omniwatch":   { numeral: "XI.",   label: "Self - OmniWatch", title: "OmniWatch",'
    '               sub: "Wklej link do dowolnego filmu - YouTube, TikTok, Instagram, X, Reels,'
    ' Shorts - i pozwol OmniWatch obejrzec go w calosci: kazda klatke i kazde slowo, nie tylko'
    ' transkrypcje. Zapytaj o konkret albo rozbierz film na czesci." },\n')

# Only used when Scout cannot be mounted inside Hermes.
SCOUT_NAV_LINE = ('  { href: "/omniwatch-scout", label: "Scout", icon: <Radar size={16} />, '
                  'accent: "#d4a574", dim: "rgba(212,165,116,0.16)" },\n')
SCOUT_TITLE_LINE = (
    '  "/omniwatch-scout": { numeral: "XI.",   label: "Self - Scout",      title: "OmniWatch Scout",'
    '         sub: "Nazwij konta i hashtagi, ktore warto obserwowac. Hermes zbiera je przez Apify,'
    ' Scout pokazuje filmy ponad ich wlasna norma, a wyniki wracaja rozlozone na czesci." },\n')

# SPEC F12: the link from an Astros topic into OmniWatch for that exact video.
ASTROS_MARKER = "asx-act omni"
ASTROS_ANCHOR = '                    <button className="asx-act nb"'
ASTROS_CSS_ANCHOR = ".asx-act.seo:hover{ box-shadow:0 0 18px rgba(255,216,107,.3); }\n"
CHIP = (
    '                    {t.competitor.url && (\n'
    '                      <a className="asx-act omni"\n'
    '                         href={`/omniwatch?url=${encodeURIComponent(t.competitor.url)}`}\n'
    '                         title="Astros read the title. OmniWatch opens the video and tells you'
    ' how it was made.">\n'
    '                        <MonitorPlay size={14} /> OMNI WATCHES IT\n'
    '                      </a>\n'
    '                    )}\n')
CHIP_CSS = ('        .asx-act.omni{ color:#c58bff; border-color:rgba(197,139,255,.5); }'
            ' .asx-act.omni:hover{ box-shadow:0 0 18px rgba(197,139,255,.3); }\n')

# The Memory panel's Vault label: a hard-coded default path replaced by the resolved one.
MEMORY_MARKER = "OmniVaultLabel"
MEMORY_ANCHOR = "Vault: <code>~/Documents/Obsidian Vault</code>"
MEMORY_LABEL = "Vault: <OmniVaultLabel />"
MEMORY_IMPORT = 'import OmniVaultLabel from "./OmniVaultLabel";\n'

DRY_RUN = False


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def digest(path):
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None


def write(path, text):
    """Write unless this is a dry run, which only proves the anchors exist."""
    if DRY_RUN:
        return
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def ensure_icons(text, icons):
    """Make sure every icon we reference is imported from lucide-react."""
    match = re.search(r'import \{([^}]*)\} from "lucide-react";', text)
    if not match:
        return text
    names = [name.strip() for name in match.group(1).split(",") if name.strip()]
    for icon in icons:
        if not any(name == icon or name.endswith(f" as {icon}") for name in names):
            names.append(icon)
    return (text[:match.start()] + "import { " + ", ".join(names) +
            ' } from "lucide-react";' + text[match.end():])


def drop_line(path, needle):
    """Remove a nav line an earlier version of this installer added."""
    text = read(path)
    lines = text.split("\n")
    kept = [line for line in lines if needle not in line]
    if len(kept) == len(lines):
        return False
    write(path, "\n".join(kept))
    return True


def mount_scout_in_hermes(src):
    """Mount Scout as a Hermes sub-tab. None when the file does not match."""
    path = f"{src}/src/app/hermes/page.tsx"
    try:
        text = read(path)
    except OSError:
        return None
    if '"scout"' in text and "ScoutView" in text:
        return "already mounted", False

    original = text
    if "ScoutView" not in text:
        anchor = 'import AstrosView from "@/components/AstrosView";\n'
        if anchor not in text:
            return None
        text = text.replace(anchor, anchor + 'import ScoutView from "@/components/ScoutView";\n', 1)

    # The key appears twice before the tab bar: the HermesTab union, then the
    # deep-link allowlist. Both have to learn the new key.
    if text.count('"astros"') < 2:
        return None
    text = text.replace('"astros"', '"astros" | "scout"', 1)
    text = text.replace('"astros",', '"astros", "scout",', 1)

    bar = '{ key: "astros",    label: "Hermes Astros", icon: <Sparkles size={14} /> },'
    if bar not in text:
        return None
    text = text.replace(
        bar,
        bar + '\n          { key: "scout",     label: "OmniWatch Scout", icon: <Eye size={14} /> },',
        1)

    render = ') : tab === "astros" ? (\n        <AstrosView />\n      '
    if render not in text:
        return None
    text = text.replace(render, render + ') : tab === "scout" ? (\n        <ScoutView />\n      ', 1)

    text = ensure_icons(text, ["Eye"])
    if text == original:
        return None
    write(path, text)
    return "mounted as a Hermes sub-tab", True


def patch_sidebar(src, scout_top_level):
    path = f"{src}/src/components/Sidebar.tsx"
    text = read(path)
    added = []
    anchor = '  { href: "/thumbnails",'
    if '"/omniwatch"' not in text:
        if anchor in text:
            text = text.replace(anchor, NAV_LINE + anchor, 1)
        else:
            text, count = re.subn(r"\n\];\s*\n\s*const DEFAULT_ORDER",
                                  "\n" + NAV_LINE + "];\n\nconst DEFAULT_ORDER", text, count=1)
            if count == 0:
                raise LookupError("brak kotwicy /thumbnails i bloku DEFAULT_ORDER")
        added.append("/omniwatch")
    if scout_top_level and '"/omniwatch-scout"' not in text:
        if anchor not in text:
            raise LookupError("brak kotwicy /thumbnails dla zakladki Scout")
        text = text.replace(anchor, SCOUT_NAV_LINE + anchor, 1)
        added.append("/omniwatch-scout")
    text = ensure_icons(text, ["Eye", "Radar"] if scout_top_level else ["Eye"])
    write(path, text)
    if not scout_top_level and drop_line(path, '"/omniwatch-scout"'):
        added.append("usunieto stara gorna zakladke /omniwatch-scout")
    return (", ".join(added) if added else "bez zmian"), bool(added)


def patch_topbar(src, scout_top_level):
    path = f"{src}/src/components/TopBar.tsx"
    text = read(path)
    added = []
    anchor = '  "/thumbnails":'
    if '"/omniwatch":' not in text:
        if anchor in text:
            text = text.replace(anchor, TITLE_LINE + anchor, 1)
        else:
            block = "const TITLES: Record<string, PageMeta> = {\n"
            if block not in text:
                raise LookupError("brak kotwicy /thumbnails i bloku TITLES")
            text = text.replace(block, block + TITLE_LINE, 1)
        added.append("/omniwatch")
    if scout_top_level and '"/omniwatch-scout":' not in text:
        if anchor not in text:
            raise LookupError("brak kotwicy /thumbnails dla tytulu Scout")
        text = text.replace(anchor, SCOUT_TITLE_LINE + anchor, 1)
        added.append("/omniwatch-scout")
    write(path, text)
    if not scout_top_level and drop_line(path, '"/omniwatch-scout":'):
        added.append("usunieto stary tytul /omniwatch-scout")
    return (", ".join(added) if added else "bez zmian"), bool(added)


def patch_astros(src, _scout_top_level=None):
    """Register the SPEC F12 link: one extra action chip per Astros topic.

    Astros already hands each topic to the Video agent, NotebookLM and the SEO writer.
    NotebookLM gets the competitor's video but reads the transcript; this chip opens
    the picture in OmniWatch instead. It is a link only - the film project's
    `api/video/auto/assemble` patches are not part of this release.
    """
    path = f"{src}/src/components/AstrosView.tsx"
    text = read(path)
    occurrences = text.count(ASTROS_MARKER)
    if occurrences > 1:
        raise LookupError(
            f"chip OmniWatch wystepuje {occurrences} razy - plik wymaga recznego "
            "uporzadkowania, nie dokladam kolejnego")
    if occurrences == 1:
        if CHIP_CSS not in text and ASTROS_CSS_ANCHOR in text:
            write(path, text.replace(ASTROS_CSS_ANCHOR, ASTROS_CSS_ANCHOR + CHIP_CSS, 1))
            return "already added; dodano brakujacy styl", True
        return "already added", False
    if ASTROS_ANCHOR not in text or ASTROS_CSS_ANCHOR not in text:
        raise LookupError(
            "brak kotwicy AstrosView (oczekiwano "
            f"{ASTROS_ANCHOR.strip()!r} i reguly CSS .asx-act.seo:hover) - "
            "plik pozostawiony bez zmian")
    text = text.replace(ASTROS_ANCHOR, CHIP + ASTROS_ANCHOR, 1)
    text = text.replace(ASTROS_CSS_ANCHOR, ASTROS_CSS_ANCHOR + CHIP_CSS, 1)
    text = ensure_icons(text, ["MonitorPlay"])
    write(path, text)
    return "chip added", True


def patch_memory(src, _scout_top_level=None):
    """Show the Vault actually in use instead of a fixed default path.

    The label is display-only; the Memory panel's own reads are untouched. A file that
    no longer carries the exact default label is left alone and reported, never guessed at.
    """
    path = f"{src}/src/components/MemoryPanel.tsx"
    text = read(path)
    if MEMORY_MARKER in text:
        return "already added", False
    imports = list(re.finditer(r'^import [^\n]*;\n', text, flags=re.M))
    if MEMORY_ANCHOR not in text or not imports:
        # Cosmetic only: a host whose panel no longer prints the default label keeps its
        # own text. Never a conflict that would block installing the analysis release.
        return "etykieta Vaulta nie znaleziona - plik pozostawiony bez zmian", False
    last = imports[-1]
    text = text[:last.end()] + MEMORY_IMPORT + text[last.end():]
    text = text.replace(MEMORY_ANCHOR, MEMORY_LABEL, 1)
    write(path, text)
    return "vault label added", True


NAV_FILES = {
    "sidebar": "src/components/Sidebar.tsx",
    "topbar": "src/components/TopBar.tsx",
    "hermes": "src/app/hermes/page.tsx",
    "astros": "src/components/AstrosView.tsx",
    "memory": "src/components/MemoryPanel.tsx",
}


def main():
    parser = argparse.ArgumentParser(description="Register OmniWatch navigation in Agent OS")
    parser.add_argument("src", help="<agent-os>/source")
    parser.add_argument("--only", default="sidebar,topbar,hermes,astros,memory",
                        help="comma-separated subset of sidebar,topbar,hermes,astros,memory")
    parser.add_argument("--path-prefix", default=None,
                        help="prefix for reported paths (default: the src directory name)")
    parser.add_argument("--dry-run", action="store_true",
                        help="check the anchors and report the plan without writing")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    global DRY_RUN
    DRY_RUN = args.dry_run

    src = args.src.rstrip("/")
    prefix = args.path_prefix or src.split("/")[-1] or "source"
    requested = [name.strip() for name in args.only.split(",") if name.strip()]
    unknown = [name for name in requested if name not in NAV_FILES]
    if unknown:
        print(json.dumps({"ok": False, "error": f"nieznane sekcje: {', '.join(unknown)}"}))
        return 2

    files = []
    notes = []
    ok = True

    mounted = None
    if "hermes" in requested:
        try:
            mounted = mount_scout_in_hermes(src)
        except OSError as error:
            mounted = None
            notes.append(f"Hermes: {error}")
    scout_top_level = mounted is None

    def record(name, action, before=None, after=None, error=None, changed=None):
        nonlocal ok
        entry = {
            "name": name,
            "path": f"{prefix}/{NAV_FILES[name]}",
            "action": action,
            "before": before,
            "after": after,
            "changed": bool(changed) if changed is not None else before != after,
        }
        if error:
            ok = False
            entry["error"] = error
        files.append(entry)

    def record_result(name, result, before):
        action, changed = result
        record(name, action, before, digest(f"{src}/{NAV_FILES[name]}"), changed=changed)

    for name, function in (("sidebar", patch_sidebar), ("topbar", patch_topbar), ("astros", patch_astros),
                           ("memory", patch_memory)):
        if name not in requested:
            continue
        path = f"{src}/{NAV_FILES[name]}"
        before = digest(path)
        try:
            record_result(name, function(src, scout_top_level), before)
        except OSError as error:
            record(name, "blad odczytu/zapisu", before, digest(path), error=str(error))
        except LookupError as error:
            record(name, "kotwica nieznaleziona - plik pozostawiony bez zmian",
                   before, digest(path), error=str(error))

    if "hermes" in requested:
        hermes_path = f"{src}/{NAV_FILES['hermes']}"
        before = digest(hermes_path)
        if mounted:
            record_result("hermes", mounted, before)
        else:
            record("hermes", "nie zamontowano - Scout zostaje gorna zakladka",
                   before, digest(hermes_path), changed=False)
            notes.append("Hermes: plik nie pasuje do kotwic; Scout zarejestrowany jako gorna zakladka")

    report = {
        "ok": ok,
        "dryRun": bool(args.dry_run),
        "files": files,
        "notes": notes,
        "scoutTopLevel": scout_top_level,
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        for entry in files:
            print(f"  · {entry['name']}: {entry['action']}")
        for note in notes:
            print(f"  · {note}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
