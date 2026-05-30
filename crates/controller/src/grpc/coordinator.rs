use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;

use futures::Stream;
use tokio::sync::Mutex;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};
use tracing::{error, info, warn};

use handicap_proto::v1 as pb;
use pb::coordinator_server::Coordinator;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{AbortRun, Profile, RunAssignment, ServerMessage, WorkerMessage};

use crate::store::Db;
use crate::store::runs::{self, RunStatus};

/// What a pending run needs to hand to its worker.
#[derive(Debug, Clone)]
pub struct PendingAssignment {
    pub scenario_yaml: String,
    pub profile: Profile,
    pub env: HashMap<String, String>,
}

/// Outbound channel to an active (connected) worker.
type WorkerTx = tokio::sync::mpsc::Sender<Result<ServerMessage, Status>>;

#[derive(Clone)]
pub struct CoordinatorState {
    pub db: Db,
    pub pending: Arc<Mutex<HashMap<String, PendingAssignment>>>,
    /// run_id → tx channel for workers that have registered and are active.
    pub active: Arc<Mutex<HashMap<String, WorkerTx>>>,
}

impl CoordinatorState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            pending: Arc::new(Mutex::new(HashMap::new())),
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn enqueue(&self, run_id: String, a: PendingAssignment) {
        self.pending.lock().await.insert(run_id, a);
    }

    /// Send an AbortRun message to the worker handling `run_id`.
    /// Returns `true` if the message was dispatched, `false` if no active worker found.
    pub async fn abort(&self, run_id: &str) -> bool {
        let tx = self.active.lock().await.get(run_id).cloned();
        if let Some(tx) = tx {
            let msg = ServerMessage {
                payload: Some(ServerPayload::Abort(AbortRun {
                    run_id: run_id.to_string(),
                    reason: "user requested abort".to_string(),
                })),
            };
            let _ = tx.send(Ok(msg)).await;
            true
        } else {
            false
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
                        info!(worker_id = %reg.worker_id, run_id = %reg.run_id, "worker registered");
                        // Register the outbound channel so abort() can reach this worker.
                        state
                            .active
                            .lock()
                            .await
                            .insert(reg.run_id.clone(), tx.clone());
                        let pending = state.pending.lock().await.remove(&reg.run_id);
                        match pending {
                            Some(a) => {
                                let assignment = RunAssignment {
                                    run_id: reg.run_id.clone(),
                                    scenario_yaml: a.scenario_yaml,
                                    profile: Some(a.profile),
                                    env: a.env,
                                    data_binding: None,
                                };
                                let _ = tx
                                    .send(Ok(ServerMessage {
                                        payload: Some(ServerPayload::Assignment(assignment)),
                                    }))
                                    .await;
                                let _ = runs::set_status(
                                    &state.db,
                                    &reg.run_id,
                                    RunStatus::Running,
                                    Some(crate::store::now_ms()),
                                    None,
                                )
                                .await;
                            }
                            None => {
                                error!(run_id = %reg.run_id, "no pending assignment for worker");
                                break;
                            }
                        }
                    }
                    Some(WorkerPayload::MetricBatch(batch)) => {
                        let rows: Vec<crate::store::metrics::MetricRow> = batch
                            .windows
                            .iter()
                            .map(|w| {
                                let status_json = serde_json::to_string(&w.status_counts)
                                    .unwrap_or_else(|_| "{}".to_string());
                                crate::store::metrics::MetricRow {
                                    run_id: batch.run_id.clone(),
                                    ts_second: w.ts_second,
                                    step_id: w.step_id.clone(),
                                    count: w.count as i64,
                                    error_count: w.error_count as i64,
                                    hdr_histogram: w.hdr_histogram.clone(),
                                    status_counts: status_json,
                                }
                            })
                            .collect();
                        if let Err(e) = crate::store::metrics::insert_batch(&state.db, &rows).await
                        {
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
                            if let Err(e) =
                                crate::store::metrics::insert_loop_batch(&state.db, &loop_rows)
                                    .await
                            {
                                warn!(run_id = %batch.run_id, error = %e, "failed to insert loop metrics");
                            }
                        }
                    }
                    Some(WorkerPayload::RunStatus(s)) => {
                        info!(run_id = %s.run_id, phase = ?s.phase, "worker run status");
                        if s.phase == pb::run_status::Phase::Completed as i32 {
                            let _ = runs::set_status(
                                &state.db,
                                &s.run_id,
                                RunStatus::Completed,
                                None,
                                Some(crate::store::now_ms()),
                            )
                            .await;
                        } else if s.phase == pb::run_status::Phase::Failed as i32 {
                            let _ = runs::set_status(
                                &state.db,
                                &s.run_id,
                                RunStatus::Failed,
                                None,
                                Some(crate::store::now_ms()),
                            )
                            .await;
                        } else if s.phase == pb::run_status::Phase::Aborted as i32 {
                            let _ = runs::set_status(
                                &state.db,
                                &s.run_id,
                                RunStatus::Aborted,
                                None,
                                Some(crate::store::now_ms()),
                            )
                            .await;
                        }
                    }
                    Some(WorkerPayload::Pong(_)) => {}
                    None => {}
                }
            }
            // Remove from active map when stream closes.
            if let Some(ref rid) = run_id {
                state.active.lock().await.remove(rid);
            }
            info!(?run_id, "worker stream closed");
        });

        let out: ChannelStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out))
    }
}
