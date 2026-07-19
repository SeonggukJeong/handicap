//! When every VU fails during a run (e.g., scenario references an undefined
//! template variable), `run_scenario` must surface this as `Err`, not silently
//! return `Ok(())` — otherwise the worker reports `RunStatus::Completed` for a
//! run that produced zero metrics, hiding the failure from operators.

use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{EngineError, MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;

#[tokio::test]
async fn all_vus_failed_surfaces_as_error() {
    let yaml = r#"
version: 1
name: bad
variables: {}
steps:
  - id: bad
    name: bad
    type: http
    request:
      method: GET
      url: "{{missing_var}}/"
    assert:
      - status: 200
"#;
    let scenario = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let plan = RunPlan {
        vus: 3,
        ramp_up: std::time::Duration::from_secs(0),
        duration: Duration::from_millis(200),
        env: std::collections::BTreeMap::new(),
        loop_breakdown_cap: 0,
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
    };
    let (tx, _rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = tokio_util::sync::CancellationToken::new();

    let res = run_scenario(scenario, plan, tx, cancel).await;

    match res {
        Err(EngineError::AllVusFailed { failed, total, .. }) => {
            assert_eq!(failed, 3, "expected 3 failed VUs");
            assert_eq!(total, 3, "expected 3 total VUs");
        }
        other => panic!("expected Err(AllVusFailed), got {other:?}"),
    }
}

/// Task 2 (US3): when every VU fails, the run's `AllVusFailed` error must carry
/// a sample of the first non-`Aborted` failure cause, so operators without the
/// editor (YAML modal / curl / HAR) can see *why* from the run message alone —
/// not just the bare `(N/N)` count. Single failure cause + single VU: with
/// multiple VUs which cause lands first in the `OnceLock` is nondeterministic,
/// which would make this test flaky.
#[tokio::test]
async fn all_vus_failed_carries_first_failure_cause() {
    let yaml = r#"
version: 1
name: bad
variables: {}
steps:
  - id: bad
    name: bad
    type: http
    request:
      method: GET
      url: "{{token}}/"
    assert:
      - status: 200
"#;
    let scenario = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let plan = RunPlan {
        vus: 1,
        ramp_up: std::time::Duration::from_secs(0),
        duration: Duration::from_millis(200),
        env: std::collections::BTreeMap::new(),
        loop_breakdown_cap: 0,
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
    };
    let (tx, _rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = tokio_util::sync::CancellationToken::new();

    let res = run_scenario(scenario, plan, tx, cancel).await;

    match res {
        Err(err @ EngineError::AllVusFailed { failed, total, .. }) => {
            assert_eq!(failed, 1, "expected 1 failed VU");
            assert_eq!(total, 1, "expected 1 total VU");
            assert_eq!(
                err.to_string(),
                "all VUs failed (1/1): template: unknown variable token",
                "expected the first failure cause to be sampled into the message"
            );
        }
        other => panic!("expected Err(AllVusFailed), got {other:?}"),
    }
}

/// SECURITY REGRESSION (fix-1, post-Task-2 review): `AllVusFailed.cause` is now
/// persisted (worker `phase_for_result` → gRPC `RunStatus.message` → controller
/// `truncate_message` → the `runs.message` DB column → `GET /api/runs/{id}` →
/// UI), so a raw `EngineError::CastFailed.value` reaching it would leak the
/// **post-render, fully-resolved** secret (see `executor.rs::render_json_value`)
/// into a persisted record any run-reader can see. This is an ordinary config
/// mistake, not an attack: `{"amount": "{{billing_token:num}}"}` where the
/// variable holds a JWT (not a number) fails the cast for every VU →
/// `AllVusFailed`. The message must carry the var name + target type (so US3
/// still tells operators *why*) but never the value.
#[tokio::test]
async fn all_vus_failed_cast_failed_cause_redacts_secret_value() {
    let secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LTEyMzQifQ.s3cr3t-signature-do-not-leak";
    let yaml = format!(
        r#"
version: 1
name: bad
variables:
  billing_token: "{secret}"
steps:
  - id: bad
    name: bad
    type: http
    request:
      method: POST
      url: "http://127.0.0.1:1/pay"
      body:
        json:
          amount: "{{{{billing_token:num}}}}"
    assert:
      - status: 200
"#
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let plan = RunPlan {
        vus: 1,
        ramp_up: std::time::Duration::from_secs(0),
        duration: Duration::from_millis(200),
        env: std::collections::BTreeMap::new(),
        loop_breakdown_cap: 0,
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
    };
    let (tx, _rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = tokio_util::sync::CancellationToken::new();

    let res = run_scenario(scenario, plan, tx, cancel).await;

    match res {
        Err(err @ EngineError::AllVusFailed { failed, total, .. }) => {
            assert_eq!(failed, 1, "expected 1 failed VU");
            assert_eq!(total, 1, "expected 1 total VU");
            let msg = err.to_string();
            assert!(
                !msg.contains(secret),
                "AllVusFailed message must NOT contain the resolved secret value, got: {msg}"
            );
            assert_eq!(
                msg, "all VUs failed (1/1): template: cannot cast {{billing_token}} to num",
                "expected the redacted var+cast (name + target type, no value) to be sampled"
            );
        }
        other => panic!("expected Err(AllVusFailed), got {other:?}"),
    }
}
