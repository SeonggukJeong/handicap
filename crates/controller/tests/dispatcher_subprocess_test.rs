//! `SubprocessDispatcher` behavior tests.
//!
//! The earlier version used `/bin/sh` as a fake worker with a comment claiming
//! sh "happily ignores the args and exits 0" — that was false (`/bin/sh
//! --controller …` prints `--controller: invalid option` to stderr and exits
//! non-zero), and the test passed only because `dispatch` does not inspect the
//! child's exit status. We now use the `true` binary, which ignores its args and
//! exits 0 with no output, and add a test proving that a *spawn* failure IS
//! surfaced as `Err` (the path `api::runs::create` relies on for fail-fast —
//! codex eval item 2/3).
#![cfg(unix)]

use std::net::SocketAddr;
use std::sync::Arc;

use handicap_controller::dispatcher::{WorkerDispatcher, subprocess::SubprocessDispatcher};

/// Path to a `true` binary: ignores all (non --help/--version) args and exits 0
/// with no stdout/stderr. A persistent stand-in for the worker binary — unlike a
/// temp fixture it can't be deleted out from under the spawned children.
fn exit_zero_worker() -> String {
    ["/usr/bin/true", "/bin/true"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .expect("no `true` binary at /usr/bin/true or /bin/true")
        .to_string()
}

#[tokio::test]
async fn dispatch_spawns_children_that_exit_zero() {
    let dispatcher = SubprocessDispatcher::new(
        exit_zero_worker(),
        "127.0.0.1:65535".parse::<SocketAddr>().unwrap(),
    );
    let dispatcher: Arc<dyn WorkerDispatcher> = Arc::new(dispatcher);
    // worker_count=2 → the dispatcher loops and spawns two children, each given
    // a distinct internally-generated --worker-id; both exit 0 (args ignored).
    dispatcher.dispatch("run-1", 2).await.expect("dispatch");
    dispatcher.cleanup("run-1").await.expect("cleanup");
}

#[tokio::test]
async fn dispatch_surfaces_spawn_failure() {
    // A missing worker binary must fail the dispatch (not silently succeed) so
    // the run-create handler can mark the run failed and return a 5xx.
    let dispatcher = SubprocessDispatcher::new(
        "/nonexistent/handicap-worker-binary".to_string(),
        "127.0.0.1:65535".parse::<SocketAddr>().unwrap(),
    );
    let dispatcher: Arc<dyn WorkerDispatcher> = Arc::new(dispatcher);
    let result = dispatcher.dispatch("run-1", 1).await;
    assert!(
        result.is_err(),
        "spawning a missing binary must surface an error, got Ok"
    );
}
