use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use rand::RngCore;
use rand::SeedableRng;
use rand::rngs::StdRng;
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, instrument, warn};

use crate::aggregator::{
    ActiveVuSample, Aggregator, BranchStat, ErrorKindStat, GroupStat, LOOP_SPLIT_PASS_SAMPLE_CAP,
    LoopExitOutcome, LoopExitStat, LoopSplitClass, LoopStat, PhaseStat, StepWindow, current_second,
};
use crate::blank_guard::{self, BlankTable};
use crate::condition::eval_condition;
use crate::dataset::{BindingPolicy, DataSet};
use crate::error::{EngineError, Result, safe_cause};
use crate::error_kind::ErrorKind;
use crate::executor::{ExtractMode, VuClient, execute_step_with};
use crate::extract::fill_missing_extracts;
use crate::open_loop_counters::{CountKind, OpenLoopCounters};
use crate::pacing::{PaceOutcome, ThinkTime, pace};
use crate::reqgen::{ReqGen, RequestGenPlan};
use crate::scenario::{Scenario, Step};
use crate::section::{
    Section, SectionOutcome, SectionRun, SectionStepStat, SharedSectionStats, VuSetup,
    drain_shared, run_section,
};
use crate::template::TemplateContext;

/// One stage of an open-loop rate curve: ramp the arrival rate to `target` (iterations/s)
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
    /// Data-driven bindings, injected per VU iteration in declared order
    /// (spec §2). Empty → no injection (back-compat). N>1 binds multiple datasets
    /// into the same iteration; the first binding whose `Unique` slice is
    /// exhausted stops the VU (break-on-first-None, spec §7).
    pub data_bindings: Vec<Arc<DataSet>>,
    /// Total per-request HTTP timeout for every VU client (reqwest client-level).
    /// `30s` reproduces the pre-S-A hardcoded default.
    pub http_timeout: Duration,
    /// Inter-iteration think time (run-level pacing). `None` → no pause.
    pub think_time: Option<ThinkTime>,
    /// Think time RNG seed. `Some` → reproducible per (seed, vu_id); `None` → entropy.
    pub think_seed: Option<u32>,
    /// Open-loop target arrival rate (iterations/s). `Some` → open-loop path
    /// (`run_scenario_open_loop`); `None` → closed-loop `run_scenario` (byte-identical).
    pub target_rps: Option<u32>,
    /// Open-loop concurrent in-flight cap = reusable slot-pool size. Required when
    /// `target_rps` is set (controller-validated). Each slot = one `VuClient` + cookie jar.
    pub max_in_flight: Option<u32>,
    /// Open-loop multi-stage rate curve (S-D). `Some(non-empty)` → the open-loop
    /// scheduler fires the k-th arrival attempt at Λ⁻¹(k + ½), Λ = ∫`rate_at(stages)`
    /// (`ArrivalSchedule`, §B34), instead of the fixed `target_rps`. `None` → fixed
    /// rate (byte-identical to S-C). The worker sets
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
    /// VU-curve graceful ramp-down 상한. `Some(d)` → 은퇴(desired 하락) 후 현재
    /// iteration이 `d`를 넘겨 lingering하면 supervisor가 activation 토큰을 취소해
    /// 다음 스텝 경계에서 park시킨다(immediate 경로 재사용). `None` → 무상한(현재
    /// 거동, byte-identical). graceful 모드에서만 참조(immediate가 항상 우선).
    pub graceful_ramp_down: Option<Duration>,
    /// connect(TCP+TLS) 단계 전용 타임아웃 (E3, spec §3.4). `Some`이면
    /// `ClientBuilder::connect_timeout`으로 설치돼, connect에서 막힌 요청이
    /// 전체-요청 `timeout`이 아니라 `ErrorKind::ConnectTimeout`으로 분류된다.
    /// `None` = 미설정(오늘과 byte-identical — 빌더 호출 자체가 없음).
    /// 컨트롤러가 `connect_timeout_seconds < http_timeout_seconds`를 강제한다.
    pub connect_timeout: Option<Duration>,
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
    /// Per-second active-VU gauge samples since the last flush. Only the VU-curve path
    /// populates this; all other paths send an empty Vec (byte-identical).
    pub active_vu_samples: Vec<ActiveVuSample>,
    /// Per-(step_id, kind) transport-send-failure count deltas since the last flush
    /// (spec 2026-08-01 §3.3). All 3 entry points populate this identically.
    pub error_kind_stats: Vec<ErrorKindStat>,
    /// Per-(loop_id, pass_bucket, outcome) 조건 반복 진입 종료 델타 (loop-while-report).
    /// 조건 반복이 없는 run은 항상 빈 Vec.
    pub loop_exit_stats: Vec<LoopExitStat>,
    /// open-loop 초 단위 시작·완료·버림 계수(계단 시험 a). 주기 flush는 끝난 초만,
    /// 최종 flush는 나머지 전부. closed-loop·VU 곡선 경로는 항상 빈 Vec.
    pub open_loop_seconds: Vec<OpenLoopSecond>,
    /// 스케줄 t=0의 epoch ms. open-loop 전 경로와 closed-loop 고정(`run_scenario`)이 모든 flush에 싣는다. VU 곡선 경로는 `None`.
    pub open_loop_started_at_ms: Option<i64>,
    /// 준비 구간의 스텝 통계 델타 (본 창과 별개). 준비가 없는 run은 항상 빈 Vec.
    pub section_step_stats: Vec<SectionStepStat>,
    /// 준비 구간 실행 결과 수 델타. 준비가 없는 run은 항상 빈 Vec.
    pub section_outcomes: Vec<SectionOutcome>,
}

/// 한 epoch 초의 open-loop 계수(계단 시험 a). `launched` = 슬롯을 얻어 시작한 도착,
/// `dropped` = 슬롯이 없어 버린 도착, `completed` = 그 초에 반복이 끝난 도착(결과 무관).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenLoopSecond {
    pub ts_second: i64,
    pub launched: u64,
    pub completed: u64,
    pub dropped: u64,
}

/// One shared worker-local cursor per binding, `Some` only for `IterSequential`
/// and `Unique` (the policies that advance a cursor); `None` for `PerVu`/`IterRandom`.
/// Index aligns with `data_bindings` order. Shared by all three execution paths.
fn make_seq_counters(datasets: &[Arc<DataSet>]) -> Vec<Option<Arc<AtomicU64>>> {
    datasets
        .iter()
        .map(|d| match d.policy {
            BindingPolicy::IterSequential | BindingPolicy::Unique => {
                Some(Arc::new(AtomicU64::new(0)))
            }
            _ => None,
        })
        .collect()
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
    let started_at_ms = epoch_millis();
    let deadline = started_at + plan.duration;
    let failed = Arc::new(AtomicU32::new(0));
    // Sample of the first non-Aborted VU failure cause (Task 2, US3). First
    // writer wins (`OnceLock::set` on later failures is a no-op) — with a
    // single VU this is deterministic; with multiple VUs it's a race, which is
    // why acceptance only asserts single-cause/single-VU (see engine/tests
    // all_vus_failed.rs doc comment).
    let cause: Arc<OnceLock<String>> = Arc::new(OnceLock::new());
    let env = Arc::new(plan.env);
    let datasets = plan.data_bindings.clone();
    let http_timeout = plan.http_timeout;
    let connect_timeout = plan.connect_timeout;
    let think_time = plan.think_time;
    let think_seed = plan.think_seed;
    let measure_phases = plan.measure_phases;
    // One shared worker-local counter per binding (IterSequential | Unique only),
    // created once per run; index = binding order.
    let seq_counters = make_seq_counters(&datasets);
    // refresh: request 판정 — run당 1회, VU 공유(spec §4.3). None이면 요청 경로는 지금과 같다.
    let reqgen = RequestGenPlan::build(&scenario);
    // 준비 통계 누적기 — 준비 스텝이 있는 run만 만든다.
    let section_stats: Option<SharedSectionStats> = if scenario.setup_steps().is_empty() {
        None
    } else {
        Some(SharedSectionStats::default())
    };

    let mut set = JoinSet::new();

    let ramp_secs = plan.ramp_up.as_secs();
    let per_tick: u32 = if ramp_secs == 0 || plan.vus == 0 {
        plan.vus
    } else {
        plan.vus.div_ceil(ramp_secs as u32).max(1)
    };

    // Flusher: drain completed 1s windows until the run ends. Started before the
    // VU spawn loop so metrics flow during ramp-up.
    let flush_agg = agg.clone();
    let flush_out = out.clone();
    let flush_sections = section_stats.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = current_second();
            let (
                drained,
                loop_stats,
                branch_stats,
                group_stats,
                phase_stats,
                error_kind_stats,
                loop_exit_stats,
            ) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                    g.drain_phase_deltas(),
                    g.drain_error_kind_deltas(),
                    g.drain_loop_exit_deltas(),
                )
            };
            let (section_step_stats, section_outcomes) = drain_shared(&flush_sections);
            if !drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
                || !phase_stats.is_empty()
                || !error_kind_stats.is_empty()
                || !loop_exit_stats.is_empty()
                || !section_step_stats.is_empty()
                || !section_outcomes.is_empty()
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
                        active_vu_samples: vec![],
                        error_kind_stats,
                        loop_exit_stats,
                        open_loop_seconds: vec![],
                        open_loop_started_at_ms: Some(started_at_ms),
                        section_step_stats,
                        section_outcomes,
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
            let cause = cause.clone();
            let env = env.clone();
            let cancel_vu = cancel.clone();
            let datasets = datasets.clone();
            let seq_counters = seq_counters.clone();
            let reqgen = reqgen.clone();
            let section_stats = section_stats.clone();
            set.spawn(async move {
                if let Err(e) = run_vu(
                    scenario,
                    vu_id,
                    agg,
                    deadline,
                    env,
                    cancel_vu,
                    datasets,
                    seq_counters,
                    http_timeout,
                    think_time,
                    think_seed,
                    measure_phases,
                    connect_timeout,
                    reqgen,
                    section_stats,
                )
                .await
                {
                    if !matches!(e, EngineError::Aborted) {
                        warn!(vu_id, error = ?e, "vu failed");
                        // Capture the first non-Aborted cause HERE, inside this
                        // gate, not after the JoinSet drain below. Defensive,
                        // not observable today: `if cancel.is_cancelled() {
                        // return Err(EngineError::Aborted); }` at runner.rs:335
                        // already early-returns before `AllVusFailed` is ever
                        // constructed on a cancelled run, so no reachable input
                        // can carry a cancel-tainted cause. If that early
                        // return is ever reordered or removed, this placement
                        // keeps a user abort from being recorded as "the
                        // failure cause". First writer wins (`OnceLock`); later
                        // failures on other VUs are no-ops.
                        //
                        // `safe_cause` (not `e.to_string()`) — `cause` is
                        // persisted (`runs.message`), not just logged, so it
                        // must never carry a resolved template value (security
                        // fix, see `error.rs::safe_cause` doc). A
                        // non-allowlisted variant yields `None` here (no-op on
                        // `OnceLock`, byte-identical message) — the `warn!`
                        // above still gets the full `Debug` for operators
                        // reading logs (pre-existing, unaffected).
                        if let Some(msg) = safe_cause(&e) {
                            let _ = cause.set(msg);
                        }
                    }
                    failed.fetch_add(1, Ordering::Relaxed);
                }
            });
            spawned += 1;
            spawn_now -= 1;
        }
        next_spawn += Duration::from_secs(1);
    }

    while let Some(res) = set.join_next().await {
        if let Err(e) = res {
            warn!(error = %e, "vu join error");
            failed.fetch_add(1, Ordering::Relaxed);
        }
    }

    let (
        final_windows,
        final_loops,
        final_branches,
        final_groups,
        final_phases,
        final_error_kinds,
        final_loop_exits,
    ) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
            g.drain_phase_deltas(),
            g.drain_error_kind_deltas(),
            g.drain_loop_exit_deltas(),
        )
    };
    let (section_step_stats, section_outcomes) = drain_shared(&section_stats);
    if !final_windows.is_empty()
        || !final_loops.is_empty()
        || !final_branches.is_empty()
        || !final_groups.is_empty()
        || !final_phases.is_empty()
        || !final_error_kinds.is_empty()
        || !final_loop_exits.is_empty()
        || !section_step_stats.is_empty()
        || !section_outcomes.is_empty()
    {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
                group_stats: final_groups,
                dropped: 0,
                phase_stats: final_phases,
                active_vu_samples: vec![],
                error_kind_stats: final_error_kinds,
                loop_exit_stats: final_loop_exits,
                open_loop_seconds: vec![],
                open_loop_started_at_ms: Some(started_at_ms),
                section_step_stats,
                section_outcomes,
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
            cause: cause.get().cloned(),
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
#[instrument(
    skip(scenario, agg, env, datasets, seq_counters, reqgen, section_stats),
    fields(vu_id)
)]
async fn run_vu(
    scenario: Arc<Scenario>,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: Arc<BTreeMap<String, String>>,
    cancel: CancellationToken,
    datasets: Vec<Arc<DataSet>>,
    seq_counters: Vec<Option<Arc<AtomicU64>>>,
    http_timeout: Duration,
    think_time: Option<ThinkTime>,
    think_seed: Option<u32>,
    measure_phases: bool,
    connect_timeout: Option<Duration>,
    reqgen: Option<Arc<RequestGenPlan>>,
    section_stats: Option<SharedSectionStats>,
) -> Result<()> {
    let client = VuClient::with_timeout(
        scenario.cookie_jar,
        http_timeout,
        measure_phases,
        connect_timeout,
    )?;
    let mut think_rng = match think_seed {
        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, 0)),
        None => StdRng::from_entropy(),
    };
    // 생성기 전용 rng — think_rng와 분리 (spec §4: 난수열 교란·의도치 않은 재현성 방지).
    let mut gen_rng = StdRng::from_entropy();
    let mut iter_id: u32 = 0;
    let mut vu_setup = VuSetup::default();
    // 본 스텝이 없으면 VU는 준비 구간(없으면 첫 반복 머리)까지만 하고 끝난다(spec D16).
    let no_main = scenario.steps.is_empty();
    while Instant::now() < deadline {
        if cancel.is_cancelled() {
            return Err(EngineError::Aborted);
        }
        // Per-iteration flow vars: start fresh from the scenario base (re-seeded
        // per iteration — generator values re-evaluate every loop).
        let mut iter_vars: BTreeMap<String, String> =
            crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
        let mut blanked = BlankTable::new();
        let mut req = reqgen
            .as_ref()
            .map(|p| ReqGen::new(p.clone(), &mut gen_rng));
        vu_setup.overlay(&mut iter_vars, &mut req);
        let setup_stats = section_stats.as_ref().filter(|_| !vu_setup.done);
        let seed_vars = setup_stats.map(|_| iter_vars.clone());
        let mut injected_rows: Vec<&BTreeMap<String, String>> = Vec::new();
        // Inject every binding in declared order. The first binding whose Unique
        // slice is exhausted (None) stops this VU; the partial inject is discarded.
        // Side effect (spec §7): an earlier IterSequential binding's shared counter
        // already advanced one step on the break-triggering iteration (≤1/VU,
        // on par with a deadline-truncated partial iteration).
        let mut stop = false;
        for (ds, counter) in datasets.iter().zip(seq_counters.iter()) {
            match ds.select_index(vu_id, iter_id, counter.as_deref()) {
                Some(idx) => {
                    if setup_stats.is_some() {
                        injected_rows.push(&ds.rows[idx]);
                    }
                    for (k, v) in &ds.rows[idx] {
                        iter_vars.insert(k.clone(), v.clone());
                    }
                    if let Some(rg) = req.as_mut() {
                        rg.mark_written(ds.rows[idx].keys());
                    }
                }
                // unique slice exhausted → stop this VU (clean Ok, not a failure).
                None => {
                    stop = true;
                    break;
                }
            }
        }
        if stop {
            break;
        }
        if let (Some(stats), Some(mut rebuilt)) = (setup_stats, seed_vars) {
            let mut setup_vars = iter_vars.clone();
            let run = run_section(
                Section::Setup,
                scenario.setup_steps(),
                &client,
                &mut setup_vars,
                &env,
                vu_id,
                iter_id,
                deadline,
                &cancel,
                &mut think_rng,
                scenario.default_think_time,
                &mut req,
                stats,
            )
            .await?;
            match run {
                SectionRun::Done(extracted) => {
                    vu_setup = VuSetup {
                        done: true,
                        vars: extracted,
                    };
                    vu_setup.overlay(&mut rebuilt, &mut req);
                    for row in injected_rows {
                        for (k, v) in row {
                            rebuilt.insert(k.clone(), v.clone());
                        }
                    }
                    iter_vars = rebuilt;
                }
                SectionRun::Failed(e) => return Err(e),
                SectionRun::Deadline => return Ok(()),
                SectionRun::Aborted => {
                    stats
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .record_interrupted(Section::Setup);
                    return Err(EngineError::Aborted);
                }
            }
        }
        if no_main {
            break;
        }
        let flow = execute_steps(
            &client,
            &scenario.steps,
            &mut iter_vars,
            &mut blanked,
            &agg,
            deadline,
            &env,
            vu_id,
            iter_id,
            None,
            &cancel,
            &mut think_rng,
            measure_phases,
            scenario.default_think_time,
            &mut req,
            None,
        )
        .await?;
        match flow {
            StepFlow::Continue | StepFlow::EndIteration => {}
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
    /// 조건 반복이 최대 횟수까지 조건을 만족해 이번 반복(시나리오 한 바퀴)을 여기서 끝낸다.
    /// deadline/abort가 아니므로 VU는 다음 반복을 계속한다.
    EndIteration,
}

/// 조건 반복 회차 하나에서 기록한 응답 한 건. 회차가 끝나야 갈래를 알 수 있어 그때까지 쥔다.
struct PassSample {
    step_id: String,
    latency_us: u64,
    is_error: bool,
}

/// 조건 반복 회차 하나의 기록: 응답 표본과, 그 회차 본문(안쪽 if·loop·parallel 포함)에서
/// 요청을 보냈는가 / 막힌 http 스텝이 있었는가.
#[derive(Default)]
struct PassBuf {
    samples: Vec<PassSample>,
    activity: PassActivity,
}

#[derive(Default, Clone, Copy)]
struct PassActivity {
    sent: bool,
    blocked: bool,
}

impl PassActivity {
    /// 아무것도 안 보내고 막히기만 한 회차 — 다음 회차도 새로 뽑을 값이 없어 같다
    /// (blank-var-url-guard G1: 최대 횟수 소진처럼 이번 시나리오 반복을 끝낸다).
    fn dead(self) -> bool {
        self.blocked && !self.sent
    }

    fn or(self, other: PassActivity) -> PassActivity {
        PassActivity {
            sent: self.sent || other.sent,
            blocked: self.blocked || other.blocked,
        }
    }
}

/// 조건 반복 진입마다 하나. parallel 분기가 `join_all`로 같은 참조를 함께 쓰므로 잠금이다
/// (std 잠금 — `await`를 넘겨 쥐지 않는다).
type PassSamples = std::sync::Mutex<PassBuf>;

/// 회차 버퍼를 `scratch`와 맞바꿔 가져오고(새 `Vec` 할당 없음) 회차 표지를 비우며 돌려준다.
/// 오염된 잠금은 그대로 쓴다.
fn take_pass(samples: &PassSamples, scratch: &mut Vec<PassSample>) -> PassActivity {
    debug_assert!(
        scratch.is_empty(),
        "take_pass: the receiving scratch Vec must be empty before the swap"
    );
    let mut g = samples.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::swap(&mut g.samples, scratch);
    std::mem::take(&mut g.activity)
}

/// 회차 표지에 `add`를 더한다(안쪽 조건 반복이 끝나며 바깥 회차에 알릴 때도 쓴다).
fn mark_pass(samples: &PassSamples, add: PassActivity) {
    let mut g = samples.lock().unwrap_or_else(|e| e.into_inner());
    g.activity = g.activity.or(add);
}

/// `scratch`의 표본을 전부 `class`로 기록하고 비운다.
fn flush_pass(a: &mut Aggregator, scratch: &mut Vec<PassSample>, class: LoopSplitClass) {
    for s in scratch.drain(..) {
        a.record_loop_split(&s.step_id, class, s.latency_us, s.is_error);
    }
}

/// Recursively execute a slice of steps for one VU iteration. Http leaves run a
/// request + record a metric, then optionally pace (per-step think time); loop
/// nodes recurse over their body `repeat` times; a conditional loop (`while`) is
/// do-while: body once, then the condition, and when it still holds at the max pass
/// count the iteration ends via `StepFlow::EndIteration`.
/// Returns `Err` only for genuine engine errors (template/header build failures);
/// deadline and cancellation are surfaced via `StepFlow` so the caller can decide
/// whether to end the iteration cleanly or report an abort — byte-for-byte the
/// same behavior the old flat loop had for the non-loop case.
#[allow(clippy::too_many_arguments)]
async fn execute_steps(
    client: &VuClient,
    steps: &[Step],
    iter_vars: &mut BTreeMap<String, String>,
    // 추출 못 해 비워진 이름 → 그 스텝 id (반복마다 새로, blank-var-url-guard).
    blanked: &mut BlankTable,
    agg: &Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: &Arc<BTreeMap<String, String>>,
    vu_id: u32,
    iter_id: u32,
    loop_index: Option<u32>,
    cancel: &CancellationToken,
    rng: &mut StdRng,
    measure_phases: bool,
    // 시나리오 기본 think time. http 스텝이 자기 `think_time`을 안 가지면 이 값을 쓴다.
    // **Parallel arm은 분기 재귀에 `None`을 넘긴다**(spec R4).
    default_think: Option<ThinkTime>,
    // 요청 단위 재평가 상태(spec 2026-10-17-genvar-per-request §4.4). None = refresh 변수 없음.
    req: &mut Option<ReqGen>,
    // 조건 반복(while) 본문 안이면 Some: 본문 http 스텝은 너그러운 추출을 쓰고 빠진 값은 빈 문자열로
    // 채운다. 가리키는 버퍼는 그 회차의 응답 표본 — 회차가 끝날 때 조건 반복 가지가 갈래를 정한다.
    cond_pass: Option<&PassSamples>,
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
                if let Some(rg) = req.as_mut() {
                    rg.refresh(&http.id, iter_vars);
                }
                // 주소가 읽는 이름 중 "추출 못 해 비워진" 값이 지금도 비어 있으면 보내지 않는다
                // (blank-var-url-guard R1). ctx 차용은 판정 값만 꺼내고 닫는다.
                let blocked = {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env: env.as_ref(),
                        vu_id,
                        iter_id,
                        loop_index,
                    };
                    blank_guard::check(&http.request.url, &ctx, blanked).is_some()
                };
                if blocked {
                    let mut none = BTreeMap::new();
                    let filled =
                        fill_missing_extracts(http, &mut none, iter_vars, cond_pass.is_some());
                    if let Some(rg) = req.as_mut() {
                        rg.mark_written(filled.defaulted.iter());
                    }
                    blank_guard::note_step(blanked, &http.id, &none, &filled.blanked);
                    if let Some(samples) = cond_pass {
                        mark_pass(
                            samples,
                            PassActivity {
                                sent: false,
                                blocked: true,
                            },
                        );
                    }
                    let mut a = agg.lock().await;
                    a.record_not_sent(&http.id, loop_index);
                    a.record_error_kind(&http.id, ErrorKind::BlankVar);
                    drop(a);
                    // 보내지 않은 스텝은 await할 곳이 없다 — 같은 실행기의 다른 task가 굶지 않게 한다.
                    tokio::task::yield_now().await;
                } else {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env: env.as_ref(),
                        vu_id,
                        iter_id,
                        loop_index,
                    };
                    let mode = if cond_pass.is_some() {
                        ExtractMode::Lenient
                    } else {
                        ExtractMode::Strict
                    };
                    let mut outcome = execute_step_with(client, http, &ctx, mode).await?;
                    if let Some(rg) = req.as_mut() {
                        rg.mark_written(outcome.extracted.keys());
                    }
                    let filled = fill_missing_extracts(
                        http,
                        &mut outcome.extracted,
                        iter_vars,
                        cond_pass.is_some(),
                    );
                    if let Some(rg) = req.as_mut() {
                        rg.mark_written(filled.defaulted.iter());
                    }
                    blank_guard::note_step(blanked, &http.id, &outcome.extracted, &filled.blanked);
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
                        if let Some(k) = outcome.error_kind {
                            a.record_error_kind(&outcome.step_id, k);
                        }
                        if measure_phases {
                            if let Some(dl) = outcome.download {
                                a.record_phase(
                                    &outcome.step_id,
                                    "download",
                                    dl.as_micros().min(u64::MAX as u128) as u64,
                                );
                            }
                            if let Some(w) = outcome.wait {
                                a.record_phase(
                                    &outcome.step_id,
                                    "wait",
                                    w.as_micros().min(u64::MAX as u128) as u64,
                                );
                            }
                            if let Some(d) = outcome.dns {
                                a.record_phase(
                                    &outcome.step_id,
                                    "dns",
                                    d.as_micros().min(u64::MAX as u128) as u64,
                                );
                            }
                            if let Some(c) = outcome.connect {
                                a.record_phase(
                                    &outcome.step_id,
                                    "connect",
                                    c.as_micros().min(u64::MAX as u128) as u64,
                                );
                            }
                        }
                    } // drop the aggregator guard before the (possibly long) think-time sleep
                    if let Some(samples) = cond_pass {
                        let mut g = samples.lock().unwrap_or_else(|e| e.into_inner());
                        g.activity.sent = true;
                        if g.samples.len() < LOOP_SPLIT_PASS_SAMPLE_CAP {
                            g.samples.push(PassSample {
                                step_id: std::mem::take(&mut outcome.step_id),
                                latency_us: outcome.latency.as_micros().min(u64::MAX as u128)
                                    as u64,
                                is_error: outcome.error.is_some(),
                            });
                        }
                    }
                }
                if let Some(tt) = http.think_time.or(default_think) {
                    match pace(tt.sample(rng), deadline, cancel).await {
                        PaceOutcome::Slept => {}
                        PaceOutcome::Cancelled => return Ok(StepFlow::Aborted),
                        PaceOutcome::DeadlineReached => return Ok(StepFlow::DeadlineReached),
                    }
                }
            }
            Step::Loop(lp) => {
                if let Some(cond) = lp.while_.as_ref() {
                    // do-while: 본문을 먼저 돌리고 조건을 본다. 최대 횟수(repeat)에 닿으면
                    // 이번 반복을 끝낸다(EndIteration) — deadline/abort가 아니다.
                    // 진입이 끝나는 다섯 지점에서 리포트 집계만 남긴다(흐름 불변,
                    // spec 2026-11-14-loop-while-report §3.1).
                    let max = lp.max_passes();
                    let mut pass: u32 = 0;
                    // 이 진입의 회차 표본 버퍼(본문이 `Some(&samples)`로 받는다)와 비우기용 빈 `Vec`.
                    let samples: PassSamples = std::sync::Mutex::new(PassBuf::default());
                    let mut scratch: Vec<PassSample> = Vec::new();
                    // 이 진입 전체의 표지 — 반복을 나오며 바깥 조건 반복 회차에 더한다(중첩 반복).
                    let mut entry_activity = PassActivity::default();
                    loop {
                        if Instant::now() >= deadline {
                            if pass > 0 {
                                agg.lock().await.record_loop_exit(
                                    &lp.id,
                                    pass,
                                    LoopExitOutcome::Truncated,
                                );
                            }
                            return Ok(StepFlow::DeadlineReached);
                        }
                        if cancel.is_cancelled() {
                            if pass > 0 {
                                agg.lock().await.record_loop_exit(
                                    &lp.id,
                                    pass,
                                    LoopExitOutcome::Truncated,
                                );
                            }
                            return Ok(StepFlow::Aborted);
                        }
                        let res = Box::pin(execute_steps(
                            client,
                            &lp.do_,
                            iter_vars,
                            blanked,
                            agg,
                            deadline,
                            env,
                            vu_id,
                            iter_id,
                            Some(pass),
                            cancel,
                            rng,
                            measure_phases,
                            default_think,
                            req,
                            Some(&samples),
                        ))
                        .await;
                        match res {
                            Ok(StepFlow::Continue) => {}
                            other => {
                                // 본문이 끊겼다(비-Continue 흐름 또는 Err) — 끊긴 회차까지 센다.
                                take_pass(&samples, &mut scratch);
                                {
                                    let mut a = agg.lock().await;
                                    flush_pass(&mut a, &mut scratch, LoopSplitClass::Cut);
                                    a.record_loop_exit(
                                        &lp.id,
                                        pass.saturating_add(1),
                                        LoopExitOutcome::Truncated,
                                    );
                                }
                                return other;
                            }
                        }
                        pass = pass.saturating_add(1);
                        let activity = take_pass(&samples, &mut scratch);
                        entry_activity = entry_activity.or(activity);
                        if activity.dead() {
                            // 보낸 요청 없이 막히기만 한 회차: 다음 회차도 같다. 조건이 기대는 값을
                            // 가져오지 못했으니 반복이 끝났다고 볼 수 없어 반복 뒤 스텝(조건이
                            // 풀려야 갈 곳)으로 가지 않고, 최대 횟수에 닿은 것처럼 이번 반복을
                            // 끝낸다(fail-closed, 「마치지 못함」 —
                            // blank-var-url-guard G1). 보낸 표본이 없으니 scratch는 비어 있다.
                            agg.lock().await.record_loop_exit(
                                &lp.id,
                                pass,
                                LoopExitOutcome::Truncated,
                            );
                            return Ok(StepFlow::EndIteration);
                        }
                        let again = {
                            let ctx = TemplateContext {
                                vars: iter_vars,
                                env: env.as_ref(),
                                vu_id,
                                iter_id,
                                loop_index: Some(pass - 1),
                            };
                            eval_condition(cond, &ctx)
                        };
                        if !again {
                            let mut a = agg.lock().await;
                            flush_pass(&mut a, &mut scratch, LoopSplitClass::Ended);
                            a.record_loop_exit(&lp.id, pass, LoopExitOutcome::Completed);
                            break;
                        }
                        if let Some(n) = max {
                            if pass >= n {
                                let mut a = agg.lock().await;
                                flush_pass(&mut a, &mut scratch, LoopSplitClass::Cut);
                                a.record_loop_exit(&lp.id, pass, LoopExitOutcome::Exhausted);
                                return Ok(StepFlow::EndIteration);
                            }
                        }
                        if !scratch.is_empty() {
                            flush_pass(
                                &mut *agg.lock().await,
                                &mut scratch,
                                LoopSplitClass::Continued,
                            );
                        }
                        // 요청 없는 본문이어도 같은 실행기의 다른 task가 굶지 않게 한다.
                        tokio::task::yield_now().await;
                    }
                    if let Some(outer) = cond_pass {
                        mark_pass(outer, entry_activity);
                    }
                } else {
                    for i in 0..lp.plain_repeat() {
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
                            blanked,
                            agg,
                            deadline,
                            env,
                            vu_id,
                            iter_id,
                            Some(i),
                            cancel,
                            rng,
                            measure_phases,
                            default_think,
                            req,
                            cond_pass,
                        ))
                        .await?;
                        match flow {
                            StepFlow::Continue => {}
                            other => return Ok(other),
                        }
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
                    blanked,
                    agg,
                    deadline,
                    env,
                    vu_id,
                    iter_id,
                    loop_index,
                    cancel,
                    rng,
                    measure_phases,
                    default_think,
                    req,
                    cond_pass,
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
                let entry_blanked: BlankTable = blanked.clone();
                // One deterministic seed per branch, drawn in declaration order from
                // the VU rng (reproducible given think_seed). Concurrent branches
                // can't share &mut rng, so each gets an independent StdRng.
                let seeds: Vec<u64> = (0..par.branches.len()).map(|_| rng.next_u64()).collect();

                // 분기별 재평가 상태 — 부모 **생성기** rng에서 시드(think rng 시드와 별개, §4.2).
                let branch_reqs: Vec<Option<ReqGen>> = par
                    .branches
                    .iter()
                    .map(|_| req.as_mut().map(ReqGen::fork))
                    .collect();
                let futs = par.branches.iter().zip(seeds).zip(branch_reqs).map(
                    |((branch, seed), branch_req)| {
                        let mut branch_vars = entry.clone();
                        let mut branch_blanked = entry_blanked.clone();
                        let mut branch_rng = StdRng::seed_from_u64(seed);
                        let mut branch_req = branch_req;
                        async move {
                            let bt0 = Instant::now();
                            let flow = Box::pin(execute_steps(
                                client,
                                &branch.steps,
                                &mut branch_vars,
                                &mut branch_blanked,
                                agg,
                                deadline,
                                env,
                                vu_id,
                                iter_id,
                                loop_index,
                                cancel,
                                &mut branch_rng,
                                measure_phases,
                                // 시나리오 기본값은 분기 서브트리에 적용하지 않는다(spec R4):
                                // parallel = 동시 리소스 로딩 구간이라 사람의 대기가 낄 자리가 아니고,
                                // 그룹 시간(= 페이지 로드 시간, ADR-0033)이 수면만큼 오염된다.
                                // 분기 스텝에 명시된 think_time은 위 Http arm에서 그대로 적용된다.
                                None,
                                &mut branch_req,
                                cond_pass,
                            ))
                            .await;
                            let branch_us = bt0.elapsed().as_micros() as u64;
                            (branch, branch_vars, branch_blanked, flow, branch_us)
                        }
                    },
                );
                // wait-all: every branch runs to completion before the node returns.
                // Time the whole concurrent block: page-load latency ≈ max(branches) (A2-2).
                let t0 = Instant::now();
                let results = futures::future::join_all(futs).await;
                let elapsed_us = t0.elapsed().as_micros() as u64;

                // Merge in declaration order (join_all preserves input order). Key-origin
                // namespace: expose each branch's declared extract outputs as
                // {{branch.var}}. First Err propagates; else worst flow
                // (Aborted > DeadlineReached > EndIteration > Continue).
                let mut aborted = false;
                let mut deadline_hit = false;
                let mut end_iteration = false;
                let mut branch_samples: Vec<(&str, u64)> = Vec::new();
                for (branch, branch_vars, branch_table, flow, branch_us) in results {
                    match flow? {
                        StepFlow::Continue => {}
                        StepFlow::DeadlineReached => deadline_hit = true,
                        StepFlow::Aborted => aborted = true,
                        StepFlow::EndIteration => end_iteration = true,
                    }
                    for k in branch.output_var_names() {
                        if let Some(v) = branch_vars.get(k) {
                            let key = format!("{}.{}", branch.name, k);
                            iter_vars.insert(key.clone(), v.clone());
                            if let Some(rg) = req.as_mut() {
                                rg.mark_written(std::iter::once(&key));
                            }
                        }
                    }
                    blank_guard::merge_branch(
                        blanked,
                        &branch_table,
                        &branch.name,
                        &branch.output_var_names(),
                        &branch_vars,
                    );
                    branch_samples.push((branch.name.as_str(), branch_us));
                }
                // Record page-load latency only on a clean block — a deadline/abort cut a
                // branch short (skipped steps → too-fast block), which would skew the
                // distribution low. Same caution as loop partial-iteration counting.
                // Page (branch="") + every branch recorded together under the same gate so
                // each branch row's count == the page row's count.
                if !aborted && !deadline_hit && !end_iteration {
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
                if end_iteration {
                    return Ok(StepFlow::EndIteration);
                }
            }
        }
    }
    Ok(StepFlow::Continue)
}

/// Instantaneous arrival rate (iterations/s) at `elapsed_secs` into a piecewise-linear
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

/// One stage of the open-loop curve as a linear-rate segment (§B34):
/// `r(t) = r0 + slope·(t − t0)` on `[t0, t0 + dur]`, `cum0` = Λ(t0), `area` = ∫ over the stage.
#[derive(Debug, Clone, Copy)]
struct Seg {
    t0: f64,
    dur: f64,
    r0: f64,
    slope: f64,
    cum0: f64,
    area: f64,
}

/// Inverse of the cumulative arrival curve Λ(t) = ∫₀ᵗ rate_at(stages, s) ds, evaluated
/// with a monotone cursor (§B34): the k-th arrival attempt fires at Λ⁻¹(k + ½), so
/// [0, T) holds Λ(T) arrivals rounded (|error| ≤ ½). Same curve as `rate_at`; 0-rate
/// stretches are skipped by the inverse itself. Callers must pass non-decreasing `m`.
struct ArrivalSchedule {
    segs: Vec<Seg>,
    /// Index of the first segment that may still contain `m` — only ever moves forward,
    /// so a whole run advances it at most `segs.len()` times (amortized O(1) per arrival).
    cursor: usize,
    end_t: f64,
    end_cum: f64,
    /// Last target: past the curve's end `rate_at` holds it, and so does the inverse.
    tail_rate: f64,
    /// Segments inspected by `time_at` (test-only lock on the amortized-O(1) cursor, G2).
    #[cfg(test)]
    scans: u64,
}

impl ArrivalSchedule {
    fn new(stages: &[Stage]) -> Self {
        let mut segs = Vec::with_capacity(stages.len());
        let mut t0 = 0.0_f64;
        let mut cum0 = 0.0_f64;
        let mut r0 = 0.0_f64;
        for stage in stages {
            let dur = f64::from(stage.duration_seconds);
            let target = f64::from(stage.target);
            // A 0-duration stage (controller-rejected; defensive here) is a pure rate jump
            // like `rate_at`'s span-0 case: no area, slope 0 so no inf/NaN enters the table.
            let (slope, area) = if dur > 0.0 {
                ((target - r0) / dur, (r0 + target) / 2.0 * dur)
            } else {
                (0.0, 0.0)
            };
            segs.push(Seg {
                t0,
                dur,
                r0,
                slope,
                cum0,
                area,
            });
            t0 += dur;
            cum0 += area;
            r0 = target;
        }
        Self {
            segs,
            cursor: 0,
            end_t: t0,
            end_cum: cum0,
            tail_rate: r0,
            #[cfg(test)]
            scans: 0,
        }
    }

    /// Smallest t (seconds since `started_at`) with Λ(t) = `m`; `None` if unreachable
    /// (empty stages, or the curve ends at rate 0 and `m` exceeds its total area).
    fn time_at(&mut self, m: f64) -> Option<f64> {
        while let Some(seg) = self.segs.get(self.cursor).copied() {
            #[cfg(test)]
            {
                self.scans += 1;
            }
            if seg.area > 0.0 && m <= seg.cum0 + seg.area {
                let delta = (m - seg.cum0).max(0.0);
                if delta == 0.0 {
                    return Some(seg.t0);
                }
                // slope/2·τ² + r0·τ = Δ in the cancellation-free form — one expression for
                // rising, falling and flat segments. Δ ≤ area keeps the discriminant ≥ min(r0², target²) ≥ 0,
                // so `max(0, ·)` only guards float noise; denominator > 0 because Δ > 0.
                let disc = (seg.r0 * seg.r0 + 2.0 * seg.slope * delta).max(0.0);
                let tau = 2.0 * delta / (seg.r0 + disc.sqrt());
                return Some(seg.t0 + tau.min(seg.dur));
            }
            self.cursor += 1;
        }
        if self.tail_rate > 0.0 {
            Some(self.end_t + (m - self.end_cum).max(0.0) / self.tail_rate)
        } else {
            None
        }
    }
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
    // Sample of the first non-Aborted VU failure cause (Task 2, US3) — mirror
    // of run_scenario's `cause` slot, see that function for the full rationale.
    let cause: Arc<OnceLock<String>> = Arc::new(OnceLock::new());
    let env = Arc::new(plan.env);
    let datasets = plan.data_bindings.clone();
    let http_timeout = plan.http_timeout;
    let connect_timeout = plan.connect_timeout;
    let think_time = plan.think_time;
    let think_seed = plan.think_seed;
    let measure_phases = plan.measure_phases;
    let immediate = plan.ramp_down == RampDown::Immediate;
    let graceful_ramp_down = plan.graceful_ramp_down;
    let seq_counters = make_seq_counters(&datasets);
    // refresh: request 판정 — run당 1회, VU 공유(spec §4.3). None이면 요청 경로는 지금과 같다.
    let reqgen = RequestGenPlan::build(&scenario);
    let section_stats: Option<SharedSectionStats> = if scenario.setup_steps().is_empty() {
        None
    } else {
        Some(SharedSectionStats::default())
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
    let mut retire_since: Vec<Option<Instant>> = vec![None; max_vus as usize];
    // 끝난 VU 태스크 수 — 본 스텝이 없는 run만 센다(감독 루프의 이른 종료, spec D16).
    let ended: Option<Arc<AtomicU32>> = scenario
        .steps
        .is_empty()
        .then(|| Arc::new(AtomicU32::new(0)));

    // Flusher: mirror of run_scenario's (MetricFlush drain site #5 — see engine
    // CLAUDE.md "드레인 6/guard 5"). dropped is always 0 on this path.
    let flush_agg = agg.clone();
    let flush_out = out.clone();
    let flush_sections = section_stats.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = current_second();
            let (
                drained,
                loop_stats,
                branch_stats,
                group_stats,
                phase_stats,
                active_vu_samples,
                error_kind_stats,
                loop_exit_stats,
            ) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                    g.drain_phase_deltas(),
                    g.drain_active_vu_completed(now_s),
                    g.drain_error_kind_deltas(),
                    g.drain_loop_exit_deltas(),
                )
            };
            let (section_step_stats, section_outcomes) = drain_shared(&flush_sections);
            if (!drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
                || !phase_stats.is_empty()
                || !active_vu_samples.is_empty()
                || !error_kind_stats.is_empty()
                || !loop_exit_stats.is_empty()
                || !section_step_stats.is_empty()
                || !section_outcomes.is_empty())
                && flush_out
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
                        group_stats,
                        dropped: 0,
                        phase_stats,
                        active_vu_samples,
                        error_kind_stats,
                        loop_exit_stats,
                        open_loop_seconds: vec![],
                        open_loop_started_at_ms: None,
                        section_step_stats,
                        section_outcomes,
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
        // 본 스텝이 없는 run: 곡선 최고점까지 VU를 다 띄웠고 그 VU가 모두 끝났으면 끝낸다.
        // 최고점 전에는 끝내지 않는다 — 뒤에 시작할 VU도 준비를 한 번 해야 한다.
        if ended
            .as_ref()
            .is_some_and(|e| spawned >= max_vus && e.load(Ordering::Acquire) >= spawned)
        {
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
            let cause = cause.clone();
            let env = env.clone();
            let cancel_vu = cancel.clone();
            let datasets = datasets.clone();
            let seq_counters = seq_counters.clone();
            let rx = desired_rx.clone();
            let slab_vu = slab.clone();
            let reqgen = reqgen.clone();
            let section_stats = section_stats.clone();
            let end_guard = ended.clone().map(VuEnded);
            set.spawn(async move {
                // 태스크가 어떻게 끝나든(panic 포함) future가 버려질 때 센다.
                let _end_guard = end_guard;
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
                    datasets,
                    seq_counters,
                    http_timeout,
                    think_time,
                    think_seed,
                    measure_phases,
                    connect_timeout,
                    reqgen,
                    section_stats,
                )
                .await
                {
                    if !matches!(e, EngineError::Aborted) {
                        warn!(vu_id, error = ?e, "vu failed");
                        // Capture the first non-Aborted cause HERE, inside this
                        // gate — mirror of run_scenario's placement (see that
                        // function's spawn closure for the full rationale).
                        // Defensive, not observable today: `if
                        // cancel.is_cancelled() { return
                        // Err(EngineError::Aborted); }` at runner.rs:963
                        // already early-returns before `AllVusFailed` is ever
                        // constructed on a cancelled run. First writer wins
                        // (`OnceLock`).
                        //
                        // `safe_cause` mirror of run_scenario's placement — see
                        // that spawn closure for the full security rationale
                        // (`cause` is persisted, must be value-free).
                        if let Some(msg) = safe_cause(&e) {
                            let _ = cause.set(msg);
                        }
                    }
                    failed.fetch_add(1, Ordering::Relaxed);
                }
            });
            spawned += 1;
        }
        let _ = desired_tx.send(desired);
        // Active-VU gauge: keep-last sample per wall-clock second. The supervisor runs
        // 4 ticks/sec; `record_active_vu` uses a BTreeMap keyed by second so multiple
        // ticks within the same second overwrite — drain always yields one entry/sec.
        // `desired` reuses the value computed above; `actual` counts live slab tokens.
        let sample_second = current_second();
        let actual = {
            let g = slab.lock().expect("slab mutex");
            g.iter().flatten().count() as u32
        };
        agg.lock()
            .await
            .record_active_vu(sample_second, desired, actual);
        if immediate {
            // Idempotent re-cancel every tick (NOT falling-edge-only): closes the
            // "VU woke on watch but hasn't registered yet" race — worst lag is one
            // tick (250ms) + a step boundary (spec §4.2).
            let g = slab.lock().expect("slab mutex");
            for tok in g.iter().skip(desired as usize).flatten() {
                tok.cancel();
            }
        } else if let Some(cap) = graceful_ramp_down {
            retire_expired(&slab, &mut retire_since, desired, spawned, cap, now);
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
    let (
        final_windows,
        final_loops,
        final_branches,
        final_groups,
        final_phases,
        final_active_vu,
        final_error_kinds,
        final_loop_exits,
    ) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
            g.drain_phase_deltas(),
            g.drain_active_vu(),
            g.drain_error_kind_deltas(),
            g.drain_loop_exit_deltas(),
        )
    };
    let (section_step_stats, section_outcomes) = drain_shared(&section_stats);
    if !final_windows.is_empty()
        || !final_loops.is_empty()
        || !final_branches.is_empty()
        || !final_groups.is_empty()
        || !final_phases.is_empty()
        || !final_active_vu.is_empty()
        || !final_error_kinds.is_empty()
        || !final_loop_exits.is_empty()
        || !section_step_stats.is_empty()
        || !section_outcomes.is_empty()
    {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
                group_stats: final_groups,
                dropped: 0,
                phase_stats: final_phases,
                active_vu_samples: final_active_vu,
                error_kind_stats: final_error_kinds,
                loop_exit_stats: final_loop_exits,
                open_loop_seconds: vec![],
                open_loop_started_at_ms: None,
                section_step_stats,
                section_outcomes,
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
            cause: cause.get().cloned(),
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

/// 곡선 VU 태스크 하나가 끝났음을 공유 계수에 올린다 — drop으로 올리므로 panic한 태스크도 센다.
struct VuEnded(Arc<AtomicU32>);

impl Drop for VuEnded {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::Release);
    }
}

/// graceful ramp-down 상한(spec §5.3): 은퇴(index >= desired) 후 `cap`을 넘겨
/// 여전히 active(slab Some)인 VU의 토큰을 취소한다. 취소된 VU는 스텝 경계에서
/// `StepFlow::Aborted` → park(immediate와 동일 경로, `failed` 미증가). `retire_since`는
/// supervisor-소유 per-index 타이머(공유 없음). `index >= desired && slab Some`은
/// 항상 원래 lingering 활성화(재활성은 desired > index를 요구)라 취소 안전.
fn retire_expired(
    slab: &std::sync::Mutex<Vec<Option<CancellationToken>>>,
    retire_since: &mut [Option<Instant>],
    desired: u32,
    spawned: u32,
    cap: Duration,
    now: Instant,
) {
    let g = slab.lock().expect("slab mutex");
    for index in (desired as usize)..(spawned as usize) {
        if let Some(tok) = &g[index] {
            match retire_since[index] {
                None => retire_since[index] = Some(now),
                Some(t0) if now.duration_since(t0) >= cap => tok.cancel(),
                _ => {}
            }
        } else {
            retire_since[index] = None; // 자발 park·미활성 → 타이머 리셋
        }
    }
    // index < desired(desired-active)는 은퇴 대상 아님 → 리셋(재-desire 케이스)
    for slot in retire_since.iter_mut().take(desired as usize) {
        *slot = None;
    }
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
///  - setup: `run_section` gets the activation token `act`; a retire during setup
///    leaves setup undone (redone on the next activation) and is not counted as
///    `interrupted`, a run-wide cancel is; every setup exit that ends the VU calls
///    `clear_slot` first.
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
    datasets: Vec<Arc<DataSet>>,
    seq_counters: Vec<Option<Arc<AtomicU64>>>,
    http_timeout: Duration,
    think_time: Option<ThinkTime>,
    think_seed: Option<u32>,
    measure_phases: bool,
    connect_timeout: Option<Duration>,
    reqgen: Option<Arc<RequestGenPlan>>,
    section_stats: Option<SharedSectionStats>,
) -> Result<()> {
    // Client + rng + iter_id persist across park (Park & 재사용, spec §2):
    // the cookie jar IS the session, and iter_id stays monotonic.
    let client = VuClient::with_timeout(
        scenario.cookie_jar,
        http_timeout,
        measure_phases,
        connect_timeout,
    )?;
    let mut think_rng = match think_seed {
        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, 0)),
        None => StdRng::from_entropy(),
    };
    // 생성기 전용 rng — think_rng와 분리, park를 넘어 지속(같은 수명, spec §4).
    let mut gen_rng = StdRng::from_entropy();
    let mut iter_id: u32 = 0;
    // 준비 상태는 park 밖 — 재활성화에서 다시 하지 않는다.
    let mut vu_setup = VuSetup::default();
    // 본 스텝이 없으면 준비 구간 뒤 그 자리에서 끝난다(spec D16) — 자리는 다시 채워지지 않는다.
    let no_main = scenario.steps.is_empty();
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
            let mut iter_vars: BTreeMap<String, String> =
                crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
            let mut blanked = BlankTable::new();
            let mut req = reqgen
                .as_ref()
                .map(|p| ReqGen::new(p.clone(), &mut gen_rng));
            vu_setup.overlay(&mut iter_vars, &mut req);
            let setup_stats = section_stats.as_ref().filter(|_| !vu_setup.done);
            let seed_vars = setup_stats.map(|_| iter_vars.clone());
            let mut injected_rows: Vec<&BTreeMap<String, String>> = Vec::new();
            // Inject every binding in declared order (mirror of run_vu). First
            // exhausted Unique slice → permanent clean stop; partial inject discarded.
            // Side effect (spec §7): an earlier IterSequential counter advances one
            // extra step on the break-triggering iteration (≤1/VU, discarded).
            let mut stop = false;
            for (ds, counter) in datasets.iter().zip(seq_counters.iter()) {
                match ds.select_index(vu_id, iter_id, counter.as_deref()) {
                    Some(idx) => {
                        if setup_stats.is_some() {
                            injected_rows.push(&ds.rows[idx]);
                        }
                        for (k, v) in &ds.rows[idx] {
                            iter_vars.insert(k.clone(), v.clone());
                        }
                        if let Some(rg) = req.as_mut() {
                            rg.mark_written(ds.rows[idx].keys());
                        }
                    }
                    // unique slice exhausted → permanent clean stop (mirror run_vu).
                    None => {
                        stop = true;
                        break;
                    }
                }
            }
            if stop {
                clear_slot(&slab, index);
                return Ok(());
            }
            if let (Some(stats), Some(mut rebuilt)) = (setup_stats, seed_vars) {
                let mut setup_vars = iter_vars.clone();
                let run = match run_section(
                    Section::Setup,
                    scenario.setup_steps(),
                    &client,
                    &mut setup_vars,
                    &env,
                    vu_id,
                    iter_id,
                    deadline,
                    &act,
                    &mut think_rng,
                    scenario.default_think_time,
                    &mut req,
                    stats,
                )
                .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        clear_slot(&slab, index);
                        return Err(e);
                    }
                };
                match run {
                    SectionRun::Done(extracted) => {
                        vu_setup = VuSetup {
                            done: true,
                            vars: extracted,
                        };
                        vu_setup.overlay(&mut rebuilt, &mut req);
                        for row in injected_rows {
                            for (k, v) in row {
                                rebuilt.insert(k.clone(), v.clone());
                            }
                        }
                        iter_vars = rebuilt;
                    }
                    SectionRun::Failed(e) => {
                        clear_slot(&slab, index);
                        return Err(e);
                    }
                    SectionRun::Deadline => {
                        clear_slot(&slab, index);
                        return Ok(());
                    }
                    SectionRun::Aborted => {
                        if cancel.is_cancelled() {
                            stats
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .record_interrupted(Section::Setup);
                        }
                        break; // retire parks with setup undone; run-abort exits below
                    }
                }
            }
            if no_main {
                clear_slot(&slab, index);
                return Ok(());
            }
            let flow = match execute_steps(
                &client,
                &scenario.steps,
                &mut iter_vars,
                &mut blanked,
                &agg,
                deadline,
                &env,
                vu_id,
                iter_id,
                None,
                &act,
                &mut think_rng,
                measure_phases,
                scenario.default_think_time,
                &mut req,
                None,
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
                StepFlow::Continue | StepFlow::EndIteration => {
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

/// open-loop 슬롯 하나의 준비 상태. 슬롯은 한 번에 한 도착만 쓰므로 `setup` 잠금은 대기가 없다.
struct SlotState {
    /// 준비 완료. 스케줄러는 이 값이 참일 때만 도착을 그 자리에서 `Launched`로 센다.
    ready: AtomicBool,
    /// 준비 실패로 run에서 빠진 슬롯 — `SlotGuard`가 큐로 돌려주지 않는다.
    retired: AtomicBool,
    setup: std::sync::Mutex<VuSetup>,
}

/// 준비 스텝이 있는 open-loop run이 공유하는 상태.
struct OpenSetup {
    stats: SharedSectionStats,
    /// 빠진 슬롯 수. `max_in_flight`에 닿으면 run이 `AllVusFailed`로 끝난다.
    retired: AtomicUsize,
    /// 준비를 마친 슬롯 수. 본 스텝이 없는 run은 `ready + retired`가 `max_in_flight`에
    /// 닿으면 스케줄러가 끝난다(spec D16).
    ready: AtomicUsize,
    cause: OnceLock<String>,
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
    // 스케줄 t=0(`started_at`, 고정 간격 첫 도착·`ArrivalSchedule` 시각의 기준)의 epoch ms.
    // 계단 경계의 기준이라 모든 open-loop flush에 싣는다(계단 시험 a).
    let started_at_ms = epoch_millis();
    let deadline = started_at + plan.duration;
    let counters = Arc::new(std::sync::Mutex::new(OpenLoopCounters::new(
        started_at_ms.div_euclid(1000),
    )));
    let env = Arc::new(plan.env);
    let datasets = plan.data_bindings.clone();
    let http_timeout = plan.http_timeout;
    let connect_timeout = plan.connect_timeout;
    let think_seed = plan.think_seed;
    let vu_offset = plan.vu_offset;
    let measure_phases = plan.measure_phases;
    let mut dropped: u64 = 0;
    let mut arrival_counter: u64 = 0;
    let exhausted = Arc::new(AtomicBool::new(false));
    let seq_counters = make_seq_counters(&datasets);
    // refresh: request 판정 — run당 1회, VU 공유(spec §4.3). None이면 요청 경로는 지금과 같다.
    let reqgen = RequestGenPlan::build(&scenario);

    // Slot pool: max_in_flight reusable clients, index = vu_id (offset applied at use).
    let pool: Vec<Arc<VuClient>> = (0..max_in_flight)
        .map(|_| {
            Ok(Arc::new(VuClient::with_timeout(
                scenario.cookie_jar,
                http_timeout,
                measure_phases,
                connect_timeout,
            )?))
        })
        .collect::<Result<_>>()?;
    // Free-slot queue: pre-loaded with every index. `try_recv` = acquire (Empty → drop),
    // send back on completion. The channel itself is the permit + the slot identity.
    let (slot_tx, mut slot_rx) = mpsc::channel::<usize>(max_in_flight);
    for i in 0..max_in_flight {
        slot_tx.try_send(i).expect("capacity == max_in_flight");
    }

    let slots: Vec<Arc<SlotState>> = (0..max_in_flight)
        .map(|_| {
            Arc::new(SlotState {
                ready: AtomicBool::new(false),
                retired: AtomicBool::new(false),
                setup: std::sync::Mutex::new(VuSetup::default()),
            })
        })
        .collect();
    // 준비 통계·빠진 슬롯 계수 — 준비 스텝이 있는 run만 만든다.
    let open_setup: Option<Arc<OpenSetup>> = if scenario.setup_steps().is_empty() {
        None
    } else {
        Some(Arc::new(OpenSetup {
            stats: SharedSectionStats::default(),
            retired: AtomicUsize::new(0),
            ready: AtomicUsize::new(0),
            cause: OnceLock::new(),
        }))
    };
    // 본 스텝이 없는 run은 슬롯마다 준비만 한 번 하고, 도착을 세지 않는다(spec D16).
    let no_main = scenario.steps.is_empty();
    let section_stats: Option<SharedSectionStats> = open_setup.as_ref().map(|o| o.stats.clone());

    let mut set = JoinSet::new();

    // Flusher: drain windows until the run ends. Sends dropped: 0 throughout; the
    // run-total drop count rides on the single final flush below (avoids per-window
    // delta/double-count bookkeeping). The per-second launched/completed/dropped rows
    // ride `open_loop_seconds` (finished seconds only here, the rest on the final flush).
    let flush_agg = agg.clone();
    let flush_counters = counters.clone();
    let flush_out = out.clone();
    let flush_sections = section_stats.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = current_second();
            let (
                drained,
                loop_stats,
                branch_stats,
                group_stats,
                phase_stats,
                error_kind_stats,
                loop_exit_stats,
                open_loop_seconds,
            ) = {
                let mut g = flush_agg.lock().await;
                // 계수 행은 agg 잠금을 얻은 뒤에 꺼낸다 — 잠금을 기다리는 동안 꺼낸 행을
                // 들고 있으면, 그 사이 최종 drain·`flusher.abort()`가 끝나 행이 사라진다.
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                    g.drain_phase_deltas(),
                    g.drain_error_kind_deltas(),
                    g.drain_loop_exit_deltas(),
                    flush_counters
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .drain_completed(now_s),
                )
            };
            let (section_step_stats, section_outcomes) = drain_shared(&flush_sections);
            let has_data = !drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
                || !phase_stats.is_empty()
                || !error_kind_stats.is_empty()
                || !loop_exit_stats.is_empty()
                || !open_loop_seconds.is_empty()
                || !section_step_stats.is_empty()
                || !section_outcomes.is_empty();
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
                        active_vu_samples: vec![],
                        error_kind_stats,
                        loop_exit_stats,
                        open_loop_seconds,
                        open_loop_started_at_ms: Some(started_at_ms),
                        section_step_stats,
                        section_outcomes,
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

    // Fixed-rate interval (S-C): precomputed integer nanos → byte-identical when curve is None.
    let fixed_interval = Duration::from_nanos((1_000_000_000u64 / u64::from(target_rps)).max(1));
    // Curve mode (§B34): the k-th arrival *attempt* fires at the absolute time Λ⁻¹(k + ½),
    // Λ(t) = ∫rate_at(stages). 0-rate stretches are skipped by the inverse itself (no
    // poll-step); once no attempt remains before the deadline, `next` parks at `deadline`.
    // No empty-stages filter: `Some(vec![])` → `time_at` None → deadline, the same
    // observable behavior as before (the worker maps empty proto stages to None anyway).
    let mut schedule = plan.stages.as_deref().map(ArrivalSchedule::new);
    // Attempt index including drops — NOT `arrival_counter` (fired only, = iter_id). A
    // dropped attempt consumes its schedule slot, like the fixed path's `next += fixed_interval`;
    // driving the schedule by fired count would pin `next` in the past and storm drops.
    let mut tick: u64 = 0;
    let duration_secs = plan.duration.as_secs_f64();
    let curve_time = move |schedule: &mut ArrivalSchedule, k: u64| -> Instant {
        match schedule.time_at(k as f64 + 0.5) {
            Some(s) if s < duration_secs => started_at + Duration::from_secs_f64(s),
            _ => deadline,
        }
    };
    let mut next = match schedule.as_mut() {
        None => started_at,
        Some(s) => curve_time(s, 0),
    };
    loop {
        if cancel.is_cancelled() || exhausted.load(Ordering::Relaxed) || Instant::now() >= deadline
        {
            break;
        }
        if open_setup
            .as_ref()
            .is_some_and(|o| o.retired.load(Ordering::Relaxed) >= max_in_flight)
        {
            break;
        }
        // 본 스텝이 없는 run: 모든 슬롯이 준비를 마쳤거나 빠졌으면 끝낸다. 전부 빠진 run의
        // `AllVusFailed`는 어느 break로 나왔든 루프 뒤 `retired` 재검사가 정한다.
        if no_main {
            let Some(o) = &open_setup else {
                break;
            };
            if o.ready.load(Ordering::Acquire) + o.retired.load(Ordering::Relaxed) >= max_in_flight
            {
                break;
            }
        }
        let now = Instant::now();
        if now < next {
            // Clamp the wait to the run deadline (curve mode parks `next` at `deadline`
            // once its arrivals are exhausted, e.g. a curve ending at rate 0).
            let wait = next.min(deadline).saturating_duration_since(now);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancel.cancelled() => break,
            }
            continue;
        }
        match slot_rx.try_recv() {
            // 본 스텝이 없는 run에서 준비를 마친 슬롯을 받은 도착: 할 일이 없다 — 슬롯만 돌려준다.
            // 방금 꺼낸 슬롯이라 큐에 자리가 있다.
            Ok(slot) if no_main && slots[slot].ready.load(Ordering::Acquire) => {
                let _ = slot_tx.try_send(slot);
                // 일정보다 늦은 도착이 몰려도 준비 중인 태스크가 돌 수 있게 양보한다(아래 `Err` 갈래와 같다).
                tokio::task::yield_now().await;
            }
            Ok(slot) => {
                // 준비가 안 된 슬롯의 도착은 준비에 성공한 뒤 태스크가 센다.
                if open_setup.is_none() || slots[slot].ready.load(Ordering::Acquire) {
                    counters
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .record(CountKind::Launched);
                }
                let vu_id = vu_offset.saturating_add(slot as u32);
                let iter_id = arrival_counter as u32;
                arrival_counter += 1;
                let client = pool[slot].clone();
                let scenario = scenario.clone();
                let agg = agg.clone();
                let env = env.clone();
                let cancel_vu = cancel.clone();
                let datasets = datasets.clone();
                let seq_counters = seq_counters.clone();
                let reqgen = reqgen.clone();
                let exhausted = exhausted.clone();
                let counters = counters.clone();
                let slot_tx = slot_tx.clone();
                let slot_state = slots[slot].clone();
                let open_setup = open_setup.clone();
                set.spawn(async move {
                    // Return the slot on ALL exit paths (including panics) via Drop —
                    // except a slot retired by a failed setup, which leaves the pool.
                    // A permanently-leaked slot would shrink the pool, causing runaway drops.
                    struct SlotGuard {
                        slot: usize,
                        tx: mpsc::Sender<usize>,
                        state: Arc<SlotState>,
                    }
                    impl Drop for SlotGuard {
                        fn drop(&mut self) {
                            if self.state.retired.load(Ordering::Acquire) {
                                return;
                            }
                            let _ = self.tx.try_send(self.slot); // capacity guaranteed
                        }
                    }
                    let _slot_guard = SlotGuard {
                        slot,
                        tx: slot_tx,
                        state: slot_state.clone(),
                    };
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
                        datasets,
                        seq_counters,
                        &mut rng,
                        &exhausted,
                        measure_phases,
                        reqgen.as_ref(),
                        &counters,
                        open_setup.as_deref(),
                        &slot_state,
                        slot,
                    )
                    .await
                    {
                        Ok(()) | Err(EngineError::Aborted) => {}
                        Err(e) => warn!(vu_id, error = ?e, "arrival failed"),
                    }
                });
            }
            Err(_) => {
                // 본 스텝이 없는 run은 보낼 요청이 없으므로 「보내지 않음」으로 세지 않는다.
                if !no_main {
                    dropped += 1;
                    counters
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .record(CountKind::Dropped);
                }
                // Pool full while behind schedule: yield so in-flight arrivals (which
                // free slots) get scheduled instead of tight-spinning the catch-up backlog.
                tokio::task::yield_now().await;
            }
        }
        match schedule.as_mut() {
            None => next += fixed_interval,
            Some(s) => {
                tick += 1;
                next = curve_time(s, tick);
            }
        }
    }
    // 스케줄러가 끝난 초: 이 뒤의 빈 초는 0행으로 채우지 않는다(완료 계수만 남는다).
    counters
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .end_scheduler(current_second());

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
    let (
        final_windows,
        final_loops,
        final_branches,
        final_groups,
        final_phases,
        final_error_kinds,
        final_loop_exits,
    ) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
            g.drain_phase_deltas(),
            g.drain_error_kind_deltas(),
            g.drain_loop_exit_deltas(),
        )
    };
    let final_open_loop_seconds = counters
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain_all();
    let (section_step_stats, section_outcomes) = drain_shared(&section_stats);
    // open-loop final flush is UNGUARDED (always sent — carries run-total `dropped`
    // unconditionally, pre-existing behavior). No `|| !error_kind_stats.is_empty()`
    // guard term here by design (spec 2026-08-01 §3.3 — the 5 send-guards exclude this site);
    // likewise no `loop_exit_stats` guard term (loop-while-report).
    let _ = out
        .send(MetricFlush {
            windows: final_windows,
            loop_stats: final_loops,
            branch_stats: final_branches,
            group_stats: final_groups,
            dropped: total_dropped,
            phase_stats: final_phases,
            active_vu_samples: vec![],
            error_kind_stats: final_error_kinds,
            loop_exit_stats: final_loop_exits,
            open_loop_seconds: final_open_loop_seconds,
            open_loop_started_at_ms: Some(started_at_ms),
            section_step_stats,
            section_outcomes,
        })
        .await;
    drop(out);
    flusher.abort();
    let _ = flusher.await;

    if cancel.is_cancelled() {
        return Err(EngineError::Aborted);
    }
    if let Some(o) = &open_setup {
        if o.retired.load(Ordering::Relaxed) >= max_in_flight {
            warn!(
                failed = max_in_flight,
                total = max_in_flight,
                "all open-loop slots failed setup"
            );
            return Err(EngineError::AllVusFailed {
                failed: max_in_flight as u32,
                total: max_in_flight as u32,
                cause: o.cause.get().cloned(),
            });
        }
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
    datasets: Vec<Arc<DataSet>>,
    seq_counters: Vec<Option<Arc<AtomicU64>>>,
    rng: &mut StdRng,
    exhausted: &AtomicBool,
    measure_phases: bool,
    reqgen: Option<&Arc<RequestGenPlan>>,
    counters: &std::sync::Mutex<OpenLoopCounters>,
    open_setup: Option<&OpenSetup>,
    slot_state: &SlotState,
    slot: usize,
) -> Result<()> {
    // 생성기 전용 rng — think_rng(호출자가 넘긴 `rng` 파라미터)와 분리 (spec §4).
    // arrival=1 반복이므로 per-arrival 생성이 곧 per-iteration 재평가.
    let mut gen_rng = StdRng::from_entropy();
    let mut iter_vars: BTreeMap<String, String> =
        crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
    let mut blanked = BlankTable::new();
    let mut req = reqgen.map(|p| ReqGen::new(p.clone(), &mut gen_rng));
    if open_setup.is_some() {
        slot_state
            .setup
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .overlay(&mut iter_vars, &mut req);
    }
    // 준비가 있고 이 슬롯이 아직 준비 전이면 이 도착이 준비를 한다.
    let setup_open = open_setup.filter(|_| !slot_state.ready.load(Ordering::Acquire));
    // 본 스텝이 없는 run의 도착은 준비만 하고 시작·완료 어디에도 세지 않는다(spec D16).
    let no_main = scenario.steps.is_empty();
    let seed_vars = setup_open.map(|_| iter_vars.clone());
    let mut injected_rows: Vec<&BTreeMap<String, String>> = Vec::new();
    // Inject every binding in declared order (single arrival, no per-VU loop).
    // First exhausted Unique slice → signal the scheduler to stop new arrivals
    // and drop this arrival (partial inject discarded). Side effect (spec §7): an
    // earlier IterSequential counter advances one extra step on this arrival (≤1).
    for (ds, counter) in datasets.iter().zip(seq_counters.iter()) {
        match ds.select_index(vu_id, iter_id, counter.as_deref()) {
            Some(idx) => {
                if setup_open.is_some() {
                    injected_rows.push(&ds.rows[idx]);
                }
                for (k, v) in &ds.rows[idx] {
                    iter_vars.insert(k.clone(), v.clone());
                }
                if let Some(rg) = req.as_mut() {
                    rg.mark_written(ds.rows[idx].keys());
                }
            }
            // unique slice exhausted → signal the scheduler to stop new arrivals.
            None => {
                exhausted.store(true, Ordering::Relaxed);
                if setup_open.is_some() && !no_main {
                    // 스케줄러가 세지 않은 도착 — 지금처럼 「시작」으로 센다.
                    counters
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .record(CountKind::Launched);
                }
                return Ok(());
            }
        }
    }
    if let (Some(o), Some(mut rebuilt)) = (setup_open, seed_vars) {
        let stats = &o.stats;
        let mut setup_vars = iter_vars.clone();
        let run = run_section(
            Section::Setup,
            scenario.setup_steps(),
            client,
            &mut setup_vars,
            env,
            vu_id,
            iter_id,
            deadline,
            cancel,
            rng,
            scenario.default_think_time,
            &mut req,
            stats,
        )
        .await;
        let failure = match run {
            Ok(SectionRun::Done(extracted)) => {
                let mut state = slot_state.setup.lock().unwrap_or_else(|e| e.into_inner());
                *state = VuSetup {
                    done: true,
                    vars: extracted,
                };
                state.overlay(&mut rebuilt, &mut req);
                drop(state);
                for row in injected_rows {
                    for (k, v) in row {
                        rebuilt.insert(k.clone(), v.clone());
                    }
                }
                iter_vars = rebuilt;
                slot_state.ready.store(true, Ordering::Release);
                o.ready.fetch_add(1, Ordering::Release);
                if !no_main {
                    counters
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .record(CountKind::Launched);
                }
                None
            }
            Ok(SectionRun::Failed(e)) | Err(e) => Some(e),
            Ok(SectionRun::Deadline) => return Ok(()),
            Ok(SectionRun::Aborted) => {
                stats
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .record_interrupted(Section::Setup);
                return Err(EngineError::Aborted);
            }
        };
        if let Some(e) = failure {
            // 이 도착은 시작·완료·보내지 않음 어디에도 세지 않는다. 슬롯은 run에서 빠진다.
            slot_state.retired.store(true, Ordering::Release);
            if let Some(msg) = safe_cause(&e) {
                let _ = o.cause.set(msg);
            }
            o.retired.fetch_add(1, Ordering::Relaxed);
            match &e {
                EngineError::SetupFailed { step_id, kind, .. } => {
                    warn!(slot, step_id = %step_id, kind = %kind, "setup failed; slot retired");
                }
                _ => warn!(slot, kind = "engine_error", "setup failed; slot retired"),
            }
            return Ok(());
        }
    }
    if no_main {
        return Ok(());
    }
    // No run-level think time in open-loop (arrival rate governs inter-iteration pacing).
    let r = execute_steps(
        client,
        &scenario.steps,
        &mut iter_vars,
        &mut blanked,
        agg,
        deadline,
        env,
        vu_id,
        iter_id,
        None,
        cancel,
        rng,
        measure_phases,
        scenario.default_think_time,
        &mut req,
        None,
    )
    .await;
    // 결과와 무관하게 끝난 반복으로 센다 — 엔진 오류·취소도 `?`보다 먼저 기록한다(spec §4.2).
    counters
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .record(CountKind::Completed);
    r?;
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

fn epoch_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
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

    fn st(target: u32, duration_seconds: u32) -> Stage {
        Stage {
            target,
            duration_seconds,
        }
    }

    /// 독립 기준 Λ(Σdur): 구현의 `cum0`을 재사용하지 않고 stage별 사다리꼴을 따로 합한다
    /// (같은 오류를 같이 품지 않도록 — spec §6.1 b).
    fn lambda_ref(stages: &[Stage]) -> f64 {
        let mut prev = 0.0_f64;
        let mut sum = 0.0_f64;
        for s in stages {
            let t = f64::from(s.target);
            sum += (prev + t) / 2.0 * f64::from(s.duration_seconds);
            prev = t;
        }
        sum
    }

    /// [0, T=Σdur)에 드는 도착 시도 수 — 스케줄러 곡선 분기와 같은 질의(k+½).
    fn arrivals_before_end(stages: &[Stage]) -> u64 {
        let end: f64 = stages.iter().map(|s| f64::from(s.duration_seconds)).sum();
        let mut sched = ArrivalSchedule::new(stages);
        let mut k = 0u64;
        while let Some(t) = sched.time_at(k as f64 + 0.5) {
            if t >= end {
                break;
            }
            k += 1;
        }
        k
    }

    #[test]
    fn arrival_schedule_matches_closed_form_on_single_ramp() {
        // [{5,10}]: rate(t)=t/2 → Λ(t)=t²/4 → Λ⁻¹(m)=√(4m). (§6.1 a)
        let mut s = ArrivalSchedule::new(&[st(5, 10)]);
        for k in 0..25u64 {
            let m = k as f64 + 0.5;
            let got = s.time_at(m).expect("within the curve");
            assert!((got - (4.0 * m).sqrt()).abs() < 1e-9, "k={k} got={got}");
        }
    }

    #[test]
    fn arrival_schedule_count_rounds_cumulative_area() {
        // (§6.1 b) 곡선마다 [0, Σdur)의 도착 수가 독립 Λ(Σdur)의 ±½ 안.
        // 바깥은 배열(by-ref 순회만 하므로 vec!이면 clippy::useless_vec — -D warnings).
        let curves: [Vec<Stage>; 10] = [
            vec![st(5, 10)],                                 // §B34 재현 1 (Λ=25)
            vec![st(10, 6)],                                 // §B34 재현 2 / 2워커 몫 (Λ=30)
            vec![st(20, 6)],                                 // §B34 재현 3 (Λ=60)
            vec![st(20, 1), st(20, 7)],                      // §B34 대조 (Λ=150)
            vec![st(100, 1), st(100, 1)],                    // ramp + hold
            vec![st(0, 1), st(10, 2)],                       // 선행 0 hold
            vec![st(10, 1), st(10, 1), st(0, 1)],            // 0으로 끝나는 ramp-down
            vec![st(30, 2), st(10, 3), st(50, 1), st(0, 2)], // 상승/하강 다구간
            vec![st(7, 3)],                                  // 비정수 Λ=10.5 (Review Focus 4)
            vec![st(1000, 2), st(1000, 6)],                  // US2 고레이트 곡선 (Λ=7000)
        ];
        for c in &curves {
            let want = lambda_ref(c);
            let got = arrivals_before_end(c) as f64;
            assert!((got - want).abs() <= 0.5, "curve={c:?} got={got} Λ={want}");
        }
    }

    #[test]
    fn arrival_schedule_cursor_is_monotone_and_matches_fresh() {
        // (§6.1 c ①②) 연속 결과 비감소 + 재사용 인스턴스 == 매번 fresh 인스턴스(낡은 커서 검출).
        // 면적 190, 꼬리 rate 20 → k≥190은 곡선 끝 이후 연장 구간까지 지난다.
        let c = [st(30, 2), st(10, 3), st(50, 1), st(0, 2), st(20, 2)];
        let mut reused = ArrivalSchedule::new(&c);
        let mut prev = 0.0_f64;
        for k in 0..200u64 {
            let m = k as f64 + 0.5;
            let r = reused.time_at(m);
            let fresh = ArrivalSchedule::new(&c).time_at(m);
            assert_eq!(r, fresh, "k={k}");
            let t = r.expect("tail rate 20 keeps arrivals reachable");
            assert!(t >= prev, "k={k}: {t} < {prev}");
            prev = t;
        }
    }

    #[test]
    fn arrival_schedule_scan_count_is_amortized_constant() {
        // (§6.1 c ③, G2) 1000-stage 곡선(10↔20 rps 교대, 각 1s, 면적 14990)을 끝 근처까지 질의.
        // 총 구간 검사 수 ≤ 호출 수 + stage 수. 커서를 매 호출 처음부터 훑으면 ~7.5M으로 RED.
        let c: Vec<Stage> = (0..1000)
            .map(|i| st(if i % 2 == 0 { 10 } else { 20 }, 1))
            .collect();
        let n = (lambda_ref(&c) - 1.0).floor() as u64;
        let mut s = ArrivalSchedule::new(&c);
        for k in 0..n {
            assert!(s.time_at(k as f64 + 0.5).is_some(), "k={k}");
        }
        let bound = n + s.segs.len() as u64;
        assert!(
            s.scans <= bound,
            "scans={} > N+segs={bound}: cursor rescans from the start (G2 regression)",
            s.scans
        );
    }

    #[test]
    fn arrival_schedule_skips_zero_rate_hold() {
        // (§6.1 d) 선행 0 hold는 Λ가 평평 → 첫 도착은 hold 뒤.
        let mut s = ArrivalSchedule::new(&[st(0, 2), st(10, 2)]);
        let t = s.time_at(0.5).expect("second stage has area");
        assert!(
            t >= 2.0,
            "first arrival must land after the 0-rate hold, got {t}"
        );
    }

    #[test]
    fn arrival_schedule_exhausts_when_curve_ends_at_zero() {
        // (§6.1 e) 면적 20, 꼬리 rate 0 → 20번째 이후 도달 불가.
        let mut s = ArrivalSchedule::new(&[st(10, 2), st(0, 2)]);
        let t = s.time_at(19.5).expect("inside the ramp-down");
        assert!(t < 4.0, "{t}");
        assert_eq!(s.time_at(20.5), None);
    }

    #[test]
    fn arrival_schedule_extends_past_end_at_last_target() {
        // (§6.1 f) 면적 5, 끝 이후는 rate_at처럼 마지막 target(10) 유지 → 1 + 0.5/10.
        let mut s = ArrivalSchedule::new(&[st(10, 1)]);
        let t = s.time_at(5.5).expect("tail rate 10");
        assert!((t - 1.05).abs() < 1e-12, "{t}");
    }

    #[test]
    fn arrival_schedule_empty_or_all_zero_curve_has_no_arrivals() {
        // (§6.1 g) 빈 stages + (Review Focus 1) fan-out 정수 분할로 몫이 0이 된 곡선.
        assert_eq!(ArrivalSchedule::new(&[]).time_at(0.5), None);
        assert_eq!(
            ArrivalSchedule::new(&[st(0, 5), st(0, 3)]).time_at(0.5),
            None
        );
    }

    #[test]
    fn arrival_schedule_zero_duration_stage_is_a_rate_jump() {
        // (Review Focus 2) 0-dur stage = rate_at의 span 0처럼 점프, area 0, inf/NaN 없음.
        // 점프 후 10 rps × 2s → Λ=20, 첫 도착 0.5/10.
        let c = [st(10, 0), st(10, 2)];
        let mut s = ArrivalSchedule::new(&c);
        assert!(
            s.segs
                .iter()
                .all(|g| g.slope.is_finite() && g.area.is_finite())
        );
        let t = s.time_at(0.5).expect("second stage has area");
        assert!((t - 0.05).abs() < 1e-12, "{t}");
        assert_eq!(arrivals_before_end(&c), 20);
    }

    #[test]
    fn arrival_schedule_matches_closed_form_on_falling_segment() {
        // 10→0 over 2s (after a 0-dur jump to 10): Λ(t) = 10t − 2.5t² → Λ⁻¹(m) = 2m/(10+√(100−10m)).
        // Locks in-segment placement on a negative slope (count tests can't see it).
        let mut s = ArrivalSchedule::new(&[st(10, 0), st(0, 2)]);
        for k in 0..10u64 {
            let m = k as f64 + 0.5;
            let want = 2.0 * m / (10.0 + (100.0 - 10.0 * m).sqrt());
            let got = s.time_at(m).expect("within the ramp-down");
            assert!((got - want).abs() < 1e-9, "k={k} got={got} want={want}");
        }
    }

    #[test]
    fn arrival_schedule_is_precise_at_soak_scale() {
        // (Review Focus 3) target 상한 1M × 24h ramp: Λ(t)=(1e6/86400)/2·t², 총면적 4.32e10.
        let mut s = ArrivalSchedule::new(&[st(1_000_000, 86_400)]);
        // `_f64` 접미 필수 — 없으면 `m`이 {float}로 남아 `.sqrt()`가 E0689(plan 리뷰 R1 실측).
        for m in [0.5_f64, 1e6 + 0.5, 4.32e10 - 0.5] {
            let want = (2.0 * m * 86_400.0 / 1e6).sqrt();
            let got = s.time_at(m).expect("within the curve");
            assert!(
                got.is_finite() && (got - want).abs() <= want * 1e-9,
                "m={m} got={got} want={want}"
            );
        }
    }
}

#[cfg(test)]
mod graceful_cap_tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tokio_util::sync::CancellationToken;

    fn active_slab(
        n: usize,
    ) -> (
        std::sync::Mutex<Vec<Option<CancellationToken>>>,
        Vec<CancellationToken>,
    ) {
        let toks: Vec<CancellationToken> = (0..n).map(|_| CancellationToken::new()).collect();
        let slab = std::sync::Mutex::new(toks.iter().cloned().map(Some).collect());
        (slab, toks)
    }

    #[test]
    fn sets_timer_then_cancels_after_cap() {
        // desired=1, spawned=3: index 0 = desired-active, index 1·2 = over-desired active(=lingering).
        let (slab, toks) = active_slab(3);
        let mut since = vec![None; 3];
        let cap = Duration::from_secs(2);
        let base = Instant::now();
        // 1st: 타이머만 세팅, 취소 0.
        retire_expired(&slab, &mut since, 1, 3, cap, base);
        assert!(since[0].is_none(), "index<desired resets");
        assert!(since[1].is_some() && since[2].is_some());
        assert!(!toks[1].is_cancelled() && !toks[2].is_cancelled());
        // 2nd: cap 이내 → 취소 없음.
        retire_expired(&slab, &mut since, 1, 3, cap, base + Duration::from_secs(1));
        assert!(!toks[1].is_cancelled());
        // 3rd: cap 도달 → index 1·2 취소.
        retire_expired(&slab, &mut since, 1, 3, cap, base + Duration::from_secs(2));
        assert!(toks[1].is_cancelled() && toks[2].is_cancelled());
    }

    #[test]
    fn re_desire_resets_timer_no_cancel() {
        // index 1이 은퇴 타이머를 갖다가 desired가 다시 오르면(2) 리셋 → cap 지나도 취소 안 함.
        let (slab, toks) = active_slab(2);
        let mut since = vec![None; 2];
        let cap = Duration::from_secs(1);
        let base = Instant::now();
        retire_expired(&slab, &mut since, 1, 2, cap, base); // index1 retiring
        assert!(since[1].is_some());
        retire_expired(&slab, &mut since, 2, 2, cap, base + Duration::from_secs(2)); // desired 2 → index1 desired-active
        assert!(since[1].is_none(), "re-desired index resets");
        assert!(!toks[1].is_cancelled());
    }

    #[test]
    fn parked_slot_not_cancelled() {
        // index 1이 over-desired지만 slab None(자발 park) → 타이머·취소 없음.
        let (slab, toks) = active_slab(2);
        slab.lock().unwrap()[1] = None;
        let mut since = vec![None; 2];
        let cap = Duration::from_secs(1);
        let base = Instant::now();
        retire_expired(&slab, &mut since, 1, 2, cap, base);
        retire_expired(&slab, &mut since, 1, 2, cap, base + Duration::from_secs(5));
        assert!(since[1].is_none());
        assert!(!toks[1].is_cancelled());
    }
}
