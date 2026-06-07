# Parallel per-branch latency breakdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각 `parallel` 노드의 분기별 레이턴시 분포(p50/p95/p99/max·count)를 리포트에 emit해 "어느 동시 호출이 페이지를 지배하는가(병목 분기)"를 보이게 한다.

**Architecture:** 기존 A2-2 `group_stats` 파이프라인을 `(step_id, branch)` 키로 확장한다(별도 파이프라인 신설 아님). 엔진이 페이지(`branch=""`)와 분기(`branch=분기명`)를 같은 `group_hists`/`group_stats` 벡터로 흘리고, proto `GroupStat`에 `branch` 필드 1개를 더하며, 컨트롤러가 `(step_id, branch)`로 read-merge해 `GroupLatency.branches`로 중첩한다. B7-C phase 분해(`(step_id, phase)`)와 완전 동형 — 신규 드레인/플러시/guard·신규 proto 메시지·신규 테이블 0.

**Tech Stack:** Rust(engine HDR 집계 / controller axum+sqlx / proto prost+tonic) + TypeScript/React/Zod UI. 설계 = `docs/superpowers/specs/2026-06-07-parallel-per-branch-latency-design.md`.

---

## 이 repo 특유의 실행 제약 (모든 task 공통)

- **pre-commit 훅이 비-`.md` 커밋마다 전체 workspace를 빌드/clippy/test** 한다 → 각 task는 **하나의 green 커밋**이어야 한다. RED 테스트만 단독 커밋 불가, dead-code 헬퍼 단독 커밋 불가. **로컬에선 RED→GREEN을 확인하되 커밋은 task당 1회**로 fold.
- 커밋은 `git commit`을 **`run_in_background:false` + 파이프 없이** 단일 호출, 직후 `git log -1`로 landed 확인(파이프는 exit code 마스킹).
- **cold-build flake**: 엔진/워커를 바꾼 커밋은 pre-commit `cargo test --workspace`가 controller e2e 워커 race로 flake날 수 있다 → 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm, flake나면 같은 커밋 재시도.
- **tdd-guard 훅**: 편집 대상 파일에 인라인 `#[cfg(test)]`가 이미 있거나 작업트리에 pending test-path 파일이 있으면 통과. 이 plan이 건드리는 `aggregator.rs`/`runner.rs`/`main.rs`(worker)/`metrics.rs`/`report.rs`는 전부 인라인 테스트 보유 → 자동 통과. `store/mod.rs`·`grpc/coordinator.rs`는 같은 task에서 test-path 파일(`crates/engine/tests/*.rs` 또는 인라인 테스트 보유 src)을 먼저 건드리면 unblock. 막히면 `crates/controller/tests/` 아래 trivial keepalive를 깔고 task 끝에 `rm`.
- **UI 커밋**: pre-commit은 cargo만 돌린다 → UI task는 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`를 **수동**으로 돌려 `tsc -b`/eslint를 통과시킨다.
- **proto 변경(Task 2)은 crate-wide**: prost 구조체는 exhaustive라 `GroupStat` 필드 추가 시 모든 literal 사이트가 컴파일 에러 → `grep -rn "GroupStat {" crates/`로 전부 확인.

## 파일 구조 (생성/수정 + 책임)

| 파일 | 변경 | 책임 |
|---|---|---|
| `crates/engine/src/aggregator.rs` | 수정 | `group_hists` 키 `(step_id, branch)`화 + `record_group(step_id, branch, us)` + `GroupStat.branch` + `drain_group_deltas` |
| `crates/engine/src/runner.rs` | 수정 | Parallel arm — 분기별 `Instant` 측정 + clean-block에서 페이지+분기 일괄 기록 |
| `crates/engine/tests/parallel_node.rs` | 수정 | per-branch 기록 통합 테스트 |
| `crates/proto/proto/coordinator.proto` | 수정 | `GroupStat.branch = 4` |
| `crates/worker/src/main.rs` | 수정 | 엔진→proto `GroupStat` forwarding에 `branch` |
| `crates/controller/src/store/metrics.rs` | 수정 | `GroupMetricRow.branch` + insert/select |
| `crates/controller/src/store/mod.rs` | 수정 | migration 0014 `ensure_run_group_metrics_branch` + wire |
| `crates/controller/src/grpc/coordinator.rs` | 수정 | ingest 변환에 `branch` |
| `crates/controller/src/report.rs` | 수정 | `group_acc` `(step_id, branch)`화 + `GroupLatency.branches` + `BranchLatency` + 중첩 조립 |
| `crates/controller/tests/e2e_test.rs` | 수정 | smoke에 분기 행 단언 |
| `ui/src/api/schemas.ts` | 수정 | `BranchLatencySchema` + `GroupLatencySchema.branches` |
| `ui/src/components/report/GroupLatencyTable.tsx` | 수정 | 페이지 행 + 들여쓴 분기 sub-행 |
| `ui/src/components/report/__tests__/GroupLatencyTable.test.tsx` | 수정 | 분기 sub-행 렌더 검증 |

---

## Task 1: 엔진 — 분기별 group latency 측정·기록

**Files:**
- Modify: `crates/engine/src/aggregator.rs` (`GroupStat` :44, `record_group` :220, `drain_group_deltas` :237, `group_hists` :136, tests :430/:451)
- Modify: `crates/engine/src/runner.rs` (Parallel arm :511-578)
- Test: `crates/engine/tests/parallel_node.rs` (`parallel_records_group_latency_sample` :196)

이 커밋 후: 분기 데이터가 엔진 내부에서 기록되지만 워커가 proto에 forward 안 함(proto 필드 없음) → 와이어로 안 나감. 워커는 `g.branch`를 참조 안 하므로 컴파일 green.

- [ ] **Step 1: `group_hists` 키를 `(step_id, branch)`로 (aggregator.rs:136)**

```rust
    /// per-parallel-node accumulating page-load latency + sample count (A2-2);
    /// keyed by (step_id, branch) — branch = "" is the page (whole concurrent block),
    /// branch = <name> is one parallel branch's wall-clock (per-branch breakdown).
    group_hists: HashMap<(String, String), (Histogram<u64>, u64)>,
```

- [ ] **Step 2: `record_group` 시그니처에 `branch` (aggregator.rs:218-233)**

기존을 통째로 교체:

```rust
    /// Record one parallel-node latency sample (µs). HDR-accumulating, unconditional
    /// (no cap). branch = "" → page (whole concurrent block); branch = <name> → that
    /// branch's wall-clock. One sample per (node, branch) per clean iteration.
    pub fn record_group(&mut self, step_id: &str, branch: &str, latency_us: u64) {
        let v = latency_us.clamp(1, 60_000_000);
        let e = self
            .group_hists
            .entry((step_id.to_string(), branch.to_string()))
            .or_insert_with(|| {
                (
                    Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).expect("valid bounds"),
                    0,
                )
            });
        let _ = e.0.record(v);
        e.1 += 1;
    }
```

- [ ] **Step 3: `GroupStat`에 `branch` (aggregator.rs:44-48) + `drain_group_deltas` (aggregator.rs:237-246)**

`GroupStat` 구조체:

```rust
pub struct GroupStat {
    pub step_id: String, // the `parallel` node's id
    pub branch: String,  // "" = page (whole block), else the branch name
    pub histogram: Histogram<u64>,
    pub count: u64,
}
```

`drain_group_deltas`:

```rust
    pub fn drain_group_deltas(&mut self) -> Vec<GroupStat> {
        std::mem::take(&mut self.group_hists)
            .into_iter()
            .map(|((step_id, branch), (histogram, count))| GroupStat {
                step_id,
                branch,
                histogram,
                count,
            })
            .collect()
    }
```

- [ ] **Step 4: runner Parallel arm — 분기 future가 `branch_us` 반환 (runner.rs:521-542)**

`futs` 클로저의 `async move` 블록을 교체(`Instant::now()`로 `Box::pin(...).await`만 감싸 분기 wall-clock 측정):

```rust
                let futs = par.branches.iter().zip(seeds).map(|(branch, seed)| {
                    let mut branch_vars = entry.clone();
                    let mut branch_rng = StdRng::seed_from_u64(seed);
                    async move {
                        let bt0 = Instant::now();
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
                            measure_phases,
                        ))
                        .await;
                        let branch_us = bt0.elapsed().as_micros() as u64;
                        (branch, branch_vars, flow, branch_us)
                    }
                });
```

- [ ] **Step 5: runner merge 루프에서 분기 샘플 수집 + clean-block 일괄 기록 (runner.rs:553-572)**

기존 merge 루프 + `record_group` 호출을 교체. **핵심: `results`는 by-value로 소비되므로 분기 샘플을 루프 *안에서* 수집**:

```rust
                let mut aborted = false;
                let mut deadline_hit = false;
                let mut branch_samples: Vec<(String, u64)> = Vec::new();
                for (branch, branch_vars, flow, branch_us) in results {
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
                    branch_samples.push((branch.name.clone(), branch_us));
                }
                // Record page-load latency only on a clean block — a deadline/abort cut a
                // branch short (skipped steps → too-fast block), which would skew the
                // distribution low. Same caution as loop partial-iteration counting.
                // Page (branch="") + every branch recorded together under the same gate so
                // each branch row's count == the page row's count.
                if !aborted && !deadline_hit {
                    let mut a = agg.lock().await;
                    a.record_group(&par.id, "", elapsed_us);
                    for (name, us) in &branch_samples {
                        a.record_group(&par.id, name, *us);
                    }
                }
                if aborted {
                    return Ok(StepFlow::Aborted);
                }
                if deadline_hit {
                    return Ok(StepFlow::DeadlineReached);
                }
```

- [ ] **Step 6: aggregator 단위 테스트 갱신 (aggregator.rs:430-458)**

`record_group_accumulates_and_drains_as_delta`를 교체(branch 차원 검증):

```rust
    #[test]
    fn record_group_accumulates_and_drains_as_delta() {
        let mut a = Aggregator::new(0); // cap irrelevant to group latency
        a.record_group("p1", "", 100_000); // page 100 ms
        a.record_group("p1", "", 300_000); // page 300 ms
        a.record_group("p1", "a", 100_000); // branch a
        a.record_group("p2", "", 50_000); // page
        let mut by: std::collections::HashMap<(String, String), (u64, u64)> = Default::default();
        for g in a.drain_group_deltas() {
            by.insert((g.step_id.clone(), g.branch.clone()), (g.count, g.histogram.max()));
        }
        assert_eq!(by.get(&("p1".into(), "".into())).map(|x| x.0), Some(2), "p1 page 2 samples");
        assert_eq!(by.get(&("p1".into(), "a".into())).map(|x| x.0), Some(1), "p1 branch a 1 sample");
        assert_eq!(by.get(&("p2".into(), "".into())).map(|x| x.0), Some(1), "p2 page 1 sample");
        assert!(by[&("p1".into(), "".into())].1 >= 290_000, "p1 page max ~= 300ms");
        assert!(a.drain_group_deltas().is_empty(), "drain resets group hists");
    }
```

`group_stat_serializes_histogram`의 `a.record_group("p1", 12_345);` → `a.record_group("p1", "", 12_345);`.

- [ ] **Step 7: parallel_node.rs 통합 테스트 갱신 (parallel_node.rs:232-249)**

`parallel_records_group_latency_sample`의 집계/단언 블록(`let mut total_pages` ~ 끝)을 교체:

```rust
    let mut page_count = 0u64;
    let mut page_max_us = 0u64;
    let mut branch_counts: std::collections::BTreeMap<String, u64> = Default::default();
    for f in &flushes {
        for g in &f.group_stats {
            assert_eq!(g.step_id, "01HX0000000000000000000010");
            if g.branch.is_empty() {
                page_count += g.count;
                page_max_us = page_max_us.max(g.histogram.max());
            } else {
                *branch_counts.entry(g.branch.clone()).or_default() += g.count;
            }
        }
    }
    assert!(page_count >= 1, "at least one clean page-load sample, got {page_count}");
    assert!(page_max_us >= 250_000, "page-load ~= 300ms (max not sum), got {page_max_us}µs");
    assert_eq!(
        branch_counts.keys().cloned().collect::<Vec<_>>(),
        vec!["a".to_string(), "b".to_string()],
        "both branch labels recorded"
    );
    assert_eq!(branch_counts["a"], page_count, "branch a fires once per clean page");
    assert_eq!(branch_counts["b"], page_count, "branch b fires once per clean page");
```

- [ ] **Step 8: 빌드·테스트 (RED→GREEN 로컬 확인)**

```bash
cargo test -p handicap-engine
```
Expected: `record_group_accumulates_and_drains_as_delta`·`parallel_records_group_latency_sample` 포함 전부 PASS. 워커는 `g.branch` 미참조라 `cargo build --workspace`도 green.

```bash
cargo build --workspace
```
Expected: 0 에러(워커 forwarding은 아직 branch 무시).

- [ ] **Step 9: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm (cold-build flake guard)
git add crates/engine/src/aggregator.rs crates/engine/src/runner.rs crates/engine/tests/parallel_node.rs
git commit -m "feat(engine): per-branch group latency — group_hists keyed (step_id, branch)"
git log -1 --oneline
```

---

## Task 2: proto + 워커 forwarding

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (`GroupStat` :45-49)
- Modify: `crates/worker/src/main.rs` (group_stats forwarding :282-293)
- Modify: `crates/controller/src/grpc/coordinator.rs` (**테스트** `ingest_stores_group_stats`의 `pb::GroupStat {` 리터럴 :1413 — prost exhaustive)

이 커밋 후: 분기가 엔진→워커→proto로 흐른다. 컨트롤러 ingest의 **read 변환**(`coordinator.rs:856`)은 아직 `GroupMetricRow`에 branch 필드가 없어 `gs.branch`를 무시(드롭) → DB엔 안 들어감 → 페이지 레이턴시 오염 없음. 와이어 페이지 행은 `branch=""`(proto3 default 미직렬화)라 byte-identical. **단 proto 필드 추가는 crate-wide — 컨트롤러 *테스트*의 proto literal(:1413)은 컴파일러가 강제하므로 같은 커밋에서 고쳐야 green.**

- [ ] **Step 1: proto `GroupStat.branch = 4` (coordinator.proto:45-49)**

```proto
message GroupStat {
  string step_id = 1;        // the `parallel` node's id
  bytes hdr_histogram = 2;   // hdrhistogram V2 serialized (delta since last drain)
  uint64 count = 3;          // samples in this delta
  string branch = 4;         // "" = page (whole block), else the branch name
}
```

- [ ] **Step 2: 워커 forwarding에 `branch` (main.rs:282-293)**

`filter_map` 클로저의 proto `GroupStat { ... }` literal에 `branch` 추가:

```rust
            let group_stats: Vec<GroupStat> = flush
                .group_stats
                .into_iter()
                .filter_map(|g| {
                    let hdr = g.serialize_histogram().ok()?;
                    Some(GroupStat {
                        step_id: g.step_id,
                        branch: g.branch,
                        hdr_histogram: hdr,
                        count: g.count,
                    })
                })
                .collect();
```

- [ ] **Step 3: 컨트롤러 테스트의 proto `GroupStat {` literal 수정 (coordinator.rs:1413)**

`ingest_stores_group_stats` 테스트의 `pb::GroupStat { … }` literal에 `branch` 추가(prost exhaustive — 안 고치면 `missing field 'branch'`로 `cargo test --workspace` 컴파일 실패):

```rust
            group_stats: vec![pb::GroupStat {
                step_id: "p1".to_string(),
                branch: String::new(),
                hdr_histogram: blob,
                count: 1,
            }],
```

그리고 다른 proto `GroupStat {` literal이 더 없는지 확인:

Run: `grep -rn "GroupStat {" crates/`
Expected: 엔진 `drain_group_deltas`(Task 1)·워커 forwarding(Step 2)·이 테스트(:1413) 셋뿐. ingest read 변환(`coordinator.rs:856`)은 `gs.step_id`처럼 *읽기*만 → literal 아님(Task 3에서 `GroupMetricRow`에 branch 추가). 추가 literal 있으면 `branch: …` 보강.

- [ ] **Step 4: 빌드·테스트**

```bash
cargo build --workspace && cargo test --workspace
```
Expected: 전부 PASS(기존 e2e `parallel_group_latency_report_e2e_smoke`는 page만 단언 → 여전히 green; 분기 단언은 Task 5에서 추가). 기능적 검증(branch가 와이어로 흐름)은 Task 5 e2e가 담당.

- [ ] **Step 5: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm
git add crates/proto/proto/coordinator.proto crates/worker/src/main.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(proto): GroupStat.branch=4 + worker forwards per-branch latency"
git log -1 --oneline
```

---

## Task 3: 컨트롤러 — branch 영속 + build_report 중첩 조립

**Files:**
- Modify: `crates/controller/src/store/metrics.rs` (`GroupMetricRow` :248, `insert_group_batch` :256, `group_breakdown` :277, test :754)
- Modify: `crates/controller/src/store/mod.rs` (`connect` :66-70, `ensure_*` 패턴 :143)
- Modify: `crates/controller/src/grpc/coordinator.rs` (ingest :853-862)
- Modify: `crates/controller/src/report.rs` (`GroupLatency` :124, `group_acc`+assembly :544-567, tests :1179/:1227)

이 커밋은 atomic — `GroupMetricRow.branch`(영속)와 `build_report`의 `(step_id, branch)` 키잉이 결합돼야 분기 행이 페이지 버킷을 오염 안 한다. 한 green 커밋으로.

- [ ] **Step 1: `GroupMetricRow.branch` + insert/select (metrics.rs:248-294)**

`GroupMetricRow`:

```rust
#[derive(Debug, Clone)]
pub struct GroupMetricRow {
    pub run_id: String,
    pub step_id: String, // the `parallel` node's id
    pub branch: String,  // "" = page (whole block), else the branch name
    pub hdr_histogram: Vec<u8>,
    pub count: i64,
}
```

`insert_group_batch`의 INSERT(:264-270)를 5-컬럼으로:

```rust
        sqlx::query(
            "INSERT INTO run_group_metrics(run_id,step_id,branch,hdr_histogram,count) VALUES(?,?,?,?,?)",
        )
        .bind(&r.run_id)
        .bind(&r.step_id)
        .bind(&r.branch)
        .bind(&r.hdr_histogram)
        .bind(r.count)
        .execute(&mut *tx)
        .await?;
```

`group_breakdown`(:277-293)의 SELECT + row 매핑:

```rust
pub async fn group_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<GroupMetricRow>> {
    let rows = sqlx::query(
        "SELECT step_id, branch, hdr_histogram, count FROM run_group_metrics \
         WHERE run_id = ? ORDER BY step_id, branch",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| GroupMetricRow {
            run_id: run_id.to_string(),
            step_id: r.get("step_id"),
            branch: r.get("branch"),
            hdr_histogram: r.get("hdr_histogram"),
            count: r.get("count"),
        })
        .collect())
}
```

- [ ] **Step 2: migration 0014 `ensure_run_group_metrics_branch` (store/mod.rs)**

`ensure_runs_verdict_json` 아래(또는 `ensure_*` 군집)에 추가:

```rust
/// migration 0014 (Rust-guarded): add `branch` to `run_group_metrics` for per-branch
/// parallel latency breakdown (branch="" = page). SQLite ADD COLUMN isn't idempotent,
/// so detect first (same pattern as ensure_runs_dropped). run_group_metrics is created
/// by MIGRATION_SQL_0010, so this must run after that.
async fn ensure_run_group_metrics_branch(db: &Db) -> anyhow::Result<()> {
    let has: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('run_group_metrics') WHERE name = 'branch'",
    )
    .fetch_one(db)
    .await?;
    if has == 0 {
        sqlx::query("ALTER TABLE run_group_metrics ADD COLUMN branch TEXT NOT NULL DEFAULT ''")
            .execute(db)
            .await?;
    }
    Ok(())
}
```

`connect()`의 migration 체인 끝(0013 줄 뒤, `Ok(pool)` 앞)에 wire:

```rust
    sqlx::query(MIGRATION_SQL_0013).execute(&pool).await?; // migration 0013: run_phase_metrics
    ensure_run_group_metrics_branch(&pool).await?; // migration 0014 (Rust-guarded; see fn)
    Ok(pool)
```

- [ ] **Step 3: ingest 변환에 `branch` (coordinator.rs:853-862)**

`GroupMetricRow { ... }` literal에 `branch` 추가:

```rust
    let group_rows: Vec<crate::store::metrics::GroupMetricRow> = batch
        .group_stats
        .iter()
        .map(|gs| crate::store::metrics::GroupMetricRow {
            run_id: batch.run_id.clone(),
            step_id: gs.step_id.clone(),
            branch: gs.branch.clone(),
            hdr_histogram: gs.hdr_histogram.clone(),
            count: gs.count as i64,
        })
        .collect();
```

- [ ] **Step 4: `BranchLatency` 타입 + `GroupLatency.branches` (report.rs:124-132)**

`GroupLatency` 아래에 `BranchLatency` 추가하고 `GroupLatency`에 `branches` 필드:

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct GroupLatency {
    pub step_id: String, // the `parallel` node's id
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
    /// per-branch latency nested under this parallel node (empty if no parallel branches).
    /// `#[serde(default)]` only (no skip_serializing_if) → always serialized so the UI
    /// schema can use a plain required array (no `.default()` leak).
    #[serde(default)]
    pub branches: Vec<BranchLatency>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BranchLatency {
    pub branch: String, // the parallel branch name
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}
```

- [ ] **Step 5: `group_acc` `(step_id, branch)`화 + 중첩 조립 (report.rs:544-567)**

`group_acc` 누적부터 `group_latency` collect까지를 통째로 교체:

```rust
    let mut group_acc: BTreeMap<(String, String), (Histogram<u64>, u64)> = BTreeMap::new();
    for g in groups {
        let e = group_acc
            .entry((g.step_id.clone(), g.branch.clone()))
            .or_insert_with(|| (fresh_hist(), 0));
        if let Ok(Some(h)) = decode_hdr(&g.hdr_histogram) {
            merge_into(&mut e.0, &h); // fail-soft: bad blob -> count kept, distribution skips it
        }
        e.1 += g.count as u64;
    }
    // Branch rows (branch != "") nest under their parallel node's page (branch == "").
    // BTreeMap orders "" before any branch name within each step_id, so branches sort
    // by name. A bad branch HDR blob keeps the count but skips the distribution (same
    // fail-soft as the page).
    let mut branches_by_step: BTreeMap<String, Vec<BranchLatency>> = BTreeMap::new();
    for ((step_id, branch), (h, count)) in &group_acc {
        if branch.is_empty() {
            continue;
        }
        let p = percentiles_of(h);
        branches_by_step
            .entry(step_id.clone())
            .or_default()
            .push(BranchLatency {
                branch: branch.clone(),
                count: *count,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
                max_ms: h.max() / 1_000,
            });
    }
    let group_latency: Vec<GroupLatency> = group_acc
        .iter()
        .filter(|((_, branch), _)| branch.is_empty())
        .map(|((step_id, _), (h, count))| {
            let p = percentiles_of(h);
            GroupLatency {
                step_id: step_id.clone(),
                count: *count,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
                max_ms: h.max() / 1_000,
                branches: branches_by_step.remove(step_id).unwrap_or_default(),
            }
        })
        .collect();
```

- [ ] **Step 6: store 테스트 fixture 갱신 (metrics.rs:754-778)**

`group_batch_appends_and_reads_back`를 교체(branch 영속/읽기 검증):

```rust
    #[tokio::test]
    async fn group_batch_appends_and_reads_back() {
        let db = pool().await;
        // run_group_metrics has no FK to runs, so no seed needed.
        let rows = vec![
            GroupMetricRow { run_id: "r1".into(), step_id: "p1".into(), branch: "".into(), hdr_histogram: vec![1, 2, 3], count: 4 },
            GroupMetricRow { run_id: "r1".into(), step_id: "p1".into(), branch: "".into(), hdr_histogram: vec![4, 5], count: 2 },
            GroupMetricRow { run_id: "r1".into(), step_id: "p1".into(), branch: "a".into(), hdr_histogram: vec![6], count: 1 },
        ];
        insert_group_batch(&db, &rows).await.unwrap();
        let read = group_breakdown(&db, "r1").await.unwrap();
        assert_eq!(read.len(), 3, "append-only keeps all delta rows");
        assert_eq!(
            read.iter().filter(|r| r.branch.is_empty()).map(|r| r.count).sum::<i64>(),
            6,
            "page deltas coexist"
        );
        assert!(read.iter().any(|r| r.branch == "a" && r.count == 1), "branch row persisted");
        assert!(read.iter().all(|r| r.step_id == "p1"));
    }
```

- [ ] **Step 7: build_report 테스트 — 기존 fixture 갱신 + 중첩 테스트 추가 (report.rs:1179-1232)**

`build_report_attaches_group_latency_without_polluting_summary`의 `groups` literal(:1192-1197)에 `branch: "".into()`을 추가하고, 단언에 `assert!(g.branches.is_empty());`를 `assert_eq!(rep.group_latency.len(), 1);` 아래에 삽입:

```rust
        let groups = vec![GroupMetricRow {
            run_id: r.id.clone(),
            step_id: "01HX0000000000000000000010".into(),
            branch: "".into(),
            hdr_histogram: make_hdr_bytes(&[300_000, 305_000, 295_000]),
            count: 3,
        }];
```
```rust
        assert_eq!(rep.group_latency.len(), 1);
        assert!(rep.group_latency[0].branches.is_empty(), "no branch rows → empty branches");
```

`build_report_empty_groups_yields_empty_group_latency` 아래에 새 테스트 추가:

```rust
    #[test]
    fn build_report_nests_branch_latency_under_page() {
        use crate::store::metrics::GroupMetricRow;
        let r = run_row();
        let rows = vec![win(100, "01HX0000000000000000000011", 10, 0, r#"{"200":10}"#, &[5_000])];
        let par = "01HX0000000000000000000010";
        let groups = vec![
            GroupMetricRow { run_id: r.id.clone(), step_id: par.into(), branch: "".into(), hdr_histogram: make_hdr_bytes(&[300_000, 300_000]), count: 2 },
            GroupMetricRow { run_id: r.id.clone(), step_id: par.into(), branch: "a".into(), hdr_histogram: make_hdr_bytes(&[300_000, 300_000]), count: 2 },
            GroupMetricRow { run_id: r.id.clone(), step_id: par.into(), branch: "b".into(), hdr_histogram: make_hdr_bytes(&[50_000, 50_000]), count: 2 },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(&r, &yaml, &rows, &[], &[], &groups, &[]);

        assert_eq!(rep.group_latency.len(), 1, "one parallel node → one page entry");
        let g = &rep.group_latency[0];
        assert_eq!(g.step_id, par);
        assert_eq!(g.count, 2, "page count = clean iterations, not summed branches");
        assert_eq!(g.branches.len(), 2, "two branches nested");
        assert_eq!(g.branches[0].branch, "a", "branches sorted by name");
        assert_eq!(g.branches[1].branch, "b");
        assert_eq!(g.branches[0].count, 2, "each branch fires once per clean page");
        assert!(g.branches[0].p50_ms >= 290, "branch a ~300ms (bottleneck), got {}", g.branches[0].p50_ms);
        assert!(g.branches[1].p50_ms <= 60, "branch b ~50ms (fast), got {}", g.branches[1].p50_ms);
        assert_eq!(rep.summary.count, 10, "branches+page excluded from summary count");
        // typed round-trip (report types require Deserialize too).
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }
```

- [ ] **Step 8: 빌드·테스트 (RED→GREEN 로컬)**

```bash
cargo test -p handicap-controller
```
Expected: `group_batch_appends_and_reads_back`·`build_report_nests_branch_latency_under_page`·`build_report_attaches_group_latency_without_polluting_summary` 포함 PASS. e2e smoke(page만 단언)도 PASS(분기 단언은 Task 5).

```bash
cargo build --workspace
```
Expected: 0 에러.

- [ ] **Step 9: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm
git add crates/controller/src/store/metrics.rs crates/controller/src/store/mod.rs crates/controller/src/grpc/coordinator.rs crates/controller/src/report.rs
git commit -m "feat(controller): persist per-branch group latency + nest under GroupLatency.branches (migration 0014)"
git log -1 --oneline
```

---

## Task 4: UI — 분기 sub-행 렌더

**Files:**
- Modify: `ui/src/api/schemas.ts` (`GroupLatencySchema` :260에 `branches` + 신규 `BranchLatencySchema` — `ReportSchema.group_latency` :341은 `.optional()` 그대로, 변경 없음)
- Modify: `ui/src/components/report/GroupLatencyTable.tsx`
- Test: `ui/src/components/report/__tests__/GroupLatencyTable.test.tsx`

- [ ] **Step 1: Zod 스키마 — `BranchLatencySchema` + `GroupLatencySchema.branches` (schemas.ts:260-270)**

`GroupLatencySchema` 위에 `BranchLatencySchema`를 추가하고 `GroupLatencySchema`에 `branches`(plain required — 서버가 항상 emit):

```ts
export const BranchLatencySchema = z
  .object({
    branch: z.string(),
    count: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
    max_ms: z.number().int().nonnegative(),
  })
  .strict();
export type BranchLatency = z.infer<typeof BranchLatencySchema>;

export const GroupLatencySchema = z
  .object({
    step_id: z.string(),
    count: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
    max_ms: z.number().int().nonnegative(),
    branches: z.array(BranchLatencySchema),
  })
  .strict();
export type GroupLatency = z.infer<typeof GroupLatencySchema>;
```

- [ ] **Step 2: 다른 group_latency fixture에 `branches: []` (필수 필드라 컴파일 강제)**

Run: `grep -rn "group_latency\|GroupLatency\b" ui/src --include=*.ts --include=*.tsx -l`
group_latency 항목을 직접 만드는 테스트 fixture가 있으면(예: RunDetailPage/report 테스트) 각 항목에 `branches: []` 추가. `pnpm build`(`tsc -b`)가 누락을 잡는다(Step 6에서 확인).

- [ ] **Step 3: 테스트 갱신 — 분기 sub-행 (GroupLatencyTable.test.tsx)**

파일 전체를 교체(기존 fixture에 `branches: []` 추가 + 분기 렌더 케이스 추가):

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { GroupLatencyTable } from "../GroupLatencyTable";
import type { GroupLatency } from "../../../api/schemas";

const rows: GroupLatency[] = [
  {
    step_id: "p1",
    count: 42,
    p50_ms: 300,
    p95_ms: 420,
    p99_ms: 500,
    max_ms: 610,
    branches: [
      { branch: "feed", count: 42, p50_ms: 300, p95_ms: 410, p99_ms: 480, max_ms: 600 },
      { branch: "user", count: 42, p50_ms: 40, p95_ms: 60, p99_ms: 70, max_ms: 90 },
    ],
  },
];

describe("GroupLatencyTable", () => {
  it("renders a page row plus a sub-row per branch", () => {
    render(<GroupLatencyTable breakdown={rows} meta={new Map([["p1", { name: "page load" }]])} />);
    expect(screen.getByRole("region", { name: "Page load latency" })).toBeInTheDocument();
    expect(screen.getByText("page load")).toBeInTheDocument();
    expect(screen.getByText("420")).toBeInTheDocument(); // page p95
    expect(screen.getByText("610")).toBeInTheDocument(); // page max
    expect(screen.getByRole("columnheader", { name: "p95 ms" })).toBeInTheDocument();
    // branch sub-rows: labels = branch names, distinct latencies
    expect(screen.getByText(/feed/)).toBeInTheDocument();
    expect(screen.getByText(/user/)).toBeInTheDocument();
    expect(screen.getByText("600")).toBeInTheDocument(); // feed branch max (bottleneck)
    expect(screen.getByText("90")).toBeInTheDocument(); // user branch max (fast)
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

- [ ] **Step 4: 테스트 RED 확인**

Run: `cd ui && pnpm test GroupLatencyTable`
Expected: FAIL("feed"/"user" sub-행 미렌더).

- [ ] **Step 5: `GroupLatencyTable` — 분기 sub-행 (GroupLatencyTable.tsx)**

파일 전체를 교체:

```tsx
import { Fragment } from "react";
import type { GroupLatency } from "../../api/schemas";

type GroupMeta = { name: string };
type Props = { breakdown: GroupLatency[]; meta: Map<string, GroupMeta> };

/** Page-load latency per `parallel` node = wall-clock of the concurrent block
 *  (≈ max of branches), aggregated run-total, with a sub-row per branch
 *  (branch's own wall-clock) so the bottleneck concurrent call is visible. Separate
 *  from StepStatsTable because the parallel node's id is not an http-leaf metric row. */
export function GroupLatencyTable({ breakdown, meta }: Props) {
  if (breakdown.length === 0) return null;
  return (
    <section aria-label="Page load latency" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Page load latency</h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">Parallel node / branch</th>
            <th className="py-2 pr-4 font-medium">Count</th>
            <th className="py-2 pr-4 font-medium">p50 ms</th>
            <th className="py-2 pr-4 font-medium">p95 ms</th>
            <th className="py-2 pr-4 font-medium">p99 ms</th>
            <th className="py-2 pr-4 font-medium">max ms</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((g) => {
            const m = meta.get(g.step_id);
            return (
              <Fragment key={g.step_id}>
                <tr className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">
                    {m?.name ?? g.step_id} <span className="text-slate-400">(parallel)</span>
                  </td>
                  <td className="py-2 pr-4">{g.count}</td>
                  <td className="py-2 pr-4">{g.p50_ms}</td>
                  <td className="py-2 pr-4">{g.p95_ms}</td>
                  <td className="py-2 pr-4">{g.p99_ms}</td>
                  <td className="py-2 pr-4">{g.max_ms}</td>
                </tr>
                {g.branches.map((b) => (
                  <tr key={`${g.step_id}:${b.branch}`} className="border-b border-slate-100 text-slate-600">
                    <td className="py-2 pr-4 pl-6">↳ {b.branch}</td>
                    <td className="py-2 pr-4">{b.count}</td>
                    <td className="py-2 pr-4">{b.p50_ms}</td>
                    <td className="py-2 pr-4">{b.p95_ms}</td>
                    <td className="py-2 pr-4">{b.p99_ms}</td>
                    <td className="py-2 pr-4">{b.max_ms}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 6: 테스트 GREEN + 게이트**

```bash
cd ui && pnpm test GroupLatencyTable
```
Expected: 3 케이스 PASS.

```bash
cd ui && pnpm lint && pnpm test && pnpm build
```
Expected: lint 0 경고, 전체 test PASS, `tsc -b` 0 에러(Step 2의 fixture 누락이 있으면 여기서 잡힘 → 추가 후 재실행).

- [ ] **Step 7: 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # warm (UI 커밋도 cargo 훅 통과)
git add ui/src/api/schemas.ts ui/src/components/report/GroupLatencyTable.tsx ui/src/components/report/__tests__/GroupLatencyTable.test.tsx
git commit -m "feat(ui): per-branch latency sub-rows in GroupLatencyTable"
git log -1 --oneline
```

---

## Task 5: e2e smoke — 분기 행 단언

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs` (`parallel_group_latency_report_e2e_smoke` 단언부)

- [ ] **Step 1: 분기 단언 추가 (e2e_test.rs)**

이 테스트엔 **이미 `(e)`(steps[] 검사 :2174)·`(f)`(summary :2187) 블록이 있다** → 새 블록은 **`(f)` 블록 뒤에 `(g)`로 추가**(renumber 회피). `entry`(:2153)·`count`(:2161)는 fn-body let이라 끝까지 스코프에 있다:

```rust
    // (g) branches: per-branch latency nested under the page. Two branches (a, b),
    //     each recorded once per clean page-load → branch count == page count.
    let branches = entry["branches"]
        .as_array()
        .expect("group_latency[0].branches array present");
    assert_eq!(branches.len(), 2, "two parallel branches → two branch entries; got: {branches:?}");
    let mut names: Vec<&str> = branches.iter().map(|b| b["branch"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, vec!["a", "b"], "branch labels must be the branch names");
    for b in branches {
        assert_eq!(
            b["count"].as_u64().unwrap(),
            count,
            "each branch fires once per clean page → branch count == page count"
        );
        assert!(
            b["max_ms"].as_u64().unwrap() > 0,
            "20ms branch delay → branch max_ms > 0"
        );
    }
```

- [ ] **Step 2: e2e 실행**

```bash
cargo build -p handicap-worker   # off-runtime worker build (cold-build flake guard)
cargo test -p handicap-controller --test e2e_test parallel_group_latency_report_e2e_smoke -- --nocapture
```
Expected: PASS(분기 a/b 각 count == 페이지 count, max_ms > 0). flake(워커 race)면 재시도.

- [ ] **Step 3: 전체 게이트 + 커밋**

```bash
cargo build --workspace && cargo test --workspace
git add crates/controller/tests/e2e_test.rs
git commit -m "test(e2e): per-branch latency assertions in parallel_group_latency smoke"
git log -1 --oneline
```

---

## Task 6: 라이브 검증 + 브랜치 마무리

머지 전 필수 라이브 검증(S-D 갭 차단 — RTL/`tsc -b`가 못 잡는 응답-파싱·실측정 경로).

- [ ] **Step 1: 컨트롤러+워커 기동 (격리 DB, 자체 바이너리)**

```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
cd ui && pnpm build && cd ..
rm -f /tmp/perbranch.db
./target/debug/controller --db /tmp/perbranch.db --ui-dir ui/dist &
```

- [ ] **Step 2: 느린/빠른 분기 echo 타깃 + parallel 시나리오로 run**

python `ThreadingHTTPServer`로 `/slow`(200ms sleep)·`/fast`(즉시) 200 응답 서버를 띄우고, top-level `type: parallel` 2-분기(slow, fast) 시나리오를 `POST /api/scenarios` → `POST /api/runs {"scenario_id":…,"profile":{"vus":2,"duration_seconds":5},"env":{}}`. (시나리오 YAML 작성·생성응답 파싱 함정은 루트 CLAUDE.md "로컬 dev 실행 함정" — 생성응답 대신 `GET /api/scenarios/{id}/runs`로 run id 재조회, curl→python 직결.)

- [ ] **Step 3: 리포트 검증**

terminal 후 `GET /api/runs/{run_id}/report`를 curl→python 직결로 파싱해 확인:
- `group_latency[0].branches` 2개(slow, fast).
- slow 분기 p50 ≈ 200ms, fast 분기 p50 ≈ 0–몇 ms (병목 분기 가려짐).
- 페이지 p50 ≈ max(분기) ≈ 200ms.
- 각 분기 `count` == 페이지 `count`.
- `summary.count` = 페이지/분기에 오염 안 됨(http 요청 수만).

- [ ] **Step 4: UI 라운드트립(선택, Playwright 인라인)**

리포트 페이지에서 "Page load latency" 섹션에 페이지 행 + 들여쓴 slow/fast sub-행이 보이고 콘솔 Zod 에러 0. `browser_evaluate`로 테이블 행 텍스트 추출(저장-경로 의존 회피, 루트 CLAUDE.md Playwright cwd 함정). 검증 후 `.playwright-mcp`·루트 png 정리.

- [ ] **Step 5: 프로세스 정리 + 최종 게이트**

```bash
# controller/worker/python echo 종료(lsof -i :8080 로 PID 확인)
cargo test --workspace
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
```
Expected: 전부 green.

- [ ] **Step 6: 최종 whole-feature 리뷰 → 머지**

`handicap-reviewer` 에이전트로 전체 diff 리뷰(와이어 1:1: 엔진 GroupStat ↔ proto ↔ store ↔ report ↔ Zod, deferral 추적, 게이트 재확인). READY-TO-MERGE면 `superpowers:finishing-a-development-branch`로 master ff-merge(워크트리면 루트 CLAUDE.md git 토폴로지 절차) + build-log/roadmap/status/메모리 갱신.

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: §4.1 엔진(T1)·§4.2 runner(T1)·§4.3 proto+워커(T2)·§4.4 store(T3)·§4.4b ingest(T3 Step3)·§4.5 build_report(T3)·§4.6 리포트 스키마+리터럴(T3 Step4/7)·§4.7 UI(T4)·§6 테스트(각 task)·§7 빈 번호(migration 0014=T3, proto branch=4=T2) 전부 task 매핑됨. §2.2 제외 항목(phase/오류/trace/중첩)은 어느 task도 안 건드림(범위 준수).
- **Placeholder**: 모든 코드 블록은 실제 코드. "TODO"/"적절히" 없음.
- **타입 일관성**: `record_group(step_id, branch, latency)`·`GroupStat{step_id,branch,histogram,count}`·`GroupMetricRow{...,branch,...}`·`GroupLatency.branches: Vec<BranchLatency>`·`BranchLatency{branch,count,p50_ms,p95_ms,p99_ms,max_ms}`·Zod `BranchLatencySchema`가 T1→T4 전반 동일.
- **커밋 경계**: 각 task = 1 green 커밋(workspace 게이트 호환). T1(엔진, 워커 branch 무시)·T2(proto+워커, 컨트롤러 ingest 드롭)·T3(컨트롤러 atomic, 오염 윈도 없음)·T4(UI)·T5(e2e)는 순차로 각자 green.
