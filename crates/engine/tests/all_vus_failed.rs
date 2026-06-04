//! When every VU fails during a run (e.g., scenario references an undefined
//! template variable), `run_scenario` must surface this as `Err`, not silently
//! return `Ok(())` — otherwise the worker reports `RunStatus::Completed` for a
//! run that produced zero metrics, hiding the failure from operators.

use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{EngineError, MetricFlush, RunPlan, Scenario, run_scenario};
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
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
    };
    let (tx, _rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = tokio_util::sync::CancellationToken::new();

    let res = run_scenario(scenario, plan, tx, cancel).await;

    match res {
        Err(EngineError::AllVusFailed { failed, total }) => {
            assert_eq!(failed, 3, "expected 3 failed VUs");
            assert_eq!(total, 3, "expected 3 total VUs");
        }
        other => panic!("expected Err(AllVusFailed), got {other:?}"),
    }
}
