use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use handicap_engine::{
    BindingPolicy, DataSet, EngineError, MetricFlush, RunPlan, Scenario, run_scenario,
    run_scenario_open_loop,
};
use handicap_proto::v1 as pb;
use handicap_worker_core::{WorkerError, connect_with_backoff, load_dataset};
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{BranchStat, LoopStat, MetricBatch, MetricWindow, RunStatus, WorkerMessage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long)]
    controller: String,
    #[arg(long)]
    run_id: String,
    /// Explicit worker id. If omitted (K8s Indexed Job), derived from
    /// JOB_COMPLETION_INDEX as "{run_id}-w{index}". (A3a spec §7.2.)
    #[arg(long)]
    worker_id: Option<String>,
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
    let worker_id = resolve_worker_id(
        args.worker_id.clone(),
        &args.run_id,
        std::env::var("JOB_COMPLETION_INDEX").ok(),
    );
    info!(?args, %worker_id, "worker starting");

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
        &worker_id,
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
    // Lets the inbound forwarder log the end-of-run stream close at debug rather
    // than warn once we begin shutting down (set before each terminal drop(tx)).
    let shutdown = link.shutdown;

    let scenario: Scenario =
        Scenario::from_yaml(&assignment.scenario_yaml).context("parse scenario YAML")?;
    let scenario = Arc::new(scenario);
    let profile = assignment.profile.expect("assignment must include profile");

    // Wire env and ramp_up from the assignment into RunPlan.
    let env: BTreeMap<String, String> = assignment.env.clone().into_iter().collect();

    // Data-binding loading stage (spec §7.3): if the assignment carries a binding,
    // drain DatasetBatch messages until we have row_count rows, THEN start the
    // engine. An abort/cancel during loading exits cleanly; an early stream close
    // is a failure.
    //
    // This block MUST come before spawning `abort_listener` (which moves
    // `inbound_rx`) and before spawning `forwarder` (so early-return arms don't
    // need to clean up either task).
    let dataset: Option<Arc<DataSet>> = match &assignment.data_binding {
        Some(b) if b.row_count > 0 => {
            info!(rows = b.row_count, run_id = %args.run_id, "loading dataset before run");
            match load_dataset(&mut inbound_rx, b.row_count, &args.run_id, &cancel).await {
                Ok(rows) => {
                    let policy = match pb::data_binding::Policy::try_from(b.policy) {
                        Ok(pb::data_binding::Policy::PerVu) => BindingPolicy::PerVu,
                        Ok(pb::data_binding::Policy::IterSequential) => {
                            BindingPolicy::IterSequential
                        }
                        Ok(pb::data_binding::Policy::IterRandom) => BindingPolicy::IterRandom,
                        Ok(pb::data_binding::Policy::Unique) => BindingPolicy::Unique,
                        _ => unreachable!(
                            "proto DataBinding.policy {} not mapped — controller/worker version mismatch",
                            b.policy
                        ),
                    };
                    Some(Arc::new(DataSet {
                        policy,
                        seed: b.seed,
                        rows,
                    }))
                }
                Err(WorkerError::Cancelled) => {
                    // Abort/SIGTERM during loading: report Aborted + clean shutdown
                    // (mirror the end-of-main shutdown sequence).
                    info!(run_id = %args.run_id, "aborted during dataset load");
                    shutdown.store(true, Ordering::Relaxed);
                    let msg = WorkerMessage {
                        payload: Some(WorkerPayload::RunStatus(RunStatus {
                            run_id: args.run_id.clone(),
                            phase: pb::run_status::Phase::Aborted as i32,
                            message: String::new(),
                        })),
                    };
                    let _ = tx.send(msg).await;
                    drop(tx);
                    let _ = tokio::time::timeout(Duration::from_secs(2), inbound_fwd).await;
                    signal_task.abort();
                    return Ok(());
                }
                Err(e) => {
                    // Stream closed early (e.g. controller crash mid-stream): report
                    // Failed + clean shutdown so the run doesn't sit "running".
                    let emsg = e.to_string();
                    tracing::warn!(run_id = %args.run_id, error = %emsg, "dataset load failed");
                    let msg = WorkerMessage {
                        payload: Some(WorkerPayload::RunStatus(RunStatus {
                            run_id: args.run_id.clone(),
                            phase: pb::run_status::Phase::Failed as i32,
                            message: emsg,
                        })),
                    };
                    let _ = tx.send(msg).await;
                    drop(tx);
                    let _ = tokio::time::timeout(Duration::from_secs(2), inbound_fwd).await;
                    signal_task.abort();
                    return Ok(());
                }
            }
        }
        _ => None,
    };

    // Capture open-loop predicate BEFORE the RunPlan build — partial field moves
    // (profile.think_time) in the struct literal below make &profile invalid after.
    let is_open_loop = proto_is_open_loop(&profile);

    let plan = RunPlan {
        vus: assignment.vu_count,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(run_duration_secs(&profile)),
        env,
        loop_breakdown_cap: profile.loop_breakdown_cap,
        vu_offset: assignment.vu_offset,
        data_binding: dataset,
        // proto default 0 (absent field from an old controller) → fall back to 30s
        // so the byte-identical invariant holds; current controllers send 1..=600.
        http_timeout: Duration::from_secs(u64::from(if profile.http_timeout_seconds == 0 {
            30
        } else {
            profile.http_timeout_seconds
        })),
        think_time: profile.think_time.map(|t| handicap_engine::ThinkTime {
            min_ms: t.min_ms,
            max_ms: t.max_ms,
        }),
        think_seed: profile.think_seed,
        // Open-loop: proto optional uint32 → Option<u32>. Some(rps) selects the
        // open-loop execution path below; None → closed-loop run_scenario.
        target_rps: profile.target_rps,
        max_in_flight: profile.max_in_flight,
        // S-D: map proto stages to engine Stage structs; empty → None (closed/fixed path).
        stages: if profile.stages.is_empty() {
            None
        } else {
            Some(
                profile
                    .stages
                    .iter()
                    .map(|s| handicap_engine::Stage {
                        target: s.target,
                        duration_seconds: s.duration_seconds,
                    })
                    .collect(),
            )
        },
    };
    info!(
        vus = plan.vus,
        duration_s = profile.duration_seconds,
        ramp_up_s = profile.ramp_up_seconds,
        "starting engine run"
    );

    let (win_tx, mut win_rx) = mpsc::channel::<MetricFlush>(32);

    let run_id = args.run_id.clone();
    let worker_id = worker_id.clone();
    let tx_metric = tx.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(flush) = win_rx.recv().await {
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
            let loop_stats: Vec<LoopStat> = flush
                .loop_stats
                .into_iter()
                .map(|ls| LoopStat {
                    step_id: ls.step_id,
                    loop_index: ls.loop_index,
                    count: ls.count,
                    error_count: ls.error_count,
                })
                .collect();
            let branch_stats: Vec<BranchStat> = flush
                .branch_stats
                .into_iter()
                .map(|bs| BranchStat {
                    step_id: bs.step_id,
                    branch: bs.branch,
                    count: bs.count,
                })
                .collect();
            // Keep the `flush.dropped == 0` term: the open-loop final flush may carry the
            // run-total dropped count with empty windows. Dropping it would silently
            // discard `dropped` on all-empty-window final flushes (the C1 footgun).
            if windows.is_empty()
                && loop_stats.is_empty()
                && branch_stats.is_empty()
                && flush.dropped == 0
            {
                continue;
            }
            let msg = WorkerMessage {
                payload: Some(WorkerPayload::MetricBatch(MetricBatch {
                    run_id: run_id.clone(),
                    worker_id: worker_id.clone(),
                    windows,
                    loop_stats,
                    branch_stats,
                    dropped: flush.dropped,
                })),
            };
            if tx_metric.send(msg).await.is_err() {
                debug!("controller stream closed mid-run, dropping batch");
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

    let run_res = if is_open_loop {
        run_scenario_open_loop(scenario, plan, win_tx, cancel).await
    } else {
        run_scenario(scenario, plan, win_tx, cancel).await
    };

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
    shutdown.store(true, Ordering::Relaxed);
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), inbound_fwd).await;
    info!("worker done");
    Ok(())
}

/// Open-loop when fixed rate OR a non-empty stage curve is set (S-D §3.5 predicate,
/// proto side). Empty `stages` ≡ absent.
fn proto_is_open_loop(p: &pb::Profile) -> bool {
    p.target_rps.is_some() || !p.stages.is_empty()
}

/// Total run duration for the engine: sum of stage durations when a curve is set,
/// else the flat `duration_seconds`. Invariant: engine deadline = this value.
fn run_duration_secs(p: &pb::Profile) -> u64 {
    if p.stages.is_empty() {
        u64::from(p.duration_seconds)
    } else {
        p.stages.iter().map(|s| u64::from(s.duration_seconds)).sum()
    }
}

/// Resolve the worker id: explicit `--worker-id` wins; otherwise (K8s Indexed
/// Job) derive `"{run_id}-w{index}"` from `JOB_COMPLETION_INDEX` (default index
/// 0 if unset). Subprocess always passes `--worker-id`, so the fallback is the
/// K8s path only. (A3a spec §7.2.)
fn resolve_worker_id(
    arg: Option<String>,
    run_id: &str,
    completion_index: Option<String>,
) -> String {
    match arg {
        Some(id) => id,
        None => {
            let idx = completion_index.unwrap_or_else(|| "0".to_string());
            format!("{run_id}-w{idx}")
        }
    }
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

    #[test]
    fn resolve_worker_id_prefers_explicit_arg() {
        assert_eq!(
            resolve_worker_id(Some("w-explicit".to_string()), "run-1", None),
            "w-explicit"
        );
    }

    #[test]
    fn resolve_worker_id_falls_back_to_completion_index() {
        // K8s Indexed Job: no --worker-id, JOB_COMPLETION_INDEX present.
        assert_eq!(
            resolve_worker_id(None, "run-9", Some("3".to_string())),
            "run-9-w3"
        );
    }

    #[test]
    fn resolve_worker_id_defaults_when_nothing_present() {
        // Neither arg nor env (shouldn't happen in practice) → deterministic id.
        assert_eq!(resolve_worker_id(None, "run-9", None), "run-9-w0");
    }

    #[test]
    fn stages_wiring() {
        let p = pb::Profile {
            duration_seconds: 10,
            ..Default::default()
        };
        assert!(!proto_is_open_loop(&p));
        assert_eq!(run_duration_secs(&p), 10);

        let p_with_stages = pb::Profile {
            stages: vec![
                pb::Stage {
                    target: 200,
                    duration_seconds: 30,
                },
                pb::Stage {
                    target: 0,
                    duration_seconds: 30,
                },
            ],
            ..Default::default()
        };
        assert!(proto_is_open_loop(&p_with_stages));
        assert_eq!(run_duration_secs(&p_with_stages), 60);
    }
}
