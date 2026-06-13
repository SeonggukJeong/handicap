use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rand::RngCore;
use rand::SeedableRng;
use rand::rngs::StdRng;
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, instrument, warn};

use crate::aggregator::{Aggregator, BranchStat, GroupStat, LoopStat, PhaseStat, StepWindow};
use crate::condition::eval_condition;
use crate::dataset::{BindingPolicy, DataSet};
use crate::error::{EngineError, Result};
use crate::executor::{VuClient, execute_step};
use crate::pacing::{PaceOutcome, ThinkTime, pace};
use crate::scenario::{Scenario, Step};
use crate::template::TemplateContext;

/// One stage of an open-loop rate curve: ramp the arrival rate to `target` (req/s)
/// over `duration_seconds`, linearly from the previous stage's target (0 for the
/// first stage). Run-config concept (profile_json) — plain derive, no YAML round-trip
/// (NOT a scenario.rs manual-serde enum). Reused by the controller store Profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stage {
    pub target: u32,
    pub duration_seconds: u32,
}

/// VU 곡선 ramp-down 시 초과분 VU 처리 (spec §2). Graceful = 현재 iteration을
/// 마치고 park, Immediate = 활성화 child 토큰 취소 → 다음 스텝 경계에서 중단 후
/// park (진행 중 HTTP 요청 1개는 마저 끝남 — mid-request 소켓 중단은 비목표).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RampDown {
    #[default]
    Graceful,
    Immediate,
}

#[derive(Debug, Clone)]
pub struct RunPlan {
    pub vus: u32,
    pub ramp_up: Duration,
    pub duration: Duration,
    pub env: BTreeMap<String, String>,
    pub loop_breakdown_cap: u32,
    /// Global VU id offset for this shard: `vu_id = vu_offset + spawned`.
    /// `0` for a single-worker run (legacy numbering). (A3a spec §3.)
    pub vu_offset: u32,
    /// Optional data-driven binding. `None` → no injection (back-compat).
    pub data_binding: Option<Arc<DataSet>>,
    /// Total per-request HTTP timeout for every VU client (reqwest client-level).
    /// `30s` reproduces the pre-S-A hardcoded default.
    pub http_timeout: Duration,
    /// Inter-iteration think time (run-level pacing). `None` → no pause.
    pub think_time: Option<ThinkTime>,
    /// Think time RNG seed. `Some` → reproducible per (seed, vu_id); `None` → entropy.
    pub think_seed: Option<u32>,
    /// Open-loop target arrival rate (req/s). `Some` → open-loop path
    /// (`run_scenario_open_loop`); `None` → closed-loop `run_scenario` (byte-identical).
    pub target_rps: Option<u32>,
    /// Open-loop concurrent in-flight cap = reusable slot-pool size. Required when
    /// `target_rps` is set (controller-validated). Each slot = one `VuClient` + cookie jar.
    pub max_in_flight: Option<u32>,
    /// Open-loop multi-stage rate curve (S-D). `Some(non-empty)` → the open-loop
    /// scheduler drives arrivals at `rate_at(stages, elapsed)` instead of the fixed
    /// `target_rps`. `None` → fixed rate (byte-identical to S-C). The worker sets
    /// `duration == sum(stage durations)` as an invariant (the engine derives the
    /// deadline from `plan.duration`, not from `stages`).
    pub stages: Option<Vec<Stage>>,
    /// Opt-in latency-phase breakdown (B7-C). `true` → the Http arm records the
    /// download phase via `Aggregator::record_phase`. `false` → byte-identical (no
    /// phase channel touched). Default false at every absent boundary.
    pub measure_phases: bool,
    /// Closed-loop VU curve (spec §3.1): `Some(non-empty)` → the worker selects
    /// `run_scenario_vu_curve` (park-gate). `None` → fixed closed / open-loop
    /// (byte-identical). The worker sets `duration == sum(stage durations)`
    /// (same invariant as `stages`).
    pub vu_stages: Option<Vec<Stage>>,
    /// VU-curve ramp-down mode. Only meaningful with `vu_stages` (controller-validated).
    pub ramp_down: RampDown,
}

/// One flush from the engine to the worker: a batch of completed 1s windows
/// plus the per-(step_id, loop_index) count deltas accumulated since the last flush,
/// plus per-(if_id, branch) decision-count deltas.
#[derive(Debug)]
pub struct MetricFlush {
    pub windows: Vec<StepWindow>,
    pub loop_stats: Vec<LoopStat>,
    pub branch_stats: Vec<BranchStat>,
    pub group_stats: Vec<GroupStat>,
    /// Open-loop arrivals dropped because the slot pool was full, since the last
    /// flush (delta). Always `0` on the closed-loop path.
    pub dropped: u64,
    /// Per-(step_id, phase) latency-phase deltas since the last flush (B7-C).
    pub phase_stats: Vec<PhaseStat>,
}

/// Drive `vus` virtual users through `scenario` for `plan.duration`, streaming
/// completed 1s windows to `out`. Returns when the run finishes (all VUs done).
pub async fn run_scenario(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<MetricFlush>,
    cancel: CancellationToken,
) -> Result<()> {
    let agg = Arc::new(Mutex::new(Aggregator::new(plan.loop_breakdown_cap)));
    let started_at = Instant::now();
    let deadline = started_at + plan.duration;
    let failed = Arc::new(AtomicU32::new(0));
    let env = Arc::new(plan.env);
    let dataset = plan.data_binding.clone();
    let http_timeout = plan.http_timeout;
    let think_time = plan.think_time;
    let think_seed = plan.think_seed;
    let measure_phases = plan.measure_phases;
    // One shared worker-local counter for IterSequential and Unique, created once per run.
    let seq_counter = match dataset.as_ref().map(|d| d.policy) {
        Some(BindingPolicy::IterSequential | BindingPolicy::Unique) => {
            Some(Arc::new(AtomicU64::new(0)))
        }
        _ => None,
    };

    let mut set = JoinSet::new();

    let ramp_secs = plan.ramp_up.as_secs();
    let per_tick: u32 = if ramp_secs == 0 || plan.vus == 0 {
        plan.vus
    } else {
        plan.vus.div_ceil(ramp_secs as u32).max(1)
    };

    let mut spawned: u32 = 0;
    let mut next_spawn = started_at;

    loop {
        if cancel.is_cancelled() {
            break;
        }
        if spawned >= plan.vus {
            break;
        }
        if Instant::now() < next_spawn {
            // Sleep until the next tick OR until cancel fires.
            let until = next_spawn.saturating_duration_since(Instant::now());
            tokio::select! {
                _ = tokio::time::sleep(until) => {}
                _ = cancel.cancelled() => break,
            }
            continue;
        }
        let mut spawn_now = per_tick.min(plan.vus - spawned);
        while spawn_now > 0 {
            let vu_id = plan.vu_offset.saturating_add(spawned);
            let scenario = scenario.clone();
            let agg = agg.clone();
            let failed = failed.clone();
            let env = env.clone();
            let cancel_vu = cancel.clone();
            let dataset = dataset.clone();
            let seq_counter = seq_counter.clone();
            set.spawn(async move {
                if let Err(e) = run_vu(
                    scenario,
                    vu_id,
                    agg,
                    deadline,
                    env,
                    cancel_vu,
                    dataset,
                    seq_counter,
                    http_timeout,
                    think_time,
                    think_seed,
                    measure_phases,
                )
                .await
                {
                    if !matches!(e, EngineError::Aborted) {
                        warn!(vu_id, error = ?e, "vu failed");
                    }
                    failed.fetch_add(1, Ordering::Relaxed);
                }
            });
            spawned += 1;
            spawn_now -= 1;
        }
        next_spawn += Duration::from_secs(1);
    }

    // Flusher: drain completed 1s windows until the run ends.
    let flush_agg = agg.clone();
    let flush_out = out.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = chrono_second();
            let (drained, loop_stats, branch_stats, group_stats, phase_stats) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                    g.drain_phase_deltas(),
                )
            };
            if !drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
                || !phase_stats.is_empty()
            {
                debug!(
                    count = drained.len(),
                    loops = loop_stats.len(),
                    branches = branch_stats.len(),
                    groups = group_stats.len(),
                    "flushing windows"
                );
                if flush_out
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
                        group_stats,
                        dropped: 0,
                        phase_stats,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            if flush_out.is_closed() {
                break;
            }
        }
    });

    while let Some(res) = set.join_next().await {
        if let Err(e) = res {
            warn!(error = %e, "vu join error");
            failed.fetch_add(1, Ordering::Relaxed);
        }
    }

    let (final_windows, final_loops, final_branches, final_groups, final_phases) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
            g.drain_phase_deltas(),
        )
    };
    if !final_windows.is_empty()
        || !final_loops.is_empty()
        || !final_branches.is_empty()
        || !final_groups.is_empty()
        || !final_phases.is_empty()
    {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
                group_stats: final_groups,
                dropped: 0,
                phase_stats: final_phases,
            })
            .await;
    }
    drop(out);
    flusher.abort();
    let _ = flusher.await;

    if cancel.is_cancelled() {
        return Err(EngineError::Aborted);
    }

    let failed_count = failed.load(Ordering::Relaxed);
    if plan.vus > 0 && failed_count >= plan.vus {
        warn!(failed = failed_count, total = plan.vus, "all VUs failed");
        return Err(EngineError::AllVusFailed {
            failed: failed_count,
            total: plan.vus,
        });
    }
    if failed_count > 0 {
        info!(
            failed = failed_count,
            total = plan.vus,
            "run finished with partial VU failures"
        );
    } else {
        info!("run finished");
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[instrument(skip(scenario, agg, env, dataset, seq_counter), fields(vu_id))]
async fn run_vu(
    scenario: Arc<Scenario>,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: Arc<BTreeMap<String, String>>,
    cancel: CancellationToken,
    dataset: Option<Arc<DataSet>>,
    seq_counter: Option<Arc<AtomicU64>>,
    http_timeout: Duration,
    think_time: Option<ThinkTime>,
    think_seed: Option<u32>,
    measure_phases: bool,
) -> Result<()> {
    let client = VuClient::with_timeout(scenario.cookie_jar, http_timeout)?;
    let mut think_rng = match think_seed {
        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, 0)),
        None => StdRng::from_entropy(),
    };
    let mut iter_id: u32 = 0;
    while Instant::now() < deadline {
        if cancel.is_cancelled() {
            return Err(EngineError::Aborted);
        }
        // Per-iteration flow vars: start fresh from the scenario base.
        let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
        if let Some(ds) = &dataset {
            match ds.select_index(vu_id, iter_id, seq_counter.as_deref()) {
                Some(idx) => {
                    for (k, v) in &ds.rows[idx] {
                        iter_vars.insert(k.clone(), v.clone());
                    }
                }
                // unique slice exhausted → stop this VU (clean Ok, not a failure).
                None => break,
            }
        }
        let flow = execute_steps(
            &client,
            &scenario.steps,
            &mut iter_vars,
            &agg,
            deadline,
            &env,
            vu_id,
            iter_id,
            None,
            &cancel,
            &mut think_rng,
            measure_phases,
        )
        .await?;
        match flow {
            StepFlow::Continue => {}
            StepFlow::DeadlineReached => return Ok(()),
            StepFlow::Aborted => return Err(EngineError::Aborted),
        }
        // run-level think time between iterations
        if let Some(tt) = think_time {
            if pace(tt.sample(&mut think_rng), deadline, &cancel).await == PaceOutcome::Cancelled {
                return Err(EngineError::Aborted);
            }
        }
        iter_id = iter_id.wrapping_add(1);
    }
    Ok(())
}

/// Control-flow signal threaded back up the recursive step tree.
enum StepFlow {
    Continue,
    DeadlineReached,
    Aborted,
}

/// Recursively execute a slice of steps for one VU iteration. Http leaves run a
/// request + record a metric, then optionally pace (per-step think time); loop
/// nodes recurse over their body `repeat` times.
/// Returns `Err` only for genuine engine errors (template/header build failures);
/// deadline and cancellation are surfaced via `StepFlow` so the caller can decide
/// whether to end the iteration cleanly or report an abort — byte-for-byte the
/// same behavior the old flat loop had for the non-loop case.
#[allow(clippy::too_many_arguments)]
async fn execute_steps(
    client: &VuClient,
    steps: &[Step],
    iter_vars: &mut BTreeMap<String, String>,
    agg: &Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: &Arc<BTreeMap<String, String>>,
    vu_id: u32,
    iter_id: u32,
    loop_index: Option<u32>,
    cancel: &CancellationToken,
    rng: &mut StdRng,
    measure_phases: bool,
) -> Result<StepFlow> {
    for step in steps {
        if Instant::now() >= deadline {
            return Ok(StepFlow::DeadlineReached);
        }
        if cancel.is_cancelled() {
            return Ok(StepFlow::Aborted);
        }
        match step {
            Step::Http(http) => {
                let ctx = TemplateContext {
                    vars: iter_vars,
                    env: env.as_ref(),
                    vu_id,
                    iter_id,
                    loop_index,
                };
                let outcome = execute_step(client, http, &ctx).await?;
                iter_vars.extend(outcome.extracted.clone());
                {
                    let mut a = agg.lock().await;
                    a.record(
                        &outcome.step_id,
                        outcome.latency.as_micros().min(u64::MAX as u128) as u64,
                        outcome.status,
                        outcome.error.is_some(),
                        loop_index,
                    );
                    if measure_phases {
                        if let Some(dl) = outcome.download {
                            a.record_phase(
                                &outcome.step_id,
                                "download",
                                dl.as_micros().min(u64::MAX as u128) as u64,
                            );
                        }
                    }
                } // drop the aggregator guard before the (possibly long) think-time sleep
                if let Some(tt) = &http.think_time {
                    match pace(tt.sample(rng), deadline, cancel).await {
                        PaceOutcome::Slept => {}
                        PaceOutcome::Cancelled => return Ok(StepFlow::Aborted),
                        PaceOutcome::DeadlineReached => return Ok(StepFlow::DeadlineReached),
                    }
                }
            }
            Step::Loop(lp) => {
                for i in 0..lp.repeat {
                    if Instant::now() >= deadline {
                        return Ok(StepFlow::DeadlineReached);
                    }
                    if cancel.is_cancelled() {
                        return Ok(StepFlow::Aborted);
                    }
                    let flow = Box::pin(execute_steps(
                        client,
                        &lp.do_,
                        iter_vars,
                        agg,
                        deadline,
                        env,
                        vu_id,
                        iter_id,
                        Some(i),
                        cancel,
                        rng,
                        measure_phases,
                    ))
                    .await?;
                    match flow {
                        StepFlow::Continue => {}
                        other => return Ok(other),
                    }
                }
            }
            Step::If(if_step) => {
                // Pick the branch AND label which one (shared with trace; 9d labels).
                // `ctx` borrows `iter_vars` immutably; scope it so the borrow ends
                // before the recursive call takes `iter_vars` by &mut.
                let (taken, branch): (&[Step], String) = {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env: env.as_ref(),
                        vu_id,
                        iter_id,
                        loop_index,
                    };
                    select_branch(if_step, &ctx)
                };
                // Record the decision (counts-only, unconditional — see
                // Aggregator::record_branch). Scope the lock so it drops before the
                // recursive call re-locks `agg`.
                {
                    let mut a = agg.lock().await;
                    a.record_branch(&if_step.id, &branch);
                }
                // Pass the *incoming* loop_index through unchanged — the If arm makes no
                // new scope, so an if-in-loop's branch children still see the loop index
                // (spec §4). Box::pin the recursion (If/Loop arms only — hot path unboxed).
                let flow = Box::pin(execute_steps(
                    client,
                    taken,
                    iter_vars,
                    agg,
                    deadline,
                    env,
                    vu_id,
                    iter_id,
                    loop_index,
                    cancel,
                    rng,
                    measure_phases,
                ))
                .await?;
                match flow {
                    StepFlow::Continue => {}
                    other => return Ok(other),
                }
            }
            Step::Parallel(par) => {
                // Snapshot entry vars; each branch runs on its own clone (concurrent
                // branches can't share &mut iter_vars). Reads see entry; writes
                // (extracts) stay branch-local and are merged back namespaced (§3.2).
                let entry: BTreeMap<String, String> = iter_vars.clone();
                // One deterministic seed per branch, drawn in declaration order from
                // the VU rng (reproducible given think_seed). Concurrent branches
                // can't share &mut rng, so each gets an independent StdRng.
                let seeds: Vec<u64> = (0..par.branches.len()).map(|_| rng.next_u64()).collect();

                let futs = par.branches.iter().zip(seeds).map(|(branch, seed)| {
                    let mut branch_vars = entry.clone();
                    let mut branch_rng = StdRng::seed_from_u64(seed);
                    async move {
                        let bt0 = Instant::now();
                        let flow = Box::pin(execute_steps(
                            client,
                            &branch.steps,
                            &mut branch_vars,
                            agg,
                            deadline,
                            env,
                            vu_id,
                            iter_id,
                            loop_index,
                            cancel,
                            &mut branch_rng,
                            measure_phases,
                        ))
                        .await;
                        let branch_us = bt0.elapsed().as_micros() as u64;
                        (branch, branch_vars, flow, branch_us)
                    }
                });
                // wait-all: every branch runs to completion before the node returns.
                // Time the whole concurrent block: page-load latency ≈ max(branches) (A2-2).
                let t0 = Instant::now();
                let results = futures::future::join_all(futs).await;
                let elapsed_us = t0.elapsed().as_micros() as u64;

                // Merge in declaration order (join_all preserves input order). Key-origin
                // namespace: expose each branch's declared extract outputs as
                // {{branch.var}}. First Err propagates; else worst flow
                // (Aborted > DeadlineReached > Continue).
                let mut aborted = false;
                let mut deadline_hit = false;
                let mut branch_samples: Vec<(&str, u64)> = Vec::new();
                for (branch, branch_vars, flow, branch_us) in results {
                    match flow? {
                        StepFlow::Continue => {}
                        StepFlow::DeadlineReached => deadline_hit = true,
                        StepFlow::Aborted => aborted = true,
                    }
                    for k in branch.output_var_names() {
                        if let Some(v) = branch_vars.get(k) {
                            iter_vars.insert(format!("{}.{}", branch.name, k), v.clone());
                        }
                    }
                    branch_samples.push((branch.name.as_str(), branch_us));
                }
                // Record page-load latency only on a clean block — a deadline/abort cut a
                // branch short (skipped steps → too-fast block), which would skew the
                // distribution low. Same caution as loop partial-iteration counting.
                // Page (branch="") + every branch recorded together under the same gate so
                // each branch row's count == the page row's count.
                if !aborted && !deadline_hit {
                    let mut a = agg.lock().await;
                    a.record_group(&par.id, "", elapsed_us);
                    for (name, us) in &branch_samples {
                        a.record_group(&par.id, name, *us);
                    }
                }
                if aborted {
                    return Ok(StepFlow::Aborted);
                }
                if deadline_hit {
                    return Ok(StepFlow::DeadlineReached);
                }
            }
        }
    }
    Ok(StepFlow::Continue)
}

/// Instantaneous arrival rate (req/s) at `elapsed_secs` into a piecewise-linear
/// stage curve. Start rate = 0; stage k ramps `target_{k-1} → target_k` over its
/// duration (target_0 = 0). Past the end → last target (caller's deadline ends the run).
fn rate_at(stages: &[Stage], elapsed_secs: f64) -> f64 {
    let mut seg_start = 0.0_f64;
    let mut prev_target = 0.0_f64;
    for stage in stages {
        let seg_end = seg_start + f64::from(stage.duration_seconds);
        let target = f64::from(stage.target);
        if elapsed_secs <= seg_end {
            let span = seg_end - seg_start;
            if span <= 0.0 {
                return target;
            }
            let frac = (elapsed_secs - seg_start) / span;
            return prev_target + frac * (target - prev_target);
        }
        seg_start = seg_end;
        prev_target = target;
    }
    prev_target
}

/// Closed-loop VU curve (spec §4): drive a piecewise-linear *active VU count*
/// `desired(t) = round(rate_at(vu_stages, elapsed))` with park-gated reusable VU
/// tasks. Isolated from `run_scenario`/`run_scenario_open_loop` — the fixed
/// closed-loop and open-loop paths are untouched (S-C isolation precedent).
///
/// Supervisor runs INLINE in this task (mirror of run_scenario's spawn-loop
/// position): tick every 250ms until the deadline, only then join. Starting at
/// 0 VUs with lazy spawn means the JoinSet may be empty early — joining
/// immediately would end the run at t≈0 (spec §4.2 hazard).
pub async fn run_scenario_vu_curve(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<MetricFlush>,
    cancel: CancellationToken,
) -> Result<()> {
    let stages = plan
        .vu_stages
        .clone()
        .expect("worker selects this path only when vu_stages is non-empty");
    let max_vus: u32 = stages.iter().map(|s| s.target).max().unwrap_or(0);
    let agg = Arc::new(Mutex::new(Aggregator::new(plan.loop_breakdown_cap)));
    let started_at = Instant::now();
    let deadline = started_at + plan.duration;
    let failed = Arc::new(AtomicU32::new(0));
    let env = Arc::new(plan.env);
    let dataset = plan.data_binding.clone();
    let http_timeout = plan.http_timeout;
    let think_time = plan.think_time;
    let think_seed = plan.think_seed;
    let measure_phases = plan.measure_phases;
    let immediate = plan.ramp_down == RampDown::Immediate;
    let seq_counter = match dataset.as_ref().map(|d| d.policy) {
        Some(BindingPolicy::IterSequential | BindingPolicy::Unique) => {
            Some(Arc::new(AtomicU64::new(0)))
        }
        _ => None,
    };

    // Desired active-VU count, broadcast to every VU task. VU `i` is active iff
    // `desired > i`.
    let (desired_tx, desired_rx) = tokio::sync::watch::channel::<u32>(0);
    // Per-VU activation tokens. The supervisor re-cancels indexes >= desired EVERY
    // tick in immediate mode (idempotent — closes the wake→register race, spec §4.2).
    let slab: Arc<std::sync::Mutex<Vec<Option<CancellationToken>>>> =
        Arc::new(std::sync::Mutex::new(vec![None; max_vus as usize]));

    let mut set = JoinSet::new();
    let mut spawned: u32 = 0;

    // Flusher: mirror of run_scenario's (MetricFlush drain site #5 — see engine
    // CLAUDE.md "드레인 6/guard 5"). dropped is always 0 on this path.
    let flush_agg = agg.clone();
    let flush_out = out.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = chrono_second();
            let (drained, loop_stats, branch_stats, group_stats, phase_stats) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                    g.drain_phase_deltas(),
                )
            };
            if (!drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
                || !phase_stats.is_empty())
                && flush_out
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
                        group_stats,
                        dropped: 0,
                        phase_stats,
                    })
                    .await
                    .is_err()
            {
                break;
            }
            if flush_out.is_closed() {
                break;
            }
        }
    });

    // ── Supervisor (inline): tick until deadline ──
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let elapsed = now.duration_since(started_at).as_secs_f64();
        let desired =
            (rate_at(&stages, elapsed).round() as i64).clamp(0, i64::from(max_vus)) as u32;
        // Lazy spawn: indexes the curve never reaches are never spawned.
        while spawned < desired {
            let index = spawned;
            let vu_id = plan.vu_offset.saturating_add(index);
            let scenario = scenario.clone();
            let agg = agg.clone();
            let failed = failed.clone();
            let env = env.clone();
            let cancel_vu = cancel.clone();
            let dataset = dataset.clone();
            let seq_counter = seq_counter.clone();
            let rx = desired_rx.clone();
            let slab_vu = slab.clone();
            set.spawn(async move {
                if let Err(e) = run_vu_curve(
                    scenario,
                    index,
                    vu_id,
                    agg,
                    deadline,
                    env,
                    cancel_vu,
                    rx,
                    slab_vu,
                    dataset,
                    seq_counter,
                    http_timeout,
                    think_time,
                    think_seed,
                    measure_phases,
                )
                .await
                {
                    if !matches!(e, EngineError::Aborted) {
                        warn!(vu_id, error = ?e, "vu failed");
                    }
                    failed.fetch_add(1, Ordering::Relaxed);
                }
            });
            spawned += 1;
        }
        let _ = desired_tx.send(desired);
        if immediate {
            // Idempotent re-cancel every tick (NOT falling-edge-only): closes the
            // "VU woke on watch but hasn't registered yet" race — worst lag is one
            // tick (250ms) + a step boundary (spec §4.2).
            let g = slab.lock().expect("slab mutex");
            for tok in g.iter().skip(desired as usize).flatten() {
                tok.cancel();
            }
        }
        tokio::select! {
            _ = ticker.tick() => {}
            _ = cancel.cancelled() => break,
        }
    }

    while let Some(res) = set.join_next().await {
        if let Err(e) = res {
            warn!(error = %e, "vu join error");
            failed.fetch_add(1, Ordering::Relaxed);
        }
    }

    // Final flush (MetricFlush drain site #6, guarded — dropped always 0 here).
    let (final_windows, final_loops, final_branches, final_groups, final_phases) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
            g.drain_phase_deltas(),
        )
    };
    if !final_windows.is_empty()
        || !final_loops.is_empty()
        || !final_branches.is_empty()
        || !final_groups.is_empty()
        || !final_phases.is_empty()
    {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
                group_stats: final_groups,
                dropped: 0,
                phase_stats: final_phases,
            })
            .await;
    }
    drop(out);
    flusher.abort();
    let _ = flusher.await;

    if cancel.is_cancelled() {
        return Err(EngineError::Aborted);
    }
    let failed_count = failed.load(Ordering::Relaxed);
    // AllVusFailed is judged against SPAWNED, not max_vus: 250ms sampling + round
    // may never reach the curve peak, and "every VU we actually ran died" must
    // still fail the run (spec §4.3).
    if spawned > 0 && failed_count >= spawned {
        warn!(
            failed = failed_count,
            total = spawned,
            "all spawned VUs failed"
        );
        return Err(EngineError::AllVusFailed {
            failed: failed_count,
            total: spawned,
        });
    }
    if failed_count > 0 {
        info!(
            failed = failed_count,
            total = spawned,
            "vu-curve run finished with partial VU failures"
        );
    } else {
        info!("vu-curve run finished");
    }
    Ok(())
}

fn clear_slot(slab: &std::sync::Mutex<Vec<Option<CancellationToken>>>, index: u32) {
    slab.lock().expect("slab mutex")[index as usize] = None;
}

/// One park-gated curve VU (spec §4.3).
///
/// INTENDED DUPLICATION of `run_vu`'s iteration body (S-C `run_arrival` precedent)
/// — keep binding select / execute_steps call / think-time pacing in lockstep with
/// `run_vu`. Curve-only deltas:
///  - park-gate around the iteration (`desired` watch; VU `index` active iff
///    `desired > index`)
///  - per-activation child token (`act`) so a supervisor retire-cancel parks the
///    VU instead of killing it; run-abort is distinguished at the park head via
///    the run-level `cancel`.
///  - retire-abort does NOT count into `failed` — NEW semantics vs run_scenario,
///    where Aborted also increments failed (harmless there: the run returns
///    Err(Aborted) anyway).
#[allow(clippy::too_many_arguments)]
#[instrument(skip_all, fields(vu_id))]
async fn run_vu_curve(
    scenario: Arc<Scenario>,
    index: u32,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: Arc<BTreeMap<String, String>>,
    cancel: CancellationToken,
    mut desired: tokio::sync::watch::Receiver<u32>,
    slab: Arc<std::sync::Mutex<Vec<Option<CancellationToken>>>>,
    dataset: Option<Arc<DataSet>>,
    seq_counter: Option<Arc<AtomicU64>>,
    http_timeout: Duration,
    think_time: Option<ThinkTime>,
    think_seed: Option<u32>,
    measure_phases: bool,
) -> Result<()> {
    // Client + rng + iter_id persist across park (Park & 재사용, spec §2):
    // the cookie jar IS the session, and iter_id stays monotonic.
    let client = VuClient::with_timeout(scenario.cookie_jar, http_timeout)?;
    let mut think_rng = match think_seed {
        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, 0)),
        None => StdRng::from_entropy(),
    };
    let mut iter_id: u32 = 0;
    let deadline_tokio = tokio::time::Instant::from_std(deadline);
    loop {
        // ── park: 3-way select — watch / run-cancel / deadline (spec §4.3) ──
        if cancel.is_cancelled() {
            return Err(EngineError::Aborted);
        }
        if Instant::now() >= deadline {
            return Ok(());
        }
        if *desired.borrow() <= index {
            tokio::select! {
                r = desired.wait_for(|d| *d > index) => {
                    if r.is_err() {
                        return Ok(()); // sender dropped — run is tearing down
                    }
                }
                _ = cancel.cancelled() => return Err(EngineError::Aborted),
                _ = tokio::time::sleep_until(deadline_tokio) => return Ok(()),
            }
        }
        // ── activate: child token, register in slab (both modes — run-abort
        //    propagates from the parent token automatically) ──
        let act = cancel.child_token();
        slab.lock().expect("slab mutex")[index as usize] = Some(act.clone());
        // ── active loop: iterate until retired / deadline ──
        loop {
            if Instant::now() >= deadline {
                clear_slot(&slab, index);
                return Ok(());
            }
            if act.is_cancelled() {
                break; // retire (or run-abort — re-checked at the park head)
            }
            // Graceful gate at the loop head too: if desired dropped DURING the
            // think-time sleep, park before running another iteration (spec §2 —
            // "sleep을 마저 잔 뒤 park, 그동안 요청은 안 나간다").
            if *desired.borrow() <= index {
                break;
            }
            // Per-iteration flow vars: lockstep with run_vu.
            let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
            if let Some(ds) = &dataset {
                match ds.select_index(vu_id, iter_id, seq_counter.as_deref()) {
                    Some(idx) => {
                        for (k, v) in &ds.rows[idx] {
                            iter_vars.insert(k.clone(), v.clone());
                        }
                    }
                    // unique slice exhausted → permanent clean stop (mirror run_vu).
                    None => {
                        clear_slot(&slab, index);
                        return Ok(());
                    }
                }
            }
            let flow = match execute_steps(
                &client,
                &scenario.steps,
                &mut iter_vars,
                &agg,
                deadline,
                &env,
                vu_id,
                iter_id,
                None,
                &act,
                &mut think_rng,
                measure_phases,
            )
            .await
            {
                Ok(f) => f,
                Err(e) => {
                    clear_slot(&slab, index);
                    return Err(e); // genuine engine error → permanent VU death
                }
            };
            match flow {
                StepFlow::Continue => {
                    // run_vu increments at the loop tail; doing it on Continue is
                    // equivalent (the non-Continue paths there return entirely).
                    iter_id = iter_id.wrapping_add(1);
                }
                StepFlow::DeadlineReached => {
                    clear_slot(&slab, index);
                    return Ok(());
                }
                StepFlow::Aborted => break, // act cancelled — retire or run-abort
            }
            // Gate re-check BEFORE think-time pacing (graceful-lag mitigation,
            // spec §2): a retire at this point skips the sleep entirely.
            if *desired.borrow() <= index {
                break;
            }
            if let Some(tt) = think_time {
                match pace(tt.sample(&mut think_rng), deadline, &act).await {
                    PaceOutcome::Cancelled => break, // retire or run-abort
                    PaceOutcome::DeadlineReached => {
                        clear_slot(&slab, index);
                        return Ok(());
                    }
                    PaceOutcome::Slept => {}
                }
            }
        }
        // ── deactivate: clear slot; run-abort exits, retire parks ──
        clear_slot(&slab, index);
        if cancel.is_cancelled() {
            return Err(EngineError::Aborted);
        }
    }
}

/// Drive open-loop arrival-rate load: schedule iteration *starts* at `target_rps`
/// against a fixed pool of `max_in_flight` reusable VU clients (slot index = vu_id,
/// cookie jar persists per slot). Arrivals that find no free slot are dropped and
/// counted. Isolated from `run_scenario` — closed-loop code is untouched.
pub async fn run_scenario_open_loop(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<MetricFlush>,
    cancel: CancellationToken,
) -> Result<()> {
    let max_in_flight = plan.max_in_flight.unwrap_or(1).max(1) as usize;
    let target_rps = plan.target_rps.unwrap_or(1).max(1);
    let agg = Arc::new(Mutex::new(Aggregator::new(plan.loop_breakdown_cap)));
    let started_at = Instant::now();
    let deadline = started_at + plan.duration;
    let env = Arc::new(plan.env);
    let dataset = plan.data_binding.clone();
    let http_timeout = plan.http_timeout;
    let think_seed = plan.think_seed;
    let vu_offset = plan.vu_offset;
    let measure_phases = plan.measure_phases;
    let mut dropped: u64 = 0;
    let mut arrival_counter: u64 = 0;
    let exhausted = Arc::new(AtomicBool::new(false));
    let seq_counter = match dataset.as_ref().map(|d| d.policy) {
        Some(BindingPolicy::IterSequential | BindingPolicy::Unique) => {
            Some(Arc::new(AtomicU64::new(0)))
        }
        _ => None,
    };

    // Slot pool: max_in_flight reusable clients, index = vu_id (offset applied at use).
    let pool: Vec<Arc<VuClient>> = (0..max_in_flight)
        .map(|_| {
            Ok(Arc::new(VuClient::with_timeout(
                scenario.cookie_jar,
                http_timeout,
            )?))
        })
        .collect::<Result<_>>()?;
    // Free-slot queue: pre-loaded with every index. `try_recv` = acquire (Empty → drop),
    // send back on completion. The channel itself is the permit + the slot identity.
    let (slot_tx, mut slot_rx) = mpsc::channel::<usize>(max_in_flight);
    for i in 0..max_in_flight {
        slot_tx.try_send(i).expect("capacity == max_in_flight");
    }

    let mut set = JoinSet::new();

    // Flusher: drain windows until the run ends. Sends dropped: 0 throughout; the
    // run-total drop count rides on the single final flush below (avoids per-window
    // delta/double-count bookkeeping; per-second drop series is deferred, spec §9).
    let flush_agg = agg.clone();
    let flush_out = out.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = chrono_second();
            let (drained, loop_stats, branch_stats, group_stats, phase_stats) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                    g.drain_phase_deltas(),
                )
            };
            let has_data = !drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
                || !phase_stats.is_empty();
            if has_data {
                debug!(
                    count = drained.len(),
                    loops = loop_stats.len(),
                    branches = branch_stats.len(),
                    groups = group_stats.len(),
                    "flushing windows"
                );
                if flush_out
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
                        group_stats,
                        dropped: 0,
                        phase_stats,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            if flush_out.is_closed() {
                break;
            }
        }
    });

    // Rate epsilon: below this the curve is effectively zero (a `{0, d}` hold or the
    // ramp-down tail) — fire nothing, just poll. Low-but-positive rates (e.g. 0.5 rps
    // = 2s interval) take the normal 1/rate path (no interval cap — capping distorts rate).
    const RATE_EPS: f64 = 1e-9;
    let curve = plan.stages.clone();
    // Fixed-rate interval (S-C): precomputed integer nanos → byte-identical when curve is None.
    let fixed_interval = Duration::from_nanos((1_000_000_000u64 / u64::from(target_rps)).max(1));
    let mut next = started_at;
    loop {
        if cancel.is_cancelled() || exhausted.load(Ordering::Relaxed) || Instant::now() >= deadline
        {
            break;
        }
        let now = Instant::now();
        if now < next {
            // Clamp the wait to the run deadline so curve-derived large intervals
            // (e.g. 1/tiny_rate at the start of a ramp) don't block past deadline.
            let wait = next.min(deadline).saturating_duration_since(now);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => break,
            }
            continue;
        }
        // Per-iteration interval: fixed (byte-identical) or curve-derived.
        // For curves, evaluate the rate at the *scheduled* tick time (`next`), not `now`.
        // Using `now` causes tiny-rate intervals (e.g. 1/0.24 ≈ 4s) early in a ramp,
        // because `now` lags behind the scheduled tick slightly. Evaluating at `next`
        // (which is `≥ started_at`) gives the intended piecewise-linear rate.
        let interval = match &curve {
            None => fixed_interval,
            Some(stages) => {
                let next_elapsed = next.saturating_duration_since(started_at).as_secs_f64();
                let rate = rate_at(stages, next_elapsed);
                if rate <= RATE_EPS {
                    // Zero-rate region: no arrival, no drop. Poll-step with the SAME
                    // cancel-aware select so cancel/deadline stay responsive.
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                        _ = cancel.cancelled() => break,
                    }
                    next = Instant::now();
                    continue;
                }
                Duration::from_secs_f64(1.0 / rate)
            }
        };
        match slot_rx.try_recv() {
            Ok(slot) => {
                let vu_id = vu_offset.saturating_add(slot as u32);
                let iter_id = arrival_counter as u32;
                arrival_counter += 1;
                let client = pool[slot].clone();
                let scenario = scenario.clone();
                let agg = agg.clone();
                let env = env.clone();
                let cancel_vu = cancel.clone();
                let dataset = dataset.clone();
                let seq_counter = seq_counter.clone();
                let exhausted = exhausted.clone();
                let slot_tx = slot_tx.clone();
                set.spawn(async move {
                    // Return the slot on ALL exit paths (including panics) via Drop.
                    // A permanently-leaked slot would shrink the pool, causing runaway drops.
                    struct SlotGuard {
                        slot: usize,
                        tx: mpsc::Sender<usize>,
                    }
                    impl Drop for SlotGuard {
                        fn drop(&mut self) {
                            let _ = self.tx.try_send(self.slot); // capacity guaranteed
                        }
                    }
                    let _slot_guard = SlotGuard { slot, tx: slot_tx };
                    let mut rng = match think_seed {
                        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, iter_id)),
                        None => StdRng::from_entropy(),
                    };
                    match run_arrival(
                        &client,
                        &scenario,
                        vu_id,
                        iter_id,
                        &agg,
                        deadline,
                        &env,
                        &cancel_vu,
                        dataset,
                        seq_counter,
                        &mut rng,
                        &exhausted,
                        measure_phases,
                    )
                    .await
                    {
                        Ok(()) | Err(EngineError::Aborted) => {}
                        Err(e) => warn!(vu_id, error = ?e, "arrival failed"),
                    }
                });
            }
            Err(_) => {
                dropped += 1;
                // Pool full while behind schedule: yield so in-flight arrivals (which
                // free slots) get scheduled instead of tight-spinning the catch-up backlog.
                tokio::task::yield_now().await;
            }
        }
        next += interval;
    }

    while let Some(res) = set.join_next().await {
        if let Err(e) = res {
            warn!(error = %e, "arrival join error");
        }
    }

    // Drain remaining windows FIRST (mirrors run_scenario shutdown sequence), then
    // stop the flusher. This avoids losing windows the flusher had drained-but-not-yet-sent.
    // The final flush also carries the run-total `dropped` (flusher sent dropped: 0
    // throughout, so no double count).
    let total_dropped = dropped;
    let (final_windows, final_loops, final_branches, final_groups, final_phases) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
            g.drain_phase_deltas(),
        )
    };
    let _ = out
        .send(MetricFlush {
            windows: final_windows,
            loop_stats: final_loops,
            branch_stats: final_branches,
            group_stats: final_groups,
            dropped: total_dropped,
            phase_stats: final_phases,
        })
        .await;
    drop(out);
    flusher.abort();
    let _ = flusher.await;

    if cancel.is_cancelled() {
        return Err(EngineError::Aborted);
    }
    info!(dropped = total_dropped, "open-loop run finished");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_arrival(
    client: &VuClient,
    scenario: &Scenario,
    vu_id: u32,
    iter_id: u32,
    agg: &Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: &Arc<BTreeMap<String, String>>,
    cancel: &CancellationToken,
    dataset: Option<Arc<DataSet>>,
    seq_counter: Option<Arc<AtomicU64>>,
    rng: &mut StdRng,
    exhausted: &AtomicBool,
    measure_phases: bool,
) -> Result<()> {
    let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
    if let Some(ds) = &dataset {
        match ds.select_index(vu_id, iter_id, seq_counter.as_deref()) {
            Some(idx) => {
                for (k, v) in &ds.rows[idx] {
                    iter_vars.insert(k.clone(), v.clone());
                }
            }
            // unique slice exhausted → signal the scheduler to stop new arrivals.
            None => {
                exhausted.store(true, Ordering::Relaxed);
                return Ok(());
            }
        }
    }
    // No run-level think time in open-loop (arrival rate governs inter-iteration pacing).
    let _ = execute_steps(
        client,
        &scenario.steps,
        &mut iter_vars,
        agg,
        deadline,
        env,
        vu_id,
        iter_id,
        None,
        cancel,
        rng,
        measure_phases,
    )
    .await?;
    Ok(())
}

/// Pick the taken branch of an `if` step AND its decision label
/// ("then" / "elif_{j}" / "else" / "none"). Shared by the load interpreter
/// (`execute_steps`) and the test-run interpreter (`trace::trace_scenario`) so the
/// branch-label contract has a single source of truth (9d labels).
pub(crate) fn select_branch<'a>(
    if_step: &'a crate::scenario::IfStep,
    ctx: &TemplateContext,
) -> (&'a [Step], String) {
    if eval_condition(&if_step.cond, ctx) {
        (&if_step.then_, "then".to_string())
    } else {
        // Default: "else" when it has a body, "none" when no branch matched and
        // else is empty/absent (spec §7). An elif match overrides this below.
        let mut sel: (&[Step], String) = if if_step.else_.is_empty() {
            (if_step.else_.as_slice(), "none".to_string())
        } else {
            (if_step.else_.as_slice(), "else".to_string())
        };
        for (j, e) in if_step.elif.iter().enumerate() {
            if eval_condition(&e.cond, ctx) {
                sel = (e.then_.as_slice(), format!("elif_{j}"));
                break;
            }
        }
        sel
    }
}

fn chrono_second() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_branch_picks_then_elif_else_none() {
        use crate::scenario::{CompareOp, Condition, ElifBranch, IfStep};
        let v = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let leaf = |val: &str| Condition::Compare {
            left: val.to_string(),
            op: CompareOp::Eq,
            right: Some("yes".to_string()),
        };
        // cond false, one elif false, empty else → "none"
        let if_step = IfStep {
            id: "01HX0000000000000000000004".into(),
            name: "br".into(),
            cond: leaf("no"),
            then_: vec![],
            elif: vec![ElifBranch {
                cond: leaf("no"),
                then_: vec![],
            }],
            else_: vec![],
        };
        let (_taken, branch) = select_branch(&if_step, &ctx);
        assert_eq!(branch, "none");

        // cond true → "then"
        let if_then = IfStep {
            cond: leaf("yes"),
            ..if_step.clone()
        };
        assert_eq!(select_branch(&if_then, &ctx).1, "then");
    }

    #[test]
    fn rate_at_piecewise_linear() {
        // ramp 0→200 over 30s
        let s = vec![Stage {
            target: 200,
            duration_seconds: 30,
        }];
        assert_eq!(rate_at(&s, 0.0), 0.0);
        assert_eq!(rate_at(&s, 15.0), 100.0);
        assert_eq!(rate_at(&s, 30.0), 200.0);
        // ramp + hold: 0→200(30s), hold 200(120s)
        let s = vec![
            Stage {
                target: 200,
                duration_seconds: 30,
            },
            Stage {
                target: 200,
                duration_seconds: 120,
            },
        ];
        assert_eq!(rate_at(&s, 30.0), 200.0);
        assert_eq!(rate_at(&s, 90.0), 200.0);
        assert_eq!(rate_at(&s, 150.0), 200.0);
        // ramp-down: 0→200(30s), 200→0(30s)
        let s = vec![
            Stage {
                target: 200,
                duration_seconds: 30,
            },
            Stage {
                target: 0,
                duration_seconds: 30,
            },
        ];
        assert_eq!(rate_at(&s, 30.0), 200.0);
        assert_eq!(rate_at(&s, 45.0), 100.0);
        assert_eq!(rate_at(&s, 60.0), 0.0);
        // segment-to-segment: 0→100(10s), 100→500(10s)
        let s = vec![
            Stage {
                target: 100,
                duration_seconds: 10,
            },
            Stage {
                target: 500,
                duration_seconds: 10,
            },
        ];
        assert_eq!(rate_at(&s, 10.0), 100.0);
        assert_eq!(rate_at(&s, 15.0), 300.0);
        assert_eq!(rate_at(&s, 20.0), 500.0);
        // empty → 0
        assert_eq!(rate_at(&[], 5.0), 0.0);
    }
}
