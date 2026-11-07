//! 종료 신호(SIGHUP/SIGTERM/SIGINT) 처리 — 창 닫기·로그아웃이 `Drop`을 건너뛰어 임시 DB(환경 값 포함)를
//! 남기지 않게, 신호를 정상 종료 경로(세션 종료 → TempDb drop → 터미널 복구)로 돌린다.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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

/// 신호를 받으면 `true`가 되는 플래그. 핸들러는 이 함수가 돌아오기 전에 이미 걸려 있다.
pub fn install(rt: &Runtime) -> Arc<AtomicBool> {
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
    });
    flag
}
