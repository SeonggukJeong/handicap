"""Border thickness options on option A (zoom 1.6)."""
import sys

import page2
from page2 import BASE, LABEL, tw

C_SEL = "#f2f5f8"


def frame_heavy(g, x, y, w, h, sc, tint, sel):
    if tint:
        g.bg(x, y, x + w, y + h, tint)
    g.put(x, y, "┏" + "━" * (w - 2) + "┓", sc, tint)
    g.put(x, y + h - 1, "┗" + "━" * (w - 2) + "┛", sc, tint)
    for r in range(1, h - 1):
        g.put(x, y + r, "┃", sc, tint)
        g.put(x + w - 1, y + r, "┃", sc, tint)


def frame_block(g, x, y, w, h, sc, tint, sel):
    if tint:
        g.bg(x, y, x + w, y + h, tint)
    g.put(x, y, "▛" + "▀" * (w - 2) + "▜", sc, tint)
    g.put(x, y + h - 1, "▙" + "▄" * (w - 2) + "▟", sc, tint)
    for r in range(1, h - 1):
        g.put(x, y + r, "▌", sc, tint)
        g.put(x + w - 1, y + r, "▐", sc, tint)


def build(frame_fn):
    page2.frame = frame_fn
    g = page2.option_a(1.6)
    # selected panel (0): title as an inverted badge instead of a different border
    pw = g.w // 3
    t = "로그인"
    tint = None
    g.put(1, 2, " ▶ " + t + " ", "#0b0f14", C_SEL, True)
    return g


out = sys.argv[1]
a = build(frame_heavy)
b = build(frame_block)
frag = f"""
<h2>테두리 굵기 — 두 가지 (A안 글꼴 ×1.6 기준)</h2>
<p class="subtitle">상태 문구는 지금 크기 그대로 두고 테두리로 눈에 띄게. 테두리를 모든 칸에서 굵게 쓰면 '선택한 칸' 표시를 다른 방법으로 해야 해서, 선택한 칸(로그인)은 제목을 흰 바탕 글자(▶ 로그인)로 표시해 봤습니다.</p>
<div class="options">
<div class="option" data-choice="heavy" onclick="toggleSelect(this)"><div class="letter">1</div><div class="content">
<h3>굵은 선 (━ ┃)</h3><p>지금 선택한 칸에만 쓰던 굵은 선 문자를 모든 칸에. 선 두께는 글꼴에 따라 1.5~2배 정도.</p></div></div>
<div class="option" data-choice="block" onclick="toggleSelect(this)"><div class="letter">2</div><div class="content">
<h3>반 칸 두께 블록 (▀ ▌)</h3><p>글자 칸의 절반을 색으로 채운 띠. 훨씬 두껍고 멀리서도 색이 덩어리로 보임.</p></div></div>
</div>
<div class="section"><h3>1 — 굵은 선</h3>{a.html(BASE * 1.6)}</div>
<div class="section"><h3>2 — 반 칸 블록</h3>{b.html(BASE * 1.6)}</div>
"""
open(out, "w", encoding="utf-8").write(frag)
print(out)
