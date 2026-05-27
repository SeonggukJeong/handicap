use futures::StreamExt;
use handicap_proto::v1 as pb;
use pb::coordinator_client::CoordinatorClient;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{Register, RunAssignment, WorkerMessage};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::Channel;
use tracing::{info, warn};

use crate::error::WorkerError;

/// Wraps the worker's side of the bidi stream. After `register`, the worker
/// receives a single `RunAssignment` from the server, then the same `tx` is
/// used for ongoing `MetricBatch` / `RunStatus` sends.
pub struct WorkerLink {
    pub tx: mpsc::Sender<WorkerMessage>,
    pub assignment: RunAssignment,
    // Held to keep the inbound consumer task alive; never read in Slice 1.
    #[allow(dead_code)]
    pub inbound: tokio::task::JoinHandle<()>,
}

pub async fn connect_and_register(
    controller_url: &str,
    worker_id: &str,
    run_id: &str,
    capacity_vus: u32,
) -> Result<WorkerLink, WorkerError> {
    let channel = Channel::from_shared(controller_url.to_string())?
        .connect()
        .await?;
    let mut client = CoordinatorClient::new(channel);

    let (tx, rx) = mpsc::channel::<WorkerMessage>(64);
    let outbound = ReceiverStream::new(rx);
    let response = client.channel(outbound).await?;
    let mut inbound = response.into_inner();

    // Send Register.
    tx.send(WorkerMessage {
        payload: Some(WorkerPayload::Register(Register {
            worker_id: worker_id.to_string(),
            run_id: run_id.to_string(),
            capacity_vus,
        })),
    })
    .await
    .map_err(|_| WorkerError::SendFailed)?;
    info!(%worker_id, %run_id, "registered with controller");

    // Wait for the first ServerMessage — must be RunAssignment in slice 1.
    let first = inbound.next().await;
    let assignment = match first {
        Some(Ok(msg)) => match msg.payload {
            Some(ServerPayload::Assignment(a)) => a,
            other => {
                warn!(?other, "expected RunAssignment, got something else");
                return Err(WorkerError::NoAssignment);
            }
        },
        Some(Err(e)) => return Err(WorkerError::Rpc(e)),
        None => return Err(WorkerError::NoAssignment),
    };

    // Spawn an inbound consumer so we drain pings/aborts (no-op in slice 1).
    let handle = tokio::spawn(async move {
        while let Some(msg) = inbound.next().await {
            match msg {
                Ok(m) => tracing::debug!(?m.payload, "controller msg"),
                Err(e) => {
                    warn!(error = %e, "inbound stream closed");
                    break;
                }
            }
        }
    });

    Ok(WorkerLink {
        tx,
        assignment,
        inbound: handle,
    })
}
