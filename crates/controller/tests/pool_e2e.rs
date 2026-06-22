//! LAN pool-mode e2e: always-on worker pool — a single pool worker completes
//! two sequential runs (reconnect-per-run), proving R1 (end-to-end) and R9
//! (metrics merged per run).  A second test exercises the token-mismatch
//! rejection branch (R3/§3.6): wrong token → worker never joins pool → 400
//! "연결된 LAN 워커" on POST /api/runs.
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use handicap_controller::dispatcher::NoopDispatcher;
use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
use handicap_controller::{app, store};
use handicap_proto::v1::coordinator_server::CoordinatorServer;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------------------------------------------------------------------------
// Helpers (copied + adapted from multi_worker_fanout_e2e.rs)
// ---------------------------------------------------------------------------

async fn worker_bin_path() -> PathBuf {
    let cargo = env!("CARGO");
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    tokio::task::spawn_blocking(move || {
        let status = std::process::Command::new(cargo)
            .args(["build", "-p", "handicap-worker"])
            .status()
            .expect("cargo build -p handicap-worker");
        assert!(status.success(), "worker build failed");
    })
    .await
    .expect("spawn_blocking for worker build panicked");
    if let Ok(p) = std::env::var("CARGO_BIN_EXE_worker") {
        return PathBuf::from(p);
    }
    PathBuf::from(manifest_dir)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("target/debug/worker")
}

async fn bind_local() -> (TcpListener, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, addr)
}

/// Boot an in-process pool-mode controller.
/// Uses `NoopDispatcher` (the test spawns the worker itself).
/// `coord.set_pool_mode(true)` and `coord.set_worker_token(token)` must be called
/// BEFORE this function is called so the OnceLocks are set.
async fn boot_pool(
    coord: CoordinatorState,
    db: store::Db,
    grpc_listener: TcpListener,
    rest_listener: TcpListener,
    _grpc_addr: SocketAddr, // unused in pool-mode boot; kept for symmetry
) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[("worker_capacity_vus", 2000i64)],
        ),
        scheduler_tz: chrono_tz::UTC,
    });
    let rest_handle = tokio::spawn(async move {
        axum::serve(rest_listener, app).await.unwrap();
    });
    let grpc_handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(CoordinatorServer::new(CoordinatorService { state: coord }))
            .serve_with_incoming(TcpListenerStream::new(grpc_listener))
            .await
            .unwrap();
    });
    (rest_handle, grpc_handle)
}

/// Spawn a real pool worker subprocess. Returns the `Child` handle for
/// survival checks and cleanup.
fn spawn_pool_worker(worker_bin: &Path, grpc_addr: SocketAddr, token: &str) -> std::process::Child {
    std::process::Command::new(worker_bin)
        .args([
            "--controller",
            &format!("http://{grpc_addr}"),
            "--token",
            token,
        ])
        // No --run-id → pool mode
        .spawn()
        .expect("worker spawn failed")
}

/// Poll `coord.pool_idle_count()` until it reaches `expected` or timeout.
async fn wait_idle(coord: &CoordinatorState, expected: usize, timeout: Duration, label: &str) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if coord.pool_idle_count().await >= expected {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "{label}: timed out waiting for pool_idle_count >= {expected} \
                 (current = {})",
                coord.pool_idle_count().await
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// POST /api/scenarios and return the scenario id.
async fn create_scenario(http: &reqwest::Client, rest_base: &str, yaml: &str) -> String {
    let v: Value = http
        .post(format!("{rest_base}/api/scenarios"))
        .json(&json!({ "yaml": yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["id"].as_str().unwrap().to_string()
}

/// POST /api/runs with closed-loop profile and return the run id.
async fn create_run(
    http: &reqwest::Client,
    rest_base: &str,
    scenario_id: &str,
    vus: u32,
    duration_seconds: u32,
) -> String {
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": vus, "duration_seconds": duration_seconds },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let status = resp.status();
    let body: Value = resp.json().await.unwrap();
    assert!(
        status.is_success(),
        "POST /api/runs failed {status}: {body}"
    );
    body["id"].as_str().unwrap().to_string()
}

/// Poll GET /api/runs/{id} until a terminal status is reached, return it.
async fn poll_to_terminal(http: &reqwest::Client, rest_base: &str, run_id: &str) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut last = String::new();
    while tokio::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{rest_base}/api/runs/{run_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last = v["status"].as_str().unwrap_or("").to_string();
        if last == "completed" || last == "failed" || last == "aborted" {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("run {run_id} did not reach terminal within 60s; last={last}");
}

// ---------------------------------------------------------------------------
// Test 1: pool_worker_runs_then_reuses
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_worker_runs_then_reuses() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {worker_bin:?}");

    // Wiremock target: a /hit endpoint with a small delay so p50_ms > 0.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(5)),
        )
        .mount(&target)
        .await;

    // Bind REST and gRPC on random ports.
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // Build the in-process controller in pool mode with a shared token.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);
    coord.set_worker_token(Some("SECRET".into()));

    let (rest_handle, grpc_handle) = boot_pool(
        coord.clone(),
        db.clone(),
        grpc_listener,
        rest_listener,
        grpc_addr,
    )
    .await;

    // Give the servers a moment to be ready.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Spawn the pool worker with the correct token (no --run-id).
    let mut child = spawn_pool_worker(&worker_bin, grpc_addr, "SECRET");

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    // ---- Scenario ----
    let scenario_yaml = format!(
        "version: 1\nname: pool-reuse\nvariables:\n  base: \"{}\"\nsteps:\n  \
         - id: \"01HX0000000000000000000030\"\n    name: hit\n    type: http\n    request:\n      \
         method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n    assert:\n      \
         - status: 200\n",
        target.uri()
    );
    let scenario_id = create_scenario(&http, &rest_base, &scenario_yaml).await;

    // ---- Run #1 ----
    // Wait for the worker to register idle before launching the run.
    wait_idle(&coord, 1, Duration::from_secs(15), "before run #1").await;

    let run1_id = create_run(&http, &rest_base, &scenario_id, 1, 2).await;
    let status1 = poll_to_terminal(&http, &rest_base, &run1_id).await;
    assert_eq!(status1, "completed", "run #1 must complete; got {status1}");

    // Check that the report has requests > 0 (worker actually did work).
    let report1: Value = http
        .get(format!("{rest_base}/api/runs/{run1_id}/report"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let count1 = report1["summary"]["count"].as_u64().unwrap_or(0);
    assert!(
        count1 >= 10,
        "run #1 report count must be >= 10; got {count1}"
    );

    // Assert the worker child is still alive (not exited between runs).
    let worker_exited = child.try_wait().expect("try_wait failed");
    assert!(
        worker_exited.is_none(),
        "pool worker must stay alive between run #1 and run #2; it exited: {worker_exited:?}"
    );

    // ---- Run #2 ----
    // The worker disconnects after run #1 completes (reconnect-per-run).
    // Wait for it to re-register idle before launching run #2.
    wait_idle(&coord, 1, Duration::from_secs(15), "before run #2").await;

    let run2_id = create_run(&http, &rest_base, &scenario_id, 1, 2).await;
    let status2 = poll_to_terminal(&http, &rest_base, &run2_id).await;
    assert_eq!(status2, "completed", "run #2 must complete; got {status2}");

    let report2: Value = http
        .get(format!("{rest_base}/api/runs/{run2_id}/report"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let count2 = report2["summary"]["count"].as_u64().unwrap_or(0);
    assert!(
        count2 >= 10,
        "run #2 report count must be >= 10; got {count2}"
    );

    // Both run IDs must be different (two distinct runs).
    assert_ne!(run1_id, run2_id, "run #1 and run #2 must have distinct IDs");

    // The worker is still alive after run #2 as well.
    let worker_exited_after2 = child.try_wait().expect("try_wait failed");
    assert!(
        worker_exited_after2.is_none(),
        "pool worker must stay alive after run #2; it exited: {worker_exited_after2:?}"
    );

    // ---- Cleanup ----
    child.kill().ok();
    let _ = child.wait();
    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 2: pool_wrong_token_rejected_and_run_returns_400
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_wrong_token_rejected_and_run_returns_400() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {worker_bin:?}");

    // Bind REST and gRPC on random ports.
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // Build the in-process controller in pool mode, token = "SECRET".
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);
    coord.set_worker_token(Some("SECRET".into()));

    let (rest_handle, grpc_handle) = boot_pool(
        coord.clone(),
        db.clone(),
        grpc_listener,
        rest_listener,
        grpc_addr,
    )
    .await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    // Spawn a worker with the WRONG token — it should be rejected and never join the pool.
    let mut child = spawn_pool_worker(&worker_bin, grpc_addr, "WRONG");

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    // Window-poll over ~3 s: assert BOTH (a) the worker process is still alive
    // (it is genuinely attempting + retrying via backoff, not absent/crashed) AND
    // (b) pool_idle_count stays 0 — the wrong-token worker is rejected on every
    // attempt and never joins, not even transiently.
    //
    // A blind single sleep+check would not prove rejection: on a slow box the 400
    // could fire BEFORE the worker even attempted to connect, so the pool would be
    // empty for a benign reason.  Sampling across the window while confirming the
    // worker is alive means: localhost connect+reject+backoff-retries happen within
    // the window, so the worker provably attempted and was rejected (per the
    // AbortRun-before-register ordering in the controller).
    let window_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < window_deadline {
        let still_up = child.try_wait().expect("try_wait failed").is_none();
        assert!(
            still_up,
            "wrong-token worker process must remain alive (retrying) during the window"
        );
        let idle = coord.pool_idle_count().await;
        assert_eq!(
            idle, 0,
            "wrong-token worker must not join the pool even transiently; idle = {idle}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Create a minimal scenario to drive POST /api/runs.
    let scenario_yaml = "version: 1\nname: auth-test\nsteps:\n  \
         - id: \"01HX0000000000000000000031\"\n    name: hit\n    type: http\n    request:\n      \
         method: GET\n      url: \"http://127.0.0.1:1/noop\"\n";
    let scenario_id = create_scenario(&http, &rest_base, scenario_yaml).await;

    // POST /api/runs must fail fast with 400 "연결된 LAN 워커" (empty pool).
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 1, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body_text = resp.text().await.unwrap();
    assert_eq!(
        http_status, 400,
        "empty-pool POST /api/runs must return 400; got {http_status}: {body_text}"
    );
    assert!(
        body_text.contains("연결된 LAN 워커"),
        "400 body must contain '연결된 LAN 워커'; got: {body_text}"
    );

    // ---- Cleanup ----
    child.kill().ok();
    let _ = child.wait();
    rest_handle.abort();
    grpc_handle.abort();
}
