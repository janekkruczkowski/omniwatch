#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""OmniWatch CLI launcher - a thin wrapper around the shared Node runtime.

    uv run omniwatch.py <url> [-q "question"] [--lang en|pl|de|es|fr] [--teardown]

The analysis itself lives in the shared runtime (`apps/standalone/cli.mjs` ->
`packages/omniwatch/src/runtime/cli.ts`). This file owns no analysis logic: it finds
Node, checks the version and replaces itself with the Node launcher, so the exit code
and an interruption are passed through unchanged.

A missing Node or a missing runtime artifact is reported before anything starts; the
old Python engine is never used as a fallback.
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

HELP = """OmniWatch - zapytaj film, a Qwen Omni obejrzy go za Ciebie.

  uv run omniwatch.py <url> [-q "pytanie"] [--lang en|pl|de|es|fr] [--teardown]

  -q, --question <tekst>  pytanie o film (puste = pelne streszczenie)
  --lang <kod>            jezyk odpowiedzi
  --teardown              rozbierz film na czesci (hook, beaty, montaz, CTA)
  --conversation <id>     rozmowa, do ktorej nalezy pytanie
  --parent <turnId>       poprzednia odpowiedz, ktora rozwijamy
  --help                  ta instrukcja

Analize wykonuje wspolny runtime OmniWatch (jedna implementacja dla CLI i WWW).
"""

INSTALL_HINT = f"""OmniWatch wymaga Node {MIN_NODE_TEXT} lub nowszego.
Zainstaluj Node 22 LTS: https://nodejs.org/download/release/v22.22.3/
Po instalacji uruchom ponownie: uv run omniwatch.py <url>
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


def main(argv: list[str]) -> int:
    if "--help" in argv or "-h" in argv:
        sys.stdout.write(HELP)
        return 0

    node = find_node()
    if node is None:
        sys.stderr.write(INSTALL_HINT)
        return 4

    version = node_version(node)
    if version is None or version < MIN_NODE:
        found = ".".join(str(part) for part in version) if version else "nieznana"
        sys.stderr.write(INSTALL_HINT)
        sys.stderr.write(f"Znaleziona wersja Node: {found}.\n")
        return 4

    launcher = ROOT / "cli.mjs"
    if not launcher.is_file():
        sys.stderr.write(
            f"Nie znaleziono launchera runtime: {launcher}\n"
            "Zainstaluj wydanie OmniWatch (instalator kopiuje rdzen razem z aplikacja).\n"
        )
        return 4

    env = dict(os.environ)
    env.setdefault("OMNIWATCH_APP_ROOT", str(ROOT))
    # execve replaces this process: the Node launcher owns the exit code and signals.
    os.execve(node, [node, str(launcher), *argv], env)
    return 4  # unreachable


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
