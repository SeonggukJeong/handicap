use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// When the target returns 500 but the step asserts `status: 200`, the engine
/// must count every request as an error.  This verifies the full path:
///   executor: `Assertion::Status(200) != 500`  → `ExecOutcome { error: Some(_) }`
///   aggregator: `is_error = outcome.error.is_some()` → `error_count += 1`
///   flush: `StepWindow { error_count, count }` sent to the caller
///
/// followups-after-mvp1 #11
#[tokio::test]
async fn assertion_failure_increments_error_count() {
    let server = MockServer::start().await;

    // Always return 500 so the `assert: [{ status: 200 }]` always fires.
    Mock::given(method("GET"))
        .and(path("/always-500"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: assert-failure
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000040"
    name: failing-assert
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/always-500"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone)
            .await
            .expect("run_scenario itself should not fail");
    });

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0, "at least one request must have been recorded");
    assert_eq!(
        errors, total,
        "every request should have been counted as an error (got {errors} errors out of {total} requests)"
    );
}
