#!/usr/bin/env bash
# tmux-shot-color.sh — render a tmux pane to PNG *with* ANSI colors.
# Usage: ./tmux-shot-color.sh [session[:win.pane]] [output.png]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-pchain}"
OUT="${2:-/tmp/tmux-${TARGET%%:*}-color.png}"
FONT="DejaVu Sans Mono"
PTSIZE=16
BG="#1e1e1e"
PAD=18

tmux has-session -t "${TARGET%%:*}" 2>/dev/null || { echo "No session: ${TARGET%%:*}" >&2; exit 1; }

MARKUP="$(mktemp /tmp/tmux-shot.XXXXXX.pango)"
trap 'rm -f "$MARKUP"' EXIT

# -e keeps escape sequences (colors); convert SGR -> Pango markup.
tmux capture-pane -t "$TARGET" -e -p | python3 "$HERE/ansi2pango.py" > "$MARKUP"

pango-view --no-display -q --markup \
  --font "$FONT $PTSIZE" \
  --background "$BG" \
  --margin "$PAD" \
  -o "$OUT" \
  "$MARKUP"

echo "$OUT"
