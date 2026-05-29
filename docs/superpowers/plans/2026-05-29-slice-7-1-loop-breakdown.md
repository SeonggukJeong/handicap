# Slice 7-1 — Loop 요청수 breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리포트에서 루프 본문 스텝의 `loop_index`별 요청수/에러수를 접이식 drill-down으로 보여준다. 집계 상한(cap)은 Run 다이얼로그에서 per-run 지정(0=끄기, 기본 256, 상한 10000).

**Architecture:** 엔진 `Aggregator`가 기존 step_id 윈도와 별개로 `(step_id, loop_index)→{count,errors}`를 counts-only로 누적(cap 초과는 `u32::MAX` overflow 버킷). flush마다 delta를 `MetricFlush.loop_stats`로 워커에 보내고, 워커가 gRPC `MetricBatch.loop_stats`로 컨트롤러에 전달, 컨트롤러가 `run_loop_metrics`에 UPSERT 누적. 리포트가 step별로 묶어 `ReportStep.loop_breakdown`으로 노출, UI가 caret drill-down으로 렌더. cap은 run profile에 실려 엔진까지 전달.

**Tech Stack:** Rust (tokio mpsc, sqlx/SQLite, tonic/prost), TypeScript/React (Zod, RTL/vitest). 설계: `docs/superpowers/specs/2026-05-29-slice-7-1-loop-breakdown-design.md`.

**Spec:** `docs/superpowers/specs/2026-05-29-slice-7-1-loop-breakdown-design.md`

**전제:** `slice-7-loop` 브랜치 위에서, 머지 전 구현. Slice 7(loop 노드 + `${loop_index}`)이 이미 있음.

---

## File Structure

- `crates/engine/src/aggregator.rs` — `LoopStat`/`LoopCount` + `loop_counts` 맵 + `Aggregator::new(cap)` + `record(..., loop_index)` + `drain_loop_deltas()`. **가장 많이 바뀜.**
- `crates/engine/src/runner.rs` — `MetricFlush` 채널 페이로드, `RunPlan.loop_breakdown_cap`, record 호출부에 loop_index, flusher가 loop delta 동봉.
- `crates/engine/src/lib.rs` — `MetricFlush`, `LoopStat` re-export.
- `crates/engine/tests/*.rs`, `crates/worker/tests/abort_and_env.rs` — `run_scenario` 채널 타입(`MetricFlush`) 반영.
- `crates/proto/proto/coordinator.proto` — `Profile.loop_breakdown_cap`, `LoopStat`, `MetricBatch.loop_stats`.
- `crates/worker/src/main.rs` — profile cap→RunPlan, `MetricFlush.loop_stats`→pb `LoopStat`.
- `crates/controller/src/store/runs.rs`, `crates/controller/src/api/runs.rs` — `Profile.loop_breakdown_cap`(serde default) + 검증 + proto 빌드.
- `crates/controller/src/store/migrations/0003_run_loop_metrics.sql` — **신규** 테이블.
- `crates/controller/src/store/metrics.rs` — `insert_loop_batch` UPSERT + `loop_breakdown(run_id)` 조회.
- `crates/controller/src/grpc/coordinator.rs` — `MetricBatch.loop_stats` 수신 처리.
- `crates/controller/src/report.rs` — `ReportStep.loop_breakdown` + `build_report` 조립.
- `ui/src/components/RunDialog.tsx`, `ui/src/api/schemas.ts` — cap 입력 + payload + `ProfileSchema`; `ReportStep.loop_breakdown`.
- `ui/src/components/report/StepStatsTable.tsx` — caret drill-down.
- `scripts/bench-throughput.sh` — breakdown ON/OFF 벤치.
- `docs/adr/*`, `CLAUDE.md` — 결정/결과.

---

## Task 1: 엔진 Aggregator — loop_index 집계 (cap / overflow / 0=off)

**Files:**
- Modify: `crates/engine/src/aggregator.rs`

- [ ] **Step 1: 실패하는 단위 테스트 작성** (`aggregator.rs` 의 `mod tests`)

```rust
    #[test]
    fn loop_counts_by_index_within_cap() {
        let mut a = Aggregator::new(256);
        a.record("s", 1_000, 200, false, Some(0));
        a.record("s", 1_000, 200, false, Some(0));
        a.record("s", 1_000, 500, true, Some(1));
        let deltas = a.drain_loop_deltas();
        let mut m: std::collections::HashMap<(String, u32), (u64, u64)> = Default::default();
        for d in deltas {
            m.insert((d.step_id, d.loop_index), (d.count, d.error_count));
        }
        assert_eq!(m.get(&("s".to_string(), 0)), Some(&(2, 0)));
        assert_eq!(m.get(&("s".to_string(), 1)), Some(&(1, 1)));
    }

    #[test]
    fn loop_index_at_or_above_cap_folds_into_overflow_sentinel() {
        let mut a = Aggregator::new(4);
        a.record("s", 1_000, 200, false, Some(4)); // == cap -> overflow
        a.record("s", 1_000, 200, false, Some(99)); // > cap  -> overflow
        a.record("s", 1_000, 200, false, Some(3)); // < cap  -> own bucket
        let deltas = a.drain_loop_deltas();
        let by: std::collections::HashMap<u32, u64> =
            deltas.into_iter().map(|d| (d.loop_index, d.count)).collect();
        assert_eq!(by.get(&3), Some(&1));
        assert_eq!(by.get(&u32::MAX), Some(&2), "overflow bucket = u32::MAX");
    }

    #[test]
    fn cap_zero_disables_breakdown() {
        let mut a = Aggregator::new(0);
        a.record("s", 1_000, 200, false, Some(0));
        a.record("s", 1_000, 200, false, Some(5));
        assert!(a.drain_loop_deltas().is_empty(), "cap=0 records no loop stats");
    }

    #[test]
    fn none_loop_index_records_no_breakdown() {
        let mut a = Aggregator::new(256);
        a.record("s", 1_000, 200, false, None);
        assert!(a.drain_loop_deltas().is_empty());
    }

    #[test]
    fn drain_loop_deltas_resets_between_drains() {
        let mut a = Aggregator::new(256);
        a.record("s", 1_000, 200, false, Some(0));
        assert_eq!(a.drain_loop_deltas().len(), 1);
        assert!(a.drain_loop_deltas().is_empty(), "second drain empty (delta reset)");
    }
```

기존 `records_and_serializes` 테스트의 `a.record(...)` 호출 4곳에 `None`(loop_index) 인자를 추가하고, `Aggregator::new()` → `Aggregator::new(256)`로 바꾼다.

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-engine aggregator:: 2>&1 | head -30`
Expected: 컴파일 에러 — `new`는 인자 없음, `record`는 5번째 인자 없음, `drain_loop_deltas`/`LoopStat` 미존재.

- [ ] **Step 3: 구현** (`aggregator.rs`)

`use` 위쪽/적당한 위치에 타입 추가:
```rust
/// Overflow bucket key: any loop_index >= cap is folded here.
pub const LOOP_OVERFLOW: u32 = u32::MAX;

/// A per-(step_id, loop_index) request/error delta since the last drain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopStat {
    pub step_id: String,
    pub loop_index: u32, // LOOP_OVERFLOW = aggregated ">= cap" bucket
    pub count: u64,
    pub error_count: u64,
}

#[derive(Debug, Default, Clone, Copy)]
struct LoopCount {
    count: u64,
    error_count: u64,
}
```

`Aggregator` 구조체와 생성자/record/drain 수정:
```rust
#[derive(Debug, Default)]
pub struct Aggregator {
    windows: HashMap<(String, i64), StepWindow>,
    loop_counts: HashMap<(String, u32), LoopCount>,
    loop_cap: u32,
}

impl Aggregator {
    pub fn new(loop_breakdown_cap: u32) -> Self {
        Self {
            windows: HashMap::new(),
            loop_counts: HashMap::new(),
            loop_cap: loop_breakdown_cap,
        }
    }

    pub fn record(
        &mut self,
        step_id: &str,
        latency_us: u64,
        status: u16,
        is_error: bool,
        loop_index: Option<u32>,
    ) {
        let ts = current_second();
        let w = self
            .windows
            .entry((step_id.to_string(), ts))
            .or_insert_with(|| StepWindow::new(step_id.to_string(), ts));
        w.record(latency_us, status, is_error);

        if self.loop_cap > 0 {
            if let Some(i) = loop_index {
                let bucket = if i < self.loop_cap { i } else { LOOP_OVERFLOW };
                let c = self
                    .loop_counts
                    .entry((step_id.to_string(), bucket))
                    .or_default();
                c.count += 1;
                if is_error {
                    c.error_count += 1;
                }
            }
        }
    }

    /// Take and reset the accumulated per-(step_id, loop_index) deltas.
    pub fn drain_loop_deltas(&mut self) -> Vec<LoopStat> {
        std::mem::take(&mut self.loop_counts)
            .into_iter()
            .map(|((step_id, loop_index), c)| LoopStat {
                step_id,
                loop_index,
                count: c.count,
                error_count: c.error_count,
            })
            .collect()
    }
}
```
(`Default` derive가 `loop_cap: 0`을 주는데, 이는 "끄기"라 안전하다. 단 `Aggregator::default()`를 쓰는 코드가 있으면 `new(256)`로 바꾼다 — Step 1에서 처리.)

- [ ] **Step 4: green + clippy**

Run: `cargo test -p handicap-engine aggregator:: 2>&1 | tail -15`
Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings 2>&1 | tail -3`
Expected: 모두 통과/clean.

- [ ] **Step 5: 커밋**

```bash
git add crates/engine/src/aggregator.rs
git commit -m "feat(engine): aggregator per-loop_index counts (cap, overflow sentinel, 0=off)"
```

---

## Task 2: 엔진 — MetricFlush 채널 + RunPlan.loop_breakdown_cap + runner 배선

**Files:**
- Modify: `crates/engine/src/runner.rs`
- Modify: `crates/engine/src/lib.rs`
- Modify: `crates/engine/tests/loop_node.rs`, `multi_step.rs`, `runner_e2e.rs`, `ramp_up.rs`, `all_vus_failed.rs`
- Modify: `crates/worker/tests/abort_and_env.rs`
- Modify: `crates/worker/src/main.rs` (채널 타입만; loop_stats 매핑은 Task 4)

이 task는 "채널 페이로드 타입을 바꾸고 모든 호출부를 고쳐 green" 단위다.

- [ ] **Step 1: 실패 테스트 — loop_node.rs에 breakdown 단언 추가**

`crates/engine/tests/loop_node.rs` 의 `loop_index_renders_in_request` 테스트를 확장(또는 새 테스트 추가). 채널이 `MetricFlush`를 흘리므로 수신부를 `batch.windows` / `batch.loop_stats`로 바꾼다. 새 단언:
```rust
// (loop_index_renders_in_request 내부, rx 수신 루프 교체)
    let mut errors: u64 = 0;
    let mut total: u64 = 0;
    let mut by_index: std::collections::HashMap<u32, u64> = Default::default();
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
        for ls in flush.loop_stats {
            *by_index.entry(ls.loop_index).or_default() += ls.count;
        }
    }
    run.await.expect("join");
    assert!(total > 0);
    assert_eq!(errors, 0, "every /item/<loop_index> must match a stub");
    // repeat=3 -> loop_index 0,1,2 each hit; breakdown must reflect distinct indices.
    assert!(by_index.get(&0).copied().unwrap_or(0) > 0, "index 0 recorded");
    assert!(by_index.get(&1).copied().unwrap_or(0) > 0, "index 1 recorded");
    assert!(by_index.get(&2).copied().unwrap_or(0) > 0, "index 2 recorded");
```
그리고 이 테스트의 `RunPlan { .. }`에 `loop_breakdown_cap: 256` 필드를 추가.

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-engine --test loop_node 2>&1 | head -30`
Expected: 컴파일 에러 — `MetricFlush`/`loop_stats`/`RunPlan.loop_breakdown_cap` 미존재.

- [ ] **Step 3: runner.rs — MetricFlush + RunPlan 필드 + flusher 배선**

`RunPlan`에 필드 추가:
```rust
pub struct RunPlan {
    pub vus: u32,
    pub ramp_up: Duration,
    pub duration: Duration,
    pub env: BTreeMap<String, String>,
    pub loop_breakdown_cap: u32,
}
```

채널 페이로드 타입 신설(파일 상단, 적당한 위치):
```rust
use crate::aggregator::{Aggregator, LoopStat, StepWindow};

/// One flush from the engine to the worker: a batch of completed 1s windows
/// plus the per-(step_id, loop_index) count deltas accumulated since the last flush.
#[derive(Debug)]
pub struct MetricFlush {
    pub windows: Vec<StepWindow>,
    pub loop_stats: Vec<LoopStat>,
}
```

`run_scenario` 시그니처의 채널 타입 변경:
```rust
pub async fn run_scenario(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<MetricFlush>,
    cancel: CancellationToken,
) -> Result<(), EngineError> {
```
- `Aggregator::new()` 호출을 `Aggregator::new(plan.loop_breakdown_cap)`로.
- flusher(주기적으로 `drain_completed`를 보내는 코드)가 보내는 값을 `MetricFlush { windows, loop_stats: agg.lock().await.drain_loop_deltas() }`로 감싼다. drain 시점에 windows와 loop delta를 함께 take. 최종 `drain_all`도 동일하게 `MetricFlush`로 전송(마지막 loop delta 포함).
- 만약 flusher가 `windows.is_empty()`면 skip하던 로직이 있으면, **loop_stats가 비어있지 않을 때도 전송**되도록 조건을 `windows.is_empty() && loop_stats.is_empty()`로 바꾼다(끝물 loop delta 유실 방지).

> NOTE: record 호출부는 이미 Slice 7에서 `execute_steps`의 Http leaf가 `loop_index`를 안다(`TemplateContext`/`Some(i)`). 그 호출 `a.record(&outcome.step_id, latency, status, is_err)`에 5번째 인자로 그 `loop_index`를 넘긴다(top-level은 `None`).

- [ ] **Step 4: lib.rs re-export**
```rust
pub use aggregator::{LoopStat, StepWindow};
pub use runner::{MetricFlush, RunPlan, run_scenario};
```
(기존 re-export 목록에 `MetricFlush`, `LoopStat` 추가. `StepWindow`가 이미 export면 중복 주의.)

- [ ] **Step 5: 모든 run_scenario 호출부 수정**

각 파일에서 `for w in batch` → `for w in flush.windows`(변수명 `batch`를 `flush`로) 그리고 `RunPlan { .. }` 리터럴에 `loop_breakdown_cap: 0`(테스트 기본; loop 테스트만 256) 추가. drain-only(`while rx.recv().await.is_some()`)는 변경 불필요.
- `crates/engine/tests/multi_step.rs`: 3곳의 `for w in batch` → `for w in flush.windows`(수신 변수명 교체), 모든 `RunPlan`에 `loop_breakdown_cap: 0`.
- `crates/engine/tests/runner_e2e.rs`, `ramp_up.rs`, `all_vus_failed.rs`: `RunPlan`에 `loop_breakdown_cap: 0`; `batch` 수신 시 윈도 접근은 `.windows`로.
- `crates/worker/tests/abort_and_env.rs`: `RunPlan`에 `loop_breakdown_cap: 0`; 채널 수신부 `.windows`.
- `crates/worker/src/main.rs`: `win_rx`가 이제 `MetricFlush`를 받는다 — `while let Some(flush) = win_rx.recv()`로, `batch.into_iter()` → `flush.windows.into_iter()`로. (loop_stats 매핑은 Task 4에서; 이 task에선 `flush.windows`만 사용하고 `flush.loop_stats`는 일단 무시해 컴파일만 통과시킨다 — 단 `let _ = flush.loop_stats;`로 미사용 경고 회피.) `let plan = RunPlan { .. }`에 `loop_breakdown_cap: 0`(Task 4에서 profile값으로 교체).

- [ ] **Step 6: green + clippy**

Run: `cargo test -p handicap-engine 2>&1 | tail -20`
Run: `cargo test -p handicap-worker 2>&1 | tail -10`
Run: `cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3`
Expected: 전부 통과/clean. loop_node.rs 의 by_index 단언 포함.

- [ ] **Step 7: 커밋**

```bash
git add crates/engine/src/runner.rs crates/engine/src/lib.rs crates/engine/tests/ crates/worker/src/main.rs crates/worker/tests/abort_and_env.rs
git commit -m "feat(engine): MetricFlush carries loop_stats; RunPlan.loop_breakdown_cap threaded to aggregator"
```

---

## Task 3: proto — Profile.loop_breakdown_cap + LoopStat + MetricBatch.loop_stats

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`

- [ ] **Step 1: .proto 편집**

`Profile`에 필드 추가:
```proto
message Profile {
  uint32 vus = 1;
  uint32 ramp_up_seconds = 2;
  uint32 duration_seconds = 3;
  uint32 loop_breakdown_cap = 4;   // 0 = disabled
}
```
신규 메시지 + `MetricBatch`에 필드 추가:
```proto
message LoopStat {
  string step_id = 1;
  uint32 loop_index = 2;   // 4294967295 (u32::MAX) = overflow bucket (>= cap)
  uint64 count = 3;
  uint64 error_count = 4;
}

message MetricBatch {
  string worker_id = 1;
  string run_id = 2;
  repeated MetricWindow windows = 3;
  repeated LoopStat loop_stats = 4;
}
```

- [ ] **Step 2: 빌드로 생성 확인**

Run: `cargo build -p handicap-proto 2>&1 | tail -5`
Expected: 성공(prost 코드 생성). 후속 task에서 `pb::LoopStat`, `Profile.loop_breakdown_cap`, `MetricBatch.loop_stats` 사용 가능.

- [ ] **Step 3: 커밋**

```bash
git add crates/proto/proto/coordinator.proto
git commit -m "feat(proto): Profile.loop_breakdown_cap + LoopStat + MetricBatch.loop_stats"
```

---

## Task 4: 워커 — profile cap → RunPlan; MetricFlush.loop_stats → pb LoopStat

**Files:**
- Modify: `crates/worker/src/main.rs`

- [ ] **Step 1: 배선 (테스트는 e2e/통합으로 Task 10에서)**

`use pb::{..}`에 `LoopStat`을 추가(예: `use pb::{LoopStat, MetricBatch, MetricWindow, RunStatus, WorkerMessage};`).

RunPlan 빌드에 cap 전달:
```rust
    let plan = RunPlan {
        vus: profile.vus,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(profile.duration_seconds.into()),
        env,
        loop_breakdown_cap: profile.loop_breakdown_cap,
    };
```

forwarder에서 loop_stats 매핑(`flush.windows` 처리 직후, MetricBatch 빌드 전):
```rust
            let loop_stats: Vec<LoopStat> = flush
                .loop_stats
                .into_iter()
                .map(|ls| LoopStat {
                    step_id: ls.step_id,
                    loop_index: ls.loop_index,
                    count: ls.count,
                    error_count: ls.error_count,
                })
                .collect();
            if windows.is_empty() && loop_stats.is_empty() {
                continue;
            }
            let msg = WorkerMessage {
                payload: Some(WorkerPayload::MetricBatch(MetricBatch {
                    run_id: run_id.clone(),
                    worker_id: worker_id.clone(),
                    windows,
                    loop_stats,
                })),
            };
```
(Task 2에서 넣은 `let _ = flush.loop_stats;` 임시 라인은 제거.)

- [ ] **Step 2: 빌드/clippy**

Run: `cargo build -p handicap-worker 2>&1 | tail -5`
Run: `cargo clippy -p handicap-worker --all-targets -- -D warnings 2>&1 | tail -3`
Expected: 성공/clean.

- [ ] **Step 3: 커밋**

```bash
git add crates/worker/src/main.rs
git commit -m "feat(worker): forward loop_stats in MetricBatch; pass loop_breakdown_cap to engine"
```

---

## Task 5: 컨트롤러 profile — loop_breakdown_cap (serde default) + 검증 + proto 빌드

**Files:**
- Modify: `crates/controller/src/store/runs.rs`
- Modify: `crates/controller/src/api/runs.rs`
- Test: `crates/controller/src/api/runs.rs` 내 인라인 테스트(없으면 추가) 또는 `crates/controller/tests/`

- [ ] **Step 1: 실패 테스트 — cap 검증**

`api/runs.rs` 인라인 `#[cfg(test)] mod tests`(없으면 신설)에 검증 함수 단위 테스트:
```rust
    #[test]
    fn validates_loop_breakdown_cap_bounds() {
        assert!(super::loop_cap_ok(0));      // off 허용
        assert!(super::loop_cap_ok(256));
        assert!(super::loop_cap_ok(10_000));
        assert!(!super::loop_cap_ok(10_001)); // 상한 초과 거부
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller loop_cap 2>&1 | head -20`
Expected: 컴파일 에러 — `loop_cap_ok` 미존재.

- [ ] **Step 3: 구현**

`store/runs.rs` 의 `Profile`에 필드 추가(profile_json 저장이라 마이그레이션 불필요):
```rust
fn default_loop_cap() -> u32 { 256 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub vus: u32,
    pub ramp_up_seconds: u32,
    pub duration_seconds: u32,
    #[serde(default = "default_loop_cap")]
    pub loop_breakdown_cap: u32,
}
```
(구 run row의 profile_json엔 이 키가 없지만 `#[serde(default)]`로 256이 채워진다.)

`api/runs.rs`: 요청 payload `Profile`에도 동일 필드 + 기본값(같은 `default_loop_cap` 재사용 또는 별도). 검증 헬퍼 + create 핸들러에서 호출:
```rust
pub(crate) fn loop_cap_ok(cap: u32) -> bool {
    cap <= 10_000
}
```
create 핸들러의 기존 검증 블록(`if body.profile.vus == 0 || ...`) 근처에 추가:
```rust
    if !loop_cap_ok(body.profile.loop_breakdown_cap) {
        return Err(ApiError::bad_request(
            "loop_breakdown_cap must be <= 10000 (0 disables breakdown)".into(),
        ));
    }
```
(실제 `ApiError` 생성 방식은 기존 `vus` 검증 코드와 동일 패턴을 따른다.)

proto Profile 빌드(api/runs.rs:65 부근)에 필드 추가:
```rust
        profile: handicap_proto::v1::Profile {
            vus: body.profile.vus,
            ramp_up_seconds: body.profile.ramp_up_seconds,
            duration_seconds: body.profile.duration_seconds,
            loop_breakdown_cap: body.profile.loop_breakdown_cap,
        },
```
`store::runs::insert_run`에 넘기는 `Profile`에도 cap이 포함(이미 같은 struct면 자동).

- [ ] **Step 4: green + 빌드**

Run: `cargo test -p handicap-controller loop_cap 2>&1 | tail -10`
Run: `cargo build -p handicap-controller 2>&1 | tail -5`
Expected: 통과/성공.

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/store/runs.rs crates/controller/src/api/runs.rs
git commit -m "feat(controller): loop_breakdown_cap in run profile (serde default 256, <=10000)"
```

---

## Task 6: 컨트롤러 — migration 0003 + run_loop_metrics UPSERT + coordinator 수신

**Files:**
- Create: `crates/controller/src/store/migrations/0003_run_loop_metrics.sql`
- Modify: `crates/controller/src/store/metrics.rs`
- Modify: `crates/controller/src/grpc/coordinator.rs`
- Test: `crates/controller/src/store/metrics.rs` 인라인 테스트(기존 패턴 따라)

- [ ] **Step 1: 마이그레이션 파일**

`0003_run_loop_metrics.sql`:
```sql
CREATE TABLE IF NOT EXISTS run_loop_metrics (
  run_id      TEXT    NOT NULL,
  step_id     TEXT    NOT NULL,
  loop_index  INTEGER NOT NULL,   -- 4294967295 = overflow bucket (>= cap)
  count       INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id, loop_index)
);
```
(마이그레이션 로더가 디렉토리의 `*.sql`을 순서대로 실행하는지 확인 — 0001/0002와 같은 메커니즘. 새 파일만 추가하면 됨. `IF NOT EXISTS`라 재기동 재실행 안전.)

- [ ] **Step 2: 실패 테스트 — UPSERT 누적**

`metrics.rs` 인라인 테스트(기존 메모리 DB 헬퍼 사용; `insert_batch` 테스트가 있으면 그 패턴):
```rust
    #[tokio::test]
    async fn loop_metrics_upsert_accumulates() {
        let db = crate::store::test_db().await; // 기존 테스트 헬퍼 이름에 맞춤
        let rows = vec![
            LoopMetricRow { run_id: "r".into(), step_id: "s".into(), loop_index: 0, count: 3, error_count: 1 },
            LoopMetricRow { run_id: "r".into(), step_id: "s".into(), loop_index: 0, count: 2, error_count: 0 },
            LoopMetricRow { run_id: "r".into(), step_id: "s".into(), loop_index: 4294967295, count: 7, error_count: 0 },
        ];
        insert_loop_batch(&db, &rows).await.unwrap();
        let got = loop_breakdown(&db, "r").await.unwrap();
        let m: std::collections::HashMap<(String,i64),(i64,i64)> =
            got.into_iter().map(|r| ((r.step_id, r.loop_index), (r.count, r.error_count))).collect();
        assert_eq!(m.get(&("s".into(), 0)), Some(&(5, 1)));            // 3+2 / 1+0
        assert_eq!(m.get(&("s".into(), 4294967295)), Some(&(7, 0)));
    }
```
(실제 테스트 DB 헬퍼 이름은 metrics.rs 기존 테스트에서 확인해 맞춘다.)

- [ ] **Step 3: 실패 확인**

Run: `cargo test -p handicap-controller loop_metrics_upsert 2>&1 | head -20`
Expected: 컴파일 에러 — `LoopMetricRow`/`insert_loop_batch`/`loop_breakdown` 미존재.

- [ ] **Step 4: 구현** (`metrics.rs`)
```rust
#[derive(Debug, Clone)]
pub struct LoopMetricRow {
    pub run_id: String,
    pub step_id: String,
    pub loop_index: i64, // u32 값을 i64로 저장 (SQLite INTEGER). overflow = 4294967295
    pub count: i64,
    pub error_count: i64,
}

pub async fn insert_loop_batch(db: &Db, rows: &[LoopMetricRow]) -> sqlx::Result<()> {
    for r in rows {
        sqlx::query(
            "INSERT INTO run_loop_metrics(run_id,step_id,loop_index,count,error_count) \
             VALUES(?,?,?,?,?) \
             ON CONFLICT(run_id,step_id,loop_index) DO UPDATE SET \
               count = count + excluded.count, \
               error_count = error_count + excluded.error_count",
        )
        .bind(&r.run_id)
        .bind(&r.step_id)
        .bind(r.loop_index)
        .bind(r.count)
        .bind(r.error_count)
        .execute(db)
        .await?;
    }
    Ok(())
}

pub async fn loop_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<LoopMetricRow>> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT step_id, loop_index, count, error_count FROM run_loop_metrics \
         WHERE run_id = ? ORDER BY step_id, loop_index",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| LoopMetricRow {
            run_id: run_id.to_string(),
            step_id: r.get("step_id"),
            loop_index: r.get("loop_index"),
            count: r.get("count"),
            error_count: r.get("error_count"),
        })
        .collect())
}
```

coordinator(`grpc/coordinator.rs`)의 `MetricBatch` 핸들러 끝(insert_batch 호출 뒤)에 추가:
```rust
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
                            if let Err(e) =
                                crate::store::metrics::insert_loop_batch(&state.db, &loop_rows).await
                            {
                                warn!(run_id = %batch.run_id, error = %e, "failed to insert loop metrics");
                            }
                        }
```

- [ ] **Step 5: green + clippy**

Run: `cargo test -p handicap-controller loop_metrics_upsert 2>&1 | tail -10`
Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings 2>&1 | tail -3`
Expected: 통과/clean.

- [ ] **Step 6: 커밋**

```bash
git add crates/controller/src/store/migrations/0003_run_loop_metrics.sql crates/controller/src/store/metrics.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): run_loop_metrics table + UPSERT ingest of MetricBatch.loop_stats"
```

---

## Task 7: 컨트롤러 리포트 — ReportStep.loop_breakdown

**Files:**
- Modify: `crates/controller/src/report.rs`
- Modify: 리포트 핸들러(report 조립 호출부 — `build_report` 호출 지점에서 `loop_breakdown` rows 전달)
- Test: `report.rs` 인라인 테스트

- [ ] **Step 1: 실패 테스트** (`report.rs` `mod tests`)
```rust
    #[test]
    fn build_report_attaches_loop_breakdown() {
        let run = sample_run(); // 기존 테스트 헬퍼/픽스처에 맞춤
        let windows = vec![/* step "s" 의 WindowWithHdr 1개, count 6 */];
        let loops = vec![
            LoopMetricRow { run_id: "r".into(), step_id: "s".into(), loop_index: 0, count: 3, error_count: 0 },
            LoopMetricRow { run_id: "r".into(), step_id: "s".into(), loop_index: 1, count: 2, error_count: 0 },
            LoopMetricRow { run_id: "r".into(), step_id: "s".into(), loop_index: 4294967295, count: 1, error_count: 0 },
        ];
        let rep = build_report(&run, "version: 1\nname: x\nsteps: []\n", &windows, &loops);
        let step = rep.steps.iter().find(|s| s.step_id == "s").unwrap();
        assert_eq!(step.loop_breakdown.len(), 3);
        assert_eq!(step.loop_breakdown[0].loop_index, Some(0));
        assert_eq!(step.loop_breakdown[2].loop_index, None, "overflow -> null");
        // 직렬화 round-trip (Slice 5 함정: Deserialize 강제)
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }
```
(기존 `build_report` 시그니처/픽스처에 맞춰 인자 구성. windows 픽스처는 기존 `build_report_*` 테스트에서 복사.)

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller build_report_attaches_loop 2>&1 | head -20`
Expected: 컴파일 에러 — `build_report`가 4번째 인자/`loop_breakdown` 미보유.

- [ ] **Step 3: 구현**

`LoopBucket` 타입 + `ReportStep` 확장:
```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct LoopBucket {
    pub loop_index: Option<u32>, // None = overflow (>= cap)
    pub count: u64,
    pub error_count: u64,
}

// ReportStep 에 필드 추가:
//   pub loop_breakdown: Vec<LoopBucket>,
```
`build_report` 시그니처에 `loops: &[crate::store::metrics::LoopMetricRow]` 추가. step별로 묶어 `loop_breakdown` 구성(정렬: loop_index 오름차순, overflow(=`u32::MAX`)는 None으로 맨 끝):
```rust
    use std::collections::BTreeMap;
    let mut by_step: BTreeMap<String, Vec<LoopBucket>> = BTreeMap::new();
    for r in loops {
        let idx = r.loop_index as u32;
        by_step.entry(r.step_id.clone()).or_default().push(LoopBucket {
            loop_index: if idx == u32::MAX { None } else { Some(idx) },
            count: r.count as u64,
            error_count: r.error_count as u64,
        });
    }
    // loops 는 SQL에서 step_id, loop_index ORDER BY 로 이미 정렬돼 옴 (overflow=u32::MAX가 맨 끝).
```
각 `ReportStep` 생성 시 `loop_breakdown: by_step.remove(&step_id).unwrap_or_default()`.

리포트 핸들러: `loop_breakdown(&db, run_id)`를 조회해 `build_report(..., &loops)`로 전달.

- [ ] **Step 4: green**

Run: `cargo test -p handicap-controller report 2>&1 | tail -15`
Expected: 통과(기존 report 테스트 + 새 테스트). 기존 `build_report` 호출부(테스트 포함) 모두 4번째 인자 추가.

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/report.rs
git commit -m "feat(controller): ReportStep.loop_breakdown (per loop_index, overflow=null)"
```

---

## Task 8: UI Run 다이얼로그 — cap 입력 (0=off, 기본 256, 상한 10000)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Modify: `ui/src/api/schemas.ts` (`ProfileSchema`)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

- [ ] **Step 1: 실패 테스트** (`RunDialog.test.tsx` 에 append)
```tsx
  it("posts loop_breakdown_cap (default 256) on Run", async () => {
    const user = userEvent.setup();
    // ... 기존 RunDialog 렌더 셋업 재사용 ...
    await user.click(screen.getByRole("button", { name: /^run$/i }));
    expect(captured.profile.loop_breakdown_cap).toBe(256);
  });

  it("lets the user set loop_breakdown_cap to 0 (off)", async () => {
    const user = userEvent.setup();
    const cap = screen.getByLabelText(/loop breakdown cap/i) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "0");
    await user.click(screen.getByRole("button", { name: /^run$/i }));
    expect(captured.profile.loop_breakdown_cap).toBe(0);
  });
```
(기존 RunDialog 테스트의 mutate/capture 패턴을 그대로 재사용 — `captured` 는 그 테스트가 post payload를 잡는 방식에 맞춤.)

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test -- RunDialog 2>&1 | tail -20`
Expected: FAIL — 입력/필드 없음.

- [ ] **Step 3: 구현**

`RunDialog.tsx`: 상태 + 입력 추가(vus/duration 옆):
```tsx
  const [loopCap, setLoopCap] = useState(256);
  const loopCapInvalid = loopCap < 0 || loopCap > 10000;
```
`canSubmit`에 `&& !loopCapInvalid` 추가. 입력 필드(label `Loop breakdown cap`):
```tsx
  <label className="block text-sm">
    Loop breakdown cap
    <input
      type="number"
      min={0}
      max={10000}
      aria-label="loop breakdown cap"
      value={loopCap}
      onChange={(e) => setLoopCap(Number(e.target.value))}
      className="..."
    />
    <span className="text-xs text-slate-500">0 = 끄기 · 루프 스텝의 loop_index별 집계 상한</span>
  </label>
```
payload profile에 추가:
```tsx
                profile: {
                  vus,
                  duration_seconds: duration,
                  ramp_up_seconds: rampUp,
                  loop_breakdown_cap: loopCap,
                },
```
`schemas.ts` `ProfileSchema`에 `loop_breakdown_cap: z.number().int().min(0).max(10000).default(256)` 추가.

- [ ] **Step 4: green + build**

Run: `cd ui && pnpm test -- RunDialog 2>&1 | tail -15`
Run: `cd ui && pnpm build 2>&1 | tail -8`
Expected: PASS + `tsc -b` clean.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/RunDialog.tsx ui/src/api/schemas.ts ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog loop breakdown cap input (0=off, default 256, max 10000)"
```

---

## Task 9: UI 리포트 — schemas + StepStatsTable drill-down

**Files:**
- Modify: `ui/src/api/schemas.ts` (`ReportStep`)
- Modify: `ui/src/components/report/StepStatsTable.tsx`
- Test: `ui/src/components/report/__tests__/StepStatsTable.test.tsx`

- [ ] **Step 1: 실패 테스트** (`StepStatsTable.test.tsx` 에 append)
```tsx
  it("shows a per-loop drill-down when a step has loop_breakdown", async () => {
    const user = userEvent.setup();
    const steps = [{
      step_id: "s", count: 6, error_count: 0, status_counts: { "200": 6 },
      p50_ms: 1, p95_ms: 2, p99_ms: 3,
      loop_breakdown: [
        { loop_index: 0, count: 3, error_count: 0 },
        { loop_index: 1, count: 2, error_count: 0 },
        { loop_index: null, count: 1, error_count: 0 },
      ],
    }];
    const meta = new Map([["s", { id: "s", name: "tick", method: "GET", url: "/item/${loop_index}" }]]);
    render(<StepStatsTable steps={steps as never} meta={meta} />);
    // 기본 접힘: 내부 표 안 보임
    expect(screen.queryByText(/loop_index/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /tick|expand|loop/i }));
    expect(screen.getByText("3")).toBeInTheDocument(); // index 0 count
    expect(screen.getByText(/그 외|상한 초과|overflow/i)).toBeInTheDocument(); // null bucket label
  });

  it("renders no drill-down caret when loop_breakdown is empty", () => {
    const steps = [{
      step_id: "s", count: 6, error_count: 0, status_counts: {}, p50_ms: 1, p95_ms: 2, p99_ms: 3,
      loop_breakdown: [],
    }];
    render(<StepStatsTable steps={steps as never} meta={new Map()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test -- StepStatsTable 2>&1 | tail -20`
Expected: FAIL — drill-down/caret 없음; `loop_breakdown` 타입 없음.

- [ ] **Step 3: 구현**

`schemas.ts` `ReportStep`(현재 `step_id,count,error_count,status_counts,p50_ms,p95_ms,p99_ms`)에 추가:
```ts
  loop_breakdown: z
    .array(z.object({
      loop_index: z.number().int().nullable(),
      count: z.number(),
      error_count: z.number(),
    }))
    .default([]),
```

`StepStatsTable.tsx`: 각 행을 expandable로. 한 스텝에 `loop_breakdown.length > 0`이면 Step 셀에 토글 버튼(caret), 펼치면 그 스텝 행 아래에 내부 표 행 삽입. `useState`로 펼친 step_id 집합 관리:
```tsx
import { useState } from "react";
// ...
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
```
본문 `steps.map`을 Fragment로 바꿔 메인 행 + (펼침 시) breakdown 행:
```tsx
{steps.map((s) => {
  const m = meta.get(s.step_id);
  const hasBreakdown = s.loop_breakdown.length > 0;
  const isOpen = open.has(s.step_id);
  return (
    <Fragment key={s.step_id}>
      <tr className="border-b border-slate-100">
        <td className="py-2 pr-4 font-medium">
          {hasBreakdown && (
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={`Toggle loop breakdown for ${m?.name ?? s.step_id}`}
              onClick={() => toggle(s.step_id)}
              className="mr-1 text-slate-500"
            >
              {isOpen ? "▾" : "▸"}
            </button>
          )}
          {m?.name ?? s.step_id}
        </td>
        {/* ... 기존 method/url/count/errors/p50/p95/p99 셀 그대로 ... */}
      </tr>
      {hasBreakdown && isOpen && (
        <tr className="bg-slate-50">
          <td colSpan={8} className="px-6 py-2">
            <table className="text-xs">
              <thead className="text-slate-500">
                <tr><th className="pr-4 text-left">loop_index</th><th className="pr-4 text-left">requests</th><th className="pr-4 text-left">errors</th></tr>
              </thead>
              <tbody>
                {s.loop_breakdown.map((b, i) => (
                  <tr key={i}>
                    <td className="pr-4 font-mono">{b.loop_index === null ? "그 외 (상한 초과)" : b.loop_index}</td>
                    <td className="pr-4">{b.count}</td>
                    <td className="pr-4">{b.error_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </Fragment>
  );
})}
```
`import { Fragment, useState } from "react";`.

- [ ] **Step 4: green + build**

Run: `cd ui && pnpm test -- StepStatsTable 2>&1 | tail -15`
Run: `cd ui && pnpm build 2>&1 | tail -8`
Expected: PASS + clean. (`ReportStep` 에 `loop_breakdown` 추가 시 기존 ReportView/StepStatsTable 픽스처가 default([])로 통과하는지 확인 — Zod `.default([])`가 있으니 파싱은 OK, 단 인라인 TS 픽스처는 필드 추가 필요할 수 있음.)

- [ ] **Step 5: 커밋**

```bash
git add ui/src/api/schemas.ts ui/src/components/report/StepStatsTable.tsx ui/src/components/report/__tests__/StepStatsTable.test.tsx
git commit -m "feat(ui): per-loop drill-down in StepStatsTable (collapsed by default, overflow label)"
```

---

## Task 10: e2e — 루프 시나리오(cap) → 리포트 loop_breakdown

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs`

- [ ] **Step 1: 테스트 작성**

`loop_e2e_inner_step_counts`(Slice 7)를 모델로 한 새 e2e `loop_breakdown_e2e`:
- wiremock `GET /item/0`,`/item/1`,`/item/2` stub(200).
- 시나리오: `repeat: 3` 루프, 자식 http url `{{base}}/item/${loop_index}`(내부 스텝 고정 ULID).
- run 생성 payload의 `profile.loop_breakdown_cap = 256`, 1 VU, 2s.
- terminal까지 poll → `GET /api/runs/{id}/report`.
- 단언: report의 내부 스텝 엔트리에 `loop_breakdown`이 존재하고, index 0/1/2 각 count>0, 합 == 스텝 count, error 합 == 0, overflow(null) 버킷 없음(repeat=3 < cap).

`report_e2e_smoke`/`loop_e2e_inner_step_counts`의 harness(worker_bin_path, controller spawn, create/run/poll)를 그대로 차용. JSON 파싱은 `report["steps"][i]["loop_breakdown"]` 접근.

- [ ] **Step 2: 통과 확인 (2~3회 반복으로 flakiness 점검)**

Run: `cargo test -p handicap-controller --test e2e_test loop_breakdown 2>&1 | tail -25`
Expected: PASS. 마지막 루프가 mid-body로 잘릴 수 있어 정확한 균등 분포는 단언하지 말고 "각 index count>0 && 합==스텝 count && error==0"만.

- [ ] **Step 3: 커밋**

```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(e2e): loop scenario -> report loop_breakdown per loop_index"
```

---

## Task 11: 성능 벤치(ON vs OFF) + 검증 게이트

**Files:**
- Modify: `scripts/bench-throughput.sh`

- [ ] **Step 1: 벤치에 cap 주입**

`scripts/bench-throughput.sh`: 기존 run 생성 payload의 profile에 cap을 env로 주입한다. profile 라인 근처(`"profile":{"vus":...}`)를 다음처럼:
```bash
LOOP_CAP="${LOOP_CAP:-0}"   # 0 = breakdown off (default)
# ... profile JSON 에 ,"loop_breakdown_cap":$LOOP_CAP 추가 ...
```
`-d "{\"scenario_id\":\"$SCN\",\"profile\":{\"vus\":$VUS,\"ramp_up_seconds\":2,\"duration_seconds\":$DURATION,\"loop_breakdown_cap\":$LOOP_CAP},\"env\":{}}"`

- [ ] **Step 2: ON vs OFF 비교 (loop 시나리오)**

```bash
SCENARIO_KIND=loop LOOP_CAP=0   just bench-throughput   # breakdown off
SCENARIO_KIND=loop LOOP_CAP=256 just bench-throughput   # breakdown on
```
Expected: rps_avg 차이가 run-to-run 변동(±~5%) 내, p95/p99 동일. (회귀 시 spec §8대로 재검토.) 두 수치를 Task 12 CLAUDE.md용으로 기록.

- [ ] **Step 3: 전체 게이트**

Run: `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace 2>&1 | tail -20`
Run: `cd ui && pnpm test 2>&1 | tail -6 && pnpm build 2>&1 | tail -6`
Expected: 전부 green.

- [ ] **Step 4: 커밋**

```bash
git add scripts/bench-throughput.sh
git commit -m "test(bench): LOOP_CAP env for breakdown on/off A/B"
```

---

## Task 12: 문서 — ADR 보강 + CLAUDE.md

**Files:**
- Modify: `docs/adr/0020-control-flow-loop-node.md` (또는 신규 `0021`)
- Modify: `docs/adr/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: ADR**

ADR-0020에 "loop_index별 요청수 breakdown(counts-only, per-run cap `loop_breakdown_cap`, 0=off, overflow sentinel `u32::MAX`→리포트 null, `run_loop_metrics` UPSERT)" 후속 결정 단락을 추가하거나, 메트릭 cardinality 정책이 독립적이라 판단되면 `docs/adr/0021-loop-metric-breakdown.md`로 분리(이 경우 README 인덱스 + CLAUDE.md 결정 목록에 0021 추가). 구현 중 판단해 하나 선택.

- [ ] **Step 2: CLAUDE.md**
- "Slice 7 결과" 단락 뒤에 "Slice 7-1 결과:" 단락 추가 — loop_index별 count/error breakdown(counts-only), per-run cap(RunDialog, 0=off, 기본256/상한1만), `MetricFlush.loop_stats`→`MetricBatch.loop_stats`→`run_loop_metrics`(migration 0003) UPSERT, `ReportStep.loop_breakdown` + StepStatsTable drill-down. **Task 11 ON vs OFF 처리량 수치** 기재.
- "Slice 7에서 배운 함정들" 뒤(또는 같은 섹션 내)에 함정 추가: (a) profile은 `profile_json` 저장이라 새 profile 필드는 `#[serde(default)]`만 달면 runs 마이그레이션 불필요(구 row 자동 기본값) — Slice 6 ADD COLUMN 함정 회피; (b) 엔진 메트릭 채널 페이로드를 `Vec<StepWindow>`→`MetricFlush`로 바꾸면 모든 `run_scenario` 호출부(테스트 포함)가 `.windows`로 갱신 필요; (c) overflow를 `u32::MAX` sentinel로 보내고 리포트에서 `null`로 변환하면 컨트롤러/UI가 cap 숫자를 몰라도 됨.
- 결정 목록에 (0021로 분리 시) 한 줄 추가.

- [ ] **Step 3: 커밋**

```bash
git add docs/adr/ CLAUDE.md
git commit -m "docs(slice-7-1): loop breakdown ADR + CLAUDE.md results & gotchas"
```

---

## Self-Review (against the spec)

- **§1 In** — Task1(엔진 집계) · Task2/3/4(전송) · Task6(저장) · Task7(리포트) · Task9(UI drill-down) · Task5/8(cap 설정). ✅
- **§2 결정** — counts-only(T1), per-run cap+0=off(T5/T8/T1), 상한10000(T5/T8), overflow sentinel→null(T1/T7/T9), delta+UPSERT(T1/T6), profile_json→마이그레이션 불필요(T5). ✅
- **§3 데이터 흐름** — RunDialog→REST→profile→proto→RunPlan→Aggregator→MetricFlush→MetricBatch→run_loop_metrics→report→UI: T2~T9 전구간. ✅
- **§4 엔진** — Aggregator(T1) + RunPlan/runner(T2). ✅
- **§5 proto** — T3. ✅
- **§6 controller** — profile(T5)·migration/ingest(T6)·report(T7). ✅
- **§7 UI** — RunDialog(T8)·schemas+StepStatsTable(T9). ✅
- **§8 성능** — 벤치 ON/OFF(T11). ✅
- **§9 acceptance** — 엔진/컨트롤러/UI/e2e/성능/게이트 = T1~T11. ✅
- **§10 ADR** — T12. ✅

Type 일관성: 엔진 `LoopStat{step_id,loop_index:u32(=u32::MAX overflow),count,error_count}` = proto `LoopStat` = `MetricBatch.loop_stats`; `LoopMetricRow{loop_index:i64}`(DB) ↔ report `LoopBucket{loop_index:Option<u32>}`(u32::MAX→None); UI `loop_breakdown:{loop_index:number|null,count,error_count}[]`. `RunPlan.loop_breakdown_cap:u32` = proto `Profile.loop_breakdown_cap` = controller `Profile.loop_breakdown_cap`(serde default 256) = UI `ProfileSchema.loop_breakdown_cap`(0..10000 default256). `MetricFlush{windows,loop_stats}` 채널 페이로드 일관(T2 모든 호출부). cap=0 → 엔진 무집계 → run_loop_metrics 빈 → report 빈 loop_breakdown → UI caret 없음(일관).
