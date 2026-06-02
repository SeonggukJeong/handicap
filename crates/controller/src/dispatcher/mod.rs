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

/// A dispatcher that starts no workers and always reports success. The run is
/// accepted (201) but stays `pending` because no worker ever registers.
///
/// Used by API/integration tests that exercise run-create without a real worker
/// (now that genuine dispatch failure is authoritative — see `api::runs::create`
/// and `cancel_dispatch_failed`, codex eval item 2). A `SubprocessDispatcher`
/// pointed at a missing binary now (correctly) fails the run, so tests that want
/// a successful create use this instead.
pub struct NoopDispatcher;

#[async_trait]
impl WorkerDispatcher for NoopDispatcher {
    async fn dispatch(&self, _run_id: &str, _worker_count: u32) -> anyhow::Result<()> {
        Ok(())
    }
    async fn cleanup(&self, _run_id: &str) -> anyhow::Result<()> {
        Ok(())
    }
}
