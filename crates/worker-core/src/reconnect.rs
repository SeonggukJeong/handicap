use std::future::Future;
use std::time::Duration;

use tokio::time::{Instant, sleep};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::client::{WorkerLink, connect_and_register};
use crate::error::WorkerError;

/// Retry schedule: 1s, 2s, 4s, 8s for the first four attempts; subsequent
/// attempts also wait 8s (the last entry repeats). The total elapsed time
/// is capped at TOTAL_CAP.
pub const SCHEDULE: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
];

/// Give up if cumulative elapsed time (including the next planned sleep)
/// exceeds this. Matches spec §4.2 — workers terminate if disconnected ≥ 60s.
pub const TOTAL_CAP: Duration = Duration::from_secs(60);

/// 접속 재시도 규칙. 재시도 여부는 `is_fatal` 한 곳에서만 정한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryPolicy {
    /// 모든 오류를 재시도한다(풀 워커).
    RetryAll,
    /// 배정 전에 컨트롤러가 Abort를 보냈으면 재시도하지 않는다(run 전용 워커).
    StopOnAbort,
}

impl RetryPolicy {
    /// true면 재시도 없이 그 오류로 즉시 끝낸다.
    pub fn is_fatal(self, e: &WorkerError) -> bool {
        match self {
            RetryPolicy::RetryAll => false,
            RetryPolicy::StopOnAbort => {
                matches!(e, WorkerError::AbortedBeforeAssignment { .. })
            }
        }
    }
}

/// Retry `connect_and_register` with an exponential backoff (1·2·4·8 s, then
/// cap at 8 s) until either it succeeds or the cumulative elapsed time exceeds
/// `TOTAL_CAP` (60 s). On give-up, returns the last error.
///
/// Rationale: in K8s mode the worker Job can start before the controller
/// Service has an endpoint. The 60 s give-up matches spec §4.2.
///
/// `cancel` lets a SIGTERM during the backoff sleep abort the retry loop
/// promptly instead of waiting up to 8 s for the next iteration's check.
/// When cancelled, returns `WorkerError::Cancelled`.
#[allow(clippy::too_many_arguments)]
pub async fn connect_with_backoff(
    controller_url: &str,
    worker_id: &str,
    run_id: &str,
    capacity_vus: u32,
    token: &str,
    hostname: &str,
    stable: bool,
    cancel: CancellationToken,
    policy: RetryPolicy,
) -> Result<WorkerLink, WorkerError> {
    let token = token.to_string();
    let hostname = hostname.to_string();
    let cancel_for_attempt = cancel.clone();
    retry_with_backoff_policy(
        || {
            connect_and_register(
                controller_url,
                worker_id,
                run_id,
                capacity_vus,
                &token,
                &hostname,
                stable,
                &cancel_for_attempt,
            )
        },
        cancel,
        policy,
    )
    .await
}

/// Generic retry loop driving any `Future<Output = Result<T, WorkerError>>`
/// factory through the `SCHEDULE` / `TOTAL_CAP` policy. Extracted from
/// `connect_with_backoff` so unit tests can drive it with a synthetic
/// connector that fails instantly (no real tonic I/O), letting
/// `tokio::time::pause()` auto-advance virtual time. Public for the same
/// testing reason — production code should call `connect_with_backoff`.
///
/// Uses `tokio::time::Instant` (not `std::time::Instant`) so the elapsed-time
/// guard is consistent with the virtual clock that `tokio::time::sleep` and
/// `tokio::time::pause` operate on. In production `tokio::time::Instant`
/// reads the wall clock; under `start_paused = true` it tracks the (paused +
/// auto-advancing) virtual clock, which is what makes the unit test finish
/// in milliseconds of real wall-clock.
///
/// `cancel` is checked at two points: (1) at the top of every loop iteration
/// so a token cancelled before the first attempt short-circuits, and (2) via
/// `tokio::select!` while sleeping between attempts so a SIGTERM mid-sleep
/// aborts within microseconds instead of up to 8 s. On either path the
/// function returns `WorkerError::Cancelled` so callers can distinguish a
/// graceful shutdown from a real connect failure.
pub async fn retry_with_backoff<F, Fut, T>(
    attempt_fn: F,
    cancel: CancellationToken,
) -> Result<T, WorkerError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, WorkerError>>,
{
    retry_with_backoff_policy(attempt_fn, cancel, RetryPolicy::RetryAll).await
}

/// `retry_with_backoff`와 같되 `policy.is_fatal`인 오류는 재시도하지 않고 즉시 돌려준다.
pub async fn retry_with_backoff_policy<F, Fut, T>(
    mut attempt_fn: F,
    cancel: CancellationToken,
    policy: RetryPolicy,
) -> Result<T, WorkerError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, WorkerError>>,
{
    let started = Instant::now();
    let mut attempt: usize = 0;
    loop {
        if cancel.is_cancelled() {
            return Err(WorkerError::Cancelled);
        }
        match attempt_fn().await {
            Ok(value) => {
                if attempt > 0 {
                    info!(
                        attempt,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        "connected after retries"
                    );
                }
                return Ok(value);
            }
            Err(e) => {
                if policy.is_fatal(&e) {
                    return Err(e);
                }
                let delay = SCHEDULE
                    .get(attempt)
                    .copied()
                    .unwrap_or_else(|| *SCHEDULE.last().unwrap());
                let elapsed = started.elapsed();
                if elapsed + delay > TOTAL_CAP {
                    warn!(
                        error = %e,
                        attempt,
                        elapsed_s = elapsed.as_secs(),
                        "gave up after 60s"
                    );
                    return Err(e);
                }
                warn!(
                    error = %e,
                    attempt,
                    sleep_ms = delay.as_millis() as u64,
                    "controller unreachable, retrying"
                );
                tokio::select! {
                    _ = sleep(delay) => { attempt += 1; }
                    _ = cancel.cancelled() => return Err(WorkerError::Cancelled),
                }
            }
        }
    }
}
