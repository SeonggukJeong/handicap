// spec 2026-08-01-error-taxonomy §3.4 (E3): RunPlan.connect_timeout이 VuClient의
// reqwest connect_timeout까지 도달해, connect 단계 정지를 전체-요청 `timeout`이 아닌
// `connect_timeout`으로 가르는지 핀 고정. 이 판별이 US3의 전부다.
//
// 3 실행 진입점(closed/curve/open) 전부 각자 배선을 검증한다(리뷰 B-1) —
// `run_scenario`(closed-loop)만 찌르면 `run_scenario_vu_curve`/`run_scenario_open_loop`의
// 4번째 인자 배선은 어떤 회귀에도 이 파일이 못 잡는 사각지대가 된다. 모양은 E1
// `tests/error_kind_flush.rs`의 `Mode`+`base_plan`+3-way dispatch match를 그대로 따른다.
//
// 진단 출력에 reqwest Error의 Display/Debug 금지(Global) — kind만 assert.
use handicap_engine::{
    ErrorKind, MetricFlush, RampDown, RunPlan, Scenario, Stage, run_scenario,
    run_scenario_open_loop, run_scenario_vu_curve,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

// 비라우팅 IP — SYN에 응답이 없어 connect 단계에서 정지한다. 실측 확정:
// E1의 `tests/error_kind.rs::connect_stall_classifies_connect_timeout`이 같은 주소로
// 0.5초에 결정적 통과, raw 소켓으로 >2.6초 무응답 확인 → 아래 1초 임계는 안전.
// spec §9.1이 남긴 backlog-포화 대체안은 불필요.
const YAML: &str = "version: 1
name: ct
steps:
  - id: 01HX0000000000000000000001
    type: http
    name: stall
    request:
      method: GET
      url: http://10.255.255.1:81/
";

fn plan(
    mode: Mode,
    dur_ms: u64,
    http_timeout: Duration,
    connect_timeout: Option<Duration>,
) -> RunPlan {
    let mut p = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        // 호출부가 dur_ms를 고른다 — closed-loop는 http_timeout보다 넉넉히 길게 둬야
        // deadline까지 반복이 여러 번 돌며 분포가 결정적으로 채워진다(아래 각 테스트
        // 주석 참고). curve/open은 실행 모델이 달라(슈퍼바이저가 deadline까지 tick하고
        // 나서야 join) 규칙이 다르다 — 각 테스트 주석 참고.
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout,
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
        connect_timeout,
    };
    // Curve/open은 base 리터럴 이후 mode별 필드를 켠다 — E1 `error_kind_flush.rs`의
    // `base_plan`+`if let Mode::Open/Curve`(리뷰 B-1이 지정한 정본) 모양을 그대로 따른다.
    if let Mode::Open = mode {
        p.target_rps = Some(50);
        p.max_in_flight = Some(4);
    }
    if let Mode::Curve = mode {
        // `rate_at`(runner.rs)은 stage duration의 절반 지점에서야
        // desired=round(0.5)=1에 도달한다(선형보간) — stage 길이를 dur_ms에 비례시키면
        // dur_ms가 짧을 때 VU가 spawn되기도 전에 deadline을 맞는다. 1초 stage로
        // 고정해 spawn 지연을 ~500ms로 못박고, 실제 duration(dur_ms)은 호출부가 그보다
        // 넉넉히 길게 고른다.
        p.vu_stages = Some(vec![Stage {
            target: 1,
            duration_seconds: 1,
        }]);
    }
    p
}

async fn kind_totals(
    mode: Mode,
    dur_ms: u64,
    http_timeout: Duration,
    connect_timeout: Option<Duration>,
) -> Vec<(ErrorKind, u64)> {
    let scenario = Arc::new(Scenario::from_yaml(YAML).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let p = plan(mode, dur_ms, http_timeout, connect_timeout);
    let cancel = CancellationToken::new();
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, p, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, p, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, p, tx, cancel)),
    };
    let mut totals: std::collections::BTreeMap<ErrorKind, u64> = Default::default();
    while let Some(f) = rx.recv().await {
        for s in &f.error_kind_stats {
            *totals.entry(s.kind).or_default() += s.count;
        }
    }
    h.await.unwrap().unwrap();
    totals.into_iter().collect()
}

/// ON-path shared assertion for all three modes: connect_timeout must be recorded,
/// and it must never leak into the generic Timeout bucket (would mean the 4th
/// `with_timeout` argument on that mode's builder site didn't reach reqwest).
fn assert_connect_timeout_only(totals: &[(ErrorKind, u64)]) {
    let ct = totals
        .iter()
        .find(|(k, _)| *k == ErrorKind::ConnectTimeout)
        .map(|(_, c)| *c);
    assert!(
        ct.is_some_and(|c| c > 0),
        "connect_timeout이 집계돼야 한다. 실제 분포: {totals:?}"
    );
    assert!(
        !totals.iter().any(|(k, _)| *k == ErrorKind::Timeout),
        "노브 ON이면 일반 timeout으로 새면 안 된다. 실제 분포: {totals:?}"
    );
}

#[tokio::test]
async fn knob_on_classifies_connect_timeout_closed() {
    // closed-loop(`run_scenario`/`run_vu`) 배선. connect 1s < 전체 3s → connect
    // 타임아웃이 먼저 발화 → is_timeout && is_connect.
    // http_timeout을 3s로 둔 이유: Step 8의 고의 회귀(노브 무시) 시에도 6s run 안에서
    // 전체 타임아웃이 여유 있게 발화해 RED 분포가 결정적으로 [(Timeout, N)]이 된다
    // (5s면 마진 1s라 지터에 따라 []가 나와 예측이 어긋난다 — 이 파일의 http_timeout
    // 최댓값은 3s다, M-1).
    let totals = kind_totals(
        Mode::Closed,
        6000,
        Duration::from_secs(3),
        Some(Duration::from_secs(1)),
    )
    .await;
    assert_connect_timeout_only(&totals);
}

#[tokio::test]
async fn knob_off_classifies_plain_timeout() {
    // 대조군: 노브 없이 전체 타임아웃만 2s → 단계 불명 `timeout`. closed-loop 하나로
    // 충분하다(리뷰 B-1: curve/open은 각자 ON 배선만 확인하면 됨 — OFF 의미론은 3경로가
    // 공유하는 `VuClient::with_timeout`(None이면 빌더 호출 자체가 없음)과
    // `classify_send_error` 한 곳에서 결정되고, 그 판별은 이미 이 테스트가 closed-loop로
    // 검증한다).
    // spec 리뷰 R14: 전체-타임아웃이 먼저 터지면 is_connect가 성립하지 않는다.
    let totals = kind_totals(Mode::Closed, 6000, Duration::from_secs(2), None).await;
    let t = totals
        .iter()
        .find(|(k, _)| *k == ErrorKind::Timeout)
        .map(|(_, c)| *c);
    assert!(
        t.is_some_and(|c| c > 0),
        "노브 미설정이면 timeout이어야 한다. 실제 분포: {totals:?}"
    );
    assert!(
        !totals.iter().any(|(k, _)| *k == ErrorKind::ConnectTimeout),
        "노브 미설정인데 connect_timeout이 나오면 대조가 무의미. 실제 분포: {totals:?}"
    );
}

#[tokio::test]
async fn knob_on_classifies_connect_timeout_curve() {
    // VU-curve(`run_scenario_vu_curve`/`run_vu_curve`) 배선 — 리뷰 B-1: closed-loop만
    // 찌르면 이 경로의 4번째 인자 배선은 어떤 회귀에도 이 파일이 못 잡는다.
    //
    // closed-loop와 실행 모델이 다르다: 슈퍼바이저는 `Instant::now() >= deadline`까지
    // 250ms tick을 계속 돌고 나서야 `join_next()`로 넘어간다(VU가 먼저 끝나도 루프가
    // 조기 종료하지 않는다) — 그래서 duration을 너무 크게 잡으면 그 값 자체가
    // wall-clock 하한이 돼 버린다. 1200ms로 고른 근거: `plan()`의 1초 stage가 spawn을
    // ~500ms에 만들고, 1200ms는 그보다 700ms 여유가 있으면서도 connect_timeout
    // 완료(spawn ~500ms + connect 1s ≈ 1.5s)보다 짧다 — 슈퍼바이저가 1200ms에서 먼저
    // 빠져나가고 남은 ~300ms는 `join_next()`가 흡수해, duration을 더 키워도 얻는 게
    // 없다(총 wall ≈ 1.5s).
    let totals = kind_totals(
        Mode::Curve,
        1200,
        Duration::from_secs(3),
        Some(Duration::from_secs(1)),
    )
    .await;
    assert_connect_timeout_only(&totals);
}

#[tokio::test]
async fn knob_on_classifies_connect_timeout_open() {
    // open-loop(`run_scenario_open_loop`) 슬롯-풀 배선 — 리뷰 B-1: 세 번째
    // `VuClient::with_timeout` 4번째 인자 사이트(슬롯 풀 생성, curve/closed와 별개
    // 코드 경로 — S-C 격리).
    // target_rps=50/max_in_flight=4 → 첫 arrival이 t≈0에 슬롯을 잡으므로 curve의 ramp
    // 지연이 없다. duration=900ms(< connect_timeout 1s 완료 시점)로 짧게 잡아 스케줄
    // 루프가 먼저 빠지고 `join_next()`가 남은 대기를 흡수하게 한다(curve와 같은
    // "tick-until-deadline" 모델 — 위 curve 주석 참고).
    let totals = kind_totals(
        Mode::Open,
        900,
        Duration::from_secs(3),
        Some(Duration::from_secs(1)),
    )
    .await;
    assert_connect_timeout_only(&totals);
}
