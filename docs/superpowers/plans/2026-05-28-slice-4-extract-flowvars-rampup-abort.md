# Slice 4 — Extract / Flow Vars / `${ENV}` / Ramp-up / Abort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scenarios actually multi-step. A QA can author a two-step "login → fetch profile" scenario (token *or* session auth), hit Run, and have it work — meaning the engine extracts values from step N, makes them available as `{{var}}` in step N+1, resolves `${ENV}` from the run config, ramps VUs up linearly over `ramp_up_seconds`, and lets the user abort an in-flight run from the UI.

**Architecture:** Three layers move in lockstep.

1. **Engine.** `crates/engine` grows three orthogonal capabilities: `${ENV}` and `${ENV:-default}` resolution in `template.rs` (existing renderer extended with an `env` borrow + a small parser for the default syntax); a new `Extract` type in `scenario.rs` + a new `extract.rs` module that evaluates per-step extracts against the HTTP response (JSONPath into a JSON body via `serde_json_path`; header; cookie via `resp.cookies()`; status); the executor returns the extracted name→value map alongside each `ExecOutcome`; the runner spawns VUs with a linear ramp-up schedule, threads `env` through `TemplateContext`, and maintains a per-iteration `iter_vars` map (scenario variables ⊕ extracts) that gets handed to `render()` at every step.
2. **Wire protocol + controller + worker.** Proto gains `map<string,string> env = 4;` on `RunAssignment` and an `AbortRun` server→worker message that's already declared but currently inert; the controller adds `POST /api/runs/:id/abort` (sends `AbortRun` over the existing bidi stream and marks the run `aborted`); the worker subscribes to abort by holding a `CancellationToken` that `run_scenario` consults via `tokio::select!`; env from the run config flows from `runs` table → `RunAssignment` → `RunPlan::env` → `TemplateContext::env`.
3. **UI.** The scenario model gains a real `extract: Extract[]` field (drop the Slice 3 "strip from normalizer" workaround). Inspector gets an `ExtractEditor` section that mirrors the canonical YAML shape (`var`, `from: body|header|cookie|status`, conditional `path`/`name`). Run dialog already collects env; we wire it down (it was already sent to the API in Slice 2 — verify). `RunDetailPage` gets a red **Abort** button that's only enabled while `status === "running"`.

**Test plan — explicitly stronger than Slice 3.** Slice 3 leaned on `it.todo` stubs for components and skipped property/integration tests. Slice 4 hardens every layer:

- **Engine unit tests** — every public function in `template.rs`, `extract.rs`, `executor.rs`, `runner.rs` gets failing-first tests for happy path *and* the surprising edge cases (missing env with default, JSONPath miss, cookie not in jar, all-VUs-failed during ramp).
- **Engine property tests (`proptest`)** — three properties: (a) `template::render` on arbitrary `String` input never panics — returns `Ok | Err(MalformedTemplate) | Err(UnknownVar)`; (b) `Scenario::from_yaml(s.to_yaml())` is the identity on arbitrary in-shape `Scenario` values (including `Extract` variants); (c) `extract::evaluate` is stable under headers/body permutations (extracting the same JSONPath from the same body returns the same value).
- **Engine integration tests** — `crates/engine/tests/multi_step.rs` boots a `wiremock` server, exercises both the *token-extract → header* flow and the *cookie_jar=auto session* flow with 10 VUs × 2 s, asserts on per-step status counts and zero assertion errors. A second test verifies ramp-up by running 20 VUs / ramp-up 2 s / duration 4 s and asserting the per-second `count` profile is monotone-non-decreasing during ramp.
- **Controller integration / e2e tests** — `crates/controller/tests/e2e_test.rs` is extended with a two-step scenario (env-driven base URL, extract token, send Bearer) ending with `status === "completed"` and `extracted_var_count > 0` metrics; a new `abort_test.rs` runs a 30 s scenario, calls `POST /api/runs/:id/abort` after 500 ms, and asserts the run ends in `aborted` within 2 s.
- **UI unit tests** — `model.test.ts` gains Extract variant cases; `yamlDoc.test.ts` gains extract-edit and round-trip cases (including the *delete normalizer-drop workaround* — i.e., a model parsed from a doc with extract now exposes extract on the model, not just on the doc).
- **UI property tests (`fast-check`)** — two properties: (a) `serializeDoc(parseScenarioDoc(text).doc)` is idempotent over the second round-trip for any random in-shape scenario (model → YAML → model preserves data); (b) every `Extract` variant round-trips through `yamlDoc` losslessly.
- **UI component tests (`@testing-library/react`)** — real interaction tests (not `.todo`) for:
  - `Inspector` with a selected step: add an extract row, change `from`, change `var`, change `path`, remove. Each interaction asserts on the canonical YAML text the store now holds (read via `useScenarioEditor.getState().yamlText`) — this catches model↔YAML drift end-to-end.
  - `RunDetailPage` Abort: button disabled while pending, enabled when status=running, fires `POST /api/runs/:id/abort` via React Query, becomes disabled after the optimistic update.
- **Manual check (`docs/dev/ui-slice-4-manual-check.md`)** — covers the two-step authoring flow, token and session auth, ramp-up visual smoke, and a real abort against a 30 s wiremock run.

**Tech Stack additions:**

- Rust: `serde_json_path ^0.7` (RFC 9535 JSONPath; tiny, no I/O), `tokio-util ^0.7` for `CancellationToken` (already a transitive of tonic in our tree but we'll declare it explicitly), `proptest ^1.5` as dev-dep, `tracing-test ^0.2` as dev-dep for span-aware tests on the runner.
- UI: `@testing-library/react ^16.0`, `@testing-library/jest-dom ^6.6`, `@testing-library/user-event ^14.5`, `fast-check ^3.22`. All dev-deps.

No new ADRs needed — every decision in this slice was locked by ADR-0014 (template notation), ADR-0015 (sync impl), ADR-0016 (task per VU), and ADR-0018 (cookie jar). Slice 4 just implements them.

**Slice 4 scope (locked):**

| In | Out (deferred) |
|---|---|
| `${ENV}` and `${ENV:-default}` template resolution; env passed run-config → engine | Secret env vars / vault integration |
| `extract: Vec<Extract>` in engine + UI; variants `body`/`header`/`cookie`/`status` | `extract` from streaming body chunks; non-JSON body extract (regex / XPath) |
| Flow vars (`{{var}}`) chain step N → N+1 within a VU iteration | Cross-iteration vars; cross-VU shared state |
| Linear ramp-up: every second `floor(vus / ramp_up_seconds)` VUs spawn | Stages, custom curves, ramp-down |
| Abort: `POST /api/runs/:id/abort` → `AbortRun` over existing stream → cancellation token observed by runner | Pause/resume; graceful "finish current iter then stop" |
| Real RTL tests for `Inspector ExtractEditor` and `RunDetailPage Abort` | Comprehensive coverage of every existing component (we keep Slice 3's stubs as-is for components that didn't change) |
| `proptest` (Rust) and `fast-check` (TS) properties for template / extract / model round-trip | Fuzzing harness in CI; mutation testing |
| Manual check runbook (`docs/dev/ui-slice-4-manual-check.md`) | Playwright E2E (rejected during scope question) |

**Prerequisites:**

- Slice 3 must be green: `just build && just lint && just test`, then `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build`. CLAUDE.md should already mention "Slice 3 결과:".

---

## File structure (Slice 4 — only new / modified)

```
Cargo.toml                                                  # + serde_json_path, proptest, tracing-test, tokio-util workspace deps
crates/engine/Cargo.toml                                    # + serde_json_path, tokio-util ; dev: proptest, tracing-test
crates/engine/src/scenario.rs                               # + Extract enum, + Step.extract field
crates/engine/src/template.rs                               # + env field on TemplateContext, + ${ENV:-default} parsing
crates/engine/src/extract.rs                                # NEW JSONPath/header/cookie/status evaluator
crates/engine/src/executor.rs                               # ExecOutcome carries extracted map
crates/engine/src/runner.rs                                 # ramp-up, env, flow vars, CancellationToken
crates/engine/src/error.rs                                  # + ExtractFailed, + Aborted
crates/engine/src/lib.rs                                    # re-exports
crates/engine/tests/multi_step.rs                           # NEW wiremock token+session integration
crates/engine/tests/ramp_up.rs                              # NEW ramp-up shape integration
crates/engine/tests/proptests.rs                            # NEW render/round-trip proptests

crates/proto/proto/coordinator.proto                        # + env on RunAssignment ; AbortRun already exists
crates/worker/src/main.rs                                   # env, ramp, abort plumbing
crates/worker/src/client.rs                                 # observe AbortRun, hold CancellationToken
crates/controller/src/api/runs.rs                           # + POST /runs/{id}/abort
crates/controller/src/grpc/coordinator.rs                   # + abort routing, + env on assignment
crates/controller/src/store/runs.rs                         # mark_aborted helper
crates/controller/tests/api_test.rs                         # + abort happy path
crates/controller/tests/e2e_test.rs                         # + two-step + env + abort

ui/package.json                                             # + @testing-library/{react,jest-dom,user-event}, fast-check (dev)
ui/pnpm-lock.yaml                                           # regenerated
ui/vitest.config.ts                                         # + setupFiles for jest-dom
ui/src/test/setup.ts                                        # NEW jest-dom import
ui/src/scenario/model.ts                                    # + ExtractModel, Step.extract
ui/src/scenario/yamlDoc.ts                                  # normalizer surfaces extract ; + setStepExtract Edit ; + serializer reshape
ui/src/scenario/store.ts                                    # + setStepExtract action
ui/src/scenario/__tests__/model.test.ts                     # + Extract zod cases
ui/src/scenario/__tests__/yamlDoc.test.ts                   # + extract round-trip cases
ui/src/scenario/__tests__/store.test.ts                     # + setStepExtract case
ui/src/scenario/__tests__/proptests.test.ts                 # NEW fast-check round-trip
ui/src/components/scenario/Inspector.tsx                    # + ExtractEditor section
ui/src/components/scenario/__tests__/Inspector.test.tsx     # rewrite: real RTL tests for ExtractEditor
ui/src/pages/RunDetailPage.tsx                              # + Abort button, abort hook
ui/src/pages/__tests__/RunDetailPage.test.tsx               # NEW RTL test for abort flow
ui/src/api/client.ts                                        # + abortRun
ui/src/api/hooks.ts                                         # + useAbortRun

docs/dev/ui-slice-4-manual-check.md                         # NEW
CLAUDE.md                                                   # status + gotchas
```

**Conventions (carry over from Slice 2/3):**
- Function components: `function Foo(...)`, not `const Foo = (...)`.
- One Tailwind utility-class chain per element; line-break long chains.
- Vitest tests live under `__tests__/` next to source.
- No emoji, no decorative comments. Comments only where the *why* is non-obvious.
- Rust: prefer `?` over manual match. `thiserror::Error` on every error type in `error.rs`. No `unwrap()` in non-test code.

---

## Task 1: Dependencies (Rust + UI) + jest-dom setup

**Files:**
- Modify: `Cargo.toml`
- Modify: `crates/engine/Cargo.toml`
- Modify: `ui/package.json`
- Modify: `ui/vitest.config.ts`
- Create: `ui/src/test/setup.ts`

- [ ] **Step 1: Workspace Cargo.toml — add deps**

Edit `Cargo.toml`. Under `[workspace.dependencies]`, add (alphabetical placement):

```toml
serde_json_path = "0.7"
tokio-util = { version = "0.7", default-features = false }
proptest = "1.5"
tracing-test = { version = "0.2", default-features = false }
```

- [ ] **Step 2: `crates/engine/Cargo.toml` — wire deps**

Add under `[dependencies]`:

```toml
serde_json_path.workspace = true
tokio-util = { workspace = true, features = ["rt"] }
```

Add under `[dev-dependencies]`:

```toml
proptest.workspace = true
tracing-test.workspace = true
```

- [ ] **Step 3: Verify Rust builds**

```bash
cargo build --workspace --tests
```

Expected: clean build (no new code yet — just deps resolved).

- [ ] **Step 4: UI deps**

Edit `ui/package.json`. Add to `devDependencies` (alphabetical):

```json
{
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "fast-check": "^3.22.0"
  }
}
```

Then:

```bash
cd ui && pnpm install
```

Expected: lockfile updates, no peer-dep failures (React 18 + RTL 16 is supported).

- [ ] **Step 5: jest-dom setup file**

Create `ui/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 6: Wire setupFiles in vitest.config.ts**

Edit `ui/vitest.config.ts` — find the `test:` block and add `setupFiles`:

```ts
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
```

- [ ] **Step 7: Verify UI lint + test still pass**

```bash
cd ui && pnpm lint && pnpm test
```

Expected: green (no behavioral changes yet).

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml crates/engine/Cargo.toml ui/package.json ui/pnpm-lock.yaml ui/vitest.config.ts ui/src/test/setup.ts
git commit -m "build: add slice 4 deps (serde_json_path, proptest, RTL, fast-check)"
```

---

## Task 2: Template engine — `${ENV}` and `${ENV:-default}` support

**Files:**
- Modify: `crates/engine/src/template.rs`

The current renderer accepts `${vu_id}`, `${iter_id}` and rejects any other `${...}`. Slice 4 changes that so `${NAME}` resolves against an env map carried on `TemplateContext`, and `${NAME:-default}` falls back to `default` when `NAME` is absent. `{{...}}` is unchanged.

Decision: `env` is `&BTreeMap<String, String>` (not Option) — an empty map is the natural "no env" case. The unknown-var error continues to fire when the key is missing *and* no default is provided.

- [ ] **Step 1: Failing tests for new behavior**

Append to `crates/engine/src/template.rs` `mod tests`:

```rust
    #[test]
    fn renders_env_var() {
        let v = BTreeMap::new();
        let env: BTreeMap<String, String> =
            [("BASE_URL".to_string(), "https://prod.example".to_string())]
                .into_iter()
                .collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
        };
        assert_eq!(
            render("${BASE_URL}/x", &ctx).unwrap(),
            "https://prod.example/x"
        );
    }

    #[test]
    fn env_var_default_used_when_missing() {
        let v = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
        };
        assert_eq!(
            render("${MISSING:-localhost}/x", &ctx).unwrap(),
            "localhost/x"
        );
    }

    #[test]
    fn env_var_default_ignored_when_present() {
        let v = BTreeMap::new();
        let env: BTreeMap<String, String> =
            [("HOST".to_string(), "prod".to_string())].into_iter().collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
        };
        assert_eq!(render("${HOST:-fallback}", &ctx).unwrap(), "prod");
    }

    #[test]
    fn empty_default_is_valid() {
        let v = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
        };
        assert_eq!(render("[${X:-}]", &ctx).unwrap(), "[]");
    }

    #[test]
    fn unknown_env_var_without_default_errors() {
        let v = BTreeMap::new();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
        };
        assert!(matches!(
            render("${MISSING}", &ctx),
            Err(EngineError::UnknownVar(_))
        ));
    }

    #[test]
    fn system_var_still_works_alongside_env() {
        let v = BTreeMap::new();
        let env: BTreeMap<String, String> =
            [("HOST".to_string(), "h".to_string())].into_iter().collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 9,
            iter_id: 0,
        };
        assert_eq!(
            render("${HOST}/${vu_id}", &ctx).unwrap(),
            "h/9"
        );
    }
```

Also update the existing two tests (`renders_vu_id_and_iter_id`, `unknown_flow_var_errors`, etc.) that construct `TemplateContext { vars, vu_id, iter_id }` — they need the new `env` field. Use a single helper to keep them tidy:

Replace the existing tests block (lines 78–167 of `template.rs`) so every `TemplateContext { ... }` literal also has `env: &empty_env()`. Add this helper before any tests:

```rust
    fn empty_env() -> BTreeMap<String, String> {
        BTreeMap::new()
    }
```

Concretely, every TemplateContext literal in the test module looks like:

```rust
            let env = empty_env();
            let ctx = TemplateContext {
                vars: &v,
                env: &env,
                vu_id: 0,
                iter_id: 0,
            };
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cargo test -p handicap-engine template::tests
```

Expected: compile error (TemplateContext does not have `env` field).

- [ ] **Step 3: Implement the new struct + parser**

Replace lines 5–10 (the `TemplateContext` declaration) with:

```rust
#[derive(Debug, Clone)]
pub struct TemplateContext<'a> {
    pub vars: &'a BTreeMap<String, String>,
    pub env: &'a BTreeMap<String, String>,
    pub vu_id: u32,
    pub iter_id: u32,
}
```

Replace the body of the `${...}` branch (lines 35–49) with:

```rust
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            let end = find_byte(bytes, i + 2, b'}').ok_or_else(|| {
                EngineError::MalformedTemplate(format!("unclosed ${{ at byte {i}"))
            })?;
            let inner = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in ${ }".into()))?;
            let (name, default) = match inner.find(":-") {
                Some(p) => (inner[..p].trim(), Some(inner[p + 2..].to_string())),
                None => (inner.trim(), None),
            };
            let value = match name {
                "vu_id" => ctx.vu_id.to_string(),
                "iter_id" => ctx.iter_id.to_string(),
                other => match ctx.env.get(other) {
                    Some(v) => v.clone(),
                    None => match default {
                        Some(d) => d,
                        None => return Err(EngineError::UnknownVar(other.to_string())),
                    },
                },
            };
            out.push_str(&value);
            i = end + 1;
            continue;
        }
```

- [ ] **Step 4: Run tests to verify**

```bash
cargo test -p handicap-engine template
```

Expected: PASS (all template tests including the 6 new ones).

NOTE: the workspace will not yet compile end-to-end because `runner.rs` constructs `TemplateContext` without `env`. We fix that in Task 6. For now isolate the test to `-p handicap-engine` and the `template` filter.

- [ ] **Step 5: Patch the runner construction to compile (placeholder)**

To keep the workspace green between tasks, patch `crates/engine/src/runner.rs` line ~121 — the construction inside `run_vu`. Replace:

```rust
            let ctx = TemplateContext {
                vars: &scenario.variables,
                vu_id,
                iter_id,
            };
```

with a placeholder that uses an empty env (real wiring lands in Task 6):

```rust
            let empty_env: BTreeMap<String, String> = BTreeMap::new();
            let ctx = TemplateContext {
                vars: &scenario.variables,
                env: &empty_env,
                vu_id,
                iter_id,
            };
```

Add `use std::collections::BTreeMap;` to `runner.rs` if not already there (it isn't — `scenario.rs` brings it in, but `runner.rs` doesn't).

- [ ] **Step 6: Full engine + workspace build**

```bash
cargo build --workspace
cargo test -p handicap-engine
```

Expected: all engine tests pass; workspace compiles.

- [ ] **Step 7: Commit**

```bash
git add crates/engine/src/template.rs crates/engine/src/runner.rs
git commit -m "feat(engine): \${ENV} and \${ENV:-default} template substitution"
```

---

## Task 3: `Extract` type in scenario model

**Files:**
- Modify: `crates/engine/src/scenario.rs`
- Create: `crates/engine/tests/fixtures/two_step.yaml`

The canonical YAML shape per spec §2.3 is an internally-tagged variant on `from`:

```yaml
extract:
  - var: token
    from: body
    path: "$.access_token"
  - var: jsession
    from: cookie
    name: "JSESSIONID"
  - var: req_id
    from: header
    name: "X-Request-Id"
  - var: code
    from: status
```

`serde`'s `tag = "from"` internally-tagged enum is the right shape — and unlike the `Body`/`Assertion` cases (which used externally-tagged map-shape), internally-tagged struct variants round-trip cleanly through `serde_yaml 0.9`. We use `rename_all = "lowercase"` so YAML literals stay lower-case.

`Step.extract` is `#[serde(default)] Vec<Extract>` — older scenarios without an extract field still parse.

- [ ] **Step 1: Two-step fixture**

Create `crates/engine/tests/fixtures/two_step.yaml`:

```yaml
version: 1
name: "two step token flow"
variables:
  base: "http://placeholder"
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "{{base}}/login"
      body:
        json:
          username: "${USERNAME:-demo}"
          password: "${PASSWORD:-pw}"
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.access_token"
  - id: "01HX0000000000000000000002"
    name: "profile"
    type: http
    request:
      method: GET
      url: "{{base}}/me"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      - status: 200
```

- [ ] **Step 2: Failing tests**

Append to `crates/engine/src/scenario.rs` `mod tests`:

```rust
    const TWO_STEP_FIXTURE: &str = include_str!("../tests/fixtures/two_step.yaml");

    #[test]
    fn parses_two_step_fixture() {
        let s = Scenario::from_yaml(TWO_STEP_FIXTURE).expect("parses");
        assert_eq!(s.steps.len(), 2);
        let login = &s.steps[0];
        assert_eq!(login.extract.len(), 1);
        match &login.extract[0] {
            Extract::Body { var, path } => {
                assert_eq!(var, "token");
                assert_eq!(path, "$.access_token");
            }
            other => panic!("expected Body extract, got {:?}", other),
        }
        assert_eq!(s.steps[1].extract.len(), 0);
    }

    #[test]
    fn parses_each_extract_variant() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request:
      method: GET
      url: "/"
    assert: []
    extract:
      - var: t
        from: body
        path: "$.a"
      - var: h
        from: header
        name: X-Trace
      - var: c
        from: cookie
        name: JSESSIONID
      - var: s
        from: status
"#;
        let s = Scenario::from_yaml(y).expect("parses");
        let xs = &s.steps[0].extract;
        assert_eq!(xs.len(), 4);
        assert!(matches!(xs[0], Extract::Body { .. }));
        assert!(matches!(xs[1], Extract::Header { .. }));
        assert!(matches!(xs[2], Extract::Cookie { .. }));
        assert!(matches!(xs[3], Extract::Status { .. }));
    }

    #[test]
    fn extract_round_trips() {
        let s = Scenario::from_yaml(TWO_STEP_FIXTURE).unwrap();
        let yaml = s.to_yaml().unwrap();
        let s2 = Scenario::from_yaml(&yaml).unwrap();
        assert_eq!(s, s2);
    }

    #[test]
    fn rejects_extract_with_unknown_from() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request: { method: GET, url: "/" }
    assert: []
    extract:
      - var: t
        from: nope
        path: "$.a"
"#;
        assert!(Scenario::from_yaml(y).is_err());
    }

    #[test]
    fn rejects_body_extract_without_path() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request: { method: GET, url: "/" }
    assert: []
    extract:
      - var: t
        from: body
"#;
        assert!(Scenario::from_yaml(y).is_err());
    }
```

- [ ] **Step 3: Run the tests (they fail — Extract is not defined)**

```bash
cargo test -p handicap-engine scenario::tests
```

Expected: compile error (no `Extract` type).

- [ ] **Step 4: Add the `Extract` enum**

Add to `crates/engine/src/scenario.rs` after the `Assertion` impls (around line 186):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "from", rename_all = "lowercase", deny_unknown_fields)]
pub enum Extract {
    Body { var: String, path: String },
    Header { var: String, name: String },
    Cookie { var: String, name: String },
    Status { var: String },
}
```

And add to the `Step` struct (insert after the `assert` field):

```rust
    #[serde(default)]
    pub extract: Vec<Extract>,
```

- [ ] **Step 5: Run scenario tests**

```bash
cargo test -p handicap-engine scenario
```

Expected: PASS (all existing tests still pass since `extract` defaults to empty; 5 new tests pass).

- [ ] **Step 6: Verify workspace build**

```bash
cargo build --workspace
```

Expected: clean. (`executor.rs` doesn't read `step.extract` yet — that lands in Task 5.)

- [ ] **Step 7: Commit**

```bash
git add crates/engine/src/scenario.rs crates/engine/tests/fixtures/two_step.yaml
git commit -m "feat(engine): Extract type + Step.extract field"
```

---

## Task 4: `extract.rs` evaluator (JSONPath / header / cookie / status)

**Files:**
- Create: `crates/engine/src/extract.rs`
- Modify: `crates/engine/src/lib.rs`
- Modify: `crates/engine/src/error.rs`

The evaluator takes a slice of `Extract` definitions plus the response artifacts and produces a `BTreeMap<String, String>`. Choices on edge cases:

- **JSONPath miss** → returns `Err(ExtractFailed)`, which the executor records as a step-level error (the metric increments `error_count`). This matches user expectations: if a login is supposed to return `access_token` and doesn't, the next step would fail anyway.
- **JSONPath multi-match** → take the first match. Document this; not configurable in MVP.
- **JSON body that doesn't parse** → `Err(ExtractFailed("body not JSON"))`.
- **Non-string JSONPath result** (number, bool, null, object) → coerce via `serde_json::Value::to_string()` minus surrounding quotes for strings. Object/array → JSON-stringify.
- **Header missing** → error. We may relax later but MVP is strict.
- **Cookie** → search the response's `Set-Cookie` headers for the named cookie. (We don't reach into the jar — the jar is mutated for future requests; this extracts a *value into a flow var*.)
- **Status** → status code as base-10 string.

- [ ] **Step 1: Error variants**

Edit `crates/engine/src/error.rs` (line ~27 — append variants to the existing `EngineError` enum):

```rust
    #[error("extract failed: {0}")]
    ExtractFailed(String),
    #[error("aborted")]
    Aborted,
```

- [ ] **Step 2: Failing tests**

Create `crates/engine/src/extract.rs`:

```rust
//! Per-step response extraction: JSONPath into body, header lookup, cookie
//! lookup, status code → named flow variable. Result goes into the per-VU
//! per-iteration `iter_vars` map consumed by subsequent steps.

use std::collections::BTreeMap;

use crate::error::{EngineError, Result};
use crate::scenario::Extract;

/// Captured response artifacts for a single step.
pub struct ResponseFacts<'a> {
    pub status: u16,
    pub headers: &'a [(String, String)],
    /// Raw `Set-Cookie` header values for this response (not the merged jar).
    pub set_cookies: &'a [String],
    /// Body bytes. Body is parsed lazily so non-body extracts don't pay.
    pub body: &'a [u8],
}

/// Apply each `Extract` against `facts`. On the first failure (missing JSON
/// path, missing header, etc.) return `Err` — the executor decides whether
/// that means the step is errored.
pub fn evaluate(
    extracts: &[Extract],
    facts: &ResponseFacts<'_>,
) -> Result<BTreeMap<String, String>> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut body_json: Option<serde_json::Value> = None;

    for e in extracts {
        match e {
            Extract::Body { var, path } => {
                let json = match body_json.as_ref() {
                    Some(v) => v,
                    None => {
                        let v: serde_json::Value = serde_json::from_slice(facts.body)
                            .map_err(|e| EngineError::ExtractFailed(format!("body not JSON: {e}")))?;
                        body_json = Some(v);
                        body_json.as_ref().unwrap()
                    }
                };
                let value = jsonpath_first(json, path)
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no match: {path}")))?;
                out.insert(var.clone(), stringify(&value));
            }
            Extract::Header { var, name } => {
                let value = facts
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.clone())
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no header: {name}")))?;
                out.insert(var.clone(), value);
            }
            Extract::Cookie { var, name } => {
                let value = facts
                    .set_cookies
                    .iter()
                    .find_map(|sc| parse_cookie_value(sc, name))
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no cookie: {name}")))?;
                out.insert(var.clone(), value);
            }
            Extract::Status { var } => {
                out.insert(var.clone(), facts.status.to_string());
            }
        }
    }
    Ok(out)
}

fn jsonpath_first(json: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    use serde_json_path::JsonPath;
    let p = JsonPath::parse(path).ok()?;
    p.query(json).first().cloned()
}

fn stringify(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn parse_cookie_value(set_cookie: &str, name: &str) -> Option<String> {
    // "JSESSIONID=abc; Path=/; HttpOnly" → if name == "JSESSIONID", return "abc"
    let first = set_cookie.split(';').next()?.trim();
    let (k, v) = first.split_once('=')?;
    if k.trim() == name { Some(v.trim().to_string()) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_facts(body: &str) -> ResponseFacts<'_> {
        ResponseFacts {
            status: 200,
            headers: &[],
            set_cookies: &[],
            body: body.as_bytes(),
        }
    }

    #[test]
    fn body_jsonpath_string() {
        let body = r#"{"access_token":"T0K3N"}"#;
        let facts = body_facts(body);
        let xs = vec![Extract::Body {
            var: "token".into(),
            path: "$.access_token".into(),
        }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("token").map(String::as_str), Some("T0K3N"));
    }

    #[test]
    fn body_jsonpath_number_coerced() {
        let facts = body_facts(r#"{"id": 42}"#);
        let xs = vec![Extract::Body {
            var: "id".into(),
            path: "$.id".into(),
        }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("id").map(String::as_str), Some("42"));
    }

    #[test]
    fn body_jsonpath_miss_is_error() {
        let facts = body_facts(r#"{}"#);
        let xs = vec![Extract::Body {
            var: "t".into(),
            path: "$.nope".into(),
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    #[test]
    fn body_not_json_is_error() {
        let facts = body_facts("<html>");
        let xs = vec![Extract::Body {
            var: "t".into(),
            path: "$.a".into(),
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    #[test]
    fn header_lookup_case_insensitive() {
        let headers = vec![("X-Trace".into(), "abc".into())];
        let facts = ResponseFacts {
            status: 200,
            headers: &headers,
            set_cookies: &[],
            body: b"",
        };
        let xs = vec![Extract::Header {
            var: "tr".into(),
            name: "x-trace".into(),
        }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("tr").map(String::as_str), Some("abc"));
    }

    #[test]
    fn header_missing_is_error() {
        let facts = body_facts("");
        let xs = vec![Extract::Header {
            var: "x".into(),
            name: "X-None".into(),
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    #[test]
    fn cookie_extracts_first_attr_pair() {
        let set_cookies = vec!["JSESSIONID=abc123; Path=/; HttpOnly".into()];
        let facts = ResponseFacts {
            status: 200,
            headers: &[],
            set_cookies: &set_cookies,
            body: b"",
        };
        let xs = vec![Extract::Cookie {
            var: "jsession".into(),
            name: "JSESSIONID".into(),
        }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("jsession").map(String::as_str), Some("abc123"));
    }

    #[test]
    fn cookie_missing_is_error() {
        let facts = body_facts("");
        let xs = vec![Extract::Cookie {
            var: "x".into(),
            name: "None".into(),
        }];
        assert!(matches!(
            evaluate(&xs, &facts),
            Err(EngineError::ExtractFailed(_))
        ));
    }

    #[test]
    fn status_extract() {
        let facts = ResponseFacts {
            status: 503,
            headers: &[],
            set_cookies: &[],
            body: b"",
        };
        let xs = vec![Extract::Status { var: "code".into() }];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("code").map(String::as_str), Some("503"));
    }

    #[test]
    fn multiple_extracts_in_order() {
        let body = r#"{"a":"x","b":"y"}"#;
        let facts = body_facts(body);
        let xs = vec![
            Extract::Body {
                var: "first".into(),
                path: "$.a".into(),
            },
            Extract::Body {
                var: "second".into(),
                path: "$.b".into(),
            },
        ];
        let out = evaluate(&xs, &facts).unwrap();
        assert_eq!(out.get("first").map(String::as_str), Some("x"));
        assert_eq!(out.get("second").map(String::as_str), Some("y"));
    }
}
```

- [ ] **Step 3: Register the module**

Edit `crates/engine/src/lib.rs`. Add `pub mod extract;` alongside the existing `pub mod`s, and re-export `pub use extract::{evaluate as evaluate_extracts, ResponseFacts};` if not already there.

- [ ] **Step 4: Run the tests**

```bash
cargo test -p handicap-engine extract
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/extract.rs crates/engine/src/lib.rs crates/engine/src/error.rs
git commit -m "feat(engine): extract evaluator (JSONPath/header/cookie/status)"
```

---

## Task 5: Executor returns extracted flow vars

**Files:**
- Modify: `crates/engine/src/executor.rs`

The executor already builds `ExecOutcome { step_id, status, latency, error }`. We add `extracted: BTreeMap<String, String>` and pass the response's headers/body to `extract::evaluate`. If extraction fails, we still return an outcome (with `error = Some("extract failed: ...")` and an empty `extracted`); the metric records the step as errored, but the run continues.

Body must be read to memory now so the extractor can see it. The current code already does `resp.bytes().await` to drain — we now keep those bytes.

- [ ] **Step 1: Failing test**

Append to `crates/engine/src/executor.rs` a `#[cfg(test)] mod tests` (the file currently has none — Slice 1 tested it through `runner_e2e.rs`; we add a focused unit using `wiremock`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::{Extract, HttpMethod, Request, Step, StepKind};
    use std::collections::BTreeMap;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn empty_env() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    #[tokio::test]
    async fn extract_token_from_body_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"access_token":"T0K3N"}"#),
            )
            .mount(&server)
            .await;

        let step = Step {
            id: "01HX0000000000000000000001".into(),
            name: "login".into(),
            kind: StepKind::Http,
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/login", server.uri()),
                headers: BTreeMap::new(),
                body: None,
            },
            assert: vec![],
            extract: vec![Extract::Body {
                var: "token".into(),
                path: "$.access_token".into(),
            }],
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert_eq!(outcome.status, 200);
        assert!(outcome.error.is_none(), "no error: {:?}", outcome.error);
        assert_eq!(outcome.extracted.get("token").map(String::as_str), Some("T0K3N"));
    }

    #[tokio::test]
    async fn extract_failure_records_step_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/empty"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let step = Step {
            id: "01HX0000000000000000000002".into(),
            name: "x".into(),
            kind: StepKind::Http,
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/empty", server.uri()),
                headers: BTreeMap::new(),
                body: None,
            },
            assert: vec![],
            extract: vec![Extract::Body {
                var: "t".into(),
                path: "$.no".into(),
            }],
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert!(outcome.error.is_some(), "expected error");
        assert!(outcome.extracted.is_empty());
    }
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cargo test -p handicap-engine executor::tests
```

Expected: compile error — `ExecOutcome` has no `extracted` field; `Step` constructor requires `extract`; `execute_step` does not call `extract::evaluate`.

- [ ] **Step 3: Update `ExecOutcome` + executor body**

In `crates/engine/src/executor.rs`:

Add to imports:

```rust
use crate::extract::{ResponseFacts, evaluate as evaluate_extracts};
use std::collections::BTreeMap;
```

Replace the `ExecOutcome` struct:

```rust
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub step_id: String,
    pub status: u16,
    pub latency: Duration,
    pub error: Option<String>,
    pub extracted: BTreeMap<String, String>,
}
```

Replace the `Ok(resp)` arm of the `match outcome` block (the existing block that calls `resp.bytes().await`) with:

```rust
        Ok(resp) => {
            let status = resp.status().as_u16();
            // Collect headers + Set-Cookie before consuming the response.
            let headers: Vec<(String, String)> = resp
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
                    return Ok(ExecOutcome {
                        step_id: step.id.clone(),
                        status,
                        latency,
                        error: Some(format!("read body: {e}")),
                        extracted: BTreeMap::new(),
                    });
                }
            };

            let mut error: Option<String> = None;
            for a in &step.assert {
                match a {
                    Assertion::Status(want) if *want != status => {
                        error = Some(format!("status {} != {}", status, want));
                        break;
                    }
                    _ => {}
                }
            }

            let mut extracted = BTreeMap::new();
            if error.is_none() && !step.extract.is_empty() {
                let facts = ResponseFacts {
                    status,
                    headers: &headers,
                    set_cookies: &set_cookies,
                    body: &body_bytes,
                };
                match evaluate_extracts(&step.extract, &facts) {
                    Ok(map) => extracted = map,
                    Err(e) => error = Some(e.to_string()),
                }
            }

            Ok(ExecOutcome {
                step_id: step.id.clone(),
                status,
                latency,
                error,
                extracted,
            })
        }
```

Replace the `Err(e)` arm to include the `extracted: BTreeMap::new()` field:

```rust
        Err(e) => Ok(ExecOutcome {
            step_id: step.id.clone(),
            status: 0,
            latency,
            error: Some(e.to_string()),
            extracted: BTreeMap::new(),
        }),
```

- [ ] **Step 4: Run executor tests**

```bash
cargo test -p handicap-engine executor
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Run all engine tests**

```bash
cargo test -p handicap-engine
```

Expected: all pass (the runner test in `runner_e2e.rs` doesn't read `extracted` — it just sums `count`/`error_count`).

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/executor.rs
git commit -m "feat(engine): executor returns extracted flow vars per step"
```

---

## Task 6: Runner — flow vars per VU iteration, ramp-up, cancellation token, env

**Files:**
- Modify: `crates/engine/src/runner.rs`
- Modify: `crates/engine/src/lib.rs`

Three independent changes land together because they all touch `RunPlan` and the VU loop:

1. **Flow vars.** Each VU iteration starts with `iter_vars = scenario.variables.clone()`. After every step, `iter_vars.extend(outcome.extracted)`. The `TemplateContext` for the next step in the same iteration sees the merged map. On the next iteration `iter_vars` resets to the scenario base (flow vars do NOT persist across iterations — that's the contract).
2. **Ramp-up.** `RunPlan` gets `ramp_up: Duration`. We compute `per_second = max(1, ceil(vus / ramp_up_seconds))` (or all at once if `ramp_up_seconds == 0`) and spawn that many tasks per tick, sleeping between ticks. Each spawned task still receives `deadline = run_start + duration` so a late-spawned VU has less total run time — this is the intended semantics for k6-style linear ramp.
3. **Cancellation.** `run_scenario` takes a `CancellationToken` parameter. The per-VU loop checks `token.is_cancelled()` between steps; the ramp-up loop checks before each spawn. On cancel we wait for in-flight VUs to land (max 5 s), then return `Err(EngineError::Aborted)`.
4. **Env.** `RunPlan` gains `env: BTreeMap<String, String>`. Threaded down into `run_vu`'s TemplateContext.

- [ ] **Step 1: Failing test for flow var chaining**

Create `crates/engine/tests/multi_step.rs`:

```rust
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn token_extracted_and_reused_in_next_step() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"access_token":"T0K3N"}"#))
        .mount(&server)
        .await;

    // /me REQUIRES the bearer token; without it wiremock returns 404 (no match).
    Mock::given(method("GET"))
        .and(path("/me"))
        .and(header("authorization", "Bearer T0K3N"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: token-flow
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: login
    type: http
    request:
      method: POST
      url: "{{{{base}}}}/login"
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.access_token"
  - id: "01HX0000000000000000000002"
    name: me
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/me"
      headers:
        Authorization: "Bearer {{{{token}}}}"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 4,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone).await.expect("runs");
    });

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    let mut per_step: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    while let Some(batch) = rx.recv().await {
        for w in batch {
            total += w.count;
            errors += w.error_count;
            let e = per_step.entry(w.step_id.clone()).or_insert((0, 0));
            e.0 += w.count;
            e.1 += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0, "should record at least one request");
    assert_eq!(errors, 0, "no extract / assert errors expected; got {total} reqs, {errors} errors");

    let login = per_step.get("01HX0000000000000000000001").copied().unwrap_or_default();
    let me = per_step.get("01HX0000000000000000000002").copied().unwrap_or_default();
    assert!(login.0 > 0 && me.0 > 0, "both steps must have requests: login={:?} me={:?}", login, me);
    assert_eq!(login.1, 0);
    assert_eq!(me.1, 0);
}

#[tokio::test]
async fn cookie_jar_session_flow_works() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/session-login"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("Set-Cookie", "JSESSIONID=abc; Path=/")
                .set_body_string("ok"),
        )
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/session-me"))
        .and(header("cookie", "JSESSIONID=abc"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hi"))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: session-flow
cookie_jar: auto
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000010"
    name: login
    type: http
    request:
      method: POST
      url: "{{{{base}}}}/session-login"
    assert:
      - status: 200
  - id: "01HX0000000000000000000011"
    name: me
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/session-me"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 3,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone).await.expect("runs");
    });

    let mut errors: u64 = 0;
    let mut total: u64 = 0;
    while let Some(batch) = rx.recv().await {
        for w in batch {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0);
    assert_eq!(errors, 0, "session-me must succeed via cookie jar");
}

#[tokio::test]
async fn env_var_substitution_in_url() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/health"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = r#"
version: 1
name: env
variables: {}
steps:
  - id: "01HX0000000000000000000020"
    name: health
    type: http
    request:
      method: GET
      url: "${BASE_URL}/v2/health"
    assert:
      - status: 200
"#;

    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let env: BTreeMap<String, String> =
        [("BASE_URL".to_string(), server.uri())].into_iter().collect();
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env,
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone).await.expect("runs");
    });

    let mut errors: u64 = 0;
    let mut total: u64 = 0;
    while let Some(batch) = rx.recv().await {
        for w in batch {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0);
    assert_eq!(errors, 0);
}

#[tokio::test]
async fn cancellation_stops_run_quickly() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: long
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000030"
    name: ping
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/"
    assert:
      - status: 200
"#,
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 3,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(30),
        env: BTreeMap::new(),
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone).await
    });
    // Drain in the background so the sender doesn't fill up.
    let drain = tokio::spawn(async move {
        while rx.recv().await.is_some() {}
    });

    tokio::time::sleep(Duration::from_millis(300)).await;
    cancel.cancel();

    let started = std::time::Instant::now();
    let r = run.await.expect("join");
    drain.await.ok();
    let elapsed = started.elapsed();

    assert!(matches!(r, Err(handicap_engine::EngineError::Aborted)));
    assert!(elapsed < Duration::from_secs(6), "cancel should land within 6s, took {elapsed:?}");
}
```

- [ ] **Step 2: Create the ramp-up test**

Create `crates/engine/tests/ramp_up.rs`:

```rust
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn ramp_up_increases_count_over_time() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(50)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: ramp
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000040"
    name: ping
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        vus: 20,
        ramp_up: Duration::from_secs(2),
        duration: Duration::from_secs(4),
        env: BTreeMap::new(),
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone).await.expect("runs");
    });

    let mut per_sec: BTreeMap<i64, u64> = BTreeMap::new();
    while let Some(batch) = rx.recv().await {
        for w in batch {
            *per_sec.entry(w.ts_second).or_insert(0) += w.count;
        }
    }
    run.await.expect("join");

    // We don't pin exact counts (CI is noisy), but we DO assert that the
    // earliest 1s window has strictly fewer requests than the steady-state
    // window once ramp finished — i.e., ramp-up actually delays VU spawn.
    let mut windows: Vec<(i64, u64)> = per_sec.into_iter().collect();
    windows.sort_by_key(|(t, _)| *t);
    assert!(windows.len() >= 3, "expected at least 3 1-second windows, got {:?}", windows);
    let first = windows.first().unwrap().1;
    let later = windows[windows.len() - 2].1; // not the last (may be partial drain)
    assert!(
        first < later,
        "ramp-up: first window count {first} should be < later window count {later}; windows: {windows:?}",
    );
}
```

- [ ] **Step 3: Run the new tests — they all fail**

```bash
cargo test -p handicap-engine --tests
```

Expected: compile errors (`RunPlan` lacks `ramp_up`, `env`; `run_scenario` signature changed; `EngineError::Aborted` may not be re-exported from `lib`).

- [ ] **Step 4: Update `RunPlan` and `run_scenario`**

Edit `crates/engine/src/runner.rs`. Add at the top:

```rust
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;
```

Replace `RunPlan`:

```rust
#[derive(Debug, Clone)]
pub struct RunPlan {
    pub vus: u32,
    pub ramp_up: Duration,
    pub duration: Duration,
    pub env: BTreeMap<String, String>,
}
```

Replace `run_scenario` and `run_vu` (the entire body below `RunPlan`):

```rust
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
        next_spawn = next_spawn + Duration::from_secs(1);
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
        info!(failed = failed_count, total = plan.vus, "run finished with partial VU failures");
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
        for step in &scenario.steps {
            if Instant::now() >= deadline {
                return Ok(());
            }
            if cancel.is_cancelled() {
                return Err(EngineError::Aborted);
            }
            let ctx = TemplateContext {
                vars: &iter_vars,
                env: env.as_ref(),
                vu_id,
                iter_id,
            };
            let outcome = execute_step(&client, step, &ctx).await?;
            iter_vars.extend(outcome.extracted.clone());
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
```

Note `div_ceil` is stable for `u32` since Rust 1.79. Our MSRV is 1.85, so it's fine.

- [ ] **Step 5: Re-export `EngineError`**

Edit `crates/engine/src/lib.rs`. Ensure `pub use error::EngineError;` is present so integration tests can use `handicap_engine::EngineError::Aborted`.

- [ ] **Step 6: Update Slice 1's runner_e2e test signature**

`crates/engine/tests/runner_e2e.rs` constructs `RunPlan { vus, duration }` — update it to include `ramp_up: Duration::from_secs(0)` and `env: BTreeMap::new()`, and pass `CancellationToken::new()` to `run_scenario`. Add the necessary imports.

Concretely, the line near the top of the file:

```rust
    let plan = RunPlan {
        vus: 5,
        duration: Duration::from_secs(2),
    };
```

becomes:

```rust
    let plan = RunPlan {
        vus: 5,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: std::collections::BTreeMap::new(),
    };
```

And:

```rust
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx).await.expect("runs");
    });
```

becomes:

```rust
    let cancel = tokio_util::sync::CancellationToken::new();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel).await.expect("runs");
    });
```

Apply the same fix to `crates/engine/tests/all_vus_failed.rs` (same pattern; add the `ramp_up`, `env`, `cancel` parameters).

- [ ] **Step 7: Run all engine tests**

```bash
cargo test -p handicap-engine
```

Expected: all pass, including:
- `multi_step::token_extracted_and_reused_in_next_step`
- `multi_step::cookie_jar_session_flow_works`
- `multi_step::env_var_substitution_in_url`
- `multi_step::cancellation_stops_run_quickly`
- `ramp_up::ramp_up_increases_count_over_time`
- pre-existing `runner_e2e`, `all_vus_failed`

If `ramp_up_increases_count_over_time` is flaky in CI (it depends on timing), the threshold is `first < later` — generous. If your CI is so slow that the first window already accumulates as much as steady-state, increase `vus` to 40 or extend `duration` to 5 s.

- [ ] **Step 8: Commit**

```bash
git add crates/engine/src/runner.rs crates/engine/src/lib.rs crates/engine/tests/multi_step.rs crates/engine/tests/ramp_up.rs crates/engine/tests/runner_e2e.rs crates/engine/tests/all_vus_failed.rs
git commit -m "feat(engine): ramp-up, env, flow vars, cancellation token in runner"
```

---

## Task 7: Property tests (`proptest`) — template + scenario round-trip + extract eval

**Files:**
- Create: `crates/engine/tests/proptests.rs`

The integration tests above pin specific paths through the engine. Property tests guard against the *kinds* of bugs unit tests miss: a template renderer that panics on a stray `${`, a YAML round-trip that loses information on a deeply nested body, an extractor that returns different values for the same input on different runs.

We deliberately keep the strategies (`Strategy<Value=Scenario>`, etc.) small — just enough to test the contract, not a full fuzzer.

- [ ] **Step 1: Write the property tests**

Create `crates/engine/tests/proptests.rs`:

```rust
use std::collections::BTreeMap;

use handicap_engine::{Scenario, evaluate_extracts};
use handicap_engine::scenario::{
    Assertion, Body, CookieJarMode, Extract, HttpMethod, Request, Step, StepKind,
};
use handicap_engine::template::{TemplateContext, render};
use handicap_engine::extract::ResponseFacts;
use proptest::collection::{btree_map, vec};
use proptest::option;
use proptest::prelude::*;

// ---- Strategies ----

fn arb_ident() -> impl Strategy<Value = String> {
    // a–z, 1–10 chars — keeps strategies small while exercising the parser
    "[a-z]{1,10}"
}

fn arb_http_method() -> impl Strategy<Value = HttpMethod> {
    prop_oneof![
        Just(HttpMethod::Get),
        Just(HttpMethod::Post),
        Just(HttpMethod::Put),
        Just(HttpMethod::Patch),
        Just(HttpMethod::Delete),
        Just(HttpMethod::Head),
        Just(HttpMethod::Options),
    ]
}

fn arb_assertion() -> impl Strategy<Value = Assertion> {
    (100u16..600u16).prop_map(Assertion::Status)
}

fn arb_extract() -> impl Strategy<Value = Extract> {
    prop_oneof![
        (arb_ident(), "[a-zA-Z_][a-zA-Z0-9_.$]{0,16}")
            .prop_map(|(var, path)| Extract::Body { var, path: format!("${path}") }),
        (arb_ident(), "[A-Za-z][A-Za-z0-9-]{0,20}")
            .prop_map(|(var, name)| Extract::Header { var, name }),
        (arb_ident(), "[A-Za-z][A-Za-z0-9_]{0,20}")
            .prop_map(|(var, name)| Extract::Cookie { var, name }),
        arb_ident().prop_map(|var| Extract::Status { var }),
    ]
}

fn arb_body() -> impl Strategy<Value = Body> {
    prop_oneof![
        ".*".prop_map(Body::Raw),
        btree_map(arb_ident(), ".*", 0..3).prop_map(Body::Form),
        // Keep JSON simple — string scalar value avoids serde_json::Value complications.
        ".*".prop_map(|s| Body::Json(serde_json::Value::String(s))),
    ]
}

fn arb_step() -> impl Strategy<Value = Step> {
    (
        // ULID-shaped fake (uppercase Crockford alphabet).
        "[0-9A-HJKMNP-TV-Z]{26}",
        arb_ident(),
        arb_http_method(),
        // URL with optional template — keeps strategy realistic.
        "(/[a-z0-9/_-]{0,20}|\\{\\{[a-z]{1,5}\\}\\}/[a-z0-9/_-]{0,10})",
        btree_map("[A-Za-z][A-Za-z0-9-]{0,10}", ".*", 0..3),
        option::of(arb_body()),
        vec(arb_assertion(), 0..3),
        vec(arb_extract(), 0..3),
    )
        .prop_map(|(id, name, method, url, headers, body, assert, extract)| Step {
            id,
            name,
            kind: StepKind::Http,
            request: Request {
                method,
                url,
                headers,
                body,
            },
            assert,
            extract,
        })
}

fn arb_scenario() -> impl Strategy<Value = Scenario> {
    (
        arb_ident(),
        prop_oneof![Just(CookieJarMode::Auto), Just(CookieJarMode::Off)],
        btree_map(arb_ident(), ".*", 0..3),
        vec(arb_step(), 0..4),
    )
        .prop_map(|(name, cookie_jar, variables, steps)| Scenario {
            version: 1,
            name,
            cookie_jar,
            variables,
            steps,
        })
}

// ---- Properties ----

proptest! {
    /// `template::render` must NEVER panic. Any input either renders or returns
    /// a typed error.
    #[test]
    fn template_render_never_panics(input in ".*") {
        let vars: BTreeMap<String, String> = BTreeMap::new();
        let env: BTreeMap<String, String> = BTreeMap::new();
        let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0 };
        let _ = render(&input, &ctx);
    }

    /// Round-trip: `Scenario → YAML → Scenario` is the identity.
    #[test]
    fn scenario_yaml_round_trip(s in arb_scenario()) {
        let y = s.to_yaml().expect("serialize");
        let s2 = Scenario::from_yaml(&y).expect(&format!("deserialize:\n{y}"));
        prop_assert_eq!(s, s2);
    }

    /// `extract::evaluate` is deterministic — same inputs always give the
    /// same outputs (no time/randomness/state).
    #[test]
    fn evaluate_is_deterministic(body in ".*", name in "[A-Z][A-Z0-9_]{0,8}") {
        let facts = ResponseFacts {
            status: 200,
            headers: &[("X-T".into(), "v".into())],
            set_cookies: &[format!("{name}=v; Path=/")],
            body: body.as_bytes(),
        };
        let xs = vec![
            Extract::Header { var: "h".into(), name: "X-T".into() },
            Extract::Cookie { var: "c".into(), name: name.clone() },
            Extract::Status { var: "s".into() },
        ];
        let a = evaluate_extracts(&xs, &facts);
        let b = evaluate_extracts(&xs, &facts);
        match (a, b) {
            (Ok(a), Ok(b)) => prop_assert_eq!(a, b),
            (Err(a), Err(b)) => prop_assert_eq!(a.to_string(), b.to_string()),
            _ => prop_assert!(false, "non-deterministic result"),
        }
    }
}
```

- [ ] **Step 2: Make sure required types are accessible from the integration test**

We use `handicap_engine::scenario::*`, `handicap_engine::extract::ResponseFacts`, and `handicap_engine::template::render`. Verify `lib.rs` exports these modules as `pub mod`. If not, edit `crates/engine/src/lib.rs`:

```rust
pub mod aggregator;
pub mod error;
pub mod executor;
pub mod extract;
pub mod runner;
pub mod scenario;
pub mod template;

pub use error::EngineError;
pub use runner::{RunPlan, run_scenario};
pub use scenario::Scenario;
pub use extract::evaluate as evaluate_extracts;
```

- [ ] **Step 3: Run the property tests**

```bash
cargo test -p handicap-engine --test proptests
```

Expected: PASS. Each property runs ~256 cases (proptest default). The whole file should complete in < 5 s on a laptop.

If a case shrinks down to a parsing edge that the engine genuinely doesn't handle, **do not weaken the property** — fix the engine. The whole point of property testing is to surface these.

- [ ] **Step 4: Commit**

```bash
git add crates/engine/tests/proptests.rs crates/engine/src/lib.rs
git commit -m "test(engine): proptest properties for render/round-trip/extract"
```

---

## Task 8: Proto — `env` on RunAssignment

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`

`AbortRun` already exists in the proto. We only need to add the env map.

- [ ] **Step 1: Edit the proto**

Edit `crates/proto/proto/coordinator.proto`. Replace the `RunAssignment` message:

```proto
message RunAssignment {
  string run_id = 1;
  string scenario_yaml = 2;     // canonical scenario YAML, snapshotted
  Profile profile = 3;
  map<string, string> env = 4;  // run-config env vars; resolved as ${NAME}
}
```

Update the leading comment on the `Profile` message to drop the "(populated but ignored)" parenthetical now that ramp-up is honored:

```proto
message Profile {
  uint32 vus = 1;
  uint32 ramp_up_seconds = 2;
  uint32 duration_seconds = 3;
}
```

- [ ] **Step 2: Rebuild — `tonic-build` regenerates code**

```bash
cargo build --workspace
```

Expected: compile errors in `crates/controller/src/grpc/coordinator.rs` and `crates/worker/src/main.rs` because they construct `RunAssignment` without the new `env` field. We fix those in Tasks 9–10.

- [ ] **Step 3: Patch the two call sites to keep workspace green between tasks**

In `crates/controller/src/grpc/coordinator.rs`, find every `RunAssignment { ... }` literal and add `env: Default::default()`. Same for any `Assignment` constructed in `worker/src/main.rs` (worker reads; it doesn't construct). For the controller, we'll fill env from the run's env_json in Task 10.

- [ ] **Step 4: Verify workspace still builds**

```bash
cargo build --workspace --tests
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/proto/proto/coordinator.proto crates/controller/src/grpc/coordinator.rs
git commit -m "proto: add env map to RunAssignment"
```

---

## Task 9: Worker — env, ramp-up, abort plumbing

**Files:**
- Modify: `crates/worker/src/main.rs`
- Modify: `crates/worker/src/client.rs`

The worker currently:
- Receives `RunAssignment`
- Builds a `RunPlan { vus, duration }`
- Calls `run_scenario(...)`

After Slice 4:
- Build a `RunPlan` with `ramp_up: Duration::from_secs(profile.ramp_up_seconds.into())`, `env: assignment.env`.
- Create a `CancellationToken` and observe `AbortRun` messages from the server. When an `AbortRun` for the current `run_id` arrives, call `cancel.cancel()`.

The client module (`worker/src/client.rs`) already handles the bidi stream. We extend it to surface inbound messages as a channel the main loop can consume.

- [ ] **Step 1: Read the current worker structure**

```bash
cat crates/worker/src/main.rs crates/worker/src/client.rs
```

Confirm the message flow:
- `client.rs` returns an inbound stream
- `main.rs` matches on `assignment` / `abort` / `ping`

If the client already exposes inbound messages to main, we route abort there. If not, we add a small channel.

- [ ] **Step 2: Update `RunPlan` construction**

In `crates/worker/src/main.rs`, find the block that builds `RunPlan` (around line 50). Replace:

```rust
    let plan = RunPlan {
        vus: profile.vus,
        duration: Duration::from_secs(profile.duration_seconds.into()),
    };
```

with:

```rust
    let env: std::collections::BTreeMap<String, String> = assignment.env.into_iter().collect();
    let plan = RunPlan {
        vus: profile.vus,
        ramp_up: Duration::from_secs(profile.ramp_up_seconds.into()),
        duration: Duration::from_secs(profile.duration_seconds.into()),
        env,
    };
```

- [ ] **Step 3: Wire `CancellationToken` + abort listener**

In `crates/worker/src/main.rs`, after the `assignment` is received and before the `run_scenario` spawn, add:

```rust
    let cancel = tokio_util::sync::CancellationToken::new();
    let cancel_for_listener = cancel.clone();
    let assignment_run_id = assignment.run_id.clone();
    // Listener: drain remaining inbound messages from the server and
    // observe AbortRun for our run_id.
    let abort_listener = tokio::spawn(async move {
        while let Some(msg) = inbound.recv().await {
            match msg.payload {
                Some(handicap_proto::v1::server_message::Payload::Abort(a))
                    if a.run_id == assignment_run_id =>
                {
                    cancel_for_listener.cancel();
                    break;
                }
                _ => {}
            }
        }
    });
```

(`inbound` is the receiver-half of an `mpsc` set up by `client.rs`. If your current `main.rs` consumes inbound messages directly in the same task that processes `assignment`, refactor so that after assignment is taken, the remaining `inbound.recv()` loop runs in a dedicated task and exposes a `cancel` token. The exact diff depends on the current `main.rs` shape — keep the change minimal but ensure the listener can detect Abort *while the run is in progress*.)

Update the `run_scenario` call to pass `cancel.clone()`:

```rust
    if let Err(e) = run_scenario(scenario, plan, metrics_tx, cancel.clone()).await {
        if matches!(e, handicap_engine::EngineError::Aborted) {
            tracing::info!(run_id = %assignment.run_id, "run aborted");
        } else {
            tracing::warn!(run_id = %assignment.run_id, error = ?e, "run failed");
        }
    }
```

Also send the right `RunStatus` back to the controller — `Phase::Failed` for `Aborted` is wrong; the controller already marks aborted itself when it dispatches abort. The worker can use `Phase::Completed` if it was a clean cancel, or `Phase::Failed` for other errors. (Simpler: leave the controller to decide; the worker says `Failed` only on engine errors *other than* Aborted.)

- [ ] **Step 4: Build the worker**

```bash
cargo build -p handicap-worker
```

Expected: clean.

- [ ] **Step 5: Cargo deps for worker — add `tokio-util`**

If `crates/worker/Cargo.toml` doesn't already pull `tokio-util`, add:

```toml
tokio-util = { workspace = true, features = ["rt"] }
```

Verify build again:

```bash
cargo build -p handicap-worker
```

- [ ] **Step 6: Commit**

```bash
git add crates/worker/src/main.rs crates/worker/src/client.rs crates/worker/Cargo.toml
git commit -m "feat(worker): env/ramp/abort plumbing to engine RunPlan + cancellation"
```

---

## Task 10: Controller — env passthrough, abort endpoint, e2e

**Files:**
- Modify: `crates/controller/src/api/runs.rs`
- Modify: `crates/controller/src/grpc/coordinator.rs`
- Modify: `crates/controller/src/store/runs.rs`
- Modify: `crates/controller/tests/api_test.rs`
- Modify: `crates/controller/tests/e2e_test.rs`

Two changes:

1. **env passthrough.** The run row already has `env_json`. When the coordinator dispatches an assignment, deserialize that into `BTreeMap<String, String>` (filtering out non-string values to keep types simple — env vars are stringly-typed) and stuff into `RunAssignment.env`.
2. **Abort endpoint.** `POST /api/runs/{id}/abort` checks the run exists and is in `running` status, sends `AbortRun { run_id }` to the worker over the existing stream (via a coordinator handle), and marks the run as `aborted`.

The coordinator already routes `RunAssignment` to workers; the existing pattern in `grpc/coordinator.rs` should be extensible to also route `AbortRun`.

- [ ] **Step 1: Failing API test — POST /abort**

In `crates/controller/tests/api_test.rs`, add a new test:

```rust
#[tokio::test]
async fn abort_run_marks_run_aborted() {
    let (client, _ctx) = start_test_controller().await;

    // 1. Create scenario + run (mirror existing "create run" test setup).
    let scenario = client
        .post("/api/scenarios")
        .json(&serde_json::json!({
            "yaml": include_str!("../../engine/tests/fixtures/single_step.yaml")
        }))
        .send()
        .await
        .unwrap();
    let scenario: serde_json::Value = scenario.json().await.unwrap();
    let scenario_id = scenario["id"].as_str().unwrap();

    let run_resp = client
        .post("/api/runs")
        .json(&serde_json::json!({
            "scenario_id": scenario_id,
            "profile": { "vus": 1, "duration_seconds": 30 },
            "env": {}
        }))
        .send()
        .await
        .unwrap();
    let run: serde_json::Value = run_resp.json().await.unwrap();
    let run_id = run["id"].as_str().unwrap();

    // Wait until status flips to running. (Worker is spawned by controller.)
    let mut tries = 0;
    loop {
        let r = client
            .get(&format!("/api/runs/{run_id}"))
            .send()
            .await
            .unwrap();
        let body: serde_json::Value = r.json().await.unwrap();
        if body["status"] == "running" || tries > 50 {
            break;
        }
        tries += 1;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    // 2. Abort.
    let abort = client
        .post(&format!("/api/runs/{run_id}/abort"))
        .send()
        .await
        .unwrap();
    assert_eq!(abort.status(), 200);

    // 3. Within 5s, the run should land in `aborted`.
    let mut final_status = String::new();
    for _ in 0..50 {
        let r = client
            .get(&format!("/api/runs/{run_id}"))
            .send()
            .await
            .unwrap();
        let body: serde_json::Value = r.json().await.unwrap();
        final_status = body["status"].as_str().unwrap().to_string();
        if final_status == "aborted" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(final_status, "aborted");
}
```

Adapt the `start_test_controller`, helper imports, etc. to match the existing test scaffolding pattern in `api_test.rs`. Read the surrounding code for the precise call shape.

- [ ] **Step 2: Run to confirm fails**

```bash
cargo test -p handicap-controller --test api_test abort_run_marks_run_aborted
```

Expected: 404 from `POST /api/runs/{id}/abort` (route not defined).

- [ ] **Step 3: Add the abort handler**

In `crates/controller/src/api/runs.rs`, add a handler:

```rust
pub async fn abort_run(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> std::result::Result<StatusCode, ApiError> {
    let run = app.runs.get_run(&id).await?.ok_or(ApiError::NotFound)?;
    if run.status != "running" && run.status != "pending" {
        return Err(ApiError::Conflict(format!(
            "cannot abort run in status {}",
            run.status
        )));
    }
    app.coordinator.abort(&id).await?;
    app.runs.mark_aborted(&id).await?;
    Ok(StatusCode::OK)
}
```

(Names depend on the existing `AppState` shape — adapt to whatever the file uses for the runs store and the coordinator handle. The pattern is "lookup → check status → tell coordinator → mark store".)

Register the route in the router builder for `/api/runs/{id}/abort`.

- [ ] **Step 4: Coordinator abort routing**

In `crates/controller/src/grpc/coordinator.rs`, add a method to the coordinator handle that sends `AbortRun` to the worker for a given `run_id`. The coordinator already maintains a mapping `run_id → outbound_tx` (it must, to deliver `Assignment`). Reuse that mapping:

```rust
pub async fn abort(&self, run_id: &str) -> Result<(), CoordError> {
    let outbound = self.outbound_for(run_id).await.ok_or(CoordError::UnknownRun)?;
    let msg = ServerMessage {
        payload: Some(server_message::Payload::Abort(AbortRun {
            run_id: run_id.to_string(),
            reason: "user requested".into(),
        })),
    };
    outbound.send(msg).await.map_err(|_| CoordError::WorkerGone)?;
    Ok(())
}
```

(Again, the exact API names depend on the existing handle. Adapt.)

- [ ] **Step 5: `mark_aborted` store helper**

In `crates/controller/src/store/runs.rs`, add:

```rust
pub async fn mark_aborted(&self, id: &str) -> Result<(), sqlx::Error> {
    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE runs SET status = 'aborted', ended_at = ?1 WHERE id = ?2")
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 6: env passthrough in assignment**

In `crates/controller/src/grpc/coordinator.rs` (or wherever assignments are built), parse `env_json` from the run row into a `BTreeMap<String, String>`:

```rust
let env: std::collections::BTreeMap<String, String> =
    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&run.env_json)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
        .collect();
let assignment = RunAssignment {
    run_id: run.id.clone(),
    scenario_yaml: run.scenario_yaml.clone(),
    profile: Some(profile),
    env: env.into_iter().collect(),
};
```

(Adapt to wherever the assignment is actually constructed — `Default::default()` was the placeholder from Task 8.)

- [ ] **Step 7: Extend e2e for two-step + env**

In `crates/controller/tests/e2e_test.rs`, add a second e2e case that:

1. Boots a `wiremock` server with `/login` (returns `{"access_token":"T"}`) and `/me` (requires `Authorization: Bearer T`).
2. Creates a two-step scenario whose URL uses `${BASE_URL}`.
3. POSTs a run with `env: { "BASE_URL": "<wiremock uri>" }` and a 2 s duration.
4. Polls `/runs/{id}` until completed.
5. Asserts `status == "completed"` and `metrics` shows both steps with non-zero `count` and zero `error_count`.

Use the structure of the existing e2e test as the template.

- [ ] **Step 8: Run all controller tests**

```bash
cargo test -p handicap-controller
```

Expected: PASS, including the new abort test, the new two-step e2e, and all pre-existing tests.

- [ ] **Step 9: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/src/grpc/coordinator.rs crates/controller/src/store/runs.rs crates/controller/tests/api_test.rs crates/controller/tests/e2e_test.rs
git commit -m "feat(controller): env passthrough + abort endpoint + e2e for two-step/abort"
```

---

## Task 11: UI scenario model — add `Extract` (drop the normalizer workaround)

**Files:**
- Modify: `ui/src/scenario/model.ts`
- Modify: `ui/src/scenario/__tests__/model.test.ts`

The Slice 3 normalizer in `yamlDoc.ts` strips `extract` before Zod validation because the model didn't have it. Now we add `Extract` to the model. The normalizer change lands in Task 12.

- [ ] **Step 1: Failing tests**

In `ui/src/scenario/__tests__/model.test.ts`, append:

```ts
import { ExtractModel, type Extract } from "../model";

describe("ExtractModel", () => {
  it("accepts the four variants", () => {
    const cases: Extract[] = [
      { var: "t", from: "body", path: "$.x" },
      { var: "h", from: "header", name: "X-Trace" },
      { var: "c", from: "cookie", name: "JSESSIONID" },
      { var: "s", from: "status" },
    ];
    for (const c of cases) {
      expect(() => ExtractModel.parse(c)).not.toThrow();
    }
  });

  it("rejects body extract without path", () => {
    expect(() => ExtractModel.parse({ var: "x", from: "body" })).toThrow();
  });

  it("rejects header extract without name", () => {
    expect(() => ExtractModel.parse({ var: "x", from: "header" })).toThrow();
  });

  it("rejects unknown from", () => {
    expect(() =>
      ExtractModel.parse({ var: "x", from: "headers", name: "X" }),
    ).toThrow();
  });
});

describe("ScenarioModel + extract", () => {
  it("accepts a step with extracts", () => {
    const value = {
      version: 1,
      name: "demo",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000001",
          name: "login",
          type: "http",
          request: { method: "POST", url: "/x" },
          assert: [],
          extract: [{ var: "token", from: "body", path: "$.access_token" }],
        },
      ],
    };
    expect(() => ScenarioModel.parse(value)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run them — they fail**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/model.test.ts
```

Expected: FAIL — `ExtractModel` not exported.

- [ ] **Step 3: Add `ExtractModel` and `Step.extract`**

In `ui/src/scenario/model.ts`, insert before `StepModel`:

```ts
export const ExtractModel = z.discriminatedUnion("from", [
  z
    .object({
      var: z.string().min(1),
      from: z.literal("body"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      var: z.string().min(1),
      from: z.literal("header"),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      var: z.string().min(1),
      from: z.literal("cookie"),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      var: z.string().min(1),
      from: z.literal("status"),
    })
    .strict(),
]);
export type Extract = z.infer<typeof ExtractModel>;
```

Update `StepModel` to add the `extract` field:

```ts
export const StepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("http"),
    request: RequestModel,
    assert: z.array(AssertionModel).default([]),
    extract: z.array(ExtractModel).default([]),
  })
  .strict();
```

- [ ] **Step 4: Run model tests**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/model.test.ts
```

Expected: PASS (all old + new).

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/model.ts ui/src/scenario/__tests__/model.test.ts
git commit -m "feat(ui): ExtractModel + Step.extract in scenario model"
```

---

## Task 12: UI yamlDoc — extract round-trip + setStepExtract edit

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts`
- Modify: `ui/src/scenario/__tests__/yamlDoc.test.ts`

Slice 3's normalizer drops `extract`. Now it must:
- Reshape the YAML representation `{ var, from, path/name }` into the model shape (which is identical — no reshape needed, but we DO need to include extract in the normalizer output).
- Round-trip should preserve `extract` on the model (already preserved on the doc — we tested that in Slice 3).

Add `Edit::setStepExtract` so the inspector can replace the whole extract list for a step. (Same pattern as `setStepAssert`.)

- [ ] **Step 1: Failing tests**

In `ui/src/scenario/__tests__/yamlDoc.test.ts`, append:

```ts
describe("extract — model integration", () => {
  it("model now exposes extract on the step", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    expect(out.model.steps[0].extract).toEqual([
      { var: "token", from: "body", path: "$.token" },
    ]);
  });

  it("round-trips extract through model+doc edits", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");

    applyEdit(out.doc, {
      type: "setStepExtract",
      stepId: "01HX0000000000000000000001",
      extract: [
        { var: "token", from: "body", path: "$.access_token" },
        { var: "trace", from: "header", name: "X-Trace" },
      ],
    });
    const round = serializeDoc(out.doc);
    expect(round).toContain("X-Trace");
    expect(round).toContain("access_token");
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error("re-parse failed");
    expect(out2.model.steps[0].extract).toEqual([
      { var: "token", from: "body", path: "$.access_token" },
      { var: "trace", from: "header", name: "X-Trace" },
    ]);
  });

  it("setting empty extract clears the key", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setStepExtract",
      stepId: "01HX0000000000000000000001",
      extract: [],
    });
    const round = serializeDoc(out.doc);
    expect(round).not.toMatch(/extract:\s/);
  });
});
```

- [ ] **Step 2: Run them**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/yamlDoc.test.ts
```

Expected: FAIL — `setStepExtract` edit not handled; model.extract undefined.

- [ ] **Step 3: Update yamlDoc.ts**

In `ui/src/scenario/yamlDoc.ts`:

1. Add `setStepExtract` to the `Edit` union:

```ts
  | {
      type: "setStepExtract";
      stepId: string;
      extract: ReadonlyArray<
        | { var: string; from: "body"; path: string }
        | { var: string; from: "header"; name: string }
        | { var: string; from: "cookie"; name: string }
        | { var: string; from: "status" }
      >;
    };
```

2. Handle in `applyEdit`:

```ts
    case "setStepExtract": {
      const idx = findStepIndex(doc, edit.stepId);
      if (idx === -1) return;
      if (edit.extract.length === 0) {
        doc.deleteIn(["steps", idx, "extract"]);
        return;
      }
      doc.setIn(["steps", idx, "extract"], doc.createNode(edit.extract));
      return;
    }
```

3. Update `normalizeStep` to include extract:

```ts
function normalizeStep(s: unknown): unknown {
  if (typeof s !== "object" || s === null) return s;
  const src = s as Record<string, unknown>;
  const request =
    typeof src.request === "object" && src.request !== null
      ? normalizeRequest(src.request as Record<string, unknown>)
      : src.request;
  const assert = Array.isArray(src.assert) ? src.assert.map(normalizeAssertion) : [];
  const extract = Array.isArray(src.extract) ? src.extract : [];
  return {
    id: src.id,
    name: src.name,
    type: src.type,
    request,
    assert,
    extract,
  };
}
```

- [ ] **Step 4: Run yamlDoc tests**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/yamlDoc.test.ts
```

Expected: PASS (all old + 3 new).

- [ ] **Step 5: Run full UI suite to catch fallout**

```bash
cd ui && pnpm test
```

Expected: PASS. (Existing store tests should continue to pass — they don't touch extract.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git commit -m "feat(ui): extract surfaced on model + setStepExtract edit"
```

---

## Task 13: UI store — `setStepExtract` + property tests for round-trip

**Files:**
- Modify: `ui/src/scenario/store.ts`
- Modify: `ui/src/scenario/__tests__/store.test.ts`
- Create: `ui/src/scenario/__tests__/proptests.test.ts`

- [ ] **Step 1: Failing tests**

In `ui/src/scenario/__tests__/store.test.ts`, append:

```ts
import type { Extract } from "../model";

describe("setStepExtract", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("replaces the extract list and reflects in yamlText", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const stepId = "01HX0000000000000000000001";
    const extracts: Extract[] = [
      { var: "token", from: "body", path: "$.access_token" },
    ];
    useScenarioEditor.getState().setStepExtract(stepId, extracts);
    const s = useScenarioEditor.getState();
    expect(s.model!.steps[0].extract).toEqual(extracts);
    expect(s.yamlText).toContain("$.access_token");
  });
});
```

- [ ] **Step 2: Run — fails**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/store.test.ts
```

Expected: FAIL — `setStepExtract` action not defined.

- [ ] **Step 3: Add action to store**

In `ui/src/scenario/store.ts`, append to the interface:

```ts
  setStepExtract(stepId: string, extract: ReadonlyArray<Extract>): void;
```

(Import `Extract` from `./model`.)

Add to the store body:

```ts
  setStepExtract(stepId, extract) {
    dispatch(set, get, { type: "setStepExtract", stepId, extract });
  },
```

And to the `getInitialState` shim — add `setStepExtract: useScenarioEditor.getState().setStepExtract,`.

- [ ] **Step 4: Run store tests**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add fast-check property tests**

Create `ui/src/scenario/__tests__/proptests.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ScenarioModel, type Scenario, type Extract } from "../model";
import { parseScenarioDoc, serializeDoc } from "../yamlDoc";

const ULID_ARB = fc.string({ minLength: 26, maxLength: 26 }).map((s) =>
  s
    .toUpperCase()
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, "0")
    .padEnd(26, "0")
    .slice(0, 26),
);

const httpMethod = fc.constantFrom(
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
);

const ident = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);

const extractArb: fc.Arbitrary<Extract> = fc.oneof(
  fc.record({
    var: ident,
    from: fc.constant("body" as const),
    path: fc
      .stringMatching(/^[a-zA-Z_.][a-zA-Z0-9_.$]{0,16}$/)
      .map((p) => `$${p.startsWith(".") ? p : "." + p}`),
  }),
  fc.record({
    var: ident,
    from: fc.constant("header" as const),
    name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,12}$/),
  }),
  fc.record({
    var: ident,
    from: fc.constant("cookie" as const),
    name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,12}$/),
  }),
  fc.record({
    var: ident,
    from: fc.constant("status" as const),
  }),
);

const stepArb = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("http" as const),
  request: fc.record({
    method: httpMethod,
    url: fc.stringMatching(/^\/[a-z0-9/_-]{0,20}$/),
    headers: fc.dictionary(
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,10}$/),
      fc.stringMatching(/^[a-zA-Z0-9 .,:/_-]{0,30}$/),
      { maxKeys: 2 },
    ),
  }),
  assert: fc.array(
    fc.record({
      kind: fc.constant("status" as const),
      code: fc.integer({ min: 100, max: 599 }),
    }),
    { maxLength: 2 },
  ),
  extract: fc.array(extractArb, { maxLength: 2 }),
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  version: fc.constant(1 as const),
  name: ident,
  cookie_jar: fc.constantFrom("auto" as const, "off" as const),
  variables: fc.dictionary(
    ident,
    fc.stringMatching(/^[a-zA-Z0-9 .,:/_-]{0,30}$/),
    { maxKeys: 3 },
  ),
  steps: fc.array(stepArb, { maxLength: 3 }),
});

describe("scenario round-trip property", () => {
  it("ScenarioModel parses what serializeDoc(parseScenarioDoc(text).doc) outputs", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        // Build the YAML by JSON-stringifying then parseScenarioDoc-ing the
        // canonical YAML form. We use a small canonical-YAML helper:
        const yaml = scenarioToCanonicalYaml(s);
        const parsed = parseScenarioDoc(yaml);
        if ("error" in parsed) {
          throw new Error(`parseScenarioDoc failed: ${parsed.error}\n--\n${yaml}`);
        }
        const round = serializeDoc(parsed.doc);
        const reparsed = parseScenarioDoc(round);
        if ("error" in reparsed) {
          throw new Error(`re-parse failed: ${reparsed.error}\n--\n${round}`);
        }
        // Model after one round-trip should equal model after two.
        expect(reparsed.model).toEqual(parsed.model);
      }),
      { numRuns: 40 },
    );
  });
});

// Minimal canonical YAML for the test — emits the exact shape ScenarioModel
// expects WITHOUT going through yaml.Document, so we test the read-path on
// arbitrary inputs rather than against our own writer's biases.
function scenarioToCanonicalYaml(s: Scenario): string {
  const obj = {
    version: s.version,
    name: s.name,
    cookie_jar: s.cookie_jar,
    variables: s.variables,
    steps: s.steps.map((st) => {
      const out: Record<string, unknown> = {
        id: st.id,
        name: st.name,
        type: st.type,
        request: {
          method: st.request.method,
          url: st.request.url,
          headers: st.request.headers ?? {},
        },
        assert: st.assert.map((a) => ({ status: a.code })),
      };
      if (st.extract && st.extract.length > 0) {
        out.extract = st.extract.map((e) => {
          if (e.from === "body") return { var: e.var, from: "body", path: e.path };
          if (e.from === "header") return { var: e.var, from: "header", name: e.name };
          if (e.from === "cookie") return { var: e.var, from: "cookie", name: e.name };
          return { var: e.var, from: "status" };
        });
      }
      return out;
    }),
  };
  // serialize via the same library we use in production
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yamlPkg = require("yaml");
  return yamlPkg.stringify(obj);
}
```

(If the `require` style isn't allowed by your ESLint config, replace with a top-of-file `import { stringify as yamlStringify } from "yaml";` and call `yamlStringify(obj)`.)

- [ ] **Step 6: Run proptests**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/proptests.test.ts
```

Expected: PASS, 1 property runs 40 cases. If a case fails (e.g., shrinks down to a URL that survives our regex but breaks parseScenarioDoc), **do not weaken the property** — fix the bug.

- [ ] **Step 7: Run full UI suite**

```bash
cd ui && pnpm test
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add ui/src/scenario/store.ts ui/src/scenario/__tests__/store.test.ts ui/src/scenario/__tests__/proptests.test.ts
git commit -m "feat(ui): store setStepExtract + fast-check round-trip property"
```

---

## Task 14: Inspector ExtractEditor (real RTL tests)

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx`
- Modify: `ui/src/components/scenario/__tests__/Inspector.test.tsx`

A new section in the Inspector beneath the Assertions block. Layout per row: `var` text input · `from` select (body/header/cookie/status) · conditional second field (`path` for body, `name` for header/cookie, nothing for status) · delete button. An "Add" row underneath. Disabled state when there's no selected step (the entire Inspector is hidden in that case — existing behavior).

The RTL test exercises the *full path*: render the Inspector with a loaded store, interact, then read back `useScenarioEditor.getState().yamlText` to verify the YAML now contains the expected extract entry.

- [ ] **Step 1: Write the failing RTL tests**

Replace `ui/src/components/scenario/__tests__/Inspector.test.tsx` entirely with:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";

const VALID_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
`;

function loadAndSelect() {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  useScenarioEditor.getState().loadFromString(VALID_YAML);
  useScenarioEditor.getState().select("01HX0000000000000000000001");
}

describe("Inspector — placeholder", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("shows placeholder when no step is selected", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    render(<Inspector />);
    expect(screen.getByText(/Select a step/i)).toBeInTheDocument();
  });
});

describe("Inspector — ExtractEditor", () => {
  beforeEach(() => loadAndSelect());

  it("adds a body extract row and writes it to the YAML", async () => {
    const user = userEvent.setup();
    render(<Inspector />);

    // Open the Extract section — it's labelled by a fieldset.
    const extractSection = screen.getByRole("group", { name: /Extracts?/i });
    const addBtn = within(extractSection).getByRole("button", { name: /Add/i });
    await user.click(addBtn);

    // A new row appears. Default `from` is "body"; set var + path.
    const varInput = within(extractSection).getByPlaceholderText("var");
    await user.clear(varInput);
    await user.type(varInput, "token");

    const pathInput = within(extractSection).getByPlaceholderText("$.path");
    await user.clear(pathInput);
    await user.type(pathInput, "$.access_token");

    // Move focus so onBlur dispatches commit (textarea-style fields blur on Tab).
    await user.tab();

    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toMatch(/extract:/);
    expect(yaml).toMatch(/var:\s*token/);
    expect(yaml).toMatch(/path:\s*"?\$\.access_token"?/);
    expect(yaml).toMatch(/from:\s*body/);
  });

  it("switching from to header swaps the second field from path to name", async () => {
    const user = userEvent.setup();
    render(<Inspector />);

    const extractSection = screen.getByRole("group", { name: /Extracts?/i });
    await user.click(within(extractSection).getByRole("button", { name: /Add/i }));

    const fromSelect = within(extractSection).getByLabelText("extract-from-0");
    await user.selectOptions(fromSelect, "header");

    expect(within(extractSection).queryByPlaceholderText("$.path")).toBeNull();
    expect(within(extractSection).getByPlaceholderText("header name")).toBeInTheDocument();
  });

  it("removes a row when its delete button is clicked", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const extractSection = screen.getByRole("group", { name: /Extracts?/i });

    await user.click(within(extractSection).getByRole("button", { name: /Add/i }));
    await user.type(within(extractSection).getByPlaceholderText("var"), "t");
    await user.type(within(extractSection).getByPlaceholderText("$.path"), "$.x");
    await user.tab();

    expect(useScenarioEditor.getState().yamlText).toMatch(/extract:/);

    const removeBtn = within(extractSection).getByRole("button", {
      name: /Remove extract 0/i,
    });
    await user.click(removeBtn);

    expect(useScenarioEditor.getState().yamlText).not.toMatch(/extract:/);
  });
});
```

- [ ] **Step 2: Run — they fail**

```bash
cd ui && pnpm vitest run src/components/scenario/__tests__/Inspector.test.tsx
```

Expected: FAIL — no Extracts fieldset, no Add button matching our query.

- [ ] **Step 3: Add `ExtractEditor` to `Inspector.tsx`**

In `ui/src/components/scenario/Inspector.tsx`:

Add `Extract` import:

```ts
import type { Body, Extract, HttpMethod, Step } from "../../scenario/model";
```

Add to the `StepInspector` JSX, after `AssertEditor`:

```tsx
      <ExtractEditor step={step} />
```

Add the component (paste verbatim near the other editors):

```tsx
function ExtractEditor({ step }: { step: Step }) {
  const setStepExtract = useScenarioEditor((s) => s.setStepExtract);

  const setRow = (idx: number, next: Extract) => {
    const list = step.extract.slice();
    list[idx] = next;
    setStepExtract(step.id, list);
  };
  const remove = (idx: number) => {
    setStepExtract(
      step.id,
      step.extract.filter((_, i) => i !== idx),
    );
  };
  const append = () => {
    setStepExtract(step.id, [
      ...step.extract,
      { var: "", from: "body", path: "$." },
    ]);
  };

  return (
    <fieldset
      className="flex flex-col gap-2 border border-slate-200 rounded p-3"
      aria-label="Extracts"
    >
      <legend className="px-1 text-xs font-semibold text-slate-600">Extracts</legend>
      <ul className="flex flex-col gap-2">
        {step.extract.map((x, idx) => (
          <li key={idx} className="flex flex-wrap gap-2 items-center text-xs">
            <input
              placeholder="var"
              className="border border-slate-300 rounded px-2 py-1 font-mono w-24"
              value={x.var}
              onChange={(e) => setRow(idx, { ...x, var: e.target.value })}
            />
            <select
              aria-label={`extract-from-${idx}`}
              className="border border-slate-300 rounded px-2 py-1"
              value={x.from}
              onChange={(e) => {
                const from = e.target.value as Extract["from"];
                if (from === "body") setRow(idx, { var: x.var, from, path: "$." });
                else if (from === "header") setRow(idx, { var: x.var, from, name: "" });
                else if (from === "cookie") setRow(idx, { var: x.var, from, name: "" });
                else setRow(idx, { var: x.var, from: "status" });
              }}
            >
              <option value="body">body</option>
              <option value="header">header</option>
              <option value="cookie">cookie</option>
              <option value="status">status</option>
            </select>
            {x.from === "body" && (
              <input
                placeholder="$.path"
                className="border border-slate-300 rounded px-2 py-1 font-mono flex-1 min-w-[120px]"
                value={x.path}
                onChange={(e) => setRow(idx, { ...x, path: e.target.value })}
              />
            )}
            {(x.from === "header" || x.from === "cookie") && (
              <input
                placeholder={x.from === "header" ? "header name" : "cookie name"}
                className="border border-slate-300 rounded px-2 py-1 font-mono flex-1 min-w-[120px]"
                value={x.name}
                onChange={(e) => setRow(idx, { ...x, name: e.target.value })}
              />
            )}
            {x.from === "status" && (
              <span className="text-slate-400 italic flex-1">no extra field</span>
            )}
            <button
              type="button"
              aria-label={`Remove extract ${idx}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => remove(idx)}
            >
              ×
            </button>
          </li>
        ))}
        {step.extract.length === 0 && (
          <li className="text-xs text-slate-400 italic">No extracts</li>
        )}
      </ul>
      <button
        type="button"
        className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
        onClick={append}
      >
        Add
      </button>
    </fieldset>
  );
}
```

- [ ] **Step 4: Run RTL tests**

```bash
cd ui && pnpm vitest run src/components/scenario/__tests__/Inspector.test.tsx
```

Expected: PASS, 4 tests (1 placeholder + 3 ExtractEditor).

If a test fails because `setStepExtract` dispatches with stale React state (the "click add then type before re-render" timing), make sure your component reads `step.extract` from the current store snapshot inside the closure. With Zustand selectors that's automatic.

- [ ] **Step 5: Full UI suite**

```bash
cd ui && pnpm test
```

Expected: PASS across all files.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): inspector extract editor + real RTL tests"
```

---

## Task 15: RunDetailPage Abort button + RTL test

**Files:**
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/api/hooks.ts`
- Modify: `ui/src/pages/RunDetailPage.tsx`
- Create: `ui/src/pages/__tests__/RunDetailPage.test.tsx`

- [ ] **Step 1: Add API client + hook**

In `ui/src/api/client.ts`, append a method:

```ts
abortRun: (id: string) =>
  request<{}>(`/api/runs/${id}/abort`, { method: "POST" }, z.object({}).passthrough()),
```

(Use the same `request<T>` shape the file already uses. If responses for `POST` with empty body need a different parser, mirror what other void endpoints do.)

In `ui/src/api/hooks.ts`, append:

```ts
export function useAbortRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.abortRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["run", runId] });
    },
  });
}
```

- [ ] **Step 2: Failing RTL test**

Create `ui/src/pages/__tests__/RunDetailPage.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RunDetailPage } from "../RunDetailPage";

function renderWithRouter(runId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/runs/${runId}`]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RunDetailPage — abort", () => {
  it("shows Abort enabled only when status is running, and posts /abort", async () => {
    let phase = "running";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/runs/R1") && (!init || init.method !== "POST")) {
        return Promise.resolve(
          jsonResponse({
            id: "R1",
            scenario_id: "S1",
            status: phase,
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 5 },
            env: {},
            started_at: 1,
            ended_at: null,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs/R1/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R1", windows: [] }));
      }
      if (url.endsWith("/api/runs/R1/abort") && init?.method === "POST") {
        phase = "aborted";
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    const user = userEvent.setup();
    renderWithRouter("R1");

    // Abort button visible and enabled.
    const abortBtn = await screen.findByRole("button", { name: /Abort/i });
    expect(abortBtn).toBeEnabled();

    await user.click(abortBtn);

    // After mutation succeeds + polling re-fetches, status flips and the
    // button disappears (or disables) — assert on either form.
    await waitFor(() => {
      const stillThere = screen.queryByRole("button", { name: /Abort/i });
      expect(
        stillThere === null || (stillThere && (stillThere as HTMLButtonElement).disabled),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].endsWith("/api/runs/R1/abort") &&
          c[1]?.method === "POST",
      ),
    ).toBe(true);
  });

  it("hides Abort when status is completed", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/R2") || url.endsWith("/api/runs/R2/")) {
        return Promise.resolve(
          jsonResponse({
            id: "R2",
            scenario_id: "S1",
            status: "completed",
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 5 },
            env: {},
            started_at: 1,
            ended_at: 2,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs/R2/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R2", windows: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    renderWithRouter("R2");

    // Wait for initial fetch, then assert no Abort button.
    await screen.findByText(/completed/i);
    expect(screen.queryByRole("button", { name: /Abort/i })).toBeNull();
  });
});
```

- [ ] **Step 3: Run — fails**

```bash
cd ui && pnpm vitest run src/pages/__tests__/RunDetailPage.test.tsx
```

Expected: FAIL — no Abort button.

- [ ] **Step 4: Add Abort button to `RunDetailPage.tsx`**

Edit `ui/src/pages/RunDetailPage.tsx`. Near the top, import `useAbortRun`. Render an Abort button only when `run.status === "running"`:

```tsx
import { useAbortRun, useRun, useRunMetrics } from "../api/hooks";

// ... inside the component, after the run query:
const abort = useAbortRun(id ?? "");

// ... in the header area:
{run.status === "running" && (
  <button
    type="button"
    onClick={() => abort.mutate()}
    disabled={abort.isPending}
    className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
  >
    {abort.isPending ? "Aborting…" : "Abort"}
  </button>
)}
```

(Adapt to the existing JSX shape — the file has a header section with status + meta. The button goes in that header.)

- [ ] **Step 5: Run RTL tests**

```bash
cd ui && pnpm vitest run src/pages/__tests__/RunDetailPage.test.tsx
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Full suite + build**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add ui/src/api/client.ts ui/src/api/hooks.ts ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx
git commit -m "feat(ui): abort button on run detail + RTL test for state transitions"
```

---

## Task 16: Manual check + CLAUDE.md update

**Files:**
- Create: `docs/dev/ui-slice-4-manual-check.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Manual check runbook**

Create `docs/dev/ui-slice-4-manual-check.md`:

```markdown
# Slice 4 — UI 수동 점검 체크리스트

머지 직전에 실행. 개발 루프:

```bash
# T0 — wiremock 기반 가짜 API
docker run --rm -p 9090:8080 \
  -e WIREMOCK_OPTIONS="--global-response-templating" \
  wiremock/wiremock:3.7.0

# T1 — controller (UI 정적 서빙)
cargo run -p handicap-controller -- --rest-addr 127.0.0.1:8080 --ui-dir ui/dist

# T2 — UI dev (proxy)
cd ui && pnpm dev
```

`http://localhost:5173` 접속.

## 1. 토큰 인증 멀티스텝

- [ ] `/scenarios/new` → 캔버스에서 step 1 추가, name `login`, method `POST`,
      URL `${BASE_URL}/login`, body `{"u":"a","p":"b"}` JSON.
- [ ] Assertion 200 추가.
- [ ] **Extracts** 섹션에서 **Add** → var `token`, from `body`, path `$.access_token`.
- [ ] step 2 추가, name `me`, method `GET`, URL `${BASE_URL}/me`,
      headers: `Authorization: Bearer {{token}}`, assertion 200.
- [ ] YAML 탭으로 전환해 `extract:` 블록이 step 1에 보이는지 확인. 다시 캔버스로.
- [ ] **Create** → 생성된 scenario에서 **Runs** → **New run** → VUs 5 / duration 5s /
      env: `BASE_URL=http://localhost:9090/__admin/mappings` (또는 wiremock 매핑 URL).
- [ ] wiremock에 미리 `/login` (200 + body `{"access_token":"T0K3N"}`) 및 `/me` (Bearer 검사 + 200) stub 등록.
- [ ] 실행 페이지에서 status `running` → 종료 후 `completed`.
- [ ] 1초 시계열 메트릭이 step별로 보이고 error_count == 0.

## 2. 세션(쿠키) 인증

- [ ] 새 scenario `cookie_jar: auto`. step 1 POST `${BASE_URL}/login` (Set-Cookie 반환),
      step 2 GET `${BASE_URL}/profile` (Cookie 헤더 자동 첨부).
- [ ] step 1 Extracts 비움 (jar 자동 처리).
- [ ] 같은 VUs 5 / duration 5s로 실행. error_count == 0.
- [ ] (선택) wiremock 로그로 Cookie 헤더가 자동 첨부됨을 확인.

## 3. Ramp-up

- [ ] scenario는 (1)에서 만든 토큰 시나리오 재사용. VUs 50 / ramp_up 10s / duration 30s.
- [ ] 실행 시작 직후 첫 5초 동안 RPS가 단계적으로 증가하는 것 확인 (메트릭 표).
- [ ] ramp 종료 후 정상 plateau.

## 4. Abort

- [ ] 새 run: VUs 5 / duration 60s.
- [ ] 시작 후 ~3초 뒤 **Abort** 버튼 클릭.
- [ ] 5초 안에 status `aborted`로 전환, RPS 그래프 절단.
- [ ] Abort 버튼은 사라지거나 disabled.

## 5. 오프라인 런타임 (Slice 2/3 회귀)

- [ ] `pnpm build` → controller로 정적 서빙. DevTools 네트워크 → Offline (`/api` 만 허용).
- [ ] 페이지 로드 시 CDN 요청 없음. CSP 위반 없음. Monaco worker 정상 동작.

## 6. lint/test/build green

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cargo fmt --check && cargo build --workspace && cargo test --workspace
```

모두 통과.
```

- [ ] **Step 2: Update `CLAUDE.md`**

Update the status line:

Replace:

```
**상태: Slice 3(캔버스 + Monaco + 양방향 sync) 구현 완료.**
```

with:

```
**상태: Slice 4(extract + 변수 체이닝 + ${ENV} + ramp-up + abort) 구현 완료.**
```

Append a new paragraph after the "Slice 3 결과:" block:

```
Slice 4 결과: 엔진이 multi-step extract(JSONPath body / header / cookie / status)와 ${ENV:-default} 템플릿, 1초 단위 linear ramp-up, CancellationToken 기반 abort를 지원. 컨트롤러 `POST /api/runs/{id}/abort` → 워커가 in-flight run 취소. UI Inspector에 ExtractEditor, RunDetail에 Abort 버튼. 테스트: Rust unit + wiremock multi-step integration + proptest properties, UI RTL + fast-check round-trip. K8s 배포는 Slice 6, 차트·HTML 리포트는 Slice 5.
```

Add a new gotchas section after "Slice 3에서 배운 함정들":

```
## Slice 4에서 배운 함정들

- **serde_yaml 0.9 + internally-tagged enum w/ struct variants은 round-trip OK**: Slice 1에서 외부 태그(externally-tagged) map-shape enum이 깨지는 버그가 있었지만 (`Body`, `Assertion`), `#[serde(tag = "from")]` 형태의 internally-tagged + struct 변형은 정상 동작. `Extract`는 이 패턴으로 모델링.
- **`reqwest::Response::cookies()` vs Set-Cookie 헤더 직접 읽기**: 자동 쿠키 jar가 활성화돼도 응답의 raw Set-Cookie 헤더는 그대로 노출된다. 우리는 `from: cookie` extract에서 raw Set-Cookie 헤더를 파싱(첫 `key=value` 페어)한다 — jar에서 끄집어내려고 하면 reqwest 내부 jar 인터페이스가 stable하지 않음.
- **JSONPath 라이브러리 선택**: `serde_json_path` (RFC 9535 compliant). `jsonpath-rust`는 의존성이 더 무겁고 API가 변동적. `JsonPath::parse(path).query(json).first()` 패턴이면 충분.
- **`u32::div_ceil`은 Rust 1.79+**: workspace MSRV 1.85라 OK. `ceil_div(a, b)` 헬퍼를 손수 작성할 필요 없음.
- **CancellationToken은 `tokio_util::sync` 모듈에서**: tonic이 transitively 가져오긴 하지만 dev에 명시적으로 의존 추가하는 게 안전 (tonic minor 업데이트로 token 사라질 위험 회피).
- **Ramp-up 테스트의 flakiness 한계**: 1초 윈도우 단위에서 "first window count < later window count" 검증은 환경 부하에 민감. 매 초마다 정확히 `floor(target/ramp)` VU spawn을 검사하지 말고 monotonic non-decreasing trend만 검사.
- **`@testing-library/react` + Zustand의 store reset 패턴**: 각 `it` 전에 `useScenarioEditor.setState(useScenarioEditor.getInitialState())`로 초기화. RTL는 React 트리만 재마운트하므로 모듈 스코프 store는 직접 비워야 한다.
- **`fast-check` + Vitest의 default `numRuns`**: 100. CI 시간을 아끼려고 우리는 round-trip 프로퍼티에서 40으로 줄였다. 의도적 — 셔링크 발생 시 numRuns를 다시 올려 재현.
- **userEvent.setup()를 it마다 호출**: v14에서 글로벌 default user-event는 deprecated. 매 테스트에서 `const user = userEvent.setup()` 명시.
- **`@monaco-editor/react` & `vitest` 환경에서 `?worker` 임포트**: Slice 3 vitest.config.ts의 `workerQueryPlugin`이 Slice 4 RTL 테스트에서도 그대로 사용된다 — Inspector / RunDetail은 Monaco를 직접 마운트하지 않으므로 worker 모킹은 불필요.
- **`PATCH /scenarios/{id}` 의 optimistic lock과 Slice 4 extract 변경**: extract만 바뀌어도 yamlText가 달라지므로 dirty 플래그가 켜진다. EditorShell의 baselineSeededRef 패턴이 그대로 적용되어 추가 작업 없음 — 단 회귀 점검은 manual check §1에서 한 번 한다.
```

- [ ] **Step 3: Run all final tests**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && cargo fmt --check && cargo build --workspace && cargo test --workspace
```

Expected: green across the board.

- [ ] **Step 4: Run the manual check**

Follow `docs/dev/ui-slice-4-manual-check.md` end-to-end with a real wiremock instance. Annotate any failure inline under a `## Findings` heading and fix.

- [ ] **Step 5: Commit**

```bash
git add docs/dev/ui-slice-4-manual-check.md CLAUDE.md
git commit -m "docs(slice-4): manual check runbook + CLAUDE.md status & gotchas"
```

- [ ] **Step 6 (optional): Tag**

```bash
git tag slice-4
```

---

## Self-review against spec (writing-plans § Self-Review)

Cross-checked against `docs/superpowers/specs/2026-05-27-handicap-mvp1-design.md` and the in/out scope answer captured at planning start.

**Spec coverage:**

- §1.5 In: "변수: env vars + 한 응답에서 JSON path로 값 추출 → 다음 요청에서 사용" → Tasks 2 (env), 3–5 (extract types + evaluator + executor), 6 (flow vars in runner).
- §1.5 In: "토큰(JWT/Bearer) 기반과 세션(쿠키) 기반 둘 다 지원" → Task 6 (cookie jar wiring already in place from Slice 1; verified in Task 6's `cookie_jar_session_flow_works`), Tasks 7 + 14 (UI extract editor for token flow). Manual check §1 + §2.
- §2.3 schema includes `extract`, `assert`, `cookie_jar` — `extract` was the Slice 4 gap. All four `from` variants (`body`/`header`/`status`/`cookie`) are implemented (Task 4) and exposed in UI (Task 14).
- §2.5 variable notation: `{{var}}` (already in Slice 1) and `${ENV}` / `${ENV:-default}` (Task 2) and `${vu_id}`/`${iter_id}` (Slice 1).
- §3.1 ramp-up curve: "MVP는 linear. 매 초마다 `floor(target_vus / ramp_up_seconds)` 개의 task spawn." → Task 6, integration test in Task 7 (`ramp_up_increases_count_over_time`).
- §3.4 abort flow not explicitly in spec, but the proto already declared `AbortRun` and the spec's acceptance §4.2 mentions abort isn't required. We added abort because the user picked "Core + ramp-up + abort" during scope question. Counted as bonus coverage.
- §4.1 acceptance items 1–3: covered by Slice 3 already (canvas/YAML/sync); not in scope here.
- §4.1 acceptance item 4 (run dialog VUs/ramp-up/duration/env): Slice 2 dialog already collects these; Slice 4 wires env down and honors ramp-up.
- §4.1 acceptance item 5 (run progress polling): unchanged from Slice 2.
- §4.1 acceptance item 7 (re-run with different config): unchanged from Slice 2.
- §4.1 acceptance item 8 (token + session auth both work, VU isolation): Tasks 6, 7, 14 + manual check §1–2.
- §4.4 testing — "각 Rust 크레이트 라인 커버리지 ≥ 60%": this slice's adds boost coverage on engine; we don't run `cargo tarpaulin` in this plan but the added test count makes 60% reachable. (If a future task tightens this, instrument via separate task.)
- §4.4 UI bidirectional sync unit tests: Slice 3 already covered model, ULID, doc, store. Slice 4 adds Extract zod + extract round-trip + fast-check property + RTL Inspector and RunDetail tests.

**Placeholder scan:**

- No "TBD" / "TODO" / "implement later" in step bodies.
- Component code, store actions, edits, evaluator functions all spelled out.
- Test code is complete and runnable (no `...` ellipses or skipped assertions).
- Manual check is in concrete steps, not "verify it works".

**Type consistency:**

- `Edit` union members (`setStepExtract`) referenced by store (`setStepExtract` action) and tests, consistent names.
- `Extract` type in Rust (`scenario.rs`) and TS (`model.ts`) carry identical variant shapes (`body { var, path }`, `header { var, name }`, `cookie { var, name }`, `status { var }`).
- `RunPlan` extended with `ramp_up`, `env`; all integration tests and the worker plumbing updated together (Tasks 6, 9).
- `CancellationToken` import path `tokio_util::sync::CancellationToken` consistent across runner, worker, integration tests, and explicit dev-dep declaration in Task 1.
- `EngineError::Aborted` added in Task 4 and used in Tasks 6, 9.

**Test plan strength (vs Slice 3):**

| Layer | Slice 3 | Slice 4 |
|---|---|---|
| Rust unit | Strong | Strong + property tests (Task 7) |
| Rust integration | One (runner_e2e) | Three new (multi_step, ramp_up, plus extended controller e2e) |
| UI unit | Strong (model/ulid/store/yamlDoc) | Strong + new ExtractModel + new yamlDoc extract cases + fast-check round-trip |
| UI component | `.todo` stubs only | **Real RTL tests** for ExtractEditor and RunDetailPage Abort |
| UI e2e | Manual check | Manual check (Playwright deferred per user choice) |

No issues found.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-slice-4-extract-flowvars-rampup-abort.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. With 16 tasks of varied size (Tasks 6 and 10 are the largest), this keeps each session's context small.
2. **Inline Execution** — Execute in this session using `superpowers:executing-plans`, batched with checkpoints at Task boundaries 5/10/15.

Which approach?
