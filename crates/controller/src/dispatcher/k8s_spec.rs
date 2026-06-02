use std::collections::BTreeMap;

use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{
    Capabilities, Container, PodSecurityContext, PodSpec, PodTemplateSpec, ResourceRequirements,
    SecurityContext,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

/// Inputs for `build_job_spec`. All strings are validated by the caller
/// (DNS-1123 labels, image refs etc).
#[derive(Debug, Clone)]
pub struct JobSpecInput<'a> {
    pub release_name: &'a str,
    pub namespace: &'a str,
    pub run_id: &'a str,
    /// Number of worker Pods (Indexed Job parallelism/completions). N from
    /// `CoordinatorState::worker_count_for`. (A3c spec §7.2.)
    pub worker_count: u32,
    pub worker_image: &'a str,
    pub controller_grpc_url: &'a str,
    pub resources: WorkerResources,
}

#[derive(Debug, Clone)]
pub struct WorkerResources {
    pub cpu_request: String,
    pub mem_request: String,
    pub cpu_limit: String,
    pub mem_limit: String,
}

impl Default for WorkerResources {
    fn default() -> Self {
        Self {
            cpu_request: "500m".into(),
            mem_request: "256Mi".into(),
            cpu_limit: "4".into(),
            mem_limit: "1Gi".into(),
        }
    }
}

/// Build the Job manifest. Pure function — no side effects, easy to test.
pub fn build_job_spec(input: &JobSpecInput<'_>) -> Job {
    let mut labels = BTreeMap::<String, String>::new();
    labels.insert("app.kubernetes.io/name".into(), "handicap-worker".into());
    labels.insert(
        "app.kubernetes.io/instance".into(),
        input.release_name.into(),
    );
    labels.insert("app.kubernetes.io/component".into(), "worker".into());
    labels.insert("handicap.io/run-id".into(), input.run_id.into());

    let container = Container {
        name: "worker".into(),
        image: Some(input.worker_image.into()),
        command: Some(vec!["/usr/local/bin/worker".into()]),
        args: Some(vec![
            "--controller".into(),
            input.controller_grpc_url.into(),
            "--run-id".into(),
            input.run_id.into(),
        ]),
        resources: Some(ResourceRequirements {
            requests: Some(
                [
                    ("cpu".into(), Quantity(input.resources.cpu_request.clone())),
                    (
                        "memory".into(),
                        Quantity(input.resources.mem_request.clone()),
                    ),
                ]
                .into_iter()
                .collect(),
            ),
            limits: Some(
                [
                    ("cpu".into(), Quantity(input.resources.cpu_limit.clone())),
                    ("memory".into(), Quantity(input.resources.mem_limit.clone())),
                ]
                .into_iter()
                .collect(),
            ),
            claims: None,
        }),
        security_context: Some(SecurityContext {
            allow_privilege_escalation: Some(false),
            read_only_root_filesystem: Some(true),
            run_as_non_root: Some(true),
            run_as_user: Some(65532),
            capabilities: Some(Capabilities {
                drop: Some(vec!["ALL".into()]),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };

    Job {
        metadata: ObjectMeta {
            generate_name: Some(format!("handicap-worker-{}-", short_id(input.run_id))),
            namespace: Some(input.namespace.into()),
            labels: Some(labels.clone()),
            ..Default::default()
        },
        spec: Some(JobSpec {
            backoff_limit: Some(0),
            ttl_seconds_after_finished: Some(600),
            // Fan-out: one Indexed Job runs N Pods; each derives its worker id from
            // the auto-injected JOB_COMPLETION_INDEX. (A3c spec §7.2.)
            completion_mode: Some("Indexed".into()),
            completions: Some(input.worker_count.max(1) as i32),
            parallelism: Some(input.worker_count.max(1) as i32),
            template: PodTemplateSpec {
                metadata: Some(ObjectMeta {
                    labels: Some(labels),
                    ..Default::default()
                }),
                spec: Some(PodSpec {
                    restart_policy: Some("Never".into()),
                    containers: vec![container],
                    security_context: Some(PodSecurityContext {
                        run_as_non_root: Some(true),
                        run_as_user: Some(65532),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
            },
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn short_id(s: &str) -> String {
    // ULIDs are 26 chars; K8s name length is 63. Use the trailing 8 chars
    // (the time-sortable head is shared across many runs, the random tail
    // is the discriminator).
    let lower = s.to_ascii_lowercase();
    lower
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}
