//! 조건 반복(loop + while) 실행 — do-while 의미·EndIteration·너그러운 추출 (loop-do-while T3).
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, ResponseTemplate};

const ORDER_ID: &str = "01HX0000000000000000000002";

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
    elapsed: Duration,
    flushes: Vec<MetricFlush>,
}

async fn run(yaml: &str, ms: u64) -> Out {
    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(1024);
    let t0 = Instant::now();
    let h = tokio::spawn(run_scenario(
        scenario,
        plan(ms),
        tx,
        CancellationToken::new(),
    ));
    let mut flushes = Vec::new();
    while let Some(f) = rx.recv().await {
        flushes.push(f);
    }
    let ok = h.await.expect("join").is_ok();
    Out {
        ok,
        elapsed: t0.elapsed(),
        flushes,
    }
}

fn errors_of(out: &Out, step: &str) -> u64 {
    out.flushes
        .iter()
        .flat_map(|f| f.windows.iter())
        .filter(|w| w.step_id == step)
        .map(|w| w.error_count)
        .sum()
}

async fn paths(server: &MockServer) -> Vec<String> {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| match r.url.query() {
            Some(q) => format!("{}?{}", r.url.path(), q),
            None => r.url.path().to_string(),
        })
        .collect()
}

fn count(p: &[String], prefix: &str) -> usize {
    p.iter().filter(|s| s.starts_with(prefix)).count()
}

fn wait_resp() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_string(r#"{"code":"WAIT"}"#)
}
fn ok_resp() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_string(r#"{"code":"OK"}"#)
}

/// [first] → loop(order) → after
fn scenario_yaml(base: &str, loop_head: &str, order_extra: &str, with_first: bool) -> String {
    let first = if with_first {
        r#"  - id: "01HX0000000000000000000009"
    name: first
    type: http
    request: { method: GET, url: "{{base}}/first" }
    assert: []
"#
    } else {
        ""
    };
    format!(
        r#"version: 1
name: while-test
variables:
  base: "{base}"
  code: ""
steps:
{first}  - id: "01HX0000000000000000000001"
    name: poll
    type: loop
{loop_head}
    do:
      - id: "{ORDER_ID}"
        name: order
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/order?i=${{loop_index}}" }}
        assert: []
{order_extra}        extract:
          - {{ var: code, from: body, path: "$.code" }}
  - id: "01HX0000000000000000000003"
    name: after
    type: http
    request: {{ method: GET, url: "{{{{base}}}}/after?c={{{{code}}}}" }}
    assert: []
"#
    )
}

const WHILE_WAIT: &str = r#"    while: { left: "{{code}}", op: eq, right: "WAIT" }"#;

async fn mount_after(server: &MockServer) {
    Mock::given(path("/after"))
        .respond_with(ResponseTemplate::new(200))
        .mount(server)
        .await;
}

#[tokio::test]
async fn while_false_first_pass_runs_once() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(ok_resp())
        .mount(&server)
        .await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run(&y, 600).await;
    assert!(out.ok);
    let p = paths(&server).await;
    let (o, a) = (count(&p, "/order"), count(&p, "/after"));
    assert!(a >= 1, "{a}");
    assert!(o == a || o == a + 1, "order={o} after={a}");
    assert!(
        p.iter()
            .filter(|s| s.starts_with("/order"))
            .all(|s| s == "/order?i=0")
    );
}

#[tokio::test]
async fn while_retries_until_ok() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(path("/order"))
        .respond_with(ok_resp())
        .mount(&server)
        .await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run(&y, 600).await;
    assert!(out.ok);
    let p = paths(&server).await;
    assert_eq!(
        &p[0..4],
        &["/order?i=0", "/order?i=1", "/order?i=2", "/after?c=OK"]
    );
}

/// 회귀 가드: repeat 소진 → 반복 종료(뒤 스텝 건너뜀), 다음 반복은 시작.
#[tokio::test]
async fn while_exhausted_ends_iteration_and_next_starts() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    Mock::given(path("/first"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    mount_after(&server).await;
    let head = format!("{WHILE_WAIT}\n    repeat: 3");
    let y = scenario_yaml(&server.uri(), &head, "", true);
    let out = run(&y, 800).await;
    assert!(out.ok);
    let p = paths(&server).await;
    let (f, o, a) = (
        count(&p, "/first"),
        count(&p, "/order"),
        count(&p, "/after"),
    );
    assert_eq!(a, 0);
    assert!(f >= 2, "다음 반복이 시작돼야 한다: first={f}");
    assert!(o >= 3 * (f - 1) && o <= 3 * f, "first={f} order={o}");
}

#[tokio::test]
async fn while_unlimited_stops_at_deadline() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    let think = "        think_time: { min_ms: 50, max_ms: 50 }\n";
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, think, false);
    let out = run(&y, 1000).await;
    assert!(out.ok);
    assert!(out.elapsed < Duration::from_secs(3), "{:?}", out.elapsed);
    assert_eq!(count(&paths(&server).await, "/after"), 0);
}

/// 회귀 가드(R0): while 없는 loop의 repeat: 0 = 본문 0회.
#[tokio::test]
async fn plain_loop_repeat_zero_runs_zero_times() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), "    repeat: 0", "", false);
    let out = run(&y, 500).await;
    assert!(out.ok);
    let p = paths(&server).await;
    assert_eq!(count(&p, "/order"), 0);
    assert!(count(&p, "/after") >= 1);
}

#[tokio::test]
async fn cond_loop_lenient_extract_keeps_retrying() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(path("/order"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"code":"OK","orderId":"7"}"#))
        .mount(&server)
        .await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false).replace(
        r#"          - { var: code, from: body, path: "$.code" }"#,
        r#"          - { var: code, from: body, path: "$.code" }
          - { var: orderId, from: body, path: "$.orderId" }"#,
    );
    let y = y.replace("after?c={{code}}", "after?o={{orderId}}");
    let out = run(&y, 600).await;
    assert!(out.ok);
    let p = paths(&server).await;
    assert_eq!(
        &p[0..4],
        &["/order?i=0", "/order?i=1", "/order?i=2", "/after?o=7"]
    );
    assert_eq!(errors_of(&out, ORDER_ID), 0);
}

async fn timeout_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(path("/order"))
        .respond_with(ok_resp().set_delay(Duration::from_millis(2500)))
        .mount(&server)
        .await;
    mount_after(&server).await;
    server
}

#[tokio::test]
async fn cond_loop_transport_failure_blanks_and_exits() {
    let to = "        timeout_seconds: 1\n";
    // 조건 반복: 실패한 회차의 code는 빈 문자열 → 조건 거짓 → 탈출. 그 빈 값을 주소에 쓰는
    // 뒤 스텝은 보내지 않고(blank-var-url-guard) 그 스텝의 에러로만 센다.
    let server = timeout_server().await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, to, false);
    let out = run(&y, 2500).await;
    assert!(out.ok);
    let p = paths(&server).await;
    assert_eq!(count(&p, "/after"), 0, "blank url was sent: {p:?}");
    // 탈출했다: 첫 회차 WAIT(i=0) → 두 번째 회차 시간 초과(i=1)에서 끝나 i=2는 없다.
    assert_eq!(&p[0..2], &["/order?i=0", "/order?i=1"]);
    assert_eq!(count(&p, "/order?i=2"), 0, "loop kept retrying: {p:?}");
    assert!(errors_of(&out, "01HX0000000000000000000003") > 0);

    // 대조: while 없는 loop은 실패 뒤에도 code가 WAIT으로 남는다.
    let server2 = timeout_server().await;
    let y = scenario_yaml(&server2.uri(), "    repeat: 2", to, false);
    let out = run(&y, 2500).await;
    assert!(out.ok);
    let p = paths(&server2).await;
    assert_eq!(
        p.iter().find(|s| s.starts_with("/after")).unwrap(),
        "/after?c=WAIT"
    );
}

#[tokio::test]
async fn cond_loop_no_request_body_stops_at_deadline() {
    let server = MockServer::start().await;
    let y = format!(
        r#"version: 1
name: noreq
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    while: {{ left: "1", op: eq, right: "1" }}
    do:
      - id: "01HX0000000000000000000004"
        name: gate
        type: if
        cond: {{ left: "a", op: eq, right: "b" }}
        then:
          - id: "01HX0000000000000000000005"
            name: never
            type: http
            request: {{ method: GET, url: "{{{{base}}}}/never" }}
            assert: []
"#,
        server.uri()
    );
    let out = run(&y, 1000).await;
    assert!(out.ok);
    assert!(out.elapsed < Duration::from_secs(3), "{:?}", out.elapsed);
}

/// 회귀 가드: 요청 없는 본문이어도 조건 반복이 실행기를 독점하지 않는다.
#[tokio::test(flavor = "current_thread")]
async fn cond_loop_no_request_body_yields_to_other_tasks() {
    let y = r#"version: 1
name: empty-body
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    while: { left: "1", op: eq, right: "1" }
    do: []
"#;
    let counter = Arc::new(AtomicU64::new(0));
    let c = counter.clone();
    let side = tokio::spawn(async move {
        loop {
            c.fetch_add(1, Ordering::Relaxed);
            tokio::task::yield_now().await;
        }
    });
    let out = run(y, 300).await;
    side.abort();
    assert!(out.ok);
    let n = counter.load(Ordering::Relaxed);
    assert!(n > 100, "옆 task가 굶었다: counter={n}");
}

#[tokio::test]
async fn parallel_branch_end_iteration_priority() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    Mock::given(path("/side"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    mount_after(&server).await;
    let y = format!(
        r#"version: 1
name: par
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - id: "01HX0000000000000000000001"
            name: poll
            type: loop
            repeat: 1
            while: {{ left: "{{{{code}}}}", op: eq, right: "WAIT" }}
            do:
              - id: "{ORDER_ID}"
                name: order
                type: http
                request: {{ method: GET, url: "{{{{base}}}}/order" }}
                assert: []
                extract:
                  - {{ var: code, from: body, path: "$.code" }}
      - name: b
        steps:
          - {{ id: "01HX0000000000000000000011", name: side, type: http, request: {{ method: GET, url: "{{{{base}}}}/side" }}, assert: [] }}
  - id: "01HX0000000000000000000003"
    name: after
    type: http
    request: {{ method: GET, url: "{{{{base}}}}/after" }}
    assert: []
"#,
        server.uri()
    );
    let out = run(&y, 600).await;
    assert!(out.ok);
    let p = paths(&server).await;
    assert!(count(&p, "/order") >= 1);
    assert!(count(&p, "/side") >= 1);
    assert_eq!(count(&p, "/after"), 0);
    // EndIteration으로 끝난 블록은 페이지 지연 행(group_stats)을 남기지 않는다
    // (runner.rs `&& !end_iteration` — 일찍 끝난 블록이 분포를 낮게 왜곡하는 것을 막는다).
    let group_rows: usize = out
        .flushes
        .iter()
        .flat_map(|f| f.group_stats.iter())
        .filter(|g| g.step_id == "01HX0000000000000000000010")
        .count();
    assert_eq!(group_rows, 0, "EndIteration 블록에 group_stats 행이 남았다");
}
