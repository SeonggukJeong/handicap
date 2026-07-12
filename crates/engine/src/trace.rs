//! Single-pass scenario trace for the editor "test-run" (spec
//! `2026-06-01-scenario-editor-test-run-design.md`). NOT a load run: 1 VU, one
//! pass over `steps`, capturing per-request detail instead of aggregated metrics.
//! The interpreter (`trace_scenario`) mirrors `runner::execute_steps`' control
//! flow without the load machinery (no Aggregator/deadline-windows/cancel).

use std::collections::BTreeMap;
use std::time::Duration;

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
}

/// Run `scenario` once (1 VU, single pass) and capture a per-request trace.
/// Never returns `Err` — setup failures land in `ScenarioTrace.error`, per-step
/// failures in each `StepTrace.error`.
pub async fn trace_scenario(scenario: &Scenario, opts: &TraceOptions) -> ScenarioTrace {
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

    let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
    let mut state = TraceState {
        steps: Vec::new(),
        requests: 0,
        truncated: false,
    };
    Box::pin(trace_steps(
        &client,
        &scenario.steps,
        &mut iter_vars,
        &opts.env,
        None,
        opts,
        deadline,
        &mut state,
        scenario.default_think_time,
    ))
    .await;

    let ok = state.steps.iter().all(|s| s.error.is_none());
    ScenarioTrace {
        ok,
        total_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        steps: state.steps,
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
                    iter_id: 0,
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
                        iter_id: 0,
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
}
