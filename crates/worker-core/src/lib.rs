//! Reusable worker library: gRPC connect/register, error types, and (in later
//! Slice 6 tasks) reconnect + signal handling.
//!
//! Extracted from the `handicap-worker` binary so reconnect/signal logic can
//! be exercised by `tokio::time::pause()` unit tests — a bin-only crate can't
//! host `#[tokio::test]` against private modules ergonomically.

pub mod client;
pub mod error;

pub use client::{WorkerLink, connect_and_register};
pub use error::WorkerError;
