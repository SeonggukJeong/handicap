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
