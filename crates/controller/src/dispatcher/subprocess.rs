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
    /// `worker_bin` 뒤·`--controller` 앞에 끼울 선행 인자(멀티콜 서브커맨드용). 기본 빈 벡터.
    leading_args: Vec<String>,
}

impl SubprocessDispatcher {
    pub fn new(worker_bin: String, grpc_addr: SocketAddr, db: Db) -> Self {
        Self {
            worker_bin,
            grpc_addr,
            db,
            leading_args: Vec::new(),
        }
    }

    /// 멀티콜 self-spawn용: spawn 명령에 선행 인자(예 `["worker"]`)를 끼운다.
    pub fn with_leading_args(mut self, args: Vec<String>) -> Self {
        self.leading_args = args;
        self
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
            let cmd_args =
                worker_command_args(&self.leading_args, &controller_url, run_id, &worker_id);
            let mut cmd = Command::new(&self.worker_bin);
            cmd.args(&cmd_args)
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

/// worker spawn 인자열을 만든다: [leading…] ++ --controller URL --run-id ID --worker-id WID.
fn worker_command_args(
    leading: &[String],
    controller_url: &str,
    run_id: &str,
    worker_id: &str,
) -> Vec<String> {
    let mut v: Vec<String> = leading.to_vec();
    v.push("--controller".into());
    v.push(controller_url.into());
    v.push("--run-id".into());
    v.push(run_id.into());
    v.push("--worker-id".into());
    v.push(worker_id.into());
    v
}

#[cfg(test)]
mod tests {
    use super::worker_command_args;

    #[test]
    fn default_no_leading_args_byte_identical() {
        let a = worker_command_args(&[], "http://127.0.0.1:8081", "r1", "w1");
        assert_eq!(
            a,
            vec![
                "--controller",
                "http://127.0.0.1:8081",
                "--run-id",
                "r1",
                "--worker-id",
                "w1"
            ]
        );
    }

    #[test]
    fn leading_worker_subcommand_prepended() {
        let a = worker_command_args(&["worker".into()], "http://127.0.0.1:8081", "r1", "w1");
        assert_eq!(a[0], "worker");
        assert_eq!(&a[1..3], &["--controller", "http://127.0.0.1:8081"]);
    }
}
