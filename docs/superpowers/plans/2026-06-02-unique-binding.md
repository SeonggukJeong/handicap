# `unique` Data-Binding Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4th data-binding policy `unique` — each dataset row injected as a `{{var}}` is consumed at most once globally across N fan-out workers; a VU stops cleanly when its worker's slice is exhausted.

**Architecture:** The controller partitions the dataset into **disjoint contiguous slices** (one per worker, via the existing `shard_split` arithmetic) and streams each worker only its slice. The engine reuses `iter_sequential`'s shared worker-local `AtomicU64` cursor but **without `% len` wrap**: `select_index` returns `Option<usize>` and yields `None` once the cursor passes the slice end, which makes `run_vu` break (clean VU completion). A run-create gate rejects `rows < N` so every worker always gets a non-empty slice (no unbound-load path).

**Tech Stack:** Rust (engine/controller/worker crates, tonic/prost gRPC, sqlx/SQLite), TypeScript/React + Zod + Vitest (UI).

**Spec:** `docs/superpowers/specs/2026-06-02-unique-binding-design.md` (read it first).

---

## TDD-guard notes (subagent execution)

The Claude PreToolUse `tdd-guard` blocks edits to `crates/*/src/*.rs` / `ui/src/*.tsx` unless a pending test-path file exists in the worktree (root CLAUDE.md). Per task:
- **Task 1**: Step 1 creates `crates/engine/tests/unique_binding.rs` (real test-path file) → unblocks `dataset.rs`/`runner.rs`. `dataset.rs` also has inline `#[cfg(test)]`.
- **Task 3 (worker)**: the one-line policy arm has no feasible unit test (covered by Task 7 e2e). Pre-lay a keepalive: `printf '#[test]\nfn _k(){}\n' > crates/worker/tests/_unique_keepalive.rs`, make the edit, then **`rm crates/worker/tests/_unique_keepalive.rs` before commit** (commit only `crates/worker/src/main.rs`). Use explicit `git add` paths (never `-A`).
- **Tasks 4, 5**: `runs.rs` (inline tests at :289), `shard.rs` + `coordinator.rs` (inline `#[cfg(test)]`) auto-pass.
- **Task 6 (UI)**: Step 1 writes the RTL test first.
- **Task 7**: test-path file (`tests/`) — auto-passes.

**Per-task gates:** every Rust task ends with `cargo build -p handicap-worker` (root CLAUDE.md: `cargo run -p handicap-controller` does NOT rebuild the worker binary the subprocess dispatcher spawns). The UI task ends with `pnpm build`. The pre-commit hook runs cargo only.

---

## Task 1: Engine — `Unique` policy, `Option<usize>` selection, stop-VU

**Files:**
- Create: `crates/engine/tests/unique_binding.rs`
- Modify: `crates/engine/src/dataset.rs` (enum `BindingPolicy`, `select_index`, inline tests)
- Modify: `crates/engine/src/runner.rs` (`run_scenario` counter ~:58-61, `run_vu` ~:240-247)

- [ ] **Step 1: Write the failing integration test (also unblocks the TDD guard)**

Create `crates/engine/tests/unique_binding.rs`:

```rust
//! `unique` policy contract: each row handed out at most once via a shared
//! worker-local cursor, then `None` (no wrap). (spec §2, §4.1)
use handicap_engine::{BindingPolicy, DataSet};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::AtomicU64;

fn rows(n: usize) -> Vec<BTreeMap<String, String>> {
    (0..n)
        .map(|i| {
            let mut m = BTreeMap::new();
            m.insert("tok".to_string(), format!("t{i}"));
            m
        })
        .collect()
}

#[test]
fn unique_consumes_each_row_once_then_returns_none() {
    let ds = DataSet {
        policy: BindingPolicy::Unique,
        seed: 0,
        rows: rows(4),
    };
    let c = AtomicU64::new(0);
    let got: Vec<Option<usize>> = (0..6).map(|i| ds.select_index(i, 0, Some(&c))).collect();
    assert_eq!(
        got,
        vec![Some(0), Some(1), Some(2), Some(3), None, None],
        "unique must return 0..len then None forever (no wrap)"
    );
}

#[test]
fn unique_two_vus_never_get_the_same_row() {
    let ds = DataSet {
        policy: BindingPolicy::Unique,
        seed: 0,
        rows: rows(3),
    };
    let c = AtomicU64::new(0);
    let mut seen = HashSet::new();
    for _iter in 0..3 {
        for vu in 0..2u32 {
            if let Some(idx) = ds.select_index(vu, 0, Some(&c)) {
                assert!(seen.insert(idx), "row {idx} handed out twice");
            }
        }
    }
    assert_eq!(seen.len(), 3, "all 3 unique rows consumed exactly once");
}
```

- [ ] **Step 2: Run it to verify it fails (no `Unique`, `select_index` returns `usize`)**

Run: `cargo test -p handicap-engine --test unique_binding`
Expected: FAIL — `no variant named Unique` / `expected Option, found usize`.

- [ ] **Step 3: Add `Unique` to the engine enum and make `select_index` return `Option<usize>`**

In `crates/engine/src/dataset.rs`, add the variant to `BindingPolicy` (after `IterRandom`):

```rust
    /// Worker-local shared cursor, advanced once per iteration, NO wrap. Returns
    /// `None` when the worker's disjoint slice is exhausted → the VU stops.
    Unique,
```

Replace `select_index` (current signature `-> usize`) with:

```rust
    /// Row index for this (vu_id, iter_id), or `None` when a `Unique` slice is
    /// exhausted. `counter` is the shared worker-local cursor (Some for
    /// `IterSequential` and `Unique`); the `fetch_add` happens here so the
    /// increment is exactly once per iteration. Non-unique policies always
    /// return `Some` (rows is non-empty: the gate rejects empty datasets and
    /// unique requires rows >= N).
    pub fn select_index(
        &self,
        vu_id: u32,
        iter_id: u32,
        counter: Option<&std::sync::atomic::AtomicU64>,
    ) -> Option<usize> {
        let len = self.rows.len();
        debug_assert!(len > 0, "DataSet::select_index on empty rows");
        match self.policy {
            BindingPolicy::PerVu => Some((vu_id as usize) % len),
            BindingPolicy::IterSequential => {
                let c = counter.expect("IterSequential requires a shared counter");
                Some((c.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as usize) % len)
            }
            BindingPolicy::IterRandom => {
                let mixed = mix(self.seed, vu_id, iter_id);
                let mut rng = StdRng::seed_from_u64(mixed);
                Some(rng.gen_range(0..len))
            }
            BindingPolicy::Unique => {
                let c = counter.expect("Unique requires a shared counter");
                let next = c.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as usize;
                if next >= len { None } else { Some(next) }
            }
        }
    }
```

- [ ] **Step 4: Update the existing inline `select_index` unit tests to the `Option` signature**

In `crates/engine/src/dataset.rs` inline `mod tests`, edit the assertions (the `select_index` return is now `Option<usize>`):

`per_vu_is_fixed_and_wraps` — the first assert (comparing two calls) is unchanged; wrap the literals:
```rust
        assert_eq!(ds.select_index(1, 0, None), ds.select_index(1, 99, None));
        assert_eq!(ds.select_index(1, 0, None), Some(1));
        assert_eq!(ds.select_index(4, 0, None), Some(1));
```

`iter_sequential_advances_once_per_call_and_wraps`:
```rust
        assert_eq!(ds.select_index(0, 0, Some(&c)), Some(0));
        assert_eq!(ds.select_index(0, 1, Some(&c)), Some(1));
        assert_eq!(ds.select_index(0, 2, Some(&c)), Some(0)); // wrap
```

`iter_random_is_deterministic_for_same_inputs`:
```rust
        let a = ds.select_index(3, 7, None);
        let b = ds.select_index(3, 7, None);
        assert_eq!(a, b, "same (seed,vu,iter) must reproduce the same index");
        assert!(a.unwrap() < 5);
```

`iter_random_varies_across_iterations`:
```rust
        let seq: Vec<usize> = (0..10)
            .map(|i| ds.select_index(0, i, None).unwrap())
            .collect();
```

- [ ] **Step 5: Wire the shared counter for `Unique` and add the stop-VU branch in the runner**

In `crates/engine/src/runner.rs`, `run_scenario` (~:58-61) change the counter match arm:

```rust
    let seq_counter = match dataset.as_ref().map(|d| d.policy) {
        Some(BindingPolicy::IterSequential | BindingPolicy::Unique) => Some(Arc::new(AtomicU64::new(0))),
        _ => None,
    };
```

In `run_vu` (~:240-247) replace the dataset overlay block:

```rust
        if let Some(ds) = &dataset {
            match ds.select_index(vu_id, iter_id, seq_counter.as_deref()) {
                Some(idx) => {
                    for (k, v) in &ds.rows[idx] {
                        iter_vars.insert(k.clone(), v.clone());
                    }
                }
                // unique slice exhausted → stop this VU (clean Ok, not a failure).
                None => break,
            }
        }
```

(The old `if !ds.rows.is_empty()` guard is removed: the gate guarantees non-empty rows for every policy, so the `% 0` path is unreachable.)

- [ ] **Step 6: Run the new test + the engine suite + the worker build**

Run: `cargo test -p handicap-engine`
Expected: PASS (incl. `unique_binding` and updated inline tests).
Run: `cargo build -p handicap-worker`
Expected: builds clean (worker links the engine lib).

- [ ] **Step 7: Commit**

```bash
git add crates/engine/tests/unique_binding.rs crates/engine/src/dataset.rs crates/engine/src/runner.rs
git commit -m "feat(engine): unique binding policy — Option<usize> select + stop-VU on exhaust"
```

---

## Task 2: proto — add `UNIQUE = 3`

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (`DataBinding.Policy` enum ~:120-125)

- [ ] **Step 1: Add the enum value**

In `crates/proto/proto/coordinator.proto`, change the `Policy` enum:

```proto
  enum Policy {
    PER_VU = 0;
    ITER_SEQUENTIAL = 1;
    ITER_RANDOM = 2;
    UNIQUE = 3;
  }
```

(Removes the `// UNIQUE reserved …` comment. Adding an enum value is backward-compatible — controller/worker deploy together; root/engine CLAUDE.md trap.)

- [ ] **Step 2: Rebuild to regenerate prost types**

Run: `cargo build -p handicap-proto`
Expected: builds clean; `handicap_proto::v1::data_binding::Policy::Unique` now exists.

- [ ] **Step 3: Commit**

```bash
git add crates/proto/proto/coordinator.proto
git commit -m "feat(proto): DataBinding.Policy UNIQUE = 3"
```

---

## Task 3: Worker — map proto `Unique` → engine `Unique`

**Files:**
- Modify: `crates/worker/src/main.rs` (policy mapping ~:118-128)

> TDD guard: `main.rs` already has an inline `#[cfg(test)] mod tests` (:349) on disk, so this edit auto-passes (no keepalive needed). The wiring is exercised by the Task 7 e2e.

- [ ] **Step 1: Add the `Unique` match arm**

In `crates/worker/src/main.rs`, the `match pb::data_binding::Policy::try_from(b.policy)` block, add before `_ => unreachable!`:

```rust
                        Ok(pb::data_binding::Policy::Unique) => BindingPolicy::Unique,
```

(The `_ => unreachable!("… version mismatch")` arm stays — controller/worker deploy together. The worker receives `b.row_count` = its slice `count_i` rows via `load_dataset` and builds `DataSet { policy: Unique, .. }`; it is unaware of the global offset — local `0..count_i` indexing.)

- [ ] **Step 2: Build the worker**

Run: `cargo build -p handicap-worker`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add crates/worker/src/main.rs
git commit -m "feat(worker): map proto DataBinding Unique policy to engine"
```

---

## Task 4: Controller — validation gate + run-create resolution

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (`validate_run_config` :47-100, `create` resolution :129-143, inline `mod tests` :289)

- [ ] **Step 1: Write the failing gate tests**

In `crates/controller/src/api/runs.rs`, inside the existing `#[cfg(test)] mod tests` (:289), add:

```rust
    use super::*;
    use crate::app::AppState;
    use crate::binding::{BindingPolicy, DataBinding};
    use crate::grpc::coordinator::CoordinatorState;
    use crate::store::runs::Profile;
    use std::sync::Arc;

    async fn state_with(db: crate::store::Db, capacity: u32) -> AppState {
        AppState {
            db: db.clone(),
            coord: CoordinatorState::with_capacity(db, capacity),
            // validate_run_config never dispatches — a dummy dispatcher is fine.
            // NOTE: no re-export at dispatcher/mod.rs — full path required.
            dispatcher: Arc::new(crate::dispatcher::subprocess::SubprocessDispatcher::new(
                "worker".to_string(),
                "127.0.0.1:1".parse().unwrap(),
            )),
            ui_dir: None,
            dataset_max_rows: 1_000_000,
        }
    }

    fn unique_profile(dataset_id: String, vus: u32) -> Profile {
        Profile {
            vus,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            data_binding: Some(DataBinding {
                dataset_id,
                policy: BindingPolicy::Unique,
                mappings: vec![],
            }),
        }
    }

    #[tokio::test]
    async fn unique_rejected_when_rows_below_worker_count() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        // 1 row; capacity 1 + vus 2 → N = 2; rows 1 < 2 → reject.
        let dataset_id =
            crate::store::datasets::insert(&db, "d", &["c".to_string()], &[vec!["a".to_string()]], 0)
                .await
                .unwrap();
        let state = state_with(db, 1).await;
        let err = validate_run_config(&state, &unique_profile(dataset_id, 2))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)), "rows < N must reject");
    }

    #[tokio::test]
    async fn unique_accepted_when_rows_meet_worker_count() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        // 2 rows; capacity 1 + vus 2 → N = 2; rows 2 >= 2 → Ok(Some(meta)).
        let dataset_id = crate::store::datasets::insert(
            &db,
            "d",
            &["c".to_string()],
            &[vec!["a".to_string()], vec!["b".to_string()]],
            0,
        )
        .await
        .unwrap();
        let state = state_with(db, 1).await;
        let meta = validate_run_config(&state, &unique_profile(dataset_id, 2))
            .await
            .unwrap();
        assert!(meta.is_some(), "valid unique binding returns the dataset meta");
    }
```

> If `mod tests` already has a `use` block / helpers, merge rather than duplicate. Confirm `Profile`'s exact field set with `crates/controller/src/store/runs.rs` and adjust the literal if it differs.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p handicap-controller --lib api::runs::tests::unique_ -- --nocapture`
Expected: FAIL — `unique_rejected_*` fails because the current gate rejects ALL unique (line 64) so it errors for the wrong reason / `unique_accepted_*` fails (unique rejected unconditionally).

- [ ] **Step 3: Replace the unconditional reject with the N-floor + u32 + cap logic**

In `validate_run_config`, **delete** the block (lines ~64-68):

```rust
    if matches!(b.policy, BindingPolicy::Unique) {
        return Err(ApiError::BadRequest(
            "unique 정책은 아직 지원하지 않습니다 (다음 슬라이스)".into(),
        ));
    }
```

After the empty-dataset check (`if meta.row_count == 0 { … }`) and the column-existence loop, add the unique-specific gates:

```rust
    if matches!(b.policy, BindingPolicy::Unique) {
        // shard_split is u32 (grpc/shard.rs) — refuse rows that would truncate.
        if meta.row_count as u64 > u32::MAX as u64 {
            return Err(ApiError::BadRequest(
                "unique 정책은 데이터셋 행 수가 u32 범위를 넘을 수 없습니다".into(),
            ));
        }
        // Every worker must get at least one row, else a worker would generate
        // unbound load (dataset=None path). rows >= N ⟹ all shard counts >= 1.
        let n = state.coord.worker_count_for(profile.vus);
        if (meta.row_count as u64) < n as u64 {
            return Err(ApiError::BadRequest(format!(
                "unique 정책은 데이터셋 행 수가 워커 수 이상이어야 합니다: rows={} < workers={n}",
                meta.row_count
            )));
        }
    }
```

Then include unique in the per-iteration cap check. Change:

```rust
    let per_iteration = matches!(
        b.policy,
        BindingPolicy::IterSequential | BindingPolicy::IterRandom
    );
```

to:

```rust
    let per_iteration = matches!(
        b.policy,
        BindingPolicy::IterSequential | BindingPolicy::IterRandom | BindingPolicy::Unique
    );
```

- [ ] **Step 4: Replace the `unreachable!` resolution arm in `create`**

In `create` (~:142), change:

```rust
                BindingPolicy::Unique => unreachable!("unique rejected by validate_run_config"),
```

to:

```rust
                // unique stores the TOTAL row count; assignment_for partitions it
                // into per-worker disjoint slices at register time (Task 5).
                BindingPolicy::Unique => (
                    handicap_proto::v1::data_binding::Policy::Unique,
                    meta.row_count as u64,
                ),
```

- [ ] **Step 5: Run the gate tests + worker build**

Run: `cargo test -p handicap-controller --lib api::runs::tests::unique_`
Expected: PASS.
Run: `cargo build -p handicap-worker`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/api/runs.rs
git commit -m "feat(controller): accept unique binding — N-floor + u32 gate + resolution"
```

---

## Task 5: Controller — per-worker disjoint slice (`WorkerStream`)

**Files:**
- Modify: `crates/controller/src/grpc/shard.rs` (new `dataset_slice` + test)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`WorkerStream` struct, `assignment_for` :252-281, `stream_dataset` :672-743, call site :634-638)

- [ ] **Step 1: Write the failing `dataset_slice` test**

In `crates/controller/src/grpc/shard.rs` `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn dataset_slice_unique_partitions_disjoint() {
        // unique: disjoint contiguous shards summing to total.
        assert_eq!(dataset_slice(true, 5, 2, 0), (0, 3));
        assert_eq!(dataset_slice(true, 5, 2, 1), (3, 2));
        // replicated (per_vu / iter_*): every worker gets the whole count at offset 0.
        assert_eq!(dataset_slice(false, 5, 2, 0), (0, 5));
        assert_eq!(dataset_slice(false, 5, 2, 1), (0, 5));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p handicap-controller --lib grpc::shard::tests::dataset_slice`
Expected: FAIL — `cannot find function dataset_slice`.

- [ ] **Step 3: Add `dataset_slice` to `shard.rs`**

```rust
/// Per-worker dataset slice. `unique` partitions the dataset into disjoint
/// contiguous shards (`shard_split`); replicated policies (per_vu / iter_*) give
/// every worker the same `(0, total)`. Returns `(offset, count)` as u64.
/// Caller guarantees `total <= u32::MAX` for unique (validation gate). (spec §4.4)
pub fn dataset_slice(is_unique: bool, total: u64, shard_count: u32, shard_index: u32) -> (u64, u64) {
    if is_unique {
        let (offset, count) = shard_split(total as u32, shard_count, shard_index);
        (offset as u64, count as u64)
    } else {
        (0, total)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p handicap-controller --lib grpc::shard::tests::dataset_slice`
Expected: PASS.

- [ ] **Step 5: Add the `WorkerStream` struct in `coordinator.rs`**

After the `PendingDataBinding` impl (~:60), add:

```rust
/// One worker's resolved dataset stream: which rows to fetch + the mappings to
/// apply. For unique these are a disjoint slice (`offset_i..offset_i+count_i`);
/// for replicated policies it's the whole dataset (`offset 0`). (spec §4.4)
struct WorkerStream {
    dataset_id: String,
    mappings: Vec<Mapping>,
    offset: u64,
    count: u64,
}
```

- [ ] **Step 6: Rewrite `assignment_for` to emit per-worker count + return `WorkerStream`**

Change the signature return type from `Option<(RunAssignment, Option<PendingDataBinding>)>` to:

```rust
    ) -> Option<(RunAssignment, Option<WorkerStream>)> {
```

Replace the body (from `let a = &rw.base;` to the `Some((assignment, …))` return) with:

```rust
        let a = &rw.base;
        let binding = a.data_binding.as_ref();
        // Resolve this worker's slice: unique partitions disjointly; others replicate.
        let stream = binding.map(|b| {
            let is_unique = b.policy == pb::data_binding::Policy::Unique;
            let (offset, count) = crate::grpc::shard::dataset_slice(
                is_unique,
                b.row_count,
                shard_count,
                shard_index,
            );
            WorkerStream {
                dataset_id: b.dataset_id.clone(),
                mappings: b.mappings.clone(),
                offset,
                count,
            }
        });
        let assignment = RunAssignment {
            run_id: run_id.to_string(),
            scenario_yaml: a.scenario_yaml.clone(),
            profile: Some(a.profile),
            env: a.env.clone(),
            // proto row_count is the PER-WORKER count (count_i for unique).
            data_binding: binding.zip(stream.as_ref()).map(|(b, s)| pb::DataBinding {
                policy: b.policy as i32,
                seed: b.seed,
                row_count: s.count,
            }),
            shard_index,
            shard_count,
            vu_offset,
            vu_count,
        };
        Some((assignment, stream))
```

(`shard_count` here is the per-run worker count N — the register caller passes `rw.expected`.)

- [ ] **Step 7: Rewrite `stream_dataset` to take a `WorkerStream` (offset-aware)**

Change the signature + body opening:

```rust
async fn stream_dataset(state: &CoordinatorState, tx: &WorkerTx, run_id: &str, ws: &WorkerStream) {
    let total = ws.count as i64;
    let mut sent: i64 = 0;
    let mut incomplete = false;
    while sent < total {
        let limit = DATASET_BATCH_ROWS.min(total - sent);
        let src = match crate::store::datasets::get_rows_range(
            &state.db,
            &ws.dataset_id,
            ws.offset as i64 + sent,
            limit,
        )
        .await
        {
```

And change the per-row mapping application (was `binding.mappings_apply(row)`):

```rust
        let proto_rows: Vec<pb::DatasetRow> = src
            .iter()
            .map(|row| pb::DatasetRow {
                values: crate::binding::apply_mappings(&ws.mappings, row)
                    .into_iter()
                    .collect(),
            })
            .collect();
```

(The rest of `stream_dataset` — batching loop, `incomplete` AbortRun, success log — is unchanged.)

- [ ] **Step 8: Update the register call site to use the `WorkerStream` guard**

In the stream handler (~:600-638), the binding is now a `WorkerStream`. The `assignment_for` destructure stays (`let Some((assignment, stream)) = state.assignment_for(...)`); rename the variable and change the guard block (was lines 634-638):

```rust
                        // Stream this worker's dataset slice (disjoint for unique,
                        // replicated otherwise). Row values are NEVER logged (spec §11).
                        if let Some(ws) = &stream {
                            if ws.count > 0 {
                                stream_dataset(&state, &tx, &reg.run_id, ws).await;
                            }
                        }
```

> The `let Some((assignment, binding)) = …` binding pattern (~:600) should be renamed to `let Some((assignment, stream)) = …`.

- [ ] **Step 9: Build, run controller tests, build worker**

Run: `cargo build -p handicap-controller`
Expected: clean (no other `assignment_for`/`stream_dataset` callers — grep to confirm: `cargo build` is the check).
Run: `cargo test -p handicap-controller`
Expected: PASS (existing coordinator/e2e binding tests still green — non-unique path is byte-identical: `offset 0`, `count = row_count`).
Run: `cargo build -p handicap-worker`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add crates/controller/src/grpc/shard.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): partition dataset into per-worker disjoint slices for unique"
```

---

## Task 6: UI — policy option, Zod enum, banner

**Files:**
- Modify: `ui/src/api/schemas.ts` (`BindingPolicyEnum` :20)
- Modify: `ui/src/components/DataBindingPanel.tsx` (`showBanner` :198, dropdown :375-377, banner block :382-392)
- Modify: `ui/src/components/__tests__/DataBindingPanel.test.tsx` (update the option-count test :260; add a unique case)

> The existing test harness: `renderPanel(scenario, onChange?, onValidityChange?)` is **positional** (file :122). The policy `<select aria-label="policy">` only renders **after a dataset is selected** — every policy test does `await screen.findByLabelText(/dataset/i)` → `user.selectOptions(datasetSelect, "DS1")` → `await screen.findByLabelText(/policy/i)` (see :234-258). The banner needs `selectedId` set too. Follow this exact pattern.

- [ ] **Step 1a: Update the existing option-count test (currently asserts NO unique) — it would otherwise go red**

In `ui/src/components/__tests__/DataBindingPanel.test.tsx`, the test at :260 (`"policy dropdown has exactly per_vu/iter_sequential/iter_random — no 'unique'"`). Rename it and flip the two assertions at :284-285:

```tsx
  it("policy dropdown offers per_vu/iter_sequential/iter_random/unique", async () => {
    // ... unchanged setup (renderPanel + select DS1 + read policy options) ...
    expect(options).toContain("per_vu");
    expect(options).toContain("iter_sequential");
    expect(options).toContain("iter_random");
    expect(options).toContain("unique");
    expect(options).toHaveLength(4);
  });
```

- [ ] **Step 1b: Add the failing unique-selection test**

```tsx
  it("selects the unique policy and shows the stop-VU banner", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPanel(makeScenario(), onChange);
    const datasetSelect = await screen.findByLabelText(/dataset/i);
    await user.selectOptions(datasetSelect, "DS1");
    const policySelect = await screen.findByLabelText(/policy/i);
    await user.selectOptions(policySelect, "unique");
    expect(policySelect).toHaveValue("unique");
    expect(screen.getByText(/소진된 VU/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test -- DataBindingPanel`
Expected: FAIL — `unique` not an option (`selectOptions` throws / `toHaveLength(4)` fails) and `소진된 VU` banner text absent.

- [ ] **Step 3: Add `unique` to the Zod enum**

In `ui/src/api/schemas.ts`:

```ts
export const BindingPolicyEnum = z.enum(["per_vu", "iter_sequential", "iter_random", "unique"]);
```

- [ ] **Step 4: Add the dropdown option + banner**

In `ui/src/components/DataBindingPanel.tsx`, add the option after `iter_random` (:377):

```tsx
              <option value="unique">unique — 행마다 1회 소비, 소진 시 VU 종료</option>
```

Extend `showBanner` (:198):

```tsx
  const showBanner =
    !!selectedId &&
    (policy === "iter_sequential" || policy === "iter_random" || policy === "unique");
```

The banner (:382-392) is currently a **single static block** (NOT keyed off `policy`). Make its body conditional — keep the existing iter_* copy verbatim, add the `unique` branch:

```tsx
          {/* per-iteration / unique warning banner */}
          {showBanner && (
            <div
              role="alert"
              className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              {policy === "unique" ? (
                <>
                  unique 정책은 데이터셋 전체를 워커별로 분할해 각 행을 1회만 사용합니다. 소진된 VU는
                  종료되고 부하(RPS)는 그 시점부터 감소합니다. (행 수 ≥ 워커 수 필요)
                </>
              ) : (
                <>
                  per-iteration 정책은 전체 데이터셋
                  {rowCount !== undefined ? `(${rowCount}행)` : ""}을 워커 메모리에 적재합니다. 상한은
                  controller <code>--dataset-max-rows</code>
                  (Helm <code>controller.datasetMaxRows</code>).
                </>
              )}
            </div>
          )}
```

- [ ] **Step 5: Run the test + the full UI gate**

Run: `cd ui && pnpm test -- DataBindingPanel`
Expected: PASS.
Run: `cd ui && pnpm build`
Expected: `tsc -b` clean + vite build OK (catches Zod/enum type drift `pnpm test` misses).

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/schemas.ts ui/src/components/DataBindingPanel.tsx ui/src/components/__tests__/DataBindingPanel.test.tsx
git commit -m "feat(ui): unique data-binding policy option + banner"
```

---

## Task 7: e2e — 2-worker unique uniqueness

**Files:**
- Modify: `crates/controller/tests/multi_worker_fanout_e2e.rs` (new `#[tokio::test]`, reuse `boot`/`bind_local`/`worker_bin_path`)

- [ ] **Step 1: Write the e2e test**

Append to `crates/controller/tests/multi_worker_fanout_e2e.rs` (model on `two_worker_fanout_completes` :83 + the per_vu binding profile from `e2e_test.rs` :956). It forces N=2 via `capacity 1`, seeds 6 unique tokens (rows 6 ≥ N 2 → no rejection), injects `{{tok}}` into the query, and asserts **no token reaches the target twice**:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_worker_unique_consumes_each_row_once() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let worker_bin = worker_bin_path().await;
    assert!(worker_bin.exists(), "worker bin not at {:?}", worker_bin);

    let target = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(2)),
        )
        .mount(&target)
        .await;

    let (rest_listener, rest_addr) = bind_local().await;
    let (grpc_listener, grpc_addr) = bind_local().await;
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::with_capacity(db.clone(), 1); // capacity 1 → N = vus
    let (rest_handle, grpc_handle) =
        boot(coord, db.clone(), grpc_listener, rest_listener, grpc_addr, &worker_bin).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // 6 unique tokens; 2 workers → disjoint slices (0,3) and (3,3).
    let dataset_id = store::datasets::insert(
        &db,
        "toks",
        &["tok".to_string()],
        &(0..6).map(|i| vec![format!("t{i}")]).collect::<Vec<_>>(),
        0,
    )
    .await
    .unwrap();

    let http = reqwest::Client::new();
    let rest_base = format!("http://{}", rest_addr);
    let scenario_yaml = format!(
        "version: 1\nname: unique-e2e\nsteps:\n  - id: \"01HX0000000000000000000033\"\n    name: hit\n    type: http\n    request:\n      method: GET\n      url: \"{}/hit?tok={{{{tok}}}}\"\n",
        target.uri()
    );
    let v: Value = http
        .post(format!("{}/api/scenarios", rest_base))
        .json(&json!({ "yaml": scenario_yaml }))
        .send().await.unwrap().json().await.unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 2 VUs, capacity 1 → 2 workers; unique → each worker consumes its 3 tokens once.
    let v: Value = http.post(format!("{}/api/runs", rest_base))
        .json(&json!({
            "scenario_id": scenario_id,
            "profile": {
                "vus": 2, "duration_seconds": 3, "ramp_up_seconds": 0,
                "data_binding": {
                    "dataset_id": dataset_id,
                    "policy": "unique",
                    "mappings": [{"kind": "column", "var": "tok", "column": "tok"}]
                }
            },
            "env": {}
        }))
        .send().await.unwrap().json().await.unwrap();
    let run_id = v["id"].as_str().unwrap().to_string();

    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        let v: Value = http
            .get(format!("{}/api/runs/{}", rest_base, run_id))
            .send().await.unwrap().json().await.unwrap();
        last = v["status"].as_str().unwrap_or("").to_string();
        if last == "completed" || last == "failed" || last == "aborted" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(last, "completed", "unique fan-out should complete; got {last}");

    // Uniqueness: the query is only `tok={value}` → strip the prefix. No token twice.
    // (`.query()` is the repo idiom — sibling tests use it, not `query_pairs()`.)
    let reqs = target.received_requests().await.unwrap();
    let toks: Vec<String> = reqs
        .iter()
        .filter_map(|r| {
            r.url
                .query()
                .and_then(|q| q.strip_prefix("tok="))
                .map(|t| t.to_string())
        })
        .collect();
    let distinct: std::collections::HashSet<&String> = toks.iter().collect();
    assert!(!toks.is_empty(), "expected unique-bound requests, saw none");
    assert_eq!(
        toks.len(),
        distinct.len(),
        "unique policy must not reuse a row: {toks:?}"
    );
    // Every observed token is a real dataset token (mappings applied, no `{{tok}}`).
    assert!(
        toks.iter().all(|t| t.starts_with('t') && !t.contains('{')),
        "unbound or malformed token leaked: {toks:?}"
    );

    rest_handle.abort();
    grpc_handle.abort();
}
```

- [ ] **Step 2: Run the e2e**

Run: `cargo test -p handicap-controller --test multi_worker_fanout_e2e two_worker_unique -- --nocapture`
Expected: PASS — run completes, no token appears twice. (If flaky on a cold build, retry warm — see memory `flaky-e2e-cold-build`.)

- [ ] **Step 3: Commit**

```bash
git add crates/controller/tests/multi_worker_fanout_e2e.rs
git commit -m "test(e2e): 2-worker unique binding consumes each row at most once"
```

---

## Task 8: Docs — ADR, CLAUDE.md, roadmap

**Files:**
- Modify: `docs/adr/0022-*.md` (resolve "unique reserved")
- Modify: `CLAUDE.md` (decisions list 0022 line)
- Modify: `crates/engine/CLAUDE.md`, `crates/controller/CLAUDE.md`, `ui/CLAUDE.md` (domain traps)
- Modify: `docs/roadmap.md` (§A1/§B1/§B2'' — mark unique done)

- [ ] **Step 1: Update ADR-0022**

In `docs/adr/0022-*.md`, add a dated note that `unique` is now implemented (post-A3): stop-VU on exhaust, static disjoint slices via `shard_split`/`dataset_slice`, `rows >= N` + `rows <= u32::MAX` gate, counts-only (no new metric/proto field beyond `Policy::UNIQUE=3`). Reference this spec/plan.

- [ ] **Step 2: Update root `CLAUDE.md`**

In the "알아둘 결정들" 0022 line, append that unique is complete (멀티워커 disjoint 슬라이스 + stop-VU). Update the status header / Slice list if it tracks binding policies.

- [ ] **Step 3: Add domain traps**

- `crates/engine/CLAUDE.md`: `select_index` returns `Option<usize>` — `Unique` returns `None` on exhaust (no wrap); shared counter created for `IterSequential | Unique`; `run_vu` `None → break` is a clean VU completion (no `failed`++).
- `crates/controller/CLAUDE.md`: `unique` partition — `PendingDataBinding.row_count` means TOTAL for unique (read ONLY by `assignment_for`, which emits per-worker `count_i` to proto/stream/guard via `WorkerStream`); `dataset_slice` in `shard.rs`; gate rejects `rows < N` (no empty slice → no unbound-load path) and `rows > u32::MAX`.
- `ui/CLAUDE.md`: `BindingPolicyEnum` includes `unique`; `<input list>`/select test note already covers the panel.

- [ ] **Step 4: Update `docs/roadmap.md`**

Mark §B1 / §B2'' `unique` 바인딩 as DONE (this slice); note the `on_exhaust: fail` toggle remains deferred.

- [ ] **Step 5: Conflict-marker scan + commit (docs-only fast-path skips cargo)**

```bash
grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md ; echo "marker check: $?"
git add docs/adr CLAUDE.md crates/engine/CLAUDE.md crates/controller/CLAUDE.md ui/CLAUDE.md docs/roadmap.md
git commit -m "docs: unique binding policy — ADR-0022, CLAUDE.md traps, roadmap"
```

---

## Task 9: Final whole-feature review

- [ ] **Step 1: Run all gates from a clean state**

```bash
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build -p handicap-worker
cd ui && pnpm test && pnpm build
```
Expected: all green.

- [ ] **Step 2: Dispatch the `handicap-reviewer` agent**

Review the whole branch diff against the spec, focusing on: engine↔proto↔controller↔worker **wire 1:1** (`Policy::UNIQUE=3` ↔ engine `Unique` ↔ `WorkerStream.count`), the `row_count`-means-total-for-unique invariant (only `assignment_for` reads it), N-floor/u32 gate, non-unique byte-identical path, and the deferral note (`on_exhaust` toggle). Read-only.

- [ ] **Step 3: Address findings, re-run gates, then finish the branch**

Per `superpowers:finishing-a-development-branch` (this repo: local ff-merge to `master`, no remote — root CLAUDE.md git topology).

---

## Self-Review (plan author)

**Spec coverage:** §4.1 engine → T1; §4.2 proto → T2; §4.5 worker → T3; §4.3 gate+resolution → T4; §4.4 partition (WorkerStream/assignment_for/stream_dataset) → T5; §4.7 UI → T6; §7 e2e uniqueness → T7; §4.6 (no metric change) → covered by absence (no migration/proto-field task); §10 ADR/docs → T8. §3.3 `on_exhaust` deferral recorded in T8 Step 4. All spec sections mapped.

**Placeholder scan:** All code steps contain full code. Two "match the existing file" notes (T4 Profile fields, T6 banner JSX) point at concrete existing code the implementer reads — not invented APIs.

**Type consistency:** `select_index -> Option<usize>` consistent across T1 (def), used in T1 runner + T7 (engine test). `WorkerStream { dataset_id, mappings, offset, count }` defined T5 Step 5, consumed T5 Steps 6-8 (`s.count` → proto `row_count`; `ws.offset`/`ws.count`/`ws.dataset_id`/`ws.mappings` → stream). `dataset_slice(is_unique, total, shard_count, shard_index) -> (u64,u64)` defined T5 Step 3, called T5 Step 6. `Policy::Unique` (proto) introduced T2, used T3 (worker map), T4 (resolution), T5 (is_unique check). Engine `BindingPolicy::Unique` introduced T1, used T1 runner + T7. Gate `rows >= N` (T4) ⟹ T5 `dataset_slice` never yields count 0 ⟹ T1 `None→break` only fires on real mid-run exhaustion — consistent end to end.
