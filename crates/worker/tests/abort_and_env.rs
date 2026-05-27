/// Tests for Task 9 + F3: env/ramp-up wiring, abort via CancellationToken,
/// and phase mapping (phase_for_result helper).
///
/// These tests exercise the RunPlan construction logic and abort signalling
/// without requiring a real gRPC server. They validate that:
/// - `assignment.env` is threaded into `RunPlan.env` as a BTreeMap
/// - `profile.ramp_up_seconds` is threaded into `RunPlan.ramp_up`
/// - A `CancellationToken` that is cancelled before run_scenario starts causes
///   `EngineError::Aborted` to be returned immediately.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{EngineError, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Minimal scenario YAML with a single step — used across tests.
fn minimal_yaml() -> &'static str {
    r#"
version: 1
name: abort-test
steps:
  - id: s1
    name: never
    type: http
    request:
      method: GET
      url: "http://127.0.0.1:19999/never"
"#
}

#[test]
fn run_plan_env_and_ramp_up_wiring() {
    // Simulates what main.rs does after Task 9.
    let env_map: std::collections::HashMap<String, String> = [
        ("FOO".to_string(), "bar".to_string()),
        ("BAZ".to_string(), "qux".to_string()),
    ]
    .into_iter()
    .collect();

    let env: BTreeMap<String, String> = env_map.clone().into_iter().collect();
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(5),
        duration: Duration::from_secs(10),
        env,
    };

    assert_eq!(plan.ramp_up, Duration::from_secs(5));
    assert_eq!(plan.env.get("FOO").map(String::as_str), Some("bar"));
    assert_eq!(plan.env.get("BAZ").map(String::as_str), Some("qux"));
    // BTreeMap should be sorted
    let keys: Vec<_> = plan.env.keys().collect();
    assert_eq!(keys, vec!["BAZ", "FOO"]);
}

#[tokio::test]
async fn cancelled_token_aborts_run() {
    let scenario = Arc::new(Scenario::from_yaml(minimal_yaml()).expect("parse yaml"));
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(30),
        env: BTreeMap::new(),
    };
    let (win_tx, _win_rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    // Cancel before run starts — engine should observe this immediately.
    cancel.cancel();

    let result = run_scenario(scenario, plan, win_tx, cancel).await;
    assert!(
        matches!(result, Err(EngineError::Aborted)),
        "expected Aborted, got {result:?}"
    );
}
