//! 점검 1회(`run_check`)와 순수 판정(`judge`) — spec §6.1–6.2.
//!
//! 벽 화면에 나가는 `reason`은 이 파일의 고정 문구 + 시나리오 작성자의 스텝 이름뿐이다.
//! 엔진 error 원문은 `starts_with` 분류에만 쓰고 절대 `reason`에 싣지 않는다.

use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::{
    Assertion, HttpStep, Scenario, ScenarioTrace, Step, StepKind, StepTrace, TraceOptions,
    trace_scenario,
};
use serde::{Deserialize, Serialize};

use super::config::{LatencySource, PanelConfig};
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
}

impl CheckResult {
    fn with_reason(at_ms: i64, verdict: Verdict, reason: impl Into<String>) -> Self {
        Self {
            at_ms,
            verdict,
            latency_ms: None,
            reason: Some(reason.into()),
        }
    }
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
                reason: None
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
}
