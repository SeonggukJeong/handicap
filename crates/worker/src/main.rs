use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use handicap_engine::{EngineError, MetricFlush, RunPlan, Scenario, run_scenario};
use handicap_proto::v1 as pb;
use handicap_worker_core::{WorkerError, connect_with_backoff};
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{MetricBatch, MetricWindow, RunStatus, WorkerMessage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long)]
    controller: String,
    #[arg(long)]
    run_id: String,
    #[arg(long)]
    worker_id: String,
    #[arg(long, default_value = "1000")]
    capacity_vus: u32,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let args = Args::parse();
    info!(?args, "worker starting");

    // Install the cancel token + SIGTERM handler BEFORE connect_with_backoff
    // so a K8s pod-termination signal during the initial backoff sleep (the
    // common shutdown case while the controller Service has no endpoint yet)
    // is caught by our handler instead of the kernel's default SIGTERM action.
    // Without this, SIGTERM during connect would kill the process with exit
    // 143 and skip any cleanup. See worker-core::reconnect for the matching
    // cancel-aware backoff sleep.
    let cancel = CancellationToken::new();
    let cancel_for_signal = cancel.clone();
    let signal_task = tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "failed to install SIGTERM handler");
                return;
            }
        };
        if sigterm.recv().await.is_some() {
            tracing::info!("SIGTERM received, cancelling run");
            cancel_for_signal.cancel();
        }
    });

    let link = match connect_with_backoff(
        &args.controller,
        &args.worker_id,
        &args.run_id,
        args.capacity_vus,
        cancel.clone(),
    )
    .await
    {
        Ok(link) => link,
        Err(WorkerError::Cancelled) => {
            // SIGTERM during connect: exit cleanly (no run was ever started,
            // so there's nothing to report back to the controller).
            info!("SIGTERM during connect, exiting cleanly");
            signal_task.abort();
            return Ok(());
        }
        Err(e) => return Err(anyhow::Error::from(e).context("connect_with_backoff")),
    };
    let assignment = link.assignment;
    let tx = link.tx;
    let mut inbound_rx = link.inbound_rx;
    let inbound_fwd = link.inbound_fwd;

    let scenario: Scenario =
        Scenario::from_yaml(&assignment.scenario_yaml).context("parse scenario YAML")?;
    let scenario = Arc::new(scenario);
    let profile = assignment.profile.expect("assignment must include profile");

    // Wire env and ramp_up from the assignment into RunPlan.
    let env: BTreeMap<String, String> = assignment.env.clone().into_iter().collect();
    let plan = RunPlan {
        vus: profile.vus,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(profile.duration_seconds.into()),
        env,
        loop_breakdown_cap: 0, // Task 4 will wire profile.loop_breakdown_cap here
    };
    info!(
        vus = plan.vus,
        duration_s = profile.duration_seconds,
        ramp_up_s = profile.ramp_up_seconds,
        "starting engine run"
    );

    let (win_tx, mut win_rx) = mpsc::channel::<MetricFlush>(32);

    let run_id = args.run_id.clone();
    let worker_id = args.worker_id.clone();
    let tx_metric = tx.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(flush) = win_rx.recv().await {
            let _ = flush.loop_stats; // Task 4 will wire these into pb::LoopStatBatch
            let windows: Vec<MetricWindow> = flush
                .windows
                .into_iter()
                .filter_map(|w| {
                    let hdr = w.serialize_histogram().ok()?;
                    let status_counts = w
                        .status_counts
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v))
                        .collect();
                    Some(MetricWindow {
                        ts_second: w.ts_second,
                        step_id: w.step_id,
                        count: w.count,
                        error_count: w.error_count,
                        hdr_histogram: hdr,
                        status_counts,
                    })
                })
                .collect();
            if windows.is_empty() {
                continue;
            }
            let msg = WorkerMessage {
                payload: Some(WorkerPayload::MetricBatch(MetricBatch {
                    run_id: run_id.clone(),
                    worker_id: worker_id.clone(),
                    windows,
                })),
            };
            if tx_metric.send(msg).await.is_err() {
                error!("controller stream closed, dropping batch");
                break;
            }
        }
    });

    // Abort listener: watch inbound messages for AbortRun addressed to our run.
    // Reuses the same `cancel` token installed at startup — SIGTERM and an
    // inbound AbortRun both cancel the in-flight scenario via the same token,
    // which the engine watches for `EngineError::Aborted` → Phase::Aborted.
    let cancel_for_listener = cancel.clone();
    let assignment_run_id = assignment.run_id.clone();
    let abort_listener = tokio::spawn(async move {
        while let Some(msg) = inbound_rx.recv().await {
            if let Some(ServerPayload::Abort(a)) = msg.payload {
                if a.run_id == assignment_run_id {
                    info!(run_id = %assignment_run_id, reason = %a.reason, "abort signal received");
                    cancel_for_listener.cancel();
                    break;
                }
            }
        }
    });

    let run_res = run_scenario(scenario, plan, win_tx, cancel).await;

    // Clean up the abort listener — it may still be blocked on recv().
    abort_listener.abort();
    abort_listener.await.ok();
    signal_task.abort();

    forwarder.await.ok();

    // Phase::Aborted signals the controller to mark the run as aborted (matching
    // the REST abort path). The store's set_status has a guard against overwriting
    // an already-aborted row, so this is idempotent.
    if matches!(&run_res, Err(EngineError::Aborted)) {
        info!(run_id = %args.run_id, "run aborted");
    } else if let Err(e) = &run_res {
        tracing::warn!(run_id = %args.run_id, error = ?e, "run failed");
    }
    let (phase, message) = phase_for_result(&run_res);
    let msg = WorkerMessage {
        payload: Some(WorkerPayload::RunStatus(RunStatus {
            run_id: args.run_id.clone(),
            phase,
            message,
        })),
    };
    let _ = tx.send(msg).await;

    // Drop the sender explicitly: the gRPC client's ReceiverStream drains the
    // buffered message first, then signals HTTP/2 END_STREAM. HTTP/2 guarantees
    // the DATA frame (final RunStatus) arrives before END_STREAM on the same
    // stream. After the controller receives EOF it closes the inbound leg, which
    // causes `inbound_fwd` to complete — we await that as the synchronization
    // point. This replaces the previous fixed 200ms sleep with a deterministic
    // signal: we exit only after the protocol confirms the far end received EOF.
    //
    // The await is capped at 2s so a misbehaving controller can't hang the
    // worker process forever; that ceiling matches the previous sleep's
    // worst-case behavior while letting the happy path exit in milliseconds.
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), inbound_fwd).await;
    info!("worker done");
    Ok(())
}

/// Map an engine result to the gRPC `Phase` discriminant and error message string.
///
/// `Phase::Aborted` signals the controller to mark the run as aborted (matching
/// the REST abort path). The store's `set_status` has a SQL guard against
/// overwriting an already-aborted row, so the round-trip is idempotent.
fn phase_for_result(res: &Result<(), EngineError>) -> (i32, String) {
    match res {
        Ok(()) => (pb::run_status::Phase::Completed as i32, String::new()),
        Err(EngineError::Aborted) => (pb::run_status::Phase::Aborted as i32, String::new()),
        Err(e) => (pb::run_status::Phase::Failed as i32, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use handicap_engine::EngineError;

    #[test]
    fn phase_for_aborted_is_aborted() {
        let res: Result<(), EngineError> = Err(EngineError::Aborted);
        let (phase, msg) = phase_for_result(&res);
        assert_eq!(phase, pb::run_status::Phase::Aborted as i32);
        assert_eq!(msg, "");
    }

    #[test]
    fn phase_for_ok_is_completed() {
        let (phase, _) = phase_for_result(&Ok(()));
        assert_eq!(phase, pb::run_status::Phase::Completed as i32);
    }

    #[test]
    fn phase_for_other_error_is_failed() {
        let res: Result<(), EngineError> = Err(EngineError::AllVusFailed {
            failed: 5,
            total: 5,
        });
        let (phase, msg) = phase_for_result(&res);
        assert_eq!(phase, pb::run_status::Phase::Failed as i32);
        assert!(!msg.is_empty(), "failure message should be non-empty");
    }
}
