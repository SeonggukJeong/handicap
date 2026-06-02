use std::collections::BTreeMap;

use k8s_openapi::api::batch::v1::{Job, JobSpec};
use k8s_openapi::api::core::v1::{
    Affinity, Capabilities, Container, PodAffinityTerm, PodAntiAffinity, PodSecurityContext,
    PodSpec, PodTemplateSpec, ResourceRequirements, SecurityContext, TopologySpreadConstraint,
    WeightedPodAffinityTerm,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};

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
        // Guaranteed QoS (requests == limits): the scheduler reserves dedicated CPU
        // and the load generator isn't CFS-throttled below its cap — the fidelity
        // lever from spec §7.3. Magnitude is deliberately modest so N>1 Indexed Pods
        // schedule on a single-node / small-CI kind cluster (the registration
        // watchdog fails the run if any worker Pod can't schedule). Production
        // high-throughput deployments raise these via the deferred Helm worker
        // resource values (roadmap §B); equality is the invariant, size is not.
        Self {
            cpu_request: "250m".into(),
            mem_request: "256Mi".into(),
            cpu_limit: "250m".into(),
            mem_limit: "256Mi".into(),
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

    // Soft scheduling hints (spec §7.3). MUST be soft: a single-node kind cluster
    // can't satisfy hard spread/anti-affinity, and the registration watchdog would
    // then fail any N>1 run. ScheduleAnyway / preferred → multi-node spreads, single
    // node still packs.
    let topology = vec![TopologySpreadConstraint {
        max_skew: 1,
        topology_key: "kubernetes.io/hostname".into(),
        when_unsatisfiable: "ScheduleAnyway".into(),
        label_selector: Some(LabelSelector {
            match_labels: Some(
                [(
                    "app.kubernetes.io/component".to_string(),
                    "worker".to_string(),
                )]
                .into_iter()
                .collect(),
            ),
            ..Default::default()
        }),
        ..Default::default()
    }];
    let affinity = Affinity {
        pod_anti_affinity: Some(PodAntiAffinity {
            preferred_during_scheduling_ignored_during_execution: Some(vec![
                WeightedPodAffinityTerm {
                    weight: 100,
                    pod_affinity_term: PodAffinityTerm {
                        label_selector: Some(LabelSelector {
                            match_labels: Some(
                                [(
                                    "app.kubernetes.io/component".to_string(),
                                    "controller".to_string(),
                                )]
                                .into_iter()
                                .collect(),
                            ),
                            ..Default::default()
                        }),
                        topology_key: "kubernetes.io/hostname".into(),
                        ..Default::default()
                    },
                },
            ]),
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
                    affinity: Some(affinity),
                    topology_spread_constraints: Some(topology),
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
