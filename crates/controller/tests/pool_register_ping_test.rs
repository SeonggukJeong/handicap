#![cfg(feature = "in-process")]
//! 풀 워커 등록 직후 컨트롤러는 Ping을 먼저 보내고(워커 쪽 "수락됨" 신호), 토큰이 틀리면
//! 공유 상수 사유의 Abort를 보낸다.

use std::time::Duration;

use handicap_controller::in_process::{InProcessConfig, InProcessWorkerMode, run_in_process};
use handicap_proto::v1::coordinator_client::CoordinatorClient;
use handicap_proto::v1::server_message::Payload as ServerPayload;
use handicap_proto::v1::worker_message::Payload as WorkerPayload;
use handicap_proto::v1::{Register, ServerMessage, WorkerMessage};

const TOKEN: &str = "t";

fn tmp_db() -> String {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("c.db").display().to_string();
    std::mem::forget(tmp);
    p
}

async fn first_message(token: &str) -> ServerMessage {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let _rc = run_in_process(InProcessConfig {
        db: Some(tmp_db()),
        scheduler_disabled: true,
        worker_mode: InProcessWorkerMode::Pool,
        worker_token: Some(TOKEN.into()),
        grpc: std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        grpc_port_fallback: false,
        ..InProcessConfig::default()
    })
    .await
    .expect("start pool controller");

    let mut client = CoordinatorClient::connect(format!("http://127.0.0.1:{port}"))
        .await
        .expect("connect");
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    tx.send(WorkerMessage {
        payload: Some(WorkerPayload::Register(Register {
            worker_id: "ping-w1".into(),
            run_id: String::new(),
            capacity_vus: 10,
            hostname: "h".into(),
            stable_id: false,
            token: token.into(),
        })),
    })
    .await
    .unwrap();
    let mut stream = client
        .channel(tokio_stream::wrappers::ReceiverStream::new(rx))
        .await
        .expect("channel")
        .into_inner();
    let msg = tokio::time::timeout(Duration::from_secs(2), stream.message())
        .await
        .expect("no server message within 2s")
        .expect("stream error")
        .expect("stream closed");
    drop(tx);
    msg
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_message_after_pool_register_is_ping() {
    let msg = first_message(TOKEN).await;
    assert!(
        matches!(msg.payload, Some(ServerPayload::Ping(_))),
        "got {:?}",
        msg.payload
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_token_abort_reason_is_auth_failed() {
    let msg = first_message("wrong").await;
    let Some(ServerPayload::Abort(a)) = msg.payload else {
        panic!("expected Abort, got {:?}", msg.payload);
    };
    assert_eq!(a.reason, "authentication failed");
    assert_eq!(a.reason, handicap_proto::AUTH_FAILED_REASON);
}
