use handicap_engine::{PaceOutcome, ThinkTime, pace};
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[test]
fn sample_fixed_when_min_eq_max() {
    let tt = ThinkTime {
        min_ms: 250,
        max_ms: 250,
    };
    let mut rng = StdRng::seed_from_u64(1);
    assert_eq!(tt.sample(&mut rng), Duration::from_millis(250));
}

#[test]
fn sample_in_range_inclusive() {
    let tt = ThinkTime {
        min_ms: 100,
        max_ms: 200,
    };
    let mut rng = StdRng::seed_from_u64(7);
    for _ in 0..200 {
        let d = tt.sample(&mut rng).as_millis() as u32;
        assert!((100..=200).contains(&d), "sample {d} out of [100,200]");
    }
}

#[test]
fn sample_reproducible_for_same_seed() {
    let tt = ThinkTime {
        min_ms: 0,
        max_ms: 1000,
    };
    let seq = |seed| {
        let mut rng = StdRng::seed_from_u64(seed);
        (0..5)
            .map(|_| tt.sample(&mut rng).as_millis())
            .collect::<Vec<_>>()
    };
    assert_eq!(seq(42), seq(42));
    assert_ne!(seq(42), seq(43));
}

#[test]
fn sample_clamps_inverted_range() {
    // lenient: max < min → behaves as fixed min (run must not die).
    let tt = ThinkTime {
        min_ms: 300,
        max_ms: 100,
    };
    let mut rng = StdRng::seed_from_u64(1);
    assert_eq!(tt.sample(&mut rng), Duration::from_millis(300));
}

#[tokio::test(start_paused = true)]
async fn pace_sleeps_full_duration_when_within_window() {
    let cancel = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    let start = Instant::now();
    let out = pace(Duration::from_millis(500), deadline.into_std(), &cancel).await;
    assert!(matches!(out, PaceOutcome::Slept));
    assert_eq!(start.elapsed(), Duration::from_millis(500));
}

#[tokio::test(start_paused = true)]
async fn pace_returns_cancelled_immediately_on_cancel() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let deadline = Instant::now() + Duration::from_secs(60);
    let out = pace(Duration::from_secs(10), deadline.into_std(), &cancel).await;
    assert!(matches!(out, PaceOutcome::Cancelled));
}

#[tokio::test(start_paused = true)]
async fn pace_clamps_to_deadline() {
    let cancel = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_millis(100);
    let out = pace(Duration::from_secs(10), deadline.into_std(), &cancel).await;
    assert!(matches!(out, PaceOutcome::DeadlineReached));
}

#[tokio::test(start_paused = true)]
async fn pace_returns_slept_for_zero_duration() {
    let cancel = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    let out = pace(Duration::ZERO, deadline.into_std(), &cancel).await;
    assert!(matches!(out, PaceOutcome::Slept));
}

#[tokio::test(start_paused = true)]
async fn pace_deadline_already_past_returns_deadline_reached() {
    let cancel = CancellationToken::new();
    // deadline strictly in the past relative to std::time → early return
    let past = std::time::Instant::now() - Duration::from_millis(1);
    let out = pace(Duration::from_secs(1), past, &cancel).await;
    assert!(matches!(out, PaceOutcome::DeadlineReached));
}
