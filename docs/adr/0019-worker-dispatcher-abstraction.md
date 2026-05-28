# ADR-0019 — Worker dispatch is pluggable: subprocess or K8s Job

* Status: Accepted
* Date: 2026-05-28
* Deciders: handicap maintainers
* Tags: deployment, controller, worker, K8s

## Context

Slice 1–5 controllers spawn the worker as a subprocess from
`worker_proc::spawn_worker`. That is convenient for local development
(`cargo run -p handicap-controller` Just Works) but ships nothing toward
the MVP completion criterion (spec §4.2): "deployed to a kind cluster via
one Helm chart, controller creates worker Pods via the K8s API."

The two dispatch paths differ in almost every observable way:
- Subprocess: same process namespace, kill-on-controller-exit, stdout/stderr
  inherit, no network step to reach the gRPC port.
- K8s Job: separate Pod, separate filesystem, image-based binary, must
  resolve controller via in-cluster Service DNS, lifecycle is K8s-owned.

We need both: subprocess for the fast iteration loop, K8s for the
production-shape deployment that ships with the MVP.

## Decision

The controller defines a `WorkerDispatcher` trait with `async fn dispatch(&self, run_id, worker_id) -> Result<()>` and `async fn cleanup(&self, run_id) -> Result<()>`. Two implementations land in Slice 6:

- `SubprocessDispatcher` — wraps the current `spawn_worker` logic; default for
  local development; selected via `--worker-mode subprocess` (the default).
- `KubernetesDispatcher` — uses `kube-rs` to create a `batch/v1 Job` and to
  delete it once the run finishes; selected via `--worker-mode kubernetes`.
  Requires `--namespace`, `--worker-image`, and `--controller-grpc-url`.

`AppState` holds the dispatcher behind `Arc<dyn WorkerDispatcher>`. The HTTP
API has no knowledge of which implementation is wired.

## Consequences

Positive:
- Local `cargo run` keeps working unchanged (`--worker-mode subprocess` is
  the default).
- The K8s path is unit-testable via a pure `build_job_spec` helper.
- A future Nomad/ECS dispatcher can land without HTTP API changes.

Negative:
- Two implementations means a real chance of behavior drift (e.g. one
  dispatcher cleans up resources, the other doesn't). Mitigated by a shared
  contract test in `crates/controller/tests/dispatcher_contract.rs` (Task 3).
- The K8s dispatcher requires runtime permissions (`Role` with `jobs` and
  `pods` verbs) that the subprocess one does not — RBAC is wired in the Helm
  chart (Task 12).

## Alternatives considered

1. **K8s only.** Forces every local-dev iteration through kind. Slower
   feedback loop; harder onboarding. Rejected.
2. **Single binary with branching in `worker_proc`.** No trait, just an
   `if mode == K8s { … } else { spawn(...) }`. Marginally less code; but
   no seam for unit tests of the K8s spec builder, and the controller's
   call sites would import kube-rs unconditionally. Rejected.
3. **Auto-detect mode** (e.g. "use K8s if `KUBERNETES_SERVICE_HOST` is set").
   Magic; surprises in local-dev when you accidentally have a kubeconfig in
   scope. Explicit flag is safer. Rejected.

## Links

- Spec §3.1, §4.2
- Slice 6 plan (`docs/superpowers/plans/2026-05-28-slice-6-k8s-deploy.md`)
- ADR-0010 (controller↔worker gRPC pull)
