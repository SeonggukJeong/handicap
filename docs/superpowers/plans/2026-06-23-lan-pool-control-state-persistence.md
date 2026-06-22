# LAN 풀 제어상태 영속화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** operator가 `--worker-id`로 안정 식별자를 준 풀 워커의 제어상태(drain·capacity_override·label)를 DB에 영속해 컨트롤러 재시작 너머로 재부착한다.

**Architecture:** 워커가 additive proto `Register.stable_id`(=`--worker-id` 명시 여부)를 보낸다. 컨트롤러는 stable 워커에 한해 `pool_worker_overrides`(migration 0019)에 영속하고, register의 **INSERT(엔트리-부재) 분기에서만** DB에서 재부착한다(컨트롤러 재시작 + L6 리퍼 warm-eviction 둘 다). warm reconnect(UPDATE)는 L7 in-memory 보존 그대로. 익명(랜덤 ULID) 워커는 byte-identical + 대시보드 "일시적" 표시.

**Tech Stack:** Rust(controller axum+tonic/coordinator, sqlx/SQLite, worker-core tokio, proto/prost), TypeScript/React(Zod, React Query).

## Global Constraints

- **spec**: `docs/superpowers/specs/2026-06-23-lan-pool-control-state-persistence-design.md` (R1–R12가 정규 척추). 각 task 머리에 충족 R 명시.
- **엔진(`crates/engine`)·메트릭/리포트·스케줄러 무변경**. proto는 `Register.stable_id = 6` **additive만**. migration은 0019 1개(`CREATE TABLE IF NOT EXISTS`).
- **byte-identical when off**: 전 워커 익명(stable=false)이면 DB write/read-적용 0·DTO stable=false·proto field 6 default false → L7과 동작·와이어·리포트 동일. (migration 0019는 무조건 실행되나 빈 테이블 — 로직만 게이트.)
- **R14 락 규율**: 풀 락 안에서 스냅샷/캡처만(`.await` 0). DB read는 register에서 락 *전*, DB write는 set_control에서 락 *후*.
- **에러 정책**: register의 `get_pool_override` Err → fail-soft(기본값 + `warn!`, register 미중단, `?` 금지). set_control의 `upsert`/`delete` Err → `pool_set_control`이 `anyhow::Result`로 surface → handler 500.
- **capacity_override 범위 = `1..=1_000_000`**(L7 유지)·**label ≤ 200**(L7 유지) — 본 슬라이스는 그대로.
- **UI 문구 전부 `ko.ts`(`ko.workers.*`) 경유**(ADR-0035, 인라인 한국어/영어 0). **Zod**: 신규 `stable`은 항상 직렬화되는 `z.boolean()`(nullable 아님).
- **커밋**: cargo-영향 커밋마다 전체 워크스페이스 게이트. 각 task는 **독립 green 커밋**. `git commit`은 `run_in_background:false` 단일 호출(폴링 금지), 파이프(`| tail`) 금지, 직후 `git log -1`.
- **gate(cargo)**: `cargo build -p handicap-worker --bin worker && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace`. **gate(UI)**: `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-ops-followup/ui && pnpm lint && pnpm test && pnpm build`.

---

### Task 1: proto `stable_id` + 워커 송신

**충족 R: R1 (seam: proto + worker). 컨트롤러는 아직 안 읽음 → additive·byte-identical·green 단독.**

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (`message Register` 22–28)
- Modify: `crates/worker-core/src/client.rs` (`connect_and_register` 101–134)
- Modify: `crates/worker-core/src/reconnect.rs` (`connect_with_backoff` 35–62)
- Modify: `crates/worker/src/lib.rs` (`run` 484, `run_pool` 524, new helper + inline test)
- Test: 인라인 `#[cfg(test)]` in `crates/worker/src/lib.rs` (이미 `resolve_worker_id` 테스트 존재 → src 편집 unblock)

**Interfaces:**
- Produces: proto `Register { …, bool stable_id = 6 }`. `connect_and_register(…, hostname, stable: bool, cancel)` and `connect_with_backoff(…, hostname, stable: bool, cancel)` gain a `stable: bool` param (after `hostname`, before `cancel`). Helper `worker_id_is_stable(&Option<String>) -> bool`.

- [ ] **Step 1: proto field.** In `coordinator.proto`, `message Register` (after `hostname = 5`):
```proto
  bool stable_id = 6;       // worker_id is operator-assigned (--worker-id) → durable control (LAN ops); false = ephemeral random ULID
```

- [ ] **Step 2: Write failing worker helper test** in `crates/worker/src/lib.rs` `mod tests`:
```rust
#[test]
fn worker_id_is_stable_reflects_explicit_id() {
    assert!(worker_id_is_stable(&Some("w1".to_string())), "explicit --worker-id → stable");
    assert!(!worker_id_is_stable(&None), "auto random ULID → ephemeral");
}
```

- [ ] **Step 3: Run, verify fail** — `cargo test -p handicap-worker --lib worker_id_is_stable -- --nocapture` → FAIL (`worker_id_is_stable` not defined).

- [ ] **Step 4: Implement.**

`crates/worker/src/lib.rs` — add the helper near `resolve_pool_worker_id` (`:84`):
```rust
/// A pool worker's control state is persisted only when it has a stable,
/// operator-assigned id (`--worker-id`); an auto-generated random ULID is
/// ephemeral (LAN ops persistence). Mirrors `resolve_pool_worker_id`'s
/// explicit-wins rule.
fn worker_id_is_stable(explicit: &Option<String>) -> bool {
    explicit.is_some()
}
```

`crates/worker-core/src/client.rs` `connect_and_register` (`:101`) — add `stable: bool` param after `hostname`, before `cancel`, and set the Register field:
```rust
pub async fn connect_and_register(
    controller_url: &str,
    worker_id: &str,
    run_id: &str,
    capacity_vus: u32,
    token: &str,
    hostname: &str,
    stable: bool,
    cancel: &CancellationToken,
) -> Result<WorkerLink, WorkerError> {
```
In the `Register { … }` literal (`:125`), add `stable_id: stable,` (after `hostname: hostname.to_string(),`).

`crates/worker-core/src/reconnect.rs` `connect_with_backoff` (`:35`) — add `stable: bool` param after `hostname`, before `cancel`, and pass it into the closure call (`:49`):
```rust
pub async fn connect_with_backoff(
    controller_url: &str,
    worker_id: &str,
    run_id: &str,
    capacity_vus: u32,
    token: &str,
    hostname: &str,
    stable: bool,
    cancel: CancellationToken,
) -> Result<WorkerLink, WorkerError> {
    // ...
    retry_with_backoff(
        || {
            connect_and_register(
                controller_url, worker_id, run_id, capacity_vus,
                &token, &hostname, stable, &cancel_for_attempt,
            )
        },
        cancel,
    )
    .await
}
```
(`retry_with_backoff` `:84` is connector-agnostic — no change.)

`crates/worker/src/lib.rs` call sites:
- `run` (`:484`): add `false` after the `&hostname` arg (legacy per-run worker — not a pool worker, never persisted):
```rust
    let link = match connect_with_backoff(
        &args.controller, &worker_id, &run_id, args.capacity_vus,
        args.token.as_deref().unwrap_or(""), &hostname, false, cancel.clone(),
    ).await { /* unchanged */ };
```
- `run_pool` (`:524`): compute `stable` once *outside* the loop (next to `resolve_pool_worker_id`) and pass it:
```rust
pub async fn run_pool(args: WorkerArgs) -> anyhow::Result<()> {
    let worker_id = resolve_pool_worker_id(args.worker_id.clone());
    let stable = worker_id_is_stable(&args.worker_id);
    // ... inside the loop:
        match connect_with_backoff(
            &args.controller, &worker_id, "", args.capacity_vus,
            token, &hostname, stable, cancel.clone(),
        ).await { /* unchanged */ }
```

- [ ] **Step 5: Run gate (cargo)** → all PASS. (proto codegen rebuilds; controller ignores `stable_id` → byte-identical.)

- [ ] **Step 6: Commit:**
```bash
git add crates/proto/proto/coordinator.proto crates/worker-core/src/client.rs crates/worker-core/src/reconnect.rs crates/worker/src/lib.rs
git commit -m "feat(lan-ops/t1): Register.stable_id(field 6) + 워커 송신 (R1) — additive·byte-identical"
git log -1
```

---

### Task 2: migration 0019 + store + coordinator 영속 배선

**충족 R: R2, R3, R4, R5, R6, R11. (persistence 메커니즘만 — `stable` snapshot 노출은 T3.) 한 green 커밋.**

**Files:**
- Create: `crates/controller/src/store/migrations/0019_pool_worker_overrides.sql`
- Modify: `crates/controller/src/store/mod.rs` (`pub mod pool_overrides;` + `MIGRATION_SQL_0019` const + `connect()` execute line after 0018)
- Create: `crates/controller/src/store/pool_overrides.rs` (get/upsert/delete + inline store tests)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`PoolEntry` 81–104 `stable` field, `pool_register_idle` 351–385, register call site 1163, `pool_set_control` ~487, inline coordinator tests)
- Modify: `crates/controller/src/api/pool.rs` (`patch_worker` 99–133 — `Result<bool>` 매핑)
- Create (temporary): `crates/controller/tests/_tdd_keepalive.rs` (TDD-guard unblock for the new `pool_overrides.rs` src file — `git add` explicit path, **commit 금지, task 끝 rm**)

**Interfaces:**
- Consumes: `Register.stable_id` (T1).
- Produces: `store::pool_overrides::{PoolOverride, get_pool_override, upsert_pool_override, delete_pool_override}`; `PoolEntry.stable: bool`; `pool_register_idle(…, hostname, stable: bool)`; `pool_set_control(…) -> anyhow::Result<bool>` (was `bool`).

- [ ] **Step 0: Pre-place TDD keepalive** (unblocks editing/creating `coordinator.rs`/`api/pool.rs`/`pool_overrides.rs` src before a test-path file exists). Create `crates/controller/tests/_tdd_keepalive.rs`:
```rust
#[test]
fn _tdd_keepalive() {}
```
Add ONLY this path: `git add crates/controller/tests/_tdd_keepalive.rs` (never `-A`). Do NOT commit it; remove it in Step 9.

- [ ] **Step 1: migration file + wiring.** Create `crates/controller/src/store/migrations/0019_pool_worker_overrides.sql`:
```sql
-- migration 0019: persisted pool-worker operator control overrides (LAN ops follow-up).
-- Keyed by stable worker_id (operator-assigned --worker-id). Only stable workers get a
-- row; re-attached on the INSERT (entry-absent) branch of pool_register_idle. `updated_at`
-- is write-only in v1 (forward GC/debug metadata).
CREATE TABLE IF NOT EXISTS pool_worker_overrides (
  worker_id         TEXT    PRIMARY KEY,
  drained           INTEGER NOT NULL DEFAULT 0,
  capacity_override INTEGER,
  label             TEXT,
  updated_at        INTEGER NOT NULL
);
```
In `store/mod.rs`: add `pub mod pool_overrides;` to the module list (top, after `pub mod metrics;`); add the const after `MIGRATION_SQL_0016` (group with the file-backed ones):
```rust
const MIGRATION_SQL_0019: &str = include_str!("migrations/0019_pool_worker_overrides.sql");
```
And the execute line in `connect()` after `ensure_active_vu_worker_id` (`:80`):
```rust
    sqlx::query(MIGRATION_SQL_0019).execute(&pool).await?; // migration 0019: pool_worker_overrides
```
Cross-check: `grep -c "MIGRATION_SQL_0019" crates/controller/src/store/mod.rs` == 2 (const + execute) — renumber/auto-merge footgun (controller/CLAUDE.md).

- [ ] **Step 2: Write failing store tests** in `crates/controller/src/store/pool_overrides.rs` (`#[cfg(test)] mod tests`):
```rust
#[tokio::test]
async fn override_roundtrip_and_delete() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    assert_eq!(get_pool_override(&db, "w1").await.unwrap(), None);
    upsert_pool_override(&db, "w1", true, Some(7), Some("office")).await.unwrap();
    let o = get_pool_override(&db, "w1").await.unwrap().unwrap();
    assert!(o.drained);
    assert_eq!(o.capacity_override, Some(7));
    assert_eq!(o.label.as_deref(), Some("office"));
    // upsert overwrites
    upsert_pool_override(&db, "w1", false, None, None).await.unwrap();
    let o2 = get_pool_override(&db, "w1").await.unwrap().unwrap();
    assert!(!o2.drained);
    assert_eq!(o2.capacity_override, None);
    assert_eq!(o2.label, None);
    // delete
    delete_pool_override(&db, "w1").await.unwrap();
    assert_eq!(get_pool_override(&db, "w1").await.unwrap(), None);
}
```

- [ ] **Step 3: Run, verify fail** — `cargo test -p handicap-controller --lib override_roundtrip -- --nocapture` → FAIL (module/fns missing).

- [ ] **Step 4: Implement store module.** Create `crates/controller/src/store/pool_overrides.rs`:
```rust
//! Persisted operator control overrides for stable (operator-named) pool workers.
//! Re-attached on cold register (controller restart / reaper eviction). LAN ops.
use crate::store::{Db, now_ms};

#[derive(Debug, Clone, PartialEq)]
pub struct PoolOverride {
    pub drained: bool,
    pub capacity_override: Option<u32>,
    pub label: Option<String>,
}

/// Fetch the persisted override for a stable worker (None = no row = defaults).
pub async fn get_pool_override(db: &Db, worker_id: &str) -> anyhow::Result<Option<PoolOverride>> {
    let row = sqlx::query_as::<_, (i64, Option<i64>, Option<String>)>(
        "SELECT drained, capacity_override, label FROM pool_worker_overrides WHERE worker_id = ?",
    )
    .bind(worker_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(drained, cap, label)| PoolOverride {
        drained: drained != 0,
        capacity_override: cap.map(|c| c as u32),
        label,
    }))
}

/// Insert-or-replace the override row (stamps `updated_at = now_ms`).
pub async fn upsert_pool_override(
    db: &Db,
    worker_id: &str,
    drained: bool,
    capacity_override: Option<u32>,
    label: Option<&str>,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO pool_worker_overrides (worker_id, drained, capacity_override, label, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           drained = excluded.drained,
           capacity_override = excluded.capacity_override,
           label = excluded.label,
           updated_at = excluded.updated_at",
    )
    .bind(worker_id)
    .bind(drained as i64)
    .bind(capacity_override.map(|c| c as i64))
    .bind(label)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// Remove the override row (called when control returns to all-default).
pub async fn delete_pool_override(db: &Db, worker_id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM pool_worker_overrides WHERE worker_id = ?")
        .bind(worker_id)
        .execute(db)
        .await?;
    Ok(())
}
```
(Place the `#[cfg(test)] mod tests` from Step 2 at the bottom of this file.)

- [ ] **Step 5: Run store tests** — `cargo test -p handicap-controller --lib override_roundtrip` → PASS.

- [ ] **Step 6: Write failing coordinator tests** in `crates/controller/src/grpc/coordinator.rs` `mod tests` (already `#[cfg(test)]`). NOTE: `pool_register_idle` gains a 5th arg `stable: bool`; **update ALL existing call sites** (compiler lists ~37 sites: prod `:1163` + coordinator inline tests + `crates/controller/tests/pool_api_test.rs:93`) — existing tests pass `false` (anonymous) unless asserting stable behavior.
```rust
#[tokio::test]
async fn anonymous_worker_never_persists() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("anon", tx, 10, "h".into(), false).await; // stable=false
    assert!(st.pool_set_control("anon", Some(true), Some(Some(5)), Some(Some("x".into()))).await.unwrap());
    // in-memory applied, but no DB row (byte-identical persistence path)
    assert_eq!(crate::store::pool_overrides::get_pool_override(&st.db, "anon").await.unwrap(), None);
}

#[tokio::test]
async fn stable_set_control_upserts_then_default_deletes() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx, 10, "h".into(), true).await;
    st.pool_set_control("w1", Some(true), Some(Some(7)), Some(Some("pc".into()))).await.unwrap();
    let o = crate::store::pool_overrides::get_pool_override(&st.db, "w1").await.unwrap().unwrap();
    assert!(o.drained && o.capacity_override == Some(7) && o.label.as_deref() == Some("pc"));
    // return to all-default → row deleted
    st.pool_set_control("w1", Some(false), Some(None), Some(None)).await.unwrap();
    assert_eq!(crate::store::pool_overrides::get_pool_override(&st.db, "w1").await.unwrap(), None);
}

#[tokio::test]
async fn stable_reattach_on_insert_after_restart() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let st = CoordinatorState::new(db.clone());
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx, 10, "h".into(), true).await;
    st.pool_set_control("w1", Some(true), Some(Some(5)), None).await.unwrap();
    // simulate controller restart with a warm DB: drop the in-memory entry, fresh state on same db.
    let st2 = CoordinatorState::new(db);
    let (tx2, _rx2) = tokio::sync::mpsc::channel(32);
    st2.pool_register_idle("w1", tx2, 10, "h".into(), true).await; // INSERT → re-attach from DB
    let g = st2.pool.lock().await;
    let e = g.get("w1").unwrap();
    assert!(e.drained, "drain re-attached from DB on cold register");
    assert_eq!(e.capacity_override, Some(5));
}

#[tokio::test]
async fn warm_reconnect_does_not_reapply_db() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx, 10, "h".into(), true).await; // INSERT, no row → not drained
    // out-of-band: write a drained row to DB, but the entry is already live (warm).
    crate::store::pool_overrides::upsert_pool_override(&st.db, "w1", true, None, None).await.unwrap();
    let (tx2, _rx2) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx2, 12, "h".into(), true).await; // UPDATE branch → preserve in-memory
    let g = st.pool.lock().await;
    assert!(!g.get("w1").unwrap().drained, "warm reconnect preserves in-memory, ignores DB");
}

#[tokio::test]
async fn exclude_leaves_override_row() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx, 10, "h".into(), true).await;
    st.pool_set_control("w1", Some(true), None, None).await.unwrap();
    st.pool_exclude("w1", "maintenance").await;
    assert!(crate::store::pool_overrides::get_pool_override(&st.db, "w1").await.unwrap().is_some(),
        "exclude is a one-shot action; the persisted drain survives (R6)");
}
```

- [ ] **Step 7: Run, verify fail** — `cargo test -p handicap-controller --lib stable_reattach -- --nocapture` → FAIL (signature/field/persist missing).

- [ ] **Step 8: Implement coordinator.**

`PoolEntry` (`:81`) — add `stable: bool` field (read by `pool_set_control`/`pool_register_idle`):
```rust
    /// Whether this worker has a stable, operator-assigned id (Register.stable_id).
    /// Only stable workers persist/re-attach control state (LAN ops). false = ephemeral.
    stable: bool,
```

`pool_register_idle` (`:351`) — add `stable: bool` param; read DB override *before* the lock; apply on INSERT only:
```rust
pub async fn pool_register_idle(
    &self,
    worker_id: &str,
    tx: WorkerTx,
    capacity_vus: u32,
    hostname: String,
    stable: bool,
) {
    // Read persisted override BEFORE locking (R14 — no DB .await under the pool lock).
    // Applied only on the INSERT (entry-absent) branch: cold attach after a controller
    // restart, OR reconnect after the L6 reaper evicted a half-open worker. Warm reconnect
    // (UPDATE) preserves in-memory (L7 R2). Read error → fail-soft to defaults.
    // (On a stable warm reconnect this read is discarded — a benign single PK lookup;
    //  we cannot know INSERT vs UPDATE without holding the lock.)
    let restored = if stable {
        match crate::store::pool_overrides::get_pool_override(&self.db, worker_id).await {
            Ok(o) => o,
            Err(e) => {
                warn!(worker_id, error = %e, "pool override read failed; using defaults");
                None
            }
        }
    } else {
        None
    };
    let mut g = self.pool.lock().await;
    match g.get_mut(worker_id) {
        Some(e) => {
            e.tx = tx;
            e.capacity_vus = capacity_vus;
            e.hostname = hostname;
            e.assigned_run = None;
            e.last_seen = tokio::time::Instant::now();
            e.stable = stable;
            // drained / capacity_override / label preserved in-memory (L7 R2; no DB re-apply).
        }
        None => {
            let (drained, capacity_override, label) = match restored {
                Some(o) => (o.drained, o.capacity_override, o.label),
                None => (false, None, None),
            };
            g.insert(
                worker_id.to_string(),
                PoolEntry {
                    tx,
                    capacity_vus,
                    hostname,
                    assigned_run: None,
                    last_seen: tokio::time::Instant::now(),
                    drained,
                    capacity_override,
                    label,
                    stable,
                },
            );
        }
    }
}
```
Register handler call site (`:1163`): add `reg.stable_id`:
```rust
                                .pool_register_idle(
                                    &reg.worker_id,
                                    tx.clone(),
                                    reg.capacity_vus,
                                    reg.hostname.clone(),
                                    reg.stable_id,
                                )
```
Then fix the remaining ~36 `pool_register_idle(...)` call sites (all in `#[cfg(test)]` + `tests/pool_api_test.rs:93`) by appending `false` (unless the test asserts stable behavior). The compiler lists every site.

`pool_set_control` (`:487`) — change return to `anyhow::Result<bool>`, persist post-lock:
```rust
pub async fn pool_set_control(
    &self,
    worker_id: &str,
    drained: Option<bool>,
    capacity_override: Option<Option<u32>>,
    label: Option<Option<String>>,
) -> anyhow::Result<bool> {
    let snapshot = {
        let mut g = self.pool.lock().await;
        let Some(e) = g.get_mut(worker_id) else {
            return Ok(false);
        };
        if let Some(d) = drained {
            e.drained = d;
        }
        if let Some(c) = capacity_override {
            e.capacity_override = c;
        }
        if let Some(l) = label {
            e.label = l;
        }
        // capture under lock (e.stable gates persistence); .await happens after drop.
        (e.stable, e.drained, e.capacity_override, e.label.clone())
    };
    let (stable, drained, cap, label) = snapshot;
    if stable {
        if !drained && cap.is_none() && label.is_none() {
            crate::store::pool_overrides::delete_pool_override(&self.db, worker_id).await?;
        } else {
            crate::store::pool_overrides::upsert_pool_override(
                &self.db, worker_id, drained, cap, label.as_deref(),
            )
            .await?;
        }
    }
    Ok(true)
}
```

`crates/controller/src/api/pool.rs` `patch_worker` (`:116`) — the `bool` → `Result<bool>` change forces this mapping (R4/M2):
```rust
    match state
        .coord
        .pool_set_control(&id, req.drained, req.capacity_override, req.label)
        .await
    {
        Ok(true) => {}
        Ok(false) => return Err(ApiError::NotFound),
        // Control applied in-memory but persistence failed — surface, don't swallow.
        Err(e) => {
            return Err(ApiError::Internal(
                e.context("control applied in-memory but persistence failed"),
            ));
        }
    }
```
(Keep the existing summary-build block below unchanged. `ApiError::Internal(anyhow::Error)` exists (`error.rs:26`) → 500. `e` here is `anyhow::Error`, and `.context(...)` is its **inherent** method — **no `use anyhow::Context` import needed**.)

**Existing-test impact (compiler-caught):** the `bool` → `Result<bool>` change also breaks the L7 inline test `pool_set_control_partial_update_and_404` (`coordinator.rs:~3012`), which calls `assert!(st.pool_set_control(...).await)` / `assert!(!...await)` — change each to `.await.unwrap()` (and `!...await.unwrap()`). Same green commit.

- [ ] **Step 9: Run gate (cargo)** → all PASS. Then **remove the keepalive**: `rm crates/controller/tests/_tdd_keepalive.rs` and `git restore --staged crates/controller/tests/_tdd_keepalive.rs` (if it was staged). Confirm `git status` shows it gone and untracked-removed.

- [ ] **Step 10: Commit** (verify the keepalive is NOT in the staged set):
```bash
git add crates/controller/src/store/migrations/0019_pool_worker_overrides.sql crates/controller/src/store/mod.rs crates/controller/src/store/pool_overrides.rs crates/controller/src/grpc/coordinator.rs crates/controller/src/api/pool.rs crates/controller/tests/pool_api_test.rs
git diff --cached --name-only   # must NOT include _tdd_keepalive.rs
git commit -m "feat(lan-ops/t2): pool_worker_overrides(migration 0019) + 영속/재부착 배선 (R2,R3,R4,R5,R6,R11)"
git log -1
```

---

### Task 3: `stable` 노출 seam + UI

**충족 R: R7, R8, R9. (PoolWorkerInfo→Summary→Zod 한 커밋 = R7 wire 1:1.) green 커밋.**

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`PoolWorkerInfo` ~113 `stable` field, `pool_snapshot` ~404 map)
- Modify: `crates/controller/src/api/pool.rs` (`PoolWorkerSummary` 13–23 `stable` + `From` 25–39) — **no inline `#[cfg(test)]` → needs keepalive (Step 0)**
- Modify: `ui/src/api/pool.ts` (Zod `stable`)
- Modify: `ui/src/i18n/ko.ts` (`ko.workers` — `ephemeralBadge` + `ephemeralHint`)
- Modify: `ui/src/pages/WorkerDashboardPage.tsx` (row 일시적 indicator + new `hint?` prop on `ConfirmDialog`/`EditModal` + thread)
- Create (temporary): `crates/controller/tests/_tdd_keepalive.rs` (same as T2 — unblock the inline-test-less `api/pool.rs` edit; `git add` explicit path, **commit 금지, task 끝 rm**)
- Test: `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx` (`makeWorker` factory `stable` default + `overrides` type + new cases), `ui/src/components/__tests__/RunDialog.test.tsx` (`makePoolWorker` factory `stable` default + `overrides` type)

**Interfaces:**
- Consumes: `PoolEntry.stable` (T2). Produces DTO field `stable: bool` (always serialized) → UI `PoolWorkerSummary.stable`.

- [ ] **Step 0: Pre-place TDD keepalive** (`api/pool.rs` has no inline `#[cfg(test)]`, so its Step 1 edit is blocked until a pending test-path file exists). Create `crates/controller/tests/_tdd_keepalive.rs`:
```rust
#[test]
fn _tdd_keepalive() {}
```
`git add crates/controller/tests/_tdd_keepalive.rs` (never `-A`). Do NOT commit; remove in Step 9.

- [ ] **Step 1: Backend — expose `stable`.** `coordinator.rs` `PoolWorkerInfo` (~`:113`) add `pub stable: bool,`. In `pool_snapshot`'s `.map(...)` that builds `PoolWorkerInfo` (~`:404`), add `stable: e.stable,`. `api/pool.rs` `PoolWorkerSummary` (~`:13`) add `pub stable: bool,`; in `From<PoolWorkerInfo>` (~`:27`) add `stable: i.stable,`. (Each struct has exactly ONE literal site — compiler-driven.)

- [ ] **Step 2: Run gate (cargo)** → PASS (Rust side compiles; existing pool tests still green — `stable` additive).

- [ ] **Step 3: Write failing UI tests.** First update the fixture factories so Zod `.parse` passes (required field) — **both the default object AND the `overrides` param type**:
  - `WorkerDashboardPage.test.tsx` `makeWorker` (~`:24` overrides type, ~`:36` default): add `stable?: boolean;` to the `overrides` type (~`:24-34`) AND `stable: true,` to the default object (~`:36`). Use `makeWorker({ ..., stable: false })` in the new ephemeral test.
  - `RunDialog.test.tsx` `makePoolWorker` (~`:1566` overrides type, ~`:1578` default): add `stable?: boolean;` to the overrides type AND `stable: true,` to the default. (`tsc -b`/`pnpm build` catches a missing `overrides` member.)

  Then add to `WorkerDashboardPage.test.tsx`:
```ts
it("ephemeral(비안정) 워커에 '일시적' 표시 + 제어 메뉴에 미유지 힌트", async () => {
  // fixture: makeWorker({ worker_id: "wkr-eph", hostname: "pc-eph", stable: false })
  // render → expect getByText(ko.workers.ephemeralBadge) on that row
  // open ⋯ → 비우기 → confirm dialog contains ko.workers.ephemeralHint
});
it("stable 워커엔 '일시적' 표시 없음", async () => {
  // fixture: makeWorker({ worker_id: "wkr-stable", stable: true })
  // expect queryByText(ko.workers.ephemeralBadge) === null
});
```

- [ ] **Step 4: Run, verify fail** — `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-ops-followup/ui && pnpm test WorkerDashboardPage` → FAIL (badge/hint missing).

- [ ] **Step 5: ko.ts strings** — extend `ko.workers` (after `poolPreviewDrained`):
```ts
    // ephemeral (non-stable) worker — control state not durable across controller restart
    ephemeralBadge: "일시적",
    ephemeralHint:
      "이 워커는 안정 id가 없어 컨트롤러 재시작 시 이 설정이 유지되지 않습니다. 유지하려면 워커를 '--worker-id'로 기동하세요.",
```

- [ ] **Step 6: Zod** (`ui/src/api/pool.ts`) — add to `PoolWorkerSummarySchema` (always-serialized bool, not nullable):
```ts
  stable: z.boolean(),
```

- [ ] **Step 7: Dashboard render** (`WorkerDashboardPage.tsx`):
  - **Indicator**: in the worker-id cell (or hostname cell next to the drained badge), when `!w.stable` render a small slate pill:
```tsx
{!w.stable ? (
  <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-600">
    {ko.workers.ephemeralBadge}
  </span>
) : null}
```
  - **Ephemeral hint** — `ConfirmDialog` (`:9`) `body` and `EditModal` (`:71`) `note` are typed **`string`**, not ReactNode, so there is NO JSX slot to reuse. Add a **new optional `hint?: string` prop** to BOTH `ConfirmDialog` and `EditModal`, rendered (when present) as an amber note, e.g. right after the existing `body`/`note` paragraph:
```tsx
{hint ? <p className="mt-2 text-xs text-amber-700">{hint}</p> : null}
```
  Then thread it from each call site (drain confirm `:268`, capacity modal & label modal `~:310-360`) as `hint={!worker.stable ? ko.workers.ephemeralHint : undefined}`. **Skip the exclude confirm** (`:288`) — exclude is terminal, not a durable setting (its existing `warn` prop stays for the busy-run warning). Undrain (no dialog) also needs no hint.

- [ ] **Step 8: Remove keepalive + UI gate.** First `rm crates/controller/tests/_tdd_keepalive.rs` (+ `git restore --staged` it if staged); confirm `git status` shows it gone. Then cargo gate (`cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace`) + UI gate `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-ops-followup/ui && pnpm lint && pnpm test && pnpm build` → all PASS.

- [ ] **Step 9: curl smoke (manual, optional before T4):** start a pool controller + 1 worker with `--worker-id w1` (see `/live-verify`):
  - `curl …/api/pool/workers` → each worker object has `"stable": true` (named) / `false` (anonymous).
  - `curl -X PATCH …/api/pool/workers/w1 -d '{"drained":true}'` → 200; restart controller; reconnect → worker still `drained:true`.

- [ ] **Step 10: Commit** (verify keepalive NOT staged):
```bash
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/api/pool.rs ui/src/api/pool.ts ui/src/i18n/ko.ts ui/src/pages/WorkerDashboardPage.tsx ui/src/pages/__tests__/WorkerDashboardPage.test.tsx ui/src/components/__tests__/RunDialog.test.tsx
git diff --cached --name-only   # must NOT include _tdd_keepalive.rs
git commit -m "feat(lan-ops/t3): stable 노출 seam(DTO+Zod) + 대시보드 일시적 표시/힌트 (R7,R8,R9)"
git log -1
```

---

### Task 4: 라이브 검증 + 마무리

**충족 R: R5, R6, R10, R11 라이브 (S-D 갭 차단 — register/풀-배정 경로).**

- [ ] **Step 1: `/live-verify`** — 실 pool 컨트롤러 + 워커 2대(1대 `--worker-id w1`=stable, 1대 무옵션=익명) + 50ms responder + 격리 DB. 확인:
  - **stable 영속**: PATCH drain w1 → 컨트롤러 재시작(프로세스 kill→재기동, 같은 DB) → w1 재등록 → `/workers` 여전히 "비우는 중", RunDialog 프리뷰/409 가드에서 제외.
  - **익명 비영속**: 익명 워커 drain → 재시작 → undrained 복귀 + 대시보드 "일시적" 표시.
  - **capacity_override/label 생존**(stable): PATCH override w1=4 + label → 재시작 → 값 유지.
  - **리퍼-evict 재부착**: 짧은 stale 임계값(`/settings` 또는 CLI)으로 stable w1 drain → `kill -STOP <w1 pid>`로 half-open evict(행 사라짐) → `kill -CONT` 재접속 → **컨트롤러 가동 중에도 drained 재부착**(R5 ②).
  - **exclude 행 불변**: stable w1 drain → exclude → 워커 재실행 → drained 재부착(override 행 살아있음, R6).
  - **Playwright**: 일시적 인디케이터(익명 행)·익명 워커 제어 메뉴의 미유지 힌트·Zod 콘솔 0.
- [ ] **Step 2:** Playwright/responder 잔여 정리(`rm -rf .playwright-mcp` + 루트 png).
- [ ] **Step 3: `handicap-reviewer`** (최종 크로스커팅·wire 1:1: proto stable_id↔reg.stable_id↔PoolEntry.stable↔DTO↔Zod; migration 0019 멱등; apply-on-INSERT 분기; byte-identical-off). **security-reviewer는 path-gate 평가**: 본 슬라이스는 요청실행/템플릿/바인딩/업로드/trace 무관(신규 = DB 1테이블[시크릿 0]·proto bool·DTO bool) → 매치 시 APPROVE 필요, 아니면 N/A 근거 기록. findings는 `receiving-code-review`로 평가 후 반영/기각.
- [ ] **Step 4: `/finish-slice`** — build-log·roadmap·CLAUDE 상태줄·ADR-0041 §귀결/연기·메모리 기록 → ff-merge → ExitWorktree.

---

## Self-Review (writing-plans)

- **Spec coverage**: R1(T1 proto+worker)·R2(T2 migration+store)·R3(T2 PoolEntry.stable + anonymous no-DB test)·R4(T2 pool_set_control persist + patch_worker 500)·R5(T2 apply-on-INSERT + warm/evict tests)·R6(T2 exclude_leaves_override_row)·R7(T3 PoolWorkerInfo/Summary/From + Zod)·R8(T3 indicator+hint)·R9(T3 ko.ts)·R10(T2/T3 byte-identical tests + T4 live)·R11(T2 restart-recovery + migration idempotent)·R12(T4 security-reviewer path-gate). All R covered.
- **Dead-code gate**: T1 — proto field used by Register literal; helper used by run_pool + tested. T2 — store fns called by coordinator (non-test) same commit; `PoolEntry.stable` read by register/set_control. T3 — `PoolWorkerInfo.stable` first read by `From` same commit. No `#[cfg(test)]`-only `pub(crate)` orphan.
- **Type consistency**: `worker_id_is_stable(&Option<String>)->bool`, `connect_with_backoff(…, stable: bool, cancel)`, `connect_and_register(…, stable: bool, cancel)`, `pool_register_idle(…, stable: bool)`, `pool_set_control(…)->anyhow::Result<bool>`, `PoolOverride{drained,capacity_override,label}`, `get/upsert/delete_pool_override`, DTO/Zod `stable: bool`(z.boolean) — names/types consistent across tasks.
- **Order**: T1(proto+worker)→T2(controller reads reg.stable_id + persistence)→T3(expose stable + UI)→T4(live+finish). T2 depends on T1's proto field; T3 depends on T2's PoolEntry.stable.
- **Migration footgun**: Step 1 cross-check `grep -c MIGRATION_SQL_0019 == 2` (const+execute). **Keepalive**: T2 Step 0 pre-place, Step 9 rm (never committed).

---

<!-- REVIEW-GATE: APPROVED -->
REVIEW-GATE: APPROVED

> spec-plan-reviewer: spec clean APPROVE (round 2) + plan clean APPROVE (round 2). 2026-06-23.
