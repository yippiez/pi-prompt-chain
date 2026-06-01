#!/usr/bin/env bash
# tmux-shot-box.sh — faithful screenshot of pi's centered, dark-gray prompt box.
#
# capture-pane trims the box's bg-colored cells, so we paint the known box
# region: render the captured text on a dark canvas AND on a dark-gray canvas,
# then composite the box rectangle from the gray version onto the dark one.
# Both have identical text at identical positions, so no transparency/stripes.
#
# Usage: ./tmux-shot-box.sh [session] [out.png] [width_ratio] [height_ratio]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-pchain}"; OUT="${2:-/tmp/pi-box.png}"
WR="${3:-1.0}"; HR="${4:-0.5}"
FONT="DejaVu Sans Mono"; PT=16; M=18
DARK="#1e1e1e"; GRAY="#2a2a2a"

read -r ROWS COLS <<< "$(tmux display -t "$TARGET" -p '#{pane_height} #{pane_width}')"
WORK="$(mktemp -d /tmp/box.XXXXXX)"; trap 'rm -rf "$WORK"' EXIT

tmux capture-pane -t "$TARGET" -e -p \
  | python3 "$HERE/ansi2pango.py" --fg-only --rows "$ROWS" --cols "$COLS" > "$WORK/m.pango"

render() { pango-view --no-display -q --markup --font "$FONT $PT" --background "$1" --margin "$M" -o "$2" "$WORK/m.pango"; }
render "$DARK" "$WORK/A.png"
render "$GRAY" "$WORK/B.png"

read -r W H <<< "$(identify -format '%w %h' "$WORK/A.png")"
# Box geometry in cells (must match the extension: BAR_WIDTH_RATIO / PROMPT_HEIGHT_RATIO).
read -r BX BY BW BH <<< "$(python3 - "$W" "$H" "$ROWS" "$COLS" "$M" "$WR" "$HR" <<'PY'
import sys,math
W,H,rows,cols,M,wr,hr=map(float,sys.argv[1:8])
rows,cols,M=int(rows),int(cols),int(M)
cw=(W-2*M)/cols; ch=(H-2*M)/rows
tw=max(40,math.floor(cols*wr)); left=(cols-tw)//2
th=math.floor(rows*hr); top=rows-th
# interior only: exclude the top and bottom bar rows (they keep terminal bg)
top_i=top+1; th_i=max(0,th-2)
print(int(M+left*cw), int(M+top_i*ch), int(tw*cw), int(th_i*ch))
PY
)"

# Overlay the gray box rectangle from B onto A.
convert "$WORK/A.png" \
  \( "$WORK/B.png" -crop "${BW}x${BH}+${BX}+${BY}" +repage \) \
  -geometry "+${BX}+${BY}" -composite \
  "$OUT"
echo "$OUT"
