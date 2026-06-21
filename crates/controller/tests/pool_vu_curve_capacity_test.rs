//! L5 closed-loop VU-curve pool capacity-guard e2e.
//!
//! Each test boots an in-process pool-mode controller (mirroring
//! pool_capacity_guard_test.rs) and registers idle workers with explicit
//! --capacity-vus.  Tests cover the 6 acceptance cases in the L5 spec
//! (R1, R5, R6, R7, R14).
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
// Shared helpers (copied verbatim from pool_capacity_guard_test.rs)
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
        "version: 1\nname: curve-guard-test\nvariables:\n  base: \"{target_uri}\"\nsteps:\n  \
         - id: \"01HX0000000000000000000060\"\n    name: hit\n    type: http\n    request:\n      \
         method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n    assert:\n      \
         - status: 200\n"
    )
}

fn noop_scenario_yaml() -> String {
    "version: 1\nname: curve-noop\nsteps:\n  \
     - id: \"01HX0000000000000000000061\"\n    name: hit\n    type: http\n    request:\n      \
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

/// VU-curve profile JSON helper: duration_seconds=0, vu_stages from stages slice.
fn vu_curve_profile_json(stages: &[(u32, u32)]) -> Value {
    json!({
        "duration_seconds": 0,
        "vu_stages": stages.iter().map(|(t, d)| json!({"target": t, "duration_seconds": d})).collect::<Vec<_>>(),
    })
}

/// Upload a CSV dataset via multipart POST /api/datasets and return its id.
async fn upload_dataset(http: &reqwest::Client, rest_base: &str, csv: &str) -> String {
    let boundary = "X-HANDICAP-BOUNDARY-L5";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"file\"; filename=\"data.csv\"\r\nContent-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(csv.as_bytes());
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let v: Value = http
        .post(format!("{rest_base}/api/datasets"))
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["id"].as_str().unwrap().to_string()
}

// ---------------------------------------------------------------------------
// Test 1 (R5): peak > achievable → 409 + no run row
// ---------------------------------------------------------------------------
/// 2 workers cap [5, 5] (Σ=10); curve peak=50 (> achievable=10) → 409.
/// Run row must NOT be created (R5).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_vu_curve_insufficient_returns_409() {
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

    wait_idle(&coord, 2, Duration::from_secs(15), "before curve 409 test").await;

    let scenario_id = create_scenario(&http, &rest_base, &noop_scenario_yaml()).await;
    let before = run_count(&http, &rest_base, &scenario_id).await;

    // Peak 50 >> achievable 10 → should 409.
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": vu_curve_profile_json(&[(50, 5)]),
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 409,
        "curve insufficient capacity must return 409; got {http_status}: {body}"
    );
    assert_eq!(
        body["achievable_vus"].as_u64(),
        Some(10),
        "achievable_vus must be 10; got {body}"
    );
    assert_eq!(
        body["requested_vus"].as_u64(),
        Some(50),
        "requested_vus must be peak=50; got {body}"
    );

    // R5: no run row must have been created.
    let after = run_count(&http, &rest_base, &scenario_id).await;
    assert_eq!(
        before, after,
        "409 must not create a run row: before={before} after={after}"
    );

    child0.kill().ok();
    child1.kill().ok();
    let _ = child0.wait();
    let _ = child1.wait();
    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 2 (R1): peak <= achievable → capacity-aware assignment, 201
// ---------------------------------------------------------------------------
/// 2 workers cap [5, 25] (Σ=30); curve peak=28 → 201 (capacity-aware).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_vu_curve_assigns_capacity_aware() {
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

    // Worker 0: cap 5; Worker 1: cap 25 → achievable=30, peak=28 ≤ 30.
    let mut child0 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 5);
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 25);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(
        &coord,
        2,
        Duration::from_secs(15),
        "before curve cap-aware run",
    )
    .await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // Curve peak=28 ≤ achievable=30 → capacity-aware → 201.
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": vu_curve_profile_json(&[(28, 5)]),
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 201,
        "curve cap-aware run must be created (201); got {http_status}: {body}"
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
// Test 3 (R6): ?force + peak > achievable → 201, no 409
// ---------------------------------------------------------------------------
/// 2 workers cap [5, 5] (Σ=10); curve peak=50, ?force=true → 201 (guard skip).
/// Force curve fans out (even-split), NOT N=1 legacy.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_vu_curve_force_skips_guard() {
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
        "before curve force test",
    )
    .await;

    let scenario_id =
        create_scenario(&http, &rest_base, &minimal_scenario_yaml(&target.uri())).await;

    // ?force=true → guard skip → 201 even though peak=50 > achievable=10.
    let resp = http
        .post(format!("{rest_base}/api/runs?force=true"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": vu_curve_profile_json(&[(50, 3)]),
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body: Value = resp.json().await.unwrap();

    assert_eq!(
        http_status, 201,
        "?force curve must create run (201); got {http_status}: {body}"
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
// Test 4 (R5): zero idle → 400 (NOT 409)
// ---------------------------------------------------------------------------
/// Pool mode, 0 idle workers; curve → 400 (empty-pool), not 409.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_vu_curve_zero_idle_400() {
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
            "profile": vu_curve_profile_json(&[(10, 5)]),
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let http_status = resp.status();
    let body_text = resp.text().await.unwrap();

    assert_eq!(
        http_status, 400,
        "empty pool (curve) must return 400, not 409; got {http_status}: {body_text}"
    );
    assert!(
        body_text.contains("연결된 LAN 워커"),
        "400 body must contain '연결된 LAN 워커'; got: {body_text}"
    );

    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 5 (R14): unique + rows < n_pool → rejected
// ---------------------------------------------------------------------------
/// 2 workers cap [5, 25] (n_pool=2); unique dataset rows=1, curve peak=28 →
/// spawn_run Err (rows=1 < workers=2) — unique floor guard.
/// Also covers closed-fixed (same code path) with vus=28.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_unique_rows_lt_workers_rejected() {
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

    // 2 workers → n_pool=2; unique dataset must have ≥2 rows.
    let mut child0 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 5);
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 25);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(
        &coord,
        2,
        Duration::from_secs(15),
        "before unique-floor reject test",
    )
    .await;

    // Upload 1-row dataset (unique policy needs ≥ n_pool rows = 2; 1 < 2 → reject).
    let dataset_id = upload_dataset(&http, &rest_base, "email\nuser0@example.com\n").await;

    let scenario_id = create_scenario(&http, &rest_base, &noop_scenario_yaml()).await;

    // Curve run, peak=28 ≤ achievable=30 — would succeed without unique floor.
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "duration_seconds": 0,
                "vu_stages": [{"target": 28, "duration_seconds": 5}],
                "data_binding": {
                    "dataset_id": dataset_id,
                    "policy": "unique",
                    "mappings": [{"kind": "column", "var": "email", "column": "email"}]
                }
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
        "curve+unique with rows<workers must return 400; got {http_status}: {body_text}"
    );
    assert!(
        body_text.contains("행 수") || body_text.contains("rows") || body_text.contains("worker"),
        "400 body must mention rows/workers; got: {body_text}"
    );

    // Also test closed-fixed with same dataset → same floor guard.
    wait_idle(
        &coord,
        2,
        Duration::from_secs(5),
        "before closed-fixed unique-floor reject",
    )
    .await;

    let resp2 = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "vus": 28,
                "duration_seconds": 2,
                "data_binding": {
                    "dataset_id": dataset_id,
                    "policy": "unique",
                    "mappings": [{"kind": "column", "var": "email", "column": "email"}]
                }
            },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let s2 = resp2.status();
    let b2 = resp2.text().await.unwrap();
    assert_eq!(
        s2, 400,
        "closed-fixed+unique with rows<workers must also return 400; got {s2}: {b2}"
    );

    child0.kill().ok();
    child1.kill().ok();
    let _ = child0.wait();
    let _ = child1.wait();
    rest_handle.abort();
    grpc_handle.abort();
}

// ---------------------------------------------------------------------------
// Test 6 (R14 inverse): unique + rows >= n_pool → 201
// ---------------------------------------------------------------------------
/// 2 workers cap [5, 25] (n_pool=2); unique dataset rows=10 ≥ 2 → 201.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pool_unique_rows_ge_workers_ok() {
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
    let mut child1 = spawn_pool_worker_with_cap(&worker_bin, grpc_addr, 25);

    let rest_base = format!("http://{rest_addr}");
    let http = reqwest::Client::new();

    wait_idle(&coord, 2, Duration::from_secs(15), "before unique-ok test").await;

    // 10-row dataset → rows(10) ≥ n_pool(2) → passes unique floor.
    let csv = "email\n\
               u0@example.com\n\
               u1@example.com\n\
               u2@example.com\n\
               u3@example.com\n\
               u4@example.com\n\
               u5@example.com\n\
               u6@example.com\n\
               u7@example.com\n\
               u8@example.com\n\
               u9@example.com\n";
    let dataset_id = upload_dataset(&http, &rest_base, csv).await;

    let scenario_yaml = format!(
        "version: 1\nname: curve-unique-ok\nvariables:\n  base: \"{}\"\nsteps:\n  \
         - id: \"01HX0000000000000000000062\"\n    name: hit\n    type: http\n    request:\n      \
         method: GET\n      url: \"{{{{base}}}}/hit?u=${{{{email}}}}\"\n    assert:\n      \
         - status: 200\n",
        target.uri()
    );
    let scenario_id = create_scenario(&http, &rest_base, &scenario_yaml).await;

    // Curve peak=10 ≤ achievable=30; unique rows=10 ≥ n_pool=2 → 201.
    let resp = http
        .post(format!("{rest_base}/api/runs"))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "duration_seconds": 0,
                "vu_stages": [{"target": 10, "duration_seconds": 3}],
                "data_binding": {
                    "dataset_id": dataset_id,
                    "policy": "unique",
                    "mappings": [{"kind": "column", "var": "email", "column": "email"}]
                }
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
        "curve+unique rows≥workers must be 201; got {http_status}: {body}"
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
