use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use rand::SeedableRng;
use rand::rngs::StdRng;
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, instrument, warn};

use crate::aggregator::{Aggregator, BranchStat, LoopStat, StepWindow};
use crate::condition::eval_condition;
use crate::dataset::{BindingPolicy, DataSet};
use crate::error::{EngineError, Result};
use crate::executor::{VuClient, execute_step};
use crate::pacing::{PaceOutcome, ThinkTime, pace};
use crate::scenario::{Scenario, Step};
use crate::template::TemplateContext;

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
}

/// One flush from the engine to the worker: a batch of completed 1s windows
/// plus the per-(step_id, loop_index) count deltas accumulated since the last flush,
/// plus per-(if_id, branch) decision-count deltas.
#[derive(Debug)]
pub struct MetricFlush {
    pub windows: Vec<StepWindow>,
    pub loop_stats: Vec<LoopStat>,
    pub branch_stats: Vec<BranchStat>,
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
            let (drained, loop_stats, branch_stats) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                )
            };
            if !drained.is_empty() || !loop_stats.is_empty() || !branch_stats.is_empty() {
                debug!(
                    count = drained.len(),
                    loops = loop_stats.len(),
                    branches = branch_stats.len(),
                    "flushing windows"
                );
                if flush_out
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
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

    let (final_windows, final_loops, final_branches) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
        )
    };
    if !final_windows.is_empty() || !final_loops.is_empty() || !final_branches.is_empty() {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
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
/// request + record a metric; loop nodes recurse over their body `repeat` times.
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
                let mut a = agg.lock().await;
                a.record(
                    &outcome.step_id,
                    outcome.latency.as_micros().min(u64::MAX as u128) as u64,
                    outcome.status,
                    outcome.error.is_some(),
                    loop_index,
                );
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
                    client, taken, iter_vars, agg, deadline, env, vu_id, iter_id, loop_index,
                    cancel,
                ))
                .await?;
                match flow {
                    StepFlow::Continue => {}
                    other => return Ok(other),
                }
            }
        }
    }
    Ok(StepFlow::Continue)
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
}
