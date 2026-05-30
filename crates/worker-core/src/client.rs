use std::collections::BTreeMap;

use futures::StreamExt;
use handicap_proto::v1 as pb;
use pb::coordinator_client::CoordinatorClient;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{Register, RunAssignment, ServerMessage, WorkerMessage};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
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
    /// Completes when the controller closes the inbound stream (i.e. after the
    /// controller has processed the outbound EOF we sent by dropping `tx`).
    /// Awaiting this after `drop(tx)` ensures the tokio runtime does not shut
    /// down before tonic has flushed the final HTTP/2 DATA frame and
    /// END_STREAM to the wire.
    pub inbound_fwd: tokio::task::JoinHandle<()>,
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
        inbound_fwd: fwd_handle,
    })
}

/// Accumulate `DatasetBatch` rows from the inbound stream until `expected_rows`
/// rows have arrived, then return them. During loading, an `AbortRun` for our
/// run (or `cancel`) returns `WorkerError::Cancelled`; a closed stream returns
/// `DatasetIncomplete`. Ping/other messages are ignored. (Spec §7.3.)
pub async fn load_dataset(
    inbound_rx: &mut mpsc::Receiver<ServerMessage>,
    expected_rows: u64,
    run_id: &str,
    cancel: &CancellationToken,
) -> Result<Vec<BTreeMap<String, String>>, WorkerError> {
    let mut rows: Vec<BTreeMap<String, String>> = Vec::with_capacity(expected_rows as usize);
    while (rows.len() as u64) < expected_rows {
        tokio::select! {
            _ = cancel.cancelled() => return Err(WorkerError::Cancelled),
            msg = inbound_rx.recv() => match msg {
                Some(sm) => match sm.payload {
                    Some(ServerPayload::DatasetBatch(b)) => {
                        for r in b.rows {
                            rows.push(r.values.into_iter().collect());
                        }
                    }
                    Some(ServerPayload::Abort(a)) if a.run_id == run_id => {
                        return Err(WorkerError::Cancelled);
                    }
                    _ => {} // Ping / unrelated — ignore during loading
                },
                None => {
                    return Err(WorkerError::DatasetIncomplete {
                        got: rows.len() as u64,
                        expected: expected_rows,
                    });
                }
            }
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod load_tests {
    use super::*;
    use handicap_proto::v1 as pb;

    fn batch(run_id: &str, users: &[&str]) -> ServerMessage {
        ServerMessage {
            payload: Some(ServerPayload::DatasetBatch(pb::DatasetBatch {
                run_id: run_id.to_string(),
                rows: users
                    .iter()
                    .map(|u| {
                        let mut v = std::collections::HashMap::new();
                        v.insert("user".to_string(), u.to_string());
                        pb::DatasetRow { values: v }
                    })
                    .collect(),
            })),
        }
    }

    #[tokio::test]
    async fn accumulates_until_expected() {
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(8);
        tx.send(batch("r", &["a", "b"])).await.unwrap();
        tx.send(batch("r", &["c"])).await.unwrap();
        let got = load_dataset(&mut rx, 3, "r", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].get("user").map(String::as_str), Some("a"));
        assert_eq!(got[2].get("user").map(String::as_str), Some("c"));
    }

    #[tokio::test]
    async fn abort_during_loading_returns_cancelled() {
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(8);
        tx.send(batch("r", &["a"])).await.unwrap();
        tx.send(ServerMessage {
            payload: Some(ServerPayload::Abort(pb::AbortRun {
                run_id: "r".into(),
                reason: "x".into(),
            })),
        })
        .await
        .unwrap();
        let err = load_dataset(&mut rx, 5, "r", &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(err, WorkerError::Cancelled));
    }

    #[tokio::test]
    async fn closed_stream_is_incomplete() {
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(8);
        tx.send(batch("r", &["a"])).await.unwrap();
        drop(tx);
        let err = load_dataset(&mut rx, 5, "r", &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            WorkerError::DatasetIncomplete {
                got: 1,
                expected: 5
            }
        ));
    }

    #[tokio::test]
    async fn abort_for_other_run_is_ignored() {
        let (tx, mut rx) = mpsc::channel::<ServerMessage>(8);
        // Abort addressed to a DIFFERENT run — must be ignored.
        tx.send(ServerMessage {
            payload: Some(ServerPayload::Abort(pb::AbortRun {
                run_id: "other".into(),
                reason: "x".into(),
            })),
        })
        .await
        .unwrap();
        // Then the real batch arrives and loading completes.
        tx.send(batch("r", &["a"])).await.unwrap();
        let got = load_dataset(&mut rx, 1, "r", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].get("user").map(String::as_str), Some("a"));
    }
}
