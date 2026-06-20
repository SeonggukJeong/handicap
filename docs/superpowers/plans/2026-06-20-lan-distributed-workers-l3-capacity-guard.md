# LAN 분산 워커 L3 — 과부하 가드 (capacity-aware 풀 배정) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop 풀 run이 워커당 선언 `capacity_vus`를 존중해 VU를 배정하고, 풀 총 용량이 부족하면 silently 과부하 대신 soft-409로 사용자에게 "줄여 진행/강행"을 묻게 한다.

**Architecture:** 순수 `capacity_split`(균등 출발→초과분 재분배, R5 byte-identical by construction)을 `grpc/shard.rs`에 추가하고, 컨트롤러 풀 배정 경로(`reserve_idle_pool_capacity` + `register`의 precomputed-or-`shard_split` fallback)가 그걸 쓴다. 용량 부족은 `spawn_run` insert-전 사전검사가 409(`ApiError::ConflictJson`)로 거른다. UI는 RunDialog 프리뷰에 총 용량 + 초과 힌트, 409 확인 다이얼로그(clamp/강행/취소), bespoke `createRun` fetch로 409 본문을 surface한다. **proto·worker·엔진·migration 변경 0.**

**Tech Stack:** Rust (axum 0.8, tonic, sqlx), TypeScript/React (Vite, React Query v5, Zod, vitest/RTL).

**Spec:** `docs/superpowers/specs/2026-06-20-lan-distributed-workers-l3-capacity-guard-design.md` (R1–R12 — 정규 척추; 각 task가 충족 R을 인용).

## Global Constraints

이 절은 모든 task에 암묵 적용된다 — spec에서 verbatim.

- **MSRV 1.85 / edition 2024.** workspace `cargo fmt`·`clippy -D warnings`·`nextest`.
- **proto·`crates/worker`·`crates/worker-core`·`crates/engine`·migration·DB 스키마·리포트·CSV/XLSX/비교·`shard_split`/`worker_count`/`dataset_slice`·`check_token` 무변경** (R5/R11). `capacity_vus`는 이미 `Register.capacity_vus=3` → `PoolEntry.capacity_vus`에 배선·저장됨(읽어 쓰기만).
- **byte-identical (조건부, R5)**: 선택 워커 전원 `capacity_vus ≥ 자기 균등-share`(전원 기본 1000 & `vus ≤ N×1000`인 흔한 경우) → `capacity_split` 결과 == `shard_split` 균등. `?force=true` = 항상 균등(L1 복원). open-loop·VU곡선·비-풀·비-closed 풀 경로 전부 무변경.
- **closed-loop만 가드.** `capacity_vus`는 closed-loop VU 메트릭 — open-loop(rps/슬롯)·VU곡선(단일워커)은 무변경(`!is_open_loop() && !is_vu_curve()`).
- **`?force`는 ephemeral** — 쿼리 파라미터, `Profile`에 영속 안 함.
- **신규 UI 문구 전부 `ko.*` 경유** (ADR-0035 — 인라인 한국어/영어 0, `aria-label`/`title` 포함). L2 `ko.colCapacity` "미적용" 한정어 갱신 포함.
- **워커 `--capacity-vus` 기본 1000.** `capacity_vus == 0`은 capacity 계산에서 `.max(1)`로 floor(`shard::worker_count` 컨벤션, R7).
- **커밋 게이트**: cargo-영향 커밋마다 전체 워크스페이스 게이트(수 분). ① 미사용 `pub(crate)` 헬퍼-only ② RED-테스트-only 단독 커밋 불가 → **각 task = 하나의 green 커밋**(테스트+구현 fold). UI task는 **test-path 파일 편집을 먼저**(tdd-guard ui-only: src 편집 전 pending test 필요). `git commit`은 `run_in_background:false` + 파이프 없이(exit code 가시성).

---

## Task 1: 순수 `capacity_split` + `achievable_capacity` (shard.rs)

**Files:**
- Modify: `crates/controller/src/grpc/shard.rs` (append two `pub fn` + `#[cfg(test)]` 테스트)

**Interfaces:**
- Consumes: 기존 `shard_split(total_vus: u32, n: u32, i: u32) -> (u32, u32)` (same file).
- Produces:
  - `pub fn capacity_split(total_vus: u32, caps: &[u32]) -> Vec<u32>` — 워커별 vu_count. `Σ caps[i].max(1) >= total_vus`이면 합 == total_vus, 각 `≤ caps[i].max(1)`, 부족이면 cap까지만 채워 합 < total_vus.
  - `pub fn achievable_capacity(caps: &[u32]) -> u32` — `Σ caps[i].max(1)` (saturating).

- [ ] **Step 1: Write the failing tests** (append to the existing `#[cfg(test)] mod tests` in `shard.rs`)

```rust
    #[test]
    fn achievable_capacity_sums_with_floor() {
        assert_eq!(achievable_capacity(&[5, 5]), 10);
        assert_eq!(achievable_capacity(&[0, 0, 0]), 3); // 0 floored to 1 each
        assert_eq!(achievable_capacity(&[]), 0);
    }

    #[test]
    fn capacity_split_equals_even_when_slack() {
        // No cap binds → must be byte-identical to shard_split's per-worker counts,
        // including the front-loaded remainder (first total%n shards get +1).
        for &(total, n) in &[(2u32, 2u32), (5, 2), (7, 3), (10, 4), (1, 1), (100, 7)] {
            let caps = vec![u32::MAX; n as usize]; // huge caps → never binds
            let even: Vec<u32> = (0..n).map(|i| shard_split(total, n, i).1).collect();
            assert_eq!(capacity_split(total, &caps), even, "total={total} n={n}");
        }
        // explicit remainder shapes
        assert_eq!(capacity_split(5, &[1000, 1000]), vec![3, 2]);
        assert_eq!(capacity_split(7, &[1000, 1000, 1000]), vec![3, 2, 2]);
    }

    #[test]
    fn capacity_split_respects_caps_and_sums() {
        // even 15/15 would overflow worker A (cap 5) → water-fill 5/25.
        let out = capacity_split(30, &[5, 1000]);
        assert_eq!(out, vec![5, 25]);
        assert_eq!(out.iter().sum::<u32>(), 30);
        // contiguous disjoint offsets via cumulative sum
        let mut off = 0u32;
        for (i, &c) in out.iter().enumerate() {
            assert!(c <= [5, 1000][i].max(1));
            off += c;
        }
        assert_eq!(off, 30);
    }

    #[test]
    fn capacity_split_floors_zero_to_one() {
        // cap 0 is treated as 1 (defensive, matches worker_count).
        let out = capacity_split(3, &[0, 0, 0]);
        assert_eq!(out, vec![1, 1, 1]);
    }

    #[test]
    fn capacity_split_short_pool_fills_to_cap() {
        // Σcap (10) < total (30): fill each to cap, sum < total (achievable signal).
        let out = capacity_split(30, &[5, 5]);
        assert_eq!(out, vec![5, 5]);
        assert_eq!(out.iter().sum::<u32>(), 10);
    }

    #[test]
    fn capacity_split_empty_is_empty() {
        assert!(capacity_split(10, &[]).is_empty());
    }
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cargo test -p handicap-controller --lib grpc::shard::tests::capacity 2>&1 | tail -20`
Expected: FAIL — `cannot find function capacity_split` / `achievable_capacity`.

- [ ] **Step 3: Implement both functions** (append to `shard.rs`, after `shard_split`)

```rust
/// Total achievable VUs across `caps`: `Σ caps[i].max(1)` (0 floored to 1,
/// matching `worker_count`'s `capacity.max(1)`). Saturating to avoid u32
/// overflow on pathological caps. Used by the pool capacity guard (spec R6/R7).
pub fn achievable_capacity(caps: &[u32]) -> u32 {
    caps.iter().fold(0u32, |acc, &c| acc.saturating_add(c.max(1)))
}

/// Distribute `total_vus` across `caps.len()` workers, never exceeding any
/// worker's capacity (`caps[i].max(1)`). Starts from the even `shard_split`
/// distribution, reclaims overflow from over-cap workers, and redistributes it
/// (in index order) to workers with remaining slack. When no cap binds the
/// result is byte-identical to `shard_split`'s per-worker counts (spec R5).
/// When `Σ caps.max(1) >= total_vus` the returned vector sums to `total_vus`;
/// otherwise it fills each worker to its cap and sums to less (the caller reads
/// that shortfall as "achievable < requested"). Deterministic. (spec R1.)
pub fn capacity_split(total_vus: u32, caps: &[u32]) -> Vec<u32> {
    let n = caps.len();
    if n == 0 {
        return Vec::new();
    }
    let cap = |i: usize| caps[i].max(1);
    // 1. Even start — identical to shard_split's per-worker counts (R5).
    let mut alloc: Vec<u32> = (0..n as u32)
        .map(|i| shard_split(total_vus, n as u32, i).1)
        .collect();
    // 2. Reclaim overflow from over-cap workers.
    let mut overflow: u32 = 0;
    for i in 0..n {
        if alloc[i] > cap(i) {
            overflow += alloc[i] - cap(i);
            alloc[i] = cap(i);
        }
    }
    // 3. Redistribute overflow into under-cap workers in index order. One pass
    //    suffices: when Σcap >= total, total slack >= overflow.
    for i in 0..n {
        if overflow == 0 {
            break;
        }
        let add = (cap(i) - alloc[i]).min(overflow);
        alloc[i] += add;
        overflow -= add;
    }
    alloc
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cargo test -p handicap-controller --lib grpc::shard::tests 2>&1 | tail -20`
Expected: PASS (all `capacity_split_*` + `achievable_capacity_*` + existing `shard_split`/`worker_count` tests).

- [ ] **Step 5: Commit**

```bash
git add crates/controller/src/grpc/shard.rs
git commit -m "feat(lan): capacity_split + achievable_capacity 순수 함수 (L3 R1/R5/R6/R7)"
```

---

## Task 2: capacity-aware 풀 예약 + register fallback (coordinator.rs)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs`
  - `RunWorkers` struct (~118): add `precomputed_counts` field
  - `register` (~441-442): precomputed-or-`shard_split`
  - `enqueue` (~389): new `precomputed` param
  - add `PoolReservation` enum + `reserve_idle_pool_capacity` + `pool_achievable_capacity`
  - inline `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `shard::{capacity_split, achievable_capacity, shard_split}` (Task 1); existing `PoolEntry{tx, capacity_vus, hostname, assigned_run}`, `WorkerTx`.
- Produces:
  - `pub enum PoolReservation { Reserved { workers: Vec<(String, WorkerTx)>, counts: Vec<(u32, u32)> }, Insufficient { achievable: u32 } }`
  - `pub async fn reserve_idle_pool_capacity(&self, run_id: &str, total_vus: u32) -> PoolReservation`
  - `pub async fn pool_achievable_capacity(&self) -> (usize, u32)` — `(idle_count, achievable)`
  - `enqueue(..., precomputed: Option<Vec<(u32, u32)>>)` — new 5th param

> **TDD note:** `coordinator.rs` already has `#[cfg(test)] mod tests` → editing src here passes tdd-guard. Existing pool tests call `enqueue(run_id, base_assignment(), n, vus)` (e.g. ~1957, ~1993) — they must gain a 5th `None` arg; the compiler flags every site (do NOT add a Default — `enqueue` is not prost). `reserve_idle_pool`/`assign_pool_workers`/`pool_register_idle`/`pool_disconnect` 로직 무변경.

- [ ] **Step 1: Write failing tests** (append to coordinator.rs `mod tests`; mirror the existing `pool_*` tests' setup — they build a `CoordinatorState`, `pool_register_idle(id, tx, capacity, host)`, etc.)

```rust
    #[tokio::test]
    async fn pool_achievable_capacity_sums_idle() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        for (id, cap) in [("w0", 5u32), ("w1", 1000u32)] {
            let (tx, _rx) = fake_tx();
            coord.pool_register_idle(id, tx, cap, "h".into()).await;
        }
        assert_eq!(coord.pool_achievable_capacity().await, (2, 1005));
    }

    #[tokio::test]
    async fn reserve_capacity_water_fills_within_caps() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        // worker_id sort: "w0"(cap 5) then "w1"(cap 1000)
        for (id, cap) in [("w0", 5u32), ("w1", 1000u32)] {
            let (tx, _rx) = fake_tx();
            coord.pool_register_idle(id, tx, cap, "h".into()).await;
        }
        match coord.reserve_idle_pool_capacity("run-x", 30).await {
            PoolReservation::Reserved { workers, counts } => {
                assert_eq!(workers.len(), 2);
                // even 15/15 would overflow w0(cap 5) → 5/25, offsets 0/5
                assert_eq!(counts, vec![(0, 5), (5, 25)]);
                assert_eq!(coord.pool_idle_count().await, 0); // both reserved
            }
            other => panic!("expected Reserved, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reserve_capacity_insufficient_when_total_capacity_short() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        for id in ["w0", "w1"] {
            let (tx, _rx) = fake_tx();
            coord.pool_register_idle(id, tx, 5, "h".into()).await;
        }
        match coord.reserve_idle_pool_capacity("run-x", 30).await {
            PoolReservation::Insufficient { achievable } => assert_eq!(achievable, 10),
            other => panic!("expected Insufficient, got {other:?}"),
        }
        assert_eq!(coord.pool_idle_count().await, 2); // nothing reserved
    }

    #[tokio::test]
    async fn reserve_capacity_empty_pool_returns_empty_reserved_not_insufficient() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        match coord.reserve_idle_pool_capacity("run-x", 30).await {
            PoolReservation::Reserved { workers, counts } => {
                assert!(workers.is_empty() && counts.is_empty());
            }
            other => panic!("expected empty Reserved (→ caller 400), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn register_uses_precomputed_counts_when_present() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        // enqueue with explicit per-shard counts; register must read them, not shard_split.
        coord
            .enqueue(
                "run-x".into(),
                base_assignment(),
                2,
                30,
                Some(vec![(0, 5), (5, 25)]),
            )
            .await;
        let (tx, _rx) = fake_tx();
        match coord.register("run-x", "w0", tx).await {
            RegisterOutcome::Assigned { vu_offset, vu_count, .. } => {
                assert_eq!((vu_offset, vu_count), (0, 5)); // precomputed, not 15
            }
            other => panic!("expected Assigned, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn register_falls_back_to_shard_split_when_no_precomputed() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        coord.enqueue("run-x".into(), base_assignment(), 2, 30, None).await;
        let (tx, _rx) = fake_tx();
        match coord.register("run-x", "w0", tx).await {
            RegisterOutcome::Assigned { vu_offset, vu_count, .. } => {
                assert_eq!((vu_offset, vu_count), (0, 15)); // even split (byte-identical L1)
            }
            other => panic!("expected Assigned, got {other:?}"),
        }
    }
```

> Helpers used above exist in coordinator.rs `mod tests`: `fake_tx() -> (WorkerTx, Receiver)` (:1479 — destructure `let (tx, _rx) = fake_tx();`), `base_assignment() -> PendingAssignment` (:1418), and the DB via `crate::store::connect("sqlite::memory:").await.unwrap()` (there is no `test_db()`). Mirror the existing `pool_n_is_min_idle_and_load` test's setup.

- [ ] **Step 2: Run tests, verify they fail (compile errors / missing items)**

Run: `cargo test -p handicap-controller --lib grpc::coordinator::tests::reserve 2>&1 | tail -25`
Expected: FAIL — `PoolReservation` not found, `reserve_idle_pool_capacity` not found, `enqueue` takes 4 args not 5.

- [ ] **Step 3a: Add `precomputed_counts` to `RunWorkers` + thread through `enqueue`**

In `RunWorkers` struct (~118), add field:
```rust
    /// Per-shard (vu_offset, vu_count) precomputed by the capacity-aware pool
    /// path. `None` → `register` falls back to even `shard_split` (legacy/open/
    /// curve/force, byte-identical L1). (spec R2/R5.)
    precomputed_counts: Option<Vec<(u32, u32)>>,
```
Change `enqueue` (~389) signature + literal:
```rust
    pub async fn enqueue(
        &self,
        run_id: String,
        base: PendingAssignment,
        expected: u32,
        total_vus: u32,
        precomputed: Option<Vec<(u32, u32)>>, // NEW
    ) -> CancellationToken {
        // ... inside the RunWorkers { ... } literal, add:
        //     precomputed_counts: precomputed,
```

- [ ] **Step 3b: `register` reads precomputed-or-fallback** (~441-442)

Replace:
```rust
        let shard_index = rw.next_shard;
        let (vu_offset, vu_count) = shard_split(rw.total_vus, rw.expected, shard_index);
```
with:
```rust
        let shard_index = rw.next_shard;
        let (vu_offset, vu_count) = match &rw.precomputed_counts {
            Some(counts) => counts[shard_index as usize],
            None => shard_split(rw.total_vus, rw.expected, shard_index),
        };
```
(The `Resend` arm already replays `e.vu_offset`/`e.vu_count` from the stored `WorkerEntry` — no change. `register` itself is unchanged for the legacy fan-out: non-pool `spawn_run` enqueues with `precomputed: None`, so the register handler — including the legacy gRPC fan-out path ~coordinator.rs:901 — reads `precomputed_counts: None` and falls back to `shard_split` → byte-identical.)

- [ ] **Step 3c: Add `PoolReservation` + the two methods** (place near `reserve_idle_pool` ~:229; import `crate::grpc::shard::{capacity_split, achievable_capacity}` or refer via path)

```rust
/// Outcome of `reserve_idle_pool_capacity` (closed-loop capacity path). (spec R2/R3/R6.)
#[derive(Debug)]
pub enum PoolReservation {
    /// Reserved workers (worker_id-sorted) with their per-shard (vu_offset,
    /// vu_count) from `capacity_split`. Empty `workers` = idle 0 → caller falls
    /// through to the existing empty-pool 400 (NOT Insufficient).
    Reserved {
        workers: Vec<(String, WorkerTx)>,
        counts: Vec<(u32, u32)>,
    },
    /// idle > 0 but Σ capacity < total_vus. Reached only via the rare
    /// pre-insert-check → reserve TOCTOU (the precheck normally 409s first);
    /// caller maps to mark_failed.
    Insufficient { achievable: u32 },
}
```
```rust
    /// Read-only: `(idle_count, Σ idle capacity)` for the pre-insert 409 check.
    /// Same floor/sum as the reserve path (shard::achievable_capacity). (spec R6.)
    pub async fn pool_achievable_capacity(&self) -> (usize, u32) {
        let g = self.pool.lock().await;
        let caps: Vec<u32> = g
            .values()
            .filter(|e| e.assigned_run.is_none())
            .map(|e| e.capacity_vus)
            .collect();
        (caps.len(), shard::achievable_capacity(&caps))
    }

    /// Atomically (under the pool lock) reserve idle workers for a closed-loop
    /// run, capacity-aware. Branch order is load-bearing: empty FIRST (idle 0 →
    /// existing 400), THEN capacity comparison (closed-loop vus>=1 so an empty
    /// pool's achievable 0 < vus would otherwise mis-route to Insufficient/500).
    /// (spec R2/R3/R6/R7; §4.2.)
    pub async fn reserve_idle_pool_capacity(
        &self,
        run_id: &str,
        total_vus: u32,
    ) -> PoolReservation {
        let mut g = self.pool.lock().await;
        let mut idle: Vec<(String, u32)> = g
            .iter()
            .filter(|(_, e)| e.assigned_run.is_none())
            .map(|(id, e)| (id.clone(), e.capacity_vus))
            .collect();
        idle.sort_by(|a, b| a.0.cmp(&b.0)); // deterministic selection order
        // 2. Empty FIRST → existing empty-pool 400.
        if idle.is_empty() {
            return PoolReservation::Reserved { workers: vec![], counts: vec![] };
        }
        let caps: Vec<u32> = idle.iter().map(|(_, c)| *c).collect();
        let achievable = shard::achievable_capacity(&caps);
        // 3. Insufficient (rare post-precheck TOCTOU).
        if achievable < total_vus {
            return PoolReservation::Insufficient { achievable };
        }
        // 4. N = min(idle, total_vus); capacity_split; reserve.
        let n = idle.len().min(total_vus as usize);
        let split = shard::capacity_split(total_vus, &caps[..n]);
        let mut counts = Vec::with_capacity(n);
        let mut off = 0u32;
        for &c in &split {
            counts.push((off, c));
            off += c;
        }
        let mut workers = Vec::with_capacity(n);
        for (id, _) in idle.into_iter().take(n) {
            if let Some(e) = g.get_mut(&id) {
                e.assigned_run = Some(run_id.to_string());
                workers.push((id, e.tx.clone()));
            }
        }
        PoolReservation::Reserved { workers, counts }
    }
```

- [ ] **Step 3d: Fix every existing `enqueue(...)` call site to add the 5th arg `None`**

Run `grep -rn "\.enqueue(" crates/controller/src` — update each (production `spawn_run` sites are handled in Task 3; here fix the **inline test** sites in coordinator.rs to `..., None)`). The compiler lists them all.

- [ ] **Step 4: Run tests + byte-identical guard**

Run: `cargo test -p handicap-controller --lib grpc::coordinator 2>&1 | tail -25`
Expected: PASS (new `reserve_*`/`register_*` tests + all existing `pool_*`/register/watchdog tests green — `None` fallback preserves L1).

- [ ] **Step 5: Commit**

```bash
git add crates/controller/src/grpc/coordinator.rs
git commit -m "feat(lan): capacity-aware 풀 예약 + register precomputed fallback (L3 R2/R6/R7)"
```

---

## Task 3: spawn_run 사전검사 + pool 분기 fork + ?force + 409 (runs.rs, app.rs, runner.rs)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` — `spawn_run` (~490, add `force` param + precheck + pool fork), `create` (~693, add `Query<ForceQuery>`), add `ForceQuery` struct
- Modify: `crates/controller/src/schedule/runner.rs` (~186) — pass `false` to `spawn_run`
- Test: `crates/controller/tests/` — new integration test file `pool_capacity_guard_test.rs` (mirror existing pool integration tests, e.g. the L1 use-all test)

**Interfaces:**
- Consumes: `CoordinatorState::{reserve_idle_pool_capacity, pool_achievable_capacity, PoolReservation, enqueue(.., precomputed), reserve_idle_pool, assign_pool_workers, cancel_dispatch_failed}` (Task 2); `ApiError::ConflictJson` (exists, error.rs:20); `Profile::{is_open_loop, is_vu_curve, vus}`.
- Produces: `POST /api/runs?force=true` semantics; 409 `{achievable_vus, requested_vus}`.

> The existing pool branch is `runs.rs:623-668` (one branch, all modes via `reserve_idle_pool` + even split). We **fork it by mode** and add the pre-insert precheck above `runs::insert` (:500).

- [ ] **Step 1: Write failing integration tests** (`crates/controller/tests/pool_capacity_guard_test.rs`)

Mirror the L1 pool integration test harness (grep the existing pool test that boots a controller in `--worker-mode pool`, registers idle workers via the gRPC client, and POSTs `/api/runs`). Cover:

```rust
// pseudocode shape — adapt to the repo's pool test harness (build app::router with
// pool-mode CoordinatorState, register idle workers with explicit capacity, POST /runs).

#[tokio::test]
async fn pool_assigns_capacity_aware() {
    // 2 idle workers cap [5, 1000]; closed-loop vus=30.
    // assert: run created (201), worker w0 gets vu_count 5, w1 gets 25 (via report/coord state).
}

#[tokio::test]
async fn pool_insufficient_capacity_returns_409() {
    // 2 idle workers cap 5 each (Σ=10); vus=20, no force.
    // assert: 409, body == {"achievable_vus":10,"requested_vus":20}, and runs::get(id)==None (no row).
}

#[tokio::test]
async fn pool_zero_idle_returns_400() {
    // pool mode, 0 idle workers; vus=10, no force.
    // assert: 400 "연결된 LAN 워커가 없습니다 …" (NOT 409).
}

#[tokio::test]
async fn pool_force_skips_guard() {
    // 2 idle workers cap 5 each; vus=20, ?force=true.
    // assert: 201, even split 10/10 (byte-identical L1, capacity ignored).
}

#[tokio::test]
async fn pool_clamp_resubmit_succeeds() {
    // First POST vus=20 → 409 achievable=10. Re-POST vus=10 → 201.
}

#[tokio::test]
async fn pool_default_capacity_byte_identical() {
    // 2 idle workers default cap 1000; vus=8 → even split 4/4 (no guard fires).
}
```

> **Harness adaptation (largest hidden work):** reuse `crates/controller/tests/pool_e2e.rs`'s pool harness — but its `spawn_pool_worker` (pool_e2e.rs:91) passes only `--controller`/`--token`. Extend it (or add a variant) to also pass **`--capacity-vus <n>`** (worker accepts it, default 1000, worker/src/lib.rs:39) so tests can register low-capacity (cap 5) workers. `NoopDispatcher` is irrelevant (pool mode bypasses the dispatcher). For the 409-body assertion, parse the response JSON and compare the two integer fields. For "no row" (R3), capture the runs-table count (or `GET /api/scenarios/{id}/runs` length) before/after and assert unchanged (you get no id back on 409).

- [ ] **Step 2: Run tests, verify they fail**

Run: `cargo build -p handicap-worker --bin worker && cargo test -p handicap-controller --test pool_capacity_guard_test 2>&1 | tail -25`
Expected: FAIL — `spawn_run` arity / no `?force` handling / 409 not produced.

- [ ] **Step 3a: Add `ForceQuery` + thread `force` into `create` and `spawn_run`**

In `runs.rs`, near `CreateRunRequest`:
```rust
#[derive(Debug, serde::Deserialize)]
pub struct ForceQuery {
    #[serde(default)]
    pub force: bool,
}
```
`create` (~693) — **`Query` BEFORE `Json`** (axum: the body extractor must be last):
```rust
pub async fn create(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<ForceQuery>,
    Json(body): Json<CreateRunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), ApiError> {
    // ...
    let row = spawn_run(&state, &scenario, &body.profile, validated_meta, &body.env, q.force).await?;
    // ...
}
```
`spawn_run` (~490) — add `force: bool` as the last param.

`schedule/runner.rs` (~186): `spawn_run(state, &scenario, &sched.profile, validated_meta, &env, false)`.

(Grep `spawn_run(` for any other caller — there should be exactly these two production sites + any test; add `false`/`true` accordingly.)

- [ ] **Step 3b: Pre-insert capacity precheck** — add at the TOP of `spawn_run`, **before** `runs::insert` (:500):

```rust
    // L3: closed-loop pool capacity precheck (before any DB insert → 409 leaves no
    // run row, R3). Empty pool (idle 0) is NOT a 409 — it falls through to the
    // existing empty-pool 400 below.
    if state.coord.is_pool_mode()
        && !force
        && !profile.is_open_loop()
        && !profile.is_vu_curve()
    {
        let (idle, achievable) = state.coord.pool_achievable_capacity().await;
        if idle > 0 && profile.vus > achievable {
            return Err(ApiError::ConflictJson(serde_json::json!({
                "achievable_vus": achievable,
                "requested_vus": profile.vus,
            })));
        }
    }
```

- [ ] **Step 3c: Fork the pool branch by mode** (replace the existing `if state.coord.is_pool_mode() { ... }` block at ~623-668)

```rust
    if state.coord.is_pool_mode() {
        let closed = !profile.is_open_loop() && !profile.is_vu_curve();
        if closed && !force {
            // Capacity-aware path (R2).
            match state.coord.reserve_idle_pool_capacity(&row.id, profile.vus).await {
                PoolReservation::Reserved { workers, counts } if workers.is_empty() => {
                    // empty pool → existing 400 (idle 0).
                    let msg = "연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요".to_string();
                    state.coord.cancel_dispatch_failed(&row.id).await;
                    runs::mark_failed(&state.db, &row.id, &msg).await?;
                    return Err(ApiError::BadRequest(msg));
                }
                PoolReservation::Insufficient { achievable } => {
                    // rare TOCTOU (pool shrank after precheck) — mark failed.
                    let msg = format!(
                        "풀 용량 부족 (가용 {achievable} VU < 요청 {} VU)",
                        profile.vus
                    );
                    state.coord.cancel_dispatch_failed(&row.id).await;
                    runs::mark_failed(&state.db, &row.id, &msg).await?;
                    return Err(ApiError::Internal(anyhow::anyhow!(msg)));
                }
                PoolReservation::Reserved { workers, counts } => {
                    let n_pool = workers.len() as u32;
                    state
                        .coord
                        .enqueue(row.id.clone(), assignment, n_pool, total_vus, Some(counts))
                        .await;
                    if state.coord.assign_pool_workers(&row.id, workers).await.is_err() {
                        let msg = "풀 워커 배정 실패(워커 이탈) — 재시도하세요".to_string();
                        state.coord.cancel_dispatch_failed(&row.id).await;
                        runs::mark_failed(&state.db, &row.id, &msg).await?;
                        return Err(ApiError::Internal(anyhow::anyhow!(msg)));
                    }
                    return Ok(row);
                }
            }
        } else {
            // Legacy pool path: force closed-loop OR open-loop OR VU-curve. Even
            // split via register's shard_split (precomputed None) = byte-identical L1.
            let n_cap: usize = if profile.is_vu_curve() {
                1
            } else if profile.is_open_loop() {
                let slots = profile.max_in_flight.unwrap_or(1);
                let rate = profile.target_rps.unwrap_or_else(|| {
                    profile
                        .stages
                        .as_deref()
                        .unwrap_or_default()
                        .iter()
                        .map(|s| s.target)
                        .max()
                        .unwrap_or(1)
                });
                (slots as usize).min(rate as usize)
            } else {
                profile.vus as usize
            };
            let reserved = state.coord.reserve_idle_pool(&row.id, n_cap).await;
            let n_pool = reserved.len() as u32;
            if n_pool == 0 {
                let msg = "연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요".to_string();
                state.coord.cancel_dispatch_failed(&row.id).await;
                runs::mark_failed(&state.db, &row.id, &msg).await?;
                return Err(ApiError::BadRequest(msg));
            }
            state
                .coord
                .enqueue(row.id.clone(), assignment, n_pool, total_vus, None)
                .await;
            if state.coord.assign_pool_workers(&row.id, reserved).await.is_err() {
                let msg = "풀 워커 배정 실패(워커 이탈) — 재시도하세요".to_string();
                state.coord.cancel_dispatch_failed(&row.id).await;
                runs::mark_failed(&state.db, &row.id, &msg).await?;
                return Err(ApiError::Internal(anyhow::anyhow!(msg)));
            }
            return Ok(row);
        }
    }
```

> `assignment` and `total_vus` are the locals already built before the original pool branch (`assignment` = the base RunAssignment, `total_vus` at ~615-617). Reuse them verbatim. The non-pool dispatch path below (~671+) gets its `enqueue(..., None)` 5th arg too.

- [ ] **Step 3d: Add `None` to the non-pool `enqueue`** (~673) and any other production `enqueue` site flagged by the compiler.

- [ ] **Step 4: Build worker + run tests + full gate**

Run:
```bash
cargo build -p handicap-worker --bin worker
cargo test -p handicap-controller --test pool_capacity_guard_test 2>&1 | tail -25
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -15
```
Expected: PASS / 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/schedule/runner.rs crates/controller/tests/pool_capacity_guard_test.rs
git commit -m "feat(lan): 풀 용량 사전검사 409 + ?force 강행 + 모드 fork (L3 R3/R4/R6/R12)"
```

---

## Task 4: bespoke `createRun` fetch + 409 surface (client.ts, hooks.ts)

**Files:**
- Modify: `ui/src/api/client.ts` — add `PoolCapacityError`, replace `api.createRun` with bespoke fetch (deleteDatasetImpl pattern)
- Modify: `ui/src/api/hooks.ts` — `useCreateRun` mutationFn accepts optional `force`
- Modify: `ui/src/i18n/ko.ts` — add `ko.capacityGuard` namespace (used for the error message)
- Test: `ui/src/api/__tests__/createRun.test.ts` (new)

**Interfaces:**
- Consumes: `RunSchema`, `ApiErrorSchema`, `ApiError`, `Profile`, `Run` types; `ko`.
- Produces:
  - `class PoolCapacityError extends Error { achievable_vus: number; requested_vus: number }`
  - `api.createRun(scenario_id, profile, env, opts?: { force?: boolean }): Promise<Run>` (throws `PoolCapacityError` on 409)
  - `useCreateRun` mutationFn input gains optional `force?: boolean`

> **tdd-guard (ui-only):** edit the **test file first** (pending RED diff) before touching `client.ts`/`ko.ts` — otherwise the first src edit is blocked.

- [ ] **Step 1: Write the failing test FIRST** (`ui/src/api/__tests__/createRun.test.ts`)

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { api, PoolCapacityError } from "../client";

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("api.createRun pool capacity 409", () => {
  it("throws PoolCapacityError carrying the numbers on 409", async () => {
    mockFetch(409, { achievable_vus: 10, requested_vus: 20 });
    await expect(
      api.createRun("s1", { vus: 20, duration_seconds: 5 } as never, {}),
    ).rejects.toMatchObject({ achievable_vus: 10, requested_vus: 20 });
    await expect(
      api.createRun("s1", { vus: 20, duration_seconds: 5 } as never, {}),
    ).rejects.toBeInstanceOf(PoolCapacityError);
  });

  it("appends ?force=true when opts.force is set", async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ id: "r1", scenario_id: "s1", status: "pending", profile: { vus: 20, duration_seconds: 5 }, env: {} }), { status: 201 }),
    );
    global.fetch = spy as unknown as typeof fetch;
    await api.createRun("s1", { vus: 20, duration_seconds: 5 } as never, {}, { force: true });
    expect(String((spy.mock.calls[0] as unknown[])[0])).toContain("?force=true");
  });
});
```

**Required:** the 201-path body above is a minimal stub — `createRunImpl` calls `RunSchema.parse` on success, and `RunSchema` (schemas.ts:181) **requires** `scenario_yaml`, `started_at`, `ended_at`, `created_at` (in addition to id/scenario_id/status/profile/env). Copy a full valid Run fixture from an existing run test (e.g. `ui/src/components/__tests__/RunDialog*.test.tsx` or a run-detail test) so the `?force` 201 assertion isn't masked by a parse throw.

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l3/ui && pnpm test createRun 2>&1 | tail -20`
Expected: FAIL — `PoolCapacityError` not exported / `createRun` rejects with plain ApiError (numbers stripped).

- [ ] **Step 3a: Add `ko.capacityGuard`** to `ui/src/i18n/ko.ts`

```ts
  capacityGuard: {
    // bespoke createRun error (shown as a banner in non-RunDialog callers)
    shortError: (achievable: number) => `풀 용량이 부족합니다 (가용 ${achievable} VU)`,
    // RunDialog preview + confirm dialog (Task 5 uses these)
    totalCapacity: (vus: number) => `총 용량 ${vus} VU`,
    overHint: (achievable: number) =>
      `요청 VU가 풀 용량 ${achievable} VU를 초과합니다 — 줄이거나 강행하세요`,
    dialogTitle: "풀 용량 부족",
    dialogBody: (achievable: number, requested: number) =>
      `요청한 ${requested} VU는 현재 풀 용량 ${achievable} VU를 초과합니다.`,
    clamp: (achievable: number) => `${achievable} VU로 줄여 진행`,
    force: "용량 무시하고 강행",
    cancel: "취소",
  },
```

- [ ] **Step 3b: Add `PoolCapacityError` + bespoke `createRun`** to `ui/src/api/client.ts`

Add the import `import { ko } from "../i18n/ko";` (if not present) and:
```ts
export class PoolCapacityError extends Error {
  constructor(
    public readonly achievable_vus: number,
    public readonly requested_vus: number,
  ) {
    super(ko.capacityGuard.shortError(achievable_vus));
    this.name = "PoolCapacityError";
  }
}

async function createRunImpl(
  scenario_id: string,
  profile: Profile,
  env: Record<string, string>,
  opts?: { force?: boolean },
): Promise<Run> {
  const res = await fetch(`${BASE}/runs${opts?.force ? "?force=true" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario_id, profile, env }),
  });
  const text = await res.text();
  if (res.status === 409) {
    const body = JSON.parse(text) as { achievable_vus?: unknown; requested_vus?: unknown };
    if (typeof body.achievable_vus === "number" && typeof body.requested_vus === "number") {
      throw new PoolCapacityError(body.achievable_vus, body.requested_vus);
    }
  }
  if (!res.ok) {
    let msg = text;
    try {
      msg = ApiErrorSchema.parse(JSON.parse(text)).error;
    } catch {
      // raw text
    }
    throw new ApiError(res.status, msg || `${res.status} ${res.statusText}`);
  }
  return RunSchema.parse(JSON.parse(text));
}
```
Replace the `api.createRun` entry (client.ts:138) with:
```ts
  createRun: (
    scenario_id: string,
    profile: Profile,
    env: Record<string, string>,
    opts?: { force?: boolean },
  ) => createRunImpl(scenario_id, profile, env, opts),
```

- [ ] **Step 3c: `useCreateRun` passes `force`** (`ui/src/api/hooks.ts:122-138`)

```ts
    mutationFn: ({
      scenarioId,
      profile,
      env,
      force,
    }: {
      scenarioId: string;
      profile: Profile;
      env: Record<string, string>;
      force?: boolean;
    }) => api.createRun(scenarioId, profile, env, { force }),
```
(onSuccess unchanged. Existing callers that don't pass `force` keep working — it's optional.)

- [ ] **Step 4: Run test + full UI gate**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l3/ui && pnpm test createRun 2>&1 | tail -15 && pnpm lint && pnpm build 2>&1 | tail -10`
Expected: createRun tests PASS, lint 0 warnings, `tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/client.ts ui/src/api/hooks.ts ui/src/i18n/ko.ts ui/src/api/__tests__/createRun.test.ts
git commit -m "feat(lan): bespoke createRun 409 surface + PoolCapacityError + ko.capacityGuard (L3 R9)"
```

---

## Task 5: RunDialog 총 용량 프리뷰 + 초과 힌트 + 409 확인 다이얼로그 (RunDialog.tsx, ko.ts)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` — pool preview (528-532) add total capacity + closed-fixed hint; submit path catches `PoolCapacityError` → confirm dialog (clamp/force/cancel)
- Modify: `ui/src/i18n/ko.ts` — `ko.colCapacity` (L2, ko.ts:166) drop "미적용"
- Test: `ui/src/components/__tests__/RunDialog*.test.tsx` (extend existing RunDialog test, or add a focused one)

**Interfaces:**
- Consumes: `usePoolWorkers()` (`pool.data.{pool_mode, workers[].{busy, capacity_vus}}`), `useCreateRun`, `PoolCapacityError`, `ko.capacityGuard`, existing `loadModel`/`rateMode`/`vus` state + `buildProfile`.
- Produces: (UI only)

> **tdd-guard:** edit the test file first. RunDialog mounts a lot; reuse the existing RunDialog test's setup (it already mocks `usePoolWorkers` for the L2 preview — extend that mock with `capacity_vus`).

- [ ] **Step 1: Write/extend the failing RTL tests first**

```tsx
// In the RunDialog test, mock usePoolWorkers to return pool_mode:true with
// capacities, then assert:
it("shows total idle capacity in the pool preview", async () => {
  // workers: [{busy:false,capacity_vus:5}, {busy:false,capacity_vus:5}]
  // render RunDialog (closed-fixed), assert text matches ko.capacityGuard.totalCapacity(10)
});

it("shows the over-capacity hint when closed-fixed vus exceeds idle capacity", async () => {
  // set vus input to 20 (idle capacity 10) → assert ko.capacityGuard.overHint(10) visible
});

it("does NOT show the hint for open-loop", async () => {
  // switch loadModel to open → no overHint even if maxInFlight large
});

it("opens the confirm dialog on a 409 and clamp re-submits with vus=achievable", async () => {
  // mock api.createRun to reject once with new PoolCapacityError(10, 20), then resolve.
  // submit → dialog (ko.capacityGuard.dialogTitle) → click clamp → assert api.createRun called
  // again with profile.vus === 10.
});

it("force re-submits with force:true", async () => {
  // submit → 409 dialog → click force → assert api.createRun called with opts { force: true }.
});
```

(For the 409 flow, mock `api.createRun` (the hook's underlying call) to reject with `PoolCapacityError`; follow how existing RunDialog tests assert run-creation calls via the `mutation` binding. The dialog re-submit calls `mutation.mutate` with a clamped profile or `{ force: true }`.)

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l3/ui && pnpm test RunDialog 2>&1 | tail -20`
Expected: FAIL — no total-capacity text / no hint / no confirm dialog.

- [ ] **Step 3a: Total capacity + closed-fixed hint** — extend the pool preview block (RunDialog.tsx 528-532)

```tsx
      {pool.data?.pool_mode ? (() => {
        const idle = pool.data.workers.filter((w) => !w.busy);
        const idleCapacity = idle.reduce((sum, w) => sum + Math.max(w.capacity_vus, 1), 0);
        const closedFixed = loadModel === "closed" && rateMode === "fixed";
        const over = closedFixed && Number(vus) > idleCapacity;
        return (
          <div className="mb-4">
            <p className="text-sm text-slate-600">
              {ko.workers.poolPreview(idle.length)} · {ko.capacityGuard.totalCapacity(idleCapacity)}
            </p>
            {over ? (
              <p className="text-sm text-amber-700" role="status">
                {ko.capacityGuard.overHint(idleCapacity)}
              </p>
            ) : null}
          </div>
        );
      })() : null}
```

> `loadModel`/`rateMode`/`vus` are existing RunDialog state (2-axis selector). Use whatever numeric VU value `buildProfile` uses; if `vus` is a string draft, `Number(vus)`.

- [ ] **Step 3b: 409 confirm dialog** — in the submit handler, catch `PoolCapacityError` and render a confirm dialog.

**The hook is bound to `mutation` in RunDialog** (`const mutation = useCreateRun()` at RunDialog.tsx:251; submit `mutation.mutate({ scenarioId, profile: buildProfile(), env })` at ~775-778; generic error banner at ~740-741 `mutation.error`). Use `mutation`, NOT `createRun`. Add state:
```tsx
  const [poolConflict, setPoolConflict] = useState<{ achievable: number; requested: number } | null>(null);
```
Drive it from the mutation error (effect or inline), and **suppress the generic banner when the error is a `PoolCapacityError`** so the dialog isn't doubled:
```tsx
  useEffect(() => {
    const e = mutation.error;
    if (e instanceof PoolCapacityError) {
      setPoolConflict({ achievable: e.achievable_vus, requested: e.requested_vus });
    }
  }, [mutation.error]);
```
At the generic banner (RunDialog.tsx ~740-741), gate it: `{mutation.error && !(mutation.error instanceof PoolCapacityError) ? <banner/> : null}`.
Render (reuse the existing `Modal` component, or an inline confirm region):
```tsx
      {poolConflict ? (
        <div role="alertdialog" aria-label={ko.capacityGuard.dialogTitle} className="...">
          <p>{ko.capacityGuard.dialogBody(poolConflict.achievable, poolConflict.requested)}</p>
          <Button onClick={() => {
            const built = buildProfile();
            const clamped = { ...built, vus: poolConflict.achievable };
            setPoolConflict(null);
            mutation.reset();
            mutation.mutate({ scenarioId, profile: clamped, env });
          }}>{ko.capacityGuard.clamp(poolConflict.achievable)}</Button>
          <Button onClick={() => {
            setPoolConflict(null);
            mutation.reset();
            mutation.mutate({ scenarioId, profile: buildProfile(), env, force: true });
          }}>{ko.capacityGuard.force}</Button>
          <Button onClick={() => { setPoolConflict(null); mutation.reset(); }}>{ko.capacityGuard.cancel}</Button>
        </div>
      ) : null}
```
`buildProfile()` is RunDialog's existing profile builder (used at the submit site). `mutation.reset()` clears the prior `PoolCapacityError` so the effect doesn't re-open the dialog on the next render. Guard against double-firing (disable submit while `poolConflict` is open).

> Re-submitting `{ ...built, vus: achievable }` is an honest clamped run (spec §3.3 — no degraded state). `force: true` → bespoke `createRun` appends `?force=true` (Task 4).

- [ ] **Step 3c: Update L2 `ko.colCapacity`** (ko.ts:166) — drop the now-false "미적용":

```ts
  colCapacity: "용량(VU)",
```

- [ ] **Step 4: Run tests + full UI gate**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-l3/ui && pnpm test 2>&1 | tail -15 && pnpm lint && pnpm build 2>&1 | tail -10`
Expected: full suite PASS (RunDialog new + existing WorkerDashboard/preview unaffected), lint 0, build clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/
git commit -m "feat(lan): RunDialog 총 용량 프리뷰+초과 힌트+409 확인 다이얼로그 (L3 R8/R9/R10)"
```

---

## Task 6: 런북 갱신 (docs)

**Files:**
- Modify: `docs/dev/lan-workers.md`

> Docs-only → pre-commit fast-path (no cargo/UI gate).

- [ ] **Step 1: Rewrite §4 "⚠ 과부하 미가드 경고" → "4. 과부하 가드 (L3)"**

Cover (R11/R12): capacity-aware 배정(워커당 `--capacity-vus` 존중·water-fill), 용량 부족 시 동작(RunDialog 총 용량 프리뷰+초과 힌트 / `POST /api/runs`가 `409 {achievable_vus, requested_vus}` → "줄여 진행"=`vus`를 가용으로 / "강행"=`?force=true`로 균등 과부하), curl 예: `POST /api/runs?force=true`. **dataset `unique` 한계 노트**: capacity-aware 불균형 split에서도 **disjointness는 보존**(각 행 ≤1회 소비·`rows<N` 게이트 무영향), 소비 *속도*만 불균등(많은 VU 워커가 먼저 소진→stop-on-exhaust) — uniqueness 위험 아님. 비례 분할은 후속.

- [ ] **Step 2: Update §8 한도 요약 표** — "과부하 가드" 행을 "capacity-aware closed-loop 배정(open-loop/곡선은 미적용 — 후속)"으로 갱신.

- [ ] **Step 3: Commit**

```bash
git add docs/dev/lan-workers.md
git commit -m "docs(lan): 과부하 가드(L3) 운영 런북 + unique 한계 노트 (R11/R12)"
```

---

## Verification & finish (pipeline — not a TDD task)

1. **최종 리뷰**: `handicap-reviewer` APPROVE(크로스커팅·repo 함정·REST 409 본문 ↔ UI 파싱 1:1·byte-identical-off·precomputed fallback). **+ `security-reviewer`**(path-gate: `runs.rs`/요청실행 + 409 본문 시크릿 부재 + `?force`가 토큰인증 비우회, R12).
2. **라이브 검증** (`/live-verify`, **필수** — run-생성 경로 + 신규 409 응답-파싱): localhost 풀 스택(런북 §9), 풀 워커 2대를 **저 `--capacity-vus 5`**로:
   - ① 충분(vus=8, cap 5+5) → water-fill 적합·report req 정합
   - ② 부족(vus=20) → `409 {achievable_vus:10, requested_vus:20}`
   - ③ 줄여 진행(vus=10) → 201·완료
   - ④ 강행(`?force=true`, vus=20) → 201·균등 10/10 과부하
   - ⑤ 빈 풀(워커 0) → 400(409 아님)
   - ⑥ 전원 기본 cap(1000) run = L1 byte-identical
   - **`cargo build -p handicap-worker` 워밍**(cold-build race). Playwright로 RunDialog 총 용량 프리뷰·초과 힌트·409 확인 다이얼로그(clamp/강행) 실화면 검증 → 사용자 의견 반영.
3. **`/finish-slice`**: build-log·roadmap·root CLAUDE 상태줄·ADR-0041 §귀결·도메인 CLAUDE.md(controller — capacity 가드 함정)·메모리 → ff-merge → `ExitWorktree`.

---

## Self-review (plan ↔ spec coverage)

- **R1** capacity_split + achievable → Task 1. **R2** capacity-aware 배정(reserve + register fallback) → Task 2/3. **R3** 409 + 미생성(precheck) + zero-idle 400 → Task 3. **R4** ?force → legacy → Task 3. **R5** byte-identical(slack==even·None fallback·default-cap) → Task 1(unit)/Task 2/3(integration). **R6** achievable 단일 헬퍼 → Task 1/2/3. **R7** 0-floor → Task 1. **R8** 총 용량 프리뷰+closed-fixed 힌트 → Task 5. **R9** 409 확인 다이얼로그 + bespoke createRun → Task 4/5. **R10** ko.* + colCapacity → Task 4/5. **R11** dataset_slice diff 0 + 한계 노트 → (무변경 by construction) + Task 6. **R12** 409 본문 숫자뿐 + ?force 비우회 토큰 + UI → Task 3/4 + 보안 리뷰.
- **Type consistency**: `capacity_split(u32, &[u32])->Vec<u32>`·`achievable_capacity(&[u32])->u32`·`PoolReservation{Reserved{workers,counts},Insufficient{achievable}}`·`enqueue(.., Option<Vec<(u32,u32)>>)`·`pool_achievable_capacity()->(usize,u32)`·`ForceQuery{force:bool}`·`PoolCapacityError{achievable_vus,requested_vus}`·`api.createRun(.., opts?)`·`useCreateRun({.., force?})` — 일관.
- **No placeholders**: 모든 코드 step에 실제 코드. 통합/RTL은 repo 하니스 적응 필요분만 의사코드(명시).

REVIEW-GATE: APPROVED
<!-- spec(4라운드)·plan(2라운드) 모두 spec-plan-reviewer clean APPROVE, 2026-06-20 -->
