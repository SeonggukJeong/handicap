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

    // Wait long enough for the worker's tokio runtime to start and install
    // the SIGTERM handler. On cold caches the runtime + signal driver setup
    // can take >500 ms; 1.5 s leaves margin while keeping the test snappy.
    // Without this, SIGTERM arrives before the handler is armed and the
    // kernel's default action (terminate with status 15) kicks in, which
    // is precisely the bug this test guards against — so the wait must
    // exceed handler-install latency for the assertion below to be honest.
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let pid = child.id().expect("pid");
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();

    let exit = tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .expect("worker should exit within 3s of SIGTERM")
        .expect("wait");
    // After installing the SIGTERM handler before `connect_with_backoff`,
    // SIGTERM during the backoff sleep cancels the retry loop, which returns
    // `Err(WorkerError::Cancelled)`. main.rs maps that to `return Ok(())`,
    // i.e. exit 0. If the handler had not run (the kernel default SIGTERM
    // action) the exit status would be 143 (128 + SIGTERM=15) instead.
    assert_eq!(
        exit.code(),
        Some(0),
        "expected clean exit from SIGTERM handler, got {exit:?}"
    );
}
