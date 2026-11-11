//! 오류 보기 — 화면 상태와 순수 줄 모델(spec §5.3). 그리기는 `view::inspect`.

use std::collections::{HashMap, HashSet};

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_controller::monitor::config::{PanelConfig, Threshold};
use handicap_controller::monitor::record::MASK;
use handicap_engine::{ScenarioTrace, StepKind, StepTrace};

use crate::api::ApiError;
use crate::judge::{PanelState, format_date_hms, format_hms, format_ms};
use crate::names::Names;
use crate::text;
use crate::view::{text_width, wrap_width};
use crate::wire::{CheckRecord, ClipSide, Clipped};

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

/// bidi 제어 글자(U+061C·200E/200F·202A–202E·2066–2069) — `sanitize`와 입력줄(`input::accept_char`)의 단일 소스.
pub(crate) fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// 화면에 그리는 **모든 원격 문자열**(사유·판정 상세·이름·URL·오류·본문)이 거친다. 탭 → 공백 4칸, CR 제거,
/// 그 밖의 `char::is_control`(ESC 포함)·U+2028/2029·bidi 제어(U+061C·200E/200F·202A–202E·2066–2069 —
/// 대상 응답이 줄을 시각적으로 뒤집어 URL·상태를 달리 보이게 하지 못하게) → `�`. 줄바꿈(`\n`)은 호출 쪽이 먼저 나눈다.
pub fn sanitize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\t' => out.push_str("    "),
            '\r' => {}
            '\u{2028}' | '\u{2029}' => out.push('\u{FFFD}'),
            c if is_bidi_control(c) => out.push('\u{FFFD}'),
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

impl ErrorsState {
    /// 커서를 지금 목록(`rows_at`, 최신 순)의 한 줄 at_ms에 고정한다 — 빈 목록이면 None.
    /// `cursor_at`이 None인 채면 줄 번호 0에 붙어 새 결과가 올 때마다 맨 윗줄로 옮겨 가므로
    /// 열 때·`a` 뒤·매 펌프에 부른다(사용자 확정 3).
    pub fn pin_cursor(&mut self, rows_at: &[i64]) {
        self.cursor_at =
            (!rows_at.is_empty()).then(|| rows_at[cursor_index(rows_at, self.cursor_at)]);
    }
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
        span_secs: (i.results.len() as u64).saturating_mul(u64::from(i.interval_seconds)),
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

// ---------- 기록 상세 (spec §5.3-2·§5.3-3, 목업 §2) ----------

/// 기록 하나의 조회 상태.
#[derive(Debug, Clone)]
pub enum RecordLoad {
    Loading,
    Loaded(Box<CheckRecord>),
    /// 404 — 기록이 이미 지워짐.
    Gone,
    /// `ApiError.message`
    Failed(String),
}

/// 기록 조회 결과 → 조회 상태. 404 → Gone, 그 밖의 오류 → Failed(message).
pub fn load_of(r: Result<CheckRecord, ApiError>) -> RecordLoad {
    match r {
        Ok(rec) => RecordLoad::Loaded(Box::new(rec)),
        Err(e) if e.status == Some(404) => RecordLoad::Gone,
        Err(e) => RecordLoad::Failed(e.message),
    }
}

/// 자세히 화면 상태 — 보드·칸·회차(셋 다로 늦게 온 응답을 거른다)·누른 회차·조회 상태·스텝 커서.
#[derive(Debug, Clone)]
pub struct RecordState {
    pub board_id: String,
    pub panel_id: String,
    pub at_ms: i64,
    pub clicked: CheckResult,
    pub load: RecordLoad,
    pub cursor: usize,
}

/// GUI `branchText`: "none" → "(미매치)", "then"/"else" 그대로, "elif_3" → "elif 3", 그 외 원문.
pub fn branch_text(branch: &str) -> String {
    if branch == "none" {
        return text::BRANCH_NONE.to_string();
    }
    if let Some(n) = branch.strip_prefix("elif_")
        && !n.is_empty()
        && n.bytes().all(|b| b.is_ascii_digit())
    {
        return format!("elif {n}");
    }
    branch.to_string()
}

/// 자세히 화면 스텝 표의 한 줄.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepLine {
    /// `branch_text` 적용본
    If { branch: String },
    Http {
        /// trace.steps 인덱스(= `Clipped.step`)
        trace_idx: usize,
        /// 이 기록의 http 줄 순번(1부터, if 줄은 세지 않는다)
        no: usize,
        loop_index: Option<u32>,
        /// Names에서, 없으면 step_id
        name: String,
        method: Option<String>,
        url: Option<String>,
        status: Option<u16>,
        latency_ms: Option<u64>,
        error: Option<String>,
        timed_out: bool,
        /// 스텝 칸의 그 스텝(마지막 http 행 하나만)
        focus: bool,
    },
}

/// `method`·`url`·`status`·`latency_ms`·`error`는 **trace에서**(`step.request`/`step.response` — 실제로
/// 보낸 값, URL은 서버가 가린 그대로). `Names`는 이름만 준다(시나리오에 적힌 템플릿 URL은 여기서
/// 쓰지 않는다 — 그것은 칸 설정 보기).
pub fn step_lines(
    trace: &ScenarioTrace,
    names: &Names,
    scenario_id: &str,
    focus_step_id: Option<&str>,
) -> Vec<StepLine> {
    // GUI `RecordSteps`: 같은 스텝이 loop로 여러 번 돌면 마지막 http 행, if 행은 대상 아님.
    let focus_idx = focus_step_id.and_then(|id| {
        trace
            .steps
            .iter()
            .rposition(|s| s.kind == StepKind::Http && s.step_id == id)
    });
    let mut no = 0usize;
    trace
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| match s.kind {
            StepKind::If => StepLine::If {
                branch: branch_text(s.branch.as_deref().unwrap_or("none")),
            },
            StepKind::Http => {
                no += 1;
                StepLine::Http {
                    trace_idx: i,
                    no,
                    loop_index: s.loop_index,
                    name: names
                        .step_name(scenario_id, &s.step_id)
                        .unwrap_or(&s.step_id)
                        .to_string(),
                    method: s.request.as_ref().map(|r| r.method.clone()),
                    url: s.request.as_ref().map(|r| r.url.clone()),
                    status: s.response.as_ref().map(|r| r.status),
                    latency_ms: s.response.as_ref().map(|r| r.latency_ms),
                    error: s.error.clone(),
                    timed_out: s.timed_out,
                    focus: focus_idx == Some(i),
                }
            }
        })
        .collect()
}

/// 처음 커서: focus 줄(스텝 칸 — 사용자 확정 9) → 없으면 error가 있는 첫 Http → 첫 Http → 0.
pub fn initial_step_cursor(lines: &[StepLine]) -> usize {
    let find = |pred: &dyn Fn(&StepLine) -> bool| lines.iter().position(pred);
    find(&|l| matches!(l, StepLine::Http { focus: true, .. }))
        .or_else(|| find(&|l| matches!(l, StepLine::Http { error: Some(_), .. })))
        .or_else(|| find(&|l| matches!(l, StepLine::Http { .. })))
        .unwrap_or(0)
}

/// `from`에서 `dir`(−1/+1) 쪽으로 가장 가까운 Http 줄 번호(If 줄 건너뜀). 없으면 None.
pub fn neighbor_http(lines: &[StepLine], from: usize, dir: isize) -> Option<usize> {
    let is_http = |i: &usize| matches!(lines.get(*i), Some(StepLine::Http { .. }));
    if dir < 0 {
        (0..from.min(lines.len())).rev().find(is_http)
    } else if dir > 0 {
        (from.saturating_add(1)..lines.len()).find(is_http)
    } else {
        None
    }
}

/// 스텝 표 위 안내 줄.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Note {
    NoTraceConfig,
    NoTraceTimeout,
    TraceError(String),
    TraceCut,
}

/// GUI `RecordSteps`와 같은 구분: trace null → (clicked가 config_error면 NoTraceConfig, 아니면
/// NoTraceTimeout) 하나만. trace 있음 → error가 있으면 TraceError, truncated면 TraceCut(둘 다면 그 순서로).
pub fn record_notes(rec: &CheckRecord, clicked: Verdict) -> Vec<Note> {
    let Some(t) = &rec.trace else {
        return vec![if clicked == Verdict::ConfigError {
            Note::NoTraceConfig
        } else {
            Note::NoTraceTimeout
        }];
    };
    let mut out = Vec::new();
    if let Some(e) = &t.error {
        out.push(Note::TraceError(e.clone()));
    }
    if t.truncated {
        out.push(Note::TraceCut);
    }
    out
}

/// 자세히 화면 뷰 모델.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordView {
    /// `text::record_title(칸 제목, format_date_hms(clicked.at_ms))`
    pub title: String,
    /// `row_state(clicked, 칸 기준선)`
    pub state: PanelState,
    /// clicked 기준
    pub latency_ms: Option<u64>,
    /// 기록이 왔으면 rec.result, 아니면 clicked (GUI `q.data?.result ?? clicked`)
    pub reason: Option<String>,
    pub detail: Option<String>,
    /// 이름 또는 id
    pub scenario: String,
    /// 이름 또는 id, 환경 없음이면 None
    pub environment: Option<String>,
    pub body: RecordBody,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordBody {
    Loading,
    Gone,
    Failed(String),
    Loaded {
        notes: Vec<Note>,
        lines: Vec<StepLine>,
        cursor: usize,
    },
}

/// focus = `panel.step_id`.
pub fn record_view(panel: &PanelConfig, st: &RecordState, names: &Names) -> RecordView {
    let result = match &st.load {
        RecordLoad::Loaded(rec) => &rec.result,
        _ => &st.clicked,
    };
    let body = match &st.load {
        RecordLoad::Loading => RecordBody::Loading,
        RecordLoad::Gone => RecordBody::Gone,
        RecordLoad::Failed(m) => RecordBody::Failed(m.clone()),
        RecordLoad::Loaded(rec) => {
            let lines = rec
                .trace
                .as_ref()
                .map(|t| step_lines(t, names, &panel.scenario_id, panel.step_id.as_deref()))
                .unwrap_or_default();
            RecordBody::Loaded {
                notes: record_notes(rec, st.clicked.verdict),
                cursor: st.cursor.min(lines.len().saturating_sub(1)),
                lines,
            }
        }
    };
    RecordView {
        title: text::record_title(&panel.title, &format_date_hms(st.clicked.at_ms)),
        state: row_state(&st.clicked, &panel.thresholds),
        latency_ms: st.clicked.latency_ms,
        reason: result.reason.clone(),
        detail: result.detail.clone(),
        scenario: names
            .scenario_name(&panel.scenario_id)
            .unwrap_or(&panel.scenario_id)
            .to_string(),
        environment: panel
            .environment_id
            .as_deref()
            .map(|e| names.env_name(e).unwrap_or(e).to_string()),
        body,
    }
}

// ---------- 요청·응답 본문 (spec §5.3-4, 목업 §3) ----------

/// GUI `TREE_MAX_BYTES`·`TREE_MAX_DEPTH`와 같은 한도.
pub const PRETTY_MAX_BYTES: usize = 64 * 1024;
pub const PRETTY_MAX_DEPTH: usize = 64;

/// `pretty_json`의 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pretty {
    Json(String),
    TooLarge,
    TooDeep,
    Raw,
}

fn is_json_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}

fn push_newline(out: &mut String, depth: usize) {
    out.push('\n');
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// 판정 순서: ① `s.len() > PRETTY_MAX_BYTES` → TooLarge(내용과 무관 — GUI와 같다)
/// ② 첫 비공백 글자가 `{`/`[`가 아니거나 `serde_json::from_str::<serde::de::IgnoredAny>(s)`가 실패 → Raw
/// ③ 들여쓰며 훑는 중 `{`/`[` 중첩이 PRETTY_MAX_DEPTH를 넘으면 **그 자리에서 멈추고** TooDeep ④ 그 외 Json.
/// 주의: IgnoredAny 경로는 serde_json의 재귀 상한(128)을 타지 않는다(반복문) — 깊이는 ③이 직접 센다.
///
/// 값을 다시 만들지 않고 글자 흐름을 다시 줄바꿈한다(`serde_json::Value`를 거치면 키 순서가 바뀐다).
pub fn pretty_json(s: &str) -> Pretty {
    if s.len() > PRETTY_MAX_BYTES {
        return Pretty::TooLarge;
    }
    if !matches!(s.trim_start().chars().next(), Some('{' | '[')) {
        return Pretty::Raw;
    }
    if serde_json::from_str::<serde::de::IgnoredAny>(s).is_err() {
        return Pretty::Raw;
    }
    let mut out = String::with_capacity(s.len() * 2);
    let mut depth = 0usize;
    let (mut in_str, mut esc) = (false, false);
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '{' | '[' => {
                depth += 1;
                if depth > PRETTY_MAX_DEPTH {
                    return Pretty::TooDeep;
                }
                out.push(c);
                while chars.peek().is_some_and(|&n| is_json_ws(n)) {
                    chars.next();
                }
                let close = if c == '{' { '}' } else { ']' };
                if chars.peek() == Some(&close) {
                    chars.next();
                    out.push(close);
                    depth -= 1;
                } else {
                    push_newline(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                push_newline(&mut out, depth);
                out.push(c);
            }
            ',' => {
                out.push(c);
                push_newline(&mut out, depth);
            }
            ':' => out.push_str(": "),
            c if is_json_ws(c) => {}
            c => out.push(c),
        }
    }
    Pretty::Json(out)
}

/// (요청 잘림, 응답 잘림) — `Clipped.step`은 `trace.steps` 인덱스.
pub fn clip_flags(clipped: &[Clipped], trace_idx: usize) -> (bool, bool) {
    let hit = |side: ClipSide| {
        clipped
            .iter()
            .any(|c| c.side == side && usize::try_from(c.step).is_ok_and(|s| s == trace_idx))
    };
    (hit(ClipSide::Request), hit(ClipSide::Response))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyLineKind {
    Title,
    Summary,
    Error,
    Heading,
    Text,
    Note,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyLine {
    pub kind: BodyLineKind,
    pub text: String,
}

pub struct BodyInput<'a> {
    /// 제목 줄용(StepLine::Http의 no·name)
    pub panel_title: &'a str,
    pub at_ms: i64,
    pub no: usize,
    pub name: &'a str,
    pub step: &'a StepTrace,
    pub clipped_req: bool,
    pub clipped_resp: bool,
    pub limit_kb: u32,
    pub reveal: bool,
}

/// 헤더 이름 칸 최대 폭.
const HEADER_NAME_MAX: usize = 24;

struct Lines {
    out: Vec<BodyLine>,
    width: usize,
}

impl Lines {
    /// `\n`으로 나눈 뒤 `sanitize` → `wrap_width`.
    fn wrapped(&mut self, kind: BodyLineKind, s: &str) {
        for part in s.split('\n') {
            for row in wrap_width(&sanitize(part), self.width) {
                self.out.push(BodyLine { kind, text: row });
            }
        }
    }

    /// 짧은 고정 문구(제목·안내) — 줄바꿈만.
    fn fixed(&mut self, kind: BodyLineKind, s: &str) {
        for row in wrap_width(s, self.width) {
            self.out.push(BodyLine { kind, text: row });
        }
    }

    fn headers(&mut self, title: &str, headers: &std::collections::BTreeMap<String, String>) {
        if headers.is_empty() {
            return;
        }
        self.fixed(BodyLineKind::Heading, title);
        let name_w = headers
            .keys()
            .map(|k| text_width(&sanitize(k)))
            .max()
            .unwrap_or(0)
            .min(HEADER_NAME_MAX);
        for (k, v) in headers {
            let k = sanitize(k);
            let pad = " ".repeat(name_w.saturating_sub(text_width(&k)));
            // 값 속 줄바꿈은 줄로 나누지 않고 sanitize가 치환한다(헤더 한 개 = 한 줄 흐름).
            self.indented(&format!("{k}{pad}  {}", sanitize(v)));
        }
    }

    /// 본문 규칙: 잘렸으면 원문, 아니면 `pretty_json` 갈래. 본문 `Text`는 2칸 들여쓴다.
    fn body(&mut self, body: &str, clipped: bool) {
        let pretty = if clipped {
            Pretty::Raw
        } else {
            pretty_json(body)
        };
        let shown = match &pretty {
            Pretty::Json(p) => p.as_str(),
            Pretty::TooLarge => {
                self.fixed(BodyLineKind::Note, text::RECORD_TREE_TOO_LARGE);
                body
            }
            Pretty::TooDeep => {
                self.fixed(BodyLineKind::Note, text::RECORD_TREE_TOO_DEEP);
                body
            }
            Pretty::Raw => body,
        };
        for part in shown.split('\n') {
            self.indented(&sanitize(part));
        }
    }

    /// 2칸 들여쓴 `Text` 줄 — 폭 `width - 2`로 감싼 뒤 각 줄에 들여쓰기를 붙인다(뒷줄도 2칸).
    /// 들여쓴 뒤 남는 폭이 2칸 미만이면(2칸 글자가 넘치지 않게) 들여쓰기 없이 감싼다.
    fn indented(&mut self, s: &str) {
        let (pad, room) = if self.width >= BODY_INDENT.len() + 2 {
            (BODY_INDENT, self.width - BODY_INDENT.len())
        } else {
            ("", self.width)
        };
        for row in wrap_width(s, room) {
            self.out.push(BodyLine {
                kind: BodyLineKind::Text,
                text: format!("{pad}{row}"),
            });
        }
    }
}

/// 헤더·본문 `Text` 줄의 들여쓰기.
const BODY_INDENT: &str = "  ";

/// 폭 `width`(0이면 1로)에 맞춰 줄바꿈한 전체 줄(목업 §3, GUI `StepRow` 펼친 내용과 같은 구분).
pub fn body_lines(i: &BodyInput, width: usize) -> Vec<BodyLine> {
    let mut l = Lines {
        out: Vec::new(),
        width: width.max(1),
    };
    let step = i.step;
    l.wrapped(
        BodyLineKind::Title,
        &format!(
            "{} · {} · {} {}",
            i.panel_title,
            format_hms(i.at_ms),
            i.no,
            i.name
        ),
    );
    let mut summary = match &step.request {
        Some(r) => format!("{} {}", r.method, r.url),
        None => text::NO_VALUE.to_string(),
    };
    if let Some(r) = &step.response {
        summary.push_str(&format!(
            "   →   {}   {}",
            r.status,
            format_ms(r.latency_ms as f64)
        ));
    }
    l.wrapped(BodyLineKind::Summary, &summary);
    if let Some(e) = &step.error {
        l.wrapped(BodyLineKind::Error, e);
    }
    if step.timed_out {
        l.fixed(BodyLineKind::Note, text::TIMED_OUT);
    }
    let mut masked = false;
    if let Some(r) = &step.request {
        masked |= r.url.contains(MASK) || r.headers.values().any(|v| v.contains(MASK));
        l.headers(text::RECORD_REQ_HEADERS, &r.headers);
        if let Some(b) = r.body.as_deref().filter(|b| !b.is_empty()) {
            l.fixed(BodyLineKind::Heading, text::RECORD_REQ_BODY);
            if i.reveal {
                if i.clipped_req {
                    l.fixed(BodyLineKind::Note, &text::record_clipped(i.limit_kb));
                }
                l.body(b, i.clipped_req);
            } else {
                l.fixed(BodyLineKind::Note, text::RECORD_REQ_BODY_HIDDEN);
                if i.clipped_req {
                    l.fixed(BodyLineKind::Note, &text::record_clipped(i.limit_kb));
                }
            }
        }
    }
    if let Some(r) = &step.response {
        masked |= r.headers.values().any(|v| v.contains(MASK));
        l.headers(text::RECORD_RESP_HEADERS, &r.headers);
        if !r.body.is_empty() {
            l.fixed(BodyLineKind::Heading, text::RECORD_RESP_BODY);
            if i.clipped_resp {
                l.fixed(BodyLineKind::Note, &text::record_clipped(i.limit_kb));
            }
            if r.body_truncated {
                l.fixed(BodyLineKind::Note, text::RECORD_ENGINE_TRUNCATED);
            }
            l.body(&r.body, i.clipped_resp || r.body_truncated);
        }
    }
    if masked {
        l.fixed(BodyLineKind::Note, text::RECORD_MASKED_HINT);
    }
    l.out
}

/// 만든 줄을 (폭, reveal)로 기억 — 매 프레임 다시 만들지 않는다(1 MiB 본문).
#[derive(Debug, Default)]
pub struct BodyState {
    /// StepLine 목록에서의 줄 번호
    pub line_idx: usize,
    pub reveal: bool,
    pub scroll: usize,
    cache: Option<(usize, bool, Vec<BodyLine>)>,
}

impl BodyState {
    /// 항상 reveal false · scroll 0 (옆 스텝으로 갈 때도 new).
    pub fn new(line_idx: usize) -> BodyState {
        BodyState {
            line_idx,
            ..BodyState::default()
        }
    }

    /// 캐시가 (width, self.reveal)와 다르면 다시 만든다. 돌려주는 줄 수.
    /// `i.reveal`은 무시하고 `self.reveal`을 쓴다(가림 상태의 단일 소스).
    pub fn ensure(&mut self, i: &BodyInput, width: usize) -> usize {
        let fresh = matches!(&self.cache, Some((w, r, _)) if *w == width && *r == self.reveal);
        if !fresh {
            let input = BodyInput {
                reveal: self.reveal,
                ..*i
            };
            self.cache = Some((width, self.reveal, body_lines(&input, width)));
        }
        self.lines().len()
    }

    pub fn lines(&self) -> &[BodyLine] {
        self.cache.as_ref().map_or(&[], |(_, _, l)| l.as_slice())
    }

    /// `scroll`을 `delta`만큼 옮기되 `0..=len.saturating_sub(height)`에 가둔다.
    pub fn scroll_by(&mut self, delta: isize, height: usize) {
        let max = self.lines().len().saturating_sub(height);
        let cur = self.scroll.min(max) as isize;
        self.scroll = (cur.saturating_add(delta)).clamp(0, max as isize) as usize;
    }

    pub fn scroll_to_end(&mut self, height: usize) {
        self.scroll = self.lines().len().saturating_sub(height);
    }
}
