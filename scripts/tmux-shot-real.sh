#!/usr/bin/env bash
# tmux-shot-real.sh — FAITHFUL screenshot of pi (incl. real backgrounds).
#
# Replays pi's raw output log (PI_TUI_WRITE_LOG) into a screen grid via
# vtshot.py, then renders each same-background region on its own canvas color
# and stacks them. Nothing is synthesized — colors are exactly what pi emitted.
#
# Usage: ./tmux-shot-real.sh <raw_tui_log> [output.png] [session]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="${1:?usage: tmux-shot-real.sh <raw_tui_log> [out.png] [session]}"
OUT="${2:-/tmp/pi-real.png}"
TARGET="${3:-pchain}"
FONT="DejaVu Sans Mono"; PT=16; MARGIN=18; DARK="#1e1e1e"

read -r ROWS COLS <<< "$(tmux display -t "$TARGET" -p '#{pane_height} #{pane_width}')"
WORK="$(mktemp -d /tmp/real.XXXXXX)"; trap 'rm -rf "$WORK"' EXIT

python3 "$HERE/vtshot.py" "$LOG" "$ROWS" "$COLS" > "$WORK/regions.txt"

# Split into per-region markup files + record each region's bg color.
awk -v dir="$WORK" '
  /^@@BG /{ n++; print $2 > (dir"/bg_"n); fn=sprintf("%s/rgn_%03d.pango",dir,n); next }
  { print > fn }
' "$WORK/regions.txt"

imgs=()
for f in "$WORK"/rgn_*.pango; do
  i="${f##*/rgn_}"; i="${i%.pango}"
  bg="$(cat "$WORK/bg_$((10#$i))")"
  png="$WORK/r_$i.png"
  pango-view --no-display -q --markup --font "$FONT $PT" \
    --background "$bg" --margin 0 -o "$png" "$f"
  imgs+=("$png")
done

# Stack regions top-to-bottom, then add a uniform dark frame.
convert "${imgs[@]}" -append \
  -bordercolor "$DARK" -border "${MARGIN}" \
  "$OUT"
echo "$OUT"
