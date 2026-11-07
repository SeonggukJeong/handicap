//! 종료 신호(SIGHUP/SIGTERM/SIGINT) 처리 — 창 닫기·로그아웃이 `Drop`을 건너뛰어 임시 DB(환경 값 포함)를
//! 남기지 않게, 신호를 정상 종료 경로(세션 종료 → TempDb drop → 터미널 복구)로 돌린다.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::runtime::Runtime;

/// 세 종료 신호의 수신기. 생성 시점에 핸들러가 걸린다(이후 신호는 기본 동작=즉사가 아니다).
pub struct Signals {
    #[cfg(unix)]
    streams: Option<[tokio::signal::unix::Signal; 3]>,
}

impl Signals {
    /// 런타임 컨텍스트 안에서 부른다. 핸들러를 못 걸면 신호 처리 없이 진행한다(경고 로그).
    pub fn new() -> Signals {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let streams = match (
                signal(SignalKind::hangup()),
                signal(SignalKind::terminate()),
                signal(SignalKind::interrupt()),
            ) {
                (Ok(a), Ok(b), Ok(c)) => Some([a, b, c]),
                _ => {
                    tracing::warn!("종료 신호 핸들러를 걸지 못했습니다");
                    None
                }
            };
            Signals { streams }
        }
        #[cfg(not(unix))]
        Signals {}
    }

    /// 신호가 올 때까지 기다린다.
    pub async fn recv(&mut self) {
        #[cfg(unix)]
        {
            let Some([hup, term, int]) = self.streams.as_mut() else {
                return std::future::pending().await;
            };
            tokio::select! {
                _ = hup.recv() => {}
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

impl Default for Signals {
    fn default() -> Self {
        Self::new()
    }
}

/// 신호 뒤 정상 종료에 줄 시간 — 넘기면 감시견이 강제 정리한다.
pub const GRACE: Duration = Duration::from_secs(5);

/// 신호를 받으면 `true`가 되는 플래그. 핸들러는 이 함수가 돌아오기 전에 이미 걸려 있다.
/// 메인 루프가 신호 뒤 `GRACE` 안에 끝나지 못하면(터미널 읽기에서 막히는 등) 임시 DB를 지우고
/// 터미널을 되돌린 뒤 exit 1로 강제 종료한다.
pub fn install(rt: &Runtime) -> Arc<AtomicBool> {
    install_with(rt, GRACE, force_exit)
}

fn force_exit() {
    // 비밀(환경 값)이 든 DB 삭제가 먼저 — 막힌 로그 쓰기가 삭제를 늦추면 안 된다.
    crate::tempdb::remove_active();
    crate::terminal::restore();
    tracing::error!(
        "정상 종료가 {}초 안에 끝나지 않아 강제 정리했습니다",
        GRACE.as_secs()
    );
    std::process::exit(1);
}

/// `install`의 시간·동작 주입판(테스트용).
pub fn install_with(
    rt: &Runtime,
    grace: Duration,
    on_timeout: impl FnOnce() + Send + 'static,
) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let f = flag.clone();
    let mut sigs = {
        let _g = rt.enter();
        Signals::new()
    };
    rt.spawn(async move {
        sigs.recv().await;
        tracing::info!("종료 신호를 받았습니다 — 정상 종료합니다");
        f.store(true, Ordering::SeqCst);
        // 런타임이 막혀도 동작하도록 별도 스레드. 정상 종료하면 프로세스째 사라진다.
        std::thread::spawn(move || {
            std::thread::sleep(grace);
            on_timeout();
        });
    });
    flag
}
