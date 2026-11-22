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

// ---- 값이 빈 준비 요청은 보내지 않는다 (security S1) ----

/// 무엇이든 200 `{"token":"t1"}`로 답하는 서버.
async fn any_ok_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(wiremock::matchers::any())
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"t1"}"#))
        .mount(&server)
        .await;
    server
}

/// `setup_request`는 준비 스텝 `request:` 아래에 들어갈 YAML(6칸 들여쓰기 기준).
fn setup_scenario(base: &str, setup_request: &str) -> Scenario {
    let y = format!(
        r#"
version: 1
name: setup-unbound
setup:
  steps:
    - type: http
      id: 01HX0000000000000000000009
      name: login
      request:
{setup_request}
      extract:
        - {{ var: token, from: body, path: "$.token" }}
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: main
    request: {{ method: GET, url: "{base}/me" }}
"#
    );
    Scenario::from_yaml(&y).unwrap()
}

/// `setup_request(base)`가 만든 준비 요청에 미바인딩 변수가 있으면 단발·행 모드 모두
/// 서버가 요청을 하나도 받지 않고, 준비 행이 고정 오류·변수 이름·렌더한 요청을 싣는다.
async fn assert_unbound_setup_not_sent(
    setup_request: impl Fn(&str) -> String,
    expect_unbound: &[&str],
) {
    let server = any_ok_server().await;
    let scenario = setup_scenario(&server.uri(), &setup_request(&server.uri()));
    let trace = trace_scenario(&scenario, &opts(50)).await;
    let received = server.received_requests().await.unwrap();
    assert_eq!(
        received.len(),
        0,
        "준비 요청을 보내면 안 된다: {received:?}"
    );
    assert!(trace.setup_failed, "{trace:?}");
    assert!(!trace.ok);
    assert_eq!(trace.steps.len(), 1, "본 스텝은 실행하지 않는다");
    let row = &trace.steps[0];
    assert_eq!(row.section, Some(Section::Setup));
    assert_eq!(row.error.as_deref(), Some("setup: unbound variable"));
    assert!(row.response.is_none());
    for name in expect_unbound {
        assert!(
            row.unbound_vars.iter().any(|u| u == name),
            "{name} not in {:?}",
            row.unbound_vars
        );
    }
    assert!(row.request.is_some(), "렌더한 요청은 보여 준다");

    let rt = trace_scenario_rows(&scenario, &opts(50), &seed0()).await;
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
    assert!(rt.setup_failed, "{rt:?}");
    assert!(rt.rows.is_empty());
    assert_eq!(
        rt.setup_steps[0].error.as_deref(),
        Some("setup: unbound variable")
    );
}

#[tokio::test]
async fn trace_setup_unbound_url_is_not_sent() {
    assert_unbound_setup_not_sent(
        |base| {
            format!(
                r#"        method: POST
        url: "{base}/login/{{{{nope}}}}""#
            )
        },
        &["nope"],
    )
    .await;
}

#[tokio::test]
async fn trace_setup_unbound_json_leaf_is_not_sent() {
    assert_unbound_setup_not_sent(
        |base| {
            format!(
                r#"        method: POST
        url: "{base}/login"
        body:
          json:
            user: "u1"
            password: "{{{{password}}}}"
            age: "{{{{age:num}}}}""#
            )
        },
        &["password", "age"],
    )
    .await;
}

#[tokio::test]
async fn trace_setup_unbound_header_is_not_sent() {
    assert_unbound_setup_not_sent(
        |base| {
            format!(
                r#"        method: POST
        url: "{base}/login"
        headers:
          X-Api-Key: "${{API_PW}}""#
            )
        },
        &["API_PW"],
    )
    .await;
}

#[tokio::test]
async fn trace_setup_fully_bound_sends_once() {
    let server = any_ok_server().await;
    let base = server.uri();
    let scenario = setup_scenario(
        &base,
        &format!(
            r#"        method: POST
        url: "{base}/login"
        body:
          json:
            user: "u1""#
        ),
    );
    let trace = trace_scenario(&scenario, &opts(50)).await;
    assert!(trace.ok, "{trace:?}");
    let received = server.received_requests().await.unwrap();
    let logins = received.iter().filter(|r| r.url.path() == "/login").count();
    assert_eq!(logins, 1);
    assert_eq!(received.len(), 2, "준비 1 + 본 1");
    assert!(trace.steps[0].unbound_vars.is_empty());
}

// ---- 시드(데이터셋)가 준비 추출을 이긴다 (spec D11 순서: 시나리오 변수 → 준비 추출 → 시드) ----

/// 준비 스텝이 `n`을 뽑고(`"setup"`), 본 스텝은 `/orders?row={{n}}`로 보낸다.
async fn seed_vs_setup() -> (MockServer, Scenario) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"n":"setup"}"#))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/orders"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let base = server.uri();
    let y = format!(
        r#"
version: 1
name: seed-vs-setup
setup:
  steps:
    - type: http
      id: 01HX0000000000000000000009
      name: login
      request: {{ method: POST, url: "{base}/login" }}
      extract:
        - {{ var: n, from: body, path: "$.n" }}
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: orders
    request: {{ method: GET, url: "{base}/orders?row={{{{n}}}}" }}
"#
    );
    (server, Scenario::from_yaml(&y).unwrap())
}

fn seed_n(v: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("n".to_string(), v.to_string())])
}

#[tokio::test]
async fn trace_seed_wins_over_setup_extract_on_same_name() {
    let (_server, scenario) = seed_vs_setup().await;
    let trace =
        handicap_engine::trace_scenario_with_seed(&scenario, &opts(50), &seed_n("ds")).await;
    assert!(trace.ok, "{trace:?}");
    assert_eq!(trace.steps.len(), 2);
    assert_eq!(
        trace.steps[0].extracted.get("n").map(String::as_str),
        Some("setup")
    );
    let url = &trace.steps[1].request.as_ref().unwrap().url;
    assert!(url.ends_with("/orders?row=ds"), "{url}");
}

#[tokio::test]
async fn rows_trace_seed_wins_over_setup_extract_on_same_name() {
    let (_server, scenario) = seed_vs_setup().await;
    let rows = vec![(0u64, seed_n("r0")), (1u64, seed_n("r1"))];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    assert!(rt.ok, "{rt:?}");
    assert_eq!(rt.rows.len(), 2);
    for (i, row) in rt.rows.iter().enumerate() {
        let url = &row.trace.steps[0].request.as_ref().unwrap().url;
        assert!(url.ends_with(&format!("/orders?row=r{i}")), "{url}");
    }
}
