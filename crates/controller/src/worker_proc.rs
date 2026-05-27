use std::net::SocketAddr;
use std::process::Stdio;

use tokio::process::Command;
use tracing::{info, warn};
use ulid::Ulid;

pub async fn spawn_worker(
    worker_bin: &str,
    grpc_addr: SocketAddr,
    run_id: &str,
) -> anyhow::Result<()> {
    let worker_id = Ulid::new().to_string();
    let controller_url = format!("http://{}", grpc_addr);
    info!(%worker_id, %run_id, %controller_url, worker_bin, "spawning worker subprocess");

    // We do not await the child — the worker self-terminates when the run ends.
    let mut cmd = Command::new(worker_bin);
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

    // Reap in background so the OS doesn't leave zombies — log exit code.
    let run_id = run_id.to_string();
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => info!(%run_id, ?status, "worker exited"),
            Err(e) => warn!(%run_id, error = %e, "wait on worker failed"),
        }
    });

    Ok(())
}
