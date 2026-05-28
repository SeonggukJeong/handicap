use handicap_controller::dispatcher::k8s_spec::{JobSpecInput, WorkerResources, build_job_spec};

fn fixture<'a>() -> JobSpecInput<'a> {
    JobSpecInput {
        release_name: "handicap",
        namespace: "handicap",
        run_id: "01HX1234567890ABCDEFGHIJKL",
        worker_id: "01HX9876543210ZYXWVUTSRQPO",
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
        "handicap.io/worker-id",
    ] {
        assert!(labels.contains_key(k), "missing label {}", k);
    }
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
    assert_eq!(args[0], "--controller");
    assert_eq!(
        args[1],
        "http://handicap-controller.handicap.svc.cluster.local:8081"
    );
    assert_eq!(args[2], "--run-id");
    assert_eq!(args[3], "01HX1234567890ABCDEFGHIJKL");
    assert_eq!(args[4], "--worker-id");
    assert_eq!(args[5], "01HX9876543210ZYXWVUTSRQPO");
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
    assert_eq!(req["cpu"].0, "500m");
    assert_eq!(req["memory"].0, "256Mi");
    let lim = res.limits.as_ref().unwrap();
    assert_eq!(lim["cpu"].0, "4");
    assert_eq!(lim["memory"].0, "1Gi");
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
