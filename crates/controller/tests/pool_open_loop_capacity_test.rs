//! L4 open-loop capacity-guard e2e: extend the pool guard to open-loop (fixed+curve).
//!
//! Each test boots an in-process pool-mode controller (mirroring pool_capacity_guard_test.rs)
//! and registers idle workers with explicit --capacity-vus.  Tests cover the 5 acceptance
//! cases for open-loop in the L4 spec (R3, R5, R6, R11, R13).
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
// Shared helpers (mirrors pool_capacity_guard_test.rs)
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

async fn boot_pool(
    coord: CoordinatorState,
    db: store::Db,
    grpc_listener: TcpListener,
    rest_listener: TcpListener,
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
        heartbeat_interval_seconds: 10,
        stale_timeout_seconds: 30,
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

/// Spawn a pool worker with explicit --capacity-vus.
fn spawn_pool_worker_with_cap(
    worker_bin: &Path,
    grpc_addr: SocketAddr,
    capacity_vus: u32,
) -> std::process::Child {
    std::process::Command::new(worker_bin)
        .args([
            "--controller",
            &format!("http://{grpc_addr}"),
            "--capacity-vus",
            &capacity_vus.to_string(),
            // No --run-id → pool mode
        ])
        .spawn()
        .expect("worker spawn failed")
}

/// Poll coord.pool_idle_count() until >= expected or timeout.
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

fn minimal_scenario_yaml(target_uri: &str) -> String {
    format!(
        "version: 1\nname: open-loop-guard-test\nvariables:\n  base: \"{target_uri}\"\nsteps:\n  \
         - id: \"01HX0000000000000000000050\"\n    name: hit\n    type: http\n    request:\n      \
         method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n    assert:\n      \
         - status: 200\n"
    )
}

fn noop_scenario_yaml() -> String {
    "version: 1\nname: open-loop-noop\nsteps:\n  \
     - id: \"01HX0000000000000000000051\"\n    name: hit\n    type: http\n    request:\n      \
     method: GET\n      url: \"http://127.0.0.1:1/noop\"\n"
        .to_string()
}

/// GET /api/scenarios/{sid}/runs  →  array length.
async fn run_count(http: &reqwest::Client, rest_base: &str, scenario_id: &str) -> usize {
    let v: Value = http
        .get(format!("{rest_base}/api/scenarios/{scenario_id}/runs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v.as_array().map(|a| a.len()).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Test 1: open-loop insufficient → 409 + no run row (R3, R6)
// ---------------------------------------------------------------------------
/// 2 workers cap [5, 5] (Σ=10); open fixed max_in_flight=20, target_rps=40.
/// pool_worker_cap=min(20,40)=20 > achievable=10 → 409 {achievable_vus:10, requested_vus:20}.
/// Run row must NOT be created (R3).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_open_loop_insufficient_returns_409() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {worker_bin:?}");

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);

    let (rest_handle, grpc_handle) =
        boot_pool(coord.clone(), db.clone(), grpc_listener, rest_listener).await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut child0 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 5);
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 5);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(
        &coord,
        2,
        Duration::from_secs(15),
        "before open-loop 409 test",
    )
    .await;

    let scenario_id = create_scenario(&http, &rest_base, &noop_scenario_yaml()).await;

    let before = run_count(&http, &rest_base, &scenario_id).await;

    // Open-loop: omit vus; max_in_flight=20, target_rps=40 → pool_worker_cap=min(20,40)=20
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "duration_seconds": 2,
                "target_rps": 40,
                "max_in_flight": 20
            },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 409,
        "open-loop insufficient must return 409; got {http_status}: {body}"
    );
    assert_eq!(
        body["achievable_vus"].as_u64(),
        Some(10),
        "achievable_vus must be 10; got {body}"
    );
    assert_eq!(
        body["requested_vus"].as_u64(),
        Some(20),
        "requested_vus must be max_in_flight=20; got {body}"
    );

    // R3: no run row must have been created.
    let after = run_count(&http, &rest_base, &scenario_id).await;
    assert_eq!(
        before, after,
        "409 must not create a run row (R3): before={before} after={after}"
    );

    child0.kill().ok();
    child1.kill().ok();
    let _ = child0.wait();
    let _ = child1.wait();
    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 2: open-loop zero idle → 400 (NOT 409)
// ---------------------------------------------------------------------------
/// Pool mode, 0 idle workers; open-loop max_in_flight=20.
/// Must get existing 400 (empty-pool) not 409.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_open_loop_zero_idle_400() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, _grpc_addr) = bind_local().await;

    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);

    let (rest_handle, grpc_handle) =
        boot_pool(coord.clone(), db.clone(), grpc_listener, rest_listener).await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    let scenario_id = create_scenario(&http, &rest_base, &noop_scenario_yaml()).await;

    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "duration_seconds": 2,
                "target_rps": 40,
                "max_in_flight": 20
            },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body_text = resp.text().await.unwrap();

    assert_eq!(
        http_status, 400,
        "empty pool must return 400 (not 409) for open-loop; got {http_status}: {body_text}"
    );
    assert!(
        body_text.contains("연결된 LAN 워커"),
        "400 body must contain '연결된 LAN 워커'; got: {body_text}"
    );

    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 3: open-loop ?force → 201 (guard skip, R11)
// ---------------------------------------------------------------------------
/// 2 workers cap [5, 5]; open-loop max_in_flight=20, target_rps=40, ?force=true.
/// Guard is skipped; run created 201 via legacy even-split (R11).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_open_loop_force_skips_guard() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {worker_bin:?}");

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

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);

    let (rest_handle, grpc_handle) =
        boot_pool(coord.clone(), db.clone(), grpc_listener, rest_listener).await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut child0 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 5);
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 5);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(
        &coord,
        2,
        Duration::from_secs(15),
        "before open-loop force test",
    )
    .await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // ?force=true → guard skipped → 201
    let resp = http
        .post(format!("{rest_base}/api/runs?force=true"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "duration_seconds": 2,
                "target_rps": 40,
                "max_in_flight": 20
            },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 201,
        "open-loop ?force=true must create the run (201); got {http_status}: {body}"
    );
    assert!(
        body["id"].is_string(),
        "response must have run id; got {body}"
    );

    child0.kill().ok();
    child1.kill().ok();
    let _ = child0.wait();
    let _ = child1.wait();
    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 4: open-loop capacity-aware assignment → 201 + run completes (R5, R13)
// ---------------------------------------------------------------------------
/// 2 workers cap [5, 25]; open-loop max_in_flight=8, target_rps=16.
/// pool_worker_cap=min(8,16)=8 <= achievable=30 → 201.
/// Per-worker slot/rate split verified by inline unit tests; e2e only checks aggregate.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_open_loop_assigns_capacity_aware() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {worker_bin:?}");

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

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);

    let (rest_handle, grpc_handle) =
        boot_pool(coord.clone(), db.clone(), grpc_listener, rest_listener).await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    // cap [5, 25]: the lower-cap worker gets the smaller slot/rate share.
    let mut child0 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 5);
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 25);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(
        &coord,
        2,
        Duration::from_secs(15),
        "before open-loop capacity-aware run",
    )
    .await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // max_in_flight=8, target_rps=16 → pool_worker_cap=8 ≤ achievable=30 → 201
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "duration_seconds": 3,
                "target_rps": 16,
                "max_in_flight": 8
            },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 201,
        "open-loop capacity-aware run must be created (201); got {http_status}: {body}"
    );
    assert!(
        body["id"].is_string(),
        "response must have run id; got {body}"
    );
    let run_id = body["id"].as_str().unwrap().to_string();

    // Wait for run to complete (up to 30s)
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let report = loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let r: Value = http
            .get(format!("{rest_base}/api/runs/{run_id}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let status = r["status"].as_str().unwrap_or("");
        if status == "completed" || status == "failed" {
            break r;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("run did not complete within 30s; last status={status}");
        }
    };

    assert_eq!(
        report["status"].as_str(),
        Some("completed"),
        "run must complete; got {report}"
    );

    child0.kill().ok();
    child1.kill().ok();
    let _ = child0.wait();
    let _ = child1.wait();
    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 5: open-loop min1 prevents zero-rate worker (R13)
// ---------------------------------------------------------------------------
/// 2 workers cap [2, 8]; open-loop max_in_flight=10, target_rps=3 (low rate).
/// Without min1: proportional_split(3,[2,8])=[1,2] — both ≥1. This test verifies
/// 201 and run completes (the min1 correctness is locked in unit tests).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_open_loop_no_zero_rate_fixed_aggregate() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {worker_bin:?}");

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

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);

    let (rest_handle, grpc_handle) =
        boot_pool(coord.clone(), db.clone(), grpc_listener, rest_listener).await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut child0 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 2);
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 8);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(
        &coord,
        2,
        Duration::from_secs(15),
        "before min1 open-loop run",
    )
    .await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // pool_worker_cap=min(10,3)=3 ≤ achievable=10 → 201
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "duration_seconds": 3,
                "target_rps": 3,
                "max_in_flight": 10
            },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 201,
        "low-rate open-loop run must be created (201); got {http_status}: {body}"
    );
    assert!(
        body["id"].is_string(),
        "response must have run id; got {body}"
    );

    child0.kill().ok();
    child1.kill().ok();
    let _ = child0.wait();
    let _ = child1.wait();
    rest_handle.abort();
    grpc_handle.abort();
}
