# A3a — 멀티 워커 fan-out: 컨트롤러 조정 + proto + 엔진 글로벌 vu_id 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 run 을 컨트롤러가 N 개 워커로 결정론적으로 fan-out 하는 조정(coordination) 인프라를 깐다 — 워커 수 N 산정, VU 구간 분배, per-run 멀티워커 상태머신, 엔진 글로벌 vu_id, subprocess N-spawn. (메트릭 워커별 머지는 A3b, K8s Indexed Job 은 A3c.)

**Architecture:** 컨트롤러가 권위자다. run-create 시 `N = ceil(total_vus / worker_capacity_vus)` 를 계산하고, 디스패처가 N 워커를 띄운다. 각 워커는 register 시 컨트롤러가 배정하는 shard(`shard_index`, `vu_offset`, `vu_count`)를 `RunAssignment` 로 받아 자기 VU 슬라이스만 돈다. 엔진은 VU 를 **글로벌 id**(`vu_offset + local_index`)로 번호 매겨 `${vu_id}`·데이터바인딩이 단일워커와 동일 결과를 낸다. 컨트롤러의 기존 `pending`+`active` 단일-assignment 맵을 **per-run 멀티워커 상태머신**(`RunWorkers`)으로 재작성한다.

**Tech Stack:** Rust (tokio, tonic/prost, sqlx/SQLite), protobuf. 게이트 = `cargo fmt --check + build + clippy -D warnings + test`(워크스페이스). UI 무변경.

---

## 스코프 결정 / spec 대비 의도된 deviation (리뷰어 주목)

A3a 는 spec `docs/superpowers/specs/2026-06-01-multi-worker-fanout-design.md` §9 의 첫 분할이다. 아래는 **코드 실측 후** 내린 명시적 범위 조정이다 — 리뷰어가 "누락"이 아니라 "결정"으로 검토하도록 적는다.

1. **`dispatcher.cleanup()` 호출은 A3a 에서 추가하지 않는다 (A3c 로 연기).** spec §8.1/§8.2 는 완료·fail-fast 시 "dispatcher cleanup"을 적었으나, **현재 코드는 완료/abort 어느 경로에서도 cleanup 을 호출하지 않는다**(`grep -rn cleanup crates/controller/src` 결과: trait/impl 정의뿐, 호출부 0). 코디네이터(`grpc/coordinator.rs`)는 dispatcher 핸들조차 안 들고 있다. A3a 타깃인 **subprocess 경로에서 cleanup 은 no-op**(워커 self-terminate)이라 호출해도 기능 변화가 0 이고, K8s Job 은 `ttlSecondsAfterFinished=600` + ownerRef GC 로 정리된다. dispatcher 를 코디네이터에 배선하는 변경(**23개 `CoordinatorState::new` 사이트** — prod 1 + 테스트 22)은 K8s Indexed Job 을 재작성하는 **A3c 에서 함께** 하는 게 응집적이다. **A3a 는 fail-fast 의 기능적 핵심인 "형제 워커에 AbortRun fan-out"은 구현한다** — 외부 Job 정리만 연기.
2. **fail-fast(워커 크래시)는 단위테스트로만 커버, e2e 아님.** subprocess 로 워커를 결정론적으로 죽이는 fixture 가 없다. 워커 stream 단절 → run Failed + 형제 abort 로직은 `worker_disconnected`/`record_phase` 단위테스트(in-memory db + 합성 mpsc 채널)로 검증한다. e2e(Task 7)는 **abort fan-out**(N=2 → POST abort → aborted)으로 다워커 종료 경로를 커버한다.
3. **K8s 디스패처는 A3a 에서 단일 Job 유지.** trait 시그니처(`dispatch(run_id, worker_count)`)만 맞추고, `KubernetesDispatcher` 는 worker_id 1 개를 내부 생성해 **현행 단일 Job** 을 만든다(`worker_count>1` 이면 warn 로그). Indexed Job(`parallelism=N`)은 A3c. 따라서 `dispatcher_spec_test.rs`(build_job_spec 단위테스트)는 **무변경**으로 통과한다.
4. **데이터 바인딩 검증/해석(runs.rs)은 무변경.** spec §6.1/§6.3 의 `per_vu = min(total_vus, rows)` 는 이미 `body.profile.vus`(=총VU) 기준(runs.rs:132)이라 손댈 게 없다. 각 워커는 register 시 동일 row_count 를 복제 수신(기존 스트리밍 루프가 connection 당 1 회 → 워커마다 자동 반복).

---

## 파일 구조 맵 (무엇을, 왜)

생성:
- `crates/controller/src/grpc/shard.rs` — 순수 함수 `worker_count`/`shard_split`(테스트 가능, gRPC/tonic 무관).
- `crates/engine/tests/vu_offset.rs` — 글로벌 vu_id 통합테스트(wiremock).
- `crates/controller/tests/multi_worker_fanout_e2e.rs` — N=2 subprocess fan-out e2e.

수정(책임):
- `crates/proto/proto/coordinator.proto` — `RunAssignment` 에 shard 4 필드(`shard_index/shard_count/vu_offset/vu_count`).
- `crates/engine/src/runner.rs` — `RunPlan.vu_offset` + 글로벌 vu_id(`vu_offset + spawned`).
- `crates/worker/src/main.rs` — `assignment.vu_count/vu_offset` → RunPlan; `--worker-id` optional + `JOB_COMPLETION_INDEX` fallback(`resolve_worker_id`).
- `crates/controller/src/grpc/coordinator.rs` — `CoordinatorState` per-run 상태머신(`RunWorkers`/`WorkerEntry`), Register/RunStatus/close arm 재작성, watchdog, abort fan-out, capacity.
- `crates/controller/src/grpc/mod.rs` — `pub mod shard;`.
- `crates/controller/src/api/runs.rs` — run-create 에서 N 산정 + `enqueue(base, N, total_vus)` + `dispatch(run_id, N)`.
- `crates/controller/src/dispatcher/{mod,subprocess,kubernetes}.rs` — trait `dispatch(run_id, worker_count)`, subprocess N-spawn, K8s 적응.
- `crates/controller/src/main.rs` — `--worker-capacity-vus` 플래그 → `CoordinatorState::with_capacity`.
- `crates/controller/Cargo.toml` — `tokio-util = { workspace = true, features = ["rt"] }`(watchdog 의 `CancellationToken` — engine/worker-core 와 동일 설정). dev-deps 변경 **불필요**: workspace `tokio = features=["full"]` 가 이미 `test-util` 포함이라 `start_paused` 가 그대로 동작(controller `[dev-dependencies]` 엔 tokio 줄이 없고 `[dependencies]` 의 `tokio.workspace=true` 로 받는다).
- 다수 테스트 fixture: RunPlan literal(~20)·RunAssignment literal(1)·dispatch 호출(2) — Task 별로 명시.

문서(Task 8): `docs/adr/0027-*.md`, 루트 `CLAUDE.md`(결정·인덱스), `crates/controller/CLAUDE.md`/`crates/engine/CLAUDE.md`/`crates/worker-core/CLAUDE.md`(함정), `docs/roadmap.md`, memory.

---

## Task 1: 엔진 — `RunPlan.vu_offset` + 글로벌 vu_id

**Files:**
- Modify: `crates/engine/src/runner.rs` (RunPlan struct, `run_scenario` vu_id 계산)
- Create: `crates/engine/tests/vu_offset.rs`
- Modify (RunPlan literal에 `vu_offset: 0,` 추가): 아래 Step 5 목록

- [ ] **Step 1: 글로벌 vu_id 통합테스트 작성 (failing)**

`crates/engine/tests/vu_offset.rs`:

```rust
//! Global vu_id: a worker running a shard slice numbers its VUs by the global
//! `vu_offset + local_index`, so `${vu_id}` (and data-binding selection) match
//! single-worker numbering. (A3a spec §3.)
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn run_with_offset(target: &str, vu_offset: u32, vus: u32) {
    let yaml = format!(
        "version: 1\nname: vu-offset\nvariables:\n  base: \"{target}\"\nsteps:\n  - id: \"01HX0000000000000000000010\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n"
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parse"));
    let plan = RunPlan {
        vus,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset,
        data_binding: None,
    };
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(scenario, plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_vu_id_reflects_offset() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    // Shard with offset 10, 2 VUs → vu_ids 10 and 11 must reach the target.
    run_with_offset(&server.uri(), 10, 2).await;

    let reqs = server.received_requests().await.unwrap();
    let qs: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(qs.iter().any(|q| q.contains("vu=10")), "vu=10 missing: {qs:?}");
    assert!(qs.iter().any(|q| q.contains("vu=11")), "vu=11 missing: {qs:?}");
    assert!(!qs.iter().any(|q| q.contains("vu=0")), "offset ignored: {qs:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vu_offset_zero_is_legacy_numbering() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    run_with_offset(&server.uri(), 0, 2).await;

    let reqs = server.received_requests().await.unwrap();
    let qs: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(qs.iter().any(|q| q.contains("vu=0")), "vu=0 missing: {qs:?}");
    assert!(qs.iter().any(|q| q.contains("vu=1")), "vu=1 missing: {qs:?}");
}
```

- [ ] **Step 2: 컴파일 확인 → 실패 확인**

Run: `cargo test -p handicap-engine --test vu_offset`
Expected: 컴파일 에러 (`RunPlan` 에 `vu_offset` 필드 없음). 이게 첫 RED.

- [ ] **Step 3: `RunPlan` 에 `vu_offset` 추가 + 글로벌 vu_id**

`crates/engine/src/runner.rs` RunPlan struct(현 19-28행)에 필드 추가:

```rust
#[derive(Debug, Clone)]
pub struct RunPlan {
    pub vus: u32,
    pub ramp_up: Duration,
    pub duration: Duration,
    pub env: BTreeMap<String, String>,
    pub loop_breakdown_cap: u32,
    /// Global VU id offset for this shard: `vu_id = vu_offset + local_spawn_index`.
    /// `0` for a single-worker run (legacy numbering). (A3a spec §3.)
    pub vu_offset: u32,
    /// Optional data-driven binding. `None` → no injection (back-compat).
    pub data_binding: Option<Arc<DataSet>>,
}
```

`run_scenario` 의 spawn 루프(현 90행 `let vu_id = spawned;`)를 글로벌로:

```rust
            let vu_id = plan.vu_offset + spawned;
```

(`spawned` 는 0..plan.vus 로컬 루프 카운터로 **그대로 유지** — 종료조건 `spawned >= plan.vus`·`plan.vus - spawned` 은 슬라이스 크기 기준이라 로컬이어야 한다. `vu_id` 만 글로벌. `plan.vu_offset` 은 `u32`(Copy)라 line 52 의 `plan.env` 부분 이동 후에도 접근 가능.)

- [ ] **Step 4: 글로벌 vu_id 테스트 통과 확인**

Run: `cargo test -p handicap-engine --test vu_offset`
Expected: 컴파일 통과 후 두 테스트 PASS.

- [ ] **Step 5: 모든 RunPlan literal 에 `vu_offset: 0,` 추가**

아래 각 파일의 `RunPlan { … }` literal 에 `vu_offset: 0,` 을 **`loop_breakdown_cap: …,` 줄 바로 다음**에 삽입(모든 literal 이 `loop_breakdown_cap` 을 가져 공통 앵커). 정확한 위치:

- `crates/worker/src/main.rs:168` — **여기는 `vu_offset: 0` 이 아니라** Task 3 에서 `assignment.vu_offset` 로 채운다. **이 Step 에서는 일단 `vu_offset: 0,` 로 두고**(컴파일 green), Task 3 가 교체. (지금 0 으로 둬도 단일워커 = 정확.)
- `crates/worker/tests/abort_and_env.rs:47, :67`
- `crates/engine/tests/assertions.rs:50`
- `crates/engine/tests/if_node.rs:35, :256, :413`
- `crates/engine/tests/all_vus_failed.rs:29`
- `crates/engine/tests/runner_e2e.rs:40`
- `crates/engine/tests/multi_step.rs:64, :171, :232, :293`
- `crates/engine/tests/loop_node.rs:58, :137, :212`
- `crates/engine/tests/data_binding.rs:52, :115, :178`
- `crates/engine/tests/ramp_up.rs:41`

각 literal 예(데이터바인딩 있는 경우):

```rust
    let plan = RunPlan {
        vus: 2,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: Some(Arc::new(ds)),
    };
```

검증 명령(누락 잡기): 현재 `grep -rn "RunPlan {" crates/ | wc -l` = **21**(struct def runner.rs:20 1개 + literal 20개 = 위 목록 정확히 20). Task 1 이 새 `vu_offset.rs` literal 1개를 더해 **22**가 된다. 모든 literal 에 `vu_offset` 이 들어갔는지: `grep -rn "vu_offset:" crates/engine crates/worker | wc -l` 가 production main.rs 1 + 기존 test literal 20 + vu_offset.rs 1 = **22** 인지 교차 확인. **`RunPlan {` literal 이 하나라도 `vu_offset` 없이 남으면 컴파일 에러로 잡힌다.**

- [ ] **Step 6: 엔진 + 워커 전체 빌드/테스트 green**

Run: `cargo build -p handicap-engine -p handicap-worker && cargo test -p handicap-engine`
Expected: 전부 PASS. (worker 테스트는 Task 3 전이라 RunPlan literal 만 고쳐도 green.)

- [ ] **Step 7: vu_id identity-only 검증 (spec §3.1 — 코드 확인, 테스트 아님)**

`grep -rn "vu_id" crates/engine/src/` 로 vu_id 사용처가 **identity-only**(① `template.rs:133` `${vu_id}` 렌더, ② `dataset.rs` `select_index`/`mix` 의 인자)인지 확인. **vus-크기 구조의 인덱스로 쓰는 곳이 없어야** 글로벌화가 out-of-bounds 를 안 낸다. (이미 확인됨: `dataset.rs` 의 `(vu_id as usize) % len` 은 modulo 라 글로벌 값도 안전, `mix` 는 seed 재현용.) plan 작성 시점 결과를 PR 설명/커밋 메시지에 한 줄 남긴다.

- [ ] **Step 8: 커밋**

```bash
git add crates/engine/src/runner.rs crates/engine/tests/vu_offset.rs \
        crates/engine/tests/*.rs crates/worker/src/main.rs crates/worker/tests/abort_and_env.rs
git commit -m "feat(engine): RunPlan.vu_offset + global vu_id (A3a)"
```

---

## Task 2: proto — `RunAssignment` shard 필드

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`
- Modify: `crates/proto/tests/run_assignment_env_test.rs` (fixture + assertion)
- Modify: `crates/controller/src/grpc/coordinator.rs:140` (단일워커 값으로 채워 컴파일 유지 — Task 5 가 재작성)

- [ ] **Step 1: proto 테스트에 shard 필드 assertion 추가 (failing)**

`crates/proto/tests/run_assignment_env_test.rs` 의 `RunAssignment` literal 에 4 필드를 추가하고 assertion 을 더한다:

```rust
    let a = RunAssignment {
        run_id: "r1".to_string(),
        scenario_yaml: "yaml: true".to_string(),
        profile: Some(Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 10,
            loop_breakdown_cap: 0,
        }),
        env,
        data_binding: None,
        shard_index: 2,
        shard_count: 4,
        vu_offset: 10,
        vu_count: 5,
    };
    assert_eq!(
        a.env.get("BASE_URL").map(String::as_str),
        Some("http://example.com")
    );
    assert_eq!((a.shard_index, a.shard_count, a.vu_offset, a.vu_count), (2, 4, 10, 5));
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-proto --test run_assignment_env_test`
Expected: 컴파일 에러 (`RunAssignment` 에 `shard_index` 등 없음).

- [ ] **Step 3: proto 에 shard 4 필드 추가**

`crates/proto/proto/coordinator.proto` 의 `RunAssignment`(현 86-92행):

```proto
message RunAssignment {
  string run_id = 1;
  string scenario_yaml = 2;     // canonical scenario YAML, snapshotted
  Profile profile = 3;          // Profile.vus = 총 VU (참조)
  map<string, string> env = 4;
  DataBinding data_binding = 5;   // absent → no data injection (back-compat)
  uint32 shard_index = 6;         // 0..shard_count-1
  uint32 shard_count = 7;         // = N (워커 수)
  uint32 vu_offset = 8;           // 이 워커의 글로벌 VU 시작 (= RunPlan.vu_offset)
  uint32 vu_count = 9;            // 이 워커가 도는 VU 수 (= RunPlan.vus)
}
```

- [ ] **Step 4: 컨트롤러 단일워커 literal 을 새 필드로 채워 컴파일 유지**

`crates/controller/src/grpc/coordinator.rs` 의 register handler(현 137-152행). `a.profile` 이 `Some(a.profile)` 로 이동되기 **전에** vus 를 캡처한 뒤 단일워커 값으로 채운다(Task 5 가 통째 재작성하므로 임시):

```rust
                        let pending = state.pending.lock().await.remove(&reg.run_id);
                        match pending {
                            Some(a) => {
                                let total_vus = a.profile.vus;
                                let assignment = RunAssignment {
                                    run_id: reg.run_id.clone(),
                                    scenario_yaml: a.scenario_yaml.clone(),
                                    profile: Some(a.profile),
                                    env: a.env.clone(),
                                    data_binding: a.data_binding.as_ref().map(|b| {
                                        pb::DataBinding {
                                            policy: b.policy as i32,
                                            seed: b.seed,
                                            row_count: b.row_count,
                                        }
                                    }),
                                    shard_index: 0,
                                    shard_count: 1,
                                    vu_offset: 0,
                                    vu_count: total_vus,
                                };
```

- [ ] **Step 5: proto + 컨트롤러 빌드/테스트 통과**

Run: `cargo test -p handicap-proto && cargo build -p handicap-controller`
Expected: PASS. (다른 RunAssignment literal 은 `client.rs` 가 디코드만 해서 literal 이 없다 — grep 으로 재확인: `grep -rn "RunAssignment {" crates/` 가 proto 테스트 + coordinator.rs 두 곳뿐.)

- [ ] **Step 6: 커밋**

```bash
git add crates/proto/proto/coordinator.proto crates/proto/tests/run_assignment_env_test.rs \
        crates/controller/src/grpc/coordinator.rs
git commit -m "feat(proto): RunAssignment shard fields (A3a)"
```

---

## Task 3: 워커 — vu_count/vu_offset 소비 + `--worker-id` optional + `JOB_COMPLETION_INDEX` fallback

**Files:**
- Modify: `crates/worker/src/main.rs` (Args.worker_id → Option, `resolve_worker_id`, RunPlan 배선, inline test)

- [ ] **Step 1: `resolve_worker_id` 단위테스트 작성 (failing)**

`crates/worker/src/main.rs` 의 `#[cfg(test)] mod tests`(현 323행 부근)에 추가:

```rust
    #[test]
    fn resolve_worker_id_prefers_explicit_arg() {
        assert_eq!(
            resolve_worker_id(Some("w-explicit".to_string()), "run-1", None),
            "w-explicit"
        );
    }

    #[test]
    fn resolve_worker_id_falls_back_to_completion_index() {
        // K8s Indexed Job: no --worker-id, JOB_COMPLETION_INDEX present.
        assert_eq!(
            resolve_worker_id(None, "run-9", Some("3".to_string())),
            "run-9-w3"
        );
    }

    #[test]
    fn resolve_worker_id_defaults_when_nothing_present() {
        // Neither arg nor env (shouldn't happen in practice) → deterministic id.
        assert_eq!(resolve_worker_id(None, "run-9", None), "run-9-w0");
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-worker resolve_worker_id`
Expected: 컴파일 에러 (`resolve_worker_id` 없음).

- [ ] **Step 3: `resolve_worker_id` 구현 + Args.worker_id optional**

`crates/worker/src/main.rs`:

Args 의 `worker_id` 를 optional 로(현 26-27행):

```rust
    /// Explicit worker id. If omitted (K8s Indexed Job), derived from
    /// JOB_COMPLETION_INDEX as "{run_id}-w{index}". (A3a spec §7.2.)
    #[arg(long)]
    worker_id: Option<String>,
```

`main` 진입부(현 39-40행 `let args = Args::parse();` 직후)에 해석:

```rust
    let args = Args::parse();
    let worker_id = resolve_worker_id(
        args.worker_id.clone(),
        &args.run_id,
        std::env::var("JOB_COMPLETION_INDEX").ok(),
    );
    info!(?args, %worker_id, "worker starting");
```

`main` 안에서 이후 `args.worker_id` 를 쓰는 곳을 **`worker_id`(해석값)로** 교체:
- `connect_with_backoff(&args.controller, &worker_id, &args.run_id, …)` (현 68행 `&args.worker_id`)
- `let worker_id = args.worker_id.clone();` (현 186행) → `let worker_id = worker_id.clone();` (forwarder 용; 이 local 이 235행 forwarder 클로저로 move 된다)

(`args.worker_id` 직접 참조가 더 남았는지 `grep -n "args.worker_id" crates/worker/src/main.rs` 로 확인 후 전부 교체 — 라인 번호에 의존하지 말고 grep 으로.)

순수 헬퍼(파일 하단, `phase_for_result` 부근):

```rust
/// Resolve the worker id: explicit `--worker-id` wins; otherwise (K8s Indexed
/// Job) derive `"{run_id}-w{index}"` from `JOB_COMPLETION_INDEX` (default index
/// 0 if unset). Subprocess always passes `--worker-id`, so the fallback is the
/// K8s path only. (A3a spec §7.2.)
fn resolve_worker_id(arg: Option<String>, run_id: &str, completion_index: Option<String>) -> String {
    match arg {
        Some(id) => id,
        None => {
            let idx = completion_index.unwrap_or_else(|| "0".to_string());
            format!("{run_id}-w{idx}")
        }
    }
}
```

- [ ] **Step 4: RunPlan 을 assignment.vu_count/vu_offset 으로 배선**

`crates/worker/src/main.rs` 의 RunPlan 구성(현 168-175행, Task 1 에서 `vu_offset: 0` 으로 둔 자리):

```rust
    let plan = RunPlan {
        vus: assignment.vu_count,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(profile.duration_seconds.into()),
        env,
        loop_breakdown_cap: profile.loop_breakdown_cap,
        vu_offset: assignment.vu_offset,
        data_binding: dataset,
    };
```

(`assignment` 은 `link.assignment`(현 85행)에서 온 `RunAssignment`. `assignment.vu_count`/`vu_offset` 은 Task 2 이후 존재. 단일워커 경로에선 Task 2 가 `vu_count = total_vus`, `vu_offset = 0` 으로 보내 byte-identical.)

- [ ] **Step 5: 테스트/빌드 통과**

Run: `cargo test -p handicap-worker`
Expected: `resolve_worker_id` 3 테스트 + 기존 phase 테스트 PASS.

- [ ] **Step 6: 커밋**

```bash
git add crates/worker/src/main.rs
git commit -m "feat(worker): consume shard vu_count/vu_offset; --worker-id optional + JOB_COMPLETION_INDEX (A3a)"
```

---

## Task 4: 컨트롤러 — shard 산술 순수 함수

**Files:**
- Create: `crates/controller/src/grpc/shard.rs`
- Modify: `crates/controller/src/grpc/mod.rs` (`pub mod shard;`)

- [ ] **Step 1: `shard.rs` 작성 (함수 + 인라인 테스트)**

`crates/controller/src/grpc/shard.rs`:

```rust
//! Pure fan-out arithmetic: how many workers, and how the VU range splits
//! across them. Deterministic and tonic-free so it unit-tests in isolation.
//! (A3a spec §2.1, §3.2.)

/// Number of workers for a run: `ceil(total_vus / capacity)`, at least 1.
/// `capacity == 0` is treated as 1 (defensive — the CLI default is 2000).
pub fn worker_count(total_vus: u32, capacity: u32) -> u32 {
    let cap = capacity.max(1);
    total_vus.div_ceil(cap).max(1)
}

/// VU slice for shard `i` of `n`: contiguous, disjoint, summing to `total_vus`.
/// The first `total_vus % n` shards get one extra VU. Returns `(vu_offset, vu_count)`.
pub fn shard_split(total_vus: u32, n: u32, i: u32) -> (u32, u32) {
    debug_assert!(n >= 1, "shard_split needs n >= 1");
    debug_assert!(i < n, "shard index out of range");
    let base = total_vus / n;
    let rem = total_vus % n;
    let extra = if i < rem { 1 } else { 0 };
    let vu_count = base + extra;
    let vu_offset = i * base + i.min(rem);
    (vu_offset, vu_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_count_ceils_and_floors_at_one() {
        assert_eq!(worker_count(2000, 2000), 1);
        assert_eq!(worker_count(2001, 2000), 2);
        assert_eq!(worker_count(1, 2000), 1);
        assert_eq!(worker_count(5000, 2000), 3);
        assert_eq!(worker_count(10, 0), 10); // capacity 0 → treated as 1
        assert_eq!(worker_count(0, 2000), 1); // never 0 (vus>0 enforced upstream anyway)
    }

    #[test]
    fn shard_split_is_contiguous_disjoint_and_sums() {
        // V=2, N=2 → (0,1),(1,1)
        assert_eq!(shard_split(2, 2, 0), (0, 1));
        assert_eq!(shard_split(2, 2, 1), (1, 1));
        // V=5, N=2 → (0,3),(3,2)  (first shard gets the remainder)
        assert_eq!(shard_split(5, 2, 0), (0, 3));
        assert_eq!(shard_split(5, 2, 1), (3, 2));
    }

    #[test]
    fn shard_split_covers_range_exactly_for_many_shapes() {
        for &(v, n) in &[(7u32, 3u32), (10, 4), (1, 1), (100, 7), (3, 5)] {
            let n_eff = n.min(v).max(1); // when n>v, trailing shards get 0 count
            let mut covered = vec![false; v as usize];
            let mut total = 0u32;
            for i in 0..n {
                let (off, cnt) = shard_split(v, n, i);
                total += cnt;
                for k in off..off + cnt {
                    assert!(!covered[k as usize], "overlap at vu {k} (v={v},n={n})");
                    covered[k as usize] = true;
                }
            }
            assert_eq!(total, v, "counts must sum to total (v={v},n={n})");
            assert!(covered.iter().all(|&c| c), "gap in coverage (v={v},n={n})");
            let _ = n_eff;
        }
    }
}
```

- [ ] **Step 2: 모듈 등록**

`crates/controller/src/grpc/mod.rs` 에 추가:

```rust
pub mod shard;
```

(현 `mod.rs` 내용 확인 후 `pub mod coordinator;` 옆에 한 줄. `coordinator` 가 `shard` 를 쓰므로 둘 다 pub.)

- [ ] **Step 3: 테스트 통과**

Run: `cargo test -p handicap-controller --lib shard`
Expected: 3 테스트 PASS.

- [ ] **Step 4: 커밋**

```bash
git add crates/controller/src/grpc/shard.rs crates/controller/src/grpc/mod.rs
git commit -m "feat(controller): pure shard fan-out arithmetic (A3a)"
```

---

## Task 5: 컨트롤러 — `CoordinatorState` per-run 멀티워커 상태머신

기존 `pending`+`active` 단일-assignment 맵을 per-run `RunWorkers` 맵으로 재작성한다. Register/RunStatus/stream-close arm 을 다워커-인지로 바꾸고, 워커 수 capacity·등록 watchdog·전원완료/fail-fast 집계·abort fan-out 을 넣는다. **이 Task 끝에서도 모든 기존 테스트가 green**이어야 한다(capacity 기본 2000 → 테스트 VU 는 전부 N=1 → 단일워커 byte-identical; dispatch 시그니처는 아직 단일 — Task 6 에서 N-spawn).

**Files:**
- Modify: `crates/controller/Cargo.toml` (deps `tokio-util` `features=["rt"]`; dev-deps 무변경)
- Modify: `crates/controller/src/grpc/coordinator.rs` (전면 재작성)
- Modify: `crates/controller/src/api/runs.rs` (`create` 의 enqueue 호출)
- Modify: `crates/controller/src/main.rs` (`--worker-capacity-vus` → `with_capacity`)

- [ ] **Step 1: Cargo deps 추가 (`tokio-util` 만)**

`crates/controller/Cargo.toml` `[dependencies]` 에 — **engine/worker-core 와 동일하게 `features = ["rt"]`**(bare `workspace = true` 아님; workspace 가 `tokio-util = { version = "0.7", default-features = false }` 라 features 를 안 켜면 `rt` 가 빠진다. `CancellationToken` 은 `tokio_util::sync` 라 feature 무관하게 컴파일될 공산이 크지만, 엔진(`crates/engine/Cargo.toml:22`)·worker-core 가 검증된 `["rt"]` 를 쓰므로 그대로 맞춘다):

```toml
tokio-util = { workspace = true, features = ["rt"] }
```

**dev-deps 는 손대지 않는다**: paused-time watchdog 테스트의 `#[tokio::test(start_paused = true)]` 는 workspace `tokio = { version = "1", features = ["full"] }`(루트 `Cargo.toml:39`)에 이미 포함된 `test-util` 로 동작한다. controller `[dev-dependencies]` 엔 `tokio` 줄이 없고 `[dependencies]` 의 `tokio.workspace = true` 로 받으므로 **추가/병합할 게 없다**(이 사실을 `grep -n "tokio" crates/controller/Cargo.toml` 로 한 번 확인).

Run: `cargo build -p handicap-controller`
Expected: deps 추가 후 빌드 통과(아직 코드 변경 전).

- [ ] **Step 2: 상태머신 단위테스트 작성 (failing)**

`crates/controller/src/grpc/coordinator.rs` 하단에 `#[cfg(test)] mod tests` 추가. (DB 는 in-memory, run row 를 미리 insert. tx 는 합성 mpsc 채널. `RegisterOutcome`/`record_phase`/`abort`/`worker_disconnected`/`fail_incomplete_registration` 를 직접 구동.)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::runs::{self, Profile, RunStatus};

    fn base_assignment() -> PendingAssignment {
        PendingAssignment {
            scenario_yaml: "version: 1\nname: t\nsteps: []\n".to_string(),
            profile: Profile2 { vus: 4, ramp_up_seconds: 0, duration_seconds: 1, loop_breakdown_cap: 0 },
            env: HashMap::new(),
            data_binding: None,
        }
    }

    // helper to insert a run row so set_status has a target.
    async fn seed_run(db: &Db) -> String {
        let scenario_yaml = "version: 1\nname: t\nsteps: []\n";
        let sc: handicap_engine::Scenario = serde_yaml::from_str(scenario_yaml).unwrap();
        let scenario = crate::store::scenarios::insert(db, &sc, scenario_yaml).await.unwrap();
        let profile = runs::Profile { vus: 4, ramp_up_seconds: 0, duration_seconds: 1, loop_breakdown_cap: 256, data_binding: None };
        let row = runs::insert(db, &scenario.id, scenario_yaml, &profile, &serde_json::json!({})).await.unwrap();
        row.id
    }

    fn fake_tx() -> (WorkerTx, tokio::sync::mpsc::Receiver<Result<ServerMessage, Status>>) {
        tokio::sync::mpsc::channel(8)
    }

    #[tokio::test]
    async fn register_assigns_distinct_shards_and_resends_on_reregister() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db);
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;

        let (tx0, _r0) = fake_tx();
        let o0 = coord.register(&run_id, "w0", tx0.clone()).await;
        let (tx1, _r1) = fake_tx();
        let o1 = coord.register(&run_id, "w1", tx1).await;
        match (o0, o1) {
            (RegisterOutcome::Assigned { shard_index: 0, vu_offset: 0, vu_count: 2, first: true, shard_count: 2 },
             RegisterOutcome::Assigned { shard_index: 1, vu_offset: 2, vu_count: 2, first: false, shard_count: 2 }) => {}
            other => panic!("unexpected outcomes: {other:?}"),
        }
        // Re-register w0 (idempotent): same shard, NOT a new slot.
        match coord.register(&run_id, "w0", tx0).await {
            RegisterOutcome::Resend { shard_index: 0, vu_offset: 0, vu_count: 2, .. } => {}
            other => panic!("expected idempotent resend, got {other:?}"),
        }
        // A 3rd distinct worker over-registers (expected=2): reject.
        let (tx2, _r2) = fake_tx();
        assert!(matches!(coord.register(&run_id, "w2", tx2).await, RegisterOutcome::Reject));
    }

    #[tokio::test]
    async fn all_completed_sets_run_completed() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
        let (tx0, _r0) = fake_tx();
        let (tx1, _r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        coord.record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32).await;
        // not all done yet
        assert_eq!(runs::get(&db, &run_id).await.unwrap().unwrap().status, RunStatus::Running);
        coord.record_phase(&run_id, "w1", pb::run_status::Phase::Completed as i32).await;
        assert_eq!(runs::get(&db, &run_id).await.unwrap().unwrap().status, RunStatus::Completed);
    }

    #[tokio::test]
    async fn one_failed_fails_run_and_aborts_siblings() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
        let (tx0, _r0) = fake_tx();
        let (tx1, mut r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        coord.record_phase(&run_id, "w0", pb::run_status::Phase::Failed as i32).await;
        assert_eq!(runs::get(&db, &run_id).await.unwrap().unwrap().status, RunStatus::Failed);
        // sibling w1 received an AbortRun.
        let msg = r1.try_recv().expect("sibling should get AbortRun");
        let msg = msg.unwrap();
        assert!(matches!(msg.payload, Some(ServerPayload::Abort(_))));
    }

    #[tokio::test]
    async fn disconnect_without_terminal_fails_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
        let (tx0, _r0) = fake_tx();
        let (tx1, _r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        // w0 drops without reporting a terminal phase → fail-fast.
        coord.worker_disconnected(&run_id, "w0").await;
        assert_eq!(runs::get(&db, &run_id).await.unwrap().unwrap().status, RunStatus::Failed);
    }

    #[tokio::test]
    async fn all_registered_cancels_registration_deadline() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db);
        let token = coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
        assert!(!token.is_cancelled());
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        assert!(token.is_cancelled(), "all-registered must cancel the watchdog token");
    }

    #[tokio::test]
    async fn registration_deadline_fails_incomplete_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
        let (tx0, mut r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await; // only 1 of 2 registers
        coord.fail_incomplete_registration(&run_id).await;
        assert_eq!(runs::get(&db, &run_id).await.unwrap().unwrap().status, RunStatus::Failed);
        // the one registered worker is told to abort.
        assert!(r0.try_recv().is_ok(), "registered worker should get AbortRun on deadline");
    }

    #[tokio::test(start_paused = true)]
    async fn watchdog_fires_after_deadline() {
        // Tests the REAL wiring: `enqueue` spawns the internal watchdog with
        // REGISTRATION_DEADLINE. Only 1 of 2 workers registers, so the token is
        // NOT cancelled; advancing the paused clock past the deadline lets the
        // enqueue-spawned watchdog fire → run Failed. (No hand-rolled watchdog.)
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await; // 1 of 2 → token stays live
        // start_paused → this sleep auto-advances virtual time past the deadline,
        // waking the internal watchdog (REGISTRATION_DEADLINE is visible to the
        // child test module as a private parent-item).
        tokio::time::sleep(REGISTRATION_DEADLINE + std::time::Duration::from_secs(1)).await;
        assert_eq!(runs::get(&db, &run_id).await.unwrap().unwrap().status, RunStatus::Failed);
    }
}
```

> 주의: 위 테스트는 `Profile2` 라는 가짜 이름을 쓰지 않는다 — `PendingAssignment.profile` 은 `pb::Profile`(proto)다. `base_assignment()` 의 `profile` 을 `pb::Profile { vus:4, ramp_up_seconds:0, duration_seconds:1, loop_breakdown_cap:0 }` 로 적을 것(위 의사코드의 `Profile2` 는 `pb::Profile` 로 교체). import 는 파일 상단의 `use pb::{… Profile …}` 활용.

- [ ] **Step 3: 실패 확인**

Run: `cargo test -p handicap-controller --lib coordinator`
Expected: 컴파일 에러(`RunWorkers`/`RegisterOutcome`/`register`/`record_phase`/… 없음).

- [ ] **Step 4: `coordinator.rs` 전면 재작성**

`crates/controller/src/grpc/coordinator.rs` 를 아래로 교체. (`PendingAssignment`/`PendingDataBinding`/`DATASET_BATCH_ROWS`/데이터셋 스트리밍 블록은 보존. 새: `RunWorkers`/`WorkerEntry`/`RegisterOutcome`/상태 메서드/watchdog. `pending`+`active` 제거.)

```rust
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use tokio::sync::Mutex;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status, Streaming};
use tracing::{error, info, warn};

use handicap_proto::v1 as pb;
use pb::coordinator_server::Coordinator;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{AbortRun, Profile, RunAssignment, ServerMessage, WorkerMessage};

use crate::binding::Mapping;
use crate::grpc::shard::{shard_split, worker_count};
use crate::store::Db;
use crate::store::runs::{self, RunStatus};

const DATASET_BATCH_ROWS: i64 = 1000;

/// Default per-worker VU capacity used to derive the worker count N. Overridable
/// via the controller's `--worker-capacity-vus` flag (spec §2.1).
pub const DEFAULT_WORKER_CAPACITY_VUS: u32 = 2000;

/// How long to wait for all N workers to register before failing the run
/// fast (spec §8.3). Aligned with worker-core `reconnect::TOTAL_CAP` (60s).
const REGISTRATION_DEADLINE: Duration = Duration::from_secs(60);

// ---- PendingDataBinding / PendingAssignment (unchanged) ----

#[derive(Debug, Clone)]
pub struct PendingDataBinding {
    pub dataset_id: String,
    pub policy: pb::data_binding::Policy,
    pub seed: u32,
    pub mappings: Vec<Mapping>,
    pub row_count: u64,
}

impl PendingDataBinding {
    pub fn mappings_apply(
        &self,
        source: &std::collections::BTreeMap<String, String>,
    ) -> std::collections::BTreeMap<String, String> {
        crate::binding::apply_mappings(&self.mappings, source)
    }
}

/// Worker-common base for a run's assignment (scenario/profile/env/binding).
/// Per-worker shard fields are filled at register time.
#[derive(Debug, Clone)]
pub struct PendingAssignment {
    pub scenario_yaml: String,
    pub profile: Profile,
    pub env: HashMap<String, String>,
    pub data_binding: Option<PendingDataBinding>,
}

type WorkerTx = tokio::sync::mpsc::Sender<Result<ServerMessage, Status>>;

/// One connected worker's slot in a run.
struct WorkerEntry {
    shard_index: u32,
    vu_offset: u32,
    vu_count: u32,
    tx: WorkerTx,
    phase: pb::run_status::Phase,
}

/// Per-run coordination state across N workers (replaces single-assignment
/// pending+active maps). (Spec §2.3.)
struct RunWorkers {
    base: PendingAssignment,
    expected: u32,
    total_vus: u32,
    next_shard: u32,
    workers: HashMap<String, WorkerEntry>,
    reg_deadline: CancellationToken,
    terminal: bool,
}

/// Outcome of a Register, returned to the stream handler to drive I/O.
#[derive(Debug)]
pub enum RegisterOutcome {
    /// New worker got a shard. `first` = this is the first registrant (set Running).
    Assigned { shard_index: u32, shard_count: u32, vu_offset: u32, vu_count: u32, first: bool },
    /// Same worker re-registered: resend its existing shard (idempotent).
    Resend { shard_index: u32, shard_count: u32, vu_offset: u32, vu_count: u32 },
    /// Over-registration or already-terminal run: reply AbortRun, give no shard.
    Reject,
    /// No such run (never enqueued / already removed): break the stream.
    NoRun,
}

#[derive(Clone)]
pub struct CoordinatorState {
    pub db: Db,
    runs: Arc<Mutex<HashMap<String, RunWorkers>>>,
    /// Per-worker VU capacity used to compute N = ceil(total_vus / capacity).
    pub worker_capacity_vus: u32,
}

impl CoordinatorState {
    pub fn new(db: Db) -> Self {
        Self::with_capacity(db, DEFAULT_WORKER_CAPACITY_VUS)
    }

    pub fn with_capacity(db: Db, worker_capacity_vus: u32) -> Self {
        Self {
            db,
            runs: Arc::new(Mutex::new(HashMap::new())),
            worker_capacity_vus,
        }
    }

    /// Number of workers for `total_vus` given this controller's capacity.
    pub fn worker_count_for(&self, total_vus: u32) -> u32 {
        worker_count(total_vus, self.worker_capacity_vus)
    }

    /// Register a run for `expected` workers and spawn the registration
    /// watchdog. Returns the watchdog's cancellation token (cancelled when all
    /// workers register). (Spec §2.3 enqueue, §8.3.)
    pub async fn enqueue(
        &self,
        run_id: String,
        base: PendingAssignment,
        expected: u32,
        total_vus: u32,
    ) -> CancellationToken {
        let token = CancellationToken::new();
        {
            let mut g = self.runs.lock().await;
            g.insert(
                run_id.clone(),
                RunWorkers {
                    base,
                    expected,
                    total_vus,
                    next_shard: 0,
                    workers: HashMap::new(),
                    reg_deadline: token.clone(),
                    terminal: false,
                },
            );
        }
        let coord = self.clone();
        let token_for_wd = token.clone();
        tokio::spawn(async move {
            registration_watchdog(coord, run_id, REGISTRATION_DEADLINE, token_for_wd).await;
        });
        token
    }

    /// Assign a shard to a registering worker. Pure state mutation; the caller
    /// performs the actual send/stream/DB-Running based on the outcome.
    pub async fn register(&self, run_id: &str, worker_id: &str, tx: WorkerTx) -> RegisterOutcome {
        let mut g = self.runs.lock().await;
        let Some(rw) = g.get_mut(run_id) else {
            return RegisterOutcome::NoRun;
        };
        if rw.terminal {
            return RegisterOutcome::Reject;
        }
        if let Some(e) = rw.workers.get(worker_id) {
            return RegisterOutcome::Resend {
                shard_index: e.shard_index,
                shard_count: rw.expected,
                vu_offset: e.vu_offset,
                vu_count: e.vu_count,
            };
        }
        if rw.next_shard >= rw.expected {
            return RegisterOutcome::Reject;
        }
        let shard_index = rw.next_shard;
        let (vu_offset, vu_count) = shard_split(rw.total_vus, rw.expected, shard_index);
        rw.next_shard += 1;
        let first = rw.workers.is_empty();
        rw.workers.insert(
            worker_id.to_string(),
            WorkerEntry {
                shard_index,
                vu_offset,
                vu_count,
                tx,
                phase: pb::run_status::Phase::Started,
            },
        );
        if rw.workers.len() as u32 == rw.expected {
            rw.reg_deadline.cancel();
        }
        RegisterOutcome::Assigned {
            shard_index,
            shard_count: rw.expected,
            vu_offset,
            vu_count,
            first,
        }
    }

    /// Read the run's base + a worker's shard so the handler can build the
    /// RunAssignment + stream the dataset after `register`. Returns None if the
    /// run/worker vanished.
    async fn assignment_for(
        &self,
        run_id: &str,
        worker_id: &str,
        shard_index: u32,
        shard_count: u32,
        vu_offset: u32,
        vu_count: u32,
    ) -> Option<(RunAssignment, Option<PendingDataBinding>)> {
        let g = self.runs.lock().await;
        let rw = g.get(run_id)?;
        let _ = worker_id;
        let a = &rw.base;
        let assignment = RunAssignment {
            run_id: run_id.to_string(),
            scenario_yaml: a.scenario_yaml.clone(),
            profile: Some(a.profile.clone()),
            env: a.env.clone(),
            data_binding: a.data_binding.as_ref().map(|b| pb::DataBinding {
                policy: b.policy as i32,
                seed: b.seed,
                row_count: b.row_count,
            }),
            shard_index,
            shard_count,
            vu_offset,
            vu_count,
        };
        Some((assignment, a.data_binding.clone()))
    }

    /// Record a worker's terminal phase and finalize the run when all workers
    /// agree / any fails. Performs DB writes + sibling AbortRun fan-out
    /// internally. (Spec §8.1, §8.2, §8.5 partial.)
    pub async fn record_phase(&self, run_id: &str, worker_id: &str, phase: i32) {
        use pb::run_status::Phase;
        let completed = Phase::Completed as i32;
        let failed = Phase::Failed as i32;
        let aborted = Phase::Aborted as i32;

        enum Finalize {
            None,
            Completed,
            Failed(Vec<WorkerTx>),
            Aborted,
        }

        let decision = {
            let mut g = self.runs.lock().await;
            let Some(rw) = g.get_mut(run_id) else { return };
            if let Some(e) = rw.workers.get_mut(worker_id) {
                e.phase = if phase == completed {
                    Phase::Completed
                } else if phase == failed {
                    Phase::Failed
                } else if phase == aborted {
                    Phase::Aborted
                } else {
                    Phase::Started
                };
            }
            if rw.terminal {
                Finalize::None
            } else if phase == failed {
                rw.terminal = true;
                let siblings: Vec<WorkerTx> = rw
                    .workers
                    .iter()
                    .filter(|(wid, _)| wid.as_str() != worker_id)
                    .map(|(_, e)| e.tx.clone())
                    .collect();
                Finalize::Failed(siblings)
            } else if phase == aborted {
                rw.terminal = true;
                Finalize::Aborted
            } else if phase == completed
                && rw.workers.values().all(|e| e.phase == Phase::Completed)
                && rw.workers.len() as u32 == rw.expected
            {
                rw.terminal = true;
                Finalize::Completed
            } else {
                Finalize::None
            }
        };

        match decision {
            Finalize::None => {}
            Finalize::Completed => {
                let _ = runs::set_status(&self.db, run_id, RunStatus::Completed, None, Some(crate::store::now_ms())).await;
            }
            Finalize::Aborted => {
                let _ = runs::set_status(&self.db, run_id, RunStatus::Aborted, None, Some(crate::store::now_ms())).await;
            }
            Finalize::Failed(siblings) => {
                let _ = runs::set_status(&self.db, run_id, RunStatus::Failed, None, Some(crate::store::now_ms())).await;
                fan_out_abort(run_id, &siblings, "sibling worker failed — fail-fast").await;
            }
        }
    }

    /// A worker's stream closed. If it never reported a terminal phase and the
    /// run isn't already terminal, fail the run fast + abort siblings. Also
    /// removes the worker from the run map. (Spec §8.2, §2.3 stream close.)
    pub async fn worker_disconnected(&self, run_id: &str, worker_id: &str) {
        use pb::run_status::Phase;
        let siblings = {
            let mut g = self.runs.lock().await;
            let Some(rw) = g.get_mut(run_id) else { return };
            let was_terminal_phase = rw
                .workers
                .get(worker_id)
                .map(|e| matches!(e.phase, Phase::Completed | Phase::Failed | Phase::Aborted))
                .unwrap_or(true); // unknown worker → treat as harmless
            rw.workers.remove(worker_id);
            if rw.terminal || was_terminal_phase {
                None
            } else {
                rw.terminal = true;
                Some(
                    rw.workers
                        .values()
                        .map(|e| e.tx.clone())
                        .collect::<Vec<_>>(),
                )
            }
        };
        if let Some(siblings) = siblings {
            let _ = runs::set_status(&self.db, run_id, RunStatus::Failed, None, Some(crate::store::now_ms())).await;
            fan_out_abort(run_id, &siblings, "worker disconnected before completing — fail-fast").await;
        }
    }

    /// Registration deadline expired: if the run isn't terminal and fewer than
    /// `expected` workers registered, fail it fast + abort whoever did register.
    /// (Spec §8.2 third bullet, §8.3.)
    pub async fn fail_incomplete_registration(&self, run_id: &str) {
        let siblings = {
            let mut g = self.runs.lock().await;
            let Some(rw) = g.get_mut(run_id) else { return };
            if rw.terminal || rw.workers.len() as u32 >= rw.expected {
                None
            } else {
                rw.terminal = true;
                Some(rw.workers.values().map(|e| e.tx.clone()).collect::<Vec<_>>())
            }
        };
        if let Some(siblings) = siblings {
            let _ = runs::set_status(&self.db, run_id, RunStatus::Failed, None, Some(crate::store::now_ms())).await;
            fan_out_abort(run_id, &siblings, "not all workers registered before deadline").await;
        }
    }

    /// Send AbortRun to every connected worker of `run_id` (user-initiated
    /// abort). Returns true if at least one worker was reached. (Spec §8.5.)
    pub async fn abort(&self, run_id: &str) -> bool {
        let txs = {
            let g = self.runs.lock().await;
            match g.get(run_id) {
                Some(rw) => rw.workers.values().map(|e| e.tx.clone()).collect::<Vec<_>>(),
                None => return false,
            }
        };
        let any = !txs.is_empty();
        fan_out_abort(run_id, &txs, "user requested abort").await;
        any
    }
}

/// Send AbortRun to each tx (best-effort; closed channels ignored).
async fn fan_out_abort(run_id: &str, txs: &[WorkerTx], reason: &str) {
    for tx in txs {
        let msg = ServerMessage {
            payload: Some(ServerPayload::Abort(AbortRun {
                run_id: run_id.to_string(),
                reason: reason.to_string(),
            })),
        };
        let _ = tx.send(Ok(msg)).await;
    }
}

/// Per-run watchdog: wait `deadline`, then fail the run if not everyone
/// registered. Cancelled early (via `token`) once all workers register.
async fn registration_watchdog(
    coord: CoordinatorState,
    run_id: String,
    deadline: Duration,
    token: CancellationToken,
) {
    tokio::select! {
        _ = token.cancelled() => {}
        _ = tokio::time::sleep(deadline) => {
            coord.fail_incomplete_registration(&run_id).await;
        }
    }
}

pub struct CoordinatorService {
    pub state: CoordinatorState,
}

type ChannelStream = Pin<Box<dyn Stream<Item = Result<ServerMessage, Status>> + Send>>;

#[tonic::async_trait]
impl Coordinator for CoordinatorService {
    type ChannelStream = ChannelStream;

    async fn channel(
        &self,
        req: Request<Streaming<WorkerMessage>>,
    ) -> Result<Response<Self::ChannelStream>, Status> {
        let mut inbound = req.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<ServerMessage, Status>>(32);
        let state = self.state.clone();

        tokio::spawn(async move {
            let mut run_id: Option<String> = None;
            let mut worker_id: Option<String> = None;
            while let Some(msg) = inbound.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        warn!(error = %e, "worker stream error");
                        break;
                    }
                };
                match msg.payload {
                    Some(WorkerPayload::Register(reg)) => {
                        run_id = Some(reg.run_id.clone());
                        worker_id = Some(reg.worker_id.clone());
                        info!(worker_id = %reg.worker_id, run_id = %reg.run_id, "worker registered");

                        let outcome = state.register(&reg.run_id, &reg.worker_id, tx.clone()).await;
                        let (shard_index, shard_count, vu_offset, vu_count, set_running) = match outcome {
                            RegisterOutcome::Assigned { shard_index, shard_count, vu_offset, vu_count, first } => {
                                (shard_index, shard_count, vu_offset, vu_count, first)
                            }
                            RegisterOutcome::Resend { shard_index, shard_count, vu_offset, vu_count } => {
                                (shard_index, shard_count, vu_offset, vu_count, false)
                            }
                            RegisterOutcome::Reject => {
                                warn!(run_id = %reg.run_id, worker_id = %reg.worker_id, "rejecting late/over registration");
                                let _ = tx.send(Ok(ServerMessage {
                                    payload: Some(ServerPayload::Abort(AbortRun {
                                        run_id: reg.run_id.clone(),
                                        reason: "run already started or fully sharded".to_string(),
                                    })),
                                })).await;
                                break;
                            }
                            RegisterOutcome::NoRun => {
                                error!(run_id = %reg.run_id, "no pending run for worker");
                                break;
                            }
                        };

                        let Some((assignment, binding)) = state
                            .assignment_for(&reg.run_id, &reg.worker_id, shard_index, shard_count, vu_offset, vu_count)
                            .await
                        else {
                            error!(run_id = %reg.run_id, "run vanished between register and assignment");
                            break;
                        };

                        let _ = tx.send(Ok(ServerMessage {
                            payload: Some(ServerPayload::Assignment(assignment)),
                        })).await;

                        if set_running {
                            let _ = runs::set_status(
                                &state.db,
                                &reg.run_id,
                                RunStatus::Running,
                                Some(crate::store::now_ms()),
                                None,
                            ).await;
                        }

                        // Stream mapping-applied dataset rows (replicated per worker, spec §6.2).
                        // Row values are NEVER logged (spec §11).
                        if let Some(binding) = &binding {
                            if binding.row_count > 0 {
                                stream_dataset(&state, &tx, &reg.run_id, binding).await;
                            }
                        }
                    }
                    Some(WorkerPayload::MetricBatch(batch)) => {
                        // A3a: worker_id ignored for run_metrics (A3b adds per-worker merge).
                        // loop/if metrics already accumulate (count + excluded), so N-worker
                        // sums are correct today.
                        ingest_metrics(&state, &batch).await;
                    }
                    Some(WorkerPayload::RunStatus(s)) => {
                        info!(run_id = %s.run_id, phase = ?s.phase, "worker run status");
                        if let Some(wid) = &worker_id {
                            state.record_phase(&s.run_id, wid, s.phase).await;
                        }
                    }
                    Some(WorkerPayload::Pong(_)) => {}
                    None => {}
                }
            }
            // Stream closed: fail-fast if this worker dropped before a terminal phase.
            if let (Some(rid), Some(wid)) = (run_id.as_ref(), worker_id.as_ref()) {
                state.worker_disconnected(rid, wid).await;
            }
            info!(?run_id, ?worker_id, "worker stream closed");
        });

        let out: ChannelStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out))
    }
}

/// Stream a binding's rows to one worker. Extracted verbatim from the previous
/// single-worker register handler (now runs per worker). On any incompleteness
/// it sends AbortRun so the worker's loading stage doesn't hang (spec §6.2,
/// controller CLAUDE.md "drop(tx) can't close a blocked stream").
async fn stream_dataset(
    state: &CoordinatorState,
    tx: &WorkerTx,
    run_id: &str,
    binding: &PendingDataBinding,
) {
    let total = binding.row_count as i64;
    let mut sent: i64 = 0;
    let mut incomplete = false;
    while sent < total {
        let limit = DATASET_BATCH_ROWS.min(total - sent);
        let src = match crate::store::datasets::get_rows_range(&state.db, &binding.dataset_id, sent, limit).await {
            Ok(r) => r,
            Err(e) => {
                error!(run_id = %run_id, error = %e, "dataset row fetch failed");
                incomplete = true;
                break;
            }
        };
        if src.is_empty() {
            error!(run_id = %run_id, sent, total, "dataset shrank mid-stream; fewer rows than promised");
            incomplete = true;
            break;
        }
        let proto_rows: Vec<pb::DatasetRow> = src
            .iter()
            .map(|row| pb::DatasetRow {
                values: binding.mappings_apply(row).into_iter().collect(),
            })
            .collect();
        let n = proto_rows.len() as i64;
        if tx.send(Ok(ServerMessage {
            payload: Some(ServerPayload::DatasetBatch(pb::DatasetBatch {
                run_id: run_id.to_string(),
                rows: proto_rows,
            })),
        })).await.is_err() {
            warn!(run_id = %run_id, "worker disconnected during dataset stream");
            incomplete = true;
            break;
        }
        sent += n;
    }
    if incomplete {
        let _ = tx.send(Ok(ServerMessage {
            payload: Some(ServerPayload::Abort(AbortRun {
                run_id: run_id.to_string(),
                reason: "dataset streaming incomplete".to_string(),
            })),
        })).await;
    } else {
        info!(run_id = %run_id, rows_sent = sent, "dataset rows streamed to worker");
    }
}

/// Insert one worker's metric batch (windows + loop + if). Unchanged from the
/// previous inline arm; A3b adds run_metrics per-worker keying.
async fn ingest_metrics(state: &CoordinatorState, batch: &pb::MetricBatch) {
    let rows: Vec<crate::store::metrics::MetricRow> = batch
        .windows
        .iter()
        .map(|w| {
            let status_json = serde_json::to_string(&w.status_counts).unwrap_or_else(|_| "{}".to_string());
            crate::store::metrics::MetricRow {
                run_id: batch.run_id.clone(),
                ts_second: w.ts_second,
                step_id: w.step_id.clone(),
                count: w.count as i64,
                error_count: w.error_count as i64,
                hdr_histogram: w.hdr_histogram.clone(),
                status_counts: status_json,
            }
        })
        .collect();
    if let Err(e) = crate::store::metrics::insert_batch(&state.db, &rows).await {
        warn!(run_id = %batch.run_id, error = %e, "failed to insert metric batch");
    }
    let loop_rows: Vec<crate::store::metrics::LoopMetricRow> = batch
        .loop_stats
        .iter()
        .map(|ls| crate::store::metrics::LoopMetricRow {
            run_id: batch.run_id.clone(),
            step_id: ls.step_id.clone(),
            loop_index: ls.loop_index as i64,
            count: ls.count as i64,
            error_count: ls.error_count as i64,
        })
        .collect();
    if !loop_rows.is_empty() {
        if let Err(e) = crate::store::metrics::insert_loop_batch(&state.db, &loop_rows).await {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert loop metrics");
        }
    }
    let branch_rows: Vec<crate::store::metrics::IfBranchRow> = batch
        .branch_stats
        .iter()
        .map(|bs| crate::store::metrics::IfBranchRow {
            run_id: batch.run_id.clone(),
            step_id: bs.step_id.clone(),
            branch: bs.branch.clone(),
            count: bs.count as i64,
        })
        .collect();
    if !branch_rows.is_empty() {
        if let Err(e) = crate::store::metrics::insert_if_branch_batch(&state.db, &branch_rows).await {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert if-branch metrics");
        }
    }
}
```

> 위 `mod tests` 의 `base_assignment()` 에서 `profile:` 은 `pb::Profile { vus: 4, ramp_up_seconds: 0, duration_seconds: 1, loop_breakdown_cap: 0 }` 로(의사코드 `Profile2` 교체). `Profile` 은 파일 상단에서 import 됨.

- [ ] **Step 5: `runs.rs::create` 의 enqueue 호출 갱신** (dispatch 는 Task 6)

`crates/controller/src/api/runs.rs` 의 `create`(현 158-178행 부근). enqueue 시그니처가 바뀌었으므로 N 산정 + base/expected/total_vus 전달. **dispatch 는 이 Task 에선 그대로**(단일 worker_id) — N=1 인 모든 기존 테스트는 green, N>1 spawn 은 Task 6:

```rust
    // Enqueue the assignment so the coordinator can hand shards to N workers.
    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: scenario.yaml.clone(),
        profile: handicap_proto::v1::Profile {
            vus: body.profile.vus,
            ramp_up_seconds: body.profile.ramp_up_seconds,
            duration_seconds: body.profile.duration_seconds,
            loop_breakdown_cap: body.profile.loop_breakdown_cap,
        },
        env: body.env.clone(),
        data_binding,
    };
    let n = state.coord.worker_count_for(body.profile.vus);
    state
        .coord
        .enqueue(row.id.clone(), assignment, n, body.profile.vus)
        .await;

    // Dispatch the worker(s). Task 6 makes this N-spawn; for now single worker
    // (n == 1 for all current callers since capacity defaults to 2000).
    let worker_id = ulid::Ulid::new().to_string();
    if let Err(e) = state.dispatcher.dispatch(&row.id, &worker_id).await {
        tracing::warn!(run_id = %row.id, error = %e, "failed to dispatch worker");
    }
```

- [ ] **Step 6: main.rs 에 `--worker-capacity-vus` 플래그 + `with_capacity`**

`crates/controller/src/main.rs` Args 에 필드 추가(현 56행 부근, `dataset_max_rows` 옆):

```rust
    /// Per-worker VU capacity. The controller fans a run out to
    /// N = ceil(total_vus / this). (A3a spec §2.1.)
    #[arg(long, default_value_t = handicap_controller::grpc::coordinator::DEFAULT_WORKER_CAPACITY_VUS)]
    worker_capacity_vus: u32,
```

coord 생성(현 88행):

```rust
    let coord_state =
        CoordinatorState::with_capacity(db.clone(), args.worker_capacity_vus);
```

- [ ] **Step 7: 단위테스트 + 전체 워크스페이스 통과**

Run: `cargo test -p handicap-controller --lib coordinator`
Expected: Step 2 의 8 테스트 PASS.

Run: `cargo build --workspace && cargo test --workspace`
Expected: 전부 PASS. (모든 기존 e2e/통합은 capacity=2000 → N=1 → 단일워커 byte-identical. 특히 `e2e_test.rs` 5개 e2e, `data_binding_*`, `api_test`, `crash_recovery` green.)

- [ ] **Step 8: clippy + fmt**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`
Expected: 0 warnings. (특히 `too_many_arguments`/`assign_op_pattern`/`expect_fun_call` 주의 — `n += 1` 은 `next_shard += 1` 형태로 OK.)

- [ ] **Step 9: 커밋**

```bash
git add crates/controller/Cargo.toml crates/controller/src/grpc/coordinator.rs \
        crates/controller/src/api/runs.rs crates/controller/src/main.rs
git commit -m "feat(controller): per-run multi-worker state machine + capacity + watchdog (A3a)"
```

---

## Task 6: 컨트롤러 — 디스패처 fan-out 시그니처 (`dispatch(run_id, worker_count)`)

**Files:**
- Modify: `crates/controller/src/dispatcher/mod.rs` (trait)
- Modify: `crates/controller/src/dispatcher/subprocess.rs` (N-spawn)
- Modify: `crates/controller/src/dispatcher/kubernetes.rs` (단일 Job 유지, 내부 worker_id 생성)
- Modify: `crates/controller/src/api/runs.rs` (`dispatch(&row.id, n)`)
- Modify: `crates/controller/tests/dispatcher_subprocess_test.rs`, `crates/controller/tests/dispatcher_kubernetes_test.rs`

- [ ] **Step 1: subprocess 디스패처 테스트를 새 시그니처로 (failing)**

`crates/controller/tests/dispatcher_subprocess_test.rs` 의 호출(현 19행)을 worker_count 로, 그리고 N-spawn 회귀를 추가:

```rust
    dispatcher
        .dispatch("run-1", 2)
        .await
        .expect("dispatch");
```

(주석의 `--worker-id` 언급은 "각 자식에 distinct --worker-id" 로 갱신. `/bin/sh` 는 인자 무시하고 exit 0 이므로 N=2 여도 그냥 통과 — 이 테스트는 "패닉 없이 Ok" 만 검증.)

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller --test dispatcher_subprocess_test`
Expected: 컴파일 에러(`dispatch` 가 `&str` 둘째 인자 기대).

- [ ] **Step 3: trait 시그니처 변경**

`crates/controller/src/dispatcher/mod.rs`:

```rust
    /// Start `worker_count` workers for the given run. Each implementation owns
    /// worker-id generation (subprocess: N distinct ULIDs; K8s: Indexed Job).
    /// Returns `Ok(())` once the workers were asked to start. (A3a spec §7.1.)
    async fn dispatch(&self, run_id: &str, worker_count: u32) -> anyhow::Result<()>;
```

- [ ] **Step 4: subprocess N-spawn**

`crates/controller/src/dispatcher/subprocess.rs` 의 `dispatch`:

```rust
    async fn dispatch(&self, run_id: &str, worker_count: u32) -> anyhow::Result<()> {
        let controller_url = format!("http://{}", self.grpc_addr);
        for _ in 0..worker_count.max(1) {
            let worker_id = ulid::Ulid::new().to_string();
            info!(
                %worker_id,
                %run_id,
                %controller_url,
                worker_bin = %self.worker_bin,
                "spawning worker subprocess"
            );
            let mut cmd = Command::new(&self.worker_bin);
            cmd.arg("--controller")
                .arg(&controller_url)
                .arg("--run-id")
                .arg(run_id)
                .arg("--worker-id")
                .arg(&worker_id)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .kill_on_drop(false);
            let mut child = cmd.spawn()?;

            // Reap in background so the OS doesn't leave zombies.
            let run_id_owned = run_id.to_string();
            let pid = child.id();
            tokio::spawn(async move {
                match child.wait().await {
                    Ok(status) => info!(run_id = %run_id_owned, ?status, ?pid, "worker exited"),
                    Err(e) => warn!(run_id = %run_id_owned, error = %e, "wait on worker failed"),
                }
            });
        }
        Ok(())
    }
```

(`ulid` 는 controller deps 에 이미 있음. `Command`/`Stdio`/`info`/`warn` import 유지.)

- [ ] **Step 5: K8s 디스패처 시그니처 적응 (단일 Job 유지 — Indexed Job 은 A3c)**

`crates/controller/src/dispatcher/kubernetes.rs` 의 `dispatch`:

```rust
    async fn dispatch(&self, run_id: &str, worker_count: u32) -> anyhow::Result<()> {
        if worker_count > 1 {
            warn!(
                %run_id, worker_count,
                "K8s dispatcher still creates a single Job; multi-Pod Indexed Job lands in A3c"
            );
        }
        let worker_id = ulid::Ulid::new().to_string();
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
```

(`ulid` import 추가 필요 시 `use` 없이 `ulid::Ulid::new()` 경로로. `build_job_spec` 는 **무변경** → `dispatcher_spec_test.rs` 통과 유지.)

- [ ] **Step 6: K8s 디스패처 테스트 시그니처 갱신**

`crates/controller/tests/dispatcher_kubernetes_test.rs`(feature `slice6-k8s` gated, 현 25행). worker_id 변수를 더 이상 안 넘기므로:

```rust
    let run_id = format!("test-run-{}", ulid::Ulid::new());

    dispatcher
        .dispatch(&run_id, 1)
        .await
        .expect("dispatch");
```

(`let worker_id = …;` 줄 제거. 라벨 셀렉터 검증은 run_id 기준이라 무영향.)

- [ ] **Step 7: `runs.rs::create` 의 dispatch 를 N 으로**

`crates/controller/src/api/runs.rs` 의 dispatch 호출(Task 5 Step 5 에서 남긴 단일 worker_id 블록)을:

```rust
    // Dispatch N workers (subprocess: N children; K8s: 1 Job, Indexed in A3c).
    if let Err(e) = state.dispatcher.dispatch(&row.id, n).await {
        tracing::warn!(run_id = %row.id, error = %e, "failed to dispatch worker(s)");
    }
```

(`let worker_id = ulid::Ulid::new()...;` 줄 제거 — worker_id 생성 책임이 디스패처로 이동. `ulid` 가 runs.rs 의 다른 곳(`fold_seed` 는 안 씀)에서 더 안 쓰이면 import 정리는 clippy 가 안내.)

- [ ] **Step 8: 전체 통과**

Run: `cargo test -p handicap-controller --test dispatcher_subprocess_test`
Expected: PASS.

Run: `cargo build --workspace && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`
Expected: 전부 green. (기존 e2e 는 N=1 → subprocess 가 자식 1 개 spawn — 현행과 동일.)

- [ ] **Step 9: 커밋**

```bash
git add crates/controller/src/dispatcher/ crates/controller/src/api/runs.rs \
        crates/controller/tests/dispatcher_subprocess_test.rs \
        crates/controller/tests/dispatcher_kubernetes_test.rs
git commit -m "feat(controller): dispatcher dispatch(run_id, worker_count) + subprocess N-spawn (A3a)"
```

---

## Task 7: e2e — N=2 subprocess fan-out + abort fan-out

**Files:**
- Create: `crates/controller/tests/multi_worker_fanout_e2e.rs`

`e2e_test.rs` 의 헬퍼(`worker_bin_path`, `bind_local`)를 이 파일에 복제(테스트 파일 간 공유 모듈이 없으므로 기존 패턴대로 복제). `CoordinatorState::with_capacity(db, 1)` 로 N=ceil(vus/1)=vus 강제.

- [ ] **Step 1: N=2 완료 e2e 작성 (failing → green)**

`crates/controller/tests/multi_worker_fanout_e2e.rs`:

```rust
//! A3a end-to-end: a run with 2 VUs and worker capacity 1 fans out to N=2
//! subprocess workers. We assert (a) the run completes (all shards reported
//! Completed → coordinator aggregated), and (b) wiremock saw load from the
//! run. Exact per-worker metric merge is A3b; here we use wiremock's request
//! log (ground truth) instead of run_metrics (keep-first in A3a).
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
use handicap_controller::{app, store};
use handicap_proto::v1::coordinator_server::CoordinatorServer;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn worker_bin_path() -> PathBuf {
    let cargo = env!("CARGO");
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    tokio::task::spawn_blocking(move || {
        let status = std::process::Command::new(cargo)
            .args(["build", "-p", "handicap-worker"])
            .status()
            .expect("cargo build -p handicap-worker");
        assert!(status.success(), "worker build failed");
    })
    .await
    .expect("spawn_blocking for worker build panicked");
    if let Ok(p) = std::env::var("CARGO_BIN_EXE_worker") {
        return PathBuf::from(p);
    }
    PathBuf::from(manifest_dir)
        .parent().unwrap().parent().unwrap()
        .join("target/debug/worker")
}

async fn bind_local() -> (TcpListener, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, addr)
}

/// Boot an in-process controller with the given coordinator (capacity baked in).
async fn boot(
    coord: CoordinatorState,
    db: store::Db,
    grpc_listener: TcpListener,
    rest_listener: TcpListener,
    grpc_addr: SocketAddr,
    worker_bin: &PathBuf,
) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
    let app = app::router(app::AppState {
        db,
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            worker_bin.to_string_lossy().to_string(),
            grpc_addr,
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
    });
    let rest_handle = tokio::spawn(async move {
        axum::serve(rest_listener, app).await.unwrap();
    });
    let grpc_handle = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(CoordinatorServer::new(CoordinatorService { state: coord }))
            .serve_with_incoming(TcpListenerStream::new(grpc_listener))
            .await
            .unwrap();
    });
    (rest_handle, grpc_handle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_fanout_completes() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok").set_delay(Duration::from_millis(5)))
        .mount(&target)
        .await;

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;
    let db = store::connect("sqlite::memory:").await.unwrap();
    // capacity 1 → N = total_vus.
    let coord = CoordinatorState::with_capacity(db.clone(), 1);
    let (rest_handle, grpc_handle) =
        boot(coord, db.clone(), grpc_listener, rest_listener, grpc_addr, &worker_bin).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);
    let scenario_yaml = format!(
        "version: 1\nname: fanout\nvariables:\n  base: \"{}\"\nsteps:\n  - id: \"01HX0000000000000000000020\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/hit?vu=${{vu_id}}\"\n    assert:\n      - status: 200\n",
        target.uri()
    );
    let v: Value = http.post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml })).send().await.unwrap().json().await.unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 2 VUs, capacity 1 → 2 workers, shards (vu_offset 0,1).
    let v: Value = http.post(format!("{}/api/runs", rest_base))
        .json(&json!({ "scenario_id": scenario_id, "profile": { "vus": 2, "duration_seconds": 2 }, "env": {} }))
        .send().await.unwrap().json().await.unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http.get(format!("{}/api/runs/{}", rest_base, run_id))
            .send().await.unwrap().json().await.unwrap();
        last = v["status"].as_str().unwrap().to_string();
        if last == "completed" || last == "failed" || last == "aborted" { break; }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(last, "completed", "N=2 fan-out should complete; got {last}");

    // Both shards generated load: wiremock saw global vu ids 0 AND 1.
    let reqs = target.received_requests().await.unwrap();
    let qs: Vec<String> = reqs.iter().map(|r| r.url.query().unwrap_or("").to_string()).collect();
    assert!(qs.iter().any(|q| q.contains("vu=0")), "shard 0 (vu=0) missing: {qs:?}");
    assert!(qs.iter().any(|q| q.contains("vu=1")), "shard 1 (vu=1) missing: {qs:?}");

    rest_handle.abort();
    grpc_handle.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_fanout_abort_marks_aborted() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok").set_delay(Duration::from_millis(50)))
        .mount(&target)
        .await;

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::with_capacity(db.clone(), 1);
    let (rest_handle, grpc_handle) =
        boot(coord, db.clone(), grpc_listener, rest_listener, grpc_addr, &worker_bin).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);
    let scenario_yaml = format!(
        "version: 1\nname: fanout-abort\nvariables:\n  base: \"{}\"\nsteps:\n  - id: \"01HX0000000000000000000021\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{{{{base}}}}/hit\"\n    assert:\n      - status: 200\n",
        target.uri()
    );
    let v: Value = http.post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml })).send().await.unwrap().json().await.unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 2 VUs over 30s so there's time to abort both shards.
    let v: Value = http.post(format!("{}/api/runs", rest_base))
        .json(&json!({ "scenario_id": scenario_id, "profile": { "vus": 2, "duration_seconds": 30 }, "env": {} }))
        .send().await.unwrap().json().await.unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    // Wait until running.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut saw_running = false;
    while std::time::Instant::now() < deadline {
        let v: Value = http.get(format!("{}/api/runs/{}", rest_base, run_id))
            .send().await.unwrap().json().await.unwrap();
        if v["status"].as_str() == Some("running") { saw_running = true; break; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(saw_running, "run should reach running");

    let r = http.post(format!("{}/api/runs/{}/abort", rest_base, run_id)).send().await.unwrap();
    assert_eq!(r.status(), 200);

    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut final_status = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http.get(format!("{}/api/runs/{}", rest_base, run_id))
            .send().await.unwrap().json().await.unwrap();
        final_status = v["status"].as_str().unwrap().to_string();
        if final_status == "aborted" { break; }
        if final_status == "completed" || final_status == "failed" {
            panic!("expected aborted, got {final_status}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(final_status, "aborted", "both shards should abort → run aborted");

    rest_handle.abort();
    grpc_handle.abort();
}
```

- [ ] **Step 2: 실행 (cold build 1 회 → warm 재시도 가능)**

Run: `cargo test -p handicap-controller --test multi_worker_fanout_e2e`
Expected: 두 테스트 PASS. (메모리: cold pre-commit 빌드 중 SIGKILL flake 가능 — 실패 시 warm 재시도. `flaky-e2e-cold-build`.)

- [ ] **Step 3: 워크스페이스 전체 + 게이트**

Run: `cargo build --workspace && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check`
Expected: green.

- [ ] **Step 4: 커밋**

```bash
git add crates/controller/tests/multi_worker_fanout_e2e.rs
git commit -m "test(controller): N=2 subprocess fan-out e2e (complete + abort) (A3a)"
```

---

## Task 8: 문서 — ADR-0027 + CLAUDE.md 함정 + 로드맵/메모리

**Files:**
- Create: `docs/adr/0027-multi-worker-fanout.md`
- Modify: 루트 `CLAUDE.md`("알아둘 결정들" + 상태 한 줄), `crates/controller/CLAUDE.md`, `crates/engine/CLAUDE.md`, `crates/worker-core/CLAUDE.md`, `docs/roadmap.md`

- [ ] **Step 1: ADR-0027 작성**

`docs/adr/0027-multi-worker-fanout.md`(MADR 포맷). 핵심 결정(spec §13):
- 반응형 HPA 거절 · **계획된 fan-out** 채택(run 시작 시 `N=ceil(총VU/capacity)` 고정).
- 컨트롤러 권위: capacity 유도 N(워커 register `capacity_vus` 아님), Register 시 shard 배정.
- per-run 상태머신(`RunWorkers`) — `pending`+`active` 단일 tx 재작성.
- 엔진 글로벌 vu_id(`vu_offset + local`).
- fail-fast(워커 단절/실패 → run Failed + 형제 AbortRun); best-effort·`unique`·HPA 연기.
- **A3a 한정 결정 기록**: cleanup 호출은 A3c 로 연기(현재도 미호출), K8s 단일 Job 유지(Indexed Job=A3c), 메트릭 머지=A3b.

- [ ] **Step 2: 함정 노트 추가**

- 루트 `CLAUDE.md` "알아둘 결정들" 에 `- **0027** 멀티 워커 fan-out (계획된 분산 실행): 컨트롤러 권위 N·shard 배정, per-run 상태머신, 글로벌 vu_id, fail-fast — A3a(조정+proto+엔진) 완료; A3b(메트릭 머지)·A3c(K8s Indexed Job) 후속` 한 줄. 상단 상태 단락은 건드리지 않음(슬라이스 진행 표기는 roadmap 담당).
- `crates/controller/CLAUDE.md` 에: ① `RunAssignment` 4 필드 = prost exhaustive(grep `RunAssignment {`); ② `CoordinatorState` 가 `pending`+`active` → per-run `RunWorkers` 맵(단일 tx 가정 코드 금지); ③ capacity 는 컨트롤러 `--worker-capacity-vus`(워커 register `capacity_vus` 아님); ④ **cleanup 미배선** — 완료/abort 시 dispatcher.cleanup 안 부름(A3c 에서 K8s 와 함께); ⑤ 등록 watchdog 60s = worker `TOTAL_CAP` 정렬.
- `crates/engine/CLAUDE.md` 에: 글로벌 vu_id(`vu_offset + local`) identity-only(메트릭 키는 step_id) — vus-크기 인덱싱 금지.
- `crates/worker-core/CLAUDE.md`(또는 worker 절) 에: `--worker-id` optional + `JOB_COMPLETION_INDEX` fallback(`resolve_worker_id`); subprocess 는 명시 전달, K8s(A3c)는 env 파생.
- `docs/roadmap.md` §A3 를 "A3a 완료, A3b 진행 대기" 로 갱신.

- [ ] **Step 3: docs-only 커밋**

```bash
git add docs/adr/0027-multi-worker-fanout.md CLAUDE.md crates/controller/CLAUDE.md \
        crates/engine/CLAUDE.md crates/worker-core/CLAUDE.md docs/roadmap.md
git commit -m "docs: ADR-0027 + multi-worker fan-out gotchas (A3a)"
```

> 함정(루트 CLAUDE.md): docs-only 커밋은 pre-commit cargo 게이트를 skip하고 merge-conflict marker도 안 잡는다. 여러 md 커밋 끝에 `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md` 한 번.

---

## Self-Review (spec 대비 점검 결과)

**1. Spec coverage (A3a 분할, spec §9):**
- 엔진 `RunPlan.vu_offset` + 글로벌 vu_id(§3) → Task 1. ✓ (identity-only 검증 = Task 1 Step 7.)
- proto `RunAssignment` shard 4 필드(§4) + prost grep → Task 2. ✓
- `CoordinatorState` per-run 상태머신(§2.3): pending+active → runs 맵, Register/RunStatus arm 재작성, shard 할당, watchdog(§8.3), 상태 집계(§8.1-8.2), abort fan-out(§8.5) → Task 5. ✓
- 워커: vu_count/vu_offset → RunPlan(§3.3), `--worker-id` optional + `JOB_COMPLETION_INDEX`(§7.2) → Task 3. ✓
- 디스패처 trait `dispatch(run_id, worker_count)` + subprocess N-spawn(§7.1) → Task 6. ✓
- run-create N 산정(§2.1) + enqueue(expected=N) → Task 5 Step 5/6. ✓
- e2e subprocess N=2(코디네이션·전원완료·abort) → Task 7. ✓ (fail-fast 워커크래시는 단위테스트 — 스코프 결정 §2.)
- 데이터 바인딩 정합(§6): per_vu row_count=min(총VU,rows) 이미 충족(runs.rs:132) → 무변경 확인. ✓ 스트리밍 per-worker(§6.2) = `stream_dataset` connection 당 호출. ✓

**의도된 미구현(스코프 결정 절에 명시):** ① dispatcher.cleanup 호출(A3c), ② fail-fast-on-crash e2e(단위테스트로 대체), ③ K8s Indexed Job(A3c). 메트릭 머지(§5)는 spec 상 A3b.

**2. Placeholder scan:** 모든 코드 스텝에 실제 코드 포함. `mod tests` 의 `Profile2` 의사명은 "→ `pb::Profile` 로 교체" 명시. TBD/TODO 없음.

**3. Type consistency:** `worker_count`/`shard_split`(shard.rs) ↔ `worker_count_for`(coordinator) ↔ Task 1 `vu_offset`/Task 3 `assignment.vu_offset`/`assignment.vu_count` ↔ proto 필드명(`shard_index/shard_count/vu_offset/vu_count`) 1:1. `RegisterOutcome` variant 필드명이 Task 5 테스트 패턴매치와 일치. `dispatch(run_id, worker_count: u32)` 시그니처가 trait/subprocess/kubernetes/runs.rs/2 테스트 전부 동일.
