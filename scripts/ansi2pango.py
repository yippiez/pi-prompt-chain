#!/usr/bin/env python3
"""Convert ANSI/SGR-colored text (from `tmux capture-pane -ep`) to Pango markup.

Reads stdin, writes Pango markup to stdout for rendering with:
  pango-view --markup -q --font "DejaVu Sans Mono 16" --background '#1e1e1e' ...
"""
import sys, re

DEFAULT_FG = (0xD4, 0xD4, 0xD4)
DEFAULT_BG = (0x1E, 0x1E, 0x1E)

# Standard xterm 16-color palette.
BASE16 = [
    (0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16),
    (36, 114, 200), (188, 63, 188), (17, 168, 205), (229, 229, 229),
    (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67),
    (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255),
]

def xterm256(n):
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        r, g, b = n // 36, (n // 6) % 6, n % 6
        f = lambda v: 0 if v == 0 else 55 + 40 * v
        return (f(r), f(g), f(b))
    v = 8 + 10 * (n - 232)
    return (v, v, v)

def hexc(c):
    return "#%02x%02x%02x" % c

SGR_RE = re.compile(r"\x1b\[([0-9;]*)m")
# Strip non-SGR escapes only. CRUCIAL: the CSI branch excludes final byte 'm'
# (0x6d) so SGR color sequences survive for SGR_RE to parse.
OTHER_ESC = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"   # OSC ... BEL/ST  (e.g. hyperlinks)
    r"|\x1b[_PX^][^\x1b]*(?:\x1b\\)?"        # APC/DCS/SOS/PM (e.g. cursor marker)
    r"|\x1b\[[0-9;?]*[@-ln-~]"               # CSI except final 'm' (SGR kept)
    r"|\x1b[()=>][0-9A-Za-z]?"               # charset / keypad
)

def esc_text(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

FG_ONLY = False

def parse_line(line):
    fg, bg, reverse = DEFAULT_FG, DEFAULT_BG, False
    out = []
    pos = 0
    pending = []  # buffered plain text under current style

    def flush():
        if not pending:
            return
        text = esc_text("".join(pending))
        f, b = (bg, fg) if reverse else (fg, bg)
        if FG_ONLY:
            out.append('<span foreground="%s">%s</span>' % (hexc(f), text))
        else:
            out.append('<span foreground="%s" background="%s">%s</span>' % (hexc(f), hexc(b), text))
        pending.clear()

    # strip non-SGR escape sequences (OSC titles, cursor APC markers, etc.)
    line = OTHER_ESC.sub("", line)

    for m in SGR_RE.finditer(line):
        pending.append(line[pos:m.start()])
        pos = m.end()
        flush()
        params = m.group(1)
        codes = [int(x) for x in params.split(";")] if params else [0]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == 0:
                fg, bg, reverse = DEFAULT_FG, DEFAULT_BG, False
            elif c == 7:
                reverse = True
            elif c == 27:
                reverse = False
            elif c == 39:
                fg = DEFAULT_FG
            elif c == 49:
                bg = DEFAULT_BG
            elif 30 <= c <= 37:
                fg = BASE16[c - 30]
            elif 90 <= c <= 97:
                fg = BASE16[c - 90 + 8]
            elif 40 <= c <= 47:
                bg = BASE16[c - 40]
            elif 100 <= c <= 107:
                bg = BASE16[c - 100 + 8]
            elif c == 38 or c == 48:
                target = "fg" if c == 38 else "bg"
                if i + 1 < len(codes) and codes[i + 1] == 5:
                    col = xterm256(codes[i + 2]) if i + 2 < len(codes) else DEFAULT_FG
                    i += 2
                elif i + 1 < len(codes) and codes[i + 1] == 2:
                    col = tuple(codes[i + 2 : i + 5]) if i + 4 < len(codes) else DEFAULT_FG
                    i += 4
                else:
                    col = DEFAULT_FG
                if target == "fg":
                    fg = col
                else:
                    bg = col
            i += 1

    pending.append(line[pos:])
    flush()
    return "".join(out)

def main():
    global FG_ONLY
    args = sys.argv[1:]
    FG_ONLY = "--fg-only" in args
    def opt(name, default=None):
        return int(args[args.index(name) + 1]) if name in args else default
    fixed_rows = opt("--rows")
    fixed_cols = opt("--cols")

    data = sys.stdin.buffer.read().decode("utf-8", "replace")
    lines = data.split("\n")
    if fixed_rows is None:
        while lines and lines[-1].strip() == "":
            lines.pop()  # trim trailing blanks only in free mode
    else:
        lines = (lines + [""] * fixed_rows)[:fixed_rows]  # exact row count
    width = fixed_cols or max((len(SGR_RE.sub("", OTHER_ESC.sub("", l))) for l in lines), default=0)
    rendered = []
    for l in lines:
        markup = parse_line(l)
        plain_len = len(SGR_RE.sub("", OTHER_ESC.sub("", l)))
        if plain_len < width:  # pad to full width so each row is rectangular
            pad = " " * (width - plain_len)
            if FG_ONLY:
                markup += '<span foreground="%s">%s</span>' % (hexc(DEFAULT_FG), pad)
            else:
                markup += '<span foreground="%s" background="%s">%s</span>' % (
                    hexc(DEFAULT_FG), hexc(DEFAULT_BG), pad)
        rendered.append(markup)
    sys.stdout.write("\n".join(rendered))

if __name__ == "__main__":
    main()
