use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use handicap_engine::{EngineError, RunPlan, Scenario, StepWindow, run_scenario};
use handicap_proto::v1 as pb;
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{MetricBatch, MetricWindow, RunStatus, WorkerMessage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod client;
mod error;

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

    let link = client::connect_and_register(
        &args.controller,
        &args.worker_id,
        &args.run_id,
        args.capacity_vus,
    )
    .await
    .context("register")?;
    let assignment = link.assignment;
    let tx = link.tx;
    let mut inbound_rx = link.inbound_rx;

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
    };
    info!(
        vus = plan.vus,
        duration_s = profile.duration_seconds,
        ramp_up_s = profile.ramp_up_seconds,
        "starting engine run"
    );

    let (win_tx, mut win_rx) = mpsc::channel::<Vec<StepWindow>>(32);

    let run_id = args.run_id.clone();
    let worker_id = args.worker_id.clone();
    let tx_metric = tx.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(batch) = win_rx.recv().await {
            let windows: Vec<MetricWindow> = batch
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
    let cancel = CancellationToken::new();
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

    forwarder.await.ok();

    // Determine final phase.  Aborted is not a failure from the worker's
    // perspective: the controller already marks the run aborted, so we send
    // Completed to close the stream cleanly without cluttering logs.
    let (phase, message) = match &run_res {
        Ok(()) => (pb::run_status::Phase::Completed as i32, String::new()),
        Err(EngineError::Aborted) => {
            info!(run_id = %args.run_id, "run aborted");
            (pb::run_status::Phase::Completed as i32, String::new())
        }
        Err(e) => {
            tracing::warn!(run_id = %args.run_id, error = ?e, "run failed");
            (pb::run_status::Phase::Failed as i32, e.to_string())
        }
    };
    let msg = WorkerMessage {
        payload: Some(WorkerPayload::RunStatus(RunStatus {
            run_id: args.run_id.clone(),
            phase,
            message,
        })),
    };
    let _ = tx.send(msg).await;

    // Allow the controller a moment to receive the final status before we drop the stream.
    tokio::time::sleep(Duration::from_millis(200)).await;
    info!("worker done");
    Ok(())
}
