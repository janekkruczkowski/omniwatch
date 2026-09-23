#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""OmniWatch web launcher - a thin wrapper around the shared Node runtime.

    uv run app.py            # http://127.0.0.1:8765

The HTTP/SSE surface and the analysis both live in Node
(`apps/standalone/server.mjs` over `packages/omniwatch/src/runtime`). This file only
finds Node, checks the version and replaces itself with that launcher, so the release
keeps its start command and its local address.

A missing Node or a missing runtime artifact is reported before anything starts.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MIN_NODE = (22, 22, 3)
MIN_NODE_TEXT = ".".join(str(part) for part in MIN_NODE)
# The release's tested lines (manifest `node.requirement`): 22 from 22.22.3, and 24.
NODE_REQUIREMENT = ">=22.22.3 <23 || >=24.0.0 <25"

HELP = """OmniWatch - lokalny panel (paste a link, ask a question).

  uv run app.py            # http://127.0.0.1:8765

Panel obsluguje ten sam interfejs co wydana beta:
  GET /                     interfejs WWW
  GET /i18n.json            tlumaczenia
  GET /api/watch?url&q&lang&mode
  GET /video/{id}.mp4       pobrany film (Range/seeking)
  GET /frame/{id}/{sec}.jpg klatka filmu

Dane i konfiguracja leza obok skryptow: .env, .cache/, summaries/ (beta) oraz
katalog danych nowego runtime (domyslnie ./data).
"""

INSTALL_HINT = f"""OmniWatch wymaga Node {NODE_REQUIREMENT} (linia 22 od {MIN_NODE_TEXT} albo linia 24).
Zainstaluj Node 22 LTS: https://nodejs.org/download/release/v22.22.3/
Po instalacji uruchom ponownie: uv run app.py
Stary silnik Python nie jest uruchamiany awaryjnie.
"""


def find_node() -> str | None:
    """`OMNIWATCH_NODE` wins (an explicit install path); otherwise PATH is used."""
    override = os.environ.get("OMNIWATCH_NODE")
    if override:
        return override if os.path.isfile(override) and os.access(override, os.X_OK) else None
    return shutil.which("node")


def node_version(node: str) -> tuple[int, int, int] | None:
    try:
        result = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v?(\d+)\.(\d+)\.(\d+)", result.stdout.strip())
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def node_supported(version: tuple[int, int, int] | None) -> bool:
    """Both bounds: Node 23 and 25+ are untested lines and are refused (QA R2 L7)."""
    if version is None:
        return False
    if version[0] == 22:
        return version >= MIN_NODE
    return version[0] == 24


def main(argv: list[str]) -> int:
    if "--help" in argv or "-h" in argv:
        sys.stdout.write(HELP)
        return 0

    node = find_node()
    if node is None:
        sys.stderr.write(INSTALL_HINT)
        return 4

    version = node_version(node)
    if not node_supported(version):
        found = ".".join(str(part) for part in version) if version else "nieznana"
        sys.stderr.write(INSTALL_HINT)
        sys.stderr.write(f"Znaleziona wersja Node: {found}.\n")
        return 4

    server = ROOT / "server.mjs"
    if not server.is_file():
        sys.stderr.write(
            f"Nie znaleziono serwera runtime: {server}\n"
            "Zainstaluj wydanie OmniWatch (instalator kopiuje rdzen razem z aplikacja).\n"
        )
        return 4

    env = dict(os.environ)
    env.setdefault("OMNIWATCH_APP_ROOT", str(ROOT))
    # execve replaces this process: the Node server owns the exit code and signals.
    os.execve(node, [node, str(server), *argv], env)
    return 4  # unreachable


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
