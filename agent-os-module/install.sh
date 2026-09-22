#!/usr/bin/env bash
# Install the OmniWatch analysis core into an Agent OS checkout.
#
#   ./install.sh [path-to-agent-os] [installer flags]
#
# Default target: ~/Documents/agent-os (same as before). Everything after the
# optional path is passed to the Node installer, e.g.:
#
#   ./install.sh ~/Documents/agent-os --check --json
#   ./install.sh ~/Documents/agent-os --rollback
#   ./install.sh --data-dir ~/Documents/agent-os/.omniwatch-data ~/Documents/agent-os
#
# This is a thin wrapper: the real installer is scripts/release/install.mjs, shared
# with the standalone shell. It installs the packaged analysis library and registers
# OmniWatch navigation. It deliberately does NOT run the old Director/Blueprint
# patchers -- this is an analysis-only release, and those files belong to another
# project. See docs/omniwatch/install/README.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$HERE/../scripts/release/install.mjs"
NODE_BIN="${OMNIWATCH_NODE:-node}"
ROOT="${OMNIWATCH_ROOT:-$HOME/Documents/agent-os}"

# Flags that take a value, so the value is never mistaken for the target path.
VALUE_FLAGS=" --tarball --manifest --release-dir --data-dir --install-subdir --required-tools --node-version --backup "

ARGS=()
expect_value=0
root_seen=0
for arg in "$@"; do
  if [ "$expect_value" -eq 1 ]; then
    ARGS+=("$arg")
    expect_value=0
    continue
  fi
  case "$arg" in
    --*)
      ARGS+=("$arg")
      case "$VALUE_FLAGS" in
        *" $arg "*) expect_value=1 ;;
      esac
      ;;
    *)
      if [ "$root_seen" -eq 0 ]; then
        ROOT="$arg"
        root_seen=1
      else
        echo "x nadmiarowy argument pozycyjny: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

if [ ! -f "$INSTALLER" ]; then
  echo "x brak instalatora Node: $INSTALLER" >&2
  exit 1
fi

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "x brak Node w PATH (wymagane Node >=22.22.3 w linii 22 albo linia 24)." >&2
  echo "  Ustaw OMNIWATCH_NODE na pelna sciezke do node, jesli nie ma go w PATH." >&2
  exit 1
fi

# Human progress goes to stderr so `--json` keeps stdout machine-readable.
echo "-> OmniWatch (analiza) do $ROOT" >&2
exec "$NODE_BIN" "$INSTALLER" --target agent-os --root "$ROOT" ${ARGS[@]+"${ARGS[@]}"}
