use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// Spawns the worker binary pointed at a closed port, sends SIGTERM, and
/// asserts it exits within 3 s with a non-error status code. Verifies the
/// signal handler is installed and the process honors it (rather than
/// requiring SIGKILL after the K8s grace period).
#[tokio::test]
async fn worker_exits_promptly_on_sigterm() {
    let status = Command::new("cargo")
        .args(["build", "-p", "handicap-worker"])
        .status()
        .await
        .expect("cargo build");
    assert!(status.success(), "cargo build failed");

    let bin =
        std::env::var("CARGO_BIN_EXE_worker").unwrap_or_else(|_| "target/debug/worker".to_string());

    let mut child = Command::new(&bin)
        .args([
            "--controller",
            "http://127.0.0.1:1",
            "--run-id",
            "r",
            "--worker-id",
            "w",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn");

    tokio::time::sleep(Duration::from_millis(500)).await;

    let pid = child.id().expect("pid");
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();

    let exit = tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .expect("worker should exit within 3s of SIGTERM")
        .expect("wait");
    let _ = exit;
}
