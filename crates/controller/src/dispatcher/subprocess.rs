use std::net::SocketAddr;
use std::process::Stdio;

use async_trait::async_trait;
use tokio::process::Command;
use tracing::{info, warn};
use ulid::Ulid;

use super::WorkerDispatcher;
use crate::store::{Db, runs};

/// Spawns a local `handicap-worker` subprocess per dispatched run. Used in
/// local-dev (`cargo run --bin controller`) and existing e2e tests. The
/// Kubernetes variant lives in a sibling module added by a later task.
pub struct SubprocessDispatcher {
    worker_bin: String,
    grpc_addr: SocketAddr,
    db: Db,
}

impl SubprocessDispatcher {
    pub fn new(worker_bin: String, grpc_addr: SocketAddr, db: Db) -> Self {
        Self {
            worker_bin,
            grpc_addr,
            db,
        }
    }
}

#[async_trait]
impl WorkerDispatcher for SubprocessDispatcher {
    async fn dispatch(&self, run_id: &str, worker_count: u32) -> anyhow::Result<()> {
        let controller_url = format!("http://{}", self.grpc_addr);
        for _ in 0..worker_count.max(1) {
            let worker_id = Ulid::new().to_string();
            info!(
                %worker_id,
                %run_id,
                %controller_url,
                worker_bin = %self.worker_bin,
                "spawning worker subprocess"
            );
            let mut cmd = Command::new(&self.worker_bin);
            cmd.arg("--controller")
                .arg(&controller_url)
                .arg("--run-id")
                .arg(run_id)
                .arg("--worker-id")
                .arg(&worker_id)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .kill_on_drop(false);
            let mut child = cmd.spawn()?;

            // Reap in background so the OS doesn't leave zombies. The reaper is
            // also the only component that observes a worker's exit code, so it
            // fails the run on a non-zero exit: a worker that dies before/around
            // gRPC registration (e.g. a stale binary that can't parse a new step
            // type) would otherwise sit `pending` until the 60s registration
            // watchdog. The guarded `mark_failed_if_active` is a no-op when the
            // run is already terminal (completed/aborted, or failed by the gRPC
            // `worker_disconnected` fail-fast that races with this on a
            // post-register crash), so it never clobbers a finished run.
            // (followups "open item A".)
            let run_id_owned = run_id.to_string();
            let pid = child.id();
            let db = self.db.clone();
            tokio::spawn(async move {
                match child.wait().await {
                    Ok(status) => {
                        info!(run_id = %run_id_owned, ?status, ?pid, "worker exited");
                        if !status.success() {
                            let message =
                                format!("worker process exited before completing ({status})");
                            match runs::mark_failed_if_active(&db, &run_id_owned, &message).await {
                                Ok(true) => warn!(
                                    run_id = %run_id_owned, %status,
                                    "worker died before completing the run; marked run failed"
                                ),
                                // Already terminal — the gRPC path finalized it first.
                                Ok(false) => {}
                                Err(e) => warn!(
                                    run_id = %run_id_owned, error = %e,
                                    "failed to mark run failed after worker exit"
                                ),
                            }
                        }
                    }
                    Err(e) => warn!(run_id = %run_id_owned, error = %e, "wait on worker failed"),
                }
            });
        }
        Ok(())
    }

    async fn cleanup(&self, _run_id: &str) -> anyhow::Result<()> {
        // Subprocess dispatcher: the worker self-terminates when the run ends.
        // Nothing to clean up explicitly.
        Ok(())
    }
}
