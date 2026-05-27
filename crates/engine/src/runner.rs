use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinSet;
use tracing::{debug, info, instrument, warn};

use crate::aggregator::{Aggregator, StepWindow};
use crate::error::{EngineError, Result};
use crate::executor::{VuClient, execute_step};
use crate::scenario::Scenario;
use crate::template::TemplateContext;

#[derive(Debug, Clone)]
pub struct RunPlan {
    pub vus: u32,
    pub duration: Duration,
}

/// Drive `vus` virtual users through `scenario` for `plan.duration`, streaming
/// completed 1s windows to `out`. Returns when the run finishes (all VUs done).
pub async fn run_scenario(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<Vec<StepWindow>>,
) -> Result<()> {
    let agg = Arc::new(Mutex::new(Aggregator::new()));
    let deadline = Instant::now() + plan.duration;
    let failed = Arc::new(AtomicU32::new(0));

    let mut set = JoinSet::new();
    for vu_id in 0..plan.vus {
        let scenario = scenario.clone();
        let agg = agg.clone();
        let failed = failed.clone();
        set.spawn(async move {
            if let Err(e) = run_vu(scenario, vu_id, agg, deadline).await {
                warn!(vu_id, error = ?e, "vu failed");
                failed.fetch_add(1, Ordering::Relaxed);
            }
        });
    }

    // Flush loop — until all VUs finish.
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

    // Final drain after all VUs are done.
    let final_windows = agg.lock().await.drain_all();
    if !final_windows.is_empty() {
        let _ = out.send(final_windows).await;
    }
    // Drop out (last sender) so the receiver side sees EOF, then abort the
    // flusher which still holds its own clone of the sender.
    drop(out);
    flusher.abort();
    let _ = flusher.await; // JoinError::Cancelled is fine

    let failed_count = failed.load(Ordering::Relaxed);
    if plan.vus > 0 && failed_count >= plan.vus {
        // Every VU errored before completing — surface so the worker reports
        // RunStatus::Failed instead of pretending the run succeeded silently.
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

#[instrument(skip(scenario, agg), fields(vu_id))]
async fn run_vu(
    scenario: Arc<Scenario>,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
) -> Result<()> {
    let client = VuClient::new(scenario.cookie_jar)?;
    let mut iter_id: u32 = 0;
    while Instant::now() < deadline {
        for step in &scenario.steps {
            if Instant::now() >= deadline {
                return Ok(());
            }
            let empty_env: BTreeMap<String, String> = BTreeMap::new();
            let ctx = TemplateContext {
                vars: &scenario.variables,
                env: &empty_env,
                vu_id,
                iter_id,
            };
            let outcome = execute_step(&client, step, &ctx).await?;
            let mut a = agg.lock().await;
            a.record(
                &outcome.step_id,
                outcome.latency.as_micros().min(u64::MAX as u128) as u64,
                outcome.status,
                outcome.error.is_some(),
            );
        }
        iter_id = iter_id.wrapping_add(1);
    }
    Ok(())
}

fn chrono_second() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
