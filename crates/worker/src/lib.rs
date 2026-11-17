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
pub use handicap_worker_core::pool_status;
use handicap_worker_core::pool_status::{
    FailReason, PROBE_TIMEOUT, PoolEvent, RUN_ID_MAX_CHARS, SCENARIO_NAME_MAX_CHARS, classify,
    desktop_retry_delay, probe_first, sanitize_clip, tcp_reachable,
};
use handicap_worker_core::{
    RegisterOpts, WorkerError, WorkerLink, connect_and_register_opts, connect_with_backoff,
    load_datasets,
};
use pb::server_message::Payload as ServerPayload;
use pb::worker_message::Payload as WorkerPayload;
use pb::{
    ActiveVuSample, BranchStat, ErrorKindStat, GroupStat, LoopExitStat, LoopStat, MetricBatch,
    MetricWindow, PhaseStat, RunStatus, WorkerMessage,
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
pub fn resolve_hostname() -> String {
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

    let is_open_loop = proto_is_open_loop(&profile);
    let is_vu_curve = proto_is_vu_curve(&profile);

    let plan = to_run_plan(
        &profile,
        assignment.vu_count,
        assignment.vu_offset,
        env,
        datasets,
    );
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
            let Some(batch) =
                flush_to_batch(flush, &run_id_for_forwarder, &worker_id_for_forwarder)
            else {
                continue;
            };
            let msg = WorkerMessage {
                payload: Some(WorkerPayload::MetricBatch(batch)),
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
    // stream. We then wait, capped at 2s, for `inbound_fwd` (the controller
    // closing its leg). The controller releases its copy of our stream's sender
    // once we report our end phase and removes the run entry at finalization. A
    // worker whose report is not the last closes at once; the last reporter's leg
    // closes only after the controller finishes finalization (status write and
    // report build). 2s is the upper bound. `inbound_fwd` is a `ForwarderTask`
    // moved into the timeout: when the wait expires (or this future is dropped)
    // the forwarder is aborted, not detached.
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
        version = env!("CARGO_PKG_VERSION"),
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
    let cancel = CancellationToken::new(); // process-level (SIGTERM)
    let signal_task = spawn_sigterm(cancel.clone());
    let res = run_pool_until(args, cancel).await;
    signal_task.abort();
    res
}

/// Pool loop with an externally owned cancel token (no signal handler
/// installed) — used by `run_pool` (SIGTERM) and the desktop shell.
pub async fn run_pool_until(args: WorkerArgs, cancel: CancellationToken) -> anyhow::Result<()> {
    let worker_id = resolve_pool_worker_id(args.worker_id.clone());
    let stable = worker_id_is_stable(&args.worker_id);
    let token = args.token.as_deref().unwrap_or("");
    let hostname = resolve_hostname();
    info!(version = env!("CARGO_PKG_VERSION"), %worker_id, "pool worker starting (idle)");
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
    info!("pool worker exiting");
    Ok(())
}

/// 데스크톱 부하기가 접속할 풀 컨트롤러. 후보 IP마다 같은 포트를 시도한다.
pub struct PoolTarget {
    pub ips: Vec<std::net::Ipv4Addr>,
    pub port: u16,
    pub token: String,
    pub worker_id: String,
    pub capacity_vus: u32,
}

impl std::fmt::Debug for PoolTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PoolTarget")
            .field("ips", &self.ips)
            .field("port", &self.port)
            .field("token", &"[REDACTED]")
            .field("worker_id", &self.worker_id)
            .field("capacity_vus", &self.capacity_vus)
            .finish()
    }
}

/// 취소 토큰이 울리면 `true`, `dur`이 먼저 지나면 `false`.
async fn sleep_or_cancel(dur: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        _ = cancel.cancelled() => true,
        _ = tokio::time::sleep(dur) => false,
    }
}

/// 이유가 직전과 달라졌을 때만 warn, 같으면 debug(영영 재시도하는 루프가 같은 경고를 반복하지 않게).
fn log_failure(last: &mut Option<FailReason>, reason: &FailReason, msg: &str) {
    if last.as_ref() == Some(reason) {
        debug!(?reason, "{msg}");
    } else {
        warn!(?reason, "{msg}");
        *last = Some(reason.clone());
    }
}

/// 배정 하나의 `RunStarted` 사건.
fn run_started_event(a: &pb::RunAssignment) -> PoolEvent {
    PoolEvent::RunStarted {
        run_id: sanitize_clip(&a.run_id, RUN_ID_MAX_CHARS),
        scenario_name: Scenario::from_yaml(&a.scenario_yaml)
            .ok()
            .map(|s| sanitize_clip(&s.name, SCENARIO_NAME_MAX_CHARS)),
    }
}

/// 수락 전에 이 이유로 실패한 후보는 다음 탐침에서 뺀다(닿지 않은 후보는 빼지 않는다).
fn excludes_candidate(reason: &FailReason) -> bool {
    !matches!(reason, FailReason::Unreachable)
}

/// 데스크톱 전용 풀 루프: 사이클마다 IP 탐침 → 접속 → 배정 실행, 실패해도 포기하지 않고
/// 1·2·4·8s 간격으로 다시 시도하며 상태 사건을 `events`로 알린다. `cancel`이 울리면 반환한다.
/// 서버의 `Disconnect`(제외)는 호출자 토큰의 자식 토큰만 취소되는 것으로 알아본다.
pub async fn run_pool_desktop(
    target: PoolTarget,
    cancel: CancellationToken,
    events: pool_status::EventSink,
) -> anyhow::Result<()> {
    run_pool_desktop_with(target, cancel, events, tcp_reachable).await
}

/// `run_pool_desktop`과 같고, 탐침의 연결 함수만 주입받는다(테스트용).
#[doc(hidden)]
pub async fn run_pool_desktop_with<F, Fut>(
    target: PoolTarget,
    cancel: CancellationToken,
    events: pool_status::EventSink,
    reachable: F,
) -> anyhow::Result<()>
where
    F: Fn(std::net::SocketAddr) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let PoolTarget {
        ips,
        port,
        token,
        worker_id,
        capacity_vus,
    } = target;
    let hostname = resolve_hostname();
    let addrs: Vec<std::net::SocketAddr> = ips
        .iter()
        .map(|ip| std::net::SocketAddr::from((*ip, port)))
        .collect();
    let mut attempt = 0usize;
    let mut last_reason: Option<FailReason> = None;
    // 수락 전에 틀린 상대로 판명된 후보. 전부 빠졌거나, 남은 후보 중 아무도 응답하지 않으면 비운다.
    let mut excluded: std::collections::HashSet<std::net::SocketAddr> =
        std::collections::HashSet::new();
    info!(version = env!("CARGO_PKG_VERSION"), %worker_id, "desktop pool worker starting");
    loop {
        if cancel.is_cancelled() {
            break;
        }
        events(PoolEvent::Probing {
            candidates: addrs.len(),
        });
        let mut round: Vec<std::net::SocketAddr> = addrs
            .iter()
            .copied()
            .filter(|a| !excluded.contains(a))
            .collect();
        if round.is_empty() {
            excluded.clear();
            round = addrs.clone();
        }
        let probed = tokio::select! {
            _ = cancel.cancelled() => break,
            p = probe_first(&round, PROBE_TIMEOUT, &reachable) => p,
        };
        let Some(addr) = probed else {
            if round.len() < addrs.len() {
                excluded.clear();
            }
            let d = desktop_retry_delay(attempt);
            log_failure(
                &mut last_reason,
                &FailReason::Unreachable,
                "desktop pool unreachable",
            );
            events(PoolEvent::AttemptFailed {
                reason: FailReason::Unreachable,
                retry_in: d,
            });
            if sleep_or_cancel(d, &cancel).await {
                break;
            }
            attempt += 1;
            continue;
        };

        let child = cancel.child_token();
        let accepted = std::sync::atomic::AtomicBool::new(false);
        let on_accepted = || {
            accepted.store(true, Ordering::SeqCst);
            events(PoolEvent::Accepted { addr });
        };
        let url = format!("http://{addr}");
        let register = connect_and_register_opts(
            &url,
            &worker_id,
            "",
            capacity_vus,
            &token,
            &hostname,
            true,
            &child,
            RegisterOpts {
                connect_timeout: Some(PROBE_TIMEOUT),
                on_accepted: Some(&on_accepted),
            },
        );
        let res = tokio::select! {
            biased;
            r = register => r,
            _ = cancel.cancelled() => break,
        };
        match res {
            Ok(link) => {
                attempt = 0;
                last_reason = None;
                excluded.clear();
                events(run_started_event(&link.assignment));
                if let Err(e) =
                    execute_assignment(link, worker_id.clone(), child.child_token()).await
                {
                    warn!(error = ?e, "desktop pool assignment ended with error; back to idle");
                }
                if cancel.is_cancelled() {
                    break;
                }
                if child.is_cancelled() {
                    events(PoolEvent::Excluded);
                    break;
                }
                events(PoolEvent::RunEnded);
            }
            Err(e) => {
                if cancel.is_cancelled() {
                    break;
                }
                if child.is_cancelled() {
                    events(PoolEvent::Excluded);
                    break;
                }
                let reason = classify(&e);
                let d = if accepted.load(Ordering::SeqCst) {
                    attempt = 0;
                    last_reason = None;
                    excluded.clear();
                    log_failure(&mut last_reason, &reason, "desktop pool session lost");
                    let d = desktop_retry_delay(0);
                    events(PoolEvent::SessionLost { reason });
                    d
                } else {
                    if excludes_candidate(&reason) {
                        excluded.insert(addr);
                    }
                    log_failure(&mut last_reason, &reason, "desktop pool attempt failed");
                    let d = desktop_retry_delay(attempt);
                    events(PoolEvent::AttemptFailed {
                        reason,
                        retry_in: d,
                    });
                    d
                };
                if sleep_or_cancel(d, &cancel).await {
                    break;
                }
                attempt += 1;
            }
        }
    }
    info!("desktop pool worker exiting");
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

/// E3: proto `optional uint32`(초) → 엔진 `Option<Duration>`. 부재 = 미설정.
/// `Some(0)`은 `None`으로 접는다 — reqwest는 0을 즉시-실패 타임아웃으로 설치하므로
/// 신뢰 경계에서 막는다(`http_timeout_seconds == 0 → 30` 방어와 같은 이유).
fn proto_connect_timeout(p: &pb::Profile) -> Option<std::time::Duration> {
    p.connect_timeout_seconds
        .filter(|s| *s > 0)
        .map(|s| std::time::Duration::from_secs(u64::from(s)))
}

/// proto `Profile` + shard 배정 → 엔진 `RunPlan`.
///
/// `execute_assignment`에서 추출한 순수 매핑이라 18필드를 단위 테스트로
/// 잠글 수 있다(추출 전엔 0건이었다). `profile`은 참조 — 호출부가 리터럴
/// 뒤에서 `profile.ramp_up_seconds`를 로그로 다시 읽기 때문이다.
fn to_run_plan(
    profile: &pb::Profile,
    vu_count: u32,
    vu_offset: u32,
    env: BTreeMap<String, String>,
    data_bindings: Vec<Arc<DataSet>>,
) -> RunPlan {
    RunPlan {
        vus: vu_count,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(run_duration_secs(profile)),
        env,
        loop_breakdown_cap: profile.loop_breakdown_cap,
        vu_offset,
        // N independent bindings: field 10 (data_bindings) when present, else the
        // legacy field-5 binding as a 1-element list. 로딩은 호출부
        // (`execute_assignment`)가 하고 여기엔 결과만 전달된다.
        data_bindings,
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
        // open-loop execution path in the caller; None → closed-loop run_scenario.
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
        // §B9: graceful ramp-down 상한(초) → Duration. 부재 = 무상한.
        graceful_ramp_down: proto_graceful_ramp_down(profile),
        // E3: connect 단계 전용 타임아웃. 부재/0 = None = 빌더 호출 없음(byte-identical).
        connect_timeout: proto_connect_timeout(profile),
    }
}

/// 조건 반복 진입 종료 delta (loop-while-report): engine `LoopExitStat` → proto wire.
fn loop_exit_stats_to_proto(stats: Vec<handicap_engine::LoopExitStat>) -> Vec<LoopExitStat> {
    stats
        .into_iter()
        .map(|s| LoopExitStat {
            step_id: s.step_id,
            pass_bucket: s.pass_bucket,
            outcome: s.outcome.as_wire(),
            count: s.count,
            pass_sum: s.pass_sum,
        })
        .collect()
}

/// 엔진 flush 하나를 와이어 `MetricBatch`로 옮긴다. 보낼 내용이 하나도 없으면 `None`.
fn flush_to_batch(flush: MetricFlush, run_id: &str, worker_id: &str) -> Option<MetricBatch> {
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
    let open_loop_seconds: Vec<pb::OpenLoopSecond> = flush
        .open_loop_seconds
        .iter()
        .map(|s| pb::OpenLoopSecond {
            ts_second: s.ts_second,
            launched: s.launched,
            completed: s.completed,
            dropped: s.dropped,
        })
        .collect();
    let error_kind_stats = error_kind_stats_to_proto(flush.error_kind_stats);
    let loop_exit_stats = loop_exit_stats_to_proto(flush.loop_exit_stats);
    // Keep the `flush.dropped == 0` term: the open-loop final flush may carry the
    // run-total dropped count with empty windows. Dropping it would silently
    // discard `dropped` on all-empty-window final flushes (the C1 footgun).
    // Keep `error_kind_stats.is_empty()` too (E1): an error_kind-only flush with
    // all other vecs empty must not be silently skipped (the same C1 footgun).
    // loop_exit_stats도 같은 이유. open_loop_seconds도 같은 이유(초 계수만 든 flush를 버리지 않음).
    if windows.is_empty()
        && loop_stats.is_empty()
        && branch_stats.is_empty()
        && group_stats.is_empty()
        && phase_stats.is_empty()
        && active_vu_samples.is_empty()
        && error_kind_stats.is_empty()
        && loop_exit_stats.is_empty()
        && flush.open_loop_seconds.is_empty()
        && flush.dropped == 0
    {
        return None;
    }
    Some(MetricBatch {
        run_id: run_id.to_string(),
        worker_id: worker_id.to_string(),
        windows,
        loop_stats,
        branch_stats,
        group_stats,
        phase_stats,
        active_vu_samples,
        error_kind_stats,
        loop_exit_stats,
        dropped: flush.dropped,
        open_loop_seconds,
        open_loop_started_at_ms: flush.open_loop_started_at_ms.unwrap_or(0),
    })
}

/// send-실패 분류 delta counts (E1): engine `ErrorKindStat` → proto wire
/// (`kind` becomes the 9-way lowercase_snake string via `ErrorKind::as_str()`).
fn error_kind_stats_to_proto(stats: Vec<handicap_engine::ErrorKindStat>) -> Vec<ErrorKindStat> {
    stats
        .into_iter()
        .map(|s| ErrorKindStat {
            step_id: s.step_id,
            kind: s.kind.as_str().to_string(),
            count: s.count,
        })
        .collect()
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

    fn empty_flush() -> MetricFlush {
        MetricFlush {
            windows: vec![],
            loop_stats: vec![],
            branch_stats: vec![],
            group_stats: vec![],
            dropped: 0,
            phase_stats: vec![],
            active_vu_samples: vec![],
            error_kind_stats: vec![],
            loop_exit_stats: vec![],
            open_loop_seconds: vec![],
            open_loop_started_at_ms: None,
        }
    }

    #[test]
    fn empty_flush_is_skipped() {
        assert!(flush_to_batch(empty_flush(), "r", "w").is_none());
    }

    #[test]
    fn final_flush_with_only_dropped_is_sent() {
        let mut f = empty_flush();
        f.dropped = 7;
        let b = flush_to_batch(f, "r", "w").expect("dropped-only flush must be sent");
        assert_eq!(b.dropped, 7);
        assert_eq!(b.run_id, "r");
        assert_eq!(b.worker_id, "w");
    }

    #[test]
    fn batch_carries_open_loop_seconds_and_start() {
        let mut f = empty_flush();
        f.open_loop_seconds = vec![handicap_engine::OpenLoopSecond {
            ts_second: 5,
            launched: 1,
            completed: 2,
            dropped: 3,
        }];
        f.open_loop_started_at_ms = Some(5_123);
        let b = flush_to_batch(f, "r", "w").expect("must be sent");
        assert_eq!(
            b.open_loop_seconds,
            vec![pb::OpenLoopSecond {
                ts_second: 5,
                launched: 1,
                completed: 2,
                dropped: 3
            }]
        );
        assert_eq!(b.open_loop_started_at_ms, 5_123);
    }

    #[test]
    fn flush_with_only_open_loop_seconds_is_not_skipped() {
        let mut f = empty_flush();
        f.open_loop_seconds = vec![handicap_engine::OpenLoopSecond {
            ts_second: 5,
            launched: 1,
            completed: 0,
            dropped: 0,
        }];
        assert!(flush_to_batch(f, "r", "w").is_some());
    }

    #[test]
    fn missing_open_loop_start_maps_to_zero() {
        let mut f = empty_flush();
        f.dropped = 1;
        let b = flush_to_batch(f, "r", "w").unwrap();
        assert_eq!(b.open_loop_started_at_ms, 0);
    }

    #[test]
    fn pool_target_debug_redacts_token() {
        let t = PoolTarget {
            ips: vec![std::net::Ipv4Addr::LOCALHOST],
            port: 1,
            token: "s3cret-token".into(),
            worker_id: "w".into(),
            capacity_vus: 1,
        };
        let d = format!("{t:?}");
        assert!(!d.contains("s3cret-token"), "{d}");
        assert!(d.contains("[REDACTED]"), "{d}");
    }

    /// `yaml_name`은 YAML 값 그대로(큰따옴표 이스케이프 가능).
    fn assignment_with(run_id: &str, yaml_name: &str) -> pb::RunAssignment {
        pb::RunAssignment {
            run_id: run_id.into(),
            scenario_yaml: format!("version: 1\nname: {yaml_name}\nsteps: []\n"),
            ..Default::default()
        }
    }

    #[test]
    fn run_started_event_sanitizes_scenario_name_and_run_id() {
        let ev = run_started_event(&assignment_with("r\n1\u{202E}", r#""a\u2066b\tc""#));
        assert_eq!(
            ev,
            PoolEvent::RunStarted {
                run_id: "r\u{FFFD}1\u{FFFD}".into(),
                scenario_name: Some("a\u{FFFD}b\u{FFFD}c".into()),
            }
        );
    }

    #[test]
    fn run_started_event_clips_run_id_to_64_and_name_to_80() {
        let ev = run_started_event(&assignment_with(&"r".repeat(100), &"가".repeat(100)));
        let PoolEvent::RunStarted {
            run_id,
            scenario_name,
        } = ev
        else {
            panic!("{ev:?}");
        };
        assert_eq!(run_id.chars().count(), 64);
        assert_eq!(scenario_name.unwrap().chars().count(), 80);
    }

    #[test]
    fn run_started_event_without_parsable_scenario_has_no_name() {
        let a = pb::RunAssignment {
            run_id: "r1".into(),
            scenario_yaml: "not: [valid".into(),
            ..Default::default()
        };
        assert_eq!(
            run_started_event(&a),
            PoolEvent::RunStarted {
                run_id: "r1".into(),
                scenario_name: None,
            }
        );
    }

    #[test]
    fn excluded_candidate_reasons() {
        assert!(!excludes_candidate(&FailReason::Unreachable));
        assert!(excludes_candidate(&FailReason::AuthFailed));
        assert!(excludes_candidate(&FailReason::Protocol));
        assert!(excludes_candidate(&FailReason::Rejected("x".into())));
    }

    fn closed_port() -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    }

    fn args_for(p: u16) -> WorkerArgs {
        WorkerArgs {
            controller: format!("http://127.0.0.1:{p}"),
            run_id: None,
            worker_id: Some("t".into()),
            capacity_vus: 1000,
            token: None,
        }
    }

    #[tokio::test]
    async fn run_pool_until_returns_when_precancelled() {
        let c = CancellationToken::new();
        c.cancel();
        tokio::time::timeout(
            Duration::from_secs(2),
            run_pool_until(args_for(closed_port()), c),
        )
        .await
        .expect("must return")
        .unwrap();
    }

    #[tokio::test]
    async fn run_pool_until_stops_on_cancel_during_backoff() {
        let c = CancellationToken::new();
        let c2 = c.clone();
        let h = tokio::spawn(run_pool_until(args_for(closed_port()), c));
        tokio::time::sleep(Duration::from_millis(300)).await;
        c2.cancel();
        tokio::time::timeout(Duration::from_secs(2), h)
            .await
            .expect("must stop")
            .unwrap()
            .unwrap();
    }

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

    #[test]
    fn connect_timeout_maps_seconds_to_duration() {
        // E3: proto optional uint32 → Option<Duration> 직결.
        let p = pb::Profile {
            duration_seconds: 10,
            http_timeout_seconds: 30,
            connect_timeout_seconds: Some(3),
            ..Default::default()
        };
        assert_eq!(
            proto_connect_timeout(&p),
            Some(std::time::Duration::from_secs(3))
        );
    }

    #[test]
    fn connect_timeout_absent_maps_to_none() {
        // 구 컨트롤러(필드 부재) → None → 빌더 호출 없음(byte-identical).
        let p = pb::Profile {
            duration_seconds: 10,
            http_timeout_seconds: 30,
            ..Default::default()
        };
        assert_eq!(proto_connect_timeout(&p), None);
    }

    #[test]
    fn connect_timeout_zero_maps_to_none() {
        // Some(0)을 그대로 넘기면 reqwest가 "즉시 실패" 타임아웃을 설치해 모든 요청이
        // 깨진다. 컨트롤러가 0을 거부하지만 워커가 신뢰 경계 —
        // http_timeout_seconds==0 → 30 방어(lib.rs:243-249)와 같은 자리.
        let p = pb::Profile {
            duration_seconds: 10,
            http_timeout_seconds: 30,
            connect_timeout_seconds: Some(0),
            ..Default::default()
        };
        assert_eq!(proto_connect_timeout(&p), None);
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

    #[test]
    fn error_kind_stats_map_to_proto_wire_strings() {
        use handicap_engine::{ErrorKind, ErrorKindStat};
        let out = error_kind_stats_to_proto(vec![
            ErrorKindStat {
                step_id: "s1".into(),
                kind: ErrorKind::ConnectRefused,
                count: 3,
            },
            ErrorKindStat {
                step_id: "s2".into(),
                kind: ErrorKind::LocalPortExhaustion,
                count: 1,
            },
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(
            (out[0].step_id.as_str(), out[0].kind.as_str(), out[0].count),
            ("s1", "connect_refused", 3)
        );
        assert_eq!(
            (out[1].step_id.as_str(), out[1].kind.as_str(), out[1].count),
            ("s2", "local_port_exhaustion", 1)
        );
    }

    #[test]
    fn loop_exit_stats_map_to_proto_wire_values() {
        use handicap_engine::{LoopExitOutcome, LoopExitStat};
        let out = loop_exit_stats_to_proto(vec![
            LoopExitStat {
                step_id: "l1".into(),
                pass_bucket: 21,
                outcome: LoopExitOutcome::Truncated,
                count: 2,
                pass_sum: 90,
            },
            LoopExitStat {
                step_id: "l1".into(),
                pass_bucket: 3,
                outcome: LoopExitOutcome::Exhausted,
                count: 1,
                pass_sum: 3,
            },
        ]);
        assert_eq!(
            out.iter()
                .map(|s| (
                    s.step_id.as_str(),
                    s.pass_bucket,
                    s.outcome,
                    s.count,
                    s.pass_sum
                ))
                .collect::<Vec<_>>(),
            vec![("l1", 21, 2, 2, 90), ("l1", 3, 1, 1, 3)]
        );
    }

    /// C1 sentinel `pb::Profile` — 컨트롤러 픽스처(`grpc/profile.rs`)와 같은
    /// 값으로 골랐다(가독성 규약일 뿐 크로스-크레이트로 강제되지 않는다 —
    /// 드리프트해도 양쪽 테스트는 각자 옳다). 필드마다 다르다.
    ///
    /// ⚠ `..Default::default()` 금지 — 15필드 전부 명시하는 것이 목적이다
    /// (proto 필드 추가 시 여기서 컴파일 에러가 나야 한다).
    ///
    /// ⚠ `target_rps` + `stages` + `vu_stages`를 **동시에** 채운 것은 **의도**다.
    /// 실제 run에선 `validate_run_config`가 거부하는 조합이지만, 순수 매핑
    /// 함수는 검증을 하지 않고, 세 필드를 모두 채워야 같은-타입 이웃 전치
    /// 판별력이 최대가 된다. "잘못된 픽스처"로 보고 고치지 말 것.
    fn c1_pb_profile() -> pb::Profile {
        pb::Profile {
            vus: 11,
            ramp_up_seconds: 22,
            duration_seconds: 33,
            loop_breakdown_cap: 44,
            http_timeout_seconds: 55,
            think_time: Some(pb::ThinkTime {
                min_ms: 66,
                max_ms: 77,
            }),
            think_seed: Some(88),
            target_rps: Some(99),
            max_in_flight: Some(111),
            stages: vec![pb::Stage {
                target: 122,
                duration_seconds: 133,
            }],
            measure_phases: true,
            // 원소 2개 필수 — 파생 duration(합=332)이 자기 구성요소와
            // 겹치지 않아야 sentinel 유일성이 유지된다.
            vu_stages: vec![
                pb::Stage {
                    target: 144,
                    duration_seconds: 155,
                },
                pb::Stage {
                    target: 166,
                    duration_seconds: 177,
                },
            ],
            ramp_down_immediate: false,
            graceful_ramp_down_seconds: Some(188),
            connect_timeout_seconds: Some(199),
        }
    }

    fn c1_dataset() -> Arc<DataSet> {
        Arc::new(DataSet {
            policy: BindingPolicy::PerVu,
            seed: 255,
            rows: vec![BTreeMap::from([("k".to_string(), "v".to_string())])],
        })
    }

    /// C1(워커): 전 필드 sentinel.
    ///
    /// `..` 없는 **전 필드 구조분해**가 핵심 장치다 — `RunPlan`에 필드가
    /// 추가되면 이 패턴이 컴파일 에러를 낸다. (`RunPlan`은 `PartialEq`를
    /// 파생하지 않고, `Vec<Arc<DataSet>>` 때문에 파생시키려면 엔진
    /// 프로덕션 타입까지 손대야 하므로 통째 비교 대신 이 방식을 쓴다.)
    /// 구조분해한 바인딩은 **전부 단언**한다 — 안 하면 `unused_variables`가
    /// `-D warnings`(게이트가 `--all-targets`)로 실패한다.
    #[test]
    fn c1_worker_all_fields_map_to_distinct_sentinels() {
        let env = BTreeMap::from([("E".to_string(), "1".to_string())]);
        let ds = c1_dataset();
        let plan = to_run_plan(
            &c1_pb_profile(),
            233,
            244,
            env.clone(),
            vec![Arc::clone(&ds)],
        );

        let RunPlan {
            vus,
            ramp_up,
            duration,
            env: plan_env,
            loop_breakdown_cap,
            vu_offset,
            data_bindings,
            http_timeout,
            think_time,
            think_seed,
            target_rps,
            max_in_flight,
            stages,
            measure_phases,
            vu_stages,
            ramp_down,
            graceful_ramp_down,
            connect_timeout,
        } = plan;

        assert_eq!(
            vus, 233,
            "vus는 첫 u32 인자에서 온다 — 호출부 전치는 e2e가 잡는다"
        );
        assert_eq!(vu_offset, 244, "vu_offset");
        assert_eq!(ramp_up, Duration::from_secs(22), "ramp_up");
        // 파생값: run_duration_secs가 vu_stages 우선 → 155 + 177 = 332.
        // (입력 duration_seconds=33이 아니다.)
        assert_eq!(duration, Duration::from_secs(332), "duration(vu_stages 합)");
        assert_eq!(plan_env, env, "env");
        assert_eq!(loop_breakdown_cap, 44, "loop_breakdown_cap");
        assert_eq!(data_bindings.len(), 1, "data_bindings.len");
        assert!(
            Arc::ptr_eq(&data_bindings[0], &ds),
            "data_bindings는 같은 Arc를 그대로 전달해야 한다"
        );
        assert_eq!(http_timeout, Duration::from_secs(55), "http_timeout");
        assert_eq!(
            think_time.map(|t| (t.min_ms, t.max_ms)),
            Some((66, 77)),
            "think_time"
        );
        assert_eq!(think_seed, Some(88), "think_seed");
        assert_eq!(target_rps, Some(99), "target_rps");
        assert_eq!(max_in_flight, Some(111), "max_in_flight");
        assert_eq!(
            stages.map(|v| v
                .iter()
                .map(|s| (s.target, s.duration_seconds))
                .collect::<Vec<_>>()),
            Some(vec![(122, 133)]),
            "stages"
        );
        assert!(measure_phases, "measure_phases");
        assert_eq!(
            vu_stages.map(|v| v
                .iter()
                .map(|s| (s.target, s.duration_seconds))
                .collect::<Vec<_>>()),
            Some(vec![(144, 155), (166, 177)]),
            "vu_stages"
        );
        assert_eq!(ramp_down, RampDown::Graceful, "ramp_down");
        assert_eq!(
            graceful_ramp_down,
            Some(Duration::from_secs(188)),
            "graceful_ramp_down"
        );
        assert_eq!(
            connect_timeout,
            Some(Duration::from_secs(199)),
            "connect_timeout"
        );
    }

    /// C2(워커): 전부 부재/기본.
    ///
    /// ⚠ 기대값이 입력의 직역이 **아니다**: `http_timeout_seconds = 0`은
    /// 0-폴백으로 **30초**가 되고(`Duration::ZERO`를 기대하면 엉뚱한 이유로
    /// RED), 모든 stage 리스트가 비어 `duration`은 `duration_seconds`로
    /// 폴백하며, `ramp_down_immediate=false` → `Graceful`이다.
    #[test]
    fn c2_worker_absent_and_defaults() {
        let p = pb::Profile {
            vus: 0,
            ramp_up_seconds: 0,
            duration_seconds: 7,
            loop_breakdown_cap: 0,
            http_timeout_seconds: 0,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: vec![],
            measure_phases: false,
            vu_stages: vec![],
            ramp_down_immediate: false,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
        };
        let plan = to_run_plan(&p, 0, 0, BTreeMap::new(), vec![]);

        assert_eq!(plan.stages, None, "빈 stages → None");
        assert_eq!(plan.vu_stages, None, "빈 vu_stages → None");
        assert_eq!(plan.think_time, None, "think_time");
        assert_eq!(plan.think_seed, None, "think_seed");
        assert_eq!(plan.target_rps, None, "target_rps");
        assert_eq!(plan.max_in_flight, None, "max_in_flight");
        assert_eq!(plan.graceful_ramp_down, None, "graceful_ramp_down");
        assert_eq!(plan.connect_timeout, None, "connect_timeout");
        assert!(!plan.measure_phases, "measure_phases");
        assert_eq!(plan.ramp_down, RampDown::Graceful, "ramp_down");
        assert_eq!(plan.duration, Duration::from_secs(7), "duration은 폴백");
        assert!(plan.data_bindings.is_empty(), "data_bindings");
        // 0-폴백. C4와 중복이지만 spec §4.2가 명시적으로 요구한다 — 이 단언이
        // 없으면 위 ⚠ 주석이 존재하지 않는 커버리지를 사칭한다.
        assert_eq!(
            plan.http_timeout,
            Duration::from_secs(30),
            "http_timeout 0-폴백"
        );
    }

    /// C3(워커): `bool` 2상태 → `RampDown`.
    ///
    /// **이 케이스가 없으면 `ramp_down: RampDown::Graceful` 하드코딩 회귀가
    /// 전 케이스를 통과한다** — C1·C2가 둘 다 `false`쪽이기 때문이다.
    /// 이 슬라이스가 겨냥하는 placeholder 실패 모드 그 자체다(R6).
    #[test]
    fn c3_worker_ramp_down_immediate_maps_to_immediate() {
        let mut p = c1_pb_profile();
        p.ramp_down_immediate = true;
        let plan = to_run_plan(&p, 1, 0, BTreeMap::new(), vec![]);
        assert_eq!(plan.ramp_down, RampDown::Immediate, "true → Immediate");
        // 다른 bool이 이 자리를 대신 채우고 있지 않은지 교차 확인.
        assert!(plan.measure_phases, "measure_phases는 여전히 true");
    }

    /// C4: `http_timeout_seconds == 0` → 30초 폴백(옛 컨트롤러 호환).
    /// `!= 0` 경로는 C1(55초)이 덮는다.
    #[test]
    fn c4_worker_http_timeout_zero_falls_back_to_30s() {
        let mut p = c1_pb_profile();
        p.http_timeout_seconds = 0;
        let plan = to_run_plan(&p, 1, 0, BTreeMap::new(), vec![]);
        assert_eq!(plan.http_timeout, Duration::from_secs(30));
    }
}
