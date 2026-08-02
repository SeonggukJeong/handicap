// spec 2026-08-01-error-taxonomy §3.4 (E3): RunPlan.connect_timeout이 VuClient의
// reqwest connect_timeout까지 도달해, connect 단계 정지를 전체-요청 `timeout`이 아닌
// `connect_timeout`으로 가르는지 핀 고정. 이 판별이 US3의 전부다.
// 진단 출력에 reqwest Error의 Display/Debug 금지(Global) — kind만 assert.
use handicap_engine::{ErrorKind, MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

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

fn plan(http_timeout: Duration, connect_timeout: Option<Duration>) -> RunPlan {
    RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        // http_timeout(최대 5s)보다 길어야 노브 OFF 대조군에서도 실제 타임아웃이
        // 기록된다 — 짧으면 run deadline이 먼저 끊어 분포가 빈 채로 끝난다.
        duration: Duration::from_millis(6000),
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
    }
}

async fn kind_totals(
    http_timeout: Duration,
    connect_timeout: Option<Duration>,
) -> Vec<(ErrorKind, u64)> {
    let scenario = Arc::new(Scenario::from_yaml(YAML).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario(
        scenario,
        plan(http_timeout, connect_timeout),
        tx,
        CancellationToken::new(),
    ));
    let mut totals: std::collections::BTreeMap<ErrorKind, u64> = Default::default();
    while let Some(f) = rx.recv().await {
        for s in &f.error_kind_stats {
            *totals.entry(s.kind).or_default() += s.count;
        }
    }
    h.await.unwrap().unwrap();
    totals.into_iter().collect()
}

#[tokio::test]
async fn knob_on_classifies_connect_timeout() {
    // connect 1s < 전체 3s → connect 타임아웃이 먼저 발화 → is_timeout && is_connect.
    // http_timeout을 3s로 둔 이유: Step 8의 고의 회귀(노브 무시) 시에도 6s run 안에서
    // 전체 타임아웃이 여유 있게 발화해 RED 분포가 결정적으로 [(Timeout, N)]이 된다
    // (5s면 마진 1s라 지터에 따라 []가 나와 예측이 어긋난다).
    let totals = kind_totals(Duration::from_secs(3), Some(Duration::from_secs(1))).await;
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
async fn knob_off_classifies_plain_timeout() {
    // 대조군: 노브 없이 전체 타임아웃만 2s → 단계 불명 `timeout`.
    // spec 리뷰 R14: 전체-타임아웃이 먼저 터지면 is_connect가 성립하지 않는다.
    let totals = kind_totals(Duration::from_secs(2), None).await;
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
