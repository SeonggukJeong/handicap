# Scenario Editor Test-Run — C-1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a controller endpoint `POST /api/test-runs` that runs an inline scenario YAML once (1 VU, single pass) in-process via a new engine `trace_scenario`, returning a per-request trace (resolved request, raw response, extracted vars, unbound-var warnings, branch decisions) — no DB, no worker, no proto.

**Architecture:** A new engine module `trace.rs` houses the trace data model + a recursive single-pass interpreter that mirrors `runner.rs::execute_steps`' control flow **without** the load machinery (no `Aggregator`, no per-second deadline, no `CancellationToken`). The interpreter calls a new `executor.rs::execute_step_traced` (lenient render + response capture) for HTTP leaves, and a shared `runner.rs::select_branch` (extracted from `execute_steps`) for `if` decisions. The hot load path (`run_scenario`/`execute_step`/`execute_steps`) stays byte-identical except for the no-behavior-change `select_branch` extraction. The controller endpoint parses the YAML, validates (`422` via a new `ApiError::Unprocessable`), and calls `trace_scenario` synchronously.

**Tech Stack:** Rust (engine lib + controller axum bin), `reqwest`, `serde`/`serde_json`, `tokio`, `wiremock` (engine tests). MSRV 1.85, edition 2024.

**Scope note:** This is the **C-1 backend** half of spec `docs/superpowers/specs/2026-06-01-scenario-editor-test-run-design.md`. UI (C-2) is a separate plan. `unbound_vars` (spec §9 task 3) **is in scope** per the user's decision.

**Pre-flight (run once before Task 1):**
```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-engine -p handicap-controller   # warm baseline
cargo test -p handicap-engine                            # baseline green
```

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `crates/engine/src/template.rs` | Modify | Add `render_collecting` (lenient render + collect unresolved token names). |
| `crates/engine/src/trace.rs` | Create | Trace data model (`ScenarioTrace`/`StepTrace`/`StepKind`/`TracedRequest`/`TracedResponse`/`HttpTrace`/`TraceOptions`) + `trace_scenario` interpreter. |
| `crates/engine/src/executor.rs` | Modify | Add `execute_step_traced` (+ `render_json_collecting`). `execute_step` untouched. |
| `crates/engine/src/runner.rs` | Modify | Extract `pub(crate) fn select_branch` from the `Step::If` arm; `execute_steps` calls it (no behavior change). |
| `crates/engine/src/lib.rs` | Modify | `pub mod trace;` + re-exports. |
| `crates/controller/src/error.rs` | Modify | Add `ApiError::Unprocessable(String)` → 422. |
| `crates/controller/src/api/test_runs.rs` | Create | `POST /api/test-runs` handler + DTOs + validation. |
| `crates/controller/src/api/mod.rs` | Modify | `pub mod test_runs;`. |
| `crates/controller/src/app.rs` | Modify | Import alias + route registration. |
| `crates/controller/tests/test_runs_api_test.rs` | Create | Endpoint integration tests (422 cases + 200-shape). |
| `crates/controller/CLAUDE.md` | Modify | Record the intentional 422-vs-legacy-400 divergence. |

**Constants:** `MAX_TRACE_BODY_BYTES = 16 * 1024` (response body truncation), `DEFAULT_MAX_REQUESTS = 50`, `MAX_MAX_REQUESTS = 10_000`, controller wall-clock ceiling `120s`.

---

## Task 1: `render_collecting` — lenient render that reports unresolved tokens

**Files:**
- Modify: `crates/engine/src/template.rs`
- Modify: `crates/engine/src/lib.rs`

The trace needs to know *which* `{{var}}`/`${NAME}` rendered to empty. `render_lenient` discards that. Add a third entry point that shares `render_inner` but threads an optional collector. Hot-path `render`/`render_lenient` signatures stay unchanged.

- [ ] **Step 1: Write the failing tests** (append inside `mod tests` in `template.rs`, before the closing `}`):

```rust
    #[test]
    fn collecting_reports_unresolved_flow_and_env_vars() {
        let v = vars(&[("known", "K")]);
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let mut unbound = Vec::new();
        let out = render_collecting("{{known}}-{{missing}}-${NOPE}", &ctx, &mut unbound);
        assert_eq!(out, "K--"); // resolved + two empties
        assert_eq!(unbound, vec!["missing".to_string(), "NOPE".to_string()]);
    }

    #[test]
    fn collecting_ignores_resolved_and_defaulted() {
        let v = vars(&[("a", "1")]);
        let env: BTreeMap<String, String> =
            [("H".to_string(), "h".to_string())].into_iter().collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 5,
            iter_id: 0,
            loop_index: Some(2),
        };
        let mut unbound = Vec::new();
        // ${MISSING:-fb} resolves via default → NOT unbound. system vars resolve.
        let out = render_collecting("{{a}}/${H}/${vu_id}/${loop_index}/${MISSING:-fb}", &ctx, &mut unbound);
        assert_eq!(out, "1/h/5/2/fb");
        assert!(unbound.is_empty(), "got {unbound:?}");
    }

    #[test]
    fn collecting_reports_loop_index_outside_loop() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let mut unbound = Vec::new();
        let out = render_collecting("i${loop_index}", &ctx, &mut unbound);
        assert_eq!(out, "i");
        assert_eq!(unbound, vec!["loop_index".to_string()]);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p handicap-engine --lib template::tests::collecting_ -- --nocapture`
Expected: FAIL — `cannot find function render_collecting`.

- [ ] **Step 3: Implement `render_collecting` + thread a collector through `render_inner`**

In `template.rs`, change the private `render_inner` signature to take an optional collector and have the lenient "push nothing" branches record the unresolved name. Replace the existing `render`, `render_lenient`, and `render_inner` definitions (lines ~22–144) with:

```rust
pub fn render(input: &str, ctx: &TemplateContext) -> Result<String> {
    render_inner(input, ctx, false, &mut None)
}

/// Lenient variant for **condition evaluation** (spec §3.1). Unresolved tokens
/// render to the empty string and it never returns `Err`.
pub fn render_lenient(input: &str, ctx: &TemplateContext) -> String {
    render_inner(input, ctx, true, &mut None).unwrap_or_default()
}

/// Lenient render that ALSO appends the name of every unresolved token
/// (`{{var}}` missing from vars, `${NAME}` missing with no default, `${loop_index}`
/// outside a loop) to `unbound`. Used by the test-run trace so the UI can show
/// "why is this empty". Never returns `Err`. Order-preserving; may push duplicates
/// (caller dedupes per step).
pub fn render_collecting(input: &str, ctx: &TemplateContext, unbound: &mut Vec<String>) -> String {
    let mut sink = Some(unbound);
    render_inner(input, ctx, true, &mut sink).unwrap_or_default()
}

fn render_inner(
    input: &str,
    ctx: &TemplateContext,
    lenient: bool,
    collect: &mut Option<&mut Vec<String>>,
) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut lit_start = 0;

    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            out.push_str(&input[lit_start..i]);
            let end = match find_pair(bytes, i + 2, b"}}") {
                Some(e) => e,
                None => {
                    if lenient {
                        out.push_str(&input[i..]);
                        return Ok(out);
                    }
                    return Err(EngineError::MalformedTemplate(format!(
                        "unclosed {{{{ at byte {i}"
                    )));
                }
            };
            let name = match std::str::from_utf8(&bytes[i + 2..end]) {
                Ok(s) => s.trim(),
                Err(_) => {
                    if lenient {
                        out.push_str(&input[i..]);
                        return Ok(out);
                    }
                    return Err(EngineError::MalformedTemplate("non-utf8 in {{ }}".into()));
                }
            };
            match ctx.vars.get(name) {
                Some(value) => out.push_str(value),
                None => {
                    if !lenient {
                        return Err(EngineError::UnknownVar(name.to_string()));
                    }
                    if let Some(sink) = collect.as_deref_mut() {
                        sink.push(name.to_string());
                    }
                }
            }
            i = end + 2;
            lit_start = i;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            out.push_str(&input[lit_start..i]);
            let end = match find_byte(bytes, i + 2, b'}') {
                Some(e) => e,
                None => {
                    if lenient {
                        out.push_str(&input[i..]);
                        return Ok(out);
                    }
                    return Err(EngineError::MalformedTemplate(format!(
                        "unclosed ${{ at byte {i}"
                    )));
                }
            };
            let inner = match std::str::from_utf8(&bytes[i + 2..end]) {
                Ok(s) => s,
                Err(_) => {
                    if lenient {
                        out.push_str(&input[i..]);
                        return Ok(out);
                    }
                    return Err(EngineError::MalformedTemplate("non-utf8 in ${ }".into()));
                }
            };
            let (name, default) = match inner.find(":-") {
                Some(p) => (inner[..p].trim(), Some(inner[p + 2..].to_string())),
                None => (inner.trim(), None),
            };
            let value: Option<String> = match name {
                "vu_id" => Some(ctx.vu_id.to_string()),
                "iter_id" => Some(ctx.iter_id.to_string()),
                "loop_index" => ctx.loop_index.map(|x| x.to_string()),
                other => match ctx.env.get(other) {
                    Some(v) => Some(v.clone()),
                    None => default,
                },
            };
            match value {
                Some(v) => out.push_str(&v),
                None => {
                    if !lenient {
                        return Err(EngineError::UnknownVar(name.to_string()));
                    }
                    if let Some(sink) = collect.as_deref_mut() {
                        sink.push(name.to_string());
                    }
                }
            }
            i = end + 1;
            lit_start = i;
            continue;
        }
        i += 1;
    }
    out.push_str(&input[lit_start..]);
    Ok(out)
}
```

- [ ] **Step 4: Export `render_collecting`** — in `crates/engine/src/lib.rs`, change the template re-export line:

```rust
pub use template::{TemplateContext, render, render_collecting, render_lenient};
```

- [ ] **Step 5: Run the template tests to verify they pass**

Run: `cargo test -p handicap-engine --lib template::`
Expected: PASS — new `collecting_*` tests pass and all existing `render`/`render_lenient` tests stay green (the `&mut None` collector is a no-op for them).

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/template.rs crates/engine/src/lib.rs
git commit -m "feat(engine): render_collecting — lenient render reporting unresolved tokens (C-1)"
```

---

## Task 2: Trace data model (`trace.rs`)

**Files:**
- Create: `crates/engine/src/trace.rs`
- Modify: `crates/engine/src/lib.rs`

Define the trace types first (pure data; `derive(Serialize, Deserialize)` — they are plain structs / a data-less enum, so no manual-serde trap, and Deserialize is required because the controller integration test round-trips them).

- [ ] **Step 1: Create `crates/engine/src/trace.rs` with the data model + a serde round-trip test**

```rust
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
```

- [ ] **Step 2: Register the module + re-export** — in `crates/engine/src/lib.rs`:

Add `pub mod trace;` to the module list (after `pub mod template;`), and add this re-export line. **Note:** `trace_scenario` is intentionally NOT in this list yet — it is added to this same line in Task 5 (it doesn't exist until then).

```rust
pub use trace::{
    HttpTrace, ScenarioTrace, StepKind, StepTrace, TraceOptions, TracedRequest, TracedResponse,
};
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cargo test -p handicap-engine --lib trace::tests::scenario_trace_serde_round_trips`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/engine/src/trace.rs crates/engine/src/lib.rs
git commit -m "feat(engine): test-run trace data model (C-1)"
```

---

## Task 3: `execute_step_traced` — HTTP leaf executor that captures request + response

**Files:**
- Modify: `crates/engine/src/executor.rs`
- Modify: `crates/engine/src/lib.rs`

A traced sibling of `execute_step`. Differences from the hot-path `execute_step` (which stays byte-identical): renders **leniently with collection** (unbound vars don't error, they're recorded), and **keeps** the resolved request + response headers/cookies/body (truncated). The request-build structure is duplicated rather than shared because the leaf render differs (strict-`Result` vs collecting-`String`) — duplication is the low-risk choice that keeps `execute_step` untouched.

- [ ] **Step 1: Write the failing test** (append inside `mod tests` in `executor.rs`):

```rust
    #[tokio::test]
    async fn traced_step_captures_request_response_and_unbound() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ping"))
            .respond_with(
                ResponseTemplate::new(201)
                    .insert_header("x-trace", "yes")
                    .set_body_string("pong-body"),
            )
            .mount(&server)
            .await;

        let mut headers = BTreeMap::new();
        headers.insert("x-token".to_string(), "{{missing}}".to_string()); // unbound → empty
        let step = HttpStep {
            id: "01HX0000000000000000000002".into(),
            name: "ping".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/ping", server.uri()),
                headers,
                body: None,
            },
            assert: vec![],
            extract: vec![],
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let t = execute_step_traced(&client, &step, &ctx).await;

        assert_eq!(t.request.method, "GET");
        assert_eq!(t.request.headers.get("x-token").map(String::as_str), Some("")); // rendered empty
        assert_eq!(t.unbound_vars, vec!["missing".to_string()]);
        let resp = t.response.expect("response captured");
        assert_eq!(resp.status, 201);
        assert_eq!(resp.body, "pong-body");
        assert!(!resp.body_truncated);
        assert_eq!(resp.headers.get("x-trace").map(String::as_str), Some("yes"));
        assert!(t.error.is_none(), "{:?}", t.error);
    }

    #[tokio::test]
    async fn traced_step_reports_connection_error_with_request_kept() {
        let step = HttpStep {
            id: "01HX0000000000000000000003".into(),
            name: "down".into(),
            request: Request {
                method: HttpMethod::Get,
                url: "http://127.0.0.1:1/nope".into(), // refused fast
                headers: BTreeMap::new(),
                body: None,
            },
            assert: vec![],
            extract: vec![],
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let t = execute_step_traced(&client, &step, &ctx).await;
        assert!(t.response.is_none());
        assert!(t.error.is_some());
        assert_eq!(t.request.url, "http://127.0.0.1:1/nope"); // request still captured
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p handicap-engine --lib executor::tests::traced_step -- --nocapture`
Expected: FAIL — `cannot find function execute_step_traced`.

- [ ] **Step 3: Implement `execute_step_traced` + `render_json_collecting`**

In `executor.rs`, update the imports at the top: add `render_collecting` and the trace types:

```rust
use crate::template::{TemplateContext, render, render_collecting};
use crate::trace::{HttpTrace, TracedRequest, TracedResponse};
```

Add a module-level constant near the top (after the imports):

```rust
/// Response bodies larger than this are truncated in the trace (UI display cap).
const MAX_TRACE_BODY_BYTES: usize = 16 * 1024;
```

Add these two functions (place them after `execute_step`, before `#[cfg(test)]`):

```rust
/// Lenient+collecting JSON render (trace sibling of `render_json_value`): renders
/// every string leaf via `render_collecting`, preserving numbers/bools/null and
/// object keys, and appending unresolved token names to `unbound`.
fn render_json_collecting(
    value: &serde_json::Value,
    ctx: &TemplateContext<'_>,
    unbound: &mut Vec<String>,
) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::String(s) => Value::String(render_collecting(s, ctx, unbound)),
        Value::Array(items) => {
            Value::Array(items.iter().map(|i| render_json_collecting(i, ctx, unbound)).collect())
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), render_json_collecting(v, ctx, unbound));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Trace sibling of [`execute_step`]: renders leniently (collecting unbound tokens)
/// and KEEPS the resolved request + response detail. Never errors — failures are
/// captured in the returned `HttpTrace.error`. Does not touch the load hot path.
pub async fn execute_step_traced(
    client: &VuClient,
    step: &HttpStep,
    ctx: &TemplateContext<'_>,
) -> HttpTrace {
    let mut unbound: Vec<String> = Vec::new();
    let url = render_collecting(&step.request.url, ctx, &mut unbound);

    let (method_str, method) = match step.request.method {
        HttpMethod::Get => ("GET", reqwest::Method::GET),
        HttpMethod::Post => ("POST", reqwest::Method::POST),
        HttpMethod::Put => ("PUT", reqwest::Method::PUT),
        HttpMethod::Patch => ("PATCH", reqwest::Method::PATCH),
        HttpMethod::Delete => ("DELETE", reqwest::Method::DELETE),
        HttpMethod::Head => ("HEAD", reqwest::Method::HEAD),
        HttpMethod::Options => ("OPTIONS", reqwest::Method::OPTIONS),
    };

    let mut header_display: BTreeMap<String, String> = BTreeMap::new();
    let mut headers = HeaderMap::new();
    let mut build_error: Option<String> = None;
    for (k, v) in &step.request.headers {
        let rv = render_collecting(v, ctx, &mut unbound);
        header_display.insert(k.clone(), rv.clone());
        match (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(&rv)) {
            (Ok(name), Ok(val)) => {
                headers.insert(name, val);
            }
            _ => {
                if build_error.is_none() {
                    build_error = Some(format!("invalid header {k}"));
                }
            }
        }
    }

    // Render + record the body (display form) and attach to the request builder.
    let mut body_display: Option<String> = None;
    let mut req = client.inner.request(method, &url).headers(headers);
    if let Some(body) = &step.request.body {
        req = match body {
            Body::Json(v) => {
                let rendered = render_json_collecting(v, ctx, &mut unbound);
                body_display = serde_json::to_string(&rendered).ok();
                req.json(&rendered)
            }
            Body::Form(map) => {
                let mut rendered = BTreeMap::new();
                for (k, v) in map {
                    rendered.insert(k.clone(), render_collecting(v, ctx, &mut unbound));
                }
                body_display = Some(
                    rendered
                        .iter()
                        .map(|(k, v)| format!("{k}={v}"))
                        .collect::<Vec<_>>()
                        .join("&"),
                );
                req.form(&rendered)
            }
            Body::Raw(s) => {
                let rendered = render_collecting(s, ctx, &mut unbound);
                body_display = Some(rendered.clone());
                req.body(rendered)
            }
        };
    }

    unbound.dedup();
    let request = TracedRequest {
        method: method_str.to_string(),
        url,
        headers: header_display,
        body: body_display,
    };

    let started = std::time::Instant::now();
    let outcome = req.send().await;
    let latency_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    let resp = match outcome {
        Ok(r) => r,
        Err(e) => {
            return HttpTrace {
                request,
                response: None,
                extracted: BTreeMap::new(),
                unbound_vars: unbound,
                error: Some(build_error.unwrap_or_else(|| e.to_string())),
            };
        }
    };

    let status = resp.status().as_u16();
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.as_str().to_string(), s.to_string())))
        .collect();
    let set_cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(String::from))
        .collect();
    let body_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return HttpTrace {
                request,
                response: Some(TracedResponse {
                    status,
                    latency_ms,
                    headers: resp_headers.iter().cloned().collect(),
                    set_cookies,
                    body: String::new(),
                    body_truncated: false,
                }),
                extracted: BTreeMap::new(),
                unbound_vars: unbound,
                error: Some(format!("read body: {e}")),
            };
        }
    };

    let full_len = body_bytes.len();
    let body_truncated = full_len > MAX_TRACE_BODY_BYTES;
    let body =
        String::from_utf8_lossy(&body_bytes[..full_len.min(MAX_TRACE_BODY_BYTES)]).into_owned();

    let mut error: Option<String> = build_error;
    if error.is_none() {
        for a in &step.assert {
            if let Assertion::Status(want) = a {
                if *want != status {
                    error = Some(format!("status {} != {}", status, want));
                    break;
                }
            }
        }
    }

    let mut extracted = BTreeMap::new();
    if error.is_none() && !step.extract.is_empty() {
        let facts = ResponseFacts {
            status,
            headers: &resp_headers,
            set_cookies: &set_cookies,
            body: &body_bytes,
        };
        match evaluate_extracts(&step.extract, &facts) {
            Ok(map) => extracted = map,
            Err(e) => error = Some(e.to_string()),
        }
    }

    HttpTrace {
        request,
        response: Some(TracedResponse {
            status,
            latency_ms,
            headers: resp_headers.into_iter().collect(),
            set_cookies,
            body,
            body_truncated,
        }),
        extracted,
        unbound_vars: unbound,
        error,
    }
}
```

> NOTE: `client.inner` is a private field; `execute_step_traced` lives in the same module as `VuClient` so it has access (same as `execute_step`). Keep both functions in `executor.rs`.

- [ ] **Step 4: Export `execute_step_traced`** — in `crates/engine/src/lib.rs`, extend the executor re-export:

```rust
pub use executor::{ExecOutcome, VuClient, execute_step, execute_step_traced};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p handicap-engine --lib executor::tests::traced_step`
Expected: PASS (both `traced_step_*` tests). Existing `executor` tests stay green.

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/executor.rs crates/engine/src/lib.rs
git commit -m "feat(engine): execute_step_traced — capture request+response for trace (C-1)"
```

---

## Task 4: Extract `select_branch` (shared if-decision logic)

**Files:**
- Modify: `crates/engine/src/runner.rs`

Pull the `if`-branch selection + label out of `execute_steps`' `Step::If` arm into a `pub(crate)` function so `trace_scenario` reuses the exact same decision logic (single source of truth → branch labels can't drift). Pure refactor — no behavior change; existing engine tests (`loop_node.rs`, condition/if tests) are the guard.

- [ ] **Step 1: Write a direct unit test for `select_branch`** — `runner.rs` has **no** inline `mod tests`, so append this new module at the **end** of the file (`use super::*` brings in `TemplateContext`, `select_branch`, `BTreeMap`):

```rust
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p handicap-engine --lib runner::tests::select_branch_picks -- --nocapture`
Expected: FAIL — `cannot find function select_branch`.

- [ ] **Step 3: Add `select_branch` and refactor the `Step::If` arm**

In `runner.rs`, add this function (place it just above `fn execute_steps` or just below it, module scope):

```rust
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
```

Then replace the inline selection block in the `Step::If` arm (`runner.rs` ~353–380) — the `let (taken, branch): (&[Step], String) = { ... };` block — with a call:

```rust
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
                {
                    let mut a = agg.lock().await;
                    a.record_branch(&if_step.id, &branch);
                }
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
```

- [ ] **Step 4: Run the engine suite to verify no behavior change**

Run: `cargo test -p handicap-engine`
Expected: PASS — the new `select_branch_picks_then_elif_else_none` plus ALL existing tests (the if/loop/condition tests prove the refactor is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/runner.rs
git commit -m "refactor(engine): extract select_branch (shared by load + trace) (C-1)"
```

---

## Task 5: `trace_scenario` — the single-pass interpreter

**Files:**
- Modify: `crates/engine/src/trace.rs`
- Modify: `crates/engine/src/lib.rs`
- Create: `crates/engine/tests/trace_scenario.rs`

The recursive walk: HTTP leaves → `execute_step_traced` + extract overlay + `max_requests` count; loops → recurse `0..repeat` with `loop_index` (no own row); ifs → `select_branch` + a decision row + recurse. Stops on `max_requests` or the wall-clock ceiling (`truncated`).

- [ ] **Step 1: Write the failing integration tests** — create `crates/engine/tests/trace_scenario.rs`:

```rust
use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::{Scenario, TraceOptions, trace_scenario};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn opts(env: BTreeMap<String, String>, max_requests: u32) -> TraceOptions {
    TraceOptions {
        env,
        max_requests,
        max_wall: Duration::from_secs(120),
    }
}

#[tokio::test]
async fn flat_http_pass_captures_each_step_in_order() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_string("A"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: flat
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
  - type: http
    id: 01HX0000000000000000000011
    name: b
    request: {{ method: GET, url: "{base}/b" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    assert!(trace.ok, "{:?}", trace);
    assert!(!trace.truncated);
    assert_eq!(trace.steps.len(), 2);
    assert_eq!(trace.steps[0].step_id, "01HX0000000000000000000010");
    assert_eq!(trace.steps[0].response.as_ref().unwrap().status, 200);
    assert_eq!(trace.steps[1].response.as_ref().unwrap().status, 204);
}

#[tokio::test]
async fn loop_children_carry_loop_index() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/x"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: loopy
steps:
  - type: loop
    id: 01HX0000000000000000000020
    name: rep
    repeat: 3
    do:
      - type: http
        id: 01HX0000000000000000000021
        name: x
        request: {{ method: GET, url: "{base}/x" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    // No loop container row; 3 http rows with loop_index 0,1,2.
    assert_eq!(trace.steps.len(), 3);
    let idxs: Vec<Option<u32>> = trace.steps.iter().map(|s| s.loop_index).collect();
    assert_eq!(idxs, vec![Some(0), Some(1), Some(2)]);
}

#[tokio::test]
async fn if_emits_decision_row_and_runs_taken_branch() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/then"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: branch
variables: {{ go: "yes" }}
steps:
  - type: if
    id: 01HX0000000000000000000030
    name: maybe
    cond: {{ left: "{{{{go}}}}", op: eq, right: "yes" }}
    then:
      - type: http
        id: 01HX0000000000000000000031
        name: t
        request: {{ method: GET, url: "{base}/then" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    assert_eq!(trace.steps.len(), 2);
    assert_eq!(trace.steps[0].kind, handicap_engine::StepKind::If);
    assert_eq!(trace.steps[0].branch.as_deref(), Some("then"));
    assert!(trace.steps[0].request.is_none());
    assert_eq!(trace.steps[1].step_id, "01HX0000000000000000000031");
}

#[tokio::test]
async fn max_requests_truncates() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/x"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: big
steps:
  - type: loop
    id: 01HX0000000000000000000040
    name: rep
    repeat: 10
    do:
      - type: http
        id: 01HX0000000000000000000041
        name: x
        request: {{ method: GET, url: "{base}/x" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 4)).await;

    assert!(trace.truncated);
    assert_eq!(trace.steps.len(), 4); // stopped at the cap
}

#[tokio::test]
async fn unbound_env_var_is_reported_not_fatal() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/p"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    // URL host from server, but an unbound ${MISSING} in the query.
    let yaml = format!(
        r#"
version: 1
name: unbound
steps:
  - type: http
    id: 01HX0000000000000000000050
    name: p
    request: {{ method: GET, url: "{base}/p?u=${{MISSING}}" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    assert!(trace.ok, "lenient render must not fail the run: {:?}", trace);
    assert_eq!(trace.steps[0].unbound_vars, vec!["MISSING".to_string()]);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p handicap-engine --test trace_scenario`
Expected: FAIL — `cannot find function trace_scenario` / `StepKind` import errors.

- [ ] **Step 3: Implement `trace_scenario` + the recursive walk** — append to `crates/engine/src/trace.rs` (above the `#[cfg(test)]` module):

```rust
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
    trace_steps(
        &client,
        &scenario.steps,
        &mut iter_vars,
        &opts.env,
        None,
        opts,
        deadline,
        &mut state,
    )
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
```

- [ ] **Step 4: Add `trace_scenario` to the lib re-export** — in `crates/engine/src/lib.rs`, update the trace re-export to include `trace_scenario`:

```rust
pub use trace::{
    HttpTrace, ScenarioTrace, StepKind, StepTrace, TraceOptions, TracedRequest, TracedResponse,
    trace_scenario,
};
```

- [ ] **Step 5: Run the integration tests to verify they pass**

Run: `cargo test -p handicap-engine --test trace_scenario`
Expected: PASS (all 5). Then run the full engine suite: `cargo test -p handicap-engine` — all green.

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/trace.rs crates/engine/src/lib.rs crates/engine/tests/trace_scenario.rs
git commit -m "feat(engine): trace_scenario single-pass interpreter (C-1)"
```

---

## Task 6: `ApiError::Unprocessable` (422)

**Files:**
- Modify: `crates/controller/src/error.rs`
- Modify: `crates/controller/CLAUDE.md`

- [ ] **Step 1: Write the failing test** (append a `#[cfg(test)] mod tests` to `error.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    #[test]
    fn unprocessable_maps_to_422() {
        let resp = ApiError::Unprocessable("bad scenario".into()).into_response();
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn bad_request_still_maps_to_400() {
        let resp = ApiError::BadRequest("x".into()).into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p handicap-controller --lib error::tests`
Expected: FAIL — `no variant named Unprocessable`.

- [ ] **Step 3: Add the variant + mapping**

In `error.rs`, add the variant to the enum (after `BadRequest`):

```rust
    #[error("unprocessable: {0}")]
    Unprocessable(String),
```

And add its arm in the `match &self` inside `into_response` (after the `BadRequest` arm):

```rust
            ApiError::Unprocessable(m) => (StatusCode::UNPROCESSABLE_ENTITY, m.clone()),
```

- [ ] **Step 4: Document the divergence** — append to the "axum / 라우팅" section of `crates/controller/CLAUDE.md`:

```markdown
- **`ApiError::Unprocessable`(422)는 test-run 엔드포인트 전용** (C-1): `POST /api/test-runs`의 의미 검증(시나리오 YAML 파싱 실패·`max_requests` 범위)만 422를 쓴다 — axum `Json` 추출기가 이 엔드포인트에 이미 422(틀린 필드 타입)를 내므로 핸들러도 422로 맞춰 엔드포인트 내부를 일관시킨 것. **레거시 엔드포인트(runs/presets/environments/datasets)는 400(`BadRequest`) 유지** — 의도된 분기다. `from_yaml` 에러는 `?`(→`ApiError::Scenario`→400)에 기대지 말고 명시 `map_err(|e| ApiError::Unprocessable(...))`로 매핑.
```

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p handicap-controller --lib error::tests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/error.rs crates/controller/CLAUDE.md
git commit -m "feat(controller): ApiError::Unprocessable (422) for test-run validation (C-1)"
```

---

## Task 7: `POST /api/test-runs` endpoint

**Files:**
- Create: `crates/controller/src/api/test_runs.rs`
- Modify: `crates/controller/src/api/mod.rs`
- Modify: `crates/controller/src/app.rs`
- Create: `crates/controller/tests/test_runs_api_test.rs`

The handler parses the inline YAML, validates (`422`), builds `TraceOptions` (env, max_requests, 120s ceiling), and calls `trace_scenario` synchronously. No `State`/DB needed.

- [ ] **Step 1: Write the failing integration test** — create `crates/controller/tests/test_runs_api_test.rs` using the same `make_app`/oneshot harness as `crates/controller/tests/environments_api_test.rs` (in-process, no network bind):

```rust
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

fn make_app(db: handicap_controller::store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(SubprocessDispatcher::new(
            "/nonexistent".to_string(),
            "127.0.0.1:0".parse().unwrap(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
    })
}

async fn post(app: &axum::Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

#[tokio::test]
async fn test_run_rejects_unparseable_yaml_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _b) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": "this: is: not: a: scenario", "env": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn test_run_rejects_out_of_range_max_requests_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps: []\n";
    for bad in [0u32, 10_001] {
        let (status, _b) = post(
            &app,
            "/api/test-runs",
            json!({ "scenario_yaml": yaml, "env": {}, "max_requests": bad }),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "max_requests={bad}");
    }
}

#[tokio::test]
async fn test_run_returns_200_trace_with_step_error_for_unreachable_target() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps:\n  - type: http\n    id: 01HX0000000000000000000099\n    name: down\n    request:\n      method: GET\n      url: http://127.0.0.1:1/nope\n";
    let (status, body) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": yaml, "env": {}, "max_requests": 5 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["steps"].as_array().unwrap().len(), 1);
    assert!(body["steps"][0]["error"].is_string());
}

#[tokio::test]
async fn test_run_ignores_unknown_runner_field() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps: []\n";
    let (status, body) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": yaml, "env": {}, "runner": "mars" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["steps"].as_array().unwrap().len(), 0);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p handicap-controller --test test_runs_api_test`
Expected: FAIL — route `/api/test-runs` returns 404 (handler not yet wired) / compile error for the harness import.

- [ ] **Step 3: Create the handler** — `crates/controller/src/api/test_runs.rs`:

```rust
use std::collections::BTreeMap;
use std::time::Duration;

use axum::Json;
use handicap_engine::{Scenario, ScenarioTrace, TraceOptions, trace_scenario};
use serde::Deserialize;

use crate::error::ApiError;

const DEFAULT_MAX_REQUESTS: u32 = 50;
const MAX_MAX_REQUESTS: u32 = 10_000;
const WALL_CLOCK_CEILING_SECS: u64 = 120;

fn default_max_requests() -> u32 {
    DEFAULT_MAX_REQUESTS
}

#[derive(Debug, Deserialize)]
pub struct TestRunRequest {
    pub scenario_yaml: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_max_requests")]
    pub max_requests: u32,
    /// Reserved for the future worker-based runner (spec §8-3). Ignored in v1.
    #[serde(default)]
    #[allow(dead_code)]
    pub runner: Option<String>,
}

/// `POST /api/test-runs` — run an inline scenario once (1 VU, single pass)
/// in-process and return a per-request trace. Ephemeral: nothing is persisted.
pub async fn create(
    Json(body): Json<TestRunRequest>,
) -> Result<Json<ScenarioTrace>, ApiError> {
    if body.max_requests < 1 || body.max_requests > MAX_MAX_REQUESTS {
        return Err(ApiError::Unprocessable(format!(
            "max_requests must be 1..={MAX_MAX_REQUESTS}, got {}",
            body.max_requests
        )));
    }
    let scenario = Scenario::from_yaml(&body.scenario_yaml)
        .map_err(|e| ApiError::Unprocessable(format!("scenario parse: {e}")))?;

    let opts = TraceOptions {
        env: body.env,
        max_requests: body.max_requests,
        max_wall: Duration::from_secs(WALL_CLOCK_CEILING_SECS),
    };
    let trace = trace_scenario(&scenario, &opts).await;
    Ok(Json(trace))
}
```

- [ ] **Step 4: Register the module + route**

In `crates/controller/src/api/mod.rs`, add (keep alphabetical):

```rust
pub mod test_runs;
```

In `crates/controller/src/app.rs`, extend the `use crate::api::{ ... }` import list to:

```rust
use crate::api::{
    datasets as datasets_api, environments as environments_api, presets as presets_api,
    runs as runs_api, scenarios as scenarios_api, test_runs as test_runs_api,
};
```

Then register the route in `pub fn router(...)`, after the `/runs/...` routes:

```rust
        .route("/test-runs", post(test_runs_api::create))
```

(`post` is already imported in `app.rs`.)

- [ ] **Step 5: Run the endpoint tests to verify they pass**

Run: `cargo test -p handicap-controller --test test_runs_api_test`
Expected: PASS (all 4).

- [ ] **Step 6: Full workspace gate**

Run:
```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: PASS — no fmt diff, no clippy warnings, all tests green (engine + controller, including the untouched load-path tests).

- [ ] **Step 7: Commit**

```bash
git add crates/controller/src/api/test_runs.rs crates/controller/src/api/mod.rs \
        crates/controller/src/app.rs crates/controller/tests/test_runs_api_test.rs
git commit -m "feat(controller): POST /api/test-runs ephemeral in-process trace endpoint (C-1)"
```

---

## Manual smoke (optional, after Task 7)

```bash
# Terminal 1: run the controller (no worker needed for test-run)
just run-controller   # or: cargo run -p handicap-controller --bin controller

# Terminal 2: an unreachable target → 200 trace with a step error
curl -s -w '\n%{http_code}\n' -X POST localhost:8080/api/test-runs \
  -H 'content-type: application/json' \
  -d '{"scenario_yaml":"version: 1\nname: s\nsteps:\n  - type: http\n    id: 01HX0000000000000000000099\n    name: down\n    request:\n      method: GET\n      url: http://127.0.0.1:1/nope\n","env":{},"max_requests":5}'

# Bad YAML → 422
curl -s -w '\n%{http_code}\n' -X POST localhost:8080/api/test-runs \
  -H 'content-type: application/json' -d '{"scenario_yaml":"nonsense","env":{}}'
```

---

## C-1 Completion Checklist

- [ ] `render_collecting` reports unresolved tokens; hot-path `render`/`render_lenient` unchanged.
- [ ] Trace types serde round-trip; `StepKind` serializes lowercase.
- [ ] `execute_step_traced` captures request + response (body truncated at 16 KiB) + unbound + extracts; `execute_step` byte-identical.
- [ ] `select_branch` extracted; all existing engine if/loop tests green (behavior-preserving).
- [ ] `trace_scenario`: flat order, loop `loop_index`, if decision row, `max_requests` truncation, unbound non-fatal — all covered.
- [ ] `ApiError::Unprocessable` → 422; legacy 400 untouched; divergence documented in controller CLAUDE.md.
- [ ] `POST /api/test-runs`: 422 on bad YAML / out-of-range cap; 200 trace otherwise; unknown `runner` ignored.
- [ ] `cargo fmt --all` clean, `cargo clippy --workspace --all-targets -- -D warnings` clean, `cargo test --workspace` green.

**Out of scope (C-2 / follow-ups):** editor Test-run button, `<EnvironmentPicker>` reuse, `TestRunPanel` UI, worker-path runner (spec §8-3), response-driven extract authoring (§8-1), manual var overrides (§8-2).
