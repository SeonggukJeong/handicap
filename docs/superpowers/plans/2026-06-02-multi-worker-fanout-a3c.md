# A3c — 멀티 워커 fan-out: K8s Indexed Job + dispatcher cleanup 배선 + Helm 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** K8s 워커 디스패치를 **단일 Indexed Job(parallelism=completions=N)** 으로 전환하고, 종료/실패/abort 경로에서 `dispatcher.cleanup()` 을 실제로 호출하도록 배선하며, 워커 수 레버(`worker.capacityVus`)를 Helm value 로 노출한다. 로컬/CI kind 에서 N>1 fan-out 이 실제로 N Pod 를 띄우는지 e2e 로 검증한다.

**Architecture:** `build_job_spec` 가 `worker_id` 대신 `worker_count` 를 받아 `completion_mode="Indexed"` + `parallelism`/`completions`=N 인 단 1 개 Job 을 만든다(각 Pod 는 K8s 가 자동 주입하는 `JOB_COMPLETION_INDEX` 로 자기 worker_id 를 파생 — 워커 측은 A3a 에서 이미 구현). `CoordinatorState` 가 `Arc<OnceLock<SharedDispatcher>>` 핸들을 들고, finalize(완료/실패/abort/watchdog) 시 idempotent `cleanup` 을 호출한다(단위테스트엔 핸들 미설정 → no-op). 부하 충실도는 `WorkerResources::default()` 를 **Guaranteed QoS(requests==limits)** 로 교정 + **soft** topologySpread/anti-affinity 로 잡되, 크기는 단일 노드 kind 에 N>1 이 뜨도록 modest 하게(per-deploy 리소스 튜닝은 로드맵 §B 로 연기).

**Tech Stack:** Rust, k8s-openapi 0.23(v1_30 feature), kube-rs, async-trait, tonic/prost, SQLite(sqlx), Helm(helm-unittest snapshot), kind, bash + kubectl(e2e).

---

## 스코프 결정 / spec 대비 의도된 deviation (리뷰어 주목)

이 plan 은 spec(`2026-06-01-multi-worker-fanout-design.md`) §7 = "디스패치 & K8s 형상" + §9 = "A3c" **만** 구현한다. A3a(조정 인프라) + A3b(메트릭 머지)는 머지 완료.

1. **Helm 워커 충실도는 "최소안"(사용자 결정 2026-06-02)** — `WorkerResources::default()` 를 requests==limits 로 교정 + soft topologySpread/anti-affinity 를 `build_job_spec` 기본값으로 박고, ops 레버인 **`worker.capacityVus`(→ controller `--worker-capacity-vus`)만** Helm value 로 노출한다. spec §7.3 이 언급한 **per-deployment 워커 cpu/mem req·limit 의 Helm values 노출 + controller 플래그 + dispatcher 배선은 연기**(로드맵 §B "운영 상한 관리자 화면"). 이유: `WorkerResources` 구조체·dispatcher→build_job_spec 이음새가 이미 존재해 나중 전체 배선이 순수 가산(throwaway 0)이고, 운영상 핵심 레버(N 을 정하는 capacity)는 이번에 노출되기 때문.

2. **워커 리소스 기본값 크기는 portability-driven (equality 가 충실도 invariant, 크기 아님)** — `requests==limits`(Guaranteed QoS)가 CFS 스로틀 방지의 핵심 레버다(spec §7.3). 하지만 단일 노드 kind(특히 미래 2-vCPU GitHub 러너)에서 N>1 Indexed Pod 가 전부 스케줄+등록(60s 등록 watchdog)돼야 e2e 가 통과하므로, **기본 크기를 modest 하게**(`cpu/mem = 250m/256Mi`, req==limit) 잡는다. 현재 기본(req 500m / limit 4)에서 limit 을 낮추는 방향. 프로덕션 고처리량은 §B full-plumbing 으로 올린다. (프로덕션 사용자 없음 — "사내 K8s 도입 대기" — 라 기본 하향이 회귀 아님.)

3. **topologySpread/anti-affinity 는 반드시 soft** — `topologySpreadConstraints.whenUnsatisfiable: ScheduleAnyway` + `podAntiAffinity.preferredDuringScheduling...`. **`DoNotSchedule`/`requiredDuring...` 로 하면 단일 노드 kind 에서 두 번째 Pod 가 영영 Pending → 등록 watchdog 이 run 을 Failed 로 → e2e 깨짐.** soft 라야 단일 노드는 pack, 멀티 노드는 spread.

4. **`handicap.io/worker-id` Job 라벨 + `--worker-id` 컨테이너 arg 제거** — Indexed Job 은 단일 worker_id 가 없다(Pod 마다 `JOB_COMPLETION_INDEX` → `{run_id}-w{index}`). 라벨/arg 에서 worker_id 를 뺀다. cleanup 셀렉터는 `handicap.io/run-id`(무변경, Indexed Job 1 개 + ownerRef GC 로 N Pod 일괄 삭제). 워커 측 `resolve_worker_id`(A3a)는 무변경.

5. **`dispatcher.cleanup()` 핸들 = `Arc<OnceLock<SharedDispatcher>>` (interior mutability)** — `CoordinatorState` 는 dispatcher *이전* 에 생성되고 `CoordinatorService`/`AppState` 양쪽에 clone 되므로, 생성자에 dispatcher 를 넣기보다 `OnceLock` 핸들을 두고 main.rs 가 dispatcher 빌드 후 `set_dispatcher` 로 한 번 채운다(모든 clone 이 같은 `Arc<OnceLock>` 공유). 단위/e2e 테스트는 핸들 미설정 → cleanup no-op(기존 테스트 무영향). cleanup 은 trait 계약상 idempotent 라 finalize 모든 경로에서 안전하게 호출.

6. **`worker.capacityVus` 기본 = 2000(현 `DEFAULT_WORKER_CAPACITY_VUS` 와 동일)** — 기본 배포는 N=1(byte-identical). e2e-kind 만 `--set worker.capacityVus=25` 로 낮춰 50 VUs → N=2 fan-out 을 강제.

## 파일 구조 맵 (무엇을, 왜)

| 파일 | 변경 | 책임 |
|---|---|---|
| `crates/controller/src/dispatcher/k8s_spec.rs` | 수정 | `JobSpecInput`: `worker_id`→`worker_count`. `build_job_spec`: Indexed(parallelism/completions/completion_mode) + worker-id 라벨/arg 제거 + `WorkerResources::default()` req==limit + soft topologySpread/anti-affinity. |
| `crates/controller/tests/dispatcher_spec_test.rs` | 수정 | fixture(worker_count), 기존 4 테스트 갱신(라벨/args/resources), 신규 테스트(Indexed fan-out, no --worker-id, soft topology). |
| `crates/controller/src/dispatcher/kubernetes.rs` | 수정 | `dispatch` 가 `worker_count` 로 단일 Indexed Job 생성(warn/ULID 제거). |
| `crates/controller/src/grpc/coordinator.rs` | 수정 | `CoordinatorState` 에 `dispatcher: Arc<OnceLock<SharedDispatcher>>` + `set_dispatcher` + `cleanup_dispatcher` 헬퍼. finalize 4 경로(record_phase Completed/Aborted/Failed, worker_disconnected, fail_incomplete_registration)에서 호출. 인라인 단위테스트. |
| `crates/controller/src/main.rs` | 수정 | dispatcher 빌드 후 `coord_state.set_dispatcher(dispatcher.clone())` 1 줄. |
| `deploy/helm/handicap/values.yaml` | 수정 | `worker.capacityVus: 2000`. |
| `deploy/helm/handicap/templates/deployment.yaml` | 수정 | `--worker-capacity-vus {{ .Values.worker.capacityVus }}` arg. |
| `deploy/helm/handicap/tests/__snapshots__/*.yaml` | 재생성 | snapshot drift(`UPDATE_SNAPSHOTS=1`). |
| `crates/controller/src/bin/e2e_kind_driver.rs` | (무변경 가능성) | run 완료 검증은 이미 N 워커 등록을 함의. N=2 어설션은 스크립트 쪽. |
| `scripts/e2e-kind.sh` | 수정 | helm install `--set worker.capacityVus=25` + 드라이버 후 Job `completionMode=Indexed`/`completions=2` 어설션. |
| `.github/workflows/e2e-kind.yml` | 수정 | helm install `--set worker.capacityVus=25` + Job-shape 어설션(스크립트 미경유 인라인 경로). |
| `crates/controller/CLAUDE.md` / `deploy/CLAUDE.md` / `docs/adr/0027-*.md` / `docs/roadmap.md` / 루트 `CLAUDE.md` / 메모리 | 수정 | A3c 함정·결정·상태 갱신. |

**무변경 확인 대상**(리뷰어 체크): proto(shard 4 필드는 A3a), 워커 `resolve_worker_id`/`main.rs`(A3a), 엔진, UI, `runs`/메트릭 테이블, `subprocess.rs`(A3a N-spawn), `dispatcher/mod.rs` trait 시그니처(A3a `dispatch(run_id, worker_count)`/`cleanup`).

---

## Task 1: `build_job_spec` — Indexed Job(parallelism/completions) + `worker_count` 입력, worker-id 라벨/arg 제거

**Files:**
- Modify: `crates/controller/tests/dispatcher_spec_test.rs` (fixture + 기존 테스트 갱신 + 신규 테스트)
- Modify: `crates/controller/src/dispatcher/k8s_spec.rs` (`JobSpecInput`, `build_job_spec`)
- Modify: `crates/controller/src/dispatcher/kubernetes.rs` (`dispatch` 가 새 `JobSpecInput` 사용 — 같은 커밋서 동반 수정해야 crate 컴파일)

`JobSpecInput` 에서 `worker_id` 를 빼고 `worker_count: u32` 를 넣는다 → `build_job_spec` 호출부(kubernetes.rs)·테스트(dispatcher_spec_test.rs)가 전부 컴파일 에러. 셋을 한 task 로 같이 고쳐 빌드를 green 으로 유지. (TDD 순서: tests/*.rs 를 먼저 편집 → pending test 존재 → src 편집 unblock.)

- [ ] **Step 1: 실패하는 테스트 작성/갱신** (`dispatcher_spec_test.rs`)

fixture 를 worker_count 기반으로 바꾸고(`worker_id` 제거), worker-id 라벨/arg 어설션을 제거하고, Indexed fan-out 신규 테스트를 추가한다. 파일 상단 fixture 와 영향받는 테스트 전체를 아래로 교체:

```rust
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
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --test dispatcher_spec_test`
Expected: FAIL — `JobSpecInput` 에 `worker_count` 필드 없음 + `worker_id` 제거로 컴파일 에러(여러 테스트).

- [ ] **Step 3: `JobSpecInput` + `build_job_spec` 수정** (`k8s_spec.rs`)

`JobSpecInput` 의 `worker_id` 줄을 `worker_count` 로 교체:

```rust
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
```

`build_job_spec` 안에서 ① worker-id 라벨 줄 제거, ② args 의 `--worker-id`/값 제거, ③ `JobSpec` 에 Indexed 3 필드 추가. 구체 편집:

`labels.insert("handicap.io/worker-id"...)` 줄을 **삭제**.

args 벡터를 아래로(마지막 두 원소 제거):

```rust
        args: Some(vec![
            "--controller".into(),
            input.controller_grpc_url.into(),
            "--run-id".into(),
            input.run_id.into(),
        ]),
```

`JobSpec { backoff_limit: Some(0), ttl_seconds_after_finished: Some(600), template: ... }` 의 필드에 Indexed 3 개 추가(N as i32):

```rust
        spec: Some(JobSpec {
            backoff_limit: Some(0),
            ttl_seconds_after_finished: Some(600),
            // Fan-out: one Indexed Job runs N Pods; each derives its worker id from
            // the auto-injected JOB_COMPLETION_INDEX. (A3c spec §7.2.)
            completion_mode: Some("Indexed".into()),
            completions: Some(input.worker_count.max(1) as i32),
            parallelism: Some(input.worker_count.max(1) as i32),
            template: PodTemplateSpec {
                // ... unchanged ...
```

- [ ] **Step 4: `kubernetes.rs::dispatch` 가 새 입력 사용** (`kubernetes.rs`) — `worker_count>1` warn + ULID worker_id 제거, 단일 Indexed Job:

```rust
    async fn dispatch(&self, run_id: &str, worker_count: u32) -> anyhow::Result<()> {
        let n = worker_count.max(1);
        let job = build_job_spec(&JobSpecInput {
            release_name: &self.release_name,
            namespace: &self.namespace,
            run_id,
            worker_count: n,
            worker_image: &self.worker_image,
            controller_grpc_url: &self.controller_grpc_url,
            resources: self.resources.clone(),
        });
        let created = self.jobs_api().create(&PostParams::default(), &job).await?;
        let name = created.metadata.name.unwrap_or_default();
        info!(%run_id, worker_count = n, %name, namespace = %self.namespace, "created Indexed worker Job");
        Ok(())
    }
```

파일 상단 `use ulid::Ulid;` 를 **삭제**(미사용 → clippy `-D warnings` 에서 깨짐). `use tracing::{info, warn};` 는 `warn` 이 `cleanup` 에서 계속 쓰이므로 유지. `JobSpecInput`/`WorkerResources`/`build_job_spec` import 유지.

- [ ] **Step 5: 테스트 통과 + 빌드(K8s feature 포함)**

Run: `cargo test -p handicap-controller --test dispatcher_spec_test && cargo build -p handicap-controller --features slice6-k8s --tests`
Expected: PASS, 컴파일 클린(`--features slice6-k8s` 로 kubernetes.rs 경로·`dispatcher_kubernetes_test.rs` 도 빌드되는지 확인 — 그 테스트는 `dispatch(run_id, 1)` + run-id 라벨로 list 하므로 worker_id 제거에 무영향).

- [ ] **Step 6: 커밋**

```bash
git add crates/controller/tests/dispatcher_spec_test.rs crates/controller/src/dispatcher/k8s_spec.rs crates/controller/src/dispatcher/kubernetes.rs
git commit -m "feat(controller): build_job_spec → Indexed Job (parallelism/completions=N), drop worker-id (A3c)"
```

---

## Task 2: `build_job_spec` — 부하 충실도: Guaranteed QoS(req==limit) + soft topologySpread/anti-affinity

**Files:**
- Modify: `crates/controller/tests/dispatcher_spec_test.rs` (resources 테스트 갱신 + soft topology 신규 테스트)
- Modify: `crates/controller/src/dispatcher/k8s_spec.rs` (`WorkerResources::default` + PodSpec affinity/topology)

`WorkerResources::default()` 를 requests==limits 로 교정(CFS 스로틀 방지 = 충실도 레버, 크기는 단일 노드 kind 스케줄 가능하도록 modest), PodSpec 에 **soft** topologySpread + **soft** anti-affinity(컨트롤러와 분리) 추가. soft 가 아니면 단일 노드 kind 에서 N>1 이 Pending → e2e 깨짐(§스코프결정 3).

- [ ] **Step 1: 실패하는 테스트 작성/갱신** (`dispatcher_spec_test.rs`)

기존 `container_resources_default_to_known_quantities` 를 req==limit 로 교체 + soft topology 신규 테스트 추가:

```rust
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

    // Pod anti-affinity (soft) keeps workers off the controller node when possible.
    let aff = pod.affinity.as_ref().expect("affinity");
    let paa = aff.pod_anti_affinity.as_ref().expect("podAntiAffinity");
    let pref = paa
        .preferred_during_scheduling_ignored_during_execution
        .as_ref()
        .expect("preferred anti-affinity (soft)");
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
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --test dispatcher_spec_test container_resources_default_to_known_quantities worker_pods_spread_softly_and_avoid_controller`
Expected: FAIL — req cpu 가 아직 "500m"(또는 limit "4")이고, `topology_spread_constraints`/`affinity` 가 `None`.

- [ ] **Step 3: `WorkerResources::default` 교정** (`k8s_spec.rs`)

```rust
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
```

- [ ] **Step 4: PodSpec 에 soft topologySpread + anti-affinity 추가** (`k8s_spec.rs`)

import 에 추가(파일 상단 `use k8s_openapi::api::core::v1::{...}` 줄 확장 + LabelSelector):

```rust
use k8s_openapi::api::core::v1::{
    Affinity, Capabilities, Container, PodAntiAffinity, PodAffinityTerm, PodSecurityContext,
    PodSpec, PodTemplateSpec, ResourceRequirements, SecurityContext, TopologySpreadConstraint,
    WeightedPodAffinityTerm,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
```

`build_job_spec` 안, `Job { ... }` 직전(컨테이너 정의 뒤)에 spread/affinity 를 구성:

```rust
    // Soft scheduling hints (spec §7.3). MUST be soft: a single-node kind cluster
    // can't satisfy hard spread/anti-affinity, and the registration watchdog would
    // then fail any N>1 run. ScheduleAnyway / preferred → multi-node spreads, single
    // node still packs.
    let worker_label = || {
        LabelSelector {
            match_labels: Some(
                [(
                    "app.kubernetes.io/component".to_string(),
                    "worker".to_string(),
                )]
                .into_iter()
                .collect(),
            ),
            ..Default::default()
        }
    };
    let topology = vec![TopologySpreadConstraint {
        max_skew: 1,
        topology_key: "kubernetes.io/hostname".into(),
        when_unsatisfiable: "ScheduleAnyway".into(),
        label_selector: Some(worker_label()),
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
```

그리고 `PodSpec { restart_policy: ..., containers: ..., security_context: ..., .. }` 에 두 필드 추가:

```rust
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
```

- [ ] **Step 5: 테스트 통과 + 전체 dispatcher_spec 회귀**

Run: `cargo test -p handicap-controller --test dispatcher_spec_test`
Expected: PASS — 신규 2 + 기존(labels/args/Indexed/backoff/restart/security/generate_name) 전부 green.

- [ ] **Step 6: 커밋**

```bash
git add crates/controller/tests/dispatcher_spec_test.rs crates/controller/src/dispatcher/k8s_spec.rs
git commit -m "feat(controller): worker Job Guaranteed QoS + soft topology spread/anti-affinity (A3c)"
```

---

## Task 3: `dispatcher.cleanup()` 배선 — `CoordinatorState` 핸들 + finalize 호출

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`CoordinatorState` 필드 + `set_dispatcher`/`cleanup_dispatcher` + finalize 4 사이트 + 인라인 테스트)
- Modify: `crates/controller/src/main.rs` (`set_dispatcher` 1 줄)

코디네이터가 dispatcher 핸들을 안 들어 cleanup 이 아무 데서도 안 불리던(A3a deferral) 걸 배선한다. `Arc<OnceLock<SharedDispatcher>>`(interior mutability, §스코프결정 5)로 생성 순서/clone 문제를 회피.

> **TDD 가드 노트**: `coordinator.rs` 는 인라인 `#[cfg(test)] mod tests` 가 이미 있어 그 파일 편집은 자동 통과. **`main.rs` 는 인라인 테스트가 없어** 편집이 막힌다(루트 CLAUDE.md C-1). orchestrator 가 task 시작 전 `crates/controller/tests/_tdd_keepalive.rs` 에 `#[test] fn keepalive() {}` 한 줄을 깔고, implementer 는 명시 경로로만 `git add`(절대 `-A` 금지), **커밋 전 `rm crates/controller/tests/_tdd_keepalive.rs`**.

- [ ] **Step 0 (orchestrator): keepalive 설치**

```bash
printf '#[test]\nfn keepalive() {}\n' > crates/controller/tests/_tdd_keepalive.rs
```

- [ ] **Step 1: 실패하는 인라인 테스트 작성** (`coordinator.rs` 의 `#[cfg(test)] mod tests`)

테스트 모듈 `use super::*;` 아래에 import + CountingDispatcher + 두 테스트 추가:

```rust
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingDispatcher {
        cleanups: Arc<AtomicUsize>,
    }
    #[async_trait::async_trait]
    impl crate::dispatcher::WorkerDispatcher for CountingDispatcher {
        async fn dispatch(&self, _run_id: &str, _worker_count: u32) -> anyhow::Result<()> {
            Ok(())
        }
        async fn cleanup(&self, _run_id: &str) -> anyhow::Result<()> {
            self.cleanups.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn finalize_completed_calls_dispatcher_cleanup() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let cleanups = Arc::new(AtomicUsize::new(0));
        coord.set_dispatcher(Arc::new(CountingDispatcher {
            cleanups: cleanups.clone(),
        }));
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        assert_eq!(
            cleanups.load(Ordering::SeqCst),
            1,
            "run completion must trigger dispatcher cleanup exactly once"
        );
    }

    #[tokio::test]
    async fn finalize_failed_calls_dispatcher_cleanup() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let cleanups = Arc::new(AtomicUsize::new(0));
        coord.set_dispatcher(Arc::new(CountingDispatcher {
            cleanups: cleanups.clone(),
        }));
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
        let (tx0, _r0) = fake_tx();
        let (tx1, _r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Failed as i32)
            .await;
        assert_eq!(
            cleanups.load(Ordering::SeqCst),
            1,
            "fail-fast must trigger dispatcher cleanup"
        );
    }

    #[tokio::test]
    async fn finalize_without_dispatcher_is_noop() {
        // Unit/e2e paths never call set_dispatcher → cleanup_dispatcher is a no-op
        // (handle unset). Guards against a panic/unwrap on the OnceLock.
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Completed
        );
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --lib grpc::coordinator::tests::finalize_completed_calls_dispatcher_cleanup`
Expected: FAIL — `set_dispatcher` 메서드 없음(컴파일 에러).

- [ ] **Step 3: `CoordinatorState` 에 dispatcher 핸들 + 헬퍼** (`coordinator.rs`)

파일 상단 import 에 추가:

```rust
use std::sync::OnceLock;
```

`use crate::store::Db;` 부근에 추가:

```rust
use crate::dispatcher::SharedDispatcher;
```

`CoordinatorState` struct 에 필드 추가:

```rust
#[derive(Clone)]
pub struct CoordinatorState {
    pub db: Db,
    runs: Arc<Mutex<HashMap<String, RunWorkers>>>,
    pub worker_capacity_vus: u32,
    /// Set once at startup (main.rs) so finalize paths can tear down K8s Jobs /
    /// child processes. Unset in unit/e2e tests → cleanup is a no-op. (A3c spec §7,
    /// §8.) Interior mutability so all clones (AppState.coord, CoordinatorService)
    /// share the same handle regardless of construction order.
    dispatcher: Arc<OnceLock<SharedDispatcher>>,
}
```

`with_capacity` 초기화에 `dispatcher: Arc::new(OnceLock::new()),` 추가:

```rust
    pub fn with_capacity(db: Db, worker_capacity_vus: u32) -> Self {
        Self {
            db,
            runs: Arc::new(Mutex::new(HashMap::new())),
            worker_capacity_vus,
            dispatcher: Arc::new(OnceLock::new()),
        }
    }
```

`worker_count_for` 부근(impl 블록 안)에 setter + 헬퍼 추가:

```rust
    /// Install the dispatcher handle so finalize paths can clean up. Called once
    /// at startup. Idempotent (later sets are ignored).
    pub fn set_dispatcher(&self, dispatcher: SharedDispatcher) {
        let _ = self.dispatcher.set(dispatcher);
    }

    /// Best-effort, idempotent teardown of a run's external workers. No-op if no
    /// dispatcher was installed (tests). Errors are logged, never propagated —
    /// the run is already finalized in the DB.
    async fn cleanup_dispatcher(&self, run_id: &str) {
        if let Some(d) = self.dispatcher.get() {
            if let Err(e) = d.cleanup(run_id).await {
                warn!(%run_id, error = %e, "dispatcher cleanup failed");
            }
        }
    }
```

- [ ] **Step 4: finalize 4 사이트에서 cleanup 호출** (`coordinator.rs`)

`record_phase` 의 `match decision` 세 terminal arm 끝에 각각 추가(set_status 뒤):

```rust
            Finalize::Completed => {
                let _ = runs::set_status(
                    &self.db, run_id, RunStatus::Completed, None, Some(crate::store::now_ms()),
                ).await;
                self.cleanup_dispatcher(run_id).await;
            }
            Finalize::Aborted => {
                let _ = runs::set_status(
                    &self.db, run_id, RunStatus::Aborted, None, Some(crate::store::now_ms()),
                ).await;
                self.cleanup_dispatcher(run_id).await;
            }
            Finalize::Failed(siblings) => {
                let _ = runs::set_status(
                    &self.db, run_id, RunStatus::Failed, None, Some(crate::store::now_ms()),
                ).await;
                fan_out_abort(run_id, &siblings, "sibling worker failed — fail-fast").await;
                self.cleanup_dispatcher(run_id).await;
            }
```

`worker_disconnected` 의 `if let Some(siblings) = siblings { ... }` 블록 끝(fan_out_abort 뒤)에 추가:

```rust
            fan_out_abort(
                run_id, &siblings, "worker disconnected before completing — fail-fast",
            ).await;
            self.cleanup_dispatcher(run_id).await;
```

`fail_incomplete_registration` 의 동일 블록 끝(fan_out_abort 뒤)에 추가:

```rust
            fan_out_abort(run_id, &siblings, "not all workers registered before deadline").await;
            self.cleanup_dispatcher(run_id).await;
```

> `abort()`(user-initiated)는 워커가 `Phase::Aborted` 를 보고하면 `record_phase` → `Finalize::Aborted` → cleanup 으로 닫힌다. 워커가 abort 에 응답 못 하고 끊기면 `worker_disconnected` 의 fail-fast(비-terminal) → cleanup. 두 경로 다 커버되므로 `abort()` 자체엔 cleanup 호출을 넣지 않는다(중복/조기 호출 방지 — abort 직후엔 아직 워커가 살아있을 수 있음).

- [ ] **Step 5: main.rs 배선** (`main.rs`) — dispatcher 빌드 직후(현 116행 `};` 뒤, AppState 구성 117행 전)에 1 줄:

```rust
    };
    // Let the coordinator tear down workers on finalize (completion/failure/abort).
    coord_state.set_dispatcher(dispatcher.clone());
    let state = app::AppState {
```

- [ ] **Step 6: 테스트 통과 + 전체 coordinator/lib 회귀**

Run: `cargo test -p handicap-controller --lib grpc::coordinator::`
Expected: PASS — 신규 3 + 기존 8(register/all_completed/one_failed/disconnect/all_registered/deadline/complete_then_disconnect/watchdog) 전부 green(기존 테스트는 dispatcher 미설정 → cleanup no-op, 동작 불변).

- [ ] **Step 7: keepalive 제거 + 빌드 + 커밋**

```bash
rm crates/controller/tests/_tdd_keepalive.rs
cargo build -p handicap-controller
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/main.rs
git commit -m "feat(controller): wire dispatcher.cleanup() on run finalize (A3c)"
```

> 커밋 전 `git status` 로 `_tdd_keepalive.rs` 가 staged/untracked 어디에도 없는지 확인(절대 커밋 금지).

---

## Task 4: Helm `worker.capacityVus` value → controller `--worker-capacity-vus`

**Files:**
- Modify: `deploy/helm/handicap/values.yaml`
- Modify: `deploy/helm/handicap/templates/deployment.yaml`
- Regenerate: `deploy/helm/handicap/tests/__snapshots__/*.yaml`

워커 수 N 을 결정하는 capacity 레버를 ops 가 조절할 수 있게 Helm value 로 노출(기본 2000 = 현 default = N=1 byte-identical).

- [ ] **Step 1: values.yaml 에 capacityVus 추가** — `worker:` 블록을 아래로:

```yaml
worker:
  # The image used by Jobs the controller creates. Defaults to the same image
  # as the controller — single image, two binaries.
  image: ""
  # Per-worker VU capacity. The controller fans a run out to
  # N = ceil(total_vus / capacityVus) Indexed-Job Pods. Default 2000 → most runs
  # are single-worker. Lower it to force fan-out. (A3c spec §2.1, §7.2.)
  capacityVus: 2000
```

- [ ] **Step 2: deployment.yaml args 에 플래그 추가** — `--controller-grpc-url` arg 블록(현 48-49행) 뒤에:

```yaml
            - "--controller-grpc-url"
            - "http://{{ include "handicap.controller.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.controller.grpc.port }}"
            - "--worker-capacity-vus"
            - "{{ .Values.worker.capacityVus }}"
```

- [ ] **Step 3: 렌더 확인(수동) + 스냅샷 재생성**

Run:
```bash
helm template handicap deploy/helm/handicap | grep -A1 "worker-capacity-vus"
```
Expected: `--worker-capacity-vus` 다음 줄에 `2000`(기본). 그 다음:
```bash
cd deploy/helm/handicap/tests && UPDATE_SNAPSHOTS=1 ./snapshot_test.sh && ./snapshot_test.sh
```
Expected: 첫 실행이 스냅샷 갱신, 둘째 실행 PASS(default + custom values 둘 다). custom_values.yaml 에 worker.capacityVus 오버라이드가 없다면 default 2000 으로 렌더 — 두 스냅샷 모두 새 arg 라인 포함.

> deploy/CLAUDE.md: "의도된 변경 후엔 `UPDATE_SNAPSHOTS=1` 로 재생성 — 안 하면 다음 CI 빨갛게."

- [ ] **Step 4: 커밋**

```bash
git add deploy/helm/handicap/values.yaml deploy/helm/handicap/templates/deployment.yaml deploy/helm/handicap/tests/__snapshots__/
git commit -m "feat(deploy): expose worker.capacityVus Helm value → controller flag (A3c)"
```

---

## Task 5: e2e-kind — N>1 Indexed Job fan-out 검증

**Files:**
- Modify: `scripts/e2e-kind.sh` (capacity 오버라이드 + Job-shape 어설션)
- Modify: `.github/workflows/e2e-kind.yml` (인라인 경로도 동일 오버라이드 + 어설션)

`scripts/e2e-kind.sh` 는 `deploy-kind.sh` 를 거쳐 배포하고, GH 워크플로는 자체 인라인 helm install 을 한다(스크립트 미경유) — **둘 다** capacity 를 낮춰 50 VUs → N=2 를 강제하고, 드라이버 성공 후 Job 형상을 단언한다. (드라이버의 "completed" 자체가 N 워커 전원 등록을 함의 = N Pod 스케줄 성공.)

`scripts/deploy-kind.sh` 의 helm 블록은 고정(`helm upgrade --install "$RELEASE" ... --set image.* --wait`)이고 패스스루가 없다 → `HELM_EXTRA_ARGS` 환경변수 훅을 추가해 e2e 가 capacity 를 주입한다(deploy-kind.sh 의 다른 호출자엔 무영향: unset 이면 빈 확장).

- [ ] **Step 1a: `scripts/deploy-kind.sh` — `HELM_EXTRA_ARGS` 패스스루** (현 24-28행 helm 블록을 아래로):

```bash
helm upgrade --install "$RELEASE" "$ROOT/deploy/helm/handicap" \
  --namespace "$NS" \
  --set image.repository="${IMAGE%:*}" \
  --set image.tag="${IMAGE#*:}" \
  ${HELM_EXTRA_ARGS:-} \
  --wait --timeout 3m
```

- [ ] **Step 1b: `scripts/e2e-kind.sh` — capacity 오버라이드로 deploy-kind 호출** (현 `"$ROOT/scripts/deploy-kind.sh"` 줄을 아래로; 50 VUs → N=ceil(50/25)=2):

```bash
HELM_EXTRA_ARGS="--set worker.capacityVus=25" "$ROOT/scripts/deploy-kind.sh"
```

- [ ] **Step 2: `scripts/e2e-kind.sh` — 드라이버 후 Job 형상 단언**

`cargo run ... e2e_kind_driver` 호출(현 마지막 단계) 직후, `echo "==> e2e-kind PASSED"` 전에 추가:

```bash
echo "==> verifying Indexed Job fan-out (N=2)"
JOB="$(kubectl -n "$NS" get jobs -l app.kubernetes.io/component=worker \
  -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$JOB" ]] || { echo "no worker Job found"; exit 1; }
MODE="$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.spec.completionMode}')"
COMP="$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.spec.completions}')"
SUCC="$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.status.succeeded}')"
echo "    job=$JOB mode=$MODE completions=$COMP succeeded=$SUCC"
[[ "$MODE" == "Indexed" ]] || { echo "expected Indexed Job, got '$MODE'"; exit 1; }
[[ "$COMP" == "2" ]] || { echo "expected completions=2, got '$COMP'"; exit 1; }
[[ "$SUCC" == "2" ]] || { echo "expected 2 succeeded Pods, got '$SUCC'"; exit 1; }
```

- [ ] **Step 3: `.github/workflows/e2e-kind.yml` — helm install + 어설션**

`helm upgrade --install handicap ...` 라인에 `--set worker.capacityVus=25` 추가:

```yaml
          helm upgrade --install handicap deploy/helm/handicap \
            --namespace handicap --wait --timeout 5m \
            --set worker.capacityVus=25
```

"Run e2e driver" 스텝의 `cargo run ... e2e_kind_driver` 다음 줄에 Job 형상 단언 추가(스크립트 Step 2 와 동일 bash, `NS=handicap` 고정):

```bash
          cargo run -p handicap-controller --bin e2e_kind_driver
          echo "==> verifying Indexed Job fan-out (N=2)"
          JOB="$(kubectl -n handicap get jobs -l app.kubernetes.io/component=worker -o jsonpath='{.items[0].metadata.name}')"
          MODE="$(kubectl -n handicap get job "$JOB" -o jsonpath='{.spec.completionMode}')"
          COMP="$(kubectl -n handicap get job "$JOB" -o jsonpath='{.spec.completions}')"
          SUCC="$(kubectl -n handicap get job "$JOB" -o jsonpath='{.status.succeeded}')"
          echo "job=$JOB mode=$MODE completions=$COMP succeeded=$SUCC"
          [ "$MODE" = "Indexed" ] && [ "$COMP" = "2" ] && [ "$SUCC" = "2" ] || { echo "Indexed fan-out assertion failed"; exit 1; }
```

- [ ] **Step 4: 로컬 kind 검증(가능 시) 또는 shellcheck/dry 확인**

이 repo 는 remote 미설정이라 GH 워크플로는 실제로 돌지 않으나, 로컬에서 kind 가 있으면:
Run: `just e2e-kind`
Expected: `==> Indexed Job fan-out (N=2)` 단언 통과 + `e2e-kind PASSED`.
kind 미가용이면 최소 bash 문법 확인: `bash -n scripts/e2e-kind.sh`.

> **flake/스케줄 주의**: N=2 워커 Pod 가 각 250m cpu 요청 → 단일 노드 kind 에 controller(200m)+wiremock 와 함께 떠야 한다(2-vCPU 러너 기준 합 ~700m, 여유). 등록 watchdog 60s 안에 둘 다 등록 못 하면 run Failed. 미래 CI 가 더 작은 노드면 worker 리소스 §B 배선이 필요(스코프결정 2 문서화).

- [ ] **Step 5: 커밋**

```bash
git add scripts/e2e-kind.sh .github/workflows/e2e-kind.yml
git commit -m "test(e2e-kind): assert N=2 Indexed Job fan-out (A3c)"
```

---

## Task 6: 게이트 통과 + 문서 (CLAUDE.md ×2 · ADR-0027 · 로드맵 · 루트 · 메모리)

**Files:**
- Modify: `crates/controller/CLAUDE.md`, `deploy/CLAUDE.md`, `docs/adr/0027-multi-worker-fanout.md`, `docs/roadmap.md`, 루트 `CLAUDE.md`
- Memory: `multi-worker-fanout-a3.md` / `mvp1-roadmap.md`(orchestrator)

- [ ] **Step 1: 전체 게이트** (커밋 전 필수 — 루트 CLAUDE.md 검증 훅)

```bash
cargo fmt --check
cargo build --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build -p handicap-controller --features slice6-k8s --tests   # K8s 경로 컴파일 확인(클러스터 불요)
```
Expected: 전부 green. UI 무변경 → `pnpm` 게이트 불필요(이 슬라이스는 `ui/` 무손댐).

- [ ] **Step 2: `crates/controller/CLAUDE.md` 함정 갱신** — "멀티 워커 fan-out" 섹션의 cleanup deferral 줄을 해소로 교체. 기존:

  `- **`dispatcher.cleanup()`은 아직 아무도 안 부른다 (A3c 로 연기)** (A3a): ...`

  를 아래로:

```markdown
- **A3c: `dispatcher.cleanup()` 은 `CoordinatorState` 가 finalize 시 호출** (A3c): `CoordinatorState` 가 `Arc<OnceLock<SharedDispatcher>>` 핸들을 들고(main.rs 가 dispatcher 빌드 후 `set_dispatcher` 로 1 회 주입, 모든 clone 공유), record_phase 의 Completed/Aborted/Failed arm + worker_disconnected fail-fast + fail_incomplete_registration 에서 `cleanup_dispatcher` 호출. **단위/e2e 테스트는 핸들 미설정 → no-op**(기존 테스트 무영향). cleanup 은 trait 계약상 idempotent. user abort(`abort()`)는 워커가 Aborted 보고→record_phase→cleanup, 또는 끊기면 worker_disconnected→cleanup 으로 닫히므로 `abort()` 자체엔 cleanup 미삽입(조기/중복 방지).
- **K8s 워커는 단일 Indexed Job(parallelism=completions=N), worker_id 는 Pod 가 `JOB_COMPLETION_INDEX` 로 파생** (A3c): `build_job_spec` 가 `worker_id` 대신 `worker_count` 를 받아 `completion_mode="Indexed"` + parallelism/completions=N 인 Job 1 개 생성. `handicap.io/worker-id` 라벨·`--worker-id` 컨테이너 arg 제거(Indexed Job 은 단일 id 없음 — K8s 가 Pod 마다 `JOB_COMPLETION_INDEX` env 자동 주입, 워커 `resolve_worker_id` 가 `{run_id}-w{index}` 파생). cleanup 셀렉터 `handicap.io/run-id` 무변경(Job 1 개 + ownerRef GC 로 N Pod 일괄 삭제). subprocess 는 여전히 `--worker-id` 명시 N-spawn(A3a).
```

- [ ] **Step 3: `deploy/CLAUDE.md` 함정 추가** — "Helm chart" 또는 새 "멀티 워커 Job" 섹션에:

```markdown
- **워커 Job 의 topologySpread/anti-affinity 는 반드시 soft** (A3c): `build_job_spec` 의 `topologySpreadConstraints.whenUnsatisfiable=ScheduleAnyway` + `podAntiAffinity.preferredDuringScheduling...`. **hard(`DoNotSchedule`/`required...`)로 바꾸면 단일 노드 kind 에서 2번째 워커 Pod 가 영영 Pending → 등록 watchdog(60s)이 run 을 Failed 로 → e2e-kind 깨짐.** 멀티 노드 prod 는 soft 라도 spread 됨.
- **워커 `WorkerResources::default()` 는 Guaranteed QoS(req==limit)지만 크기는 modest(250m/256Mi)** (A3c): requests==limits 가 CFS 스로틀 방지의 충실도 레버(spec §7.3)이나, 단일 노드/2-vCPU CI kind 에 N>1 Indexed Pod 가 전부 스케줄+등록돼야 e2e 통과하므로 크기를 작게. **프로덕션 고처리량은 worker cpu/mem 의 Helm values 배선(로드맵 §B full-plumbing)으로 올린다** — 현재 노출되는 워커 Helm value 는 `worker.capacityVus`(N 레버)뿐. equality 가 invariant, 크기 아님.
- **e2e-kind N>1 는 `--set worker.capacityVus=25` 로 강제** (A3c): 기본 capacity 2000 → 50 VUs 가 N=1. e2e(스크립트 + GH 워크플로 둘 다)가 capacity 를 낮춰 N=2 fan-out 을 만들고 Job `completionMode=Indexed`/`completions=2`/`succeeded=2` 를 단언. 워크플로는 `scripts/e2e-kind.sh` 미경유 인라인 helm install 이라 **양쪽 다** 고쳐야 함.
```

- [ ] **Step 4: `docs/adr/0027-multi-worker-fanout.md` 상태 갱신** — `* Status: Accepted (A3a+A3b 머지; A3c 후속)` → `* Status: Accepted (A3a+A3b+A3c 머지 — 완결)`. K8s 형상/cleanup 단락에 한 줄 추가:

```markdown
  **(A3c 머지 완료: K8s 단일 Indexed Job parallelism=completions=N + Pod 가 JOB_COMPLETION_INDEX 로 worker_id 파생, dispatcher.cleanup() 을 CoordinatorState finalize 경로에 배선(OnceLock 핸들), worker Job Guaranteed QoS + soft topologySpread/anti-affinity, Helm `worker.capacityVus` 노출. per-deploy 워커 resource Helm values 배선은 로드맵 §B 로 연기.)**
```

- [ ] **Step 5: `docs/roadmap.md` 갱신** — §A3 헤더/진행 줄의 "A3a+A3b 머지 완료" → "A3a+A3b+A3c 머지 완료(영역 A3 완결)". 분할 줄 A3c 항목에 ✅. 연기 항목에 "워커 resource per-deploy Helm values(full-plumbing)" + "반응형 HPA" + "unique 바인딩" + "best-effort/degraded" 가 §B 후보로 남아있는지 확인(없으면 한 줄 추가).

- [ ] **Step 6: 루트 `CLAUDE.md` 갱신** — 상단 상태 줄 + "알아둘 결정들" 0027 줄: "A3a(조정+proto+엔진) + A3b(메트릭 워커별 머지) 머지 완료; A3c ... 후속" → "A3a+A3b+A3c 전부 머지 완료(영역 A3 완결)". A3c 한 줄 결과 요약을 다른 슬라이스 포맷에 맞춰 추가(Indexed Job·cleanup 배선·soft topology·capacityVus value·per-deploy resource §B 연기).

- [ ] **Step 7: 문서 커밋 + conflict marker 점검**

```bash
grep -rn '^<<<<<<<\|^>>>>>>>\|^=======$' docs/ crates/controller/CLAUDE.md deploy/CLAUDE.md CLAUDE.md || echo "no markers"
git add crates/controller/CLAUDE.md deploy/CLAUDE.md docs/adr/0027-multi-worker-fanout.md docs/roadmap.md CLAUDE.md
git commit -m "docs: A3c K8s Indexed Job + cleanup wiring — traps + ADR-0027 + roadmap (A3c)"
```

- [ ] **Step 8: 메모리 갱신** (orchestrator, 커밋 후) — `multi-worker-fanout-a3.md` / `mvp1-roadmap.md` 에 "A3c 머지 완료 → 영역 A3 완결" + 핵심 락인(Indexed Job N=parallelism=completions, JOB_COMPLETION_INDEX worker_id, OnceLock dispatcher cleanup 배선, soft topology/anti-affinity, modest req==limit, capacityVus Helm value, per-deploy resource §B 연기) 한 줄.

---

## Self-Review (spec 대비 점검 결과)

**1. spec §7 + §9 A3c 커버리지:**
- §7.1 trait `dispatch(run_id, worker_count)` → A3a 완료(무변경 확인). subprocess N-spawn → A3a(무변경).
- §7.2 K8s Indexed Job(parallelism/completions/Indexed) + worker_count 입력 + `--worker-id` 제거 + JOB_COMPLETION_INDEX(워커측 A3a) → Task 1 ✅. cleanup 셀렉터 무변경 → Task 1(라벨 유지 `run-id`) ✅. backoff_limit=0/restart Never 무변경 → 기존 테스트 회귀 ✅.
- §7.3 충실도: req==limit → Task 2 ✅. topologySpread/anti-affinity(soft, 단일 노드 안전) → Task 2 ✅. Helm values 노출 = **capacity 만**(per-deploy resource 는 §B 연기, 스코프결정 1) → Task 4 ✅.
- §8 cleanup 배선(완료/실패/abort/watchdog finalize) → Task 3 ✅.
- §9 A3c 불릿(build_job_spec parallelism/completions/Indexed + worker_count + 단위테스트 / Helm values capacity·resources·topologySpread / e2e-kind N>1) → Task 1·2(단위) + Task 4(Helm) + Task 5(e2e-kind) ✅.
- §10 K8s 테스트 전략(build_job_spec 단위 + e2e-kind N>1) → Task 1·2 단위 + Task 5 e2e ✅. UI 무변경 → 게이트에서 pnpm 생략 ✅.

**2. placeholder 스캔:** 모든 코드 step 에 실제 코드/매니페스트 블록 + 정확한 명령·기대결과. "적절한 에러처리" 류 없음. (Step 1 의 deploy-kind.sh `--set` 패스스루는 "먼저 grep 확인" 분기를 명시 — 파일 미열람 상태라 양 경로 제시.)

**3. 타입/이름 일관성:** `JobSpecInput.worker_count: u32`(Task 1) ↔ kubernetes.rs `worker_count`(Task 1) ↔ `dispatch(run_id, worker_count)`(A3a trait); `WorkerResources` 4 필드 String(Task 2); `CoordinatorState.dispatcher: Arc<OnceLock<SharedDispatcher>>` + `set_dispatcher`/`cleanup_dispatcher`(Task 3) ↔ main.rs `set_dispatcher`(Task 3); Helm `worker.capacityVus`(Task 4) ↔ `--worker-capacity-vus`(기존 controller Args, Task 4 deployment) ↔ e2e `--set worker.capacityVus=25`(Task 5). build_job_spec 의 `completion_mode`/`completions`/`parallelism` = k8s-openapi 0.23 v1_30 JobSpec 실재 필드(확인됨), `topology_spread_constraints`/`affinity` = PodSpec 실재 필드(확인됨).

**리뷰어 주목 deviation**(상단 "스코프 결정" 1–6): Helm 충실도 최소안(resource per-deploy 배선 §B 연기), 워커 리소스 크기 modest(equality invariant·크기 아님), topology/anti-affinity soft 강제, worker-id 라벨/arg 제거, OnceLock cleanup 핸들, capacityVus 기본 2000(N=1 byte-identical).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-02-multi-worker-fanout-a3c.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — task 마다 fresh subagent + 2-stage 리뷰(spec compliance → code quality), task 간 검토, 최종 `handicap-reviewer`. 이 repo 표준(A3a/A3b/9c/9d/A2 동일). 워크트리는 `.claude/worktrees/` 에 `EnterWorktree`(baseRef: head), `cargo build` baseline 선행.

**2. Inline Execution** — 이 세션에서 executing-plans 로 batch 실행 + 체크포인트.

**Which approach?**
