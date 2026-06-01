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
use crate::runner::select_branch;
use crate::scenario::{Scenario, Step};
use crate::template::TemplateContext;

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
                    ))
                    .await;
                    if state.truncated {
                        return;
                    }
                }
            }
            Step::If(if_step) => {
                let (taken, branch): (&[Step], String) = {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env,
                        vu_id: 0,
                        iter_id: 0,
                        loop_index,
                    };
                    select_branch(if_step, &ctx)
                };
                state.steps.push(StepTrace {
                    step_id: if_step.id.clone(),
                    kind: StepKind::If,
                    loop_index,
                    branch: Some(branch),
                    request: None,
                    response: None,
                    extracted: BTreeMap::new(),
                    unbound_vars: vec![],
                    error: None,
                });
                Box::pin(trace_steps(
                    client, taken, iter_vars, env, loop_index, opts, deadline, state,
                ))
                .await;
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
