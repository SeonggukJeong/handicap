//! 비워진 값이 든 주소는 보내지 않는다 — 부하 경로 세 진입점(blank-var-url-guard R1–R3).
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

const LOOP_ID: &str = "01HX0000000000000000000001";
const POLL_ID: &str = "01HX0000000000000000000002";
const DEL_ID: &str = "01HX0000000000000000000003";
const AFTER_ID: &str = "01HX0000000000000000000004";
const PRE_ID: &str = "01HX0000000000000000000005";
const DETAIL_ID: &str = "01HX0000000000000000000006";
const PAR_ID: &str = "01HX0000000000000000000007";

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

const MODES: [Mode; 3] = [Mode::Closed, Mode::Curve, Mode::Open];

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

struct Win {
    count: u64,
    errors: u64,
    status_total: u64,
    hist_samples: u64,
}

fn win(out: &Out, step_id: &str) -> Win {
    let mut w = Win {
        count: 0,
        errors: 0,
        status_total: 0,
        hist_samples: 0,
    };
    for x in out
        .flushes
        .iter()
        .flat_map(|f| f.windows.iter())
        .filter(|w| w.step_id == step_id)
    {
        w.count += x.count;
        w.errors += x.error_count;
        w.status_total += x.status_counts.values().sum::<u64>();
        w.hist_samples += x.histogram.len();
    }
    w
}

fn kind_count(out: &Out, step_id: &str, kind: ErrorKind) -> u64 {
    out.flushes
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .filter(|s| s.step_id == step_id && s.kind == kind)
        .map(|s| s.count)
        .sum()
}

fn phase_total(out: &Out, step_id: &str) -> u64 {
    out.flushes
        .iter()
        .flat_map(|f| f.phase_stats.iter())
        .filter(|p| p.step_id == step_id && p.phase.starts_with("loop_"))
        .map(|p| p.count)
        .sum()
}

async fn received(server: &MockServer, prefix: &str) -> usize {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.url.path().starts_with(prefix))
        .count()
}

fn http(id: &str, name: &str, method: &str, req_tail: &str, suffix: &str) -> String {
    format!(
        r#"- {{ id: "{id}", name: {name}, type: http, request: {{ method: {method}, url: "BASE{req_tail} }}, assert: []{suffix} }}"#
    )
}

fn poll_step() -> String {
    http(
        POLL_ID,
        "poll",
        "GET",
        r#"/poll""#,
        r#", extract: [{ var: orderId, from: body, path: "$.orderId" }, { var: code, from: body, path: "$.code" }]"#,
    )
}

fn loop_block(body: &str) -> String {
    format!(
        r#"- id: "{LOOP_ID}"
  name: lp
  type: loop
  while: {{ left: "{{{{code}}}}", op: eq, right: "WAIT" }}
  repeat: 3
  do:
{}"#,
        indent(body, 4)
    )
}

fn indent(body: &str, n: usize) -> String {
    let pad = " ".repeat(n);
    body.lines()
        .map(|l| format!("{pad}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn scenario_yaml(base: &str, vars: &str, steps: &[String]) -> String {
    let body = steps.join("\n");
    format!(
        "version: 1\nname: blank-guard\nvariables: {{ {vars} }}\nsteps:\n{}\n",
        indent(&body, 2)
    )
    .replace("BASE", base)
}

fn delete_step(suffix: &str) -> String {
    http(DEL_ID, "del", "DELETE", r#"/orders/{{orderId}}""#, suffix)
}

fn after_step() -> String {
    http(AFTER_ID, "after", "GET", r#"/after""#, "")
}

/// Y1: loop(while code==WAIT) { poll } → DELETE /orders/{{orderId}} → GET /after.
fn y1(base: &str) -> String {
    scenario_yaml(
        base,
        r#"code: """#,
        &[loop_block(&poll_step()), delete_step(""), after_step()],
    )
}

/// `/poll`이 둘 다 없는 `{}`을 준다.
async fn mount_empty_poll(server: &MockServer) {
    Mock::given(path("/poll"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .mount(server)
        .await;
}

fn json_resp(body: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_string(body)
}

async fn blocked_case(mode: Mode) {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let out = run_mode(&y1(&server.uri()), 1500, mode).await;
    assert!(out.ok);
    assert_eq!(received(&server, "/orders/").await, 0, "blank url was sent");
    assert!(received(&server, "/after").await >= 1);
    let w = win(&out, DEL_ID);
    assert!(w.count > 0, "no blocked count");
    assert_eq!(w.count, w.errors);
    assert_eq!(w.status_total, 0);
    assert_eq!(w.hist_samples, 0);
    assert_eq!(kind_count(&out, DEL_ID, ErrorKind::BlankVar), w.count);
}

#[tokio::test]
async fn blocked_url_is_not_sent_closed() {
    blocked_case(Mode::Closed).await;
}

#[tokio::test]
async fn blocked_url_is_not_sent_curve() {
    blocked_case(Mode::Curve).await;
}

#[tokio::test]
async fn blocked_url_is_not_sent_open() {
    blocked_case(Mode::Open).await;
}

#[tokio::test]
async fn header_and_body_use_still_sent() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let post = format!(
        r#"- {{ id: "{DEL_ID}", name: post, type: http, request: {{ method: POST, url: "BASE/orders", headers: {{ X-Id: "{{{{orderId}}}}" }}, body: {{ json: {{ id: "{{{{orderId}}}}" }} }} }}, assert: [] }}"#
    );
    let y = scenario_yaml(
        &server.uri(),
        r#"code: """#,
        &[loop_block(&poll_step()), post, after_step()],
    );
    let out = run_mode(&y, 800, Mode::Closed).await;
    assert!(out.ok);
    assert!(received(&server, "/orders").await >= 1);
    assert_eq!(kind_count(&out, DEL_ID, ErrorKind::BlankVar), 0);
}

#[tokio::test]
async fn reextract_unblocks() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"code":"WAIT"}"#))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"code":"DONE","orderId":"7"}"#))
        .mount(&server)
        .await;
    let out = run_mode(&y1(&server.uri()), 800, Mode::Closed).await;
    assert!(out.ok);
    assert!(received(&server, "/orders/7").await >= 1);
    assert_eq!(kind_count(&out, DEL_ID, ErrorKind::BlankVar), 0);
}

#[tokio::test]
async fn real_empty_after_blank_clears_table() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"code":"WAIT"}"#))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"code":"DONE","orderId":""}"#))
        .mount(&server)
        .await;
    let out = run_mode(&y1(&server.uri()), 800, Mode::Closed).await;
    assert!(out.ok);
    assert!(received(&server, "/orders/").await >= 1);
    assert_eq!(kind_count(&out, DEL_ID, ErrorKind::BlankVar), 0);
}

async fn resets_case(mode: Mode) {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let pre = http(PRE_ID, "pre", "GET", r#"/pre/{{orderId}}""#, "");
    let y = scenario_yaml(
        &server.uri(),
        r#"code: "", orderId: """#,
        &[pre, loop_block(&poll_step()), delete_step(""), after_step()],
    );
    let out = run_mode(&y, 1500, mode).await;
    assert!(out.ok);
    let w = win(&out, PRE_ID);
    assert!(w.count >= 5, "too few iterations: {}", w.count);
    assert_eq!(received(&server, "/pre/").await as u64, w.count);
    assert_eq!(kind_count(&out, PRE_ID, ErrorKind::BlankVar), 0);
}

#[tokio::test]
async fn table_resets_each_iteration_closed() {
    resets_case(Mode::Closed).await;
}

#[tokio::test]
async fn table_resets_each_iteration_curve() {
    resets_case(Mode::Curve).await;
}

#[tokio::test]
async fn table_resets_each_iteration_open() {
    resets_case(Mode::Open).await;
}

#[tokio::test]
async fn blank_plus_unknown_var_does_not_kill_vu() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let del = http(
        DEL_ID,
        "del",
        "DELETE",
        r#"/orders/{{orderId}}/{{nope}}""#,
        "",
    );
    let y = scenario_yaml(
        &server.uri(),
        r#"code: """#,
        &[loop_block(&poll_step()), del, after_step()],
    );
    let out = run_mode(&y, 800, Mode::Closed).await;
    assert!(out.ok, "run failed (VU killed?)");
    assert!(received(&server, "/after").await >= 2);
}

#[tokio::test]
async fn blocked_step_still_paces() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let y = scenario_yaml(
        &server.uri(),
        r#"code: """#,
        &[
            loop_block(&poll_step()),
            delete_step(", think_time: { min_ms: 200, max_ms: 200 }"),
            after_step(),
        ],
    );
    let out = run_mode(&y, 1000, Mode::Closed).await;
    assert!(out.ok);
    let w = win(&out, DEL_ID);
    assert!(w.count >= 1 && w.count <= 6, "count={}", w.count);
}

#[tokio::test]
async fn real_empty_string_not_blocked() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"orderId":"","code":"DONE"}"#))
        .mount(&server)
        .await;
    let out = run_mode(&y1(&server.uri()), 800, Mode::Closed).await;
    assert!(out.ok);
    assert!(received(&server, "/orders/").await >= 1);
    assert_eq!(kind_count(&out, DEL_ID, ErrorKind::BlankVar), 0);
}

#[tokio::test]
async fn later_body_step_blocked_in_same_pass() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let detail = http(DETAIL_ID, "detail", "GET", r#"/detail/{{orderId}}""#, "");
    let body = format!("{}\n{}", poll_step(), detail);
    let y = scenario_yaml(
        &server.uri(),
        r#"code: """#,
        &[loop_block(&body), after_step()],
    );
    let out = run_mode(&y, 800, Mode::Closed).await;
    assert!(out.ok);
    assert_eq!(received(&server, "/detail/").await, 0);
    assert!(kind_count(&out, DETAIL_ID, ErrorKind::BlankVar) > 0);
    assert_eq!(phase_total(&out, DETAIL_ID), 0);
    assert!(phase_total(&out, POLL_ID) > 0, "positive control");
}

#[tokio::test]
async fn parallel_branch_blank_blocks_namespaced_url() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let branch_loop = loop_block(&poll_step());
    let par = format!(
        "- id: \"{PAR_ID}\"\n  name: fan\n  type: parallel\n  branches:\n    - name: b\n      steps:\n{}",
        indent(&branch_loop, 8)
    );
    let del = http(DEL_ID, "del", "DELETE", r#"/orders/{{b.orderId}}""#, "");
    let y = scenario_yaml(&server.uri(), r#"code: """#, &[par, del, after_step()]);
    let out = run_mode(&y, 800, Mode::Closed).await;
    assert!(out.ok);
    assert_eq!(received(&server, "/orders/").await, 0);
    assert!(kind_count(&out, DEL_ID, ErrorKind::BlankVar) > 0);
}

#[tokio::test]
async fn r0_no_cond_loop_unchanged() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    Mock::given(path("/after"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let poll = http(POLL_ID, "poll", "GET", r#"/poll""#, "");
    let y = scenario_yaml(&server.uri(), r#"code: """#, &[poll, after_step()]);
    for mode in MODES {
        let out = run_mode(&y, 600, mode).await;
        assert!(out.ok);
        assert!(
            out.flushes
                .iter()
                .flat_map(|f| f.error_kind_stats.iter())
                .all(|s| s.kind != ErrorKind::BlankVar)
        );
        for f in &out.flushes {
            for w in &f.windows {
                assert_eq!(w.count, w.status_counts.values().sum::<u64>());
            }
        }
    }
}
