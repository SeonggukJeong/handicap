# Parallel 노드 그룹/페이지 레이턴시 (A2-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각 `parallel` 노드가 자기 페이지-로드 레이턴시 분포(run-total p50/p95/p99/max + count = 동시 분기 블록의 wall-clock ≈ max-of-branches)를 종료 리포트에 emit한다.

**Architecture:** 엔진 `Step::Parallel` arm이 `join_all`을 `Instant`로 재서 `Aggregator`의 새 HDR 계열(`group_hists`)에 기록 → `MetricFlush.group_stats`(delta) → proto `MetricBatch.group_stats=7` → worker 직렬화 → controller `run_group_metrics`(append-only, migration 0010) → `build_report`가 step_id별 HDR merge → `ReportJson.group_latency` → UI `GroupLatencyTable`. loop 7-1 / if 9d breakdown 파이프라인을 **HDR(카운트 아님)** 로 재사용. summary/overall/RPS는 **별도 누적기**라 미오염. 핫 flat-http·비-parallel run은 byte-identical.

**Tech Stack:** Rust(engine/controller/worker, hdrhistogram, sqlx/SQLite, tonic/prost) + TypeScript/React/Zod/vitest.

**Spec:** `docs/superpowers/specs/2026-06-06-parallel-group-page-latency-design.md`

---

## TDD 가드 / 커밋 경계 노트 (전 task 공통)

- **pre-commit 훅이 비-`.md` 커밋마다 전체 workspace를 빌드/clippy/test** 한다 — dead-code(`-D warnings`)·RED-only 단독 커밋 불가. 각 task는 **green 커밋 1개**로 닫는다(로컬에서 RED→GREEN 확인하되 커밋은 task당 1회). `git commit`은 **foreground 단일 호출**(`run_in_background:false`, timeout 600000ms), 파이프(`| tail`) 금지, 직후 `git log -1`로 landed 확인.
- **cold-build flake**(engine/worker 변경 커밋): 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm한 뒤 커밋. flake나면 동일 커밋 warm 재시도.
- **TDD 가드(C-1)**: `src/*.rs` 편집은 인라인 `#[cfg(test)]`가 **이미 디스크에 있는** 파일이면 자동 통과한다. 이 plan이 건드리는 모든 src 파일은 인라인 `#[cfg(test)] mod tests`를 이미 갖고 있다(reviewer 확인): `aggregator.rs`, `runner.rs`, `worker/src/main.rs:420`, `store/mod.rs:156`, `store/metrics.rs`, `grpc/coordinator.rs`, `report.rs`, `api/runs.rs`. **따라서 keepalive 불요.** (만약 어떤 src 편집이 가드에 막히면 — 예상 밖 — `crates/<crate>/tests/_tdd_keepalive.rs`에 `#[test] fn _k() {}`를 깔아 unblock하고 **명시 경로로만 `git add`** 후 **커밋 전 `rm`**. 새 `migrations/*.sql`은 src가 아니라 무가드.)
- **UI 가드는 cargo 훅이 안 본다** — UI task는 `cd ui && pnpm lint && pnpm test && pnpm build`를 수동으로 돌린 뒤 커밋.

---

## Task 1: 엔진 Aggregator — `GroupStat` + `record_group` + `drain_group_deltas`

**Files:**
- Modify: `crates/engine/src/aggregator.rs` (새 struct + 필드 + 메서드 + 인라인 테스트)
- Modify: `crates/engine/src/lib.rs:15` (re-export)

- [ ] **Step 1: `GroupStat` struct + `serialize_histogram` 추가**

`crates/engine/src/aggregator.rs`의 `BranchStat` 정의(라인 37 부근) 바로 뒤에 추가:

```rust
/// A per-(parallel_step_id) page-load latency delta since the last drain. HDR (not
/// counts) — page latency is a distribution merged by the controller via
/// `Histogram::add` (delta-merge), unlike `LoopStat`/`BranchStat` count-sum. The
/// histogram is carried live; the worker serializes it at forward time (like StepWindow).
#[derive(Debug)]
pub struct GroupStat {
    pub step_id: String, // the `parallel` node's id
    pub histogram: Histogram<u64>,
    pub count: u64,
}

impl GroupStat {
    pub fn serialize_histogram(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        let mut ser = V2Serializer::new();
        ser.serialize(&self.histogram, &mut buf)
            .map_err(|e| EngineError::Histogram(e.to_string()))?;
        Ok(buf)
    }
}
```

- [ ] **Step 2: `Aggregator`에 `group_hists` 필드 + `new`/struct 갱신**

`Aggregator` struct(라인 87 부근)에 필드 추가 — 기존:
```rust
pub struct Aggregator {
    windows: HashMap<(String, i64), StepWindow>,
    loop_counts: HashMap<(String, u32), LoopCount>,
    loop_cap: u32,
    branch_counts: HashMap<(String, String), u64>,
}
```
교체:
```rust
pub struct Aggregator {
    windows: HashMap<(String, i64), StepWindow>,
    loop_counts: HashMap<(String, u32), LoopCount>,
    loop_cap: u32,
    branch_counts: HashMap<(String, String), u64>,
    /// per-parallel-node accumulating page-load latency + sample count (A2-2).
    group_hists: HashMap<String, (Histogram<u64>, u64)>,
}
```
`Aggregator::new`(라인 95 부근) 본문의 struct 리터럴에 `group_hists: HashMap::new(),` 추가:
```rust
    pub fn new(loop_breakdown_cap: u32) -> Self {
        Self {
            windows: HashMap::new(),
            loop_counts: HashMap::new(),
            loop_cap: loop_breakdown_cap,
            branch_counts: HashMap::new(),
            group_hists: HashMap::new(),
        }
    }
```

- [ ] **Step 3: `record_group` + `drain_group_deltas` 메서드 추가**

`record_branch`/`drain_branch_deltas`(라인 150~167) 바로 뒤에 추가:

```rust
    /// Record one parallel-node page-load latency sample (µs). HDR-accumulating,
    /// unconditional (no cap) — one parallel node yields one sample per clean iteration.
    pub fn record_group(&mut self, step_id: &str, latency_us: u64) {
        let v = latency_us.clamp(1, 60_000_000);
        let e = self
            .group_hists
            .entry(step_id.to_string())
            .or_insert_with(|| {
                (
                    Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).expect("valid bounds"),
                    0,
                )
            });
        let _ = e.0.record(v);
        e.1 += 1;
    }

    /// Take and reset the accumulated per-(parallel_step_id) page-load histograms as
    /// deltas (the controller merges them via Histogram::add). Histograms returned live.
    pub fn drain_group_deltas(&mut self) -> Vec<GroupStat> {
        std::mem::take(&mut self.group_hists)
            .into_iter()
            .map(|(step_id, (histogram, count))| GroupStat {
                step_id,
                histogram,
                count,
            })
            .collect()
    }
```

- [ ] **Step 4: lib.rs re-export**

`crates/engine/src/lib.rs:15` 교체:
```rust
pub use aggregator::{Aggregator, BranchStat, GroupStat, LoopStat, StepWindow};
```

- [ ] **Step 5: 인라인 테스트 작성**

`aggregator.rs`의 `#[cfg(test)] mod tests` 안(마지막 테스트 `drain_branch_deltas_resets_between_drains` 뒤)에 추가:

```rust
    #[test]
    fn record_group_accumulates_and_drains_as_delta() {
        let mut a = Aggregator::new(0); // cap irrelevant to group latency
        a.record_group("p1", 100_000); // 100 ms
        a.record_group("p1", 300_000); // 300 ms
        a.record_group("p2", 50_000);
        let mut by: std::collections::HashMap<String, (u64, u64)> = Default::default();
        for g in a.drain_group_deltas() {
            by.insert(g.step_id.clone(), (g.count, g.histogram.max()));
        }
        assert_eq!(by.get("p1").map(|x| x.0), Some(2), "p1 has 2 samples");
        assert_eq!(by.get("p2").map(|x| x.0), Some(1), "p2 has 1 sample");
        // p1 max recorded value ~= 300 ms (HDR 3-sigfig, allow the bucket fuzz).
        assert!(by["p1"].1 >= 290_000, "p1 max ~= 300ms, got {}", by["p1"].1);
        // second drain is empty (delta reset)
        assert!(a.drain_group_deltas().is_empty(), "drain resets group hists");
    }

    #[test]
    fn group_stat_serializes_histogram() {
        let mut a = Aggregator::new(0);
        a.record_group("p1", 12_345);
        let g = a.drain_group_deltas().pop().expect("one group stat");
        let bytes = g.serialize_histogram().expect("serializes");
        assert!(!bytes.is_empty(), "group histogram bytes non-empty");
    }
```

- [ ] **Step 6: 테스트 실행 (RED→GREEN 로컬 확인)**

Run: `cargo test -p handicap-engine aggregator`
Expected: 새 2 테스트 PASS, 기존 전부 PASS.

- [ ] **Step 7: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm (cold-build flake 회피)
git add crates/engine/src/aggregator.rs crates/engine/src/lib.rs
git commit -m "feat(engine): Aggregator group-latency 계열(GroupStat/record_group/drain) — A2-2"
git log -1 --oneline
```

---

## Task 2: 엔진 runner — `MetricFlush.group_stats` + 4 flush 드레인 + 3 guard + Parallel arm 측정

**Files:**
- Modify: `crates/engine/src/runner.rs` (MetricFlush 필드 + 4 드레인 사이트 + 3 guard + Parallel arm)
- Test: `crates/engine/tests/parallel_node.rs` (통합 테스트 추가)

- [ ] **Step 1: 통합 테스트 작성 (RED)**

`crates/engine/tests/parallel_node.rs`의 마지막 테스트 뒤에 추가(기존 `plan`/`drain` 헬퍼 재사용):

```rust
#[tokio::test]
async fn parallel_records_group_latency_sample() {
    let server = MockServer::start().await;
    // Two branches, each ~300 ms. The block's wall-clock ≈ max(300, 300) = ~300 ms,
    // recorded once per iteration under the parallel node's id.
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
          - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/a" }, assert: [] }
      - name: b
        steps:
          - { id: "01HX0000000000000000000012", name: gb, type: http, request: { method: GET, url: "${BASE}/b" }, assert: [] }
"#;
    let sc = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 2), tx, CancellationToken::new())
        .await
        .unwrap();
    let flushes = drain(rx).await;

    // Sum group deltas across all flushes (periodic + final) for the parallel node id.
    let mut total_pages = 0u64;
    let mut max_us = 0u64;
    for f in &flushes {
        for g in &f.group_stats {
            assert_eq!(g.step_id, "01HX0000000000000000000010");
            total_pages += g.count;
            max_us = max_us.max(g.histogram.max());
        }
    }
    assert!(total_pages >= 1, "at least one clean page-load sample, got {total_pages}");
    // Page-load ≈ max(branch) ≈ 300 ms; assert it's clearly above a single branch's
    // start jitter (≥ 250 ms) and not absurd. (NOT sum: sequential would be ~600 ms.)
    assert!(max_us >= 250_000, "page-load ~= 300ms (max not sum), got {max_us}µs");
}

#[tokio::test]
async fn flat_scenario_emits_no_group_stats() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = r#"
version: 1
name: flat
steps:
  - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/a" }, assert: [] }
"#;
    let sc = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 1), tx, CancellationToken::new())
        .await
        .unwrap();
    let flushes = drain(rx).await;
    assert!(
        flushes.iter().all(|f| f.group_stats.is_empty()),
        "non-parallel scenario emits no group stats (byte-identical wire)"
    );
}
```

- [ ] **Step 2: 테스트 실행 — 컴파일 실패 확인**

Run: `cargo test -p handicap-engine --test parallel_node parallel_records_group_latency_sample`
Expected: FAIL — `no field 'group_stats' on type MetricFlush`.

- [ ] **Step 3: `MetricFlush`에 `group_stats` 필드 추가**

`crates/engine/src/runner.rs:70` 부근 `MetricFlush` struct에 필드 추가:
```rust
pub struct MetricFlush {
    pub windows: Vec<StepWindow>,
    pub loop_stats: Vec<LoopStat>,
    pub branch_stats: Vec<BranchStat>,
    pub group_stats: Vec<GroupStat>,
    pub dropped: u64,
}
```
파일 상단의 aggregator import에 `GroupStat` 추가(기존 `use crate::aggregator::{..., BranchStat, ..., LoopStat, StepWindow};` 류 — 정확한 import 줄을 grep으로 찾아 `GroupStat`를 알파벳 위치에 삽입; 없으면 `use crate::aggregator::GroupStat;` 한 줄 추가).

- [ ] **Step 4: closed-loop periodic flush (라인 180~206) — 드레인 + guard + 필드**

기존:
```rust
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                )
            };
            if !drained.is_empty() || !loop_stats.is_empty() || !branch_stats.is_empty() {
```
교체(destructure는 직전 `let (drained, loop_stats, branch_stats) = {`도 4-tuple로):
```rust
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                )
            };
            if !drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
            {
```
그리고 그 위 `let (drained, loop_stats, branch_stats) = {` → `let (drained, loop_stats, branch_stats, group_stats) = {`. MetricFlush 리터럴(라인 195)에 `group_stats,` 추가:
```rust
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
                        group_stats,
                        dropped: 0,
                    })
```

- [ ] **Step 5: closed-loop final flush (라인 220~237) — 드레인 + guard + 필드**

기존:
```rust
    let (final_windows, final_loops, final_branches) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
        )
    };
    if !final_windows.is_empty() || !final_loops.is_empty() || !final_branches.is_empty() {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
                dropped: 0,
            })
            .await;
    }
```
교체:
```rust
    let (final_windows, final_loops, final_branches, final_groups) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
        )
    };
    if !final_windows.is_empty()
        || !final_loops.is_empty()
        || !final_branches.is_empty()
        || !final_groups.is_empty()
    {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
                group_stats: final_groups,
                dropped: 0,
            })
            .await;
    }
```

- [ ] **Step 6: open-loop periodic flush (라인 606~635) — 드레인 + has_data + 필드**

기존:
```rust
            let (drained, loop_stats, branch_stats) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                )
            };
            let has_data =
                !drained.is_empty() || !loop_stats.is_empty() || !branch_stats.is_empty();
            if has_data {
```
교체:
```rust
            let (drained, loop_stats, branch_stats, group_stats) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                )
            };
            let has_data = !drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty();
            if has_data {
```
MetricFlush 리터럴(라인 624)에 `group_stats,` 추가(windows/loop_stats/branch_stats 뒤, dropped 앞).

- [ ] **Step 7: open-loop final flush (라인 762~777) — 드레인 + 필드 (guard 없음)**

기존:
```rust
    let (final_windows, final_loops, final_branches) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
        )
    };
    let _ = out
        .send(MetricFlush {
            windows: final_windows,
            loop_stats: final_loops,
            branch_stats: final_branches,
            dropped: total_dropped,
        })
        .await;
```
교체:
```rust
    let (final_windows, final_loops, final_branches, final_groups) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
        )
    };
    let _ = out
        .send(MetricFlush {
            windows: final_windows,
            loop_stats: final_loops,
            branch_stats: final_branches,
            group_stats: final_groups,
            dropped: total_dropped,
        })
        .await;
```

- [ ] **Step 8: Parallel arm 측정 (라인 460~518)**

`Step::Parallel(par) => {` arm에서, 기존 `let results = futures::future::join_all(futs).await;`를 `Instant` 측정으로 감싸고, merge 루프 뒤 `if aborted` 앞에 record_group을 추가한다. 기존:
```rust
                // wait-all: every branch runs to completion before the node returns.
                let results = futures::future::join_all(futs).await;
```
교체:
```rust
                // wait-all: every branch runs to completion before the node returns.
                // Time the whole concurrent block: page-load latency ≈ max(branches) (A2-2).
                let t0 = Instant::now();
                let results = futures::future::join_all(futs).await;
                let elapsed_us = t0.elapsed().as_micros() as u64;
```
그리고 merge 루프가 끝나고 `if aborted {` 직전(라인 512 부근)에 삽입:
```rust
                // Record page-load latency only on a clean block — a deadline/abort cut a
                // branch short (skipped steps → too-fast block), which would skew the
                // distribution low. Same caution as loop partial-iteration counting.
                if !aborted && !deadline_hit {
                    agg.lock().await.record_group(&par.id, elapsed_us);
                }
                if aborted {
                    return Ok(StepFlow::Aborted);
                }
```
(주의: `Instant`는 이미 `runner.rs:4`에서 import됨 — 추가 불요. `par.id`는 `ParallelStep.id`.)

- [ ] **Step 9: 테스트 실행 (GREEN)**

Run: `cargo test -p handicap-engine --test parallel_node`
Expected: `parallel_records_group_latency_sample`·`flat_scenario_emits_no_group_stats` PASS, 기존 parallel 테스트 PASS.
그리고 `cargo test -p handicap-engine` 전체 PASS(다른 MetricFlush consumer 회귀 없음 확인).

- [ ] **Step 10: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/engine/src/runner.rs crates/engine/tests/parallel_node.rs
git commit -m "feat(engine): Parallel arm 그룹 레이턴시 측정 + MetricFlush.group_stats 4 flush — A2-2"
git log -1 --oneline
```

---

## Task 3: proto + worker — `GroupStat` 메시지 + `MetricBatch.group_stats=7` + worker 직렬화

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`
- Modify: `crates/worker/src/main.rs` (forward + skip guard + MetricBatch 리터럴)
- Modify: `crates/controller/src/grpc/coordinator.rs:1236` (test `mk` 리터럴 — prost exhaustive)

> **TDD 가드**: `worker/src/main.rs`는 인라인 `#[cfg(test)] mod tests`(라인 420)를 이미 가져 자동 통과 — keepalive 불요. proto/coordinator 편집도 무가드/인라인.

- [ ] **Step 1: proto에 `GroupStat` + `MetricBatch.group_stats` 추가**

`crates/proto/proto/coordinator.proto`의 `BranchStat`(라인 39~43) 뒤에 추가:
```proto
message GroupStat {
  string step_id = 1;        // the `parallel` node's id
  bytes hdr_histogram = 2;   // hdrhistogram V2 serialized (delta since last drain)
  uint64 count = 3;          // page-load samples in this delta
}
```
`MetricBatch`(라인 45~52)의 `dropped = 6` 뒤에 필드 추가:
```proto
message MetricBatch {
  string run_id = 1;
  string worker_id = 2;
  repeated MetricWindow windows = 3;
  repeated LoopStat loop_stats = 4;
  repeated BranchStat branch_stats = 5;
  uint64 dropped = 6;                  // open-loop arrivals dropped (run-total on final flush)
  repeated GroupStat group_stats = 7;  // parallel 페이지-로드 레이턴시 (delta, controller merges)
}
```

- [ ] **Step 2: 빌드로 proto 재생성 확인 — worker 컴파일 실패 확인**

Run: `cargo build -p handicap-worker`
Expected: FAIL — `MetricBatch { ... }` 리터럴이 `group_stats` 누락으로 `missing field`.

- [ ] **Step 3: worker forward + skip guard + 리터럴 (`crates/worker/src/main.rs`)**

import 줄(`use pb::{BranchStat, LoopStat, MetricBatch, MetricWindow, RunStatus, WorkerMessage};`, 라인 16)에 `GroupStat` 추가:
```rust
use pb::{BranchStat, GroupStat, LoopStat, MetricBatch, MetricWindow, RunStatus, WorkerMessage};
```
`branch_stats` 빌드(라인 270~278) 바로 뒤에 group_stats 빌드 추가:
```rust
            let group_stats: Vec<GroupStat> = flush
                .group_stats
                .into_iter()
                .filter_map(|g| {
                    let hdr = g.serialize_histogram().ok()?;
                    Some(GroupStat {
                        step_id: g.step_id,
                        hdr_histogram: hdr,
                        count: g.count,
                    })
                })
                .collect();
```
skip guard(라인 282~288) 교체:
```rust
            if windows.is_empty()
                && loop_stats.is_empty()
                && branch_stats.is_empty()
                && group_stats.is_empty()
                && flush.dropped == 0
            {
                continue;
            }
```
MetricBatch 리터럴(라인 290~297)에 `group_stats,` 추가:
```rust
                payload: Some(WorkerPayload::MetricBatch(MetricBatch {
                    run_id: run_id.clone(),
                    worker_id: worker_id.clone(),
                    windows,
                    loop_stats,
                    branch_stats,
                    group_stats,
                    dropped: flush.dropped,
                })),
```

- [ ] **Step 4: controller 테스트 `mk` 리터럴 (`crates/controller/src/grpc/coordinator.rs:1236`)**

`mk` 클로저(`#[tokio::test] ingest_accumulates_dropped_into_runs`)의 `pb::MetricBatch { ... }`에 `group_stats: vec![],` 추가(branch_stats 뒤, dropped 앞):
```rust
        let mk = |d: u64| pb::MetricBatch {
            run_id: run_id.clone(),
            worker_id: "w0".to_string(),
            windows: vec![],
            loop_stats: vec![],
            branch_stats: vec![],
            group_stats: vec![],
            dropped: d,
        };
```

- [ ] **Step 5: 컴파일 + 전체 빌드 확인**

Run: `cargo build --workspace`
Expected: PASS. (`grep -rn "MetricBatch {" crates/`로 두 리터럴 모두 `group_stats` 포함 확인.)

- [ ] **Step 6: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/proto/proto/coordinator.proto crates/worker/src/main.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(proto/worker): GroupStat 메시지 + MetricBatch.group_stats=7 + 워커 직렬화 — A2-2"
git log -1 --oneline
```

---

## Task 4: controller 저장 — migration 0010 + `insert_group_batch` + `group_breakdown`

**Files:**
- Create: `crates/controller/src/store/migrations/0010_run_group_metrics.sql`
- Modify: `crates/controller/src/store/mod.rs` (const + execute 라인)
- Modify: `crates/controller/src/store/metrics.rs` (`GroupMetricRow` + insert/read + 인라인 테스트)

> **TDD 가드**: `store/mod.rs`(인라인 `#[cfg(test)] mod tests` 라인 156)·`store/metrics.rs`(인라인 테스트) 모두 자동 통과 — keepalive 불요. `migrations/0010_*.sql`은 src 아님(무가드).

- [ ] **Step 1: migration SQL 파일 작성**

`crates/controller/src/store/migrations/0010_run_group_metrics.sql`:
```sql
-- migration 0010 (A2-2): per-parallel-node page-load latency (group latency).
-- Append-only: HDR histograms can't be merged in SQL, so each metric batch's delta
-- histogram is its own row; build_report merges by step_id (Histogram::add). No
-- PK/UPSERT (contrast run_loop_metrics/run_if_metrics, which accumulate counts in
-- SQL). Safe without an idempotency key: metric batches are delivered once over the
-- single bidi stream (no mid-run resend). CREATE IF NOT EXISTS = idempotent.
CREATE TABLE IF NOT EXISTS run_group_metrics (
  run_id        TEXT    NOT NULL,
  step_id       TEXT    NOT NULL,
  hdr_histogram BLOB    NOT NULL,
  count         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_group_metrics_run ON run_group_metrics(run_id);
```

- [ ] **Step 2: store/mod.rs const + execute 라인**

`crates/controller/src/store/mod.rs:31`(마지막 const `MIGRATION_SQL_0007` 뒤)에 추가:
```rust
const MIGRATION_SQL_0010: &str = include_str!("migrations/0010_run_group_metrics.sql");
```
`connect()`의 `ensure_runs_dropped(&pool).await?;`(라인 61) 뒤, `Ok(pool)` 앞에 execute 추가:
```rust
    sqlx::query(MIGRATION_SQL_0010).execute(&pool).await?; // migration 0010: run_group_metrics
```
**교차검증**: `grep -c MIGRATION_SQL crates/controller/src/store/mod.rs`로 const 개수와 execute 개수가 일치하는지 확인(이 함정으로 두 번 당함 — 0008/0009는 Rust-guarded라 const엔 없음).

- [ ] **Step 3: `metrics.rs`에 `GroupMetricRow` + insert + read 추가**

`crates/controller/src/store/metrics.rs`의 `if_breakdown` 함수(라인 245 부근) 뒤, `#[cfg(test)]` 앞에 추가:
```rust
#[derive(Debug, Clone)]
pub struct GroupMetricRow {
    pub run_id: String,
    pub step_id: String, // the `parallel` node's id
    pub hdr_histogram: Vec<u8>,
    pub count: i64,
}

pub async fn insert_group_batch(db: &Db, rows: &[GroupMetricRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // Append-only: each row is a delta HDR; build_report merges by step_id. No PK —
    // metric batches are delivered once (no mid-run resend), so no dedup key is needed.
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_group_metrics(run_id,step_id,hdr_histogram,count) VALUES(?,?,?,?)",
        )
        .bind(&r.run_id)
        .bind(&r.step_id)
        .bind(&r.hdr_histogram)
        .bind(r.count)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn group_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<GroupMetricRow>> {
    let rows = sqlx::query(
        "SELECT step_id, hdr_histogram, count FROM run_group_metrics \
         WHERE run_id = ? ORDER BY step_id",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| GroupMetricRow {
            run_id: run_id.to_string(),
            step_id: r.get("step_id"),
            hdr_histogram: r.get("hdr_histogram"),
            count: r.get("count"),
        })
        .collect())
}
```

- [ ] **Step 4: 인라인 테스트 (round-trip)**

`metrics.rs`의 `#[cfg(test)] mod tests` 안에 추가(기존 `connect`/`seed_run` 헬퍼 유무는 모듈 내 다른 테스트 참고 — `crate::store::connect("sqlite::memory:")` 패턴):
```rust
    #[tokio::test]
    async fn group_batch_appends_and_reads_back() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        // run_group_metrics has no FK to runs, so no seed needed.
        let rows = vec![
            GroupMetricRow {
                run_id: "r1".into(),
                step_id: "p1".into(),
                hdr_histogram: vec![1, 2, 3],
                count: 4,
            },
            GroupMetricRow {
                run_id: "r1".into(),
                step_id: "p1".into(),
                hdr_histogram: vec![4, 5],
                count: 2,
            },
        ];
        insert_group_batch(&db, &rows).await.unwrap();
        let read = group_breakdown(&db, "r1").await.unwrap();
        // append-only: two delta rows for the same step_id coexist (merged at read in build_report).
        assert_eq!(read.len(), 2, "append-only keeps both delta rows");
        assert_eq!(read.iter().map(|r| r.count).sum::<i64>(), 6);
        assert!(read.iter().all(|r| r.step_id == "p1"));
    }
```

- [ ] **Step 5: 테스트 실행**

Run: `cargo test -p handicap-controller --lib metrics::tests::group_batch_appends_and_reads_back`
Expected: PASS (migration 0010이 적용돼 테이블 존재).

- [ ] **Step 6: 커밋**

```bash
grep -c MIGRATION_SQL crates/controller/src/store/mod.rs   # const==execute 교차검증
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/store/migrations/0010_run_group_metrics.sql crates/controller/src/store/mod.rs crates/controller/src/store/metrics.rs
git commit -m "feat(controller): run_group_metrics 테이블(0010) + insert/read append-only — A2-2"
git log -1 --oneline
```

---

## Task 5: controller ingest — `ingest_metrics`가 group_stats를 저장

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`ingest_metrics` + 인라인 테스트)

- [ ] **Step 1: ingest 테스트 작성 (RED)**

`coordinator.rs`의 `#[cfg(test)] mod tests` 안(`ingest_accumulates_dropped_into_runs` 부근)에 추가. 헬퍼 `seed_run`은 같은 모듈에서 재사용:
```rust
    #[tokio::test]
    async fn ingest_stores_group_stats() {
        // The coordinator test module does NOT import these — add a local `use` (the
        // `.serialize()` method is on the `Serializer` trait, must be in scope). reviewer 확인.
        use hdrhistogram::serialization::{Serializer, V2Serializer};
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());

        // a valid HDR blob with one ~300ms sample.
        let mut h = hdrhistogram::Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
        h.record(300_000).unwrap();
        let mut blob = Vec::new();
        V2Serializer::new().serialize(&h, &mut blob).unwrap();

        let batch = pb::MetricBatch {
            run_id: run_id.clone(),
            worker_id: "w0".to_string(),
            windows: vec![],
            loop_stats: vec![],
            branch_stats: vec![],
            group_stats: vec![pb::GroupStat {
                step_id: "p1".to_string(),
                hdr_histogram: blob,
                count: 1,
            }],
            dropped: 0,
        };
        ingest_metrics(&coord, &batch).await;

        let rows = crate::store::metrics::group_breakdown(&db, &run_id)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].step_id, "p1");
        assert_eq!(rows[0].count, 1);
    }
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `cargo test -p handicap-controller --lib grpc::coordinator::tests::ingest_stores_group_stats`
Expected: FAIL — `assert_eq!(rows.len(), 1)` (group_stats가 아직 저장 안 됨, 0 rows).

- [ ] **Step 3: `ingest_metrics`에 group 저장 배선**

`crates/controller/src/grpc/coordinator.rs`의 `ingest_metrics`에서 branch_rows 블록(라인 821~836) 뒤, `if batch.dropped > 0` 앞에 추가:
```rust
    let group_rows: Vec<crate::store::metrics::GroupMetricRow> = batch
        .group_stats
        .iter()
        .map(|gs| crate::store::metrics::GroupMetricRow {
            run_id: batch.run_id.clone(),
            step_id: gs.step_id.clone(),
            hdr_histogram: gs.hdr_histogram.clone(),
            count: gs.count as i64,
        })
        .collect();
    if !group_rows.is_empty() {
        if let Err(e) = crate::store::metrics::insert_group_batch(&state.db, &group_rows).await {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert group metrics");
        }
    }
```

- [ ] **Step 4: 테스트 실행 (GREEN)**

Run: `cargo test -p handicap-controller --lib grpc::coordinator::tests::ingest_stores_group_stats`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): ingest_metrics가 group_stats를 run_group_metrics에 저장 — A2-2"
git log -1 --oneline
```

---

## Task 6: controller 리포트 — `GroupLatency` + `build_report` 6번째 파라미터 + 전 call site

**Files:**
- Modify: `crates/controller/src/report.rs` (GroupLatency, ReportJson 필드, build_report param + group_acc + emit, 11 test call site)
- Modify: `crates/controller/src/api/runs.rs:380-396` (`build_report_for_run` fetch + pass)

- [ ] **Step 1: report.rs 테스트 작성 (RED)**

`report.rs`의 `#[cfg(test)] mod tests` 안에 추가. **실제 헬퍼 사용**(reviewer 정정 — `run_row_for_duration`/`window_with_hdr_us`는 없는 이름): `run_row()`(인자 없음, report.rs:425 — Completed·2초 run), `win(ts, step, count, errors, sc, samples)`(report.rs:455), `make_hdr_bytes(&[..µs..])`(report.rs:415). 테스트 모듈은 `use hdrhistogram::serialization::{Serializer, V2Serializer};`를 이미 import(report.rs:413). 패턴은 기존 `build_report_attaches_if_breakdown`(report.rs:632) 미러.
```rust
    #[test]
    fn build_report_attaches_group_latency_without_polluting_summary() {
        use crate::store::metrics::GroupMetricRow;
        let r = run_row();
        // One http window (count=10) so summary reflects only real requests, not pages.
        let rows = vec![win(100, "01HX0000000000000000000011", 10, 0, r#"{"200":10}"#, &[5_000])];
        // One group delta for the parallel node: 3 page loads ~300 ms each.
        let groups = vec![GroupMetricRow {
            run_id: r.id.clone(),
            step_id: "01HX0000000000000000000010".into(),
            hdr_histogram: make_hdr_bytes(&[300_000, 305_000, 295_000]),
            count: 3,
        }];
        let yaml = r.scenario_yaml.clone();

        let rep = build_report(&r, &yaml, &rows, &[], &[], &groups);

        // summary/overall reflect ONLY the http window (10 reqs), NOT the 3 page loads.
        assert_eq!(rep.summary.count, 10, "group samples excluded from summary count");
        assert!(
            rep.steps.iter().all(|s| s.step_id != "01HX0000000000000000000010"),
            "parallel node id not in per-step rows"
        );
        // group_latency carries the parallel node distribution.
        assert_eq!(rep.group_latency.len(), 1);
        let g = &rep.group_latency[0];
        assert_eq!(g.step_id, "01HX0000000000000000000010");
        assert_eq!(g.count, 3);
        assert!(g.p50_ms >= 290 && g.max_ms >= 300, "p50~300ms max~305ms, got {g:?}");
        // typed round-trip (report types require Deserialize too).
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn build_report_empty_groups_yields_empty_group_latency() {
        let r = run_row();
        let rep = build_report(&r, "", &[], &[], &[], &[]);
        assert!(rep.group_latency.is_empty());
    }
```

- [ ] **Step 2: 테스트 실행 — 컴파일 실패 확인**

Run: `cargo test -p handicap-controller --lib report::tests::build_report_attaches_group_latency_without_polluting_summary`
Expected: FAIL — `build_report`가 6개 인자를 안 받음 / `group_latency` 필드 없음.

- [ ] **Step 3: import + `GroupLatency` struct + `ReportJson` 필드**

`report.rs:1`의 store import에 `GroupMetricRow` 추가:
```rust
use crate::store::metrics::{GroupMetricRow, IfBranchRow, LoopMetricRow, WindowWithHdr};
```
`LatencyDistribution` 정의(라인 109~113) 뒤에 추가:
```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct GroupLatency {
    pub step_id: String, // the `parallel` node's id
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}
```
`ReportJson`(라인 11~28)의 `latency` 필드 뒤에 추가:
```rust
    #[serde(default)]
    pub group_latency: Vec<GroupLatency>,
```

- [ ] **Step 4: `build_report` 시그니처 + group_acc + emit**

`build_report`(라인 199~205) 시그니처에 6번째 파라미터 추가:
```rust
pub fn build_report(
    run: &RunRow,
    scenario_yaml: &str,
    rows: &[WindowWithHdr],
    loops: &[LoopMetricRow],
    branches: &[IfBranchRow],
    groups: &[GroupMetricRow],
) -> ReportJson {
```
`if_breakdown` 빌드(라인 233~236) 뒤에 group 누적 추가(`overall`/`total_count`/`per_step` 미접촉 = 비오염):
```rust
    // Group (page-load) latency: a SEPARATE accumulator keyed by the parallel node's
    // id. Deliberately NOT merged into `overall`/`total_count`/`per_step`/`windows` —
    // a page load is the max of children already counted there, so folding it in would
    // double-count latency and inflate rps (spec §2.1).
    let mut group_acc: BTreeMap<String, (Histogram<u64>, u64)> = BTreeMap::new();
    for g in groups {
        let e = group_acc
            .entry(g.step_id.clone())
            .or_insert_with(|| (fresh_hist(), 0));
        if let Ok(Some(h)) = decode_hdr(&g.hdr_histogram) {
            merge_into(&mut e.0, &h); // fail-soft: bad blob -> count kept, distribution skips it
        }
        e.1 += g.count as u64;
    }
    let group_latency: Vec<GroupLatency> = group_acc
        .into_iter()
        .map(|(step_id, (h, count))| {
            let p = percentiles_of(&h);
            GroupLatency {
                step_id,
                count,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
                max_ms: h.max() / 1000,
            }
        })
        .collect();
```
최종 `ReportJson { ... }` 리터럴(라인 385~406)의 `latency,` 뒤에 추가:
```rust
        group_latency,
```

- [ ] **Step 5: `build_report_for_run` fetch + pass (`api/runs.rs`)**

`crates/controller/src/api/runs.rs:380~396` 교체:
```rust
pub async fn build_report_for_run(
    db: &crate::store::Db,
    run_id: &str,
) -> Result<crate::report::ReportJson, ApiError> {
    let row = runs::get(db, run_id).await?.ok_or(ApiError::NotFound)?;
    let rows = crate::store::metrics::windows_with_hdr(db, run_id).await?;
    let loops = crate::store::metrics::loop_breakdown(db, run_id).await?;
    let branches = crate::store::metrics::if_breakdown(db, run_id).await?;
    let groups = crate::store::metrics::group_breakdown(db, run_id).await?;
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(crate::report::build_report(
        &row,
        &scenario_yaml,
        &rows,
        &loops,
        &branches,
        &groups,
    ))
}
```

- [ ] **Step 6: 기존 `build_report(...)` 테스트 call site 11곳에 `&[]` 추가**

`report.rs` 테스트의 모든 기존 `build_report(...)` 호출(라인 500/548/573/616/660/749/763/770/777/792/814)에 마지막 인자 `&[]`를 추가한다. 예:
- `build_report(&r, &yaml, &rows, &[], &[])` → `build_report(&r, &yaml, &rows, &[], &[], &[])`
- `build_report(&r, "", &[], &[], &[])` → `build_report(&r, "", &[], &[], &[], &[])`

(컴파일러가 누락을 전부 잡는다 — `cargo build`로 빨간 줄을 따라가며 고친다.)

- [ ] **Step 7: 테스트 실행 (GREEN)**

Run: `cargo test -p handicap-controller --lib report::tests`
Expected: 새 2 테스트 + 기존 build_report 테스트 전부 PASS. 그리고 `cargo test -p handicap-controller` 전체 PASS.

- [ ] **Step 8: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/report.rs crates/controller/src/api/runs.rs
git commit -m "feat(controller): build_report group_latency 최상위 배열(비오염) + 전 call site — A2-2"
git log -1 --oneline
```

---

## Task 7: UI — Zod `GroupLatencySchema` + `GroupLatencyTable` + ReportView 슬롯

**Files:**
- Modify: `ui/src/api/schemas.ts` (`GroupLatencySchema` + `ReportSchema.group_latency`)
- Create: `ui/src/components/report/GroupLatencyTable.tsx`
- Modify: `ui/src/components/report/ReportView.tsx` (`groupMeta` + import + render)
- Test: `ui/src/components/report/GroupLatencyTable.test.tsx`

- [ ] **Step 1: Zod 스키마 추가 (`schemas.ts`)**

`IfBreakdownSchema`(라인 158 부근) 뒤에 추가:
```ts
export const GroupLatencySchema = z
  .object({
    step_id: z.string(),
    count: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
    max_ms: z.number().int().nonnegative(),
  })
  .strict();
export type GroupLatency = z.infer<typeof GroupLatencySchema>;
```
`ReportSchema`(라인 238~)의 `if_breakdown` 줄 부근에 추가(`.optional()` — `if_breakdown` 패턴, `.default([])` 금지):
```ts
    group_latency: z.array(GroupLatencySchema).optional(),
```

- [ ] **Step 2: `GroupLatencyTable` 테스트 작성 (RED)**

`ui/src/components/report/GroupLatencyTable.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { GroupLatencyTable } from "./GroupLatencyTable";
import type { GroupLatency } from "../../api/schemas";

const rows: GroupLatency[] = [
  { step_id: "p1", count: 42, p50_ms: 300, p95_ms: 420, p99_ms: 500, max_ms: 610 },
];

describe("GroupLatencyTable", () => {
  it("renders a row per parallel node with the resolved name and stats", () => {
    render(
      <GroupLatencyTable breakdown={rows} meta={new Map([["p1", { name: "page load" }]])} />,
    );
    expect(screen.getByRole("region", { name: "Page load latency" })).toBeInTheDocument();
    expect(screen.getByText("page load")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("420 ms")).toBeInTheDocument(); // p95
    expect(screen.getByText("610 ms")).toBeInTheDocument(); // max
  });

  it("falls back to step_id when meta is missing", () => {
    render(<GroupLatencyTable breakdown={rows} meta={new Map()} />);
    expect(screen.getByText("p1")).toBeInTheDocument();
  });

  it("renders nothing when empty", () => {
    const { container } = render(<GroupLatencyTable breakdown={[]} meta={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 3: 테스트 실행 — 실패 확인**

Run: `cd ui && pnpm test GroupLatencyTable`
Expected: FAIL — `GroupLatencyTable` 모듈 없음.

- [ ] **Step 4: `GroupLatencyTable.tsx` 작성**

`ui/src/components/report/GroupLatencyTable.tsx`:
```tsx
import type { GroupLatency } from "../../api/schemas";

type GroupMeta = { name: string };
type Props = { breakdown: GroupLatency[]; meta: Map<string, GroupMeta> };

/** Page-load latency per `parallel` node = wall-clock of the concurrent block
 *  (≈ max of branches), aggregated run-total. Separate from StepStatsTable because
 *  the parallel node's id is not an http-leaf metric row (A2-2). */
export function GroupLatencyTable({ breakdown, meta }: Props) {
  if (breakdown.length === 0) return null;
  return (
    <section aria-label="Page load latency" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">페이지 로드 레이턴시</h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">Parallel node</th>
            <th className="py-2 pr-4 font-medium">Pages</th>
            <th className="py-2 pr-4 font-medium">p50</th>
            <th className="py-2 pr-4 font-medium">p95</th>
            <th className="py-2 pr-4 font-medium">p99</th>
            <th className="py-2 pr-4 font-medium">max</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((g) => {
            const m = meta.get(g.step_id);
            return (
              <tr key={g.step_id} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-medium">
                  {m?.name ?? g.step_id}{" "}
                  <span className="text-slate-400">(parallel)</span>
                </td>
                <td className="py-2 pr-4">{g.count}</td>
                <td className="py-2 pr-4">{g.p50_ms} ms</td>
                <td className="py-2 pr-4">{g.p95_ms} ms</td>
                <td className="py-2 pr-4">{g.p99_ms} ms</td>
                <td className="py-2 pr-4">{g.max_ms} ms</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 5: ReportView 슬롯 + `groupMeta` (`ReportView.tsx`)**

import 블록(라인 12 `BranchStatsTable` import 뒤)에 추가:
```tsx
import { GroupLatencyTable } from "./GroupLatencyTable";
```
`ifMeta` useMemo(라인 73~83) 뒤에 `groupMeta` 추가:
```tsx
  const groupMeta = useMemo(() => {
    const m = new Map<string, { name: string }>();
    const parsed = parseScenarioDoc(report.scenario_yaml);
    if ("model" in parsed) {
      for (const g of report.group_latency ?? []) {
        const step = findStepById(parsed.model.steps, g.step_id);
        m.set(g.step_id, { name: step?.name ?? g.step_id });
      }
    }
    return m;
  }, [report.scenario_yaml, report.group_latency]);
```
렌더에서 `<BranchStatsTable ... />`(라인 160) 바로 뒤에 추가:
```tsx
      <GroupLatencyTable breakdown={report.group_latency ?? []} meta={groupMeta} />
```

- [ ] **Step 6: UI 게이트 (테스트 + lint + 빌드)**

Run:
```bash
cd ui && pnpm test GroupLatencyTable && pnpm test ReportView && pnpm lint && pnpm test && pnpm build
```
Expected: GroupLatencyTable 3 테스트 PASS, 전체 vitest PASS(기존 Report fixture는 `group_latency` `.optional()`이라 수정 불요), `pnpm lint` 0 warning, `tsc -b` clean.

- [ ] **Step 7: 커밋**

```bash
cd /Users/sgj/develop/handicap
git add ui/src/api/schemas.ts ui/src/components/report/GroupLatencyTable.tsx ui/src/components/report/GroupLatencyTable.test.tsx ui/src/components/report/ReportView.tsx
git commit -m "feat(ui): GroupLatencyTable + ReportSchema.group_latency + ReportView 슬롯 — A2-2"
git log -1 --oneline
```

---

## Task 8: e2e + 라이브 검증

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs` (새 `parallel_group_latency_report_e2e_smoke`)

- [ ] **Step 1: e2e 테스트 작성 (RED → 배선 완료돼 GREEN 기대)**

`crates/controller/tests/e2e_test.rs`에 기존 e2e(예: `if_branch_report_e2e_smoke`/`report_e2e_smoke`) 패턴을 미러해 추가. 핵심: 2-branch parallel 시나리오(각 분기에 인공 지연 ≥5ms로 p95>0 보장 — controller CLAUDE.md localhost µs 함정), 워커 subprocess → run → `/report` 에서 `group_latency` 비어있지 않고 count≥1, p95_ms·max_ms > 0. 시나리오 YAML·wiremock stub·worker_bin_path 헬퍼는 기존 e2e에서 그대로 차용. 단언 골자:
```rust
    // ... run a 2-branch parallel scenario to completion via worker subprocess ...
    let report: serde_json::Value = /* GET /api/runs/{id}/report */;
    let gl = report["group_latency"].as_array().expect("group_latency array");
    assert_eq!(gl.len(), 1, "one parallel node");
    assert!(gl[0]["count"].as_u64().unwrap() >= 1);
    assert!(gl[0]["max_ms"].as_u64().unwrap() > 0, "page-load max > 0 (artificial delay)");
    // summary count must NOT include page-load samples (only the 2 http leaves per iter).
    // (sanity: summary.count is a multiple of 2 per completed iteration, group is separate.)
```

- [ ] **Step 2: e2e 실행**

Run: `cargo test -p handicap-controller --test e2e_test parallel_group_latency_report_e2e_smoke`
Expected: PASS(워커 바이너리 빌드 + 전 파이프라인). flake(cold-build 워커 race) 시 warm 후 재시도.

- [ ] **Step 3: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/tests/e2e_test.rs
git commit -m "test(controller): parallel 그룹 레이턴시 e2e smoke — A2-2"
git log -1 --oneline
```

- [ ] **Step 4: 라이브 검증 (머지 전 필수 — S-D 교훈)**

`dev-doctor` 스킬로 로컬 스택 점검 후:
```bash
cargo build -p handicap-worker --bin worker     # subprocess가 spawn하는 바이너리
cargo run -p handicap-controller --bin controller -- --db /tmp/groupcheck.db --ui-dir ui/dist
```
- python `ThreadingHTTPServer`(또는 wiremock) 2 엔드포인트(`/a`·`/b`, 각 ~200ms 지연) 띄우고, 2-branch parallel 시나리오를 `POST /api/scenarios`로 생성 → `POST /api/runs`로 run(VUs 5, 10s).
- 종료 후 `GET /api/runs/{id}/report` JSON에서 **확인**:
  - `group_latency[0].p50_ms ≈ max(분기 지연)`(≈200ms, **합 아님** ≈400 아님), `> 개별 분기 p50`.
  - `summary.count` = 분기 http 요청 수만(그룹 미포함; 페이지당 2 요청).
  - UI(`pnpm dev` 또는 단일포트)에서 리포트 페이지에 "페이지 로드 레이턴시" 섹션이 노드명과 함께 렌더, `ReportSchema.parse` 통과(브라우저 콘솔/네트워크 무에러).
- 정리: `rm -rf .playwright-mcp` + 루트 png(`browser_take_screenshot` 잔류) 제거(gitignore 안 됨).

---

## Self-Review 체크리스트 (구현 전 plan 작성자 확인 완료)

- **Spec 커버리지**: §2.1 비오염(Task 6 non-pollution 테스트), §3.2 proto(T3), §3.3 aggregator(T1), §3.4 4 flush+3 guard(T2 Step 4-7), §4.1 측정 clean-flow(T2 Step 8), §4.2 trace 무변경(touch 안 함), §4.3 worker(T3), §4.4 migration 0010+ingest(T4/T5), §4.5 build_report(T6), §4.6 UI(T7), §6 테스트(전 task), §7 게이트(커밋 노트). ✅
- **타입 일관성**: `GroupStat`(engine)→`pb::GroupStat`(proto)→`GroupMetricRow`(store)→`GroupLatency`(report)→`GroupLatencySchema`(UI). 필드 `step_id`/`count`/`hdr_histogram`/`p*_ms`/`max_ms` 전 레이어 1:1. `record_group`/`drain_group_deltas`/`insert_group_batch`/`group_breakdown`/`group_acc`/`group_latency` 이름 일관. ✅
- **placeholder 없음**: 모든 코드 step에 실제 코드. e2e(T8 Step1)만 "기존 패턴 미러" 서술 — e2e 하네스(worker_bin_path/시나리오 빌드)는 파일별로 상이해 리터럴 복제보다 기존 미러가 정확(기존 `report_e2e_smoke` 참조). ✅
- **커밋 경계**: 각 task green(dead-code/RED-only 단독 커밋 없음). T3는 proto+worker+coordinator-test 동시(prost exhaustive). ✅

**spec-plan-reviewer pass (2026-06-06)**: 23개 항목을 라이브 코드와 대조 — 모든 코드 위치 주장(라인번호·flush guard 3곳·import·proto 필드·migration 배선·call-site 11+1·UI 미러)이 CONFIRMED. 2건 fold-in: ① Task 6 테스트가 없는 헬퍼(`run_row_for_duration`/`window_with_hdr_us`)를 호출 → 실제 헬퍼 `run_row()`/`win(...)`/`make_hdr_bytes(...)`로 교체. ② Task 5 ingest 테스트에 `use hdrhistogram::serialization::{Serializer, V2Serializer};` 로컬 import 명시(trait 메서드 미해결 방지). 중복 keepalive 2건 제거(worker/main.rs·store/mod.rs 모두 인라인 `#[cfg(test)]` 보유). dead_code 우려는 non-issue(lib crate의 pub 항목 + task별 테스트 사용).
