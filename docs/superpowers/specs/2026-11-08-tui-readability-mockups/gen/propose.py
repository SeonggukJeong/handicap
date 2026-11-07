"""Proposal mock: 6 panels (3x2) at 180x50, GUI-like."""
import math
import random
import sys

from grid import Grid, cw

FONT = {  # 3x5 pixel font
    "0": ["###", "#.#", "#.#", "#.#", "###"],
    "1": [".#.", "##.", ".#.", ".#.", "###"],
    "2": ["###", "..#", "###", "#..", "###"],
    "3": ["###", "..#", ".##", "..#", "###"],
    "4": ["#.#", "#.#", "###", "..#", "..#"],
    "5": ["###", "#..", "###", "..#", "###"],
    "6": ["###", "#..", "###", "#.#", "###"],
    "7": ["###", "..#", ".#.", ".#.", ".#."],
    "8": ["###", "#.#", "###", "#.#", "###"],
    "9": ["###", "#.#", "###", "..#", "###"],
    "H": ["#.#", "#.#", "###", "#.#", "#.#"],
    "T": ["###", ".#.", ".#.", ".#.", ".#."],
    "P": ["###", "#.#", "###", "#..", "#.."],
    ",": ["..", "..", "..", ".#", "#."],
    " ": ["..", "..", "..", "..", ".."],
}

C_TEXT = "#f2f5f8"
C_MUTED = "#9aa7b4"
C_AXIS = "#7b8794"
C_OK = "#22c55e"
C_FAIL = "#ef4444"
C_GRAY = "#94a3b8"
C_GRAYB = "#64748b"


def big_width(s, px=2):
    return sum(len(FONT[c][0]) * px + px for c in s) - px


def draw_big(g, x, y, s, color, mode):
    """mode 'full': pixel = 2 cols x 1 row (5 rows tall). 'half': pixel = 1 col x half row (3 rows)."""
    if mode == "full":
        for ch in s:
            pat = FONT[ch]
            for r, row in enumerate(pat):
                for c, p in enumerate(row):
                    if p == "#":
                        g.put(x + c * 2, y + r, "██", color)
            x += len(pat[0]) * 2 + 2
        return
    for ch in s:
        pat = FONT[ch] + ["." * len(FONT[ch][0])]
        for r in range(3):
            for c in range(len(pat[0])):
                top = pat[r * 2][c] == "#"
                bot = pat[r * 2 + 1][c] == "#"
                glyph = "█" if top and bot else "▀" if top else "▄" if bot else None
                if glyph:
                    g.put(x + c, y + r, glyph, color)
        x += len(pat[0]) + 1


def bar_color(ms, th):
    col = C_OK
    for t, c in sorted(th):
        if ms >= t:
            col = c
    return col


def panel(g, x, y, w, h, title, state, big, unit, series, th, gmax, selected=False, cons=None, stats=None, bigmode="full", tint=None):
    sc = {"ok": C_OK, "slow": None, "fail": C_FAIL}[state]
    if state == "slow":
        sc = bar_color(series[-1][1], th)
    if tint:
        g.bg(x, y, x + w, y + h, tint)
    hz, vt = ("━", "┃") if selected else ("─", "│")
    tl, tr, bl, br = ("┏", "┓", "┗", "┛") if selected else ("┌", "┐", "└", "┘")
    g.put(x, y, tl + hz * (w - 2) + tr, sc, tint)
    g.put(x, y + h - 1, bl + hz * (w - 2) + br, sc, tint)
    for r in range(1, h - 1):
        g.put(x, y + r, vt, sc, tint)
        g.put(x + w - 1, y + r, vt, sc, tint)
    ix, iw = x + 2, w - 4
    iy = y + 1
    # row 1: title (bold) + status (bold, colored)
    label = {"ok": "✔ 정상", "slow": "▲ 느림", "fail": "✖ 실패"}[state]
    g.put(ix, iy, title, C_TEXT, tint, True)
    lw = sum(cw(c) for c in label)
    g.put(ix + iw - lw, iy, label, sc, tint, True)
    # big value
    bigc = C_TEXT if state == "ok" else sc
    by = iy + 2
    if big is not None:
        uw0 = sum(cw(c) for c in unit) + 1 if unit else 0
        if bigmode == "full" and big_width(big) + uw0 > iw:
            bigmode = "half"
        if bigmode == "full":
            bw = big_width(big)
            uw = sum(cw(c) for c in unit) + 1 if unit else 0
            draw_big(g, ix + iw - bw - uw, by, big, bigc, "full")
            if unit:
                g.put(ix + iw - uw + 1, by + 4, unit, bigc, tint, True)
            bh = 5
        else:
            bw = sum(len(FONT[c][0]) + 1 for c in big) - 1
            uw = sum(cw(c) for c in unit) + 1 if unit else 0
            draw_big(g, ix + iw - bw - uw, by, big, bigc, "half")
            if unit:
                g.put(ix + iw - uw + 1, by + 2, unit, bigc, tint, True)
            bh = 3
    else:
        bh = 1
    ny = by + bh
    if cons:
        g.put(ix, ny, cons, C_FAIL, tint)
    # bars area
    bottom_rows = 2 if stats else 1  # axis + stats
    top = ny + 2
    bot = y + h - 2 - bottom_rows  # last bars row
    rows = bot - top + 1
    lab_w = 6
    bw_cols = iw - lab_w - 1
    n = min(len(series), bw_cols)
    vis = series[-n:]
    x0 = ix + bw_cols - n
    # threshold lines first (behind bars)
    for t, c in th:
        frac = t / gmax
        r_from_bottom = frac * rows
        ry = bot - int(r_from_bottom) if r_from_bottom < rows else top
        if r_from_bottom >= rows:
            continue
        for cx in range(ix, ix + bw_cols):
            g.put(cx, ry, "╌", c, tint)
        num = f"{t:,}"
        g.put(ix + iw - len(num), ry, num, c, tint, True)
    for i, (kind, ms) in enumerate(vis):
        cx = x0 + i
        if kind == "fail":
            for r in range(rows):
                g.put(cx, bot - r, "█", C_FAIL, tint)
            continue
        if kind == "gray":
            g.put(cx, bot, "▂", C_GRAYB, tint)
            continue
        eighths = max(1, round(min(ms, gmax) / gmax * rows * 8))
        col = bar_color(ms, th)
        full, part = divmod(eighths, 8)
        for r in range(full):
            g.put(cx, bot - r, "█", col, tint)
        if part and full < rows:
            g.put(cx, bot - full, "▁▂▃▄▅▆▇"[part - 1], col, tint)
    # axis line + labels
    ay = bot + 1
    g.put(x0, ay, "04:23", C_AXIS, tint)
    g.put(x0 + n // 2 - 2, ay, "04:28", C_AXIS, tint)
    g.put(ix + bw_cols - 5, ay, "04:33", C_AXIS, tint)
    g.put(ix + iw - 4, ay, "(ms)", C_AXIS, tint)
    if stats:
        g.put(ix, ay + 1, stats, C_MUTED, tint)


def series_ok(n, base, spread, seed, spike=None):
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        v = base + rnd.randint(-spread, spread) + int(spread * 0.6 * math.sin(i / 5))
        out.append(("ok", max(20, v)))
    if spike:
        for i in spike:
            out[i] = ("ok", 980 + rnd.randint(0, 300))
    return out


def build(bigmode="full", tint=True):
    W, H = 180, 50
    g = Grid(W, H)
    g.put(1, 0, "Handicap 모니터 · 운영 점검 보드", C_TEXT, None, True)
    g.put(W - 31, 0, "2026-11-08 04:33:57  점검 중", C_MUTED)
    g.put(1, H - 1, "←↑↓→ 칸 이동  ? 도움말  q 종료", C_MUTED)
    pw, ph = W // 3, (H - 2) // 2
    TH = [(700, "#facc15"), (1200, "#f97316")]
    n = 60
    slow = series_ok(n - 18, 420, 80, 2) + [("ok", 500 + i * 55) for i in range(18)]
    failp = series_ok(n - 22, 300, 60, 3) + [("fail", 0)] * 22
    trans = series_ok(n - 22, 250, 50, 4) + [("fail", 0)] * 22
    mixed = series_ok(n, 380, 90, 5, spike=[20, 21, 41])
    mixed[33] = ("fail", 0)
    ok1 = series_ok(n, 310, 70, 1)
    ok6 = series_ok(n, 160, 40, 6)
    TS = {"slow": "#2a1a0c", "fail": "#2a0e10"} if tint else {}
    specs = [
        ("로그인", "ok", "413", "ms", ok1, None, "평균 312 · 최대 498 ms"),
        ("결제 승인", "slow", "1,407", "ms", slow, None, "평균 612 · 최대 1,489 ms"),
        ("주문 조회", "fail", "HTTP 503", "", failp, "22회 연속 · 04:33:14부터", None),
        ("외부 연동", "fail", None, "", trans, "22회 연속 · 04:33:14부터", None),
        ("회원 등급 산정 배치 결과 조회 API", "ok", "1,086", "ms", mixed, None, "평균 402 · 최대 1,283 ms"),
        ("상품 목록", "ok", "152", "ms", ok6, None, "평균 160 · 최대 207 ms"),
    ]
    for k, (t, st, big, unit, ser, cons, stats) in enumerate(specs):
        px, py = (k % 3) * pw, 1 + (k // 3) * ph
        panel(g, px, py, pw, ph, t, st, big, unit, ser, TH, 1500, selected=(k == 0), cons=cons, stats=stats, bigmode=bigmode, tint=TS.get(st))
        if big is None:
            g.put(px + pw - 2 - 9, py + 4, "요청 실패", C_FAIL, TS.get(st), True)
    return g


if __name__ == "__main__":
    print(build(sys.argv[1] if len(sys.argv) > 1 else "full").html())
