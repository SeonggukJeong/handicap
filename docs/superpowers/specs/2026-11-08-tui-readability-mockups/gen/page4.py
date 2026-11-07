"""Fail-bar texture options, single panel each, option A scale."""
import sys

import grid
import page2
import page3
from grid import Grid
from page2 import BASE

# shade glyph rendering: approximate a terminal's stipple
SHADE = {"▓": 0.75, "▒": 0.5}
_orig = Grid.html


def put_fail_variant(variant):
    def bars(g, ix, iw, top, bot, series, tint, axis=True):
        orig_bars(g, ix, iw, top, bot, series, tint, axis)
        rows = bot - top + 1
        bw = iw - 7
        n = min(len(series), bw)
        x0 = ix + bw - n
        for i, (kind, _) in enumerate(series[-n:]):
            if kind != "fail":
                continue
            cx = x0 + i
            for r in range(rows):
                if variant == "solid":
                    ch, col = "█", "#ef4444"
                elif variant == "shade":
                    ch, col = "▓", "#ef4444"
                else:  # stripes: alternate columns full/shade + mark on top
                    ch, col = ("█" if (i + r) % 3 else "▒"), "#ef4444"
                g.put(cx, bot - r, ch, col, tint)
            if variant == "stripes":
                g.put(cx, top, "x", "#ffffff", "#ef4444", True)
    return bars


orig_bars = page2.bars


def panel(variant):
    page2.bars = put_fail_variant(variant)
    page2.frame = page3.frame_heavy
    g = page2.option_a(1.6)
    page2.bars = orig_bars
    pw, ph = g.w // 3, (g.h - 2) // 2
    sub = Grid(pw, ph)
    for y in range(ph):
        for x in range(pw):
            sub.c[y][x] = list(g.c[1 + y][2 * pw + x])
    return sub


def shade_html(self, scale=1.0):
    h = _orig(self, scale)
    return h


out = sys.argv[1]
cells = []
for v, name, desc in [
    ("solid", "꽉 찬 빨강", "지금 목업. 가장 강하지만 실패가 길면 칸이 빨간 벽이 됨."),
    ("shade", "촘촘한 점 무늬 (▓)", "빨강이지만 무늬가 있어 정상 막대와 질감이 다름. 글꼴에 따라 점 모양이 다르게 보임."),
    ("stripes", "빗금 흉내 + 맨 위 x", "GUI의 빨강 빗금·✖에 가장 가까움. 줄마다 어긋난 무늬로 대각선 느낌."),
]:
    cells.append(
        f'<div class="option" data-choice="{v}" onclick="toggleSelect(this)" style="flex-direction:column;align-items:flex-start">'
        f'<h3>{name}</h3><p>{desc}</p>{panel(v).html(BASE * 1.6)}</div>'
    )
frag = f"""
<h2>실패 막대 모양</h2>
<p class="subtitle">GUI는 실패 막대를 빨강 빗금 + 맨 위 ✖로 그립니다. 터미널에서 낼 수 있는 세 가지 (굵은 선 테두리, 글꼴 ×1.6 기준).</p>
<div class="options">{''.join(cells)}</div>
"""
open(out, "w", encoding="utf-8").write(frag)
print(out)
