#!/usr/bin/env bash
# tmux-shot-panel.sh — faithful screenshot of pi with TRUE per-cell backgrounds.
#
# Renders the current tmux frame (a single snapshot, so geometry is exactly what
# the terminal shows) with real fg/bg colors via ansi2pango.py, on pi's dark
# terminal background. Layout-agnostic: it draws whatever backgrounds pi emitted
# (e.g. the dark-gray #2a2a2a editor panel, the lighter cursor row) wherever they
# actually are.
#
# Replaces an older half-split hack that stripped backgrounds and hardcoded
# "dark top / gray bottom" — correct only while the gray prompt panel sat at the
# bottom of the screen, and inverted (panel black, empty area white) once the
# panel moved to the top.
#
# Usage: ./tmux-shot-panel.sh [session] [output.png]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-pchain}"
OUT="${2:-/tmp/tmux-${TARGET}-panel.png}"
FONT="DejaVu Sans Mono"; PT=16; MARGIN=18; DARK="#1e1e1e"

read -r ROWS COLS <<< "$(tmux display -t "$TARGET" -p '#{pane_height} #{pane_width}')"
WORK="$(mktemp -d /tmp/panel.XXXXXX)"; trap 'rm -rf "$WORK"' EXIT

# Single current frame, with SGR colors (-e), padded to the full grid so every
# row is rectangular. ansi2pango.py keeps real fg AND bg (incl. 24-bit truecolor).
tmux capture-pane -t "$TARGET" -e -p \
  | python3 "$HERE/ansi2pango.py" --rows "$ROWS" --cols "$COLS" > "$WORK/all.pango"

# One dark canvas. Per-cell bg spans paint the panel; inter-line gaps fall back to
# the dark canvas (invisible against pi's dark panels), so no striping workaround
# is needed.
pango-view --no-display -q --markup --font "$FONT $PT" \
  --background "$DARK" --margin "$MARGIN" -o "$OUT" "$WORK/all.pango"
echo "$OUT"
