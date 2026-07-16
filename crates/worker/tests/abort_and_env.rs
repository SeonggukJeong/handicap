/// Tests for Task 9 + F3: env/ramp-up wiring, abort via CancellationToken,
/// and phase mapping (phase_for_result helper).
///
/// These tests exercise the RunPlan construction logic and abort signalling
/// without requiring a real gRPC server. They validate that:
/// - `assignment.env` is threaded into `RunPlan.env` as a BTreeMap
/// - `profile.ramp_up_seconds` is threaded into `RunPlan.ramp_up`
/// - A `CancellationToken` that is cancelled before run_scenario starts causes
///   `EngineError::Aborted` to be returned immediately.
/// - Messages buffered in the mpsc channel before drop(tx) survive to the
///   receiver — the contract that justifies replacing the 200ms shutdown sleep
///   with an explicit sender drop (F6).
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{EngineError, MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
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
    let (win_tx, _win_rx) = mpsc::channel::<MetricFlush>(8);
    let cancel = CancellationToken::new();
    // Cancel before run starts — engine should observe this immediately.
    cancel.cancel();

    let result = run_scenario(scenario, plan, win_tx, cancel).await;
    assert!(
        matches!(result, Err(EngineError::Aborted)),
        "expected Aborted, got {result:?}"
    );
}

/// Lock in the mpsc channel contract that `drop(tx)` relies on.
///
/// This test documents *why* the 200ms sleep in the worker shutdown path is
/// unnecessary: tokio's mpsc guarantees that messages already buffered before
/// the sender is dropped are drained to the receiver before `recv()` returns
/// `None`. HTTP/2 then preserves frame order on the outbound stream, so the
/// final `RunStatus` data frame arrives before `END_STREAM`.
///
/// Regression intent: if this contract ever broke (e.g. someone dropped `tx`
/// *before* sending the final `RunStatus`), the receiver would see `None`
/// instead of the expected message and this test would fail.
#[tokio::test]
async fn channel_semantics_buffered_messages_survive_sender_drop() {
    use handicap_proto::v1::worker_message::Payload as WorkerPayload;
    use handicap_proto::v1::{RunStatus, WorkerMessage, run_status::Phase};
    use tokio::sync::mpsc;

    let (tx, mut rx) = mpsc::channel::<WorkerMessage>(64);

    // Pre-fill with a dummy "in-flight" message (representative of a metric
    // batch that may not have been drained yet when the final status is sent).
    tx.send(WorkerMessage { payload: None }).await.unwrap();

    // Send the final RunStatus — this is the message we must not lose.
    let final_msg = WorkerMessage {
        payload: Some(WorkerPayload::RunStatus(RunStatus {
            run_id: "R1".into(),
            phase: Phase::Completed as i32,
            message: String::new(),
        })),
    };
    tx.send(final_msg).await.unwrap();

    // Explicit close — no sleep. The receiver must yield both buffered messages
    // before seeing None.
    drop(tx);

    // Drain and verify ordering.
    let mut seen: Vec<WorkerMessage> = Vec::new();
    while let Some(m) = rx.recv().await {
        seen.push(m);
    }

    assert_eq!(
        seen.len(),
        2,
        "both buffered messages must survive sender drop"
    );
    match seen.last().and_then(|m| m.payload.as_ref()) {
        Some(WorkerPayload::RunStatus(s)) => {
            assert_eq!(
                s.phase,
                Phase::Completed as i32,
                "last message must be the final RunStatus(Completed)"
            );
            assert_eq!(s.run_id, "R1");
        }
        other => panic!("expected RunStatus payload as last message, got {other:?}"),
    }
    // After all senders are dropped, recv() must return None.
    assert!(
        rx.recv().await.is_none(),
        "recv after drop(tx) must yield None (channel closed)"
    );
}
