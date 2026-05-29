use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, instrument, warn};

use crate::aggregator::{Aggregator, StepWindow};
use crate::error::{EngineError, Result};
use crate::executor::{VuClient, execute_step};
use crate::scenario::{Scenario, Step};
use crate::template::TemplateContext;

#[derive(Debug, Clone)]
pub struct RunPlan {
    pub vus: u32,
    pub ramp_up: Duration,
    pub duration: Duration,
    pub env: BTreeMap<String, String>,
}

/// Drive `vus` virtual users through `scenario` for `plan.duration`, streaming
/// completed 1s windows to `out`. Returns when the run finishes (all VUs done).
pub async fn run_scenario(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<Vec<StepWindow>>,
    cancel: CancellationToken,
) -> Result<()> {
    let agg = Arc::new(Mutex::new(Aggregator::new()));
    let started_at = Instant::now();
    let deadline = started_at + plan.duration;
    let failed = Arc::new(AtomicU32::new(0));
    let env = Arc::new(plan.env);

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
            let vu_id = spawned;
            let scenario = scenario.clone();
            let agg = agg.clone();
            let failed = failed.clone();
            let env = env.clone();
            let cancel_vu = cancel.clone();
            set.spawn(async move {
                if let Err(e) = run_vu(scenario, vu_id, agg, deadline, env, cancel_vu).await {
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
            let drained = flush_agg.lock().await.drain_completed(now_s);
            if !drained.is_empty() {
                debug!(count = drained.len(), "flushing windows");
                if flush_out.send(drained).await.is_err() {
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

    let final_windows = agg.lock().await.drain_all();
    if !final_windows.is_empty() {
        let _ = out.send(final_windows).await;
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

#[instrument(skip(scenario, agg, env), fields(vu_id))]
async fn run_vu(
    scenario: Arc<Scenario>,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: Arc<BTreeMap<String, String>>,
    cancel: CancellationToken,
) -> Result<()> {
    let client = VuClient::new(scenario.cookie_jar)?;
    let mut iter_id: u32 = 0;
    while Instant::now() < deadline {
        if cancel.is_cancelled() {
            return Err(EngineError::Aborted);
        }
        // Per-iteration flow vars: start fresh from the scenario base.
        let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
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
        }
    }
    Ok(StepFlow::Continue)
}

fn chrono_second() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
