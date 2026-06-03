//! Think time (요청/반복 간 페이싱) for closed-loop runs. The delay is applied by
//! the interpreter (`runner::execute_steps` / `trace::trace_steps`), NOT by the
//! executor — `execute_step` stays byte-identical. Absent → no sleep.

use std::time::{Duration, Instant};

use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// Per-iteration (Profile) or per-step (HttpStep) delay. `min_ms == max_ms` → a
/// fixed delay; `min_ms < max_ms` → uniform random in `[min_ms, max_ms]` (both
/// ends inclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThinkTime {
    pub min_ms: u32,
    pub max_ms: u32,
}

impl ThinkTime {
    /// Draw one delay. Generic over the RNG so the load path passes a seeded
    /// `StdRng` and the trace path passes `thread_rng()`. Lenient: if `max < min`
    /// (should be blocked by validation) it clamps to a fixed `min` — never panics.
    pub fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> Duration {
        let max = self.max_ms.max(self.min_ms);
        let ms = if max == self.min_ms {
            self.min_ms
        } else {
            rng.gen_range(self.min_ms..=max)
        };
        Duration::from_millis(u64::from(ms))
    }
}

/// Result of a paced sleep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaceOutcome {
    /// Slept the requested duration (or 0) within the window.
    Slept,
    /// `cancel` fired during the sleep — caller should abort.
    Cancelled,
    /// The run deadline was hit (sleep clamped) — caller should end the iteration.
    DeadlineReached,
}

/// Sleep `dur`, racing `cancel` and clamping to `deadline` so think time never
/// hangs past the run window or an abort. Mirrors the ramp loop's
/// `tokio::select! { sleep, cancel }` (runner.rs).
pub async fn pace(dur: Duration, deadline: Instant, cancel: &CancellationToken) -> PaceOutcome {
    let now = Instant::now();
    if now >= deadline {
        return PaceOutcome::DeadlineReached;
    }
    let remaining = deadline - now;
    let capped = dur.min(remaining);
    if capped.is_zero() {
        return PaceOutcome::Slept;
    }
    tokio::select! {
        _ = tokio::time::sleep(capped) => {
            if dur > remaining { PaceOutcome::DeadlineReached } else { PaceOutcome::Slept }
        }
        _ = cancel.cancelled() => PaceOutcome::Cancelled,
    }
}
