use futures::StreamExt;
use handicap_proto::v1 as pb;
use pb::coordinator_client::CoordinatorClient;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{Register, RunAssignment, ServerMessage, WorkerMessage};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::Channel;
use tracing::{info, warn};

use crate::error::WorkerError;

/// Wraps the worker's side of the bidi stream. After `register`, the worker
/// receives a single `RunAssignment` from the server, then the same `tx` is
/// used for ongoing `MetricBatch` / `RunStatus` sends.
///
/// `inbound_rx` delivers all subsequent `ServerMessage`s that arrive after the
/// initial `RunAssignment`.  The caller is responsible for draining it (e.g.
/// to detect `AbortRun`).
pub struct WorkerLink {
    pub tx: mpsc::Sender<WorkerMessage>,
    pub assignment: RunAssignment,
    /// Receives post-assignment messages from the controller (AbortRun, Ping, …).
    pub inbound_rx: mpsc::Receiver<ServerMessage>,
    // Keeps the background forwarder alive.
    #[allow(dead_code)]
    _inbound_fwd: tokio::task::JoinHandle<()>,
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

    // Wait for the first ServerMessage — must be RunAssignment.
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

    // Forward all remaining inbound messages through a channel so that
    // `main` can listen for AbortRun without blocking on the raw gRPC stream.
    let (fwd_tx, fwd_rx) = mpsc::channel::<ServerMessage>(16);
    let fwd_handle = tokio::spawn(async move {
        while let Some(msg) = inbound.next().await {
            match msg {
                Ok(m) => {
                    tracing::debug!(?m.payload, "controller msg");
                    if fwd_tx.send(m).await.is_err() {
                        // Receiver dropped — main is done; stop forwarding.
                        break;
                    }
                }
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
        inbound_rx: fwd_rx,
        _inbound_fwd: fwd_handle,
    })
}
