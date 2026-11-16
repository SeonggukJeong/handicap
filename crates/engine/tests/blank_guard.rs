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

#[tokio::test]
async fn strict_reextract_outside_loop_clears_table() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    Mock::given(path("/refetch"))
        .respond_with(json_resp(r#"{"orderId":""}"#))
        .mount(&server)
        .await;
    // 조건 반복이 orderId를 비운 뒤, 반복 밖(엄격 모드) 스텝이 응답의 실제 빈 문자열로 다시 뽑는다.
    let refetch = http(
        PRE_ID,
        "refetch",
        "GET",
        r#"/refetch""#,
        r#", extract: [{ var: orderId, from: body, path: "$.orderId" }]"#,
    );
    let y = scenario_yaml(
        &server.uri(),
        r#"code: """#,
        &[
            loop_block(&poll_step()),
            refetch,
            delete_step(""),
            after_step(),
        ],
    );
    let out = run_mode(&y, 800, Mode::Closed).await;
    assert!(out.ok);
    assert!(received(&server, "/orders/").await >= 1);
    assert_eq!(kind_count(&out, DEL_ID, ErrorKind::BlankVar), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn blocked_spin_yields_to_other_tasks() {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    // 조건 반복이 orderId를 비운 뒤, while 없는 큰 반복 안의 차단 스텝(think time 없음)이 돈다.
    let lp = format!(
        "- id: \"{PRE_ID}\"\n  name: spin\n  type: loop\n  repeat: 200000\n  do:\n{}",
        indent(&delete_step(""), 4)
    );
    let y = scenario_yaml(
        &server.uri(),
        r#"code: """#,
        &[loop_block(&poll_step()), lp],
    );
    let counter = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let ticker = {
        let (counter, stop) = (counter.clone(), stop.clone());
        tokio::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                counter.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        })
    };
    let out = run_mode(&y, 1000, Mode::Closed).await;
    stop.store(true, Ordering::Relaxed);
    ticker.await.unwrap();
    assert!(out.ok);
    let passes = win(&out, DEL_ID).count;
    let ticks = counter.load(Ordering::Relaxed);
    assert!(passes > 1000, "too few blocked passes: {passes}");
    // 차단 패스마다 양보하면 다른 task가 패스와 거의 같은 횟수로 돈다(양보가 없으면 코루틴 예산
    // 강제 양보로 passes/128 안팎).
    assert!(ticks * 4 >= passes, "ticks={ticks} passes={passes}");
}

#[tokio::test]
async fn refreshed_generated_var_is_not_blocked() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let y = scenario_yaml(
        &server.uri(),
        r#"code: "", orderId: { gen: uuid, refresh: request }"#,
        &[loop_block(&poll_step()), delete_step(""), after_step()],
    );
    let out = run_mode(&y, 800, Mode::Closed).await;
    assert!(out.ok);
    let sent: Vec<String> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| r.url.path().to_string())
        .filter(|p| p.starts_with("/orders/"))
        .collect();
    assert!(!sent.is_empty(), "refreshed value should not be blocked");
    assert!(sent.iter().all(|p| p.len() > "/orders/".len()), "{sent:?}");
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
async fn null_extract_in_loop_blocks_url() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(json_resp(r#"{"orderId":null,"code":null}"#))
        .mount(&server)
        .await;
    let out = run_mode(&y1(&server.uri()), 800, Mode::Closed).await;
    assert!(out.ok);
    assert_eq!(received(&server, "/orders/").await, 0, "null url was sent");
    assert!(kind_count(&out, DEL_ID, ErrorKind::BlankVar) > 0);
}

/// 자기 잠금 반복: `while state ne DONE`(최대 횟수 없음) 본문 = 자기 주소에 자기가 뽑는 `etag`를
/// 쓰는 스텝 하나. `etag`가 빠진 응답 한 번이면 다음 회차부터 그 스텝은 늘 막힌다.
fn self_lock_yaml(base: &str) -> String {
    let jobs = http(
        DETAIL_ID,
        "jobs",
        "GET",
        r#"/jobs/{{id}}?since={{etag}}""#,
        r#", extract: [{ var: etag, from: body, path: "$.etag" }, { var: state, from: body, path: "$.state" }]"#,
    );
    let lp = format!(
        "- id: \"{LOOP_ID}\"\n  name: lp\n  type: loop\n  while: {{ left: \"{{{{state}}}}\", op: ne, right: \"DONE\" }}\n  do:\n{}",
        indent(&jobs, 4)
    );
    scenario_yaml(base, r#"id: "1", etag: "", state: """#, &[lp, after_step()])
}

/// 반복을 끝낸 회차 수 판정: 뒤 스텝은 한 번도 안 가고, 반복마다 본문을 한 번 보내고 한 번 막힌다.
/// 막힌 회차가 반복을 계속 돌면(빈 회전) `blocked`가 `sent`보다 훨씬 크다. 창 `count`는 막힌
/// 건도 센다(`record_not_sent`) — 보낸 건수는 와이어로 잰다.
async fn assert_dead_pass_ends_iteration(out: &Out, server: &MockServer) {
    assert!(out.ok);
    let after = win(out, AFTER_ID).count;
    let body = win(out, DETAIL_ID).count;
    let sent = received(server, "/jobs/").await as u64;
    let blocked = kind_count(out, DETAIL_ID, ErrorKind::BlankVar);
    assert_eq!(after, 0, "step after the loop ran (sent {sent})");
    assert_eq!(
        received(server, "/after").await,
        0,
        "after reached the wire"
    );
    assert!(sent >= 2, "iterations did not restart (sent {sent})");
    assert_eq!(body, sent + blocked, "window count = sent + not sent");
    // 끝 반복은 deadline에 첫 회차 뒤에서 잘릴 수 있다(보냈으나 막히기 전).
    assert!(
        blocked <= sent && sent - blocked <= 1,
        "sent={sent} blocked={blocked}"
    );
}

#[tokio::test]
async fn self_locking_loop_exits_instead_of_spinning() {
    use handicap_engine::LoopExitOutcome;
    let server = MockServer::start().await;
    Mock::given(path("/jobs/1"))
        .respond_with(json_resp(r#"{"state":"WAIT"}"#))
        .mount(&server)
        .await;
    let out = run_mode(&self_lock_yaml(&server.uri()), 1000, Mode::Closed).await;
    assert_dead_pass_ends_iteration(&out, &server).await;
    let exits: Vec<_> = out
        .flushes
        .iter()
        .flat_map(|f| f.loop_exit_stats.iter())
        .filter(|s| s.step_id == LOOP_ID)
        .collect();
    assert!(
        exits
            .iter()
            .all(|s| s.outcome == LoopExitOutcome::Truncated),
        "only Truncated exits expected: {exits:?}"
    );
    assert!(
        exits.iter().any(|s| s.pass_bucket == 2),
        "dead pass not counted: {exits:?}"
    );
}

/// 바깥 조건 반복의 회차가 안쪽 조건 반복 하나뿐이어도, 안쪽 회차가 막히기만 하면 그 반복(시나리오
/// 회차)이 끝난다 — 바깥 반복도 뒤 스텝으로 가지 않는다.
#[tokio::test]
async fn nested_self_locking_loop_exits() {
    let server = MockServer::start().await;
    Mock::given(path("/jobs/1"))
        .respond_with(json_resp(r#"{"state":"WAIT"}"#))
        .mount(&server)
        .await;
    let inner = self_lock_yaml(&server.uri());
    // self_lock_yaml의 반복 블록만 떼어 바깥 반복 본문으로 감싼다.
    let inner_loop: String = inner
        .lines()
        .skip_while(|l| !l.starts_with("  - id:"))
        .take_while(|l| !l.contains(AFTER_ID))
        .map(|l| l.strip_prefix("  ").unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n");
    let outer = format!(
        "- id: \"{PRE_ID}\"\n  name: outer\n  type: loop\n  while: {{ left: \"{{{{state}}}}\", op: ne, right: \"DONE\" }}\n  do:\n{}",
        indent(&inner_loop, 4)
    );
    let y = scenario_yaml(
        &server.uri(),
        r#"id: "1", etag: "", state: """#,
        &[outer, after_step()],
    );
    let out = run_mode(&y, 1000, Mode::Closed).await;
    assert_dead_pass_ends_iteration(&out, &server).await;
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
