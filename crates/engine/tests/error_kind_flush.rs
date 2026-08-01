// error_kind_stats가 3 진입점 모두에서 flush로 나오는지 + 깨끗한 run은 빈 벡터인지.
use handicap_engine::{ErrorKind, MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use handicap_engine::{run_scenario_open_loop, run_scenario_vu_curve};
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

const YAML_TPL: &str = "version: 1
name: ek
steps:
  - id: 01HX0000000000000000000001
    type: http
    name: hit
    request:
      method: GET
      url: {URI}
";

fn base_plan(dur_ms: u64) -> RunPlan {
    RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
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
    }
}
// ↑ 리터럴은 작성 시점 RunPlan 필드 전수(E3 전이라 connect_timeout 없음) —
// 컴파일 에러가 나면 `crates/engine/tests/think_time.rs`의 동일 리터럴을 정본으로 맞출 것.

/// 모든 flush를 **개별로** 수집한다 — concat하면 periodic/final 경로 구분이 사라져
/// 6드레인+5가드 회귀를 원리적으로 못 잡는다(리뷰 P5).
async fn collect_flushes(mode: Mode, url: &str, dur_ms: u64) -> Vec<MetricFlush> {
    let yaml = YAML_TPL.replace("{URI}", url);
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let mut plan = base_plan(dur_ms);
    if let Mode::Open = mode {
        plan.target_rps = Some(50);
        plan.max_in_flight = Some(4);
    }
    if let Mode::Curve = mode {
        // 타입·필드 정본: `runner.rs:31-34`의 `Stage` + `vu_curve.rs:28-49` `curve_plan` (리뷰 P1)
        plan.vu_stages = Some(vec![handicap_engine::Stage {
            target: 1,
            duration_seconds: (dur_ms / 1000).max(1) as u32,
        }]);
    }
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, plan, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, plan, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, plan, tx, cancel)),
    };
    let mut out = Vec::new();
    while let Some(f) = rx.recv().await {
        out.push(f);
    }
    h.await.unwrap().unwrap();
    out
}

fn kind_total(flushes: &[MetricFlush], kind: ErrorKind) -> u64 {
    flushes
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .filter(|s| s.kind == kind)
        .map(|s| s.count)
        .sum()
}

fn loaded_flushes(flushes: &[MetricFlush]) -> usize {
    flushes
        .iter()
        .filter(|f| !f.error_kind_stats.is_empty())
        .count()
}

fn refused_url() -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    format!("http://{addr}/")
}

#[tokio::test]
async fn closed_loop_flushes_error_kinds_periodically() {
    // 3초 run: periodic(500ms 틱) + final 양쪽에 실려 ≥2 flush.
    // periodic 드레인을 지우면 final 1개로 줄어 RED (리뷰 P5 축 b).
    let flushes = collect_flushes(Mode::Closed, &refused_url(), 3000).await;
    assert!(kind_total(&flushes, ErrorKind::ConnectRefused) > 0);
    assert!(
        loaded_flushes(&flushes) >= 2,
        "expected error_kind_stats in >=2 flushes (periodic+final), got {}",
        loaded_flushes(&flushes)
    );
}

#[tokio::test]
async fn open_loop_flushes_error_kinds_periodically() {
    let flushes = collect_flushes(Mode::Open, &refused_url(), 3000).await;
    assert!(kind_total(&flushes, ErrorKind::ConnectRefused) > 0);
    assert!(
        loaded_flushes(&flushes) >= 2,
        "got {}",
        loaded_flushes(&flushes)
    );
}

#[tokio::test]
async fn vu_curve_flushes_error_kinds_periodically() {
    let flushes = collect_flushes(Mode::Curve, &refused_url(), 3000).await;
    assert!(kind_total(&flushes, ErrorKind::ConnectRefused) > 0);
    assert!(
        loaded_flushes(&flushes) >= 2,
        "got {}",
        loaded_flushes(&flushes)
    );
}

#[tokio::test]
async fn error_kind_totals_match_status0_window_counts() {
    // 불변식: send-실패 1건 = 윈도 status "0" 1건 = error_kind 1건.
    // 새 send-guard 항(`|| !error_kind_stats.is_empty()`)을 지우면 "윈도는 비었는데
    // 에러 delta만 있는" 틱(초 중간 틱)에서 드레인된 delta가 send 없이 버려져
    // 등식이 깨진다 — 가드 삭제 회귀의 결정적 검출 (리뷰 P5 축 a).
    let flushes = collect_flushes(Mode::Closed, &refused_url(), 3000).await;
    let kinds: u64 = flushes
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .map(|s| s.count)
        .sum();
    let status0: u64 = flushes
        .iter()
        .flat_map(|f| f.windows.iter())
        .map(|w| w.status_counts.get(&0).copied().unwrap_or(0))
        .sum();
    assert!(kinds > 0);
    assert_eq!(
        kinds, status0,
        "every classified failure must reach the wire exactly once"
    );
}

#[tokio::test]
async fn short_run_final_flush_carries_error_kinds() {
    // 300ms run: brief 원안은 "유의미한 periodic 틱 전에 종료 → final 드레인이 유일
    // 경로"를 가정하고 `kind_total > 0`만 단언했지만, `tokio::time::interval`의
    // *첫 tick은 즉시 완료된다*는 성질(well-known gotcha) 때문에 실측(3회 반복)상
    // periodic 플러셔의 "즉시" 첫 틱이 항상 최소 1~4건의 ConnectRefused를 선점해
    // 드레인해 간다 — final 드레인을 `vec![]`로 죽여도 그 소수 건이 여전히 wire에
    // 남아 `kind_total > 0`이 계속 참이라 RED가 안 나온다(공허 축, plan-mandated
    // 이빨 실증 규율 위반이라 그대로 두지 않음).
    // 대신 실측으로 확인된 불변식(윈도 count == error_kind count, 300ms/3회 반복
    // 모두 정확히 일치)으로 단언을 강화 — final 드레인이 죽으면 final flush의
    // window count(수천 건)는 그대로인데 error_kind count만 0에 가깝게 빠져
    // 등식이 크게 어긋나 결정적 RED가 난다(리뷰 P5 축 c).
    let flushes = collect_flushes(Mode::Closed, &refused_url(), 300).await;
    let kinds: u64 = flushes
        .iter()
        .flat_map(|f| f.error_kind_stats.iter())
        .map(|s| s.count)
        .sum();
    let status0: u64 = flushes
        .iter()
        .flat_map(|f| f.windows.iter())
        .map(|w| w.status_counts.get(&0).copied().unwrap_or(0))
        .sum();
    assert!(
        status0 > 0,
        "sanity: run should attempt at least one request"
    );
    assert_eq!(
        kinds, status0,
        "final drain must carry the error_kind delta not caught by the periodic path's one early tick"
    );
}

#[tokio::test]
async fn clean_run_has_empty_error_kinds() {
    // wiremock 200 → error_kind_stats가 어떤 flush에도 실리면 안 됨 (byte-identical 축).
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let flushes = collect_flushes(Mode::Closed, &format!("{}/", server.uri()), 1000).await;
    assert_eq!(
        loaded_flushes(&flushes),
        0,
        "clean run must not emit error_kind_stats"
    );
}
