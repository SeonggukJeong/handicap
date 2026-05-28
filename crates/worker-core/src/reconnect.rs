use std::future::Future;
use std::time::Duration;

use tokio::time::{Instant, sleep};
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

/// Retry `connect_and_register` with an exponential backoff (1·2·4·8 s, then
/// cap at 8 s) until either it succeeds or the cumulative elapsed time exceeds
/// `TOTAL_CAP` (60 s). On give-up, returns the last error.
///
/// Rationale: in K8s mode the worker Job can start before the controller
/// Service has an endpoint. The 60 s give-up matches spec §4.2.
pub async fn connect_with_backoff(
    controller_url: &str,
    worker_id: &str,
    run_id: &str,
    capacity_vus: u32,
) -> Result<WorkerLink, WorkerError> {
    retry_with_backoff(|| connect_and_register(controller_url, worker_id, run_id, capacity_vus))
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
pub async fn retry_with_backoff<F, Fut, T>(mut attempt_fn: F) -> Result<T, WorkerError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, WorkerError>>,
{
    let started = Instant::now();
    let mut attempt: usize = 0;
    loop {
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
                sleep(delay).await;
                attempt += 1;
            }
        }
    }
}
