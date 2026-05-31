# Slice 9d — 분기 메트릭 breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-`if`-node **branch-decision count** breakdown to the run report — how many times each `if` selected `then` / `elif_n` / `else` / `none` — surfaced as a dedicated "Branch decisions" table in the report UI.

**Architecture:** Mirror the Slice 7-1 loop-breakdown pipeline (engine `Aggregator` delta counts → `MetricFlush` → proto `MetricBatch` → controller `run_if_metrics` UPSERT-accumulate → `ReportJson` → UI drill-down), with three deliberate departures forced by the data model: (1) branch counts are keyed by the **`if` node id**, not an http leaf (the `if` id never appears in `report.steps`, which is built purely from http-leaf metrics); (2) they are **counts-only — no `error_count`** (a branch *decision* is not a request and cannot error); (3) there is **no cap / overflow sentinel** (the branch set per `if` is finite). Because `if`-node ids are not report rows, the breakdown is surfaced as a **new top-level `ReportJson.if_breakdown` array** and rendered in a **separate `BranchStatsTable`** below the existing step table — *not* on `ReportStep` as the spec §7 literally wrote. The `none` branch (no condition matched **and** else is empty/absent) is the whole reason a dedicated counter exists: it has no http leaf to attach to.

**Tech Stack:** Rust (engine `aggregator.rs`/`runner.rs`, controller axum + sqlx SQLite + tonic/prost gRPC), protobuf, TypeScript/React (Vite + Zod + React Query + vitest/RTL).

---

## Repo conventions the executor MUST know (read before Task 1)

- **Git topology:** integration branch is `master` (no `main`, no remote). Work in a worktree; finish with local rebase + `--ff-only` merge to `master`. (Root CLAUDE.md "git 토폴로지".)
- **Worktree baseline:** a fresh `EnterWorktree` worktree has **no `ui/node_modules` and no `target/`**. Before running tests, run `cd ui && pnpm install` and `cargo build` once to establish a baseline. (Root CLAUDE.md "Subagent dispatch 노하우".)
- **Pre-commit hook** runs `cargo fmt --check + build + clippy -D warnings + test` on every commit (skipped only for `.md`-only commits). **It does NOT run UI checks** — for any task touching `ui/`, run `cd ui && pnpm test && pnpm build` (the `tsc -b` gate) **manually before committing**. (Root CLAUDE.md "검증 자동화".)
- **tdd-guard** (`.claude/hooks/tdd-guard.sh`) blocks Write/Edit on `crates/*/src/*.rs` or `ui/src/*.{ts,tsx}` unless the working tree has a **pending test file** (or the edited file has an inline `#[cfg(test)] mod tests`). Each task below orders its **test step first** to satisfy this. For two wiring edits with no natural unit test (worker `main.rs`, controller `grpc/coordinator.rs`), create a throwaway compile-only `crates/<x>/tests/<name>_wiring.rs` to unblock, then **`rm` it before committing** — the e2e (Task 11) is the real coverage. (Root CLAUDE.md "검증 자동화".)
- **prost types are exhaustive:** adding a proto field breaks every struct literal of that message (no `..Default::default()`). (controller CLAUDE.md.)
- **ULIDs in fixtures** must avoid `I/L/O/U` (Crockford base32). Reuse the existing `01HX00000000000000000000NN` ids in `crates/engine/tests/if_node.rs`. (engine CLAUDE.md.)

---

## File structure

**Create:**
- `crates/controller/src/store/migrations/0005_run_if_metrics.sql` — branch-decision table (PK `run_id, step_id, branch`, counts-only).
- `ui/src/components/report/BranchStatsTable.tsx` — separate "Branch decisions" caret-drill-down table.
- `ui/src/components/report/__tests__/BranchStatsTable.test.tsx` — its RTL tests.
- `ui/src/api/schemas.test.ts` — drives the `if_breakdown` Zod schema (Task 8 tdd-guard + contract).

**Modify:**
- `crates/engine/src/aggregator.rs` — `BranchStat` type, `branch_counts` map, `record_branch`, `drain_branch_deltas`, unit tests.
- `crates/engine/src/lib.rs` — re-export `BranchStat`.
- `crates/engine/src/runner.rs` — `MetricFlush.branch_stats`, flusher + final-flush drain, `Step::If` arm records the chosen branch.
- `crates/engine/tests/if_node.rs` — integration tests draining `branch_stats`.
- `crates/proto/proto/coordinator.proto` — `BranchStat` message + `MetricBatch.branch_stats = 5`.
- `crates/worker/src/main.rs` — convert engine `BranchStat` → proto, extend the empty-batch guard + `MetricBatch` literal.
- `crates/controller/src/store/mod.rs` — register migration 0005.
- `crates/controller/src/store/metrics.rs` — `IfBranchRow`, `insert_if_branch_batch`, `if_breakdown`, unit test.
- `crates/controller/src/grpc/coordinator.rs` — ingest `batch.branch_stats`.
- `crates/controller/src/report.rs` — `IfBranchBucket`/`IfBreakdown` structs, `ReportJson.if_breakdown`, `build_report` new param + assembly, unit test.
- `crates/controller/src/api/runs.rs` — report endpoint fetches + passes `if_breakdown`.
- `crates/controller/tests/e2e_test.rs` — e2e smoke for an if-scenario report.
- `ui/src/api/schemas.ts` — `IfBranchBucketSchema`/`IfBreakdownSchema`/types + `ReportSchema.if_breakdown`.
- `ui/src/components/report/ReportView.tsx` — build `ifMeta`, render `BranchStatsTable`.
- `ui/src/components/report/__tests__/ReportView.test.tsx` — assert the Branch decisions section.
- `docs/adr/0023-conditional-node.md`, root `CLAUDE.md`, `crates/engine/CLAUDE.md`, `crates/controller/CLAUDE.md`, `ui/CLAUDE.md`, `docs/roadmap.md`, the spec status line, and `~/.claude/.../memory/MEMORY.md` — Task 12.

---

## Task 1: Engine aggregator — branch-decision counter

**Files:**
- Modify: `crates/engine/src/aggregator.rs` (struct + methods + tests)
- Modify: `crates/engine/src/lib.rs:12` (re-export)

`aggregator.rs` already has an inline `#[cfg(test)] mod tests`, so tdd-guard passes; still write the test first (TDD).

- [ ] **Step 1: Write the failing tests**

In `crates/engine/src/aggregator.rs`, inside `mod tests` (after `drain_loop_deltas_resets_between_drains`, before the closing `}`), add:

```rust
    #[test]
    fn branch_counts_accumulate_per_if_and_branch() {
        // cap is irrelevant to branch counting — pass 0 to prove independence.
        let mut a = Aggregator::new(0);
        a.record_branch("if1", "then");
        a.record_branch("if1", "then");
        a.record_branch("if1", "elif_0");
        a.record_branch("if2", "none");
        let m: std::collections::HashMap<(String, String), u64> = a
            .drain_branch_deltas()
            .into_iter()
            .map(|b| ((b.step_id, b.branch), b.count))
            .collect();
        assert_eq!(m.get(&("if1".into(), "then".into())), Some(&2));
        assert_eq!(m.get(&("if1".into(), "elif_0".into())), Some(&1));
        assert_eq!(m.get(&("if2".into(), "none".into())), Some(&1));
    }

    #[test]
    fn drain_branch_deltas_resets_between_drains() {
        let mut a = Aggregator::new(0);
        a.record_branch("if1", "then");
        assert_eq!(a.drain_branch_deltas().len(), 1);
        assert!(
            a.drain_branch_deltas().is_empty(),
            "second drain empty (delta reset)"
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p handicap-engine --lib branch`
Expected: FAIL — `no method named record_branch` / `cannot find type BranchStat`.

- [ ] **Step 3: Add the `BranchStat` type**

In `crates/engine/src/aggregator.rs`, after the `LoopCount` struct (line ~25, before `StepWindow`), add:

```rust
/// A per-(if_id, branch) decision-count delta since the last drain. Branch metrics
/// are **decision counts** (which branch an `if` selected), not request counts — a
/// decision has no request and no error, so there is deliberately no `error_count`
/// here (contrast `LoopStat`). The `none` branch (no match + empty/absent else) is the
/// whole reason this is a dedicated counter: it has no http leaf to attach to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchStat {
    pub step_id: String, // the `if` node's id
    pub branch: String,  // "then" | "elif_0".. | "else" | "none"
    pub count: u64,
}
```

- [ ] **Step 4: Add the `branch_counts` field + constructor init**

In the `Aggregator` struct (line ~74), add the field after `loop_cap`:

```rust
#[derive(Debug, Default)]
pub struct Aggregator {
    windows: HashMap<(String, i64), StepWindow>,
    loop_counts: HashMap<(String, u32), LoopCount>,
    loop_cap: u32,
    branch_counts: HashMap<(String, String), u64>,
}
```

In `Aggregator::new` (line ~82), add the field to the literal:

```rust
    pub fn new(loop_breakdown_cap: u32) -> Self {
        Self {
            windows: HashMap::new(),
            loop_counts: HashMap::new(),
            loop_cap: loop_breakdown_cap,
            branch_counts: HashMap::new(),
        }
    }
```

- [ ] **Step 5: Add `record_branch` + `drain_branch_deltas`**

Immediately after `drain_loop_deltas` (line ~132), add:

```rust
    /// Record one branch decision for an `if` node. Unconditional (no cap): the branch
    /// set per `if` node is finite (then + #elif + else/none), unlike `loop_index`.
    pub fn record_branch(&mut self, step_id: &str, branch: &str) {
        *self
            .branch_counts
            .entry((step_id.to_string(), branch.to_string()))
            .or_default() += 1;
    }

    /// Take and reset the accumulated per-(if_id, branch) decision deltas.
    pub fn drain_branch_deltas(&mut self) -> Vec<BranchStat> {
        std::mem::take(&mut self.branch_counts)
            .into_iter()
            .map(|((step_id, branch), count)| BranchStat {
                step_id,
                branch,
                count,
            })
            .collect()
    }
```

- [ ] **Step 6: Re-export from the crate root**

In `crates/engine/src/lib.rs:12`, change:

```rust
pub use aggregator::{Aggregator, LoopStat, StepWindow};
```
to:
```rust
pub use aggregator::{Aggregator, BranchStat, LoopStat, StepWindow};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p handicap-engine --lib branch`
Expected: PASS (both new tests + existing aggregator tests unaffected).

- [ ] **Step 8: Commit**

```bash
git add crates/engine/src/aggregator.rs crates/engine/src/lib.rs
git commit -m "feat(engine): add per-(if,branch) decision counter to Aggregator (9d)"
```

---

## Task 2: Engine runner — `MetricFlush.branch_stats` + `Step::If` records the branch

**Files:**
- Modify: `crates/engine/src/runner.rs:11` (import), `:32-36` (struct), `:130-150` (flusher), `:164-175` (final flush), `:335-372` (If arm)
- Test: `crates/engine/tests/if_node.rs`

`runner.rs` has no inline tests, so the integration test in `if_node.rs` (a `tests/` file) is written **first** to unblock tdd-guard.

- [ ] **Step 1: Write the failing integration tests**

In `crates/engine/tests/if_node.rs`, add the `IF_ID` const next to the existing ids (after line 28):

```rust
const IF_ID: &str = "01HX0000000000000000000001";
```

Add a branch-draining helper after `run_and_count` (after line 56):

```rust
/// Run the scenario for one VU / short window, return (if_id, branch) -> total decisions.
async fn run_and_branches(yaml: &str) -> HashMap<(String, String), u64> {
    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(400),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        data_binding: None,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel).await });
    let mut branches: HashMap<(String, String), u64> = HashMap::new();
    while let Some(f) = rx.recv().await {
        for b in f.branch_stats {
            *branches.entry((b.step_id, b.branch)).or_default() += b.count;
        }
    }
    run.await.expect("join").expect("run ok");
    branches
}
```

Add two tests at the end of the file (before the final closing brace, if any — this file is flat so append at EOF):

```rust
#[tokio::test]
async fn branch_metrics_record_then_when_cond_true() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/then"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    // top cond always true ("x" eq "x"); elif cond never true.
    let cond = r#"{ left: "x", op: eq, right: "x" }"#;
    let elif_cond = r#"{ left: "x", op: eq, right: "y" }"#;
    let yaml = scenario_yaml(&server.uri(), cond, elif_cond);
    let b = run_and_branches(&yaml).await;
    let then: u64 = b
        .iter()
        .filter(|((id, br), _)| id == IF_ID && br == "then")
        .map(|(_, c)| *c)
        .sum();
    assert!(then > 0, "then branch decisions recorded");
    assert!(
        !b.keys()
            .any(|(id, br)| id == IF_ID && (br == "else" || br == "elif_0")),
        "only the then branch should be taken"
    );
}

#[tokio::test]
async fn branch_metrics_record_none_when_no_match_and_no_else() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/then"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    // if with only `then`, cond false, NO elif, NO else → "none".
    let base = server.uri();
    let yaml = format!(
        r#"
version: 1
name: nonebranch
variables:
  base: "{base}"
steps:
  - id: "{IF_ID}"
    name: branch
    type: if
    cond: {{ left: "1", op: eq, right: "2" }}
    then:
      - id: "{THEN_ID}"
        name: then-step
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/then" }}
        assert: [ {{ status: 200 }} ]
"#
    );
    let b = run_and_branches(&yaml).await;
    let none: u64 = b
        .iter()
        .filter(|((id, br), _)| id == IF_ID && br == "none")
        .map(|(_, c)| *c)
        .sum();
    assert!(none > 0, "none branch (no match + no else) recorded");
    assert_eq!(
        b.keys().filter(|(id, br)| id == IF_ID && br == "then").count(),
        0,
        "then must not be recorded when cond is false"
    );
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p handicap-engine --test if_node branch_metrics`
Expected: FAIL — `no field branch_stats on MetricFlush` (compile error).

- [ ] **Step 3: Add `branch_stats` to `MetricFlush` + import**

In `crates/engine/src/runner.rs:11`, change:
```rust
use crate::aggregator::{Aggregator, LoopStat, StepWindow};
```
to:
```rust
use crate::aggregator::{Aggregator, BranchStat, LoopStat, StepWindow};
```

In the `MetricFlush` struct (lines 32-36), add the field:
```rust
#[derive(Debug)]
pub struct MetricFlush {
    pub windows: Vec<StepWindow>,
    pub loop_stats: Vec<LoopStat>,
    pub branch_stats: Vec<BranchStat>,
}
```

- [ ] **Step 4: Drain branch deltas in the flusher**

Replace the flusher drain block (current lines 130-150) with the following. **Stop before the `if flush_out.is_closed() { break; }` at lines 151-153 — leave that check intact:**

```rust
            let (drained, loop_stats, branch_stats) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                )
            };
            if !drained.is_empty() || !loop_stats.is_empty() || !branch_stats.is_empty() {
                debug!(
                    count = drained.len(),
                    loops = loop_stats.len(),
                    branches = branch_stats.len(),
                    "flushing windows"
                );
                if flush_out
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
```

- [ ] **Step 5: Drain branch deltas in the final flush**

Replace the final-flush block (current lines 164-175) with:

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
            })
            .await;
    }
```

- [ ] **Step 6: Record the chosen branch in the `Step::If` arm**

Replace the entire `Step::If(if_step) => { ... }` arm (current lines 335-372) with:

```rust
            Step::If(if_step) => {
                // Pick the branch AND label which one (for branch-decision metrics, 9d).
                // `ctx` borrows `iter_vars` immutably; scope it in a block so the borrow
                // ends before the recursive call takes `iter_vars` by &mut. `taken`
                // borrows the scenario (`if_step`), `branch` is owned.
                let (taken, branch): (&[Step], String) = {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env: env.as_ref(),
                        vu_id,
                        iter_id,
                        loop_index,
                    };
                    if eval_condition(&if_step.cond, &ctx) {
                        (if_step.then_.as_slice(), "then".to_string())
                    } else {
                        // Default: "else" when it has a body, "none" when no branch
                        // matched and else is empty/absent (spec §7). An elif match
                        // overrides this below.
                        let mut sel: (&[Step], String) = if if_step.else_.is_empty() {
                            (if_step.else_.as_slice(), "none".to_string())
                        } else {
                            (if_step.else_.as_slice(), "else".to_string())
                        };
                        for (j, e) in if_step.elif.iter().enumerate() {
                            if eval_condition(&e.cond, &ctx) {
                                sel = (e.then_.as_slice(), format!("elif_{j}"));
                                break;
                            }
                        }
                        sel
                    }
                };
                // Record the decision (counts-only, unconditional — see
                // Aggregator::record_branch). Scope the lock so it drops before the
                // recursive call re-locks `agg`.
                {
                    let mut a = agg.lock().await;
                    a.record_branch(&if_step.id, &branch);
                }
                // Pass the *incoming* loop_index through unchanged — the If arm makes no
                // new scope, so an if-in-loop's branch children still see the loop index
                // (spec §4). Box::pin the recursion (If/Loop arms only — hot path unboxed).
                let flow = Box::pin(execute_steps(
                    client, taken, iter_vars, agg, deadline, env, vu_id, iter_id, loop_index,
                    cancel,
                ))
                .await?;
                match flow {
                    StepFlow::Continue => {}
                    other => return Ok(other),
                }
            }
```

- [ ] **Step 7: Run the new tests + the full engine suite**

Run: `cargo test -p handicap-engine`
Expected: PASS — including `branch_metrics_record_then_when_cond_true`, `branch_metrics_record_none_when_no_match_and_no_else`, and all existing if/loop tests (none construct `MetricFlush`, so the new field doesn't break them).

- [ ] **Step 8: Commit** (pre-commit hook builds the whole workspace — the worker still compiles because proto `MetricBatch` is unchanged and the worker doesn't yet read `flush.branch_stats`)

```bash
git add crates/engine/src/runner.rs crates/engine/tests/if_node.rs
git commit -m "feat(engine): record if-branch decisions and carry them in MetricFlush (9d)"
```

---

## Task 3: Proto `BranchStat` + worker conversion (one commit — prost exhaustiveness)

**Files:**
- Modify: `crates/proto/proto/coordinator.proto:32-44`
- Modify: `crates/worker/src/main.rs:13` (import), `:210-229` (conversion + literal + guard)

Adding `branch_stats` to proto `MetricBatch` breaks the worker's `MetricBatch { … }` literal at `main.rs:224` (the only construction site — verified by `grep -rn "MetricBatch {" crates/`). So proto + worker land together. `main.rs` has no inline test → use a throwaway wiring stub for tdd-guard.

- [ ] **Step 1: Create a compile-only wiring stub (tdd-guard unblock)**

Create `crates/worker/tests/branch_forward_wiring.rs`:

```rust
//! TEMP stub to satisfy tdd-guard while editing worker/src/main.rs. The real
//! coverage for branch_stats forwarding is the e2e in Task 11. Delete before commit.
#[test]
fn branch_forward_wiring_placeholder() {
    assert!(true);
}
```

- [ ] **Step 2: Add the proto message + field**

In `crates/proto/proto/coordinator.proto`, after the `LoopStat` message (line 37), add:

```proto
message BranchStat {
  string step_id = 1;   // the `if` node's id
  string branch = 2;    // "then" | "elif_0".. | "else" | "none"
  uint64 count = 3;     // decision count (counts-only: a branch decision has no error)
}
```

Then add field 5 to `MetricBatch` (line 39-44):

```proto
message MetricBatch {
  string run_id = 1;
  string worker_id = 2;
  repeated MetricWindow windows = 3;
  repeated LoopStat loop_stats = 4;
  repeated BranchStat branch_stats = 5;
}
```

- [ ] **Step 3: Regenerate + verify proto compiles**

Run: `cargo build -p handicap-proto`
Expected: success (tonic-build regenerates the prost types with `BranchStat` + `branch_stats`).

- [ ] **Step 4: Run the workspace build to see the worker literal break**

Run: `cargo build -p handicap-worker`
Expected: FAIL — `missing field branch_stats in initializer of MetricBatch`.

- [ ] **Step 5: Import proto `BranchStat` in the worker**

In `crates/worker/src/main.rs:13`, change:
```rust
use pb::{LoopStat, MetricBatch, MetricWindow, RunStatus, WorkerMessage};
```
to:
```rust
use pb::{BranchStat, LoopStat, MetricBatch, MetricWindow, RunStatus, WorkerMessage};
```

- [ ] **Step 6: Convert + extend the guard + the literal**

In the forwarder closure, after the `loop_stats` conversion (after line 219, before the `if windows.is_empty()` guard), add the branch conversion, then update the guard and the `MetricBatch` literal. Replace lines 220-230 (the guard through the literal) with:

```rust
            let branch_stats: Vec<BranchStat> = flush
                .branch_stats
                .into_iter()
                .map(|bs| BranchStat {
                    step_id: bs.step_id,
                    branch: bs.branch,
                    count: bs.count,
                })
                .collect();
            if windows.is_empty() && loop_stats.is_empty() && branch_stats.is_empty() {
                continue;
            }
            let msg = WorkerMessage {
                payload: Some(WorkerPayload::MetricBatch(MetricBatch {
                    run_id: run_id.clone(),
                    worker_id: worker_id.clone(),
                    windows,
                    loop_stats,
                    branch_stats,
                })),
            };
```

(The closure param `bs` is the engine `BranchStat` from `handicap_engine::MetricFlush.branch_stats`; the constructed `BranchStat { … }` is the proto type from `pb` — same engine↔proto mapping the `loop_stats` block uses for `LoopStat`.)

- [ ] **Step 7: Build the worker**

Run: `cargo build -p handicap-worker`
Expected: success.

- [ ] **Step 8: Remove the stub and commit**

```bash
rm crates/worker/tests/branch_forward_wiring.rs
git add crates/proto/proto/coordinator.proto crates/worker/src/main.rs
git commit -m "feat(proto,worker): carry branch_stats over gRPC MetricBatch (9d)"
```

---

## Task 4: Controller migration 0005 — `run_if_metrics` table

**Files:**
- Create: `crates/controller/src/store/migrations/0005_run_if_metrics.sql`
- Modify: `crates/controller/src/store/mod.rs:26` (const) + `:51` (execute)

`store/mod.rs` has inline tests → tdd-guard passes.

- [ ] **Step 1: Create the migration**

Create `crates/controller/src/store/migrations/0005_run_if_metrics.sql`:

```sql
CREATE TABLE IF NOT EXISTS run_if_metrics (
  run_id   TEXT    NOT NULL,
  step_id  TEXT    NOT NULL,   -- the `if` node's id
  branch   TEXT    NOT NULL,   -- "then" | "elif_0".. | "else" | "none"
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id, branch)
);
```

(`CREATE TABLE IF NOT EXISTS` is idempotent — same pattern as 0003/0004, avoids the `ALTER TABLE` non-idempotency footgun. No `error_count`: counts-only.)

- [ ] **Step 2: Register the migration constant**

In `crates/controller/src/store/mod.rs`, after line 26, add:

```rust
const MIGRATION_SQL_0005: &str = include_str!("migrations/0005_run_if_metrics.sql");
```

- [ ] **Step 3: Execute it in `connect`**

In `crates/controller/src/store/mod.rs`, after line 51 (`sqlx::query(MIGRATION_SQL_0004).execute(&pool).await?;`), add:

```rust
    sqlx::query(MIGRATION_SQL_0005).execute(&pool).await?;
```

- [ ] **Step 4: Verify migrations still run**

Run: `cargo test -p handicap-controller --lib store::tests::opens_and_migrates_in_memory`
Expected: PASS (connect() runs 0001-0005 without error).

- [ ] **Step 5: Commit**

```bash
git add crates/controller/src/store/migrations/0005_run_if_metrics.sql crates/controller/src/store/mod.rs
git commit -m "feat(controller): add run_if_metrics migration 0005 (9d)"
```

---

## Task 5: Controller store — `IfBranchRow` + UPSERT-accumulate + query

**Files:**
- Modify: `crates/controller/src/store/metrics.rs` (after the loop functions, ~line 178; + a test in `mod tests`)

`metrics.rs` has inline tests → tdd-guard passes; write the test first.

- [ ] **Step 1: Write the failing unit test**

In `crates/controller/src/store/metrics.rs`, inside `mod tests` (after `loop_metrics_upsert_accumulates`, before the closing `}` at line 371), add:

```rust
    #[tokio::test]
    async fn if_metrics_upsert_accumulates() {
        let db = pool().await;
        let rows = vec![
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "then".into(),
                count: 3,
            },
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "then".into(),
                count: 2,
            },
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "none".into(),
                count: 7,
            },
        ];
        insert_if_branch_batch(&db, &rows).await.unwrap();
        let got = if_breakdown(&db, "r").await.unwrap();
        let m: std::collections::HashMap<(String, String), i64> = got
            .into_iter()
            .map(|r| ((r.step_id, r.branch), r.count))
            .collect();
        assert_eq!(m.get(&("if1".into(), "then".into())), Some(&5)); // 3+2 accumulate
        assert_eq!(m.get(&("if1".into(), "none".into())), Some(&7));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p handicap-controller --lib if_metrics_upsert_accumulates`
Expected: FAIL — `cannot find type IfBranchRow` / `insert_if_branch_batch` / `if_breakdown`.

- [ ] **Step 3: Add the row type + functions**

In `crates/controller/src/store/metrics.rs`, after `loop_breakdown` (after line 178), add:

```rust
#[derive(Debug, Clone)]
pub struct IfBranchRow {
    pub run_id: String,
    pub step_id: String, // the `if` node's id
    pub branch: String,  // "then" | "elif_0".. | "else" | "none"
    pub count: i64,
}

pub async fn insert_if_branch_batch(db: &Db, rows: &[IfBranchRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // Single tx, individual upserts: branch deltas are incremental counts (like
    // run_loop_metrics), so accumulate on conflict.
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_if_metrics(run_id,step_id,branch,count) \
             VALUES(?,?,?,?) \
             ON CONFLICT(run_id,step_id,branch) DO UPDATE SET \
               count = count + excluded.count",
        )
        .bind(&r.run_id)
        .bind(&r.step_id)
        .bind(&r.branch)
        .bind(r.count)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn if_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<IfBranchRow>> {
    // ORDER BY branch is lexicographic TEXT — fine for counts; the UI re-sorts
    // then < elif_n < else < none for display (BranchStatsTable::branchRank).
    let rows = sqlx::query(
        "SELECT step_id, branch, count FROM run_if_metrics \
         WHERE run_id = ? ORDER BY step_id, branch",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| IfBranchRow {
            run_id: run_id.to_string(),
            step_id: r.get("step_id"),
            branch: r.get("branch"),
            count: r.get("count"),
        })
        .collect())
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p handicap-controller --lib if_metrics_upsert_accumulates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/controller/src/store/metrics.rs
git commit -m "feat(controller): run_if_metrics UPSERT-accumulate + query (9d)"
```

---

## Task 6: Controller gRPC — ingest `batch.branch_stats`

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (after the loop_rows block, ~line 290)

The `MetricBatch` handler edit has no natural unit test (covered by e2e Task 11) → use a wiring stub for tdd-guard.

- [ ] **Step 1: Create a compile-only wiring stub (tdd-guard unblock)**

Create `crates/controller/tests/branch_ingest_wiring.rs`:

```rust
//! TEMP stub for tdd-guard while editing grpc/coordinator.rs. Real coverage is the
//! e2e in Task 11. Delete before commit.
#[test]
fn branch_ingest_wiring_placeholder() {
    assert!(true);
}
```

- [ ] **Step 2: Add the branch ingest block**

In `crates/controller/src/grpc/coordinator.rs`, inside the `Some(WorkerPayload::MetricBatch(batch))` arm, immediately after the loop-metrics block (after line 290, after its closing `}`), add:

```rust
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
                            if let Err(e) = crate::store::metrics::insert_if_branch_batch(
                                &state.db,
                                &branch_rows,
                            )
                            .await
                            {
                                warn!(run_id = %batch.run_id, error = %e, "failed to insert if-branch metrics");
                            }
                        }
```

- [ ] **Step 3: Build the controller**

Run: `cargo build -p handicap-controller`
Expected: success.

- [ ] **Step 4: Remove the stub and commit**

```bash
rm crates/controller/tests/branch_ingest_wiring.rs
git add crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): ingest branch_stats into run_if_metrics (9d)"
```

---

## Task 7: Controller report — `if_breakdown` in `ReportJson` + endpoint

**Files:**
- Modify: `crates/controller/src/report.rs:1` (import), structs (~line 58), `ReportJson` (line 8-16), `build_report` signature + assembly + the 3 test call sites, + new test
- Modify: `crates/controller/src/api/runs.rs:188-202` (report endpoint)

Both files have inline tests → tdd-guard passes. Changing `build_report`'s signature breaks all 4 call sites (`report.rs:286,310,353` + `api/runs.rs:196`) — fix them in this one task so the controller stays green.

- [ ] **Step 1: Write the failing report test**

In `crates/controller/src/report.rs`, inside `mod tests` (after `build_report_attaches_loop_breakdown`, before line 367 `}`), add:

```rust
    #[test]
    fn build_report_attaches_if_breakdown() {
        use crate::store::metrics::IfBranchRow;
        let r = run_row();
        let rows = vec![win(100, "s", 6, 0, r#"{"200":6}"#, &[10_000])];
        // `build_report` preserves input order (no re-sort — the UI's branchRank
        // re-sorts for display). The controller passes rows already `ORDER BY branch`
        // (TEXT), so simulate that here: "else" < "then" lexicographically.
        let branches = vec![
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "else".into(),
                count: 2,
            },
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "then".into(),
                count: 4,
            },
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if2".into(),
                branch: "none".into(),
                count: 9,
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(&r, &yaml, &rows, &[], &branches);
        assert_eq!(rep.if_breakdown.len(), 2);
        let if1 = rep.if_breakdown.iter().find(|b| b.step_id == "if1").unwrap();
        // Order is preserved from the (SQL-sorted) input: "else" then "then".
        assert_eq!(if1.branches.len(), 2);
        assert_eq!(if1.branches[0].branch, "else");
        assert_eq!(if1.branches[0].count, 2);
        assert_eq!(if1.branches[1].branch, "then");
        let if2 = rep.if_breakdown.iter().find(|b| b.step_id == "if2").unwrap();
        assert_eq!(if2.branches[0].branch, "none");
        assert_eq!(if2.branches[0].count, 9);
        // typed round-trip (report types require Deserialize too).
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p handicap-controller --lib build_report_attaches_if_breakdown`
Expected: FAIL — `build_report` takes 4 args, not 5 / no field `if_breakdown`.

- [ ] **Step 3: Add the import + breakdown structs**

In `crates/controller/src/report.rs:1`, change:
```rust
use crate::store::metrics::{LoopMetricRow, WindowWithHdr};
```
to:
```rust
use crate::store::metrics::{IfBranchRow, LoopMetricRow, WindowWithHdr};
```

After the `LoopBucket` struct (after line 58), add:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct IfBranchBucket {
    pub branch: String, // "then" | "elif_0".. | "else" | "none"
    pub count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IfBreakdown {
    pub step_id: String, // the `if` node's id
    pub branches: Vec<IfBranchBucket>,
}
```

- [ ] **Step 4: Add the `if_breakdown` field to `ReportJson`**

In the `ReportJson` struct (line 8-16), add the field after `status_distribution`:

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct ReportJson {
    pub run: ReportRun,
    pub scenario_yaml: String,
    pub summary: ReportSummary,
    pub windows: Vec<ReportWindow>,
    pub steps: Vec<ReportStep>,
    pub status_distribution: BTreeMap<String, u64>,
    pub if_breakdown: Vec<IfBreakdown>,
}
```

- [ ] **Step 5: Extend `build_report` signature + assembly + the literal**

Change the `build_report` signature (line 91-96) to add a 5th param:

```rust
pub fn build_report(
    run: &RunRow,
    scenario_yaml: &str,
    rows: &[WindowWithHdr],
    loops: &[LoopMetricRow],
    branches: &[IfBranchRow],
) -> ReportJson {
```

Immediately after the `loop_by_step` building block (after line 109, before `let mut windows: ...`), add:

```rust
    // Group branch decision counts by `if` node id (rows already ordered by
    // step_id, branch from SQL). Keyed by the `if` id, NOT an http leaf — `if` ids
    // never appear in `steps`, and the `none` bucket has no leaf at all.
    let mut if_by_step: BTreeMap<String, Vec<IfBranchBucket>> = BTreeMap::new();
    for r in branches {
        if_by_step
            .entry(r.step_id.clone())
            .or_default()
            .push(IfBranchBucket {
                branch: r.branch.clone(),
                count: r.count as u64,
            });
    }
    let if_breakdown: Vec<IfBreakdown> = if_by_step
        .into_iter()
        .map(|(step_id, branches)| IfBreakdown { step_id, branches })
        .collect();
```

In the final `ReportJson { … }` literal (line 187-211), add the field after `status_distribution: status_dist,`:

```rust
        status_distribution: status_dist,
        if_breakdown,
```

- [ ] **Step 6: Fix the existing test call sites**

In `crates/controller/src/report.rs`:
- Line 286: `let rpt = build_report(&r, &yaml, &rows, &[]);` → `let rpt = build_report(&r, &yaml, &rows, &[], &[]);`
- Line 310: `let rpt = build_report(&r, &yaml, &[bad], &[]);` → `let rpt = build_report(&r, &yaml, &[bad], &[], &[]);`
- Line 353: `let rep = build_report(&r, &yaml, &rows, &loops);` → `let rep = build_report(&r, &yaml, &rows, &loops, &[]);`

- [ ] **Step 7: Wire the report endpoint**

In `crates/controller/src/api/runs.rs`, replace the `report` handler body (lines 192-201) with:

```rust
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    let rows = crate::store::metrics::windows_with_hdr(&state.db, &id).await?;
    let loops = crate::store::metrics::loop_breakdown(&state.db, &id).await?;
    let branches = crate::store::metrics::if_breakdown(&state.db, &id).await?;
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(Json(crate::report::build_report(
        &row,
        &scenario_yaml,
        &rows,
        &loops,
        &branches,
    )))
```

- [ ] **Step 8: Run the controller test suite**

Run: `cargo test -p handicap-controller`
Expected: PASS — `build_report_attaches_if_breakdown` + all existing report/store/api tests.

- [ ] **Step 9: Commit**

```bash
git add crates/controller/src/report.rs crates/controller/src/api/runs.rs
git commit -m "feat(controller): expose if_breakdown in ReportJson + /report (9d)"
```

---

## Task 8: UI schemas — `if_breakdown` Zod types

**Files:**
- Create: `ui/src/api/schemas.test.ts` (drives the schema + tdd-guard)
- Modify: `ui/src/api/schemas.ts` (new schemas + `ReportSchema.if_breakdown` + types)

- [ ] **Step 1: Write the failing schema test**

Create `ui/src/api/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ReportSchema, IfBreakdownSchema } from "./schemas";

describe("if_breakdown schema", () => {
  it("parses an IfBreakdown entry", () => {
    const parsed = IfBreakdownSchema.parse({
      step_id: "if1",
      branches: [
        { branch: "then", count: 930 },
        { branch: "none", count: 0 },
      ],
    });
    expect(parsed.branches).toHaveLength(2);
    expect(parsed.branches[0].branch).toBe("then");
  });

  it("accepts a report carrying if_breakdown", () => {
    const report = {
      run: {
        id: "r",
        scenario_id: "s",
        status: "completed",
        profile: {},
        env: {},
        started_at: 1,
        ended_at: 2,
        created_at: 0,
      },
      scenario_yaml: "version: 1\nname: x\nsteps: []\n",
      summary: { count: 0, errors: 0, rps: 0, duration_seconds: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0 },
      windows: [],
      steps: [],
      status_distribution: {},
      if_breakdown: [{ step_id: "if1", branches: [{ branch: "then", count: 1 }] }],
    };
    const parsed = ReportSchema.parse(report);
    expect(parsed.if_breakdown?.[0].step_id).toBe("if1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test schemas`
Expected: FAIL — `IfBreakdownSchema` is not exported.

- [ ] **Step 3: Add the schemas + types**

In `ui/src/api/schemas.ts`, after the `ReportStepSchema` block (after line 121), add:

```ts
export const IfBranchBucketSchema = z
  .object({
    branch: z.string(),
    count: z.number(),
  })
  .strict();

export const IfBreakdownSchema = z
  .object({
    step_id: z.string(),
    branches: z.array(IfBranchBucketSchema),
  })
  .strict();
```

In `ReportSchema` (line 148-157), add the field before the closing `})` / `.strict()`:

```ts
export const ReportSchema = z
  .object({
    run: ReportRunSchema,
    scenario_yaml: z.string(),
    summary: ReportSummarySchema,
    windows: z.array(ReportWindowSchema),
    steps: z.array(ReportStepSchema),
    status_distribution: StatusDistributionSchema,
    if_breakdown: z.array(IfBreakdownSchema).optional(),
  })
  .strict();
```

(`.optional()` mirrors `loop_breakdown`'s defensive optionality; the controller always emits the field, so the consumer reads `report.if_breakdown ?? []`.)

After `export type ReportSummary = ...` (line 162), add:

```ts
export type IfBreakdown = z.infer<typeof IfBreakdownSchema>;
```

- [ ] **Step 4: Run to verify pass + the type gate**

Run: `cd ui && pnpm test schemas && pnpm build`
Expected: tests PASS; `pnpm build` (`tsc -b`) clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/schemas.ts ui/src/api/schemas.test.ts
git commit -m "feat(ui): add if_breakdown Zod schema + types (9d)"
```

---

## Task 9: UI `BranchStatsTable` component

**Files:**
- Create: `ui/src/components/report/__tests__/BranchStatsTable.test.tsx`
- Create: `ui/src/components/report/BranchStatsTable.tsx`

Mirrors `StepStatsTable`'s caret-drill-down pattern (`Set<string>` open state, ▾/▸ toggle, nested sub-table). Test first (tdd-guard + TDD).

- [ ] **Step 1: Write the failing component test**

Create `ui/src/components/report/__tests__/BranchStatsTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { BranchStatsTable } from "../BranchStatsTable";
import type { IfBreakdown } from "../../../api/schemas";

describe("BranchStatsTable", () => {
  const breakdown: IfBreakdown[] = [
    {
      step_id: "if1",
      branches: [
        { branch: "else", count: 100 },
        { branch: "then", count: 930 },
        { branch: "elif_0", count: 210 },
        { branch: "none", count: 0 },
      ],
    },
  ];
  const meta = new Map([["if1", { name: "branch-on-status" }]]);

  it("renders one row per if-node, branch rows hidden until expanded", () => {
    render(<BranchStatsTable breakdown={breakdown} meta={meta} />);
    expect(screen.getByText(/branch-on-status/)).toBeInTheDocument();
    expect(screen.queryByText("then")).not.toBeInTheDocument();
  });

  it("expands to per-branch decision counts incl the none bucket, in display order", async () => {
    const user = userEvent.setup();
    render(<BranchStatsTable breakdown={breakdown} meta={meta} />);
    await user.click(screen.getByRole("button", { name: /branch-on-status/i }));
    expect(screen.getByText("then")).toBeInTheDocument();
    expect(screen.getByText("elif_0")).toBeInTheDocument();
    expect(screen.getByText("else")).toBeInTheDocument();
    expect(screen.getByText("(미매치)")).toBeInTheDocument();
    // display order: then < elif_0 < else < none
    const labels = screen.getAllByTestId("branch-label").map((e) => e.textContent);
    expect(labels).toEqual(["then", "elif_0", "else", "(미매치)"]);
  });

  it("renders nothing when there are no if-nodes", () => {
    const { container } = render(<BranchStatsTable breakdown={[]} meta={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test BranchStatsTable`
Expected: FAIL — cannot resolve `../BranchStatsTable`.

- [ ] **Step 3: Implement the component**

Create `ui/src/components/report/BranchStatsTable.tsx`:

```tsx
import { Fragment, useState } from "react";
import type { IfBreakdown } from "../../api/schemas";

type IfMeta = { name: string };
type Props = { breakdown: IfBreakdown[]; meta: Map<string, IfMeta> };

/** Display order: then (0) < elif_n (1+n) < else < none. SQL returns branches in
 *  lexicographic TEXT order, which is not the authoring order — re-sort here. */
function branchRank(branch: string): number {
  if (branch === "then") return 0;
  if (branch.startsWith("elif_")) {
    const n = Number(branch.slice("elif_".length));
    return Number.isFinite(n) ? 1 + n : 1_000;
  }
  if (branch === "else") return 1_000_000;
  if (branch === "none") return 1_000_001;
  return 999_999;
}

function branchLabel(branch: string): string {
  return branch === "none" ? "(미매치)" : branch;
}

export function BranchStatsTable({ breakdown, meta }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (breakdown.length === 0) return null;

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section aria-label="Branch decisions" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Branch decisions</h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">If node</th>
            <th className="py-2 pr-4 font-medium">Decisions</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((b) => {
            const m = meta.get(b.step_id);
            const isOpen = open.has(b.step_id);
            const total = b.branches.reduce((acc, x) => acc + x.count, 0);
            const sorted = [...b.branches].sort(
              (x, y) => branchRank(x.branch) - branchRank(y.branch),
            );
            return (
              <Fragment key={b.step_id}>
                <tr className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`Toggle branch breakdown for ${m?.name ?? b.step_id}`}
                      onClick={() => toggle(b.step_id)}
                      className="mr-1 text-slate-500"
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                    {m?.name ?? b.step_id} <span className="text-slate-400">(if)</span>
                  </td>
                  <td className="py-2 pr-4">{total}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-slate-50">
                    <td colSpan={2} className="px-6 py-2">
                      <table className="text-xs">
                        <thead className="text-slate-500">
                          <tr>
                            <th className="pr-4 text-left">branch</th>
                            <th className="pr-4 text-left">decisions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map((x) => (
                            <tr key={x.branch}>
                              <td className="pr-4 font-mono" data-testid="branch-label">
                                {branchLabel(x.branch)}
                              </td>
                              <td className="pr-4">{x.count}</td>
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
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 4: Run to verify pass + type gate**

Run: `cd ui && pnpm test BranchStatsTable && pnpm build`
Expected: tests PASS; `pnpm build` clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/report/BranchStatsTable.tsx ui/src/components/report/__tests__/BranchStatsTable.test.tsx
git commit -m "feat(ui): BranchStatsTable per-if branch-decision drill-down (9d)"
```

---

## Task 10: UI `ReportView` — resolve if-node names + render the table

**Files:**
- Modify: `ui/src/components/report/ReportView.tsx` (imports, `ifMeta`, render)
- Modify: `ui/src/components/report/__tests__/ReportView.test.tsx` (assert the section)

`ifMeta` resolves each `if_breakdown` step_id → the `if` node's `name` via `findStepById` (9c added it to resolve any-type steps, including containers).

- [ ] **Step 1: Add a failing assertion to the existing ReportView test**

Open `ui/src/components/report/__tests__/ReportView.test.tsx`. The file already has a typed `const FIXTURE: Report` (~lines 14-85) and existing tests spread it (`{ ...FIXTURE, scenario_yaml, ... }`). **Reuse `FIXTURE`** — do not inline a fresh object or use `as never` (that defeats `tsc -b`). After Task 8, the `Report` type carries `if_breakdown?`, so a typed object is feasible. Add this test:

```tsx
it("renders a Branch decisions section when if_breakdown is present", () => {
  const report: Report = {
    ...FIXTURE,
    scenario_yaml: [
      "version: 1",
      "name: x",
      "steps:",
      '  - id: "01HX0000000000000000000001"',
      "    name: branchy",
      "    type: if",
      '    cond: { left: "1", op: eq, right: "1" }',
      "    then:",
      '      - id: "01HX0000000000000000000002"',
      "        name: then-step",
      "        type: http",
      '        request: { method: GET, url: "/then" }',
      "        assert: []",
      "",
    ].join("\n"),
    if_breakdown: [
      { step_id: "01HX0000000000000000000001", branches: [{ branch: "then", count: 5 }] },
    ],
  };
  render(<ReportView report={report} />);
  expect(screen.getByText("Branch decisions")).toBeInTheDocument();
  expect(screen.getByText(/branchy/)).toBeInTheDocument();
});
```

(`Report`, `screen`, `render`, and `FIXTURE` are already in scope for the existing tests. If the `Report` import is type-only, ensure `Report` is imported — it is, since `FIXTURE` is annotated with it.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test ReportView`
Expected: FAIL — "Branch decisions" not in the document.

- [ ] **Step 3: Wire `ReportView`**

In `ui/src/components/report/ReportView.tsx`:

Change the model import (line 4):
```tsx
import { flattenHttpSteps } from "../../scenario/model";
```
to:
```tsx
import { flattenHttpSteps, findStepById } from "../../scenario/model";
```

Add the `BranchStatsTable` import after the `StepStatsTable` import (line 9):
```tsx
import { BranchStatsTable } from "./BranchStatsTable";
```

After the `stepMeta` useMemo (after line 64), add:

```tsx
  const ifMeta = useMemo(() => {
    const m = new Map<string, { name: string }>();
    const parsed = parseScenarioDoc(report.scenario_yaml);
    if ("model" in parsed) {
      for (const b of report.if_breakdown ?? []) {
        const step = findStepById(parsed.model.steps, b.step_id);
        m.set(b.step_id, { name: step?.name ?? b.step_id });
      }
    }
    return m;
  }, [report.scenario_yaml, report.if_breakdown]);
```

In the JSX, after `<StepStatsTable … />` (line 89), add:

```tsx
      <BranchStatsTable breakdown={report.if_breakdown ?? []} meta={ifMeta} />
```

- [ ] **Step 4: Run to verify pass + full UI gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: all UI tests PASS; `pnpm build` (`tsc -b && vite build`) clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/report/ReportView.tsx ui/src/components/report/__tests__/ReportView.test.tsx
git commit -m "feat(ui): render Branch decisions table in ReportView (9d)"
```

---

## Task 11: e2e smoke — if-scenario report carries `if_breakdown`

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs` (new test, mirrors `report_e2e_smoke`)

This proves the full wire (worker subprocess → gRPC `branch_stats` → `run_if_metrics` → `/report.if_breakdown`). `e2e_test.rs` is a `tests/` file, so editing it does not trip tdd-guard. **Read `report_e2e_smoke` in this file first** and reuse its scaffolding (`worker_bin_path()`, controller spawn + `--worker-mode subprocess`, wiremock setup, poll the run until terminal, `GET /api/runs/{id}/report`). The only deltas are the scenario and the assertion.

- [ ] **Step 1: Write the failing e2e test**

Add to `crates/controller/tests/e2e_test.rs` a test `if_branch_report_e2e_smoke` modeled exactly on `report_e2e_smoke`, with:

- A wiremock stub for `GET /then` returning 200 (set a small `set_delay` like the existing smoke if it asserts p95 > 0; not needed here).
- This scenario YAML (interpolate the wiremock base into `variables.base`; the `if` cond is always true so `then` is taken every iteration):

```yaml
version: 1
name: e2e-branch
variables:
  base: "<WIREMOCK_URI>"
steps:
  - id: "01HX0000000000000000000001"
    name: gate
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX0000000000000000000002"
        name: then-step
        type: http
        request: { method: GET, url: "{{base}}/then" }
        assert: [ { status: 200 } ]
```

- After the run reaches a terminal state and the report is fetched + JSON-parsed, assert:

```rust
let if_breakdown = report["if_breakdown"].as_array().expect("if_breakdown array");
let gate = if_breakdown
    .iter()
    .find(|b| b["step_id"] == "01HX0000000000000000000001")
    .expect("if-node present in if_breakdown");
let then = gate["branches"]
    .as_array()
    .unwrap()
    .iter()
    .find(|x| x["branch"] == "then")
    .expect("then branch present");
assert!(then["count"].as_u64().unwrap() > 0, "then branch decided at least once");
```

(If `report_e2e_smoke` deserializes into a typed struct rather than `serde_json::Value`, instead assert against `report.if_breakdown` using the `ReportJson`/`IfBreakdown` types — match whatever the existing smoke does.)

- [ ] **Step 2: Run to verify it fails for the right reason, then passes**

Run: `cargo test -p handicap-controller --test e2e_test if_branch_report_e2e_smoke -- --nocapture`
Expected: with all prior tasks merged, PASS. (If you run it before the worker/controller binaries are rebuilt, the helper `worker_bin_path()` rebuilds the worker; ensure `cargo build` has run so the controller binary is current.)

> Flake note: cold full-workspace builds during this test can SIGKILL under memory pressure (a known flake) — if it dies with signal 9 on a cold build, re-run warm.

- [ ] **Step 3: Commit**

```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(controller): e2e smoke for if-branch report breakdown (9d)"
```

---

## Task 12: ADR + CLAUDE.md + roadmap + memory

All edits are `.md` → the pre-commit hook takes the docs-only fast path (no cargo). **After editing, run `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md` once** — the md-only fast path does not lint, so conflict markers can slip in.

- [ ] **Step 1: Update ADR-0023**

In `docs/adr/0023-conditional-node.md`, add a decision note: branch metrics are a **dedicated per-`if`-node decision counter** (engine `Aggregator::branch_counts` → `MetricFlush.branch_stats` → proto → `run_if_metrics` → `ReportJson.if_breakdown` → UI `BranchStatsTable`). **No cap / no overflow sentinel** (branch set is finite per `if`), **counts-only / no `error_count`** (a decision is not a request), keyed by `if` id + branch `TEXT` (`then`/`elif_n`/`else`/`none`); `none` = no match + empty/absent else. Surfaced as a **separate report table**, not on `ReportStep` (the spec's literal `ReportStep.branch_breakdown` was infeasible — `if` ids are not http-leaf report rows).

- [ ] **Step 2: Update the spec status line**

In `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md:3`, change the status to mark 9d implemented/merged.

- [ ] **Step 3: Update root `CLAUDE.md`**

- Status line near the top: 9a+9b+9c+**9d** done; Slice 9 complete.
- ADR-0023 bullet in "알아둘 결정들": note branch metrics done (dedicated counter, no cap, counts-only, separate table).
- Add a Slice 9d result paragraph in the same style as the 7-1/9c paragraphs.

- [ ] **Step 4: Update domain CLAUDE.md gotchas**

- `crates/engine/CLAUDE.md` (메트릭/집계): branch decisions recorded in the `Step::If` arm via `Aggregator::record_branch` (counts-only, **no cap** — independent of `loop_cap`); `MetricFlush.branch_stats` is the third drained vector; `none` = no match + empty/absent else.
- `crates/controller/CLAUDE.md` (리포트 빌드 / proto): `run_if_metrics` (migration 0005, `CREATE TABLE IF NOT EXISTS`, branch is a `TEXT` key, **no `error_count`**); `build_report` gained a 5th `branches` param (all 4 call sites updated); `MetricBatch.branch_stats = 5` added (only worker `main.rs:224` constructs `MetricBatch`).
- `ui/CLAUDE.md` (리포트 렌더링): branch breakdown is a **separate `BranchStatsTable`** (if ids are not in `report.steps`); `ifMeta` resolves names via `findStepById`; SQL returns branches in TEXT order so the component re-sorts `then < elif_n < else < none`; `none` renders as `(미매치)`.

- [ ] **Step 5: Update `docs/roadmap.md`**

Move Slice 9 (incl. 9d) to done; note branch-metrics shipped.

- [ ] **Step 6: Conflict-marker sweep + commit**

```bash
grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md || echo "no markers"
git add docs/ CLAUDE.md crates/engine/CLAUDE.md crates/controller/CLAUDE.md ui/CLAUDE.md
git commit -m "docs(9d): ADR-0023 branch metrics, CLAUDE.md, roadmap, spec status"
```

- [ ] **Step 7: Update auto-memory** (outside the repo — use the Write tool, not git)

Update `~/.claude/projects/-Users-sgj-develop-handicap/memory/mvp1-roadmap.md` (and its `MEMORY.md` index line) to record Slice 9d done + merged.

---

## Final integration

After all tasks pass and the worktree is green (`cargo test --workspace`, `cd ui && pnpm test && pnpm build`):

- [ ] Rebase the branch onto `master` (docs commits may have landed), then `git checkout master && git merge --ff-only <branch>`.
- [ ] `ExitWorktree` (use `discard_changes: true` *after* confirming the ff-merge — the commits are already on `master`). See root CLAUDE.md "검증 자동화" for the worktree cleanup quirk.

---

## Self-review (performed against the spec)

**Spec coverage (§8 "9d — 분기 메트릭 breakdown"):**
- engine `Aggregator` per-(if_id, branch) → Task 1 ✓
- `MetricFlush.branch_stats` + all `run_scenario` consumers + worker `MetricFlush→MetricBatch` (SF-3) → Tasks 2, 3 ✓ (verified: only `runner.rs` constructs `MetricFlush`; only worker `main.rs:224` constructs proto `MetricBatch`; receiving test sites don't construct either, so they need no edit)
- proto `MetricBatch.branch_stats` (new field number, prost exhaustive) → Task 3 ✓ (field 5)
- controller `run_if_metrics` (migration 0005, branch is `TEXT` — SF-4) → Tasks 4, 5 ✓
- `ReportStep.branch_breakdown` → **deviated to `ReportJson.if_breakdown` + separate `BranchStatsTable`** (documented in Architecture + Task 12; `if` ids are not http-leaf report rows, and `none` has no leaf — confirmed against `report.rs` + `ReportView.tsx`). User chose the separate-table surfacing.
- UI `StepStatsTable` drill-down → Tasks 9, 10 (separate table, same caret UX) ✓
- tests: aggregator unit (T1), controller report integration (T7), e2e smoke (T11) → ✓
- ADR-0023 metric decision update → Task 12 ✓

**Departures from the loop (7-1) pipeline, all deliberate & documented:** no `error_count` (counts-only), no cap/overflow sentinel, keyed by `if` id (not http leaf), surfaced as a new top-level report array + separate UI table.

**Placeholder scan:** none — every code step carries complete code; the only "follow the existing pattern" is the e2e harness scaffolding (Task 11), which is established-codebase reuse of `report_e2e_smoke` in the same file.

**Type consistency:** engine `BranchStat{step_id,branch,count}` ↔ proto `BranchStat{step_id,branch,count}` ↔ controller `IfBranchRow{run_id,step_id,branch,count}` ↔ `IfBranchBucket{branch,count}`/`IfBreakdown{step_id,branches}` ↔ Zod `IfBranchBucketSchema`/`IfBreakdownSchema` ↔ TS `IfBreakdown` — field names line up 1:1 across the wire (the 8c `Mapping` lesson). `build_report` 5-arg signature is consistent across its definition and all 4 call sites.
