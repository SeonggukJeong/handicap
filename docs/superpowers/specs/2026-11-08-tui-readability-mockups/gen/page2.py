"""Option A (terminal font zoom) vs option B (pixel Hangul) at the same physical width."""
import json
import math
import random
import sys

from grid import Grid, cw
from propose import FONT, big_width, draw_big, bar_color, series_ok, C_TEXT, C_MUTED, C_AXIS, C_OK, C_FAIL, C_GRAYB

HJ = json.loads(json.loads(open("/Users/sgj/develop/handicap/.claude/worktrees/tui-readability/.playwright-mcp/hangul.json").read()))
BASE = 0.92  # same physical size as page 1 (180 cols)
TH = [(700, "#facc15"), (1200, "#f97316")]
GMAX = 1500


def tw(s):
    return sum(cw(c) for c in s)


def draw_pix(g, x, y, rows, color, bg):
    """bitmap rows -> half blocks (1 col x half row per pixel)."""
    if len(rows) % 2:
        rows = rows + ["." * len(rows[0])]
    for r in range(0, len(rows), 2):
        for c in range(len(rows[0])):
            t, b = rows[r][c] == "#", rows[r + 1][c] == "#"
            gl = "█" if t and b else "▀" if t else "▄" if b else None
            if gl:
                g.put(x + c, y + r // 2, gl, color, bg)
    return (len(rows) + 1) // 2, len(rows[0])


def frame(g, x, y, w, h, sc, tint, sel):
    if tint:
        g.bg(x, y, x + w, y + h, tint)
    hz, vt = ("━", "┃") if sel else ("─", "│")
    tl, tr, bl, br = ("┏", "┓", "┗", "┛") if sel else ("┌", "┐", "└", "┘")
    g.put(x, y, tl + hz * (w - 2) + tr, sc, tint)
    g.put(x, y + h - 1, bl + hz * (w - 2) + br, sc, tint)
    for r in range(1, h - 1):
        g.put(x, y + r, vt, sc, tint)
        g.put(x + w - 1, y + r, vt, sc, tint)


def bars(g, ix, iw, top, bot, series, tint, axis=True):
    rows = bot - top + 1
    lab_w = 6
    bw = iw - lab_w - 1
    n = min(len(series), bw)
    vis = series[-n:]
    x0 = ix + bw - n
    for t, c in TH:
        f = t / GMAX * rows
        if f >= rows:
            continue
        ry = bot - int(f)
        for cx in range(ix, ix + bw):
            g.put(cx, ry, "╌", c, tint)
        num = f"{t:,}"
        g.put(ix + iw - len(num), ry, num, c, tint, True)
    for i, (kind, ms) in enumerate(vis):
        cx = x0 + i
        if kind == "fail":
            for r in range(rows):
                g.put(cx, bot - r, "█", C_FAIL, tint)
            continue
        e = max(1, round(min(ms, GMAX) / GMAX * rows * 8))
        col = bar_color(ms, TH)
        full, part = divmod(e, 8)
        for r in range(full):
            g.put(cx, bot - r, "█", col, tint)
        if part and full < rows:
            g.put(cx, bot - full, "▁▂▃▄▅▆▇"[part - 1], col, tint)
    if axis:
        ay = bot + 1
        g.put(x0, ay, "04:23", C_AXIS, tint)
        if n > 24:
            g.put(x0 + n // 2 - 2, ay, "04:28", C_AXIS, tint)
        g.put(ix + bw - 5, ay, "04:33", C_AXIS, tint)
        g.put(ix + iw - 4, ay, "(ms)", C_AXIS, tint)


def data():
    n = 60
    slow = series_ok(n - 18, 420, 80, 2) + [("ok", 500 + i * 55) for i in range(18)]
    failp = series_ok(n - 22, 300, 60, 3) + [("fail", 0)] * 22
    trans = series_ok(n - 22, 250, 50, 4) + [("fail", 0)] * 22
    mixed = series_ok(n, 380, 90, 5, spike=[20, 21, 41])
    mixed[33] = ("fail", 0)
    return [
        # title, state, big, unit, series, cons, stats, display values
        ("로그인", "ok", "413", "ms", series_ok(n, 310, 70, 1), None, "평균 312 · 최대 498 ms", []),
        ("결제 승인", "slow", "1,407", "ms", slow, None, "평균 612 · 최대 1,489 ms", []),
        ("주문 조회", "fail", "HTTP 503", "", failp, "22회 연속 · 04:33:14부터", None, []),
        ("외부 연동", "fail", "요청 실패", "", trans, "22회 연속 · 04:33:14부터", None, []),
        ("회원 등급 조회", "ok", "1,086", "ms", mixed, None, "평균 402 · 최대 1,283 ms", ["VIP", "정상 영업"]),
        ("재고 조회", "ok", "152", "ms", series_ok(n, 160, 40, 6), None, "평균 160 · 최대 207 ms", ["1,204", "입고 대기"]),
    ]


LABEL = {"ok": "✔ 정상", "slow": "▲ 느림", "fail": "✖ 실패"}
TINT = {"slow": "#2a1a0c", "fail": "#2a0e10"}


def state_color(st, series):
    return {"ok": C_OK, "fail": C_FAIL}.get(st) or bar_color(series[-1][1], TH)


def header(g, W, H):
    g.put(1, 0, "Handicap 모니터 · 운영 점검 보드", C_TEXT, None, True)
    s = "04:33:57  점검 중"
    g.put(W - tw(s) - 1, 0, s, C_MUTED)
    g.put(1, H - 1, "←↑↓→ 칸 이동  ? 도움말  q 종료", C_MUTED)


def option_a(zoom):
    W, H = round(180 / zoom), round(50 / zoom)
    g = Grid(W, H)
    header(g, W, H)
    pw, ph = W // 3, (H - 2) // 2
    for k, (t, st, big, unit, ser, cons, stats, disp) in enumerate(data()):
        x, y = (k % 3) * pw, 1 + (k // 3) * ph
        sc = state_color(st, ser)
        tint = TINT.get(st)
        frame(g, x, y, pw, ph, sc, tint, k == 0)
        ix, iw, iy = x + 2, pw - 4, y + 1
        g.put(ix, iy, t, C_TEXT, tint, True)
        g.put(ix + iw - tw(LABEL[st]), iy, LABEL[st], sc, tint, True)
        bigc = C_TEXT if st == "ok" else sc
        by = iy + 1
        ascii_big = all(c in FONT for c in big)
        uw = tw(unit) + 1 if unit else 0
        if ascii_big:
            bw = sum(len(FONT[c][0]) + 1 for c in big) - 1
            draw_big(g, ix + iw - bw - uw, by, big, bigc, "half")
            if unit:
                g.put(ix + iw - uw + 1, by + 2, unit, bigc, tint, True)
        else:
            g.put(ix + iw - tw(big), by + 1, big, bigc, tint, True)
        for i, v in enumerate(disp[:2]):
            g.put(ix, by + i, v, C_TEXT if i == 0 else "#cbd5e1", tint, True)
        ny = by + 3
        if cons:
            g.put(ix, ny, cons, C_FAIL, tint)
        bot = y + ph - 2 - (1 if stats else 0) - 1
        bars(g, ix, iw, ny + 1, bot, ser, tint)
        if stats:
            g.put(ix, bot + 2, stats, C_MUTED, tint)
    return g


def option_b():
    W, H = 180, 50
    g = Grid(W, H)
    header(g, W, H)
    pw, ph = W // 3, (H - 2) // 2
    for k, (t, st, big, unit, ser, cons, stats, disp) in enumerate(data()):
        x, y = (k % 3) * pw, 1 + (k // 3) * ph
        sc = state_color(st, ser)
        tint = TINT.get(st)
        frame(g, x, y, pw, ph, sc, tint, k == 0)
        ix, iw, iy = x + 2, pw - 4, y + 1
        g.put(ix, iy, t, C_TEXT, tint, True)
        word = LABEL[st].split()[1]
        bigc = C_TEXT if st == "ok" else sc
        hrows, hw = draw_pix(g, ix, iy + 1, HJ["16:" + word], sc, tint)
        by = iy + 1 + hrows
        if all(c in FONT for c in big) and big_width(big) + 3 <= iw:
            bw = big_width(big)
            uw = tw(unit) + 1 if unit else 0
            draw_big(g, ix + iw - bw - uw, by, big, bigc, "full")
            if unit:
                g.put(ix + iw - uw + 1, by + 4, unit, bigc, tint, True)
            bh = 5
        elif all(c in FONT for c in big):
            bw = sum(len(FONT[c][0]) + 1 for c in big) - 1
            draw_big(g, ix + iw - bw, by, big, bigc, "half")
            bh = 3
        else:
            key = "12:" + big
            r, w = len(HJ[key]) // 2 + 1, len(HJ[key][0])
            draw_pix(g, ix + iw - w, by, HJ[key], bigc, tint)
            bh = r
        for i, v in enumerate(disp[:2]):
            g.put(ix, by + 1 + i, v, C_TEXT if i == 0 else "#cbd5e1", tint, True)
        ny = by + bh
        if cons:
            g.put(ix, ny, cons, C_FAIL, tint)
        bot = y + ph - 2 - (1 if stats else 0) - 1
        bars(g, ix, iw, ny + 1, bot, ser, tint)
        if stats:
            g.put(ix, bot + 2, stats, C_MUTED, tint)
    return g


def main():
    out = sys.argv[1]
    z = 1.6
    a = option_a(z)
    b = option_b()
    frag = f"""
    <h2>한글을 크게 — 두 가지 방법 (같은 1920×1080 화면 기준)</h2>
    <p class="subtitle">"응답 값"은 칸에 설정한 <b>벽 표시 값</b>(응답 본문에서 뽑은 값, 예: <code>VIP</code>·<code>정상 영업</code>)으로 이해했습니다 — 아래 '회원 등급 조회'·'재고 조회' 칸 왼쪽 위. 둘 다 같은 실제 화면 폭으로 그렸으니 글자 크기를 그대로 비교하세요.</p>
    <div class="options">
    <div class="option" data-choice="a" onclick="toggleSelect(this)"><div class="letter">A</div><div class="content">
    <h3>터미널 글꼴 자체를 키움 (×1.6 — 화면 {a.w}×{a.h}칸)</h3>
    <p>모든 글자(한글·응답 값·사유·시각)가 1.6배. 자동 시작 줄의 <code>--zoom</code> 값 하나로 정하고, 화면은 칸 수가 줄어든 만큼 배치를 맞춤. 큰 숫자는 3줄 높이, 막대는 조금 낮아짐.</p>
    </div></div>
    <div class="option" data-choice="b" onclick="toggleSelect(this)"><div class="letter">B</div><div class="content">
    <h3>글꼴은 그대로, 상태 문구만 픽셀 한글로 크게 (화면 180×50칸)</h3>
    <p>정상·느림·실패 같은 정해진 단어는 미리 그려 넣어 크게. 다만 <b>응답 값·실패 사유 같은 임의 한글</b>까지 크게 하려면 한글 비트맵 글꼴 전체를 프로그램에 넣어야 하고, 칸 폭을 많이 차지함. 나머지 글자는 지금처럼 작음.</p>
    </div></div>
    </div>
    <div class="section"><h3>A — 글꼴 ×1.6</h3>{a.html(BASE * z)}</div>
    <div class="section"><h3>B — 글꼴 그대로 + 픽셀 한글 상태 문구</h3>{b.html(BASE)}</div>
    """
    open(out, "w", encoding="utf-8").write(frag)
    print(out, a.w, a.h)


if __name__ == "__main__":
    main()
