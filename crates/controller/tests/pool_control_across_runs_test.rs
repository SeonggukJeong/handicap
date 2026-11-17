#![cfg(feature = "in-process")]
//! 풀 항목의 수명 vs 스트림 종료: run을 끝낸 부하기는 run마다 스트림을 닫고 다시 등록한다.
//! 그 사이 컨트롤러가 풀 항목을 지우면, 고정 id가 없는 부하기는 운영자 설정(빼기·용량 덮어쓰기·
//! 메모)을 잃고 빠졌던 부하기가 다시 배정 대상이 된다. 또 같은 id로 새로 등록한 뒤 옛 스트림이
//! 닫혀도 새 등록이 지워지면 안 된다.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use handicap_controller::in_process::{
    InProcessConfig, InProcessWorkerMode, RunningController, run_in_process,
};
use handicap_proto::v1 as pb;
use pb::coordinator_client::CoordinatorClient;
use pb::worker_message::Payload as WorkerPayload;
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::any;
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "t";

fn tmp_db() -> String {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("c.db").display().to_string();
    std::mem::forget(tmp);
    p
}

fn free_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

async fn start_pool(grpc_port: u16) -> RunningController {
    run_in_process(InProcessConfig {
        db: Some(tmp_db()),
        scheduler_disabled: true,
        worker_mode: InProcessWorkerMode::Pool,
        worker_token: Some(TOKEN.into()),
        grpc: SocketAddr::from((Ipv4Addr::LOCALHOST, grpc_port)),
        grpc_port_fallback: false,
        ..InProcessConfig::default()
    })
    .await
    .expect("start pool controller")
}

fn rest(rc: &RunningController, path: &str) -> String {
    format!("http://{}{}", rc.rest_addr(), path)
}

/// CLI 풀 부하기, `--worker-id` 없음 = 고정 id 아님(설정이 DB에 남지 않는다).
fn spawn_ephemeral_worker(port: u16) -> (CancellationToken, JoinHandle<anyhow::Result<()>>) {
    let cancel = CancellationToken::new();
    let h = tokio::spawn(handicap_worker::run_pool_until(
        handicap_worker::WorkerArgs {
            controller: format!("http://127.0.0.1:{port}"),
            run_id: None,
            worker_id: None,
            capacity_vus: 10,
            token: Some(TOKEN.into()),
        },
        cancel.clone(),
    ));
    (cancel, h)
}

async fn workers(rc: &RunningController) -> Vec<Value> {
    let v: Value = reqwest::get(rest(rc, "/api/pool/workers"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["workers"].as_array().cloned().unwrap_or_default()
}

async fn worker(rc: &RunningController, id: &str) -> Option<Value> {
    workers(rc).await.into_iter().find(|w| w["worker_id"] == id)
}

/// 처음 등록된 부하기의 id(무작위 ULID)를 기다려 얻는다.
async fn wait_first_worker_id(rc: &RunningController) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(w) = workers(rc).await.into_iter().next() {
            return w["worker_id"].as_str().unwrap().to_string();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker never registered"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn patch(rc: &RunningController, id: &str, body: Value) {
    let resp = reqwest::Client::new()
        .patch(rest(rc, &format!("/api/pool/workers/{id}")))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "patch: {}", resp.status());
}

async fn target() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    s
}

async fn create_scenario(rc: &RunningController, base: &str) -> String {
    let yaml = format!(
        "version: 1\nname: lv-pool\nsteps:\n  - id: root\n    name: GET /\n    type: http\n    request:\n      method: GET\n      url: \"{base}/\"\n"
    );
    let resp = reqwest::Client::new()
        .post(rest(rc, "/api/scenarios"))
        .json(&json!({ "yaml": yaml }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "scenario: {}", resp.status());
    let v: Value = resp.json().await.unwrap();
    v["id"].as_str().unwrap().to_string()
}

async fn post_run(rc: &RunningController, sid: &str, seconds: u32) -> reqwest::Response {
    reqwest::Client::new()
        .post(rest(rc, "/api/runs"))
        .json(&json!({
            "scenario_id": sid,
            "profile": { "vus": 1, "duration_seconds": seconds },
            "env": {}
        }))
        .send()
        .await
        .unwrap()
}

async fn start_run(rc: &RunningController, sid: &str, seconds: u32) -> String {
    let resp = post_run(rc, sid, seconds).await;
    assert!(resp.status().is_success(), "run: {}", resp.status());
    let v: Value = resp.json().await.unwrap();
    v["id"].as_str().unwrap().to_string()
}

async fn run_status(rc: &RunningController, run_id: &str) -> String {
    let v: Value = reqwest::get(rest(rc, &format!("/api/runs/{run_id}")))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    v["status"].as_str().unwrap_or_default().to_string()
}

async fn wait_busy(rc: &RunningController, id: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if worker(rc, id).await.is_some_and(|w| w["busy"] == true) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker never became busy"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// run이 끝나고 부하기가 다시 등록돼 유휴가 될 때까지 지켜본다. 유휴가 된 항목과, 그 사이
/// 목록에서 한 번이라도 사라졌는지(옛 스트림이 닫힐 때 항목을 지웠다는 뜻)를 돌려준다.
async fn watch_until_reregistered(rc: &RunningController, id: &str, run_id: &str) -> (Value, bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut run_done = false;
    let mut vanished = false;
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker never came back idle (run_done={run_done}, vanished={vanished})"
        );
        if !run_done {
            run_done = run_status(rc, run_id).await == "completed";
        }
        match worker(rc, id).await {
            None => vanished = true,
            Some(w) if run_done && w["busy"] == false => return (w, vanished),
            Some(_) => {}
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ephemeral_worker_keeps_label_and_capacity_override_across_run() {
    let port = free_port();
    let rc = start_pool(port).await;
    let t = target().await;
    let (cancel, h) = spawn_ephemeral_worker(port);
    let id = wait_first_worker_id(&rc).await;
    patch(
        &rc,
        &id,
        json!({ "label": "keepme", "capacity_override": 7 }),
    )
    .await;
    let sid = create_scenario(&rc, &t.uri()).await;
    let run_id = start_run(&rc, &sid, 1).await;
    wait_busy(&rc, &id).await;
    let (w, vanished) = watch_until_reregistered(&rc, &id, &run_id).await;
    assert_eq!(w["label"], "keepme", "{w}");
    assert_eq!(w["capacity_override"], 7, "{w}");
    assert!(!vanished, "worker must stay listed between runs");
    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(10), h).await;
    rc.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ephemeral_worker_drained_mid_run_stays_drained() {
    let port = free_port();
    let rc = start_pool(port).await;
    let t = target().await;
    let (cancel, h) = spawn_ephemeral_worker(port);
    let id = wait_first_worker_id(&rc).await;
    let sid = create_scenario(&rc, &t.uri()).await;
    let run_id = start_run(&rc, &sid, 2).await;
    wait_busy(&rc, &id).await;
    patch(&rc, &id, json!({ "drained": true })).await;
    let (w, vanished) = watch_until_reregistered(&rc, &id, &run_id).await;
    assert_eq!(w["drained"], true, "{w}");
    assert!(!vanished, "worker must stay listed between runs");
    // The only worker is drained → the next run must not be assigned to it.
    let resp = post_run(&rc, &sid, 1).await;
    assert!(
        resp.status().is_client_error(),
        "a drained worker must not receive the next run, got {}",
        resp.status()
    );
    assert_eq!(worker(&rc, &id).await.unwrap()["busy"], false);
    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(10), h).await;
    rc.shutdown().await;
}

/// Open a raw pool stream for `worker_id`, register, and return its sender + inbound.
async fn raw_register(
    port: u16,
    worker_id: &str,
) -> (
    tokio::sync::mpsc::Sender<pb::WorkerMessage>,
    tonic::Streaming<pb::ServerMessage>,
) {
    let mut client = CoordinatorClient::connect(format!("http://127.0.0.1:{port}"))
        .await
        .unwrap();
    let (tx, rx) = tokio::sync::mpsc::channel::<pb::WorkerMessage>(8);
    tx.send(pb::WorkerMessage {
        payload: Some(WorkerPayload::Register(pb::Register {
            worker_id: worker_id.to_string(),
            run_id: String::new(),
            capacity_vus: 10,
            token: TOKEN.into(),
            hostname: "raw".into(),
            stable_id: false,
        })),
    })
    .await
    .unwrap();
    let inbound = client
        .channel(ReceiverStream::new(rx))
        .await
        .unwrap()
        .into_inner();
    (tx, inbound)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn old_stream_close_does_not_remove_newer_registration() {
    let port = free_port();
    let rc = start_pool(port).await;
    let (tx1, mut in1) = raw_register(port, "dup").await;
    // The acceptance Ping proves stream 1 is in the pool.
    let _ = tokio::time::timeout(Duration::from_secs(5), in1.message())
        .await
        .expect("acceptance ping on stream 1");
    let (tx2, mut in2) = raw_register(port, "dup").await;
    let _ = tokio::time::timeout(Duration::from_secs(5), in2.message())
        .await
        .expect("acceptance ping on stream 2");
    patch(&rc, "dup", json!({ "label": "second" })).await;
    // Close stream 1 (END_STREAM + drop its response side).
    drop(tx1);
    drop(in1);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let w = worker(&rc, "dup").await;
    assert!(
        w.as_ref().is_some_and(|w| w["label"] == "second"),
        "closing the OLD stream must not remove the newer registration: {w:?}"
    );
    drop((tx2, in2));
    rc.shutdown().await;
}

/// run이 `completed`가 되는 순간을 20ms 간격으로 지켜보고 그 시각을 돌려준다.
async fn wait_completed(rc: &RunningController, run_id: &str) -> tokio::time::Instant {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if run_status(rc, run_id).await == "completed" {
            return tokio::time::Instant::now();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "run never completed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_reregisters_promptly_after_run() {
    let port = free_port();
    let rc = start_pool(port).await;
    let t = target().await;
    let (cancel, h) = spawn_ephemeral_worker(port);
    let id = wait_first_worker_id(&rc).await;
    let sid = create_scenario(&rc, &t.uri()).await;
    let run_id = start_run(&rc, &sid, 1).await;
    wait_busy(&rc, &id).await;
    let t0 = wait_completed(&rc, &run_id).await;
    let deadline = t0 + Duration::from_secs(10);
    let t1 = loop {
        if worker(&rc, &id).await.is_some_and(|w| w["busy"] == false) {
            break tokio::time::Instant::now();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker never came back idle"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let elapsed = t1 - t0;
    eprintln!("reregister elapsed after completed: {elapsed:?}");
    assert!(
        elapsed < Duration::from_millis(1000),
        "worker should re-register promptly after the run, took {elapsed:?}"
    );
    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(10), h).await;
    rc.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn back_to_back_run_gets_the_worker() {
    let port = free_port();
    let rc = start_pool(port).await;
    let t = target().await;
    let (cancel, h) = spawn_ephemeral_worker(port);
    let id = wait_first_worker_id(&rc).await;
    let sid = create_scenario(&rc, &t.uri()).await;
    let run_id = start_run(&rc, &sid, 1).await;
    wait_busy(&rc, &id).await;
    let t0 = wait_completed(&rc, &run_id).await;
    let window = t0 + Duration::from_millis(500);
    let second = loop {
        let resp = post_run(&rc, &sid, 1).await;
        if resp.status().is_success() {
            break resp;
        }
        assert!(
            tokio::time::Instant::now() < window,
            "back-to-back run was not accepted within 500ms, last status {}",
            resp.status()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    eprintln!("second run accepted after: {:?}", t0.elapsed());
    let v: Value = second.json().await.unwrap();
    assert!(v["id"].as_str().is_some(), "{v}");
    wait_busy(&rc, &id).await;
    cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(10), h).await;
    rc.shutdown().await;
}
