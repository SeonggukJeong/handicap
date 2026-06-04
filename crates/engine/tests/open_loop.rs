use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario_open_loop};
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
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: Some(target_rps),
        max_in_flight: Some(max_in_flight),
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
