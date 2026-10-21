use std::sync::Arc;

use tokio_util::sync::CancellationToken;

/// 운영실 모니터 감독자. Task 3은 `AppState` 배선용 스텁 — 내부는 Task 4에서 채운다.
#[derive(Clone, Default)]
pub struct MonitorSupervisor {
    #[allow(dead_code)]
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {}

impl MonitorSupervisor {
    /// 루트 취소 토큰은 Task 4에서 필드로 보관한다(지금은 읽히지 않는 필드가 dead_code라 무시).
    pub fn with_root(_token: CancellationToken) -> Self {
        Self::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_constructible() {
        let s = MonitorSupervisor::default();
        let _c = s.clone();
        let _r = MonitorSupervisor::with_root(tokio_util::sync::CancellationToken::new());
    }
}
