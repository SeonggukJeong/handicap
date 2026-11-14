//! 조건 반복 리포트 집계(loop-while-report) — 진입이 끝난 회차·방식 건수가 flush에 실린다.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{
    LOOP_EXIT_PASS_CAP, LoopExitOutcome, LoopExitStat, MetricFlush, RampDown, RunPlan, Scenario,
    run_scenario, run_scenario_open_loop, run_scenario_vu_curve,
};
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

/// [first] -> loop(order) -> after
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

/// `cancel_after`가 Some이면 그 시간 뒤 취소 토큰을 취소한다.
async fn run_mode(yaml: &str, ms: u64, mode: Mode, cancel_after: Option<Duration>) -> Out {
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
    if let Some(d) = cancel_after {
        let c = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(d).await;
            c.cancel();
        });
    }
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

/// (pass_bucket, outcome 와이어 값) -> (건수, 회차 합), 전 flush 합산.
fn exits(out: &Out) -> BTreeMap<(u32, u32), (u64, u64)> {
    let mut m: BTreeMap<(u32, u32), (u64, u64)> = BTreeMap::new();
    for s in out.flushes.iter().flat_map(|f| f.loop_exit_stats.iter()) {
        let e = m.entry((s.pass_bucket, s.outcome.as_wire())).or_default();
        e.0 += s.count;
        e.1 += s.pass_sum;
    }
    m
}

fn total_pass_sum(out: &Out) -> u64 {
    exits(out).values().map(|v| v.1).sum()
}

fn outcome_count(out: &Out, wire: u32) -> u64 {
    exits(out)
        .iter()
        .filter(|((_, o), _)| *o == wire)
        .map(|(_, v)| v.0)
        .sum()
}

#[test]
fn loop_exit_wire_values_are_fixed() {
    assert_eq!(LOOP_EXIT_PASS_CAP, 20);
    assert_eq!(LoopExitOutcome::Completed.as_wire(), 0);
    assert_eq!(LoopExitOutcome::Exhausted.as_wire(), 1);
    assert_eq!(LoopExitOutcome::Truncated.as_wire(), 2);
    let s = LoopExitStat {
        step_id: "l".into(),
        pass_bucket: 21,
        outcome: LoopExitOutcome::Truncated,
        count: 1,
        pass_sum: 500,
    };
    assert_eq!(s.pass_bucket, LOOP_EXIT_PASS_CAP + 1);
}

/// 지점 1: 2번 WAIT 뒤 OK → 첫 진입은 3번째에 완료, 이후 진입은 1번째에 완료.
#[tokio::test]
async fn site1_completed_records_pass_count() {
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
    let out = run_mode(&y, 600, Mode::Closed, None).await;
    assert!(out.ok);
    let e = exits(&out);
    assert_eq!(e.get(&(3, 0)), Some(&(1, 3)), "{e:?}");
    assert!(
        e.get(&(1, 0)).is_some_and(|v| v.0 >= 1 && v.1 == v.0),
        "{e:?}"
    );
    assert_eq!(outcome_count(&out, 1), 0);
}

/// 지점 2: 끝내 WAIT + 최대 3 → 중단은 전부 3번째 칸, 회차 합 = 3 × 건수.
#[tokio::test]
async fn site2_exhausted_records_max_passes() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    mount_after(&server).await;
    let head = format!("{WHILE_WAIT}\n    repeat: 3");
    let y = scenario_yaml(&server.uri(), &head, "", false);
    let out = run_mode(&y, 600, Mode::Closed, None).await;
    assert!(out.ok);
    let e = exits(&out);
    let ex = e.get(&(3, 1)).copied().unwrap_or_default();
    assert!(ex.0 >= 1, "{e:?}");
    assert_eq!(ex.1, ex.0 * 3);
    assert_eq!(outcome_count(&out, 1), ex.0, "중단은 3번째 칸에만: {e:?}");
    assert_eq!(outcome_count(&out, 0), 0);
}

/// 지점 3: think time 없는 무제한 조건 반복이 deadline에 끊긴다 → 진입 1건이 "마치지 못함",
/// 회차 합 = 보낸 요청 수(끊긴 곳이 회차 머리이므로 시작한 회차는 전부 요청을 보냈다).
#[tokio::test]
async fn site3_deadline_at_pass_head_records_truncated() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp().set_delay(Duration::from_millis(20)))
        .mount(&server)
        .await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run_mode(&y, 400, Mode::Closed, None).await;
    assert!(out.ok);
    let reqs = count(&paths(&server).await, "/order") as u64;
    assert!(reqs >= 2, "reqs={reqs}");
    assert_eq!(outcome_count(&out, 2), 1, "{:?}", exits(&out));
    assert_eq!(outcome_count(&out, 0) + outcome_count(&out, 1), 0);
    // spec §2: 끊긴 회차는 요청을 보내기 전에 끊겼을 수 있다 → 회차 합이 요청 수보다 최대 1 크다.
    let sum = total_pass_sum(&out);
    assert!(sum >= reqs && sum - reqs <= 1, "pass_sum={sum} reqs={reqs}");
}

/// 지점 4: 요청이 진행 중일 때 취소 → 그 요청이 끝난 뒤 회차 머리의 취소 검사에서 끊긴다.
#[tokio::test]
async fn site4_cancel_at_pass_head_records_truncated() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp().set_delay(Duration::from_millis(30)))
        .mount(&server)
        .await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run_mode(&y, 5000, Mode::Closed, Some(Duration::from_millis(200))).await;
    assert!(!out.ok, "취소된 run은 Err(Aborted)");
    let reqs = count(&paths(&server).await, "/order") as u64;
    assert_eq!(outcome_count(&out, 2), 1, "{:?}", exits(&out));
    // spec §2: 끊긴 회차는 요청을 보내기 전에 끊겼을 수 있다 → 회차 합이 요청 수보다 최대 1 크다.
    let sum = total_pass_sum(&out);
    assert!(sum >= reqs && sum - reqs <= 1, "pass_sum={sum} reqs={reqs}");
}

/// 지점 5(비-Continue): 본문 think time 도중 deadline → 끊긴 회차 포함 1회, 요청 1건.
#[tokio::test]
async fn site5_deadline_during_think_records_started_pass() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(wait_resp())
        .mount(&server)
        .await;
    let think = "        think_time: { min_ms: 2000, max_ms: 2000 }\n";
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, think, false);
    let out = run_mode(&y, 300, Mode::Closed, None).await;
    assert!(out.ok);
    assert_eq!(count(&paths(&server).await, "/order"), 1);
    assert_eq!(exits(&out).get(&(1, 2)), Some(&(1, 1)), "{:?}", exits(&out));
}

/// 지점 5(Err): 2번째 회차 렌더에서 캐스트 실패 → 에러는 전과 같이 전파(전 VU 실패 → run Err),
/// 그 진입은 (2번째 칸, 마치지 못함) 1건·회차 합 2·요청 1건.
#[tokio::test]
async fn site5_body_error_records_and_still_propagates() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"code":"WAIT","n":"abc"}"#))
        .mount(&server)
        .await;
    let y = format!(
        r#"version: 1
name: while-cast
variables:
  base: "{base}"
  code: ""
  n: "1"
steps:
  - id: "01HX0000000000000000000001"
    name: poll
    type: loop
{WHILE_WAIT}
    do:
      - id: "{ORDER_ID}"
        name: order
        type: http
        request:
          method: POST
          url: "{{{{base}}}}/order"
          body: {{ json: {{ n: "{{{{n:num}}}}" }} }}
        assert: []
        extract:
          - {{ var: code, from: body, path: "$.code" }}
          - {{ var: n, from: body, path: "$.n" }}
"#,
        base = server.uri()
    );
    let out = run_mode(&y, 2000, Mode::Closed, None).await;
    assert!(!out.ok, "캐스트 실패는 VU를 죽이고 run은 AllVusFailed");
    assert_eq!(count(&paths(&server).await, "/order"), 1);
    assert_eq!(exits(&out), BTreeMap::from([((2, 2), (1, 2))]));
}

/// R0: while 없는 loop은 집계가 비어 있다.
#[tokio::test]
async fn plain_loop_and_flat_scenarios_record_nothing() {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(ok_resp())
        .mount(&server)
        .await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), "    repeat: 2", "", false);
    let out = run_mode(&y, 300, Mode::Closed, None).await;
    assert!(out.ok);
    assert!(out.flushes.iter().all(|f| f.loop_exit_stats.is_empty()));

    // loop이 전혀 없는 평평한 시나리오도 배치 층에서 비어 있다(R0, spec §5).
    let flat = format!(
        r#"version: 1
name: flat
variables:
  base: "{base}"
steps:
  - id: "01HX0000000000000000000003"
    name: after
    type: http
    request: {{ method: GET, url: "{{{{base}}}}/after" }}
    assert: []
"#,
        base = server.uri()
    );
    let out = run_mode(&flat, 300, Mode::Closed, None).await;
    assert!(out.ok);
    assert!(count(&paths(&server).await, "/after") >= 1);
    assert!(out.flushes.iter().all(|f| f.loop_exit_stats.is_empty()));
}

/// 세 실행 방식: 주기 flush와 마지막 flush 양쪽에 실리고, 어떤 델타도 버려지지 않는다.
/// 본문이 스텝 하나라 `0 <= 회차 합 - 요청 수 <= 마치지 못함 건수`.
async fn assert_flushes_loop_exits(mode: Mode) {
    let server = MockServer::start().await;
    Mock::given(path("/order"))
        .respond_with(ok_resp())
        .mount(&server)
        .await;
    mount_after(&server).await;
    let y = scenario_yaml(&server.uri(), WHILE_WAIT, "", false);
    let out = run_mode(&y, 3000, mode, None).await;
    assert!(out.ok);
    let loaded = out
        .flushes
        .iter()
        .filter(|f| !f.loop_exit_stats.is_empty())
        .count();
    assert!(loaded >= 2, "주기+마지막 flush에 실려야 한다: {loaded}");
    let reqs = count(&paths(&server).await, "/order") as u64;
    let sum = total_pass_sum(&out);
    let trunc = outcome_count(&out, 2);
    assert!(
        sum >= reqs && sum - reqs <= trunc,
        "sum={sum} reqs={reqs} trunc={trunc}"
    );
}

#[tokio::test]
async fn closed_flushes_loop_exits() {
    assert_flushes_loop_exits(Mode::Closed).await;
}
#[tokio::test]
async fn curve_flushes_loop_exits() {
    assert_flushes_loop_exits(Mode::Curve).await;
}
#[tokio::test]
async fn open_flushes_loop_exits() {
    assert_flushes_loop_exits(Mode::Open).await;
}
