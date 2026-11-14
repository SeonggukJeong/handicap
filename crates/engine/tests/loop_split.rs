//! 조건 반복 응답 시간 분리(loop-while-latency-split).
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{
    LOOP_SPLIT_PASS_SAMPLE_CAP, LoopSplitClass, MetricFlush, PHASE_LOOP_CUT, PHASE_LOOP_CUT_ERR,
    PHASE_LOOP_FINAL, PHASE_LOOP_FINAL_ERR, PHASE_LOOP_RETRY, PHASE_LOOP_RETRY_ERR, RampDown,
    RunPlan, Scenario, run_scenario, run_scenario_open_loop, run_scenario_vu_curve,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, ResponseTemplate};

const ORDER_ID: &str = "01HX0000000000000000000002";
const EXTRA_ID: &str = "01HX0000000000000000000004";
const DETAIL_ID: &str = "01HX0000000000000000000005";

#[test]
fn loop_split_wire_names_are_fixed() {
    assert_eq!(LOOP_SPLIT_PASS_SAMPLE_CAP, 1024);
    assert_eq!(
        [PHASE_LOOP_FINAL, PHASE_LOOP_RETRY, PHASE_LOOP_CUT],
        ["loop_final", "loop_retry", "loop_cut"]
    );
    assert_eq!(
        [
            PHASE_LOOP_FINAL_ERR,
            PHASE_LOOP_RETRY_ERR,
            PHASE_LOOP_CUT_ERR
        ],
        ["loop_final_err", "loop_retry_err", "loop_cut_err"]
    );
    assert_eq!(LoopSplitClass::Ended.phase(), PHASE_LOOP_FINAL);
    assert_eq!(LoopSplitClass::Continued.phase(), PHASE_LOOP_RETRY);
    assert_eq!(LoopSplitClass::Cut.phase(), PHASE_LOOP_CUT);
    assert_eq!(LoopSplitClass::Cut.err_phase(), PHASE_LOOP_CUT_ERR);
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

fn wait_resp() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_string(r#"{"code":"WAIT"}"#)
}
fn ok_resp() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_string(r#"{"code":"OK"}"#)
}

const WHILE_WAIT: &str = r#"    while: { left: "{{code}}", op: eq, right: "WAIT" }"#;
const EXTRACT_CODE: &str = r#", extract: [{ var: code, from: body, path: "$.code" }]"#;
const THINK_2S: &str = ", think_time: { min_ms: 2000, max_ms: 2000 }";
const ASSERT_201: &str = "[{ status: 201 }]";

/// http 스텝 한 줄(flow 매핑). `suffix`는 `, extract: …`·`, think_time: …` 따위.
fn http(id: &str, url_path: &str, assert: &str, suffix: &str) -> String {
    format!(
        r#"- {{ id: "{id}", name: s{tail}, type: http, request: {{ method: GET, url: "BASE{url_path}" }}, assert: {assert}{suffix} }}"#,
        tail = &id[id.len() - 2..]
    )
}

/// `body`의 각 줄 앞에 공백 `n`칸을 붙인다.
fn indent(body: &str, n: usize) -> String {
    let pad = " ".repeat(n);
    body.lines()
        .map(|l| format!("{pad}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 조건 반복 하나짜리 시나리오. `body`는 본문 스텝 목록(들여쓰기 없는 `- …` 줄들).
fn yaml(base: &str, loop_head: &str, body: &str) -> String {
    format!(
        r#"version: 1
name: split-test
variables:
  code: ""
steps:
  - id: "01HX0000000000000000000001"
    name: poll
    type: loop
{loop_head}
    do:
{body}
"#,
        body = indent(body, 6)
    )
    .replace("BASE", base)
}

fn order_step(assert: &str, suffix_extra: &str) -> String {
    http(
        ORDER_ID,
        "/order",
        assert,
        &format!("{EXTRACT_CODE}{suffix_extra}"),
    )
}

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
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

fn phase_count(out: &Out, step_id: &str, phase: &str) -> u64 {
    out.flushes
        .iter()
        .flat_map(|f| f.phase_stats.iter())
        .filter(|p| p.step_id == step_id && p.phase == phase)
        .map(|p| p.count)
        .sum()
}

/// 전 flush 합산: (final, retry, cut, final_err, retry_err, cut_err).
fn split(out: &Out, step_id: &str) -> [u64; 6] {
    [
        PHASE_LOOP_FINAL,
        PHASE_LOOP_RETRY,
        PHASE_LOOP_CUT,
        PHASE_LOOP_FINAL_ERR,
        PHASE_LOOP_RETRY_ERR,
        PHASE_LOOP_CUT_ERR,
    ]
    .map(|ph| phase_count(out, step_id, ph))
}

/// 전 flush 합산: 그 스텝 창의 (count, error_count).
fn window(out: &Out, step_id: &str) -> (u64, u64) {
    out.flushes
        .iter()
        .flat_map(|f| f.windows.iter())
        .filter(|w| w.step_id == step_id)
        .fold((0, 0), |a, w| (a.0 + w.count, a.1 + w.error_count))
}

/// 합 등식: 갈래 합 = 창 건수, 에러 갈래 합 = 창 에러 수.
fn assert_sums(out: &Out, step_id: &str) {
    let s = split(out, step_id);
    let (count, errs) = window(out, step_id);
    assert_eq!(s[0] + s[1] + s[2], count, "{step_id}: {s:?} count={count}");
    assert_eq!(s[3] + s[4] + s[5], errs, "{step_id}: {s:?} errors={errs}");
}

/// WAIT 2번 뒤 OK(이후 계속 OK).
async fn mount_wait_twice(server: &MockServer) {
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .up_to_n_times(2)
        .mount(server)
        .await;
    Mock::given(path("/order"))
        .respond_with(ok_resp())
        .mount(server)
        .await;
}

async fn mount_extra(server: &MockServer) {
    for p in ["/extra", "/detail", "/after"] {
        Mock::given(path(p))
            .respond_with(ResponseTemplate::new(200))
            .mount(server)
            .await;
    }
}

#[tokio::test]
async fn wait_twice_then_ok_splits_by_pass() {
    let server = MockServer::start().await;
    mount_wait_twice(&server).await;
    let y = yaml(&server.uri(), WHILE_WAIT, &order_step("[]", ""));
    let out = run_mode(&y, 600, Mode::Closed).await;
    assert!(out.ok);
    assert_sums(&out, ORDER_ID);
    let s = split(&out, ORDER_ID);
    assert_eq!(s[1], 2, "{s:?}");
    assert!(s[0] >= 1, "{s:?}");
    assert_eq!(s[3] + s[4] + s[5], 0, "{s:?}");
}

#[tokio::test]
async fn exhausted_last_pass_is_cut() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    let head = format!("{WHILE_WAIT}\n    repeat: 3");
    let y = yaml(&server.uri(), &head, &order_step("[]", ""));
    let out = run_mode(&y, 600, Mode::Closed).await;
    assert!(out.ok);
    assert_sums(&out, ORDER_ID);
    let s = split(&out, ORDER_ID);
    assert_eq!(s[0], 0, "{s:?}");
    assert!(s[1] >= 2, "{s:?}");
    assert!(s[2] >= 1, "{s:?}");
    assert!(s[1] <= 2 * s[2] + 2, "{s:?}");
}

#[tokio::test]
async fn two_body_steps_split_together() {
    let server = MockServer::start().await;
    mount_wait_twice(&server).await;
    mount_extra(&server).await;
    let body = format!(
        "{}\n{}",
        order_step("[]", ""),
        http(EXTRA_ID, "/extra", "[]", "")
    );
    let y = yaml(&server.uri(), WHILE_WAIT, &body);
    let out = run_mode(&y, 600, Mode::Closed).await;
    assert!(out.ok);
    for id in [ORDER_ID, EXTRA_ID] {
        assert_sums(&out, id);
        let s = split(&out, id);
        assert_eq!(s[1], 2, "{id}: {s:?}");
    }
}

#[tokio::test]
async fn errors_land_in_err_phases() {
    let server = MockServer::start().await;
    mount_wait_twice(&server).await;
    let y = yaml(&server.uri(), WHILE_WAIT, &order_step(ASSERT_201, ""));
    let out = run_mode(&y, 600, Mode::Closed).await;
    assert!(out.ok);
    assert_sums(&out, ORDER_ID);
    let s = split(&out, ORDER_ID);
    let (count, errs) = window(&out, ORDER_ID);
    assert!(errs > 0, "{s:?}");
    assert_eq!(s[3] + s[4] + s[5], count, "전부 에러: {s:?} count={count}");
}

#[tokio::test]
async fn unbounded_never_resolving_has_no_final() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    let y = yaml(&server.uri(), WHILE_WAIT, &order_step("[]", ""));
    let out = run_mode(&y, 300, Mode::Closed).await;
    assert!(out.ok);
    assert_sums(&out, ORDER_ID);
    let s = split(&out, ORDER_ID);
    assert_eq!(s[0], 0, "{s:?}");
    assert!(s[1] >= 1, "{s:?}");
}

#[tokio::test]
async fn no_retry_run_records_no_loop_retry() {
    // (a) 1번째 회차에서 풀리지만 본문 think time 도중 run이 끝난다.
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(ok_resp())
        .mount(&server)
        .await;
    let y = yaml(&server.uri(), WHILE_WAIT, &order_step("[]", THINK_2S));
    let out = run_mode(&y, 300, Mode::Closed).await;
    assert!(out.ok);
    assert_sums(&out, ORDER_ID);
    let s = split(&out, ORDER_ID);
    assert_eq!((s[0], s[1], s[2]), (0, 0, 1), "{s:?}");

    // (b) 끝내 안 풀림 + 최대 1회 → 전부 끊김.
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    let head = format!("{WHILE_WAIT}\n    repeat: 1");
    let y = yaml(&server.uri(), &head, &order_step("[]", ""));
    let out = run_mode(&y, 400, Mode::Closed).await;
    assert!(out.ok);
    let s = split(&out, ORDER_ID);
    let (count, _) = window(&out, ORDER_ID);
    assert!(count >= 1);
    assert_eq!((s[0], s[1]), (0, 0), "{s:?}");
    assert_eq!(s[2], count, "{s:?}");
}

#[tokio::test]
async fn scenarios_without_cond_loop_record_no_phase_stats() {
    let server = MockServer::start().await;
    mount_extra(&server).await;
    Mock::given(path("/order"))
        .respond_with(ok_resp())
        .mount(&server)
        .await;
    let step = http(ORDER_ID, "/order", "[]", EXTRACT_CODE);
    let head = |name: &str, rest: &str| {
        format!("version: 1\nname: {name}\nvariables:\n  code: \"\"\nsteps:\n{rest}\n")
            .replace("BASE", &server.uri())
    };
    let flat = head("flat", &indent(&step, 2));
    let plain_loop = head(
        "plain",
        &indent(
            &format!(
                "- id: \"01HX0000000000000000000001\"\n  name: l\n  type: loop\n  repeat: 2\n  do:\n{}",
                indent(&step, 4)
            ),
            2,
        ),
    );
    let if_node = head(
        "if",
        &indent(
            &format!(
                "- id: \"01HX0000000000000000000006\"\n  name: g\n  type: if\n  cond: {{ left: \"1\", op: eq, right: \"1\" }}\n  then:\n{}",
                indent(&step, 4)
            ),
            2,
        ),
    );
    let par = head(
        "par",
        &indent(
            &format!(
                "- id: \"01HX0000000000000000000007\"\n  name: p\n  type: parallel\n  branches:\n    - name: b1\n      steps:\n{}",
                indent(&step, 8)
            ),
            2,
        ),
    );
    for y in [flat, plain_loop, if_node, par] {
        let out = run_mode(&y, 300, Mode::Closed).await;
        assert!(out.ok);
        assert!(window(&out, ORDER_ID).0 >= 1, "요청이 있었어야 한다");
        assert!(
            out.flushes.iter().all(|f| f.phase_stats.is_empty()),
            "R0: {y}"
        );
    }
}

#[tokio::test]
async fn pass_sample_cap_limits_one_pass() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(ok_resp())
        .mount(&server)
        .await;
    let inner = format!(
        "- id: \"01HX0000000000000000000008\"\n  name: inner\n  type: loop\n  repeat: 1100\n  do:\n{}",
        indent(&order_step("[]", ""), 4)
    );
    let y = yaml(&server.uri(), WHILE_WAIT, &inner);
    let out = run_mode(&y, 6000, Mode::Closed).await;
    assert!(out.ok);
    let completed: u64 = out
        .flushes
        .iter()
        .flat_map(|f| f.loop_exit_stats.iter())
        .filter(|s| s.outcome.as_wire() == 0)
        .map(|s| s.count)
        .sum();
    assert!(completed >= 1, "완료된 진입이 있어야 한다");
    let s = split(&out, ORDER_ID);
    let (count, _) = window(&out, ORDER_ID);
    assert!(count >= 1100, "count={count}");
    assert_eq!(s[0], 1024 * completed, "{s:?} completed={completed}");
    assert!(s[0] + s[2] < count, "{s:?} count={count}");
}

#[tokio::test]
async fn http_inside_if_in_cond_loop_is_split() {
    let server = MockServer::start().await;
    mount_wait_twice(&server).await;
    mount_extra(&server).await;
    let body = format!(
        "{}\n- id: \"01HX0000000000000000000006\"\n  name: gate\n  type: if\n  cond: {{ left: \"{{{{code}}}}\", op: eq, right: \"OK\" }}\n  then:\n{}",
        order_step("[]", ""),
        indent(&http(DETAIL_ID, "/detail", "[]", ""), 4)
    );
    let y = yaml(&server.uri(), WHILE_WAIT, &body);
    let out = run_mode(&y, 600, Mode::Closed).await;
    assert!(out.ok);
    assert_sums(&out, DETAIL_ID);
    let d = split(&out, DETAIL_ID);
    assert!(d[0] >= 1, "{d:?}");
    assert_eq!(d[1], 0, "{d:?}");
    assert_sums(&out, ORDER_ID);
    assert_eq!(split(&out, ORDER_ID)[1], 2);
}

#[tokio::test]
async fn http_inside_parallel_in_cond_loop_is_split() {
    let server = MockServer::start().await;
    mount_extra(&server).await;
    let body = format!(
        "- id: \"01HX0000000000000000000007\"\n  name: par\n  type: parallel\n  branches:\n    - name: b1\n      steps:\n{}",
        indent(&http(EXTRA_ID, "/extra", "[]", ""), 8)
    );
    let y = yaml(&server.uri(), WHILE_WAIT, &body);
    let out = run_mode(&y, 400, Mode::Closed).await;
    assert!(out.ok);
    assert_sums(&out, EXTRA_ID);
    let s = split(&out, EXTRA_ID);
    assert!(s[0] + s[1] + s[2] >= 1, "{s:?}");
}

#[tokio::test]
async fn http_inside_plain_loop_in_cond_loop_is_split() {
    let server = MockServer::start().await;
    mount_extra(&server).await;
    let body = format!(
        "- id: \"01HX0000000000000000000008\"\n  name: inner\n  type: loop\n  repeat: 2\n  do:\n{}",
        indent(&http(EXTRA_ID, "/extra", "[]", ""), 4)
    );
    let y = yaml(&server.uri(), WHILE_WAIT, &body);
    let out = run_mode(&y, 400, Mode::Closed).await;
    assert!(out.ok);
    assert_sums(&out, EXTRA_ID);
    let s = split(&out, EXTRA_ID);
    assert!(s[0] + s[1] + s[2] >= 1, "{s:?}");
}

#[tokio::test]
async fn curve_and_open_modes_keep_sum_equality() {
    for mode in [Mode::Curve, Mode::Open] {
        let server = MockServer::start().await;
        mount_wait_twice(&server).await;
        let y = yaml(&server.uri(), WHILE_WAIT, &order_step("[]", ""));
        let out = run_mode(&y, 1500, mode).await;
        assert!(out.ok);
        assert_sums(&out, ORDER_ID);
        let s = split(&out, ORDER_ID);
        assert!(s[0] + s[1] + s[2] >= 1, "{s:?}");
    }
}
