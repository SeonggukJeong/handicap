//! Reusable worker library: gRPC connect/register, error types, and (in later
//! Slice 6 tasks) reconnect + signal handling.
//!
//! Extracted from the `handicap-worker` binary so reconnect/signal logic can
//! be exercised by `tokio::time::pause()` unit tests — a bin-only crate can't
//! host `#[tokio::test]` against private modules ergonomically.

pub mod client;
pub mod error;
pub mod pool_status;
pub mod reconnect;

pub use client::{
    RegisterOpts, WorkerLink, connect_and_register, connect_and_register_opts, load_datasets,
};
pub use error::WorkerError;
pub use reconnect::{
    RetryPolicy, connect_with_backoff, retry_with_backoff, retry_with_backoff_policy,
};
