//! L3 capacity-guard e2e: pre-insert 409 + ?force + mode fork.
//!
//! Each test boots an in-process pool-mode controller (mirroring pool_e2e.rs)
//! and registers idle workers with explicit --capacity-vus so the guard fires at
//! predictable thresholds.  Tests cover the 6 acceptance cases in the L3 spec.
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
// Shared helpers (minimal copy from pool_e2e.rs + capacity-vus extension)
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

/// Spawn a pool worker with optional --capacity-vus override.
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
        "version: 1\nname: cap-guard-test\nvariables:\n  base: \"{target_uri}\"\nsteps:\n  \
         - id: \"01HX0000000000000000000040\"\n    name: hit\n    type: http\n    request:\n      \
         method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n    assert:\n      \
         - status: 200\n"
    )
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
// Test 1: capacity-aware assignment (water-fill)
// ---------------------------------------------------------------------------
/// Two workers cap [5, 1000]; closed-loop vus=30.
/// The capacity path should fire: water-fill assigns ≤5 to the cap-5 worker
/// and the rest to the cap-1000 worker.  Run created (201).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_assigns_capacity_aware() {
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

    // Worker 0: cap 5; Worker 1: cap 1000.
    let mut child0 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 5);
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 1000);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(&coord, 2, Duration::from_secs(15), "before cap-aware run").await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // POST /api/runs  closed-loop vus=30 (cap-5 worker gets ≤5, cap-1000 gets 25)
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 30, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let status = resp.status();
    let body: Value = resp.json().await.unwrap();
    assert_eq!(
        status, 201,
        "capacity-aware run must be created (201); got {status}: {body}"
    );
    assert!(
        body["id"].is_string(),
        "response must have run id; got {body}"
    );

    // Cleanup
    child0.kill().ok();
    child1.kill().ok();
    let _ = child0.wait();
    let _ = child1.wait();
    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 2: insufficient capacity → 409 + no run row (R3)
// ---------------------------------------------------------------------------
/// 2 workers cap 5 each (Σ=10); vus=20, no force.
/// Must get 409 {"achievable_vus":10,"requested_vus":20} and no run row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_insufficient_capacity_returns_409() {
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

    wait_idle(&coord, 2, Duration::from_secs(15), "before 409 test").await;

    let scenario_id = create_scenario(
        &http,
        &rest_base,
        "version: 1\nname: guard-test\nsteps:\n  \
         - id: \"01HX0000000000000000000041\"\n    name: hit\n    type: http\n    request:\n      \
         method: GET\n      url: \"http://127.0.0.1:1/noop\"\n",
    )
    .await;

    // Row count BEFORE the 409 request.
    let before = run_count(&http, &rest_base, &scenario_id).await;

    // POST vus=20 — should 409.
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 20, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 409,
        "insufficient capacity must return 409; got {http_status}: {body}"
    );
    assert_eq!(
        body["achievable_vus"].as_u64(),
        Some(10),
        "achievable_vus must be 10; got {body}"
    );
    assert_eq!(
        body["requested_vus"].as_u64(),
        Some(20),
        "requested_vus must be 20; got {body}"
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
// Test 3: zero idle workers → 400 (NOT 409)
// ---------------------------------------------------------------------------
/// Pool mode, 0 idle workers; vus=10, no force.
/// Must get 400 "연결된 LAN 워커" (the existing empty-pool error), not 409.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_zero_idle_returns_400() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;
    let _ = grpc_addr; // unused: no workers will connect

    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);

    let (rest_handle, grpc_handle) =
        boot_pool(coord.clone(), db.clone(), grpc_listener, rest_listener).await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    let scenario_id = create_scenario(
        &http,
        &rest_base,
        "version: 1\nname: empty-pool-test\nsteps:\n  \
         - id: \"01HX0000000000000000000042\"\n    name: hit\n    type: http\n    request:\n      \
         method: GET\n      url: \"http://127.0.0.1:1/noop\"\n",
    )
    .await;

    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 10, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body_text = resp.text().await.unwrap();

    assert_eq!(
        http_status, 400,
        "empty pool must return 400 (not 409); got {http_status}: {body_text}"
    );
    assert!(
        body_text.contains("연결된 LAN 워커"),
        "400 body must contain '연결된 LAN 워커'; got: {body_text}"
    );

    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 4: ?force=true → 201, even split (byte-identical L1)
// ---------------------------------------------------------------------------
/// 2 workers cap 5 each; vus=20, ?force=true.
/// Guard is skipped; run created 201 via legacy even-split.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_force_skips_guard() {
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

    wait_idle(&coord, 2, Duration::from_secs(15), "before force test").await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // POST vus=20 ?force=true — guard must be skipped → 201.
    let resp = http
        .post(format!("{rest_base}/api/runs?force=true"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 20, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 201,
        "?force=true must create the run (201); got {http_status}: {body}"
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
// Test 5: clamp-resubmit (409 then vus=achievable → 201)
// ---------------------------------------------------------------------------
/// First POST vus=20 → 409 achievable=10.  Re-POST vus=10 → 201.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_clamp_resubmit_succeeds() {
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

    wait_idle(&coord, 2, Duration::from_secs(15), "before clamp test").await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // First attempt: vus=20 → 409.
    let resp1 = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 20, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let s1 = resp1.status();
    let b1: Value = resp1.json().await.unwrap();
    assert_eq!(s1, 409, "first attempt must return 409; got {s1}: {b1}");
    let achievable = b1["achievable_vus"].as_u64().unwrap();
    assert_eq!(achievable, 10, "achievable_vus must be 10; got {b1}");

    // Workers are still idle (409 released them or they weren't reserved).
    // Wait for idle to be restored (the 409 fires before DB insert, no reservation).
    wait_idle(
        &coord,
        2,
        Duration::from_secs(5),
        "after 409 — workers must stay idle",
    )
    .await;

    // Re-POST with vus=achievable → 201.
    let resp2 = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": achievable, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let s2 = resp2.status();
    let b2: Value = resp2.json().await.unwrap();
    assert_eq!(
        s2, 201,
        "resubmit at achievable vus must return 201; got {s2}: {b2}"
    );
    assert!(b2["id"].is_string(), "response must have run id; got {b2}");

    child0.kill().ok();
    child1.kill().ok();
    let _ = child0.wait();
    let _ = child1.wait();
    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 6: default cap (1000) — guard does NOT fire, even split (byte-identical L1)
// ---------------------------------------------------------------------------
/// 2 idle workers default cap 1000; vus=8 → guard does not fire → even split.
/// Run created 201 (precheck: idle=2, achievable=2000 >= 8, no 409).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_default_capacity_byte_identical() {
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

    // Default cap 1000 each.
    let mut child0 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 1000);
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 1000);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(&coord, 2, Duration::from_secs(15), "before default-cap run").await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // vus=8 << total_cap=2000 → guard should NOT fire (no 409).
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 8, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 201,
        "default-cap run must be created (201), no guard; got {http_status}: {body}"
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
