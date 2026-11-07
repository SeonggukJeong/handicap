//! 뷰 모델 — 보드 설정 + 폴링 스냅샷 → 칸마다 그릴 값(GUI `MonitorPanel.tsx` 호출부 규칙).

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_controller::monitor::config::PanelConfig;
use ratatui::style::Color;

use crate::judge::{
    DEFAULT_BAR_COLOR, PanelState, PanelStateInput, ReasonParts, bar_color, bar_slots,
    big_value_text, format_hms, format_stat_num, latency_stats, panel_state, reason_parts,
    show_consecutive,
};
use crate::poll::PollSnapshot;
use crate::text;
use crate::wire::{BoardResponse, PanelStatus, StatusResponse};

pub const COLOR_FAIL: &str = "#ef4444";
pub const COLOR_GRAY_BAR: &str = "#475569";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BigValue {
    Text(String),
    Reason(ReasonParts),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarKind {
    Empty,
    Ok { latency_ms: u64 },
    Fail,
    ConfigError,
    Upstream,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bar {
    pub kind: BarKind,
    pub color: Color,
    /// 그 슬롯 결과의 `CheckResult.at_ms`, 빈 슬롯 `None`.
    pub at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdView {
    pub ms: u32,
    pub color: Color,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelView {
    pub title: String,
    pub state: PanelState,
    pub label: &'static str,
    pub big: BigValue,
    pub consecutive: Option<String>,
    /// `bar_slots` 전체(폭에 맞춰 자르기는 렌더에서).
    pub bars: Vec<Bar>,
    pub stats: Option<String>,
    pub display: Vec<String>,
    pub interval_seconds: u32,
    pub timeout_seconds: u32,
    pub graph_max_ms: u32,
    pub thresholds: Vec<ThresholdView>,
    /// 설정 기준 표시 항목 수(최대 2).
    pub n_display_items: usize,
    pub show_stats: bool,
}

/// 줄 종류. 파생 순서 = 화면 순서.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Row {
    Status,
    ReasonSmall,
    Consecutive,
    Bars,
    Axis,
    Stats,
    Display(usize),
}

/// 우선순위 Status > Bars > Axis > Consecutive > ReasonSmall > Stats > Display(0) > Display(1)로
/// `inner_h`줄만 고르고 화면 순서로 돌려준다.
pub fn panel_rows(
    inner_h: u16,
    has_reason_small: bool,
    has_consecutive: bool,
    has_stats: bool,
    n_display: usize,
) -> Vec<Row> {
    let mut order = vec![Row::Status, Row::Bars, Row::Axis];
    if has_consecutive {
        order.push(Row::Consecutive);
    }
    if has_reason_small {
        order.push(Row::ReasonSmall);
    }
    if has_stats {
        order.push(Row::Stats);
    }
    order.extend((0..n_display).map(Row::Display));
    order.truncate(usize::from(inner_h));
    order.sort();
    order
}

/// `#rrggbb` → `Color::Rgb`.
pub fn parse_hex(s: &str) -> Option<Color> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(Color::Rgb((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

fn rgb(hex: &str) -> Color {
    parse_hex(hex)
        .or_else(|| parse_hex(DEFAULT_BAR_COLOR))
        .unwrap_or(Color::Green)
}

fn bar_of(r: &CheckResult, p: &PanelConfig) -> Bar {
    let at_ms = Some(r.at_ms);
    match r.verdict {
        Verdict::Ok => {
            let ms = r.latency_ms.unwrap_or(0);
            Bar {
                kind: BarKind::Ok { latency_ms: ms },
                color: rgb(bar_color(ms, &p.thresholds)),
                at_ms,
            }
        }
        Verdict::Fail => Bar {
            kind: BarKind::Fail,
            color: rgb(COLOR_FAIL),
            at_ms,
        },
        Verdict::ConfigError => Bar {
            kind: BarKind::ConfigError,
            color: rgb(COLOR_GRAY_BAR),
            at_ms,
        },
        Verdict::UpstreamFailed => Bar {
            kind: BarKind::Upstream,
            color: rgb(COLOR_GRAY_BAR),
            at_ms,
        },
        Verdict::BranchSkipped => Bar {
            kind: BarKind::Skipped,
            color: rgb(COLOR_GRAY_BAR),
            at_ms,
        },
    }
}

fn display_values(p: &PanelConfig, state: PanelState, latest: Option<&CheckResult>) -> Vec<String> {
    let n = p.display_items.len().min(2);
    if n == 0 || !matches!(state, PanelState::Ok | PanelState::Slow | PanelState::Fail) {
        return Vec::new();
    }
    let at = |i: usize| -> Option<String> {
        latest
            .and_then(|l| l.display.get(i))
            .and_then(|v| v.clone())
            .filter(|v| !v.is_empty())
    };
    if state == PanelState::Fail && (0..n).all(|i| at(i).is_none()) {
        return Vec::new();
    }
    (0..n)
        .map(|i| at(i).unwrap_or_else(|| text::NO_VALUE.to_string()))
        .collect()
}

fn panel_view(
    p: &PanelConfig,
    show_stats: bool,
    st: Option<&StatusResponse>,
    status: Option<&PanelStatus>,
    server_down: bool,
) -> PanelView {
    let results: &[CheckResult] = status.map_or(&[], |s| s.results.as_slice());
    let latest = results.last();
    let state = match st {
        None if server_down => PanelState::Stale,
        None => PanelState::Pending,
        Some(st) => panel_state(&PanelStateInput {
            latest,
            now_ms: st.now_ms,
            started_at_ms: st.started_at_ms,
            enabled: st.enabled,
            server_down,
            interval_sec: p.interval_seconds,
            budget_sec: status.map_or(p.timeout_seconds, |s| s.check_budget_seconds),
            thresholds: &p.thresholds,
        }),
    };
    let big_text = big_value_text(state, latest);
    let big = match state {
        PanelState::Fail | PanelState::ConfigError | PanelState::Blocked | PanelState::Skipped => {
            BigValue::Reason(reason_parts(
                &big_text,
                latest.and_then(|l| l.detail.as_deref()),
            ))
        }
        _ => BigValue::Text(big_text),
    };
    let consecutive = match status {
        Some(s) if state == PanelState::Fail && show_consecutive(s.consecutive_fail) => s
            .fail_since_ms
            .map(|since| text::consecutive(s.consecutive_fail, &format_hms(since))),
        _ => None,
    };
    let stats =
        if show_stats && matches!(state, PanelState::Ok | PanelState::Slow | PanelState::Fail) {
            latency_stats(results).map(|(avg, max)| {
                format!(
                    "{} {} · {} {} ms",
                    text::STATS_AVG,
                    format_stat_num(avg as f64),
                    text::STATS_MAX,
                    format_stat_num(max as f64)
                )
            })
        } else {
            None
        };
    let bars = bar_slots(results, p.bar_count as usize)
        .into_iter()
        .map(|slot| match slot {
            Some(r) => bar_of(r, p),
            None => Bar {
                kind: BarKind::Empty,
                color: Color::Reset,
                at_ms: None,
            },
        })
        .collect();
    PanelView {
        title: p.title.clone(),
        state,
        label: text::state_label(state),
        big,
        consecutive,
        bars,
        stats,
        display: display_values(p, state, latest),
        interval_seconds: p.interval_seconds,
        timeout_seconds: p.timeout_seconds,
        graph_max_ms: p.graph_max_ms,
        thresholds: p
            .thresholds
            .iter()
            .map(|t| ThresholdView {
                ms: t.ms,
                color: rgb(&t.color),
            })
            .collect(),
        n_display_items: p.display_items.len().min(2),
        show_stats,
    }
}

/// 보드 설정 + 폴링 스냅샷 → 칸별 뷰. 스냅샷이 다른 보드 것이면 "status 아직 없음"으로 취급한다.
pub fn build_panels(board: &BoardResponse, snap: &PollSnapshot) -> Vec<PanelView> {
    let last = snap.last.as_ref().filter(|_| snap.board_id == board.id);
    board
        .config
        .panels
        .iter()
        .map(|p| {
            let status = last.and_then(|st| st.panels.iter().find(|ps| ps.panel_id == p.id));
            panel_view(
                p,
                board.config.show_latency_stats,
                last,
                status,
                snap.server_down,
            )
        })
        .collect()
}
