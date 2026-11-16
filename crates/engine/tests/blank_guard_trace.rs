//! 시험 실행 trace도 비워진 값이 든 주소는 보내지 않는다 — runner와 같은 규칙(blank-var-url-guard R1–R3).
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{
    BLOCKED_ERROR, BlockedInfo, ErrorKind, MetricFlush, RampDown, RunPlan, Scenario, StepKind,
    StepTrace, TraceOptions, TracedRequest, run_scenario, trace_scenario, trace_scenario_rows,
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
const USE_ID: &str = "01HX0000000000000000000008";
const X_ID: &str = "01HX0000000000000000000009";
const LOOP2_ID: &str = "01HX000000000000000000000A";

fn opts(max_requests: u32, max_wall: Duration) -> TraceOptions {
    TraceOptions {
        env: BTreeMap::new(),
        max_requests,
        max_wall,
        apply_think_time: false,
    }
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

fn indent(body: &str, n: usize) -> String {
    let pad = " ".repeat(n);
    body.lines()
        .map(|l| format!("{pad}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
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

fn scenario_yaml(base: &str, vars: &str, steps: &[String]) -> String {
    let body = steps.join("\n");
    format!(
        "version: 1\nname: blank-guard-trace\nvariables: {{ {vars} }}\nsteps:\n{}\n",
        indent(&body, 2)
    )
    .replace("BASE", base)
}

fn delete_step() -> String {
    http(DEL_ID, "del", "DELETE", r#"/orders/{{orderId}}""#, "")
}

fn after_step() -> String {
    http(AFTER_ID, "after", "GET", r#"/after""#, "")
}

fn y1(base: &str) -> String {
    scenario_yaml(
        base,
        r#"code: """#,
        &[loop_block(&poll_step()), delete_step(), after_step()],
    )
}

fn parallel_yaml(base: &str) -> String {
    let branch_loop = loop_block(&poll_step());
    let par = format!(
        "- id: \"{PAR_ID}\"\n  name: fan\n  type: parallel\n  branches:\n    - name: b\n      steps:\n{}",
        indent(&branch_loop, 8)
    );
    let del = http(DEL_ID, "del", "DELETE", r#"/orders/{{b.orderId}}""#, "");
    scenario_yaml(base, r#"code: """#, &[par, del, after_step()])
}

async fn mount_empty_poll(server: &MockServer) {
    Mock::given(path("/poll"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .mount(server)
        .await;
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

fn row<'a>(steps: &'a [StepTrace], id: &str) -> &'a StepTrace {
    steps
        .iter()
        .find(|s| s.step_id == id)
        .unwrap_or_else(|| panic!("no row for {id}"))
}

#[tokio::test]
async fn trace_blocks_and_marks_row() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let sc = Scenario::from_yaml(&y1(&server.uri())).unwrap();
    let t = trace_scenario(&sc, &opts(50, Duration::from_secs(20))).await;

    assert!(!t.ok);
    let del = row(&t.steps, DEL_ID);
    assert_eq!(del.kind, StepKind::Http);
    assert_eq!(del.loop_index, None);
    assert_eq!(del.branch, None);
    let req = del.request.as_ref().expect("request");
    assert_eq!(req.method, "DELETE");
    assert!(req.url.ends_with("/orders/"), "{}", req.url);
    assert!(req.headers.is_empty());
    assert_eq!(req.body, None);
    assert!(del.response.is_none());
    assert!(del.extracted.is_empty());
    assert!(del.unbound_vars.is_empty());
    assert_eq!(del.error.as_deref(), Some(BLOCKED_ERROR));
    assert!(del.branch_eval.is_empty());
    assert!(!del.timed_out);
    assert_eq!(
        del.blocked,
        Some(BlockedInfo {
            vars: vec!["orderId".into()],
            by_step: POLL_ID.into()
        })
    );
    assert_eq!(received(&server, "/orders/").await, 0, "blank url was sent");
    let after = row(&t.steps, AFTER_ID);
    assert_eq!(after.error, None);
    assert!(after.blocked.is_none());
}

#[tokio::test]
async fn null_extract_in_loop_blocks_url_trace() {
    let server = MockServer::start().await;
    Mock::given(path("/poll"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"orderId":null,"code":null}"#))
        .mount(&server)
        .await;
    let sc = Scenario::from_yaml(&y1(&server.uri())).unwrap();
    let t = trace_scenario(&sc, &opts(50, Duration::from_secs(20))).await;
    let del = row(&t.steps, DEL_ID);
    assert_eq!(
        del.blocked,
        Some(BlockedInfo {
            vars: vec!["orderId".into()],
            by_step: POLL_ID.into()
        })
    );
    assert_eq!(received(&server, "/orders/").await, 0, "null url was sent");
}

async fn blocked_trace_ids(yaml: &str) -> BTreeSet<String> {
    let sc = Scenario::from_yaml(yaml).unwrap();
    let t = trace_scenario(&sc, &opts(50, Duration::from_secs(20))).await;
    t.steps
        .iter()
        .filter(|s| s.blocked.is_some())
        .map(|s| s.step_id.clone())
        .collect()
}

async fn blocked_runner_ids(yaml: &str) -> BTreeSet<String> {
    runner_flushes(yaml)
        .await
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .filter(|s| s.kind == ErrorKind::BlankVar && s.count > 0)
        .map(|s| s.step_id.clone())
        .collect()
}

async fn runner_flushes(yaml: &str) -> Vec<MetricFlush> {
    let scenario = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(1000),
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
    };
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(1024);
    let h = tokio::spawn(run_scenario(scenario, plan, tx, CancellationToken::new()));
    let mut flushes = Vec::new();
    while let Some(f) = rx.recv().await {
        flushes.push(f);
    }
    h.await.unwrap().unwrap();
    flushes
}

/// 자기 잠금 반복(runner 쪽 `tests/blank_guard.rs::self_lock_yaml`과 같은 모양).
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

async fn mount_wait_jobs(server: &MockServer) {
    Mock::given(path("/jobs/1"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"state":"WAIT"}"#))
        .mount(server)
        .await;
}

#[tokio::test]
async fn self_locking_loop_trace_stops_without_truncation() {
    let server = MockServer::start().await;
    mount_wait_jobs(&server).await;
    let sc = Scenario::from_yaml(&self_lock_yaml(&server.uri())).unwrap();
    let t = trace_scenario(&sc, &opts(500, Duration::from_secs(20))).await;
    assert!(!t.truncated, "trace spun into a cap");
    // 막힌 회차는 최대 횟수에 닿은 것처럼 그 회차를 끝낸다 — 반복 뒤 스텝은 안 돈다.
    assert_eq!(t.ended_by_loop.as_deref(), Some(LOOP_ID));
    let blocked: Vec<_> = t
        .steps
        .iter()
        .filter(|s| s.step_id == DETAIL_ID && s.blocked.is_some())
        .collect();
    assert_eq!(blocked.len(), 1, "blocked rows");
    assert_eq!(blocked[0].loop_index, Some(1));
    assert!(
        t.steps.iter().all(|s| s.step_id != AFTER_ID),
        "after step ran"
    );
    assert_eq!(received(&server, "/jobs/").await, 1);
    assert_eq!(received(&server, "/after").await, 0);
}

/// 두 엔진 모두 막힌 회차에서 그 회차를 끝내고 뒤 스텝에 가지 않는다(lockstep).
#[tokio::test]
async fn trace_and_runner_both_leave_self_locking_loop() {
    let server = MockServer::start().await;
    mount_wait_jobs(&server).await;
    let yaml = self_lock_yaml(&server.uri());
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let t = trace_scenario(&sc, &opts(500, Duration::from_secs(20))).await;
    assert!(!t.truncated);
    assert_eq!(t.ended_by_loop.as_deref(), Some(LOOP_ID), "trace");
    assert!(t.steps.iter().all(|s| s.step_id != AFTER_ID), "trace");
    let flushes = runner_flushes(&yaml).await;
    let count = |id: &str| -> u64 {
        flushes
            .iter()
            .flat_map(|f| f.windows.iter())
            .filter(|w| w.step_id == id)
            .map(|w| w.count)
            .sum()
    };
    assert_eq!(count(AFTER_ID), 0, "runner reached the step after the loop");
    // 창 count = 보낸 + 막힌. 반복마다 한 번 보내고 한 번 막힌다(빈 회전이면 막힌 쪽이 훨씬 많다).
    let blocked: u64 = flushes
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .filter(|s| s.step_id == DETAIL_ID && s.kind == ErrorKind::BlankVar)
        .map(|s| s.count)
        .sum();
    let sent = count(DETAIL_ID) - blocked;
    assert!(sent >= 2, "runner iterations did not restart (sent {sent})");
    assert!(
        blocked <= sent && sent - blocked <= 1,
        "sent={sent} blocked={blocked}"
    );
}

#[tokio::test]
async fn trace_and_runner_block_same_steps() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    mount_wait_jobs(&server).await;
    for yaml in [
        y1(&server.uri()),
        parallel_yaml(&server.uri()),
        self_lock_yaml(&server.uri()),
    ] {
        let t = blocked_trace_ids(&yaml).await;
        let r = blocked_runner_ids(&yaml).await;
        assert!(!t.is_empty(), "trace blocked nothing");
        assert_eq!(t, r, "trace/runner diverge");
    }
}

#[tokio::test]
async fn blocked_step_blanks_own_extracts_in_loop() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let detail = http(
        DETAIL_ID,
        "detail",
        "GET",
        r#"/detail/{{orderId}}""#,
        r#", extract: [{ var: token, from: body, path: "$.token" }]"#,
    );
    let use_ = http(USE_ID, "use", "GET", r#"/use/{{token}}""#, "");
    let body = format!("{}\n{}\n{}", poll_step(), detail, use_);
    let y = scenario_yaml(&server.uri(), r#"code: """#, &[loop_block(&body)]);
    let sc = Scenario::from_yaml(&y).unwrap();
    let t = trace_scenario(&sc, &opts(50, Duration::from_secs(20))).await;

    let d = row(&t.steps, DETAIL_ID);
    assert_eq!(d.blocked.as_ref().unwrap().by_step, POLL_ID);
    assert_eq!(
        d.extracted,
        BTreeMap::from([("token".to_string(), String::new())])
    );
    let u = row(&t.steps, USE_ID);
    let b = u.blocked.as_ref().unwrap();
    assert_eq!(b.by_step, DETAIL_ID);
    assert_eq!(b.vars, vec!["token".to_string()]);
    assert_eq!(received(&server, "/detail/").await, 0);
    assert_eq!(received(&server, "/use/").await, 0);
}

#[tokio::test]
async fn trace_json_unchanged_without_block() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let poll = http(POLL_ID, "poll", "GET", r#"/poll""#, "");
    let y = scenario_yaml(&server.uri(), r#"code: """#, &[poll, after_step()]);
    let sc = Scenario::from_yaml(&y).unwrap();
    let t = trace_scenario(&sc, &opts(50, Duration::from_secs(20))).await;
    let v = serde_json::to_value(&t).unwrap();
    let steps = v["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 2);
    for s in steps {
        assert!(!s.as_object().unwrap().contains_key("blocked"), "{s}");
    }
}

#[tokio::test]
async fn blocked_rows_hit_request_cap() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let x = http(X_ID, "x", "GET", r#"/x/{{orderId}}""#, "");
    let rep = format!(
        "- id: \"{LOOP2_ID}\"\n  name: rep\n  type: loop\n  repeat: 10000\n  do:\n{}",
        indent(&x, 4)
    );
    let y = scenario_yaml(
        &server.uri(),
        r#"code: """#,
        &[loop_block(&poll_step()), rep],
    );
    let sc = Scenario::from_yaml(&y).unwrap();
    let t = trace_scenario(&sc, &opts(50, Duration::from_secs(2))).await;
    assert!(t.truncated);
    let http_rows = t.steps.iter().filter(|s| s.kind == StepKind::Http).count();
    assert!(http_rows <= 50, "http rows = {http_rows}");
    assert_eq!(received(&server, "/x/").await, 0);
}

#[tokio::test]
async fn table_resets_each_dataset_row() {
    let server = MockServer::start().await;
    mount_empty_poll(&server).await;
    let pre = http(PRE_ID, "pre", "GET", r#"/pre/{{orderId}}""#, "");
    let y = scenario_yaml(
        &server.uri(),
        r#"code: "", orderId: """#,
        &[pre, loop_block(&poll_step()), delete_step(), after_step()],
    );
    let sc = Scenario::from_yaml(&y).unwrap();
    let rows: Vec<(u64, BTreeMap<String, String>)> = (0..3).map(|i| (i, BTreeMap::new())).collect();
    let t = trace_scenario_rows(&sc, &opts(200, Duration::from_secs(20)), &rows).await;
    assert_eq!(t.rows.len(), 3);
    for r in &t.rows {
        assert!(row(&r.trace.steps, PRE_ID).blocked.is_none());
        assert!(row(&r.trace.steps, DEL_ID).blocked.is_some());
    }
    assert_eq!(received(&server, "/pre/").await, 3);
}

#[test]
fn blocked_field_roundtrip() {
    let s = StepTrace {
        step_id: DEL_ID.into(),
        kind: StepKind::Http,
        loop_index: None,
        branch: None,
        request: Some(TracedRequest {
            method: "DELETE".into(),
            url: "http://x/orders/".into(),
            headers: BTreeMap::new(),
            body: None,
        }),
        response: None,
        extracted: BTreeMap::new(),
        unbound_vars: vec![],
        error: Some(BLOCKED_ERROR.into()),
        branch_eval: vec![],
        timed_out: false,
        blocked: Some(BlockedInfo {
            vars: vec!["orderId".into()],
            by_step: POLL_ID.into(),
        }),
        defaulted: Vec::new(),
    };
    let json = serde_json::to_string(&s).unwrap();
    let back: StepTrace = serde_json::from_str(&json).unwrap();
    assert_eq!(back, s);

    let mut v: serde_json::Value = serde_json::to_value(&s).unwrap();
    v.as_object_mut().unwrap().remove("blocked");
    let old: StepTrace = serde_json::from_value(v).unwrap();
    assert!(old.blocked.is_none());
}
