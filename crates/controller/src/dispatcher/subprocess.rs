use std::net::SocketAddr;
use std::process::Stdio;

use async_trait::async_trait;
use tokio::process::Command;
use tracing::{info, warn};

use super::WorkerDispatcher;

/// Spawns a local `handicap-worker` subprocess per dispatched run. Used in
/// local-dev (`cargo run --bin controller`) and existing e2e tests. The
/// Kubernetes variant lives in a sibling module added by a later task.
pub struct SubprocessDispatcher {
    worker_bin: String,
    grpc_addr: SocketAddr,
}

impl SubprocessDispatcher {
    pub fn new(worker_bin: String, grpc_addr: SocketAddr) -> Self {
        Self {
            worker_bin,
            grpc_addr,
        }
    }
}

#[async_trait]
impl WorkerDispatcher for SubprocessDispatcher {
    async fn dispatch(&self, run_id: &str, worker_id: &str) -> anyhow::Result<()> {
        let controller_url = format!("http://{}", self.grpc_addr);
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
            .arg(worker_id)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(false);
        let mut child = cmd.spawn()?;

        // Reap in background so the OS doesn't leave zombies.
        let run_id_owned = run_id.to_string();
        let pid = child.id();
        tokio::spawn(async move {
            match child.wait().await {
                Ok(status) => info!(run_id = %run_id_owned, ?status, ?pid, "worker exited"),
                Err(e) => warn!(run_id = %run_id_owned, error = %e, "wait on worker failed"),
            }
        });
        Ok(())
    }

    async fn cleanup(&self, _run_id: &str) -> anyhow::Result<()> {
        // Subprocess dispatcher: the worker self-terminates when the run ends.
        // Nothing to clean up explicitly.
        Ok(())
    }
}
