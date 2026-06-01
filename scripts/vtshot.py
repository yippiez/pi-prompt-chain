#!/usr/bin/env python3
"""Replay a raw terminal output stream (e.g. PI_TUI_WRITE_LOG) into a screen
grid that preserves background colors, then emit Pango markup for pango-view.

Unlike `tmux capture-pane`, this keeps full-width background fills (trailing
bg-colored spaces) intact, so light/dark panel backgrounds render faithfully.

Usage: vtshot.py <raw.log> <rows> <cols>  > out.pango
"""
import sys, re

DEFAULT_FG = (0xD4, 0xD4, 0xD4)
DEFAULT_BG = (0x1E, 0x1E, 0x1E)
BASE16 = [
    (0,0,0),(205,49,49),(13,188,121),(229,229,16),(36,114,200),(188,63,188),
    (17,168,205),(229,229,229),(102,102,102),(241,76,76),(35,209,139),
    (245,245,67),(59,142,234),(214,112,214),(41,184,219),(255,255,255),
]
def xterm256(n):
    if n < 16: return BASE16[n]
    if n < 232:
        n -= 16; r,g,b = n//36,(n//6)%6,n%6
        f = lambda v: 0 if v==0 else 55+40*v
        return (f(r),f(g),f(b))
    v = 8+10*(n-232); return (v,v,v)

class Cell:
    __slots__=("ch","fg","bg")
    def __init__(self): self.ch=" "; self.fg=DEFAULT_FG; self.bg=DEFAULT_BG

class Screen:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.grid=[[Cell() for _ in range(cols)] for _ in range(rows)]
        self.r=self.c=0
        self.fg=DEFAULT_FG; self.bg=DEFAULT_BG; self.rev=False
        self.wrap=False  # deferred-wrap pending flag (cursor parked at last col)

    def scroll(self):
        self.grid.pop(0); self.grid.append([Cell() for _ in range(self.cols)])

    def newline(self):
        self.r+=1; self.wrap=False
        if self.r>=self.rows: self.scroll(); self.r=self.rows-1

    def put(self, ch):
        # Resolve a pending wrap only when the next printable char actually arrives
        # (LF/CR cancel it first), matching real terminal deferred-wrap behavior.
        if self.wrap:
            self.c=0; self.wrap=False; self.newline()
        if self.r>=self.rows:
            self.scroll(); self.r=self.rows-1
        cell=self.grid[self.r][self.c]
        cell.ch=ch
        cell.fg,cell.bg=(self.bg,self.fg) if self.rev else (self.fg,self.bg)
        if self.c>=self.cols-1:
            self.wrap=True  # park at last column; defer the wrap
        else:
            self.c+=1

    def sgr(self, params):
        codes=[int(x) for x in params.split(";")] if params else [0]
        i=0
        while i<len(codes):
            c=codes[i]
            if c==0: self.fg,self.bg,self.rev=DEFAULT_FG,DEFAULT_BG,False
            elif c==7: self.rev=True
            elif c==27: self.rev=False
            elif c==39: self.fg=DEFAULT_FG
            elif c==49: self.bg=DEFAULT_BG
            elif 30<=c<=37: self.fg=BASE16[c-30]
            elif 90<=c<=97: self.fg=BASE16[c-90+8]
            elif 40<=c<=47: self.bg=BASE16[c-40]
            elif 100<=c<=107: self.bg=BASE16[c-100+8]
            elif c in (38,48):
                col=DEFAULT_FG
                if i+1<len(codes) and codes[i+1]==5:
                    col=xterm256(codes[i+2]) if i+2<len(codes) else DEFAULT_FG; i+=2
                elif i+1<len(codes) and codes[i+1]==2:
                    col=tuple(codes[i+2:i+5]) if i+4<len(codes) else DEFAULT_FG; i+=4
                if c==38: self.fg=col
                else: self.bg=col
            i+=1

    def el(self, n):  # erase in line, fill with current bg
        bg=self.fg if self.rev else self.bg
        rng = range(self.c,self.cols) if n==0 else range(0,self.c+1) if n==1 else range(0,self.cols)
        for c in rng:
            cell=self.grid[self.r][c]; cell.ch=" "; cell.fg=DEFAULT_FG; cell.bg=bg

    def ed(self, n):  # erase display
        if n==2:
            for row in self.grid:
                for cell in row: cell.ch=" "; cell.fg=DEFAULT_FG; cell.bg=DEFAULT_BG

CSI = re.compile(r"\x1b\[([0-9;?]*)([A-Za-z@])")

def replay(data, rows, cols):
    s=Screen(rows,cols); i=0; n=len(data)
    while i<n:
        ch=data[i]
        if ch=="\x1b":
            if i+1<n and data[i+1]=="[":
                m=CSI.match(data,i)
                if m:
                    params,final=m.group(1),m.group(2)
                    p=params.lstrip("?")
                    arg=int(p.split(";")[0]) if p and p.split(";")[0].isdigit() else None
                    if final in ("H","f","A","B","C","D","G","d","J"):
                        s.wrap=False  # cursor movement cancels pending wrap
                    if final in("H","f"):
                        parts=(params or "").split(";")
                        r=int(parts[0]) if parts[0:1] and parts[0] else 1
                        c=int(parts[1]) if len(parts)>1 and parts[1] else 1
                        s.r=max(0,min(rows-1,r-1)); s.c=max(0,min(cols-1,c-1))
                    elif final=="m": s.sgr(params)
                    elif final=="K": s.el(arg or 0)
                    elif final=="J": s.ed(arg if arg is not None else 0)
                    elif final=="A": s.r=max(0,s.r-(arg or 1))
                    elif final=="B": s.r=min(rows-1,s.r+(arg or 1))
                    elif final=="C": s.c=min(cols-1,s.c+(arg or 1))
                    elif final=="D": s.c=max(0,s.c-(arg or 1))
                    elif final=="G": s.c=max(0,min(cols-1,(arg or 1)-1))
                    elif final=="d": s.r=max(0,min(rows-1,(arg or 1)-1))
                    i=m.end(); continue
                i+=2; continue
            elif i+1<n and data[i+1]=="]":  # OSC ... BEL/ST
                j=data.find("\x07",i)
                k=data.find("\x1b\\",i)
                ends=[x for x in (j,k) if x!=-1]
                i=(min(ends)+ (1 if min(ends)==j else 2)) if ends else n; continue
            else:
                i+=2; continue
        elif ch=="\r": s.c=0; s.wrap=False; i+=1; continue
        elif ch=="\n":
            s.newline(); i+=1; continue
        elif ch=="\b": s.c=max(0,s.c-1); s.wrap=False; i+=1; continue
        elif ch=="\t": s.c=min(cols-1,(s.c//8+1)*8); i+=1; continue
        elif ord(ch)<32: i+=1; continue
        else: s.put(ch); i+=1
    return s

def hexc(c): return "#%02x%02x%02x"%tuple(c)
def esc(t): return t.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def row_bg(row):
    """Most common background color in a row — used as that row's canvas."""
    counts={}
    for cell in row:
        counts[cell.bg]=counts.get(cell.bg,0)+1
    return max(counts, key=counts.get)

def row_markup(row, canvas):
    """Foreground-only markup; emit bg only for cells that differ from canvas,
    so the per-line leading gap is filled by the region canvas (no stripes)."""
    out=[]; run=[]; cur=None
    def flush():
        if run:
            f,b=cur
            if b==canvas:
                out.append('<span foreground="%s">%s</span>'%(hexc(f),esc("".join(run))))
            else:
                out.append('<span foreground="%s" background="%s">%s</span>'%(hexc(f),hexc(b),esc("".join(run))))
            run.clear()
    for cell in row:
        key=(cell.fg,cell.bg)
        if key!=cur: flush(); cur=key
        run.append(cell.ch)
    flush()
    return "".join(out)

def emit_regions(s):
    """Group consecutive rows by background color into regions. Output each as:
       @@BG #rrggbb\n<markup line>\n<markup line>...  (markers consumed by driver)"""
    rows=s.grid
    # trim trailing fully-default blank rows
    def blank(row): return all(c.ch==" " and c.bg==DEFAULT_BG for c in row)
    end=len(rows)
    while end>0 and blank(rows[end-1]): end-=1
    rows=rows[:end]
    chunks=[]; i=0
    while i<len(rows):
        bg=row_bg(rows[i]); j=i
        while j<len(rows) and row_bg(rows[j])==bg: j+=1
        lines=[row_markup(rows[k],bg) for k in range(i,j)]
        chunks.append("@@BG %s\n%s"%(hexc(bg),"\n".join(lines)))
        i=j
    return "\n".join(chunks)

def main():
    path=sys.argv[1]; rows=int(sys.argv[2]); cols=int(sys.argv[3])
    data=open(path,encoding="utf-8",errors="replace").read()
    sys.stdout.write(emit_regions(replay(data,rows,cols)))

if __name__=="__main__":
    main()
