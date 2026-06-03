use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Drive a 1-VU run for `run_secs` against a target that delays `delay_ms`, with
/// the engine client timeout set to `http_timeout`. Returns (total, errors).
async fn run_with_timeout(delay_ms: u64, http_timeout: Duration, run_secs: u64) -> (u64, u64) {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(delay_ms)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: timeout-test
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000050"
    name: slow
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/slow"
    assert: []
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(run_secs),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move {
        run_scenario(scenario, plan, tx, cancel)
            .await
            .expect("run ok");
    });
    let (mut total, mut errors) = (0u64, 0u64);
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");
    (total, errors)
}

#[tokio::test]
async fn short_client_timeout_errors_on_slow_target() {
    // Target delays 400ms; client timeout 100ms → every request times out (status 0, error).
    let (total, errors) = run_with_timeout(400, Duration::from_millis(100), 1).await;
    assert!(total > 0, "at least one request recorded");
    assert_eq!(
        errors, total,
        "all requests should time out: {errors}/{total}"
    );
}

#[tokio::test]
async fn generous_client_timeout_succeeds_on_slow_target() {
    // Same 400ms delay but 5s timeout → no timeout errors.
    let (total, errors) = run_with_timeout(400, Duration::from_secs(5), 2).await;
    assert!(total > 0, "at least one request recorded");
    assert_eq!(errors, 0, "no request should time out: {errors}/{total}");
}

/// A per-step `timeout_seconds` overrides the (generous) client timeout for that
/// step only: a 1s step timeout against a 1500ms-delayed target → all errors,
/// even though the client default is 30s.
#[tokio::test]
async fn per_step_timeout_overrides_client_default() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(1500)))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: per-step-timeout
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000053"
    name: slow
    type: http
    timeout_seconds: 1
    request:
      method: GET
      url: "{{{{base}}}}/slow"
    assert: []
"#,
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30), // generous client default
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move {
        run_scenario(scenario, plan, tx, cancel)
            .await
            .expect("run ok");
    });
    let (mut total, mut errors) = (0u64, 0u64);
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");
    assert!(total > 0, "at least one request recorded");
    assert_eq!(
        errors, total,
        "per-step 1s timeout must fire: {errors}/{total}"
    );
}
