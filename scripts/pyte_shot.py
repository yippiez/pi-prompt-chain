#!/usr/bin/env python3
"""Replay a raw terminal stream into a grid using the `pyte` VT emulator
(handles deferred wrap, relative moves, synchronized output, etc. correctly),
then emit background-region markup for tmux-shot-real.sh.

Usage: pyte_shot.py <raw.log> <rows> <cols>
"""
import sys, pyte

DEFAULT_FG = (0xD4, 0xD4, 0xD4)
DEFAULT_BG = (0x1E, 0x1E, 0x1E)
NAMES = {
    "black":(0,0,0),"red":(205,49,49),"green":(13,188,121),"brown":(229,229,16),
    "yellow":(229,229,16),"blue":(36,114,200),"magenta":(188,63,188),
    "cyan":(17,168,205),"white":(229,229,229),
    "brightblack":(102,102,102),"brightred":(241,76,76),"brightgreen":(35,209,139),
    "brightbrown":(245,245,67),"brightyellow":(245,245,67),"brightblue":(59,142,234),
    "brightmagenta":(214,112,214),"brightcyan":(41,184,219),"brightwhite":(255,255,255),
}
def to_rgb(c, default):
    if c is None or c == "default":
        return default
    if c in NAMES:
        return NAMES[c]
    if isinstance(c, str) and len(c) == 6:
        try: return (int(c[0:2],16), int(c[2:4],16), int(c[4:6],16))
        except ValueError: pass
    return default

def hexc(c): return "#%02x%02x%02x" % tuple(c)
def esc(t): return t.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def main():
    path, rows, cols = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    data = open(path, encoding="utf-8", errors="replace").read()
    screen = pyte.Screen(cols, rows)
    pyte.Stream(screen).feed(data)

    grid = []  # rows of (char, fg_rgb, bg_rgb)
    for y in range(rows):
        line = screen.buffer[y]
        row = []
        for x in range(cols):
            ch = line[x]
            fg, bg = to_rgb(ch.fg, DEFAULT_FG), to_rgb(ch.bg, DEFAULT_BG)
            if ch.reverse: fg, bg = bg, fg
            row.append((ch.data or " ", fg, bg))
        grid.append(row)

    # trim trailing fully-default blank rows
    def blank(row): return all(c == " " and b == DEFAULT_BG for c, f, b in row)
    while grid and blank(grid[-1]): grid.pop()

    def row_bg(row):
        counts = {}
        for _, _, b in row: counts[b] = counts.get(b, 0) + 1
        return max(counts, key=counts.get)

    def row_markup(row, canvas):
        out = []; run = []; cur = None
        def flush():
            if run:
                f, b = cur
                if b == canvas:
                    out.append('<span foreground="%s">%s</span>' % (hexc(f), esc("".join(run))))
                else:
                    out.append('<span foreground="%s" background="%s">%s</span>' % (hexc(f), hexc(b), esc("".join(run))))
                run.clear()
        for ch, f, b in row:
            if (f, b) != cur: flush(); cur = (f, b)
            run.append(ch)
        flush()
        return "".join(out)

    chunks = []; i = 0
    while i < len(grid):
        bg = row_bg(grid[i]); j = i
        while j < len(grid) and row_bg(grid[j]) == bg: j += 1
        lines = [row_markup(grid[k], bg) for k in range(i, j)]
        chunks.append("@@BG %s\n%s" % (hexc(bg), "\n".join(lines)))
        i = j
    sys.stdout.write("\n".join(chunks))

if __name__ == "__main__":
    main()
