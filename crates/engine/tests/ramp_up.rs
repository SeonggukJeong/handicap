use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn ramp_up_increases_count_over_time() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(50)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: ramp
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000040"
    name: ping
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 20,
        ramp_up: Duration::from_secs(2),
        duration: Duration::from_secs(4),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone)
            .await
            .expect("runs");
    });

    let mut per_sec: BTreeMap<i64, u64> = BTreeMap::new();
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            *per_sec.entry(w.ts_second).or_insert(0) += w.count;
        }
    }
    run.await.expect("join");

    // We don't pin exact counts (CI is noisy), but we DO assert that the
    // earliest 1s window has strictly fewer requests than the steady-state
    // window once ramp finished — i.e., ramp-up actually delays VU spawn.
    let mut windows: Vec<(i64, u64)> = per_sec.into_iter().collect();
    windows.sort_by_key(|(t, _)| *t);
    assert!(
        windows.len() >= 3,
        "expected at least 3 1-second windows, got {:?}",
        windows
    );
    let first = windows.first().unwrap().1;
    let later = windows[windows.len() - 2].1; // not the last (may be partial drain)
    assert!(
        first < later,
        "ramp-up: first window count {first} should be < later window count {later}; windows: {windows:?}",
    );
}
