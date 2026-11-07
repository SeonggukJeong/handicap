//! `/status` 폴러와 서버 끊김 판정.

use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::api::Api;
use crate::wire::StatusResponse;

/// 연속 실패가 이 횟수 이상이면 서버 응답 없음.
pub const SERVER_DOWN_AFTER: u32 = 3;
pub const POLL_INTERVAL: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone)]
pub enum PollOutcome {
    Ok(StatusResponse),
    NotFound,
    Failed,
}

#[derive(Debug, Default, Clone)]
pub struct ServerDownTracker {
    failures: u32,
}

impl ServerDownTracker {
    pub fn record(&mut self, o: &PollOutcome) {
        match o {
            PollOutcome::Ok(_) => self.failures = 0,
            PollOutcome::Failed => self.failures = self.failures.saturating_add(1),
            PollOutcome::NotFound => {}
        }
    }

    pub fn is_down(&self) -> bool {
        self.failures >= SERVER_DOWN_AFTER
    }
}

#[derive(Debug, Clone, Default)]
pub struct PollSnapshot {
    pub board_id: String,
    pub last: Option<StatusResponse>,
    pub server_down: bool,
}

pub async fn poll_once(api: &Api, board_id: &str) -> PollOutcome {
    match api.status(board_id).await {
        Ok(s) => PollOutcome::Ok(s),
        Err(e) if e.status == Some(404) => PollOutcome::NotFound,
        Err(_) => PollOutcome::Failed,
    }
}

/// 보이는 보드(`board`의 현재 값)만 1초마다 폴링한다. 보드가 바뀌면 이전 결과를 버린다.
pub fn spawn_poller(
    api: Api,
    board: watch::Receiver<String>,
    tx: watch::Sender<PollSnapshot>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut tracker = ServerDownTracker::default();
        let mut current = String::new();
        let mut last: Option<StatusResponse> = None;
        loop {
            let id = board.borrow().clone();
            if id != current {
                current = id.clone();
                last = None;
            }
            let outcome = poll_once(&api, &id).await;
            tracker.record(&outcome);
            match outcome {
                PollOutcome::Ok(s) => last = Some(s),
                PollOutcome::NotFound => last = None,
                PollOutcome::Failed => {}
            }
            let snap = PollSnapshot {
                board_id: id,
                last: last.clone(),
                server_down: tracker.is_down(),
            };
            if tx.send(snap).is_err() {
                return;
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_down_after_three() {
        let mut t = ServerDownTracker::default();
        t.record(&PollOutcome::Failed);
        t.record(&PollOutcome::Failed);
        assert!(!t.is_down());
        t.record(&PollOutcome::Failed);
        assert!(t.is_down());
    }

    #[test]
    fn not_found_does_not_count() {
        let mut t = ServerDownTracker::default();
        t.record(&PollOutcome::Failed);
        t.record(&PollOutcome::Failed);
        for _ in 0..5 {
            t.record(&PollOutcome::NotFound);
        }
        assert!(!t.is_down());
    }

    #[test]
    fn not_found_neither_counts_nor_resets() {
        let mut t = ServerDownTracker::default();
        t.record(&PollOutcome::Failed);
        t.record(&PollOutcome::Failed);
        t.record(&PollOutcome::NotFound);
        t.record(&PollOutcome::Failed);
        assert!(t.is_down());
    }

    #[test]
    fn ok_resets() {
        let mut t = ServerDownTracker::default();
        for _ in 0..3 {
            t.record(&PollOutcome::Failed);
        }
        assert!(t.is_down());
        let ok = StatusResponse {
            now_ms: 0,
            board_updated_at: 0,
            enabled: true,
            started_at_ms: None,
            panels: vec![],
        };
        t.record(&PollOutcome::Ok(ok));
        assert!(!t.is_down());
    }
}
