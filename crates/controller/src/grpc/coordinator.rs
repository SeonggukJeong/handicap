use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::Stream;
use tokio::sync::Mutex;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status, Streaming};
use tracing::{error, info, warn};

use handicap_proto::v1 as pb;
use pb::coordinator_server::Coordinator;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{AbortRun, Profile, RunAssignment, ServerMessage, WorkerMessage};

use crate::binding::Mapping;
use crate::dispatcher::SharedDispatcher;
use crate::grpc::shard::{self, shard_split};
use crate::store::Db;
use crate::store::runs::{self, RunStatus};

const DATASET_BATCH_ROWS: i64 = 1000;

/// Default per-worker VU capacity used to derive the worker count N. Overridable
/// via the controller's `--worker-capacity-vus` flag (spec §2.1).
pub const DEFAULT_WORKER_CAPACITY_VUS: u32 = 2000;

/// How long to wait for all N workers to register before failing the run
/// fast (spec §8.3). Aligned with worker-core `reconnect::TOTAL_CAP` (60s).
/// In tests a shorter value lets `watchdog_fires_after_deadline` use a real
/// (non-paused) timer without burning wall-clock seconds — sqlx pool management
/// uses `tokio::time::timeout` internally, so `start_paused` causes PoolTimedOut.
#[cfg(not(test))]
const REGISTRATION_DEADLINE: Duration = Duration::from_secs(60);
#[cfg(test)]
const REGISTRATION_DEADLINE: Duration = Duration::from_millis(200);

// ---- PendingDataBinding / PendingAssignment (unchanged) ----

#[derive(Debug, Clone)]
pub struct PendingDataBinding {
    pub dataset_id: String,
    pub policy: pb::data_binding::Policy,
    pub seed: u32,
    pub mappings: Vec<Mapping>,
    pub row_count: u64,
}

/// One worker's resolved dataset stream for ONE binding: which rows to fetch +
/// the mappings to apply + which binding it is. For unique these are a disjoint
/// slice (`offset_i..offset_i+count_i`); for replicated policies it's the whole
/// dataset (`offset 0`). `binding_index` tags the emitted `DatasetBatch` so the
/// worker routes rows to the right binding. (spec §4.4)
struct WorkerStream {
    dataset_id: String,
    mappings: Vec<Mapping>,
    offset: u64,
    count: u64,
    binding_index: u32,
}

/// Worker-common base for a run's assignment (scenario/profile/env/bindings).
/// Per-worker shard fields are filled at register time. `data_bindings` is the
/// full ordered list of N independent bindings (the legacy single binding is
/// folded to a 1-element vec upstream).
#[derive(Debug, Clone)]
pub struct PendingAssignment {
    pub scenario_yaml: String,
    pub profile: Profile,
    pub env: HashMap<String, String>,
    pub data_bindings: Vec<PendingDataBinding>,
}

type WorkerTx = tokio::sync::mpsc::Sender<Result<ServerMessage, Status>>;

/// An idle (or assigned) pool worker registered without a run_id. (LAN L1, R5.)
struct PoolEntry {
    /// Consumed by `assign_pool_workers` to push RunAssignment.
    tx: WorkerTx,
    /// Worker-declared capacity (VUs). Used by `effective_capacity_vus()`.
    /// L1 stores this but does NOT enforce it (no overload guard in L1 — see
    /// the runbook over-capacity warning). L2+ use it via capacity math.
    capacity_vus: u32,
    /// Worker machine hostname (display-only; "" if unset). LAN L2.
    hostname: String,
    /// Set by `reserve_idle_pool` when the worker is assigned to a run.
    /// `None` = idle; `Some(run_id)` = busy. Reset to `None` on re-register (R13).
    assigned_run: Option<String>,
    /// Last time we heard from this worker (Pong/MetricBatch/RunStatus/re-Register).
    /// Reaper evicts entries older than the stale timeout. (LAN L6, R1.)
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

/// Display snapshot of one pool worker — returned by `pool_snapshot` (LAN L2 R1).
/// `tx` is intentionally absent; callers only see display fields.
#[derive(Debug, Clone)]
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

/// One connected worker's slot in a run.
struct WorkerEntry {
    shard_index: u32,
    vu_offset: u32,
    vu_count: u32,
    tx: WorkerTx,
    phase: pb::run_status::Phase,
}

/// Per-run coordination state across N workers (replaces single-assignment
/// pending+active maps). (Spec §2.3.)
struct RunWorkers {
    base: PendingAssignment,
    expected: u32,
    total_vus: u32,
    next_shard: u32,
    workers: HashMap<String, WorkerEntry>,
    reg_deadline: CancellationToken,
    terminal: bool,
    /// Per-shard (vu_offset, vu_count) precomputed by the capacity-aware pool
    /// path. `None` → `register` falls back to even `shard_split` (legacy/open/
    /// curve/force, byte-identical L1). (spec R2/R5.)
    precomputed_counts: Option<Vec<(u32, u32)>>,
}

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

/// Outcome of a Register, returned to the stream handler to drive I/O.
#[derive(Debug)]
pub enum RegisterOutcome {
    /// New worker got a shard. `first` = this is the first registrant (set Running).
    Assigned {
        shard_index: u32,
        shard_count: u32,
        vu_offset: u32,
        vu_count: u32,
        first: bool,
    },
    /// Same worker re-registered: resend its existing shard (idempotent).
    Resend {
        shard_index: u32,
        shard_count: u32,
        vu_offset: u32,
        vu_count: u32,
    },
    /// Over-registration or already-terminal run: reply AbortRun, give no shard.
    Reject,
    /// No such run (never enqueued / already removed): break the stream.
    NoRun,
}

#[derive(Clone)]
pub struct CoordinatorState {
    pub db: Db,
    runs: Arc<Mutex<HashMap<String, RunWorkers>>>,
    /// Set once at startup (main.rs) so finalize paths can tear down K8s Jobs /
    /// child processes. Unset in unit/e2e tests → cleanup is a no-op. (A3c spec §7,
    /// §8.) Interior mutability so all clones (AppState.coord, CoordinatorService)
    /// share the same handle regardless of construction order.
    dispatcher: Arc<OnceLock<SharedDispatcher>>,
    /// Set once at startup via `--worker-token`. When set, incoming `Register.token`
    /// must match exactly. When unset (None), any token is accepted (no auth). LAN L1.
    worker_token: Arc<OnceLock<String>>,
    /// Persistent pool of workers that registered without a run_id (LAN L1, R5).
    /// Keyed by worker_id. Task 3's `reserve_idle_pool`/`assign_pool_workers` draw
    /// from here; `pool_disconnect` routes busy-worker disconnects to the existing
    /// fail-fast (R8).
    pool: Arc<Mutex<HashMap<String, PoolEntry>>>,
    /// Set once at startup when `--worker-mode pool`. When true, `spawn_run` uses
    /// the pool path (reserve_idle_pool + assign_pool_workers) instead of dispatcher.
    pool_mode: Arc<OnceLock<bool>>,
}

impl CoordinatorState {
    /// Build a coordinator. Worker capacity is no longer the coordinator's
    /// concern — `SettingsState` (AppState) is the single authority and the
    /// run-create path computes N from `shard::worker_count(total_vus, capacity)`.
    pub fn new(db: Db) -> Self {
        Self {
            db,
            runs: Arc::new(Mutex::new(HashMap::new())),
            dispatcher: Arc::new(OnceLock::new()),
            worker_token: Arc::new(OnceLock::new()),
            pool: Arc::new(Mutex::new(HashMap::new())),
            pool_mode: Arc::new(OnceLock::new()),
        }
    }

    /// Install the dispatcher handle so finalize paths can clean up. Called once
    /// at startup. Idempotent (later sets are ignored).
    pub fn set_dispatcher(&self, dispatcher: SharedDispatcher) {
        let _ = self.dispatcher.set(dispatcher);
    }

    /// Install the required worker token (startup, once). None = no auth.
    /// All clones share the same OnceLock so this is set-once across the process.
    pub fn set_worker_token(&self, token: Option<String>) {
        if let Some(t) = token {
            let _ = self.worker_token.set(t);
        }
    }

    /// True if `presented` matches the configured token (or no token configured).
    /// Plain string compare: the L1 channel is plaintext so timing-safe compare
    /// is not meaningful here (spec R3/§3.6 scope is transport, not HMAC).
    pub fn check_token(&self, presented: &str) -> bool {
        match self.worker_token.get() {
            None => true,
            Some(expected) => expected == presented,
        }
    }

    /// Activate pool dispatch mode (set once at startup via `--worker-mode pool`).
    /// All clones share the same OnceLock so this is set-once across the process.
    pub fn set_pool_mode(&self, on: bool) {
        let _ = self.pool_mode.set(on);
    }

    /// True when running in pool mode (`--worker-mode pool`). spawn_run uses the
    /// pool path (reserve_idle_pool + assign_pool_workers) instead of dispatcher.
    pub fn is_pool_mode(&self) -> bool {
        *self.pool_mode.get().unwrap_or(&false)
    }

    /// Atomically (under the pool lock) reserve up to `cap` idle workers for
    /// `run_id`: mark each `assigned_run = Some(run_id)` (reservation LOCK —
    /// stops a concurrent launch from grabbing the same worker) and return
    /// (worker_id, tx) for each. (R6/R13.)
    pub async fn reserve_idle_pool(&self, run_id: &str, cap: usize) -> Vec<(String, WorkerTx)> {
        let mut g = self.pool.lock().await;
        let ids: Vec<String> = g
            .iter()
            .filter(|(_, e)| e.assigned_run.is_none() && !e.drained)
            .map(|(id, _)| id.clone())
            .take(cap)
            .collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(e) = g.get_mut(&id) {
                e.assigned_run = Some(run_id.to_string()); // 예약 락(같은 guard 내 원자적)
                out.push((id, e.tx.clone()));
            }
        }
        out
    }

    /// Push assignments to reserved pool workers, reusing register()/assignment_for()/
    /// stream_dataset(). On a closed tx (worker vanished between reserve and push),
    /// return Err so the caller fails the run fast (R7) — not the 60s watchdog.
    pub async fn assign_pool_workers(
        &self,
        run_id: &str,
        reserved: Vec<(String, WorkerTx)>,
    ) -> Result<(), ()> {
        for (worker_id, tx) in reserved {
            let outcome = self.register(run_id, &worker_id, tx.clone()).await;
            let (shard_index, shard_count, vu_offset, vu_count, set_running) = match outcome {
                RegisterOutcome::Assigned {
                    shard_index,
                    shard_count,
                    vu_offset,
                    vu_count,
                    first,
                } => (shard_index, shard_count, vu_offset, vu_count, first),
                // 풀 발사에선 일어나지 않아야 함(예약 수==expected). 방어적으로 실패.
                _ => return Err(()),
            };
            let Some((assignment, streams)) = self
                .assignment_for(
                    run_id,
                    &worker_id,
                    shard_index,
                    shard_count,
                    vu_offset,
                    vu_count,
                )
                .await
            else {
                return Err(());
            };
            if tx
                .send(Ok(ServerMessage {
                    payload: Some(ServerPayload::Assignment(assignment)),
                }))
                .await
                .is_err()
            {
                // 워커 이탈 → 즉시 fail-fast (R7) — assigned_run은 reserve가 이미 Some
                return Err(());
            }
            if set_running {
                let _ = runs::set_status(
                    &self.db,
                    run_id,
                    RunStatus::Running,
                    Some(crate::store::now_ms()),
                    None,
                )
                .await;
            }
            for ws in &streams {
                if ws.count > 0 && !stream_dataset(self, &tx, run_id, ws).await {
                    break;
                }
            }
        }
        Ok(())
    }

    /// Register (or refresh, on reconnect) an idle pool worker. Idempotent on
    /// worker_id: replaces tx/capacity/hostname and RESETS assigned_run to None (R13
    /// reuse). Operator control fields (drained/capacity_override/label) are preserved
    /// across reconnects so operator settings survive transient disconnections. (R2)
    pub async fn pool_register_idle(
        &self,
        worker_id: &str,
        tx: WorkerTx,
        capacity_vus: u32,
        hostname: String,
    ) {
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
                g.insert(
                    worker_id.to_string(),
                    PoolEntry {
                        tx,
                        capacity_vus,
                        hostname,
                        assigned_run: None,
                        last_seen: tokio::time::Instant::now(),
                        drained: false,
                        capacity_override: None,
                        label: None,
                    },
                );
            }
        }
    }

    /// Test/observability helper: count idle (unassigned) pool workers.
    pub async fn pool_idle_count(&self) -> usize {
        self.pool
            .lock()
            .await
            .values()
            .filter(|e| e.assigned_run.is_none())
            .count()
    }

    /// Read-only snapshot of all connected pool workers for the dashboard
    /// (LAN L2 R1). Copies display fields under the lock; never exposes `tx`.
    /// `now` is injected for testability with virtual clocks (LAN L6, R8).
    pub async fn pool_snapshot(&self, now: tokio::time::Instant) -> Vec<PoolWorkerInfo> {
        let g = self.pool.lock().await;
        let mut out: Vec<PoolWorkerInfo> = g
            .iter()
            .map(|(id, e)| PoolWorkerInfo {
                worker_id: id.clone(),
                hostname: e.hostname.clone(),
                capacity_vus: e.capacity_vus,
                assigned_run: e.assigned_run.clone(),
                last_seen_secs_ago: now.saturating_duration_since(e.last_seen).as_secs(),
                drained: e.drained,
                capacity_override: e.capacity_override,
                label: e.label.clone(),
            })
            .collect();
        drop(g);
        out.sort_by(|a, b| {
            (a.hostname.as_str(), a.worker_id.as_str())
                .cmp(&(b.hostname.as_str(), b.worker_id.as_str()))
        });
        out
    }

    /// Stamp a pool worker's last_seen on any inbound message (R1). No-op if the
    /// worker_id is not a pool entry (non-pool stream or already-evicted).
    pub async fn pool_touch(&self, worker_id: &str) {
        if let Some(e) = self.pool.lock().await.get_mut(worker_id) {
            e.last_seen = tokio::time::Instant::now();
        }
    }

    /// One heartbeat sweep (R13, injectable for the virtual-clock unit test):
    /// ping every pool worker, evict any whose last_seen is older than `stale`.
    /// Lock discipline (R14): snapshot (id, tx, is_stale) UNDER the lock with no
    /// `.await`, drop the lock, then do all `.await` (Ping send / pool_disconnect)
    /// outside it. A dead tx (send Err) means the stream is gone → evict (R3).
    pub async fn pool_heartbeat_tick(&self, now: tokio::time::Instant, stale: std::time::Duration) {
        let snapshot: Vec<(String, WorkerTx, bool)> = {
            let g = self.pool.lock().await;
            g.iter()
                .map(|(id, e)| {
                    (
                        id.clone(),
                        e.tx.clone(),
                        now.duration_since(e.last_seen) > stale,
                    )
                })
                .collect()
        };
        for (wid, tx, is_stale) in snapshot {
            if is_stale {
                // idle → silent remove; busy → worker_disconnected fail-fast (R3/R5).
                self.pool_disconnect(&wid).await;
                continue;
            }
            let ping = ServerMessage {
                payload: Some(ServerPayload::Ping(pb::Ping { nonce: 0 })),
            };
            if tx.send(Ok(ping)).await.is_err() {
                self.pool_disconnect(&wid).await;
            }
        }
    }

    /// A pool worker's stream closed. Remove its entry; if it was mid-run
    /// (assigned_run = Some), route to the existing fail-fast which preserves
    /// the terminal-phase guard (no spurious fail after Completed). (R8)
    pub async fn pool_disconnect(&self, worker_id: &str) {
        let assigned = {
            let mut g = self.pool.lock().await;
            g.remove(worker_id).and_then(|e| e.assigned_run)
        };
        if let Some(run_id) = assigned {
            self.worker_disconnected(&run_id, worker_id).await;
        }
    }

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
        let Some(e) = g.get_mut(worker_id) else {
            return false;
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
        let Some((tx, assigned)) = captured else {
            return false;
        };
        if let Some(run_id) = assigned {
            self.worker_disconnected(&run_id, worker_id).await;
        }
        let _ = tx.try_send(Ok(ServerMessage {
            payload: Some(ServerPayload::Disconnect(pb::Disconnect {
                reason: reason.to_string(),
            })),
        }));
        true
    }

    /// Read-only: `(idle_count, Σ achievable capacity)` for the pre-insert 409 check.
    /// `worker_cap` limits how many idle workers are considered (same subset as
    /// `reserve_idle_pool_capacity`). Same floor/sum as the reserve path
    /// (shard::achievable_capacity). (spec R6, L4.)
    pub async fn pool_achievable_capacity(&self, worker_cap: u32) -> (usize, u32) {
        let g = self.pool.lock().await;
        // Sort by worker_id for deterministic subset selection — same order as
        // reserve_idle_pool_capacity so both functions consider the same N workers.
        let mut idle: Vec<(String, u32)> = g
            .iter()
            .filter(|(_, e)| e.assigned_run.is_none() && !e.drained)
            .map(|(id, e)| (id.clone(), e.effective_capacity_vus()))
            .collect();
        idle.sort_by(|a, b| a.0.cmp(&b.0));
        let n = idle.len().min(worker_cap as usize);
        let caps: Vec<u32> = idle.iter().map(|(_, c)| *c).collect();
        (idle.len(), shard::achievable_capacity(&caps[..n]))
    }

    /// Atomically (under the pool lock) reserve idle workers for a run,
    /// capacity-aware. `worker_cap` caps how many workers to use (open-loop:
    /// `pool_worker_cap`; closed: vus). `slot_total` is the concurrency demand
    /// (closed: vus; open: max_in_flight). Branch order is load-bearing: empty
    /// FIRST (idle 0 → existing 400), THEN capacity comparison (closed-loop
    /// vus>=1 so an empty pool's achievable 0 < vus would otherwise mis-route
    /// to Insufficient/500). (spec R2/R3/R6/R7; §4.2; L4.)
    pub async fn reserve_idle_pool_capacity(
        &self,
        run_id: &str,
        worker_cap: u32,
        slot_total: u32,
    ) -> PoolReservation {
        let mut g = self.pool.lock().await;
        let mut idle: Vec<(String, u32)> = g
            .iter()
            .filter(|(_, e)| e.assigned_run.is_none() && !e.drained)
            .map(|(id, e)| (id.clone(), e.effective_capacity_vus()))
            .collect();
        idle.sort_by(|a, b| a.0.cmp(&b.0)); // deterministic selection order
        // 2. Empty FIRST → existing empty-pool 400.
        if idle.is_empty() {
            return PoolReservation::Reserved {
                workers: vec![],
                counts: vec![],
            };
        }
        let caps: Vec<u32> = idle.iter().map(|(_, c)| *c).collect();
        // N = min(idle, worker_cap) — consider only as many workers as the load needs.
        let n = idle.len().min(worker_cap as usize);
        let achievable = shard::achievable_capacity(&caps[..n]);
        // 3. Insufficient (rare post-precheck TOCTOU).
        if achievable < slot_total {
            return PoolReservation::Insufficient { achievable };
        }
        // 4. capacity_split over the n-worker subset; reserve.
        let split = shard::capacity_split(slot_total, &caps[..n]);
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

    /// Release a capacity reservation that was made by `reserve_idle_pool_capacity`
    /// but never promoted to `enqueue` (e.g. unique-floor rejection after reserve).
    /// Resets `assigned_run` to `None` for each worker_id in the reserved list so
    /// they become idle again without needing to disconnect and reconnect. (R14.)
    pub async fn release_pool_reservation(&self, workers: &[(String, WorkerTx)]) {
        let mut g = self.pool.lock().await;
        for (id, _) in workers {
            if let Some(e) = g.get_mut(id) {
                e.assigned_run = None;
            }
        }
    }

    /// Best-effort, idempotent teardown of a run's external workers. No-op if no
    /// dispatcher was installed (tests). Errors are logged, never propagated —
    /// the run is already finalized in the DB.
    async fn cleanup_dispatcher(&self, run_id: &str) {
        if let Some(d) = self.dispatcher.get() {
            if let Err(e) = d.cleanup(run_id).await {
                warn!(%run_id, error = %e, "dispatcher cleanup failed");
            }
        }
    }

    /// Register a run for `expected` workers and spawn the registration
    /// watchdog. Returns the watchdog's cancellation token (cancelled when all
    /// workers register). (Spec §2.3 enqueue, §8.3.)
    pub async fn enqueue(
        &self,
        run_id: String,
        base: PendingAssignment,
        expected: u32,
        total_vus: u32,
        precomputed: Option<Vec<(u32, u32)>>, // NEW: capacity-aware pool counts (Task 2)
    ) -> CancellationToken {
        let token = CancellationToken::new();
        {
            let mut g = self.runs.lock().await;
            g.insert(
                run_id.clone(),
                RunWorkers {
                    base,
                    expected,
                    total_vus,
                    next_shard: 0,
                    workers: HashMap::new(),
                    reg_deadline: token.clone(),
                    terminal: false,
                    precomputed_counts: precomputed,
                },
            );
        }
        let coord = self.clone();
        let token_for_wd = token.clone();
        tokio::spawn(async move {
            registration_watchdog(coord, run_id, REGISTRATION_DEADLINE, token_for_wd).await;
        });
        token
    }

    /// Assign a shard to a registering worker. Pure state mutation; the caller
    /// performs the actual send/stream/DB-Running based on the outcome.
    pub async fn register(&self, run_id: &str, worker_id: &str, tx: WorkerTx) -> RegisterOutcome {
        let mut g = self.runs.lock().await;
        let Some(rw) = g.get_mut(run_id) else {
            return RegisterOutcome::NoRun;
        };
        if rw.terminal {
            return RegisterOutcome::Reject;
        }
        if let Some(e) = rw.workers.get(worker_id) {
            return RegisterOutcome::Resend {
                shard_index: e.shard_index,
                shard_count: rw.expected,
                vu_offset: e.vu_offset,
                vu_count: e.vu_count,
            };
        }
        if rw.next_shard >= rw.expected {
            return RegisterOutcome::Reject;
        }
        let shard_index = rw.next_shard;
        let (vu_offset, vu_count) = match &rw.precomputed_counts {
            Some(counts) => counts[shard_index as usize],
            None => shard_split(rw.total_vus, rw.expected, shard_index),
        };
        rw.next_shard += 1;
        let first = rw.workers.is_empty();
        rw.workers.insert(
            worker_id.to_string(),
            WorkerEntry {
                shard_index,
                vu_offset,
                vu_count,
                tx,
                phase: pb::run_status::Phase::Started,
            },
        );
        if rw.workers.len() as u32 == rw.expected {
            rw.reg_deadline.cancel();
        }
        RegisterOutcome::Assigned {
            shard_index,
            shard_count: rw.expected,
            vu_offset,
            vu_count,
            first,
        }
    }

    /// Read the run's base + a worker's shard so the handler can build the
    /// RunAssignment + stream the dataset after `register`. Returns None if the
    /// run/worker vanished.
    async fn assignment_for(
        &self,
        run_id: &str,
        worker_id: &str,
        shard_index: u32,
        shard_count: u32,
        vu_offset: u32,
        vu_count: u32,
    ) -> Option<(RunAssignment, Vec<WorkerStream>)> {
        let g = self.runs.lock().await;
        let rw = g.get(run_id)?;
        let _ = worker_id;
        let a = &rw.base;
        // Resolve this worker's slice for EACH binding (in order): unique
        // partitions disjointly (its own row_count → its own disjoint slice per
        // worker); replicated policies (per_vu/iter_*) give the whole dataset.
        // The proto DataBinding row_count is the PER-WORKER count (count_i).
        let mut proto_bindings = Vec::with_capacity(a.data_bindings.len());
        let mut streams = Vec::with_capacity(a.data_bindings.len());
        for (i, b) in a.data_bindings.iter().enumerate() {
            let is_unique = b.policy == pb::data_binding::Policy::Unique;
            let (offset, count) =
                crate::grpc::shard::dataset_slice(is_unique, b.row_count, shard_count, shard_index);
            proto_bindings.push(pb::DataBinding {
                policy: b.policy as i32,
                seed: b.seed,
                row_count: count,
            });
            streams.push(WorkerStream {
                dataset_id: b.dataset_id.clone(),
                mappings: b.mappings.clone(),
                offset,
                count,
                binding_index: i as u32,
            });
        }
        let assignment = RunAssignment {
            run_id: run_id.to_string(),
            scenario_yaml: a.scenario_yaml.clone(),
            profile: Some({
                let mut p = a.profile.clone();
                let slot_weights: Option<Vec<u32>> = rw
                    .precomputed_counts
                    .as_ref()
                    .map(|c| c.iter().map(|(_, cnt)| *cnt).collect());
                reduce_pool_profile(
                    &mut p,
                    shard_index,
                    shard_count,
                    vu_count,
                    slot_weights.as_deref(),
                );
                p
            }),
            env: a.env.clone(),
            // Controller writes field 10 (`data_bindings`) only; field 5 stays
            // None. The worker reads field 10 first (Task 4), so a single-binding
            // run travels as `data_bindings=[one]` end-to-end, behaving identically.
            data_binding: None,
            shard_index,
            shard_count,
            vu_offset,
            vu_count,
            data_bindings: proto_bindings,
        };
        Some((assignment, streams))
    }

    /// Record a worker's terminal phase and finalize the run when all workers
    /// agree / any fails. Performs DB writes + sibling AbortRun fan-out
    /// internally. (Spec §8.1, §8.2, §8.5 partial.)
    pub async fn record_phase(&self, run_id: &str, worker_id: &str, phase: i32) {
        use pb::run_status::Phase;
        let completed = Phase::Completed as i32;
        let failed = Phase::Failed as i32;
        let aborted = Phase::Aborted as i32;

        enum Finalize {
            None,
            Completed,
            Failed(Vec<WorkerTx>),
            Aborted,
        }

        let decision = {
            let mut g = self.runs.lock().await;
            let Some(rw) = g.get_mut(run_id) else {
                return;
            };
            if let Some(e) = rw.workers.get_mut(worker_id) {
                e.phase = if phase == completed {
                    Phase::Completed
                } else if phase == failed {
                    Phase::Failed
                } else if phase == aborted {
                    Phase::Aborted
                } else {
                    Phase::Started
                };
            }
            if rw.terminal {
                Finalize::None
            } else if phase == failed {
                rw.terminal = true;
                let siblings: Vec<WorkerTx> = rw
                    .workers
                    .iter()
                    .filter(|(wid, _)| wid.as_str() != worker_id)
                    .map(|(_, e)| e.tx.clone())
                    .collect();
                Finalize::Failed(siblings)
            } else if phase == aborted {
                rw.terminal = true;
                Finalize::Aborted
            } else if phase == completed
                && rw.workers.values().all(|e| e.phase == Phase::Completed)
                && rw.workers.len() as u32 == rw.expected
            {
                rw.terminal = true;
                Finalize::Completed
            } else {
                Finalize::None
            }
        };

        match decision {
            Finalize::None => {}
            Finalize::Completed => {
                let _ = runs::set_status(
                    &self.db,
                    run_id,
                    RunStatus::Completed,
                    None,
                    Some(crate::store::now_ms()),
                )
                .await;
                // 목록/타임라인 배지용 verdict 영속(forward-only 캐시). on-demand /report
                // verdict와 동일 — 같은 evaluate_criteria를 동일한 완료-후 불변 메트릭에 적용.
                // fail-soft: 리포트 빌드 실패는 finalize를 막지 않는다(run은 이미 Completed) —
                // warn! + skip(배지가 NULL로 남을 뿐, run은 Completed).
                match crate::api::runs::build_report_for_run(&self.db, run_id).await {
                    Ok(report) => {
                        if let Some(verdict) = &report.verdict {
                            if let Err(e) = runs::set_verdict(&self.db, run_id, verdict).await {
                                warn!(%run_id, error = %e, "failed to persist verdict badge");
                            }
                        }
                    }
                    Err(e) => {
                        warn!(%run_id, error = %e, "verdict badge skipped: report build failed");
                    }
                }
                self.cleanup_dispatcher(run_id).await;
            }
            Finalize::Aborted => {
                let _ = runs::set_status(
                    &self.db,
                    run_id,
                    RunStatus::Aborted,
                    None,
                    Some(crate::store::now_ms()),
                )
                .await;
                self.cleanup_dispatcher(run_id).await;
            }
            Finalize::Failed(siblings) => {
                let _ = runs::set_status(
                    &self.db,
                    run_id,
                    RunStatus::Failed,
                    None,
                    Some(crate::store::now_ms()),
                )
                .await;
                fan_out_abort(run_id, &siblings, "sibling worker failed — fail-fast").await;
                self.cleanup_dispatcher(run_id).await;
            }
        }
    }

    /// A worker's stream closed. If it never reported a terminal phase and the
    /// run isn't already terminal, fail the run fast + abort siblings. Also
    /// removes the worker from the run map. (Spec §8.2, §2.3 stream close.)
    pub async fn worker_disconnected(&self, run_id: &str, worker_id: &str) {
        use pb::run_status::Phase;
        let siblings = {
            let mut g = self.runs.lock().await;
            let Some(rw) = g.get_mut(run_id) else {
                return;
            };
            let was_terminal_phase = rw
                .workers
                .get(worker_id)
                .map(|e| matches!(e.phase, Phase::Completed | Phase::Failed | Phase::Aborted))
                .unwrap_or(true); // unknown worker → treat as harmless
            if rw.terminal || was_terminal_phase {
                // Terminal worker (or already-finalized run): KEEP its entry so the
                // completion gate (`workers.len() == expected` && all Completed) still
                // counts it. Workers close their stream right after reporting a terminal
                // phase, so removing here would make an N>=2 run never finalize.
                // (A3a: code-review CRITICAL fix.)
                None
            } else {
                // Non-terminal disconnect = crash → fail-fast: drop it + abort siblings.
                rw.workers.remove(worker_id);
                rw.terminal = true;
                Some(
                    rw.workers
                        .values()
                        .map(|e| e.tx.clone())
                        .collect::<Vec<_>>(),
                )
            }
        };
        if let Some(siblings) = siblings {
            let _ = runs::set_status(
                &self.db,
                run_id,
                RunStatus::Failed,
                None,
                Some(crate::store::now_ms()),
            )
            .await;
            fan_out_abort(
                run_id,
                &siblings,
                "worker disconnected before completing — fail-fast",
            )
            .await;
            self.cleanup_dispatcher(run_id).await;
        }
    }

    /// Registration deadline expired: if the run isn't terminal and fewer than
    /// `expected` workers registered, fail it fast + abort whoever did register.
    /// (Spec §8.2 third bullet, §8.3.)
    pub async fn fail_incomplete_registration(&self, run_id: &str) {
        let siblings = {
            let mut g = self.runs.lock().await;
            let Some(rw) = g.get_mut(run_id) else {
                return;
            };
            if rw.terminal || rw.workers.len() as u32 >= rw.expected {
                None
            } else {
                rw.terminal = true;
                Some(
                    rw.workers
                        .values()
                        .map(|e| e.tx.clone())
                        .collect::<Vec<_>>(),
                )
            }
        };
        if let Some(siblings) = siblings {
            let _ = runs::set_status(
                &self.db,
                run_id,
                RunStatus::Failed,
                None,
                Some(crate::store::now_ms()),
            )
            .await;
            fan_out_abort(
                run_id,
                &siblings,
                "not all workers registered before deadline",
            )
            .await;
            self.cleanup_dispatcher(run_id).await;
        }
    }

    /// Tear down a run whose worker dispatch failed before the run could start:
    /// drop the in-memory entry, cancel the registration watchdog (so it doesn't
    /// fire 60s later on an already-failed run), abort any worker that raced in
    /// before dispatch errored (subprocess N≥2 partial spawn), and release
    /// dispatcher resources. The caller marks the run `failed` in the DB. Safe to
    /// call when the run is unknown (idempotent no-op). (codex eval, item 2.)
    pub async fn cancel_dispatch_failed(&self, run_id: &str) {
        let siblings = {
            let mut g = self.runs.lock().await;
            g.remove(run_id).map(|rw| {
                rw.reg_deadline.cancel();
                rw.workers
                    .values()
                    .map(|e| e.tx.clone())
                    .collect::<Vec<_>>()
            })
        };
        if let Some(txs) = siblings {
            fan_out_abort(run_id, &txs, "worker dispatch failed").await;
            self.cleanup_dispatcher(run_id).await;
        }
    }

    /// Send AbortRun to every connected worker of `run_id` (user-initiated
    /// abort). Returns true if at least one worker was reached. (Spec §8.5.)
    ///
    /// NOTE: `cleanup_dispatcher` is intentionally NOT called here. Workers reply
    /// with `Phase::Aborted` → `record_phase` → `Finalize::Aborted` → cleanup; an
    /// unreachable worker is closed by `worker_disconnected` fail-fast → cleanup;
    /// a never-registered run is closed by the watchdog's
    /// `fail_incomplete_registration` → cleanup. Calling cleanup here would risk an
    /// early/duplicate teardown while workers are still draining. (A3c.)
    pub async fn abort(&self, run_id: &str) -> bool {
        let txs = {
            let g = self.runs.lock().await;
            match g.get(run_id) {
                Some(rw) => rw
                    .workers
                    .values()
                    .map(|e| e.tx.clone())
                    .collect::<Vec<_>>(),
                None => return false,
            }
        };
        let any = !txs.is_empty();
        fan_out_abort(run_id, &txs, "user requested abort").await;
        any
    }
}

/// Reduce a pooled worker's per-shard Profile: open-loop slot/rate split OR
/// closed-loop VU-curve stage scaling. Pure mutation. `slot_weights` = the full
/// per-worker count vector (vu_count per shard), derived by `assignment_for` from
/// `precomputed_counts`; `None` = legacy/force/non-pool even split.
fn reduce_pool_profile(
    profile: &mut pb::Profile,
    shard_index: u32,
    shard_count: u32,
    vu_count: u32,
    slot_weights: Option<&[u32]>,
) {
    let is_open_loop = profile.target_rps.is_some() || !profile.stages.is_empty();
    let is_curve = !profile.vu_stages.is_empty();
    if shard_count <= 1 || (!is_open_loop && !is_curve) {
        return;
    }
    if is_open_loop {
        // ── open-loop arm (L4, unchanged) ──
        profile.max_in_flight = Some(vu_count);
        if let Some(total) = profile.target_rps {
            profile.target_rps = Some(match slot_weights {
                Some(w) => shard::proportional_split_min1(total, w)[shard_index as usize],
                None => shard_split(total, shard_count, shard_index).1,
            });
        }
        for s in &mut profile.stages {
            s.target = match slot_weights {
                Some(w) => shard::proportional_split(s.target, w)[shard_index as usize],
                None => shard_split(s.target, shard_count, shard_index).1,
            };
        }
    } else {
        // ── closed-loop VU-curve arm (L5): scale each stage.target only.
        // 0-share is harmless (engine parks a 0-VU stage; no .max(1) over-fire —
        // run_scenario_vu_curve has no min-1 floor). Do NOT touch max_in_flight.
        for s in &mut profile.vu_stages {
            s.target = match slot_weights {
                Some(w) => shard::proportional_split(s.target, w)[shard_index as usize],
                None => shard_split(s.target, shard_count, shard_index).1,
            };
        }
    }
}

/// Send AbortRun to each tx (best-effort; closed channels ignored).
async fn fan_out_abort(run_id: &str, txs: &[WorkerTx], reason: &str) {
    for tx in txs {
        let msg = ServerMessage {
            payload: Some(ServerPayload::Abort(AbortRun {
                run_id: run_id.to_string(),
                reason: reason.to_string(),
            })),
        };
        let _ = tx.send(Ok(msg)).await;
    }
}

/// Per-run watchdog: wait `deadline`, then fail the run if not everyone
/// registered. Cancelled early (via `token`) once all workers register.
async fn registration_watchdog(
    coord: CoordinatorState,
    run_id: String,
    deadline: Duration,
    token: CancellationToken,
) {
    tokio::select! {
        _ = token.cancelled() => {}
        _ = tokio::time::sleep(deadline) => {
            coord.fail_incomplete_registration(&run_id).await;
        }
    }
}

pub struct CoordinatorService {
    pub state: CoordinatorState,
}

type ChannelStream = Pin<Box<dyn Stream<Item = Result<ServerMessage, Status>> + Send>>;

#[tonic::async_trait]
impl Coordinator for CoordinatorService {
    type ChannelStream = ChannelStream;

    async fn channel(
        &self,
        req: Request<Streaming<WorkerMessage>>,
    ) -> Result<Response<Self::ChannelStream>, Status> {
        let mut inbound = req.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<ServerMessage, Status>>(32);
        let state = self.state.clone();

        tokio::spawn(async move {
            let mut run_id: Option<String> = None;
            let mut worker_id: Option<String> = None;
            let mut pool_conn = false;
            while let Some(msg) = inbound.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        warn!(error = %e, "worker stream error");
                        break;
                    }
                };
                match msg.payload {
                    Some(WorkerPayload::Register(reg)) => {
                        if !state.check_token(&reg.token) {
                            warn!(worker_id = %reg.worker_id, "register rejected: token mismatch");
                            let _ = tx
                                .send(Ok(ServerMessage {
                                    payload: Some(ServerPayload::Abort(AbortRun {
                                        run_id: reg.run_id.clone(),
                                        reason: "authentication failed".to_string(),
                                    })),
                                }))
                                .await;
                            break;
                        }
                        worker_id = Some(reg.worker_id.clone());
                        if reg.run_id.is_empty() {
                            // Pool mode: register idle, wait for push assignment from assign_pool_workers (Task 3).
                            info!(worker_id = %reg.worker_id, "pool worker registered idle");
                            state
                                .pool_register_idle(
                                    &reg.worker_id,
                                    tx.clone(),
                                    reg.capacity_vus,
                                    reg.hostname.clone(),
                                )
                                .await;
                            pool_conn = true;
                            continue;
                        }
                        run_id = Some(reg.run_id.clone());
                        info!(worker_id = %reg.worker_id, run_id = %reg.run_id, "worker registered");

                        let outcome = state
                            .register(&reg.run_id, &reg.worker_id, tx.clone())
                            .await;
                        let (shard_index, shard_count, vu_offset, vu_count, set_running) =
                            match outcome {
                                RegisterOutcome::Assigned {
                                    shard_index,
                                    shard_count,
                                    vu_offset,
                                    vu_count,
                                    first,
                                } => (shard_index, shard_count, vu_offset, vu_count, first),
                                RegisterOutcome::Resend {
                                    shard_index,
                                    shard_count,
                                    vu_offset,
                                    vu_count,
                                } => (shard_index, shard_count, vu_offset, vu_count, false),
                                RegisterOutcome::Reject => {
                                    warn!(run_id = %reg.run_id, worker_id = %reg.worker_id, "rejecting late/over registration");
                                    let _ = tx
                                        .send(Ok(ServerMessage {
                                            payload: Some(ServerPayload::Abort(AbortRun {
                                                run_id: reg.run_id.clone(),
                                                reason: "run already started or fully sharded"
                                                    .to_string(),
                                            })),
                                        }))
                                        .await;
                                    break;
                                }
                                RegisterOutcome::NoRun => {
                                    error!(run_id = %reg.run_id, "no pending run for worker");
                                    break;
                                }
                            };

                        let Some((assignment, streams)) = state
                            .assignment_for(
                                &reg.run_id,
                                &reg.worker_id,
                                shard_index,
                                shard_count,
                                vu_offset,
                                vu_count,
                            )
                            .await
                        else {
                            error!(run_id = %reg.run_id, "run vanished between register and assignment");
                            break;
                        };

                        let _ = tx
                            .send(Ok(ServerMessage {
                                payload: Some(ServerPayload::Assignment(assignment)),
                            }))
                            .await;

                        if set_running {
                            let _ = runs::set_status(
                                &state.db,
                                &reg.run_id,
                                RunStatus::Running,
                                Some(crate::store::now_ms()),
                                None,
                            )
                            .await;
                        }

                        // Stream each binding's dataset slice for this worker
                        // (disjoint for unique, replicated otherwise), tagged with
                        // its binding_index. Row values are NEVER logged (spec §11).
                        // If any binding's stream comes up incomplete it already sent
                        // AbortRun — stop streaming the rest (the worker aborts the
                        // whole run on any incomplete binding).
                        for ws in &streams {
                            if ws.count > 0 && !stream_dataset(&state, &tx, &reg.run_id, ws).await {
                                break;
                            }
                        }
                    }
                    Some(WorkerPayload::MetricBatch(batch)) => {
                        // A3b: run_metrics is keyed by worker_id (per-worker rows, read-time
                        // merge). loop/if metrics accumulate (count + excluded), so N-worker
                        // sums are correct without per-worker keying.
                        ingest_metrics(&state, &batch).await;
                    }
                    Some(WorkerPayload::RunStatus(s)) => {
                        info!(run_id = %s.run_id, phase = ?s.phase, "worker run status");
                        if let Some(wid) = &worker_id {
                            state.record_phase(&s.run_id, wid, s.phase).await;
                        }
                    }
                    Some(WorkerPayload::Pong(_)) => {}
                    None => {}
                }
                // R1: any inbound from a pool connection refreshes liveness. Gated on
                // pool_conn so per-run/k8s MetricBatch hot path never touches the pool lock,
                // and worker_id is Some only after the Register arm ran.
                if pool_conn {
                    if let Some(wid) = &worker_id {
                        state.pool_touch(wid).await;
                    }
                }
            }
            // Stream closed: route to pool or legacy fail-fast based on connection mode.
            if pool_conn {
                if let Some(wid) = worker_id.as_ref() {
                    state.pool_disconnect(wid).await;
                }
            } else if let (Some(rid), Some(wid)) = (run_id.as_ref(), worker_id.as_ref()) {
                state.worker_disconnected(rid, wid).await;
            }
            info!(?run_id, ?worker_id, "worker stream closed");
        });

        let out: ChannelStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out))
    }
}

/// Stream this worker's dataset slice for ONE binding. For `unique` the slice is
/// a disjoint contiguous range; for replicated policies it is the whole dataset
/// (offset 0). Each batch carries `ws.binding_index` so the worker routes rows to
/// the right binding. Returns `true` when the full slice was delivered, `false`
/// when it came up incomplete — in which case AbortRun was already sent so the
/// worker's loading stage doesn't hang (spec §6.2, §4.4, controller CLAUDE.md
/// "drop(tx) can't close a blocked stream"). The caller breaks on the first
/// `false`: any incomplete binding aborts the whole run, so later bindings need
/// not be streamed.
async fn stream_dataset(
    state: &CoordinatorState,
    tx: &WorkerTx,
    run_id: &str,
    ws: &WorkerStream,
) -> bool {
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
            Ok(r) => r,
            Err(e) => {
                error!(run_id = %run_id, error = %e, "dataset row fetch failed");
                incomplete = true;
                break;
            }
        };
        if src.is_empty() {
            error!(
                run_id = %run_id,
                sent,
                total,
                "dataset shrank mid-stream; fewer rows than promised"
            );
            incomplete = true;
            break;
        }
        let proto_rows: Vec<pb::DatasetRow> = src
            .iter()
            .map(|row| pb::DatasetRow {
                values: crate::binding::apply_mappings(&ws.mappings, row)
                    .into_iter()
                    .collect(),
            })
            .collect();
        let n = proto_rows.len() as i64;
        if tx
            .send(Ok(ServerMessage {
                payload: Some(ServerPayload::DatasetBatch(pb::DatasetBatch {
                    run_id: run_id.to_string(),
                    rows: proto_rows,
                    binding_index: ws.binding_index,
                })),
            }))
            .await
            .is_err()
        {
            warn!(run_id = %run_id, "worker disconnected during dataset stream");
            incomplete = true;
            break;
        }
        sent += n;
    }
    if incomplete {
        let _ = tx
            .send(Ok(ServerMessage {
                payload: Some(ServerPayload::Abort(AbortRun {
                    run_id: run_id.to_string(),
                    reason: "dataset streaming incomplete".to_string(),
                })),
            }))
            .await;
        false
    } else {
        info!(run_id = %run_id, rows_sent = sent, "dataset rows streamed to worker");
        true
    }
}

/// Insert one worker's metric batch (windows + loop + if). Unchanged from the
/// previous inline arm; A3b adds run_metrics per-worker keying.
async fn ingest_metrics(state: &CoordinatorState, batch: &pb::MetricBatch) {
    let rows: Vec<crate::store::metrics::MetricRow> = batch
        .windows
        .iter()
        .map(|w| {
            let status_json =
                serde_json::to_string(&w.status_counts).unwrap_or_else(|_| "{}".to_string());
            crate::store::metrics::MetricRow {
                run_id: batch.run_id.clone(),
                ts_second: w.ts_second,
                step_id: w.step_id.clone(),
                worker_id: batch.worker_id.clone(), // A3b: per-worker keying
                count: w.count as i64,
                error_count: w.error_count as i64,
                hdr_histogram: w.hdr_histogram.clone(),
                status_counts: status_json,
            }
        })
        .collect();
    if let Err(e) = crate::store::metrics::insert_batch(&state.db, &rows).await {
        warn!(run_id = %batch.run_id, error = %e, "failed to insert metric batch");
    }
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
        if let Err(e) = crate::store::metrics::insert_loop_batch(&state.db, &loop_rows).await {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert loop metrics");
        }
    }
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
        if let Err(e) = crate::store::metrics::insert_if_branch_batch(&state.db, &branch_rows).await
        {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert if-branch metrics");
        }
    }
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
    if !group_rows.is_empty() {
        if let Err(e) = crate::store::metrics::insert_group_batch(&state.db, &group_rows).await {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert group metrics");
        }
    }
    let phase_rows: Vec<crate::store::metrics::PhaseMetricRow> = batch
        .phase_stats
        .iter()
        .map(|ps| crate::store::metrics::PhaseMetricRow {
            run_id: batch.run_id.clone(),
            step_id: ps.step_id.clone(),
            phase: ps.phase.clone(),
            hdr_histogram: ps.hdr_histogram.clone(),
            count: ps.count as i64,
        })
        .collect();
    if !phase_rows.is_empty() {
        if let Err(e) = crate::store::metrics::insert_phase_batch(&state.db, &phase_rows).await {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert phase metrics");
        }
    }
    let active_vu_rows: Vec<crate::store::metrics::ActiveVuRow> = batch
        .active_vu_samples
        .iter()
        .map(|s| crate::store::metrics::ActiveVuRow {
            run_id: batch.run_id.clone(),
            ts_second: s.ts_second,
            desired: s.desired as i64,
            actual: s.actual as i64,
            worker_id: batch.worker_id.clone(), // L5: per-worker keying (run_metrics:1229 동형)
        })
        .collect();
    if !active_vu_rows.is_empty() {
        if let Err(e) =
            crate::store::metrics::insert_active_vu_batch(&state.db, &active_vu_rows).await
        {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert active-vu metrics");
        }
    }
    if batch.dropped > 0 {
        if let Err(e) = sqlx::query("UPDATE runs SET dropped = dropped + ? WHERE id = ?")
            .bind(batch.dropped as i64)
            .bind(&batch.run_id)
            .execute(&state.db)
            .await
        {
            warn!(run_id = %batch.run_id, error = %e, "failed to update dropped");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::runs::{self, RunStatus};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingDispatcher {
        cleanups: Arc<AtomicUsize>,
    }
    #[async_trait::async_trait]
    impl crate::dispatcher::WorkerDispatcher for CountingDispatcher {
        async fn dispatch(&self, _run_id: &str, _worker_count: u32) -> anyhow::Result<()> {
            Ok(())
        }
        async fn cleanup(&self, _run_id: &str) -> anyhow::Result<()> {
            self.cleanups.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn finalize_completed_calls_dispatcher_cleanup() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let cleanups = Arc::new(AtomicUsize::new(0));
        coord.set_dispatcher(Arc::new(CountingDispatcher {
            cleanups: cleanups.clone(),
        }));
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        assert_eq!(
            cleanups.load(Ordering::SeqCst),
            1,
            "run completion must trigger dispatcher cleanup exactly once"
        );
    }

    #[tokio::test]
    async fn finalize_aborted_calls_dispatcher_cleanup() {
        // The Aborted finalize arm wires cleanup too (a worker reporting
        // Phase::Aborted is how user-abort closes — see abort()'s doc).
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let cleanups = Arc::new(AtomicUsize::new(0));
        coord.set_dispatcher(Arc::new(CountingDispatcher {
            cleanups: cleanups.clone(),
        }));
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Aborted as i32)
            .await;
        assert_eq!(
            cleanups.load(Ordering::SeqCst),
            1,
            "aborted run must trigger dispatcher cleanup"
        );
    }

    #[tokio::test]
    async fn finalize_failed_calls_dispatcher_cleanup() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let cleanups = Arc::new(AtomicUsize::new(0));
        coord.set_dispatcher(Arc::new(CountingDispatcher {
            cleanups: cleanups.clone(),
        }));
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        let (tx1, _r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Failed as i32)
            .await;
        assert_eq!(
            cleanups.load(Ordering::SeqCst),
            1,
            "fail-fast must trigger dispatcher cleanup"
        );
    }

    #[tokio::test]
    async fn finalize_without_dispatcher_is_noop() {
        // Unit/e2e paths never call set_dispatcher → cleanup_dispatcher is a no-op
        // (handle unset). Guards against a panic/unwrap on the OnceLock.
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Completed
        );
    }

    /// criteria가 있는 run을 seed(메트릭 없음 → p95=0 <= 큰 임계 → verdict passed=true).
    async fn seed_run_with_criteria(db: &Db) -> String {
        let scenario_yaml = "version: 1\nname: t\nsteps: []\n";
        let sc: handicap_engine::Scenario = serde_yaml::from_str(scenario_yaml).unwrap();
        let scenario = crate::store::scenarios::insert(db, &sc, scenario_yaml)
            .await
            .unwrap();
        let criteria = runs::Criteria {
            max_p95_ms: Some(100_000),
            ..Default::default()
        };
        let profile = runs::Profile {
            vus: 4,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            data_bindings: vec![],
            criteria: Some(criteria),
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            worker_count: None,
        };
        runs::insert(
            db,
            &scenario.id,
            scenario_yaml,
            &profile,
            &serde_json::json!({}),
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn finalize_completed_persists_verdict_for_criteria_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run_with_criteria(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Completed);
        let v = row.verdict.expect("verdict persisted at finalize");
        assert!(v.passed, "no metrics → p95=0 <= 100000 → passed");
        assert_eq!(v.criteria.len(), 1);
    }

    #[tokio::test]
    async fn finalize_completed_no_criteria_leaves_verdict_null() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await; // criteria: None
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Completed);
        assert!(row.verdict.is_none(), "no criteria → verdict NULL");
    }

    #[tokio::test]
    async fn finalize_failed_does_not_persist_verdict() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run_with_criteria(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Failed as i32)
            .await;
        let row = runs::get(&db, &run_id).await.unwrap().unwrap();
        assert_eq!(row.status, RunStatus::Failed);
        assert!(row.verdict.is_none(), "Failed run never gets a verdict");
    }

    fn base_assignment() -> PendingAssignment {
        PendingAssignment {
            scenario_yaml: "version: 1\nname: t\nsteps: []\n".to_string(),
            profile: pb::Profile {
                vus: 4,
                ramp_up_seconds: 0,
                duration_seconds: 1,
                loop_breakdown_cap: 0,
                http_timeout_seconds: 30,
                think_time: None,
                think_seed: None,
                target_rps: None,
                max_in_flight: None,
                stages: vec![],
                measure_phases: false,
                vu_stages: vec![],
                ramp_down_immediate: false,
            },
            env: HashMap::new(),
            data_bindings: vec![],
        }
    }

    // helper to insert a run row so set_status has a target.
    async fn seed_run(db: &Db) -> String {
        let scenario_yaml = "version: 1\nname: t\nsteps: []\n";
        let sc: handicap_engine::Scenario = serde_yaml::from_str(scenario_yaml).unwrap();
        let scenario = crate::store::scenarios::insert(db, &sc, scenario_yaml)
            .await
            .unwrap();
        let profile = runs::Profile {
            vus: 4,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            worker_count: None,
        };
        let row = runs::insert(
            db,
            &scenario.id,
            scenario_yaml,
            &profile,
            &serde_json::json!({}),
        )
        .await
        .unwrap();
        row.id
    }

    fn fake_tx() -> (
        WorkerTx,
        tokio::sync::mpsc::Receiver<Result<ServerMessage, Status>>,
    ) {
        tokio::sync::mpsc::channel(8)
    }

    #[test]
    fn split_open_loop_profile_sums_exact_and_byte_identical_at_n1() {
        use handicap_proto::v1::{Profile as PbProfile, Stage as PbStage};
        let base = PbProfile {
            target_rps: Some(10),
            max_in_flight: Some(7),
            stages: vec![PbStage {
                target: 10,
                duration_seconds: 5,
            }],
            ..Default::default()
        };

        // N=2: shard_split(7,2,0)=(0,4),(1)=(4,3) → slots 4+3=7; rps 5+5=10
        let mut w0 = base.clone();
        reduce_pool_profile(&mut w0, 0, 2, 4, None);
        let mut w1 = base.clone();
        reduce_pool_profile(&mut w1, 1, 2, 3, None);
        assert_eq!(w0.target_rps.unwrap() + w1.target_rps.unwrap(), 10);
        assert_eq!(w0.max_in_flight.unwrap(), 4);
        assert_eq!(w1.max_in_flight.unwrap(), 3);
        assert_eq!(w0.stages[0].target + w1.stages[0].target, 10);

        // N=1: byte-identical (shard_count=1 → unchanged)
        let mut solo = base.clone();
        reduce_pool_profile(&mut solo, 0, 1, 7, None);
        assert_eq!(solo, base);

        // closed-loop (not open-loop) profile is untouched (defensive)
        let closed = PbProfile {
            vus: 100,
            ..Default::default()
        };
        let mut c = closed.clone();
        reduce_pool_profile(&mut c, 0, 2, 50, None);
        assert_eq!(c, closed);
    }

    #[test]
    fn split_curve_only_open_loop_splits_each_stage() {
        use handicap_proto::v1::{Profile as PbProfile, Stage as PbStage};
        // Curve-only open-loop (target_rps=None, stages present) — exercises the
        // `!stages.is_empty()` disjunct of the helper's open-loop guard. If that
        // disjunct ever regressed to `target_rps.is_some()` only, curve-only
        // multi-worker runs would silently NOT split → N× load (ADR-0032).
        let base = PbProfile {
            target_rps: None,
            max_in_flight: Some(7),
            stages: vec![
                PbStage {
                    target: 10,
                    duration_seconds: 5,
                },
                PbStage {
                    target: 7,
                    duration_seconds: 3,
                },
            ],
            ..Default::default()
        };

        // N=2: shard_split(7,2,*) → slots 4/3; each stage split: 10→5/5, 7→4/3.
        let mut w0 = base.clone();
        reduce_pool_profile(&mut w0, 0, 2, 4, None);
        let mut w1 = base.clone();
        reduce_pool_profile(&mut w1, 1, 2, 3, None);
        assert!(w0.target_rps.is_none() && w1.target_rps.is_none()); // stays curve-only
        assert_eq!(w0.max_in_flight.unwrap(), 4);
        assert_eq!(w1.max_in_flight.unwrap(), 3);
        assert_eq!(w0.stages[0].target + w1.stages[0].target, 10);
        assert_eq!(w0.stages[1].target + w1.stages[1].target, 7);
        // durations unchanged
        assert_eq!(w0.stages[0].duration_seconds, 5);
        assert_eq!(w0.stages[1].duration_seconds, 3);

        // N=1: byte-identical
        let mut solo = base.clone();
        reduce_pool_profile(&mut solo, 0, 1, 7, None);
        assert_eq!(solo, base);
    }

    #[tokio::test]
    async fn register_assigns_distinct_shards_and_resends_on_reregister() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db);
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 4, None)
            .await;

        let (tx0, _r0) = fake_tx();
        let o0 = coord.register(&run_id, "w0", tx0.clone()).await;
        let (tx1, _r1) = fake_tx();
        let o1 = coord.register(&run_id, "w1", tx1).await;
        match (o0, o1) {
            (
                RegisterOutcome::Assigned {
                    shard_index: 0,
                    vu_offset: 0,
                    vu_count: 2,
                    first: true,
                    shard_count: 2,
                },
                RegisterOutcome::Assigned {
                    shard_index: 1,
                    vu_offset: 2,
                    vu_count: 2,
                    first: false,
                    shard_count: 2,
                },
            ) => {}
            other => panic!("unexpected outcomes: {other:?}"),
        }
        // Re-register w0 (idempotent): same shard, NOT a new slot.
        match coord.register(&run_id, "w0", tx0).await {
            RegisterOutcome::Resend {
                shard_index: 0,
                vu_offset: 0,
                vu_count: 2,
                ..
            } => {}
            other => panic!("expected idempotent resend, got {other:?}"),
        }
        // A 3rd distinct worker over-registers (expected=2): reject.
        let (tx2, _r2) = fake_tx();
        assert!(matches!(
            coord.register(&run_id, "w2", tx2).await,
            RegisterOutcome::Reject
        ));
    }

    #[tokio::test]
    async fn all_completed_sets_run_completed() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        let (tx1, _r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        // not all done yet — run stays in its pre-running state (Pending in this
        // unit test; the gRPC handler sets Running when the first worker registers,
        // but unit tests drive the state machine directly without that call).
        assert_ne!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Completed
        );
        coord
            .record_phase(&run_id, "w1", pb::run_status::Phase::Completed as i32)
            .await;
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Completed
        );
    }

    #[tokio::test]
    async fn one_failed_fails_run_and_aborts_siblings() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        let (tx1, mut r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Failed as i32)
            .await;
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Failed
        );
        // sibling w1 received an AbortRun.
        let msg = r1.try_recv().expect("sibling should get AbortRun");
        let msg = msg.unwrap();
        assert!(matches!(msg.payload, Some(ServerPayload::Abort(_))));
    }

    #[tokio::test]
    async fn disconnect_without_terminal_fails_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        let (tx1, _r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        // w0 drops without reporting a terminal phase → fail-fast.
        coord.worker_disconnected(&run_id, "w0").await;
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Failed
        );
    }

    #[tokio::test]
    async fn all_registered_cancels_registration_deadline() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db);
        let token = coord
            .enqueue(run_id.clone(), base_assignment(), 1, 4, None)
            .await;
        assert!(!token.is_cancelled());
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        assert!(
            token.is_cancelled(),
            "all-registered must cancel the watchdog token"
        );
    }

    #[tokio::test]
    async fn registration_deadline_fails_incomplete_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 4, None)
            .await;
        let (tx0, mut r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await; // only 1 of 2 registers
        coord.fail_incomplete_registration(&run_id).await;
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Failed
        );
        // the one registered worker is told to abort.
        assert!(
            r0.try_recv().is_ok(),
            "registered worker should get AbortRun on deadline"
        );
    }

    #[tokio::test]
    async fn complete_then_disconnect_then_sibling_completes_finalizes() {
        // Regression (A3a code-review CRITICAL): a worker closes its stream right
        // after reporting Completed. If worker_disconnected removed its entry, the
        // `len()==expected` completion gate could never be met at N>=2 and the run
        // would hang in Running. Terminal entries must be kept so the run finalizes.
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        let (tx1, _r1) = fake_tx();
        coord.register(&run_id, "w0", tx0).await;
        coord.register(&run_id, "w1", tx1).await;
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await;
        // w0 completes, then its process exits → stream closes.
        coord.worker_disconnected(&run_id, "w0").await;
        assert_ne!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Completed,
            "run must not finalize while w1 is still running"
        );
        coord
            .record_phase(&run_id, "w1", pb::run_status::Phase::Completed as i32)
            .await;
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Completed,
            "run must finalize after w1 completes, despite w0 having disconnected"
        );
    }

    #[tokio::test]
    async fn watchdog_fires_after_deadline() {
        // Tests the REAL wiring: `enqueue` spawns the internal watchdog with
        // REGISTRATION_DEADLINE. Only 1 of 2 workers registers, so the token is
        // NOT cancelled; the watchdog fires after REGISTRATION_DEADLINE → run Failed.
        //
        // We use a real (non-paused) timer here because sqlx's pool management
        // uses `tokio::time::timeout` internally — `start_paused` would cause the
        // pool's 30s acquire_timeout to fire immediately when virtual time jumps,
        // producing PoolTimedOut before the assertion (REGISTRATION_DEADLINE is
        // overridden to 200ms in `#[cfg(test)]` so this completes in ~200ms wall-clock).
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        coord
            .enqueue(run_id.clone(), base_assignment(), 2, 4, None)
            .await;
        let (tx0, _r0) = fake_tx();
        coord.register(&run_id, "w0", tx0).await; // 1 of 2 → token stays live
        // Sleep past the (test-only) 200ms deadline so the watchdog fires.
        tokio::time::sleep(REGISTRATION_DEADLINE + std::time::Duration::from_millis(50)).await;
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Failed
        );
    }

    #[tokio::test]
    async fn ingest_accumulates_dropped_into_runs() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());

        let mk = |d: u64| pb::MetricBatch {
            run_id: run_id.clone(),
            worker_id: "w0".to_string(),
            windows: vec![],
            loop_stats: vec![],
            branch_stats: vec![],
            group_stats: vec![],
            phase_stats: vec![],
            active_vu_samples: vec![],
            dropped: d,
        };
        ingest_metrics(&coord, &mk(3)).await;
        ingest_metrics(&coord, &mk(5)).await;

        let d: i64 = sqlx::query_scalar("SELECT dropped FROM runs WHERE id = ?")
            .bind(&run_id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(d, 8, "dropped must accumulate across batches");
    }

    #[tokio::test]
    async fn ingest_stores_group_stats() {
        use hdrhistogram::serialization::{Serializer, V2Serializer};
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());

        // a valid HDR blob with one ~300ms sample.
        let mut h = hdrhistogram::Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
        h.record(300_000).unwrap();
        let mut blob = Vec::new();
        V2Serializer::new().serialize(&h, &mut blob).unwrap();

        // second HDR blob for the branch="a" stat — same histogram value.
        let mut blob_a = Vec::new();
        V2Serializer::new().serialize(&h, &mut blob_a).unwrap();

        let batch = pb::MetricBatch {
            run_id: run_id.clone(),
            worker_id: "w0".to_string(),
            windows: vec![],
            loop_stats: vec![],
            branch_stats: vec![],
            group_stats: vec![
                pb::GroupStat {
                    step_id: "p1".to_string(),
                    branch: String::new(),
                    hdr_histogram: blob,
                    count: 1,
                },
                pb::GroupStat {
                    step_id: "p1".to_string(),
                    branch: "a".to_string(),
                    hdr_histogram: blob_a,
                    count: 1,
                },
            ],
            phase_stats: vec![],
            active_vu_samples: vec![],
            dropped: 0,
        };
        ingest_metrics(&coord, &batch).await;

        let rows = crate::store::metrics::group_breakdown(&db, &run_id)
            .await
            .unwrap();
        assert_eq!(
            rows.len(),
            2,
            "page row + branch-a row expected; got: {rows:?}"
        );
        assert_eq!(rows[0].step_id, "p1");
        // The page row (branch == "") and the branch-a row must both be stored.
        let page_row = rows.iter().find(|r| r.branch.is_empty()).expect("page row");
        let branch_a = rows.iter().find(|r| r.branch == "a").expect("branch-a row");
        assert_eq!(page_row.count, 1);
        assert_eq!(branch_a.count, 1, "branch='a' round-trip count must be 1");
    }

    #[tokio::test]
    async fn token_unset_accepts_any() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        // worker_token 미설정 → check_token은 항상 통과
        assert!(coord.check_token(""));
        assert!(coord.check_token("anything"));
    }

    #[tokio::test]
    async fn token_mismatch_rejected() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        coord.set_worker_token(Some("secret".to_string()));
        assert!(coord.check_token("secret"));
        assert!(!coord.check_token("wrong"));
        assert!(!coord.check_token(""));
    }

    #[tokio::test]
    async fn pool_register_idempotent_resets_assigned() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx0, _r0) = fake_tx();
        coord
            .pool_register_idle("w0", tx0, 100, "host".into())
            .await;
        assert_eq!(coord.pool_idle_count().await, 1);
        // 같은 worker_id 재등록 = tx 교체, 중복 아님
        let (tx0b, _r0b) = fake_tx();
        coord
            .pool_register_idle("w0", tx0b, 100, "host".into())
            .await;
        assert_eq!(
            coord.pool_idle_count().await,
            1,
            "재등록은 멱등(중복 엔트리 없음)"
        );
    }

    #[tokio::test]
    async fn pool_disconnect_removes() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx0, _r0) = fake_tx();
        coord
            .pool_register_idle("w0", tx0, 100, "host".into())
            .await;
        coord.pool_disconnect("w0").await;
        assert_eq!(coord.pool_idle_count().await, 0);
    }

    #[tokio::test]
    async fn pool_n_is_min_idle_and_load() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        for w in ["w0", "w1", "w2"] {
            let (tx, _r) = fake_tx();
            coord.pool_register_idle(w, tx, 100, "host".into()).await;
        }
        // cap=2(부하상한, 예: vus=2) → 3 유휴 중 2개만 예약
        let reserved = coord.reserve_idle_pool("run-x", 2).await;
        assert_eq!(reserved.len(), 2);
        assert_eq!(
            coord.pool_idle_count().await,
            1,
            "예약된 2개는 유휴에서 빠짐"
        );
    }

    #[tokio::test]
    async fn pool_empty_reserves_none() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let reserved = coord.reserve_idle_pool("run-x", 4).await;
        assert!(reserved.is_empty());
    }

    #[tokio::test]
    async fn pool_launch_assigns_shards() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let (tx0, mut r0) = fake_tx();
        let (tx1, mut r1) = fake_tx();
        coord
            .pool_register_idle("w0", tx0, 100, "host".into())
            .await;
        coord
            .pool_register_idle("w1", tx1, 100, "host".into())
            .await;
        let reserved = coord.reserve_idle_pool(&run_id, 4).await; // cap=4(vus), 유휴 2 → N=2
        coord
            .enqueue(
                run_id.clone(),
                base_assignment(),
                reserved.len() as u32,
                4,
                None,
            )
            .await;
        coord.assign_pool_workers(&run_id, reserved).await.unwrap();
        // 두 워커가 각각 RunAssignment를 받았고 shard_index가 0/1
        let a0 = r0.try_recv().unwrap().unwrap();
        let a1 = r1.try_recv().unwrap().unwrap();
        let idxs: Vec<u32> = [a0, a1]
            .iter()
            .filter_map(|m| match &m.payload {
                Some(ServerPayload::Assignment(a)) => Some(a.shard_index),
                _ => None,
            })
            .collect();
        assert_eq!(
            {
                let mut v = idxs.clone();
                v.sort();
                v
            },
            vec![0, 1]
        );
    }

    #[tokio::test]
    async fn pool_busy_disconnect_fails_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let (tx0, _r0) = fake_tx();
        coord
            .pool_register_idle("w0", tx0, 100, "host".into())
            .await;
        let reserved = coord.reserve_idle_pool(&run_id, 4).await; // assigned_run=Some(run_id)
        coord
            .enqueue(
                run_id.clone(),
                base_assignment(),
                reserved.len() as u32,
                4,
                None,
            )
            .await;
        coord.assign_pool_workers(&run_id, reserved).await.unwrap();
        coord.pool_disconnect("w0").await; // terminal 보고 없이 끊김
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Failed
        );
    }

    #[tokio::test]
    async fn pool_push_to_dead_tx_fails_fast() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let (tx0, r0) = fake_tx();
        drop(r0); // 수신측 닫힘 → 이후 tx.send 실패
        coord
            .pool_register_idle("w0", tx0, 100, "host".into())
            .await;
        let reserved = coord.reserve_idle_pool(&run_id, 4).await;
        coord
            .enqueue(
                run_id.clone(),
                base_assignment(),
                reserved.len() as u32,
                4,
                None,
            )
            .await;
        assert!(
            coord.assign_pool_workers(&run_id, reserved).await.is_err(),
            "닫힌 tx push는 즉시 Err (호출자가 cancel_dispatch_failed, R7)"
        );
    }

    #[tokio::test]
    async fn pool_completed_then_close_no_fail() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let (tx0, _r0) = fake_tx(); // _r0 유지 → push 성공
        coord
            .pool_register_idle("w0", tx0, 100, "host".into())
            .await;
        let reserved = coord.reserve_idle_pool(&run_id, 4).await;
        coord
            .enqueue(
                run_id.clone(),
                base_assignment(),
                reserved.len() as u32,
                4,
                None,
            )
            .await;
        coord.assign_pool_workers(&run_id, reserved).await.unwrap();
        coord
            .record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32)
            .await; // 완료
        coord.pool_disconnect("w0").await; // 정상 종료(terminal 보고 후 close)
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Completed,
            "Completed 보고 후 정상 종료는 fail-fast 오탐 안 함"
        );
    }

    #[tokio::test]
    async fn pool_reused_worker_is_idle_after_reconnect() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx0, _r0) = fake_tx();
        coord
            .pool_register_idle("w0", tx0, 100, "host".into())
            .await;
        let _ = coord.reserve_idle_pool("run-x", 4).await; // assigned_run=Some → busy
        assert_eq!(coord.pool_idle_count().await, 0, "예약 후 busy(idle 아님)");
        // run 종료 후 워커가 새 스트림으로 재연결 → 재등록(fresh idle, assigned_run=None)
        let (tx0b, _r0b) = fake_tx();
        coord
            .pool_register_idle("w0", tx0b, 100, "host".into())
            .await;
        assert_eq!(
            coord.pool_idle_count().await,
            1,
            "재연결 워커는 다시 유휴 → reserve가 재사용(R13)"
        );
    }

    #[tokio::test]
    async fn pool_snapshot_lists_idle_and_busy() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx1, _r1) = fake_tx();
        let (tx2, _r2) = fake_tx();
        coord
            .pool_register_idle("wb", tx1, 100, "beta".into())
            .await;
        coord
            .pool_register_idle("wa", tx2, 200, "alpha".into())
            .await;
        // 한 워커를 busy로(reserve가 assigned_run=Some 마킹; DB run 행 불요 — 풀 맵만 건드림)
        let _ = coord.reserve_idle_pool("run-1", 1).await;
        let snap = coord.pool_snapshot(tokio::time::Instant::now()).await;
        assert_eq!(snap.len(), 2);
        // 정렬: hostname alpha < beta (결정적)
        assert_eq!(snap[0].hostname, "alpha");
        assert_eq!(snap[1].hostname, "beta");
        // 정확히 하나가 busy(어느 워커인지는 비결정적이라 run_id로만 단언)
        let busy: Vec<_> = snap.iter().filter(|w| w.assigned_run.is_some()).collect();
        assert_eq!(busy.len(), 1);
        assert_eq!(busy[0].assigned_run.as_deref(), Some("run-1"));
    }

    #[tokio::test]
    async fn pool_register_stores_hostname() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx, _r) = fake_tx();
        coord
            .pool_register_idle("w1", tx, 50, "myhost".into())
            .await;
        let snap = coord.pool_snapshot(tokio::time::Instant::now()).await;
        assert_eq!(snap[0].hostname, "myhost");
        assert_eq!(snap[0].capacity_vus, 50);
    }

    // ── Task 2: capacity-aware reservation + register precomputed fallback ──

    #[tokio::test]
    async fn pool_achievable_capacity_sums_idle() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        for (id, cap) in [("w0", 5u32), ("w1", 1000u32)] {
            let (tx, _rx) = fake_tx();
            coord.pool_register_idle(id, tx, cap, "h".into()).await;
        }
        // worker_cap=1005 (closed vus=total cap), all 2 workers considered
        assert_eq!(coord.pool_achievable_capacity(1005).await, (2, 1005));
    }

    #[tokio::test]
    async fn reserve_capacity_water_fills_within_caps() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        // worker_id sort: "w0"(cap 5) then "w1"(cap 1000)
        for (id, cap) in [("w0", 5u32), ("w1", 1000u32)] {
            let (tx, _rx) = fake_tx();
            coord.pool_register_idle(id, tx, cap, "h".into()).await;
        }
        // closed-loop: worker_cap=slot_total=vus=30 — assertions unchanged (behavior identical)
        match coord.reserve_idle_pool_capacity("run-x", 30, 30).await {
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
        // closed-loop: worker_cap=slot_total=vus=30 — assertions unchanged (behavior identical)
        match coord.reserve_idle_pool_capacity("run-x", 30, 30).await {
            PoolReservation::Insufficient { achievable } => assert_eq!(achievable, 10),
            other => panic!("expected Insufficient, got {other:?}"),
        }
        assert_eq!(coord.pool_idle_count().await, 2); // nothing reserved
    }

    #[tokio::test]
    async fn reserve_capacity_empty_pool_returns_empty_reserved_not_insufficient() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        // closed-loop: worker_cap=slot_total=vus=30 — assertions unchanged (behavior identical)
        match coord.reserve_idle_pool_capacity("run-x", 30, 30).await {
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
            RegisterOutcome::Assigned {
                vu_offset,
                vu_count,
                ..
            } => {
                assert_eq!((vu_offset, vu_count), (0, 5)); // precomputed, not 15
            }
            other => panic!("expected Assigned, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn register_falls_back_to_shard_split_when_no_precomputed() {
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        coord
            .enqueue("run-x".into(), base_assignment(), 2, 30, None)
            .await;
        let (tx, _rx) = fake_tx();
        match coord.register("run-x", "w0", tx).await {
            RegisterOutcome::Assigned {
                vu_offset,
                vu_count,
                ..
            } => {
                assert_eq!((vu_offset, vu_count), (0, 15)); // even split (byte-identical L1)
            }
            other => panic!("expected Assigned, got {other:?}"),
        }
    }

    // ── Task 2: L4 open-loop proportional/min1 rate split unit tests ──

    /// PbProfile fixture for open-loop fixed (target_rps + max_in_flight).
    fn open_fixed_pb(target_rps: u32, max_in_flight: u32) -> pb::Profile {
        pb::Profile {
            target_rps: Some(target_rps),
            max_in_flight: Some(max_in_flight),
            ..Default::default()
        }
    }

    /// PbProfile fixture for open-loop curve (stages, no target_rps).
    fn open_curve_pb(stage_target: u32) -> pb::Profile {
        pb::Profile {
            max_in_flight: Some(stage_target),
            stages: vec![handicap_proto::v1::Stage {
                target: stage_target,
                duration_seconds: 5,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn reduce_open_loop_fixed_uses_min1_with_weights() {
        // proportional_split_min1(30,[5,25])[0]=6, [1]=24 (Σ=30)
        let mut p = open_fixed_pb(30, 30);
        reduce_pool_profile(&mut p, 0, 2, 5, Some(&[5, 25]));
        assert_eq!(p.target_rps, Some(6)); // proportional_split_min1(30,[5,25])[0]
        let mut p1 = open_fixed_pb(30, 30);
        reduce_pool_profile(&mut p1, 1, 2, 25, Some(&[5, 25]));
        assert_eq!(p1.target_rps, Some(24)); // [1]; Σ=30
    }

    #[test]
    fn reduce_open_loop_fixed_min1_no_zero_heterogeneous() {
        // proportional_split(3,[1,25])=[0,3] but min1 → [1,2]
        let mut p = open_fixed_pb(3, 26);
        reduce_pool_profile(&mut p, 0, 2, 1, Some(&[1, 25]));
        assert_eq!(p.target_rps, Some(1)); // min1: small slot still gets ≥1
    }

    #[test]
    fn reduce_open_loop_curve_uses_proportional_with_weights() {
        // proportional_split(30,[5,25])[0]=5 (zero-share allowed for curve)
        let mut p = open_curve_pb(30);
        reduce_pool_profile(&mut p, 0, 2, 5, Some(&[5, 25]));
        assert_eq!(p.stages[0].target, 5); // proportional_split(30,[5,25])[0]
    }

    #[test]
    fn reduce_open_loop_none_is_legacy_shard_split() {
        // None arm = byte-identical legacy (regression guard)
        let mut p = open_fixed_pb(10, 6);
        reduce_pool_profile(&mut p, 0, 2, 3, None);
        assert_eq!(p.target_rps, Some(shard_split(10, 2, 0).1));
    }

    // ── Task 1: L5 closed-loop VU-curve pool guard — reduce_pool_profile ──

    #[test]
    fn reduce_pool_profile_scales_vu_stages_proportionally() {
        // peak 30, weights [5,25] (sum==peak so proportional_split(peak,w)[i]==w[i]).
        // worker 0 vu_count=5, worker 1 vu_count=25.
        // stage targets [30, 10]:
        //   stage[0]: proportional_split(30,[5,25])=[5,25] → w0=5, w1=25
        //   stage[1]: proportional_split(10,[5,25])=[2,8]  → w0=2, w1=8
        // Σ per stage == original target; max(w0 scaled) == vu_count=5 (R3).
        let mk = |stages: Vec<(u32, u32)>| pb::Profile {
            vu_stages: stages
                .into_iter()
                .map(|(t, d)| pb::Stage {
                    target: t,
                    duration_seconds: d,
                })
                .collect(),
            ..Default::default()
        };
        let weights = [5u32, 25u32];

        let mut w0 = mk(vec![(30, 10), (10, 10)]);
        reduce_pool_profile(&mut w0, 0, 2, 5, Some(&weights));
        assert_eq!(
            w0.vu_stages.iter().map(|s| s.target).collect::<Vec<_>>(),
            vec![5, 2],
            "worker0 peak stage == its weight (5); sub-peak proportional"
        );
        // max scaled stage == vu_count (slab size / offset parity, R3)
        assert_eq!(w0.vu_stages.iter().map(|s| s.target).max().unwrap(), 5);
        assert!(
            w0.max_in_flight.is_none(),
            "curve arm must NOT set max_in_flight"
        );

        let mut w1 = mk(vec![(30, 10), (10, 10)]);
        reduce_pool_profile(&mut w1, 1, 2, 25, Some(&weights));
        assert_eq!(
            w1.vu_stages.iter().map(|s| s.target).collect::<Vec<_>>(),
            vec![25, 8]
        );
        // Σ per stage == original stage target
        assert_eq!(w0.vu_stages[0].target + w1.vu_stages[0].target, 30);
        assert_eq!(w0.vu_stages[1].target + w1.vu_stages[1].target, 10);
    }

    #[test]
    fn reduce_pool_profile_curve_none_weights_even_split() {
        // force/legacy path: slot_weights None → shard_split even split.
        let mut p = pb::Profile {
            vu_stages: vec![pb::Stage {
                target: 10,
                duration_seconds: 5,
            }],
            ..Default::default()
        };
        reduce_pool_profile(&mut p, 0, 2, 5, None);
        assert_eq!(p.vu_stages[0].target, shard_split(10, 2, 0).1);
        assert!(p.max_in_flight.is_none());
    }

    #[test]
    fn reduce_pool_profile_single_worker_curve_noop() {
        // shard_count <= 1 → early return, vu_stages untouched (byte-identical, R11).
        let mut p = pb::Profile {
            vu_stages: vec![pb::Stage {
                target: 50,
                duration_seconds: 10,
            }],
            ..Default::default()
        };
        reduce_pool_profile(&mut p, 0, 1, 50, Some(&[50]));
        assert_eq!(p.vu_stages[0].target, 50, "shard_count==1 → unchanged");
    }

    #[tokio::test]
    async fn reserve_open_loop_slots_capacity_split() {
        // 2 workers cap [5, 25]; worker_cap=8 (pool_worker_cap for max_in_flight=8),
        // slot_total=8 (concurrency_demand=max_in_flight). The capacity_split of 8
        // across caps [5,25] is [5,3] (w0 capped at 5, w1 gets remaining 3).
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        for (id, cap) in [("w0", 5u32), ("w1", 25u32)] {
            let (tx, _rx) = fake_tx();
            coord.pool_register_idle(id, tx, cap, "h".into()).await;
        }
        match coord.reserve_idle_pool_capacity("run-x", 8, 8).await {
            PoolReservation::Reserved { workers, counts } => {
                assert_eq!(workers.len(), 2);
                // capacity_split(8,[5,25]): even 4/4 → w0 cap 5 ok (4<=5), w1 ok → [4,4]
                // Wait: shard_split(8,2,0)=(0,4), shard_split(8,2,1)=(4,4) → even 4/4 no overflow
                // capacity_split start: [4,4], w0 cap 5 >= 4 ok, w1 cap 25 >= 4 ok → [4,4]
                assert_eq!(counts, vec![(0, 4), (4, 4)]);
            }
            other => panic!("expected Reserved, got {other:?}"),
        }
    }

    // ── Task 1 (LAN L6): last_seen / pool_touch / pool_heartbeat_tick / evict ──
    //
    // Virtual-clock tests: `start_paused` is NOT used because sqlx's pool
    // management uses `tokio::time::timeout` internally — pausing the clock
    // before `connect()` causes the pool's acquire_timeout to fire on the first
    // `advance()`, producing PoolTimedOut (same footgun as watchdog test above).
    // Instead we connect with a live clock, then call `tokio::time::pause()` +
    // `advance()` — the DB connection is already open so no further pool acquire
    // is needed during the test body (REGISTRATION_DEADLINE pattern in this file).

    #[tokio::test]
    async fn pool_touch_advances_last_seen() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx, _rx) = tokio::sync::mpsc::channel(32);
        coord.pool_register_idle("w1", tx, 10, "h".into()).await;
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(5)).await;
        let before = coord.pool_snapshot(tokio::time::Instant::now()).await[0].last_seen_secs_ago;
        assert!(before >= 5, "before touch: {before}s >= 5s");
        coord.pool_touch("w1").await;
        let after = coord.pool_snapshot(tokio::time::Instant::now()).await[0].last_seen_secs_ago;
        assert_eq!(after, 0, "immediately after touch: 0s ago");
    }

    #[tokio::test]
    async fn stale_idle_evicted() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx, _rx) = tokio::sync::mpsc::channel(32);
        coord.pool_register_idle("w1", tx, 10, "h".into()).await;
        assert_eq!(coord.pool_idle_count().await, 1);
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(31)).await;
        coord
            .pool_heartbeat_tick(
                tokio::time::Instant::now(),
                std::time::Duration::from_secs(30),
            )
            .await;
        assert_eq!(
            coord.pool_idle_count().await,
            0,
            "stale idle worker evicted"
        );
    }

    #[tokio::test]
    async fn fresh_idle_pinged_not_evicted() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        coord.pool_register_idle("w1", tx, 10, "h".into()).await;
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(10)).await; // < stale 30
        coord
            .pool_heartbeat_tick(
                tokio::time::Instant::now(),
                std::time::Duration::from_secs(30),
            )
            .await;
        assert_eq!(coord.pool_idle_count().await, 1, "fresh worker not evicted");
        // fresh worker got a Ping (tick_pings_all_entries)
        let msg = rx.try_recv().expect("ping pushed");
        assert!(
            matches!(msg.unwrap().payload, Some(super::ServerPayload::Ping(_))),
            "expected Ping payload"
        );
    }

    #[tokio::test]
    async fn stale_busy_routes_worker_disconnected() {
        // Mirror pool_busy_disconnect_fails_run: register idle, reserve to a run
        // (busy), let it go stale, tick → run marked failed + pool entry gone.
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let (tx, _rx) = fake_tx(); // keep _rx so assign_pool_workers send succeeds
        coord.pool_register_idle("w0", tx, 100, "host".into()).await;
        let reserved = coord.reserve_idle_pool(&run_id, 4).await; // assigned_run=Some
        coord
            .enqueue(
                run_id.clone(),
                base_assignment(),
                reserved.len() as u32,
                4,
                None,
            )
            .await;
        coord.assign_pool_workers(&run_id, reserved).await.unwrap();
        // Advance past stale threshold and tick.
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(31)).await;
        coord
            .pool_heartbeat_tick(
                tokio::time::Instant::now(),
                std::time::Duration::from_secs(30),
            )
            .await;
        assert_eq!(
            coord.pool_idle_count().await,
            0,
            "stale busy worker evicted"
        );
        assert_eq!(
            runs::get(&db, &run_id).await.unwrap().unwrap().status,
            RunStatus::Failed,
            "stale busy worker → run failed via worker_disconnected"
        );
    }

    #[tokio::test]
    async fn double_evict_idempotent() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx, _rx) = tokio::sync::mpsc::channel(32);
        coord.pool_register_idle("w1", tx, 10, "h".into()).await;
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(31)).await;
        coord
            .pool_heartbeat_tick(
                tokio::time::Instant::now(),
                std::time::Duration::from_secs(30),
            )
            .await;
        // Late stream-close after eviction → no panic, no-op.
        coord.pool_disconnect("w1").await;
        assert_eq!(coord.pool_idle_count().await, 0);
    }

    #[tokio::test]
    async fn empty_pool_tick_noop() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        // No workers registered — tick must not panic.
        tokio::time::pause();
        coord
            .pool_heartbeat_tick(
                tokio::time::Instant::now(),
                std::time::Duration::from_secs(30),
            )
            .await;
        assert_eq!(coord.pool_idle_count().await, 0);
    }

    // ── Task 1 (LAN L7): PoolEntry 제어 3필드 + 가드 ripple + 대시보드 read-path ──

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
        assert!(
            !e.tx.is_closed(),
            "tx refreshed to tx2 (tx1's receiver was dropped)"
        );
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
        let e = PoolEntry {
            tx,
            capacity_vus: 25,
            hostname: "h".into(),
            assigned_run: None,
            last_seen: tokio::time::Instant::now(),
            drained: false,
            capacity_override: None,
            label: None,
        };
        assert_eq!(e.effective_capacity_vus(), 25);
        let e2 = PoolEntry {
            capacity_override: Some(5),
            ..e
        };
        assert_eq!(e2.effective_capacity_vus(), 5);
    }

    #[tokio::test]
    async fn drained_worker_excluded_from_capacity_paths() {
        let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        let mut _rxs = Vec::new(); // keep receivers alive so tx stays open
        for (id, cap) in [("w1", 10u32), ("w2", 10)] {
            let (tx, rx) = tokio::sync::mpsc::channel(32);
            st.pool_register_idle(id, tx, cap, "h".into()).await;
            _rxs.push(rx);
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

    #[tokio::test]
    async fn drained_worker_excluded_from_reserve_idle_pool() {
        // w1 drained, w2 not — reserve_idle_pool should return only w2.
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        let (tx1, _r1) = fake_tx();
        let (tx2, _r2) = fake_tx();
        coord.pool_register_idle("w1", tx1, 10, "h".into()).await;
        coord.pool_register_idle("w2", tx2, 10, "h".into()).await;
        {
            let mut g = coord.pool.lock().await;
            g.get_mut("w1").unwrap().drained = true;
        }
        // cap=10 → room for both, but w1 is drained so only w2 should be reserved
        let reserved = coord.reserve_idle_pool("run-x", 10).await;
        assert_eq!(reserved.len(), 1, "drained w1 excluded; only w2 reserved");
        assert_eq!(reserved[0].0, "w2");
        // w1 (drained) stays with assigned_run=None; w2 is now assigned
        {
            let g = coord.pool.lock().await;
            assert!(
                g.get("w1").unwrap().assigned_run.is_none(),
                "drained w1 was not reserved — assigned_run stays None"
            );
            assert_eq!(
                g.get("w2").unwrap().assigned_run.as_deref(),
                Some("run-x"),
                "w2 was reserved"
            );
        }
    }

    #[tokio::test]
    async fn drained_worker_excluded_from_reserve_idle_pool_capacity() {
        // w1 drained (cap 10), w2 not (cap 10); worker_cap/slot_total cover both.
        // Only w2's capacity should be considered — achievable is 10, not 20.
        let coord = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        let (tx1, _r1) = fake_tx();
        let (tx2, _r2) = fake_tx();
        coord.pool_register_idle("w1", tx1, 10, "h".into()).await;
        coord.pool_register_idle("w2", tx2, 10, "h".into()).await;
        {
            let mut g = coord.pool.lock().await;
            g.get_mut("w1").unwrap().drained = true;
        }
        // Request slot_total=10 which fits w2 alone; worker_cap=20 allows both if not drained.
        match coord.reserve_idle_pool_capacity("run-x", 20, 10).await {
            PoolReservation::Reserved { workers, counts } => {
                assert_eq!(workers.len(), 1, "drained w1 excluded; only w2 reserved");
                assert_eq!(workers[0].0, "w2");
                // w2 gets the full slot_total=10
                assert_eq!(counts, vec![(0, 10)]);
                // w1 (drained) stays unassigned; w2 is now assigned
                let g = coord.pool.lock().await;
                assert!(
                    g.get("w1").unwrap().assigned_run.is_none(),
                    "drained w1 was not reserved — assigned_run stays None"
                );
                assert_eq!(
                    g.get("w2").unwrap().assigned_run.as_deref(),
                    Some("run-x"),
                    "w2 was reserved"
                );
            }
            other => panic!("expected Reserved, got {other:?}"),
        }
    }

    // ── Task 3 (LAN L7): pool_set_control + pool_exclude ──

    #[tokio::test]
    async fn pool_set_control_partial_update_and_404() {
        let st = CoordinatorState::new(crate::store::connect("sqlite::memory:").await.unwrap());
        let (tx, _rx) = tokio::sync::mpsc::channel(32);
        st.pool_register_idle("w1", tx, 10, "h".into()).await;
        assert!(
            st.pool_set_control("w1", Some(true), Some(Some(5)), Some(Some("pc".into())))
                .await
        );
        {
            let g = st.pool.lock().await;
            let e = g.get("w1").unwrap();
            assert!(e.drained);
            assert_eq!(e.capacity_override, Some(5));
            assert_eq!(e.label.as_deref(), Some("pc"));
        }
        // partial: only undrain; clear override; leave label
        assert!(
            st.pool_set_control("w1", Some(false), Some(None), None)
                .await
        );
        {
            let g = st.pool.lock().await;
            let e = g.get("w1").unwrap();
            assert!(!e.drained);
            assert_eq!(e.capacity_override, None);
            assert_eq!(e.label.as_deref(), Some("pc"));
        }
        assert!(
            !st.pool_set_control("missing", Some(true), None, None).await,
            "404 → false"
        );
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
        assert!(matches!(
            msg.unwrap().payload,
            Some(ServerPayload::Disconnect(_))
        ));
        assert!(!st.pool_exclude("missing", "x").await, "404 → false");
    }
}
