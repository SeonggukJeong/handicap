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
use pb::{Profile, RunAssignment, ServerMessage, WorkerMessage};

use crate::store::Db;
use crate::store::runs::{self, RunStatus};

/// What a pending run needs to hand to its worker.
#[derive(Debug, Clone)]
pub struct PendingAssignment {
    pub scenario_yaml: String,
    pub profile: Profile,
}

#[derive(Clone)]
pub struct CoordinatorState {
    pub db: Db,
    pub pending: Arc<Mutex<HashMap<String, PendingAssignment>>>,
}

impl CoordinatorState {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn enqueue(&self, run_id: String, a: PendingAssignment) {
        self.pending.lock().await.insert(run_id, a);
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
                        let pending = state.pending.lock().await.remove(&reg.run_id);
                        match pending {
                            Some(a) => {
                                let assignment = RunAssignment {
                                    run_id: reg.run_id.clone(),
                                    scenario_yaml: a.scenario_yaml,
                                    profile: Some(a.profile),
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
                                    Some(now_ms()),
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
                        // Persistence wired in Task 14.
                        info!(
                            run_id = %batch.run_id,
                            windows = batch.windows.len(),
                            "received metric batch (persistence pending Task 14)"
                        );
                    }
                    Some(WorkerPayload::RunStatus(s)) => {
                        info!(run_id = %s.run_id, phase = ?s.phase, "worker run status");
                        if s.phase == pb::run_status::Phase::Completed as i32 {
                            let _ = runs::set_status(
                                &state.db,
                                &s.run_id,
                                RunStatus::Completed,
                                None,
                                Some(now_ms()),
                            )
                            .await;
                        } else if s.phase == pb::run_status::Phase::Failed as i32 {
                            let _ = runs::set_status(
                                &state.db,
                                &s.run_id,
                                RunStatus::Failed,
                                None,
                                Some(now_ms()),
                            )
                            .await;
                        }
                    }
                    Some(WorkerPayload::Pong(_)) => {}
                    None => {}
                }
            }
            info!(?run_id, "worker stream closed");
        });

        let out: ChannelStream = Box::pin(ReceiverStream::new(rx));
        Ok(Response::new(out))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
