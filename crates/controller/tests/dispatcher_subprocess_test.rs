use std::net::SocketAddr;
use std::sync::Arc;

use handicap_controller::dispatcher::{WorkerDispatcher, subprocess::SubprocessDispatcher};

#[tokio::test]
async fn dispatch_spawns_a_child_that_exits_zero() {
    // Use `/bin/sh` as a placeholder "worker" so the test is fast and
    // hermetic — we only assert that the dispatcher returns Ok and doesn't
    // panic, not that a real handicap-worker registered. `sh` will happily
    // ignore the `--controller`, `--run-id`, `--worker-id` args we hand it
    // and exit 0.
    let dispatcher = SubprocessDispatcher::new(
        "/bin/sh".to_string(),
        "127.0.0.1:65535".parse::<SocketAddr>().unwrap(),
    );
    let dispatcher: Arc<dyn WorkerDispatcher> = Arc::new(dispatcher);
    dispatcher
        .dispatch("run-1", "worker-1")
        .await
        .expect("dispatch");
    // Cleanup is a no-op; just ensure it doesn't panic.
    dispatcher.cleanup("run-1").await.expect("cleanup");
}
