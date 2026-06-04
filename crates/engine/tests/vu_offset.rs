//! Global vu_id: a worker running a shard slice numbers its VUs by the global
//! `vu_offset + local_index`, so `${vu_id}` (and data-binding selection) match
//! single-worker numbering. (A3a spec §3.)
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn run_with_offset(target: &str, vu_offset: u32, vus: u32) {
    let yaml = format!(
        "version: 1\nname: vu-offset\nvariables:\n  base: \"{target}\"\nsteps:\n  - id: \"01HX0000000000000000000010\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n"
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parse"));
    let plan = RunPlan {
        vus,
        ramp_up: Duration::from_secs(0),
        // 2s (not 1s) so both VUs reliably fire at least once even on a loaded
        // machine — matches runner_e2e.rs and the repo's ramp-up timing note.
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
    };
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(scenario, plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_vu_id_reflects_offset() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    // Shard with offset 10, 2 VUs → vu_ids 10 and 11 must reach the target.
    run_with_offset(&server.uri(), 10, 2).await;

    let reqs = server.received_requests().await.unwrap();
    let qs: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(
        qs.iter().any(|q| q.contains("vu=10")),
        "vu=10 missing: {qs:?}"
    );
    assert!(
        qs.iter().any(|q| q.contains("vu=11")),
        "vu=11 missing: {qs:?}"
    );
    assert!(
        !qs.iter().any(|q| q.contains("vu=0")),
        "offset ignored: {qs:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vu_offset_zero_is_legacy_numbering() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    run_with_offset(&server.uri(), 0, 2).await;

    let reqs = server.received_requests().await.unwrap();
    let qs: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(
        qs.iter().any(|q| q.contains("vu=0")),
        "vu=0 missing: {qs:?}"
    );
    assert!(
        qs.iter().any(|q| q.contains("vu=1")),
        "vu=1 missing: {qs:?}"
    );
}
