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
        .post(format!("{}/scenarios", rest_base))
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
        .post(format!("{}/runs", rest_base))
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
            .get(format!("{}/runs/{}", rest_base, run_id))
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
        .get(format!("{}/runs/{}/metrics", rest_base, run_id))
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

    rest_handle.abort();
    grpc_handle.abort();
}
