//! Single-pass scenario trace for the editor "test-run" (spec
//! `2026-06-01-scenario-editor-test-run-design.md`). NOT a load run: 1 VU, one
//! pass over `steps`, capturing per-request detail instead of aggregated metrics.
//! The interpreter (`trace_scenario`) mirrors `runner::execute_steps`' control
//! flow without the load machinery (no Aggregator/deadline-windows/cancel).

use std::collections::BTreeMap;
use std::time::Duration;

use rand::SeedableRng;
use serde::{Deserialize, Serialize};

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
    /// An `if` decision row (carries `branch`; no request/response). Loop nodes do
    /// not get their own row — their children carry `loop_index`.
    If,
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
}

use std::time::Instant;

use crate::executor::{VuClient, execute_step_traced};
use crate::pacing::ThinkTime;
use crate::runner::select_branch;
use crate::scenario::{CompareOp, Condition, IfStep, Scenario, Step};
use crate::template::{TemplateContext, render_collecting};

struct TraceState {
    steps: Vec<StepTrace>,
    requests: u32,
    truncated: bool,
    /// 이 패스의 `${iter_id}` 값 — 단발/시드 = 0, sequential = 반복 순번 (R4).
    iter_id: u32,
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
            };
        }
    };
    let mut state = TraceState {
        steps: Vec::new(),
        requests: 0,
        truncated: false,
        iter_id: 0,
    };
    trace_once(&client, scenario, opts, seed_vars, 0, deadline, &mut state).await
}

/// 시나리오를 시드 행마다 1회씩 순차 실행 (1 VU iter_sequential 미러 — ADR-0047).
/// 클라이언트(cookie jar)는 1회 빌드해 행 간 공유(R5), `max_requests`·wall-clock
/// deadline은 전 행 공유 단일 예산(R6). 실패 행에서도 계속(R10). 예산이 행 시작
/// 전에 소진되면 그 행부터 `rows`에 없다(R6). Never returns `Err` — 극히 드문
/// 클라이언트 빌드 실패는 `ok=false`·빈 `rows`로 축약(R8 와이어에 error 채널 없음).
pub async fn trace_scenario_rows(
    scenario: &Scenario,
    opts: &TraceOptions,
    seeded_rows: &[(u64, BTreeMap<String, String>)],
) -> RowsTrace {
    let started = Instant::now();
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
    };
    let mut rows: Vec<RowTrace> = Vec::with_capacity(seeded_rows.len());
    let mut truncated = false;
    for (i, (row_index, seed)) in seeded_rows.iter().enumerate() {
        // 행 시작 전 예산 소진 → 이 행부터 미실행 (rows에 없음 — R6).
        if state.requests >= opts.max_requests || Instant::now() >= deadline {
            truncated = true;
            break;
        }
        let trace = trace_once(
            &client, scenario, opts, seed, i as u32, deadline, &mut state,
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
async fn trace_once(
    client: &VuClient,
    scenario: &Scenario,
    opts: &TraceOptions,
    seed_vars: &BTreeMap<String, String>,
    iter_id: u32,
    deadline: Instant,
    state: &mut TraceState,
) -> ScenarioTrace {
    let started = Instant::now();
    state.steps = Vec::new();
    state.truncated = false;
    state.iter_id = iter_id;
    // 생성기 전용 rng — think_rng와 절대 공유 금지(spec §4). 행/반복마다 재평가.
    let mut gen_rng = rand::rngs::StdRng::from_entropy();
    let mut iter_vars: BTreeMap<String, String> =
        crate::genvars::seed_iter_vars(&scenario.variables, &mut gen_rng);
    // 기존 데이터셋 overlay 루프 무변경 — 우선순위 생성 < 데이터셋 < extract.
    for (k, v) in seed_vars {
        iter_vars.insert(k.clone(), v.clone());
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
) {
    for step in steps {
        if state.truncated {
            return;
        }
        if state.requests >= opts.max_requests || Instant::now() >= deadline {
            state.truncated = true;
            return;
        }
        match step {
            Step::Http(http) => {
                let ctx = TemplateContext {
                    vars: iter_vars,
                    env,
                    vu_id: 0,
                    iter_id: state.iter_id,
                    loop_index,
                };
                let t = execute_step_traced(client, http, &ctx).await;
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
                });
                if opts.apply_think_time {
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
                for i in 0..lp.repeat {
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
                    ))
                    .await;
                    if state.truncated {
                        return;
                    }
                }
            }
            Step::If(if_step) => {
                let (taken, branch, cond_unbound): (&[Step], String, Vec<String>) = {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env,
                        vu_id: 0,
                        iter_id: state.iter_id,
                        loop_index,
                    };
                    let unbound = collect_if_condition_unbound(if_step, &ctx);
                    let (taken, branch) = select_branch(if_step, &ctx);
                    (taken, branch, unbound)
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
                });
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
                for branch in &par.branches {
                    if state.truncated {
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
                    ))
                    .await;
                    for k in branch.output_var_names() {
                        if let Some(v) = branch_vars.get(k) {
                            iter_vars.insert(format!("{}.{}", branch.name, k), v.clone());
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
            }],
            final_vars: BTreeMap::new(),
            truncated: false,
            error: None,
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
                },
            }],
        };
        let json = serde_json::to_value(&rt).unwrap();
        // 와이어 키 고정 (R8 — UI Zod 1:1 계약)
        assert!(json.get("rows").unwrap()[0].get("row_index").is_some());
        let back: RowsTrace = serde_json::from_value(json).unwrap();
        assert_eq!(rt, back);
    }
}
