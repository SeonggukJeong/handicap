use std::sync::Arc;

use async_trait::async_trait;

pub mod k8s_spec;
pub mod kubernetes;
pub mod subprocess;

/// A `WorkerDispatcher` knows how to start a worker process for a run, and
/// how to clean up after the run finishes. Implementations are swappable at
/// startup via `--worker-mode`.
#[async_trait]
pub trait WorkerDispatcher: Send + Sync {
    /// Start `worker_count` workers for the given run. Each implementation owns
    /// worker-id generation (subprocess: N distinct ULIDs; K8s: Indexed Job).
    /// Returns `Ok(())` once the workers were asked to start. (A3a spec §7.1.)
    async fn dispatch(&self, run_id: &str, worker_count: u32) -> anyhow::Result<()>;

    /// Tear down any external state (K8s Job, child handle) associated with
    /// the run. MUST be idempotent — the controller calls `cleanup` from
    /// multiple paths (run completion, abort, controller restart).
    async fn cleanup(&self, run_id: &str) -> anyhow::Result<()>;
}

/// Shared handle held by `AppState`.
pub type SharedDispatcher = Arc<dyn WorkerDispatcher>;
