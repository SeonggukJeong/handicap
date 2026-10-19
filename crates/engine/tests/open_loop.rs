use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, Stage, run_scenario_open_loop};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn plan(target_rps: u32, max_in_flight: u32, secs: u64) -> RunPlan {
    RunPlan {
        vus: 0, // open-loop ignores vus
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

#[tokio::test]
async fn open_loop_fires_near_target_rps_with_ample_pool() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let cancel = CancellationToken::new();
    // 50 rps * 2s = ~100 requests; ample pool so no drops.
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        plan(50, 64, 2),
        tx,
        cancel,
    ));
    let mut count = 0u64;
    let mut dropped = 0u64;
    while let Some(f) = rx.recv().await {
        count += f.windows.iter().map(|w| w.count).sum::<u64>();
        dropped += f.dropped;
    }
    h.await.unwrap().unwrap();
    // ~100 expected; allow timing slack. Key: in the right order of magnitude, not VU-bound.
    assert!((60..=140).contains(&count), "count={count} not near 100");
    assert_eq!(dropped, 0, "ample pool should not drop");
}

#[tokio::test]
async fn open_loop_drops_when_pool_too_small() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    // 100 rps but only 1 slot held 200ms each → most arrivals find no free slot.
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        plan(100, 1, 2),
        tx,
        cancel,
    ));
    let mut count = 0u64;
    let mut dropped = 0u64;
    while let Some(f) = rx.recv().await {
        count += f.windows.iter().map(|w| w.count).sum::<u64>();
        dropped += f.dropped;
    }
    h.await.unwrap().unwrap();
    assert!(dropped > 0, "small pool must drop (dropped={dropped})");
    assert!(count < 100, "achieved must be below target (count={count})");
}

#[tokio::test]
async fn open_loop_cancel_aborts_promptly() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let cancel = CancellationToken::new();
    let s = scenario(&format!("{}/", server.uri()));
    let c2 = cancel.clone();
    let h = tokio::spawn(run_scenario_open_loop(s, plan(50, 8, 30), tx, cancel));
    tokio::time::sleep(Duration::from_millis(300)).await;
    c2.cancel();
    // drain
    while rx.recv().await.is_some() {}
    let res = h.await.unwrap();
    assert!(matches!(res, Err(handicap_engine::EngineError::Aborted)));
}

#[tokio::test]
async fn open_loop_stages_curve_runs_and_drops_nothing_when_capacity_ample() {
    // 0→100 rps over 1s, hold 100 for 1s (total 2s). Ample slots, fast local mock.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 0,
        ramp_up: std::time::Duration::ZERO,
        duration: std::time::Duration::from_secs(2), // == sum(stages) invariant
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: std::time::Duration::from_secs(30),
        think_time: None,
        think_seed: Some(7),
        target_rps: None, // curve mode (not fixed)
        max_in_flight: Some(50),
        stages: Some(vec![
            Stage {
                target: 100,
                duration_seconds: 1,
            },
            Stage {
                target: 100,
                duration_seconds: 1,
            },
        ]),
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
        connect_timeout: None,
    };
    let cancel = CancellationToken::new();
    let mut total: u64 = 0;
    let mut dropped: u64 = 0;
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        plan,
        tx,
        cancel,
    ));
    while let Some(flush) = rx.recv().await {
        for w in &flush.windows {
            total += w.count;
        }
        dropped += flush.dropped;
    }
    h.await.unwrap().unwrap();
    // Λ = 0→100/1s (50) + hold 100/1s (100) = 150 (§B34).
    assert!((147..=151).contains(&total), "Λ=150, got {total}");
    assert_eq!(dropped, 0, "ample slots → no drops");
}

// vu_id (= slot index, 0..max_in_flight) is rendered into the request and observed
// at the target. With max_in_flight=2, only slot ids {0,1} ever appear.
#[tokio::test]
async fn open_loop_vu_id_is_slot_index_bounded_by_pool() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: ol\nsteps:\n  - id: 01HX0000000000000000000011\n    name: get\n    type: http\n    request:\n      method: GET\n      url: {}/u/${{vu_id}}\n    assert:\n      - status: 200\n",
        server.uri()
    );
    let scn: Arc<Scenario> = Arc::new(serde_yaml::from_str(&yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let cancel = CancellationToken::new();
    let h = tokio::spawn(run_scenario_open_loop(scn, plan(40, 2, 2), tx, cancel));
    while rx.recv().await.is_some() {}
    h.await.unwrap().unwrap();
    let reqs = server.received_requests().await.unwrap();
    assert!(!reqs.is_empty());
    for r in &reqs {
        let p = r.url.path();
        assert!(
            p == "/u/0" || p == "/u/1",
            "vu_id must be slot 0 or 1, got {p}"
        );
    }
}

// ── §B34 curve-arrival-integral: 곡선 도착 수 = ∫rate (±1) ─────────────────────

fn st(target: u32, duration_seconds: u32) -> Stage {
    Stage {
        target,
        duration_seconds,
    }
}

/// 곡선 모드 RunPlan: duration == Σ stage durations (워커 불변식), target_rps 없음.
fn curve_plan(stages: Vec<Stage>, max_in_flight: u32) -> RunPlan {
    let secs: u64 = stages.iter().map(|s| u64::from(s.duration_seconds)).sum();
    RunPlan {
        target_rps: None,
        stages: Some(stages),
        ..plan(1, max_in_flight, secs)
    }
}

/// 곡선 run 1회: (요청 수, dropped, 경과, 결과). 시나리오는 http 스텝 1개라 요청 수 = 발사 수.
async fn run_curve(
    stages: Vec<Stage>,
    max_in_flight: u32,
    delay: Duration,
) -> (u64, u64, Duration, Result<(), handicap_engine::EngineError>) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(delay))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let started = Instant::now();
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        curve_plan(stages, max_in_flight),
        tx,
        CancellationToken::new(),
    ));
    let mut count = 0u64;
    let mut dropped = 0u64;
    while let Some(f) = rx.recv().await {
        count += f.windows.iter().map(|w| w.count).sum::<u64>();
        dropped += f.dropped;
    }
    let res = h.await.unwrap();
    (count, dropped, started.elapsed(), res)
}

#[tokio::test]
async fn curve_slow_ramp_from_zero_fires_cumulative_area() {
    // 0→5 rps / 4s, Λ=10. 수정 전: rate(0.1)=0.125 → 8s 간격 → ~1건.
    let (count, dropped, _, res) = run_curve(vec![st(5, 4)], 50, Duration::ZERO).await;
    res.unwrap();
    assert_eq!(dropped, 0, "ample pool");
    assert!((9..=11).contains(&count), "Λ=10, got {count}");
}

#[tokio::test]
async fn curve_short_ramp_fires_cumulative_area() {
    // 0→10 rps / 3s, Λ=15. 수정 전 ~1건.
    let (count, dropped, _, res) = run_curve(vec![st(10, 3)], 50, Duration::ZERO).await;
    res.unwrap();
    assert_eq!(dropped, 0, "ample pool");
    assert!((14..=16).contains(&count), "Λ=15, got {count}");
}

#[tokio::test]
async fn curve_leading_zero_hold_then_ramp_fires_cumulative_area() {
    // 0 hold 1s → 0→10 / 2s, Λ=10. 수정 전 poll이 ~1.0s에 깨어 rate≈0 → 수 초 간격 → ~1건.
    let (count, dropped, _, res) = run_curve(vec![st(0, 1), st(10, 2)], 50, Duration::ZERO).await;
    res.unwrap();
    assert_eq!(dropped, 0, "ample pool");
    assert!((9..=11).contains(&count), "Λ=10, got {count}");
}

#[tokio::test]
async fn curve_ending_at_zero_drains_tail_and_ends_at_deadline() {
    // 0→10 / 1s, hold 10 / 1s, 10→0 / 1s: Λ=20. 꼬리 소진 후 deadline(3s)까지 대기 후 정상 종료.
    let (count, dropped, elapsed, res) = tokio::time::timeout(
        Duration::from_secs(15),
        run_curve(vec![st(10, 1), st(10, 1), st(0, 1)], 50, Duration::ZERO),
    )
    .await
    .expect("run must end near its 3s deadline");
    res.unwrap();
    assert_eq!(dropped, 0, "ample pool");
    assert!((19..=21).contains(&count), "Λ=20, got {count}");
    assert!(
        elapsed >= Duration::from_secs(3),
        "ended early: {elapsed:?}"
    );
}

#[tokio::test]
async fn curve_all_zero_share_fires_nothing_and_ends_at_deadline() {
    // Review Focus 1: fan-out 정수 분할로 이 워커 몫이 전부 0인 곡선.
    let (count, dropped, elapsed, res) = tokio::time::timeout(
        Duration::from_secs(15),
        run_curve(vec![st(0, 2)], 8, Duration::ZERO),
    )
    .await
    .expect("run must end near its 2s deadline");
    res.unwrap();
    assert_eq!((count, dropped), (0, 0));
    assert!(
        elapsed >= Duration::from_secs(2),
        "ended early: {elapsed:?}"
    );
}

#[tokio::test]
async fn curve_drop_consumes_schedule_slot() {
    // 0→50 / 2s (Λ=50), 슬롯 1개·응답 200ms → 대부분 drop. drop도 스케줄 슬롯 하나를
    // 소비하므로 시도 수(count + dropped) ≈ Λ. 스케줄을 발사 수(arrival_counter)로 구동하면
    // drop 뒤 next가 과거에 머물러 drop이 폭주한다(Review Focus 5).
    let (count, dropped, _, res) = run_curve(vec![st(50, 2)], 1, Duration::from_millis(200)).await;
    res.unwrap();
    assert!(dropped > 0, "1 slot × 200ms must drop (dropped={dropped})");
    let attempts = count + dropped;
    assert!(
        (49..=51).contains(&attempts),
        "Λ=50 attempts, got count={count} + dropped={dropped} = {attempts}"
    );
}

#[tokio::test]
async fn curve_cancel_during_zero_hold_aborts_promptly() {
    // 긴 0 구간(30s) 중 cancel: poll-step이 없으니 대기 select의 cancel 분기가 유일한 경로.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![st(0, 30), st(10, 1)], 8),
        tx,
        cancel,
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    c2.cancel();
    let res = tokio::time::timeout(Duration::from_secs(5), async {
        while rx.recv().await.is_some() {}
        h.await.unwrap()
    })
    .await
    .expect("cancel must return within 5s");
    assert!(matches!(res, Err(handicap_engine::EngineError::Aborted)));
}
