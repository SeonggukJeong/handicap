use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, Stage, run_scenario_vu_curve};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn ramp_down_default_is_graceful() {
    assert_eq!(RampDown::default(), RampDown::Graceful);
}

#[test]
fn ramp_down_serde_lowercase_round_trip() {
    assert_eq!(
        serde_json::to_string(&RampDown::Immediate).unwrap(),
        "\"immediate\""
    );
    assert_eq!(
        serde_json::from_str::<RampDown>("\"graceful\"").unwrap(),
        RampDown::Graceful
    );
}

fn curve_plan(stages: Vec<Stage>, ramp_down: RampDown) -> RunPlan {
    let secs: u64 = stages.iter().map(|s| u64::from(s.duration_seconds)).sum();
    RunPlan {
        vus: 0, // curve ignores vus (controller-validated to 0)
        ramp_up: Duration::ZERO,
        duration: Duration::from_secs(secs), // worker invariant: sum(stage durations)
        env: BTreeMap::new(),
        loop_breakdown_cap: 256,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: Some(stages),
        ramp_down,
        graceful_ramp_down: None,
    }
}

fn scenario(url: &str) -> Arc<Scenario> {
    let yaml = format!(
        "version: 1\nname: vc\nsteps:\n  - id: 01HX0000000000000000000010\n    name: get\n    type: http\n    request:\n      method: GET\n      url: {url}\n    assert:\n      - status: 200\n"
    );
    Arc::new(serde_yaml::from_str(&yaml).unwrap())
}

fn stage(target: u32, duration_seconds: u32) -> Stage {
    Stage {
        target,
        duration_seconds,
    }
}

/// 채널을 다 마시고 (총 count, 총 error) 집계.
async fn drain(rx: &mut mpsc::Receiver<MetricFlush>) -> (u64, u64) {
    let (mut count, mut errors) = (0u64, 0u64);
    while let Some(f) = rx.recv().await {
        count += f.windows.iter().map(|w| w.count).sum::<u64>();
        errors += f.windows.iter().map(|w| w.error_count).sum::<u64>();
    }
    (count, errors)
}

#[tokio::test]
async fn vu_curve_ramps_and_completes_at_stage_sum() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let started = Instant::now();
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(2, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let (count, errors) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    let elapsed = started.elapsed();
    assert!(count > 0, "curve run should fire requests, got {count}");
    assert_eq!(errors, 0);
    // deadline = sum(stage durations) = 2s. 넉넉한 상한(spec §7.1: 정확 단언은 flake).
    assert!(
        (Duration::from_millis(1800)..Duration::from_millis(4000)).contains(&elapsed),
        "run should end near 2s, took {elapsed:?}"
    );
}

#[tokio::test]
async fn vu_curve_cookie_jar_persists_across_park() {
    // 곡선 1→0→1: 가운데 0 VU 구간이 park를 강제. jar가 슬롯-지속이면
    // 맨 첫 요청만 쿠키가 없다 (재활성화 첫 요청도 쿠키 동반).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).insert_header("set-cookie", "sid=abc123"))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(
            vec![stage(1, 1), stage(0, 2), stage(1, 1)],
            RampDown::Graceful,
        ),
        tx,
        CancellationToken::new(),
    ));
    let (count, _) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    let reqs = server.received_requests().await.unwrap();
    let with_cookie = reqs
        .iter()
        .filter(|r| {
            r.headers
                .get("cookie")
                .map(|v| v.to_str().unwrap_or("").contains("sid=abc123"))
                .unwrap_or(false)
        })
        .count() as u64;
    assert!(
        count >= 2,
        "need at least two requests to prove persistence, got {count}"
    );
    assert_eq!(
        with_cookie,
        count - 1,
        "only the very first request may lack the cookie (jar persists across park)"
    );
}

#[tokio::test]
async fn vu_curve_vu_ids_stay_within_bound() {
    // ${vu_id}를 경로에 에코 → 모든 id < max(stage.target).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: vc\nsteps:\n  - id: 01HX0000000000000000000010\n    name: get\n    type: http\n    request:\n      method: GET\n      url: {}/u/${{vu_id}}\n    assert:\n      - status: 200\n",
        server.uri()
    );
    let sc: Arc<Scenario> = Arc::new(serde_yaml::from_str(&yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        sc,
        curve_plan(vec![stage(3, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let (count, _) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    assert!(count > 0);
    let reqs = server.received_requests().await.unwrap();
    for r in &reqs {
        let id: u32 = r.url.path().rsplit('/').next().unwrap().parse().unwrap();
        assert!(id < 3, "vu_id {id} outside [0, 3)");
    }
}

#[tokio::test]
async fn vu_curve_graceful_rampdown_records_no_errors() {
    // 느린 응답 + 하강 곡선: graceful retire는 에러/abort를 메트릭에 안 남긴다.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(4, 1), stage(0, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let (count, errors) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    assert!(count > 0);
    assert_eq!(errors, 0, "graceful ramp-down must not record errors");
}

#[tokio::test]
async fn vu_curve_immediate_retire_is_not_a_failure() {
    // immediate: 토큰 취소로 스텝 경계 중단 — run은 Ok, 에러 0 (retire ≠ failed).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(4, 1), stage(0, 2)], RampDown::Immediate),
        tx,
        CancellationToken::new(),
    ));
    let (count, errors) = drain(&mut rx).await;
    let res = h.await.unwrap();
    assert!(
        res.is_ok(),
        "immediate retire must not fail the run: {res:?}"
    );
    assert!(count > 0);
    assert_eq!(errors, 0);
}

#[tokio::test]
async fn vu_curve_all_spawned_vus_failed() {
    // strict 렌더 실패(UnknownVar)로 spawn된 전 VU가 죽으면 AllVusFailed (spawned 기준).
    let yaml = "version: 1\nname: vc\nsteps:\n  - id: 01HX0000000000000000000010\n    name: bad\n    type: http\n    request:\n      method: GET\n      url: http://127.0.0.1:1/{{missing}}\n    assert:\n      - status: 200\n";
    let sc: Arc<Scenario> = Arc::new(serde_yaml::from_str(yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        sc,
        curve_plan(vec![stage(2, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    drain(&mut rx).await;
    let res = h.await.unwrap();
    assert!(
        matches!(res, Err(handicap_engine::EngineError::AllVusFailed { .. })),
        "expected AllVusFailed, got {res:?}"
    );
}

#[tokio::test]
async fn vu_curve_abort_cancels_run() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    // 가파른 ramp(1s에 2 VU) + 긴 hold: cancel 시점(1.5s)에 active VU가 실재하는
    // 상태의 abort를 검증 (500ms-cancel이면 desired=0이라 spawn 전 abort만 커버).
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(2, 1), stage(2, 10)], RampDown::Graceful),
        tx,
        cancel,
    ));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    c2.cancel();
    drain(&mut rx).await;
    let res = h.await.unwrap();
    assert!(matches!(res, Err(handicap_engine::EngineError::Aborted)));
}

#[tokio::test]
async fn vu_curve_emits_active_vu_samples() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(3, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let mut samples: Vec<handicap_engine::ActiveVuSample> = Vec::new();
    while let Some(f) = rx.recv().await {
        samples.extend(f.active_vu_samples);
    }
    h.await.unwrap().unwrap();
    assert!(!samples.is_empty(), "curve run must emit active-VU samples");
    let max_desired = samples.iter().map(|s| s.desired).max().unwrap();
    assert_eq!(max_desired, 3, "desired should reach stage target 3");
    assert!(
        samples.iter().any(|s| s.actual > 0),
        "actual VUs should be observed"
    );
    let mut secs: Vec<i64> = samples.iter().map(|s| s.ts_second).collect();
    secs.sort_unstable();
    let mut uniq = secs.clone();
    uniq.dedup();
    assert_eq!(uniq.len(), secs.len(), "one active-VU sample per second");
}

fn scenario_n_steps(url: &str, n: usize) -> Arc<Scenario> {
    let mut steps = String::new();
    for i in 0..n {
        // ULID는 Crockford base32(I/L/O/U 제외) — ...001{0..} 로 유효.
        steps.push_str(&format!(
            "  - id: 01HX000000000000000000001{i}\n    name: s{i}\n    type: http\n    request:\n      method: GET\n      url: {url}\n    assert:\n      - status: 200\n"
        ));
    }
    let yaml = format!("version: 1\nname: vc\nsteps:\n{steps}");
    Arc::new(serde_yaml::from_str(&yaml).unwrap())
}

async fn run_curve_count(server_uri: &str, cap: Option<Duration>) -> u64 {
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    // 곡선 [stage(2,1), stage(0,4)] = 5s run. VU1은 t≈0.75s 활성→t≈2s 은퇴.
    // 20스텝×250ms = 5s iteration → 은퇴 후 남은 run(3s)보다 iteration이 길다:
    //   uncapped VU1 = deadline(5s)에 잘림 ≈ (5−0.75)/0.25 ≈ 17스텝
    //   capped   VU1 = cap(은퇴 t≈2 + 1s)에 t≈3s 취소 ≈ (3−0.75)/0.25 ≈ 9스텝
    //   → 결정적 gap ≈ 8. iteration이 remaining-run보다 길어야 gap이 벌어진다(핵심).
    let plan = RunPlan {
        graceful_ramp_down: cap,
        ..curve_plan(vec![stage(2, 1), stage(0, 4)], RampDown::Graceful)
    };
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario_n_steps(&format!("{server_uri}/"), 20),
        plan,
        tx,
        CancellationToken::new(),
    ));
    let (count, errors) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    assert_eq!(errors, 0, "graceful cap run must not error");
    count
}

#[tokio::test]
async fn graceful_cap_cuts_lingering_iterations() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(250)))
        .mount(&server)
        .await;
    // 실시간 sanity check — 결정적 증명은 retire_expired 단위 테스트. iteration(5s)이
    // 은퇴 후 remaining-run(3s)보다 길어 uncapped=deadline-cut / capped=cap-cut로
    // gap ≈ 8이 robust. **커밋 전 실측으로 gap을 확인**(escalate: 마진 없으면 스텝 수↑).
    let uncapped = run_curve_count(&server.uri(), None).await;
    let capped = run_curve_count(&server.uri(), Some(Duration::from_secs(1))).await;
    assert!(
        capped < uncapped,
        "capped run should execute fewer requests (retiring VUs cut at cap): capped={capped} uncapped={uncapped}"
    );
}
