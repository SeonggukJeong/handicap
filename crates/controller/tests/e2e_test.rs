use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
use handicap_controller::{app, store};
use handicap_proto::v1::coordinator_server::CoordinatorServer;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Build the worker binary once (off the async runtime to avoid blocking a
/// tokio worker thread during a potentially cold build), then return the path.
///
/// Fix for followups-after-mvp1 #2: the previous inline
/// `std::process::Command::new(env!("CARGO"))...status()` was synchronous and
/// blocked the runtime for the full build duration.
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

    // CARGO_BIN_EXE_<name> is set for bins of crates listed in [dev-dependencies]
    // OR when running via `cargo test -p ... --test e2e_test` and `worker` is a
    // workspace member.  Fall back to target/debug/worker for robustness.
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

/// Bind to an OS-assigned port and return the live listener.
///
/// Fix for followups-after-mvp1 #1: the previous `pick_addr()` helper bound,
/// read the local addr, dropped the listener, and returned the SocketAddr —
/// leaving a TOCTOU window where another process could steal the port before
/// the caller re-bound it.  Now the caller holds the live socket from the
/// start and passes it directly to the server (axum::serve / tonic
/// serve_with_incoming), so the port is never released.
async fn bind_local() -> (TcpListener, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, addr)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_slice_1_e2e() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (followup #2).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let ui_dir = tempfile::tempdir().unwrap();
    std::fs::write(
        ui_dir.path().join("index.html"),
        "<!doctype html><html><body><div id=\"root\">slice2-marker</div></body></html>",
    )
    .unwrap();

    // 1. Mock target.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC (followup #1 — no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Spin up controller in-process.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: Some(ui_dir.path().to_path_buf()),
        dataset_max_rows: 1_000_000,
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

    // give servers a moment to start
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. Create scenario pointing at the wiremock URL.
    let scenario_yaml = format!(
        "version: 1\nname: e2e\nvariables:\n  base: \"{}\"\nsteps:\n  - id: root\n    name: GET /\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/\"\n    assert:\n      - status: 200\n",
        target.uri()
    );
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create a run (2 VUs, 2s duration).
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 2, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until completed (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap().to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status}"
    );

    // 7. Metrics endpoint returns at least one window with non-zero count.
    let metrics: Value = http
        .get(format!("{}/api/runs/{}/metrics", rest_base, run_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let windows = metrics["windows"].as_array().expect("windows array");
    assert!(!windows.is_empty(), "expected metric windows");
    let total: u64 = windows
        .iter()
        .map(|w| w["count"].as_u64().unwrap_or(0))
        .sum();
    assert!(total > 0, "total count should be positive");
    let errors: u64 = windows
        .iter()
        .map(|w| w["error_count"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(errors, 0, "no assertion errors expected");

    // Bonus: SPA fallback works for unknown route.
    let resp = http
        .get(format!("{}/scenarios/nope", rest_base))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(
        body.contains("slice2-marker"),
        "SPA fallback should serve index.html"
    );

    // API still works under /api after we added ui_dir.
    let resp = http
        .get(format!("{}/api/health", rest_base))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    rest_handle.abort();
    grpc_handle.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_step_with_env_e2e() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (followup #2).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Mock target: /login returns {"access_token":"T"} and /me checks Bearer header.
    let target = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(r#"{"access_token":"T"}"#)
                .insert_header("content-type", "application/json"),
        )
        .mount(&target)
        .await;
    // /me must receive Authorization: Bearer T header — wiremock can't check header values
    // easily without a custom matcher, so we just respond 200 to any request.
    Mock::given(method("GET"))
        .and(path("/me"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC (followup #1 — no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Spin up controller in-process.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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

    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. Two-step scenario using ${BASE_URL} env var and extract flow variable.
    //    BASE_URL will be provided in the run env.
    let scenario_yaml = r#"version: 1
name: "two-step env e2e"
steps:
  - id: "login"
    name: "login"
    type: http
    request:
      method: POST
      url: "${BASE_URL}/login"
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.access_token"
  - id: "profile"
    name: "profile"
    type: http
    request:
      method: GET
      url: "${BASE_URL}/me"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      - status: 200
"#;

    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run with BASE_URL env pointing at wiremock.
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 1, "duration_seconds": 2 },
            "env": { "BASE_URL": target.uri() }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until completed (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap().to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status}"
    );

    // 7. Verify metrics: both steps should have count > 0 and error_count == 0.
    let metrics: Value = http
        .get(format!("{}/api/runs/{}/metrics", rest_base, run_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let windows = metrics["windows"].as_array().expect("windows array");
    assert!(!windows.is_empty(), "expected metric windows");

    // Both step ids should appear somewhere in the windows.
    let step_ids: std::collections::HashSet<&str> = windows
        .iter()
        .filter_map(|w| w["step_id"].as_str())
        .collect();
    assert!(
        step_ids.contains("login"),
        "expected login step metrics, got: {:?}",
        step_ids
    );
    assert!(
        step_ids.contains("profile"),
        "expected profile step metrics, got: {:?}",
        step_ids
    );

    let total: u64 = windows
        .iter()
        .map(|w| w["count"].as_u64().unwrap_or(0))
        .sum();
    assert!(total > 0, "total count should be positive");

    let errors: u64 = windows
        .iter()
        .map(|w| w["error_count"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(errors, 0, "no assertion errors expected");

    rest_handle.abort();
    grpc_handle.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn abort_e2e_marks_run_aborted() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (followup #2).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let ui_dir = tempfile::tempdir().unwrap();
    std::fs::write(
        ui_dir.path().join("index.html"),
        "<!doctype html><html><body></body></html>",
    )
    .unwrap();

    // Mock target with a slow response so the run won't finish before abort.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(50)),
        )
        .mount(&target)
        .await;

    // Bind live listeners for REST + gRPC (followup #1 — no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: Some(ui_dir.path().to_path_buf()),
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    let scenario_yaml = format!(
        "version: 1\nname: abort-e2e\nvariables:\n  base: \"{}\"\nsteps:\n  - id: ping\n    name: GET /\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/\"\n    assert:\n      - status: 200\n",
        target.uri()
    );
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // Long-running run — 30s — so we have time to abort.
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 2, "duration_seconds": 30 },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // Wait until the run is observed as running.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut saw_running = false;
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if v["status"].as_str() == Some("running") {
            saw_running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(saw_running, "expected run to reach 'running' status");

    // Fire the abort.
    let abort_resp = http
        .post(format!("{}/api/runs/{}/abort", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(abort_resp.status(), 200, "abort POST should succeed");

    // Within 10s, status must reach 'aborted' (NOT 'completed' or 'failed').
    // 10s headroom because the worker is a real subprocess that has to observe
    // the cancellation, drain in-flight requests, and ship the final RunStatus.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut final_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        final_status = v["status"].as_str().unwrap().to_string();
        if final_status == "aborted" {
            break;
        }
        // Fail fast if the worker reports a terminal non-aborted state — that's
        // exactly the regression class this test catches.
        if final_status == "completed" || final_status == "failed" {
            panic!(
                "run ended in '{}' instead of 'aborted' — abort flow regression",
                final_status
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(
        final_status, "aborted",
        "run should end in 'aborted'; got '{}'",
        final_status
    );

    rest_handle.abort();
    grpc_handle.abort();
}

/// Full-stack regression guard for the loop node (Slice 7).
///
/// A scenario whose single top-level step is a `type: loop` with `repeat: 2`
/// wrapping an inner `http` step goes through the controller HTTP API →
/// subprocess worker → engine → metrics → report. We assert the report's
/// per-step entry for the INNER step id reflects the loop repeat (count > 0,
/// no errors). The controller needs no loop awareness — it groups run_metrics
/// by step_id from the DB and never walks the scenario YAML — so this test
/// exists purely to catch a regression anywhere in the full stack.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn loop_e2e_inner_step_counts() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (followup #2).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Wiremock stub: GET /tick → 200, with a small delay so each loop body
    //    takes nonzero time (matches the engine integration test, Task 3).
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/tick"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(5)),
        )
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC (followup #1 — no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. Loop scenario: a top-level `type: loop` (repeat: 2) wrapping an inner
    //    `tick` http step with a fixed, known ULID. Inner id == INNER_STEP_ID.
    const INNER_STEP_ID: &str = "01HX0000000000000000000002";
    let scenario_yaml = format!(
        "version: 1\nname: loop-e2e\nvariables:\n  base: \"{}\"\nsteps:\n  - id: \"01HX0000000000000000000001\"\n    name: repeat\n    type: loop\n    repeat: 2\n    do:\n      - id: \"{}\"\n        name: tick\n        type: http\n        request:\n          method: GET\n          url: \"{{{{base}}}}/tick\"\n        assert:\n          - status: 200\n",
        target.uri(),
        INNER_STEP_ID,
    );
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run: 1 VU over 2 seconds (comfortably fits many full loops).
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 1, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until completed (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap().to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status}"
    );

    // 7. GET /report and assert on the INNER step's per-step entry.
    let resp = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let report: Value = resp.json().await.unwrap();

    let steps = report["steps"].as_array().expect("steps array");
    // Metrics are keyed by the step that actually issued the HTTP request — the
    // INNER `tick` step. The loop wrapper itself emits no metrics.
    let inner = steps
        .iter()
        .find(|s| s["step_id"].as_str() == Some(INNER_STEP_ID))
        .unwrap_or_else(|| {
            panic!(
                "no per-step entry for inner step {}; got steps: {}",
                INNER_STEP_ID, report["steps"]
            )
        });

    let count = inner["count"].as_u64().expect("inner step count");
    let error_count = inner["error_count"]
        .as_u64()
        .expect("inner step error_count");

    // Primary invariant: the inner step ran (loop body executed) and all calls
    // succeeded. We deliberately do NOT assert `count % 2 == 0`: the engine
    // checks the deadline between loop iterations AND between body steps, so the
    // final loop can be cut mid-body when the run window ends — making the inner
    // count not a perfect multiple of `repeat`. The exact-multiple invariant is
    // covered by the engine integration test (Task 3); here we guard the full
    // create→run→report stack with the robust assertion.
    assert!(count > 0, "inner step count = {} (expected > 0)", count);
    assert_eq!(
        error_count, 0,
        "inner step error_count = {} (expected 0)",
        error_count
    );

    rest_handle.abort();
    grpc_handle.abort();
}

/// Full-stack guard for Slice 7-1 loop_breakdown: proves the chain
///   RunDialog cap → profile → proto → engine Aggregator → MetricFlush
///   → run_loop_metrics UPSERT → report `ReportStep.loop_breakdown`.
///
/// Scenario: repeat:3 loop around a single http step; each iteration targets
/// a different wiremock path (`/item/0`, `/item/1`, `/item/2`) via
/// `${loop_index}`.  The report's `steps[*].loop_breakdown` must have a
/// bucket for each of the three loop indices with count > 0 and error_count
/// == 0, and no overflow bucket (repeat=3 < cap=256).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn loop_breakdown_e2e() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (followup #2).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Wiremock stubs: GET /item/0, /item/1, /item/2 → 200.
    //    Small delay so p95_ms > 0 (consistent with other e2e tests).
    let target = MockServer::start().await;
    for i in 0..3u32 {
        Mock::given(method("GET"))
            .and(path(format!("/item/{}", i)))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("ok")
                    .set_delay(Duration::from_millis(5)),
            )
            .mount(&target)
            .await;
    }

    // 2. Bind live listeners for REST + gRPC (followup #1 — no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. Loop scenario: repeat:3, inner http step uses ${loop_index} in the
    //    URL.  We reuse the same fixed ULID as in `loop_e2e_inner_step_counts`
    //    so the inner step id is well-known.
    const INNER_STEP_ID: &str = "01HX0000000000000000000002";
    // Use the same raw-format-string approach as loop_e2e_inner_step_counts.
    let scenario_yaml = format!(
        "version: 1\nname: loop-breakdown-e2e\nvariables:\n  base: \"{}\"\nsteps:\n  - id: \"01HX0000000000000000000001\"\n    name: repeat\n    type: loop\n    repeat: 3\n    do:\n      - id: \"{}\"\n        name: item\n        type: http\n        request:\n          method: GET\n          url: \"{{{{base}}}}/item/${{loop_index}}\"\n        assert:\n          - status: 200\n",
        target.uri(),
        INNER_STEP_ID,
    );

    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run: 1 VU over 2 seconds, loop_breakdown_cap = 256.
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "vus": 1,
                "duration_seconds": 2,
                "ramp_up_seconds": 0,
                "loop_breakdown_cap": 256
            },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until completed (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap().to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status}"
    );

    // 7. GET /report and assert loop_breakdown on the inner step.
    let resp = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let report: Value = resp.json().await.unwrap();

    // Find the inner http step entry.
    let steps = report["steps"].as_array().expect("steps array");
    let inner = steps
        .iter()
        .find(|s| s["step_id"].as_str() == Some(INNER_STEP_ID))
        .unwrap_or_else(|| {
            panic!(
                "no per-step entry for inner step {}; got steps: {}",
                INNER_STEP_ID, report["steps"]
            )
        });

    let step_count = inner["count"].as_u64().expect("step count");
    assert!(step_count > 0, "inner step count should be > 0");
    assert_eq!(
        inner["error_count"].as_u64().unwrap_or(0),
        0,
        "inner step error_count should be 0"
    );

    // Assert loop_breakdown shape.
    let breakdown = inner["loop_breakdown"]
        .as_array()
        .expect("loop_breakdown must be an array");
    assert!(
        !breakdown.is_empty(),
        "loop_breakdown must be non-empty; step_count = {step_count}"
    );

    // Collect counts per loop_index bucket (non-overflow only).
    let mut by_index: std::collections::HashMap<u64, (u64, u64)> = std::collections::HashMap::new();
    let mut breakdown_total: u64 = 0;
    let mut breakdown_errors: u64 = 0;
    for bucket in breakdown {
        let cnt = bucket["count"].as_u64().expect("bucket count");
        let errs = bucket["error_count"].as_u64().expect("bucket error_count");
        breakdown_total += cnt;
        breakdown_errors += errs;
        if !bucket["loop_index"].is_null() {
            let idx = bucket["loop_index"].as_u64().expect("loop_index u64");
            let e = by_index.entry(idx).or_insert((0, 0));
            e.0 += cnt;
            e.1 += errs;
        }
    }

    // Each of loop_index 0, 1, 2 must have been executed at least once.
    for i in 0u64..3 {
        let (cnt, errs) = by_index.get(&i).copied().unwrap_or((0, 0));
        assert!(
            cnt > 0,
            "loop_index {i} bucket must have count > 0; full breakdown: {breakdown:?}"
        );
        assert_eq!(errs, 0, "loop_index {i} bucket must have error_count = 0");
    }

    // No overflow bucket (loop_index null) because repeat=3 < cap=256.
    let overflow_count: u64 = breakdown
        .iter()
        .filter(|b| b["loop_index"].is_null())
        .map(|b| b["count"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(
        overflow_count, 0,
        "no overflow bucket expected (repeat=3, cap=256)"
    );

    // Total breakdown count == step count (the sum of per-index buckets == total
    // requests; all requests belong to a loop_index because repeat < cap).
    assert_eq!(
        breakdown_total, step_count,
        "sum of breakdown counts ({breakdown_total}) must equal step count ({step_count})"
    );
    assert_eq!(breakdown_errors, 0, "total breakdown error_count must be 0");

    rest_handle.abort();
    grpc_handle.abort();
}

/// End-to-end guard for Slice 8c data-binding injection (per_vu policy).
///
/// Pipeline exercised:
///   REST run-create gate → PendingDataBinding → RunAssignment.data_binding
///   → controller streams DatasetBatch on worker register
///   → worker load_dataset → engine per-iteration overlay
///   → real HTTP with the injected value reaching wiremock.
///
/// 2 VUs, 2 dataset rows (alice / bob) — per_vu maps vu 0 → alice, vu 1 →
/// bob. We assert wiremock received at least one request for each user,
/// proving the injection pipeline is wired end-to-end.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn data_binding_per_vu_injects_distinct_values() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime.
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Wiremock stub: GET /hit → 200 (records all requests by default).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    // 2. Bind live listeners for REST + gRPC (no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller in-process.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 4. Seed the dataset directly via the store (upload path tested in datasets_api_test.rs).
    let dataset_id = handicap_controller::store::datasets::insert(
        &db,
        "users",
        &["user".to_string()],
        &[vec!["alice".to_string()], vec!["bob".to_string()]],
        0,
    )
    .await
    .unwrap();

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 5. Create the scenario. The URL embeds {{user}} as the only flow var —
    //    the value comes purely from the dataset binding (no env override).
    //    Step id uses Crockford base32 only (no I/L/O/U).
    let scenario_yaml = format!(
        "version: 1\nname: data-binding-e2e\nsteps:\n  - id: \"01HX0000000000000000000099\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{}/hit?u={{{{user}}}}\"\n",
        server.uri()
    );
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 6. Create the run: 2 VUs, per_vu policy, dataset rows alice/bob.
    //    per_vu with 2 VUs and 2 rows → vu 0 → alice, vu 1 → bob.
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "vus": 2,
                "duration_seconds": 2,
                "ramp_up_seconds": 0,
                "data_binding": {
                    "dataset_id": dataset_id,
                    "policy": "per_vu",
                    "mappings": [{"kind": "column", "var": "user", "column": "user"}]
                }
            },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 7. Poll until completed (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    let mut last_message = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap_or("").to_string();
        last_message = v["message"].as_str().unwrap_or("").to_string();
        if last_status == "completed" || last_status == "failed" || last_status == "aborted" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got '{last_status}' (message: {last_message:?})"
    );

    // 8. Assert injection reached the target: both alice and bob must appear in
    //    the query strings wiremock recorded.
    let reqs = server.received_requests().await.unwrap();
    let queries: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(
        queries.iter().any(|q| q.contains("u=alice")),
        "alice missing from wiremock requests: {queries:?}"
    );
    assert!(
        queries.iter().any(|q| q.contains("u=bob")),
        "bob missing from wiremock requests: {queries:?}"
    );

    rest_handle.abort();
    grpc_handle.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn report_e2e_smoke() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (followup #2).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Single wiremock stub: GET /ping → 200, with a small delay so p95_ms > 0
    //    (HDR histogram stores microseconds; sub-millisecond responses round to 0 ms).
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ping"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("pong")
                .set_delay(Duration::from_millis(5)),
        )
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC (followup #1 — no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. One-step scenario hitting wiremock /ping via ${BASE_URL}.
    let scenario_yaml = r#"version: 1
name: "report-smoke"
steps:
  - id: "ping"
    name: "ping"
    type: http
    request:
      method: GET
      url: "${BASE_URL}/ping"
    assert:
      - status: 200
"#;
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run with 2 VUs over 3 seconds and BASE_URL env.
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 2, "duration_seconds": 3 },
            "env": { "BASE_URL": target.uri() }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until completed (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap().to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status}"
    );

    // 7. GET /report and assert.
    let resp = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let report: Value = resp.json().await.unwrap();

    // (a) top-level keys
    for key in [
        "run",
        "scenario_yaml",
        "summary",
        "windows",
        "steps",
        "status_distribution",
    ] {
        assert!(
            report.get(key).is_some(),
            "report missing top-level key '{}'; got: {}",
            key,
            report
        );
    }

    // (b) scenario_yaml matches what we POSTed
    assert_eq!(
        report["scenario_yaml"].as_str().unwrap(),
        scenario_yaml,
        "scenario snapshot drift"
    );

    // (c) summary.count >= 2 (each VU should have made at least one request in 3s)
    let count = report["summary"]["count"].as_u64().unwrap();
    assert!(count >= 2, "summary.count = {} (expected >= 2)", count);

    // (d) exactly 1 step, id "ping"
    let steps = report["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 1, "expected 1 step, got {}", steps.len());
    assert_eq!(steps[0]["step_id"].as_str().unwrap(), "ping");

    // (e) at least one window with p95_ms > 0 (HDR decode worked end-to-end)
    let windows = report["windows"].as_array().unwrap();
    let any_p95 = windows
        .iter()
        .any(|w| w["p95_ms"].as_u64().unwrap_or(0) > 0);
    assert!(any_p95, "no window had p95_ms > 0 — HDR decode broken?");

    // (f) status_distribution["200"] == summary.count (all requests were 200)
    let two_hundred = report["status_distribution"]["200"].as_u64().unwrap_or(0);
    assert_eq!(
        two_hundred, count,
        "status_distribution.200 ({}) != summary.count ({})",
        two_hundred, count
    );

    rest_handle.abort();
    grpc_handle.abort();
}

/// End-to-end guard for Slice 9d if-branch metrics.
///
/// Proves the FULL branch-metrics wire:
///   worker subprocess → gRPC `branch_stats` → controller `run_if_metrics` table
///   → `GET /api/runs/{id}/report` returns `if_breakdown` with a `then` count > 0.
///
/// Scenario: a single `type: if` step whose condition is always true (1 == 1),
/// wrapping a `then` http step that hits wiremock GET /then → 200.
/// After the run completes we assert that `if_breakdown` contains an entry for
/// the if-node with a `then` branch whose count > 0.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn if_branch_report_e2e_smoke() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (followup #2).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Wiremock stub: GET /then → 200.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/then"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC (no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. If-scenario: always-true condition (1 == 1), then branch hits /then.
    //    Use Crockford base32 ULIDs (no I/L/O/U).
    const IF_STEP_ID: &str = "01HX0000000000000000000001";
    const THEN_STEP_ID: &str = "01HX0000000000000000000002";
    let scenario_yaml = format!(
        "version: 1\nname: e2e-branch\nvariables:\n  base: \"{base}\"\nsteps:\n  - id: \"{if_id}\"\n    name: gate\n    type: if\n    cond:\n      left: \"1\"\n      op: eq\n      right: \"1\"\n    then:\n      - id: \"{then_id}\"\n        name: then-step\n        type: http\n        request:\n          method: GET\n          url: \"{{{{base}}}}/then\"\n        assert:\n          - status: 200\n",
        base = target.uri(),
        if_id = IF_STEP_ID,
        then_id = THEN_STEP_ID,
    );
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run: 2 VUs over 2 seconds.
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 2, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until completed (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap().to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status}"
    );

    // 7. GET /report and assert if_breakdown.
    let resp = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let report: Value = resp.json().await.unwrap();

    let if_breakdown = report["if_breakdown"]
        .as_array()
        .expect("if_breakdown must be an array");
    let gate = if_breakdown
        .iter()
        .find(|b| b["step_id"] == IF_STEP_ID)
        .unwrap_or_else(|| {
            panic!(
                "if-node {} not present in if_breakdown; got: {}",
                IF_STEP_ID, report["if_breakdown"]
            )
        });
    let then = gate["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["branch"] == "then")
        .expect("then branch present");
    assert!(
        then["count"].as_u64().unwrap() > 0,
        "then branch decided at least once"
    );

    rest_handle.abort();
    grpc_handle.abort();
}

/// End-to-end smoke test for open-loop (arrival-rate) runs.
///
/// Proves the full open-loop pipeline:
///   POST /api/runs (open-loop profile) → subprocess worker →
///   run_scenario_open_loop → metrics → GET /api/runs/{id}/report
///   → summary.count > 0.
///
/// Does NOT assert anything about `dropped` (that pipeline is T9–T13).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_loop_e2e_smoke() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (cold-build flake guard).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Single wiremock stub: GET /ping → 200, with a small delay so p95_ms > 0.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ping"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("pong")
                .set_delay(Duration::from_millis(5)),
        )
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC.
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. One-step scenario hitting wiremock /ping via ${BASE_URL}.
    let scenario_yaml = r#"version: 1
name: "open-loop-smoke"
steps:
  - id: "ping"
    name: "ping"
    type: http
    request:
      method: GET
      url: "${BASE_URL}/ping"
    assert:
      - status: 200
"#;
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run with open-loop profile: target_rps=50, max_in_flight=16, 2s.
    //    vus=0 is explicit (open-loop ignores vus; slot pool = max_in_flight).
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "vus": 0,
                "target_rps": 50,
                "max_in_flight": 16,
                "duration_seconds": 2
            },
            "env": { "BASE_URL": target.uri() }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until terminal (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    let mut last_message = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap_or("").to_string();
        last_message = v["message"].as_str().unwrap_or("").to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status} (message: {last_message:?})"
    );

    // 7. GET /report and assert traffic was generated.
    let resp = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let report: Value = resp.json().await.unwrap();

    // (a) summary.count > 0 — open-loop generated at least one request
    let count = report["summary"]["count"].as_u64().unwrap_or(0);
    assert!(count > 0, "summary.count = {} (expected > 0)", count);

    // (b) status_distribution["200"] > 0 — wiremock responded with 200s
    let two_hundred = report["status_distribution"]["200"].as_u64().unwrap_or(0);
    assert!(
        two_hundred > 0,
        "status_distribution.200 = {} (expected > 0)",
        two_hundred
    );

    rest_handle.abort();
    grpc_handle.abort();
}

/// S-D: a stages (rate-curve) open-loop run drives traffic end-to-end and the
/// report reflects it. Mirrors `open_loop_e2e_smoke`; only the profile differs
/// (stages curve [200/1s, 200/1s] instead of fixed target_rps). Single-worker v1.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stages_open_loop_e2e_smoke() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (cold-build flake guard).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Single wiremock stub: GET /ping → 200, small delay so p95_ms > 0.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ping"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("pong")
                .set_delay(Duration::from_millis(5)),
        )
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC.
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. One-step scenario hitting wiremock /ping via ${BASE_URL}.
    let scenario_yaml = r#"version: 1
name: "stages-open-loop-smoke"
steps:
  - id: "ping"
    name: "ping"
    type: http
    request:
      method: GET
      url: "${BASE_URL}/ping"
    assert:
      - status: 200
"#;
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run with a stages curve: 0→200 over 1s, hold 200 for 1s (total 2s).
    //    duration_seconds=0 signals "curve mode" (total = sum of stage durations).
    //    vus=0 explicit (open-loop ignores vus; slot pool = max_in_flight).
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "vus": 0,
                "duration_seconds": 0,
                "max_in_flight": 50,
                "stages": [
                    { "target": 200, "duration_seconds": 1 },
                    { "target": 200, "duration_seconds": 1 }
                ]
            },
            "env": { "BASE_URL": target.uri() }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until terminal (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    let mut last_message = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap_or("").to_string();
        last_message = v["message"].as_str().unwrap_or("").to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status} (message: {last_message:?})"
    );

    // 7. GET /report and assert the curve generated traffic.
    let resp = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let report: Value = resp.json().await.unwrap();

    // (a) summary.count > 0 — the curve drove at least one request.
    let count = report["summary"]["count"].as_u64().unwrap_or(0);
    assert!(count > 0, "summary.count = {} (expected > 0)", count);

    // (b) at least one per-second window exists.
    assert!(
        report["windows"]
            .as_array()
            .map(|w| !w.is_empty())
            .unwrap_or(false),
        "expected >= 1 report window"
    );

    // (c) status_distribution["200"] > 0 — wiremock responded 200.
    let two_hundred = report["status_distribution"]["200"].as_u64().unwrap_or(0);
    assert!(
        two_hundred > 0,
        "status_distribution.200 = {} (expected > 0)",
        two_hundred
    );

    // (d) dropped field present (advisory, ample slots → expected 0).
    assert!(
        report["dropped"].is_u64(),
        "report.dropped field should be present"
    );

    eprintln!(
        "[stages_open_loop_e2e_smoke] count={count}, windows={}, 200s={two_hundred}",
        report["windows"].as_array().map(|w| w.len()).unwrap_or(0)
    );

    rest_handle.abort();
    grpc_handle.abort();
}

/// End-to-end guard that the `dropped` counter flows all the way to the report.
///
/// Proves the full dropped pipeline:
///   open-loop scheduler ticks arrive faster than slots free up
///   → engine drop_counter increments
///   → MetricFlush.dropped forwarded by worker
///   → controller UPDATEs runs.dropped
///   → GET /api/runs/{id}/report returns report.dropped > 0.
///
/// Setup: slow responder (100ms delay) + max_in_flight=1 + target_rps=200.
/// 200 arrivals/s into 1 slot held ~100ms each → ~20 concurrent requests needed,
/// but only 1 slot is available → the vast majority of ticks find no free slot
/// and are dropped immediately.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_loop_dropped_reaches_report() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (cold-build flake guard).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Wiremock stub: GET /slow → 200 with a 100ms delay.
    //    The slow response holds the single in-flight slot long enough for
    //    subsequent arrivals to find no free slot → dropped > 0.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(100)),
        )
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC.
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. One-step scenario hitting wiremock /slow via ${BASE_URL}.
    let scenario_yaml = r#"version: 1
name: "open-loop-dropped"
steps:
  - id: "slow"
    name: "slow"
    type: http
    request:
      method: GET
      url: "${BASE_URL}/slow"
    assert:
      - status: 200
"#;
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run with open-loop profile designed to force drops:
    //    - target_rps=200: ticks arrive at 5ms intervals
    //    - max_in_flight=1: only 1 concurrent slot
    //    - duration_seconds=2: short run, enough to accumulate many drops
    //
    //    Expected: ~200 ticks/s × 2s = 400 arrivals; each slot lasts ~100ms so
    //    only ~20 requests can complete. The rest (~380) should be dropped.
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "vus": 0,
                "target_rps": 200,
                "max_in_flight": 1,
                "duration_seconds": 2
            },
            "env": { "BASE_URL": target.uri() }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until terminal (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    let mut last_message = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap_or("").to_string();
        last_message = v["message"].as_str().unwrap_or("").to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got {last_status} (message: {last_message:?})"
    );

    // 7. GET /report and assert the dropped counter reached the DB.
    let resp = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let report: Value = resp.json().await.unwrap();

    let dropped = report["dropped"].as_u64().unwrap_or(0);
    let count = report["summary"]["count"].as_u64().unwrap_or(0);

    // Primary invariant: at least one arrival was dropped.
    // With 200 rps × 2s = 400 arrivals and max_in_flight=1 + 100ms latency,
    // the scheduler will drop the vast majority of arrivals. Even under heavy
    // system load we expect at least 1 dropped tick.
    assert!(
        dropped > 0,
        "report.dropped = {} (expected > 0); summary.count = {}",
        dropped,
        count
    );

    // Secondary: actual throughput is well below the target rate, confirming
    // the drop mechanism is the bottleneck (not a fast responder eating all ticks).
    // max achievable = 1 slot / 100ms = ~10 RPS × 2s = ~20 requests.
    // We allow up to 60 as a generous bound in case of timing variations.
    assert!(
        count < 60,
        "summary.count = {} (expected < 60 with max_in_flight=1 and 100ms latency)",
        count
    );

    eprintln!("[open_loop_dropped_reaches_report] dropped={dropped}, count={count}");

    rest_handle.abort();
    grpc_handle.abort();
}

/// End-to-end smoke test for A2-2 parallel group/page latency.
///
/// Proves the FULL group latency pipeline:
///   engine Instant measurement → `MetricFlush.group_stats` → proto `GroupStat`
///   → worker forward → controller `run_group_metrics` table
///   → `GET /api/runs/{id}/report` returns `group_latency` array.
///
/// Scenario: a single `type: parallel` node (two branches, /a and /b each with
/// 20ms artificial delay) — the page-load wall-clock ≈ max(20, 20) = ~20ms, so
/// `max_ms` > 0 robustly on localhost.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_group_latency_report_e2e_smoke() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker binary off the async runtime (cold-build flake guard).
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    // 1. Wiremock stubs: GET /a and GET /b → 200 with 20ms artificial delay.
    //    The delay is critical: sub-millisecond localhost RTTs round to 0 µs in the
    //    HDR histogram → max_ms = 0, making the assertion below fragile (controller
    //    CLAUDE.md µs-resolution footgun). 20ms is comfortably above the threshold.
    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("a-ok")
                .set_delay(Duration::from_millis(20)),
        )
        .mount(&target)
        .await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("b-ok")
                .set_delay(Duration::from_millis(20)),
        )
        .mount(&target)
        .await;

    // 2. Bind live listeners for REST + gRPC (no TOCTOU window).
    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db.clone(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);

    // 4. Parallel scenario: ONE top-level `type: parallel` node with two branches.
    //    Each branch has a single http GET step. ULIDs use Crockford base32 only
    //    (no I/L/O/U). The target URL is embedded directly (no env var needed).
    const PARALLEL_STEP_ID: &str = "01HX0000000000000000000010";
    let scenario_yaml = format!(
        r#"version: 1
name: "group-latency-e2e"
steps:
  - id: "{par_id}"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - id: "01HX0000000000000000000011"
            name: ga
            type: http
            request:
              method: GET
              url: "{base}/a"
            assert: []
      - name: b
        steps:
          - id: "01HX0000000000000000000012"
            name: gb
            type: http
            request:
              method: GET
              url: "{base}/b"
            assert: []
"#,
        par_id = PARALLEL_STEP_ID,
        base = target.uri(),
    );

    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 5. Create run: 2 VUs over 2 seconds (enough for ≥1 complete page-load iteration).
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 2, "duration_seconds": 2 },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // 6. Poll until terminal (max 30s).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut last_status = String::new();
    let mut last_message = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last_status = v["status"].as_str().unwrap_or("").to_string();
        last_message = v["message"].as_str().unwrap_or("").to_string();
        if last_status == "completed" || last_status == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last_status, "completed",
        "expected completed; got '{last_status}' (message: {last_message:?})"
    );

    // 7. GET /report and assert group_latency.
    let resp = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let report: Value = resp.json().await.unwrap();

    // (a) group_latency array must be present and contain exactly one entry
    //     (the single parallel node in the scenario).
    let gl = report["group_latency"]
        .as_array()
        .expect("group_latency array present in report");
    assert_eq!(
        gl.len(),
        1,
        "exactly one parallel node → exactly one group_latency entry; got: {gl:?}"
    );

    // (b) The entry references the correct parallel node step_id.
    let entry = &gl[0];
    assert_eq!(
        entry["step_id"].as_str().unwrap(),
        PARALLEL_STEP_ID,
        "group_latency entry step_id must match the parallel node id"
    );

    // (c) At least one clean page-load sample was recorded.
    let count = entry["count"].as_u64().expect("group_latency[0].count");
    assert!(
        count >= 1,
        "at least one complete page-load sample expected; got count={count}"
    );

    // (d) max_ms > 0 — the 20ms artificial branch delay guarantees this is not 0.
    let max_ms = entry["max_ms"].as_u64().expect("group_latency[0].max_ms");
    assert!(
        max_ms > 0,
        "page-load max_ms must be > 0 with 20ms artificial branch delay; got max_ms={max_ms}"
    );

    // (e) The parallel node id must NOT appear as a per-step row: group_latency
    //     measures the page-load wall-clock, not an HTTP leaf. The http leaves
    //     (...0011, ...0012) appear in steps[], not the parallel node id.
    let steps = report["steps"].as_array().expect("steps array");
    let parallel_in_steps = steps
        .iter()
        .any(|s| s["step_id"].as_str() == Some(PARALLEL_STEP_ID));
    assert!(
        !parallel_in_steps,
        "parallel node id must not appear in steps[] (it is not an http leaf); \
         steps: {steps:?}"
    );

    // (f) summary.count > 0 — http leaves executed (counted separately from page-loads).
    let summary_count = report["summary"]["count"].as_u64().unwrap_or(0);
    assert!(
        summary_count > 0,
        "summary.count must be > 0 (http leaf requests were made)"
    );

    eprintln!(
        "[parallel_group_latency_report_e2e_smoke] group_latency count={count}, \
         max_ms={max_ms}, summary_count={summary_count}"
    );

    rest_handle.abort();
    grpc_handle.abort();
}
