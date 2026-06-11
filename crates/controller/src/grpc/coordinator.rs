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
use crate::grpc::shard::{shard_split, worker_count};
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

/// One worker's resolved dataset stream: which rows to fetch + the mappings to
/// apply. For unique these are a disjoint slice (`offset_i..offset_i+count_i`);
/// for replicated policies it's the whole dataset (`offset 0`). (spec §4.4)
struct WorkerStream {
    dataset_id: String,
    mappings: Vec<Mapping>,
    offset: u64,
    count: u64,
}

/// Worker-common base for a run's assignment (scenario/profile/env/binding).
/// Per-worker shard fields are filled at register time.
#[derive(Debug, Clone)]
pub struct PendingAssignment {
    pub scenario_yaml: String,
    pub profile: Profile,
    pub env: HashMap<String, String>,
    pub data_binding: Option<PendingDataBinding>,
}

type WorkerTx = tokio::sync::mpsc::Sender<Result<ServerMessage, Status>>;

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
    /// Per-worker VU capacity used to compute N = ceil(total_vus / capacity).
    pub worker_capacity_vus: u32,
    /// Set once at startup (main.rs) so finalize paths can tear down K8s Jobs /
    /// child processes. Unset in unit/e2e tests → cleanup is a no-op. (A3c spec §7,
    /// §8.) Interior mutability so all clones (AppState.coord, CoordinatorService)
    /// share the same handle regardless of construction order.
    dispatcher: Arc<OnceLock<SharedDispatcher>>,
}

impl CoordinatorState {
    pub fn new(db: Db) -> Self {
        Self::with_capacity(db, DEFAULT_WORKER_CAPACITY_VUS)
    }

    pub fn with_capacity(db: Db, worker_capacity_vus: u32) -> Self {
        Self {
            db,
            runs: Arc::new(Mutex::new(HashMap::new())),
            worker_capacity_vus,
            dispatcher: Arc::new(OnceLock::new()),
        }
    }

    /// Number of workers for `total_vus` given this controller's capacity.
    pub fn worker_count_for(&self, total_vus: u32) -> u32 {
        worker_count(total_vus, self.worker_capacity_vus)
    }

    /// Install the dispatcher handle so finalize paths can clean up. Called once
    /// at startup. Idempotent (later sets are ignored).
    pub fn set_dispatcher(&self, dispatcher: SharedDispatcher) {
        let _ = self.dispatcher.set(dispatcher);
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
        let (vu_offset, vu_count) = shard_split(rw.total_vus, rw.expected, shard_index);
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
    ) -> Option<(RunAssignment, Option<WorkerStream>)> {
        let g = self.runs.lock().await;
        let rw = g.get(run_id)?;
        let _ = worker_id;
        let a = &rw.base;
        let binding = a.data_binding.as_ref();
        // Resolve this worker's slice: unique partitions disjointly; others replicate.
        let stream = binding.map(|b| {
            let is_unique = b.policy == pb::data_binding::Policy::Unique;
            let (offset, count) =
                crate::grpc::shard::dataset_slice(is_unique, b.row_count, shard_count, shard_index);
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
            profile: Some(a.profile.clone()),
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
                        run_id = Some(reg.run_id.clone());
                        worker_id = Some(reg.worker_id.clone());
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

                        let Some((assignment, stream)) = state
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

                        // Stream this worker's dataset slice (disjoint for unique,
                        // replicated otherwise). Row values are NEVER logged (spec §11).
                        if let Some(ws) = &stream {
                            if ws.count > 0 {
                                stream_dataset(&state, &tx, &reg.run_id, ws).await;
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
            }
            // Stream closed: fail-fast if this worker dropped before a terminal phase.
            if let (Some(rid), Some(wid)) = (run_id.as_ref(), worker_id.as_ref()) {
                state.worker_disconnected(rid, wid).await;
            }
            info!(?run_id, ?worker_id, "worker stream closed");
        });

        let out: ChannelStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out))
    }
}

/// Stream this worker's dataset slice to one worker. For `unique` the slice is
/// a disjoint contiguous range; for replicated policies it is the whole dataset
/// (offset 0). On any incompleteness it sends AbortRun so the worker's loading
/// stage doesn't hang (spec §6.2, §4.4, controller CLAUDE.md "drop(tx) can't
/// close a blocked stream").
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
    } else {
        info!(run_id = %run_id, rows_sent = sent, "dataset rows streamed to worker");
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
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
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
            criteria: Some(criteria),
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
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
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
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
            },
            env: HashMap::new(),
            data_binding: None,
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
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
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

    #[tokio::test]
    async fn register_assigns_distinct_shards_and_resends_on_reregister() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let run_id = seed_run(&db).await;
        let coord = CoordinatorState::new(db);
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;

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
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
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
        let token = coord.enqueue(run_id.clone(), base_assignment(), 1, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
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
        coord.enqueue(run_id.clone(), base_assignment(), 2, 4).await;
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

        let batch = pb::MetricBatch {
            run_id: run_id.clone(),
            worker_id: "w0".to_string(),
            windows: vec![],
            loop_stats: vec![],
            branch_stats: vec![],
            group_stats: vec![pb::GroupStat {
                step_id: "p1".to_string(),
                branch: String::new(),
                hdr_histogram: blob,
                count: 1,
            }],
            phase_stats: vec![],
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
}
