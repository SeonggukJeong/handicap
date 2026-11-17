use std::sync::Arc;

use handicap_worker_core::WorkerError;
use handicap_worker_core::pool_status::{
    EventSink, FailReason, GRACE, PROBE_TIMEOUT, PoolEvent, PoolState, StatusTracker, classify,
    desktop_retry_delay, probe_first, sanitize_clip, tcp_reachable,
};

#[test]
fn new_tracker_is_connecting() {
    let now = std::time::Instant::now();
    assert_eq!(StatusTracker::default().state(now), PoolState::Connecting);
}

#[tokio::test]
async fn classify_real_connect_error_is_unreachable() {
    let err = tonic::transport::Endpoint::from_static("http://127.0.0.1:1")
        .connect()
        .await
        .unwrap_err();
    assert_eq!(
        classify(&WorkerError::Connect(err)),
        FailReason::Unreachable
    );
}

#[tokio::test]
async fn public_names_are_usable() {
    let _: EventSink = Arc::new(|_| {});
    let _ = (
        PROBE_TIMEOUT,
        GRACE,
        desktop_retry_delay(0),
        sanitize_clip("a", 1),
        PoolEvent::RunEnded,
    );
    assert_eq!(
        probe_first(&[], PROBE_TIMEOUT, |_| async { false }).await,
        None
    );
    assert!(!tcp_reachable("127.0.0.1:1".parse().unwrap()).await);
}
