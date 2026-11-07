"""Terminal cell grid -> HTML (each cell a fixed-size box, wide chars span 2)."""
import html
import re
import unicodedata

CW, CH = 6.6, 13.0  # px per cell; 2 cols x 1 row ~ square pixel
DEF_FG = "#d0d7de"
DEF_BG = "#0b0f14"


def cw(ch):
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class Grid:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.c = [[[" ", None, None, False] for _ in range(w)] for _ in range(h)]

    def put(self, x, y, s, fg=None, bg=None, bold=False):
        for ch in s:
            if x >= self.w or y >= self.h or y < 0:
                return x
            if x >= 0:
                self.c[y][x] = [ch, fg, bg, bold]
                if cw(ch) == 2 and x + 1 < self.w:
                    self.c[y][x + 1] = ["", fg, bg, bold]
            x += cw(ch)
        return x

    def bg(self, x0, y0, x1, y1, bg):
        for y in range(y0, y1):
            for x in range(x0, x1):
                self.c[y][x][2] = bg

    def html(self, scale=1.0):
        out = [
            f'<div style="position:relative;width:{self.w*CW*scale:.0f}px;height:{self.h*CH*scale:.0f}px;'
            f'background:{DEF_BG};font-family:Menlo,\'D2Coding\',monospace;font-size:{11*scale:.1f}px;'
            f'line-height:{CH*scale:.1f}px;overflow:hidden">'
        ]
        for y, row in enumerate(self.c):
            for x, (ch, fg, bg, bold) in enumerate(row):
                if ch == "":
                    continue
                if ch == " " and bg is None:
                    continue
                w = cw(ch)
                st = f"left:{x*CW*scale:.1f}px;top:{y*CH*scale:.1f}px;width:{w*CW*scale:.1f}px;height:{CH*scale:.1f}px;"
                st += f"color:{fg or DEF_FG};"
                if bg:
                    st += f"background:{bg};"
                if bold:
                    st += "font-weight:700;"
                if ch == "█":
                    out.append(f'<span style="position:absolute;{st}background:{fg or DEF_FG};box-shadow:0.6px 0.6px 0 {fg or DEF_FG}"></span>')
                    continue
                if ch in QUAD:
                    rects = "".join(f'<rect x="{a}" y="{b}" width="{c}" height="{d}" fill="{fg or DEF_FG}"/>' for a, b, c, d in QUAD[ch])
                    out.append(f'<span style="position:absolute;{st}"><svg width="100%" height="100%" viewBox="0 0 8 8" preserveAspectRatio="none" style="display:block">{rects}</svg></span>')
                    continue
                if ch in "▁▂▃▄▅▆▇▀▄":
                    st += "line-height:1;overflow:hidden;"
                    out.append(f'<span style="position:absolute;{st}">{block_svg(ch, fg or DEF_FG)}</span>')
                    continue
                if ch in "─━│┃┌┐└┘┏┓┗┛╌┄":
                    out.append(f'<span style="position:absolute;{st}">{box_svg(ch, fg or DEF_FG)}</span>')
                    continue
                out.append(f'<span style="position:absolute;{st}text-align:center">{html.escape(ch)}</span>')
        out.append("</div>")
        return "".join(out)


QUAD = {
    "▌": [(0, 0, 4, 8)], "▐": [(4, 0, 4, 8)],
    "▛": [(0, 0, 8, 4), (0, 4, 4, 4)], "▜": [(0, 0, 8, 4), (4, 4, 4, 4)],
    "▙": [(0, 4, 8, 4), (0, 0, 4, 4)], "▟": [(0, 4, 8, 4), (4, 0, 4, 4)],
}


def block_svg(ch, color):
    # exact geometry so blocks tile like a real terminal
    frac = {"▁": 1, "▂": 2, "▃": 3, "▄": 4, "▅": 5, "▆": 6, "▇": 7, "█": 8}
    if ch == "▀":
        return f'<svg width="100%" height="100%" viewBox="0 0 8 8" preserveAspectRatio="none" style="display:block"><rect x="0" y="0" width="8" height="4" fill="{color}"/></svg>'
    n = frac[ch]
    return f'<svg width="100%" height="100%" viewBox="0 0 8 8" preserveAspectRatio="none" style="display:block"><rect x="0" y="{8-n}" width="8" height="{n}" fill="{color}"/></svg>'


def box_svg(ch, color):
    thick = ch in "━┃┏┓┗┛"
    sw = 1.6 if thick else 0.8
    lines = {
        "─": [(0, 4, 8, 4)], "━": [(0, 4, 8, 4)],
        "│": [(4, 0, 4, 8)], "┃": [(4, 0, 4, 8)],
        "┌": [(4, 4, 8, 4), (4, 4, 4, 8)], "┏": [(4, 4, 8, 4), (4, 4, 4, 8)],
        "┐": [(0, 4, 4, 4), (4, 4, 4, 8)], "┓": [(0, 4, 4, 4), (4, 4, 4, 8)],
        "└": [(4, 0, 4, 4), (4, 4, 8, 4)], "┗": [(4, 0, 4, 4), (4, 4, 8, 4)],
        "┘": [(4, 0, 4, 4), (0, 4, 4, 4)], "┛": [(4, 0, 4, 4), (0, 4, 4, 4)],
    }
    if ch in "╌┄":
        segs = "".join(f'<line x1="{a}" y1="4" x2="{a+2.2}" y2="4" stroke="{color}" stroke-width="1.1"/>' for a in (0.5, 4.5))
        return f'<svg width="100%" height="100%" viewBox="0 0 8 8" preserveAspectRatio="none" style="display:block">{segs}</svg>'
    segs = "".join(f'<line x1="{a}" y1="{b}" x2="{c}" y2="{d}" stroke="{color}" stroke-width="{sw}"/>' for a, b, c, d in lines[ch])
    return f'<svg width="100%" height="100%" viewBox="0 0 8 8" preserveAspectRatio="none" style="display:block">{segs}</svg>'


SGR = re.compile(r"\x1b\[([0-9;]*)m")


def from_ansi(text, w, h):
    g = Grid(w, h)
    for y, line in enumerate(text.split("\n")[:h]):
        fg = bg = None
        bold = False
        x = 0
        pos = 0
        for m in list(SGR.finditer(line)) + [None]:
            end = m.start() if m else len(line)
            x = g.put(x, y, line[pos:end], fg, bg, bold)
            if not m:
                break
            pos = m.end()
            ps = [int(p) if p else 0 for p in m.group(1).split(";")] or [0]
            i = 0
            while i < len(ps):
                p = ps[i]
                if p == 0:
                    fg = bg = None
                    bold = False
                elif p == 1:
                    bold = True
                elif p == 22:
                    bold = False
                elif p == 39:
                    fg = None
                elif p == 49:
                    bg = None
                elif p in (38, 48) and i + 4 < len(ps) + 0 and ps[i + 1] == 2:
                    col = "#%02x%02x%02x" % tuple(ps[i + 2 : i + 5])
                    if p == 38:
                        fg = col
                    else:
                        bg = col
                    i += 4
                elif 30 <= p <= 37 or 90 <= p <= 97:
                    fg = None
                i += 1
    return g
