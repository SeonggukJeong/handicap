//! Loop node + `${loop_index}` end-to-end: a loop body with `repeat: 3` whose
//! request URL contains `${loop_index}` must hit `/item/0`, `/item/1`, `/item/2`
//! (0-based). Each path has its own stub asserting 200; if `${loop_index}` were
//! not resolved (or resolved to the wrong value), the URL would miss every stub,
//! wiremock would 404, the `status: 200` assertion would fail, and `errors > 0`.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn loop_index_resolves_per_iteration() {
    let server = MockServer::start().await;

    for i in 0..3 {
        Mock::given(method("GET"))
            .and(path(format!("/item/{i}")))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;
    }

    let yaml = format!(
        r#"
version: 1
name: loop-index
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: fan-out
    type: loop
    repeat: 3
    do:
      - id: "01HX0000000000000000000002"
        name: fetch
        type: http
        request:
          method: GET
          url: "{{{{base}}}}/item/${{loop_index}}"
        assert:
          - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 2,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone)
            .await
            .expect("runs");
    });

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    while let Some(batch) = rx.recv().await {
        for w in batch {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0, "loop body should record at least one request");
    assert_eq!(
        errors, 0,
        "every iteration must hit /item/<loop_index>; {errors} of {total} requests missed (404)"
    );
}
