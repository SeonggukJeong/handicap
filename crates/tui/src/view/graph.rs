//! 막대 그래프 순수 함수 — 열 글리프·기준선 줄·숫자 열 폭(spec §5.1·§5.3·§5.4).

use super::model::{Bar, BarKind, ThresholdView};
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
