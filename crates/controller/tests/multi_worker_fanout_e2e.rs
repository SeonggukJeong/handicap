//! A3a end-to-end: a run with 2 VUs and worker capacity 1 fans out to N=2
//! subprocess workers. We assert (a) the run completes (all shards reported
//! Completed → coordinator aggregated), and (b) wiremock saw load from the
//! run. Exact per-worker metric merge is A3b; here we use wiremock's request
//! log (ground truth) instead of run_metrics (keep-first in A3a).
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
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

/// Boot an in-process controller with the given coordinator (capacity baked in).
async fn boot(
    coord: CoordinatorState,
    db: store::Db,
    grpc_listener: TcpListener,
    rest_listener: TcpListener,
    grpc_addr: SocketAddr,
    worker_bin: &Path,
) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
            db,
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_fanout_completes() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

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
    // capacity 1 → N = total_vus.
    let coord = CoordinatorState::with_capacity(db.clone(), 1);
    let (rest_handle, grpc_handle) = boot(
        coord,
        db.clone(),
        grpc_listener,
        rest_listener,
        grpc_addr,
        &worker_bin,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);
    let scenario_yaml = format!(
        "version: 1\nname: fanout\nvariables:\n  base: \"{}\"\nsteps:\n  - id: \"01HX0000000000000000000020\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n    assert:\n      - status: 200\n",
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

    // 2 VUs, capacity 1 → 2 workers, shards (vu_offset 0,1).
    let v: Value = http.post(format!("{}/api/runs", rest_base))
        .json(&json!({ "scenario_id": scenario_id, "profile": { "vus": 2, "duration_seconds": 2 }, "env": {} }))
        .send().await.unwrap().json().await.unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last = v["status"].as_str().unwrap().to_string();
        if last == "completed" || last == "failed" || last == "aborted" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(last, "completed", "N=2 fan-out should complete; got {last}");

    // Both shards generated load: wiremock saw global vu ids 0 AND 1.
    let reqs = target.received_requests().await.unwrap();
    let qs: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(
        qs.iter().any(|q| q.contains("vu=0")),
        "shard 0 (vu=0) missing: {qs:?}"
    );
    assert!(
        qs.iter().any(|q| q.contains("vu=1")),
        "shard 1 (vu=1) missing: {qs:?}"
    );

    rest_handle.abort();
    grpc_handle.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_fanout_abort_marks_aborted() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(50)),
        )
        .mount(&target)
        .await;

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::with_capacity(db.clone(), 1);
    let (rest_handle, grpc_handle) = boot(
        coord,
        db.clone(),
        grpc_listener,
        rest_listener,
        grpc_addr,
        &worker_bin,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);
    let scenario_yaml = format!(
        "version: 1\nname: fanout-abort\nvariables:\n  base: \"{}\"\nsteps:\n  - id: \"01HX0000000000000000000021\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/hit\"\n    assert:\n      - status: 200\n",
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

    // 2 VUs over 30s so there's time to abort both shards.
    let v: Value = http.post(format!("{}/api/runs", rest_base))
        .json(&json!({ "scenario_id": scenario_id, "profile": { "vus": 2, "duration_seconds": 30 }, "env": {} }))
        .send().await.unwrap().json().await.unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // Wait until running.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
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
    assert!(saw_running, "run should reach running");

    let r = http
        .post(format!("{}/api/runs/{}/abort", rest_base, run_id))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    let deadline = std::time::Instant::now() + Duration::from_secs(15);
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
        if final_status == "completed" || final_status == "failed" {
            panic!("expected aborted, got {final_status}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(
        final_status, "aborted",
        "both shards should abort → run aborted"
    );

    rest_handle.abort();
    grpc_handle.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_fanout_merges_metrics() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(5)), // p50_ms > 0 after HDR merge
        )
        .mount(&target)
        .await;

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::with_capacity(db.clone(), 1); // capacity 1 -> N = total_vus
    let (rest_handle, grpc_handle) = boot(
        coord,
        db.clone(),
        grpc_listener,
        rest_listener,
        grpc_addr,
        &worker_bin,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);
    // Same step_id across both shards so their per-second windows collide on
    // (run_id, ts_second, step_id) — exactly the case A3a keep-first dropped.
    let scenario_yaml = format!(
        "version: 1\nname: merge\nvariables:\n  base: \"{}\"\nsteps:\n  - id: \"01HX0000000000000000000022\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n    assert:\n      - status: 200\n",
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

    // 2 VUs, 3s — steady load so both shards emit several overlapping windows.
    let v: Value = http.post(format!("{}/api/runs", rest_base))
        .json(&json!({ "scenario_id": scenario_id, "profile": { "vus": 2, "duration_seconds": 3 }, "env": {} }))
        .send().await.unwrap().json().await.unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last = v["status"].as_str().unwrap().to_string();
        if last == "completed" || last == "failed" || last == "aborted" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(last, "completed", "N=2 fan-out should complete; got {last}");

    // Ground truth: wiremock saw both shards (vu=0 and vu=1) plus a total count.
    let reqs = target.received_requests().await.unwrap();
    let wc = reqs.len();
    let qs: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(qs.iter().any(|q| q.contains("vu=0")), "shard 0 missing");
    assert!(qs.iter().any(|q| q.contains("vu=1")), "shard 1 missing");

    // /report: counts must NOT be halved by keep-first. A3a would drop one worker's
    // row per colliding (ts,step) -> report count ~= wc/2. A3b merges -> ~= wc (a few
    // in-flight-at-deadline requests may hit wiremock without being counted).
    let report: Value = http
        .get(format!("{}/api/runs/{}/report", rest_base, run_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rc = report["summary"]["count"].as_u64().unwrap() as usize;
    assert!(
        rc <= wc && rc + 4 >= wc,
        "report count {rc} should match wiremock {wc} (A3a keep-first would be ~half)"
    );
    // HDR blobs from both workers decoded + merged -> non-zero p50 (5ms delay).
    assert!(
        report["summary"]["p50_ms"].as_u64().unwrap() >= 1,
        "merged HDR should yield p50_ms >= 1ms"
    );

    // /metrics live summary must agree with /report (both read the same merged rows).
    let metrics: Value = http
        .get(format!("{}/api/runs/{}/metrics", rest_base, run_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mc: u64 = metrics["windows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["count"].as_u64().unwrap())
        .sum();
    assert_eq!(
        mc as usize, rc,
        "/metrics summed count must equal /report count"
    );

    rest_handle.abort();
    grpc_handle.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_unique_consumes_each_row_once() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(2)),
        )
        .mount(&target)
        .await;

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::with_capacity(db.clone(), 1); // capacity 1 → N = vus
    let (rest_handle, grpc_handle) = boot(
        coord,
        db.clone(),
        grpc_listener,
        rest_listener,
        grpc_addr,
        &worker_bin,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 6 unique tokens; 2 workers → disjoint slices (0,3) and (3,3).
    let dataset_id = store::datasets::insert(
        &db,
        "toks",
        &["tok".to_string()],
        &(0..6).map(|i| vec![format!("t{i}")]).collect::<Vec<_>>(),
        0,
    )
    .await
    .unwrap();

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);
    let scenario_yaml = format!(
        "version: 1\nname: unique-e2e\nsteps:\n  - id: \"01HX0000000000000000000023\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{}/hit?tok={{{{tok}}}}\"\n",
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

    // 2 VUs, capacity 1 → 2 workers; unique → each worker consumes its 3 tokens once.
    let v: Value = http
        .post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "vus": 2, "duration_seconds": 3, "ramp_up_seconds": 0,
                "data_binding": {
                    "dataset_id": dataset_id,
                    "policy": "unique",
                    "mappings": [{"kind": "column", "var": "tok", "column": "tok"}]
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

    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        last = v["status"].as_str().unwrap_or("").to_string();
        if last == "completed" || last == "failed" || last == "aborted" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(
        last, "completed",
        "unique fan-out should complete; got {last}"
    );

    // Uniqueness: the query is only `tok={value}` → strip the prefix.
    // No token may appear twice across both workers.
    let reqs = target.received_requests().await.unwrap();
    let toks: Vec<String> = reqs
        .iter()
        .filter_map(|r| {
            r.url
                .query()
                .and_then(|q| q.strip_prefix("tok="))
                .map(|t| t.to_string())
        })
        .collect();
    let distinct: std::collections::HashSet<&String> = toks.iter().collect();
    assert!(!toks.is_empty(), "expected unique-bound requests, saw none");
    assert_eq!(
        toks.len(),
        distinct.len(),
        "unique policy must not reuse a row: {toks:?}"
    );
    // Every observed token is a real dataset token (mappings applied, no `{{tok}}`).
    assert!(
        toks.iter().all(|t| t.starts_with('t') && !t.contains('{')),
        "unbound or malformed token leaked: {toks:?}"
    );

    rest_handle.abort();
    grpc_handle.abort();
}
