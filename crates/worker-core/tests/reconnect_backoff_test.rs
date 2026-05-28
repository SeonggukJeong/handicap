use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use handicap_worker_core::WorkerError;
use handicap_worker_core::reconnect::{SCHEDULE, TOTAL_CAP, retry_with_backoff};
use tokio_util::sync::CancellationToken;

#[test]
fn schedule_matches_spec() {
    // Spec §4.2 requires worker to back off and give up after 60s.
    // The schedule is 1·2·4·8 = 15s for the first four attempts; subsequent
    // attempts repeat 8s. The 60s cap allows roughly 5 more attempts at 8s
    // each (40s) plus the initial 15s = 55s before giving up.
    let expected = [
        Duration::from_secs(1),
        Duration::from_secs(2),
        Duration::from_secs(4),
        Duration::from_secs(8),
    ];
    assert_eq!(SCHEDULE, &expected[..]);
    assert_eq!(TOTAL_CAP, Duration::from_secs(60));
}

/// Drive the retry loop with a synthetic always-failing connector. Under
/// `tokio::time::pause()` the runtime auto-advances virtual time across the
/// `sleep` awaits because the elapsed-time guard inside `retry_with_backoff`
/// uses `tokio::time::Instant` (which tracks paused virtual time), and no
/// real I/O is in flight. The 60 s cap is therefore reached in milliseconds
/// of wall-clock. Using the real `connect_and_register` with a bad URL would
/// NOT auto-advance — tonic's transport spawns I/O tasks that keep the
/// runtime "busy" enough to defeat auto-advance, so the loop would sleep for
/// real seconds. The `retry_with_backoff` indirection (a small public helper
/// in `reconnect.rs`) lets us exercise the policy directly. The production
/// path (`connect_with_backoff`) is a thin wrapper over the same helper, so
/// the schedule/cap behaviour is covered.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn give_up_returns_last_error_after_60s() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_clone = attempts.clone();

    let real_started = std::time::Instant::now();
    let result: Result<(), WorkerError> = retry_with_backoff(
        || {
            let attempts = attempts_clone.clone();
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                Err(WorkerError::SendFailed)
            }
        },
        CancellationToken::new(),
    )
    .await;
    let real_elapsed = real_started.elapsed();

    assert!(result.is_err(), "should give up and return error");
    // With paused time, real wall-clock should be tiny even though tokio
    // saw ~60s of "sleep". This proves the cap fires.
    assert!(
        real_elapsed < Duration::from_secs(5),
        "paused-time loop should not take real time; took {:?}",
        real_elapsed
    );
    // 1+2+4+8 = 15s then repeated 8s; the cap (60s) is reached when the
    // next-sleep guard fires. Verify at least a handful of attempts ran.
    assert!(
        attempts.load(Ordering::SeqCst) >= 4,
        "expected several attempts before give-up, got {}",
        attempts.load(Ordering::SeqCst)
    );
}

/// SIGTERM during `connect_with_backoff` should abort the in-flight backoff
/// sleep promptly (not wait the full 8 s for the next loop iteration). We
/// simulate this by handing `retry_with_backoff` a cancel token, advancing
/// virtual time into the first sleep, then cancelling.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cancel_during_backoff_returns_cancelled() {
    let cancel = CancellationToken::new();
    let cancel_trigger = cancel.clone();

    // Spawn a watchdog that cancels after ~500 ms of virtual time — well
    // inside the first 1 s sleep — so the `select!` inside `retry_with_backoff`
    // takes the `cancel` arm instead of the `sleep` arm.
    let watchdog = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        cancel_trigger.cancel();
    });

    let real_started = std::time::Instant::now();
    let result: Result<(), WorkerError> =
        retry_with_backoff(|| async { Err::<(), _>(WorkerError::SendFailed) }, cancel).await;
    let real_elapsed = real_started.elapsed();
    watchdog.await.ok();

    assert!(
        matches!(result, Err(WorkerError::Cancelled)),
        "expected Err(Cancelled), got {result:?}"
    );
    assert!(
        real_elapsed < Duration::from_secs(5),
        "paused-time cancel path should be near-instant in real time; took {real_elapsed:?}"
    );
}
