//! 추출 기본값 — 부하 경로 세 진입점(extract-default R2–R4).
//! 서버가 실제로 받은 요청(와이어)으로 단언한다.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{
    ErrorKind, MetricFlush, RampDown, RunPlan, Scenario, run_scenario, run_scenario_open_loop,
    run_scenario_vu_curve,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, ResponseTemplate};

const ORD_ID: &str = "01HX0000000000000000000003";
const PAGE_ID: &str = "01HX0000000000000000000004";
const A_ID: &str = "01HX0000000000000000000005";
const X_ID: &str = "01HX0000000000000000000006";

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

fn plan(ms: u64) -> RunPlan {
    RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(ms),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
        connect_timeout: None,
    }
}

struct Out {
    ok: bool,
    flushes: Vec<MetricFlush>,
}

async fn run_mode(yaml: &str, ms: u64, mode: Mode) -> Out {
    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let mut p = plan(ms);
    if let Mode::Open = mode {
        p.target_rps = Some(50);
        p.max_in_flight = Some(4);
    }
    if let Mode::Curve = mode {
        p.vu_stages = Some(vec![handicap_engine::Stage {
            target: 1,
            duration_seconds: (ms / 1000).max(1) as u32,
        }]);
    }
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(1024);
    let cancel = CancellationToken::new();
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, p, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, p, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, p, tx, cancel)),
    };
    let mut flushes = Vec::new();
    while let Some(f) = rx.recv().await {
        flushes.push(f);
    }
    let ok = h.await.expect("join").is_ok();
    Out { ok, flushes }
}

fn kind_count(out: &Out, step_id: &str, kind: ErrorKind) -> u64 {
    out.flushes
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .filter(|s| s.step_id == step_id && s.kind == kind)
        .map(|s| s.count)
        .sum()
}

fn step_errors(out: &Out, step_id: &str) -> u64 {
    out.flushes
        .iter()
        .flat_map(|f| f.windows.iter())
        .filter(|w| w.step_id == step_id)
        .map(|w| w.error_count)
        .sum()
}

async fn paths(server: &MockServer) -> Vec<String> {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| r.url.path().to_string())
        .collect()
}

async fn received(server: &MockServer, prefix: &str) -> usize {
    paths(server)
        .await
        .iter()
        .filter(|p| p.starts_with(prefix))
        .count()
}

fn json_resp(body: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_string(body)
}

fn fill(tpl: &str, uri: &str, def: &str) -> String {
    tpl.replace("{URI}", uri).replace("{DEF}", def)
}

/// 조건 반복(`state ne DONE`)이 `state`를 뽑아 **조건으로** 끝난 뒤 `GET /orders/{{orderId}}`.
/// `{DEF}`는 orderId 추출 항목에 붙는 `, default: none` 또는 빈 글자.
const US1: &str = r#"version: 1
name: ed-us1
variables: { state: "" }
steps:
  - id: "01HX0000000000000000000001"
    name: lp
    type: loop
    while: { left: "{{state}}", op: ne, right: "DONE" }
    repeat: 2
    do:
      - { id: "01HX0000000000000000000002", name: poll, type: http, request: { method: GET, url: "{URI}/poll" }, assert: [], extract: [{ var: state, from: body, path: "$.state" }, { var: orderId, from: body, path: "$.orderId"{DEF} }] }
  - { id: "01HX0000000000000000000003", name: ord, type: http, request: { method: GET, url: "{URI}/orders/{{orderId}}" }, assert: [] }
"#;

async fn us1_case(mode: Mode) {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"state":"DONE"}"#))
        .mount(&server)
        .await;
    let out = run_mode(&fill(US1, &server.uri(), ", default: none"), 1200, mode).await;
    assert!(out.ok);
    assert!(
        received(&server, "/orders/none").await > 0,
        "default value was not used in the url: {:?}",
        paths(&server).await
    );
    assert_eq!(kind_count(&out, ORD_ID, ErrorKind::BlankVar), 0);
}

#[tokio::test]
async fn us1_default_unblocks_url_after_loop_closed() {
    us1_case(Mode::Closed).await;
}

#[tokio::test]
async fn us1_default_unblocks_url_after_loop_curve() {
    us1_case(Mode::Curve).await;
}

#[tokio::test]
async fn us1_default_unblocks_url_after_loop_open() {
    us1_case(Mode::Open).await;
}

#[tokio::test]
async fn no_default_behaviour_unchanged() {
    // 기본값이 없으면 지금과 같다: 비워진 값이 주소에 쓰여 보내지 않는다. 이 변경 전후 모두 통과해야 한다.
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"state":"DONE"}"#))
        .mount(&server)
        .await;
    let out = run_mode(&fill(US1, &server.uri(), ""), 1200, Mode::Closed).await;
    assert!(out.ok);
    assert_eq!(received(&server, "/orders/").await, 0);
    assert!(kind_count(&out, ORD_ID, ErrorKind::BlankVar) > 0);
}

/// 자기 주소에 직전 응답의 커서를 쓰는 조건 반복. `{DEF}`는 cursor 추출 항목에 붙는 글자.
const US2: &str = r#"version: 1
name: ed-us2
variables: { cursor: start, state: "" }
steps:
  - id: "01HX0000000000000000000001"
    name: lp
    type: loop
    while: { left: "{{state}}", op: ne, right: "DONE" }
    repeat: 5
    do:
      - { id: "01HX0000000000000000000004", name: page, type: http, request: { method: GET, url: "{URI}/page/{{cursor}}" }, assert: [], extract: [{ var: state, from: body, path: "$.state" }, { var: cursor, from: body, path: "$.next"{DEF} }] }
"#;

#[tokio::test]
async fn us2_self_cursor_recovers() {
    let server = MockServer::start().await;
    Mock::given(path("/page/start"))
        .respond_with(json_resp(r#"{"state":"WAIT"}"#))
        .mount(&server)
        .await;
    Mock::given(path("/page/restart"))
        .respond_with(json_resp(r#"{"state":"DONE","next":"n2"}"#))
        .mount(&server)
        .await;
    let out = run_mode(
        &fill(US2, &server.uri(), ", default: restart"),
        1200,
        Mode::Closed,
    )
    .await;
    assert!(out.ok);
    assert!(
        received(&server, "/page/restart").await >= 1,
        "{:?}",
        paths(&server).await
    );
    assert_eq!(kind_count(&out, PAGE_ID, ErrorKind::BlankVar), 0);
}

/// 조건 반복 밖: 필드가 없을 때도 있는 응답 → `if`가 기본값을 읽어 갈라진다.
const US3: &str = r#"version: 1
name: ed-us3
steps:
  - { id: "01HX0000000000000000000005", name: a, type: http, request: { method: GET, url: "{URI}/a" }, assert: [], extract: [{ var: coupon, from: body, path: "$.couponId", default: none }] }
  - id: "01HX0000000000000000000009"
    name: c
    type: if
    cond: { left: "{{coupon}}", op: eq, right: "none" }
    then:
      - { id: "01HX0000000000000000000006", name: nc, type: http, request: { method: GET, url: "{URI}/no-coupon" }, assert: [] }
    else:
      - { id: "01HX0000000000000000000007", name: c, type: http, request: { method: GET, url: "{URI}/coupon" }, assert: [] }
"#;

#[tokio::test]
async fn us3_outside_loop_missing_field_is_not_error() {
    let server = MockServer::start().await;
    Mock::given(path("/a"))
        .respond_with(json_resp("{}"))
        .mount(&server)
        .await;
    let out = run_mode(&fill(US3, &server.uri(), ""), 800, Mode::Closed).await;
    assert!(out.ok);
    assert_eq!(step_errors(&out, A_ID), 0);
    assert!(received(&server, "/no-coupon").await > 0);
    assert_eq!(received(&server, "/coupon").await, 0);
}

const TRANSPORT: &str = r#"version: 1
name: ed-transport
steps:
  - { id: "01HX0000000000000000000005", name: dead, type: http, request: { method: GET, url: "http://127.0.0.1:1/t" }, assert: [], extract: [{ var: t, from: body, path: "$.t", default: none }] }
  - { id: "01HX0000000000000000000006", name: next, type: http, request: { method: GET, url: "{URI}/next/{{t}}" }, assert: [] }
"#;

#[tokio::test]
async fn outside_loop_transport_failure_fills_default() {
    let server = MockServer::start().await;
    let out = run_mode(&fill(TRANSPORT, &server.uri(), ""), 800, Mode::Closed).await;
    assert!(out.ok);
    assert!(
        received(&server, "/next/none").await > 0,
        "{:?}",
        paths(&server).await
    );
}

/// 조건 반복이 `id`를 비우고(기본값 없음) 조건으로 끝난다 → 막힌 스텝의 기본값이 뒤로 이어진다.
const BLOCKED: &str = r#"version: 1
name: ed-blocked
variables: { state: "" }
steps:
  - id: "01HX0000000000000000000001"
    name: lp
    type: loop
    while: { left: "{{state}}", op: ne, right: "DONE" }
    repeat: 2
    do:
      - { id: "01HX0000000000000000000002", name: poll, type: http, request: { method: GET, url: "{URI}/poll" }, assert: [], extract: [{ var: state, from: body, path: "$.state" }, { var: id, from: body, path: "$.id" }] }
  - { id: "01HX0000000000000000000006", name: x, type: http, request: { method: GET, url: "{URI}/x/{{id}}" }, assert: [], extract: [{ var: r, from: body, path: "$.r", default: none }] }
  - { id: "01HX0000000000000000000007", name: y, type: http, request: { method: GET, url: "{URI}/y/{{r}}" }, assert: [] }
"#;

#[tokio::test]
async fn outside_loop_blocked_fills_default() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"state":"DONE"}"#))
        .mount(&server)
        .await;
    let out = run_mode(&fill(BLOCKED, &server.uri(), ""), 1200, Mode::Closed).await;
    assert!(out.ok);
    assert!(kind_count(&out, X_ID, ErrorKind::BlankVar) > 0);
    assert_eq!(received(&server, "/x/").await, 0, "blank url was sent");
    assert!(
        received(&server, "/y/none").await > 0,
        "{:?}",
        paths(&server).await
    );
}

/// 이름이 겹친 요청 단위 생성 변수는 기본값을 덮어쓰지 않는다.
const REGEN: &str = r#"version: 1
name: ed-regen
variables: { tok: { gen: uuid, refresh: request } }
steps:
  - { id: "01HX0000000000000000000008", name: s1, type: http, request: { method: GET, url: "{URI}/s1" }, assert: [], extract: [{ var: tok, from: body, path: "$.tok", default: fixed }] }
  - { id: "01HX0000000000000000000006", name: u2, type: http, request: { method: GET, url: "{URI}/u/{{tok}}" }, assert: [] }
  - { id: "01HX0000000000000000000007", name: u3, type: http, request: { method: GET, url: "{URI}/u/{{tok}}" }, assert: [] }
"#;

#[tokio::test]
async fn default_stops_request_regen() {
    let server = MockServer::start().await;
    Mock::given(path("/s1"))
        .respond_with(json_resp("{}"))
        .mount(&server)
        .await;
    let out = run_mode(&fill(REGEN, &server.uri(), ""), 800, Mode::Closed).await;
    assert!(out.ok);
    let us: Vec<String> = paths(&server)
        .await
        .into_iter()
        .filter(|p| p.starts_with("/u/"))
        .collect();
    assert!(us.len() >= 2, "{us:?}");
    assert!(us.iter().all(|p| p == "/u/fixed"), "{us:?}");
}

/// 조건 반복이 `id`를 비움 표에 올리고(기본값 없음) 조건으로 끝난 뒤, 중간 스텝이 `id`에 기본값을 넣는다.
const CLEAR: &str = r#"version: 1
name: ed-clear
variables: { state: "" }
steps:
  - id: "01HX0000000000000000000001"
    name: lp
    type: loop
    while: { left: "{{state}}", op: ne, right: "DONE" }
    repeat: 2
    do:
      - { id: "01HX0000000000000000000002", name: poll, type: http, request: { method: GET, url: "{URI}/poll" }, assert: [], extract: [{ var: state, from: body, path: "$.state" }, { var: id, from: body, path: "$.id" }] }
  - { id: "01HX0000000000000000000005", name: mid, type: http, request: { method: GET, url: "{URI}/mid" }, assert: [], extract: [{ var: id, from: body, path: "$.id"{DEF} }] }
  - { id: "01HX0000000000000000000006", name: z, type: http, request: { method: GET, url: "{URI}/z/{{id}}" }, assert: [] }
"#;

async fn clear_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"state":"DONE"}"#))
        .mount(&server)
        .await;
    Mock::given(path("/mid"))
        .respond_with(json_resp("{}"))
        .mount(&server)
        .await;
    server
}

// 앞서 비워진 이름이 뒤 스텝의 기본값으로 주소에 쓸 수 있게 되는 흐름을 고정한다.
// 비움 표 항목이 지워지는지는 고정하지 않는다: `blank_guard::check`는 이름이 표에 있고 값이 비어 있을
// 때만 막는데 기본값은 비지 않아 관찰할 수 없다(`filled.defaulted`를 note_step에 넘겨도 초록이었다).
#[tokio::test]
async fn default_unblocks_name_blanked_earlier() {
    let server = clear_server().await;
    let out = run_mode(
        &fill(CLEAR, &server.uri(), ", default: none"),
        1200,
        Mode::Closed,
    )
    .await;
    assert!(out.ok);
    assert!(
        received(&server, "/z/none").await > 0,
        "{:?}",
        paths(&server).await
    );
    assert_eq!(kind_count(&out, X_ID, ErrorKind::BlankVar), 0);
}

#[tokio::test]
async fn default_unblocks_name_blanked_earlier_control_without_default_stays_blocked() {
    // 통제: 중간 스텝에 기본값이 없으면 id가 표에 남아 마지막 스텝이 막힌다(위 테스트가 공허하지 않다는 증거).
    let server = clear_server().await;
    let out = run_mode(&fill(CLEAR, &server.uri(), ""), 1200, Mode::Closed).await;
    assert!(out.ok);
    assert_eq!(received(&server, "/z/").await, 0);
    assert!(kind_count(&out, X_ID, ErrorKind::BlankVar) > 0);
}
