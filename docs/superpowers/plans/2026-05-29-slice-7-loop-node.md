# Slice 7 — Loop Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first control-flow node — `loop` (repeat-count, single-level) — to the scenario model end-to-end: engine recursion, `${loop_index}`, canvas container node, YAML round-trip, inspector, and report labelling.

**Architecture:** The scenario step list becomes a tree. `Step` turns from a flat struct into an internally-tagged enum (`Http` / `Loop`); the engine interpreter recurses over step lists, running a loop's body `repeat` times. The UI mirrors this with a Zod discriminated union, a tree-aware YAML path finder, and a React Flow parent/child container node. The engine permits arbitrary nesting (free recursion); single-level (`loop` contains only `http`) is enforced by the UI Zod schema — this keeps the engine simple and sets up Slice 8 (conditional) / Slice 9 (parallel) as the same container pattern.

**Tech Stack:** Rust (serde_yaml 0.9 internally-tagged enum, tokio, wiremock, proptest) · TypeScript/React (Zod discriminated union, `yaml` Document API, React Flow `@xyflow/react` v12 subflows, Zustand, vitest/RTL/fast-check).

**Spec:** `docs/superpowers/specs/2026-05-29-slice-7-loop-node-design.md`

**Deviation from spec §4.1:** spec wrote `LoopStep.do_: Vec<HttpStep>` to forbid nesting at the type level. This plan uses `do_: Vec<Step>` instead, because internal tagging on `Vec<HttpStep>` would strip `type: http` from serialized inner steps (contradicting the spec's own canonical YAML in §3, which shows `type: http` inside `do`). Single-level is enforced in the UI Zod schema (`do: z.array(HttpStepModel)`). Rationale recorded in ADR-0020 (Task 12).

---

## File Structure

**Engine (`crates/engine/src/`)**
- `scenario.rs` — `Step` enum + `HttpStep` + `LoopStep`; accessors. **Most-changed file.**
- `executor.rs` — `execute_step` takes `&HttpStep` (was `&Step`).
- `runner.rs` — recursive `execute_steps`; sets `loop_index` per iteration.
- `template.rs` — `TemplateContext.loop_index`; `${loop_index}` in `render`.
- `lib.rs` — re-export `HttpStep`, `LoopStep`; drop `StepKind`.
- `tests/proptests.rs` — `arb_step` builds `Step::Http(HttpStep{..})`; add `arb_loop`.
- `tests/loop_node.rs` — **new** wiremock integration (count = repeat × iters; cancel mid-loop; extract persists).

**Controller (`crates/controller/src/`)** — **no change.** `report.rs::build_report` groups metrics by `step_id` from the DB; it never walks scenario YAML. (Verified: `report.rs:99-156`.)

**UI (`ui/src/`)**
- `scenario/model.ts` — `HttpStepModel` / `LoopStepModel` / `StepModel` discriminated union; `isHttpStep`/`isLoopStep`; `flattenHttpSteps`.
- `scenario/yamlDoc.ts` — `findStepPath` (tree); `normalizeStep` branch; new `Edit` variants.
- `scenario/store.ts` — `addLoopStep` / `addStepInLoop` / `setLoopRepeat` actions.
- `components/scenario/LoopStepNode.tsx` — **new** container node component.
- `components/scenario/CanvasView.tsx` — parent/child layout; add-loop + add-step-in-loop.
- `components/scenario/Inspector.tsx` — branch to `LoopInspector`.
- `components/report/ReportView.tsx` + `pages/RunDetailPage.tsx` — use `flattenHttpSteps`.

---

## Task 1: Engine model — `Step` enum

**Files:**
- Modify: `crates/engine/src/scenario.rs`
- Modify: `crates/engine/src/lib.rs:15`
- Modify: `crates/engine/src/executor.rs:10,41-45,107,117,128,135,142,150,167-200,228-...`
- Modify: `crates/engine/src/runner.rs:13,167-189`
- Modify: `crates/engine/tests/proptests.rs:9-11,60-86`

This is the irreducible "change the type, fix every call site, end green" unit. The TDD-guard hook is satisfied because Step 1 edits the inline `#[cfg(test)] mod tests` in `scenario.rs` (a pending test diff) before touching `runner.rs`/`lib.rs`.

- [ ] **Step 1: Write the failing tests** (in `scenario.rs`, inside `mod tests`)

```rust
    #[test]
    fn parses_loop_step() {
        let y = r#"
version: 1
name: loopy
steps:
  - id: "01HX0000000000000000000001"
    name: repeat-add
    type: loop
    repeat: 3
    do:
      - id: "01HX0000000000000000000002"
        name: add
        type: http
        request: { method: POST, url: "/cart" }
        assert:
          - status: 200
"#;
        let s = Scenario::from_yaml(y).expect("parses loop");
        assert_eq!(s.steps.len(), 1);
        match &s.steps[0] {
            Step::Loop(l) => {
                assert_eq!(l.id, "01HX0000000000000000000001");
                assert_eq!(l.repeat, 3);
                assert_eq!(l.do_.len(), 1);
                assert!(matches!(l.do_[0], Step::Http(_)));
            }
            other => panic!("expected loop, got {other:?}"),
        }
    }

    #[test]
    fn loop_round_trips() {
        let y = r#"
version: 1
name: loopy
steps:
  - id: "01HX0000000000000000000001"
    name: repeat-add
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000002"
        name: add
        type: http
        request: { method: GET, url: "/x" }
        assert: []
"#;
        let s = Scenario::from_yaml(y).unwrap();
        let s2 = Scenario::from_yaml(&s.to_yaml().unwrap()).unwrap();
        assert_eq!(s, s2);
    }

    #[test]
    fn inner_http_step_keeps_type_tag_when_serialized() {
        let s = Scenario::from_yaml(
            "version: 1\nname: x\nsteps:\n  - id: \"01HX0000000000000000000001\"\n    name: l\n    type: loop\n    repeat: 1\n    do:\n      - id: \"01HX0000000000000000000002\"\n        name: h\n        type: http\n        request: { method: GET, url: \"/\" }\n        assert: []\n",
        )
        .unwrap();
        let out = s.to_yaml().unwrap();
        assert!(out.contains("type: http"), "inner step must keep type tag:\n{out}");
        assert!(out.contains("type: loop"));
    }
```

Also rewrite the existing http accessor assertions in `parses_single_step_fixture` (lines ~319-323) and `parses_two_step_fixture`/`parses_each_extract_variant` to match the new enum. Replace direct field access with a match:

```rust
    // in parses_single_step_fixture, replace the `let step = &s.steps[0];` block:
        let Step::Http(step) = &s.steps[0] else {
            panic!("expected http step");
        };
        assert_eq!(step.id, "root");
        assert_eq!(step.request.method, HttpMethod::Get);
        assert_eq!(step.request.url, "{{base_url}}/");
        assert_eq!(step.assert, vec![Assertion::Status(200)]);
```

Apply the same `let Step::Http(...) = ... else { panic! }` rewrite to every `s.steps[i]` access in the inline tests (`parses_two_step_fixture` lines 220-229, `parses_each_extract_variant` line 259, `parses_body_*` lines 383/411/437). Delete the `step.kind == StepKind::Http` assertion (the enum variant is the kind now).

- [ ] **Step 2: Run, verify it fails to compile**

Run: `cargo test -p handicap-engine scenario:: 2>&1 | head -30`
Expected: compile errors — `Step` is still a struct, `Step::Loop`/`Step::Http`/`l.do_` unknown.

- [ ] **Step 3: Rewrite the model in `scenario.rs`** (replace lines 32-50)

```rust
/// A scenario step. Internally-tagged on `type` so the YAML shape is
/// `{type: http, ...}` / `{type: loop, ...}` — matching the UI wire format and
/// ADR-0020. Internal tagging round-trips in serde_yaml 0.9 (proven by the
/// `Extract` enum, Slice 4). NOTE: serde does not enforce `deny_unknown_fields`
/// through internal tagging, so the engine is lenient about unknown fields
/// inside a step; the UI Zod schema (`ui/src/scenario/model.ts`) is the strict
/// authoring gate. `do_` is `Vec<Step>` (not `Vec<HttpStep>`) so the engine
/// supports nesting for free; single-level is enforced UI-side for Slice 7.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Step {
    Http(HttpStep),
    Loop(LoopStep),
}

impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::Http(h) => &h.id,
            Step::Loop(l) => &l.id,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Step::Http(h) => &h.name,
            Step::Loop(l) => &l.name,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HttpStep {
    pub id: String,
    pub name: String,
    pub request: Request,
    #[serde(default)]
    pub assert: Vec<Assertion>,
    #[serde(default)]
    pub extract: Vec<Extract>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LoopStep {
    pub id: String,
    pub name: String,
    pub repeat: u32,
    #[serde(rename = "do")]
    pub do_: Vec<Step>,
}
```

Delete the old `StepKind` enum (lines 46-50) entirely.

- [ ] **Step 4: Fix `lib.rs:15`**

```rust
pub use scenario::{
    Assertion, Body, CookieJarMode, HttpMethod, HttpStep, LoopStep, Request, Scenario, Step,
};
```

(Removed `StepKind`; added `HttpStep`, `LoopStep`.)

- [ ] **Step 5: Fix `executor.rs`** — `execute_step` operates on an `HttpStep`

In the `use` on line 10, replace `Step` with `HttpStep`:
```rust
use crate::scenario::{Assertion, Body, CookieJarMode, HttpMethod, HttpStep, Scenario};
```
Change the signature (line 41-45) and leave the body unchanged (all `step.request` / `step.assert` / `step.extract` / `step.id` accesses are now `HttpStep` fields):
```rust
pub async fn execute_step(
    client: &VuClient,
    step: &HttpStep,
    ctx: &TemplateContext<'_>,
) -> Result<ExecOutcome> {
```
In the `executor.rs` inline tests (lines 167-200, 228-...): change the `use` to `use crate::scenario::{Extract, HttpMethod, HttpStep, Request};` and replace each `Step { id, name, kind: StepKind::Http, request, assert, extract }` literal with `HttpStep { id, name, request, assert, extract }` (drop the `kind` field). `execute_step(&client, &step, &ctx)` now passes an `&HttpStep`.

- [ ] **Step 6: Fix `runner.rs`** — recursive dispatch (replace the `for step in &scenario.steps { ... }` body, lines 166-189)

Add the import (line 13): `use crate::executor::{VuClient, execute_step};` stays; add `use crate::scenario::{Scenario, Step};`.

Replace the per-iteration loop body in `run_vu`:
```rust
        // Per-iteration flow vars: start fresh from the scenario base.
        let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
        let res = execute_steps(
            &client, &scenario.steps, &mut iter_vars, &agg, deadline, &env, vu_id, iter_id, &cancel,
        )
        .await;
        match res {
            StepFlow::Continue => {}
            StepFlow::DeadlineReached => return Ok(()),
            StepFlow::Aborted => return Err(EngineError::Aborted),
        }
        iter_id = iter_id.wrapping_add(1);
```

Add, below `run_vu`, the recursive executor and a small control-flow enum:
```rust
enum StepFlow {
    Continue,
    DeadlineReached,
    Aborted,
}

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
    cancel: &CancellationToken,
) -> StepFlow {
    for step in steps {
        if Instant::now() >= deadline {
            return StepFlow::DeadlineReached;
        }
        if cancel.is_cancelled() {
            return StepFlow::Aborted;
        }
        match step {
            Step::Http(http) => {
                let ctx = TemplateContext {
                    vars: iter_vars,
                    env: env.as_ref(),
                    vu_id,
                    iter_id,
                    loop_index: None,
                };
                let outcome = match execute_step(client, http, &ctx).await {
                    Ok(o) => o,
                    Err(EngineError::Aborted) => return StepFlow::Aborted,
                    Err(e) => {
                        warn!(vu_id, error = ?e, "step failed");
                        return StepFlow::Aborted;
                    }
                };
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
                        return StepFlow::DeadlineReached;
                    }
                    if cancel.is_cancelled() {
                        return StepFlow::Aborted;
                    }
                    // loop_index is threaded via TemplateContext at the Http leaf
                    // (Task 2 wires it). For now nested steps run with their own
                    // context; the loop body is the recursive call below.
                    let flow = Box::pin(execute_steps_with_loop_index(
                        client, &lp.do_, iter_vars, agg, deadline, env, vu_id, iter_id, Some(i),
                        cancel,
                    ))
                    .await;
                    match flow {
                        StepFlow::Continue => {}
                        other => return other,
                    }
                }
            }
        }
    }
    StepFlow::Continue
}
```

> NOTE FOR IMPLEMENTER: To avoid duplicating the body, in Task 2 you will collapse `execute_steps` and `execute_steps_with_loop_index` into a single function carrying a `loop_index: Option<u32>` parameter threaded into `TemplateContext`. For Task 1, write the single function `execute_steps` WITHOUT the loop-index plumbing — give `Step::Loop` a body that recurses via `Box::pin(execute_steps(...))` (recursion in an `async fn` needs boxing). The `execute_steps_with_loop_index` reference above is a forward-declaration of the Task 2 shape; in Task 1 just recurse into `execute_steps` and pass `loop_index: None` at the Http leaf. Keep it compiling and green.

Task 1 concrete recursion (no loop_index yet) — use this exact `Step::Loop` arm in Task 1:
```rust
            Step::Loop(lp) => {
                for _ in 0..lp.repeat {
                    let flow = Box::pin(execute_steps(
                        client, &lp.do_, iter_vars, agg, deadline, env, vu_id, iter_id, cancel,
                    ))
                    .await;
                    match flow {
                        StepFlow::Continue => {}
                        other => return other,
                    }
                }
            }
```

- [ ] **Step 7: Fix `proptests.rs`** (lines 9-11, 60-86)

Change the import: `use handicap_engine::scenario::{Assertion, Body, CookieJarMode, Extract, HttpMethod, HttpStep, LoopStep, Request, Step};` (drop `StepKind`).

Rename `arb_step` → `arb_http_step` returning `HttpStep` (drop `kind`), then add an `arb_step` that wraps it and occasionally produces a loop:
```rust
fn arb_http_step() -> impl Strategy<Value = HttpStep> {
    (
        "[0-9A-HJKMNP-TV-Z]{26}",
        arb_ident(),
        arb_http_method(),
        "(/[a-z0-9/_-]{0,20}|\\{\\{[a-z]{1,5}\\}\\}/[a-z0-9/_-]{0,10})",
        btree_map("[A-Za-z][A-Za-z0-9-]{0,10}", ".*", 0..3),
        option::of(arb_body()),
        vec(arb_assertion(), 0..3),
        vec(arb_extract(), 0..3),
    )
        .prop_map(|(id, name, method, url, headers, body, assert, extract)| HttpStep {
            id,
            name,
            request: Request { method, url, headers, body },
            assert,
            extract,
        })
}

fn arb_step() -> impl Strategy<Value = Step> {
    prop_oneof![
        4 => arb_http_step().prop_map(Step::Http),
        1 => (
            "[0-9A-HJKMNP-TV-Z]{26}",
            arb_ident(),
            1u32..4u32,
            vec(arb_http_step().prop_map(Step::Http), 1..3),
        )
            .prop_map(|(id, name, repeat, do_)| Step::Loop(LoopStep { id, name, repeat, do_ })),
    ]
}
```
The `arb_scenario` `vec(arb_step(), 0..4)` line is unchanged. The existing `scenario_yaml_round_trip` proptest now also covers loops.

- [ ] **Step 8: Run the whole engine suite to green**

Run: `cargo test -p handicap-engine 2>&1 | tail -30`
Expected: all pass, including `parses_loop_step`, `loop_round_trips`, `inner_http_step_keeps_type_tag_when_serialized`, and `scenario_yaml_round_trip` (now exercising loops).

Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add crates/engine/src/scenario.rs crates/engine/src/lib.rs crates/engine/src/executor.rs crates/engine/src/runner.rs crates/engine/tests/proptests.rs
git commit -m "feat(engine): Step enum with loop variant (recursive step tree)"
```

---

## Task 2: `${loop_index}` system variable

**Files:**
- Modify: `crates/engine/src/template.rs:5-11,49-59`
- Modify: `crates/engine/src/runner.rs` (thread `loop_index` into `TemplateContext`)
- Modify: `crates/engine/src/executor.rs` test `TemplateContext` literals (add `loop_index: None`)
- Modify: `crates/engine/tests/proptests.rs:109` (`TemplateContext` literal)

- [ ] **Step 1: Write the failing test** (in `template.rs` `mod tests`)

```rust
    #[test]
    fn renders_loop_index_when_set() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: Some(2),
        };
        assert_eq!(render("item-${loop_index}", &ctx).unwrap(), "item-2");
    }

    #[test]
    fn loop_index_outside_loop_errors() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert!(matches!(
            render("${loop_index}", &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }
```

Add `loop_index: None` (or a value) to EVERY existing `TemplateContext { .. }` literal in `template.rs`'s tests (there are ~13) — otherwise they won't compile.

- [ ] **Step 2: Run, verify failure**

Run: `cargo test -p handicap-engine template:: 2>&1 | head -20`
Expected: compile error — `TemplateContext` has no field `loop_index`.

- [ ] **Step 3: Add the field and the resolver**

`template.rs` struct (lines 5-11):
```rust
#[derive(Debug, Clone)]
pub struct TemplateContext<'a> {
    pub vars: &'a BTreeMap<String, String>,
    pub env: &'a BTreeMap<String, String>,
    pub vu_id: u32,
    pub iter_id: u32,
    /// Current loop iteration index (0-based), or `None` outside any loop.
    pub loop_index: Option<u32>,
}
```
In `render`, extend the `match name` (lines 49-59):
```rust
            let value = match name {
                "vu_id" => ctx.vu_id.to_string(),
                "iter_id" => ctx.iter_id.to_string(),
                "loop_index" => match ctx.loop_index {
                    Some(i) => i.to_string(),
                    None => return Err(EngineError::UnknownVar("loop_index".to_string())),
                },
                other => match ctx.env.get(other) {
                    Some(v) => v.clone(),
                    None => match default {
                        Some(d) => d,
                        None => return Err(EngineError::UnknownVar(other.to_string())),
                    },
                },
            };
```

- [ ] **Step 4: Thread `loop_index` through the runner**

Collapse Task 1's recursion into a single function carrying `loop_index: Option<u32>`. In `runner.rs`, change `execute_steps`'s signature to add `loop_index: Option<u32>`, pass it into the Http leaf's `TemplateContext`, and in the `Step::Loop` arm pass `Some(i)` for the loop counter:
```rust
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
) -> StepFlow {
    for step in steps {
        // ... deadline/cancel guards unchanged ...
        match step {
            Step::Http(http) => {
                let ctx = TemplateContext { vars: iter_vars, env: env.as_ref(), vu_id, iter_id, loop_index };
                // ... unchanged ...
            }
            Step::Loop(lp) => {
                for i in 0..lp.repeat {
                    if Instant::now() >= deadline { return StepFlow::DeadlineReached; }
                    if cancel.is_cancelled() { return StepFlow::Aborted; }
                    let flow = Box::pin(execute_steps(
                        client, &lp.do_, iter_vars, agg, deadline, env, vu_id, iter_id, Some(i), cancel,
                    )).await;
                    match flow { StepFlow::Continue => {}, other => return other }
                }
            }
        }
    }
    StepFlow::Continue
}
```
Update the call in `run_vu` to pass `None` for the top-level `loop_index`:
```rust
        let res = execute_steps(
            &client, &scenario.steps, &mut iter_vars, &agg, deadline, &env, vu_id, iter_id, None, &cancel,
        ).await;
```

> Single-level note: because `loop_index` is a scalar (not a stack), a nested loop would shadow the outer index. That is acceptable — the UI forbids nested loops in Slice 7. The nested-loop slice (spec §8) will replace this with a scoped map.

- [ ] **Step 5: Fix remaining `TemplateContext` literals**

`executor.rs` tests (2 literals, ~line 203, 246) and `proptests.rs:109` — add `loop_index: None`.

- [ ] **Step 6: Run to green + clippy**

Run: `cargo test -p handicap-engine 2>&1 | tail -15`
Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings`
Expected: all green, clippy clean.

- [ ] **Step 7: Commit**

```bash
git add crates/engine/src/template.rs crates/engine/src/runner.rs crates/engine/src/executor.rs crates/engine/tests/proptests.rs
git commit -m "feat(engine): \${loop_index} system var threaded through loop recursion"
```

---

## Task 3: Loop execution — wiremock integration

**Files:**
- Create: `crates/engine/tests/loop_node.rs`

- [ ] **Step 1: Write the failing test** (the file IS the test — it drives the recursion correctness)

```rust
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A loop with repeat=3 wrapping one GET, run with 1 VU for a fixed window,
/// must record count == 3 * iterations on the inner step id.
#[tokio::test]
async fn loop_body_executes_repeat_times_per_iteration() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/tick"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(5)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: loop-count
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: repeat
    type: loop
    repeat: 3
    do:
      - id: "01HX0000000000000000000002"
        name: tick
        type: http
        request:
          method: GET
          url: "{{{{base}}}}/tick"
        assert:
          - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel).await.expect("runs") });

    let mut tick_count: u64 = 0;
    let mut errors: u64 = 0;
    let mut iters_seen: u64 = 0; // not directly observable; assert multiple-of-3 instead
    while let Some(batch) = rx.recv().await {
        for w in batch {
            if w.step_id == "01HX0000000000000000000002" {
                tick_count += w.count;
                errors += w.error_count;
            }
        }
    }
    let _ = iters_seen;
    run.await.expect("join");

    assert_eq!(errors, 0, "no errors expected");
    assert!(tick_count >= 3, "at least one full loop (3 ticks), got {tick_count}");
    assert_eq!(tick_count % 3, 0, "tick count must be a multiple of repeat=3, got {tick_count}");
}

/// `${loop_index}` resolves to 0..repeat inside the loop body — wiremock sees
/// distinct paths /item/0, /item/1, /item/2.
#[tokio::test]
async fn loop_index_renders_in_request() {
    let server = MockServer::start().await;
    for i in 0..3 {
        Mock::given(method("GET"))
            .and(path(format!("/item/{i}")))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
    }
    let yaml = format!(
        r#"
version: 1
name: loop-index
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: repeat
    type: loop
    repeat: 3
    do:
      - id: "01HX0000000000000000000002"
        name: item
        type: http
        request:
          method: GET
          url: "{{{{base}}}}/item/${{loop_index}}"
        assert:
          - status: 200
"#,
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan { vus: 1, ramp_up: Duration::from_secs(0), duration: Duration::from_secs(1), env: BTreeMap::new() };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel).await.expect("runs") });
    let mut errors: u64 = 0;
    let mut total: u64 = 0;
    while let Some(batch) = rx.recv().await {
        for w in batch { total += w.count; errors += w.error_count; }
    }
    run.await.expect("join");
    assert!(total > 0);
    // All three /item/{i} are stubbed; an unrendered ${loop_index} would 404 → assert error.
    assert_eq!(errors, 0, "every /item/<loop_index> must match a stub");
}

/// Cancellation lands quickly even with a large repeat (checked between iterations).
#[tokio::test]
async fn cancel_lands_mid_loop() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/p"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(20)))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: big-loop
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: repeat
    type: loop
    repeat: 100000
    do:
      - id: "01HX0000000000000000000002"
        name: p
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/p" }}
        assert: []
"#,
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan { vus: 2, ramp_up: Duration::from_secs(0), duration: Duration::from_secs(30), env: BTreeMap::new() };
    let cancel = CancellationToken::new();
    let cancel2 = cancel.clone();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel2).await });
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    tokio::time::sleep(Duration::from_millis(300)).await;
    cancel.cancel();
    let started = std::time::Instant::now();
    let r = run.await.expect("join");
    drain.await.ok();
    assert!(matches!(r, Err(handicap_engine::EngineError::Aborted)));
    assert!(started.elapsed() < Duration::from_secs(6), "cancel within 6s");
}
```

- [ ] **Step 2: Run, verify pass** (the recursion from Tasks 1–2 should already satisfy these)

Run: `cargo test -p handicap-engine --test loop_node 2>&1 | tail -20`
Expected: 3 tests pass. If `loop_body_executes_repeat_times_per_iteration` fails with a count not divisible by 3, the deadline is cutting a loop mid-body — that is acceptable ONLY at the very end; if it fails, reduce `repeat` to 3 and confirm at least one clean multiple. If `loop_index_renders_in_request` shows errors, `${loop_index}` is not being threaded (revisit Task 2 Step 4).

- [ ] **Step 3: Commit**

```bash
git add crates/engine/tests/loop_node.rs
git commit -m "test(engine): loop integration — count×repeat, loop_index render, cancel mid-loop"
```

---

## Task 4: UI model — discriminated union

**Files:**
- Modify: `ui/src/scenario/model.ts:69-93`
- Test: `ui/src/scenario/__tests__/model.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { ScenarioModel, isLoopStep, isHttpStep, flattenHttpSteps } from "../model";

const LOOP_YAML_JS = {
  version: 1,
  name: "x",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000001",
      name: "loop",
      type: "loop",
      repeat: 3,
      do: [
        {
          id: "01HX0000000000000000000002",
          name: "h",
          type: "http",
          request: { method: "GET", url: "/x", headers: {} },
          assert: [],
          extract: [],
        },
      ],
    },
  ],
};

describe("loop step model", () => {
  it("accepts a valid loop step", () => {
    const r = ScenarioModel.safeParse(LOOP_YAML_JS);
    expect(r.success).toBe(true);
    if (r.success) {
      const s = r.data.steps[0];
      expect(isLoopStep(s)).toBe(true);
      expect(isHttpStep(s)).toBe(false);
    }
  });

  it("rejects repeat = 0", () => {
    const bad = structuredClone(LOOP_YAML_JS);
    bad.steps[0].repeat = 0;
    expect(ScenarioModel.safeParse(bad).success).toBe(false);
  });

  it("rejects a nested loop inside do (single-level)", () => {
    const bad = structuredClone(LOOP_YAML_JS);
    (bad.steps[0].do as unknown[]).push({
      id: "01HX0000000000000000000003",
      name: "inner-loop",
      type: "loop",
      repeat: 2,
      do: [],
    });
    expect(ScenarioModel.safeParse(bad).success).toBe(false);
  });

  it("rejects request key on a loop step", () => {
    const bad = structuredClone(LOOP_YAML_JS) as Record<string, unknown>;
    (bad.steps as Record<string, unknown>[])[0].request = { method: "GET", url: "/" };
    expect(ScenarioModel.safeParse(bad).success).toBe(false);
  });

  it("flattenHttpSteps recurses into loop bodies", () => {
    const r = ScenarioModel.safeParse(LOOP_YAML_JS);
    expect(r.success).toBe(true);
    if (r.success) {
      const flat = flattenHttpSteps(r.data.steps);
      expect(flat.map((s) => s.id)).toEqual(["01HX0000000000000000000002"]);
    }
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd ui && pnpm test -- model 2>&1 | tail -20`
Expected: FAIL — `isLoopStep`/`flattenHttpSteps` not exported; `StepModel` doesn't accept `type: loop`.

- [ ] **Step 3: Rewrite `model.ts` (lines 69-93) + add helpers**

```ts
export const HttpStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("http"),
    request: RequestModel,
    assert: z.array(AssertionModel).default([]),
    extract: z.array(ExtractModel).default([]),
  })
  .strict();
export type HttpStep = z.infer<typeof HttpStepModel>;

export const LoopStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("loop"),
    repeat: z.number().int().min(1, "repeat must be >= 1"),
    // do: http only — single-level for Slice 7. Nested loops rejected here.
    do: z.array(HttpStepModel).min(1, "loop body needs at least one step"),
  })
  .strict();
export type LoopStep = z.infer<typeof LoopStepModel>;

export const StepModel = z.discriminatedUnion("type", [HttpStepModel, LoopStepModel]);
export type Step = z.infer<typeof StepModel>;

export function isLoopStep(s: Step): s is LoopStep {
  return s.type === "loop";
}
export function isHttpStep(s: Step): s is HttpStep {
  return s.type === "http";
}

/** Depth-first list of every http step, recursing into loop bodies. */
export function flattenHttpSteps(steps: ReadonlyArray<Step>): HttpStep[] {
  const out: HttpStep[] = [];
  for (const s of steps) {
    if (s.type === "http") out.push(s);
    else out.push(...s.do);
  }
  return out;
}
```
Keep `ScenarioModel.steps: z.array(StepModel)` — the field name is unchanged, only `StepModel` changed. `newEmptyScenario` is unchanged (`steps: []`).

- [ ] **Step 4: Run to green**

Run: `cd ui && pnpm test -- model 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/model.ts ui/src/scenario/__tests__/model.test.ts
git commit -m "feat(ui): loop step model (discriminated union) + flattenHttpSteps"
```

---

## Task 5: yamlDoc — tree paths + loop edits

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts`
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts` (append; create if absent)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { parseScenarioDoc, applyEdit, serializeDoc } from "../yamlDoc";

const BASE = `version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: top
    type: http
    request:
      method: GET
      url: "/top" # keep this comment
    assert: []
`;

function parse(y: string) {
  const r = parseScenarioDoc(y);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("yamlDoc loop edits", () => {
  it("addLoopStep appends a loop with one placeholder http step", () => {
    const { doc } = parse(BASE);
    applyEdit(doc, { type: "addLoopStep", id: "01HX000000000000000000000L", name: "Loop 1", childId: "01HX000000000000000000000C" });
    const r = parseScenarioDoc(serializeDoc(doc));
    if ("error" in r) throw new Error(r.error);
    const loop = r.model.steps[1];
    expect(loop.type).toBe("loop");
    if (loop.type === "loop") {
      expect(loop.repeat).toBe(1);
      expect(loop.do).toHaveLength(1);
      expect(loop.do[0].id).toBe("01HX000000000000000000000C");
    }
  });

  it("addStepInLoop appends an http step into the loop body", () => {
    const { doc } = parse(BASE);
    applyEdit(doc, { type: "addLoopStep", id: "01HX000000000000000000000L", name: "Loop", childId: "01HX000000000000000000000C" });
    applyEdit(doc, { type: "addStepInLoop", loopId: "01HX000000000000000000000L", id: "01HX000000000000000000000D", name: "second" });
    const r = parse(serializeDoc(doc));
    const loop = r.model.steps[1];
    if (loop.type === "loop") expect(loop.do.map((s) => s.id)).toEqual(["01HX000000000000000000000C", "01HX000000000000000000000D"]);
  });

  it("setLoopRepeat updates repeat", () => {
    const { doc } = parse(BASE);
    applyEdit(doc, { type: "addLoopStep", id: "01HX000000000000000000000L", name: "Loop", childId: "01HX000000000000000000000C" });
    applyEdit(doc, { type: "setLoopRepeat", loopId: "01HX000000000000000000000L", repeat: 7 });
    const r = parse(serializeDoc(doc));
    const loop = r.model.steps[1];
    if (loop.type === "loop") expect(loop.repeat).toBe(7);
  });

  it("setStepField targets a step nested inside a loop", () => {
    const { doc } = parse(BASE);
    applyEdit(doc, { type: "addLoopStep", id: "01HX000000000000000000000L", name: "Loop", childId: "01HX000000000000000000000C" });
    applyEdit(doc, { type: "setStepField", stepId: "01HX000000000000000000000C", path: ["request", "url"], value: "/inner" });
    const r = parse(serializeDoc(doc));
    const loop = r.model.steps[1];
    if (loop.type === "loop" && loop.do[0].type === "http") expect(loop.do[0].request.url).toBe("/inner");
  });

  it("preserves a comment on a sibling key after a nested edit", () => {
    const { doc } = parse(BASE);
    applyEdit(doc, { type: "setStepField", stepId: "01HX0000000000000000000001", path: ["request", "method"], value: "POST" });
    expect(serializeDoc(doc)).toContain("# keep this comment");
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd ui && pnpm test -- yamlDoc 2>&1 | tail -20`
Expected: FAIL — unknown edit types; `findStepIndex` can't see nested steps.

- [ ] **Step 3: Add `findStepPath`, branch `normalizeStep`, add edits**

Replace `findStepIndex` (lines 164-174) with a tree-aware path finder (keep the no-op-on-miss contract):
```ts
/** Full doc path to the step with `stepId`, searching top-level and one level
 * of loop `do`. Returns null if not found (callers no-op — stale ids can arrive
 * after a step was removed via the YAML pane). */
function findStepPath(doc: Document, stepId: string): Array<string | number> | null {
  const steps = doc.getIn(["steps"]);
  if (!isSeq(steps)) return null;
  for (let i = 0; i < steps.items.length; i++) {
    const item = steps.items[i] as Node;
    if (!isMap(item)) continue;
    if (item.get("id") === stepId) return ["steps", i];
    const body = item.get("do");
    if (isSeq(body)) {
      for (let j = 0; j < body.items.length; j++) {
        const inner = body.items[j] as Node;
        if (isMap(inner) && inner.get("id") === stepId) return ["steps", i, "do", j];
      }
    }
  }
  return null;
}
```

Add the new `Edit` variants (extend the union at lines 17-45):
```ts
  | { type: "addLoopStep"; id: string; name: string; childId: string }
  | { type: "addStepInLoop"; loopId: string; id: string; name: string }
  | { type: "setLoopRepeat"; loopId: string; repeat: number }
```

In `applyEdit`, rewrite the step cases to use `findStepPath`, and add the loop cases:
```ts
    case "addStep": {
      ensureSeq(doc, ["steps"]);
      const steps = doc.getIn(["steps"]) as YAMLSeq;
      steps.add(doc.createNode({
        id: edit.id, name: edit.name, type: "http",
        request: { method: "GET", url: "/" }, assert: [{ status: 200 }],
      }));
      return;
    }
    case "addLoopStep": {
      ensureSeq(doc, ["steps"]);
      const steps = doc.getIn(["steps"]) as YAMLSeq;
      steps.add(doc.createNode({
        id: edit.id, name: edit.name, type: "loop", repeat: 1,
        do: [{ id: edit.childId, name: "Step 1", type: "http", request: { method: "GET", url: "/" }, assert: [{ status: 200 }] }],
      }));
      return;
    }
    case "addStepInLoop": {
      const loopPath = findStepPath(doc, edit.loopId);
      if (loopPath === null) return;
      ensureSeq(doc, [...loopPath, "do"]);
      const body = doc.getIn([...loopPath, "do"]) as YAMLSeq;
      body.add(doc.createNode({
        id: edit.id, name: edit.name, type: "http",
        request: { method: "GET", url: "/" }, assert: [{ status: 200 }],
      }));
      return;
    }
    case "setLoopRepeat": {
      const loopPath = findStepPath(doc, edit.loopId);
      if (loopPath === null) return;
      doc.setIn([...loopPath, "repeat"], edit.repeat);
      return;
    }
    case "removeStep": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      doc.deleteIn(path);
      return;
    }
    case "moveStep": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      const parentPath = path.slice(0, -1);
      const fromIdx = path[path.length - 1] as number;
      const parent = doc.getIn(parentPath) as YAMLSeq;
      const node = parent.items[fromIdx];
      parent.items.splice(fromIdx, 1);
      parent.items.splice(edit.toIndex, 0, node);
      return;
    }
    case "setStepField": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      const fullPath: Array<string | number> = [...path, ...edit.path];
      if (edit.value === undefined) { doc.deleteIn(fullPath); return; }
      const node = typeof edit.value === "object" && edit.value !== null ? doc.createNode(edit.value) : edit.value;
      doc.setIn(fullPath, node);
      return;
    }
    case "setStepAssert": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      doc.setIn([...path, "assert"], doc.createNode(edit.asserts.map((a) => ({ status: a.code }))));
      return;
    }
    case "setStepExtract": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      if (edit.extract.length === 0) { doc.deleteIn([...path, "extract"]); return; }
      doc.setIn([...path, "extract"], doc.createNode(edit.extract));
      return;
    }
```

Branch `normalizeStep` (lines 206-225) on `type` so loop steps pass through with a recursively-normalized body:
```ts
function normalizeStep(s: unknown): unknown {
  if (typeof s !== "object" || s === null) return s;
  const src = s as Record<string, unknown>;
  if (src.type === "loop") {
    return {
      id: src.id,
      name: src.name,
      type: "loop",
      repeat: src.repeat,
      do: Array.isArray(src.do) ? src.do.map(normalizeStep) : [],
    };
  }
  const request =
    typeof src.request === "object" && src.request !== null
      ? normalizeRequest(src.request as Record<string, unknown>)
      : src.request;
  const assert = Array.isArray(src.assert) ? src.assert.map(normalizeAssertion) : [];
  const extract = Array.isArray(src.extract) ? src.extract : [];
  return { id: src.id, name: src.name, type: src.type, request, assert, extract };
}
```

- [ ] **Step 4: Add a loop case to the fast-check round-trip property**

If `ui/src/scenario/__tests__/` has a fast-check round-trip test (search for `fc.` / `roundTrip`), extend its step arbitrary to occasionally emit a loop wrapping 1-2 http steps. Use explicit `as const` on `type` literals to avoid the `Arbitrary<string>` widening trap (CLAUDE.md Slice 4 note). If no such test exists, add `roundTrip_loop` to the yamlDoc test: build a model with a loop, serialize via the doc, re-parse, assert deep-equal on `steps`.

- [ ] **Step 5: Run to green**

Run: `cd ui && pnpm test -- yamlDoc 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git commit -m "feat(ui): tree-aware yaml step paths + loop edits (add/addInLoop/setRepeat)"
```

---

## Task 6: store — loop actions

**Files:**
- Modify: `ui/src/scenario/store.ts`
- Test: `ui/src/scenario/__tests__/store.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";

const reset = () =>
  useScenarioEditor.setState(
    (useScenarioEditor as unknown as { getInitialState: () => ReturnType<typeof useScenarioEditor.getState> }).getInitialState(),
  );

describe("store loop actions", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("addLoopStep adds a loop containing one http step", () => {
    const id = useScenarioEditor.getState().addLoopStep("Loop 1");
    const steps = useScenarioEditor.getState().model!.steps;
    const loop = steps.find((s) => s.id === id)!;
    expect(loop.type).toBe("loop");
    if (loop.type === "loop") expect(loop.do).toHaveLength(1);
  });

  it("addStepInLoop appends to the loop body", () => {
    const loopId = useScenarioEditor.getState().addLoopStep("Loop");
    useScenarioEditor.getState().addStepInLoop(loopId, "inner-2");
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    if (loop.type === "loop") expect(loop.do).toHaveLength(2);
  });

  it("setLoopRepeat updates repeat", () => {
    const loopId = useScenarioEditor.getState().addLoopStep("Loop");
    useScenarioEditor.getState().setLoopRepeat(loopId, 5);
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    if (loop.type === "loop") expect(loop.repeat).toBe(5);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd ui && pnpm test -- store 2>&1 | tail -20`
Expected: FAIL — `addLoopStep`/`addStepInLoop`/`setLoopRepeat` not functions.

- [ ] **Step 3: Add the actions**

In `ScenarioEditorState` (after `addStep`, line 40):
```ts
  addLoopStep(name: string): string; // returns new loop id
  addStepInLoop(loopId: string, name: string): string; // returns new child id
  setLoopRepeat(loopId: string, repeat: number): void;
```
In the store body (after `addStep`, line 116):
```ts
  addLoopStep(name) {
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addLoopStep", id, name, childId });
    return id;
  },
  addStepInLoop(loopId, name) {
    const id = newStepId();
    dispatch(set, get, { type: "addStepInLoop", loopId, id, name });
    return id;
  },
  setLoopRepeat(loopId, repeat) {
    dispatch(set, get, { type: "setLoopRepeat", loopId, repeat });
  },
```
Add all three to the `actions` capture object (lines 200-221) so `getInitialState` keeps them after a reset:
```ts
    addLoopStep: s.addLoopStep,
    addStepInLoop: s.addStepInLoop,
    setLoopRepeat: s.setLoopRepeat,
```

- [ ] **Step 4: Run to green**

Run: `cd ui && pnpm test -- store 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/store.ts ui/src/scenario/__tests__/store.test.ts
git commit -m "feat(ui): store actions addLoopStep / addStepInLoop / setLoopRepeat"
```

---

## Task 7: Canvas — loop container node

**Files:**
- Create: `ui/src/components/scenario/LoopStepNode.tsx`
- Modify: `ui/src/components/scenario/CanvasView.tsx`
- Test: `ui/src/components/scenario/__tests__/CanvasView.test.tsx` (append; create if absent)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanvasView } from "../CanvasView";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () =>
  useScenarioEditor.setState(
    (useScenarioEditor as unknown as { getInitialState: () => ReturnType<typeof useScenarioEditor.getState> }).getInitialState(),
  );

describe("CanvasView loop node", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("renders a loop container with its inner step and a repeat badge", async () => {
    const loopId = useScenarioEditor.getState().addLoopStep("Checkout loop");
    useScenarioEditor.getState().setLoopRepeat(loopId, 4);
    render(<CanvasView />);
    expect(screen.getByText("Checkout loop")).toBeInTheDocument();
    expect(screen.getByText(/×\s*4/)).toBeInTheDocument(); // repeat badge
  });

  it("has an Add loop button that creates a loop", async () => {
    const user = userEvent.setup();
    render(<CanvasView />);
    await user.click(screen.getByRole("button", { name: /add loop/i }));
    const steps = useScenarioEditor.getState().model!.steps;
    expect(steps.some((s) => s.type === "loop")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd ui && pnpm test -- CanvasView 2>&1 | tail -20`
Expected: FAIL — no "Add loop" button, no repeat badge.

- [ ] **Step 3: Create `LoopStepNode.tsx`** (container parent node)

```tsx
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export interface LoopStepNodeData extends Record<string, unknown> {
  name: string;
  repeat: number;
  selected: boolean;
}

type LoopStepNodeType = Node<LoopStepNodeData, "loop">;

function LoopStepNodeImpl({ data }: NodeProps<LoopStepNodeType>) {
  const { name, repeat, selected } = data;
  return (
    <div
      className={
        "h-full w-full rounded-md border-2 border-dashed bg-slate-50/60 " +
        (selected ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-400")
      }
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <div className="flex items-center justify-between px-2 py-1">
        <span className="font-medium text-slate-900 truncate" title={name}>
          {name}
        </span>
        <span className="text-xs font-mono text-slate-600 bg-white border border-slate-300 rounded px-1.5">
          × {repeat}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
    </div>
  );
}

export const LoopStepNode = memo(LoopStepNodeImpl);
```

- [ ] **Step 4: Rewrite `CanvasView.tsx`** — parent/child layout

Key changes: register `loop` in `NODE_TYPES`; build nodes by walking the (possibly nested) model; a loop becomes a parent node sized to hold its children, each child is a node with `parentId: loop.id` + `extent: "parent"`; add an "Add loop" button; when a loop is selected, the "Add step" button adds into that loop. Replace the whole file:

```tsx
import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useScenarioEditor } from "../../scenario/store";
import { HttpStepNode, type HttpStepNodeData } from "./HttpStepNode";
import { LoopStepNode, type LoopStepNodeData } from "./LoopStepNode";
import { isLoopStep } from "../../scenario/model";

const NODE_TYPES = { http: HttpStepNode, loop: LoopStepNode };
const NODE_WIDTH = 220;
const NODE_GAP = 60;
const CHILD_H = 64;
const CHILD_GAP = 16;
const LOOP_HEADER_H = 36;
const LOOP_PAD = 12;

type AnyData = HttpStepNodeData | LoopStepNodeData;

export function CanvasView() {
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const addStep = useScenarioEditor((s) => s.addStep);
  const addLoopStep = useScenarioEditor((s) => s.addLoopStep);
  const addStepInLoop = useScenarioEditor((s) => s.addStepInLoop);

  // Is the current selection a loop (so "Add step" targets it)?
  const selectedLoopId = useMemo(() => {
    const sel = steps.find((s) => s.id === selectedStepId);
    return sel && isLoopStep(sel) ? sel.id : null;
  }, [steps, selectedStepId]);

  const nodes = useMemo<Array<Node<AnyData>>>(() => {
    const out: Array<Node<AnyData>> = [];
    let x = 0;
    for (const step of steps) {
      if (isLoopStep(step)) {
        const bodyH = Math.max(1, step.do.length) * (CHILD_H + CHILD_GAP);
        const height = LOOP_HEADER_H + LOOP_PAD + bodyH;
        out.push({
          id: step.id,
          type: "loop",
          position: { x, y: 0 },
          data: { name: step.name, repeat: step.repeat, selected: step.id === selectedStepId },
          style: { width: NODE_WIDTH, height },
          draggable: false,
          selectable: false,
        });
        step.do.forEach((child, j) => {
          out.push({
            id: child.id,
            type: "http",
            parentId: step.id,
            extent: "parent",
            position: { x: LOOP_PAD, y: LOOP_HEADER_H + j * (CHILD_H + CHILD_GAP) },
            data: {
              name: child.name,
              method: child.request.method,
              url: child.request.url,
              selected: child.id === selectedStepId,
            },
            draggable: false,
            selectable: false,
          });
        });
        x += NODE_WIDTH + NODE_GAP;
      } else {
        out.push({
          id: step.id,
          type: "http",
          position: { x, y: 0 },
          data: {
            name: step.name,
            method: step.request.method,
            url: step.request.url,
            selected: step.id === selectedStepId,
          },
          draggable: false,
          selectable: false,
        });
        x += NODE_WIDTH + NODE_GAP;
      }
    }
    return out;
  }, [steps, selectedStepId]);

  // Edges only between top-level steps (the linear chain). Inner loop steps are
  // visually contained, not chained at the top level.
  const edges = useMemo<Edge[]>(
    () =>
      steps.slice(1).map((step, i) => ({
        id: `${steps[i].id}->${step.id}`,
        source: steps[i].id,
        target: step.id,
        type: "default",
      })),
    [steps],
  );

  const onNodeClick: NodeMouseHandler = (_e, node) => select(node.id);
  const onPaneClick = () => select(null);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-[400px] border border-slate-200 rounded-md overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="flex gap-2 mt-3">
        <button
          type="button"
          onClick={() => {
            if (selectedLoopId) {
              const id = addStepInLoop(selectedLoopId, `Step ${Date.now() % 1000}`);
              select(id);
            } else {
              const id = addStep(`Step ${steps.length + 1}`);
              select(id);
            }
          }}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
        >
          {selectedLoopId ? "+ Add step in loop" : "+ Add step"}
        </button>
        <button
          type="button"
          onClick={() => {
            const id = addLoopStep(`Loop ${steps.length + 1}`);
            select(id);
          }}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
        >
          + Add loop
        </button>
        {steps.length === 0 && (
          <span className="text-xs text-slate-400 self-center">
            Canvas is empty. Add a step or a loop to begin.
          </span>
        )}
      </div>
    </div>
  );
}
```

> NOTE: `Date.now()` for a placeholder label is fine in the browser. If the RTL environment forbids it, replace with `loop.do.length + 1`.

- [ ] **Step 5: Run to green + build gate**

Run: `cd ui && pnpm test -- CanvasView 2>&1 | tail -15`
Expected: PASS.
Run: `cd ui && pnpm build 2>&1 | tail -15`
Expected: `tsc -b` clean (catches union narrowing — `step.request` only valid after `isLoopStep` guard).

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/scenario/LoopStepNode.tsx ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/__tests__/CanvasView.test.tsx
git commit -m "feat(ui): loop container node on canvas (parent/child subflow + add-loop)"
```

---

## Task 8: Inspector — LoopInspector branch

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx`
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx` (append; create if absent)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () =>
  useScenarioEditor.setState(
    (useScenarioEditor as unknown as { getInitialState: () => ReturnType<typeof useScenarioEditor.getState> }).getInitialState(),
  );

describe("Inspector loop", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("shows a repeat field when a loop is selected and updates the model", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("Loop A");
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);
    const repeat = screen.getByLabelText(/repeat/i) as HTMLInputElement;
    expect(repeat).toBeInTheDocument();
    await user.clear(repeat);
    await user.type(repeat, "6");
    await user.tab(); // commit on blur
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    if (loop.type === "loop") expect(loop.repeat).toBe(6);
  });

  it("editing a step nested in a loop works (request URL)", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("Loop A");
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    const childId = loop.type === "loop" ? loop.do[0].id : "";
    useScenarioEditor.getState().select(childId);
    render(<Inspector />);
    const url = screen.getByDisplayValue("/") as HTMLInputElement;
    await user.clear(url);
    await user.type(url, "/inner");
    const after = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    if (after.type === "loop" && after.do[0].type === "http") expect(after.do[0].request.url).toBe("/inner");
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd ui && pnpm test -- Inspector 2>&1 | tail -20`
Expected: FAIL — no repeat field; the http inspector throws on a loop step (`step.request` undefined).

- [ ] **Step 3: Branch the inspector**

Change the import (line 3) to include the union + guards + flatten:
```ts
import type { Assertion, Extract, HttpMethod, HttpStep, LoopStep, Step } from "../../scenario/model";
import { flattenHttpSteps, isLoopStep } from "../../scenario/model";
```
The selection lookup must search nested steps too. Replace the `step` lookup in `Inspector()` (lines 14-17):
```ts
  const step = useMemo<Step | null>(() => {
    const top = steps.find((s) => s.id === selectedStepId);
    if (top) return top;
    // nested http step inside a loop
    return flattenHttpSteps(steps).find((s) => s.id === selectedStepId) ?? null;
  }, [steps, selectedStepId]);
```
Dispatch by type in the render (replace `return <StepInspector step={step} />;`, line 31):
```ts
  return isLoopStep(step) ? <LoopInspector step={step} /> : <HttpStepInspector step={step} />;
```
Rename the existing `StepInspector`/`StepInspectorProps` to `HttpStepInspector` and change its prop type to `HttpStep` (so `step.request` type-checks). The `index`/move/delete header logic currently uses top-level `steps`; for a nested step `index` will be -1 and the up/down buttons would misbehave. Compute the sibling list generically:
```ts
function HttpStepInspector({ step }: { step: HttpStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const setStepAssert = useScenarioEditor((s) => s.setStepAssert);
  const setStepExtract = useScenarioEditor((s) => s.setStepExtract);
  const removeStep = useScenarioEditor((s) => s.removeStep);
  const moveStep = useScenarioEditor((s) => s.moveStep);
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);

  // Siblings: top-level if the step is top-level; else the loop body it lives in.
  const siblings = useMemo(() => {
    if (steps.some((s) => s.id === step.id)) return steps;
    const parent = steps.find((s) => isLoopStep(s) && s.do.some((c) => c.id === step.id));
    return parent && isLoopStep(parent) ? parent.do : steps;
  }, [steps, step.id]);
  const index = siblings.findIndex((s) => s.id === step.id);
  // ... rest of the existing JSX unchanged, but swap `steps` → `siblings` in the
  // move-button disabled checks and clamps, and pass setStepExtract via ExtractEditor as before.
}
```
(`useMemo` import already present on line 1.) The `ExtractEditor`/`AssertEditor`/`BodyEditor`/`HeadersEditor` sub-components are unchanged — they take `step: Step` but only touch http fields; retype their `step` param to `HttpStep`.

Add the new `LoopInspector` near the bottom:
```ts
function LoopInspector({ step }: { step: LoopStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const setLoopRepeat = useScenarioEditor((s) => s.setLoopRepeat);
  const removeStep = useScenarioEditor((s) => s.removeStep);
  const select = useScenarioEditor((s) => s.select);
  const [repeatDraft, setRepeatDraft] = useState(String(step.repeat));

  useEffect(() => { setRepeatDraft(String(step.repeat)); }, [step.id, step.repeat]);

  const commitRepeat = () => {
    const n = Number(repeatDraft);
    if (Number.isInteger(n) && n >= 1) setLoopRepeat(step.id, n);
    else setRepeatDraft(String(step.repeat));
  };

  return (
    <aside aria-label="Inspector" className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">Loop</h3>
        <SmallButton onClick={() => removeStep(step.id)} label="Delete" title="Delete loop" danger />
      </header>
      <Field label="Name">
        <input
          className="w-full border border-slate-300 rounded px-2 py-1"
          value={step.name}
          onChange={(e) => setStepField(step.id, ["name"], e.target.value || "Untitled")}
        />
      </Field>
      <Field label="Repeat">
        <input
          type="number"
          min={1}
          aria-label="repeat"
          className="w-24 border border-slate-300 rounded px-2 py-1"
          value={repeatDraft}
          onChange={(e) => setRepeatDraft(e.target.value)}
          onBlur={commitRepeat}
        />
      </Field>
      <div>
        <div className="text-xs font-semibold text-slate-600 mb-1">Body steps</div>
        <ul className="flex flex-col gap-1">
          {step.do.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="text-left w-full px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-100"
                onClick={() => select(c.id)}
              >
                <span className="font-medium">{c.name}</span>{" "}
                <span className="font-mono text-slate-500">{c.request.method} {c.request.url}</span>
              </button>
            </li>
          ))}
          {step.do.length === 0 && <li className="text-xs text-slate-400 italic">No steps</li>}
        </ul>
      </div>
    </aside>
  );
}
```
Add `useEffect` to the React import on line 1 if not present (it is: `useEffect, useMemo, useState`).

- [ ] **Step 4: Run to green + build gate**

Run: `cd ui && pnpm test -- Inspector 2>&1 | tail -15`
Run: `cd ui && pnpm build 2>&1 | tail -10`
Expected: PASS + `tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): LoopInspector (repeat editor + body step list); http inspector handles nested steps"
```

---

## Task 9: Report — flatten nested steps for labelling

**Files:**
- Modify: `ui/src/components/report/ReportView.tsx:50-60`
- Modify: `ui/src/pages/RunDetailPage.tsx:26-34`
- Test: `ui/src/components/report/__tests__/ReportView.test.tsx` (append)

- [ ] **Step 1: Write the failing test**

Add to `ReportView.test.tsx` a case where `scenario_yaml` contains a loop and the report has a metric row for the inner step id; assert the inner step's **name** is rendered (not the raw ULID). Model it on the existing ReportView tests (reuse their fixture shape). Skeleton:
```tsx
it("labels a step nested inside a loop using its name", () => {
  const scenarioYaml = `version: 1
name: x
steps:
  - id: 01HX0000000000000000000001
    name: my-loop
    type: loop
    repeat: 2
    do:
      - id: 01HX0000000000000000000002
        name: inner-tick
        type: http
        request: { method: GET, url: "/tick" }
        assert: []
`;
  const report = /* build a report object with steps:[{ step_id: "01HX0000000000000000000002", ... }] and scenario_yaml above */;
  render(<ReportView report={report} width={600} height={300} />);
  expect(screen.getByText("inner-tick")).toBeInTheDocument();
});
```
(Fill the `report` object to match the existing tests' `ReportJson` fixture, swapping in the loop `scenario_yaml` and the inner `step_id`.)

- [ ] **Step 2: Run, verify failure**

Run: `cd ui && pnpm test -- ReportView 2>&1 | tail -20`
Expected: FAIL — the step map is built from `model.steps` (loop has no `.request`); inner step missing, so the ULID shows instead of `inner-tick`. (Also a `tsc` error on `s.request.url` would surface in `pnpm build`.)

- [ ] **Step 3: Use `flattenHttpSteps` in both consumers**

`ReportView.tsx` — replace the `for (const s of parsed.model.steps)` block (line 53) with a flatten:
```ts
      for (const s of flattenHttpSteps(parsed.model.steps)) {
        map.set(s.id, {
          name: s.name,
          method: s.request.method,
          url: resolveForDisplay(s.request.url, envMap),
        });
      }
```
Add the import: `import { flattenHttpSteps } from "../../scenario/model";`

`RunDetailPage.tsx` — replace `parsed.model.steps.map((s) => ({...}))` (line 28) with:
```ts
    return flattenHttpSteps(parsed.model.steps).map((s) => ({
      id: s.id,
      name: s.name,
      method: s.request.method,
      url: s.request.url,
    }));
```
Add the import: `import { flattenHttpSteps } from "../scenario/model";` (adjust the existing model import if one exists).

- [ ] **Step 4: Run to green + build gate**

Run: `cd ui && pnpm test -- ReportView 2>&1 | tail -15`
Run: `cd ui && pnpm build 2>&1 | tail -10`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/report/ReportView.tsx ui/src/pages/RunDetailPage.tsx ui/src/components/report/__tests__/ReportView.test.tsx
git commit -m "feat(ui): flatten loop bodies when labelling report/run-detail steps"
```

---

## Task 10: e2e — loop scenario → run → report

**Files:**
- Create or extend: `crates/controller/tests/e2e_test.rs` (follow the existing `worker_bin_path()` + subprocess pattern; see `report_e2e_smoke`)

- [ ] **Step 1: Write the failing test**

Add an e2e that: starts a wiremock target stubbing `GET /tick` → 200; creates a scenario whose YAML has a `type: loop` with `repeat: 2` wrapping the `tick` http step; POSTs it via the controller API; starts a run (1 VU, short duration) in subprocess worker mode; polls until terminal; GETs `/api/runs/{id}/report`; asserts the report JSON has a per-step entry for the inner step id with `count > 0` and `count % 2 == 0` (multiple of repeat) and `error_count == 0`. Reuse the harness in the existing e2e file (mirror `report_e2e_smoke` exactly for setup/teardown — `worker_bin_path()`, controller spawn, wiremock stub registration).

> Reuse note: copy the scenario-create + run-start + poll-until-terminal helpers from `report_e2e_smoke`; only the scenario YAML (now containing a loop) and the per-step count assertion (`% 2 == 0`) differ.

- [ ] **Step 2: Run, verify it passes** (engine already supports loops; this is a regression guard across the full stack)

Run: `cargo test -p handicap-controller --test e2e_test loop 2>&1 | tail -25`
Expected: PASS. If the inner count is not a multiple of 2, shorten/lengthen `duration` so at least one full loop completes within the window, or assert only `count > 0 && error_count == 0` with a comment that exact multiples are covered by the engine integration test (Task 3).

- [ ] **Step 3: Commit**

```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(e2e): loop scenario create→run→report inner-step counts"
```

---

## Task 11: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Rust workspace gate**

Run: `cargo fmt --check && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace 2>&1 | tail -30`
Expected: all green. (This mirrors the pre-commit hook.)

- [ ] **Step 2: UI gate**

Run: `cd ui && pnpm test 2>&1 | tail -20 && pnpm build 2>&1 | tail -10`
Expected: all tests pass, `tsc -b && vite build` clean.

- [ ] **Step 3: Manual smoke (local dev)** — document results, do not commit binaries

Per CLAUDE.md "로컬 dev": run `cargo run --bin controller` + `cargo run --bin worker` + `cd ui && pnpm dev`, then:
1. New scenario → canvas → "Add loop" → set repeat 3 → "Add step in loop" → set its URL to a wiremock path with `${loop_index}` → Save.
2. Switch to YAML tab: confirm `type: loop`, `repeat: 3`, nested `do:` with `type: http` on inner steps, and any comment you added is preserved.
3. Run (1 VU, short duration) against a wiremock stub for each `/.../0../2`.
4. After terminal, confirm the report's step table labels the inner step by **name** and its count is a multiple of 3.

Record observations (and any gotchas) for the CLAUDE.md update in Task 12.

---

## Task 12: ADR-0020 + docs

**Files:**
- Create: `docs/adr/0020-control-flow-loop-node.md`
- Modify: `docs/adr/README.md` (index)
- Modify: `CLAUDE.md` (decisions index + Slice 7 results + gotchas)

- [ ] **Step 1: Write ADR-0020** (MADR format, status Accepted)

Content must record: the **internally-tagged `Step` enum** decision; **`do_: Vec<Step>`** (engine permits nesting; single-level enforced UI-side) and *why* this deviates from spec §4.1 (`type: http` consistency in serialized YAML, extensibility to Slice 8/9); `${loop_index}` 0-based, errors outside a loop; metrics semantics (inner count × repeat); and the explicit deferrals (data-driven, nested loops, templated `repeat`, conditional/parallel). Reference the spec doc.

- [ ] **Step 2: Update `docs/adr/README.md`** — add the 0020 row to the index table.

- [ ] **Step 3: Update `CLAUDE.md`**
- Add to "알아둘 결정들": `- **0020** Control-flow 노드: loop (재귀 스텝 트리, 단일 레벨, repeat-count)`.
- Update the status line (top): Slice 7 구현 완료.
- Add a "Slice 7 결과" paragraph (mirror the Slice 6 one): loop 노드, Step enum, `${loop_index}`, 캔버스 컨테이너, `Vec<Step>` 결정.
- Add a "Slice 7에서 배운 함정들" section capturing real gotchas found during implementation — at minimum: serde internal-tagging does NOT enforce `deny_unknown_fields` (UI Zod is the strict gate); `async fn` recursion needs `Box::pin`; React Flow parent/child needs `extent: "parent"` + explicit parent `style` height; plus anything from the Task 11 manual smoke.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0020-control-flow-loop-node.md docs/adr/README.md CLAUDE.md
git commit -m "docs(slice-7): ADR-0020 loop node + CLAUDE.md results & gotchas"
```

---

## Self-Review (against the spec)

- **§1 scope** — loop / repeat / do / single-level / `${loop_index}` / canvas container: Tasks 1–9. ✅
- **§4.1 model** — Task 1 (with documented `Vec<Step>` deviation). ✅
- **§4.2 interpreter recursion** — Tasks 1–2. ✅
- **§4.3 `${loop_index}` 0-based, errors outside loop** — Task 2. ✅
- **§5 controller no-change + report walk recursion** — verified no controller change; UI recursion in Task 9. ✅
- **§6 UI canvas/yaml/inspector/zod** — Tasks 4–8. ✅
- **§7 metrics ×repeat, abort mid-loop, extract persists** — Task 3 (count×repeat, cancel) + extract persistence is inherent to `iter_vars` threading (Task 1) and exercised by the existing multi_step extract behavior; loop body shares the same `iter_vars`. ✅
- **§8 deferrals recorded** — ADR-0020 (Task 12). ✅
- **§9 acceptance** — model/engine (T1–3), UI (T4–8), report/e2e (T9–10), docs (T12), gates (T11). ✅
- **§10 ADR-0020** — Task 12. ✅

Type-consistency check: `Step` (TS) = `HttpStep | LoopStep`; `flattenHttpSteps` returns `HttpStep[]`; `isLoopStep`/`isHttpStep` guards used consistently in CanvasView/Inspector/ReportView/RunDetailPage. Engine `Step::{Http(HttpStep),Loop(LoopStep)}`, `LoopStep.do_: Vec<Step>`, `Step::id()/name()` accessors, `TemplateContext.loop_index: Option<u32>`. Edit variants `addLoopStep{id,name,childId}` / `addStepInLoop{loopId,id,name}` / `setLoopRepeat{loopId,repeat}` match across yamlDoc + store. No placeholders remain (the two "fill the fixture" notes in Tasks 9–10 point at concrete existing fixtures to copy).
