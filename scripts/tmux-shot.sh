#!/usr/bin/env bash
# tmux-shot.sh — render a tmux session/pane to a PNG image.
#
# Usage:
#   ./tmux-shot.sh [session[:window.pane]] [output.png]
#
# Examples:
#   ./tmux-shot.sh                 # capture session "pchain" -> /tmp/tmux-pchain.png
#   ./tmux-shot.sh pchain          # explicit session
#   ./tmux-shot.sh pchain:0.0 out.png
set -euo pipefail

TARGET="${1:-pchain}"
OUT="${2:-/tmp/tmux-${TARGET%%:*}.png}"

FONT="DejaVu Sans Mono"
PTSIZE=16
FG="#d4d4d4"
BG="#1e1e1e"
PAD=18

if ! tmux has-session -t "${TARGET%%:*}" 2>/dev/null; then
  echo "No such tmux session: ${TARGET%%:*}" >&2
  exit 1
fi

# -p print to stdout, capture the visible pane.
TXT="$(mktemp /tmp/tmux-shot.XXXXXX.txt)"
trap 'rm -f "$TXT"' EXIT
# Capture the pane, then:
#  1. strip trailing blank lines so the image crops vertically to content;
#  2. pad every line out to the full pane width. capture-pane trims trailing
#     whitespace, which drops the right-hand margin of centered UI (e.g. pi's
#     80%-width status bar) and makes it render off-center. Re-padding to the
#     pane width restores that margin so centered elements stay centered.
PW="$(tmux display -t "$TARGET" -p '#{pane_width}')"
tmux capture-pane -t "$TARGET" -p \
  | sed -e :a -e '/^[[:space:]]*$/{$d;N;ba}' \
  | awk -v w="$PW" '{ printf "%-*s\n", w, $0 }' > "$TXT"

# Render with pango-view (plain text by default — no markup interpretation),
# which respects monospace columns and avoids ImageMagick's @-file policy.
pango-view \
  --no-display \
  -q \
  --font "$FONT $PTSIZE" \
  --background "$BG" \
  --foreground "$FG" \
  --margin "$PAD" \
  -o "$OUT" \
  "$TXT"

echo "$OUT"
