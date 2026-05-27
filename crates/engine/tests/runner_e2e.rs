use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn runs_5_vus_for_2_seconds_against_mock() {
    // Arrange — mock target server.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: test
variables:
  base: "{}"
steps:
  - id: home
    name: GET /
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
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 5,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: std::collections::BTreeMap::new(),
    };

    let cancel = tokio_util::sync::CancellationToken::new();
    let scenario_clone = scenario.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel)
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

    assert!(total > 0, "should record at least one request");
    assert_eq!(errors, 0, "no assertion failures expected");
}
