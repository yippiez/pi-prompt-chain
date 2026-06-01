#!/usr/bin/env bash
# tmux-shot-panel.sh — faithful screenshot of pi with its gray prompt panel.
#
# pango per-line backgrounds stripe (leading gaps show the canvas), and tmux
# capture-pane trims bg-colored trailing spaces. Workaround: split the screen
# at the panel boundary and render each half on its own canvas color (dark top,
# gray bottom), then stack them. Inter-line gaps then match each half's canvas,
# so the gray panel is solid.
#
# Usage: ./tmux-shot-panel.sh [session] [output.png] [panel_ratio]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-pchain}"
OUT="${2:-/tmp/tmux-${TARGET}-panel.png}"
RATIO="${3:-0.5}"
FONT="DejaVu Sans Mono"; PT=16; MARGIN=18
DARK="#1e1e1e"; GRAY="#d3d3d3"

read -r ROWS COLS <<< "$(tmux display -t "$TARGET" -p '#{pane_height} #{pane_width}')"
PANEL_ROWS=$(python3 -c "import math;print(max(3,math.floor($ROWS*$RATIO)))")
TOP_ROWS=$((ROWS - PANEL_ROWS))

WORK="$(mktemp -d /tmp/panel.XXXXXX)"; trap 'rm -rf "$WORK"' EXIT

# Full-height capture (keep every row so geometry is fixed), foreground only.
tmux capture-pane -t "$TARGET" -e -p \
  | python3 "$HERE/ansi2pango.py" --fg-only --rows "$ROWS" --cols "$COLS" > "$WORK/all.pango"

# Split into top (dark) and bottom (gray panel) halves.
head -n "$TOP_ROWS" "$WORK/all.pango" > "$WORK/top.pango"
tail -n "$PANEL_ROWS" "$WORK/all.pango" > "$WORK/bot.pango"

render() { # <markup> <bg> <out>
  pango-view --no-display -q --markup --font "$FONT $PT" \
    --background "$2" --margin 0 -o "$3" "$1"
}
render "$WORK/top.pango" "$DARK" "$WORK/top.png"
render "$WORK/bot.pango" "$GRAY" "$WORK/bot.png"

# Stack, then frame: dark top/side margins, gray bottom margin.
convert "$WORK/top.png" "$WORK/bot.png" -append "$WORK/body.png"
convert "$WORK/body.png" \
  -bordercolor "$DARK" -border "${MARGIN}x0" \
  -background "$DARK" -gravity North -splice "0x${MARGIN}" \
  -background "$GRAY" -gravity South -splice "0x${MARGIN}" \
  "$OUT"
echo "$OUT"
