#![cfg(feature = "in-process")]
//! US4 (서버→로컬→서버, 실패한 전환의 서버 복원): 같은 프로세스에서 풀 모드 컨트롤러를
//! 끄고 같은 gRPC 포트로 새 컨트롤러를 띄우면, 기다리던 원격 풀 워커가 새 컨트롤러에
//! 다시 등록돼야 한다. 옛 컨트롤러의 워커 스트림 처리기가 종료 신호 없이 살아 있으면
//! 워커는 죽은 컨트롤러에 붙은 채 영영 돌아오지 않는다(최종 리뷰 I1).

use std::time::Duration;

use handicap_controller::in_process::{
    InProcessConfig, InProcessWorkerMode, RunningController, run_in_process,
};
use tokio_util::sync::CancellationToken;

const TOKEN: &str = "t";
const WORKER_ID: &str = "rejoin-w1";

fn tmp_db() -> String {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("c.db").display().to_string();
    std::mem::forget(tmp);
    p
}

async fn start_pool(grpc_port: u16) -> RunningController {
    run_in_process(InProcessConfig {
        db: Some(tmp_db()),
        scheduler_disabled: true,
        worker_mode: InProcessWorkerMode::Pool,
        worker_token: Some(TOKEN.into()),
        grpc: std::net::SocketAddr::from(([127, 0, 0, 1], grpc_port)),
        grpc_port_fallback: false,
        ..InProcessConfig::default()
    })
    .await
    .expect("start pool controller")
}

async fn wait_for_worker(rc: &RunningController, within: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        if rc
            .pool_workers()
            .await
            .iter()
            .any(|w| w.worker_id == WORKER_ID)
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn idle_pool_worker_rejoins_next_controller_on_same_port() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };

    let first = start_pool(port).await;

    let cancel = CancellationToken::new();
    let worker = tokio::spawn(handicap_worker::run_pool_until(
        handicap_worker::WorkerArgs {
            controller: format!("http://127.0.0.1:{port}"),
            run_id: None,
            worker_id: Some(WORKER_ID.into()),
            capacity_vus: 10,
            token: Some(TOKEN.into()),
        },
        cancel.clone(),
    ));

    assert!(
        wait_for_worker(&first, Duration::from_secs(10)).await,
        "worker must register with the first controller"
    );

    tokio::time::timeout(Duration::from_secs(15), first.shutdown())
        .await
        .expect("shutdown must not hang");
    drop(first);

    let second = start_pool(port).await;
    // worker-core 재연결 간격은 1·2·4·8초 — 첫 재시도(1s)가 새 컨트롤러에 닿는다.
    // 연결이 끊긴 걸 알아차린 뒤 두 번째 재시도까지 여유를 둔 15초.
    let rejoined = wait_for_worker(&second, Duration::from_secs(15)).await;

    cancel.cancel();
    second.shutdown().await;
    let _ = tokio::time::timeout(Duration::from_secs(10), worker).await;

    assert!(
        rejoined,
        "idle pool worker must re-register with the next controller on the same gRPC port"
    );
}
