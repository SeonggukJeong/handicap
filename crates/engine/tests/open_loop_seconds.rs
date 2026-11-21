//! 계단 시험 a — open-loop 초 단위 시작·완료·버림 계수 + 엔진 시작 시각(spec §4.2).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use handicap_engine::{
    MetricFlush, RampDown, RunPlan, Scenario, run_scenario, run_scenario_open_loop,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn plan(target_rps: u32, max_in_flight: u32, secs: u64) -> RunPlan {
    RunPlan {
        vus: 0,
        ramp_up: Duration::ZERO,
        duration: Duration::from_secs(secs),
        env: BTreeMap::new(),
        loop_breakdown_cap: 256,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: Some(target_rps),
        max_in_flight: Some(max_in_flight),
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
        connect_timeout: None,
    }
}

fn scenario(url: &str) -> Arc<Scenario> {
    let yaml = format!(
        "version: 1\nname: ol\nsteps:\n  - id: 01HX0000000000000000000010\n    name: get\n    type: http\n    request:\n      method: GET\n      url: {url}\n    assert:\n      - status: 200\n"
    );
    Arc::new(serde_yaml::from_str(&yaml).unwrap())
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

async fn delayed_server(delay: Duration) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(delay))
        .mount(&server)
        .await;
    server
}

async fn collect_open_loop(scenario: Arc<Scenario>, plan: RunPlan) -> Vec<MetricFlush> {
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(256);
    let h = tokio::spawn(run_scenario_open_loop(
        scenario,
        plan,
        tx,
        CancellationToken::new(),
    ));
    let mut flushes = Vec::new();
    while let Some(f) = rx.recv().await {
        flushes.push(f);
    }
    h.await.unwrap().unwrap();
    flushes
}

#[tokio::test]
async fn per_second_dropped_sums_to_run_total() {
    let server = delayed_server(Duration::from_millis(200)).await;
    let flushes = collect_open_loop(scenario(&format!("{}/", server.uri())), plan(20, 1, 3)).await;
    let per_second: u64 = flushes
        .iter()
        .flat_map(|f| f.open_loop_seconds.iter())
        .map(|r| r.dropped)
        .sum();
    let run_total = flushes.last().expect("final flush").dropped;
    let all_dropped: u64 = flushes.iter().map(|f| f.dropped).sum();
    assert_eq!(
        all_dropped, run_total,
        "run total rides only the final flush"
    );
    assert!(run_total > 0, "1 slot × 200ms at 20 rps must drop");
    assert_eq!(per_second, run_total);
}

#[tokio::test]
async fn launched_plus_dropped_equals_attempts_and_completed_le_launched() {
    let server = delayed_server(Duration::from_millis(200)).await;
    let flushes = collect_open_loop(scenario(&format!("{}/", server.uri())), plan(20, 1, 3)).await;
    let rows: Vec<_> = flushes
        .iter()
        .flat_map(|f| f.open_loop_seconds.iter())
        .collect();
    let launched: u64 = rows.iter().map(|r| r.launched).sum();
    let completed: u64 = rows.iter().map(|r| r.completed).sum();
    let dropped: u64 = rows.iter().map(|r| r.dropped).sum();
    // 고정 간격 시도 k는 t0 + k × 50 ms(1e9 / 20 ns, 정확히 나눠떨어짐)에 예약되고,
    // `next < deadline`인 k = 0..59만 시도된다 → 상한 60. 늦게 깨면 밀린 시도를 곧바로
    // 따라잡으므로(`next += fixed_interval`, 건너뛰기 없음) 잃는 것은 마지막 대기가
    // deadline을 넘겨 깨어난 꼬리뿐이다 — 하한은 느린 CI의 깨어남 지연 250 ms(5회)까지 허용.
    let attempts = launched + dropped;
    assert!(
        (55..=60).contains(&attempts),
        "attempts={attempts} (launched={launched} dropped={dropped}) not near 20 rps × 3 s = 60"
    );
    assert!(
        completed <= launched,
        "completed={completed} launched={launched}"
    );
    // 요청 1개 시나리오: 보낸 요청은 모두 끝난 도착이다(run이 모든 도착을 join한 뒤 최종 drain).
    // 반대로 deadline 직전에 발사된 도착은 `execute_steps` 머리의 deadline 검사로 요청 없이
    // 끝날 수 있다 — 슬롯이 1개라 그런 도착은 동시에 최대 1개(= max_in_flight).
    let received = server.received_requests().await.unwrap().len() as u64;
    assert!(
        received <= completed && completed - received <= 1,
        "completed={completed} received={received}"
    );
}

#[tokio::test]
async fn started_at_on_every_open_loop_flush() {
    let server = delayed_server(Duration::from_millis(10)).await;
    let before = epoch_ms();
    let flushes = collect_open_loop(scenario(&format!("{}/", server.uri())), plan(20, 4, 2)).await;
    let after = epoch_ms();
    assert!(!flushes.is_empty());
    let v = flushes[0]
        .open_loop_started_at_ms
        .expect("open-loop flush carries started_at");
    for f in &flushes {
        assert_eq!(f.open_loop_started_at_ms, Some(v));
    }
    assert!(
        (before..=after).contains(&v),
        "started_at {v} not within [{before}, {after}]"
    );
}

#[tokio::test]
async fn rows_every_second_while_scheduler_runs() {
    // 응답 3 s · 슬롯 1 · 1 rps · 4 s: 앞 몇 초는 끝나는 요청이 없어 1초 창이 비어 있다 —
    // 그 초들의 계수 행만 실린 주기 flush도 버려지면 안 된다.
    let server = delayed_server(Duration::from_secs(3)).await;
    let flushes = collect_open_loop(scenario(&format!("{}/", server.uri())), plan(1, 1, 4)).await;
    let start_s = flushes[0]
        .open_loop_started_at_ms
        .expect("started_at")
        .div_euclid(1000);
    let ts: Vec<i64> = flushes
        .iter()
        .flat_map(|f| f.open_loop_seconds.iter())
        .map(|r| r.ts_second)
        .collect();
    let mut sorted = ts.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ts.len(), "no second emitted twice: {ts:?}");
    assert_eq!(
        sorted.first().copied(),
        Some(start_s),
        "rows start at t0's second: {ts:?}"
    );
    // 스케줄러는 t0 + 4 s까지 살아 있으므로 start_s ..= start_s + 4가 모두 있어야 한다.
    for s in start_s..=start_s + 4 {
        assert!(
            sorted.contains(&s),
            "missing second {s} (start {start_s}): {ts:?}"
        );
    }
}

#[tokio::test]
async fn closed_loop_flush_carries_start_time_but_no_seconds() {
    let server = delayed_server(Duration::from_millis(10)).await;
    let mut p = plan(1, 1, 1);
    p.vus = 2;
    p.target_rps = None;
    p.max_in_flight = None;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(256);
    let before = epoch_ms();
    let h = tokio::spawn(run_scenario(
        scenario(&format!("{}/", server.uri())),
        p,
        tx,
        CancellationToken::new(),
    ));
    let mut n = 0;
    let mut starts = std::collections::BTreeSet::new();
    while let Some(f) = rx.recv().await {
        n += 1;
        assert!(f.open_loop_seconds.is_empty());
        starts.insert(
            f.open_loop_started_at_ms
                .expect("closed-loop 고정도 시작 시각을 싣는다"),
        );
    }
    h.await.unwrap().unwrap();
    assert!(n > 0);
    assert_eq!(starts.len(), 1, "한 run의 시작 시각은 하나");
    let t0 = *starts.iter().next().unwrap();
    assert!(t0 >= before && t0 <= before + 1_000);
}

#[tokio::test]
async fn completed_recorded_on_engine_error() {
    // 미정의 `{{x}}` 주소 → 렌더 단계 엔진 오류(`Err`)로 끝나는 도착도 끝난 반복으로 센다.
    let flushes = collect_open_loop(scenario("http://127.0.0.1:9/{{x}}"), plan(20, 4, 1)).await;
    let rows: Vec<_> = flushes
        .iter()
        .flat_map(|f| f.open_loop_seconds.iter())
        .collect();
    let launched: u64 = rows.iter().map(|r| r.launched).sum();
    let completed: u64 = rows.iter().map(|r| r.completed).sum();
    assert!(launched > 0, "arrivals must launch");
    assert_eq!(
        completed, launched,
        "every launched arrival finished (with an error)"
    );
}
