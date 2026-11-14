//! Single-pass scenario trace for the editor "test-run" (spec
//! `2026-06-01-scenario-editor-test-run-design.md`). NOT a load run: 1 VU, one
//! pass over `steps`, capturing per-request detail instead of aggregated metrics.
//! The interpreter (`trace_scenario`) mirrors `runner::execute_steps`' control
//! flow without the load machinery (no Aggregator/deadline-windows/cancel).

use std::collections::BTreeMap;
use std::time::Duration;

use rand::SeedableRng;
use serde::{Deserialize, Serialize};

use crate::condition::BranchEval;

/// Knobs supplied by the controller per test-run.
#[derive(Debug, Clone)]
pub struct TraceOptions {
    /// `${ENV}` values (already merged from the environment overlay client-side).
    pub env: BTreeMap<String, String>,
    /// Max HTTP leaf calls before the trace stops with `truncated = true`.
    pub max_requests: u32,
    /// Wall-clock ceiling; on reaching it the trace stops with `truncated = true`.
    pub max_wall: Duration,
    /// When true, the trace HONORS per-step `think_time` (actually sleeps) — for
    /// throttled previews (e.g. firewall). Default false = instant preview. Only
    /// per-step think time applies (single pass has no inter-iteration gap).
    pub apply_think_time: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    Http,
    /// An `if` decision row (carries `branch`; no request/response). Plain loops
    /// (no `while`) get no row of their own — their children carry `loop_index`;
    /// conditional loops emit `Loop` judge rows (below).
    If,
    /// 조건 반복(`while`) 한 회차 뒤의 판정 행(`branch` = "again"/"done"/"exhausted",
    /// `branch_eval[0]` = 조건 판정). `while` 없는 loop은 행을 만들지 않는다.
    Loop,
}

/// 조건 반복 판정 행의 전 행 공유 상한 (`max_requests`처럼 데이터 행 사이에 초기화하지 않는다).
pub const MAX_LOOP_JUDGE_ROWS: u32 = 200;

/// `if` 판정 줄의 전 행 공유 상한 — 요청 상한에 비례한다(`max(1000, max_requests × 10)`,
/// 곱은 포화). 배수 10·바닥 1000의 근거는 spec §2.1.
pub fn if_judge_row_cap(max_requests: u32) -> u32 {
    max_requests.saturating_mul(10).max(1000)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TracedRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TracedResponse {
    pub status: u16,
    pub latency_ms: u64,
    pub download_ms: Option<u64>,
    pub headers: BTreeMap<String, String>,
    pub set_cookies: Vec<String>,
    pub body: String,
    pub body_truncated: bool,
}

/// HTTP-leaf-specific trace fields, produced by `executor::execute_step_traced`.
/// The interpreter wraps these into a `StepTrace` (adding `loop_index`).
#[derive(Debug, Clone)]
pub struct HttpTrace {
    pub request: TracedRequest,
    pub response: Option<TracedResponse>,
    pub extracted: BTreeMap<String, String>,
    pub unbound_vars: Vec<String>,
    pub error: Option<String>,
    /// send/body-read 에러가 요청 시간 초과(`reqwest::Error::is_timeout`)였는가.
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StepTrace {
    pub step_id: String,
    pub kind: StepKind,
    /// 0-based index when this row ran inside a loop body, else `None`.
    pub loop_index: Option<u32>,
    /// For `if` rows only: the selected branch ("then"/"elif_{j}"/"else"/"none").
    pub branch: Option<String>,
    pub request: Option<TracedRequest>,
    pub response: Option<TracedResponse>,
    #[serde(default)]
    pub extracted: BTreeMap<String, String>,
    #[serde(default)]
    pub unbound_vars: Vec<String>,
    pub error: Option<String>,
    /// `if` 결정 행 전용: 평가한 분기 조건별 판정 근거(없으면 직렬화 생략).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branch_eval: Vec<BranchEval>,
    /// http 행 전용: 요청 시간 초과로 실패했는가(false면 직렬화 생략).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScenarioTrace {
    /// True when no HTTP leaf reported an error.
    pub ok: bool,
    pub total_ms: u64,
    pub steps: Vec<StepTrace>,
    /// Flow vars at end of the pass (scenario.variables + all extracts).
    pub final_vars: BTreeMap<String, String>,
    /// True when `max_requests` or the wall-clock ceiling cut the pass short.
    pub truncated: bool,
    /// Setup-level failure (e.g. HTTP client build) — distinct from per-step errors.
    pub error: Option<String>,
    /// 조건 반복이 최대 횟수에 닿아 이번 반복을 끝냈다면 그 loop 스텝 id (없으면 직렬화 생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_by_loop: Option<String>,
}

use std::sync::Arc;
use std::time::Instant;

use crate::executor::{ExtractMode, VuClient, execute_step_traced_with};
use crate::extract::blank_missing_extracts;
use crate::pacing::ThinkTime;
use crate::reqgen::{ReqGen, RequestGenPlan};
use crate::runner::select_branch;
use crate::scenario::{CompareOp, Condition, IfStep, Scenario, Step};
use crate::template::{TemplateContext, render_collecting};

struct TraceState {
    steps: Vec<StepTrace>,
    requests: u32,
    truncated: bool,
    /// 이 패스의 `${iter_id}` 값 — 단발/시드 = 0, sequential = 반복 순번 (R4).
    iter_id: u32,
    /// 지금까지 push한 조건 반복 판정 행 수 — 전 행 공유 예산(`MAX_LOOP_JUDGE_ROWS`).
    judge_rows: u32,
    /// 지금까지 넣은 if 판정 줄 수 — 전 행 공유 예산(`if_judge_row_cap`).
    if_rows: u32,
    /// 조건 반복이 최대 횟수로 끝났다면 그 loop id. 이 값이 있으면 바깥 재귀가 모두 빠져나온다.
    ended_by_loop: Option<String>,
}

/// Run `scenario` once (1 VU, single pass) and capture a per-request trace.
/// Never returns `Err` — setup failures land in `ScenarioTrace.error`, per-step
/// failures in each `StepTrace.error`.
pub async fn trace_scenario(scenario: &Scenario, opts: &TraceOptions) -> ScenarioTrace {
    trace_scenario_with_seed(scenario, opts, &BTreeMap::new()).await
}

/// sequential test-run의 행 하나 결과 (R8 — 컨트롤러가 그대로 직렬화).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RowTrace {
    /// 첫 바인딩 행 번호(= start_row + i, wrap 없음 — R17 앵커). 호출자가 부여.
    pub row_index: u64,
    pub trace: ScenarioTrace,
}

/// sequential test-run 응답의 엔진측 절반 (spec R8, ADR-0047).
/// `truncated`/`ok`는 seeded_rows 기준 — R18 clamp 반영(요청 구간 축소 시
/// all-green이어도 truncated)은 컨트롤러가 OR로 조정한다(정의는 spec R6 소유).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RowsTrace {
    /// `!truncated && rows[].trace.ok 전부`.
    pub ok: bool,
    /// 시드 행을 전부 못 돌았거나(미실행 행 존재) 마지막 실행 행이 mid-cut.
    pub truncated: bool,
    pub total_ms: u64,
    pub rows: Vec<RowTrace>,
}

/// `trace_scenario` + 데이터셋 시드 1행 주입 (test-run single_row, ADR-0047).
/// 시드는 scenario.variables 위에 덮인다(충돌 시 데이터셋 우선 — run_vu의
/// "variables.clone() 후 바인딩 insert" 순서 미러, runner.rs `run_vu` — R4).
/// 응답 형태는 기존 `ScenarioTrace` 그대로(R7) — setup 실패는 `error` 필드.
pub async fn trace_scenario_with_seed(
    scenario: &Scenario,
    opts: &TraceOptions,
    seed_vars: &BTreeMap<String, String>,
) -> ScenarioTrace {
    let started = Instant::now();
    let reqgen = RequestGenPlan::build(scenario);
    let deadline = started + opts.max_wall;
    let client = match VuClient::new(scenario.cookie_jar) {
        Ok(c) => c,
        Err(e) => {
            return ScenarioTrace {
                ok: false,
                total_ms: 0,
                steps: vec![],
                final_vars: BTreeMap::new(),
                truncated: false,
                error: Some(format!("http client build: {e}")),
                ended_by_loop: None,
            };
        }
    };
    let mut state = TraceState {
        steps: Vec::new(),
        requests: 0,
        truncated: false,
        iter_id: 0,
        judge_rows: 0,
        if_rows: 0,
        ended_by_loop: None,
    };
    trace_once(
        &client,
        scenario,
        opts,
        seed_vars,
        0,
        deadline,
        &mut state,
        reqgen.as_ref(),
    )
    .await
}

/// 시나리오를 시드 행마다 1회씩 순차 실행 (1 VU iter_sequential 미러 — ADR-0047).
/// 클라이언트(cookie jar)는 1회 빌드해 행 간 공유(R5), `max_requests`·wall-clock
/// deadline·if 판정 줄 수·조건 반복 판정 줄 수는 전 행 공유 단일 예산(R6). 실패 행에서도
/// 계속(R10). 예산이 행 시작 전에 소진되면 그 행부터 `rows`에 없다(R6). Never returns `Err` — 극히 드문
/// 클라이언트 빌드 실패는 `ok=false`·빈 `rows`로 축약(R8 와이어에 error 채널 없음).
pub async fn trace_scenario_rows(
    scenario: &Scenario,
    opts: &TraceOptions,
    seeded_rows: &[(u64, BTreeMap<String, String>)],
) -> RowsTrace {
    let started = Instant::now();
    let reqgen = RequestGenPlan::build(scenario);
    let deadline = started + opts.max_wall;
    let client = match VuClient::new(scenario.cookie_jar) {
        Ok(c) => c,
        Err(_) => {
            return RowsTrace {
                ok: false,
                truncated: false,
                total_ms: 0,
                rows: vec![],
            };
        }
    };
    let mut state = TraceState {
        steps: Vec::new(),
        requests: 0,
        truncated: false,
        iter_id: 0,
        judge_rows: 0,
        if_rows: 0,
        ended_by_loop: None,
    };
    let mut rows: Vec<RowTrace> = Vec::with_capacity(seeded_rows.len());
    let mut truncated = false;
    for (i, (row_index, seed)) in seeded_rows.iter().enumerate() {
        // 행 시작 전 예산 소진(요청 수·시간·if 판정 줄 수·조건 반복 판정 줄 수) → 이 행부터
        // 미실행 (rows에 없음 — R6).
        if state.requests >= opts.max_requests
            || Instant::now() >= deadline
            || state.if_rows >= if_judge_row_cap(opts.max_requests)
            || state.judge_rows >= MAX_LOOP_JUDGE_ROWS
        {
            truncated = true;
            break;
        }
        let trace = trace_once(
            &client,
            scenario,
            opts,
            seed,
            i as u32,
            deadline,
            &mut state,
            reqgen.as_ref(),
        )
        .await;
        let mid_cut = trace.truncated;
        rows.push(RowTrace {
            row_index: *row_index,
            trace,
        });
        if mid_cut {
            // 마지막 실행 행 mid-cut (R6) — 이후 행도 미실행.
            truncated = true;
            break;
        }
    }
    let ok = !truncated && rows.iter().all(|r| r.trace.ok);
    RowsTrace {
        ok,
        truncated,
        total_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        rows,
    }
}

/// 클라이언트 하나로 시나리오를 1패스 실행하는 내부 코어. `state.requests`
/// (공유 요청 예산)는 호출 간 이월되고 `steps`/`truncated`/`iter_id`는 진입 시
/// 리셋된다 — `trace_scenario_rows`(Task 2)가 행 루프에서 재사용 (R6).
#[allow(clippy::too_many_arguments)]
async fn trace_once(
    client: &VuClient,
    scenario: &Scenario,
    opts: &TraceOptions,
    seed_vars: &BTreeMap<String, String>,
    iter_id: u32,
    deadline: Instant,
    state: &mut TraceState,
    reqgen: Option<&Arc<RequestGenPlan>>,
) -> ScenarioTrace {
    let started = Instant::now();
    state.steps = Vec::new();
    state.truncated = false;
    state.iter_id = iter_id;
    // 생성기 전용 rng — think_rng와 절대 공유 금지(spec §4). 행/반복마다 재평가.
    let mut gen_rng = rand::rngs::StdRng::from_entropy();
    let mut iter_vars: BTreeMap<String, String> =
        crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
    // 행/반복마다 새 상태 — 행 간 죽은 집합이 새지 않는다.
    let mut req = reqgen.map(|p| ReqGen::new(p.clone(), &mut gen_rng));
    // 기존 데이터셋 overlay 루프 무변경 — 우선순위 생성 < 데이터셋 < extract.
    for (k, v) in seed_vars {
        iter_vars.insert(k.clone(), v.clone());
    }
    if let Some(rg) = req.as_mut() {
        rg.mark_written(seed_vars.keys());
    }
    Box::pin(trace_steps(
        client,
        &scenario.steps,
        &mut iter_vars,
        &opts.env,
        None,
        opts,
        deadline,
        state,
        scenario.default_think_time,
        &mut req,
        false,
        false,
    ))
    .await;
    let ok = state.steps.iter().all(|s| s.error.is_none());
    ScenarioTrace {
        ok,
        total_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        steps: std::mem::take(&mut state.steps),
        final_vars: iter_vars,
        truncated: state.truncated,
        error: None,
        ended_by_loop: state.ended_by_loop.take(),
    }
}

/// Collect the names of unresolved tokens referenced anywhere in an `if` node's
/// conditions — the primary `cond` plus every `elif` cond — so the trace decision
/// row can surface "this branch was decided with an unbound variable". The load
/// path evaluates conditions via `render_lenient` and discards this; the spec
/// (§3-2) scoped `unbound_vars` to request render, so this is a trace-only
/// extension. Renders are throwaway (only the collected names matter) and mirror
/// `condition::eval_compare`'s render sites: `left` always; `right` only for ops
/// other than `exists`/`empty` (those never render `right`).
fn collect_if_condition_unbound(if_step: &IfStep, ctx: &TemplateContext) -> Vec<String> {
    fn walk(cond: &Condition, ctx: &TemplateContext, out: &mut Vec<String>) {
        match cond {
            Condition::All(cs) | Condition::Any(cs) => {
                for c in cs {
                    walk(c, ctx, out);
                }
            }
            Condition::Compare { left, op, right } => {
                let _ = render_collecting(left, ctx, out);
                if !matches!(op, CompareOp::Exists | CompareOp::Empty) {
                    if let Some(r) = right {
                        let _ = render_collecting(r, ctx, out);
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&if_step.cond, ctx, &mut out);
    for e in &if_step.elif {
        walk(&e.cond, ctx, &mut out);
    }
    // Order-preserving dedup (a var may recur across cond/elif); mirrors
    // executor::execute_step_traced's unbound dedup.
    let mut seen = std::collections::HashSet::new();
    out.retain(|name| seen.insert(name.clone()));
    out
}

#[allow(clippy::too_many_arguments)]
async fn trace_steps(
    client: &VuClient,
    steps: &[Step],
    iter_vars: &mut BTreeMap<String, String>,
    env: &BTreeMap<String, String>,
    loop_index: Option<u32>,
    opts: &TraceOptions,
    deadline: Instant,
    state: &mut TraceState,
    // 시나리오 기본 think time. http 스텝이 자기 `think_time`을 안 가지면 이 값을 쓴다.
    // **Parallel arm은 분기 재귀에 `None`을 넘긴다**(spec R4, runner와 동일 규칙).
    default_think: Option<ThinkTime>,
    // 요청 단위 재평가 상태(runner::execute_steps와 동일 규칙). None = refresh 변수 없음.
    req: &mut Option<ReqGen>,
    // 조건 반복(while) 본문 안인지 — runner::execute_steps와 같은 규칙(if·parallel·중첩 loop로 상속).
    in_cond_loop: bool,
    // 조건 반복 본문의 think time을 `apply_think_time`과 무관하게 잘 것인가(keep_think).
    force_think: bool,
) {
    for step in steps {
        if state.truncated || state.ended_by_loop.is_some() {
            return;
        }
        if state.requests >= opts.max_requests || Instant::now() >= deadline {
            state.truncated = true;
            return;
        }
        match step {
            Step::Http(http) => {
                if let Some(rg) = req.as_mut() {
                    rg.refresh(&http.id, iter_vars);
                }
                let ctx = TemplateContext {
                    vars: iter_vars,
                    env,
                    vu_id: 0,
                    iter_id: state.iter_id,
                    loop_index,
                };
                let mode = if in_cond_loop {
                    ExtractMode::Lenient
                } else {
                    ExtractMode::Strict
                };
                let mut t = execute_step_traced_with(client, http, &ctx, mode).await;
                if let Some(rg) = req.as_mut() {
                    rg.mark_written(t.extracted.keys());
                }
                if in_cond_loop {
                    blank_missing_extracts(http, &mut t.extracted, iter_vars);
                }
                iter_vars.extend(t.extracted.clone());
                state.requests += 1;
                state.steps.push(StepTrace {
                    step_id: http.id.clone(),
                    kind: StepKind::Http,
                    loop_index,
                    branch: None,
                    request: Some(t.request),
                    response: t.response,
                    extracted: t.extracted,
                    unbound_vars: t.unbound_vars,
                    error: t.error,
                    branch_eval: Vec::new(),
                    timed_out: t.timed_out,
                });
                if opts.apply_think_time || force_think {
                    if let Some(tt) = http.think_time.or(default_think) {
                        let now = Instant::now();
                        if now < deadline {
                            let dur = tt.sample(&mut rand::thread_rng()).min(deadline - now);
                            tokio::time::sleep(dur).await;
                        }
                        if Instant::now() >= deadline {
                            state.truncated = true;
                        }
                    }
                }
            }
            Step::Loop(lp) => {
                if let Some(cond) = lp.while_.as_ref() {
                    // do-while (runner::execute_steps와 같은 의미): 본문 → 조건. 최대 횟수에 닿으면
                    // 이번 반복을 끝낸다(`ended_by_loop`).
                    let max = lp.max_passes();
                    let body_think = force_think || lp.keeps_think();
                    let mut pass: u32 = 0;
                    loop {
                        // 판정 행 상한은 회차 시작에서 본다 — 반복이 끝난 회차(done/exhausted)는
                        // 상한과 무관하지만, 조건 반복에 자주 들어가는 경우도 총량이 묶인다.
                        if state.truncated
                            || state.requests >= opts.max_requests
                            || state.judge_rows >= MAX_LOOP_JUDGE_ROWS
                            || Instant::now() >= deadline
                        {
                            state.truncated = true;
                            return;
                        }
                        Box::pin(trace_steps(
                            client,
                            &lp.do_,
                            iter_vars,
                            env,
                            Some(pass),
                            opts,
                            deadline,
                            state,
                            default_think,
                            req,
                            true,
                            body_think,
                        ))
                        .await;
                        if state.truncated || state.ended_by_loop.is_some() {
                            return;
                        }
                        pass = pass.saturating_add(1);
                        let (eval, again) = {
                            let ctx = TemplateContext {
                                vars: iter_vars,
                                env,
                                vu_id: 0,
                                iter_id: state.iter_id,
                                loop_index: Some(pass - 1),
                            };
                            let eval = crate::condition::explain_condition(cond, "while", &ctx);
                            let again = eval.passed;
                            (eval, again)
                        };
                        let exhausted = again && max.is_some_and(|n| pass >= n);
                        let verdict = if !again {
                            "done"
                        } else if exhausted {
                            "exhausted"
                        } else {
                            "again"
                        };
                        state.steps.push(StepTrace {
                            step_id: lp.id.clone(),
                            kind: StepKind::Loop,
                            loop_index: Some(pass - 1),
                            branch: Some(verdict.to_string()),
                            request: None,
                            response: None,
                            extracted: BTreeMap::new(),
                            unbound_vars: Vec::new(),
                            error: None,
                            branch_eval: vec![eval],
                            timed_out: false,
                        });
                        state.judge_rows += 1;
                        if !again {
                            break;
                        }
                        if exhausted {
                            state.ended_by_loop = Some(lp.id.clone());
                            return;
                        }
                    }
                } else {
                    for i in 0..lp.plain_repeat() {
                        if state.truncated
                            || state.requests >= opts.max_requests
                            || Instant::now() >= deadline
                        {
                            state.truncated = true;
                            return;
                        }
                        Box::pin(trace_steps(
                            client,
                            &lp.do_,
                            iter_vars,
                            env,
                            Some(i),
                            opts,
                            deadline,
                            state,
                            default_think,
                            req,
                            in_cond_loop,
                            force_think,
                        ))
                        .await;
                        if state.truncated || state.ended_by_loop.is_some() {
                            return;
                        }
                    }
                }
            }
            Step::If(if_step) => {
                if state.if_rows >= if_judge_row_cap(opts.max_requests) {
                    state.truncated = true;
                    return;
                }
                let (taken, branch, cond_unbound, branch_eval): (
                    &[Step],
                    String,
                    Vec<String>,
                    Vec<BranchEval>,
                ) = {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env,
                        vu_id: 0,
                        iter_id: state.iter_id,
                        loop_index,
                    };
                    let unbound = collect_if_condition_unbound(if_step, &ctx);
                    let (taken, branch) = select_branch(if_step, &ctx);
                    (
                        taken,
                        branch,
                        unbound,
                        crate::condition::explain_branches(if_step, &ctx),
                    )
                };
                state.steps.push(StepTrace {
                    step_id: if_step.id.clone(),
                    kind: StepKind::If,
                    loop_index,
                    branch: Some(branch),
                    request: None,
                    response: None,
                    extracted: BTreeMap::new(),
                    unbound_vars: cond_unbound,
                    error: None,
                    branch_eval,
                    timed_out: false,
                });
                state.if_rows += 1;
                Box::pin(trace_steps(
                    client,
                    taken,
                    iter_vars,
                    env,
                    loop_index,
                    opts,
                    deadline,
                    state,
                    default_think,
                    req,
                    in_cond_loop,
                    force_think,
                ))
                .await;
            }
            Step::Parallel(par) => {
                // Trace is a single 1-VU pass: timing is irrelevant, so run branches
                // SEQUENTIALLY (no concurrency machinery). Each branch runs on its own
                // clone of the entry vars (isolated, matching the load path), then its
                // declared outputs are merged back namespaced so downstream rows
                // resolve {{branch.var}} (mirror runner::execute_steps' Parallel arm).
                // No decision row for the node itself (all branches run); each branch
                // http appears as an ordinary Http row in declaration order.
                let entry: BTreeMap<String, String> = iter_vars.clone();
                // runner와 동일하게 모든 분기 ReqGen을 merge-back 전에 한꺼번에 fork한다
                // (앞 분기의 `<branch>.<k>` mark_written이 뒤 분기 fork에 새지 않게).
                let branch_reqs: Vec<Option<ReqGen>> = par
                    .branches
                    .iter()
                    .map(|_| req.as_mut().map(ReqGen::fork))
                    .collect();
                for (branch, mut branch_req) in par.branches.iter().zip(branch_reqs) {
                    if state.truncated || state.ended_by_loop.is_some() {
                        return;
                    }
                    // The merge-back below runs even if this branch's recursion
                    // truncates mid-way (max_requests): partial extracts are
                    // intentionally preserved so the preview shows what resolved.
                    // Do NOT add an early-return between the recursion and the merge.
                    let mut branch_vars = entry.clone();
                    Box::pin(trace_steps(
                        client,
                        &branch.steps,
                        &mut branch_vars,
                        env,
                        loop_index,
                        opts,
                        deadline,
                        state,
                        // 시나리오 기본값은 분기 서브트리에 적용하지 않는다(spec R4, runner와 동일):
                        // parallel = 동시 리소스 로딩 구간이라 사람의 대기가 낄 자리가 아니고,
                        // 그룹 시간이 수면만큼 오염된다. 분기 스텝에 명시된 think_time은 위
                        // Http arm에서 그대로 적용된다.
                        None,
                        &mut branch_req,
                        in_cond_loop,
                        force_think,
                    ))
                    .await;
                    for k in branch.output_var_names() {
                        if let Some(v) = branch_vars.get(k) {
                            let key = format!("{}.{}", branch.name, k);
                            iter_vars.insert(key.clone(), v.clone());
                            if let Some(rg) = req.as_mut() {
                                rg.mark_written(std::iter::once(&key));
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenario_trace_serde_round_trips() {
        let t = ScenarioTrace {
            ok: false,
            total_ms: 12,
            steps: vec![StepTrace {
                step_id: "01HX0000000000000000000001".into(),
                kind: StepKind::Http,
                loop_index: Some(0),
                branch: None,
                request: Some(TracedRequest {
                    method: "GET".into(),
                    url: "http://x/ping".into(),
                    headers: BTreeMap::new(),
                    body: None,
                }),
                response: Some(TracedResponse {
                    status: 200,
                    latency_ms: 3,
                    download_ms: None,
                    headers: BTreeMap::new(),
                    set_cookies: vec![],
                    body: "ok".into(),
                    body_truncated: false,
                }),
                extracted: BTreeMap::new(),
                unbound_vars: vec!["missing".into()],
                error: None,
                branch_eval: vec![],
                timed_out: false,
            }],
            final_vars: BTreeMap::new(),
            truncated: false,
            error: None,
            ended_by_loop: None,
        };
        let json = serde_json::to_value(&t).unwrap();
        let back: ScenarioTrace = serde_json::from_value(json).unwrap();
        assert_eq!(t, back);
        // StepKind serializes lowercase (UI contract).
        assert_eq!(
            serde_json::to_value(StepKind::If).unwrap(),
            serde_json::json!("if")
        );
    }

    #[test]
    fn rows_trace_serde_round_trips() {
        let rt = RowsTrace {
            ok: false,
            truncated: true,
            total_ms: 7,
            rows: vec![RowTrace {
                row_index: 3,
                trace: ScenarioTrace {
                    ok: true,
                    total_ms: 5,
                    steps: vec![],
                    final_vars: BTreeMap::new(),
                    truncated: false,
                    error: None,
                    ended_by_loop: None,
                },
            }],
        };
        let json = serde_json::to_value(&rt).unwrap();
        // 와이어 키 고정 (R8 — UI Zod 1:1 계약)
        assert!(json.get("rows").unwrap()[0].get("row_index").is_some());
        let back: RowsTrace = serde_json::from_value(json).unwrap();
        assert_eq!(rt, back);
    }

    // ---------- 조건 반복(while) trace (loop-do-while T4) ----------
    use std::time::Duration as StdDuration;
    use wiremock::matchers::path as wm_path;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const LOOP_ID: &str = "01HX0000000000000000000001";
    const ORDER_ID: &str = "01HX0000000000000000000002";
    const AFTER_ID: &str = "01HX0000000000000000000003";

    fn t_opts(apply_think_time: bool, max_requests: u32, max_wall: StdDuration) -> TraceOptions {
        TraceOptions {
            env: BTreeMap::new(),
            max_requests,
            max_wall,
            apply_think_time,
        }
    }

    /// loop(order) → after. `loop_head` = repeat/while/keep_think 줄들, `order_extra` = 본문 스텝 추가 줄.
    fn loop_yaml(base: &str, root_extra: &str, loop_head: &str, order_extra: &str) -> String {
        format!(
            r#"version: 1
name: while-trace
{root_extra}variables:
  base: "{base}"
  code: ""
steps:
  - id: "{LOOP_ID}"
    name: poll
    type: loop
{loop_head}
    do:
      - id: "{ORDER_ID}"
        name: order
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/order" }}
        assert: []
{order_extra}        extract:
          - {{ var: code, from: body, path: "$.code" }}
  - id: "{AFTER_ID}"
    name: after
    type: http
    request: {{ method: GET, url: "{{{{base}}}}/after" }}
    assert: []
"#
        )
    }

    const WHILE_WAIT: &str = r#"    while: { left: "{{code}}", op: eq, right: "WAIT" }"#;

    async fn mount_wait_then_ok(server: &MockServer, waits: u64) {
        if waits > 0 {
            Mock::given(wm_path("/order"))
                .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"code":"WAIT"}"#))
                .up_to_n_times(waits)
                .mount(server)
                .await;
        }
        Mock::given(wm_path("/order"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"code":"OK"}"#))
            .mount(server)
            .await;
        Mock::given(wm_path("/after"))
            .respond_with(ResponseTemplate::new(200))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn trace_while_emits_judge_rows() {
        let server = MockServer::start().await;
        mount_wait_then_ok(&server, 2).await;
        let sc = Scenario::from_yaml(&loop_yaml(&server.uri(), "", WHILE_WAIT, "")).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        let kinds: Vec<StepKind> = t.steps.iter().map(|s| s.kind.clone()).collect();
        assert_eq!(
            kinds,
            vec![
                StepKind::Http,
                StepKind::Loop,
                StepKind::Http,
                StepKind::Loop,
                StepKind::Http,
                StepKind::Loop,
                StepKind::Http,
            ]
        );
        let judges: Vec<&StepTrace> = t
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Loop)
            .collect();
        let branches: Vec<&str> = judges
            .iter()
            .map(|s| s.branch.as_deref().unwrap())
            .collect();
        assert_eq!(branches, ["again", "again", "done"]);
        let idx: Vec<Option<u32>> = judges.iter().map(|s| s.loop_index).collect();
        assert_eq!(idx, [Some(0), Some(1), Some(2)]);
        for j in &judges {
            assert_eq!(j.step_id, LOOP_ID);
            assert!(j.request.is_none() && j.response.is_none() && j.error.is_none());
            assert!(j.extracted.is_empty() && j.unbound_vars.is_empty() && !j.timed_out);
            assert_eq!(j.branch_eval.len(), 1);
            assert_eq!(j.branch_eval[0].branch, "while");
        }
        assert_eq!(t.ended_by_loop, None);
        assert!(t.ok && !t.truncated);
    }

    #[tokio::test]
    async fn trace_while_exhausted_sets_ended_by_loop() {
        let server = MockServer::start().await;
        Mock::given(wm_path("/order"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"code":"WAIT"}"#))
            .mount(&server)
            .await;
        Mock::given(wm_path("/after"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let head = format!("    repeat: 2\n{WHILE_WAIT}");
        let sc = Scenario::from_yaml(&loop_yaml(&server.uri(), "", &head, "")).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        let last = t.steps.last().unwrap();
        assert_eq!(last.kind, StepKind::Loop);
        assert_eq!(last.branch.as_deref(), Some("exhausted"));
        assert_eq!(t.ended_by_loop.as_deref(), Some(LOOP_ID));
        assert!(t.steps.iter().all(|s| s.step_id != AFTER_ID));
        assert!(!t.truncated);
    }

    /// 회귀 가드(R0): while 없는 loop의 trace JSON은 지금과 같다.
    #[tokio::test]
    async fn trace_plain_loop_has_no_judge_rows() {
        let server = MockServer::start().await;
        mount_wait_then_ok(&server, 0).await;
        let sc = Scenario::from_yaml(&loop_yaml(&server.uri(), "", "    repeat: 3", "")).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert_eq!(t.steps.iter().filter(|s| s.step_id == ORDER_ID).count(), 3);
        let json = serde_json::to_value(&t).unwrap();
        assert!(json.get("ended_by_loop").is_none(), "{json}");
        for s in json["steps"].as_array().unwrap() {
            assert_ne!(s["kind"], "loop", "{s}");
        }
    }

    #[tokio::test]
    async fn trace_judge_rows_capped() {
        // 요청 없는 본문(분기 안 타는 if) + 항상 참 + 최대 횟수 없음.
        let yaml = r#"version: 1
name: spin
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    while: { left: "1", op: eq, right: "1" }
    do:
      - id: "01HX0000000000000000000009"
        name: never
        type: if
        cond: { left: "1", op: eq, right: "2" }
        then: []
"#;
        let sc = Scenario::from_yaml(yaml).unwrap();
        let started = std::time::Instant::now();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert!(started.elapsed() < StdDuration::from_secs(5));
        assert!(t.truncated);
        let n = t.steps.iter().filter(|s| s.kind == StepKind::Loop).count();
        assert_eq!(n, MAX_LOOP_JUDGE_ROWS as usize, "judge rows = {n}");
    }

    #[tokio::test]
    async fn trace_judge_row_cap_boundary_done_is_not_truncated() {
        // 조건이 정확히 상한번째 판정 행에서 거짓 → 끝난 반복이므로 truncated 아님.
        let yaml = r#"version: 1
name: edge
steps:
  - id: "01HX0000000000000000000001"
    name: edge
    type: loop
    while: { left: "${loop_index}", op: lt, right: "199" }
    do:
      - id: "01HX0000000000000000000009"
        name: never
        type: if
        cond: { left: "1", op: eq, right: "2" }
        then: []
"#;
        let sc = Scenario::from_yaml(yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        let loops: Vec<_> = t
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Loop)
            .collect();
        assert_eq!(loops.len(), MAX_LOOP_JUDGE_ROWS as usize);
        assert_eq!(loops.last().unwrap().branch.as_deref(), Some("done"));
        assert!(!t.truncated);
        assert!(t.ended_by_loop.is_none());
    }

    #[tokio::test]
    async fn trace_judge_rows_capped_across_loop_reentry() {
        // 조건 반복이 자주 "들어가지고" 첫 회차에 끝나도(done 행 1개씩) 판정 행 총량은 상한을 넘지 않는다.
        let yaml = r#"version: 1
name: reenter
steps:
  - id: "01HX0000000000000000000001"
    name: outer
    type: loop
    repeat: 1000
    do:
      - id: "01HX0000000000000000000002"
        name: inner
        type: loop
        while: { left: "1", op: eq, right: "2" }
        do:
          - id: "01HX0000000000000000000009"
            name: never
            type: if
            cond: { left: "1", op: eq, right: "2" }
            then: []
"#;
        let sc = Scenario::from_yaml(yaml).unwrap();
        let started = std::time::Instant::now();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert!(started.elapsed() < StdDuration::from_secs(5));
        assert!(t.truncated);
        let n = t.steps.iter().filter(|s| s.kind == StepKind::Loop).count();
        assert!(n <= MAX_LOOP_JUDGE_ROWS as usize, "judge rows = {n}");
    }

    const THINK_200: &str = "        think_time: { min_ms: 200, max_ms: 200 }\n";

    #[tokio::test]
    async fn trace_keep_think_sleeps_when_think_disabled() {
        let server = MockServer::start().await;
        mount_wait_then_ok(&server, 2).await;
        let o = t_opts(false, 50, StdDuration::from_secs(30));
        let sc = Scenario::from_yaml(&loop_yaml(&server.uri(), "", WHILE_WAIT, THINK_200)).unwrap();
        let t = trace_scenario(&sc, &o).await;
        assert!(
            t.total_ms >= 400,
            "keep_think 기본: total_ms={}",
            t.total_ms
        );

        let server2 = MockServer::start().await;
        mount_wait_then_ok(&server2, 2).await;
        let head = format!("{WHILE_WAIT}\n    keep_think: false");
        let sc = Scenario::from_yaml(&loop_yaml(&server2.uri(), "", &head, THINK_200)).unwrap();
        let t = trace_scenario(&sc, &o).await;
        assert!(
            t.total_ms < 300,
            "keep_think: false: total_ms={}",
            t.total_ms
        );

        // 루트 기본 think만 있는 변형.
        let server3 = MockServer::start().await;
        mount_wait_then_ok(&server3, 2).await;
        let root = "default_think_time: { min_ms: 200, max_ms: 200 }\n";
        let sc = Scenario::from_yaml(&loop_yaml(&server3.uri(), root, WHILE_WAIT, "")).unwrap();
        let t = trace_scenario(&sc, &o).await;
        assert!(
            t.total_ms >= 400,
            "루트 기본 think: total_ms={}",
            t.total_ms
        );
    }

    #[tokio::test]
    async fn trace_cond_loop_lenient_extract() {
        let server = MockServer::start().await;
        mount_wait_then_ok(&server, 1).await;
        let yaml = loop_yaml(&server.uri(), "", WHILE_WAIT, "").replace(
            r#"          - { var: code, from: body, path: "$.code" }"#,
            r#"          - { var: code, from: body, path: "$.code" }
          - { var: orderId, from: body, path: "$.orderId" }"#,
        );
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        let first = t.steps.iter().find(|s| s.step_id == ORDER_ID).unwrap();
        assert_eq!(first.error, None);
        let want: BTreeMap<String, String> = [("code", "WAIT"), ("orderId", "")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert_eq!(first.extracted, want);
    }

    #[tokio::test]
    async fn trace_sequential_rows_continue_after_exhausted() {
        let server = MockServer::start().await;
        Mock::given(wm_path("/order"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"code":"WAIT"}"#))
            .mount(&server)
            .await;
        Mock::given(wm_path("/after"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let head = format!("    repeat: 1\n{WHILE_WAIT}");
        let sc = Scenario::from_yaml(&loop_yaml(&server.uri(), "", &head, "")).unwrap();
        let seeds = vec![(0u64, BTreeMap::new()), (1u64, BTreeMap::new())];
        let rt =
            trace_scenario_rows(&sc, &t_opts(false, 50, StdDuration::from_secs(30)), &seeds).await;
        assert_eq!(rt.rows.len(), 2);
        for r in &rt.rows {
            assert_eq!(r.trace.ended_by_loop.as_deref(), Some(LOOP_ID));
            // 둘째 행도 실제로 돌았다(take가 아니라 clone이면 즉시 반환해 스텝 0개).
            assert!(
                r.trace.steps.iter().any(|s| s.step_id == ORDER_ID),
                "행 {} 본문 스텝 없음",
                r.row_index
            );
        }
    }

    // ---------- if 판정 줄 상한 (if-judge-row-cap) ----------
    const IF_ID: &str = "01HX0000000000000000000009";

    /// loop(repeat) → 항상 거짓 if. spec §1.1.
    fn spin_if_yaml(repeat: u64) -> String {
        format!(
            r#"version: 1
name: ifspin
steps:
  - id: "{LOOP_ID}"
    name: spin
    type: loop
    repeat: {repeat}
    do:
      - id: "{IF_ID}"
        name: never
        type: if
        cond: {{ left: "1", op: eq, right: "2" }}
        then: []
"#
        )
    }

    fn if_rows(t: &ScenarioTrace) -> usize {
        t.steps.iter().filter(|s| s.kind == StepKind::If).count()
    }

    #[test]
    fn if_judge_row_cap_scales_with_max_requests() {
        assert_eq!(if_judge_row_cap(0), 1000);
        assert_eq!(if_judge_row_cap(50), 1000);
        assert_eq!(if_judge_row_cap(100), 1000);
        assert_eq!(if_judge_row_cap(200), 2000);
        assert_eq!(if_judge_row_cap(10_000), 100_000);
        assert_eq!(if_judge_row_cap(u32::MAX), u32::MAX);
    }

    #[tokio::test]
    async fn trace_if_rows_capped() {
        let sc = Scenario::from_yaml(&spin_if_yaml(1_000_000)).unwrap();
        let started = std::time::Instant::now();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert!(started.elapsed() < StdDuration::from_secs(5));
        assert_eq!(if_rows(&t), 1000);
        assert_eq!(t.steps.len(), 1000);
        assert!(t.truncated);
    }

    #[tokio::test]
    async fn trace_if_row_cap_boundary() {
        let o = t_opts(false, 50, StdDuration::from_secs(30));
        let t = trace_scenario(&Scenario::from_yaml(&spin_if_yaml(1000)).unwrap(), &o).await;
        assert_eq!(if_rows(&t), 1000);
        assert!(
            !t.truncated,
            "정확히 상한 번째 줄에서 끝난 시나리오는 잘림이 아니다"
        );
        let t = trace_scenario(&Scenario::from_yaml(&spin_if_yaml(1001)).unwrap(), &o).await;
        assert_eq!(if_rows(&t), 1000);
        assert!(t.truncated);
    }

    #[tokio::test]
    async fn trace_if_row_cap_proportional() {
        let sc = Scenario::from_yaml(&spin_if_yaml(1500)).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 200, StdDuration::from_secs(30))).await;
        assert_eq!(if_rows(&t), 1500);
        assert!(!t.truncated);
    }

    #[tokio::test]
    async fn trace_if_rows_capped_inside_parallel() {
        let yaml = format!(
            r#"version: 1
name: par-if
steps:
  - id: "{LOOP_ID}"
    name: spin
    type: loop
    repeat: 2000
    do:
      - id: "{ORDER_ID}"
        name: par
        type: parallel
        branches:
          - name: A
            steps:
              - id: "{IF_ID}"
                name: never
                type: if
                cond: {{ left: "1", op: eq, right: "2" }}
                then: []
"#
        );
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert_eq!(if_rows(&t), 1000);
        assert!(t.truncated);
    }

    /// http(/first) → `tail`. 순차 2행 — 1행이 판정 줄 예산을 정확히 바닥내면 2행은 시작하지 않는다.
    async fn rows_after_exact_budget(tail: &str) -> (RowsTrace, usize) {
        let server = MockServer::start().await;
        Mock::given(wm_path("/first"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let yaml = format!(
            r#"version: 1
name: seq-edge
steps:
  - id: "{AFTER_ID}"
    name: first
    type: http
    request: {{ method: GET, url: "{}/first" }}
    assert: []
{tail}"#,
            server.uri()
        );
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let seeds = vec![(0u64, BTreeMap::new()), (1u64, BTreeMap::new())];
        let rt =
            trace_scenario_rows(&sc, &t_opts(false, 50, StdDuration::from_secs(30)), &seeds).await;
        let sent = server.received_requests().await.unwrap().len();
        (rt, sent)
    }

    #[tokio::test]
    async fn trace_rows_stop_before_row_when_if_budget_exhausted() {
        let tail = format!(
            r#"  - id: "{LOOP_ID}"
    name: spin
    type: loop
    repeat: 1000
    do:
      - id: "{IF_ID}"
        name: never
        type: if
        cond: {{ left: "1", op: eq, right: "2" }}
        then: []
"#
        );
        let (rt, sent) = rows_after_exact_budget(&tail).await;
        assert_eq!(rt.rows.len(), 1, "2행은 미실행");
        assert!(!rt.rows[0].trace.truncated, "1행은 잘리지 않고 끝났다");
        assert_eq!(if_rows(&rt.rows[0].trace), 1000);
        assert!(rt.truncated);
        assert_eq!(sent, 1, "2행의 요청이 나가지 않았다");
    }

    #[tokio::test]
    async fn trace_rows_stop_before_row_when_loop_judge_budget_exhausted() {
        let tail = format!(
            r#"  - id: "{LOOP_ID}"
    name: edge
    type: loop
    while: {{ left: "${{loop_index}}", op: lt, right: "199" }}
    do:
      - id: "{IF_ID}"
        name: never
        type: if
        cond: {{ left: "1", op: eq, right: "2" }}
        then: []
"#
        );
        let (rt, sent) = rows_after_exact_budget(&tail).await;
        assert_eq!(rt.rows.len(), 1, "2행은 미실행");
        let t = &rt.rows[0].trace;
        assert!(!t.truncated);
        let loops: Vec<_> = t
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Loop)
            .collect();
        assert_eq!(loops.len(), MAX_LOOP_JUDGE_ROWS as usize);
        assert_eq!(loops.last().unwrap().branch.as_deref(), Some("done"));
        assert!(rt.truncated);
        assert_eq!(sent, 1);
    }
}
