//! 막대 그래프 순수 함수 — 열 글리프·기준선 줄·숫자 열 폭(spec §5.1·§5.3·§5.4).

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};

use super::model::{Bar, BarKind, PanelView, ThresholdView};
use super::text_width;
use crate::judge::format_stat_num;

/// 막대 폭 하한 — 숫자 열을 두면 막대가 이보다 좁아질 때 열을 없앤다.
pub const MIN_BAR_W: u16 = 12;
/// 기준선을 그리는 최소 막대 줄 수.
pub const MIN_THRESHOLD_ROWS: u16 = 3;

const BLOCKS: [char; 7] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];

/// 높이 `steps`(1줄 = 8단계)를 아래에서부터 채운 열.
fn filled(steps: u32, rows: u16) -> Vec<Option<char>> {
    let full = (steps / 8) as usize;
    let rem = (steps % 8) as usize;
    (0..usize::from(rows))
        .map(|r| {
            if r < full {
                Some('█')
            } else if r == full && rem != 0 {
                Some(BLOCKS[rem - 1])
            } else {
                None
            }
        })
        .collect()
}

/// 막대 한 개의 열 — index 0 = 맨 아래 줄. `None` = 빈 글자 칸.
// `is_multiple_of`는 rust-version 1.88에 없어 `%`를 유지한다.
#[allow(clippy::manual_is_multiple_of)]
pub fn column(bar: &Bar, rows: u16, graph_max_ms: u32, x: usize) -> Vec<Option<char>> {
    let total = u32::from(rows) * 8;
    match bar.kind {
        BarKind::Empty => vec![None; usize::from(rows)],
        BarKind::Ok { latency_ms } => {
            let max = u64::from(graph_max_ms.max(1));
            let ms = latency_ms.min(max);
            let e = ((ms as f64 / max as f64) * f64::from(total)).round() as u32;
            filled(e.max(1), rows)
        }
        BarKind::Fail | BarKind::ConfigError => (0..usize::from(rows))
            .map(|r| Some(if (x + r) % 3 == 0 { '▒' } else { '█' }))
            .collect(),
        BarKind::Upstream => {
            let e = (f64::from(total) * 0.12).round() as u32;
            filled(e.max(1), rows)
        }
        BarKind::Skipped => (0..usize::from(rows))
            .map(|r| if r == 0 { Some('·') } else { None })
            .collect(),
    }
}

/// (아래에서부터 줄 번호, 기준선) — 같은 줄이면 높은 기준선만, 아래→위 순.
pub fn threshold_rows(
    th: &[ThresholdView],
    graph_max_ms: u32,
    rows: u16,
) -> Vec<(u16, ThresholdView)> {
    if rows == 0 {
        return Vec::new();
    }
    let max = u64::from(graph_max_ms.max(1));
    let mut sorted: Vec<&ThresholdView> = th.iter().collect();
    sorted.sort_by_key(|t| t.ms);
    let mut out: Vec<(u16, ThresholdView)> = Vec::new();
    for t in sorted {
        let row = (u64::from(t.ms) * u64::from(rows) / max).min(u64::from(rows) - 1) as u16;
        match out.last_mut() {
            Some(last) if last.0 == row => *last = (row, t.clone()),
            _ => out.push((row, t.clone())),
        }
    }
    out
}

/// 숫자 열 폭(0 = 열 없음). `draw=false`거나 기준선 없음 → 0. 열을 두면 막대 폭(`inner_w - (열 + 구분 1칸)`) < `MIN_BAR_W`일 때 0.
pub fn label_width(th: &[ThresholdView], inner_w: u16, draw: bool) -> u16 {
    if !draw || th.is_empty() {
        return 0;
    }
    let widest = th
        .iter()
        .map(|t| text_width(&format_stat_num(f64::from(t.ms))))
        .max()
        .unwrap_or(0);
    let w = u16::try_from(widest).unwrap_or(u16::MAX).max(4);
    if inner_w.saturating_sub(w + 1) < MIN_BAR_W {
        0
    } else {
        w
    }
}

/// 막대 영역(`area` = 숫자 열 포함 폭 × 막대 줄 수)을 그린다. 막대는 숫자 열을 뺀 폭 `W`의
/// 오른쪽 끝에 붙이고, 기준선은 막대 글리프가 없는 글자 칸에만 점선으로 긋는다.
/// 반환 = 막대들이 놓인 가로 범위(시각 줄이 같은 범위에 그린다).
pub fn render_graph(
    f: &mut Frame,
    area: Rect,
    v: &PanelView,
    draw_thresholds: bool,
    label_w: u16,
) -> Rect {
    let w = if label_w > 0 {
        area.width.saturating_sub(label_w + 1)
    } else {
        area.width
    };
    let rows = area.height;
    let visible = v.bars.len().min(usize::from(w));
    let bars = &v.bars[v.bars.len() - visible..];
    let x0 = area.x + w - visible as u16;
    let range = Rect::new(x0, area.y, visible as u16, rows);
    if rows == 0 || w == 0 {
        return range;
    }
    let th_rows = if draw_thresholds {
        threshold_rows(&v.thresholds, v.graph_max_ms, rows)
    } else {
        Vec::new()
    };
    let cols: Vec<Vec<Option<char>>> = bars
        .iter()
        .enumerate()
        .map(|(i, b)| column(b, rows, v.graph_max_ms, i))
        .collect();
    // 바탕(느림·실패 물들이기)은 칸 테두리 `Block::style`이 칸 전체에 이미 칠했다 — 여기선 글자·
    // 글자색만 바꾸므로(`set_char`·`set_fg`·bg 없는 `set_string`) 그 바탕이 그대로 남는다.
    let buf = f.buffer_mut();
    let y_of = |r: u16| area.y + rows - 1 - r;
    for r in 0..rows {
        let y = y_of(r);
        let dash = th_rows
            .iter()
            .find(|(tr, _)| *tr == r)
            .map(|(_, t)| t.color);
        for x in 0..w {
            let cell = &mut buf[(area.x + x, y)];
            let glyph = x.checked_sub(w - visible as u16).and_then(|j| {
                let j = usize::from(j);
                cols[j][usize::from(r)].map(|ch| (ch, bars[j].color))
            });
            match (glyph, dash) {
                (Some((ch, c)), _) => {
                    cell.set_char(ch).set_fg(c);
                }
                (None, Some(c)) => {
                    cell.set_char('╌').set_fg(c);
                }
                _ => {}
            }
        }
    }
    if label_w > 0 && draw_thresholds {
        let lx = area.x + w + 1;
        for (r, t) in &th_rows {
            let text = format_stat_num(f64::from(t.ms));
            let tw = text_width(&text) as u16;
            if tw > label_w {
                continue;
            }
            buf.set_string(
                lx + label_w - tw,
                y_of(*r),
                &text,
                Style::default().fg(t.color).add_modifier(Modifier::BOLD),
            );
        }
    }
    range
}
