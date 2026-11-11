//! 화면 판정 규칙 — `ui/src/monitor/logic.ts`·`display.ts`의 1:1 이식(순수 함수).

use chrono::{Local, TimeZone};
use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_controller::monitor::config::Threshold;

use crate::text::{NO_VALUE, NOT_CONTAINED_TAIL};

pub const DEFAULT_BAR_COLOR: &str = "#22c55e";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelState {
    Ok,
    Slow,
    Fail,
    ConfigError,
    Blocked,
    Skipped,
    Stale,
    StaleOff,
    Pending,
}

// `is_multiple_of`는 rust-version 1.88에 없어 `%`를 유지한다.
#[allow(clippy::manual_is_multiple_of)]
fn with_commas(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// 정수 ms + 천 단위 쉼표(`1,350`), 단위 없음.
pub fn format_stat_num(ms: f64) -> String {
    with_commas(ms.round().max(0.0) as u64)
}

/// `1,350 ms`
pub fn format_ms(ms: f64) -> String {
    format!("{} ms", format_stat_num(ms))
}

/// 넘은 임계값 중 가장 높은 것의 색(임계값은 오름차순), 없으면 초록.
pub fn bar_color(latency_ms: u64, thresholds: &[Threshold]) -> &str {
    let mut color = DEFAULT_BAR_COLOR;
    for t in thresholds {
        if latency_ms >= u64::from(t.ms) {
            color = &t.color;
        }
    }
    color
}

pub fn stale_after_ms(interval_sec: u32, budget_sec: u32) -> i64 {
    (i64::from(interval_sec) * 3 + i64::from(budget_sec) + 5) * 1000
}

pub struct PanelStateInput<'a> {
    pub latest: Option<&'a CheckResult>,
    pub now_ms: i64,
    pub started_at_ms: Option<i64>,
    pub enabled: bool,
    pub server_down: bool,
    pub interval_sec: u32,
    pub budget_sec: u32,
    pub thresholds: &'a [Threshold],
}

pub fn panel_state(i: &PanelStateInput) -> PanelState {
    if i.server_down {
        return PanelState::Stale;
    }
    if !i.enabled {
        return PanelState::StaleOff;
    }
    let reference = match i.latest {
        Some(l) => Some(l.at_ms),
        None => i.started_at_ms,
    };
    if let Some(r) = reference
        && i.now_ms - r >= stale_after_ms(i.interval_sec, i.budget_sec)
    {
        return PanelState::Stale;
    }
    let Some(latest) = i.latest else {
        return PanelState::Pending;
    };
    match latest.verdict {
        Verdict::Fail => return PanelState::Fail,
        Verdict::ConfigError => return PanelState::ConfigError,
        Verdict::UpstreamFailed => return PanelState::Blocked,
        Verdict::BranchSkipped => return PanelState::Skipped,
        Verdict::Ok => {}
    }
    if let Some(ms) = latest.latency_ms
        && i.thresholds.iter().any(|t| ms >= u64::from(t.ms))
    {
        return PanelState::Slow;
    }
    PanelState::Ok
}

/// `bar_count`칸, 오른쪽부터 채움 — 최신이 항상 마지막 칸, 빈 칸이 앞, 넘치면 오래된 것 제거.
pub fn bar_slots(results: &[CheckResult], bar_count: usize) -> Vec<Option<&CheckResult>> {
    let kept = if results.len() > bar_count {
        &results[results.len() - bar_count..]
    } else {
        results
    };
    let mut slots: Vec<Option<&CheckResult>> = vec![None; bar_count - kept.len()];
    slots.extend(kept.iter().map(Some));
    slots
}

/// ok 판정이면서 latency가 있는 결과의 (평균 반올림, 최대). 없으면 None.
pub fn latency_stats(results: &[CheckResult]) -> Option<(u64, u64)> {
    let ms: Vec<u64> = results
        .iter()
        .filter(|r| r.verdict == Verdict::Ok)
        .filter_map(|r| r.latency_ms)
        .collect();
    if ms.is_empty() {
        return None;
    }
    let sum: u64 = ms.iter().sum();
    let avg = (sum as f64 / ms.len() as f64).round() as u64;
    Some((avg, ms.iter().copied().max().unwrap_or(0)))
}

/// (cols, rows)
pub fn grid_for(n: usize) -> (usize, usize) {
    match n {
        0 | 1 => (1, 1),
        2 => (2, 1),
        3 => (3, 1),
        4 => (2, 2),
        5 | 6 => (3, 2),
        _ => (3, 3),
    }
}

pub fn show_consecutive(n: u32) -> bool {
    n >= 2
}

pub fn big_value_text(state: PanelState, latest: Option<&CheckResult>) -> String {
    match state {
        PanelState::Ok | PanelState::Slow => match latest.and_then(|l| l.latency_ms) {
            Some(ms) => format_ms(ms as f64),
            None => NO_VALUE.to_string(),
        },
        PanelState::Fail | PanelState::ConfigError | PanelState::Blocked | PanelState::Skipped => {
            latest
                .and_then(|l| l.reason.clone())
                .unwrap_or_else(|| NO_VALUE.to_string())
        }
        _ => NO_VALUE.to_string(),
    }
}

/// 실패 사유는 고정 사유 + 선택적 ` · {스텝 이름}` — 첫 구분자에서 자른다.
pub fn split_reason(reason: &str) -> (String, Option<String>) {
    match reason.split_once(" · ") {
        Some((fixed, step)) => (fixed.to_string(), Some(step.to_string())),
        None => (reason.to_string(), None),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasonParts {
    Split { fixed: String, step: Option<String> },
    Detail { big: String, small: String },
    NotContained { needle: String, small: String },
}

const NOT_CONTAINED_HEAD: &str = "본문 전체 글자 포함 ";

pub fn reason_parts(reason: &str, detail: Option<&str>) -> ReasonParts {
    let Some(detail) = detail else {
        let (fixed, step) = split_reason(reason);
        return ReasonParts::Split { fixed, step };
    };
    // TS: reason.length >= 1 + TAIL.length (UTF-16 길이) — 바이트로는 접두 `"`(1) + 꼬리.
    if detail.starts_with(NOT_CONTAINED_HEAD)
        && reason.len() > NOT_CONTAINED_TAIL.len()
        && reason.starts_with('"')
        && reason.ends_with(NOT_CONTAINED_TAIL)
    {
        return ReasonParts::NotContained {
            needle: reason[1..reason.len() - NOT_CONTAINED_TAIL.len()].to_string(),
            small: detail.to_string(),
        };
    }
    ReasonParts::Detail {
        big: reason.to_string(),
        small: detail.to_string(),
    }
}

fn local_fmt(ms: i64, fmt: &str) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(t) => t.format(fmt).to_string(),
        None => fmt
            .replace("%Y", "0000")
            .replace("%m", "00")
            .replace("%d", "00")
            .replace("%H", "00")
            .replace("%M", "00")
            .replace("%S", "00"),
    }
}

/// 로컬 시각 `HH:MM:SS`
pub fn format_hms(ms: i64) -> String {
    local_fmt(ms, "%H:%M:%S")
}

/// 로컬 시각 `HH:MM`
pub fn format_hm(ms: i64) -> String {
    local_fmt(ms, "%H:%M")
}

/// 로컬 `YYYY-MM-DD HH:MM:SS`(GUI `formatDateHms`).
pub fn format_date_hms(ms: i64) -> String {
    local_fmt(ms, "%Y-%m-%d %H:%M:%S")
}
