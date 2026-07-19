use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::Context;
use clap::Args as ClapArgs;
use handicap_engine::{
    BindingPolicy, DataSet, EngineError, MetricFlush, RampDown, RunPlan, Scenario, run_scenario,
    run_scenario_open_loop, run_scenario_vu_curve,
};
use handicap_proto::run_duration_secs;
use handicap_proto::v1 as pb;
use handicap_worker_core::{WorkerError, WorkerLink, connect_with_backoff, load_datasets};
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{
    ActiveVuSample, BranchStat, GroupStat, LoopStat, MetricBatch, MetricWindow, PhaseStat,
    RunStatus, WorkerMessage,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};
use tracing_subscriber::EnvFilter;

/// Worker CLI 인자 — lib이 단일 소스. worker 바이너리(`main.rs`)는 `#[command(flatten)]`로,
/// 컨트롤러 멀티콜(`controller worker …`)은 `Cmd::Worker(WorkerArgs)`로 같은 구조체를 재사용한다.
#[derive(Debug, ClapArgs)]
pub struct WorkerArgs {
    #[arg(long)]
    pub controller: String,
    /// Run id to execute (legacy single-run mode). Omit to run in pool mode.
    #[arg(long)]
    pub run_id: Option<String>,
    /// Explicit worker id. If omitted (K8s Indexed Job), derived from
    /// JOB_COMPLETION_INDEX as "{run_id}-w{index}". (A3a spec §7.2.)
    /// In pool mode: derived as a random ULID if omitted (R12).
    #[arg(long)]
    pub worker_id: Option<String>,
    #[arg(long, default_value = "1000")]
    pub capacity_vus: u32,
    // SECURITY: never `?args`-debug-dump this struct — the token would leak in logs. Log explicit fields + token_set.
    /// Shared preshared key for the controller (LAN). Omit if controller has no --worker-token.
    #[arg(long)]
    pub token: Option<String>,
}

/// Install the worker's tracing subscriber (fmt + EnvFilter, default "info").
/// Called once by the worker bin OR the controller's `worker` subcommand arm —
/// NOT by `run()` (avoids a double global-subscriber set panic when the same
/// process also booted the controller; in practice the worker subcommand is a
/// fresh process, but keeping init out of `run()` makes that structural).
pub fn init_worker_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
}

/// Spawn the SIGTERM handler task. Installs the signal handler BEFORE
/// connect_with_backoff so a K8s pod-termination signal during the initial
/// backoff sleep is caught and cancels the token instead of killing the process.
fn spawn_sigterm(cancel: CancellationToken) -> tokio::task::JoinHandle<()> {
    let cancel_for_signal = cancel;
    tokio::spawn(async move {
        #[cfg(unix)]
        {
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
        }
        #[cfg(windows)]
        {
            match tokio::signal::ctrl_c().await {
                Ok(()) => {
                    tracing::info!("Ctrl-C received, cancelling run");
                    cancel_for_signal.cancel();
                }
                Err(e) => tracing::warn!(error = %e, "failed to install Ctrl-C handler"),
            }
        }
    })
}

/// Pool worker id: explicit --worker-id wins, else a fresh random ULID (R12).
/// run_pool calls this once outside its loop so the same id is reused for
/// every reconnect within the process lifetime.
fn resolve_pool_worker_id(explicit: Option<String>) -> String {
    explicit.unwrap_or_else(|| ulid::Ulid::new().to_string())
}

/// A pool worker's control state is persisted only when it has a stable,
/// operator-assigned id (`--worker-id`); an auto-generated random ULID is
/// ephemeral (LAN ops persistence). Mirrors `resolve_pool_worker_id`'s
/// explicit-wins rule.
fn worker_id_is_stable(explicit: &Option<String>) -> bool {
    explicit.is_some()
}

/// Best-effort machine hostname for pool dashboard display. Empty on
/// failure / non-UTF8 (display-only; never load-bearing).
fn resolve_hostname() -> String {
    gethostname::gethostname()
        .to_str()
        .map(str::to_owned)
        .unwrap_or_default()
}

/// Execute a single run assignment: parse scenario, load datasets, run engine,
/// send terminal RunStatus. Ownership: the caller (run/run_pool) owns
/// signal_task — execute_assignment does NOT hold or abort it.
///
/// `worker_id` is the resolved id for this process (used in MetricBatch).
/// `run_cancel` is the token the engine and abort_listener watch. For
/// run_pool, pass cancel.child_token() so per-run abort doesn't kill the
/// process-level SIGTERM token. For legacy run(), pass cancel.clone().
async fn execute_assignment(
    link: WorkerLink,
    worker_id: String,
    run_cancel: CancellationToken,
) -> anyhow::Result<()> {
    let assignment = link.assignment;
    let run_id = assignment.run_id.clone();
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
    // Prefer the new repeated field 10 (data_bindings); fall back to the legacy
    // single field 5 (data_binding) wrapped as a 1-element list. Old controllers
    // send field 5 only — this fallback keeps that path byte-identical until the
    // controller writes field 10 (Task 5).
    let bindings: Vec<&pb::DataBinding> = if !assignment.data_bindings.is_empty() {
        assignment.data_bindings.iter().collect()
    } else {
        assignment.data_binding.iter().collect()
    };
    // A binding with row_count == 0 carries no data; the whole-empty case yields an
    // empty datasets Vec (no stream to drain), matching the legacy `None` path
    // byte-for-byte. Do NOT relax this to `!bindings.is_empty()` — that would promise
    // the engine more buckets than load_datasets drains (length mismatch).
    let datasets: Vec<Arc<DataSet>> = if bindings.iter().any(|b| b.row_count > 0) {
        let expected: Vec<u64> = bindings.iter().map(|b| b.row_count).collect();
        let total: u64 = expected.iter().sum();
        info!(bindings = bindings.len(), rows = total, run_id = %run_id, "loading datasets before run");
        match load_datasets(&mut inbound_rx, &expected, &run_id, &run_cancel).await {
            Ok(all_rows) => bindings
                .iter()
                .zip(all_rows)
                .map(|(b, rows)| {
                    Arc::new(DataSet {
                        policy: map_policy(b.policy),
                        seed: b.seed,
                        rows,
                    })
                })
                .collect(),
            Err(WorkerError::Cancelled) => {
                // Abort/SIGTERM during loading: report Aborted + clean shutdown
                // (mirror the end-of-main shutdown sequence).
                info!(run_id = %run_id, "aborted during dataset load");
                shutdown.store(true, Ordering::Relaxed);
                let msg = WorkerMessage {
                    payload: Some(WorkerPayload::RunStatus(RunStatus {
                        run_id: run_id.clone(),
                        phase: pb::run_status::Phase::Aborted as i32,
                        message: String::new(),
                    })),
                };
                let _ = tx.send(msg).await;
                drop(tx);
                let _ = tokio::time::timeout(Duration::from_secs(2), inbound_fwd).await;
                // signal_task is NOT aborted here — caller owns it.
                return Ok(());
            }
            Err(e) => {
                // Stream closed early (e.g. controller crash mid-stream): report
                // Failed + clean shutdown so the run doesn't sit "running".
                let emsg = e.to_string();
                tracing::warn!(run_id = %run_id, error = %emsg, "dataset load failed");
                let msg = WorkerMessage {
                    payload: Some(WorkerPayload::RunStatus(RunStatus {
                        run_id: run_id.clone(),
                        phase: pb::run_status::Phase::Failed as i32,
                        message: emsg,
                    })),
                };
                let _ = tx.send(msg).await;
                drop(tx);
                let _ = tokio::time::timeout(Duration::from_secs(2), inbound_fwd).await;
                // signal_task is NOT aborted here — caller owns it.
                return Ok(());
            }
        }
    } else {
        Vec::new()
    };

    // Capture predicates BEFORE the RunPlan build — partial field moves
    // (profile.think_time) in the struct literal below make &profile invalid after.
    let is_open_loop = proto_is_open_loop(&profile);
    let is_vu_curve = proto_is_vu_curve(&profile);
    let graceful_ramp_down = proto_graceful_ramp_down(&profile);

    let plan = RunPlan {
        vus: assignment.vu_count,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(run_duration_secs(&profile)),
        env,
        loop_breakdown_cap: profile.loop_breakdown_cap,
        vu_offset: assignment.vu_offset,
        // N independent bindings: field 10 (data_bindings) when present, else the
        // legacy field-5 binding as a 1-element list (loaded into `datasets` above).
        data_bindings: datasets,
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
        measure_phases: profile.measure_phases,
        // VU-curve: map proto vu_stages → engine Stage vec; empty → None (closed/flat path).
        vu_stages: if profile.vu_stages.is_empty() {
            None
        } else {
            Some(
                profile
                    .vu_stages
                    .iter()
                    .map(|s| handicap_engine::Stage {
                        target: s.target,
                        duration_seconds: s.duration_seconds,
                    })
                    .collect(),
            )
        },
        ramp_down: if profile.ramp_down_immediate {
            RampDown::Immediate
        } else {
            RampDown::Graceful
        },
        // §B9: mapped via proto_graceful_ramp_down(&profile) above the literal —
        // same partial-move constraint as is_open_loop/is_vu_curve.
        graceful_ramp_down,
    };
    info!(
        vus = plan.vus,
        duration_s = plan.duration.as_secs(),
        ramp_up_s = profile.ramp_up_seconds,
        "starting engine run"
    );

    let (win_tx, mut win_rx) = mpsc::channel::<MetricFlush>(32);

    let run_id_for_forwarder = run_id.clone();
    let worker_id_for_forwarder = worker_id.clone();
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
            let group_stats: Vec<GroupStat> = flush
                .group_stats
                .into_iter()
                .filter_map(|g| {
                    let hdr = g.serialize_histogram().ok()?;
                    Some(GroupStat {
                        step_id: g.step_id,
                        branch: g.branch,
                        hdr_histogram: hdr,
                        count: g.count,
                    })
                })
                .collect();
            let phase_stats: Vec<PhaseStat> = flush
                .phase_stats
                .into_iter()
                .filter_map(|p| {
                    let hdr = p.serialize_histogram().ok()?;
                    Some(PhaseStat {
                        step_id: p.step_id,
                        phase: p.phase,
                        hdr_histogram: hdr,
                        count: p.count,
                    })
                })
                .collect();
            let active_vu_samples: Vec<ActiveVuSample> = flush
                .active_vu_samples
                .into_iter()
                .map(|s| ActiveVuSample {
                    ts_second: s.ts_second,
                    desired: s.desired,
                    actual: s.actual,
                })
                .collect();
            // Keep the `flush.dropped == 0` term: the open-loop final flush may carry the
            // run-total dropped count with empty windows. Dropping it would silently
            // discard `dropped` on all-empty-window final flushes (the C1 footgun).
            if windows.is_empty()
                && loop_stats.is_empty()
                && branch_stats.is_empty()
                && group_stats.is_empty()
                && phase_stats.is_empty()
                && active_vu_samples.is_empty()
                && flush.dropped == 0
            {
                continue;
            }
            let msg = WorkerMessage {
                payload: Some(WorkerPayload::MetricBatch(MetricBatch {
                    run_id: run_id_for_forwarder.clone(),
                    worker_id: worker_id_for_forwarder.clone(),
                    windows,
                    loop_stats,
                    branch_stats,
                    group_stats,
                    phase_stats,
                    active_vu_samples,
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
    // Reuses run_cancel — SIGTERM and an inbound AbortRun both cancel the
    // in-flight scenario via the same token, which the engine watches for
    // `EngineError::Aborted` → Phase::Aborted.
    let abort_listener = tokio::spawn(abort_listener_loop(
        inbound_rx,
        run_id.clone(),
        run_cancel.clone(),
    ));

    let run_res = if is_vu_curve {
        run_scenario_vu_curve(scenario, plan, win_tx, run_cancel).await
    } else if is_open_loop {
        run_scenario_open_loop(scenario, plan, win_tx, run_cancel).await
    } else {
        run_scenario(scenario, plan, win_tx, run_cancel).await
    };

    // Clean up the abort listener — it may still be blocked on recv().
    abort_listener.abort();
    abort_listener.await.ok();
    // signal_task is NOT aborted here — caller owns it.

    forwarder.await.ok();

    // Phase::Aborted signals the controller to mark the run as aborted (matching
    // the REST abort path). The store's set_status has a guard against overwriting
    // an already-aborted row, so this is idempotent.
    if matches!(&run_res, Err(EngineError::Aborted)) {
        info!(run_id = %run_id, "run aborted");
    } else if let Err(e) = &run_res {
        tracing::warn!(run_id = %run_id, error = ?e, "run failed");
    }
    let (phase, message) = phase_for_result(&run_res);
    let msg = WorkerMessage {
        payload: Some(WorkerPayload::RunStatus(RunStatus {
            run_id: run_id.clone(),
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

/// Legacy single-run (non-pool): controller spawns with --run-id.
pub async fn run(args: WorkerArgs) -> anyhow::Result<()> {
    let run_id = args.run_id.clone().expect("legacy run() requires --run-id");
    let worker_id = resolve_worker_id(
        args.worker_id.clone(),
        &run_id,
        std::env::var("JOB_COMPLETION_INDEX").ok(),
    );
    info!(
        controller = %args.controller,
        run_id = ?args.run_id,
        capacity_vus = args.capacity_vus,
        token_set = args.token.is_some(),
        %worker_id,
        "worker starting"
    );

    let cancel = CancellationToken::new();
    let signal_task = spawn_sigterm(cancel.clone());
    let hostname = resolve_hostname();

    let link = match connect_with_backoff(
        &args.controller,
        &worker_id,
        &run_id,
        args.capacity_vus,
        args.token.as_deref().unwrap_or(""),
        &hostname,
        false,
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

    let res = execute_assignment(link, worker_id, cancel.clone()).await;
    signal_task.abort();
    res
}

/// Pool mode: register idle (empty run_id), wait for assignment, execute,
/// then reconnect to become idle again (reconnect-per-run, R1).
pub async fn run_pool(args: WorkerArgs) -> anyhow::Result<()> {
    let worker_id = resolve_pool_worker_id(args.worker_id.clone());
    let stable = worker_id_is_stable(&args.worker_id);
    let cancel = CancellationToken::new(); // process-level (SIGTERM)
    let signal_task = spawn_sigterm(cancel.clone());
    let token = args.token.as_deref().unwrap_or("");
    let hostname = resolve_hostname();
    info!(%worker_id, "pool worker starting (idle)");
    loop {
        if cancel.is_cancelled() {
            break;
        }
        match connect_with_backoff(
            &args.controller,
            &worker_id,
            "",
            args.capacity_vus,
            token,
            &hostname,
            stable,
            cancel.clone(),
        )
        .await
        {
            Ok(link) => {
                let run_cancel = cancel.child_token(); // per-run (abort cancels only this)
                if let Err(e) = execute_assignment(link, worker_id.clone(), run_cancel).await {
                    warn!(error = ?e, "pool assignment ended with error; back to idle");
                }
                // After assignment ends, loop back to reconnect and idle-register again
                // (reconnect-per-run).
            }
            Err(WorkerError::Cancelled) => break,
            Err(e) => {
                warn!(error = %e, "pool connect failed; retrying");
            }
        }
    }
    signal_task.abort();
    info!("pool worker exiting");
    Ok(())
}

/// Routing: run_id present → legacy single-run, absent → pool mode (R1).
pub async fn run_dispatch(args: WorkerArgs) -> anyhow::Result<()> {
    if should_run_pool(&args) {
        run_pool(args).await
    } else {
        run(args).await
    }
}

/// Pure predicate: true when args indicate pool mode (no --run-id).
fn should_run_pool(args: &WorkerArgs) -> bool {
    args.run_id.is_none()
}

/// Map a proto `DataBinding.policy` discriminant to the engine `BindingPolicy`.
/// An unknown value means a controller/worker version mismatch. Controller and
/// worker are co-deployed from one build, so an unknown discriminant is a mis-deploy
/// rather than a data error — panicking surfaces it loudly (a graceful fallback would
/// silently apply the wrong policy).
fn map_policy(policy: i32) -> BindingPolicy {
    match pb::data_binding::Policy::try_from(policy) {
        Ok(pb::data_binding::Policy::PerVu) => BindingPolicy::PerVu,
        Ok(pb::data_binding::Policy::IterSequential) => BindingPolicy::IterSequential,
        Ok(pb::data_binding::Policy::IterRandom) => BindingPolicy::IterRandom,
        Ok(pb::data_binding::Policy::Unique) => BindingPolicy::Unique,
        _ => unreachable!(
            "proto DataBinding.policy {policy} not mapped — controller/worker version mismatch"
        ),
    }
}

/// Open-loop when fixed rate OR a non-empty stage curve is set (S-D §3.5 predicate,
/// proto side). Empty `stages` ≡ absent.
fn proto_is_open_loop(p: &pb::Profile) -> bool {
    p.target_rps.is_some() || !p.stages.is_empty()
}

/// Closed-loop VU curve when vu_stages is non-empty (spec §3.1). Empty ≡ absent.
fn proto_is_vu_curve(p: &pb::Profile) -> bool {
    !p.vu_stages.is_empty()
}

/// Graceful ramp-down cap (§B9): proto seconds → engine `Duration`. Absent
/// (field not set) → `None` (unbounded graceful drain, unchanged behavior).
fn proto_graceful_ramp_down(p: &pb::Profile) -> Option<Duration> {
    p.graceful_ramp_down_seconds
        .map(|s| Duration::from_secs(u64::from(s)))
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

/// 인바운드 서버 스트림에서 이 run의 Abort 신호를 감시한다.
/// - 명시적 `Abort`(run_id 일치) 수신 → 취소하고 반환.
/// - 명시적 Abort 없이 스트림이 닫힘(컨트롤러 크래시/연결 끊김) → **그것도 취소**한다
///   (R4b: cross-platform 하드-크래시 백스톱 — 워커가 좀비 부하를 계속 돌리지 않게).
///
/// 정상 완료 경로에선 호출부가 이 태스크를 `abort()`로 먼저 죽이므로(스트림 close 관찰 전)
/// close-without-abort 취소가 오탐을 내지 않는다. 호출부가 시나리오 완료(lib.rs:427) 직후
/// listener를 abort(lib.rs:430)하는 그 찰나에 스트림이 닫혀 `cancel()`이 발화하더라도
/// **benign-by-construction** — 시나리오는 이미 끝났으니 늦은 취소는 no-op이고, 풀은
/// reconnect-per-run이라 run마다 새 `link`/`inbound_rx`를 받아 stale-channel 누수가 없다.
pub(crate) async fn abort_listener_loop(
    mut inbound_rx: mpsc::Receiver<pb::ServerMessage>,
    run_id: String,
    cancel: CancellationToken,
) {
    while let Some(msg) = inbound_rx.recv().await {
        if let Some(ServerPayload::Abort(a)) = msg.payload {
            if a.run_id == run_id {
                info!(run_id = %run_id, reason = %a.reason, "abort signal received");
                cancel.cancel();
                return;
            }
        }
    }
    // 스트림이 명시적 Abort 없이 닫힘 = 컨트롤러 연결 끊김(크래시). 좀비 run 방지 취소.
    info!(
        run_id = %run_id,
        "inbound stream closed without abort — cancelling run (controller disconnect)"
    );
    cancel.cancel();
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
            cause: None,
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
    fn run_duration_uses_vu_stage_sum() {
        let p = pb::Profile {
            duration_seconds: 0,
            vu_stages: vec![
                pb::Stage {
                    target: 5,
                    duration_seconds: 3,
                },
                pb::Stage {
                    target: 1,
                    duration_seconds: 4,
                },
            ],
            ..Default::default()
        };
        assert_eq!(run_duration_secs(&p), 7);
        assert!(proto_is_vu_curve(&p));
        assert!(!proto_is_open_loop(&p));

        // Priority tie-break: when both vu_stages and stages are set, the VU curve wins
        // (run_duration_secs and dispatch both check vu_stages first).
        let p2 = pb::Profile {
            vu_stages: p.vu_stages.clone(),
            stages: vec![pb::Stage {
                target: 100,
                duration_seconds: 99,
            }],
            ..Default::default()
        };
        assert_eq!(run_duration_secs(&p2), 7); // vu_stages sum (3+4), not stages' 99
        assert!(proto_is_vu_curve(&p2));
        // proto_is_open_loop = target_rps.is_some() || !stages.is_empty();
        // stages is non-empty here, so this is true — but dispatch checks is_vu_curve first,
        // so the VU-curve path wins regardless.
        assert!(proto_is_open_loop(&p2));
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

    // ---- pool worker id tests ----

    #[test]
    fn pool_worker_id_explicit_override() {
        assert_eq!(resolve_pool_worker_id(Some("w-x".into())), "w-x");
    }

    #[test]
    fn pool_worker_id_random_is_nonempty_and_stable() {
        // When no explicit id, a fresh ULID (26 Crockford chars) is generated.
        // Process-lifetime stability is guaranteed by run_pool calling this once
        // outside its loop.
        let id = resolve_pool_worker_id(None);
        assert_eq!(id.len(), 26);
        assert!(!id.is_empty());
    }

    // ---- run_dispatch routing tests (user override: should_run_pool predicate) ----

    #[test]
    fn should_run_pool_returns_false_when_run_id_present() {
        let args = WorkerArgs {
            controller: "http://x".into(),
            run_id: Some("r1".into()),
            worker_id: None,
            capacity_vus: 1,
            token: None,
        };
        assert!(!should_run_pool(&args));
    }

    #[test]
    fn should_run_pool_returns_true_when_run_id_absent() {
        let args = WorkerArgs {
            controller: "http://x".into(),
            run_id: None,
            worker_id: None,
            capacity_vus: 1,
            token: None,
        };
        assert!(should_run_pool(&args));
    }

    #[test]
    fn resolve_hostname_returns_string_or_empty() {
        // 머신마다 값이 다르므로 "panic 없이 String 반환"만 단언(빈 폴백 포함 OK).
        let h = resolve_hostname();
        let _ = h.len(); // 호출이 패닉하지 않음
    }

    #[test]
    fn worker_id_is_stable_reflects_explicit_id() {
        assert!(
            worker_id_is_stable(&Some("w1".to_string())),
            "explicit --worker-id → stable"
        );
        assert!(!worker_id_is_stable(&None), "auto random ULID → ephemeral");
    }

    #[test]
    fn maps_graceful_cap_seconds_to_duration() {
        let p = pb::Profile {
            graceful_ramp_down_seconds: Some(7),
            ..Default::default()
        };
        assert_eq!(proto_graceful_ramp_down(&p), Some(Duration::from_secs(7)));

        let p_absent = pb::Profile {
            graceful_ramp_down_seconds: None,
            ..Default::default()
        };
        assert_eq!(proto_graceful_ramp_down(&p_absent), None);
    }

    #[tokio::test]
    async fn abort_listener_explicit_abort_cancels() {
        let (tx, rx) = mpsc::channel::<pb::ServerMessage>(4);
        let cancel = CancellationToken::new();
        let h = tokio::spawn(abort_listener_loop(rx, "run-1".to_string(), cancel.clone()));
        tx.send(pb::ServerMessage {
            payload: Some(ServerPayload::Abort(pb::AbortRun {
                run_id: "run-1".to_string(),
                reason: "user".to_string(),
            })),
        })
        .await
        .unwrap();
        h.await.unwrap();
        assert!(cancel.is_cancelled());
    }

    #[tokio::test]
    async fn abort_listener_inbound_close_cancels() {
        // R4b: 컨트롤러 크래시 시뮬레이션 — 명시적 Abort 없이 송신자 drop으로 스트림 close.
        let (tx, rx) = mpsc::channel::<pb::ServerMessage>(4);
        let cancel = CancellationToken::new();
        let h = tokio::spawn(abort_listener_loop(rx, "run-1".to_string(), cancel.clone()));
        drop(tx);
        h.await.unwrap();
        assert!(cancel.is_cancelled());
    }

    #[tokio::test]
    async fn abort_listener_aborted_before_close_no_false_positive() {
        // 정상 완료 경로: 호출부가 listener를 먼저 abort → 그 뒤 스트림이 닫혀도 취소 안 됨.
        let (tx, rx) = mpsc::channel::<pb::ServerMessage>(4);
        let cancel = CancellationToken::new();
        let h = tokio::spawn(abort_listener_loop(rx, "run-1".to_string(), cancel.clone()));
        h.abort();
        let _ = h.await;
        drop(tx);
        tokio::task::yield_now().await;
        assert!(!cancel.is_cancelled());
    }
}
