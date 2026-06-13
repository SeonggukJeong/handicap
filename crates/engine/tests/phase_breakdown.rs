use std::sync::Arc;
use std::time::Duration;

use handicap_engine::aggregator::PhaseStat;
use handicap_engine::runner::{MetricFlush, RampDown, RunPlan, run_scenario};
use handicap_engine::scenario::Scenario;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn plan(measure_phases: bool) -> RunPlan {
    RunPlan {
        vus: 2,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(400),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
    }
}

async fn collect_phases(measure_phases: bool) -> Vec<PhaseStat> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/p"))
        .respond_with(ResponseTemplate::new(200).set_body_string("payload"))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - id: 01HX0000000000000000000051\n    type: http\n    name: g\n    request:\n      method: GET\n      url: {}/p\n",
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let h = tokio::spawn(run_scenario(
        scenario,
        plan(measure_phases),
        tx,
        CancellationToken::new(),
    ));
    let mut phases = Vec::new();
    while let Some(f) = rx.recv().await {
        phases.extend(f.phase_stats);
    }
    h.await.unwrap().unwrap();
    phases
}

#[tokio::test]
async fn measure_phases_on_records_download_deltas() {
    let phases = collect_phases(true).await;
    assert!(
        phases.iter().any(|p| p.phase == "download" && p.count > 0),
        "expected download phase deltas when measure_phases=true"
    );
}

#[tokio::test]
async fn measure_phases_off_records_nothing() {
    assert!(
        collect_phases(false).await.is_empty(),
        "no phase deltas when measure_phases=false (byte-identical)"
    );
}
