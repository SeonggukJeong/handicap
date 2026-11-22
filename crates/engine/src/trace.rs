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
    /// if 판정 줄 상한과 판정 줄 바이트 예산도 이 값에 비례한다.
    pub max_requests: u32,
    /// Wall-clock ceiling; on reaching it the trace stops with `truncated = true`.
    /// 판정 줄 상한에 먼저 닿으면 그 전에 끊긴다.
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

/// 판정 줄(If·Loop) 한 줄의 메모리 어림(바이트) — 가변 글자 `str::len` 합 + 줄당 64 +
/// `BranchEval`당 32. 요청·응답·추출·오류는 판정 줄에 없으므로 세지 않는다.
pub fn judge_row_bytes(row: &StepTrace) -> u64 {
    let mut n: u64 = 64 + row.step_id.len() as u64;
    if let Some(b) = &row.branch {
        n += b.len() as u64;
    }
    for v in &row.unbound_vars {
        n += v.len() as u64;
    }
    for be in &row.branch_eval {
        n += 32 + be.branch.len() as u64;
        if let Some(leaf) = &be.leaf {
            n += leaf.left.len() as u64;
            n += leaf.right.as_ref().map_or(0, |v| v.len() as u64);
            n += leaf.left_value.as_ref().map_or(0, |v| v.len() as u64);
            n += leaf.right_value.as_ref().map_or(0, |v| v.len() as u64);
        }
    }
    n
}

/// 판정 줄 전체(If + Loop)의 바이트 예산 — 줄 수 상한 두 개에 줄당 4096 바이트를 곱한 값.
/// u64에서 계산해 `max_requests = u32::MAX`에서도 넘치지 않는다.
pub fn judge_byte_budget(max_requests: u32) -> u64 {
    (if_judge_row_cap(max_requests) as u64 + MAX_LOOP_JUDGE_ROWS as u64) * 4096
}

/// trace가 판정 줄 상한(If 줄 수 · Loop 줄 수 · 바이트 예산 중 하나)에 닿아 끊겼는지.
/// 컨트롤러·모니터가 잘린 사유를 가릴 때 쓴다. 단일 패스(`trace_scenario`) trace 전용 —
/// 순차 행 trace는 예산을 행 사이에 이월하므로 한 행의 줄만으로는 판정할 수 없다.
pub fn judge_rows_exhausted(steps: &[StepTrace], max_requests: u32) -> bool {
    let mut if_n: u64 = 0;
    let mut loop_n: u64 = 0;
    let mut bytes: u64 = 0;
    for s in steps {
        match s.kind {
            StepKind::If => if_n += 1,
            StepKind::Loop => loop_n += 1,
            StepKind::Http => continue,
        }
        bytes = bytes.saturating_add(judge_row_bytes(s));
    }
    if_n >= if_judge_row_cap(max_requests) as u64
        || loop_n >= MAX_LOOP_JUDGE_ROWS as u64
        || bytes > judge_byte_budget(max_requests)
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
    /// http 행 전용: 비워진 값이 주소에 쓰여 보내지 않았다(없으면 직렬화 생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<BlockedInfo>,
    /// http 행 전용: 값을 못 뽑아 `default`가 들어간 이름(선언 순서, 없으면 직렬화 생략).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub defaulted: Vec<String>,
    /// 준비 구간에서 실행한 행이면 `Some(Section::Setup)`, 본 스텝이면 `None`(직렬화 생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<Section>,
}

/// 보내지 않은 http 행의 사유 — 변수 이름과 값을 못 준 스텝 id만 싣는다(값 없음).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockedInfo {
    pub vars: Vec<String>,
    pub by_step: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScenarioTrace {
    /// True when no HTTP leaf reported an error.
    pub ok: bool,
    pub total_ms: u64,
    pub steps: Vec<StepTrace>,
    /// Flow vars at end of the pass (scenario.variables + all extracts).
    pub final_vars: BTreeMap<String, String>,
    /// `max_requests`·판정 줄 상한(줄 수·바이트) 또는 시간 상한이 패스를 끊었을 때 true.
    pub truncated: bool,
    /// Setup-level failure (e.g. HTTP client build) — distinct from per-step errors.
    pub error: Option<String>,
    /// 조건 반복이 최대 횟수에 닿아 이번 반복을 끝냈다면 그 loop 스텝 id (없으면 직렬화 생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_by_loop: Option<String>,
    /// 준비 스텝이 실패해 본 스텝을 실행하지 않았다(false면 직렬화 생략).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub setup_failed: bool,
    /// 준비에 걸린 시간 ms (준비가 있을 때만).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_ms: Option<u64>,
}

use std::sync::Arc;
use std::time::Instant;

use crate::blank_guard::{self, BLOCKED_ERROR, BlankTable};
use crate::executor::{ExtractMode, VuClient, execute_step_traced_with, method_parts};
use crate::extract::fill_missing_extracts;
use crate::pacing::ThinkTime;
use crate::reqgen::{ReqGen, RequestGenPlan};
use crate::runner::select_branch;
use crate::scenario::{CompareOp, Condition, IfStep, Scenario, Step};
use crate::section::Section;
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
    /// 지금까지 넣은 판정 줄(If·Loop)의 바이트 어림 합 — 전 행 공유 예산(`judge_byte_budget`).
    judge_bytes: u64,
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
    /// 첫 행 앞에서 한 번 실행한 준비 스텝 행(없으면 직렬화 생략).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub setup_steps: Vec<StepTrace>,
    /// 준비 실패로 행을 하나도 실행하지 않았다(false면 직렬화 생략).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub setup_failed: bool,
    /// 준비에 걸린 시간 ms (준비가 있을 때만).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_ms: Option<u64>,
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
                setup_failed: false,
                setup_ms: None,
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
        judge_bytes: 0,
        ended_by_loop: None,
    };
    let mut setup_rows = Vec::new();
    let mut setup_ms = None;
    let mut setup_vars = BTreeMap::new();
    let mut reuse_seed = None;
    if let Some(setup) = run_trace_setup(
        scenario,
        opts,
        seed_vars,
        &client,
        deadline,
        &mut state,
        reqgen.as_ref(),
    )
    .await
    {
        match setup.outcome {
            TraceSectionRun::Done(extracted) => {
                setup_vars = extracted;
                reuse_seed = Some(setup.scenario_vars);
                setup_rows = setup.rows;
                setup_ms = Some(setup.ms);
            }
            stopped => {
                return ScenarioTrace {
                    ok: setup.rows.iter().all(|s| s.error.is_none()),
                    total_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    steps: setup.rows,
                    final_vars: setup.vars,
                    truncated: matches!(stopped, TraceSectionRun::Truncated),
                    error: None,
                    ended_by_loop: None,
                    setup_failed: matches!(stopped, TraceSectionRun::Failed),
                    setup_ms: Some(setup.ms),
                };
            }
        }
    }
    let mut trace = trace_once(
        &client,
        scenario,
        opts,
        seed_vars,
        0,
        deadline,
        &mut state,
        reqgen.as_ref(),
        &setup_vars,
        reuse_seed,
    )
    .await;
    if setup_ms.is_some() {
        setup_rows.append(&mut trace.steps);
        trace.steps = setup_rows;
        trace.total_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        trace.setup_ms = setup_ms;
    }
    trace
}

/// 시나리오를 시드 행마다 1회씩 순차 실행 (1 VU iter_sequential 미러 — ADR-0047).
/// 클라이언트(cookie jar)는 1회 빌드해 행 간 공유(R5), `max_requests`·wall-clock
/// deadline·if 판정 줄 수·조건 반복 판정 줄 수·판정 줄 바이트는 전 행 공유 단일 예산(R6). 실패 행에서도
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
                setup_steps: Vec::new(),
                setup_failed: false,
                setup_ms: None,
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
        judge_bytes: 0,
        ended_by_loop: None,
    };
    let mut setup_steps = Vec::new();
    let mut setup_ms = None;
    let mut setup_vars = BTreeMap::new();
    let mut reuse_seed = None;
    if let Some((_, first_seed)) = seeded_rows.first() {
        if let Some(setup) = run_trace_setup(
            scenario,
            opts,
            first_seed,
            &client,
            deadline,
            &mut state,
            reqgen.as_ref(),
        )
        .await
        {
            match setup.outcome {
                TraceSectionRun::Done(extracted) => {
                    setup_vars = extracted;
                    reuse_seed = Some(setup.scenario_vars);
                    setup_steps = setup.rows;
                    setup_ms = Some(setup.ms);
                }
                stopped => {
                    return RowsTrace {
                        ok: false,
                        truncated: matches!(stopped, TraceSectionRun::Truncated),
                        total_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                        rows: vec![],
                        setup_steps: setup.rows,
                        setup_failed: matches!(stopped, TraceSectionRun::Failed),
                        setup_ms: Some(setup.ms),
                    };
                }
            }
        }
    }
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
            &setup_vars,
            reuse_seed.take(),
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
        setup_steps,
        setup_failed: false,
        setup_ms,
    }
}

/// 방금 push한 판정 줄(`state.steps`의 마지막)의 어림을 `judge_bytes`에 더하고,
/// 바이트 예산을 넘겼는지 돌려준다(넘긴 줄 자체는 trace에 남는다).
fn charge_judge_row(state: &mut TraceState, opts: &TraceOptions) -> bool {
    let add = state.steps.last().map_or(0, judge_row_bytes);
    state.judge_bytes = state.judge_bytes.saturating_add(add);
    state.judge_bytes > judge_byte_budget(opts.max_requests)
}

/// 클라이언트 하나로 시나리오를 1패스 실행하는 내부 코어. `state.requests`
/// (공유 요청 예산)와 `if_rows`·`judge_rows`·`judge_bytes`(판정 줄 예산)는 호출 간 이월되고 `steps`/`truncated`/`iter_id`는 진입 시
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
    // 준비 스텝이 추출한 변수(없으면 빈 맵).
    setup_vars: &BTreeMap<String, String>,
    // Some이면 이 패스의 시나리오 변수로 다시 시드하지 않고 이 값을 쓴다(첫 패스, 준비 때 시드한 값).
    reuse_seed: Option<BTreeMap<String, String>>,
) -> ScenarioTrace {
    let started = Instant::now();
    state.steps = Vec::new();
    state.truncated = false;
    state.iter_id = iter_id;
    // 생성기 전용 rng — think_rng와 절대 공유 금지(spec §4). 행/반복마다 재평가.
    let mut gen_rng = rand::rngs::StdRng::from_entropy();
    let mut iter_vars: BTreeMap<String, String> = match reuse_seed {
        Some(v) => v,
        None => crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng),
    };
    // 행/반복마다 새 상태 — 행 간 죽은 집합이 새지 않는다.
    let mut req = reqgen.map(|p| ReqGen::new(p.clone(), &mut gen_rng));
    // 순서: 시나리오 변수 → 준비 추출 → 시드(데이터셋).
    iter_vars.extend(setup_vars.iter().map(|(k, v)| (k.clone(), v.clone())));
    if let Some(rg) = req.as_mut() {
        rg.mark_written(setup_vars.keys());
    }
    // 기존 데이터셋 overlay 루프 무변경 — 우선순위 생성 < 데이터셋 < extract.
    for (k, v) in seed_vars {
        iter_vars.insert(k.clone(), v.clone());
    }
    if let Some(rg) = req.as_mut() {
        rg.mark_written(seed_vars.keys());
    }
    // 행/반복마다 새 비움 표 — 앞 행에서 비워진 이름이 다음 행의 정당한 요청을 막지 않는다.
    let mut blanked = BlankTable::new();
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
        &mut blanked,
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
        setup_failed: false,
        setup_ms: None,
    }
}

/// 준비 구간 실행 결과.
enum TraceSectionRun {
    /// 모든 준비 스텝 성공 — 추출한 변수.
    Done(BTreeMap<String, String>),
    Failed,
    /// 요청 상한 또는 시간 상한에 닿았다(`state.truncated`가 선다).
    Truncated,
}

/// trace 쪽 구간 실행. 준비 행을 `state.steps`에 `section: Some(section)`으로 쌓는다.
/// `state.requests`(요청 상한)와 `deadline`은 본 패스와 공유하고 스텝마다 머리에서 검사한다.
/// 본 스텝용 `trace_steps`를 다시 쓰지 않는다(값 채우기·비움 표·너그러운 추출이 없다).
#[allow(clippy::too_many_arguments)]
async fn trace_section(
    section: Section,
    steps: &[Step],
    client: &VuClient,
    vars: &mut BTreeMap<String, String>,
    opts: &TraceOptions,
    deadline: Instant,
    state: &mut TraceState,
    req: &mut Option<ReqGen>,
    default_think: Option<ThinkTime>,
) -> TraceSectionRun {
    let mut extracted_all = BTreeMap::new();
    for step in steps {
        let Step::Http(http) = step else {
            state.steps.push(StepTrace {
                step_id: step.id().to_string(),
                kind: StepKind::Http,
                loop_index: None,
                branch: None,
                request: None,
                response: None,
                extracted: BTreeMap::new(),
                unbound_vars: Vec::new(),
                error: Some(format!("setup: step {} must be http", step.id())),
                branch_eval: Vec::new(),
                timed_out: false,
                blocked: None,
                defaulted: Vec::new(),
                section: Some(section),
            });
            return TraceSectionRun::Failed;
        };
        if state.requests >= opts.max_requests || Instant::now() >= deadline {
            state.truncated = true;
            return TraceSectionRun::Truncated;
        }
        if let Some(rg) = req.as_mut() {
            rg.refresh(&http.id, vars);
        }
        let ctx = TemplateContext {
            vars,
            env: &opts.env,
            vu_id: 0,
            iter_id: state.iter_id,
            loop_index: None,
        };
        let mut t =
            execute_step_traced_with(client, http, &ctx, ExtractMode::StrictNoDefaults).await;
        state.requests += 1;
        if t.error.is_none() {
            if !t.unbound_vars.is_empty() {
                t.error = Some("setup: unbound variable".to_string());
            } else if t.extracted.values().any(String::is_empty) {
                t.error = Some("setup: empty extract".to_string());
            }
        }
        let failed = t.error.is_some();
        let extracted = t.extracted;
        state.steps.push(StepTrace {
            step_id: http.id.clone(),
            kind: StepKind::Http,
            loop_index: None,
            branch: None,
            request: Some(t.request),
            response: t.response,
            extracted: extracted.clone(),
            unbound_vars: t.unbound_vars,
            error: t.error,
            branch_eval: Vec::new(),
            timed_out: t.timed_out,
            blocked: None,
            defaulted: Vec::new(),
            section: Some(section),
        });
        if failed {
            return TraceSectionRun::Failed;
        }
        if let Some(rg) = req.as_mut() {
            rg.mark_written(extracted.keys());
        }
        vars.extend(extracted.clone());
        extracted_all.extend(extracted);
        if opts.apply_think_time {
            if let Some(tt) = http.think_time.or(default_think) {
                let now = Instant::now();
                if now < deadline {
                    let dur = tt.sample(&mut rand::thread_rng()).min(deadline - now);
                    tokio::time::sleep(dur).await;
                }
                if Instant::now() >= deadline {
                    state.truncated = true;
                    return TraceSectionRun::Truncated;
                }
            }
        }
    }
    TraceSectionRun::Done(extracted_all)
}

/// 준비 한 번 실행의 산출물. 준비 행은 `state.steps`에서 꺼내 `rows`에 둔다.
struct TraceSetup {
    outcome: TraceSectionRun,
    rows: Vec<StepTrace>,
    ms: u64,
    /// 준비 때 한 번 시드한 시나리오 변수(첫 패스가 다시 쓴다).
    scenario_vars: BTreeMap<String, String>,
    /// 준비가 끝난 시점의 변수(준비 때 시나리오 변수 + 시드 + 준비 추출).
    vars: BTreeMap<String, String>,
}

/// 준비 스텝이 있으면 「시나리오 변수 + 시드」의 사본에서 한 번 실행한다. 없으면 `None`.
async fn run_trace_setup(
    scenario: &Scenario,
    opts: &TraceOptions,
    seed_vars: &BTreeMap<String, String>,
    client: &VuClient,
    deadline: Instant,
    state: &mut TraceState,
    reqgen: Option<&Arc<RequestGenPlan>>,
) -> Option<TraceSetup> {
    if scenario.setup_steps().is_empty() {
        return None;
    }
    let started = Instant::now();
    state.steps = Vec::new();
    state.truncated = false;
    state.iter_id = 0;
    let mut gen_rng = rand::rngs::StdRng::from_entropy();
    let scenario_vars = crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
    let mut vars = scenario_vars.clone();
    let mut req = reqgen.map(|p| ReqGen::new(p.clone(), &mut gen_rng));
    for (k, v) in seed_vars {
        vars.insert(k.clone(), v.clone());
    }
    if let Some(rg) = req.as_mut() {
        rg.mark_written(seed_vars.keys());
    }
    let outcome = trace_section(
        Section::Setup,
        scenario.setup_steps(),
        client,
        &mut vars,
        opts,
        deadline,
        state,
        &mut req,
        scenario.default_think_time,
    )
    .await;
    Some(TraceSetup {
        outcome,
        rows: std::mem::take(&mut state.steps),
        ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        scenario_vars,
        vars,
    })
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
    // 추출 못 해 비워진 이름의 비움 표(runner::execute_steps와 같은 규칙).
    blanked: &mut BlankTable,
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
                // runner::execute_steps와 같은 판정 — 주소가 읽는 이름이 비워진 채면 보내지 않는다.
                let blocked = {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env,
                        vu_id: 0,
                        iter_id: state.iter_id,
                        loop_index,
                    };
                    blank_guard::check(&http.request.url, &ctx, blanked)
                };
                if let Some(b) = blocked {
                    let mut extracted = BTreeMap::new();
                    let filled =
                        fill_missing_extracts(http, &mut extracted, iter_vars, in_cond_loop);
                    if let Some(rg) = req.as_mut() {
                        rg.mark_written(filled.defaulted.iter());
                    }
                    blank_guard::note_step(blanked, &http.id, &extracted, &filled.blanked);
                    state.requests += 1;
                    state.steps.push(StepTrace {
                        step_id: http.id.clone(),
                        kind: StepKind::Http,
                        loop_index,
                        branch: None,
                        request: Some(TracedRequest {
                            method: method_parts(&http.request.method).0.to_string(),
                            url: b.url,
                            headers: BTreeMap::new(),
                            body: None,
                        }),
                        response: None,
                        extracted,
                        unbound_vars: Vec::new(),
                        error: Some(BLOCKED_ERROR.to_string()),
                        branch_eval: Vec::new(),
                        timed_out: false,
                        blocked: Some(BlockedInfo {
                            vars: b.vars,
                            by_step: b.by_step,
                        }),
                        defaulted: filled.defaulted,
                        section: None,
                    });
                } else {
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
                    let filled =
                        fill_missing_extracts(http, &mut t.extracted, iter_vars, in_cond_loop);
                    if let Some(rg) = req.as_mut() {
                        rg.mark_written(filled.defaulted.iter());
                    }
                    blank_guard::note_step(blanked, &http.id, &t.extracted, &filled.blanked);
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
                        blocked: None,
                        defaulted: filled.defaulted,
                        section: None,
                    });
                }
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
                        let pass_start = state.steps.len();
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
                            blanked,
                            true,
                            body_think,
                        ))
                        .await;
                        if state.truncated || state.ended_by_loop.is_some() {
                            return;
                        }
                        // runner와 같은 규칙: 보낸 요청 없이 막히기만 한 회차(안쪽 if·loop·parallel
                        // 행 포함)면 판정 행 없이, 최대 횟수 소진처럼 이번 반복을 끝낸다
                        // (`ended_by_loop`, 잘림 아님 — blank-var-url-guard G2).
                        let pass_rows = &state.steps[pass_start..];
                        let http_rows = || pass_rows.iter().filter(|s| s.kind == StepKind::Http);
                        if http_rows().any(|s| s.blocked.is_some())
                            && http_rows().all(|s| s.blocked.is_some())
                        {
                            state.ended_by_loop = Some(lp.id.clone());
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
                            blocked: None,
                            defaulted: Vec::new(),
                            section: None,
                        });
                        state.judge_rows += 1;
                        if charge_judge_row(state, opts) {
                            state.truncated = true;
                            return;
                        }
                        tokio::task::yield_now().await;
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
                        let before = (state.steps.len(), state.requests);
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
                            blanked,
                            in_cond_loop,
                            force_think,
                        ))
                        .await;
                        if state.truncated || state.ended_by_loop.is_some() {
                            return;
                        }
                        // 줄도 요청도 안 만든 회차는 다음 회차도 같다 — 남은 회차를 돌지 않는다(잘림 아님).
                        if (state.steps.len(), state.requests) == before {
                            break;
                        }
                        // 보내기 전에 실패하는 http만 든 본문은 줄을 만들면서도 멈추지 않는다.
                        tokio::task::yield_now().await;
                    }
                }
            }
            Step::If(if_step) => {
                if state.if_rows >= if_judge_row_cap(opts.max_requests) {
                    state.truncated = true;
                    return;
                }
                // 큰 조건·비싼 `matches`가 줄 수만큼 실행기 스레드를 쥐지 않게.
                tokio::task::yield_now().await;
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
                    blocked: None,
                    defaulted: Vec::new(),
                    section: None,
                });
                state.if_rows += 1;
                if charge_judge_row(state, opts) {
                    state.truncated = true;
                    return;
                }
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
                    blanked,
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
                let entry_blanked: BlankTable = blanked.clone();
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
                    let mut branch_blanked: BlankTable = entry_blanked.clone();
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
                        &mut branch_blanked,
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
                    blank_guard::merge_branch(
                        blanked,
                        &branch_blanked,
                        &branch.name,
                        &branch.output_var_names(),
                        &branch_vars,
                    );
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
                blocked: None,
                defaulted: Vec::new(),
                section: None,
            }],
            final_vars: BTreeMap::new(),
            truncated: false,
            error: None,
            ended_by_loop: None,
            setup_failed: false,
            setup_ms: None,
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
                    setup_failed: false,
                    setup_ms: None,
                },
            }],
            setup_steps: Vec::new(),
            setup_failed: false,
            setup_ms: None,
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
    // ---------- 판정 줄 바이트 예산 ----------
    fn judge_row(kind: StepKind, left: &str) -> StepTrace {
        StepTrace {
            step_id: "ab".into(),
            kind,
            loop_index: None,
            branch: Some("none".into()),
            request: None,
            response: None,
            extracted: BTreeMap::new(),
            unbound_vars: vec!["x".into(), "yz".into()],
            error: None,
            branch_eval: vec![BranchEval {
                branch: "then".into(),
                passed: false,
                leaf: Some(crate::condition::LeafEval {
                    left: left.into(),
                    op: CompareOp::Eq,
                    right: Some("r".into()),
                    left_value: Some("lv".into()),
                    right_value: None,
                    left_unbound: false,
                }),
            }],
            timed_out: false,
            blocked: None,
            defaulted: Vec::new(),
            section: None,
        }
    }

    fn judge_bytes_sum(t: &ScenarioTrace) -> u64 {
        t.steps
            .iter()
            .filter(|s| matches!(s.kind, StepKind::If | StepKind::Loop))
            .map(judge_row_bytes)
            .sum()
    }

    #[test]
    fn judge_row_bytes_counts_variable_text() {
        // 64 + step_id 2 + branch 4 + unbound 1+2 + (32 + "then" 4 + "한" 3 + "r" 1 + "lv" 2)
        assert_eq!(judge_row_bytes(&judge_row(StepKind::If, "한")), 115);
    }

    #[test]
    fn judge_byte_budget_scales_without_overflow() {
        assert_eq!(judge_byte_budget(50), 1200 * 4096);
        assert_eq!(judge_byte_budget(10_000), 100_200 * 4096);
        assert_eq!(judge_byte_budget(u32::MAX), (u32::MAX as u64 + 200) * 4096);
    }

    #[test]
    fn judge_rows_exhausted_cases() {
        let small_if = || judge_row(StepKind::If, "1");
        let small_loop = || judge_row(StepKind::Loop, "1");
        let n = |k: usize, f: &dyn Fn() -> StepTrace| (0..k).map(|_| f()).collect::<Vec<_>>();
        assert!(judge_rows_exhausted(&n(1000, &small_if), 50));
        assert!(
            !judge_rows_exhausted(&n(1000, &small_if), 200),
            "상한 2,000"
        );
        assert!(!judge_rows_exhausted(&n(999, &small_if), 50));
        assert!(judge_rows_exhausted(&n(200, &small_loop), 50));
        assert!(
            judge_rows_exhausted(&n(200, &small_loop), 10_000),
            "조건 반복 상한은 비례 안 함"
        );
        let mut mixed = n(999, &small_if);
        mixed.extend(n(199, &small_loop));
        assert!(!judge_rows_exhausted(&mixed, 50), "두 예산은 합치지 않는다");
        let big = "a".repeat(1_300_000);
        let huge = (0..4)
            .map(|_| judge_row(StepKind::If, &big))
            .collect::<Vec<_>>();
        assert!(judge_rows_exhausted(&huge, 50), "5.2 MB > 예산 4.9 MB");
        assert!(!judge_rows_exhausted(&huge[..3], 50));
        assert!(!judge_rows_exhausted(&[], 50));
    }

    #[tokio::test]
    async fn trace_if_rows_byte_budget() {
        let big = "a".repeat(40_000);
        let yaml = spin_if_yaml(1_000_000).replace(r#"left: "1""#, &format!(r#"left: "{big}""#));
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert!(t.truncated);
        assert!(
            if_rows(&t) < 1000,
            "줄 수 상한보다 먼저 닿는다: {}",
            if_rows(&t)
        );
        let budget = judge_byte_budget(50);
        let sum = judge_bytes_sum(&t);
        let last = judge_row_bytes(t.steps.last().unwrap());
        assert!(sum > budget, "넘긴 줄이 trace에 남는다");
        assert!(sum - last <= budget, "초과분은 줄 하나");
        assert!(judge_rows_exhausted(&t.steps, 50));
    }

    #[tokio::test]
    async fn trace_while_rows_byte_budget() {
        let big = "a".repeat(40_000);
        let yaml = format!(
            r#"version: 1
name: bigwhile
steps:
  - id: "{LOOP_ID}"
    name: spin
    type: loop
    while: {{ left: "{big}", op: ne, right: "x" }}
    do: []
"#
        );
        let sc = Scenario::from_yaml(&yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert!(t.truncated);
        assert!(t.ended_by_loop.is_none());
        let n = t.steps.iter().filter(|s| s.kind == StepKind::Loop).count();
        assert!(
            n < MAX_LOOP_JUDGE_ROWS as usize,
            "줄 수 상한보다 먼저 닿는다: {n}"
        );
        assert!(judge_bytes_sum(&t) > judge_byte_budget(50));
    }

    // ---------- 진행 없는 반복 끊기 + 양보 ----------
    const EMPTY_SPIN: &str = r#"version: 1
name: emptyspin
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    repeat: 4000000000
    do: []
"#;

    const NESTED_EMPTY_SPIN: &str = r#"version: 1
name: nested
steps:
  - id: "01HX0000000000000000000001"
    name: outer
    type: loop
    repeat: 4000000000
    do:
      - id: "01HX0000000000000000000002"
        name: inner
        type: loop
        repeat: 4000000000
        do: []
"#;

    #[tokio::test]
    async fn trace_no_progress_loop_ends_at_once() {
        for y in [EMPTY_SPIN, NESTED_EMPTY_SPIN] {
            let sc = Scenario::from_yaml(y).unwrap();
            let started = std::time::Instant::now();
            let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(2))).await;
            assert!(
                started.elapsed() < StdDuration::from_secs(1),
                "{:?}",
                started.elapsed()
            );
            assert!(t.steps.is_empty());
            assert!(!t.truncated);
            assert!(t.ok);
        }
    }

    #[tokio::test]
    async fn trace_no_progress_loop_keeps_parallel_merge() {
        let yaml = r#"version: 1
name: par-merge
variables:
  x: "v"
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    repeat: 4000000000
    do:
      - id: "01HX0000000000000000000002"
        name: par
        type: parallel
        branches:
          - name: A
            steps:
              - id: "01HX0000000000000000000003"
                name: zero
                type: loop
                repeat: 0
                do:
                  - id: "01HX0000000000000000000004"
                    name: never
                    type: http
                    request: { method: GET, url: "http://127.0.0.1:1/never" }
                    extract:
                      - { var: x, from: body, path: "$.x" }
"#;
        let sc = Scenario::from_yaml(yaml).unwrap();
        let started = std::time::Instant::now();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(2))).await;
        assert!(
            started.elapsed() < StdDuration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        assert!(!t.truncated);
        assert!(t.steps.is_empty());
        assert_eq!(t.final_vars.get("A.x").map(String::as_str), Some("v"));
    }

    #[tokio::test]
    async fn trace_progress_loop_runs_every_iteration() {
        let sc = Scenario::from_yaml(&spin_if_yaml(7)).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        assert_eq!(if_rows(&t), 7);
        let idx: Vec<_> = t.steps.iter().map(|s| s.loop_index).collect();
        assert_eq!(idx, (0..7).map(Some).collect::<Vec<_>>());
        assert!(!t.truncated);
    }

    /// 단일 스레드 런타임에서 trace가 도는 동안 옆 task가 몇 번 돌았는지.
    async fn side_ticks_during_trace(yaml: &str) -> (ScenarioTrace, u64) {
        use std::sync::atomic::{AtomicU64, Ordering};
        let counter = Arc::new(AtomicU64::new(0));
        let c = counter.clone();
        let side = tokio::spawn(async move {
            loop {
                c.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        });
        let sc = Scenario::from_yaml(yaml).unwrap();
        let t = trace_scenario(&sc, &t_opts(false, 50, StdDuration::from_secs(30))).await;
        side.abort();
        (t, counter.load(Ordering::Relaxed))
    }

    #[tokio::test(flavor = "current_thread")]
    async fn trace_if_rows_yield_to_other_tasks() {
        // loop 없이 최상위 if 300개 — If 가지의 양보만 관찰된다.
        let mut y = String::from("version: 1\nname: flat-ifs\nsteps:\n");
        for i in 0..300 {
            y += &format!(
                "  - id: \"01HX00000000000000000{i:05}\"\n    name: n{i}\n    type: if\n    cond: {{ left: \"1\", op: eq, right: \"2\" }}\n    then: []\n"
            );
        }
        let (t, n) = side_ticks_during_trace(&y).await;
        assert_eq!(if_rows(&t), 300);
        assert!(n > 100, "옆 task가 굶었다: counter={n}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn trace_plain_loop_iterations_yield_to_other_tasks() {
        // 보내기 전에 실패하는 http(상대 주소) — 회차마다 줄은 생기지만 send가 멈추지 않는다.
        let y = r#"version: 1
name: failing-http
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    repeat: 40
    do:
      - id: "01HX0000000000000000000002"
        name: bad
        type: http
        request: { method: GET, url: "/x" }
        assert: []
"#;
        let (t, n) = side_ticks_during_trace(y).await;
        assert_eq!(t.steps.len(), 40);
        assert!(t.steps.iter().all(|s| s.error.is_some()));
        assert!(n >= 30, "옆 task가 굶었다: counter={n}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn trace_while_passes_yield_to_other_tasks() {
        let y = r#"version: 1
name: empty-while
steps:
  - id: "01HX0000000000000000000001"
    name: spin
    type: loop
    while: { left: "1", op: eq, right: "1" }
    do: []
"#;
        let (t, n) = side_ticks_during_trace(y).await;
        let rows = t.steps.iter().filter(|s| s.kind == StepKind::Loop).count();
        assert_eq!(rows, MAX_LOOP_JUDGE_ROWS as usize);
        assert!(t.truncated, "기존 동작 그대로");
        assert!(n > 100, "옆 task가 굶었다: counter={n}");
    }
}
