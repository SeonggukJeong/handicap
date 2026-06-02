use handicap_controller::dispatcher::k8s_spec::{JobSpecInput, WorkerResources, build_job_spec};

fn fixture<'a>() -> JobSpecInput<'a> {
    JobSpecInput {
        release_name: "handicap",
        namespace: "handicap",
        run_id: "01HX1234567890ABCDEFGHIJKL",
        worker_count: 1,
        worker_image: "ghcr.io/example/handicap:0.1.0",
        controller_grpc_url: "http://handicap-controller.handicap.svc.cluster.local:8081",
        resources: WorkerResources::default(),
    }
}

#[test]
fn labels_contain_required_keys() {
    let job = build_job_spec(&fixture());
    let labels = job.metadata.labels.as_ref().expect("labels");
    for k in [
        "app.kubernetes.io/name",
        "app.kubernetes.io/instance",
        "app.kubernetes.io/component",
        "handicap.io/run-id",
    ] {
        assert!(labels.contains_key(k), "missing label {}", k);
    }
    // Indexed Job has no single worker id — Pods derive it from JOB_COMPLETION_INDEX.
    assert!(
        !labels.contains_key("handicap.io/worker-id"),
        "worker-id label must be dropped for Indexed Job"
    );
    assert_eq!(labels["handicap.io/run-id"], "01HX1234567890ABCDEFGHIJKL");
}

#[test]
fn job_has_zero_retry_and_cleanup_ttl() {
    let job = build_job_spec(&fixture());
    let spec = job.spec.as_ref().expect("spec");
    assert_eq!(spec.backoff_limit, Some(0), "must not retry on failure");
    assert_eq!(spec.ttl_seconds_after_finished, Some(600));
}

#[test]
fn pod_has_restart_never_and_runs_non_root() {
    let job = build_job_spec(&fixture());
    let pod = job.spec.as_ref().unwrap().template.spec.as_ref().unwrap();
    assert_eq!(pod.restart_policy.as_deref(), Some("Never"));
    let sec = pod.security_context.as_ref().expect("podSecurityContext");
    assert_eq!(sec.run_as_non_root, Some(true));
    assert_eq!(sec.run_as_user, Some(65532));
}

#[test]
fn container_args_pass_through_to_worker_binary() {
    let job = build_job_spec(&fixture());
    let c = &job
        .spec
        .as_ref()
        .unwrap()
        .template
        .spec
        .as_ref()
        .unwrap()
        .containers[0];
    assert_eq!(
        c.command.as_deref(),
        Some(&["/usr/local/bin/worker".to_string()][..])
    );
    let args = c.args.as_ref().expect("args");
    // No --worker-id: K8s Indexed Job Pods read JOB_COMPLETION_INDEX (auto-injected).
    assert!(
        !args.iter().any(|a| a == "--worker-id"),
        "K8s workers must NOT get --worker-id; they derive it from JOB_COMPLETION_INDEX"
    );
    assert_eq!(
        args,
        &[
            "--controller".to_string(),
            "http://handicap-controller.handicap.svc.cluster.local:8081".to_string(),
            "--run-id".to_string(),
            "01HX1234567890ABCDEFGHIJKL".to_string(),
        ]
    );
}

#[test]
fn container_resources_default_to_known_quantities() {
    let job = build_job_spec(&fixture());
    let res = job
        .spec
        .as_ref()
        .unwrap()
        .template
        .spec
        .as_ref()
        .unwrap()
        .containers[0]
        .resources
        .as_ref()
        .expect("resources");
    let req = res.requests.as_ref().unwrap();
    let lim = res.limits.as_ref().unwrap();
    // Guaranteed QoS: requests == limits (fidelity lever, spec §7.3). Magnitude is
    // modest so N>1 Indexed Pods schedule on single-node/CI kind (spec §7.3 + A3c
    // scope decision 2); production raises via deferred Helm values (roadmap §B).
    assert_eq!(req["cpu"].0, "250m");
    assert_eq!(lim["cpu"].0, "250m");
    assert_eq!(req["memory"].0, "256Mi");
    assert_eq!(lim["memory"].0, "256Mi");
}

#[test]
fn worker_pods_spread_softly_and_avoid_controller() {
    let job = build_job_spec(&fixture());
    let pod = job.spec.as_ref().unwrap().template.spec.as_ref().unwrap();

    // topologySpread must be SOFT — DoNotSchedule would leave the 2nd Pod Pending
    // on single-node kind and the run would fail the registration watchdog.
    let tsc = pod
        .topology_spread_constraints
        .as_ref()
        .expect("topologySpreadConstraints");
    assert_eq!(tsc[0].when_unsatisfiable, "ScheduleAnyway", "must be soft");
    assert_eq!(tsc[0].topology_key, "kubernetes.io/hostname");
    assert_eq!(tsc[0].max_skew, 1);
    // The constraint must target worker Pods — without a selector it would spread
    // every Pod in the namespace, not just sibling workers.
    let tsc_sel = tsc[0]
        .label_selector
        .as_ref()
        .expect("topologySpreadConstraint labelSelector")
        .match_labels
        .as_ref()
        .unwrap();
    assert_eq!(tsc_sel["app.kubernetes.io/component"], "worker");

    // Pod anti-affinity (soft) keeps workers off the controller node when possible.
    let aff = pod.affinity.as_ref().expect("affinity");
    let paa = aff.pod_anti_affinity.as_ref().expect("podAntiAffinity");
    let pref = paa
        .preferred_during_scheduling_ignored_during_execution
        .as_ref()
        .expect("preferred anti-affinity (soft)");
    assert_eq!(pref[0].weight, 100, "soft anti-affinity weight");
    let sel = pref[0]
        .pod_affinity_term
        .label_selector
        .as_ref()
        .unwrap()
        .match_labels
        .as_ref()
        .unwrap();
    assert_eq!(sel["app.kubernetes.io/component"], "controller");
    // required anti-affinity would block scheduling on a single node — must be unset.
    assert!(
        paa.required_during_scheduling_ignored_during_execution
            .is_none(),
        "anti-affinity must be soft (preferred), not required"
    );
}

#[test]
fn container_security_drops_all_caps_and_read_only_fs() {
    let job = build_job_spec(&fixture());
    let c = &job
        .spec
        .as_ref()
        .unwrap()
        .template
        .spec
        .as_ref()
        .unwrap()
        .containers[0];
    let sec = c.security_context.as_ref().expect("securityContext");
    assert_eq!(sec.allow_privilege_escalation, Some(false));
    assert_eq!(sec.read_only_root_filesystem, Some(true));
    let caps = sec.capabilities.as_ref().expect("capabilities");
    assert_eq!(caps.drop.as_deref(), Some(&["ALL".to_string()][..]));
}

#[test]
fn generate_name_is_dns1123_and_under_63_chars() {
    let job = build_job_spec(&fixture());
    let gn = job.metadata.generate_name.as_ref().expect("generate_name");
    // K8s appends 5 random chars; the prefix + suffix must fit in 63.
    assert!(gn.len() + 5 <= 63, "generate_name too long: {}", gn);
    for c in gn.chars() {
        assert!(
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-',
            "non-DNS1123 char in {}: {}",
            gn,
            c
        );
    }
    // trailing dash required for generateName
    assert!(gn.ends_with('-'), "generate_name must end with '-'");
}

#[test]
fn indexed_job_fans_out_to_worker_count() {
    let mut input = fixture();
    input.worker_count = 3;
    let job = build_job_spec(&input);
    let spec = job.spec.as_ref().expect("spec");
    assert_eq!(
        spec.completion_mode.as_deref(),
        Some("Indexed"),
        "fan-out uses an Indexed Job"
    );
    assert_eq!(spec.parallelism, Some(3), "all N workers run at once");
    assert_eq!(spec.completions, Some(3), "all N must complete");
}

#[test]
fn single_worker_job_is_n_eq_1() {
    // N=1 (default capacity path) is still one Pod with completions/parallelism 1.
    let job = build_job_spec(&fixture());
    let spec = job.spec.as_ref().unwrap();
    assert_eq!(spec.completion_mode.as_deref(), Some("Indexed"));
    assert_eq!(spec.parallelism, Some(1));
    assert_eq!(spec.completions, Some(1));
}
