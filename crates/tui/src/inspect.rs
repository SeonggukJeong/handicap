//! 오류 보기 — 화면 상태와 순수 줄 모델(spec §5.3). 그리기는 `view::inspect`.

use std::collections::{HashMap, HashSet};

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_controller::monitor::config::Threshold;

use crate::api::ApiError;
use crate::judge::PanelState;
use crate::wire::CheckRecord;

/// 목록 한 줄의 사유 칸.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    Known {
        reason: Option<String>,
        detail: Option<String>,
    },
    Loading,
    /// 404 — 기록이 이미 지워짐.
    Gone,
    /// `ApiError.message`
    Failed(String),
}

/// 화면에 그리는 **모든 원격 문자열**(사유·판정 상세·이름·URL·오류·본문)이 거친다. 탭 → 공백 4칸, CR 제거,
/// 그 밖의 `char::is_control`(ESC 포함)·U+2028/2029 → `�`. 줄바꿈(`\n`)은 호출 쪽이 먼저 나눈다.
pub fn sanitize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\t' => out.push_str("    "),
            '\r' => {}
            '\u{2028}' | '\u{2029}' => out.push('\u{FFFD}'),
            c if c.is_control() => out.push('\u{FFFD}'),
            c => out.push(c),
        }
    }
    out
}

/// 실패류(목록 "실패만"에 드는 회차) — Fail | ConfigError | UpstreamFailed.
pub fn is_failure(v: Verdict) -> bool {
    matches!(
        v,
        Verdict::Fail | Verdict::ConfigError | Verdict::UpstreamFailed
    )
}

/// 한 회차의 상태 — 벽과 같은 규칙(`judge::panel_state`의 verdict·기준선 부분).
pub fn row_state(r: &CheckResult, thresholds: &[Threshold]) -> PanelState {
    match r.verdict {
        Verdict::Fail => PanelState::Fail,
        Verdict::ConfigError => PanelState::ConfigError,
        Verdict::UpstreamFailed => PanelState::Blocked,
        Verdict::BranchSkipped => PanelState::Skipped,
        Verdict::Ok => match r.latency_ms {
            Some(ms) if thresholds.iter().any(|t| ms >= u64::from(t.ms)) => PanelState::Slow,
            _ => PanelState::Ok,
        },
    }
}

/// 최신 순. `show_all == false`면 실패류만.
pub fn error_results(results: &[CheckResult], show_all: bool) -> Vec<&CheckResult> {
    results
        .iter()
        .rev()
        .filter(|r| show_all || is_failure(r.verdict))
        .collect()
}

/// 목록(최신 순 at_ms)에서 커서 줄 번호. None → 0. 있으면 그 줄. 없으면 그보다 오래된 첫 줄,
/// 그것도 없으면 마지막 줄. 빈 목록 → 0.
pub fn cursor_index(rows_at: &[i64], cursor_at: Option<i64>) -> usize {
    let Some(at) = cursor_at else {
        return 0;
    };
    if let Some(i) = rows_at.iter().position(|&a| a == at) {
        return i;
    }
    rows_at
        .iter()
        .position(|&a| a < at)
        .unwrap_or(rows_at.len().saturating_sub(1))
}

/// 커서를 `delta`줄 옮긴 뒤의 at_ms(양 끝에서 멈춤). 빈 목록 → None.
pub fn move_cursor(rows_at: &[i64], cursor_at: Option<i64>, delta: isize) -> Option<i64> {
    if rows_at.is_empty() {
        return None;
    }
    let idx = cursor_index(rows_at, cursor_at) as isize;
    let last = rows_at.len() as isize - 1;
    let new = idx.saturating_add(delta).clamp(0, last);
    Some(rows_at[new as usize])
}

/// 커서가 보이는 창의 첫 줄(상태 없이 계산).
pub fn window_start(cursor: usize, len: usize, height: usize) -> usize {
    if height == 0 {
        return 0;
    }
    cursor
        .saturating_sub(height / 2)
        .min(len.saturating_sub(height))
}

/// 기록 조회 결과 → 사유 칸. 404 → Gone, 그 밖의 오류 → Failed(message).
pub fn reason_of(r: Result<CheckRecord, ApiError>) -> Reason {
    match r {
        Ok(rec) => Reason::Known {
            reason: rec.result.reason,
            detail: rec.result.detail,
        },
        Err(e) if e.status == Some(404) => Reason::Gone,
        Err(e) => Reason::Failed(e.message),
    }
}

/// 예전 회차의 사유(기록 조회로 채운다). 키 = at_ms.
#[derive(Debug, Default)]
pub struct ReasonCache {
    map: HashMap<i64, Reason>,
}

impl ReasonCache {
    /// 최신 결과(`/status`가 사유를 싣는다)와 Ok는 조회 없이 `r`에서, 나머지는 캐시(없으면 Loading).
    pub fn reason_for(&self, r: &CheckResult, is_latest: bool) -> Reason {
        if is_latest || r.verdict == Verdict::Ok {
            return Reason::Known {
                reason: r.reason.clone(),
                detail: r.detail.clone(),
            };
        }
        self.map.get(&r.at_ms).cloned().unwrap_or(Reason::Loading)
    }

    /// `visible` 중 조회가 필요한 at_ms(최신 아님 ∧ Ok 아님 ∧ 캐시에 없음).
    pub fn wanted(&self, visible: &[&CheckResult], latest_at: Option<i64>) -> Vec<i64> {
        visible
            .iter()
            .filter(|r| Some(r.at_ms) != latest_at)
            .filter(|r| r.verdict != Verdict::Ok)
            .filter(|r| !self.map.contains_key(&r.at_ms))
            .map(|r| r.at_ms)
            .collect()
    }

    pub fn mark_loading(&mut self, at: &[i64]) {
        for &a in at {
            self.map.insert(a, Reason::Loading);
        }
    }

    pub fn put(&mut self, at_ms: i64, r: Reason) {
        self.map.insert(at_ms, r);
    }

    /// 막대 구간에서 밀려난 회차 제거.
    pub fn retain(&mut self, alive: &HashSet<i64>) {
        self.map.retain(|at, _| alive.contains(at));
    }
}

/// 오류 목록 화면 상태 — 보드·칸·보기 모드·커서(at_ms 고정)·사유 캐시.
#[derive(Debug, Default)]
pub struct ErrorsState {
    pub board_id: String,
    pub panel_id: String,
    pub show_all: bool,
    pub cursor_at: Option<i64>,
    pub cache: ReasonCache,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorRow {
    pub at_ms: i64,
    pub state: PanelState,
    pub latency_ms: Option<u64>,
    pub reason: Reason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorsView {
    /// 칸 제목
    pub title: String,
    /// 보이는 창만
    pub rows: Vec<ErrorRow>,
    /// 창 안 줄 번호(목록이 비면 None)
    pub cursor: Option<usize>,
    /// 막대 구간의 실패류 회차 수
    pub failures: usize,
    /// 막대 구간 전체 회차 수
    pub total: usize,
    /// total × interval_seconds (명목 구간)
    pub span_secs: u64,
    pub show_all: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ErrorsInput<'a> {
    pub title: &'a str,
    pub results: &'a [CheckResult],
    pub thresholds: &'a [Threshold],
    pub interval_seconds: u32,
}

/// (목록 전체, 창 첫 줄, 커서 줄 번호) — `errors_view`·`visible_results`가 같은 창을 쓴다.
fn window<'a>(
    results: &'a [CheckResult],
    st: &ErrorsState,
    height: usize,
) -> (Vec<&'a CheckResult>, usize, usize, usize) {
    let list = error_results(results, st.show_all);
    let rows_at: Vec<i64> = list.iter().map(|r| r.at_ms).collect();
    let cursor = cursor_index(&rows_at, st.cursor_at);
    let start = window_start(cursor, list.len(), height);
    let end = start.saturating_add(height).min(list.len());
    (list, start, end, cursor)
}

/// `height` = 목록 줄 수. `results`는 `/status` 순서(오래된 → 최신).
pub fn errors_view(i: &ErrorsInput, st: &ErrorsState, height: usize) -> ErrorsView {
    let (list, start, end, cursor) = window(i.results, st, height);
    let latest_at = i.results.last().map(|r| r.at_ms);
    let rows: Vec<ErrorRow> = list[start..end]
        .iter()
        .map(|r| ErrorRow {
            at_ms: r.at_ms,
            state: row_state(r, i.thresholds),
            latency_ms: r.latency_ms,
            reason: st.cache.reason_for(r, Some(r.at_ms) == latest_at),
        })
        .collect();
    let cursor = (!rows.is_empty()).then(|| cursor - start);
    ErrorsView {
        title: i.title.to_string(),
        rows,
        cursor,
        failures: i.results.iter().filter(|r| is_failure(r.verdict)).count(),
        total: i.results.len(),
        span_secs: i.results.len() as u64 * u64::from(i.interval_seconds),
        show_all: st.show_all,
    }
}

/// 창에 보이는 결과(조회 대상 계산용) — `errors_view`와 같은 창.
pub fn visible_results<'a>(
    results: &'a [CheckResult],
    st: &ErrorsState,
    height: usize,
) -> Vec<&'a CheckResult> {
    let (list, start, end, _) = window(results, st, height);
    list[start..end].to_vec()
}
