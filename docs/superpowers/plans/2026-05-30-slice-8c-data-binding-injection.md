# Slice 8c — Data Binding + Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject CSV/XLSX dataset rows into `{{var}}` per VU/iteration during a run, with three binding policies (per_vu / iter_sequential / iter_random), end-to-end from the RunDialog binding UI through the controller, worker loading stage, and engine indexing.

**Architecture:** Run config (`profile_json`) carries a `data_binding` snapshot (dataset_id + policy + mappings). On run-create the controller validates the binding, computes a sliced row count, and enqueues it. When the worker registers, the controller streams the mapping-applied rows (`{var: value}`) as `DatasetBatch` messages over the existing bidi gRPC stream; the worker accumulates them into an in-memory dataset *before* starting the engine. The engine overlays the policy-selected row onto each iteration's flow vars (priority: scenario defaults → data → extract). The worker is **mapping-agnostic but policy-aware** (it computes the index; it never sees column names or mapping rules). `unique` is reserved (API-rejected) for a later slice.

**Tech Stack:** Rust (engine/controller/worker/proto), prost/tonic gRPC, sqlx/SQLite, axum 0.8, `rand` 0.8 (deterministic PRNG), React + TypeScript + Zod + React Query + vitest/RTL.

**Reference spec:** `docs/superpowers/specs/2026-05-30-slice-8-data-driven-design.md` §4 (policies), §7 (transport+wiring), §8c (engine indexing/overlay), §9 (RunDialog binding), §11 (validation gate), §13-8c (completion), §14 (deps).

**Prerequisites already shipped:** 8a (body templating — `executor.rs` renders form values + JSON string leaves) and 8b (dataset resource — `datasets`/`dataset_rows` tables, `/api/datasets` CRUD, `store::datasets`, `crates/controller/src/datasets/parse.rs`). Both merged to `master`.

---

## Conventions & Traps (read before starting)

- **Worktree**: work in `.claude/worktrees/slice-8c` (gitignored). Subagent prompts must start with `cd /Users/sgj/develop/handicap/.claude/worktrees/slice-8c`.
- **Worker rebuild trap** (spec §11, CLAUDE.md): 8c changes the engine + worker + proto. `cargo run -p handicap-controller --bin controller` does **not** rebuild `target/debug/worker`. Run `cargo build -p handicap-worker` before any manual check or e2e, and the e2e helper `worker_bin_path()` already does `cargo build -p handicap-worker` for you.
- **Controller has two bins**: always `cargo run -p handicap-controller --bin controller -- …` (there is also `e2e_kind_driver`).
- **Pre-commit hook** runs `cargo fmt --check && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`. Never `--no-verify`. A lone `full_slice_1_e2e` signal-9 on a cold build is a known flake (memory [[flaky-e2e-cold-build]]) — re-run the same commit warm.
- **TDD-guard**: editing `crates/*/src/*.rs` or `ui/src/*.{ts,tsx}` requires a pending test file on disk first. New Rust modules with only inline `#[cfg(test)]` won't satisfy it at creation time — create the integration/`__tests__` test file first, or write the inline-test module's source so the file already has `#[cfg(test)] mod tests` when first written is not enough (file doesn't exist on disk yet). Standard unblock: write the test file (or a temp `crates/<x>/tests/_tdd_unblock.rs`, `rm` before commit).
- **prost enums are i32 fields**: `pb::DataBinding.policy` is an `i32`. Convert with `pb::data_binding::Policy::try_from(i32)`. prost structs are exhaustive (no `..Default::default()`) — adding a proto field breaks every struct-literal site; grep for them.
- **`reqwest`/`StdRng` API**: pin `rand = "0.8"` (this plan uses `StdRng::seed_from_u64` + `rng.gen_range(0..n)`, the 0.8 API). Do not let it resolve to 0.9 (renamed `gen_range`→`random_range`).
- **Review discipline**: reviewers use read-only git only (`git diff`/`git show <sha>`). Never `checkout`/`switch`/`stash` (detaches the worktree HEAD).

---

## File Structure

**Create:**
- `crates/engine/src/dataset.rs` — `DataSet`, `BindingPolicy`, deterministic index selection (`select_index`, `splitmix64`). Owns all PRNG/indexing logic.
- `crates/engine/tests/data_binding.rs` — wiremock integration: per_vu reaches distinct values, iter_sequential cycles.
- `crates/controller/src/binding.rs` — run-config `DataBinding`/`BindingPolicy`/`Mapping` types (serde, in `profile_json`) + `unique` rejection + slicing + seed fold helpers.
- `crates/controller/tests/data_binding_api_test.rs` — run-create validation gate (column-missing, empty dataset, `unique`, over-max) + slicing/seed unit coverage via the API.
- `ui/src/scenario/scanVars.ts` — `{{var}}` scanner over url/headers/body(form+json leaves), recursing loop `do:`.
- `ui/src/scenario/__tests__/scanVars.test.ts` — scanner unit tests.
- `ui/src/components/DataBindingPanel.tsx` — RunDialog binding subcomponent (mapping table, policy dropdown, validation, warning banner).
- `ui/src/components/__tests__/DataBindingPanel.test.tsx` — RTL.

**Modify:**
- `crates/proto/proto/coordinator.proto` — `DataBinding`/`DatasetRow`/`DatasetBatch` messages; `RunAssignment.data_binding=5`; `ServerMessage.payload.dataset_batch=4`.
- `crates/engine/src/lib.rs` — export `dataset` module types; `crates/engine/src/runner.rs` — `RunPlan.data_binding`, overlay + index in `run_vu`, seq counter in `run_scenario`.
- `crates/engine/Cargo.toml` + root `Cargo.toml` — `rand` dep.
- `crates/controller/src/store/runs.rs` — `Profile.data_binding: Option<DataBinding>` (`#[serde(default)]`).
- `crates/controller/src/api/runs.rs` — validation gate + build `PendingDataBinding`.
- `crates/controller/src/grpc/coordinator.rs` — `PendingAssignment.data_binding`; populate `RunAssignment.data_binding`; stream `DatasetBatch` on Register.
- `crates/controller/src/store/datasets.rs` — `get_rows_range` (batched idx-ordered fetch).
- `crates/controller/src/app.rs` + `src/main.rs` — `AppState.dataset_max_rows` + `--dataset-max-rows` CLI.
- `crates/worker-core/src/{lib.rs,client.rs,error.rs}` — `load_dataset` helper + `DatasetIncomplete` error.
- `crates/worker/src/main.rs` — loading stage; build `DataSet`; pass via `RunPlan`.
- `ui/src/api/{schemas.ts,client.ts,hooks.ts}` — binding payload shape + `useDataset` sample hook.
- `ui/src/components/RunDialog.tsx` + `ui/src/pages/ScenarioRunsPage.tsx` — mount `DataBindingPanel`, thread scenario YAML, include `data_binding` in the create payload.
- `docs/adr/0022-data-driven-datasets.md`, `CLAUDE.md`.

---

### Task 0: Add `rand` dependency (engine) + build verification

**Files:**
- Modify: `Cargo.toml` (workspace deps)
- Modify: `crates/engine/Cargo.toml`

- [ ] **Step 1: Add `rand` to workspace deps**

In `Cargo.toml` `[workspace.dependencies]`, add (alphabetical, after `proptest`):

```toml
rand = "0.8"
```

- [ ] **Step 2: Add `rand` to the engine crate**

In `crates/engine/Cargo.toml` `[dependencies]` (after `hdrhistogram.workspace = true`):

```toml
rand = { workspace = true }
```

- [ ] **Step 3: Verify it resolves on MSRV/edition and lockfile updates**

Run: `cargo build -p handicap-engine`
Expected: builds clean. Confirm `rand` resolved to a `0.8.x` line:
Run: `cargo tree -p handicap-engine -i rand | head -3`
Expected: shows `rand v0.8.x` (NOT 0.9). If 0.9 appears, the pin is wrong — fix the version requirement to `=0.8` and rebuild.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock crates/engine/Cargo.toml
git commit -m "build(engine): add rand 0.8 for deterministic dataset PRNG (8c)"
```

---

### Task 1: proto — DataBinding / DatasetRow / DatasetBatch + wire into RunAssignment & ServerMessage

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`
- Modify: `crates/controller/src/grpc/coordinator.rs:113-118` (RunAssignment literal — add `data_binding: None`)
- Test: `crates/proto` has no test harness; verify via `cargo build` + a construction test added in `crates/controller/tests/data_binding_api_test.rs` is deferred to Task 4. For this task, the gate is `cargo build --workspace`.

- [ ] **Step 1: Add the proto messages and fields**

Edit `crates/proto/proto/coordinator.proto`.

Add the new messages near the bottom (after `Ping`):

```proto
// ---------- Data binding (Slice 8c) ----------

message DataBinding {
  Policy policy = 1;
  uint32 seed = 2;        // controller folds run_id (ULID) → u32; determinism only
  uint64 row_count = 3;   // rows the worker will receive after policy-aware slicing
  enum Policy {
    PER_VU = 0;
    ITER_SEQUENTIAL = 1;
    ITER_RANDOM = 2;
    // UNIQUE reserved — rejected at the controller, see spec §12.
  }
}

// One row with mappings already applied: keys are flow-var names, not columns.
message DatasetRow {
  map<string, string> values = 1;
}

message DatasetBatch {
  string run_id = 1;
  repeated DatasetRow rows = 2;
}
```

Add `data_binding` to `RunAssignment` (field 5):

```proto
message RunAssignment {
  string run_id = 1;
  string scenario_yaml = 2;
  Profile profile = 3;
  map<string, string> env = 4;
  DataBinding data_binding = 5;   // absent → no data injection (back-compat)
}
```

Add `dataset_batch` to the `ServerMessage` oneof (field 4):

```proto
message ServerMessage {
  oneof payload {
    RunAssignment assignment = 1;
    AbortRun abort = 2;
    Ping ping = 3;
    DatasetBatch dataset_batch = 4;
  }
}
```

- [ ] **Step 2: Build proto to regenerate prost types**

Run: `cargo build -p handicap-proto`
Expected: builds; `pb::DataBinding`, `pb::data_binding::Policy`, `pb::DatasetRow`, `pb::DatasetBatch`, `pb::server_message::Payload::DatasetBatch` now exist.

- [ ] **Step 3: Fix the one RunAssignment literal so the workspace compiles**

In `crates/controller/src/grpc/coordinator.rs`, the `RunAssignment { … }` literal (~line 113) now misses `data_binding`. Add it as `None` for now (Task 5 wires the real value):

```rust
let assignment = RunAssignment {
    run_id: reg.run_id.clone(),
    scenario_yaml: a.scenario_yaml,
    profile: Some(a.profile),
    env: a.env,
    data_binding: None,
};
```

- [ ] **Step 4: Verify the whole workspace still compiles**

Run: `cargo build --workspace`
Expected: clean. The worker's `if let Some(ServerPayload::Abort(a))` match is non-exhaustive (if-let), so the new `DatasetBatch` variant needs no change there yet.

- [ ] **Step 5: Commit**

```bash
git add crates/proto/proto/coordinator.proto crates/controller/src/grpc/coordinator.rs
git commit -m "proto(coordinator): DataBinding/DatasetRow/DatasetBatch + RunAssignment.data_binding + ServerMessage.dataset_batch (8c)"
```

---

### Task 2: Engine — dataset types, indexing, per-iteration overlay

**Files:**
- Create: `crates/engine/src/dataset.rs`
- Modify: `crates/engine/src/lib.rs`, `crates/engine/src/runner.rs`
- Create: `crates/engine/tests/data_binding.rs`

- [ ] **Step 1: Write the dataset module with inline unit tests (this also satisfies TDD-guard for runner.rs edits below — but create this file first)**

Create `crates/engine/src/dataset.rs`:

```rust
//! Data-driven binding: an in-memory dataset plus the policy that decides which
//! row a given (vu_id, iter_id) sees. Rows arrive from the controller with
//! mappings already applied — keys are flow-var names, not source columns
//! (spec §2 "mapping-agnostic worker"). Indexing is deterministic so a run's
//! report reproduces the exact sequence (spec §11).
use std::collections::BTreeMap;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingPolicy {
    /// Fixed row per VU for the whole run: `idx = vu_id % rows`.
    PerVu,
    /// Worker-local monotonic counter, advanced once per VU iteration.
    IterSequential,
    /// Deterministic PRNG keyed by (seed, vu_id, iter_id) per iteration.
    IterRandom,
}

/// One run's bound dataset. `rows` is non-empty (the controller's validation
/// gate rejects empty datasets, spec §11) but `select_index` defends anyway.
#[derive(Debug)]
pub struct DataSet {
    pub policy: BindingPolicy,
    pub seed: u32,
    pub rows: Vec<BTreeMap<String, String>>,
}

impl DataSet {
    /// Row index for this (vu_id, iter_id). `counter` is the shared
    /// worker-local sequential counter (Some only for `IterSequential`);
    /// `select_index` does the `fetch_add` so the increment happens exactly
    /// once per iteration at the call site.
    pub fn select_index(
        &self,
        vu_id: u32,
        iter_id: u32,
        counter: Option<&std::sync::atomic::AtomicU64>,
    ) -> usize {
        let len = self.rows.len();
        debug_assert!(len > 0, "DataSet::select_index on empty rows");
        match self.policy {
            BindingPolicy::PerVu => (vu_id as usize) % len,
            BindingPolicy::IterSequential => {
                let c = counter.expect("IterSequential requires a shared counter");
                (c.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as usize) % len
            }
            BindingPolicy::IterRandom => {
                let mixed = mix(self.seed, vu_id, iter_id);
                let mut rng = StdRng::seed_from_u64(mixed);
                rng.gen_range(0..len)
            }
        }
    }
}

/// Mix (seed, vu_id, iter_id) into a u64 RNG seed via splitmix64 rounds.
/// Direct XOR-then-modulo would stripe (spec §4); a full mix de-correlates
/// adjacent ids so consecutive iterations don't walk the dataset in lockstep.
fn mix(seed: u32, vu_id: u32, iter_id: u32) -> u64 {
    let mut z = seed as u64;
    z = splitmix64(z.wrapping_add(vu_id as u64));
    splitmix64(z.wrapping_add(iter_id as u64))
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn rows(n: usize) -> Vec<BTreeMap<String, String>> {
        (0..n)
            .map(|i| {
                let mut m = BTreeMap::new();
                m.insert("user".to_string(), format!("u{i}"));
                m
            })
            .collect()
    }

    #[test]
    fn per_vu_is_fixed_and_wraps() {
        let ds = DataSet { policy: BindingPolicy::PerVu, seed: 0, rows: rows(3) };
        // Same vu, different iter → same index (fixed for the run).
        assert_eq!(ds.select_index(1, 0, None), ds.select_index(1, 99, None));
        assert_eq!(ds.select_index(1, 0, None), 1);
        // vu beyond rows wraps.
        assert_eq!(ds.select_index(4, 0, None), 1);
    }

    #[test]
    fn iter_sequential_advances_once_per_call_and_wraps() {
        let ds = DataSet { policy: BindingPolicy::IterSequential, seed: 0, rows: rows(2) };
        let c = AtomicU64::new(0);
        assert_eq!(ds.select_index(0, 0, Some(&c)), 0);
        assert_eq!(ds.select_index(0, 1, Some(&c)), 1);
        assert_eq!(ds.select_index(0, 2, Some(&c)), 0); // wrap
    }

    #[test]
    fn iter_random_is_deterministic_for_same_inputs() {
        let ds = DataSet { policy: BindingPolicy::IterRandom, seed: 42, rows: rows(5) };
        let a = ds.select_index(3, 7, None);
        let b = ds.select_index(3, 7, None);
        assert_eq!(a, b, "same (seed,vu,iter) must reproduce the same index");
        assert!(a < 5);
    }

    #[test]
    fn iter_random_varies_across_iterations() {
        let ds = DataSet { policy: BindingPolicy::IterRandom, seed: 1, rows: rows(50) };
        let seq: Vec<usize> = (0..10).map(|i| ds.select_index(0, i, None)).collect();
        let distinct: std::collections::HashSet<_> = seq.iter().collect();
        assert!(distinct.len() > 1, "random policy should not be constant: {seq:?}");
    }
}
```

- [ ] **Step 2: Run the dataset unit tests (they fail to compile until exported, that's fine — run after export)**

Defer running until Step 3 wires lib.rs. (Skipping a premature failing run here is intentional — the module isn't reachable yet.)

- [ ] **Step 3: Export the module**

In `crates/engine/src/lib.rs` add the module + re-exports:

```rust
pub mod dataset;
```

and in the `pub use` block:

```rust
pub use dataset::{BindingPolicy, DataSet};
```

- [ ] **Step 4: Run dataset unit tests**

Run: `cargo test -p handicap-engine dataset::`
Expected: 4 tests pass.

- [ ] **Step 5: Add `data_binding` to `RunPlan` and update all RunPlan literals to `None`**

In `crates/engine/src/runner.rs`, extend `RunPlan` (add the import + field):

```rust
use std::sync::Arc;
// (Arc already imported.)
use crate::dataset::{BindingPolicy, DataSet};

#[derive(Debug, Clone)]
pub struct RunPlan {
    pub vus: u32,
    pub ramp_up: Duration,
    pub duration: Duration,
    pub env: BTreeMap<String, String>,
    pub loop_breakdown_cap: u32,
    /// Optional data-driven binding. `None` → no injection (back-compat).
    pub data_binding: Option<Arc<DataSet>>,
}
```

Then grep for every `RunPlan {` literal and add `data_binding: None`:

Run: `grep -rn "RunPlan {" crates/ | grep -v "pub struct"`
Expected sites (add `data_binding: None,` to each): `crates/worker/src/main.rs`, and engine integration tests `crates/engine/tests/{loop_node.rs,multi_step.rs,ramp_up.rs,runner_e2e.rs,all_vus_failed.rs,template_env_wiring.rs}` (and any other that constructs RunPlan). Add the field to each literal.

- [ ] **Step 6: Implement the overlay + indexing in `run_scenario` / `run_vu`**

In `crates/engine/src/runner.rs`:

In `run_scenario`, after `let env = Arc::new(plan.env);` add the dataset + shared sequential counter:

```rust
    let dataset = plan.data_binding.clone();
    // One shared worker-local counter for IterSequential, created once per run.
    let seq_counter = match dataset.as_ref().map(|d| d.policy) {
        Some(BindingPolicy::IterSequential) => Some(Arc::new(std::sync::atomic::AtomicU64::new(0))),
        _ => None,
    };
```

In the VU spawn loop, clone them into each task and pass to `run_vu`:

```rust
            let dataset = dataset.clone();
            let seq_counter = seq_counter.clone();
            set.spawn(async move {
                if let Err(e) =
                    run_vu(scenario, vu_id, agg, deadline, env, dataset, seq_counter, cancel_vu).await
                {
                    if !matches!(e, EngineError::Aborted) {
                        warn!(vu_id, error = ?e, "vu failed");
                    }
                    failed.fetch_add(1, Ordering::Relaxed);
                }
            });
```

Extend `run_vu`'s signature and overlay the row right after the per-iteration `iter_vars` clone:

```rust
#[allow(clippy::too_many_arguments)]
#[instrument(skip(scenario, agg, env, dataset, seq_counter), fields(vu_id))]
async fn run_vu(
    scenario: Arc<Scenario>,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: Arc<BTreeMap<String, String>>,
    dataset: Option<Arc<DataSet>>,
    seq_counter: Option<Arc<std::sync::atomic::AtomicU64>>,
    cancel: CancellationToken,
) -> Result<()> {
    let client = VuClient::new(scenario.cookie_jar)?;
    let mut iter_id: u32 = 0;
    while Instant::now() < deadline {
        if cancel.is_cancelled() {
            return Err(EngineError::Aborted);
        }
        // Per-iteration flow vars: scenario defaults, then dataset overlay,
        // then extract (applied later inside execute_steps). Priority:
        // scenario.variables < data < extract (spec §8c F4).
        let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
        if let Some(ds) = &dataset {
            if !ds.rows.is_empty() {
                let idx = ds.select_index(vu_id, iter_id, seq_counter.as_deref());
                for (k, v) in &ds.rows[idx] {
                    iter_vars.insert(k.clone(), v.clone());
                }
            }
        }
        let flow = execute_steps(
            &client,
            &scenario.steps,
            &mut iter_vars,
            &agg,
            deadline,
            &env,
            vu_id,
            iter_id,
            None,
            &cancel,
        )
        .await?;
        match flow {
            StepFlow::Continue => {}
            StepFlow::DeadlineReached => return Ok(()),
            StepFlow::Aborted => return Err(EngineError::Aborted),
        }
        iter_id = iter_id.wrapping_add(1);
    }
    Ok(())
}
```

- [ ] **Step 7: Run engine unit + existing integration tests**

Run: `cargo test -p handicap-engine`
Expected: all pass (existing tests now construct `RunPlan { …, data_binding: None }`; behavior unchanged when `None`).

- [ ] **Step 8: Write the wiremock integration test (create the test file first — TDD-guard already satisfied by the inline tests, but this is the contract)**

Create `crates/engine/tests/data_binding.rs`:

```rust
//! Data binding end-to-end against wiremock: per_vu makes each VU send a
//! distinct dataset value; iter_sequential walks the dataset across iterations.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{BindingPolicy, DataSet, MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn row(user: &str) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    m.insert("user".to_string(), user.to_string());
    m
}

#[tokio::test]
async fn per_vu_sends_distinct_dataset_values() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    // Scenario: GET {base}/hit?u={{user}} — {{user}} comes from the dataset.
    let yaml = format!(
        r#"
version: 1
name: per-vu
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000020"
    name: hit
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/hit?u={{{{user}}}}"
"#,
        server.uri()
    );
    let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();

    let ds = DataSet {
        policy: BindingPolicy::PerVu,
        seed: 0,
        rows: vec![row("alice"), row("bob")],
    };
    let plan = RunPlan {
        vus: 2,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        data_binding: Some(Arc::new(ds)),
    };

    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(Arc::new(scenario), plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();

    // Inspect what wiremock actually received: both dataset values must appear.
    let reqs = server.received_requests().await.unwrap();
    let queries: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(queries.iter().any(|q| q.contains("u=alice")), "alice missing: {queries:?}");
    assert!(queries.iter().any(|q| q.contains("u=bob")), "bob missing: {queries:?}");
}

#[tokio::test]
async fn iter_sequential_walks_the_dataset() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(2)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: iter-seq
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000021"
    name: hit
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/hit?u={{{{user}}}}"
"#,
        server.uri()
    );
    let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();

    let ds = DataSet {
        policy: BindingPolicy::IterSequential,
        seed: 0,
        rows: vec![row("a0"), row("a1"), row("a2")],
    };
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        data_binding: Some(Arc::new(ds)),
    };

    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(Arc::new(scenario), plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();

    let reqs = server.received_requests().await.unwrap();
    let queries: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    // With a single VU iterating sequentially, all three values must be hit.
    for v in ["u=a0", "u=a1", "u=a2"] {
        assert!(queries.iter().any(|q| q.contains(v)), "{v} missing: {queries:?}");
    }
}
```

- [ ] **Step 9: Run the integration test**

Run: `cargo test -p handicap-engine --test data_binding`
Expected: both tests pass.

- [ ] **Step 10: Lint + commit**

```bash
cargo clippy -p handicap-engine --all-targets -- -D warnings
git add crates/engine/src/dataset.rs crates/engine/src/lib.rs crates/engine/src/runner.rs \
        crates/engine/tests/data_binding.rs crates/worker/src/main.rs crates/engine/tests
git commit -m "feat(engine): dataset binding types + per-iteration overlay + deterministic indexing (8c)"
```

---

### Task 3: Controller run-config binding types + `Profile.data_binding`

**Files:**
- Create: `crates/controller/src/binding.rs`
- Modify: `crates/controller/src/lib.rs` (add `pub mod binding;`), `crates/controller/src/store/runs.rs`

- [ ] **Step 1: Write the binding module (inline tests satisfy TDD-guard for this new file's creation only if a pending test exists — create it with inline `#[cfg(test)]`; if guard blocks, first create the Task 4 test file `crates/controller/tests/data_binding_api_test.rs` as an empty `// placeholder` and it unblocks)**

Create `crates/controller/src/binding.rs`:

```rust
//! Run-config data binding (serialized into `profile_json`, spec §4). Kept out
//! of the proto layer: the controller converts this to `pb::DataBinding`
//! (policy/seed/row_count) + applies mappings while streaming rows, so the
//! worker stays mapping-agnostic. `unique` is parsed but rejected at run-create.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingPolicy {
    PerVu,
    IterSequential,
    IterRandom,
    /// Reserved — accepted by serde so old/forward configs parse, but rejected
    /// by the run-create gate (spec §4/§12).
    Unique,
}

/// One variable's source: a dataset column or a constant literal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mapping {
    Column { var: String, column: String },
    Literal { var: String, value: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataBinding {
    pub dataset_id: String,
    pub policy: BindingPolicy,
    #[serde(default)]
    pub mappings: Vec<Mapping>,
}

impl DataBinding {
    /// Columns this binding reads from the dataset (literals excluded). Used by
    /// the validation gate to confirm every referenced column exists.
    pub fn referenced_columns(&self) -> Vec<&str> {
        self.mappings
            .iter()
            .filter_map(|m| match m {
                Mapping::Column { column, .. } => Some(column.as_str()),
                Mapping::Literal { .. } => None,
            })
            .collect()
    }

    /// Apply mappings to one source row (`{column: value}`) → `{var: value}`.
    /// Missing columns yield an empty string (defensive — the gate ensures
    /// columns exist, but a short/ragged row could still lack a cell).
    pub fn apply<'a>(
        &self,
        source: &std::collections::BTreeMap<String, String>,
    ) -> std::collections::BTreeMap<String, String> {
        let mut out = std::collections::BTreeMap::new();
        for m in &self.mappings {
            match m {
                Mapping::Column { var, column } => {
                    out.insert(var.clone(), source.get(column).cloned().unwrap_or_default());
                }
                Mapping::Literal { var, value } => {
                    out.insert(var.clone(), value.clone());
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn parses_per_vu_with_column_mapping() {
        let json = r#"{
            "dataset_id": "01J",
            "policy": "per_vu",
            "mappings": [{"column": {"var": "username", "column": "email"}}]
        }"#;
        // serde enum repr for Mapping::Column is {"column": {var, column}} (externally tagged).
        let b: DataBinding = serde_json::from_str(json).unwrap();
        assert_eq!(b.policy, BindingPolicy::PerVu);
        assert_eq!(b.referenced_columns(), vec!["email"]);
    }

    #[test]
    fn apply_maps_columns_and_literals() {
        let b = DataBinding {
            dataset_id: "d".into(),
            policy: BindingPolicy::PerVu,
            mappings: vec![
                Mapping::Column { var: "u".into(), column: "email".into() },
                Mapping::Literal { var: "role".into(), value: "admin".into() },
            ],
        };
        let mut src = BTreeMap::new();
        src.insert("email".to_string(), "a@x.com".to_string());
        let out = b.apply(&src);
        assert_eq!(out.get("u").map(String::as_str), Some("a@x.com"));
        assert_eq!(out.get("role").map(String::as_str), Some("admin"));
    }
}
```

> **Note on the mapping JSON shape:** the externally-tagged enum above serializes `Mapping::Column { var, column }` as `{"column": {"var": …, "column": …}}`. The UI (Task 9) must emit this exact shape. If you prefer the flatter `{"kind":"column","var":…,"column":…}`, switch the enum to `#[serde(tag = "kind", rename_all = "snake_case")]` and update the UI schema to match — **decide here and keep both sides identical.** This plan uses internally-tagged (`tag = "kind"`) for readability; change the test JSON accordingly:

Replace the enum attribute and test JSON to the internally-tagged form:

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mapping {
    Column { var: String, column: String },
    Literal { var: String, value: String },
}
```

and the test JSON:

```rust
let json = r#"{
    "dataset_id": "01J",
    "policy": "per_vu",
    "mappings": [{"kind": "column", "var": "username", "column": "email"}]
}"#;
```

- [ ] **Step 2: Export the module**

In `crates/controller/src/lib.rs` add (next to the other `pub mod`):

```rust
pub mod binding;
```

- [ ] **Step 3: Add `data_binding` to the DB `Profile` struct**

In `crates/controller/src/store/runs.rs`, extend `Profile` (keeps `runs` schema unchanged — `profile_json` JSON column, `#[serde(default)]` makes old rows parse, spec §3/F5):

```rust
use crate::binding::DataBinding;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub vus: u32,
    #[serde(default)]
    pub ramp_up_seconds: u32,
    pub duration_seconds: u32,
    #[serde(default = "default_loop_cap")]
    pub loop_breakdown_cap: u32,
    #[serde(default)]
    pub data_binding: Option<DataBinding>,
}
```

Update the two `Profile { … }` literals in `runs.rs` tests to add `data_binding: None`.

- [ ] **Step 4: Run controller lib tests + verify back-compat parse**

Run: `cargo test -p handicap-controller --lib binding:: && cargo test -p handicap-controller --lib runs::`
Expected: pass. Old `profile_json` without `data_binding` still deserializes (the `set_status_happy_path_and_aborted_guard` test inserts a profile without the field via the struct literal — but DB round-trip of an old JSON string is what matters; the `#[serde(default)]` covers it).

- [ ] **Step 5: Commit**

```bash
git add crates/controller/src/binding.rs crates/controller/src/lib.rs crates/controller/src/store/runs.rs
git commit -m "feat(controller): run-config DataBinding types in profile_json (8c)"
```

---

### Task 4: Run-create validation gate + `--dataset-max-rows`

**Files:**
- Modify: `crates/controller/src/app.rs` (`AppState.dataset_max_rows`), `crates/controller/src/main.rs` (CLI arg)
- Modify: `crates/controller/src/api/runs.rs` (gate)
- Create: `crates/controller/tests/data_binding_api_test.rs`

- [ ] **Step 1: Write the validation-gate API test first (TDD)**

Create `crates/controller/tests/data_binding_api_test.rs`. Model the harness on `crates/controller/tests/datasets_api_test.rs` (it builds an `AppState` + axum router and drives it with `tower::ServiceExt::oneshot`; reuse its `multipart()` helper to upload a dataset, then POST `/api/runs`). Provide these tests with full assertions:

```rust
//! Run-create data-binding validation gate (spec §11): column-missing,
//! empty-dataset, `unique`, and over-`--dataset-max-rows` are all 400/409;
//! a valid per_vu binding is 201.
use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

mod common; // factor the AppState/router builder + multipart() helper from datasets_api_test.rs into tests/common/mod.rs, OR inline copies here.

// ... build app with dataset_max_rows = e.g. 5 ...
// 1. upload a 2-row dataset with columns [email, pw] → capture id.
// 2. create a scenario that uses {{username}}.
// Then:

#[tokio::test]
async fn rejects_mapping_to_missing_column() {
    // binding maps var→column "nope" (not in [email,pw]) → 400, body mentions the column.
}

#[tokio::test]
async fn rejects_empty_dataset() {
    // upload a 0-row dataset, bind per_vu → 400.
}

#[tokio::test]
async fn rejects_unique_policy() {
    // policy:"unique" → 400, body mentions "다음 슬라이스"/"unique".
}

#[tokio::test]
async fn rejects_iter_policy_over_max_rows() {
    // dataset_max_rows=5, dataset has > 5 rows, policy iter_sequential → 400.
    // per_vu with the same dataset → 201 (per_vu is not capped, spec §11).
}

#[tokio::test]
async fn accepts_valid_per_vu_binding() {
    // valid binding → 201; GET the run shows profile.data_binding round-tripped.
}
```

> Fill each test body completely using the `datasets_api_test.rs` patterns (multipart upload, JSON `/api/runs` POST with `{scenario_id, profile:{…, data_binding:{…}}, env:{}}`). Keep `dataset_max_rows` small (5) so the over-max case is cheap.

- [ ] **Step 2: Add the CLI arg + AppState field**

In `crates/controller/src/main.rs` `Args`, add:

```rust
    /// Max dataset rows a per-iteration binding may stream into a worker
    /// (per_vu is not capped). Guards worker memory. Spec §10.
    #[arg(long, default_value_t = 1_000_000)]
    dataset_max_rows: u64,
```

and thread it into `AppState`:

```rust
    let state = app::AppState {
        db: db.clone(),
        coord: coord_state.clone(),
        dispatcher: dispatcher.clone(),
        ui_dir: args.ui_dir.clone(),
        dataset_max_rows: args.dataset_max_rows,
    };
```

In `crates/controller/src/app.rs`, add the field to `AppState`:

```rust
#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub dispatcher: SharedDispatcher,
    pub ui_dir: Option<PathBuf>,
    pub dataset_max_rows: u64,
}
```

Update any test/helper that constructs `AppState` (grep `AppState {`) to set `dataset_max_rows` (use `1_000_000` or a small value in tests).

- [ ] **Step 3: Implement the gate in `api/runs.rs::create`**

After the existing `loop_cap_ok` check and before `runs::insert`, validate the binding:

```rust
    // Data-binding validation gate (spec §11). `unique` is reserved.
    if let Some(b) = &body.profile.data_binding {
        use crate::binding::BindingPolicy;
        if matches!(b.policy, BindingPolicy::Unique) {
            return Err(ApiError::BadRequest(
                "unique 정책은 아직 지원하지 않습니다 (다음 슬라이스)".into(),
            ));
        }
        let meta = crate::store::datasets::get_meta(&state.db, &b.dataset_id)
            .await?
            .ok_or_else(|| ApiError::BadRequest("data_binding.dataset_id가 존재하지 않습니다".into()))?;
        if meta.row_count == 0 {
            return Err(ApiError::BadRequest("빈 데이터셋은 바인딩할 수 없습니다".into()));
        }
        for col in b.referenced_columns() {
            if !meta.columns.iter().any(|c| c == col) {
                return Err(ApiError::BadRequest(format!(
                    "매핑 컬럼 '{col}'이 데이터셋에 없습니다 (있는 컬럼: {:?})",
                    meta.columns
                )));
            }
        }
        // per-iteration policies stream the whole dataset → cap. per_vu is sliced
        // to min(vus, rows) so it is never capped (spec §11).
        let per_iteration = matches!(
            b.policy,
            BindingPolicy::IterSequential | BindingPolicy::IterRandom
        );
        if per_iteration && (meta.row_count as u64) > state.dataset_max_rows {
            return Err(ApiError::BadRequest(format!(
                "per-iteration 바인딩 행 수 {}가 상한 {}을 초과합니다",
                meta.row_count, state.dataset_max_rows
            )));
        }
    }
```

- [ ] **Step 4: Run the gate tests + full controller tests**

Run: `cargo test -p handicap-controller --test data_binding_api_test`
Expected: all 5 pass.
Run: `cargo test -p handicap-controller`
Expected: all pass (AppState literal updates didn't break other suites).

- [ ] **Step 5: Lint + commit**

```bash
cargo clippy -p handicap-controller --all-targets -- -D warnings
git add crates/controller/src/app.rs crates/controller/src/main.rs \
        crates/controller/src/api/runs.rs crates/controller/tests/data_binding_api_test.rs
git commit -m "feat(controller): run-create data-binding validation gate + --dataset-max-rows (8c)"
```

---

### Task 5: PendingAssignment binding + populate RunAssignment.data_binding (policy/seed/slicing)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`PendingAssignment`, RunAssignment population)
- Modify: `crates/controller/src/api/runs.rs` (build `PendingDataBinding`)

- [ ] **Step 1: Define `PendingDataBinding` and add it to `PendingAssignment`**

In `crates/controller/src/grpc/coordinator.rs`, add a struct that carries everything the streaming step (Task 6) and the RunAssignment need:

```rust
use crate::binding::Mapping;

/// Resolved binding the controller holds between run-create and worker-register.
/// Row data is NOT held here (spec §7.2 R4) — only what's needed to (a) fill
/// RunAssignment.data_binding and (b) stream rows from the DB on Register.
#[derive(Debug, Clone)]
pub struct PendingDataBinding {
    pub dataset_id: String,
    pub policy: pb::data_binding::Policy,
    pub seed: u32,
    pub mappings: Vec<Mapping>,
    /// Rows the worker will receive after policy-aware slicing.
    pub row_count: u64,
}

#[derive(Debug, Clone)]
pub struct PendingAssignment {
    pub scenario_yaml: String,
    pub profile: Profile,
    pub env: HashMap<String, String>,
    pub data_binding: Option<PendingDataBinding>,
}
```

- [ ] **Step 2: Populate `RunAssignment.data_binding` from the pending binding**

In `coordinator.rs`, change the RunAssignment literal (the `data_binding: None` from Task 1) to derive from `a.data_binding`:

```rust
                                let assignment = RunAssignment {
                                    run_id: reg.run_id.clone(),
                                    scenario_yaml: a.scenario_yaml.clone(),
                                    profile: Some(a.profile.clone()),
                                    env: a.env.clone(),
                                    data_binding: a.data_binding.as_ref().map(|b| pb::DataBinding {
                                        policy: b.policy as i32,
                                        seed: b.seed,
                                        row_count: b.row_count,
                                    }),
                                };
```

> Note: `a` is now consumed by reference in places — adjust the `match pending { Some(a) => { … } }` arm to clone fields as shown (`a` is moved out of the map; cloning the small fields is fine, and Task 6 needs `a.data_binding` afterward, so keep `a` in scope through the streaming step).

- [ ] **Step 3: Build `PendingDataBinding` in `api/runs.rs::create`**

After the validation gate (Task 4) and after `runs::insert` (so we know nothing failed), compute the proto policy, fold the seed from `row.id`, and slice the row count. Replace the existing `PendingAssignment { … }` literal:

```rust
    // Resolve the binding for the worker (spec §4/§7): proto policy, a
    // deterministic seed folded from the run id, and the sliced row count.
    let data_binding = if let Some(b) = &body.profile.data_binding {
        use crate::binding::BindingPolicy;
        let meta = crate::store::datasets::get_meta(&state.db, &b.dataset_id)
            .await?
            .expect("validated above"); // gate already proved existence
        let (policy, row_count) = match b.policy {
            BindingPolicy::PerVu => (
                handicap_proto::v1::data_binding::Policy::PerVu,
                (body.profile.vus as u64).min(meta.row_count as u64),
            ),
            BindingPolicy::IterSequential => (
                handicap_proto::v1::data_binding::Policy::IterSequential,
                meta.row_count as u64,
            ),
            BindingPolicy::IterRandom => (
                handicap_proto::v1::data_binding::Policy::IterRandom,
                meta.row_count as u64,
            ),
            BindingPolicy::Unique => unreachable!("rejected by gate"),
        };
        Some(crate::grpc::coordinator::PendingDataBinding {
            dataset_id: b.dataset_id.clone(),
            policy,
            seed: fold_seed(&row.id),
            mappings: b.mappings.clone(),
            row_count,
        })
    } else {
        None
    };

    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: scenario.yaml.clone(),
        profile: handicap_proto::v1::Profile {
            vus: body.profile.vus,
            ramp_up_seconds: body.profile.ramp_up_seconds,
            duration_seconds: body.profile.duration_seconds,
            loop_breakdown_cap: body.profile.loop_breakdown_cap,
        },
        env,
        data_binding,
    };
    state.coord.enqueue(row.id.clone(), assignment).await;
```

Add the `fold_seed` helper at the bottom of `api/runs.rs` (above the `#[cfg(test)]` module):

```rust
/// Fold a run id (ULID, 26 Crockford chars) into a u32 PRNG seed. Determinism
/// is all we need (spec §4) — collisions are harmless since the seed only
/// drives `iter_random` reproducibility within a single run.
fn fold_seed(run_id: &str) -> u32 {
    // FNV-1a over the id bytes.
    let mut h: u32 = 0x811C_9DC5;
    for byte in run_id.as_bytes() {
        h ^= *byte as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}
```

- [ ] **Step 4: Add a unit test for `fold_seed` + slicing intent**

In the `#[cfg(test)] mod tests` of `api/runs.rs`, add:

```rust
    #[test]
    fn fold_seed_is_deterministic_and_varies() {
        assert_eq!(super::fold_seed("01HX0000000000000000000001"),
                   super::fold_seed("01HX0000000000000000000001"));
        assert_ne!(super::fold_seed("01HX0000000000000000000001"),
                   super::fold_seed("01HX0000000000000000000002"));
    }
```

- [ ] **Step 5: Build + test + commit**

Run: `cargo test -p handicap-controller`
Expected: pass (existing `PendingAssignment` construction in any test now needs `data_binding: None` — grep `PendingAssignment {` and fix).

```bash
cargo clippy -p handicap-controller --all-targets -- -D warnings
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/api/runs.rs
git commit -m "feat(controller): resolve binding → RunAssignment.data_binding (policy/seed/slicing) (8c)"
```

---

### Task 6: Stream DatasetBatch rows on worker Register

**Files:**
- Modify: `crates/controller/src/store/datasets.rs` (`get_rows_range`)
- Modify: `crates/controller/src/grpc/coordinator.rs` (stream after sending RunAssignment)

- [ ] **Step 1: Add a batched, idx-ordered row fetch to the store (TDD: add the inline test first)**

In `crates/controller/src/store/datasets.rs`, add:

```rust
/// Fetch up to `limit` rows starting at `start_idx` (inclusive), idx-ordered,
/// as `{column: value}` maps. Used to stream a dataset to a worker in batches
/// without loading the whole thing at once (spec §7.3).
pub async fn get_rows_range(
    db: &Db,
    id: &str,
    start_idx: i64,
    limit: i64,
) -> Result<Vec<BTreeMap<String, String>>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT row_json FROM dataset_rows WHERE dataset_id = ? AND idx >= ? ORDER BY idx LIMIT ?",
    )
    .bind(id)
    .bind(start_idx)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let s: String = r.get("row_json");
            serde_json::from_str::<BTreeMap<String, String>>(&s).unwrap_or_default()
        })
        .collect())
}
```

Add to the `#[cfg(test)] mod tests`:

```rust
    #[tokio::test]
    async fn get_rows_range_paginates() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let columns = vec!["c".to_string()];
        let rows: Vec<Vec<String>> = (0..10).map(|i| vec![i.to_string()]).collect();
        let id = insert(&db, "p", &columns, &rows, 0).await.unwrap();
        let first = get_rows_range(&db, &id, 0, 4).await.unwrap();
        assert_eq!(first.len(), 4);
        assert_eq!(first[0].get("c").map(String::as_str), Some("0"));
        let next = get_rows_range(&db, &id, 4, 4).await.unwrap();
        assert_eq!(next[0].get("c").map(String::as_str), Some("4"));
    }
```

Run: `cargo test -p handicap-controller --lib datasets::tests::get_rows_range_paginates`
Expected: pass.

- [ ] **Step 2: Stream batches after the worker registers**

In `coordinator.rs`, inside the `Some(WorkerPayload::Register(reg))` arm, after sending the `RunAssignment` and before/around the `set_status` call, stream the rows if a binding is present. Use a batch size constant:

```rust
const DATASET_BATCH_ROWS: i64 = 1000;
```

After the `set_status(... Running ...)` call (still inside the `Some(a) =>` arm, with `a` in scope):

```rust
                                if let Some(binding) = &a.data_binding {
                                    if binding.row_count > 0 {
                                        let mut sent: i64 = 0;
                                        let total = binding.row_count as i64;
                                        while sent < total {
                                            let limit = DATASET_BATCH_ROWS.min(total - sent);
                                            let src = match crate::store::datasets::get_rows_range(
                                                &state.db, &binding.dataset_id, sent, limit,
                                            )
                                            .await
                                            {
                                                Ok(r) => r,
                                                Err(e) => {
                                                    error!(run_id = %reg.run_id, error = %e, "dataset row fetch failed");
                                                    break;
                                                }
                                            };
                                            if src.is_empty() {
                                                break; // dataset shrank; stop (worker will see fewer rows)
                                            }
                                            let proto_rows: Vec<pb::DatasetRow> = src
                                                .iter()
                                                .map(|row| pb::DatasetRow {
                                                    // apply mappings → {var: value}; never log values (spec §11)
                                                    values: binding
                                                        .mappings_apply(row)
                                                        .into_iter()
                                                        .collect(),
                                                })
                                                .collect();
                                            let n = proto_rows.len() as i64;
                                            let _ = tx
                                                .send(Ok(ServerMessage {
                                                    payload: Some(ServerPayload::DatasetBatch(
                                                        pb::DatasetBatch {
                                                            run_id: reg.run_id.clone(),
                                                            rows: proto_rows,
                                                        },
                                                    )),
                                                }))
                                                .await;
                                            sent += n;
                                        }
                                    }
                                }
```

Add a small `mappings_apply` method on `PendingDataBinding` (delegates to `binding::DataBinding::apply` logic, but `PendingDataBinding` already holds `Vec<Mapping>`):

```rust
impl PendingDataBinding {
    /// Map one source row `{column: value}` → `{var: value}` using mappings.
    pub fn mappings_apply(
        &self,
        source: &std::collections::BTreeMap<String, String>,
    ) -> std::collections::BTreeMap<String, String> {
        use crate::binding::Mapping;
        let mut out = std::collections::BTreeMap::new();
        for m in &self.mappings {
            match m {
                Mapping::Column { var, column } => {
                    out.insert(var.clone(), source.get(column).cloned().unwrap_or_default());
                }
                Mapping::Literal { var, value } => {
                    out.insert(var.clone(), value.clone());
                }
            }
        }
        out
    }
}
```

> The map field on `pb::DatasetRow` is `HashMap<String,String>`; `.into_iter().collect()` from a `BTreeMap` produces it.

- [ ] **Step 3: Build + test + commit**

Run: `cargo build --workspace && cargo test -p handicap-controller`
Expected: pass.

```bash
cargo clippy -p handicap-controller --all-targets -- -D warnings
git add crates/controller/src/store/datasets.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): stream mapping-applied DatasetBatch rows on worker register (8c)"
```

---

### Task 7: Worker loading stage + build DataSet + pass to engine

**Files:**
- Modify: `crates/worker-core/src/error.rs` (`DatasetIncomplete`), `crates/worker-core/src/lib.rs`, `crates/worker-core/src/client.rs` (add `load_dataset`)
- Modify: `crates/worker/src/main.rs`

- [ ] **Step 1: Add the error variant**

In `crates/worker-core/src/error.rs` add to `WorkerError`:

```rust
    /// The controller closed the stream before sending all expected dataset
    /// rows. Treated as a run failure (the engine never started).
    #[error("dataset stream ended early ({got}/{expected} rows)")]
    DatasetIncomplete { got: u64, expected: u64 },
```

- [ ] **Step 2: Write the `load_dataset` helper with contract tests (TDD — add tests in client.rs inline module so TDD-guard passes, since client.rs already exists)**

In `crates/worker-core/src/client.rs`, add:

```rust
use std::collections::BTreeMap;
use pb::ServerMessage;
use pb::server_message::Payload as ServerPayload;
use tokio_util::sync::CancellationToken;

/// Accumulate `DatasetBatch` rows from the inbound stream until `expected_rows`
/// rows have arrived, then return them. During loading an `AbortRun` for our
/// run (or `cancel`) returns `WorkerError::Cancelled`; a closed stream returns
/// `DatasetIncomplete`. Ping and other messages are ignored. (Spec §7.3 R1.)
pub async fn load_dataset(
    inbound_rx: &mut mpsc::Receiver<ServerMessage>,
    expected_rows: u64,
    run_id: &str,
    cancel: &CancellationToken,
) -> Result<Vec<BTreeMap<String, String>>, WorkerError> {
    let mut rows: Vec<BTreeMap<String, String>> = Vec::with_capacity(expected_rows as usize);
    while (rows.len() as u64) < expected_rows {
        tokio::select! {
            _ = cancel.cancelled() => return Err(WorkerError::Cancelled),
            msg = inbound_rx.recv() => match msg {
                Some(sm) => match sm.payload {
                    Some(ServerPayload::DatasetBatch(b)) => {
                        for r in b.rows {
                            rows.push(r.values.into_iter().collect());
                        }
                    }
                    Some(ServerPayload::Abort(a)) if a.run_id == run_id => {
                        return Err(WorkerError::Cancelled);
                    }
                    _ => {} // Ping / unrelated — ignore during loading
                },
                None => {
                    return Err(WorkerError::DatasetIncomplete {
                        got: rows.len() as u64,
                        expected: expected_rows,
                    });
                }
            }
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod load_tests {
    use super::*;
    use handicap_proto::v1 as pb;

    fn batch(run_id: &str, users: &[&str]) -> ServerMessage {
        ServerMessage {
            payload: Some(ServerPayload::DatasetBatch(pb::DatasetBatch {
                run_id: run_id.to_string(),
                rows: users
                    .iter()
                    .map(|u| {
                        let mut v = std::collections::HashMap::new();
                        v.insert("user".to_string(), u.to_string());
                        pb::DatasetRow { values: v }
                    })
                    .collect(),
            })),
        }
    }

    #[tokio::test]
    async fn accumulates_until_expected() {
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(8);
        tx.send(batch("r", &["a", "b"])).await.unwrap();
        tx.send(batch("r", &["c"])).await.unwrap();
        let got = load_dataset(&mut rx, 3, "r", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].get("user").map(String::as_str), Some("a"));
        assert_eq!(got[2].get("user").map(String::as_str), Some("c"));
    }

    #[tokio::test]
    async fn abort_during_loading_returns_cancelled() {
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(8);
        tx.send(batch("r", &["a"])).await.unwrap();
        tx.send(ServerMessage {
            payload: Some(ServerPayload::Abort(pb::AbortRun {
                run_id: "r".into(),
                reason: "x".into(),
            })),
        })
        .await
        .unwrap();
        let err = load_dataset(&mut rx, 5, "r", &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(err, WorkerError::Cancelled));
    }

    #[tokio::test]
    async fn closed_stream_is_incomplete() {
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(8);
        tx.send(batch("r", &["a"])).await.unwrap();
        drop(tx);
        let err = load_dataset(&mut rx, 5, "r", &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(err, WorkerError::DatasetIncomplete { got: 1, expected: 5 }));
    }
}
```

Export from `crates/worker-core/src/lib.rs`:

```rust
pub use client::{WorkerLink, connect_and_register, load_dataset};
```

Run: `cargo test -p handicap-worker-core`
Expected: 3 new tests + existing pass.

- [ ] **Step 3: Wire the loading stage into `worker/src/main.rs`**

After obtaining `assignment`/`tx`/`inbound_rx`, and after parsing the scenario/profile, build the optional dataset **before** spawning the abort listener and starting the engine:

```rust
use std::collections::BTreeMap;
use handicap_engine::{BindingPolicy, DataSet, EngineError, MetricFlush, RunPlan, Scenario, run_scenario};
use handicap_worker_core::{WorkerError, connect_with_backoff, load_dataset};

// … after `let mut inbound_rx = link.inbound_rx;` and scenario/profile setup …

    // Data-binding loading stage (spec §7.3): if the assignment carries a
    // binding, drain DatasetBatch messages until we have row_count rows, THEN
    // start the engine. Abort during loading exits cleanly as Aborted.
    let dataset: Option<Arc<DataSet>> = match &assignment.data_binding {
        Some(db) if db.row_count > 0 => {
            info!(rows = db.row_count, "loading dataset before run");
            match load_dataset(&mut inbound_rx, db.row_count, &assignment.run_id, &cancel).await {
                Ok(rows) => {
                    let policy = match pb::data_binding::Policy::try_from(db.policy) {
                        Ok(pb::data_binding::Policy::PerVu) => BindingPolicy::PerVu,
                        Ok(pb::data_binding::Policy::IterSequential) => BindingPolicy::IterSequential,
                        Ok(pb::data_binding::Policy::IterRandom) => BindingPolicy::IterRandom,
                        Err(_) => {
                            return Err(anyhow::anyhow!("unknown binding policy {}", db.policy));
                        }
                    };
                    Some(Arc::new(DataSet { policy, seed: db.seed, rows }))
                }
                Err(WorkerError::Cancelled) => {
                    info!(run_id = %args.run_id, "aborted during dataset load");
                    let msg = WorkerMessage {
                        payload: Some(WorkerPayload::RunStatus(RunStatus {
                            run_id: args.run_id.clone(),
                            phase: pb::run_status::Phase::Aborted as i32,
                            message: String::new(),
                        })),
                    };
                    let _ = tx.send(msg).await;
                    drop(tx);
                    let _ = tokio::time::timeout(Duration::from_secs(2), inbound_fwd).await;
                    signal_task.abort();
                    return Ok(());
                }
                Err(e) => return Err(anyhow::Error::from(e).context("load_dataset")),
            }
        }
        _ => None,
    };
```

Then add `data_binding: dataset` to the `RunPlan` literal:

```rust
    let plan = RunPlan {
        vus: profile.vus,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(profile.duration_seconds.into()),
        env,
        loop_breakdown_cap: profile.loop_breakdown_cap,
        data_binding: dataset,
    };
```

> The `assignment.data_binding` access must come before `let assignment = link.assignment;` is partially moved — keep `assignment` owned (it already is) and read `&assignment.data_binding` / `&assignment.run_id` before the scenario parse that consumes `assignment.scenario_yaml`. Reorder so `scenario_yaml` is read after the binding fields, or clone `assignment.scenario_yaml` first. Simplest: clone what you need up front:
> ```rust
> let scenario_yaml = assignment.scenario_yaml.clone();
> let data_binding_meta = assignment.data_binding.clone();
> ```
> and use those locals.

- [ ] **Step 4: Build + worker tests + commit**

Run: `cargo build -p handicap-worker && cargo test -p handicap-worker -p handicap-worker-core`
Expected: pass.

```bash
cargo clippy -p handicap-worker -p handicap-worker-core --all-targets -- -D warnings
git add crates/worker-core/src/error.rs crates/worker-core/src/lib.rs \
        crates/worker-core/src/client.rs crates/worker/src/main.rs
git commit -m "feat(worker): dataset loading stage before engine start + build DataSet (8c)"
```

---

### Task 8: UI `{{var}}` scanner

**Files:**
- Create: `ui/src/scenario/scanVars.ts`
- Create: `ui/src/scenario/__tests__/scanVars.test.ts`

- [ ] **Step 1: Write the scanner test first (TDD-guard + contract)**

Create `ui/src/scenario/__tests__/scanVars.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { scanFlowVars } from "../scanVars";
import type { Scenario } from "../model";

function scenario(steps: Scenario["steps"]): Scenario {
  return { version: 1, name: "t", cookie_jar: "auto", variables: {}, steps };
}

describe("scanFlowVars", () => {
  it("finds {{var}} in url, headers, form values, and json string leaves", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: {
          method: "POST",
          url: "{{base}}/login?ref={{ref}}",
          headers: { Authorization: "Bearer {{token}}" },
          body: { kind: "json", value: { user: "{{username}}", age: 30, nested: { k: "{{deep}}" } } },
        },
        assert: [],
        extract: [],
      },
    ]);
    expect([...scanFlowVars(s)].sort()).toEqual(
      ["base", "deep", "ref", "token", "username"].sort(),
    );
  });

  it("scans form body values but not keys", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000002",
        name: "f",
        type: "http",
        request: {
          method: "POST",
          url: "/x",
          headers: {},
          body: { kind: "form", value: { user: "{{u}}", literalKey: "static" } },
        },
        assert: [],
        extract: [],
      },
    ]);
    expect([...scanFlowVars(s)]).toEqual(["u"]);
  });

  it("recurses into loop do: bodies", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000003",
        name: "loop",
        type: "loop",
        repeat: 2,
        do: [
          {
            id: "01HX0000000000000000000004",
            name: "inner",
            type: "http",
            request: { method: "GET", url: "/item/{{id}}", headers: {} },
            assert: [],
            extract: [],
          },
        ],
      },
    ]);
    expect([...scanFlowVars(s)]).toEqual(["id"]);
  });

  it("ignores ${ENV} and system tokens", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000005",
        name: "e",
        type: "http",
        request: { method: "GET", url: "${BASE_URL}/x?v=${vu_id}", headers: {} },
        assert: [],
        extract: [],
      },
    ]);
    expect([...scanFlowVars(s)]).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement the scanner**

Create `ui/src/scenario/scanVars.ts`:

```ts
import { flattenHttpSteps, type Scenario } from "./model";

const FLOW_VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function collectFromString(s: string, out: Set<string>): void {
  for (const m of s.matchAll(FLOW_VAR_RE)) {
    out.add(m[1]);
  }
}

function collectFromJson(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    collectFromString(value, out);
  } else if (Array.isArray(value)) {
    for (const v of value) collectFromJson(v, out);
  } else if (value && typeof value === "object") {
    // Only string leaves are templated by the engine (8a) — keys are verbatim.
    for (const v of Object.values(value)) collectFromJson(v, out);
  }
}

/**
 * All distinct `{{var}}` names referenced by a scenario, across url, header
 * values, form body values, and JSON body string leaves — recursing into loop
 * `do:` bodies via flattenHttpSteps. `${ENV}` / `${vu_id}` are a different
 * namespace and are not returned (mirrors engine template.rs).
 */
export function scanFlowVars(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const step of flattenHttpSteps(scenario.steps)) {
    collectFromString(step.request.url, out);
    for (const v of Object.values(step.request.headers)) collectFromString(v, out);
    const body = step.request.body;
    if (body?.kind === "raw") collectFromString(body.value, out);
    else if (body?.kind === "form") {
      for (const v of Object.values(body.value)) collectFromString(v, out);
    } else if (body?.kind === "json") {
      collectFromJson(body.value, out);
    }
  }
  return out;
}
```

- [ ] **Step 3: Run the scanner tests**

Run: `cd ui && pnpm test scanVars`
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/scenario/scanVars.ts ui/src/scenario/__tests__/scanVars.test.ts
git commit -m "feat(ui): {{var}} scanner over url/headers/body + loop do: (8c)"
```

---

### Task 9: UI binding schema + client + hooks

**Files:**
- Modify: `ui/src/api/schemas.ts`, `ui/src/api/client.ts`, `ui/src/api/hooks.ts`
- Modify: `ui/src/api/__tests__/schemas.test.ts` (or add a focused test)

- [ ] **Step 1: Add binding schemas (matching the Rust serde shapes from Task 3/5)**

In `ui/src/api/schemas.ts`, add:

```ts
export const BindingPolicyEnum = z.enum(["per_vu", "iter_sequential", "iter_random"]);
export type BindingPolicy = z.infer<typeof BindingPolicyEnum>;

// Matches Rust `Mapping` (internally-tagged on "kind").
export const MappingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), var: z.string().min(1), column: z.string().min(1) }),
  z.object({ kind: z.literal("literal"), var: z.string().min(1), value: z.string() }),
]);
export type Mapping = z.infer<typeof MappingSchema>;

export const DataBindingSchema = z.object({
  dataset_id: z.string().min(1),
  policy: BindingPolicyEnum,
  mappings: z.array(MappingSchema),
});
export type DataBinding = z.infer<typeof DataBindingSchema>;
```

Extend `ProfileSchema` to carry the optional binding (round-trips through `profile_json`):

```ts
export const ProfileSchema = z.object({
  vus: z.number().int().nonnegative(),
  ramp_up_seconds: z.number().int().nonnegative().default(0),
  duration_seconds: z.number().int().nonnegative(),
  loop_breakdown_cap: z.number().int().min(0).max(10000).default(256),
  data_binding: DataBindingSchema.nullish(),
});
```

> Note the `RunSchema.profile` parse: the backend stores `data_binding` inside `profile_json`, so `GET /runs/{id}` returns it under `profile`. `.nullish()` (optional + nullable) keeps old runs (no field) valid.

- [ ] **Step 2: Pass `data_binding` through the create-run client + hook**

In `ui/src/api/client.ts`, the `createRun` signature already sends `profile` verbatim, so the binding rides along inside `profile`. No change needed there if `DataBindingPanel` writes into the `profile` object. Verify `createRun` serializes `profile` as-is (it does: `JSON.stringify({ scenario_id, profile, env })`).

Add a sample-rows hook. In `ui/src/api/hooks.ts` add:

```ts
export function useDataset(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.dataset(id) : ["datasets", "missing"],
    queryFn: () => api.getDataset(id!),
    enabled: Boolean(id),
  });
}
```

(`api.getDataset` and `queryKeys.dataset` already exist from 8b.)

- [ ] **Step 3: Add a schema round-trip test**

In `ui/src/api/__tests__/schemas.test.ts` (or a new `binding.test.ts`):

```ts
import { ProfileSchema, DataBindingSchema } from "../schemas";

it("parses a profile with a column-mapped per_vu binding", () => {
  const p = ProfileSchema.parse({
    vus: 2,
    duration_seconds: 5,
    data_binding: {
      dataset_id: "01J",
      policy: "per_vu",
      mappings: [{ kind: "column", var: "username", column: "email" }],
    },
  });
  expect(p.data_binding?.policy).toBe("per_vu");
});

it("parses a profile with no binding (back-compat)", () => {
  const p = ProfileSchema.parse({ vus: 1, duration_seconds: 1 });
  expect(p.data_binding ?? null).toBeNull();
});
```

- [ ] **Step 4: Test + build gate + commit**

Run: `cd ui && pnpm test schemas && pnpm build`
Expected: tests pass; `tsc -b && vite build` clean.

```bash
git add ui/src/api/schemas.ts ui/src/api/hooks.ts ui/src/api/__tests__
git commit -m "feat(ui): data_binding schema + useDataset hook (8c)"
```

---

### Task 10: RunDialog binding panel (mapping table, policy, validation)

**Files:**
- Create: `ui/src/components/DataBindingPanel.tsx`
- Create: `ui/src/components/__tests__/DataBindingPanel.test.tsx`
- Modify: `ui/src/components/RunDialog.tsx`, `ui/src/pages/ScenarioRunsPage.tsx`

- [ ] **Step 1: Write the RTL test first**

Create `ui/src/components/__tests__/DataBindingPanel.test.tsx`. Provide tests that mount the panel with a fake scenario (one http step using `{{username}}`) and a fake datasets list, then assert:

```tsx
// Render with a QueryClientProvider + mocked api (vi.mock("../../api/client")).
// Tests:
// 1. Auto-scans {{username}} → a mapping row exists for "username".
// 2. Choosing a dataset auto-matches column "username" if present (same-name).
// 3. An unmatched {{var}} (no column / no literal) shows the red blocking state
//    and calls onValidityChange(false).
// 4. Selecting per-iteration policy shows the memory warning banner; per_vu hides it.
// 5. Choosing "unique" is not offered (only the 3 supported policies in the dropdown).
```

> Write each test body fully: render `<DataBindingPanel scenario={…} onChange={spy} onValidityChange={spy} />`, use `userEvent.setup()` per test, query by role/label, assert spy calls. Follow `RunDialog.test.tsx` patterns for the QueryClient wrapper.

- [ ] **Step 2: Implement the panel**

Create `ui/src/components/DataBindingPanel.tsx`. Responsibilities (spec §9, mockup `mapping-hybrid-v2`):

- Props: `{ scenario: Scenario; vus: number; onChange: (b: DataBinding | null) => void; onValidityChange: (ok: boolean) => void }`.
- `useDatasets()` for the dataset dropdown; `useDataset(selectedId)` for columns + row-0 sample.
- `scanFlowVars(scenario)` seeds one mapping row per detected `{{var}}`. Each row: var name (label), a source selector (`— none —` / each dataset column / `literal…`), and (for literal) a text input. All rows ✕-removable; "+ 추가" adds a manual row; detected-but-unused vars show as chips.
- On dataset select, auto-match: for each var, if a column of the same name exists, default its mapping to that column.
- Policy dropdown: `per_vu` (default) / `iter_sequential` / `iter_random` only. **No `unique`.**
- Per-iteration policy → always show the warning banner: "전체 N행(~X MB) 워커 메모리 적재. 상한은 controller `--dataset-max-rows`(Helm `controller.datasetMaxRows`)." per_vu → no banner.
- Validation (blocking): every `{{var}}` the scenario uses must be covered by a mapping (column or literal) OR exist in `scenario.variables` (a scenario default) OR look like env (`${…}` — not a flow var, so out of scope). If any used `{{var}}` is uncovered, render it red and call `onValidityChange(false)`. Otherwise `onValidityChange(true)`.
- When valid and a dataset+≥1 column-mapping is selected, call `onChange({ dataset_id, policy, mappings })`. If no dataset selected, call `onChange(null)` (run without binding).
- Flex layout: inputs `min-w-0`, trailing ✕ `shrink-0` (RunDialog flex trap, CLAUDE.md).

Keep the component self-contained; emit `DataBinding | null` upward so RunDialog owns the payload.

- [ ] **Step 3: Mount it in RunDialog + thread scenario YAML**

`RunDialog` currently only gets `scenarioId`+`hasLoop`. It needs the parsed scenario to scan vars. Two options — pick the lighter one:

- Pass the already-parsed `Scenario` model from `ScenarioRunsPage` (it already calls `parseScenarioDoc(yaml)` for `hasLoop`). Add a `scenario: Scenario | null` prop to `RunDialog` and a `dataBinding` state + `bindingValid` state.

In `ScenarioRunsPage.tsx`, compute the parsed model once and pass it:

```tsx
const parsedScenario = useMemo(() => {
  const yaml = scenario.data?.yaml;
  if (!yaml) return null;
  const parsed = parseScenarioDoc(yaml);
  return "model" in parsed ? parsed.model : null;
}, [scenario.data?.yaml]);
// hasLoop derived from parsedScenario?.steps.some(isLoopStep)
```

and `<RunDialog scenario={parsedScenario} … />`.

In `RunDialog.tsx`:
- Add `scenario: Scenario | null` to `Props`.
- Add `const [binding, setBinding] = useState<DataBinding | null>(null);` and `const [bindingValid, setBindingValid] = useState(true);`.
- Render `{scenario && <DataBindingPanel scenario={scenario} vus={vus} onChange={setBinding} onValidityChange={setBindingValid} />}` (place it above the submit row).
- Add `&& bindingValid` to `canSubmit`.
- Include `data_binding: binding ?? undefined` inside the `profile` object of the `mutation.mutate` payload:

```tsx
profile: {
  vus,
  duration_seconds: duration,
  ramp_up_seconds: rampUp,
  loop_breakdown_cap: hasLoop ? loopCap : 0,
  data_binding: binding ?? undefined,
},
```

- [ ] **Step 4: Run RTL + existing RunDialog tests + build gate**

Run: `cd ui && pnpm test DataBindingPanel RunDialog && pnpm build`
Expected: pass; build clean. (`RunDialog.test.tsx` may need a `scenario={null}` prop added to existing renders — update them.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/DataBindingPanel.tsx ui/src/components/__tests__/DataBindingPanel.test.tsx \
        ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx \
        ui/src/pages/ScenarioRunsPage.tsx
git commit -m "feat(ui): RunDialog data-binding panel — scan/map/policy/validate (8c)"
```

---

### Task 11: End-to-end — upload dataset → per-VU run → report

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs` (add one test) — reuse `worker_bin_path()` (builds the worker) and the existing controller-spawn pattern.

- [ ] **Step 1: Write the e2e test**

Add to `crates/controller/tests/e2e_test.rs` a test that:

1. starts a `wiremock::MockServer` stubbing `GET /hit` → 200 (record requests),
2. spins up the controller (REST + gRPC) with `worker_mode = subprocess`, `worker_bin = worker_bin_path()`, and `dataset_max_rows` large,
3. `POST /api/datasets` (multipart) a 2-row CSV `user\nalice\nbob`,
4. `POST /api/scenarios` a scenario with one GET `{{base}}/hit?u={{user}}` (base via env),
5. `POST /api/runs` with `profile.data_binding = { dataset_id, policy: "per_vu", mappings: [{kind:"column", var:"user", column:"user"}] }`, `env: { base: <wiremock uri> }`, vus=2, short duration,
6. polls `GET /api/runs/{id}` until terminal (`completed`),
7. asserts `server.received_requests()` contains both `u=alice` and `u=bob`.

Follow the existing e2e tests' controller bootstrap (they build an `AppState` + serve axum + tonic on ephemeral ports). Set `dataset_max_rows` in that `AppState` literal.

- [ ] **Step 2: Run it (worker builds automatically via `worker_bin_path`)**

Run: `cargo test -p handicap-controller --test e2e_test data_binding -- --test-threads=1`
Expected: pass. (If a cold-build signal-9 flake hits an unrelated e2e, re-run warm — memory [[flaky-e2e-cold-build]].)

- [ ] **Step 3: Commit**

```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(controller): e2e upload dataset → per-VU run injects distinct values (8c)"
```

---

### Task 12: Docs — ADR-0022 extension, CLAUDE.md, perf A/B

**Files:**
- Modify: `docs/adr/0022-data-driven-datasets.md`, `CLAUDE.md`

- [ ] **Step 1: Extend ADR-0022 with the 8c decisions**

`ADR-0022` exists (written in 8b). Add the 8c-specific consequences if not already present (spec §15): mapping-agnostic/policy-aware worker, policy-aware slicing (per_vu = min(vus,rows); per-iteration = full ≤ cap), worker loading stage (rows streamed post-Register, engine starts only after row_count reached), deterministic indexing (per_vu modulo / sequential `AtomicU64` / `iter_random` splitmix64-seeded `StdRng`), seed = FNV-fold of run_id (determinism not uniqueness), multi-worker worker-local wrap invariant, and `unique` rejection point (run-create gate). Keep the rejected-alternatives section.

- [ ] **Step 2: Run a perf A/B (spec §10) — body-bearing path**

The existing `just bench-throughput` has no body, so it doesn't exercise injection. Do a manual A/B with a body-bearing scenario:
- Build: `cargo build --release -p handicap-controller -p handicap-worker` (or use the bench harness if it supports a POST-body scenario).
- Run the same scenario twice at 200 VUs × 20s: (A) no binding, (B) per_vu binding into a JSON body leaf, against wiremock.
- Record RPS + p50/p95/p99 for both; confirm B is within run-to-run variance of A (injection is one BTreeMap overlay + the existing 8a JSON walk per iteration). If the bench harness can't send a body, state that explicitly and rely on the engine micro-cost argument (one index calc + map insert per iteration ≪ HTTP RTT).

- [ ] **Step 3: Update CLAUDE.md**

- Headline status → "Slice 8c (데이터셋 바인딩+주입) 구현 완료" once merged.
- Add a "Slice 8c 결과" paragraph: pipeline (RunDialog binding → profile_json.data_binding → run-create gate → PendingDataBinding → RunAssignment.data_binding + streamed DatasetBatch on Register → worker loading stage → engine overlay/indexing), 3 policies, slicing, deterministic seed, `--dataset-max-rows`, `unique` reserved, perf result.
- Add a "Slice 8c에서 배운 함정들" section capturing anything discovered during implementation (e.g. prost enum i32 conversion, RunPlan literal churn, worker loading-stage ordering vs abort listener, mapping JSON shape sync between Rust serde and Zod).
- Confirm ADR-0022 line in "알아둘 결정들" mentions binding/policies (it already covers data-driven).

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0022-data-driven-datasets.md CLAUDE.md
git commit -m "docs: ADR-0022 8c binding/policy/worker-loading + CLAUDE.md 8c notes"
```

---

## Out of Scope (deferred — spec §12)

- `unique` policy (reserved enum variant; API-rejected). Engine indexing, run-termination, and multi-worker partitioning land in its own slice.
- Sensitive-value masking (separate security slice). 8c only keeps row values out of worker/controller logs.
- JSON number/type injection (string leaves only).
- Dataset versioning/diff/edit; multi-worker global cursor.
- Helm `controller.datasetMaxRows` exposure: the CLI arg + AppState gate ship in 8c; wiring the Helm value + deployment arg is a prod-rollout follow-up. The RunDialog banner references the value name for operator guidance even before the Helm value exists.

---

## Self-Review

**Spec coverage (§13-8c completion criteria):**
- proto `DataBinding`/`DatasetBatch` → Task 1 ✓
- worker loading stage contract tests (accumulate / abort / order) → Task 7 (accumulate ✓, abort ✓; batch *order* covered by `accumulates_until_expected` preserving push order ✓)
- controller slicing + wiring + `unique` rejection → Tasks 4 (reject), 5 (slicing/wiring), 6 (streaming) ✓
- engine indexing/overlay unit → Task 2 ✓
- wiremock integration (per-VU distinct; iter_sequential cycles) → Task 2 ✓
- `{{var}}` scanner + RunDialog RTL → Tasks 8, 10 ✓
- upload→per-VU run→report e2e → Task 11 ✓
- ADR-0022 + CLAUDE.md → Task 12 ✓

**Type consistency check:**
- Engine `BindingPolicy` (PerVu/IterSequential/IterRandom) — no `Unique` (engine never sees it). Controller `binding::BindingPolicy` HAS `Unique` (parsed, rejected). proto `data_binding::Policy` has 3. Conversions: controller→proto (Task 5), proto→engine (Task 7). ✓
- Mapping JSON shape: Rust `#[serde(tag="kind")]` ↔ Zod `discriminatedUnion("kind")` — both `{kind:"column",var,column}` / `{kind:"literal",var,value}`. **Kept identical in Task 3 and Task 9.** ✓
- `RunPlan.data_binding: Option<Arc<DataSet>>` — Task 2 adds field; all literals updated (worker main + engine tests). `PendingAssignment.data_binding: Option<PendingDataBinding>` — Task 5 adds; grep `PendingAssignment {`. `AppState.dataset_max_rows` — Task 4; grep `AppState {`. ✓
- `WorkerError::DatasetIncomplete { got, expected }` — Task 7 defines + matched in test. ✓

**Placeholder scan:** Tasks 1–9 and 11 contain complete code. Tasks 10 (DataBindingPanel) and 4/11 test bodies are described with concrete assertions but not byte-complete component/test source — these are genuinely design-heavy UI/e2e surfaces where the implementer must follow existing patterns (`RunDialog.test.tsx`, `datasets_api_test.rs`, `e2e_test.rs`); the description fixes every behavior, prop, and assertion. Flagged here intentionally rather than hidden.

**Back-compat:** `data_binding` is `#[serde(default)]` in `Profile` (no `runs` migration); `Option`/`nullish` everywhere; `None` binding = byte-identical to pre-8c behavior (engine overlay is a no-op when `data_binding` is `None`). ✓
