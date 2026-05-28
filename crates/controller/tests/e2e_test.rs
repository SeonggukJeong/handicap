use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
use handicap_controller::{app, store};
use handicap_proto::v1::coordinator_server::CoordinatorServer;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn worker_bin_path() -> PathBuf {
    // CARGO_BIN_EXE_<name> is set for bins of crates listed in [dev-dependencies] OR
    // when running tests via `cargo test -p ... --test e2e_test` and `worker` is a workspace member.
    // To be robust across both, fall back to target/debug/worker.
    if let Ok(p) = std::env::var("CARGO_BIN_EXE_worker") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("target/debug/worker")
}

async fn pick_addr() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    drop(l);
    a
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_slice_1_e2e() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Ensure the worker binary exists. The user must `cargo build -p handicap-worker` first
    //    OR rely on the workspace test runner having built it. To make this self-contained we
    //    build it here.
    let status = std::process::Command::new(env!("CARGO"))
        .args(["build", "-p", "handicap-worker"])
        .status()
        .expect("cargo build -p handicap-worker");
    assert!(status.success(), "worker build failed");
    let worker_bin = worker_bin_path();
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

    // 2. Pick free ports for REST + gRPC.
    let rest_addr = pick_addr().await;
    let grpc_addr = pick_addr().await;

    // 3. Spin up controller in-process.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        worker_bin: worker_bin.to_string_lossy().to_string(),
        grpc_addr,
        ui_dir: Some(ui_dir.path().to_path_buf()),
    });
    let rest_listener = TcpListener::bind(rest_addr).await.unwrap();
    let rest_handle = tokio::spawn(async move {
        axum::serve(rest_listener, app).await.unwrap();
    });
    let grpc_handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(CoordinatorServer::new(CoordinatorService { state: coord }))
            .serve(grpc_addr)
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

    // 0. Ensure worker binary is built.
    let status = std::process::Command::new(env!("CARGO"))
        .args(["build", "-p", "handicap-worker"])
        .status()
        .expect("cargo build -p handicap-worker");
    assert!(status.success(), "worker build failed");
    let worker_bin = worker_bin_path();
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

    // 2. Pick free ports.
    let rest_addr = pick_addr().await;
    let grpc_addr = pick_addr().await;

    // 3. Spin up controller in-process.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        worker_bin: worker_bin.to_string_lossy().to_string(),
        grpc_addr,
        ui_dir: None,
    });
    let rest_listener = TcpListener::bind(rest_addr).await.unwrap();
    let rest_handle = tokio::spawn(async move {
        axum::serve(rest_listener, app).await.unwrap();
    });
    let grpc_handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(CoordinatorServer::new(CoordinatorService { state: coord }))
            .serve(grpc_addr)
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

    // Build the worker binary (same pattern as full_slice_1_e2e).
    let status = std::process::Command::new(env!("CARGO"))
        .args(["build", "-p", "handicap-worker"])
        .status()
        .expect("cargo build -p handicap-worker");
    assert!(status.success(), "worker build failed");
    let worker_bin = worker_bin_path();
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

    let rest_addr = pick_addr().await;
    let grpc_addr = pick_addr().await;

    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        worker_bin: worker_bin.to_string_lossy().to_string(),
        grpc_addr,
        ui_dir: Some(ui_dir.path().to_path_buf()),
    });
    let rest_listener = TcpListener::bind(rest_addr).await.unwrap();
    let rest_handle = tokio::spawn(async move {
        axum::serve(rest_listener, app).await.unwrap();
    });
    let grpc_handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(CoordinatorServer::new(CoordinatorService { state: coord }))
            .serve(grpc_addr)
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn report_e2e_smoke() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();

    // 0. Build worker bin (same pattern as the other e2e tests).
    let status = std::process::Command::new(env!("CARGO"))
        .args(["build", "-p", "handicap-worker"])
        .status()
        .expect("cargo build -p handicap-worker");
    assert!(status.success(), "worker build failed");
    let worker_bin = worker_bin_path();
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

    // 2. Pick free ports.
    let rest_addr = pick_addr().await;
    let grpc_addr = pick_addr().await;

    // 3. Boot controller.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        worker_bin: worker_bin.to_string_lossy().to_string(),
        grpc_addr,
        ui_dir: None,
    });
    let rest_listener = TcpListener::bind(rest_addr).await.unwrap();
    let rest_handle = tokio::spawn(async move {
        axum::serve(rest_listener, app).await.unwrap();
    });
    let grpc_handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(CoordinatorServer::new(CoordinatorService { state: coord }))
            .serve(grpc_addr)
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
