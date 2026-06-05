# Parallel 노드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세 번째 control-flow 노드 `type: parallel` 을 추가한다 — 한 VU가 한 iteration 안에서 여러 분기를 동시 실행(wait-all join)하고, 분기 출력을 `{{branch.var}}` 네임스페이스로 다운스트림에 노출한다.

**Architecture:** 엔진 `execute_steps` 에 `Step::Parallel` arm을 추가(`futures::future::join_all` 협력 동시성, 공유 cookie jar/client) + trace lockstep + 컨트롤러 `insights.rs` 1 arm. UI는 Zod 4-way + 세로 레인 캔버스 + inspector 분기 CRUD + yamlDoc 양방향 sync. 부하경로(flat http) byte-identical, proto·워커·마이그레이션 무변경.

**Tech Stack:** Rust(engine/controller, serde_yaml, futures, wiremock, reqwest, hdrhistogram), TypeScript/React(Zod, @xyflow/react, yaml Document API, Zustand, vitest, fast-check).

**Spec:** `docs/superpowers/specs/2026-06-05-parallel-node-design.md`. **2 sub-slice**: **P-a** = Task 1–4 (engine + trace + controller arm). **P-b** = Task 5–9 (UI authoring).

**커밋 규율(루트 CLAUDE.md):** pre-commit이 비-`.md`마다 전체 workspace를 돌린다 — RED-only 커밋·미사용 헬퍼 단독 커밋은 게이트에 막힌다. **각 Task는 로컬에서 RED→GREEN 확인 후 단일 green 커밋**으로 fold. `git commit`은 `run_in_background:false` + 파이프 없이, 직후 `git log -1`로 확인. cold-build flake나면 `cargo build -p handicap-worker && cargo build --workspace` 후 warm 재시도.

---

## File Structure

**P-a (engine + controller):**
- `crates/engine/src/scenario.rs` — `Step::Parallel`, `ParallelStep`, `Branch`, `Extract::var()`, `Branch::output_var_names()`, `Step::id/name` arm + serde round-trip 테스트.
- `crates/engine/src/runner.rs` — `execute_steps` 의 `Step::Parallel` arm.
- `crates/engine/tests/parallel_node.rs` (Create) — wiremock 통합 테스트.
- `crates/engine/src/trace.rs` — `trace_steps` 의 `Step::Parallel` arm.
- `crates/controller/src/insights.rs` — `collect_unconditional` 의 `Parallel` arm.

**P-b (UI):**
- `ui/src/scenario/model.ts` — `BranchModel`/`ParallelStepModel`, `StepModel` 4-way + 분기명 유니크 superRefine, `flattenHttpSteps`/`findStepSiblings`/`findStepById` parallel 케이스.
- `ui/src/scenario/yamlDoc.ts` — Edit 5종 + `searchSeq` parallel 하강 + `normalizeStep` parallel.
- `ui/src/scenario/store.ts` — thin action 5종.
- `ui/src/components/scenario/ParallelStepNode.tsx` (Create) — 세로 레인 노드.
- `ui/src/components/scenario/CanvasView.tsx` — `measureStep`/`measureWidth`/`emitStep` parallel + "+ Add parallel" 툴바.
- `ui/src/components/scenario/Inspector.tsx` — 분기 CRUD 편집기.

---

# P-a — 엔진 + trace + 컨트롤러 1 arm

## Task 1: 시나리오 모델 (`ParallelStep`/`Branch`)

**Files:**
- Modify: `crates/engine/src/scenario.rs`

- [ ] **Step 1: 인라인 테스트 작성** (`scenario.rs` 의 `#[cfg(test)] mod tests` 끝에 추가)

```rust
    // ---- Parallel: serde round-trip ----

    #[test]
    fn parses_parallel_step() {
        let y = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fanout
    type: parallel
    branches:
      - name: user
        steps:
          - id: "01HX0000000000000000000011"
            name: get-user
            type: http
            request: { method: GET, url: "/api/user" }
            assert: []
      - name: feed
        steps:
          - id: "01HX0000000000000000000012"
            name: get-feed
            type: http
            request: { method: GET, url: "/api/feed" }
            assert: []
"#;
        let s = Scenario::from_yaml(y).expect("parses parallel");
        let Step::Parallel(p) = &s.steps[0] else {
            panic!("expected parallel");
        };
        assert_eq!(p.id, "01HX0000000000000000000010");
        assert_eq!(p.branches.len(), 2);
        assert_eq!(p.branches[0].name, "user");
        assert_eq!(p.branches[0].steps.len(), 1);
        assert!(matches!(p.branches[0].steps[0], Step::Http(_)));
    }

    #[test]
    fn parallel_round_trips_keeping_inner_type_tag() {
        let y = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fanout
    type: parallel
    branches:
      - name: a
        steps:
          - id: "01HX0000000000000000000011"
            name: h
            type: http
            request: { method: GET, url: "/x" }
            assert: []
"#;
        let s = Scenario::from_yaml(y).unwrap();
        let out = s.to_yaml().unwrap();
        assert!(out.contains("type: parallel"), "keeps parallel tag:\n{out}");
        assert!(out.contains("type: http"), "inner http keeps tag:\n{out}");
        assert!(out.contains("branches:"));
        let s2 = Scenario::from_yaml(&out).unwrap();
        assert_eq!(s, s2, "parallel must round-trip");
    }

    #[test]
    fn parallel_rejects_unknown_field() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000010"
    name: p
    type: parallel
    branches: []
    bogus: 1
"#;
        assert!(Scenario::from_yaml(y).is_err());
    }

    #[test]
    fn branch_output_var_names_lists_extract_vars() {
        let b = Branch {
            name: "user".into(),
            steps: vec![Step::Http(HttpStep {
                id: "01HX0000000000000000000011".into(),
                name: "h".into(),
                request: Request {
                    method: HttpMethod::Get,
                    url: "/u".into(),
                    headers: BTreeMap::new(),
                    body: None,
                    disabled: DisabledRows::default(),
                },
                assert: vec![],
                extract: vec![
                    Extract::Body { var: "id".into(), path: "$.id".into() },
                    Extract::Status { var: "code".into() },
                ],
                timeout_seconds: None,
                think_time: None,
            })],
        };
        assert_eq!(b.output_var_names(), vec!["id", "code"]);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-engine --lib scenario`
Expected: FAIL — `Step::Parallel` / `ParallelStep` / `Branch` / `Branch::output_var_names` / `Extract::var` 미정의.

- [ ] **Step 3: 모델 구현** (`scenario.rs`)

`Step` enum에 arm 추가 (`Step::If(IfStep),` 다음 줄):
```rust
    Parallel(ParallelStep),
```

`Step::id()`/`Step::name()` match에 arm 추가:
```rust
            Step::Parallel(p) => &p.id,   // id()
```
```rust
            Step::Parallel(p) => &p.name, // name()
```

`IfStep`/`ElifBranch` 정의 근처에 추가:
```rust
/// Concurrent fan-out node. All `branches` run at once within one VU (shared
/// cookie jar / client, ADR-0018); the node completes when all finish (wait-all).
/// Like `LoopStep`/`IfStep` this is a plain-derive struct variant (round-trips in
/// serde_yaml 0.9; NOT a map-shape manual-serde enum). `Vec<Step>` per branch for
/// free nesting (single-level / top-level-only is the UI Zod gate). ADR-0033.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ParallelStep {
    pub id: String,
    pub name: String,
    pub branches: Vec<Branch>,
}

/// One lane of a `ParallelStep`. `name` is the namespace key for this branch's
/// outputs (`{{name.var}}` downstream) — required, unique within the node (UI Zod).
/// No `id` (like `ElifBranch`): the branch is a label/group, its http children
/// carry the metric ids.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Branch {
    pub name: String,
    pub steps: Vec<Step>,
}

impl Branch {
    /// Variable names this branch declares as extract outputs (http-only in v1).
    /// The parallel merge namespaces exactly these keys (key-origin, not value-diff
    /// — a branch that re-extracts a parent's value is still exposed; design §3.2).
    pub fn output_var_names(&self) -> Vec<&str> {
        let mut out = Vec::new();
        for s in &self.steps {
            if let Step::Http(h) = s {
                for e in &h.extract {
                    out.push(e.var());
                }
            }
        }
        out
    }
}
```

`Extract` enum 정의 아래에 추가:
```rust
impl Extract {
    /// The flow variable this extract writes to.
    pub fn var(&self) -> &str {
        match self {
            Extract::Body { var, .. }
            | Extract::Header { var, .. }
            | Extract::Cookie { var, .. }
            | Extract::Status { var } => var,
        }
    }
}
```

- [ ] **Step 4: `lib.rs` 재export**

`crates/engine/src/lib.rs` 의 `pub use scenario::{ … };`(`:23-26`) 목록에 `Branch, ParallelStep` 추가(`ElifBranch`/`IfStep` 옆 — 와이어 1:1 / handicap-reviewer 대조 패턴).

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-engine --lib scenario`
Expected: PASS (신규 4개 + 기존 전부).

- [ ] **Step 6: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm (cold-build flake 회피)
git add crates/engine/src/scenario.rs crates/engine/src/lib.rs
git commit -m "feat(engine): Step::Parallel/ParallelStep/Branch 모델 + serde round-trip

ADR-0033 P-a. plain-derive struct variant(LoopStep/IfStep 패턴), branch name=
네임스페이스 키, Branch::output_var_names(key-origin merge용) + Extract::var().

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 2: 엔진 인터프리터 `Step::Parallel` arm

**Files:**
- Modify: `crates/engine/src/runner.rs`
- Create: `crates/engine/tests/parallel_node.rs`

- [ ] **Step 1: 통합 테스트 작성** (`crates/engine/tests/parallel_node.rs`)

기존 `crates/engine/tests/loop_node.rs` 의 import/harness 패턴(wiremock `MockServer`, `run_scenario`, `RunPlan`, mpsc, `CancellationToken`)을 먼저 읽어 그대로 차용한다. `RunPlan` 의 모든 필드를 채워야 한다(아래 헬퍼 참고 — `target_rps: None`, `max_in_flight: None`, `stages: None`, `vu_offset: 0`, `data_binding: None`, `http_timeout: Duration::from_secs(30)`, `think_time: None`, `think_seed: None`, `loop_breakdown_cap: 256`).

```rust
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use handicap_engine::runner::{run_scenario, MetricFlush, RunPlan};
use handicap_engine::scenario::Scenario;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn plan(base: &str, secs: u64) -> RunPlan {
    let mut env = BTreeMap::new();
    env.insert("BASE".to_string(), base.to_string());
    RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(secs),
        env,
        loop_breakdown_cap: 256,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
    }
}

async fn drain(mut rx: mpsc::Receiver<MetricFlush>) -> Vec<MetricFlush> {
    let mut v = Vec::new();
    while let Some(f) = rx.recv().await {
        v.push(f);
    }
    v
}

#[tokio::test]
async fn parallel_branches_run_concurrently() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - {{ id: "01HX0000000000000000000011", name: ga, type: http, request: {{ method: GET, url: "${{BASE}}/a" }}, assert: [] }}
      - name: b
        steps:
          - {{ id: "01HX0000000000000000000012", name: gb, type: http, request: {{ method: GET, url: "${{BASE}}/b" }}, assert: [] }}
"#
    );
    let sc = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    let started = Instant::now();
    run_scenario(sc, plan(&server.uri(), 1), tx, CancellationToken::new())
        .await
        .unwrap();
    let _ = drain(rx).await;
    let elapsed = started.elapsed();
    // Sequential would be 2×300ms = 600ms+. Concurrent ≈ 300ms (generous bound).
    assert!(
        elapsed < Duration::from_millis(520),
        "branches must run concurrently, took {elapsed:?}"
    );
    // Each endpoint was hit at least once.
    let reqs = server.received_requests().await.unwrap();
    assert!(reqs.iter().any(|r| r.url.path() == "/a"));
    assert!(reqs.iter().any(|r| r.url.path() == "/b"));
}

#[tokio::test]
async fn parallel_namespaces_branch_outputs_key_origin() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "AAA"})))
        .mount(&server)
        .await;
    // Branch b re-extracts the SAME value as scenario.variables.id (key-origin: the
    // {{b.id}} must still be exposed even though the value coincides with parent id).
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "SEED"})))
        .mount(&server)
        .await;
    // /combine must receive BOTH namespaced values. If {{a.id}}/{{b.id}} were unbound
    // the strict render would error and the request would never arrive.
    Mock::given(method("GET"))
        .and(path("/combine"))
        .and(query_param("u", "AAA"))
        .and(query_param("f", "SEED"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: par
variables:
  id: SEED
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - {{ id: "01HX0000000000000000000011", name: ga, type: http, request: {{ method: GET, url: "${{BASE}}/a" }}, assert: [], extract: [ {{ var: id, from: body, path: "$.id" }} ] }}
      - name: b
        steps:
          - {{ id: "01HX0000000000000000000012", name: gb, type: http, request: {{ method: GET, url: "${{BASE}}/b" }}, assert: [], extract: [ {{ var: id, from: body, path: "$.id" }} ] }}
  - id: "01HX0000000000000000000013"
    name: combine
    type: http
    request: {{ method: GET, url: "${{BASE}}/combine?u={{{{a.id}}}}&f={{{{b.id}}}}" }}
    assert: []
"#
    );
    let sc = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 1), tx, CancellationToken::new())
        .await
        .unwrap();
    let _ = drain(rx).await;
    let reqs = server.received_requests().await.unwrap();
    assert!(
        reqs.iter().any(|r| r.url.path() == "/combine"
            && r.url.query().unwrap_or("").contains("u=AAA")
            && r.url.query().unwrap_or("").contains("f=SEED")),
        "downstream must see {{a.id}}=AAA and {{b.id}}=SEED (key-origin namespace)"
    );
}

#[tokio::test]
async fn parallel_branch_http_failure_does_not_kill_vu() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ok"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    // Branch b points at a dead port → connection error (recorded, not fatal).
    let yaml = format!(
        r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - {{ id: "01HX0000000000000000000011", name: ga, type: http, request: {{ method: GET, url: "${{BASE}}/ok" }}, assert: [] }}
      - name: b
        steps:
          - {{ id: "01HX0000000000000000000012", name: gb, type: http, request: {{ method: GET, url: "http://127.0.0.1:1/dead" }}, assert: [] }}
"#
    );
    let sc = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    // run must NOT error (HTTP failure is a recorded metric, not a VU kill).
    run_scenario(sc, plan(&server.uri(), 1), tx, CancellationToken::new())
        .await
        .expect("connection error in a branch must not fail the run");
    let _ = drain(rx).await;
    assert!(server.received_requests().await.unwrap().iter().any(|r| r.url.path() == "/ok"));
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-engine --test parallel_node`
Expected: FAIL — `Step::Parallel` arm 미구현이라 `execute_steps` 의 `match step` 이 non-exhaustive 컴파일 에러(또는 panic).

- [ ] **Step 3: arm 구현** (`runner.rs`)

`use rand::SeedableRng;` 근처에 추가:
```rust
use rand::RngCore;
```

`execute_steps` 의 `match step { ... }` 에서 `Step::If(if_step) => { ... }` arm 다음에 추가:
```rust
            Step::Parallel(par) => {
                // Snapshot entry vars; each branch runs on its own clone (concurrent
                // branches can't share &mut iter_vars). Reads see entry; writes
                // (extracts) stay branch-local and are merged back namespaced (§3.2).
                let entry: BTreeMap<String, String> = iter_vars.clone();
                // One deterministic seed per branch, drawn in declaration order from
                // the VU rng (reproducible given think_seed). Concurrent branches
                // can't share &mut rng, so each gets an independent StdRng.
                let seeds: Vec<u64> = (0..par.branches.len()).map(|_| rng.next_u64()).collect();

                let futs = par.branches.iter().zip(seeds).map(|(branch, seed)| {
                    let mut branch_vars = entry.clone();
                    let mut branch_rng = StdRng::seed_from_u64(seed);
                    async move {
                        // Box::pin: recursive async (If/Loop arms do the same) —
                        // hot flat-http path stays unboxed.
                        let flow = Box::pin(execute_steps(
                            client,
                            &branch.steps,
                            &mut branch_vars,
                            agg,
                            deadline,
                            env,
                            vu_id,
                            iter_id,
                            loop_index,
                            cancel,
                            &mut branch_rng,
                        ))
                        .await;
                        (branch, branch_vars, flow)
                    }
                });
                // wait-all: every branch runs to completion before the node returns.
                let results = futures::future::join_all(futs).await;

                // Merge in declaration order (join_all preserves input order). Key-origin
                // namespace: expose each branch's declared extract outputs as
                // {{branch.var}}. Branch names are unique (UI gate) so prefixes are
                // disjoint → order-independent; the declaration-order loop also makes
                // a duplicate-name run reproducible. First Err propagates (highest
                // priority); else worst flow (Aborted > DeadlineReached > Continue).
                let mut aborted = false;
                let mut deadline_hit = false;
                for (branch, branch_vars, flow) in results {
                    match flow? {
                        StepFlow::Continue => {}
                        StepFlow::DeadlineReached => deadline_hit = true,
                        StepFlow::Aborted => aborted = true,
                    }
                    for k in branch.output_var_names() {
                        if let Some(v) = branch_vars.get(k) {
                            iter_vars.insert(format!("{}.{}", branch.name, k), v.clone());
                        }
                    }
                }
                if aborted {
                    return Ok(StepFlow::Aborted);
                }
                if deadline_hit {
                    return Ok(StepFlow::DeadlineReached);
                }
            }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-engine --test parallel_node`
Expected: PASS (3개). 타이밍 테스트가 가끔 flake나면 (런 환경 부하) `< 520ms` bound는 그대로 두고 재시도 — 진짜 회귀는 `/a`·`/b` 미수신.

- [ ] **Step 5: 전체 엔진 테스트 (byte-identical 회귀 가드)**

Run: `cargo test -p handicap-engine`
Expected: PASS — 기존 loop/if/flat 테스트 전부 통과(parallel arm은 추가만, 기존 경로 무변경).

- [ ] **Step 6: 커밋**

```bash
git add crates/engine/src/runner.rs crates/engine/tests/parallel_node.rs
git commit -m "feat(engine): execute_steps Step::Parallel arm (join_all wait-all + 네임스페이스 merge)

협력 동시성(공유 jar/client), 분기별 entry 스냅샷 복제, key-origin {{branch.var}}
merge(선언 순서), 에러 lenient(HTTP 실패는 메트릭·VU 미살, 진짜 엔진 에러는 join 후
전파). 핫패스 byte-identical. ADR-0033 P-a.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 3: trace lockstep `Step::Parallel` arm

**Files:**
- Modify: `crates/engine/src/trace.rs`

- [ ] **Step 1: 인라인 테스트 작성** (`trace.rs` 의 `#[cfg(test)] mod tests` 에 추가)

`trace_scenario` 는 실제 HTTP를 치므로 wiremock 이 필요. 기존 trace 테스트가 없으면 `tokio::test` + `MockServer` 로 작성(`crates/engine/tests/` 가 아니라 인라인이면 dev-dep wiremock 사용 가능 — `crates/engine/Cargo.toml` `[dev-dependencies]` 에 wiremock 확인; 없으면 이 테스트만 `crates/engine/tests/parallel_trace.rs` 통합 테스트로). 여기서는 통합 테스트 파일로 둔다:

Create `crates/engine/tests/parallel_trace.rs`:
```rust
use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::scenario::Scenario;
use handicap_engine::trace::{trace_scenario, StepKind, TraceOptions};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn trace_runs_parallel_branches_and_namespaces_outputs() {
    let server = MockServer::start().await;
    Mock::given(method("GET")).and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "AAA"})))
        .mount(&server).await;
    Mock::given(method("GET")).and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "BBB"})))
        .mount(&server).await;
    Mock::given(method("GET")).and(path("/combine")).and(query_param("u", "AAA")).and(query_param("f", "BBB"))
        .respond_with(ResponseTemplate::new(200)).mount(&server).await;
    let mut env = BTreeMap::new();
    env.insert("BASE".to_string(), server.uri());
    let yaml = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/a" }, assert: [], extract: [ { var: id, from: body, path: "$.id" } ] }
      - name: b
        steps:
          - { id: "01HX0000000000000000000012", name: gb, type: http, request: { method: GET, url: "${BASE}/b" }, assert: [], extract: [ { var: id, from: body, path: "$.id" } ] }
  - id: "01HX0000000000000000000013"
    name: combine
    type: http
    request: { method: GET, url: "${BASE}/combine?u={{a.id}}&f={{b.id}}" }
    assert: []
"#;
    let sc = Scenario::from_yaml(yaml).unwrap();
    let opts = TraceOptions {
        env,
        max_requests: 50,
        max_wall: Duration::from_secs(10),
        apply_think_time: false,
    };
    let t = trace_scenario(&sc, &opts).await;
    // 3 http rows (2 branch leaves + combine); no decision row for parallel.
    let http_rows: Vec<_> = t.steps.iter().filter(|s| s.kind == StepKind::Http).collect();
    assert_eq!(http_rows.len(), 3);
    // combine row resolved both namespaced vars (it returned 200, no unbound).
    let combine = t.steps.iter().find(|s| s.step_id == "01HX0000000000000000000013").unwrap();
    assert!(combine.unbound_vars.is_empty(), "namespaced vars must resolve in trace");
    assert_eq!(combine.response.as_ref().unwrap().status, 200);
    // final_vars carries the namespaced outputs.
    assert_eq!(t.final_vars.get("a.id").map(String::as_str), Some("AAA"));
    assert_eq!(t.final_vars.get("b.id").map(String::as_str), Some("BBB"));
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-engine --test parallel_trace`
Expected: FAIL — `trace_steps` 의 `match step` non-exhaustive (Parallel arm 없음).

- [ ] **Step 3: arm 구현** (`trace.rs::trace_steps`)

`Step::If(if_step) => { ... }` arm 다음에 추가:
```rust
            Step::Parallel(par) => {
                // Trace is a single 1-VU pass: timing is irrelevant, so run branches
                // SEQUENTIALLY (no concurrency machinery). Each branch runs on its own
                // clone of the entry vars (isolated, matching the load path), then its
                // declared outputs are merged back namespaced so downstream rows
                // resolve {{branch.var}} (mirror runner::execute_steps' Parallel arm).
                // No decision row for the node itself (all branches run); each branch
                // http appears as an ordinary Http row in declaration order.
                let entry = iter_vars.clone();
                for branch in &par.branches {
                    if state.truncated {
                        return;
                    }
                    let mut branch_vars = entry.clone();
                    Box::pin(trace_steps(
                        client,
                        &branch.steps,
                        &mut branch_vars,
                        env,
                        loop_index,
                        opts,
                        deadline,
                        state,
                    ))
                    .await;
                    for k in branch.output_var_names() {
                        if let Some(v) = branch_vars.get(k) {
                            iter_vars.insert(format!("{}.{}", branch.name, k), v.clone());
                        }
                    }
                }
            }
```

`trace.rs` 상단 `use crate::scenario::{...}` 에 이미 `Step` 이 있으므로 추가 import 불필요(`Branch::output_var_names` 는 메서드라 별도 import 없음).

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-engine --test parallel_trace`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add crates/engine/src/trace.rs crates/engine/tests/parallel_trace.rs
git commit -m "feat(engine): trace_steps Step::Parallel arm (lockstep)

분기 순차 실행(trace=1VU 단일패스, 타이밍 무의미) + 동일 key-origin 네임스페이스
merge로 다운스트림 {{branch.var}} resolve. 결정 행 없음(전 분기 실행). ADR-0033 P-a.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 4: 컨트롤러 `insights.rs` `Parallel` arm

**Files:**
- Modify: `crates/controller/src/insights.rs`

`collect_unconditional` 의 `match s` 는 exhaustive(wildcard 없음) — `Step::Parallel` 추가로 컨트롤러가 **컴파일 실패**한다. 분기는 무조건 도달하므로 `conditional` 플래그를 그대로 넘겨 재귀(loop arm과 동형). 효과: parallel 분기 안 assertion 없는 http 도 `no_request_step` 후보가 된다(항상 실행되므로 옳음).

- [ ] **Step 1: 인라인 테스트 작성** (`insights.rs` 의 `#[cfg(test)] mod tests` 에 추가)

기존 테스트 헬퍼(`fn step(...)`, `ReportStep`, scenario YAML 빌더)를 읽어 패턴을 맞춘다. `derive_insights`/`collect_unconditional` 가 시나리오 YAML을 받는 형태에 맞춰:
```rust
    #[test]
    fn parallel_branch_steps_are_unconditional() {
        let mut out = Vec::new();
        let sc = handicap_engine::scenario::Scenario::from_yaml(
            r#"
version: 1
name: p
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "/a" }, assert: [] }
"#,
        )
        .unwrap();
        super::collect_unconditional(&sc.steps, false, &mut out);
        assert_eq!(out, vec!["01HX0000000000000000000011".to_string()]);
    }
```
(`collect_unconditional` 가 `fn`(non-pub)이면 `super::collect_unconditional` 로 모듈 내 테스트에서 호출 가능.)

- [ ] **Step 2: 테스트 실패 확인 (컴파일 에러)**

Run: `cargo test -p handicap-controller --lib insights`
Expected: FAIL — `non-exhaustive patterns: \`&Step::Parallel(_)\` not covered`.

- [ ] **Step 3: arm 구현** (`insights.rs::collect_unconditional`)

`Step::If(i) => { ... }` arm 다음에 추가:
```rust
            Step::Parallel(p) => {
                // All branches always run → unconditional (pass the flag through,
                // like the loop arm). ADR-0033.
                for b in &p.branches {
                    collect_unconditional(&b.steps, conditional, out);
                }
            }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --lib insights`
Expected: PASS.

- [ ] **Step 5: 전체 컨트롤러 빌드 + 테스트 (무변경 경계 확인)**

Run: `cargo test -p handicap-controller`
Expected: PASS — proto/store/report 무변경, insights 1 arm만 추가.

- [ ] **Step 6: 커밋 (P-a 완료)**

```bash
cargo build --workspace
git add crates/controller/src/insights.rs
git commit -m "feat(controller): insights collect_unconditional Parallel arm

exhaustive match라 Step::Parallel 필수(빌드 게이트). 분기는 무조건 도달 →
conditional 플래그 passthrough(loop arm 동형). 그 외 컨트롤러/proto/워커/migration
무변경. ADR-0033 P-a 완료.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

# P-b — UI authoring

> **게이트(매 Task 커밋 전):** `cd ui && pnpm lint && pnpm test && pnpm build`. `pnpm test <name>`(인자 `--` 없이)로 단일파일 빠른 반복, 머지 전 인자 없는 전체 `pnpm test` 1회. `pnpm build`(`tsc -b`)만 strict 타입(특히 Zod `.default()` 누출)을 잡는다.

## Task 5: Zod 모델 + 헬퍼 + `normalizeStep` (4-way widening, 한 커밋)

**Files:**
- Modify: `ui/src/scenario/model.ts`
- Modify: `ui/src/scenario/yamlDoc.ts` (`normalizeStep` parallel + `normalizeBranch`)
- Modify(같은-커밋 컴파일 스텁): `ui/src/scenario/__tests__/proptests.test.ts`, `ui/src/components/scenario/CanvasView.tsx`, `ui/src/components/scenario/Inspector.tsx`
- Test: `ui/src/scenario/__tests__/model.test.ts` (기존 파일에 추가)

> **`tsc -b` 캐스케이드(9c 함정 — 이 Task의 CRITICAL 제약):** `StepModel` 을 4-way 로 넓히면 `Step` 유니언을 exhaustive 하게 쓰는 **프로덕션 3사이트 + 테스트 1사이트**가 그 자리에서 `tsc -b` red(`pnpm build` = Task 게이트)가 된다. 4곳 모두 **이 한 커밋**에 parallel 케이스(아래 Step 5의 컴파일 스텁)를 포함해야 P-b 첫 커밋이 green이다:
> - `CanvasView.tsx` `measureStep`(`:176`, trailing fallthrough `ifBands(step)` = `Extract<Step,{type:"if"}>`) + `emitStep`(`:208`, fallthrough `step.cond/then/else`) → 컴파일 스텁(실제 레인은 **Task 7이 교체**).
> - `Inspector.tsx` dispatch(`:57-59`, http가 trailing) → `if (isParallelStep(step)) return <ParallelInspector …/>` + 최소 `ParallelInspector` 스텁(**Task 8이 교체**) + `isParallelStep`/`ParallelStep` import + `ChildStepButton` 삼항(`:703` `: "if"`)에 parallel arm.
> - `__tests__/proptests.test.ts` `stepToYaml`(`:264`) 직렬화기에 parallel 케이스.

- [ ] **Step 1: 테스트 작성** (`model.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { ParallelStepModel, StepModel, flattenHttpSteps, findStepById, findStepSiblings } from "./model";

const http = (id: string, name = "h") => ({
  id, name, type: "http" as const,
  request: { method: "GET" as const, url: "/" },
  assert: [], extract: [],
});

const parallel = {
  id: "01HX0000000000000000000010", name: "fan", type: "parallel" as const,
  branches: [
    { name: "user", steps: [http("01HX0000000000000000000011")] },
    { name: "feed", steps: [http("01HX0000000000000000000012")] },
  ],
};

describe("ParallelStepModel", () => {
  it("parses a valid parallel step", () => {
    expect(ParallelStepModel.safeParse(parallel).success).toBe(true);
  });
  it("rejects duplicate branch names (namespace keys)", () => {
    const dup = { ...parallel, branches: [
      { name: "x", steps: [http("01HX0000000000000000000011")] },
      { name: "x", steps: [http("01HX0000000000000000000012")] },
    ]};
    const r = StepModel.safeParse(dup);
    expect(r.success).toBe(false);
  });
  it("rejects a branch with no steps", () => {
    const empty = { ...parallel, branches: [{ name: "a", steps: [] }] };
    expect(ParallelStepModel.safeParse(empty).success).toBe(false);
  });
  it("StepModel accepts parallel as a 4th variant", () => {
    expect(StepModel.safeParse(parallel).success).toBe(true);
  });
});

describe("helpers descend into parallel branches", () => {
  it("flattenHttpSteps collects branch leaves", () => {
    const flat = flattenHttpSteps([parallel as never]);
    expect(flat.map((s) => s.id)).toEqual([
      "01HX0000000000000000000011",
      "01HX0000000000000000000012",
    ]);
  });
  it("findStepById finds a step inside a branch", () => {
    expect(findStepById([parallel as never], "01HX0000000000000000000012")?.id).toBe(
      "01HX0000000000000000000012",
    );
    expect(findStepById([parallel as never], "01HX0000000000000000000010")?.type).toBe("parallel");
  });
  it("findStepSiblings returns the branch's step list", () => {
    const sibs = findStepSiblings([parallel as never], "01HX0000000000000000000011");
    expect(sibs.map((s) => s.id)).toEqual(["01HX0000000000000000000011"]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test model.test`
Expected: FAIL — `ParallelStepModel` export 없음.

- [ ] **Step 3: 모델 구현** (`model.ts`)

`IfStepModel` 정의 다음, `StepModel` 정의 **앞**에 추가:
```ts
// ── Parallel: top-level only (no nesting in v1). Branches are http-only sequences;
//    branch `name` is the namespace key for that branch's outputs ({{name.var}}). ──
export const BranchModel = z
  .object({
    name: z.string().min(1, "branch name required"),
    steps: z.array(HttpStepModel).min(1, "branch needs at least one step"),
  })
  .strict();
export type Branch = z.infer<typeof BranchModel>;

// Plain object (NO superRefine here) so it stays a valid discriminatedUnion member.
// Branch-name uniqueness is enforced on the StepModel union below (ZodEffects can't
// be a discriminatedUnion member — same constraint as BodyModel).
export const ParallelStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("parallel"),
    branches: z.array(BranchModel).min(1, "parallel needs at least one branch"),
  })
  .strict();
export type ParallelStep = z.infer<typeof ParallelStepModel>;
```

`StepModel` 을 교체:
```ts
export const StepModel = z
  .discriminatedUnion("type", [HttpStepModel, LoopStepModel, IfStepModel, ParallelStepModel])
  .superRefine((s, ctx) => {
    // Branch names must be unique within a parallel node — they are the namespace
    // keys for {{branch.var}}; duplicates would silently collapse downstream vars.
    if (s.type !== "parallel") return;
    const seen = new Set<string>();
    s.branches.forEach((b, i) => {
      if (seen.has(b.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate branch name "${b.name}"`,
          path: ["branches", i, "name"],
        });
      }
      seen.add(b.name);
    });
  });
export type Step = z.infer<typeof StepModel>;
```

`isParallelStep` 가드 추가(`isIfStep` 옆):
```ts
export function isParallelStep(s: Step): s is ParallelStep {
  return s.type === "parallel";
}
```

`flattenHttpSteps` — trailing `else`(=if 가정)를 `else if`로 좁히고 parallel 추가:
```ts
export function flattenHttpSteps(steps: ReadonlyArray<Step>): HttpStep[] {
  const out: HttpStep[] = [];
  for (const s of steps) {
    if (s.type === "http") out.push(s);
    else if (s.type === "loop") out.push(...flattenHttpSteps(s.do));
    else if (s.type === "parallel") {
      for (const b of s.branches) out.push(...flattenHttpSteps(b.steps));
    } else {
      // if
      out.push(...flattenHttpSteps(s.then));
      for (const e of s.elif) out.push(...flattenHttpSteps(e.then));
      out.push(...flattenHttpSteps(s.else));
    }
  }
  return out;
}
```

`siblingsOrNull` — `else if (s.type === "if")` 블록 **앞**에 추가:
```ts
    } else if (s.type === "parallel") {
      for (const b of s.branches) {
        const r = siblingsOrNull(b.steps, stepId);
        if (r) return r;
      }
    } else if (s.type === "if") {
```
(주의: 현재 `siblingsOrNull` 은 `if (loop) … else if (if)` 구조 — `else if (parallel)` 를 if 앞에 끼운다.)

`findStepById` — 동일하게 `else if (s.type === "if")` 앞에 parallel 추가:
```ts
    } else if (s.type === "parallel") {
      for (const b of s.branches) {
        const r = findStepById(b.steps, stepId);
        if (r) return r;
      }
    } else if (s.type === "if") {
```

- [ ] **Step 4: `normalizeStep` parallel** (`yamlDoc.ts`)

`normalizeStep` 의 `if (src.type === "if") { ... }` 블록 다음에 추가:
```ts
  if (src.type === "parallel") {
    return {
      id: src.id,
      name: src.name,
      type: "parallel",
      branches: Array.isArray(src.branches) ? src.branches.map(normalizeBranch) : [],
    };
  }
```
파일 하단 `normalizeElif` 옆에 추가:
```ts
function normalizeBranch(b: unknown): unknown {
  if (typeof b !== "object" || b === null) return b;
  const src = b as Record<string, unknown>;
  return {
    name: src.name,
    steps: Array.isArray(src.steps) ? src.steps.map(normalizeStep) : [],
  };
}
```

- [ ] **Step 5: 같은-커밋 컴파일 스텁 (CRITICAL — 위 캐스케이드 4사이트)**

(a) `CanvasView.tsx` `measureStep` 의 if-fallthrough **앞**:
```ts
  if (step.type === "parallel") return 0; // Task 7이 실제 레인 높이로 교체
```
(b) `CanvasView.tsx` `emitStep` 의 if-fallthrough **앞**(`const inner = ...` 다음):
```ts
  if (step.type === "parallel") return; // Task 7이 레인 노드 emit으로 교체
```
(c) `Inspector.tsx`: import에 `isParallelStep` + `ParallelStep` 타입 추가. dispatch(`return <HttpStepInspector step={step} />` **앞**):
```tsx
  if (isParallelStep(step)) return <ParallelInspector step={step} topLevel={topLevel} />;
```
최소 스텁(Task 8이 실제 분기 편집기로 교체):
```tsx
function ParallelInspector({ step }: { step: ParallelStep; topLevel: boolean }) {
  return <div className="text-xs text-slate-500">parallel: {step.branches.length} branches</div>;
}
```
`ChildStepButton` 삼항(`:703`)의 `: "if"` 를 `: step.type === "parallel" ? "parallel" : "if"` 로.
(d) `__tests__/proptests.test.ts` `stepToYaml`(`:264`)에 parallel 케이스: `{ id, name, type: "parallel", branches: step.branches.map((b) => ({ name: b.name, steps: b.steps.map(httpToYaml) })) }`(실제 헬퍼명은 파일에서 확인). round-trip arbitrary에 parallel을 더할 필요 없음(스코프 최소) — exhaustive switch 컴파일 위해 케이스만.

- [ ] **Step 6: 게이트**

Run: `cd ui && pnpm test model.test && pnpm build`
Expected: model.test PASS + `tsc -b` clean(4-way + 4 캐스케이드 사이트 모두 parallel 케이스).

- [ ] **Step 7: 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
git add ui/src/scenario/model.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/model.test.ts ui/src/scenario/__tests__/proptests.test.ts ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/Inspector.tsx
git commit -m "feat(ui): ParallelStepModel + StepModel 4-way + 헬퍼/normalize parallel 하강

분기명 유니크 superRefine(union 레벨, ZodEffects/discriminatedUnion 제약 회피),
flattenHttpSteps/findStepById/findStepSiblings parallel 하강(trailing-else→else-if),
normalizeStep/normalizeBranch. tsc-b 캐스케이드 소비처 같은-커밋 fold. ADR-0033 P-b.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 6: yamlDoc Edit 5종 + `searchSeq` 하강 + store actions

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts`
- Modify: `ui/src/scenario/store.ts`
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts` (기존 파일에 추가)

- [ ] **Step 1: 테스트 작성** (`yamlDoc.test.ts`)

기존 yamlDoc 테스트의 헬퍼(`parseScenarioDoc`/`applyEdit`/`serializeDoc` round-trip 패턴)를 따른다.
```ts
import { describe, it, expect } from "vitest";
import { parseScenarioDoc, applyEdit, serializeDoc } from "./yamlDoc";

const BASE = `version: 1
name: t
steps: []
`;

function apply(yaml: string, edit: Parameters<typeof applyEdit>[1]): string {
  const r = parseScenarioDoc(yaml);
  if ("error" in r) throw new Error(r.error);
  applyEdit(r.doc, edit);
  return serializeDoc(r.doc);
}

describe("parallel edits", () => {
  it("addParallelStep seeds two named branches with one http each", () => {
    const out = apply(BASE, {
      type: "addParallelStep", id: "01HX0000000000000000000010", name: "fan",
      branch1Id: "01HX0000000000000000000011", branch2Id: "01HX0000000000000000000012",
    });
    const r = parseScenarioDoc(out);
    if ("error" in r) throw new Error(r.error);
    const p = r.model.steps[0];
    expect(p.type).toBe("parallel");
    if (p.type !== "parallel") return;
    expect(p.branches.map((b) => b.name)).toEqual(["branch1", "branch2"]);
    expect(p.branches[0].steps[0].id).toBe("01HX0000000000000000000011");
  });

  it("addBranch / addStepInParallelBranch / setBranchName / removeBranch", () => {
    let out = apply(BASE, {
      type: "addParallelStep", id: "01HX0000000000000000000010", name: "fan",
      branch1Id: "01HX0000000000000000000011", branch2Id: "01HX0000000000000000000012",
    });
    out = apply(out, { type: "addBranch", parallelId: "01HX0000000000000000000010", name: "branch3", childId: "01HX0000000000000000000013" });
    out = apply(out, { type: "addStepInParallelBranch", parallelId: "01HX0000000000000000000010", branchIndex: 0, id: "01HX0000000000000000000014", name: "Step 2" });
    out = apply(out, { type: "setBranchName", parallelId: "01HX0000000000000000000010", branchIndex: 1, name: "feed" });
    out = apply(out, { type: "removeBranch", parallelId: "01HX0000000000000000000010", index: 2 });
    const r = parseScenarioDoc(out);
    if ("error" in r) throw new Error(r.error);
    const p = r.model.steps[0];
    if (p.type !== "parallel") throw new Error("not parallel");
    expect(p.branches.length).toBe(2);
    expect(p.branches[1].name).toBe("feed");
    expect(p.branches[0].steps.map((s) => s.id)).toEqual([
      "01HX0000000000000000000011", "01HX0000000000000000000014",
    ]);
  });

  it("removeStep / setStepField descend into a parallel branch (searchSeq)", () => {
    let out = apply(BASE, {
      type: "addParallelStep", id: "01HX0000000000000000000010", name: "fan",
      branch1Id: "01HX0000000000000000000011", branch2Id: "01HX0000000000000000000012",
    });
    out = apply(out, { type: "setStepField", stepId: "01HX0000000000000000000011", path: ["request", "url"], value: "/changed" });
    expect(out).toContain("/changed");
    out = apply(out, { type: "removeStep", stepId: "01HX0000000000000000000012" });
    const r = parseScenarioDoc(out);
    if ("error" in r) throw new Error(r.error);
    const p = r.model.steps[0];
    if (p.type !== "parallel") throw new Error("not parallel");
    // branch2 now has 0 steps → Zod min(1) would reject; so the test scenario keeps
    // branch2 with its seeded step and removes branch1's instead. Adjust if needed:
    expect(p.branches[1].steps.length).toBe(0);
  });
});
```
(마지막 케이스의 `min(1)` 충돌 — **명시 지시**: `removeStep` 이 분기의 마지막 스텝을 지우면 `BranchModel.min(1)` 때문에 `parseScenarioDoc` 가 `{error}` 를 반환해 `if ("error" in r) throw` 가 단언 전에 던진다. 따라서 그 케이스의 검증은 **`parseScenarioDoc` 가 아니라 `serializeDoc(doc)` 텍스트로** — `expect(out).not.toContain("01HX0000000000000000000012")` 처럼 doc 레벨에서 id가 사라졌는지만 단언한다. searchSeq 의 분기 하강 동작 검증이 목적이지 모델 유효성이 아니다.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test yamlDoc.test`
Expected: FAIL — 새 Edit 타입 미정의(TS) / 케이스 미처리.

- [ ] **Step 3: Edit 타입 + applyEdit 케이스** (`yamlDoc.ts`)

`Edit` 유니언에 추가(`addIfInLoop` 다음):
```ts
  | { type: "addParallelStep"; id: string; name: string; branch1Id: string; branch2Id: string }
  | { type: "addBranch"; parallelId: string; name: string; childId: string }
  | { type: "removeBranch"; parallelId: string; index: number }
  | {
      type: "addStepInParallelBranch";
      parallelId: string;
      branchIndex: number;
      id: string;
      name: string;
    }
  | { type: "setBranchName"; parallelId: string; branchIndex: number; name: string }
```

`applyEdit` switch에 케이스 추가(헬퍼 `seedHttp` 는 인라인 객체로):
```ts
    case "addParallelStep": {
      ensureSeq(doc, ["steps"]);
      const steps = doc.getIn(["steps"]) as YAMLSeq;
      const seed = (id: string) => ({
        id, name: "Step 1", type: "http",
        request: { method: "GET", url: "/" }, assert: [{ status: 200 }],
      });
      const node = doc.createNode({
        id: edit.id, name: edit.name, type: "parallel",
        branches: [
          { name: "branch1", steps: [seed(edit.branch1Id)] },
          { name: "branch2", steps: [seed(edit.branch2Id)] },
        ],
      });
      steps.add(node);
      return;
    }
    case "addBranch": {
      const path = findStepPath(doc, edit.parallelId);
      if (path === null) return;
      ensureSeq(doc, [...path, "branches"]);
      const branches = doc.getIn([...path, "branches"]) as YAMLSeq;
      const node = doc.createNode({
        name: edit.name,
        steps: [
          {
            id: edit.childId, name: "Step 1", type: "http",
            request: { method: "GET", url: "/" }, assert: [{ status: 200 }],
          },
        ],
      });
      branches.add(node);
      return;
    }
    case "removeBranch": {
      const path = findStepPath(doc, edit.parallelId);
      if (path === null) return;
      doc.deleteIn([...path, "branches", edit.index]);
      return;
    }
    case "addStepInParallelBranch": {
      const path = findStepPath(doc, edit.parallelId);
      if (path === null) return;
      ensureSeq(doc, [...path, "branches", edit.branchIndex, "steps"]);
      const body = doc.getIn([...path, "branches", edit.branchIndex, "steps"]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id, name: edit.name, type: "http",
        request: { method: "GET", url: "/" }, assert: [{ status: 200 }],
      });
      body.add(node);
      return;
    }
    case "setBranchName": {
      const path = findStepPath(doc, edit.parallelId);
      if (path === null) return;
      doc.setIn([...path, "branches", edit.branchIndex, "name"], plainScalar(edit.name));
      return;
    }
```

`searchSeq` — elif 처리 블록 다음, `return null` 앞에 parallel 하강 추가:
```ts
    const branches = item.get("branches");
    if (isSeq(branches)) {
      for (let j = 0; j < branches.items.length; j++) {
        const br = branches.items[j] as Node;
        if (!isMap(br)) continue;
        const inBr = searchSeq(br.get("steps"), [...path, "branches", j, "steps"], stepId);
        if (inBr) return inBr;
      }
    }
```

- [ ] **Step 4: store thin actions** (`store.ts`)

기존 `addIfStep`/`addStepInBranch`/`addLoopStep` thin action 패턴(ULID 생성 → `applyEdit` → reserialize → return id)을 읽어 미러. 새 action 5종:
```ts
addParallelStep(name) → ids: id/branch1Id/branch2Id 3개 생성, applyEdit(addParallelStep), return id
addBranch(parallelId) → 현재 model에서 그 parallel의 분기명을 읽어 충돌 없는 기본명 생성
                        (`branch{N}`, N=유니크 만드는 첫 정수) + childId 생성, applyEdit(addBranch)
removeBranch(parallelId, index) → applyEdit(removeBranch)
addStepInParallelBranch(parallelId, branchIndex, name) → id 생성, applyEdit, return id
setBranchName(parallelId, branchIndex, name) → applyEdit
```
(ULID 생성기는 기존 action이 쓰는 헬퍼 — `store.ts` 에서 확인해 동일 사용. **`addBranch` 가 유니크 기본명을 생성**해야 새 분기가 superRefine(분기명 유니크, Task 5)에 즉시 걸리지 않는다 — 리뷰 지적.)

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm test yamlDoc.test && pnpm lint && pnpm test && pnpm build && cd ..
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git commit -m "feat(ui): parallel yamlDoc Edit 5종 + searchSeq 분기 하강 + store actions

addParallelStep(2분기 시드)/addBranch/removeBranch/addStepInParallelBranch/
setBranchName + findStepPath의 branches[].steps 재귀 하강. ADR-0033 P-b.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 7: 캔버스 세로 레인 (`ParallelStepNode` + 에미터 + 툴바)

**Files:**
- Create: `ui/src/components/scenario/ParallelStepNode.tsx`
- Modify: `ui/src/components/scenario/CanvasView.tsx` (Task 5의 measureStep/emitStep parallel **스텁을 교체**)
- Test: `ui/src/components/scenario/__tests__/CanvasView.test.tsx` (기존 파일에 추가)

> 먼저 `ui/src/components/scenario/IfStepNode.tsx` 를 읽는다 — `ParallelStepNode` 는 그 패턴(헤더 + 밴드 라벨 + 자식은 React Flow `parentId` 로 떠 있음)을 **가로 레인**으로 바꾼 것이다. `data.lanes: {name, x}[]` 가 IfStepNode 의 `data.bands: {label, y}[]` 에 대응. **node data 타입은 반드시 `interface … extends Record<string, unknown>`**(v12 `Node<TData>` 제약 — `HttpStepNode.tsx:4`/`IfStepNode.tsx:4` 패턴; plain `type` 은 `tsc -b` 거부).

- [ ] **Step 1: 테스트 작성** (`CanvasView.test.tsx`)

기존 CanvasView 테스트(ResizeObserver 폴리필은 `test/setup.ts` 에 있음)의 store-seed + 노드 렌더 패턴을 따른다.
```ts
it("renders a parallel node with one node per branch step + lane labels", async () => {
  // seed store with a scenario containing a parallel node (2 branches, 1 http each)
  // then assert: a node with data.type "parallel" exists, branch names render,
  // and each branch http leaf renders as its own node.
  // (mirror the existing "renders an if node" test's store-seed + getByText assertions.)
});

it("'+ Add parallel' toolbar button adds a parallel step", async () => {
  // click the button, assert store.model.steps gains a parallel step with 2 branches.
});
```
(구체 셀렉터는 기존 if-node 테스트를 그대로 미러 — branch name `getByText("user")`, 노드 텍스트 등.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test CanvasView`
Expected: FAIL — parallel 노드 미렌더 / "+ Add parallel" 버튼 없음.

- [ ] **Step 3: `ParallelStepNode.tsx` 구현**

`IfStepNode.tsx` 를 복사해 다음으로 변형: 헤더 텍스트 `⇉ {name} · parallel`(동시성 표시), `data.lanes: {name:string; x:number}[]` 를 받아 각 레인 라벨을 그 x 오프셋(absolute, top: 헤더 아래)에 렌더. 컨테이너는 `w-full box-border` + 부모가 준 `style.width/height`. 자식 http 노드는 React Flow가 `parentId` 로 띄우므로 이 컴포넌트는 배경/헤더/레인 라벨만.
```tsx
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export interface ParallelStepNodeData extends Record<string, unknown> {
  name: string;
  lanes: Array<{ name: string; x: number }>;
  selected: boolean;
}

export const ParallelStepNode = memo(function ParallelStepNode({
  data,
}: NodeProps<Node<ParallelStepNodeData, "parallel">>) {
  return (
    <div
      className={`w-full box-border h-full rounded-md border ${
        data.selected ? "border-indigo-500" : "border-slate-300"
      } bg-indigo-50/40`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="px-2 py-1 text-xs font-semibold text-indigo-700">
        ⇉ {data.name} · parallel
      </div>
      {data.lanes.map((lane) => (
        <div
          key={lane.name}
          className="absolute text-[10px] font-medium text-indigo-600"
          style={{ left: lane.x, top: 36 }}
        >
          {lane.name}
        </div>
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
```
(`IfStepNode` 의 Handle/스타일/`memo`/`NodeProps<Node<...>>` 형식을 정확히 맞춘다 — v12 시그니처 함정은 `ui/CLAUDE.md`.)

- [ ] **Step 4: 에미터 + 툴바** (`CanvasView.tsx`)

상수 추가(`LOOP_PAD` 근처):
```ts
const LANE_WIDTH = 200;
const LANE_GAP = 12;
const PARALLEL_HEADER_H = 36;
const LANE_LABEL_H = 18;
```
import + NODE_TYPES:
```ts
import { ParallelStepNode, type ParallelStepNodeData } from "./ParallelStepNode";
// ...
const NODE_TYPES = { http: HttpStepNode, loop: LoopStepNode, if: IfStepNode, parallel: ParallelStepNode };
```
`AnyData` 유니언에 `| ParallelStepNodeData`.

`measureStep` 의 Task 5 스텁(`if (step.type === "parallel") return 0;`)을 실제 높이 계산으로 **교체**:
```ts
  if (step.type === "parallel") {
    const laneH = (steps: typeof step.branches[number]["steps"]) =>
      steps.reduce((h, c) => h + measureStep(c) + CHILD_GAP, 0);
    const maxLane = Math.max(
      ...step.branches.map((b) => laneH(b.steps)),
      CHILD_H + CHILD_GAP,
    );
    return PARALLEL_HEADER_H + LANE_LABEL_H + maxLane;
  }
```

새 `measureWidth`(컨테이너 폭 — http/loop/if는 고정, parallel만 가로로 자람):
```ts
// Container width. Only parallel grows horizontally (lanes side-by-side); the
// others keep NODE_WIDTH and grow vertically.
function measureWidth(step: Step): number {
  if (step.type !== "parallel") return NODE_WIDTH;
  return step.branches.length * (LANE_WIDTH + LANE_GAP) - LANE_GAP + LOOP_PAD * 2;
}
```

최상위 노드 루프(`CanvasView` 안)에서 x 전진을 `measureWidth` 기반으로:
```ts
    for (const step of steps) {
      emitStep(step, x, 0, measureWidth(step), undefined, out, selectedStepId);
      x += measureWidth(step) + NODE_GAP;
    }
```

`emitStep` 의 Task 5 스텁(`if (step.type === "parallel") return;`)을 실제 레인 emit으로 **교체**(`const inner = ...` 다음 위치):
```ts
  if (step.type === "parallel") {
    const lanes: Array<{ name: string; x: number }> = [];
    out.push({
      id: step.id,
      type: "parallel",
      data: { name: step.name, lanes, selected: step.id === selectedStepId },
      style: { width: measureWidth(step), height: measureStep(step) },
      ...base,
    });
    let lx = LOOP_PAD;
    for (const b of step.branches) {
      lanes.push({ name: b.name, x: lx });
      let ly = PARALLEL_HEADER_H + LANE_LABEL_H;
      for (const child of b.steps) {
        emitStep(child, lx, ly, LANE_WIDTH, step.id, out, selectedStepId);
        ly += measureStep(child) + CHILD_GAP;
      }
      lx += LANE_WIDTH + LANE_GAP;
    }
    return;
  }
```
(`lanes` 배열은 push로 채운 뒤 `data` 가 같은 참조를 들고 있게 — 위에서 `data: { lanes }` 에 먼저 빈 배열을 넣고 이후 push. JS 객체 참조라 동작.)

툴바 "+ Add parallel" 버튼(기존 "+ Add if" 버튼 다음):
```tsx
          <button
            type="button"
            onClick={() => {
              const id = addParallelStep(`Parallel ${steps.length + 1}`);
              select(id);
            }}
            className="whitespace-nowrap px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
          >
            + Add parallel
          </button>
```
`const addParallelStep = useScenarioEditor((s) => s.addParallelStep);` 를 다른 add* selector 옆에 추가.

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm test CanvasView && pnpm lint && pnpm test && pnpm build && cd ..
git add ui/src/components/scenario/ParallelStepNode.tsx ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/__tests__/CanvasView.test.tsx
git commit -m "feat(ui): 캔버스 parallel 세로 레인 노드 + 가로 에미터 + '+ Add parallel'

ParallelStepNode(헤더+레인 라벨, 자식은 parentId로 부유) + measureWidth(parallel만
가로 성장) + emitStep 레인 배치(폭=Σ레인, 높이=max레인). ADR-0033 P-b.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 8: Inspector 분기 편집기

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx` (Task 5의 `ParallelInspector` **스텁 + dispatch를 실제 편집기로 교체** — dispatch/`isParallelStep` import는 Task 5가 이미 배선)
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx` (기존 파일에 추가)

> Task 5가 `Inspector.tsx:59` 앞에 `if (isParallelStep(step)) return <ParallelInspector step={step} topLevel={topLevel} />;` dispatch와 최소 `ParallelInspector` 스텁을 이미 깔았다(tsc 캐스케이드). **이 Task는 그 스텁 본문만 실제 편집기로 채운다** — dispatch/import는 건드릴 필요 없음.
> `Inspector.tsx` 를 읽어 loop(repeat 편집 + "+ Add step in loop")·if(분기 패널 + "+ Add step"/"+ Add elif") 의 편집 UI 패턴을 파악. parallel 편집기: 분기 목록(각 분기 `name` 입력 + "+ Add step in branch" + "✕ remove branch"(분기 ≥2 일 때만)) + "+ Add branch". 분기 `name` 입력은 **onBlur 커밋 draft**(`ExtractEditor`/`commitRepeat` 패턴, `ui/CLAUDE.md` F5) + 노드 내 중복명 **soft 경고**(Zod가 hard로 막지만 inspector도 즉시 시각 피드백 — `matches` 정규식 경고 패턴).

- [ ] **Step 1: 테스트 작성** (`Inspector.test.tsx`)

```ts
// seed store with a parallel step selected; assert:
//  - branch name inputs render with current names
//  - "+ Add branch" adds a branch (store.model.branches grows)
//  - editing a branch name (type + blur) commits via setBranchName
//  - duplicate name shows a warning (getByText(/duplicate|중복/))
//  - "+ Add step" in a branch adds an http leaf to that branch
//  - "remove branch" hidden when only ... (branches >= 2 to allow removal; with 2, removal allowed down to 1)
// (mirror the existing if-branch inspector test's store-seed + interactions.)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test Inspector`
Expected: FAIL — parallel 편집 UI 없음.

- [ ] **Step 3: 구현** (`Inspector.tsx`)

Task 5의 `ParallelInspector` 스텁 본문을 실제 편집기로 교체. 기존 if 분기 패널 컴포넌트(`BranchPanel` 류)를 미러한 `ParallelBranchEditor`(분기 `name` draft+onBlur + "+ Add step in branch"(store `addStepInParallelBranch`) + "✕"(store `removeBranch`, `branches.length > 1` 일 때만)) + 상단 "+ Add branch"(store `addBranch` — 유니크 기본명 생성). 중복명 경고: `step.branches` 에서 같은 name이 2회 이상이면 그 입력 옆에 `<span role="alert">중복된 분기 이름</span>`.

- [ ] **Step 4: 게이트 + 커밋**

```bash
cd ui && pnpm test Inspector && pnpm lint && pnpm test && pnpm build && cd ..
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): Inspector parallel 분기 편집(이름 draft+onBlur, CRUD, 중복명 경고)

ADR-0033 P-b.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 9: 전체 게이트 + 라이브 run 검증 + 머지

**Files:** (없음 — 검증·머지)

- [ ] **Step 1: 전체 게이트**

```bash
cargo build -p handicap-worker && cargo build --workspace
cargo test --workspace
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
```
Expected: 전부 PASS(인자 없는 전체 `pnpm test` 포함 — targeted green ≠ full green, `ui/CLAUDE.md`).

- [ ] **Step 2: 라이브 run 1회** (S-D 교훈 — run 생성/응답파싱은 RTL이 못 잡음)

`dev-doctor` 스킬로 스택 점검 후: controller(`./target/debug/controller --db /tmp/par.db --ui-dir ui/dist`, 먼저 `cargo build -p handicap-worker && just ui-build`) + python `ThreadingHTTPServer` echo 타깃 기동. UI(또는 curl)로 parallel 노드 든 시나리오를 만들고 run 1회 → 리포트까지 도달 확인. echo 서버 로그에서 **두 분기 요청이 거의 동시**(timestamp 근접)에 도착하는지 + 다운스트림이 `{{branch.var}}` 를 받았는지 grep. test-run 패널도 1회(분기 http 행 + 네임스페이스 resolve).

- [ ] **Step 3: 정리** (Playwright/스크린샷 썼으면)

`rm -rf .playwright-mcp` + 루트 png 정리(머지 전 untracked 잔류 방지, 루트 CLAUDE.md).

- [ ] **Step 4: ADR + 로드맵 + CLAUDE.md**

- `docs/adr/0033-parallel-node.md` 작성(MADR: wait-all + 분기 네임스페이스 merge-back key-origin + top-level-only v1 + join_all 협력 동시성 + 메트릭 per-step 재사용 + 엔진/UI/insights 1 arm). 루트 `CLAUDE.md` "알아둘 결정들" 에 0033 한 줄.
- 루트 `CLAUDE.md` 상태 줄 + `docs/roadmap.md` §A2 "완료" 표기, 후속(그룹 레이턴시·중첩·per-branch breakdown) §B 누적.
- 함정 노트: `crates/engine/CLAUDE.md`(parallel arm join_all·key-origin merge·trace lockstep), `ui/CLAUDE.md`(세로 레인 에미터·분기명 유니크 superRefine union 레벨·measureWidth).
- 커밋(docs-only, fast-path): `git add docs/ crates/*/CLAUDE.md CLAUDE.md ui/CLAUDE.md && git commit -m "docs(parallel): ADR-0033 + 로드맵/CLAUDE.md 갱신"`.

- [ ] **Step 5: 머지** (루트 CLAUDE.md git 토폴로지)

워크트리에서 작업했다면: 메인 클린/ff 가능 확인 후 `git -C /Users/sgj/develop/handicap merge --ff-only <branch>` → 확인 → `ExitWorktree(remove, discard_changes:true)`. master가 전진했으면 rebase 후 ff.

---

## Self-Review 체크리스트 (구현 전 한 번)

- **Spec 커버리지**: §2 모델(T1) · §3 엔진 arm(T2) · §3.7 trace(T3) · §1 insights 경계(T4) · §5 UI Zod/canvas/inspector/sync(T5–8) · §6 메트릭(무파이프라인 — 새 코드 0, 기존 per-step 재사용이라 별도 task 없음, T9 라이브에서 확인) · §8 테스트 · §11 ADR(T9). **그룹 레이턴시·중첩·per-branch breakdown 은 비목표(§10) — task 없음 의도적.**
- **타입 일관성**: `Branch`/`ParallelStep`(엔진) ↔ `BranchModel`/`ParallelStepModel`(UI) 필드 1:1(`name`/`steps`/`branches`/`id`/`type:"parallel"`). `output_var_names`(엔진) = key-origin merge 소스. Edit 5종 이름이 store action·테스트와 일치.
- **함정 반영(plan-review 후)**: insights exhaustive match(T4 = 컨트롤러 빌드 게이트) · `lib.rs` 재export(T1) · **tsc-b 4-way 캐스케이드 4사이트(proptests + CanvasView measureStep/emitStep + Inspector dispatch)를 T5 한 커밋 컴파일 스텁으로, T7/T8이 교체** · node data `interface extends Record<string,unknown>`(T7) · trailing-else→else-if(T5 flattenHttpSteps) · 테스트 경로 전부 `__tests__/`(T5–8) · `addBranch` 유니크 기본명(T6/T8) · trace 와이어 무변경(T3 = 새 StepTrace 필드 없음) · 라이브 run 필수(T9).
