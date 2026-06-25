//! controller 실행 추상(R7) + in-process 구현(접근 2). 셸(lib.rs)은 트레잇의
//! base_url()/shutdown()에만 의존 → 사이드카(접근 1)는 제거, in-process가 유일 구현.

use handicap_controller::in_process::{InProcessConfig, RunningController, run_in_process};

/// controller 실행 백엔드 추상. LAN 전방호환 위해 트레잇 경계 유지(R7).
pub trait ControllerBackend: Send + Sync {
    /// 창이 navigate할 베이스 URL(`http://127.0.0.1:<port>/`).
    fn base_url(&self) -> String;
    /// 종료 시 호출 — controller graceful shutdown(active run abort → drain).
    fn shutdown(&self);
}

/// 컨트롤러를 Tauri 프로세스에 in-process 임베드. `RunningController`(슬라이스 1)를 보유한다.
pub struct InProcessBackend {
    rc: RunningController,
    base_url: String,
}

// `Box<dyn ControllerBackend>`(managed state)로 쓰이려면 Send+Sync 필요 — 컴파일타임 고정.
// RunningController가 비-Send/Sync가 되면 여기서 즉시 에러(조기 신호).
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<InProcessBackend>();
};

impl InProcessBackend {
    /// in-process 컨트롤러 부팅(REST/gRPC 사전바인딩·serve/scheduler/heartbeat spawn) →
    /// 실제 REST 포트로 base_url 캐시. 실패(bind/DB/migration)면 Err → 호출자가 splash에 표시.
    pub async fn start(cfg: InProcessConfig) -> anyhow::Result<InProcessBackend> {
        let rc = run_in_process(cfg).await?;
        let base_url = crate::launch::base_url(rc.rest_addr().port());
        Ok(InProcessBackend { rc, base_url })
    }
}

impl ControllerBackend for InProcessBackend {
    fn base_url(&self) -> String {
        self.base_url.clone()
    }

    fn shutdown(&self) {
        // RunningController::shutdown()은 async·bounded(슬라이스 1 §6 — 절대 hang 안 함).
        // RunEvent::Exit는 메인(이벤트루프) 스레드라 tokio 워커가 아님 → block_on 안전(nested-runtime 없음).
        tauri::async_runtime::block_on(self.rc.shutdown());
    }
}
