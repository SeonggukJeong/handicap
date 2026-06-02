use async_trait::async_trait;
use k8s_openapi::api::batch::v1::Job;
use kube::api::{Api, DeleteParams, ListParams, PostParams};
use kube::client::Client;
use tracing::{info, warn};
use ulid::Ulid;

use super::{
    WorkerDispatcher,
    k8s_spec::{JobSpecInput, WorkerResources, build_job_spec},
};

pub struct KubernetesDispatcher {
    client: Client,
    namespace: String,
    release_name: String,
    worker_image: String,
    controller_grpc_url: String,
    resources: WorkerResources,
}

impl KubernetesDispatcher {
    pub async fn try_new(
        namespace: String,
        release_name: String,
        worker_image: String,
        controller_grpc_url: String,
    ) -> anyhow::Result<Self> {
        let client = Client::try_default().await?;
        Ok(Self {
            client,
            namespace,
            release_name,
            worker_image,
            controller_grpc_url,
            resources: WorkerResources::default(),
        })
    }

    fn jobs_api(&self) -> Api<Job> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }
}

#[async_trait]
impl WorkerDispatcher for KubernetesDispatcher {
    async fn dispatch(&self, run_id: &str, worker_count: u32) -> anyhow::Result<()> {
        if worker_count > 1 {
            warn!(
                %run_id, worker_count,
                "K8s dispatcher still creates a single Job; multi-Pod Indexed Job lands in A3c"
            );
        }
        let worker_id = Ulid::new().to_string();
        let job = build_job_spec(&JobSpecInput {
            release_name: &self.release_name,
            namespace: &self.namespace,
            run_id,
            worker_id: &worker_id,
            worker_image: &self.worker_image,
            controller_grpc_url: &self.controller_grpc_url,
            resources: self.resources.clone(),
        });
        let created = self.jobs_api().create(&PostParams::default(), &job).await?;
        let name = created.metadata.name.unwrap_or_default();
        info!(%run_id, %worker_id, %name, namespace = %self.namespace, "created worker Job");
        Ok(())
    }

    async fn cleanup(&self, run_id: &str) -> anyhow::Result<()> {
        // Idempotent: list Jobs labeled with the run-id, delete each. If none
        // exist (e.g. ttlSecondsAfterFinished already collected them), this
        // is a no-op.
        let api = self.jobs_api();
        let selector = format!("handicap.io/run-id={}", run_id);
        let list = api.list(&ListParams::default().labels(&selector)).await?;
        for job in list.items {
            if let Some(name) = job.metadata.name {
                match api.delete(&name, &DeleteParams::background()).await {
                    Ok(_) => info!(%run_id, %name, "deleted worker Job"),
                    Err(e) => warn!(%run_id, %name, error = %e, "failed to delete Job"),
                }
            }
        }
        Ok(())
    }
}
