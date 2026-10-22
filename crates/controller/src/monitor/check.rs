//! 점검 1회(`run_check`)와 순수 판정(`judge`) — spec §6.1–6.2.
//!
//! 벽 화면에 나가는 `reason`은 이 파일의 고정 문구 + 시나리오 작성자의 스텝 이름뿐이다.
//! 엔진 error 원문은 `starts_with` 분류에만 쓰고 절대 `reason`에 싣지 않는다.
//! 단 조건 판정 결과일 때만 사용자가 고른 경로의 실제 값·비교값이 `reason`/`detail`에 나간다
//! (`shown`으로 제어·서식 문자를 공백으로 바꾸고 200자로 자른 뒤).

use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::extract::{jsonpath_first, stringify};
use handicap_engine::{
    Assertion, HttpStep, Scenario, ScenarioTrace, Step, StepKind, StepTrace, TraceOptions,
    TracedResponse, trace_scenario,
};
use serde::{Deserialize, Serialize};

use super::config::{
    Condition, ConditionOp, ConditionSource, LatencySource, PanelConfig, parse_finite,
};
use crate::store::{self, Db};

/// 점검 1회 요청 상한 — 설정 `max_test_run_requests`와 무관(spec §6.1).
pub const MONITOR_MAX_REQUESTS: u32 = 50;

pub const REASON_SCENARIO_MISSING: &str = "시나리오를 찾을 수 없음";
pub const REASON_ENV_MISSING: &str = "환경을 찾을 수 없음";
pub const REASON_SCENARIO_INVALID: &str = "시나리오 오류";
pub const REASON_LATENCY_STEP_MISSING: &str = "응답 시간 기준 스텝 없음";
pub const REASON_REQUEST_CAP: &str = "요청 수 상한(50) 초과";
pub const REASON_TRACE_ERROR: &str = "시나리오 실행 오류";
pub const REASON_BAD_REQUEST_BUILD: &str = "요청 구성 오류";
pub const REASON_READ_BODY: &str = "응답 본문 읽기 실패";
pub const REASON_EXTRACT: &str = "값 추출 실패";
pub const REASON_REQUEST_FAILED: &str = "요청 실패";
pub const REASON_UNBOUND_VAR: &str = "변수 미설정";
pub const REASON_COND_STEP_MISSING: &str = "조건 기준 스텝 없음";
pub const REASON_COND_STEP_NOT_RUN: &str = "조건 스텝 미실행";
pub const REASON_BODY_NOT_JSON: &str = "본문이 JSON 아님";
pub const REASON_BODY_TOO_LARGE: &str = "응답 본문이 너무 큼";
pub const REASON_NO_VALUE: &str = "값 없음";
pub const REASON_EMPTY: &str = "비어 있음";
const REASON_NOT_CONTAINED_TAIL: &str = "\" 포함 안 됨";

/// 조건 결과 `reason`·`detail`의 문자 수 상한.
pub const SHOWN_MAX_CHARS: usize = 200;

/// Unicode 서식 문자(Cf) 코드포인트 — 새 의존성 없이 하드코딩.
fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD
        | 0x0600..=0x0605
        | 0x061C
        | 0x06DD
        | 0x070F
        | 0x0890..=0x0891
        | 0x08E2
        | 0x180E
        | 0x200B..=0x200F
        | 0x202A..=0x202E
        | 0x2060..=0x2064
        | 0x2066..=0x206F
        | 0xFEFF
        | 0xFFF9..=0xFFFB
        | 0x110BD
        | 0x110CD
        | 0x13430..=0x1343F
        | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A
        | 0xE0001
        | 0xE0020..=0xE007F)
}

/// 제어·서식·줄/문단 구분 문자를 공백 하나로 바꾼다.
fn normalize_chars(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_control() || c == '\u{2028}' || c == '\u{2029}' || is_format_char(c) {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// 벽 화면에 나가는 사용자 값의 정규화 + 200자(문자 경계) 상한(`…`).
pub(crate) fn shown(s: &str) -> String {
    let n = normalize_chars(s);
    if n.chars().count() <= SHOWN_MAX_CHARS {
        return n;
    }
    let mut out: String = n.chars().take(SHOWN_MAX_CHARS - 1).collect();
    out.push('…');
    out
}

/// `"{비교값}" 포함 안 됨` — 비교값을 먼저 줄여 꼬리가 항상 남는다.
fn reason_not_contained(needle: &str) -> String {
    let n = normalize_chars(needle);
    let overhead = 1 + REASON_NOT_CONTAINED_TAIL.chars().count();
    let max = SHOWN_MAX_CHARS - overhead;
    let body = if n.chars().count() > max {
        let mut t: String = n.chars().take(max - 1).collect();
        t.push('…');
        t
    } else {
        n
    };
    format!("\"{body}{REASON_NOT_CONTAINED_TAIL}")
}

fn reason_timeout(secs: u32) -> String {
    format!("시간 초과({secs}초)")
}

fn reason_http(status: u16) -> String {
    format!("HTTP {status}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Ok,
    Fail,
    ConfigError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckResult {
    /// 점검 시작 시각 epoch ms.
    pub at_ms: i64,
    pub verdict: Verdict,
    pub latency_ms: Option<u64>,
    pub reason: Option<String>,
    /// 작은 줄 — 조건 판정 결과에만 `Some`(항상 직렬화, null 포함).
    pub detail: Option<String>,
}

impl CheckResult {
    fn with_reason(at_ms: i64, verdict: Verdict, reason: impl Into<String>) -> Self {
        Self {
            at_ms,
            verdict,
            latency_ms: None,
            reason: Some(reason.into()),
            detail: None,
        }
    }

    /// 조건 판정 결과 — `reason`·`detail` 둘 다 `shown`을 통과한다.
    fn cond_result(at_ms: i64, verdict: Verdict, reason: &str, detail: &str) -> Self {
        Self {
            at_ms,
            verdict,
            latency_ms: None,
            reason: Some(shown(reason)),
            detail: Some(shown(detail)),
        }
    }
}

fn target_label(c: &Condition) -> String {
    match c.source {
        ConditionSource::Body => {
            if c.path == "$" {
                "본문".to_string()
            } else if let Some(rest) = c.path.strip_prefix("$.") {
                rest.to_string()
            } else if c.path.starts_with("$[") {
                c.path[1..].to_string()
            } else {
                c.path.clone()
            }
        }
        ConditionSource::Header => format!("헤더 {}", c.path),
        ConditionSource::Status => "상태코드".to_string(),
        ConditionSource::BodyText => "본문 전체".to_string(),
    }
}

fn rule_label(op: ConditionOp) -> &'static str {
    match op {
        ConditionOp::Exists => "값이 있음",
        ConditionOp::NotEmpty => "비어 있지 않음",
        ConditionOp::Eq => "같음",
        ConditionOp::Ne => "같지 않음",
        ConditionOp::Contains => "포함",
        ConditionOp::Gt => "보다 큼",
        ConditionOp::Lt => "보다 작음",
    }
}

/// `{대상} · {규칙}[ {비교값}][ · {스텝 이름}]` — 정규화 전 원문(호출부가 `shown`).
fn condition_detail(c: &Condition, step_name: Option<&str>) -> String {
    let mut s = format!("{} · {}", target_label(c), rule_label(c.op));
    if c.op.needs_value() {
        s.push(' ');
        if c.value.is_empty() {
            s.push_str("\"\"");
        } else {
            s.push_str(&c.value);
        }
    }
    if let Some(n) = step_name {
        s.push_str(" · ");
        s.push_str(n);
    }
    s
}

/// 조건 스텝이 시나리오 http 스텝이 아니면 설정 오류(요청 전·judge 공유).
fn condition_step_missing(
    scenario: &Scenario,
    panel: &PanelConfig,
    at_ms: i64,
) -> Option<CheckResult> {
    if panel.conditions.is_empty() {
        return None;
    }
    let mut all = Vec::new();
    collect_http_steps(&scenario.steps, &mut all);
    let c = panel
        .conditions
        .iter()
        .find(|c| !all.iter().any(|h| h.id == c.step_id))?;
    Some(CheckResult::cond_result(
        at_ms,
        Verdict::ConfigError,
        REASON_COND_STEP_MISSING,
        &condition_detail(c, None),
    ))
}

enum Actual {
    Fixed(&'static str),
    Missing,
    Val { text: String, num: Option<f64> },
}

fn actual_value(c: &Condition, resp: &TracedResponse) -> Actual {
    match c.source {
        ConditionSource::Body => {
            if resp.body_truncated {
                return Actual::Fixed(REASON_BODY_TOO_LARGE);
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&resp.body) else {
                return Actual::Fixed(REASON_BODY_NOT_JSON);
            };
            match jsonpath_first(&json, &c.path) {
                None => Actual::Missing,
                Some(v) => Actual::Val {
                    text: stringify(&v),
                    num: match &v {
                        serde_json::Value::Number(n) => n.as_f64(),
                        _ => None,
                    },
                },
            }
        }
        ConditionSource::Header => {
            let name = c.path.trim();
            match resp
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
            {
                Some((_, v)) => Actual::Val {
                    text: v.clone(),
                    num: None,
                },
                None => Actual::Missing,
            }
        }
        ConditionSource::Status => Actual::Val {
            text: resp.status.to_string(),
            num: None,
        },
        ConditionSource::BodyText => {
            if resp.body_truncated {
                Actual::Fixed(REASON_BODY_TOO_LARGE)
            } else {
                Actual::Val {
                    text: resp.body.clone(),
                    num: None,
                }
            }
        }
    }
}

fn normalize_cmp(s: &str, c: &Condition) -> String {
    let s = if c.trim { s.trim() } else { s };
    if c.ignore_case {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

fn op_passes(c: &Condition, text: &str, num: Option<f64>) -> bool {
    match c.op {
        ConditionOp::Exists => true,
        ConditionOp::NotEmpty => !text.is_empty(),
        ConditionOp::Eq | ConditionOp::Ne => {
            let eq = if let Some(n) = num
                && let Some(v) = parse_finite(&c.value)
            {
                n == v
            } else {
                normalize_cmp(text, c) == normalize_cmp(&c.value, c)
            };
            if c.op == ConditionOp::Eq { eq } else { !eq }
        }
        ConditionOp::Contains => normalize_cmp(text, c).contains(&normalize_cmp(&c.value, c)),
        ConditionOp::Gt | ConditionOp::Lt => match (parse_finite(text), parse_finite(&c.value)) {
            (Some(a), Some(b)) => {
                if c.op == ConditionOp::Gt {
                    a > b
                } else {
                    a < b
                }
            }
            _ => false,
        },
    }
}

/// 조건을 위에서부터 평가 — 처음 깨진 하나만. 전부 통과면 `None`.
fn eval_conditions(
    all: &[&HttpStep],
    panel: &PanelConfig,
    trace: &ScenarioTrace,
    at_ms: i64,
) -> Option<CheckResult> {
    for c in &panel.conditions {
        let name = (all.len() >= 2)
            .then(|| {
                all.iter()
                    .find(|h| h.id == c.step_id)
                    .map(|h| h.name.as_str())
            })
            .flatten();
        let detail = condition_detail(c, name);
        let fail = |reason: &str| {
            Some(CheckResult::cond_result(
                at_ms,
                Verdict::Fail,
                reason,
                &detail,
            ))
        };
        let Some(resp) = trace
            .steps
            .iter()
            .rfind(|s| s.kind == StepKind::Http && s.step_id == c.step_id)
            .and_then(|s| s.response.as_ref())
        else {
            return fail(REASON_COND_STEP_NOT_RUN);
        };
        match actual_value(c, resp) {
            Actual::Fixed(r) => return fail(r),
            Actual::Missing => return fail(REASON_NO_VALUE),
            Actual::Val { text, num } => {
                if op_passes(c, &text, num) {
                    continue;
                }
                if c.source == ConditionSource::BodyText && c.op == ConditionOp::Contains {
                    return fail(&reason_not_contained(&c.value));
                }
                if text.is_empty() {
                    return fail(REASON_EMPTY);
                }
                return fail(&text);
            }
        }
    }
    None
}

/// 시나리오 정의의 http 스텝 전부(loop/if/parallel 재귀).
fn collect_http_steps<'a>(steps: &'a [Step], out: &mut Vec<&'a HttpStep>) {
    for s in steps {
        match s {
            Step::Http(h) => out.push(h),
            Step::Loop(l) => collect_http_steps(&l.do_, out),
            Step::If(i) => {
                collect_http_steps(&i.then_, out);
                for e in &i.elif {
                    collect_http_steps(&e.then_, out);
                }
                collect_http_steps(&i.else_, out);
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    collect_http_steps(&b.steps, out);
                }
            }
        }
    }
}

fn latency_step_exists(scenario: &Scenario, panel: &PanelConfig) -> bool {
    match &panel.latency_source {
        LatencySource::Total => true,
        LatencySource::Step { step_id } => {
            let mut all = Vec::new();
            collect_http_steps(&scenario.steps, &mut all);
            all.iter().any(|h| &h.id == step_id)
        }
    }
}

/// 그 스텝의 status assert 중 응답 status와 다른 값이 있으면 응답 status.
fn status_mismatch(http: Option<&HttpStep>, st: &StepTrace) -> Option<u16> {
    let resp = st.response.as_ref()?;
    let h = http?;
    h.assert
        .iter()
        .any(|a| matches!(a, Assertion::Status(c) if *c != resp.status))
        .then_some(resp.status)
}

/// 실패한 스텝 한 개의 사유(접미 제외). 분류 순서는 task-2 brief 정본:
/// ① invalid header ② status assert 불일치 ③ read body ④ 그 외(응답 있음) ⑤ 응답 없음.
fn classify(http: Option<&HttpStep>, st: &StepTrace, err: &str) -> String {
    if err.starts_with("invalid header") {
        return REASON_BAD_REQUEST_BUILD.to_string();
    }
    let Some(resp) = &st.response else {
        return REASON_REQUEST_FAILED.to_string();
    };
    if status_mismatch(http, st).is_some() {
        return reason_http(resp.status);
    }
    if err.starts_with("read body:") {
        return REASON_READ_BODY.to_string();
    }
    REASON_EXTRACT.to_string()
}

/// 순수 판정 — spec §6.2.
pub fn judge(
    scenario: &Scenario,
    panel: &PanelConfig,
    trace: &ScenarioTrace,
    at_ms: i64,
) -> CheckResult {
    if !latency_step_exists(scenario, panel) {
        return CheckResult::with_reason(at_ms, Verdict::ConfigError, REASON_LATENCY_STEP_MISSING);
    }
    if let Some(r) = condition_step_missing(scenario, panel, at_ms) {
        return r;
    }
    if trace.truncated {
        let http_rows = trace
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Http)
            .count();
        let reason = if http_rows >= MONITOR_MAX_REQUESTS as usize {
            REASON_REQUEST_CAP.to_string()
        } else {
            reason_timeout(panel.timeout_seconds)
        };
        return CheckResult::with_reason(at_ms, Verdict::Fail, reason);
    }
    if trace.error.is_some() {
        return CheckResult::with_reason(at_ms, Verdict::Fail, REASON_TRACE_ERROR);
    }

    let mut all = Vec::new();
    collect_http_steps(&scenario.steps, &mut all);

    if let Some((st, err)) = trace
        .steps
        .iter()
        .filter(|s| s.kind == StepKind::Http)
        .find_map(|s| s.error.as_deref().map(|e| (s, e)))
    {
        let http = all.iter().copied().find(|h| h.id == st.step_id);
        // 치환 안 된 변수는 시스템 장애가 아니라 설정 오류 — 빨강(Fail)이 아니라 설정 오류로.
        let (verdict, mut reason) = if st.unbound_vars.is_empty() {
            (Verdict::Fail, classify(http, st, err))
        } else {
            (Verdict::ConfigError, REASON_UNBOUND_VAR.to_string())
        };
        if all.len() >= 2
            && let Some(h) = http
        {
            reason = format!("{reason} · {}", h.name);
        }
        return CheckResult::with_reason(at_ms, verdict, reason);
    }

    if let Some(r) = eval_conditions(&all, panel, trace, at_ms) {
        return r;
    }

    let latency_ms = match &panel.latency_source {
        LatencySource::Total => Some(trace.total_ms),
        LatencySource::Step { step_id } => trace
            .steps
            .iter()
            .rfind(|s| s.kind == StepKind::Http && &s.step_id == step_id)
            .and_then(|s| s.response.as_ref())
            .map(|r| r.latency_ms),
    };
    CheckResult {
        at_ms,
        verdict: Verdict::Ok,
        latency_ms,
        reason: None,
        detail: None,
    }
}

/// 점검 1회 — spec §6.1. 매번 DB에서 시나리오·환경을 다시 읽는다.
pub async fn run_check(db: &Db, panel: &PanelConfig) -> (Option<ScenarioTrace>, CheckResult) {
    let at_ms = store::now_ms();
    let cfg_err = |reason: &str| {
        (
            None,
            CheckResult::with_reason(at_ms, Verdict::ConfigError, reason),
        )
    };

    let Ok(Some(row)) = store::scenarios::get(db, &panel.scenario_id).await else {
        return cfg_err(REASON_SCENARIO_MISSING);
    };
    let Ok(scenario) = Scenario::from_yaml(&row.yaml) else {
        return cfg_err(REASON_SCENARIO_INVALID);
    };
    let env: BTreeMap<String, String> = match &panel.environment_id {
        None => BTreeMap::new(),
        Some(id) => match store::environments::get(db, id).await {
            Ok(Some(e)) => e.vars,
            _ => return cfg_err(REASON_ENV_MISSING),
        },
    };
    // 요청을 내보내기 전에 기준 스텝부터 확인 — 설정 오류에 부하를 쓰지 않는다.
    if !latency_step_exists(&scenario, panel) {
        return cfg_err(REASON_LATENCY_STEP_MISSING);
    }
    if let Some(r) = condition_step_missing(&scenario, panel, at_ms) {
        return (None, r);
    }

    let timeout = Duration::from_secs(u64::from(panel.timeout_seconds));
    let opts = TraceOptions {
        env,
        max_requests: MONITOR_MAX_REQUESTS,
        max_wall: timeout,
        apply_think_time: false,
    };
    match tokio::time::timeout(timeout, trace_scenario(&scenario, &opts)).await {
        Err(_) => (
            None,
            CheckResult::with_reason(at_ms, Verdict::Fail, reason_timeout(panel.timeout_seconds)),
        ),
        Ok(trace) => {
            let result = judge(&scenario, panel, &trace, at_ms);
            (Some(trace), result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use handicap_engine::{TracedRequest, TracedResponse};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const A: &str = "01HX0000000000000000000001";
    const B: &str = "01HX0000000000000000000002";

    fn one_step() -> Scenario {
        Scenario::from_yaml(&format!(
            "version: 1\nname: s\nsteps:\n  - id: \"{A}\"\n    name: 인증\n    type: http\n    request: {{ method: GET, url: \"http://x/a\" }}\n    assert:\n      - status: 200\n"
        ))
        .unwrap()
    }

    fn two_steps() -> Scenario {
        Scenario::from_yaml(&format!(
            "version: 1\nname: s\nsteps:\n  - id: \"{A}\"\n    name: 인증\n    type: http\n    request: {{ method: GET, url: \"http://x/a\" }}\n    assert:\n      - status: 200\n  - id: \"{B}\"\n    name: 조회\n    type: http\n    request: {{ method: GET, url: \"http://x/b\" }}\n"
        ))
        .unwrap()
    }

    fn nested() -> Scenario {
        let c = "01HX0000000000000000000003";
        let d = "01HX0000000000000000000004";
        let e = "01HX0000000000000000000005";
        let f = "01HX0000000000000000000006";
        Scenario::from_yaml(&format!(
            r#"version: 1
name: n
steps:
  - id: "{c}"
    name: L
    type: loop
    repeat: 2
    do:
      - id: "{A}"
        name: in-loop
        type: http
        request: {{ method: GET, url: "http://x/a" }}
  - id: "{d}"
    name: I
    type: if
    cond: {{ left: "1", op: eq, right: "1" }}
    then:
      - id: "{B}"
        name: in-then
        type: http
        request: {{ method: GET, url: "http://x/b" }}
    else:
      - id: "{e}"
        name: in-else
        type: http
        request: {{ method: GET, url: "http://x/e" }}
  - id: "{f}"
    name: P
    type: parallel
    branches:
      - name: br
        steps:
          - id: "01HX0000000000000000000007"
            name: in-par
            type: http
            request: {{ method: GET, url: "http://x/p" }}
"#
        ))
        .unwrap()
    }

    fn resp(status: u16, latency: u64) -> TracedResponse {
        TracedResponse {
            status,
            latency_ms: latency,
            download_ms: None,
            headers: BTreeMap::new(),
            set_cookies: vec![],
            body: "SECRET-BODY".into(),
            body_truncated: false,
        }
    }

    fn st(id: &str, response: Option<TracedResponse>, error: Option<&str>) -> StepTrace {
        StepTrace {
            step_id: id.into(),
            kind: StepKind::Http,
            loop_index: None,
            branch: None,
            request: Some(TracedRequest {
                method: "GET".into(),
                url: "http://secret/url".into(),
                headers: BTreeMap::new(),
                body: None,
            }),
            response,
            extracted: BTreeMap::new(),
            unbound_vars: vec![],
            error: error.map(String::from),
        }
    }

    fn tr(steps: Vec<StepTrace>) -> ScenarioTrace {
        ScenarioTrace {
            ok: steps.iter().all(|s| s.error.is_none()),
            total_ms: 777,
            steps,
            final_vars: BTreeMap::new(),
            truncated: false,
            error: None,
        }
    }

    fn panel(src: LatencySource) -> PanelConfig {
        PanelConfig {
            scenario_id: "sc".into(),
            latency_source: src,
            timeout_seconds: 5,
            ..PanelConfig::default()
        }
    }

    fn fail_reason(s: &Scenario, t: &ScenarioTrace) -> String {
        let r = judge(s, &panel(LatencySource::Total), t, 1);
        assert_eq!(r.verdict, Verdict::Fail);
        assert_eq!(r.latency_ms, None);
        r.reason.unwrap()
    }

    #[test]
    fn ok_when_all_steps_pass() {
        let t = tr(vec![st(A, Some(resp(200, 10)), None)]);
        let r = judge(&one_step(), &panel(LatencySource::Total), &t, 42);
        assert_eq!(
            r,
            CheckResult {
                at_ms: 42,
                verdict: Verdict::Ok,
                latency_ms: Some(777),
                reason: None,
                detail: None
            }
        );
    }

    #[test]
    fn latency_from_last_execution_of_step() {
        let t = tr(vec![
            st(A, Some(resp(200, 10)), None),
            st(A, Some(resp(200, 55)), None),
        ]);
        let p = panel(LatencySource::Step { step_id: A.into() });
        assert_eq!(judge(&one_step(), &p, &t, 1).latency_ms, Some(55));
    }

    #[test]
    fn ok_with_null_latency_when_step_not_executed() {
        let t = tr(vec![st(A, Some(resp(200, 10)), None)]);
        let p = panel(LatencySource::Step { step_id: B.into() });
        let r = judge(&two_steps(), &p, &t, 1);
        assert_eq!(r.verdict, Verdict::Ok);
        assert_eq!(r.latency_ms, None);
    }

    #[test]
    fn fail_http_status_when_assert_mismatch() {
        let t = tr(vec![st(A, Some(resp(503, 10)), Some("status 503 != 200"))]);
        assert_eq!(fail_reason(&one_step(), &t), "HTTP 503");
    }

    #[test]
    fn fail_invalid_header_with_response() {
        let t = tr(vec![st(A, Some(resp(500, 10)), Some("invalid header X-A"))]);
        assert_eq!(fail_reason(&one_step(), &t), "요청 구성 오류");
    }

    #[test]
    fn fail_invalid_header_without_response() {
        let t = tr(vec![st(A, None, Some("invalid header X-A"))]);
        assert_eq!(fail_reason(&one_step(), &t), "요청 구성 오류");
    }

    #[test]
    fn fail_read_body_label() {
        let t = tr(vec![st(A, Some(resp(200, 10)), Some("read body: reset"))]);
        assert_eq!(fail_reason(&one_step(), &t), "응답 본문 읽기 실패");
    }

    #[test]
    fn fail_extract_label() {
        let t = tr(vec![st(A, Some(resp(200, 10)), Some("no match: $.t"))]);
        let r = fail_reason(&one_step(), &t);
        assert_eq!(r, "값 추출 실패");
        assert!(!r.contains("$.t"));
    }

    #[test]
    fn fail_no_response_label() {
        let t = tr(vec![st(
            A,
            None,
            Some("error sending request for url (http://secret/url)"),
        )]);
        let r = fail_reason(&one_step(), &t);
        assert_eq!(r, "요청 실패");
        assert!(!r.contains("secret"));
    }

    #[test]
    fn step_suffix_only_when_multiple_http_steps() {
        let t = tr(vec![st(A, Some(resp(503, 10)), Some("status"))]);
        assert_eq!(fail_reason(&one_step(), &t), "HTTP 503");
        assert_eq!(fail_reason(&two_steps(), &t), "HTTP 503 · 인증");
    }

    #[test]
    fn truncated_request_cap_reason() {
        let steps = (0..50).map(|_| st(A, Some(resp(200, 1)), None)).collect();
        let mut t = tr(steps);
        t.truncated = true;
        assert_eq!(fail_reason(&one_step(), &t), "요청 수 상한(50) 초과");
    }

    #[test]
    fn truncated_time_reason() {
        let mut t = tr(vec![st(A, Some(resp(200, 1)), None)]);
        t.truncated = true;
        assert_eq!(fail_reason(&one_step(), &t), "시간 초과(5초)");
    }

    #[test]
    fn trace_error_reason() {
        let mut t = tr(vec![]);
        t.error = Some("client build: boom".into());
        assert_eq!(fail_reason(&one_step(), &t), "시나리오 실행 오류");
    }

    #[test]
    fn config_error_when_latency_step_missing() {
        let t = tr(vec![]);
        let sc = nested();
        // 중첩(loop/if-then/if-else/parallel) 안의 http 스텝은 찾아야 한다.
        for id in [
            A,
            B,
            "01HX0000000000000000000005",
            "01HX0000000000000000000007",
        ] {
            let p = panel(LatencySource::Step { step_id: id.into() });
            assert_eq!(judge(&sc, &p, &t, 1).verdict, Verdict::Ok, "{id}");
        }
        // 존재하지 않거나 http 스텝이 아닌 id(loop 노드)는 설정 오류.
        for id in ["01HX0000000000000000000009", "01HX0000000000000000000003"] {
            let p = panel(LatencySource::Step { step_id: id.into() });
            let r = judge(&sc, &p, &t, 9);
            assert_eq!(r.verdict, Verdict::ConfigError, "{id}");
            assert_eq!(r.reason.as_deref(), Some("응답 시간 기준 스텝 없음"));
            assert_eq!(r.latency_ms, None);
        }
    }

    fn st_unbound(id: &str, response: Option<TracedResponse>, error: Option<&str>) -> StepTrace {
        let mut s = st(id, response, error);
        s.unbound_vars = vec!["BASE_URL".into()];
        s
    }

    #[test]
    fn unbound_on_failing_step_without_response_is_config_error() {
        let t = tr(vec![st_unbound(A, None, Some("builder error"))]);
        let r = judge(&one_step(), &panel(LatencySource::Total), &t, 1);
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("변수 미설정"));
        assert_eq!(r.latency_ms, None);
    }

    #[test]
    fn unbound_on_failing_step_with_response_is_config_error() {
        let t = tr(vec![st_unbound(
            A,
            Some(resp(401, 10)),
            Some("status 401 != 200"),
        )]);
        let r = judge(&one_step(), &panel(LatencySource::Total), &t, 1);
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("변수 미설정"));
    }

    #[test]
    fn unbound_reason_gets_step_suffix_with_multiple_steps() {
        let t = tr(vec![st_unbound(A, None, Some("builder error"))]);
        let r = judge(&two_steps(), &panel(LatencySource::Total), &t, 1);
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("변수 미설정 · 인증"));
    }

    #[test]
    fn unbound_only_on_passing_step_stays_ok() {
        let t = tr(vec![st_unbound(A, Some(resp(200, 10)), None)]);
        let r = judge(&one_step(), &panel(LatencySource::Total), &t, 1);
        assert_eq!(r.verdict, Verdict::Ok);
    }

    async fn db_with(yaml: &str) -> (Db, String) {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let sc = Scenario::from_yaml(yaml).unwrap();
        let row = store::scenarios::insert(&db, &sc, yaml).await.unwrap();
        (db, row.id)
    }

    fn yaml_for(url: &str) -> String {
        format!(
            "version: 1\nname: s\nsteps:\n  - id: \"{A}\"\n    name: 인증\n    type: http\n    request: {{ method: GET, url: \"{url}\" }}\n    assert:\n      - status: 200\n"
        )
    }

    #[tokio::test]
    async fn outer_timeout_fails_and_cancels() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/slow"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(3)))
            .mount(&server)
            .await;
        let (db, id) = db_with(&yaml_for(&format!("{}/slow", server.uri()))).await;
        let p = PanelConfig {
            scenario_id: id,
            timeout_seconds: 1,
            ..PanelConfig::default()
        };
        let started = std::time::Instant::now();
        let (trace, r) = run_check(&db, &p).await;
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(trace.is_none());
        assert_eq!(r.verdict, Verdict::Fail);
        assert_eq!(r.reason.as_deref(), Some("시간 초과(1초)"));
        assert_eq!(r.latency_ms, None);
    }

    #[tokio::test]
    async fn run_check_ok_against_wiremock() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let (db, id) = db_with(&yaml_for(&format!("{}/a", server.uri()))).await;
        let p = PanelConfig {
            scenario_id: id,
            ..PanelConfig::default()
        };
        let (trace, r) = run_check(&db, &p).await;
        assert!(trace.is_some());
        assert_eq!(r.verdict, Verdict::Ok);
        assert!(r.latency_ms.is_some());
    }

    #[tokio::test]
    async fn config_error_when_scenario_missing() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let p = PanelConfig {
            scenario_id: "nope".into(),
            ..PanelConfig::default()
        };
        let (trace, r) = run_check(&db, &p).await;
        assert!(trace.is_none());
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("시나리오를 찾을 수 없음"));
    }

    #[tokio::test]
    async fn config_error_when_environment_missing() {
        let (db, id) = db_with(&yaml_for("http://127.0.0.1:1/a")).await;
        let p = PanelConfig {
            scenario_id: id,
            environment_id: Some("gone".into()),
            ..PanelConfig::default()
        };
        let (_, r) = run_check(&db, &p).await;
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("환경을 찾을 수 없음"));
    }

    #[tokio::test]
    async fn config_error_when_scenario_yaml_invalid() {
        let (db, id) = db_with(&yaml_for("http://127.0.0.1:1/a")).await;
        sqlx::query("UPDATE scenarios SET yaml = ? WHERE id = ?")
            .bind("version: [not a scenario")
            .bind(&id)
            .execute(&db)
            .await
            .unwrap();
        let p = PanelConfig {
            scenario_id: id,
            ..PanelConfig::default()
        };
        let (_, r) = run_check(&db, &p).await;
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("시나리오 오류"));
    }

    #[tokio::test]
    async fn config_error_before_sending_when_latency_step_missing() {
        let (db, id) = db_with(&yaml_for("http://127.0.0.1:1/a")).await;
        let p = PanelConfig {
            scenario_id: id,
            latency_source: LatencySource::Step { step_id: B.into() },
            ..PanelConfig::default()
        };
        let (trace, r) = run_check(&db, &p).await;
        assert!(trace.is_none());
        assert_eq!(r.reason.as_deref(), Some("응답 시간 기준 스텝 없음"));
    }

    #[tokio::test]
    async fn env_vars_applied_from_environment() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/a"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let (db, id) = db_with(&yaml_for("${BASE}/a")).await;
        let mut vars = BTreeMap::new();
        vars.insert("BASE".to_string(), server.uri());
        let env = store::environments::insert(&db, "e", &vars).await.unwrap();
        let p = PanelConfig {
            scenario_id: id,
            environment_id: Some(env.id),
            ..PanelConfig::default()
        };
        let (_, r) = run_check(&db, &p).await;
        assert_eq!(r.verdict, Verdict::Ok);
    }

    #[tokio::test]
    async fn unbound_env_var_is_config_error_via_run_check() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let (db, id) = db_with(&yaml_for("${BASE_URL}/a")).await;
        let p = PanelConfig {
            scenario_id: id,
            environment_id: None,
            ..PanelConfig::default()
        };
        let (_, r) = run_check(&db, &p).await;
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("변수 미설정"));
    }

    // ---- 성공 조건 (①b Task 2) ----

    use super::super::config::{Condition, ConditionOp as Op, ConditionSource as Src};

    fn resp_with(status: u16, body: &str, headers: &[(&str, &str)]) -> TracedResponse {
        TracedResponse {
            status,
            latency_ms: 5,
            download_ms: None,
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            set_cookies: vec![],
            body: body.into(),
            body_truncated: false,
        }
    }

    fn cond(step: &str, source: Src, path: &str, op: Op, value: &str) -> Condition {
        Condition {
            step_id: step.into(),
            source,
            path: path.into(),
            op,
            value: value.into(),
            ..Condition::default()
        }
    }

    fn judge_c(sc: &Scenario, conds: Vec<Condition>, t: &ScenarioTrace) -> CheckResult {
        let p = PanelConfig {
            conditions: conds,
            ..panel(LatencySource::Total)
        };
        judge(sc, &p, t, 1)
    }

    fn t_body(body: &str) -> ScenarioTrace {
        tr(vec![st(A, Some(resp_with(200, body, &[])), None)])
    }

    #[test]
    fn cond_eq_pass_and_fail_detail_one_step() {
        let c = cond(A, Src::Body, "$.resultCode", Op::Eq, "0000");
        let r = judge_c(
            &one_step(),
            vec![c.clone()],
            &t_body(r#"{"resultCode":"E1023"}"#),
        );
        assert_eq!(r.verdict, Verdict::Fail);
        assert_eq!(r.reason.as_deref(), Some("E1023"));
        assert_eq!(r.detail.as_deref(), Some("resultCode · 같음 0000"));
        assert_eq!(r.latency_ms, None);
        let r = judge_c(&one_step(), vec![c], &t_body(r#"{"resultCode":"0000"}"#));
        assert_eq!(r.verdict, Verdict::Ok);
        assert_eq!(r.detail, None);
        assert_eq!(r.latency_ms, Some(777));
    }

    #[test]
    fn cond_detail_has_step_name_with_two_steps() {
        let c = cond(A, Src::Body, "$.resultCode", Op::Eq, "0000");
        let r = judge_c(&two_steps(), vec![c], &t_body(r#"{"resultCode":"E1"}"#));
        assert_eq!(r.detail.as_deref(), Some("resultCode · 같음 0000 · 인증"));
        assert_eq!(r.reason.as_deref(), Some("E1"));
    }

    #[test]
    fn cond_ops_table() {
        // (본문, op, 비교값, 기대: None=통과 / Some(사유))
        let rows: Vec<(&str, Op, &str, Option<&str>)> = vec![
            (r#"{"v":null}"#, Op::Exists, "", None),
            (r#"{}"#, Op::Exists, "", Some("값 없음")),
            (r#"{"v":null}"#, Op::NotEmpty, "", Some("비어 있음")),
            (r#"{"v":""}"#, Op::NotEmpty, "", Some("비어 있음")),
            (r#"{}"#, Op::NotEmpty, "", Some("값 없음")),
            (r#"{"v":"x"}"#, Op::NotEmpty, "", None),
            (r#"{"v":"0000"}"#, Op::Ne, "0000", Some("0000")),
            (r#"{"v":"ALL OK"}"#, Op::Contains, "OK", None),
            (r#"{"v":5}"#, Op::Gt, "3", None),
            (r#"{"v":2}"#, Op::Lt, "3", None),
            (r#"{"v":"abc"}"#, Op::Gt, "3", Some("abc")),
            (r#"{"v":"inf"}"#, Op::Gt, "3", Some("inf")),
            (r#"{"v":"NaN"}"#, Op::Lt, "3", Some("NaN")),
            (r#"{"v":5}"#, Op::Gt, "abc", Some("5")),
            (r#"{"v":{"a":1}}"#, Op::Eq, "x", Some(r#"{"a":1}"#)),
            (r#"{}"#, Op::Eq, "x", Some("값 없음")),
        ];
        for (body, op, val, want) in rows {
            let r = judge_c(
                &one_step(),
                vec![cond(A, Src::Body, "$.v", op, val)],
                &t_body(body),
            );
            match want {
                None => assert_eq!(r.verdict, Verdict::Ok, "{body} {op:?} {val}"),
                Some(reason) => {
                    assert_eq!(r.verdict, Verdict::Fail, "{body} {op:?} {val}");
                    assert_eq!(r.reason.as_deref(), Some(reason), "{body} {op:?} {val}");
                }
            }
        }
    }

    fn flagged(op: Op, val: &str, ic: bool, tm: bool) -> Condition {
        Condition {
            ignore_case: ic,
            trim: tm,
            ..cond(A, Src::Body, "$.v", op, val)
        }
    }

    #[test]
    fn cond_flags() {
        let run = |body: &str, c: Condition| judge_c(&one_step(), vec![c], &t_body(body));
        // eq: 실제 "OK ", 비교 "ok"
        let b = r#"{"v":"OK "}"#;
        let r = run(b, flagged(Op::Eq, "ok", false, false));
        assert_eq!(r.verdict, Verdict::Fail);
        assert_eq!(r.reason.as_deref(), Some("OK "));
        assert_eq!(
            run(b, flagged(Op::Eq, "ok", false, true)).verdict,
            Verdict::Fail
        );
        assert_eq!(
            run(b, flagged(Op::Eq, "ok", true, false)).verdict,
            Verdict::Fail
        );
        assert_eq!(
            run(b, flagged(Op::Eq, "ok", true, true)).verdict,
            Verdict::Ok
        );
        // ne
        assert_eq!(
            run(b, flagged(Op::Ne, "ok", false, false)).verdict,
            Verdict::Ok
        );
        assert_eq!(
            run(b, flagged(Op::Ne, "ok", true, true)).verdict,
            Verdict::Fail
        );
        // contains: 비교 "Ok " (뒤 공백)
        let b = r#"{"v":"ALL OK"}"#;
        assert_eq!(
            run(b, flagged(Op::Contains, "Ok ", true, false)).verdict,
            Verdict::Fail
        );
        assert_eq!(
            run(b, flagged(Op::Contains, "Ok ", true, true)).verdict,
            Verdict::Ok
        );
        // gt는 플래그 무관
        let b = r#"{"v":" 5 "}"#;
        assert_eq!(
            run(b, flagged(Op::Gt, "3", false, false)).verdict,
            Verdict::Ok
        );
        assert_eq!(
            run(b, flagged(Op::Gt, "3", true, true)).verdict,
            Verdict::Ok
        );
    }

    #[test]
    fn cond_json_number_compare() {
        let c = cond(A, Src::Body, "$.v", Op::Eq, "1");
        assert_eq!(
            judge_c(&one_step(), vec![c], &t_body(r#"{"v":1.0}"#)).verdict,
            Verdict::Ok
        );
        let c = cond(A, Src::Body, "$.v", Op::Eq, "0");
        let r = judge_c(&one_step(), vec![c], &t_body(r#"{"v":"0000"}"#));
        assert_eq!(r.verdict, Verdict::Fail);
        assert_eq!(r.reason.as_deref(), Some("0000"));
    }

    #[test]
    fn cond_body_text_not_contained() {
        let c = cond(A, Src::BodyText, "", Op::Contains, "OK");
        let r = judge_c(&one_step(), vec![c], &t_body("fail"));
        assert_eq!(r.reason.as_deref(), Some("\"OK\" 포함 안 됨"));
        assert_eq!(r.detail.as_deref(), Some("본문 전체 · 포함 OK"));
        let c = cond(A, Src::BodyText, "", Op::Contains, &"x".repeat(200));
        let r = judge_c(&one_step(), vec![c], &t_body("fail"));
        let reason = r.reason.unwrap();
        assert!(reason.chars().count() <= 200);
        assert!(reason.ends_with("\" 포함 안 됨"));
        assert!(reason.contains('…'));
        // 비교값이 한글이어도 문자 경계 안전
        let c = cond(A, Src::BodyText, "", Op::Contains, &"가".repeat(300));
        let reason = judge_c(&one_step(), vec![c], &t_body("fail"))
            .reason
            .unwrap();
        assert!(reason.chars().count() <= 200);
        assert!(reason.ends_with("\" 포함 안 됨"));
    }

    #[test]
    fn cond_body_truncated_and_not_json() {
        let mut resp = resp_with(200, "{}", &[]);
        resp.body_truncated = true;
        let t = tr(vec![st(A, Some(resp), None)]);
        for c in [
            cond(A, Src::Body, "$.v", Op::Exists, ""),
            cond(A, Src::BodyText, "", Op::Contains, "x"),
        ] {
            let r = judge_c(&one_step(), vec![c], &t);
            assert_eq!(r.verdict, Verdict::Fail);
            assert_eq!(r.reason.as_deref(), Some("응답 본문이 너무 큼"));
        }
        let r = judge_c(
            &one_step(),
            vec![cond(A, Src::Body, "$.v", Op::Exists, "")],
            &t_body("not json"),
        );
        assert_eq!(r.reason.as_deref(), Some("본문이 JSON 아님"));
        assert!(r.detail.is_some());
    }

    #[test]
    fn header_lookup_ignores_case() {
        let t = tr(vec![st(
            A,
            Some(resp_with(200, "", &[("content-type", "application/json")])),
            None,
        )]);
        let ok = cond(A, Src::Header, "Content-Type", Op::Contains, "json");
        assert_eq!(judge_c(&one_step(), vec![ok], &t).verdict, Verdict::Ok);
        let none = cond(A, Src::Header, "X-None", Op::Exists, "");
        let r = judge_c(&one_step(), vec![none], &t);
        assert_eq!(r.reason.as_deref(), Some("값 없음"));
        assert_eq!(r.detail.as_deref(), Some("헤더 X-None · 값이 있음"));
    }

    #[test]
    fn cond_status() {
        let t = t_body("");
        let ok = cond(A, Src::Status, "", Op::Eq, "200");
        assert_eq!(judge_c(&one_step(), vec![ok], &t).verdict, Verdict::Ok);
        let r = judge_c(
            &one_step(),
            vec![cond(A, Src::Status, "", Op::Gt, "300")],
            &t,
        );
        assert_eq!(r.reason.as_deref(), Some("200"));
        assert_eq!(r.detail.as_deref(), Some("상태코드 · 보다 큼 300"));
    }

    #[test]
    fn cond_uses_last_execution() {
        let t = tr(vec![
            st(A, Some(resp_with(200, r#"{"v":"0000"}"#, &[])), None),
            st(A, Some(resp_with(200, r#"{"v":"E1"}"#, &[])), None),
        ]);
        let r = judge_c(
            &one_step(),
            vec![cond(A, Src::Body, "$.v", Op::Eq, "0000")],
            &t,
        );
        assert_eq!(r.reason.as_deref(), Some("E1"));
    }

    #[test]
    fn cond_step_not_run() {
        let t = t_body("{}");
        let c = cond(B, Src::Body, "$.v", Op::Exists, "");
        let r = judge_c(&two_steps(), vec![c], &t);
        assert_eq!(r.verdict, Verdict::Fail);
        assert_eq!(r.reason.as_deref(), Some("조건 스텝 미실행"));
        assert_eq!(r.detail.as_deref(), Some("v · 값이 있음 · 조회"));
    }

    #[test]
    fn cond_first_failing_only() {
        let t = t_body(r#"{"a":"1","b":"2"}"#);
        let r = judge_c(
            &one_step(),
            vec![
                cond(A, Src::Body, "$.a", Op::Eq, "x"),
                cond(A, Src::Body, "$.b", Op::Eq, "y"),
            ],
            &t,
        );
        assert_eq!(r.reason.as_deref(), Some("1"));
        assert_eq!(r.detail.as_deref(), Some("a · 같음 x"));
    }

    #[test]
    fn scenario_failure_beats_conditions() {
        let t = tr(vec![st(
            A,
            Some(resp_with(503, "{}", &[])),
            Some("status 503 != 200"),
        )]);
        let r = judge_c(
            &one_step(),
            vec![cond(A, Src::Body, "$.v", Op::Eq, "x")],
            &t,
        );
        assert_eq!(r.reason.as_deref(), Some("HTTP 503"));
        assert_eq!(r.detail, None);
    }

    #[test]
    fn cond_step_missing_is_config_error_before_truncation() {
        let mut t = t_body("{}");
        t.truncated = true;
        let c = cond(
            "01HX0000000000000000000009",
            Src::Body,
            "$.resultCode",
            Op::Eq,
            "0000",
        );
        let r = judge_c(&two_steps(), vec![c], &t);
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("조건 기준 스텝 없음"));
        assert_eq!(r.detail.as_deref(), Some("resultCode · 같음 0000"));
    }

    #[test]
    fn body_root_and_bracket_target_labels() {
        let r = judge_c(
            &one_step(),
            vec![cond(A, Src::Body, "$", Op::NotEmpty, "")],
            &t_body(""),
        );
        assert_eq!(r.detail.as_deref(), Some("본문 · 비어 있지 않음"));
        let r = judge_c(
            &one_step(),
            vec![cond(A, Src::Body, "$['a b'][0]", Op::Exists, "")],
            &t_body("{}"),
        );
        assert_eq!(r.detail.as_deref(), Some("['a b'][0] · 값이 있음"));
    }

    #[test]
    fn shown_cuts_at_char_boundary_with_ellipsis() {
        let s = shown(&"가".repeat(300));
        assert_eq!(s.chars().count(), 200);
        assert!(s.ends_with('…'));
        let s = shown(&"😀".repeat(300));
        assert_eq!(s.chars().count(), 200);
        assert!(s.ends_with('…'));
        let exact = "가".repeat(200);
        assert_eq!(shown(&exact), exact);
    }

    #[test]
    fn shown_replaces_cf_and_controls() {
        assert_eq!(
            shown("a\u{202E}b\u{200B}c\u{FEFF}d\ne\tf\u{2028}g\u{2029}h"),
            "a b c d e f g h"
        );
    }

    #[test]
    fn no_condition_results_have_null_detail() {
        let t = tr(vec![st(A, Some(resp(503, 10)), Some("status"))]);
        let r = judge(&one_step(), &panel(LatencySource::Total), &t, 1);
        assert_eq!(r.detail, None);
        let r = judge(
            &one_step(),
            &panel(LatencySource::Step { step_id: B.into() }),
            &t,
            1,
        );
        assert_eq!(r.detail, None);
    }

    #[tokio::test]
    async fn run_check_condition_step_missing_sends_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;
        let (db, id) = db_with(&yaml_for(&format!("{}/a", server.uri()))).await;
        let p = PanelConfig {
            scenario_id: id,
            conditions: vec![cond(
                "01HX0000000000000000000009",
                Src::Body,
                "$.v",
                Op::Eq,
                "x",
            )],
            ..PanelConfig::default()
        };
        let (trace, r) = run_check(&db, &p).await;
        assert!(trace.is_none());
        assert_eq!(r.verdict, Verdict::ConfigError);
        assert_eq!(r.reason.as_deref(), Some("조건 기준 스텝 없음"));
    }

    #[tokio::test]
    async fn run_check_condition_fail_against_wiremock() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"resultCode":"E1023"}"#))
            .mount(&server)
            .await;
        let (db, id) = db_with(&yaml_for(&format!("{}/a", server.uri()))).await;
        let p = PanelConfig {
            scenario_id: id,
            conditions: vec![cond(A, Src::Body, "$.resultCode", Op::Eq, "0000")],
            ..PanelConfig::default()
        };
        let (trace, r) = run_check(&db, &p).await;
        assert!(trace.is_some());
        assert_eq!(r.verdict, Verdict::Fail);
        assert_eq!(r.reason.as_deref(), Some("E1023"));
    }
}
