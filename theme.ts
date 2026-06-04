/* ── prompt panel (half-height, dark gray background) ──── */

export const PROMPT_HEIGHT_RATIO = 0.5;
// Dark gray background (truecolor #2a2a2a). The TUI appends an SGR reset to
// every line, so the background never bleeds into other rows.
export const PANEL_BG = "\x1b[48;2;42;42;42m";
// Slightly lighter background for the cursor's row (jjui-style full-line highlight).
export const CURSOR_ROW_BG = "\x1b[48;2;58;58;72m";
export const SGR_RESET = "\x1b[0m";

// Outline graph glyphs (jjui-style): circle nodes + vertical branch lines.
export const NODE_OPEN = "○"; // leaf or expanded node
export const NODE_FILLED = "●"; // collapsed node (has hidden children)
export const BRANCH = "│ "; // vertical connector, one per ancestor depth

// Bash output is shown in a FIXED-height rounded box below the node (content
// scrolls inside it). Fixed height keeps the display structure stable as output
// arrives asynchronously, which the inline differential renderer requires.
export const BOX_CONTENT_H = 4; // visible output lines inside the box
export const BOX_MAX_W = 90; // max box width in columns
