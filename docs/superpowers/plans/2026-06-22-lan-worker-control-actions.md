# LAN 워커 제어 액션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/workers` 대시보드에서 풀 워커를 drain/undrain·exclude·capacity override·label로 운영자가 제어한다.

**Architecture:** 제어 상태(`drained`/`capacity_override`/`label`)는 `PoolEntry` in-memory 필드(migration 0)이고 idempotent re-register에 보존된다. drain·override는 L3–L5 과부하 가드와 RunDialog 프리뷰에 동일 규칙으로 반영(by-construction parity). exclude는 새 additive proto `Disconnect`를 워커 **두 사이트**(idle-wait 루프·`forward_inbound`)에서 받아 프로세스 cancel→깔끔 종료(재접속 0). 로그인 부재의 보완 통제로 모든 제어 동작에 위험/결과 경고 문구.

**Tech Stack:** Rust(controller axum+tonic/coordinator, worker-core tokio, proto/prost), TypeScript/React(Zod, React Query, Tailwind).

## Global Constraints

- **spec**: `docs/superpowers/specs/2026-06-22-lan-worker-control-actions-design.md` (R1–R14가 정규 척추). 각 task 머리에 충족 R 명시.
- **migration 0**·**엔진(`crates/engine`) 무변경**. proto는 `Disconnect` oneof field 5 **additive만**.
- **byte-identical when off**: 전 워커 기본값(drained=false·override=None)이면 가드 산식·와이어·리포트 동일. proto Disconnect 미사용=byte-identical.
- **capacity_override 범위 = `1..=1_000_000`** (순수 sanity 상한; ops-config `worker_capacity_vus` 설정도 워커 선언값도 아님). **label 길이 ≤ 200**.
- **R14 락 규율**: 풀 락 안에서 스냅샷/캡처만(`.await` 0), send/evict/fail-fast는 락 밖.
- **UI 문구 전부 `ko.ts`(`ko.workers.*`) 경유** (ADR-0035, 인라인 한국어/영어 0).
- **Zod**: 서버 `Option<T>` → JSON `null` → UI `.nullable()`(`.optional()`/`.nullish()` 금지, S-D 갭).
- **커밋**: cargo-영향 커밋마다 전체 워크스페이스 게이트. 각 task는 **독립 green 커밋**. `git commit`은 `run_in_background:false` 단일 호출(폴링 금지), 파이프(`| tail`) 금지, 직후 `git log -1`.
- **gate**: cargo task는 `cargo build -p handicap-worker --bin worker && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace`. UI task는 `cd ui && pnpm lint && pnpm test && pnpm build`.

---

### Task 1: Coordinator 제어 상태 + 가드 ripple + 대시보드 read-path

**충족 R: R1, R2, R3, R9(Rust DTO 측)**

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`PoolEntry` 81–98, `PoolWorkerInfo` 103–109, `reserve_idle_pool` 253, `pool_register_idle` 336, `pool_snapshot` 369, `pool_achievable_capacity` 447, `reserve_idle_pool_capacity` 469)
- Modify: `crates/controller/src/api/pool.rs` (`PoolWorkerSummary` 7–14, `list_workers` 27–49)
- Test: 인라인 `#[cfg(test)] mod tests` in `coordinator.rs`

**Interfaces:**
- Produces: `PoolEntry { …, drained: bool, capacity_override: Option<u32>, label: Option<String> }` + `fn effective_capacity_vus(&self) -> u32`; `PoolWorkerInfo { …, drained: bool, capacity_override: Option<u32>, label: Option<String> }`; `PoolWorkerSummary { …, drained: bool, capacity_override: Option<u32>, label: Option<String> }` (serde JSON: `drained` always, `capacity_override`/`label` → `null` when None).

- [ ] **Step 1: Write failing tests** in `coordinator.rs` `mod tests`.

```rust
// helper: build a CoordinatorState in pool mode with a dummy worker tx.
// (reuse the existing test helper that makes a (tx, _rx); if none, mpsc::channel(32))

#[tokio::test]
async fn pool_register_idle_preserves_control_and_refreshes_tx() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    let (tx1, rx1) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx1, 10, "h1".into()).await;
    // operator sets control directly (mutator arrives in Task 3; here mutate under lock)
    {
        let mut g = st.pool.lock().await;
        let e = g.get_mut("w1").unwrap();
        e.drained = true;
        e.capacity_override = Some(7);
        e.label = Some("office-pc".into());
        e.assigned_run = Some("r0".into());
    }
    // Drop tx1's receiver: if the entry still holds tx1 after re-register, is_closed()
    // would be true. Re-register with a FRESH tx2 whose receiver stays alive.
    drop(rx1);
    let (tx2, _rx2) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx2, 12, "h1b".into()).await;
    let g = st.pool.lock().await;
    let e = g.get("w1").unwrap();
    assert!(e.drained, "drain preserved across re-register");
    assert_eq!(e.capacity_override, Some(7), "override preserved");
    assert_eq!(e.label.as_deref(), Some("office-pc"), "label preserved");
    assert_eq!(e.assigned_run, None, "assigned_run reset to idle");
    assert_eq!(e.capacity_vus, 12, "declared capacity refreshed");
    assert_eq!(e.hostname, "h1b", "hostname refreshed");
    assert!(!e.tx.is_closed(), "tx refreshed to tx2 (tx1's receiver was dropped)");
}

#[tokio::test]
async fn pool_register_idle_default_fields_match_old_blind_insert() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx, 5, "h".into()).await;
    let g = st.pool.lock().await;
    let e = g.get("w1").unwrap();
    assert!(!e.drained);
    assert_eq!(e.capacity_override, None);
    assert_eq!(e.label, None);
    assert_eq!(e.assigned_run, None); // == old blind-insert behavior
}

#[tokio::test]
async fn effective_capacity_uses_override_then_declared() {
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let e = PoolEntry { tx, capacity_vus: 25, hostname: "h".into(),
        assigned_run: None, last_seen: tokio::time::Instant::now(),
        drained: false, capacity_override: None, label: None };
    assert_eq!(e.effective_capacity_vus(), 25);
    let e2 = PoolEntry { capacity_override: Some(5), ..e };
    assert_eq!(e2.effective_capacity_vus(), 5);
}

#[tokio::test]
async fn drained_worker_excluded_from_capacity_paths() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    for (id, cap) in [("w1", 10u32), ("w2", 10)] {
        let (tx, _rx) = tokio::sync::mpsc::channel(32);
        st.pool_register_idle(id, tx, cap, "h".into()).await;
        std::mem::forget(_rx); // keep tx open
    }
    // both idle → achievable = 20
    assert_eq!(st.pool_achievable_capacity(100).await, (2, 20));
    // drain w1 + override w2 to 4
    {
        let mut g = st.pool.lock().await;
        g.get_mut("w1").unwrap().drained = true;
        g.get_mut("w2").unwrap().capacity_override = Some(4);
    }
    // now only w2 idle, effective 4
    assert_eq!(st.pool_achievable_capacity(100).await, (1, 4));
}
```

- [ ] **Step 2: Run, verify fail** — `cargo test -p handicap-controller --lib pool_register_idle_preserves -- --nocapture` → FAIL (missing fields).

- [ ] **Step 3: Implement.**

`PoolEntry` (81–98): remove `#[allow(dead_code)]` from `capacity_vus` (now read by `effective_capacity_vus`), add 3 fields + method:
```rust
struct PoolEntry {
    tx: WorkerTx,
    capacity_vus: u32,
    hostname: String,
    assigned_run: Option<String>,
    last_seen: tokio::time::Instant,
    /// Operator drain veto: excluded from new assignments + capacity. (spec R1/R3)
    drained: bool,
    /// Operator capacity override; replaces capacity_vus in all pool math. (R1)
    capacity_override: Option<u32>,
    /// Operator memo (display-only). (R1)
    label: Option<String>,
}
impl PoolEntry {
    fn effective_capacity_vus(&self) -> u32 {
        self.capacity_override.unwrap_or(self.capacity_vus)
    }
}
```

`pool_register_idle` (336): blind `insert` → get-or-update preserving control fields (R2):
```rust
pub async fn pool_register_idle(&self, worker_id: &str, tx: WorkerTx, capacity_vus: u32, hostname: String) {
    let mut g = self.pool.lock().await;
    match g.get_mut(worker_id) {
        Some(e) => {
            // reconnect: refresh transport/identity, preserve operator control, reset to idle.
            e.tx = tx;
            e.capacity_vus = capacity_vus;
            e.hostname = hostname;
            e.assigned_run = None;
            e.last_seen = tokio::time::Instant::now();
            // drained / capacity_override / label intentionally untouched (R2).
        }
        None => {
            g.insert(worker_id.to_string(), PoolEntry {
                tx, capacity_vus, hostname, assigned_run: None,
                last_seen: tokio::time::Instant::now(),
                drained: false, capacity_override: None, label: None,
            });
        }
    }
}
```

Guard ripple — in `reserve_idle_pool` (253), `pool_achievable_capacity` (447), `reserve_idle_pool_capacity` (469): change the idle filter from `e.assigned_run.is_none()` to `e.assigned_run.is_none() && !e.drained`, and replace `e.capacity_vus` reads (in the `.map(|(id,e)| (id.clone(), e.capacity_vus))` collectors and `reserve_idle_pool`'s `take`) with `e.effective_capacity_vus()`. `reserve_idle_pool` (no capacity) only needs the `!e.drained` filter added.

`pool_snapshot` (369) + `PoolWorkerInfo` (103): add 3 fields (no filter — show all workers):
```rust
pub struct PoolWorkerInfo {
    pub worker_id: String,
    pub hostname: String,
    pub capacity_vus: u32,
    pub assigned_run: Option<String>,
    pub last_seen_secs_ago: u64,
    pub drained: bool,
    pub capacity_override: Option<u32>,
    pub label: Option<String>,
}
// in pool_snapshot's .map(): drained: e.drained, capacity_override: e.capacity_override, label: e.label.clone(),
```

`api/pool.rs` `PoolWorkerSummary` (7) + `list_workers` (27): add the 3 fields and map them through:
```rust
#[derive(Serialize)]
pub struct PoolWorkerSummary {
    pub worker_id: String,
    pub hostname: String,
    pub capacity_vus: u32,
    pub busy: bool,
    pub run_id: Option<String>,
    pub last_seen_secs_ago: u64,
    pub drained: bool,
    pub capacity_override: Option<u32>,
    pub label: Option<String>,
}
// in list_workers map: drained: i.drained, capacity_override: i.capacity_override, label: i.label,
```

- [ ] **Step 4: Run tests** — `cargo build -p handicap-worker --bin worker && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace` → all PASS.

- [ ] **Step 5: Commit** (`run_in_background:false`, no pipe):
```bash
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/api/pool.rs
git commit -m "feat(lan-l7/t1): PoolEntry 제어 3필드 + 가드 ripple + 대시보드 read-path (R1,R2,R3,R9)"
git log -1
```

---

### Task 2: proto `Disconnect` + 워커 두 사이트 종료 처리

**충족 R: R5, R7 (seam: proto + worker)**

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (ServerMessage oneof 104–109)
- Modify: `crates/worker-core/src/client.rs` (`forward_inbound` 52, idle-wait loop 134–158, spawn 164, `#[cfg(test)]` forward_inbound call sites)
- Test: 인라인 `#[cfg(test)]` in `client.rs`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: proto `ServerPayload::Disconnect(pb::Disconnect{ reason: String })` (oneof field 5). Worker exits its `run_pool` loop (no reconnect) when received. `forward_inbound` signature gains a trailing `cancel: CancellationToken` param.

- [ ] **Step 1: proto — add `Disconnect`.** In `coordinator.proto`, ServerMessage oneof (after `DatasetBatch dataset_batch = 4;`):
```proto
    Disconnect disconnect = 5;   // controller asks the worker to exit cleanly (no reconnect)
```
And a new top-level message (near `Ping`):
```proto
message Disconnect {
  string reason = 1;
}
```

- [ ] **Step 2: Write failing worker tests** in `client.rs`. Two tests (R7 acceptance = both sites):
  - (a) `forward_inbound_disconnect_cancels_process_token` (below) — drives the spawned `forward_inbound` arm (production code) with a `Disconnect`.
  - (b) `idle_loop_disconnect_cancels_and_exits` — the idle-wait loop is inline in `connect_and_register` (needs gRPC transport to test directly), so **mirror the existing repo pattern** `idle_wait_survives_repeated_pings` (`client.rs:303`, which re-implements the loop body inline over a channel): feed a `Disconnect` message, assert the loop returns `Err(WorkerError::Cancelled)` and `cancel.is_cancelled()`. (Match that test's structure exactly — same inline-loop technique the repo already uses for the idle path.)
```rust
#[tokio::test]
async fn forward_inbound_disconnect_cancels_process_token() {
    use tokio_util::sync::CancellationToken;
    let (in_tx, in_rx) = mpsc::channel::<Result<ServerMessage, tonic::Status>>(4);
    let (fwd_tx, _fwd_rx) = mpsc::channel::<ServerMessage>(4);
    let (out_tx, _out_rx) = mpsc::channel::<WorkerMessage>(4);
    let cancel = CancellationToken::new();
    let stream = tokio_stream::wrappers::ReceiverStream::new(in_rx);
    in_tx.send(Ok(ServerMessage {
        payload: Some(ServerPayload::Disconnect(pb::Disconnect { reason: "test".into() })),
    })).await.unwrap();
    drop(in_tx);
    forward_inbound(stream, fwd_tx, Arc::new(AtomicBool::new(false)), out_tx, cancel.clone()).await;
    assert!(cancel.is_cancelled(), "Disconnect cancels the process token");
}
```
(Use whatever `ServerMessage`/`ServerPayload`/`pb` import path the file already uses; if `pb::Disconnect` differs, match the generated path. `tokio_stream` is already a dep for `ReceiverStream`.)

- [ ] **Step 3: Run, verify fail** — `cargo build -p handicap-controller && cargo test -p handicap-worker-core --lib forward_inbound_disconnect -- --nocapture` → FAIL (no `Disconnect`, signature mismatch).

- [ ] **Step 4: Implement worker handling.**

`forward_inbound` (52): add trailing param + Disconnect arm.
```rust
async fn forward_inbound<S>(
    mut inbound: S,
    fwd_tx: mpsc::Sender<ServerMessage>,
    shutdown: Arc<AtomicBool>,
    out_tx: mpsc::Sender<WorkerMessage>,
    cancel: CancellationToken,
) where S: futures::Stream<Item = Result<ServerMessage, tonic::Status>> + Unpin {
    while let Some(msg) = inbound.next().await {
        match msg {
            Ok(m) => {
                if let Some(ServerPayload::Disconnect(d)) = &m.payload {
                    warn!(reason = %d.reason, "controller requested disconnect; exiting");
                    cancel.cancel();   // cancels run_pool's process token → loop breaks, no reconnect
                    break;
                }
                if let Some(ServerPayload::Ping(p)) = &m.payload {
                    let _ = out_tx.send(WorkerMessage {
                        payload: Some(WorkerPayload::Pong(Pong { nonce: p.nonce })),
                    }).await;
                    continue;
                }
                tracing::debug!(?m.payload, "controller msg");
                if fwd_tx.send(m).await.is_err() { break; }
            }
            Err(e) => { /* unchanged */ }
        }
    }
}
```
Spawn site (164): pass `cancel.clone()` (the `connect_and_register` `cancel: &CancellationToken` param):
```rust
let fwd_handle = tokio::spawn(forward_inbound(
    inbound, fwd_tx, shutdown.clone(), tx.clone(), cancel.clone(),
));
```
Idle-wait loop (139–154): add a `Disconnect` arm before `other =>`:
```rust
Some(ServerPayload::Disconnect(d)) => {
    warn!(reason = %d.reason, "controller requested disconnect while idle; exiting");
    cancel.cancel();
    return Err(WorkerError::Cancelled);
}
```
`#[cfg(test)]` forward_inbound call sites (the `forward_tests` module, ~2 sites): add a `CancellationToken::new()` (or a shared one) as the new last arg so they compile.

Add `use tokio_util::sync::CancellationToken;` to the test module if not already imported at file scope (it is used by `connect_and_register`).

- [ ] **Step 5: Run gate** — `cargo build -p handicap-worker --bin worker && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo nextest run --workspace` → PASS.

- [ ] **Step 6: Commit:**
```bash
git add crates/proto/proto/coordinator.proto crates/worker-core/src/client.rs
git commit -m "feat(lan-l7/t2): proto Disconnect(field 5) + 워커 두 사이트 종료 처리 (R5,R7)"
git log -1
```

---

### Task 3: 컨트롤러 exclude/control mutator + REST 엔드포인트

**충족 R: R6, R8**

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (new `pool_set_control`, `pool_exclude` near `pool_disconnect` 433)
- Modify: `crates/controller/src/api/pool.rs` (new `patch_worker`, `exclude_worker` + request structs + `deserialize_some` helper)
- Modify: `crates/controller/src/app.rs` (2 routes near the existing `/pool/workers` GET)
- Test: 인라인 `#[cfg(test)]` in `coordinator.rs`

**Interfaces:**
- Consumes: `ServerPayload::Disconnect`/`pb::Disconnect` (Task 2); `PoolWorkerSummary` (Task 1).
- Produces: `pool_set_control(worker_id, drained: Option<bool>, capacity_override: Option<Option<u32>>, label: Option<Option<String>>) -> bool`; `pool_exclude(worker_id, reason) -> bool`; routes `PATCH /api/pool/workers/{id}`, `POST /api/pool/workers/{id}/exclude`.

- [ ] **Step 1: Write failing coordinator tests.**
```rust
#[tokio::test]
async fn pool_set_control_partial_update_and_404() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx, 10, "h".into()).await;
    assert!(st.pool_set_control("w1", Some(true), Some(Some(5)), Some(Some("pc".into()))).await);
    {
        let g = st.pool.lock().await;
        let e = g.get("w1").unwrap();
        assert!(e.drained); assert_eq!(e.capacity_override, Some(5)); assert_eq!(e.label.as_deref(), Some("pc"));
    }
    // partial: only undrain; clear override; leave label
    assert!(st.pool_set_control("w1", Some(false), Some(None), None).await);
    {
        let g = st.pool.lock().await;
        let e = g.get("w1").unwrap();
        assert!(!e.drained); assert_eq!(e.capacity_override, None); assert_eq!(e.label.as_deref(), Some("pc"));
    }
    assert!(!st.pool_set_control("missing", Some(true), None, None).await, "404 → false");
}

#[tokio::test]
async fn pool_exclude_idle_removes_and_busy_fails_run() {
    let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
    let (tx, mut rx) = tokio::sync::mpsc::channel(32);
    st.pool_register_idle("w1", tx, 10, "h".into()).await;
    assert!(st.pool_exclude("w1", "maintenance").await);
    assert_eq!(st.pool_idle_count().await, 0, "removed from pool");
    // a Disconnect was pushed
    let msg = rx.try_recv().expect("Disconnect pushed");
    assert!(matches!(msg.unwrap().payload, Some(ServerPayload::Disconnect(_))));
    assert!(!st.pool_exclude("missing", "x").await, "404 → false");
}
```
(For a busy-worker terminal-routing assertion, rely on the existing `worker_disconnected`/terminal-guard tests + live-verify; the unit test above covers idle remove + Disconnect push + 404.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement mutators** in `coordinator.rs` (after `pool_disconnect`):
```rust
/// Apply operator control to a pool worker. Each Some(...) is applied; None
/// leaves that field unchanged; Some(None) clears an Option field. Returns
/// false if the worker_id is not in the pool. (spec R8)
pub async fn pool_set_control(
    &self,
    worker_id: &str,
    drained: Option<bool>,
    capacity_override: Option<Option<u32>>,
    label: Option<Option<String>>,
) -> bool {
    let mut g = self.pool.lock().await;
    let Some(e) = g.get_mut(worker_id) else { return false };
    if let Some(d) = drained { e.drained = d; }
    if let Some(c) = capacity_override { e.capacity_override = c; }
    if let Some(l) = label { e.label = l; }
    true
}

/// Hard-remove a pool worker and ask it to exit. Busy → existing fail-fast
/// (run failed); the worker's later Aborted/drop is absorbed by the terminal
/// guard. Push Disconnect via try_send (non-blocking; R14). Returns false if
/// not in pool. (spec R6)
pub async fn pool_exclude(&self, worker_id: &str, reason: &str) -> bool {
    let captured = {
        let mut g = self.pool.lock().await;
        g.remove(worker_id).map(|e| (e.tx, e.assigned_run))
    };
    let Some((tx, assigned)) = captured else { return false };
    if let Some(run_id) = assigned {
        self.worker_disconnected(&run_id, worker_id).await;
    }
    let _ = tx.try_send(Ok(ServerMessage {
        payload: Some(ServerPayload::Disconnect(pb::Disconnect { reason: reason.to_string() })),
    }));
    true
}
```

- [ ] **Step 4: Implement REST** in `api/pool.rs` (use the repo's `ApiError` for consistency — `NotFound` → 404 body `{"error":"not found"}`, `BadRequest(String)` → 400):
```rust
use axum::{extract::Path, http::StatusCode};
use serde::{Deserialize, Deserializer};
use crate::error::ApiError;

/// serde helper: distinguish absent (→ None) from present-null (→ Some(None)).
fn deserialize_some<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where T: Deserialize<'de>, D: Deserializer<'de> {
    T::deserialize(d).map(Some)
}

#[derive(Deserialize)]
pub struct PatchWorkerReq {
    #[serde(default)]
    drained: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_some")]
    capacity_override: Option<Option<u32>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    label: Option<Option<String>>,
}

#[derive(Deserialize, Default)]
pub struct ExcludeReq {
    #[serde(default)]
    reason: Option<String>,
}

const CAPACITY_OVERRIDE_MAX: u32 = 1_000_000;
const LABEL_MAX_LEN: usize = 200;

/// PATCH /api/pool/workers/{id} — partial control update. (spec R8)
pub async fn patch_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PatchWorkerReq>,
) -> Result<Json<PoolWorkerSummary>, ApiError> {
    if let Some(Some(c)) = req.capacity_override {
        if !(1..=CAPACITY_OVERRIDE_MAX).contains(&c) {
            return Err(ApiError::BadRequest("capacity_override out of range (1..=1000000)".into()));
        }
    }
    if let Some(Some(l)) = &req.label {
        if l.chars().count() > LABEL_MAX_LEN {
            return Err(ApiError::BadRequest("label too long (max 200)".into()));
        }
    }
    if !state.coord.pool_set_control(&id, req.drained, req.capacity_override, req.label).await {
        return Err(ApiError::NotFound);
    }
    // return the updated summary
    let summary = state.coord.pool_snapshot(tokio::time::Instant::now()).await
        .into_iter().find(|i| i.worker_id == id)
        .map(|i| PoolWorkerSummary {
            worker_id: i.worker_id, hostname: i.hostname, capacity_vus: i.capacity_vus,
            busy: i.assigned_run.is_some(), run_id: i.assigned_run,
            last_seen_secs_ago: i.last_seen_secs_ago,
            drained: i.drained, capacity_override: i.capacity_override, label: i.label,
        })
        .ok_or(ApiError::NotFound)?;
    Ok(Json(summary))
}

/// POST /api/pool/workers/{id}/exclude — hard remove + worker exit. (spec R6/R8)
pub async fn exclude_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ExcludeReq>,
) -> Result<StatusCode, ApiError> {
    let reason = req.reason.unwrap_or_default();
    if state.coord.pool_exclude(&id, &reason).await {
        Ok(StatusCode::OK)
    } else {
        Err(ApiError::NotFound)
    }
}
```

`app.rs`: register routes alongside the existing `GET /pool/workers` (axum 0.8 `{id}` syntax). Import `patch`, `post` from `axum::routing`:
```rust
.route("/pool/workers/{id}", axum::routing::patch(pool_api::patch_worker))
.route("/pool/workers/{id}/exclude", axum::routing::post(pool_api::exclude_worker))
```
(Find the existing `.route("/pool/workers", get(pool_api::list_workers))` line ~142 and add the two below it. Note: the route chain ends with `;` — keep the `;` on the last `.route(...)` line.)

- [ ] **Step 5: Run gate** (full workspace) → PASS.

- [ ] **Step 6: Commit:**
```bash
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/api/pool.rs crates/controller/src/app.rs
git commit -m "feat(lan-l7/t3): pool_set_control·pool_exclude + PATCH/exclude REST (R6,R8)"
git log -1
```

- [ ] **Step 7: curl smoke (manual, optional before T4):** start a pool controller + 1 worker (see `/live-verify`), then:
  - `curl -X PATCH …/api/pool/workers/<id> -d '{"drained":true}'` → 200 updated summary `drained:true`.
  - `curl -X PATCH … -d '{"capacity_override":2000000}'` → 400.
  - `curl -X PATCH …/missing -d '{}'` → 404.
  - `curl -X POST …/api/pool/workers/<id>/exclude -d '{"reason":"x"}'` → 200, worker process exits.

---

### Task 4: UI — Zod·hooks·대시보드 액션/배지/확인창/경고 + RunDialog 프리뷰

**충족 R: R4, R9(Zod 측), R10, R11, R12**

**Files:**
- Modify: `ui/src/api/pool.ts` (Zod + `patchPoolWorker`/`excludePoolWorker`)
- Modify: `ui/src/api/hooks.ts` (`usePatchPoolWorker`, `useExcludePoolWorker`)
- Modify: `ui/src/pages/WorkerDashboardPage.tsx` (per-row actions, badge, modals, confirms)
- Modify: `ui/src/components/RunDialog.tsx` (preview filter, lines ~543–546)
- Modify: `ui/src/i18n/ko.ts` (`ko.workers.*` 확장; **`ko.workers.subtitle`의 "(읽기 전용)" 문구만 제거** — 이제 쓰기 동작 추가. 무관한 다른 "(읽기 전용)" 문자열 2곳[`envBaseFrom`·`readonlySection`]은 건드리지 말 것 — blanket grep-replace 금지)
- Test: `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx` (parse-through fixtures — 3 신규 필드 필수) + `ui/src/components/__tests__/RunDialog.test.tsx` (`mockPoolWorkers` 팩토리들·any-typed라 parse 안 깨지지만 drained-제외 테스트 fixture에 3필드 추가)

**Interfaces:**
- Consumes: REST `PATCH /api/pool/workers/{id}` (body `{drained?, capacity_override?, label?}`), `POST /api/pool/workers/{id}/exclude` (body `{reason?}`), DTO fields `drained`/`capacity_override`/`label`.

- [ ] **Step 1: Zod + client** (`pool.ts`). Add to `PoolWorkerSummarySchema` (`.nullable()` per Global Constraints):
```ts
  drained: z.boolean(),
  capacity_override: z.number().nullable(),
  label: z.string().nullable(),
```
Add clients:
```ts
export async function patchPoolWorker(
  id: string,
  body: { drained?: boolean; capacity_override?: number | null; label?: string | null },
): Promise<PoolWorkerSummary> {
  const res = await fetch(`${BASE}/pool/workers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch worker ${res.status}`);
  return PoolWorkerSummarySchema.parse(await res.json());
}
export async function excludePoolWorker(id: string, reason: string): Promise<void> {
  const res = await fetch(`${BASE}/pool/workers/${encodeURIComponent(id)}/exclude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`exclude worker ${res.status}`);
}
```

- [ ] **Step 2: hooks** (`hooks.ts`) — mutations that invalidate the pool query (match the existing `usePoolWorkers` query key):
```ts
export function usePatchPoolWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof patchPoolWorker>[1] }) =>
      patchPoolWorker(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.poolWorkers() }),
  });
}
export function useExcludePoolWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => excludePoolWorker(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.poolWorkers() }),
  });
}
```
(Use the actual query key string `usePoolWorkers` registers — read it in `hooks.ts` first and match exactly.)

- [ ] **Step 3: ko.ts strings** — extend `ko.workers` (warning copy = R11 보완 통제):
```ts
  // actions
  actionsLabel: "동작",
  drain: "비우기",
  undrain: "되돌리기",
  exclude: "제외",
  editCapacity: "용량 조정",
  editLabel: "메모",
  // badges / columns
  drainedBadge: "비우는 중",
  colLabel: "메모",
  capacityManual: (n: number) => `${n} (수동)`,
  // drain confirm (reversible)
  drainConfirmTitle: "워커 비우기",
  drainConfirmBody: "이 워커에 새 작업 배정을 중단합니다. 진행 중인 작업은 그대로 끝까지 실행되고, 언제든 ‘되돌리기’로 복구할 수 있습니다.",
  // exclude confirm (destructive)
  excludeConfirmTitle: "워커 제외",
  excludeConfirmBody: "이 워커를 풀에서 제외하고 워커 프로그램을 종료합니다. 다시 추가하려면 해당 PC에서 워커를 직접 재실행해야 합니다.",
  excludeBusyWarn: (runId: string) => `주의: 이 워커는 현재 run ${runId}을(를) 실행 중입니다. 제외하면 그 run이 실패합니다.`,
  // edit modals (apply note)
  capacityApplyNote: "변경한 용량은 새 run의 부하 배분 계산에 즉시 반영됩니다.",
  labelApplyNote: "메모는 표시용이며 부하에는 영향이 없습니다.",
  confirmProceed: "계속",
  cancel: "취소",
  apply: "적용",
  // preview note for drained workers in RunDialog
  poolPreviewDrained: (n: number) => `(비우는 중 ${n}대 제외)`,
```

- [ ] **Step 4: WorkerDashboardPage tests** (write first — TDD). Use the existing test scaffolding/fixtures; build a `PoolWorkersResponse` fixture that now includes `drained`/`capacity_override`/`label` (update ALL existing fixtures in this file + any shared fixture so Zod `.parse` passes — FR3). Assertions:
```ts
it("shows drained badge and manual-capacity annotation", async () => {
  // fixture: w1 drained:true, capacity_override:5
  // expect getByText("비우는 중") and getByText("5 (수동)")
});
it("exclude of a busy worker shows a run-failure warning in the confirm", async () => {
  // fixture: w2 busy:true, run_id:"r9"
  // click ⋯ → 제외 → confirm dialog contains "run r9" and "실패"
});
it("drain confirm explains it is reversible (no run failure)", async () => {
  // click ⋯ → 비우기 → dialog contains "되돌리기" and does NOT warn about failure
});
it("applying drain calls PATCH and invalidates", async () => {
  // mock fetch PATCH 200; click 비우기 → 계속 → expect fetch called with {drained:true}
});
```

- [ ] **Step 5: WorkerDashboardPage implementation.** Per row, add an actions cell (kebab `⋯` menu or inline buttons — follow the page's existing table style). Wire:
  - **Drain/Undrain**: if `!w.drained` show "비우기" → open a confirm dialog (`drainConfirmTitle`/`drainConfirmBody`, buttons 계속/취소) → on 계속 `patch.mutate({id, body:{drained:true}})`. If `w.drained` show "되돌리기" → `patch.mutate({id, body:{drained:false}})` (no confirm needed — restoring is safe).
  - **용량 조정**: open a small modal with a number input (prefill `w.capacity_override ?? ""`) + `capacityApplyNote` + 적용/취소. 적용 → `patch.mutate({id, body:{capacity_override: val === "" ? null : Number(val)}})`. (empty = clear → null.)
  - **메모**: modal with a text input (prefill `w.label ?? ""`) + `labelApplyNote` + 적용/취소 → `patch.mutate({id, body:{label: val === "" ? null : val}})`.
  - **제외**: confirm dialog (`excludeConfirmTitle`/`excludeConfirmBody`); if `w.busy` append `excludeBusyWarn(w.run_id)` (amber). 계속 → `exclude.mutate({id, reason:""})`.
  - **Badge/columns**: render `drainedBadge` (amber pill) when `w.drained`; render capacity cell as `capacityManual(w.capacity_override)` when override set (else plain `w.capacity_vus`); add a `colLabel` column showing `w.label ?? ""`.
  - All confirm dialogs/modals: use the page's existing dialog primitive if any, else a simple `role="dialog"` with `role="alertdialog"` for the destructive exclude (a11y). Reuse the RunDialog 409 confirm pattern for consistency.

- [ ] **Step 6: RunDialog preview** (`RunDialog.tsx` ~543–546) — exclude drained + effective capacity (R4):
```ts
const idle = pool.data.workers.filter((w) => !w.drained && !w.busy);
const idleCapacity = idle.reduce(
  (sum, w) => sum + Math.max(w.capacity_override ?? w.capacity_vus, 1), 0);
const drainedCount = pool.data.workers.filter((w) => w.drained && !w.busy).length;
```
And in the preview `<p>`, optionally append `drainedCount > 0 ? " " + ko.workers.poolPreviewDrained(drainedCount) : ""`. Add/adjust a RunDialog test asserting a drained worker is excluded from the previewed idle count + capacity.

- [ ] **Step 7: UI gate** — `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-worker-control/ui && pnpm lint && pnpm test && pnpm build` → all PASS (fix any fixture missing the 3 new fields — FR3).

- [ ] **Step 8: Commit:**
```bash
git add ui/src/api/pool.ts ui/src/api/hooks.ts ui/src/pages/WorkerDashboardPage.tsx ui/src/components/RunDialog.tsx ui/src/i18n/ko.ts ui/src/pages/__tests__/WorkerDashboardPage.test.tsx
git commit -m "feat(lan-l7/t4): 대시보드 제어 액션/배지/확인창/경고 + RunDialog 프리뷰 (R4,R9,R10,R11,R12)"
git log -1
```

---

### Task 5: 라이브 검증 + 마무리

**충족 R: R4, R6, R7, R8, R10 라이브 (S-D 갭 차단)**

- [ ] **Step 1: `/live-verify`** — 실 pool 컨트롤러 + 워커 2대(짧은 하트비트 임계값) + 50ms responder + 격리 DB. 확인:
  - **drain**: PATCH drain w1 → `/workers` "비우는 중" 배지, RunDialog 프리뷰 유휴/용량에서 w1 제외, capacity 부족 시 409 achievable이 w1을 뺀 값.
  - **capacity override**: PATCH override w2=4 → 프리뷰·409 achievable에 반영.
  - **exclude idle**: POST exclude w1 → 워커 프로세스 exit, 재등록 0(로그), `/workers`에서 사라짐.
  - **exclude busy**: run 시작 후 그 워커 exclude → run `failed` 단일 terminal(double-terminal·영영-running 0), 워커 exit.
  - **Playwright 3표면**: 액션 메뉴·배지·exclude busy 경고 카피·drain 확인창·Zod 콘솔 0.
- [ ] **Step 2:** Playwright/responder 잔여 정리(`rm -rf .playwright-mcp` + 루트 png).
- [ ] **Step 3: `handicap-reviewer`** (최종 크로스커팅·wire 1:1) + **`security-reviewer`**(제어 엔드포인트 무인증 자세 R13·시크릿 비노출·경고 통제). findings는 `receiving-code-review`로 평가 후 반영/기각.
- [ ] **Step 4: `/finish-slice`** — build-log·roadmap·CLAUDE 상태줄·메모리 기록 → ff-merge → ExitWorktree.

---

## Self-Review (writing-plans)

- **Spec coverage**: R1(T1 PoolEntry)·R2(T1 register)·R3(T1 guards)·R4(T4 preview)·R5(T2 proto)·R6(T3 pool_exclude)·R7(T2 worker)·R8(T3 REST)·R9(T1 DTO + T4 Zod)·R10(T4 actions/badge/confirm)·R11(T4 warnings)·R12(T4 ko.ts)·R13(T5 security-reviewer)·R14(every cargo gate + T5 live byte-identical). All R covered.
- **Dead-code gate**: T1's new methods/fields are read by existing callers (guards←spawn_run) or serde (DTO); T3's `pool_set_control`/`pool_exclude` are called by REST handlers (non-test) in the same commit → no `#[cfg(test)]`-only `pub(crate)` dead-code error. T1 drain tests mutate fields under the in-module pool lock (no mutator needed yet).
- **Type consistency**: `effective_capacity_vus`, `pool_set_control(Option<bool>, Option<Option<u32>>, Option<Option<String>>)`, `pool_exclude(&str,&str)->bool`, `PoolWorkerSummary` 3 fields, Zod `.nullable()` — names/types match across tasks.
- **Order**: T1→T2→T3 (T3 uses T2's Disconnect)→T4 (uses T1 DTO + T3 REST)→T5.

---

<!-- REVIEW-GATE: APPROVED -->
REVIEW-GATE: APPROVED

> spec-plan-reviewer: spec clean APPROVE (round 2) + plan clean APPROVE (round 2 confirmation). 2026-06-22.
