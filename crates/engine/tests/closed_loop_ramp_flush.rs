//! closed-loop 고정: 상승 중에도 메트릭이 흘러야 한다(spec F2b).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn plan(secs: u64) -> RunPlan {
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

fn scenario(url: &str) -> Arc<Scenario> {
    let yaml = format!(
        "version: 1\nname: ol\nsteps:\n  - id: 01HX0000000000000000000010\n    name: get\n    type: http\n    request:\n      method: GET\n      url: {url}\n    assert:\n      - status: 200\n"
    );
    Arc::new(serde_yaml::from_str(&yaml).unwrap())
}

async fn delayed_server(delay: Duration) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(delay))
        .mount(&server)
        .await;
    server
}

/// spec F2b: 상승 중에도 메트릭이 흘러야 한다(시작 감시가 「부하 없음」으로 오판하지 않게).
#[tokio::test]
async fn metrics_flow_during_ramp_up() {
    let server = delayed_server(Duration::from_millis(10)).await;
    let mut p = plan(6);
    p.vus = 4;
    p.ramp_up = Duration::from_secs(4); // 1초마다 VU 1개 → 띄우는 반복문이 3초 넘게 돈다
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(256);
    let started = std::time::Instant::now();
    let h = tokio::spawn(run_scenario(
        scenario(&format!("{}/", server.uri())),
        p,
        tx,
        CancellationToken::new(),
    ));
    let first = rx.recv().await.expect("a flush");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(2500),
        "첫 flush가 상승이 끝난 뒤({elapsed:?})에야 왔다"
    );
    assert!(!first.windows.is_empty());
    while rx.recv().await.is_some() {}
    h.await.unwrap().unwrap();
}
