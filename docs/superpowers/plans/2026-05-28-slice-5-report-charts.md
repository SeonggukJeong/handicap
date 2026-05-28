# Slice 5 — Report (Charts + JSON Download) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a run reaches a terminal state (`completed` / `failed` / `aborted`), the same run-detail page transitions into a **report** view. The report shows overall summary cards (total requests · errors · RPS · p50/p95/p99 · duration), three 1-second time-series line charts (RPS · p95 ms · errors), a per-step stats table, an HTTP status-code bar chart, the scenario YAML snapshot captured at run time, and a "Download JSON" button that pulls the full report bundle as a file. A controller `GET /api/runs/{id}/report` endpoint serves the bundle — derived percentiles included — so the browser does not have to deserialize the HDR Histogram BLOBs.

**Architecture.** Two layers move in lockstep.

1. **Backend.** A new `crates/engine/src/percentiles.rs` module wraps the existing `hdrhistogram` v2 deserializer behind a `Percentiles { p50_ms, p95_ms, p99_ms }` struct + a `merge(&mut self, other)` for per-step / overall aggregation. The controller gains `crates/controller/src/report.rs` (a pure function over a `RunRow`, a `Vec<MetricRow>`, and a scenario snapshot) plus a thin axum handler `GET /api/runs/{id}/report`. The handler loads `runs.scenario_yaml` (already in the table per ADR-0013 / spec §2.9) and the same metric rows that `/metrics` reads — but this time it pulls the `hdr_histogram` BLOB and runs the new module over it. The `/metrics` endpoint stays unchanged so polling-while-running keeps its cheap hot path and the existing e2e tests still pass verbatim.

2. **Frontend.** A new `useRunReport(id, { enabled: terminal })` React Query hook fetches the bundle exactly once (on terminal transition) and stays cached. A new `ui/src/components/report/` directory holds small, composable pieces (`Summary`, `TimeSeriesChart`, `StepStatsTable`, `StatusDistribution`, `ScenarioSnapshot`, `DownloadJsonButton`, `ReportView`). `RunDetailPage` becomes the controller: while polling, it shows the existing live progress (Steps + Env + Profile + Metric Windows). Once `terminal === true` and the report has loaded, it mounts `ReportView` **in place of** the live progress sections (the Steps/Env/Profile blocks live inside `ReportView` so the page is consistent between states). Charts use **Recharts** (locked by spec §3.2, SVG-based, CSP-safe with our existing `default-src 'self'`).

**Test plan — keeps the Slice 4 bar.** Every layer has failing-first tests:

- **Engine unit tests** (`crates/engine/src/percentiles.rs` + `crates/engine/tests/percentiles_test.rs`): deserialize a known V2 BLOB → assert p50/p95/p99 against canonical values; merging two histograms returns the same result as a single histogram recording the union of samples; an empty / corrupt BLOB returns `Err(PercentileError::Decode)` (callers can choose to skip the window rather than crash); `merge_many(iter)` of zero histograms returns `Percentiles::empty()` with all fields = 0.
- **Controller unit tests** (`crates/controller/src/report.rs` inline `#[cfg(test)] mod tests`): pure `build_report(run, scenario_yaml, rows)` over fixture inputs returns the expected JSON shape; per-step grouping matches step_id; status distribution sums correctly across windows.
- **Controller integration tests** (`crates/controller/tests/report_test.rs`, new): boots an in-process axum app + sqlx pool, seeds a run + scenario + 3 fake `MetricRow`s (with real HDR BLOBs built via `hdrhistogram::Histogram::new`), `GET /api/runs/{id}/report` → asserts on each top-level field (`summary.count` matches sum, `summary.p95_ms` is non-zero, `steps[]` length = distinct step_ids, `status_distribution` totals match). One assertion-light test for `404` on an unknown id.
- **Controller e2e** (`crates/controller/tests/e2e_test.rs`, new `report_e2e_smoke`): spawn worker binary, create a 2-step scenario against wiremock, run for 3 s, poll until `completed`, `GET /api/runs/{id}/report` once, validate (a) `summary.count > 0`, (b) `scenario_yaml` equals the snapshot, (c) `steps.len() == 2`, (d) at least one window has all three percentiles `> 0`. This is the e2e the spec §4.4 calls out (kind-level is Slice 6; in-process worker subprocess is the Slice 4 pattern we keep).
- **UI unit tests** (`ui/src/api/schemas.test.ts`, extended): zod parse round-trip for the new `ReportSchema`. Reject extra fields per existing `.strict()` convention.
- **UI component tests** (`ui/src/components/report/__tests__/*.test.tsx`): RTL tests, **not `it.todo`** — Summary renders the formatted numbers, TimeSeriesChart receives the right data shape (we mock recharts at the SVG-leaf level for jsdom, see Task 7), StepStatsTable shows per-step counts/percentiles, StatusDistribution shows expected bars, ScenarioSnapshot collapses/expands, DownloadJsonButton creates a blob URL on click and revokes it on unmount. ReportView composes them with the correct order.
- **UI page test** (`ui/src/pages/__tests__/RunDetailPage.test.tsx`, extended): terminal-state transition — mocked `GET /api/runs/:id` returns `status: "completed"`, mocked `/report` returns a valid bundle, assert `ReportView` mounts and the live polling sections (Metric Windows table) are no longer in the DOM. A negative test confirms that while `status: "running"`, `useRunReport` is not called (we stub `fetch` and assert no call to `/report`).
- **Manual check runbook** (`docs/dev/ui-slice-5-manual-check.md`, new) covers: run a 30 s scenario, watch live progress, observe terminal transition into the report, verify each chart renders, click "Download JSON" and inspect the file, switch tabs to a `failed` run and `aborted` run to verify the report still renders.

**Tech stack additions:**

- Rust: **none new at workspace level.** `hdrhistogram` already in `crates/engine/Cargo.toml` and re-exported via workspace. Confirm the `serialization` feature is on (it is — used by worker `serialize_histogram`).
- UI: `recharts ^2.13` (prod dep — Recharts is SVG-only, no runtime CDN, CSP-safe under our `default-src 'self'` + `style-src 'self' 'unsafe-inline'`). No new test deps — RTL + jest-dom + user-event already from Slice 4.

No new ADRs needed — every choice in this slice is fixed by **ADR-0009** (no live dashboard, report is the differentiator), **ADR-0012** (worker-side aggregation; HDR Histogram serialized into SQLite), and **ADR-0017** (report scope). Slice 5 just implements them.

**Slice 5 scope (locked):**

| In | Out (deferred) |
|---|---|
| `Percentiles` derivation from stored HDR BLOBs (p50/p95/p99) per window + per step + overall | Live-during-run percentile streaming; raw per-request samples (ADR-0012) |
| New `GET /api/runs/{id}/report` bundle endpoint | Modifying `/metrics` (kept stable; existing tests verbatim pass) |
| `scenario_yaml` snapshot surfaced (from `runs.scenario_yaml` column already present) | Snapshot diff vs current scenario (Slice 5 manual-fixes M2 noted live YAML; we now use snapshot) |
| Report-mode transition on terminal — same page, swaps live progress for report | Separate `/runs/:id/report` URL; report shareable link |
| 3 line charts (RPS, p95 ms, errors) + 1 bar chart (status distribution); summary cards; per-step table; YAML snapshot block; JSON download button | Run-to-run comparison; SLA pass/fail; transaction time decomposition; CSV/Excel; latency histogram view (ADR-0017 OUT list) |
| RTL component tests for every new report component; e2e `report_e2e_smoke` | Playwright; visual regression |
| Manual check runbook (`ui-slice-5-manual-check.md`) | kind/Helm e2e (Slice 6) |

**Prerequisites:**
- Slice 4 green. Run from repo root: `just build && just lint && just test` then `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build`. CLAUDE.md should already mention "Slice 4 결과:" and the manual-check-fixes note.
- Wiremock available for the e2e and manual runbook (same as Slice 4).

---

## Lessons from Slice 1–4 to NOT repeat

Every Slice 5 task is checked against this list before commit. The plan reviewer (and the executing agent) MUST flag any task that violates one.

1. **No backend-without-UI gap (M1).** The most painful Slice 4 mistake: `ramp_up_seconds` / `env` shipped through proto + engine + controller, but `RunDialog` hardcoded them. We did not catch it until manual check. **Slice 5 rule:** every new backend field has a UI display task in the same iteration. If Task N adds `summary.p95_ms` to the report endpoint, Task N+k surfaces it in `Summary.tsx` and asserts on it with RTL.
2. **`pnpm build` is the only TS-strict gate (Slice 4).** `pnpm test` uses esbuild transpile and silently widens types. After every UI-touching task we MUST run `pnpm build` and only commit if it passes. The Zod `.default()` input-type leak (`number | undefined`) bit us once — every task that introduces a new schema field must run `pnpm build` before the commit step.
3. **Recharts is not jsdom-friendly without a viewport.** Recharts uses `ResponsiveContainer` which needs `width/height` to layout. In jsdom there is no real layout, so Recharts renders nothing and SVG queries fail. **Pattern:** wrap each chart in a small component that takes explicit `width: number, height: number` and use those in RTL tests; the `<ResponsiveContainer>` is only used in production by ReportView passing a measured size via a parent. Alternatively, pass `width/height` directly to the chart primitive (skip `ResponsiveContainer` in unit tests). Tests in this plan use the explicit-size path.
4. **Polling thrash (carry-forward).** While the run is non-terminal, `useRun` and `useRunMetrics` poll at 1 s. We MUST NOT add `useRunReport` to that polling set. It is `enabled: terminal === true`, fetches once, and is then cached forever (the run is immutable after terminal).
5. **HDR deserialize errors must not crash the endpoint (defensive).** Old or partially-written `hdr_histogram` BLOBs (a worker that crashed mid-flush, for example) might decode to `Err`. The endpoint must log a warning and treat that window as having zero histogram data (count/error_count/status_counts still trustable from their own columns). Crashing the report endpoint on one bad row would lose the entire run's report.
6. **belt-and-suspenders (Slice 4 F4).** Slice 5 introduces a single safeguard around HDR decode failures (item 5). Document the contract explicitly in the code comment; no e2e test will catch a silent regression that swallows valid data. The unit test in `crates/engine/tests/percentiles_test.rs` is the only line of defense.
7. **clippy `--all-targets -- -D warnings` runs on every commit.** Pre-commit hook from Slice 4 F2 already enforces; do not add `#[allow(...)]` to silence lint at the call site — fix the root cause. Particularly suspect: `assign_op_pattern` (`x = x + y`), `or_insert_with(Default::default)` (use `or_default()`).
8. **No new ADR/decision without an ADR file.** If during this slice we discover a real architectural decision (e.g. caching derived percentiles), pause, write the ADR, then proceed. Do not embed silent decisions in code comments.
9. **Display-time template resolver stays canonical.** Slice 5 might be tempted to inline new template logic in the report (e.g. expanding `${BASE_URL}` in YAML snapshot pre-render). Use the existing `ui/src/scenario/template.ts::resolveForDisplay` — don't fork it. If new template grammar comes in, both `crates/engine/src/template.rs` AND `ui/src/scenario/template.ts` change in the same task (Slice 4 manual-check-fixes M3).
10. **TDD-guard pending-file pattern (Slice 2/3/4 carry-forward).** New Rust source files in `crates/*/src/*.rs` and new TS source files in `ui/src/**/*.{ts,tsx}` must have a pending test file in the working tree before the source file is created. Use `it.todo("...")` for TS or compile-only stub `mod tests {}` for Rust if the real test in the same task comes later. Standard pattern; do not skip — the hook will block the edit.
11. **mpsc drain ≠ wire deliver (Slice 4 F6).** Not in scope for Slice 5 (no new gRPC), but if any code path adds a `drop(tx)` + sync-on-receiver-close pattern, follow the existing `inbound_fwd.await` shape, not a `sleep()`.
12. **commit-on-blur for editor inputs (Slice 4 F5).** ReportView is read-only — no input commit issues. But the JSON-download component creates a blob URL; revoke it on unmount in a `useEffect` cleanup to avoid leaking object URLs across mount/unmount cycles.

---

## File structure (Slice 5 — only new / modified)

```
crates/engine/src/percentiles.rs                          # NEW HDR decode + Percentiles struct + merge
crates/engine/src/lib.rs                                  # re-export Percentiles, PercentileError
crates/engine/tests/percentiles_test.rs                   # NEW unit tests for percentile derivation

crates/controller/src/report.rs                           # NEW report bundling (pure fn + types)
crates/controller/src/api/runs.rs                         # + report() handler
crates/controller/src/app.rs                              # + .route("/api/runs/{id}/report", get(...))
crates/controller/src/store/metrics.rs                    # + windows_with_hdr() query (reads hdr_histogram column)
crates/controller/src/lib.rs                              # mod report;
crates/controller/tests/report_test.rs                    # NEW integration test for /report
crates/controller/tests/e2e_test.rs                       # + report_e2e_smoke test

ui/package.json                                           # + recharts (prod)
ui/pnpm-lock.yaml                                         # regenerated
ui/src/api/schemas.ts                                     # + ReportSchema, SummarySchema, ReportWindowSchema, StepStatSchema
ui/src/api/client.ts                                      # + getRunReport
ui/src/api/hooks.ts                                       # + useRunReport
ui/src/api/__tests__/schemas.test.ts                      # + Report zod cases
ui/src/components/report/Summary.tsx                      # NEW summary cards
ui/src/components/report/TimeSeriesChart.tsx              # NEW Recharts line chart wrapper
ui/src/components/report/StepStatsTable.tsx               # NEW per-step table
ui/src/components/report/StatusDistribution.tsx           # NEW Recharts bar chart
ui/src/components/report/ScenarioSnapshot.tsx             # NEW YAML snapshot (Monaco read-only)
ui/src/components/report/DownloadJsonButton.tsx           # NEW blob URL download
ui/src/components/report/ReportView.tsx                   # NEW composite
ui/src/components/report/__tests__/Summary.test.tsx       # NEW
ui/src/components/report/__tests__/TimeSeriesChart.test.tsx
ui/src/components/report/__tests__/StepStatsTable.test.tsx
ui/src/components/report/__tests__/StatusDistribution.test.tsx
ui/src/components/report/__tests__/ScenarioSnapshot.test.tsx
ui/src/components/report/__tests__/DownloadJsonButton.test.tsx
ui/src/components/report/__tests__/ReportView.test.tsx
ui/src/pages/RunDetailPage.tsx                            # report-mode transition
ui/src/pages/__tests__/RunDetailPage.test.tsx             # + terminal-transition test

docs/dev/ui-slice-5-manual-check.md                       # NEW
CLAUDE.md                                                 # + Slice 5 결과 paragraph + new pitfalls
```

**Conventions (carry over from Slice 2–4):**
- Function components: `function Foo(...)`, not `const Foo = (...)`.
- One Tailwind utility-class chain per element; line-break long chains.
- Vitest tests live under `__tests__/` next to source.
- No emoji, no decorative comments. Comments only where the *why* is non-obvious.
- Rust: prefer `?` over manual match. `thiserror::Error` on every error type in `error.rs`. No `unwrap()` in non-test code.
- Every step in this plan that creates a new Rust src file `crates/<crate>/src/<name>.rs` first creates a pending `crates/<crate>/tests/<name>_test.rs` stub (or an inline `#[cfg(test)] mod tests {}`) to satisfy TDD-guard.
- Every step in this plan that creates a new TS src file `ui/src/.../<name>.ts(x)` first creates a pending `__tests__/<name>.test.tsx` with at least one `it.todo` line.

---

## Task 1: Dependencies (UI: recharts) + Rust audit

**Files:**
- Modify: `ui/package.json`
- (no Rust file changes — confirmation step only)

- [ ] **Step 1: Audit `hdrhistogram` reachability for the controller**

Run:

```bash
cargo tree -p handicap-controller -i hdrhistogram 2>&1 | head -20
```

Expected: `hdrhistogram v7.x` appears under engine→controller (the controller depends on the engine crate). If it does NOT, edit `crates/controller/Cargo.toml` to add a direct workspace dep:

```toml
hdrhistogram.workspace = true
```

And re-run `cargo build -p handicap-controller --tests` to confirm.

- [ ] **Step 2: Add Recharts to UI**

Edit `ui/package.json`. Add to `dependencies` (alphabetical):

```json
{
  "dependencies": {
    "recharts": "^2.13.0"
  }
}
```

Then:

```bash
cd ui && pnpm install
```

Expected: lockfile updates; no peer-dep failures (recharts 2.x supports React 18).

- [ ] **Step 3: Smoke-build the UI**

```bash
cd ui && pnpm build
```

Expected: clean build. Recharts adds ~50–80 kB gzipped — fine for an internal QA tool.

- [ ] **Step 4: Commit**

```bash
git add ui/package.json ui/pnpm-lock.yaml
git commit -m "build(ui): add recharts for slice 5 report charts"
```

---

## Task 2: Engine — `Percentiles` module (HDR decode + merge)

**Files:**
- Create: `crates/engine/src/percentiles.rs`
- Modify: `crates/engine/src/lib.rs`
- Create: `crates/engine/tests/percentiles_test.rs`

The engine already produces and serializes HDR Histograms in `aggregator.rs::serialize_histogram` (V2 format). Slice 5 introduces the reverse path: deserialize a BLOB, derive `Percentiles { p50_ms, p95_ms, p99_ms }`, and merge multiple histograms losslessly (HDR Histogram supports lossless add).

- [ ] **Step 1: TDD-guard stub — create the test file first with `mod tests {}` placeholder**

Create `crates/engine/tests/percentiles_test.rs`:

```rust
// Placeholder to satisfy tdd-guard before percentiles.rs lands.
// Real tests appear in Step 3.
#[test]
fn placeholder() {}
```

- [ ] **Step 2: Create `percentiles.rs` with the failing real test signatures**

Create `crates/engine/src/percentiles.rs`:

```rust
use hdrhistogram::{Histogram, serialization::{Deserializer, V2Deserializer}};
use std::io::Cursor;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Percentiles {
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

impl Percentiles {
    pub fn empty() -> Self {
        Self { p50_ms: 0, p95_ms: 0, p99_ms: 0 }
    }
}

#[derive(Debug, Error)]
pub enum PercentileError {
    #[error("failed to decode HDR Histogram V2 blob: {0}")]
    Decode(String),
}

/// Deserialize a V2-serialized HDR Histogram BLOB (microseconds).
/// Empty BLOB returns Ok(None) — caller can use Percentiles::empty().
pub fn decode_hdr(bytes: &[u8]) -> Result<Option<Histogram<u64>>, PercentileError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let mut cur = Cursor::new(bytes);
    let mut deser = V2Deserializer::new();
    deser.deserialize(&mut cur).map(Some).map_err(|e| PercentileError::Decode(e.to_string()))
}

/// Read percentiles in milliseconds. Histogram stores microseconds; we divide.
pub fn percentiles_of(h: &Histogram<u64>) -> Percentiles {
    Percentiles {
        p50_ms: h.value_at_quantile(0.50) / 1_000,
        p95_ms: h.value_at_quantile(0.95) / 1_000,
        p99_ms: h.value_at_quantile(0.99) / 1_000,
    }
}

/// Merge `other` into `acc`. Both must have the same scale (microseconds).
/// HDR Histogram add is lossless when ranges overlap.
pub fn merge_into(acc: &mut Histogram<u64>, other: &Histogram<u64>) {
    // hdrhistogram::Histogram has `+=` via `add_correct` / `add`; both
    // ignore samples outside the target's tracked range. We use `add`
    // which is the simple, lossless form for same-config histograms.
    acc.add(other).expect("histograms have compatible bounds");
}
```

- [ ] **Step 3: Wire into `lib.rs`**

Edit `crates/engine/src/lib.rs`. Add (next to other `pub mod` lines):

```rust
pub mod percentiles;
```

- [ ] **Step 4: Replace placeholder with the real failing tests**

Overwrite `crates/engine/tests/percentiles_test.rs`:

```rust
use handicap_engine::percentiles::{decode_hdr, merge_into, percentiles_of, Percentiles};
use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};

fn record_us(h: &mut Histogram<u64>, samples_us: &[u64]) {
    for &v in samples_us {
        h.record(v).unwrap();
    }
}

fn serialize(h: &Histogram<u64>) -> Vec<u8> {
    let mut buf = Vec::new();
    V2Serializer::new().serialize(h, &mut buf).unwrap();
    buf
}

#[test]
fn percentiles_of_uniform_distribution() {
    // 1ms..100ms, 100 samples — p50 ~= 50ms, p95 ~= 95ms, p99 ~= 99ms
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &(1..=100).map(|i| i * 1_000).collect::<Vec<_>>());
    let p = percentiles_of(&h);
    assert!(p.p50_ms >= 49 && p.p50_ms <= 51, "p50={} not ~50", p.p50_ms);
    assert!(p.p95_ms >= 94 && p.p95_ms <= 96, "p95={} not ~95", p.p95_ms);
    assert!(p.p99_ms >= 98 && p.p99_ms <= 100, "p99={} not ~99", p.p99_ms);
}

#[test]
fn decode_roundtrip() {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut h, &[10_000, 20_000, 30_000, 40_000, 50_000]);
    let bytes = serialize(&h);
    let decoded = decode_hdr(&bytes).expect("decode ok").expect("non-empty");
    let p = percentiles_of(&decoded);
    let p_original = percentiles_of(&h);
    assert_eq!(p, p_original);
}

#[test]
fn decode_empty_returns_none() {
    assert!(decode_hdr(&[]).unwrap().is_none());
}

#[test]
fn decode_garbage_returns_err() {
    assert!(decode_hdr(&[0xFF, 0xFF, 0xFF, 0xFF]).is_err());
}

#[test]
fn merge_is_lossless_for_overlapping_samples() {
    let mut a = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    let mut b = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut a, &[10_000, 20_000, 30_000]);
    record_us(&mut b, &[40_000, 50_000, 60_000]);

    let mut union = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    record_us(&mut union, &[10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);

    merge_into(&mut a, &b);
    assert_eq!(percentiles_of(&a), percentiles_of(&union));
}

#[test]
fn empty_percentiles() {
    assert_eq!(Percentiles::empty(), Percentiles { p50_ms: 0, p95_ms: 0, p99_ms: 0 });
}
```

- [ ] **Step 5: Run tests — expect 5 PASS, 1 placeholder gone**

```bash
cargo test -p handicap-engine --test percentiles_test
```

Expected: 5 passed.

- [ ] **Step 6: Verify clippy + workspace test still pass**

```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add crates/engine/src/percentiles.rs crates/engine/src/lib.rs crates/engine/tests/percentiles_test.rs
git commit -m "feat(engine): add Percentiles module (HDR decode + merge + p50/p95/p99)"
```

---

## Task 3: Controller store — `windows_with_hdr` query

**Files:**
- Modify: `crates/controller/src/store/metrics.rs`

The existing `summary()` query reads `ts_second, step_id, count, error_count, status_counts` — **not** `hdr_histogram`. Slice 5 adds a sibling query that also pulls the BLOB. Keeping them separate means `/metrics` (live polling) stays small.

- [ ] **Step 1: Inspect current query**

Read `crates/controller/src/store/metrics.rs` (whole file, ~90 lines). Locate the `summary()` function and its query.

- [ ] **Step 2: Add a new row type + query**

In the same file, below `WindowSummary`, add:

```rust
#[derive(Debug, sqlx::FromRow)]
pub struct WindowWithHdr {
    pub ts_second: i64,
    pub step_id: String,
    pub count: i64,
    pub error_count: i64,
    pub status_counts: String,    // JSON text — same as WindowSummary
    pub hdr_histogram: Vec<u8>,
}

pub async fn windows_with_hdr(
    pool: &sqlx::SqlitePool,
    run_id: &str,
) -> Result<Vec<WindowWithHdr>, sqlx::Error> {
    sqlx::query_as::<_, WindowWithHdr>(
        r#"SELECT ts_second, step_id, count, error_count, status_counts, hdr_histogram
           FROM run_metrics
           WHERE run_id = ?
           ORDER BY ts_second, step_id"#,
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
}
```

- [ ] **Step 3: Add an inline test that verifies the query shape**

At the bottom of `metrics.rs` (after any existing `#[cfg(test)] mod tests`), add a test (or extend the existing mod):

```rust
#[cfg(test)]
mod windows_with_hdr_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> sqlx::SqlitePool {
        let p = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn returns_rows_in_order_with_hdr_bytes() {
        let p = pool().await;
        // Seed scenario + run rows so foreign key holds (assuming schema requires them — check migrations).
        // ... follow the seeding pattern from existing tests in this file.
        // Insert two metric rows with different ts_seconds, fetch, assert ordering + hdr is non-empty.
        // [Engineer: copy the seeding pattern from the existing test in this file. The exact INSERT
        //  fixture sql is in `migrations/` — same as the existing seed in store/runs.rs tests.]
    }
}
```

> **Engineer note:** if the existing `metrics.rs` has no inline test infrastructure, add the test to `crates/controller/tests/store_metrics_test.rs` instead (new file). Use the seeding pattern from `crates/controller/tests/api_test.rs::create_and_get_scenario` as a reference — it shows how to set up an in-memory pool with migrations.

- [ ] **Step 4: Run + commit**

```bash
cargo test -p handicap-controller --lib
cargo clippy --workspace --all-targets -- -D warnings

git add crates/controller/src/store/metrics.rs
# (or git add crates/controller/tests/store_metrics_test.rs if you went that route)
git commit -m "feat(controller): add windows_with_hdr store query for report endpoint"
```

---

## Task 4: Controller — `report.rs` module (pure bundling)

**Files:**
- Create: `crates/controller/src/report.rs`
- Modify: `crates/controller/src/lib.rs`

A pure function `build_report(run: &RunRow, scenario_yaml: &str, rows: &[WindowWithHdr]) -> ReportJson`. No DB access. No HTTP. Trivial to unit-test.

- [ ] **Step 1: TDD-guard pending stub**

Since `crates/controller/src/report.rs` is new and `#[cfg(test)] mod tests` won't exist yet, create a placeholder test file `crates/controller/tests/report_test.rs` first:

```rust
// Placeholder — real tests in Task 5.
#[test]
fn placeholder() {}
```

- [ ] **Step 2: Define the report JSON types**

Create `crates/controller/src/report.rs`:

```rust
use crate::store::metrics::WindowWithHdr;
use crate::store::runs::RunRow;
use handicap_engine::percentiles::{decode_hdr, merge_into, percentiles_of, Percentiles};
use hdrhistogram::Histogram;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
pub struct ReportJson {
    pub run: ReportRun,
    pub scenario_yaml: String,
    pub summary: ReportSummary,
    pub windows: Vec<ReportWindow>,
    pub steps: Vec<ReportStep>,
    pub status_distribution: BTreeMap<String, u64>,
}

#[derive(Debug, Serialize)]
pub struct ReportRun {
    pub id: String,
    pub scenario_id: String,
    pub status: String,
    pub profile: serde_json::Value,
    pub env: serde_json::Value,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ReportSummary {
    pub count: u64,
    pub errors: u64,
    pub rps: f64,
    pub duration_seconds: i64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct ReportWindow {
    pub ts_second: i64,
    pub step_id: String,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: BTreeMap<String, u64>,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct ReportStep {
    pub step_id: String,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: BTreeMap<String, u64>,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

fn parse_status_counts(s: &str) -> BTreeMap<String, u64> {
    serde_json::from_str(s).unwrap_or_default()
}

fn add_status(into: &mut BTreeMap<String, u64>, from: &BTreeMap<String, u64>) {
    for (k, v) in from {
        *into.entry(k.clone()).or_insert(0) += v;
    }
}

const HDR_LO_US: u64 = 1;
const HDR_HI_US: u64 = 60_000_000;
const HDR_SIGFIG: u8 = 3;

fn fresh_hist() -> Histogram<u64> {
    Histogram::<u64>::new_with_bounds(HDR_LO_US, HDR_HI_US, HDR_SIGFIG)
        .expect("HDR bounds are valid")
}

pub fn build_report(run: &RunRow, scenario_yaml: &str, rows: &[WindowWithHdr]) -> ReportJson {
    // Per-window
    let mut windows: Vec<ReportWindow> = Vec::with_capacity(rows.len());
    let mut overall = fresh_hist();
    let mut per_step: BTreeMap<String, Histogram<u64>> = BTreeMap::new();
    let mut per_step_count: BTreeMap<String, (u64, u64, BTreeMap<String, u64>)> = BTreeMap::new();
    let mut status_dist: BTreeMap<String, u64> = BTreeMap::new();
    let mut total_count: u64 = 0;
    let mut total_errors: u64 = 0;

    for r in rows {
        let sc = parse_status_counts(&r.status_counts);
        let mut wp = Percentiles::empty();
        if let Ok(Some(h)) = decode_hdr(&r.hdr_histogram) {
            wp = percentiles_of(&h);
            merge_into(&mut overall, &h);
            let entry = per_step.entry(r.step_id.clone()).or_insert_with(fresh_hist);
            merge_into(entry, &h);
        }
        // count / errors / status are trustable from columns regardless of HDR decode.
        total_count += r.count as u64;
        total_errors += r.error_count as u64;
        add_status(&mut status_dist, &sc);
        let step_acc = per_step_count.entry(r.step_id.clone()).or_default();
        step_acc.0 += r.count as u64;
        step_acc.1 += r.error_count as u64;
        add_status(&mut step_acc.2, &sc);

        windows.push(ReportWindow {
            ts_second: r.ts_second,
            step_id: r.step_id.clone(),
            count: r.count as u64,
            error_count: r.error_count as u64,
            status_counts: sc,
            p50_ms: wp.p50_ms,
            p95_ms: wp.p95_ms,
            p99_ms: wp.p99_ms,
        });
    }

    let overall_p = percentiles_of(&overall);
    let profile: serde_json::Value =
        serde_json::from_str(&run.profile_json).unwrap_or(serde_json::Value::Null);
    let env: serde_json::Value =
        serde_json::from_str(&run.env_json).unwrap_or(serde_json::Value::Null);
    let duration = run.ended_at.unwrap_or(0).saturating_sub(run.started_at.unwrap_or(0));
    let rps = if duration > 0 { total_count as f64 / duration as f64 } else { 0.0 };

    let mut steps: Vec<ReportStep> = per_step_count
        .into_iter()
        .map(|(step_id, (count, errors, status_counts))| {
            let p = per_step.get(&step_id).map(percentiles_of).unwrap_or_else(Percentiles::empty);
            ReportStep {
                step_id,
                count,
                error_count: errors,
                status_counts,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
            }
        })
        .collect();
    steps.sort_by(|a, b| a.step_id.cmp(&b.step_id));

    ReportJson {
        run: ReportRun {
            id: run.id.clone(),
            scenario_id: run.scenario_id.clone(),
            status: run.status.clone(),
            profile,
            env,
            started_at: run.started_at,
            ended_at: run.ended_at,
            created_at: run.created_at,
        },
        scenario_yaml: scenario_yaml.to_string(),
        summary: ReportSummary {
            count: total_count,
            errors: total_errors,
            rps,
            duration_seconds: duration,
            p50_ms: overall_p.p50_ms,
            p95_ms: overall_p.p95_ms,
            p99_ms: overall_p.p99_ms,
        },
        windows,
        steps,
        status_distribution: status_dist,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::runs::RunRow;
    use hdrhistogram::serialization::{Serializer, V2Serializer};

    fn make_hdr_bytes(samples_us: &[u64]) -> Vec<u8> {
        let mut h = fresh_hist();
        for &v in samples_us {
            h.record(v).unwrap();
        }
        let mut buf = Vec::new();
        V2Serializer::new().serialize(&h, &mut buf).unwrap();
        buf
    }

    fn run_row() -> RunRow {
        RunRow {
            id: "R1".into(),
            scenario_id: "S1".into(),
            scenario_yaml: "version: 1\nname: x\nsteps: []\n".into(),
            profile_json: r#"{"vus":1,"ramp_up_seconds":0,"duration_seconds":2}"#.into(),
            env_json: "{}".into(),
            status: "completed".into(),
            started_at: Some(100),
            ended_at: Some(102),
            created_at: 99,
        }
    }

    fn win(ts: i64, step: &str, count: i64, errors: i64, sc: &str, samples: &[u64]) -> WindowWithHdr {
        WindowWithHdr {
            ts_second: ts,
            step_id: step.into(),
            count,
            error_count: errors,
            status_counts: sc.into(),
            hdr_histogram: make_hdr_bytes(samples),
        }
    }

    #[test]
    fn build_report_aggregates_totals() {
        let r = run_row();
        let rows = vec![
            win(100, "stepA", 10, 1, r#"{"200":9,"500":1}"#, &[10_000, 20_000]),
            win(101, "stepA", 5, 0, r#"{"200":5}"#, &[15_000]),
            win(101, "stepB", 3, 1, r#"{"200":2,"500":1}"#, &[25_000]),
        ];
        let rpt = build_report(&r, &r.scenario_yaml, &rows);
        assert_eq!(rpt.summary.count, 18);
        assert_eq!(rpt.summary.errors, 2);
        assert_eq!(rpt.summary.duration_seconds, 2);
        assert!(rpt.summary.rps > 8.9 && rpt.summary.rps < 9.1);
        assert_eq!(rpt.windows.len(), 3);
        assert_eq!(rpt.steps.len(), 2);
        assert_eq!(rpt.status_distribution.get("200").copied(), Some(16));
        assert_eq!(rpt.status_distribution.get("500").copied(), Some(2));
        // Percentiles come out non-zero
        assert!(rpt.summary.p95_ms > 0);
    }

    #[test]
    fn build_report_tolerates_bad_hdr_blob() {
        let r = run_row();
        let bad = WindowWithHdr {
            ts_second: 100,
            step_id: "stepA".into(),
            count: 5,
            error_count: 0,
            status_counts: r#"{"200":5}"#.into(),
            hdr_histogram: vec![0xff, 0xff, 0xff, 0xff],  // garbage
        };
        let rpt = build_report(&r, &r.scenario_yaml, &[bad]);
        // count/errors/status still correct
        assert_eq!(rpt.summary.count, 5);
        assert_eq!(rpt.status_distribution.get("200").copied(), Some(5));
        // Percentiles fall back to 0 for the one window with broken HDR
        assert_eq!(rpt.windows[0].p95_ms, 0);
        assert_eq!(rpt.summary.p95_ms, 0);
    }
}
```

- [ ] **Step 3: Wire `mod report` into the controller lib**

Edit `crates/controller/src/lib.rs`. Add:

```rust
pub mod report;
```

- [ ] **Step 4: Run + commit**

```bash
cargo test -p handicap-controller --lib report::
cargo clippy --workspace --all-targets -- -D warnings

git add crates/controller/src/report.rs crates/controller/src/lib.rs crates/controller/tests/report_test.rs
git commit -m "feat(controller): add report bundling module (pure fn + types)"
```

> **Engineer note:** `RunRow` struct path is `crate::store::runs::RunRow`. If the actual field names differ from what's used above (`profile_json`, `env_json`, `scenario_yaml`, `started_at`, etc.), open `crates/controller/src/store/runs.rs` and adjust the test fixtures to match. Do NOT change the `RunRow` struct itself in this task.

---

## Task 5: Controller — `GET /api/runs/{id}/report` endpoint

**Files:**
- Modify: `crates/controller/src/api/runs.rs`
- Modify: `crates/controller/src/app.rs`
- Replace placeholder: `crates/controller/tests/report_test.rs`

- [ ] **Step 1: Write the failing integration test first**

Overwrite `crates/controller/tests/report_test.rs`:

```rust
use axum::body::to_bytes;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::report::ReportJson;
use serde_json::Value;
use tower::ServiceExt;

mod common;

#[tokio::test]
async fn report_endpoint_returns_404_on_unknown_run() {
    let app = common::test_app().await;

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/runs/NOPE/report")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn report_endpoint_returns_bundle_for_seeded_run() {
    let (app, run_id, scenario_yaml) = common::seed_run_with_metrics().await;

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["run"]["id"].as_str().unwrap(), run_id);
    assert_eq!(json["scenario_yaml"].as_str().unwrap(), scenario_yaml);
    assert!(json["summary"]["count"].as_u64().unwrap() > 0);
    assert!(json["steps"].as_array().unwrap().len() >= 1);

    // Also typed-decode it to catch shape regressions
    let _typed: ReportJson = serde_json::from_value(json).unwrap();
}
```

Create `crates/controller/tests/common/mod.rs` (if it doesn't already exist; reuse if it does):

```rust
// Test helpers shared across controller integration tests.
// If this file already exists, MERGE seed_run_with_metrics in — do not overwrite.
//
// seed_run_with_metrics returns (Router, run_id, scenario_yaml).
//
// [Engineer: implement using the same pattern as existing api_test.rs setup.
//  Insert a scenario row, a run row with status='completed', and 2 run_metrics
//  rows with valid hdr_histogram bytes (use V2Serializer + Histogram::new_with_bounds(1, 60_000_000, 3)).
//  Reuse `crate::app::build_app(pool, None)` or whatever the existing tests use.]
```

> **Engineer:** if a `tests/common/mod.rs` already exists, do not overwrite — add `seed_run_with_metrics` to it. Use the existing test patterns in `crates/controller/tests/api_test.rs` (line range from the survey: `create_and_get_scenario` ~line 101) as the seeding template.

- [ ] **Step 2: Run the test — expect FAIL (no handler yet)**

```bash
cargo test -p handicap-controller --test report_test
```

Expected: 404 test passes, the bundle test fails with 404 (because `/report` is not registered yet).

- [ ] **Step 3: Add the handler**

Edit `crates/controller/src/api/runs.rs`. Add (alongside the existing `metrics()` handler):

```rust
use crate::report::{build_report, ReportJson};
use crate::store::metrics::windows_with_hdr;

pub async fn report(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ReportJson>, StatusCode> {
    let run = crate::store::runs::get(&state.pool, &id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let rows = windows_with_hdr(&state.pool, &id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(build_report(&run, &run.scenario_yaml, &rows)))
}
```

> **Engineer:** the exact `use` paths and `State<AppState>` extractor type should match the conventions in the same file. Use the existing `metrics` handler in `runs.rs` as your shape reference.

- [ ] **Step 4: Register the route**

Edit `crates/controller/src/app.rs`. Locate the `/api/runs/{id}/metrics` route line. Add right next to it:

```rust
.route("/api/runs/{id}/report", axum::routing::get(api::runs::report))
```

- [ ] **Step 5: Run the test — expect PASS**

```bash
cargo test -p handicap-controller --test report_test
```

Expected: both tests green.

- [ ] **Step 6: Verify ALL controller tests still pass (no regression)**

```bash
cargo test -p handicap-controller
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: all green; in particular the existing `static_test.rs`, `api_test.rs`, and `e2e_test.rs` tests must still pass — slice 5 is purely additive.

- [ ] **Step 7: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/app.rs crates/controller/tests/report_test.rs crates/controller/tests/common/mod.rs
git commit -m "feat(controller): add GET /api/runs/{id}/report endpoint"
```

---

## Task 6: UI — Zod schemas for the report bundle

**Files:**
- Modify: `ui/src/api/schemas.ts`
- Create/modify: `ui/src/api/__tests__/schemas.test.ts`

- [ ] **Step 1: Pending test file (TDD-guard)**

If `ui/src/api/__tests__/schemas.test.ts` doesn't exist, create it with at least one `it.todo`:

```ts
import { describe, it } from "vitest";
describe("schemas", () => {
  it.todo("ReportSchema parses bundled report");
});
```

- [ ] **Step 2: Add the schemas**

Edit `ui/src/api/schemas.ts`. Add (after existing schemas):

```ts
export const StatusDistributionSchema = z.record(z.string(), z.number().int().nonnegative());

export const ReportWindowSchema = z
  .object({
    ts_second: z.number().int(),
    step_id: z.string(),
    count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    status_counts: StatusDistributionSchema,
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
  })
  .strict();

export const ReportStepSchema = z
  .object({
    step_id: z.string(),
    count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    status_counts: StatusDistributionSchema,
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
  })
  .strict();

export const ReportSummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    rps: z.number().nonnegative(),
    duration_seconds: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
  })
  .strict();

export const ReportRunSchema = z
  .object({
    id: z.string(),
    scenario_id: z.string(),
    status: z.string(),
    profile: z.unknown(),
    env: z.unknown(),
    started_at: z.number().int().nullable(),
    ended_at: z.number().int().nullable(),
    created_at: z.number().int(),
  })
  .strict();

export const ReportSchema = z
  .object({
    run: ReportRunSchema,
    scenario_yaml: z.string(),
    summary: ReportSummarySchema,
    windows: z.array(ReportWindowSchema),
    steps: z.array(ReportStepSchema),
    status_distribution: StatusDistributionSchema,
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;
export type ReportWindow = z.infer<typeof ReportWindowSchema>;
export type ReportStep = z.infer<typeof ReportStepSchema>;
export type ReportSummary = z.infer<typeof ReportSummarySchema>;
```

- [ ] **Step 3: Replace `it.todo` with real tests**

Overwrite `ui/src/api/__tests__/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ReportSchema } from "../schemas";

describe("ReportSchema", () => {
  it("parses a minimal valid bundle", () => {
    const sample = {
      run: {
        id: "R1",
        scenario_id: "S1",
        status: "completed",
        profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
        env: {},
        started_at: 100,
        ended_at: 102,
        created_at: 99,
      },
      scenario_yaml: "version: 1\nname: x\nsteps: []\n",
      summary: {
        count: 10,
        errors: 1,
        rps: 5.0,
        duration_seconds: 2,
        p50_ms: 10,
        p95_ms: 50,
        p99_ms: 90,
      },
      windows: [
        {
          ts_second: 100,
          step_id: "stepA",
          count: 5,
          error_count: 0,
          status_counts: { "200": 5 },
          p50_ms: 10,
          p95_ms: 20,
          p99_ms: 30,
        },
      ],
      steps: [
        {
          step_id: "stepA",
          count: 5,
          error_count: 0,
          status_counts: { "200": 5 },
          p50_ms: 10,
          p95_ms: 20,
          p99_ms: 30,
        },
      ],
      status_distribution: { "200": 9, "500": 1 },
    };
    expect(() => ReportSchema.parse(sample)).not.toThrow();
  });

  it("rejects extra top-level keys (strict)", () => {
    const sample = { foo: 1 };
    expect(() => ReportSchema.parse(sample)).toThrow();
  });
});
```

- [ ] **Step 4: Run + build + commit**

```bash
cd ui && pnpm test -- --run schemas
pnpm build

git add ui/src/api/schemas.ts ui/src/api/__tests__/schemas.test.ts
git commit -m "feat(ui): add Report Zod schemas"
```

> **Why `pnpm build` here:** new schemas with nested `.default()` or composite types can silently leak `| undefined` in nested `z.infer`. Slice 4 hit this; the only gate is `pnpm build` (`tsc -b`).

---

## Task 7: UI — API client + React Query hook

**Files:**
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/api/hooks.ts`

- [ ] **Step 1: Add `getRunReport` to client**

Edit `ui/src/api/client.ts`. Add (next to existing run methods):

```ts
import { ReportSchema, type Report } from "./schemas";

export async function getRunReport(id: string): Promise<Report> {
  const r = await fetch(`${API_BASE}/api/runs/${id}/report`);
  if (!r.ok) throw new Error(`GET /api/runs/${id}/report → ${r.status}`);
  const data = await r.json();
  return ReportSchema.parse(data);
}
```

> **Engineer:** `API_BASE` is whatever constant the existing functions use (check the top of `client.ts`). Reuse it.

- [ ] **Step 2: Add `useRunReport` hook**

Edit `ui/src/api/hooks.ts`. Add:

```ts
import { getRunReport } from "./client";
import type { Report } from "./schemas";

export function useRunReport(id: string | undefined, enabled: boolean) {
  return useQuery<Report>({
    queryKey: ["runs", id, "report"],
    queryFn: () => getRunReport(id!),
    enabled: enabled && !!id,
    // Report is immutable after terminal — never refetch on focus or interval.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}
```

- [ ] **Step 3: Build + commit (no separate test step; covered by RunDetailPage page test in Task 14)**

```bash
cd ui && pnpm build
pnpm lint

git add ui/src/api/client.ts ui/src/api/hooks.ts
git commit -m "feat(ui): add getRunReport + useRunReport hook"
```

---

## Task 8: UI — Summary cards component

**Files:**
- Create: `ui/src/components/report/Summary.tsx`
- Create: `ui/src/components/report/__tests__/Summary.test.tsx`

- [ ] **Step 1: Pending test stub (TDD-guard)**

Create `ui/src/components/report/__tests__/Summary.test.tsx`:

```tsx
import { describe, it } from "vitest";
describe("Summary", () => {
  it.todo("renders summary cards with totals and percentiles");
});
```

- [ ] **Step 2: Create the component**

Create `ui/src/components/report/Summary.tsx`:

```tsx
import type { ReportSummary } from "../../api/schemas";

type Props = { summary: ReportSummary };

export function Summary({ summary }: Props) {
  const cards: Array<{ label: string; value: string }> = [
    { label: "Total requests", value: summary.count.toLocaleString() },
    { label: "Errors", value: summary.errors.toLocaleString() },
    { label: "Avg RPS", value: summary.rps.toFixed(1) },
    { label: "Duration", value: `${summary.duration_seconds}s` },
    { label: "p50", value: `${summary.p50_ms} ms` },
    { label: "p95", value: `${summary.p95_ms} ms` },
    { label: "p99", value: `${summary.p99_ms} ms` },
  ];
  return (
    <section aria-label="Report summary" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Summary</h3>
      <div className="grid grid-cols-3 md:grid-cols-7 gap-3 text-sm">
        {cards.map((c) => (
          <div key={c.label} className="border border-slate-200 rounded-md p-3 bg-white">
            <div className="text-slate-500 text-xs">{c.label}</div>
            <div className="text-lg font-semibold">{c.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Replace `it.todo` with real test**

Overwrite `ui/src/components/report/__tests__/Summary.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Summary } from "../Summary";

describe("Summary", () => {
  it("renders all summary cards with formatted numbers", () => {
    render(
      <Summary
        summary={{
          count: 12345,
          errors: 7,
          rps: 123.4,
          duration_seconds: 30,
          p50_ms: 10,
          p95_ms: 50,
          p99_ms: 90,
        }}
      />,
    );
    const region = screen.getByRole("region", { name: /Report summary/i });
    expect(region).toHaveTextContent("12,345");
    expect(region).toHaveTextContent("7");
    expect(region).toHaveTextContent("123.4");
    expect(region).toHaveTextContent("30s");
    expect(region).toHaveTextContent("10 ms");
    expect(region).toHaveTextContent("50 ms");
    expect(region).toHaveTextContent("90 ms");
  });
});
```

- [ ] **Step 4: Run + build + commit**

```bash
cd ui && pnpm test -- --run Summary
pnpm build

git add ui/src/components/report/Summary.tsx ui/src/components/report/__tests__/Summary.test.tsx
git commit -m "feat(ui): add report Summary cards"
```

---

## Task 9: UI — `TimeSeriesChart` + 3 instances (RPS, p95, errors)

**Files:**
- Create: `ui/src/components/report/TimeSeriesChart.tsx`
- Create: `ui/src/components/report/__tests__/TimeSeriesChart.test.tsx`

`TimeSeriesChart` is a thin wrapper around Recharts `LineChart`. The wrapper exposes explicit `width`/`height` so jsdom tests can render without `ResponsiveContainer` (see Lessons §3). In production, ReportView passes a measured size.

- [ ] **Step 1: Pending test stub**

Create `ui/src/components/report/__tests__/TimeSeriesChart.test.tsx`:

```tsx
import { describe, it } from "vitest";
describe("TimeSeriesChart", () => {
  it.todo("renders an SVG line chart for the given data");
});
```

- [ ] **Step 2: Create the chart component**

Create `ui/src/components/report/TimeSeriesChart.tsx`:

```tsx
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

type Point = { ts_second: number; value: number };

type Props = {
  title: string;
  data: Point[];
  yLabel: string;
  width?: number;
  height?: number;
};

export function TimeSeriesChart({ title, data, yLabel, width = 720, height = 220 }: Props) {
  // ts_second is unix epoch. Subtract the first one so the X axis reads as elapsed seconds.
  const t0 = data.length > 0 ? data[0].ts_second : 0;
  const series = data.map((p) => ({ x: p.ts_second - t0, y: p.value }));
  return (
    <section aria-label={`Time series — ${title}`} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
      <LineChart width={width} height={height} data={series}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
        <YAxis label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
        <Tooltip />
        <Line type="monotone" dataKey="y" stroke="#2563eb" dot={false} isAnimationActive={false} />
      </LineChart>
    </section>
  );
}
```

> **Why `isAnimationActive={false}`:** Recharts default animation re-runs on every prop change; for a static post-run report it adds visual noise.

- [ ] **Step 3: Replace `it.todo` with a real (defensive) test**

Overwrite `ui/src/components/report/__tests__/TimeSeriesChart.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TimeSeriesChart } from "../TimeSeriesChart";

describe("TimeSeriesChart", () => {
  it("renders an SVG with the title heading", () => {
    render(
      <TimeSeriesChart
        title="RPS"
        yLabel="req/s"
        data={[
          { ts_second: 100, value: 0 },
          { ts_second: 101, value: 50 },
          { ts_second: 102, value: 75 },
        ]}
        width={400}
        height={200}
      />,
    );
    const region = screen.getByRole("region", { name: /Time series — RPS/ });
    // Recharts emits an <svg> element inside the chart container.
    expect(region.querySelector("svg")).not.toBeNull();
  });

  it("survives empty data without throwing", () => {
    render(
      <TimeSeriesChart title="Errors" yLabel="errors" data={[]} width={400} height={200} />,
    );
    expect(screen.getByRole("region", { name: /Time series — Errors/ })).toBeInTheDocument();
  });
});
```

> If Recharts in jsdom fails to render any `<svg>`, the test catches it immediately — the component is broken in that case. Recharts 2.x with explicit width/height does render SVG in jsdom; we verified this when locking the library choice.

- [ ] **Step 4: Run + build + commit**

```bash
cd ui && pnpm test -- --run TimeSeriesChart
pnpm build

git add ui/src/components/report/TimeSeriesChart.tsx ui/src/components/report/__tests__/TimeSeriesChart.test.tsx
git commit -m "feat(ui): add TimeSeriesChart wrapper around Recharts LineChart"
```

---

## Task 10: UI — `StepStatsTable` component

**Files:**
- Create: `ui/src/components/report/StepStatsTable.tsx`
- Create: `ui/src/components/report/__tests__/StepStatsTable.test.tsx`

- [ ] **Step 1: Pending test stub**

```tsx
import { describe, it } from "vitest";
describe("StepStatsTable", () => {
  it.todo("renders per-step counts, errors, and percentiles");
});
```

- [ ] **Step 2: Create the component**

Create `ui/src/components/report/StepStatsTable.tsx`:

```tsx
import type { ReportStep } from "../../api/schemas";

type StepMeta = { id: string; name: string; method: string; url: string };

type Props = { steps: ReportStep[]; meta: Map<string, StepMeta> };

export function StepStatsTable({ steps, meta }: Props) {
  return (
    <section aria-label="Per-step stats" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Steps</h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">Step</th>
            <th className="py-2 pr-4 font-medium">Method</th>
            <th className="py-2 pr-4 font-medium">URL</th>
            <th className="py-2 pr-4 font-medium">Requests</th>
            <th className="py-2 pr-4 font-medium">Errors</th>
            <th className="py-2 pr-4 font-medium">p50 ms</th>
            <th className="py-2 pr-4 font-medium">p95 ms</th>
            <th className="py-2 pr-4 font-medium">p99 ms</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const m = meta.get(s.step_id);
            return (
              <tr key={s.step_id} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-medium">{m?.name ?? s.step_id}</td>
                <td className="py-2 pr-4 font-mono text-xs">{m?.method ?? ""}</td>
                <td className="py-2 pr-4 font-mono text-xs break-all">{m?.url ?? ""}</td>
                <td className="py-2 pr-4">{s.count}</td>
                <td className="py-2 pr-4">{s.error_count}</td>
                <td className="py-2 pr-4">{s.p50_ms}</td>
                <td className="py-2 pr-4">{s.p95_ms}</td>
                <td className="py-2 pr-4">{s.p99_ms}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 3: Replace stub with real test**

Overwrite `ui/src/components/report/__tests__/StepStatsTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StepStatsTable } from "../StepStatsTable";

describe("StepStatsTable", () => {
  it("renders rows for each step with metadata when available", () => {
    const meta = new Map([
      ["stepA", { id: "stepA", name: "login", method: "POST", url: "http://x/login" }],
    ]);
    render(
      <StepStatsTable
        steps={[
          {
            step_id: "stepA",
            count: 100,
            error_count: 2,
            status_counts: { "200": 98, "500": 2 },
            p50_ms: 10,
            p95_ms: 50,
            p99_ms: 90,
          },
          {
            step_id: "stepB",
            count: 50,
            error_count: 0,
            status_counts: { "200": 50 },
            p50_ms: 5,
            p95_ms: 20,
            p99_ms: 40,
          },
        ]}
        meta={meta}
      />,
    );
    const region = screen.getByRole("region", { name: /Per-step stats/ });
    expect(region).toHaveTextContent("login");
    expect(region).toHaveTextContent("POST");
    expect(region).toHaveTextContent("http://x/login");
    expect(region).toHaveTextContent("100");
    expect(region).toHaveTextContent("stepB"); // missing meta → falls back to id
  });
});
```

- [ ] **Step 4: Run + build + commit**

```bash
cd ui && pnpm test -- --run StepStatsTable
pnpm build

git add ui/src/components/report/StepStatsTable.tsx ui/src/components/report/__tests__/StepStatsTable.test.tsx
git commit -m "feat(ui): add StepStatsTable for per-step report breakdown"
```

---

## Task 11: UI — `StatusDistribution` bar chart

**Files:**
- Create: `ui/src/components/report/StatusDistribution.tsx`
- Create: `ui/src/components/report/__tests__/StatusDistribution.test.tsx`

- [ ] **Step 1: Pending stub**

```tsx
import { describe, it } from "vitest";
describe("StatusDistribution", () => {
  it.todo("renders a bar chart of HTTP status counts");
});
```

- [ ] **Step 2: Component**

Create `ui/src/components/report/StatusDistribution.tsx`:

```tsx
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

type Props = {
  distribution: Record<string, number>;
  width?: number;
  height?: number;
};

export function StatusDistribution({ distribution, width = 480, height = 240 }: Props) {
  const data = Object.entries(distribution)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const isEmpty = data.length === 0;
  return (
    <section aria-label="Status distribution" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Status codes</h3>
      {isEmpty ? (
        <p className="text-slate-500 text-sm italic">No status data.</p>
      ) : (
        <BarChart width={width} height={height} data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="code" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="count" fill="#16a34a" isAnimationActive={false} />
        </BarChart>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Real test**

Overwrite `ui/src/components/report/__tests__/StatusDistribution.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusDistribution } from "../StatusDistribution";

describe("StatusDistribution", () => {
  it("renders an SVG bar chart when distribution is non-empty", () => {
    render(<StatusDistribution distribution={{ "200": 950, "500": 50 }} />);
    const region = screen.getByRole("region", { name: /Status distribution/ });
    expect(region.querySelector("svg")).not.toBeNull();
    expect(region).toHaveTextContent("Status codes");
  });

  it("shows empty-state text when no status data", () => {
    render(<StatusDistribution distribution={{}} />);
    expect(screen.getByText(/No status data/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run + build + commit**

```bash
cd ui && pnpm test -- --run StatusDistribution
pnpm build

git add ui/src/components/report/StatusDistribution.tsx ui/src/components/report/__tests__/StatusDistribution.test.tsx
git commit -m "feat(ui): add StatusDistribution bar chart"
```

---

## Task 12: UI — `ScenarioSnapshot` (read-only YAML view) + `DownloadJsonButton`

**Files:**
- Create: `ui/src/components/report/ScenarioSnapshot.tsx`
- Create: `ui/src/components/report/DownloadJsonButton.tsx`
- Create: `ui/src/components/report/__tests__/ScenarioSnapshot.test.tsx`
- Create: `ui/src/components/report/__tests__/DownloadJsonButton.test.tsx`

The snapshot uses a plain `<pre>` block — Monaco is overkill for read-only display and pulls in worker setup. The download button creates a blob URL and revokes it on unmount (see Lesson §12).

- [ ] **Step 1: Pending stubs**

```tsx
// ui/src/components/report/__tests__/ScenarioSnapshot.test.tsx
import { describe, it } from "vitest";
describe("ScenarioSnapshot", () => {
  it.todo("renders the yaml in a pre block, collapsed by default");
});
```

```tsx
// ui/src/components/report/__tests__/DownloadJsonButton.test.tsx
import { describe, it } from "vitest";
describe("DownloadJsonButton", () => {
  it.todo("creates a blob URL and downloads on click");
});
```

- [ ] **Step 2: ScenarioSnapshot**

Create `ui/src/components/report/ScenarioSnapshot.tsx`:

```tsx
import { useState } from "react";

type Props = { yaml: string };

export function ScenarioSnapshot({ yaml }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Scenario snapshot" className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-semibold text-slate-700 hover:underline"
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Scenario YAML (run-time snapshot)
      </button>
      {open && (
        <pre className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded text-xs font-mono whitespace-pre overflow-x-auto">
          {yaml}
        </pre>
      )}
    </section>
  );
}
```

- [ ] **Step 3: DownloadJsonButton**

Create `ui/src/components/report/DownloadJsonButton.tsx`:

```tsx
import { useEffect, useMemo } from "react";

type Props = { filename: string; data: unknown };

export function DownloadJsonButton({ filename, data }: Props) {
  const url = useMemo(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    return URL.createObjectURL(blob);
  }, [data]);

  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return (
    <a
      href={url}
      download={filename}
      className="inline-block px-3 py-1.5 text-sm bg-slate-700 text-white rounded hover:bg-slate-800"
    >
      Download JSON
    </a>
  );
}
```

- [ ] **Step 4: Real tests**

```tsx
// ScenarioSnapshot.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { ScenarioSnapshot } from "../ScenarioSnapshot";

describe("ScenarioSnapshot", () => {
  it("is collapsed by default and expands on click", async () => {
    const yaml = "version: 1\nname: test\n";
    render(<ScenarioSnapshot yaml={yaml} />);
    expect(screen.queryByText(yaml)).toBeNull();
    const btn = screen.getByRole("button", { name: /Scenario YAML/ });
    await userEvent.setup().click(btn);
    expect(screen.getByText(/version: 1/)).toBeInTheDocument();
  });
});
```

```tsx
// DownloadJsonButton.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DownloadJsonButton } from "../DownloadJsonButton";

describe("DownloadJsonButton", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("creates a blob URL and uses it as the anchor href", () => {
    render(<DownloadJsonButton filename="report.json" data={{ hello: "world" }} />);
    const a = screen.getByRole("link", { name: /Download JSON/ }) as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("blob:mock");
    expect(a.getAttribute("download")).toBe("report.json");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("revokes the blob URL on unmount", () => {
    const { unmount } = render(
      <DownloadJsonButton filename="report.json" data={{ hello: "world" }} />,
    );
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });
});
```

- [ ] **Step 5: Run + build + commit**

```bash
cd ui && pnpm test -- --run ScenarioSnapshot DownloadJsonButton
pnpm build

git add ui/src/components/report/ScenarioSnapshot.tsx ui/src/components/report/DownloadJsonButton.tsx ui/src/components/report/__tests__/ScenarioSnapshot.test.tsx ui/src/components/report/__tests__/DownloadJsonButton.test.tsx
git commit -m "feat(ui): add ScenarioSnapshot and DownloadJsonButton"
```

---

## Task 13: UI — `ReportView` composite

**Files:**
- Create: `ui/src/components/report/ReportView.tsx`
- Create: `ui/src/components/report/__tests__/ReportView.test.tsx`

`ReportView` composes Summary + 3 TimeSeriesCharts (RPS, p95, errors) + StatusDistribution + StepStatsTable + ScenarioSnapshot + DownloadJsonButton. It is the only place in the codebase that knows how to derive per-second arrays from `report.windows` (a flat array grouped by `(ts_second, step_id)`).

- [ ] **Step 1: Pending stub**

```tsx
import { describe, it } from "vitest";
describe("ReportView", () => {
  it.todo("composes summary, charts, status, steps, snapshot, and download");
});
```

- [ ] **Step 2: Derive helpers + component**

Create `ui/src/components/report/ReportView.tsx`:

```tsx
import { useMemo } from "react";
import type { Report } from "../../api/schemas";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import { resolveForDisplay } from "../../scenario/template";
import { Summary } from "./Summary";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { StatusDistribution } from "./StatusDistribution";
import { StepStatsTable } from "./StepStatsTable";
import { ScenarioSnapshot } from "./ScenarioSnapshot";
import { DownloadJsonButton } from "./DownloadJsonButton";

type Props = { report: Report };

type Sec = { ts_second: number; count: number; errors: number; p95_ms: number };

function bySecond(report: Report): Sec[] {
  const buckets = new Map<number, Sec>();
  for (const w of report.windows) {
    const cur = buckets.get(w.ts_second) ?? {
      ts_second: w.ts_second,
      count: 0,
      errors: 0,
      p95_ms: 0,
    };
    cur.count += w.count;
    cur.errors += w.error_count;
    // For p95 time series, use the max across steps in the same second as a coarse signal.
    // Per-second per-step p95 charts are deferred (ADR-0017 OUT: percentile histogram view).
    if (w.p95_ms > cur.p95_ms) cur.p95_ms = w.p95_ms;
    buckets.set(w.ts_second, cur);
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts_second - b.ts_second);
}

export function ReportView({ report }: Props) {
  const seconds = useMemo(() => bySecond(report), [report]);
  const envMap = useMemo<Record<string, string>>(() => {
    const env = report.run.env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    return {};
  }, [report.run.env]);

  const stepMeta = useMemo(() => {
    const m = new Map<string, { id: string; name: string; method: string; url: string }>();
    const parsed = parseScenarioDoc(report.scenario_yaml);
    if ("model" in parsed) {
      for (const s of parsed.model.steps) {
        m.set(s.id, {
          id: s.id,
          name: s.name,
          method: s.request.method,
          url: resolveForDisplay(s.request.url, envMap),
        });
      }
    }
    return m;
  }, [report.scenario_yaml, envMap]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold">Report</h3>
        <DownloadJsonButton filename={`run-${report.run.id}.json`} data={report} />
      </div>
      <Summary summary={report.summary} />
      <TimeSeriesChart
        title="Requests / second"
        yLabel="req/s"
        data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.count }))}
      />
      <TimeSeriesChart
        title="p95 response time"
        yLabel="ms"
        data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.p95_ms }))}
      />
      <TimeSeriesChart
        title="Errors / second"
        yLabel="errors"
        data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.errors }))}
      />
      <StatusDistribution distribution={report.status_distribution} />
      <StepStatsTable steps={report.steps} meta={stepMeta} />
      <ScenarioSnapshot yaml={report.scenario_yaml} />
    </div>
  );
}
```

- [ ] **Step 3: Real test**

Overwrite `ui/src/components/report/__tests__/ReportView.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReportView } from "../ReportView";
import type { Report } from "../../../api/schemas";

const FIXTURE: Report = {
  run: {
    id: "R1",
    scenario_id: "S1",
    status: "completed",
    profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
    env: { BASE_URL: "http://x" },
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: [
    "version: 1",
    "name: x",
    "cookie_jar: auto",
    "variables: {}",
    "steps:",
    "  - id: stepA",
    "    name: login",
    "    type: http",
    "    request:",
    "      method: POST",
    "      url: ${BASE_URL}/login",
    "    assert: []",
    "    extract: []",
    "",
  ].join("\n"),
  summary: {
    count: 15,
    errors: 1,
    rps: 7.5,
    duration_seconds: 2,
    p50_ms: 10,
    p95_ms: 50,
    p99_ms: 90,
  },
  windows: [
    {
      ts_second: 100,
      step_id: "stepA",
      count: 10,
      error_count: 1,
      status_counts: { "200": 9, "500": 1 },
      p50_ms: 10,
      p95_ms: 40,
      p99_ms: 70,
    },
    {
      ts_second: 101,
      step_id: "stepA",
      count: 5,
      error_count: 0,
      status_counts: { "200": 5 },
      p50_ms: 8,
      p95_ms: 50,
      p99_ms: 90,
    },
  ],
  steps: [
    {
      step_id: "stepA",
      count: 15,
      error_count: 1,
      status_counts: { "200": 14, "500": 1 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    },
  ],
  status_distribution: { "200": 14, "500": 1 },
};

describe("ReportView", () => {
  it("renders summary, charts, status distribution, step table, and download", () => {
    render(<ReportView report={FIXTURE} />);
    expect(screen.getByRole("region", { name: /Report summary/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Time series — Requests/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Time series — p95/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Time series — Errors/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Status distribution/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Per-step stats/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download JSON/ })).toBeInTheDocument();
  });

  it("resolves env in step URLs (resolveForDisplay)", () => {
    render(<ReportView report={FIXTURE} />);
    const stepRegion = screen.getByRole("region", { name: /Per-step stats/ });
    expect(stepRegion).toHaveTextContent("http://x/login");
  });
});
```

- [ ] **Step 4: Run + build + commit**

```bash
cd ui && pnpm test -- --run ReportView
pnpm build

git add ui/src/components/report/ReportView.tsx ui/src/components/report/__tests__/ReportView.test.tsx
git commit -m "feat(ui): add ReportView composite (summary + charts + steps + snapshot + download)"
```

---

## Task 14: UI — wire `ReportView` into `RunDetailPage` on terminal state

**Files:**
- Modify: `ui/src/pages/RunDetailPage.tsx`
- Modify: `ui/src/pages/__tests__/RunDetailPage.test.tsx`

- [ ] **Step 1: Update page to swap live progress for report on terminal**

Edit `ui/src/pages/RunDetailPage.tsx`. Above the current return:

```tsx
import { ReportView } from "../components/report/ReportView";
import { useRunReport } from "../api/hooks";
```

Inside the component (after `const terminal = ...`):

```tsx
const report = useRunReport(id, terminal);
```

In the JSX, replace the current `Steps / Env / Profile / Metric windows` blocks with a conditional:

```tsx
{terminal && report.data ? (
  <ReportView report={report.data} />
) : (
  <>
    {/* existing live progress sections — keep verbatim:
       <EnvBlock />, Profile, Steps (if stepOrder.length > 0), Metric windows
    */}
  </>
)}
```

> **Engineer note:** keep the top "Run header + Abort button + cards row" intact above this branch (the header is the same in both states). Only the body changes.

- [ ] **Step 2: Add the failing terminal-transition test**

In `ui/src/pages/__tests__/RunDetailPage.test.tsx`, add a new `describe`:

```tsx
describe("RunDetailPage — report on terminal", () => {
  it("mounts ReportView when status is completed and report loaded; hides Metric windows", async () => {
    const reportBundle = {
      run: {
        id: "R9",
        scenario_id: "S9",
        status: "completed",
        profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
        env: {},
        started_at: 100,
        ended_at: 102,
        created_at: 99,
      },
      scenario_yaml: "version: 1\nname: x\nsteps: []\n",
      summary: {
        count: 10,
        errors: 0,
        rps: 5.0,
        duration_seconds: 2,
        p50_ms: 10,
        p95_ms: 20,
        p99_ms: 30,
      },
      windows: [],
      steps: [],
      status_distribution: { "200": 10 },
    };
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/R9")) {
        return Promise.resolve(
          jsonResponse({
            id: "R9",
            scenario_id: "S9",
            status: "completed",
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
            env: {},
            started_at: 100,
            ended_at: 102,
            created_at: 99,
          }),
        );
      }
      if (url.endsWith("/api/runs/R9/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R9", windows: [] }));
      }
      if (url.endsWith("/api/runs/R9/report")) {
        return Promise.resolve(jsonResponse(reportBundle));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R9");
    await screen.findByRole("region", { name: /Report summary/ });
    // The live "Metric windows" header should not be present in report mode.
    expect(screen.queryByText(/Metric windows/)).toBeNull();
  });

  it("does NOT fetch /report while status is running", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/R10")) {
        return Promise.resolve(
          jsonResponse({
            id: "R10",
            scenario_id: "S9",
            status: "running",
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 30 },
            env: {},
            started_at: 100,
            ended_at: null,
            created_at: 99,
          }),
        );
      }
      if (url.endsWith("/api/runs/R10/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R10", windows: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R10");
    await screen.findByText(/Metric windows|Waiting for first batch/i);
    const reportCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].endsWith("/api/runs/R10/report"),
    );
    expect(reportCalls.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run, build, commit**

```bash
cd ui && pnpm test -- --run RunDetailPage
pnpm build

git add ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx
git commit -m "feat(ui): mount ReportView on terminal state in RunDetailPage"
```

---

## Task 15: Controller e2e — `report_e2e_smoke`

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs`

This is the e2e the spec §4.4 calls out (in-process worker subprocess pattern; kind-level e2e is Slice 6).

- [ ] **Step 1: Write the failing test**

Add to `crates/controller/tests/e2e_test.rs` at the bottom (use the same `worker_bin_path()` helper from earlier tests):

```rust
#[tokio::test]
async fn report_e2e_smoke() {
    // 1. spawn wiremock + register a single 200 stub for /ping
    // 2. spawn controller in-process (REST + gRPC) — reuse the helper used by full_slice_1_e2e
    // 3. spawn worker subprocess (worker_bin_path)
    // 4. POST /api/scenarios with a 1-step scenario that hits {{base_url}}/ping
    // 5. POST /api/runs with vus=2, duration=3, env={BASE_URL: wiremock.url}
    // 6. Poll GET /api/runs/{id} until status == "completed" (timeout 15s)
    // 7. GET /api/runs/{id}/report
    // 8. Assert:
    //    - response is HTTP 200
    //    - JSON has top-level keys: run, scenario_yaml, summary, windows, steps, status_distribution
    //    - summary.count >= 2 (at least one request per VU)
    //    - scenario_yaml matches the scenario that was created
    //    - steps.len() == 1, steps[0].step_id matches the one in the YAML
    //    - At least one window has p95_ms > 0 (HDR decode worked end-to-end)
    //    - status_distribution["200"] == summary.count
}
```

> **Engineer:** copy the boilerplate (wiremock spawn, controller boot, worker subprocess, scenario create, run create, poll) from `full_slice_1_e2e` and `two_step_with_env_e2e` in the same file. The report-specific assertions begin at step 7.

- [ ] **Step 2: Implement the test body, run, debug until green**

```bash
cargo test -p handicap-controller --test e2e_test report_e2e_smoke -- --nocapture
```

Expected: green. If `summary.count == 0`, suspect: ramp_up_seconds default not set, env BASE_URL not passed, wiremock URL not bound correctly. Refer to manual-check-fixes M1 / M4.

- [ ] **Step 3: Verify the full e2e suite still passes**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 4: Commit**

```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(controller): add report_e2e_smoke (end-to-end report bundle verification)"
```

---

## Task 16: Manual check runbook + CLAUDE.md update

**Files:**
- Create: `docs/dev/ui-slice-5-manual-check.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the runbook**

Create `docs/dev/ui-slice-5-manual-check.md`:

```markdown
# Slice 5 — UI 수동 점검 (Report 화면)

Slice 4의 점검 환경(`docs/dev/ui-slice-4-manual-check.md`)을 그대로 사용. wiremock + cargo dev + vite dev.

## 사전

Slice 4 매뉴얼의 **사전 — wiremock stub 등록** 절차로 `/login` + `/me` (또는 `/profile`) stub을 띄운다.

## §1 — 토큰 시나리오로 리포트 생성

1. `/scenarios/new` 에서 토큰 인증 시나리오를 만든다 (Slice 4 §1 그대로).
2. `Run` 다이얼로그: `vus=2`, `duration=10`, `ramp_up=2`, `env: BASE_URL=http://localhost:9090`.
3. 실행 페이지에서 라이브 진행률이 갱신되는 것 확인 (Steps · Env · Profile · Metric windows).
4. 10초 + α 뒤 status 가 `completed` 로 바뀌면 **페이지가 자동으로 Report 뷰로 전환** 되는지 확인.
5. Report 뷰 각 섹션 확인:
   - Summary: 7장 카드 (count · errors · rps · duration · p50 · p95 · p99). 모든 숫자가 0이 아님.
   - Time series 3개: Requests/sec, p95 응답시간, Errors/sec. SVG가 그려졌고 점이 시간순으로 정렬.
   - Status codes 바 차트: `200` 막대가 보임. 5xx 가 있으면 빨강(현재 단일색이지만 향후 확장).
   - Per-step stats 테이블: 각 스텝의 이름·method·resolved URL·요청수·에러수·p50/p95/p99.
   - Scenario YAML (run-time snapshot): 토글 버튼으로 펼침. 실행 시점의 YAML이 그대로 보임.
   - **Download JSON** 버튼: 클릭 시 `run-{id}.json` 파일이 다운로드 됨. 열어서 `summary.count`, `windows[]`, `steps[]` 가 들어있는지 확인.

## §2 — 세션(쿠키) 시나리오로 리포트 생성

Slice 4 §2의 세션 시나리오를 같은 흐름으로 실행. Report 뷰가 동일하게 그려져야 한다. `cookie_jar: auto` 가 scenario_yaml snapshot에 그대로 포함되는지 확인 (snapshot은 실행 시점이라 이후 시나리오 편집이 영향을 주면 안 됨).

## §3 — Failed / Aborted 런의 리포트

1. wiremock stub을 의도적으로 깨거나(`DELETE /__admin/mappings`) 잘못된 URL로 시나리오 실행 → status `failed` 또는 모든 요청 5xx.
2. Report 뷰가 여전히 정상 렌더되고 `summary.errors > 0`, status_distribution에 5xx가 보이는지 확인.
3. 긴 시나리오를 시작 후 즉시 Abort → status `aborted` → Report 뷰가 partial 데이터로 렌더되는지 확인 (count > 0 if any requests fired).

## §4 — 게이트

- `pnpm lint && pnpm test && pnpm build` 통과
- `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` 통과
- CLAUDE.md 의 "Slice 5 결과:" 단락 추가됨

## 알려진 한계

- p95 시계열은 한 초의 step 간 max를 보여줌. 정확한 per-step 시계열은 ADR-0017 OUT의 "백분위 히스토그램" 항목과 함께 후속.
- Report 페이지 URL은 `/runs/:id` 그대로 (별도 `/runs/:id/report` 분리는 의도적 — 같은 URL이 progress↔report 전환).
- Recharts 차트의 dark mode 대응은 후속.
```

- [ ] **Step 2: Update CLAUDE.md**

Read `CLAUDE.md` to locate the existing "Slice 4 결과:" paragraph and the "Slice 4에서 배운 함정들" section. Add directly **after the Slice 4 manual-check paragraph**:

```markdown
Slice 5 결과: 종료된 run의 same-page Report 전환. Controller `GET /api/runs/{id}/report` 가 run + scenario_yaml snapshot + per-second windows(percentile 포함) + per-step + status 분포를 한 번에 번들. 엔진 `percentiles.rs` 가 V2 HDR Histogram BLOB을 deserialize + merge. UI Recharts (line/bar) + Summary + StepStatsTable + ScenarioSnapshot + JSON download. e2e `report_e2e_smoke` 가 워커 subprocess → 컨트롤러 → report 까지 검증. K8s 배포(Slice 6)는 아직.
```

Then add a new "Slice 5에서 배운 함정들" section at the end of the existing gotchas section:

```markdown
## Slice 5에서 배운 함정들

- **Recharts ResponsiveContainer + jsdom**: ResponsiveContainer는 부모의 measured 사이즈를 읽어 자식 차트에 넘기는데 jsdom은 layout이 없어서 size=0 → SVG가 안 그려져 RTL assertion 실패. 컴포넌트에 explicit `width`/`height` prop을 받게 만들고 ResponsiveContainer는 (필요 시) 프로덕션 path에서만 사용. 테스트는 explicit size로.
- **HDR Histogram V2 BLOB 의 partial-write 내성**: worker가 flush 중 죽으면 `hdr_histogram` 컬럼에 truncated bytes가 남을 수 있다. `decode_hdr` 는 `Result`로 실패를 표현하고 controller `build_report` 는 그 한 윈도만 p50/p95/p99=0 으로 두고 나머지 윈도를 정상 처리. crash-late-fail-soft 패턴. 단위 테스트 `build_report_tolerates_bad_hdr_blob` 가 contract.
- **`/report` 는 polling 금지**: terminal 후 한 번만 fetch, `staleTime: Infinity`, `refetchInterval: false`. live polling은 기존 `/metrics` 가 담당. 두 endpoint를 분리한 이유는 hot path의 HDR deserialize 비용을 피하기 위함.
- **Scenario snapshot vs current scenario**: M2의 follow-up에서 noted — Run 상세가 `runs.scenario_yaml` snapshot 컬럼을 봐야지 `GET /api/scenarios/{id}` 의 현재 YAML을 보면 시나리오 편집 후 과거 run의 step 라벨이 어긋난다. Slice 5는 `/report.scenario_yaml`을 snapshot으로 노출하는 쪽으로 결정.
- **bySecond 시계열 derivation은 ReportView 안에서**: 시계열 max-over-steps 합산 같은 derivation 로직을 backend가 아니라 ReportView 안에 두기로. backend는 raw windows 만 보낸다. 이유: UI가 step 필터/색상 분리 같은 변형을 더하기 쉬움.
- **`hdrhistogram` add 의 bound 일치**: `Histogram::add(other)` 는 두 히스토그램의 lo/hi/sigfig 가 같을 때 lossless. 다른 컨피그면 일부 샘플이 누락된다. `fresh_hist()` 헬퍼로 모든 누적용 히스토그램이 같은 bound 를 갖게 통일.
- **blob URL 누수**: `URL.createObjectURL` 결과는 명시적 `revokeObjectURL` 호출 전까지 페이지 lifetime 내내 남는다. `useEffect cleanup`으로 `revokeObjectURL` 호출. DownloadJsonButton unmount 테스트로 contract 검증.
```

- [ ] **Step 3: Final verification + commit**

```bash
# Full gate
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd ui && pnpm lint && pnpm test && pnpm build && cd ..

git add docs/dev/ui-slice-5-manual-check.md CLAUDE.md
git commit -m "docs(slice-5): manual-check runbook + CLAUDE.md status + gotchas"
```

- [ ] **Step 4: Run the manual check**

Open the manual check runbook and walk every section. Fix any issue found before merging. Particular attention to §1 step 4 — the page must transition automatically when status flips to completed (the test in Task 14 covers this; manual check confirms visually).

---

## Self-review checklist (run before declaring done)

The plan author MUST run through this list before handing off to executor.

**Spec §3.3 (MVP report IN) coverage:**
- [x] Summary cards (count · errors · rps · p50/95/99 · duration) — Task 8
- [x] Time series RPS — Task 9
- [x] Time series p95 — Task 9
- [x] Time series errors — Task 9
- [x] Per-step table — Task 10
- [x] Status code bar chart — Task 11
- [x] Scenario YAML snapshot — Task 12
- [x] Run config (VU·ramp-up·duration·env) — already on RunDetailPage header; ReportView's run + summary covers it
- [x] JSON full download — Task 12

**Spec §4.1 user-flow coverage:**
- [x] Same page transitions to report — Task 14
- [x] Report shows for completed AND failed AND aborted — Task 16 §3

**Spec §4.3 perf:**
- [x] 1만 row metric → report renders in 2s. HDR decode is ~10–100 µs per blob; 10k blobs ≈ 100–1000 ms — within budget. Network transfer of the bundle is the larger factor; bundle size for 10k windows is ~2 MB JSON. If this is too large in practice, paginate windows in Slice 5.1 (out of scope here).

**Spec §4.4 tests:**
- [x] Controller unit (report.rs inline) — Task 4
- [x] Controller integration (report_test.rs) — Task 5
- [x] Controller e2e (report_e2e_smoke) — Task 15
- [x] UI unit (schemas.test.ts) — Task 6
- [x] UI components (7 files) — Tasks 8–13
- [x] UI page (RunDetailPage terminal transition) — Task 14

**Lessons §1–12 mapping:**
- §1 (no UI gap): every backend field exposed in summary/windows/steps is rendered in Tasks 8–13 ✓
- §2 (pnpm build): every UI task has `pnpm build` in commit step ✓
- §3 (Recharts in jsdom): explicit width/height, no ResponsiveContainer in tests ✓
- §4 (no polling thrash): `staleTime: Infinity, refetchInterval: false` Task 7 ✓
- §5 (HDR decode tolerance): build_report_tolerates_bad_hdr_blob test Task 4 ✓
- §7 (clippy gate): cargo clippy --workspace --all-targets -- -D warnings in Tasks 2, 4, 5, 15 ✓
- §10 (TDD-guard pending file): every new src file has a pending test file step ✓
- §12 (blob URL revoke): DownloadJsonButton unmount test Task 12 ✓

**Placeholder scan:** no "TBD", no "implement later" — every step has either code or an exact engineer-note delegating a small mechanical lookup ✓

**Type / name consistency:**
- `ReportJson` (Rust) ↔ `Report` (TS via Zod) — names differ, but Rust struct is serialized by serde to a shape that `ReportSchema.parse` accepts. Cross-checked field-by-field in Tasks 4 + 6.
- `step_id` is `string` everywhere ✓
- `p50_ms / p95_ms / p99_ms` u64 in Rust → `number` in TS (Zod `int().nonnegative()`) ✓
- `Report.run` shape matches `ReportRun` Rust struct ✓
- `windows[].status_counts` is `BTreeMap<String, u64>` in Rust, `Record<string, number>` in TS via `StatusDistributionSchema` ✓

---

## Execution handoff

Plan saved at `docs/superpowers/plans/2026-05-28-slice-5-report-charts.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batched with checkpoints for review.

**Which approach?**
