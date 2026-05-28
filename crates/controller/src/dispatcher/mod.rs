use std::sync::Arc;

use async_trait::async_trait;

pub mod subprocess;

/// A `WorkerDispatcher` knows how to start a worker process for a run, and
/// how to clean up after the run finishes. Implementations are swappable at
/// startup via `--worker-mode`.
#[async_trait]
pub trait WorkerDispatcher: Send + Sync {
    /// Start a worker for the given run. Returns `Ok(())` if the worker was
    /// asked to start; it may not have registered with the coordinator yet.
    /// Errors here surface to the REST `POST /api/runs` caller as a 500.
    async fn dispatch(&self, run_id: &str, worker_id: &str) -> anyhow::Result<()>;

    /// Tear down any external state (K8s Job, child handle) associated with
    /// the run. MUST be idempotent — the controller calls `cleanup` from
    /// multiple paths (run completion, abort, controller restart).
    async fn cleanup(&self, run_id: &str) -> anyhow::Result<()>;
}

/// Shared handle held by `AppState`.
pub type SharedDispatcher = Arc<dyn WorkerDispatcher>;
