//! `SubprocessDispatcher` behavior tests.
//!
//! The earlier version used `/bin/sh` as a fake worker with a comment claiming
//! sh "happily ignores the args and exits 0" — that was false (`/bin/sh
//! --controller …` prints `--controller: invalid option` to stderr and exits
//! non-zero), and the test passed only because `dispatch` does not inspect the
//! child's exit status. We now use the `true` binary, which ignores its args and
//! exits 0 with no output, and add a test proving that a *spawn* failure IS
//! surfaced as `Err` (the path `api::runs::create` relies on for fail-fast —
//! codex eval item 2/3). A third test covers the followups "open item A" reaper:
//! a worker that spawns but exits non-zero before completing fails its run.
#![cfg(unix)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use handicap_controller::dispatcher::{WorkerDispatcher, subprocess::SubprocessDispatcher};
use handicap_controller::store::{self, Db, runs};

fn addr() -> SocketAddr {
    "127.0.0.1:65535".parse().unwrap()
}

/// Path to a `true` binary: ignores all (non --help/--version) args and exits 0
/// with no stdout/stderr. A persistent stand-in for the worker binary — unlike a
/// temp fixture it can't be deleted out from under the spawned children.
fn exit_zero_worker() -> String {
    first_existing(&["/usr/bin/true", "/bin/true"], "true")
}

/// Path to a `false` binary: ignores its args and exits 1 — stands in for a
/// worker that spawns successfully but dies non-zero before completing the run
/// (e.g. a stale binary that can't parse a new step type).
fn exit_one_worker() -> String {
    first_existing(&["/usr/bin/false", "/bin/false"], "false")
}

fn first_existing(paths: &[&str], name: &str) -> String {
    paths
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or_else(|| panic!("no `{name}` binary at {paths:?}"))
        .to_string()
}

/// Seed one `pending` run (scenario FK satisfied) and return its id.
async fn seed_pending_run(db: &Db) -> String {
    use handicap_engine::Scenario;
    let yaml = "version: 1\nname: test\nsteps: []";
    let scenario: Scenario = serde_yaml::from_str(yaml).unwrap();
    let sc = store::scenarios::insert(db, &scenario, yaml).await.unwrap();
    let profile = runs::Profile {
        vus: 1,
        ramp_up_seconds: 0,
        duration_seconds: 1,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        data_binding: None,
        data_bindings: vec![],
        criteria: None,
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: None,
        graceful_ramp_down_seconds: None,
        worker_count: None,
        apply_scenario_think_time: true,
    };
    runs::insert(db, &sc.id, yaml, &profile, &serde_json::json!({}))
        .await
        .unwrap()
        .id
}

/// Poll the run's status until it leaves `pending`/`running` or `timeout` elapses.
async fn await_terminal(db: &Db, run_id: &str, timeout: Duration) -> runs::RunStatus {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let status = runs::get(db, run_id).await.unwrap().unwrap().status;
        let active = matches!(status, runs::RunStatus::Pending | runs::RunStatus::Running);
        if !active || std::time::Instant::now() >= deadline {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn dispatch_spawns_children_that_exit_zero() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let dispatcher = SubprocessDispatcher::new(exit_zero_worker(), addr(), db);
    let dispatcher: Arc<dyn WorkerDispatcher> = Arc::new(dispatcher);
    // worker_count=2 → the dispatcher loops and spawns two children, each given
    // a distinct internally-generated --worker-id; both exit 0 (args ignored).
    dispatcher.dispatch("run-1", 2).await.expect("dispatch");
    dispatcher.cleanup("run-1").await.expect("cleanup");
}

#[tokio::test]
async fn dispatch_surfaces_spawn_failure() {
    // A missing worker binary must fail the dispatch (not silently succeed) so
    // the run-create handler can mark the run failed and return a 5xx.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let dispatcher = SubprocessDispatcher::new(
        "/nonexistent/handicap-worker-binary".to_string(),
        addr(),
        db,
    );
    let dispatcher: Arc<dyn WorkerDispatcher> = Arc::new(dispatcher);
    let result = dispatcher.dispatch("run-1", 1).await;
    assert!(
        result.is_err(),
        "spawning a missing binary must surface an error, got Ok"
    );
}

#[tokio::test]
async fn worker_nonzero_exit_marks_run_failed() {
    // Reproduction of followups "open item A": a worker that spawns fine
    // (`dispatch` returns Ok) but dies non-zero before reporting a terminal phase
    // must leave the run `failed` immediately — not hang `pending`/`running`
    // until the 60s registration watchdog. `/usr/bin/false` exits 1 without ever
    // registering, so only the subprocess reaper can fail the run.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_pending_run(&db).await;
    let dispatcher = SubprocessDispatcher::new(exit_one_worker(), addr(), db.clone());
    dispatcher.dispatch(&run_id, 1).await.expect("dispatch ok");

    let status = await_terminal(&db, &run_id, Duration::from_secs(5)).await;
    assert_eq!(
        status,
        runs::RunStatus::Failed,
        "a worker that exits non-zero before completing must fail its run"
    );
    let row = runs::get(&db, &run_id).await.unwrap().unwrap();
    assert!(
        row.message.is_some_and(|m| m.contains("exited")),
        "the failure must record the worker exit as its cause"
    );
}
