#![cfg(feature = "slice6-k8s")]

use handicap_controller::dispatcher::{WorkerDispatcher, kubernetes::KubernetesDispatcher};
use k8s_openapi::api::batch::v1::Job;
use kube::api::{Api, ListParams};
use kube::client::Client;

/// Requires a reachable cluster (KUBECONFIG points at a real or kind cluster).
/// Run with: `cargo test -p handicap-controller --features slice6-k8s --test dispatcher_kubernetes_test`.
#[tokio::test]
async fn dispatch_creates_a_labeled_job_and_cleanup_removes_it() {
    let ns = std::env::var("HANDICAP_TEST_NS").unwrap_or_else(|_| "default".into());
    let dispatcher = KubernetesDispatcher::try_new(
        ns.clone(),
        "handicap-test".into(),
        "busybox:1.36".into(),
        "http://example.invalid:8081".into(),
    )
    .await
    .expect("dispatcher");
    let run_id = format!("test-run-{}", ulid::Ulid::new());
    let worker_id = format!("test-worker-{}", ulid::Ulid::new());

    dispatcher
        .dispatch(&run_id, &worker_id)
        .await
        .expect("dispatch");

    let client = Client::try_default().await.expect("client");
    let api: Api<Job> = Api::namespaced(client, &ns);
    let list = api
        .list(&ListParams::default().labels(&format!("handicap.io/run-id={}", run_id)))
        .await
        .expect("list");
    assert_eq!(list.items.len(), 1, "exactly one Job per run");

    dispatcher.cleanup(&run_id).await.expect("cleanup");

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let list2 = api
        .list(&ListParams::default().labels(&format!("handicap.io/run-id={}", run_id)))
        .await
        .expect("list2");
    assert!(list2.items.is_empty(), "cleanup must remove the Job");
}
