//! 준비 구간 trace 후속 — 직렬화 생략·실패 경로·http 아닌 준비 스텝.

use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::{
    Scenario, Section, SetupSection, TraceOptions, trace_scenario, trace_scenario_rows,
};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn opts(max_requests: u32) -> TraceOptions {
    TraceOptions {
        env: BTreeMap::new(),
        max_requests,
        max_wall: Duration::from_secs(120),
        apply_think_time: false,
    }
}

fn seed0() -> Vec<(u64, BTreeMap<String, String>)> {
    vec![(0u64, BTreeMap::new())]
}

#[tokio::test]
async fn rows_trace_without_setup_omits_setup_keys() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let y = format!(
        r#"
version: 1
name: rows
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{}/a" }}
"#,
        server.uri()
    );
    let scenario = Scenario::from_yaml(&y).unwrap();
    let rt = trace_scenario_rows(&scenario, &opts(50), &seed0()).await;
    let v = serde_json::to_value(&rt).unwrap();
    let obj = v.as_object().unwrap();
    for key in ["setup_steps", "setup_failed", "setup_ms"] {
        assert!(!obj.contains_key(key), "{key} must be omitted: {v}");
    }
}

#[tokio::test]
async fn rows_trace_failing_setup_runs_no_rows() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(401).set_body_string("denied"))
        .mount(&server)
        .await;
    let base = server.uri();
    let y = format!(
        r#"
version: 1
name: rows-setup-fail
setup:
  steps:
    - type: http
      id: 01HX0000000000000000000009
      name: login
      request: {{ method: POST, url: "{base}/login" }}
      extract:
        - {{ var: token, from: body, path: "$.token" }}
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: me
    request: {{ method: GET, url: "{base}/me" }}
"#
    );
    let scenario = Scenario::from_yaml(&y).unwrap();
    let rt = trace_scenario_rows(&scenario, &opts(50), &seed0()).await;
    assert!(rt.setup_failed, "{rt:?}");
    assert!(!rt.ok);
    assert!(rt.rows.is_empty());
    assert_eq!(rt.setup_steps.len(), 1);
    assert_eq!(rt.setup_steps[0].section, Some(Section::Setup));
    assert!(rt.setup_steps[0].error.is_some());
}

#[tokio::test]
async fn trace_setup_non_http_step_fails_loudly() {
    let y = r#"
version: 1
name: bad-setup
steps:
  - type: loop
    id: 01HX0000000000000000000011
    name: outer
    repeat: 1
    do:
      - type: http
        id: 01HX0000000000000000000012
        name: inner
        request: { method: GET, url: "http://127.0.0.1:1/x" }
"#;
    let mut scenario = Scenario::from_yaml(y).unwrap();
    scenario.setup = Some(SetupSection {
        steps: scenario.steps.clone(),
    });
    let trace = trace_scenario(&scenario, &opts(50)).await;
    assert!(trace.setup_failed, "{trace:?}");
    assert!(!trace.ok);
    assert_eq!(trace.steps.len(), 1);
    assert_eq!(trace.steps[0].section, Some(Section::Setup));
    assert_eq!(
        trace.steps[0].error.as_deref(),
        Some("setup: step 01HX0000000000000000000011 must be http")
    );
}
