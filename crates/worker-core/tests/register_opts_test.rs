//! `connect_and_register_opts`: 배정 전 Abort 사유 보존, 수락 콜백, 연결 상한.
//! 실시간 통합 테스트(`pause` 금지 — 실제 소켓).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use handicap_proto::v1 as pb;
use handicap_proto::v1::coordinator_server::{Coordinator, CoordinatorServer};
use handicap_proto::v1::server_message::Payload as SP;
use handicap_worker_core::{
    RegisterOpts, WorkerError, connect_and_register, connect_and_register_opts,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status, Streaming};

struct Stub {
    script: Vec<SP>,
}

#[tonic::async_trait]
impl Coordinator for Stub {
    type ChannelStream = ReceiverStream<Result<pb::ServerMessage, Status>>;
    async fn channel(
        &self,
        req: Request<Streaming<pb::WorkerMessage>>,
    ) -> Result<Response<Self::ChannelStream>, Status> {
        let mut inbound = req.into_inner();
        let (tx, rx) = mpsc::channel(16);
        let script = self.script.clone();
        tokio::spawn(async move {
            // Register 수신 뒤 스크립트 전송, 이후 스트림을 열어 둔다.
            let _ = inbound.message().await;
            for p in script {
                let _ = tx.send(Ok(pb::ServerMessage { payload: Some(p) })).await;
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(tx);
        });
        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

async fn spawn_stub(script: Vec<SP>) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(CoordinatorServer::new(Stub { script }))
            .serve_with_incoming(TcpListenerStream::new(l))
            .await
            .ok();
    });
    format!("http://{addr}")
}

fn abort(reason: &str) -> SP {
    SP::Abort(pb::AbortRun {
        run_id: String::new(),
        reason: reason.to_string(),
    })
}
fn ping(n: u64) -> SP {
    SP::Ping(pb::Ping { nonce: n })
}
fn assign() -> SP {
    SP::Assignment(pb::RunAssignment::default())
}

async fn reg(
    url: &str,
    opts: RegisterOpts<'_>,
) -> Result<handicap_worker_core::WorkerLink, WorkerError> {
    let cancel = CancellationToken::new();
    tokio::time::timeout(
        Duration::from_secs(3),
        connect_and_register_opts(url, "w1", "", 1, "", "h", false, &cancel, opts),
    )
    .await
    .expect("outer 3s timeout")
}

#[tokio::test]
async fn abort_before_assignment_keeps_reason() {
    let url = spawn_stub(vec![abort(handicap_proto::AUTH_FAILED_REASON)]).await;
    let e = reg(&url, RegisterOpts::default()).await.err().unwrap();
    assert_eq!(e.abort_reason(), Some(handicap_proto::AUTH_FAILED_REASON));
    assert_eq!(e.to_string(), "missing assignment after register");
}

#[tokio::test]
async fn abort_reason_is_clipped_to_200_chars() {
    let url = spawn_stub(vec![abort(&"가".repeat(300))]).await;
    let e = reg(&url, RegisterOpts::default()).await.err().unwrap();
    assert_eq!(e.abort_reason().unwrap().chars().count(), 200);
}

#[tokio::test]
async fn on_accepted_fires_once_on_first_ping() {
    let url = spawn_stub(vec![ping(1), ping(2), assign()]).await;
    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    let cb = move || {
        n2.fetch_add(1, Ordering::SeqCst);
    };
    let opts = RegisterOpts {
        connect_timeout: None,
        on_accepted: Some(&cb),
    };
    assert!(reg(&url, opts).await.is_ok());
    assert_eq!(n.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn on_accepted_fires_on_assignment_without_ping() {
    let url = spawn_stub(vec![assign()]).await;
    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    let cb = move || {
        n2.fetch_add(1, Ordering::SeqCst);
    };
    let opts = RegisterOpts {
        connect_timeout: None,
        on_accepted: Some(&cb),
    };
    assert!(reg(&url, opts).await.is_ok());
    assert_eq!(n.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn old_connect_and_register_keeps_display_on_abort() {
    let url = spawn_stub(vec![abort(handicap_proto::AUTH_FAILED_REASON)]).await;
    let cancel = CancellationToken::new();
    let e = tokio::time::timeout(
        Duration::from_secs(3),
        connect_and_register(&url, "w1", "", 1, "", "h", false, &cancel),
    )
    .await
    .expect("outer 3s timeout")
    .err()
    .unwrap();
    assert_eq!(e.to_string(), "missing assignment after register");
}

#[tokio::test]
async fn connect_timeout_bounds_silent_listener() {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        let (sock, _) = l.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
        drop(sock);
    });
    let url = format!("http://{addr}");
    let opts = RegisterOpts {
        connect_timeout: Some(Duration::from_millis(300)),
        on_accepted: None,
    };
    let started = std::time::Instant::now();
    let r = reg(&url, opts).await;
    assert!(
        matches!(r, Err(WorkerError::ConnectTimeout)),
        "got {:?}",
        r.err()
    );
    assert!(started.elapsed() < Duration::from_secs(1));
}
