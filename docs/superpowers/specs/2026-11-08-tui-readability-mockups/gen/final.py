"""Final agreed mockup: option A (zoom 1.6), heavy border, selected = inverted title, fail = stripes (no x)."""
import sys

import page2
import page3
from page2 import BASE


def stripes_bars(orig):
    def bars(g, ix, iw, top, bot, series, tint, axis=True):
        orig(g, ix, iw, top, bot, series, tint, axis)
        rows = bot - top + 1
        bw = iw - 7
        n = min(len(series), bw)
        x0 = ix + bw - n
        for i, (kind, _) in enumerate(series[-n:]):
            if kind != "fail":
                continue
            for r in range(rows):
                g.put(x0 + i, bot - r, "█" if (i + r) % 3 else "▒", "#ef4444", tint)
    return bars


def build(frame_fn):
    orig = page2.bars
    page2.bars = stripes_bars(orig)
    try:
        return page3.build(frame_fn)
    finally:
        page2.bars = orig


if __name__ == "__main__":
    out = sys.argv[1]
    heavy = build(page3.frame_heavy)
    block = build(page3.frame_block)
    frag = f"""
<h2>최종 합의 목업 (2026-11-08)</h2>
<p class="subtitle">6칸 보드 · 터미널 글꼴 ×1.6(1920×1080 전체화면 ≈ 112×31칸) · 굵은 선 테두리(기본) · 선택 칸 = 흰 바탕 제목 · 실패 막대 = 빨강 빗금(맨 위 x 없음) · 기준선 점선+오른쪽 숫자 · 응답 시간 큰 숫자 · 화면 표시 값은 큰 숫자 왼쪽. 데이터는 가짜.</p>
<div class="section"><h3>기본 — 굵은 선 테두리</h3>{heavy.html(BASE * 1.6)}</div>
<div class="section"><h3>b 키로 바꾼 상태 — 반 칸 블록 테두리</h3>{block.html(BASE * 1.6)}</div>
"""
    open(out, "w", encoding="utf-8").write(frag)
    print(out)
