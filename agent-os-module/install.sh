#!/usr/bin/env bash
# Installs the OmniWatch tabs into an Agent OS checkout.
#
#   ./install.sh [path-to-agent-os]      # default: ~/Documents/agent-os
#
# Two tabs, two homes:
#   OmniWatch — a top-level sidebar entry, next to Thumbnails and Video.
#   Scout     — inside the Hermes tab beside Oracle and Astros, because it runs on
#               Hermes' own schedule.
#
# Re-running is safe, and is how you repair the tabs after an Agent OS update
# overwrites Sidebar.tsx, TopBar.tsx or hermes/page.tsx.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$HOME/Documents/agent-os}"
SRC="$ROOT/source"

[ -d "$SRC/src/components" ] || {
  echo "✗ No Agent OS at $ROOT (expected $SRC/src). Pass the path: ./install.sh /path/to/agent-os"
  exit 1
}

echo "→ Installing OmniWatch into $SRC"

# The api dir is entirely ours, so clear it first: a route dropped in a newer version
# of the module must not linger in an older install.
rm -rf "$SRC/src/app/api/omniwatch"
mkdir -p "$SRC/src/app/omniwatch" "$SRC/src/app/omniwatch-scout" "$SRC/src/app/api/omniwatch"
cp -R "$HERE/src/lib/." "$SRC/src/lib/"
cp -R "$HERE/src/components/." "$SRC/src/components/"
cp -R "$HERE/src/app/omniwatch/." "$SRC/src/app/omniwatch/"
cp -R "$HERE/src/app/omniwatch-scout/." "$SRC/src/app/omniwatch-scout/"
cp -R "$HERE/src/app/api/omniwatch/." "$SRC/src/app/api/omniwatch/"
echo "  · Files copied"

# The nightly scan script for Hermes' own scheduler. Python rather than bash because
# `hermes cron --script` runs any non-.sh file with its own interpreter, and Hermes is
# a Python program — so the same file works wherever Hermes does.
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
if [ -d "$HERMES_HOME" ]; then
  mkdir -p "$HERMES_HOME/scripts"
  cp "$HERE/hermes/omniwatch-scout.py" "$HERMES_HOME/scripts/"
  chmod +x "$HERMES_HOME/scripts/omniwatch-scout.py"
  echo "  · Scan script copied to ~/.hermes/scripts/omniwatch-scout.py"
fi

python3 "$HERE/register-nav.py" "$SRC"

# The bridge from a watched video to a made one. Separate from register-nav.py
# because it patches different files (the Video Director and the script route),
# and because two things editing one registrar is how a module gets merged by hand.
python3 "$HERE/patch-director.py" "$SRC"

# v2 of the bridge UI, on top of the v1 the line above installs. Its own script
# because it replaces the whole component instead of inserting into it, and because
# it is guarded by the hash of the v1 file rather than by an anchor — a VideoDirector
# that is neither v1 nor v2 is left alone and reported, never overwritten.
python3 "$HERE/patch-director-ui-v2.py" "$SRC"

echo
echo "✓ Installed. Restart Agent OS. You now have:"
echo "    OmniWatch — in the sidebar: paste a link, ask a question or take a video apart"
echo "    Scout     — inside the Hermes tab, next to Oracle and Astros, because it runs"
echo "                on Hermes' own schedule"
echo "  Both walk you through whatever still needs setting up."
