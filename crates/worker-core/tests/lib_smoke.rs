//! Placeholder smoke test for handicap-worker-core.
//!
//! Real tests for `reconnect` (exponential backoff) and SIGTERM handling will
//! be added in Slice 6 Tasks 7/8 — they need this crate to be a lib so they
//! can drive `tokio::time::pause()` in unit tests, which is the whole reason
//! Task 0 extracted the lib in the first place.

#[test]
fn lib_smoke() {
    // Exercising the public surface ensures the crate links.
    let _ = std::any::type_name::<handicap_worker_core::WorkerLink>();
    let _ = std::any::type_name::<handicap_worker_core::WorkerError>();
}
