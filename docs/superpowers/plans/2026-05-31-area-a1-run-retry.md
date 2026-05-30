# Area A1 — Run Retry (prefill seam) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user re-run any past run with its exact settings — either by prefilling the RunDialog (editable) or by immediate one-click re-launch — reusing the existing `runs` history with **zero new storage** and **zero DB migration**.

**Architecture:** A past run already carries everything a re-run needs (`profile` + `env`), and `GET /api/runs/{id}` already returns both. This slice (a) exposes the run's snapshot `scenario_yaml` on the run response so the UI can warn when the live scenario drifted from what the run used, (b) constrains the create-run `env` to `map<string,string>` at the API boundary, and (c) builds the **prefill seam** in the UI: a new `RunDialog` `initial` prop (reseed-by-React-key) and a `DataBindingPanel` `initialBinding` re-hydration prop, then wires "다시 실행" / "동일 설정 즉시 재실행" entry points into the run list and run detail pages. This seam is the foundation A2 (named presets) builds on.

**Tech Stack:** Rust (axum 0.8, serde, sqlx, tokio), TypeScript/React, Zod, React Query v5, Vitest + React Testing Library, react-router-dom.

**Spec:** `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md` (§4 Retry, §5 UI prefill seam, §8 A1 split).

---

## Conflict avoidance with Slice 9b (read first)

A1 runs in parallel with **Slice 9b** (UI authoring for the `if` conditional node, plan `docs/superpowers/plans/2026-05-31-slice-9b-ui-conditional-node.md`). They are designed to be **non-overlapping**:

| | A1 (this plan) touches | 9b touches |
|---|---|---|
| Rust | `crates/controller/src/api/runs.rs` only | nothing (9a engine already merged) |
| UI scenario model/canvas | **none** | `ui/src/scenario/{model,yamlDoc,store}.ts`, `ui/src/components/scenario/*` |
| UI run flow | `ui/src/api/{schemas,hooks,client}.ts`, `ui/src/api/runPrefill.ts` (new), `ui/src/components/{RunDialog,DataBindingPanel}.tsx`, `ui/src/pages/{ScenarioRunsPage,RunDetailPage}.tsx` | **none** |

**No source file is edited by both plans.** The only shared *dependency* is `flattenHttpSteps`/`scanFlowVars` (in `scenario/model.ts` + `scanVars.ts`), which A1 only **consumes** (via `DataBindingPanel`) and 9b **modifies**. A1 never edits those files, so there is no merge conflict regardless of merge order; if 9b lands first, `DataBindingPanel` keeps working because flattening `if` branches is transparent to it.

**Rules to keep it clean:**
- **Do NOT edit `ui/src/scenario/*` or `ui/src/components/scenario/*`** in A1. Put the new env-decode helper in a **new** file `ui/src/api/runPrefill.ts`, not in `scenario/template.ts` or `model.ts`.
- **Do NOT touch the root `CLAUDE.md` slice-status line** (that line is 9b's to move). A1 docs go to its own spec status + a `ui/CLAUDE.md` gotcha + the area-A `MEMORY` entry (Task 7).
- A1 adds **no migration** — there is no `0005` contention with anything (A2 will own `0005` later).
- **`ui/CLAUDE.md` is the one file both plans append to.** A1 appends to the **"폼·입력 UX / 진단 표시 (RunDialog, RunDetail)"** subsection; 9b appends to its own (React Flow / Zod) subsections. If 9b merged first and git reports a `ui/CLAUDE.md` conflict, **both hunks are pure additions — accept both** (no semantic overlap). `MEMORY` files are out-of-repo and per-feature, so they never conflict.
- **Post-merge build gate (the real safety net):** the disjoint file sets mean no *textual* merge conflict in source, but A1 *consumes* `flattenHttpSteps`/`scanFlowVars`, whose **bodies** 9b rewrites (signature unchanged). So after integrating whichever branch lands second onto `master`, **re-run `cd ui && pnpm test && pnpm build` before the ff-merge** — the green build is the proof that 9b's flatten changes didn't break A1's `DataBindingPanel`/`RunDetailPage` consumers (and vice-versa). A1's own tests use loop/http scenarios only, so they are independent of 9b's `if` flattening; the build gate covers the type-level coupling.

---

## File Map

| File | Change |
|---|---|
| `crates/controller/src/api/runs.rs` | + `scenario_yaml` on `RunResponse` & `to_response`; `CreateRunRequest.env` → `HashMap<String,String>`; handler env simplification |
| `crates/controller/tests/api_test.rs` | + `get_run_includes_scenario_yaml`; + `create_run_rejects_non_string_env` |
| `ui/src/api/schemas.ts` | + `scenario_yaml: z.string()` on `RunSchema` |
| `ui/src/api/client.ts` | `createRun` env param `Record<string,unknown>` → `Record<string,string>` |
| `ui/src/api/hooks.ts` | `useCreateRun` mutation env type `Record<string,unknown>` → `Record<string,string>` |
| `ui/src/api/runPrefill.ts` | **new** — `envValueToRecord`, `RunPrefill` type |
| `ui/src/api/__tests__/runPrefill.test.ts` | **new** — env decode cases |
| `ui/src/components/DataBindingPanel.tsx` | + `initialBinding` prop + seed `selectedId`/`policy`/`rows` from it |
| `ui/src/components/__tests__/DataBindingPanel.test.tsx` | + re-hydration cases |
| `ui/src/components/RunDialog.tsx` | + `initial` & `scenarioChangedWarning` props; seed all form state from `initial`; warning badge; pass `initialBinding` to panel |
| `ui/src/components/__tests__/RunDialog.test.tsx` | + prefill seeding + warning cases |
| `ui/src/pages/ScenarioRunsPage.tsx` | per-row "다시 실행"/"즉시 재실행"; `?retry=` param prefill; pass `initial`/`scenarioChangedWarning`/`key` to RunDialog |
| `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` | **new** — retry entry points |
| `ui/src/pages/RunDetailPage.tsx` | + "동일 설정 즉시 재실행" + "다시 실행" (navigate `?retry=`) |
| `ui/src/pages/__tests__/RunDetailPage.test.tsx` | + retry buttons |
| docs (Task 7) | spec status, `ui/CLAUDE.md`, MEMORY area-A |

---

## Repo conventions the worker must honor

- **Pre-commit hook runs `cargo` only** (fmt + build + clippy `-D warnings` + test). It is skipped for docs-only (`.md`) commits. It does **not** run `pnpm`. So **every UI task must end with `cd ui && pnpm test && pnpm build`** by hand — `pnpm build` (`tsc -b`) is the real type gate; `pnpm test` (esbuild) misses TS-strict errors (Zod default-leak, union mismatch). (`ui/CLAUDE.md`.)
- **TDD-guard hook**: editing `ui/src/*.tsx` or `crates/*/src/*.rs` is blocked unless a pending test file is in the working tree. Each task **writes its test first**, which unblocks the production edit. Rust files with an inline `#[cfg(test)] mod tests` pass automatically.
- **`userEvent.setup()` per `it`** (v14). Reuse each test file's existing `fetchMock` + `jsonResponse` + render harness — do not invent new ones.
- **Local run footgun:** `cargo run -p handicap-controller --bin controller` (the package has two binaries). Not needed for this plan's tests, but relevant if you manually verify.
- Git topology: integration branch is `master`, **no remote**. This work happens in a worktree under `.claude/worktrees/`; finish with a local rebase-onto-`master` + `--ff-only` merge (root `CLAUDE.md`).

---

### Task 1: Controller — `scenario_yaml` on run response + `env` constrained to `map<string,string>`

**Files:**
- Modify: `crates/controller/src/api/runs.rs`
- Test: `crates/controller/tests/api_test.rs`

Both changes live in `runs.rs` and share the same test setup, so they land together. `RunResponse` already serializes `profile` + `env`; we add `scenario_yaml` (the run's immutable snapshot, already on `RunRow.scenario_yaml`) and tighten the create-time `env` contract.

- [ ] **Step 1: Write the failing integration tests.** Append to `crates/controller/tests/api_test.rs` (reuses the existing `make_app` / `create_scenario` / `create_run` helpers at the top of the file):

```rust
#[tokio::test]
async fn get_run_includes_scenario_yaml() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: snap-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

    let scenario_id = create_scenario(&app, yaml).await;
    let run_id = create_run(&app, &scenario_id).await;

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/runs/{run_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    // The run carries the exact scenario snapshot it ran against (retry warning source).
    assert_eq!(v["scenario_yaml"].as_str().unwrap(), yaml);
}

#[tokio::test]
async fn create_run_rejects_non_string_env() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: env-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;

    // env with a non-string value must be rejected at the API boundary
    // (env is map<string,string>; ADR-0014 — env vars are always strings).
    let body = json!({
        "scenario_id": scenario_id,
        "profile": { "vus": 1, "duration_seconds": 1 },
        "env": { "PORT": 8080 }
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    // axum's Json extractor returns a 4xx (422 for a type mismatch in valid JSON).
    assert!(
        resp.status().is_client_error(),
        "non-string env must be rejected, got {}",
        resp.status()
    );
}
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cargo test -p handicap-controller --test api_test get_run_includes_scenario_yaml create_run_rejects_non_string_env`
Expected: `get_run_includes_scenario_yaml` FAILS (`scenario_yaml` is `Null` — not in response). `create_run_rejects_non_string_env` FAILS (number is silently dropped today → run is created → 201, not a client error).

- [ ] **Step 3: Add `scenario_yaml` to `RunResponse`.** In `crates/controller/src/api/runs.rs`, add the field to the struct (after `scenario_id`):

```rust
#[derive(Debug, Serialize)]
pub struct RunResponse {
    pub id: String,
    pub scenario_id: String,
    /// Immutable snapshot of the scenario YAML this run executed against. The UI
    /// compares it to the live scenario to warn when a retry would use drifted
    /// settings (spec §4). Present on every run response, incl. the list.
    pub scenario_yaml: String,
    pub status: RunStatus,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
    pub message: Option<String>,
}
```

And populate it in `to_response` (the run row already has it):

```rust
fn to_response(r: runs::RunRow) -> RunResponse {
    RunResponse {
        id: r.id,
        scenario_id: r.scenario_id,
        scenario_yaml: r.scenario_yaml,
        status: r.status,
        profile: r.profile,
        env: r.env,
        started_at: r.started_at,
        ended_at: r.ended_at,
        created_at: r.created_at,
        message: r.message,
    }
}
```

- [ ] **Step 4: Constrain `CreateRunRequest.env`.** Change the field type (the response `env` stays `serde_json::Value` — it reflects whatever is stored):

```rust
#[derive(Debug, Deserialize)]
pub struct CreateRunRequest {
    pub scenario_id: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}
```

- [ ] **Step 5: Simplify the handler env path.** In `create`, the run insert currently passes `&body.env` (a `Value`) and a separate block re-parses env into a `HashMap`. Replace the insert call (currently `runs::insert(&state.db, &scenario.id, &scenario.yaml, &body.profile, &body.env)`) with a serialize-then-insert, and delete the re-parse block.

Replace this block:

```rust
    let row = runs::insert(
        &state.db,
        &scenario.id,
        &scenario.yaml,
        &body.profile,
        &body.env,
    )
    .await?;

    // Parse env_json to HashMap<String,String> for the proto assignment.
    // Non-string values are silently dropped (ADR-0014: env vars are always strings).
    let env: std::collections::HashMap<String, String> =
        serde_json::from_value::<serde_json::Map<String, serde_json::Value>>(body.env.clone())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
            .collect();
```

with:

```rust
    // env is already map<string,string> (rejected at the API boundary otherwise).
    // Serialize back to a JSON object for storage; clone the map for the proto.
    let env_value = serde_json::to_value(&body.env).expect("env map serializes to a JSON object");
    let row = runs::insert(
        &state.db,
        &scenario.id,
        &scenario.yaml,
        &body.profile,
        &env_value,
    )
    .await?;
```

Then fix the `PendingAssignment { ... }` literal. Deleting the filter_map block above removes the local `env` binding, so the `env,` field shorthand at the `PendingAssignment` literal (`runs.rs:156`) no longer resolves. Replace that one line:

```rust
        env: body.env.clone(),
```

**Pass `body.env.clone()` (the `HashMap<String,String>`), NOT `env_value` (the `serde_json::Value`).** `PendingAssignment.env` is typed `HashMap<String,String>` (`grpc/coordinator.rs`), and after Step 4 `body.env` is exactly that type — so this compiles and is the correct value. Using `env_value` would be a type error.

- [ ] **Step 6: Run the two new tests to verify they pass**

Run: `cargo test -p handicap-controller --test api_test get_run_includes_scenario_yaml create_run_rejects_non_string_env`
Expected: both PASS.

- [ ] **Step 7: Run the full controller suite to confirm no regression** (every existing test sends `{}` or string-valued env, so the tighter type is satisfied):

Run: `cargo test -p handicap-controller`
Expected: PASS (all). If `cargo fmt`/`clippy` complain, run `cargo fmt` and re-run.

- [ ] **Step 8: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/tests/api_test.rs
git commit -m "feat(controller): expose run scenario_yaml + constrain run env to map<string,string> (A1)"
```

---

### Task 2: UI api layer — `scenario_yaml` schema, string env types, `envValueToRecord`

**Files:**
- Modify: `ui/src/api/schemas.ts`, `ui/src/api/client.ts`, `ui/src/api/hooks.ts`
- Create: `ui/src/api/runPrefill.ts`
- Test: `ui/src/api/__tests__/runPrefill.test.ts` (new)

Pure data-layer task — no component touched, build stays green.

- [ ] **Step 1: Write the failing helper test.** Create `ui/src/api/__tests__/runPrefill.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { envValueToRecord, normalizeProfile } from "../runPrefill";

describe("envValueToRecord", () => {
  it("keeps string entries", () => {
    expect(envValueToRecord({ BASE_URL: "http://x", TOKEN: "abc" })).toEqual({
      BASE_URL: "http://x",
      TOKEN: "abc",
    });
  });

  it("drops non-string values (ADR-0014: env vars are strings)", () => {
    expect(envValueToRecord({ a: "1", b: 2, c: true, d: null })).toEqual({ a: "1" });
  });

  it("returns {} for null / arrays / primitives", () => {
    expect(envValueToRecord(null)).toEqual({});
    expect(envValueToRecord(["x"])).toEqual({});
    expect(envValueToRecord("nope")).toEqual({});
    expect(envValueToRecord(undefined)).toEqual({});
  });
});

describe("normalizeProfile", () => {
  it("fills defaults and returns a clean Profile (no leaked | undefined)", () => {
    // A run's profile, as stored — defaulted fields may be absent.
    const p = normalizeProfile({ vus: 4, duration_seconds: 8 });
    expect(p.ramp_up_seconds).toBe(0);
    expect(p.loop_breakdown_cap).toBe(256);
    expect(p.vus).toBe(4);
  });

  it("preserves an existing data_binding", () => {
    const p = normalizeProfile({
      vus: 1,
      duration_seconds: 1,
      data_binding: { dataset_id: "D1", policy: "per_vu", mappings: [] },
    });
    expect(p.data_binding?.dataset_id).toBe("D1");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd ui && pnpm test -- runPrefill`
Expected: FAIL — module `../runPrefill` not found.

- [ ] **Step 3: Create the helper.** Write `ui/src/api/runPrefill.ts`:

```ts
import { ProfileSchema, type Profile } from "./schemas";

/** Decode a stored run/preset env (arbitrary JSON value) into a string→string
 *  record, dropping non-string values. The backend now rejects non-string env at
 *  the boundary, but stored/legacy values may still be anything — be defensive.
 *  Used to prefill the run dialog from a past run (spec §5). */
export function envValueToRecord(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/** Re-parse a run's `profile` into a clean `Profile`.
 *
 *  WHY THIS EXISTS: `RunSchema.profile` nests `ProfileSchema`, and Zod's nested
 *  `.default()` leaks `number | undefined` into the parent infer (ui/CLAUDE.md
 *  "Zod 중첩 .default() input 타입 누출"). So `run.profile` is typed with
 *  `ramp_up_seconds`/`loop_breakdown_cap` as `number | undefined`, which is NOT
 *  assignable to the standalone `Profile` type that `RunPrefill`/`useCreateRun`
 *  expect — a hard `tsc -b` error. Re-parsing collapses the type to ProfileSchema's
 *  output (clean `number`). At runtime it's an idempotent re-validation (the value
 *  was already ProfileSchema-validated when RunSchema parsed it). */
export function normalizeProfile(profile: unknown): Profile {
  return ProfileSchema.parse(profile);
}

/** Shape of RunDialog's `initial` prop — a past run's profile + decoded env. */
export type RunPrefill = { profile: Profile; env: Record<string, string> };
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd ui && pnpm test -- runPrefill`
Expected: PASS.

- [ ] **Step 5: Add `scenario_yaml` to `RunSchema`.** In `ui/src/api/schemas.ts`, **edit the existing `RunSchema` (lines 46-61) in place** — add only the `scenario_yaml` line after `scenario_id`; keep every other field exactly as-is (the `env: z.unknown()` field, the `message: z.string().nullable().optional()` field, etc.). The full block for reference:

```ts
export const RunSchema = z.object({
  id: z.string(),
  scenario_id: z.string(),
  // Immutable scenario snapshot the run executed against (retry drift warning).
  scenario_yaml: z.string(),
  status: RunStatusEnum,
  profile: ProfileSchema,
  // Backend stores env as serde_json::Value (could be null, object, or anything).
  // Accept any JSON value here; decode with envValueToRecord for prefill.
  env: z.unknown(),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
  created_at: z.number().int(),
  message: z.string().nullable().optional(),
});
```

> `RunListSchema` reuses `RunSchema`, so the run **list** now also carries `scenario_yaml` — ScenarioRunsPage uses it directly (no extra fetch). `ReportRunSchema` is a separate `.strict()` schema and is intentionally **not** changed (report exposes `scenario_yaml` at its own top level).

- [ ] **Step 6: Narrow the create-run env type to `Record<string,string>`.** In `ui/src/api/client.ts`, change `createRun`:

```ts
  createRun: (scenario_id: string, profile: Profile, env: Record<string, string>) =>
    request(
      "/runs",
      { method: "POST", body: JSON.stringify({ scenario_id, profile, env }) },
      RunSchema,
    ),
```

In `ui/src/api/hooks.ts`, change the `useCreateRun` mutation variable type:

```ts
    mutationFn: ({
      scenarioId,
      profile,
      env,
    }: {
      scenarioId: string;
      profile: Profile;
      env: Record<string, string>;
    }) => api.createRun(scenarioId, profile, env),
```

(The existing `RunDialog` already builds `env` as `Record<string, string>`, so this narrowing requires no change there.)

- [ ] **Step 7: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: all tests PASS; `tsc -b && vite build` succeeds.

- [ ] **Step 8: Commit**

```bash
git add ui/src/api/schemas.ts ui/src/api/client.ts ui/src/api/hooks.ts \
  ui/src/api/runPrefill.ts ui/src/api/__tests__/runPrefill.test.ts
git commit -m "feat(ui): run schema scenario_yaml + string env types + envValueToRecord (A1)"
```

---

### Task 3: `DataBindingPanel` — `initialBinding` re-hydration

**Files:**
- Modify: `ui/src/components/DataBindingPanel.tsx`
- Test: `ui/src/components/__tests__/DataBindingPanel.test.tsx`

Adds an optional `initialBinding` prop that seeds the dataset, policy, and per-var mapping rows so a prefilled run shows its saved binding. When `initialBinding` is absent the behavior is byte-identical to today. The panel is remounted (via a React `key` from RunDialog) whenever the prefill source changes, so `initialBinding` is stable for a given mount — seeding can happen in the `useState` initializers without reseed-effect races.

- [ ] **Step 1: Write the failing re-hydration test.** Append to `ui/src/components/__tests__/DataBindingPanel.test.tsx`. It reuses the file's existing `fetchMock`, `jsonResponse`, and `makeScenario` (which references `{{username}}`). Add a fetch router that serves the dataset list + one dataset with a `user` column:

```ts
describe("DataBindingPanel — initialBinding re-hydration (A1)", () => {
  function mockDatasets() {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/datasets")) {
        return Promise.resolve(
          jsonResponse({
            datasets: [
              { id: "D1", name: "users", columns: ["user"], row_count: 3, byte_size: 10, created_at: 1 },
            ],
          }),
        );
      }
      if (url.endsWith("/api/datasets/D1")) {
        return Promise.resolve(
          jsonResponse({
            id: "D1",
            name: "users",
            columns: ["user"],
            row_count: 3,
            byte_size: 10,
            created_at: 1,
            sample: [{ user: "alice" }],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function renderPanel(initialBinding: DataBinding | null) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <DataBindingPanel
          scenario={makeScenario()}
          initialBinding={initialBinding}
          onChange={() => {}}
          onValidityChange={() => {}}
        />
      </QueryClientProvider>,
    );
  }

  it("preselects the dataset, policy, and column mapping from initialBinding", async () => {
    mockDatasets();
    renderPanel({
      dataset_id: "D1",
      policy: "iter_random",
      mappings: [{ kind: "column", var: "username", column: "user" }],
    });

    // dataset + policy selects reflect the saved binding
    expect((await screen.findByLabelText("dataset")) as HTMLSelectElement).toHaveValue("D1");
    await waitFor(() => expect(screen.getByLabelText("policy")).toHaveValue("iter_random"));

    // the {{username}} row's source select is set to the `user` column (loads after columns fetch)
    await waitFor(() =>
      expect(screen.getByLabelText("source for username")).toHaveValue("user"),
    );
  });

  it("seeds a literal mapping for a var that is not a scanned column", async () => {
    mockDatasets();
    renderPanel({
      dataset_id: "D1",
      policy: "per_vu",
      mappings: [{ kind: "literal", var: "username", value: "fixed" }],
    });
    await waitFor(() =>
      expect(screen.getByLabelText("literal value for username")).toHaveValue("fixed"),
    );
  });

  it("does not duplicate a manual row seeded for an unscanned mapping var", async () => {
    mockDatasets();
    // `extra` is NOT referenced by makeScenario()'s {{username}} — it becomes a
    // manual row. The existing merge effect must not re-append it on mount.
    renderPanel({
      dataset_id: "D1",
      policy: "per_vu",
      mappings: [{ kind: "literal", var: "extra", value: "v" }],
    });
    await waitFor(() => expect(screen.getAllByLabelText("mapping var name")).toHaveLength(1));
    expect(screen.getByLabelText("mapping var name")).toHaveValue("extra");
  });

  it("highlights a stale column mapping whose column is gone from the dataset (spec §6)", async () => {
    mockDatasets();
    renderPanel({
      dataset_id: "D1",
      policy: "per_vu",
      mappings: [{ kind: "column", var: "username", column: "gone" }],
    });
    expect(await screen.findByText(/선택한 컬럼이 현재 데이터셋에 없음/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd ui && pnpm test -- DataBindingPanel`
Expected: FAIL — `initialBinding` is not a prop; dataset select defaults to `""`, policy to `per_vu`, mapping unset.

- [ ] **Step 3: Add the prop and seed state from it.** In `ui/src/components/DataBindingPanel.tsx`:

Extend the import to include `Mapping`:

```ts
import type { BindingPolicy, DataBinding, Mapping } from "../api/schemas";
```

Extend `Props`:

```ts
type Props = {
  scenario: Scenario;
  /** Optional saved binding to re-hydrate the panel from (run/preset prefill).
   *  The parent remounts this panel (via React key) when the prefill source
   *  changes, so this is read once per mount. */
  initialBinding?: DataBinding | null;
  onChange: (b: DataBinding | null) => void;
  onValidityChange: (ok: boolean) => void;
};
```

Add two seeding helpers above the component (module scope, near `makeRow`):

```ts
function applyMapping(row: MappingRow, m: Mapping | undefined): MappingRow {
  if (!m) return row;
  if (m.kind === "column") return { ...row, sourceKind: "column", column: m.column };
  return { ...row, sourceKind: "literal", literalValue: m.value };
}

/** Build the initial mapping rows: one per scanned var (seeded from initialBinding
 *  if present), plus manual rows for any mapped var the scan didn't surface. */
function seedRows(vars: Iterable<string>, initial: DataBinding | null | undefined): MappingRow[] {
  const byVar = new Map((initial?.mappings ?? []).map((m) => [m.var, m]));
  const scanned = new Set(vars);
  const out: MappingRow[] = [];
  for (const v of scanned) out.push(applyMapping(makeRow(v), byVar.get(v)));
  for (const m of initial?.mappings ?? []) {
    if (!scanned.has(m.var)) out.push(applyMapping(makeRow(m.var, true), m));
  }
  return out;
}
```

Change the three `useState` initializers (currently `selectedId=""`, `policy="per_vu"`, `rows=[]`) to seed from `initialBinding`:

```ts
  const [selectedId, setSelectedId] = useState<string>(initialBinding?.dataset_id ?? "");
  const dataset = useDataset(selectedId || undefined);
  const [policy, setPolicy] = useState<BindingPolicy>(initialBinding?.policy ?? "per_vu");
  const [rows, setRows] = useState<MappingRow[]>(() => seedRows(scanFlowVars(scenario), initialBinding));
```

> The existing `useEffect([scannedVars])` that "merges: keep existing row state, add new ones" now runs on mount finding the already-seeded rows in `prev`. It **rebuilds `next` from scratch** (one push per scanned var via `prevByVar.get(v) ?? makeRow(v)`, then one push per `prev` manual row) — so each seeded row appears exactly once; seeded scanned rows are preserved and seeded manual (unscanned-mapping) rows are kept without duplication. No change to that effect is needed. The auto-match effect only touches `sourceKind === "none"` rows, so seeded column/literal rows are left intact.
>
> **Fallback (if the no-duplicate test fails):** should the merge effect ever double-append, gate its first run — `const seededRef = useRef(false);` and at the top of the effect `if (!seededRef.current) { seededRef.current = true; return; }` (the `useState` initializer already seeded `rows`; the effect only needs to react to *later* `scannedVars` changes). Add `import { useRef } from "react"`. Re-run the Task-3 tests.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && pnpm test -- DataBindingPanel`
Expected: PASS (both new cases + all existing cases — when `initialBinding` is undefined, `seedRows` returns the same rows the old effect produced).

- [ ] **Step 5: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/DataBindingPanel.tsx ui/src/components/__tests__/DataBindingPanel.test.tsx
git commit -m "feat(ui): DataBindingPanel initialBinding re-hydration (A1)"
```

---

### Task 4: `RunDialog` — `initial` prefill + scenario-changed warning

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

Adds an optional `initial` prop that seeds every form field, a `scenarioChangedWarning` flag that renders a drift badge, and passes the binding through to `DataBindingPanel`. The parent reseeds by remounting the dialog with a React `key` (no reseed effect → no stale-state bug). Seeding each field with `?? <default>` also sidesteps the Zod nested-`.default()` input-leak (`initial.profile.loop_breakdown_cap` is typed `number | undefined`; `?? 256` collapses it).

- [ ] **Step 1: Write failing tests.** Append to `ui/src/components/__tests__/RunDialog.test.tsx` (reuses the file's `QueryClient`/render imports at the top):

```ts
import type { RunPrefill } from "../../api/runPrefill";

function renderWithInitial(initial: RunPrefill, opts?: { scenarioChangedWarning?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunDialog
        scenarioId="S1"
        hasLoop={true}
        scenario={null}
        initial={initial}
        scenarioChangedWarning={opts?.scenarioChangedWarning ?? false}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("RunDialog — initial prefill (A1)", () => {
  const initial: RunPrefill = {
    profile: {
      vus: 7,
      duration_seconds: 9,
      ramp_up_seconds: 3,
      loop_breakdown_cap: 128,
      data_binding: null,
    },
    env: { BASE_URL: "http://x", TOKEN: "abc" },
  };

  it("seeds vus / duration / ramp-up / loop cap from initial.profile", () => {
    renderWithInitial(initial);
    expect(screen.getByLabelText("VUs")).toHaveValue(7);
    expect(screen.getByLabelText("Duration (s)")).toHaveValue(9);
    expect(screen.getByLabelText("Ramp-up (s)")).toHaveValue(3);
    expect(screen.getByLabelText("loop breakdown cap")).toHaveValue(128);
  });

  it("seeds env entries from initial.env", () => {
    renderWithInitial(initial);
    expect(screen.getByLabelText("env key 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("env value 0")).toHaveValue("http://x");
    expect(screen.getByLabelText("env key 1")).toHaveValue("TOKEN");
    expect(screen.getByLabelText("env value 1")).toHaveValue("abc");
  });

  it("shows a drift warning when scenarioChangedWarning is set", () => {
    renderWithInitial(initial, { scenarioChangedWarning: true });
    expect(screen.getByRole("alert")).toHaveTextContent(/이 run 이후 수정됨/);
  });

  it("does not show the drift warning by default", () => {
    renderWithInitial(initial);
    expect(screen.queryByText(/이 run 이후 수정됨/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd ui && pnpm test -- RunDialog`
Expected: FAIL — `initial`/`scenarioChangedWarning` are not props; fields show hardcoded defaults (2/5/0/256), no env rows, no warning.

- [ ] **Step 3: Add the props and seed state.** In `ui/src/components/RunDialog.tsx`:

Add the import:

```ts
import type { RunPrefill } from "../api/runPrefill";
```

Extend `Props` (after `scenario`):

```ts
  /** When set, seed every form field from this past run's profile + env (retry
   *  prefill). The parent remounts the dialog (React key) to reseed; there is no
   *  reseed effect. */
  initial?: RunPrefill;
  /** True when `initial` came from a run whose scenario snapshot differs from the
   *  current live scenario — renders a drift warning. */
  scenarioChangedWarning?: boolean;
```

Update the signature destructuring:

```ts
export function RunDialog({
  scenarioId,
  hasLoop,
  scenario,
  initial,
  scenarioChangedWarning = false,
  onCreated,
  onCancel,
}: Props) {
```

Seed the `useState` initializers from `initial` (replace the six hardcoded ones):

```ts
  const [vus, setVus] = useState(initial?.profile.vus ?? 2);
  const [duration, setDuration] = useState(initial?.profile.duration_seconds ?? 5);
  const [rampUp, setRampUp] = useState(initial?.profile.ramp_up_seconds ?? 0);
  const [loopCap, setLoopCap] = useState(initial?.profile.loop_breakdown_cap ?? 256);
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>(() =>
    initial ? Object.entries(initial.env).map(([key, value]) => ({ key, value })) : [],
  );
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
  const [binding, setBinding] = useState<DataBinding | null>(initial?.profile.data_binding ?? null);
  const [bindingValid, setBindingValid] = useState(true);
```

- [ ] **Step 4: Render the drift warning + pass `initialBinding` to the panel.**

Add the warning badge just under the `<h3>New run</h3>` heading (inside the outer `<div>`):

```tsx
      <h3 className="text-lg font-semibold mb-3">New run</h3>
      {scenarioChangedWarning && (
        <p
          role="alert"
          className="mb-3 p-2 rounded border border-amber-300 bg-amber-50 text-sm text-amber-800"
        >
          이 시나리오는 이 run 이후 수정됨 — 설정이 안 맞을 수 있습니다.
        </p>
      )}
```

Pass the saved binding into `DataBindingPanel` (the panel is inside `{scenario && (...)}`):

```tsx
      {scenario && (
        <DataBindingPanel
          scenario={scenario}
          initialBinding={initial?.profile.data_binding ?? null}
          onChange={setBinding}
          onValidityChange={setBindingValid}
        />
      )}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ui && pnpm test -- RunDialog`
Expected: PASS (new cases + all existing — with no `initial`, every field falls back to its prior default and `envEntries` starts empty, so existing tests are unaffected).

- [ ] **Step 6: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds. (If `tsc` flags `initial.profile.loop_breakdown_cap` as `number | undefined`, the `?? 256` already collapses it — see `ui/CLAUDE.md` "Zod 중첩 .default() input 타입 누출".)

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog initial prefill + scenario-drift warning (A1)"
```

---

### Task 5: `ScenarioRunsPage` — run-list retry entry points + `?retry=` prefill

**Files:**
- Modify: `ui/src/pages/ScenarioRunsPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` (new)

The run list now owns the prefill seam (RunDialog already lives here). Each row gets:
- **다시 실행** → set this row as the dialog's prefill (`initial`) and open it.
- **즉시 재실행** → fire `createRun` immediately with the row's `profile` + decoded `env`, navigate to the new run.

A `?retry=<runId>` query param (used by RunDetailPage in Task 6) opens the dialog prefilled from that run. The drift warning is computed by comparing the prefilled run's `scenario_yaml` to the live scenario YAML.

- [ ] **Step 1: Write the failing test.** Create `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`:

```ts
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioRunsPage } from "../ScenarioRunsPage";

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

const SCENARIO_YAML =
  "version: 1\nname: demo\ncookie_jar: auto\nvariables: {}\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: "R1",
    scenario_id: "S1",
    scenario_yaml: SCENARIO_YAML,
    status: "completed",
    profile: { vus: 4, ramp_up_seconds: 1, duration_seconds: 8, loop_breakdown_cap: 256 },
    env: { BASE_URL: "http://x" },
    started_at: 1,
    ended_at: 2,
    created_at: 1,
    ...over,
  };
}

function mockApi(runOver: Record<string, unknown> = {}, postStatus = 201) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/api/scenarios/S1") && (!init || init.method === "GET")) {
      return Promise.resolve(
        jsonResponse({ id: "S1", name: "demo", yaml: SCENARIO_YAML, version: 1, created_at: 1, updated_at: 1 }),
      );
    }
    if (url.endsWith("/api/scenarios/S1/runs")) {
      return Promise.resolve(jsonResponse({ runs: [runRow(runOver)] }));
    }
    if (url.endsWith("/api/datasets")) {
      return Promise.resolve(jsonResponse({ datasets: [] }));
    }
    if (url.endsWith("/api/runs") && init?.method === "POST") {
      return Promise.resolve(
        postStatus >= 400
          ? jsonResponse({ error: "scenario drifted" }, postStatus)
          : jsonResponse(runRow({ id: "R2", status: "pending" }), postStatus),
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

function renderPage(initialPath = "/scenarios/S1/runs") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/scenarios/:id/runs" element={<ScenarioRunsPage />} />
          <Route path="/runs/:id" element={<div>run page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

describe("ScenarioRunsPage — retry (A1)", () => {
  it("'다시 실행' prefills the dialog from the run row", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "다시 실행" }));
    // dialog opens with vus seeded from the run (4)
    expect(await screen.findByLabelText("VUs")).toHaveValue(4);
    expect(screen.getByLabelText("env key 0")).toHaveValue("BASE_URL");
  });

  it("'즉시 재실행' POSTs createRun and navigates to the new run", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "즉시 재실행" }));
    await waitFor(() => expect(screen.getByText("run page")).toBeInTheDocument());
    const posted = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/runs") && (i as RequestInit)?.method === "POST",
    );
    expect(posted).toBeTruthy();
    const body = JSON.parse((posted![1] as RequestInit).body as string);
    expect(body.profile.vus).toBe(4);
    expect(body.env).toEqual({ BASE_URL: "http://x" });
  });

  it("shows the drift warning when the run snapshot differs from the live scenario", async () => {
    const user = userEvent.setup();
    mockApi({ scenario_yaml: SCENARIO_YAML.replace("http://x", "http://OLD") });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "다시 실행" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/이 run 이후 수정됨/);
  });

  it("auto-opens prefilled when ?retry=<runId> is present", async () => {
    mockApi();
    renderPage("/scenarios/S1/runs?retry=R1");
    expect(await screen.findByLabelText("VUs")).toHaveValue(4);
  });

  it("does not re-open the dialog after Cancel when the runs list refetches", async () => {
    const user = userEvent.setup();
    mockApi();
    const { qc } = renderPage("/scenarios/S1/runs?retry=R1");
    expect(await screen.findByLabelText("VUs")).toHaveValue(4); // opened via deep-link
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("VUs")).toBeNull()); // closed
    // A refetch hands the effect a fresh runs.data reference; the consumed-ref
    // guard must keep the dialog closed (no re-open-after-cancel).
    await qc.refetchQueries({ queryKey: ["scenarios", "S1", "runs"] });
    expect(screen.queryByLabelText("VUs")).toBeNull();
  });

  it("surfaces a createRun error from '즉시 재실행'", async () => {
    const user = userEvent.setup();
    mockApi({}, 400);
    renderPage();
    await user.click(await screen.findByRole("button", { name: "즉시 재실행" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/scenario drifted/);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd ui && pnpm test -- ScenarioRunsPage`
Expected: FAIL — no "다시 실행"/"즉시 재실행" buttons, no `?retry=` handling.

- [ ] **Step 3: Implement the retry wiring.** Rewrite `ui/src/pages/ScenarioRunsPage.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCreateRun, useScenario, useScenarioRuns } from "../api/hooks";
import { envValueToRecord, normalizeProfile, type RunPrefill } from "../api/runPrefill";
import type { Run } from "../api/schemas";
import { Button } from "../components/Button";
import { RunDialog } from "../components/RunDialog";
import { StatusBadge } from "../components/StatusBadge";
import { parseScenarioDoc } from "../scenario/yamlDoc";
import { isLoopStep } from "../scenario/model";

export function ScenarioRunsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const scenario = useScenario(id);
  const runs = useScenarioRuns(id);
  const createRun = useCreateRun();
  const [showDialog, setShowDialog] = useState(false);
  // The run we're prefilling from (null = a blank new run).
  const [prefillRun, setPrefillRun] = useState<Run | null>(null);

  // Parse the scenario YAML once for both hasLoop + DataBindingPanel.
  const parsedScenario = useMemo(() => {
    const yaml = scenario.data?.yaml;
    if (!yaml) return null;
    const parsed = parseScenarioDoc(yaml);
    return "model" in parsed ? parsed.model : null;
  }, [scenario.data?.yaml]);

  const hasLoop = parsedScenario?.steps.some(isLoopStep) ?? false;

  // Deep-link: ?retry=<runId> opens the dialog prefilled from that run — at most
  // once per id. The consumed-ref guard stops a runs refetch (createRun
  // invalidates the list; refetchOnWindowFocus) — which hands the effect a fresh
  // runs.data reference — from re-opening the dialog the user just cancelled.
  const retryId = searchParams.get("retry");
  const consumedRetry = useRef<string | null>(null);
  useEffect(() => {
    if (!retryId || !runs.data) return;
    if (consumedRetry.current === retryId) return;
    const target = runs.data.runs.find((r) => r.id === retryId);
    if (target) {
      consumedRetry.current = retryId;
      setPrefillRun(target);
      setShowDialog(true);
    }
  }, [retryId, runs.data]);

  function openPrefilled(run: Run) {
    setPrefillRun(run);
    setShowDialog(true);
  }

  function openBlank() {
    setPrefillRun(null);
    setShowDialog(true);
  }

  function rerunNow(run: Run) {
    // normalizeProfile re-parses to collapse the RunSchema nested-default type leak
    // (number | undefined) so the value is assignable to useCreateRun's `Profile`.
    // On failure (e.g. scenario drifted so a {{var}} is now unmapped) the run-create
    // gate returns 400 → surfaced by the createRun.error banner below.
    createRun.mutate(
      {
        scenarioId: run.scenario_id,
        profile: normalizeProfile(run.profile),
        env: envValueToRecord(run.env),
      },
      { onSuccess: (created) => navigate(`/runs/${created.id}`) },
    );
  }

  if (scenario.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (scenario.error) return <p className="text-red-600">{(scenario.error as Error).message}</p>;
  if (!scenario.data) return <p className="text-slate-500">Not found.</p>;

  const prefill: RunPrefill | undefined = prefillRun
    ? { profile: normalizeProfile(prefillRun.profile), env: envValueToRecord(prefillRun.env) }
    : undefined;
  // Drift warning: the run's scenario snapshot differs from the live scenario YAML.
  const scenarioChanged =
    !!prefillRun && prefillRun.scenario_yaml !== scenario.data.yaml;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Runs · {scenario.data.name}</h2>
          <Link
            to={`/scenarios/${scenario.data.id}`}
            className="text-sm text-slate-600 hover:underline"
          >
            ← Edit scenario
          </Link>
        </div>
        {!showDialog && <Button onClick={openBlank}>Run scenario</Button>}
      </div>

      {showDialog && (
        <div className="mb-6">
          <RunDialog
            key={prefillRun ? prefillRun.id : "new"}
            scenarioId={scenario.data.id}
            hasLoop={hasLoop}
            scenario={parsedScenario}
            initial={prefill}
            scenarioChangedWarning={scenarioChanged}
            onCreated={(runId) => {
              setShowDialog(false);
              setPrefillRun(null);
              navigate(`/runs/${runId}`);
            }}
            onCancel={() => {
              setShowDialog(false);
              setPrefillRun(null);
            }}
          />
        </div>
      )}

      {createRun.error && (
        <p
          role="alert"
          className="mb-4 p-2 rounded border border-red-200 bg-red-50 text-sm text-red-700"
        >
          재실행 실패: {(createRun.error as Error).message}
        </p>
      )}

      {runs.isLoading && <p className="text-slate-500">Loading runs…</p>}
      {runs.data && runs.data.runs.length === 0 && <p className="text-slate-500">No runs yet.</p>}
      {runs.data && runs.data.runs.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">VUs</th>
              <th className="py-2 pr-4 font-medium">Duration</th>
              <th className="py-2 pr-4 font-medium">Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.data.runs.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="py-3 pr-4">
                  <StatusBadge status={r.status} />
                </td>
                <td className="py-3 pr-4">{r.profile.vus}</td>
                <td className="py-3 pr-4">{r.profile.duration_seconds}s</td>
                <td className="py-3 pr-4 text-slate-600">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="py-3 pr-4 text-right">
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => openPrefilled(r)}
                      className="text-slate-700 hover:underline"
                    >
                      다시 실행
                    </button>
                    <button
                      type="button"
                      onClick={() => rerunNow(r)}
                      disabled={createRun.isPending}
                      className="text-slate-700 hover:underline disabled:opacity-50"
                    >
                      즉시 재실행
                    </button>
                    <Link to={`/runs/${r.id}`} className="text-slate-700 hover:underline">
                      view →
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && pnpm test -- ScenarioRunsPage`
Expected: PASS (all four cases).

- [ ] **Step 5: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/ScenarioRunsPage.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx
git commit -m "feat(ui): run-list retry (prefill + immediate) + ?retry deep-link (A1)"
```

---

### Task 6: `RunDetailPage` — retry buttons

**Files:**
- Modify: `ui/src/pages/RunDetailPage.tsx`
- Test: `ui/src/pages/__tests__/RunDetailPage.test.tsx`

The run detail header gets two actions next to Abort:
- **동일 설정 즉시 재실행** → immediate `createRun` from this run's `profile` + decoded `env`, navigate to the new run.
- **다시 실행** → navigate to the scenario's run list with `?retry=<runId>` so the prefilled dialog opens there (Task 5 handles it).

Both are shown only for terminal runs (re-running a still-running run is meaningless).

- [ ] **Step 1: Write the failing test.** Append to `ui/src/pages/__tests__/RunDetailPage.test.tsx` (reuses the file's `renderWithRouter`, `fetchMock`, `jsonResponse`). Note `renderWithRouter` only mounts `/runs/:id`; for the immediate-rerun assertion we check the POST body rather than navigation:

```ts
describe("RunDetailPage — retry (A1)", () => {
  function mockTerminalRun() {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/runs/R1") && (!init || init.method !== "POST")) {
        return Promise.resolve(
          jsonResponse({
            id: "R1",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: x\nsteps: []\n",
            status: "completed",
            profile: { vus: 6, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 256 },
            env: { TOKEN: "abc" },
            started_at: 1,
            ended_at: 2,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs/R1/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R1", windows: [] }));
      }
      if (url.endsWith("/api/runs/R1/report")) {
        return Promise.resolve(jsonResponse({}, 404));
      }
      if (url.endsWith("/api/scenarios/S1")) {
        return Promise.resolve(
          jsonResponse({ id: "S1", name: "x", yaml: "version: 1\nname: x\nsteps: []\n", version: 1, created_at: 1, updated_at: 1 }),
        );
      }
      if (url.endsWith("/api/runs") && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            id: "R2",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: x\nsteps: []\n",
            status: "pending",
            profile: { vus: 6, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 256 },
            env: { TOKEN: "abc" },
            started_at: null,
            ended_at: null,
            created_at: 3,
          }, 201),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  it("'동일 설정 즉시 재실행' POSTs createRun with this run's profile + env", async () => {
    const user = userEvent.setup();
    mockTerminalRun();
    renderWithRouter("R1");
    await user.click(await screen.findByRole("button", { name: "동일 설정 즉시 재실행" }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/runs") && (i as RequestInit)?.method === "POST",
      );
      expect(posted).toBeTruthy();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body.profile.vus).toBe(6);
      expect(body.env).toEqual({ TOKEN: "abc" });
    });
  });

  it("shows a '다시 실행' link to the run list with ?retry", async () => {
    mockTerminalRun();
    renderWithRouter("R1");
    const link = await screen.findByRole("link", { name: "다시 실행" });
    expect(link).toHaveAttribute("href", "/scenarios/S1/runs?retry=R1");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd ui && pnpm test -- RunDetailPage`
Expected: FAIL — no retry button/link.

- [ ] **Step 3: Add the buttons.** In `ui/src/pages/RunDetailPage.tsx`:

Extend the hooks import and add `useCreateRun` + `useNavigate` + the env decoder:

```ts
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useAbortRun,
  useCreateRun,
  useRun,
  useRunMetrics,
  useRunReport,
  useScenario,
} from "../api/hooks";
import { envValueToRecord, normalizeProfile } from "../api/runPrefill";
```

Inside the component, after `const abort = useAbortRun(...)`, add:

```ts
  const navigate = useNavigate();
  const createRun = useCreateRun();
```

In the header's action area, replace the lone Abort block (`{r.status === "running" && (...)}`) with a flex group that also holds the retry actions for terminal runs:

```tsx
        <div className="flex items-center gap-2">
          {r.status === "running" && (
            <button
              type="button"
              onClick={() => abort.mutate()}
              disabled={abort.isPending}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {abort.isPending ? "Aborting…" : "Abort"}
            </button>
          )}
          {terminal && (
            <>
              <button
                type="button"
                onClick={() =>
                  createRun.mutate(
                    {
                      scenarioId: r.scenario_id,
                      profile: normalizeProfile(r.profile),
                      env: envValueToRecord(r.env),
                    },
                    { onSuccess: (created) => navigate(`/runs/${created.id}`) },
                  )
                }
                disabled={createRun.isPending}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-50"
              >
                {createRun.isPending ? "Starting…" : "동일 설정 즉시 재실행"}
              </button>
              <Link
                to={`/scenarios/${r.scenario_id}/runs?retry=${r.id}`}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
              >
                다시 실행
              </Link>
            </>
          )}
        </div>
```

> `terminal` is already computed near the top of the component (`run.data ? TERMINAL.includes(...) : false`). `r.profile` leaks `| undefined` on its defaulted fields (the Zod nested-default quirk), so it is **not** directly assignable to `useCreateRun`'s `Profile` — that is exactly why the call wraps it in `normalizeProfile(r.profile)` (do NOT pass `r.profile` raw; `pnpm build`/`tsc -b` will reject it).

Then add the error surface. Insert a banner immediately **after** the header `</div>` (the `flex items-center justify-between mb-6` block) and before the `<div className="grid grid-cols-4 ...">` cards:

```tsx
      {createRun.error && (
        <div
          role="alert"
          className="mb-4 p-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded"
        >
          재실행 실패: {(createRun.error as Error).message}
        </div>
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && pnpm test -- RunDetailPage`
Expected: PASS (new cases + existing abort cases — the Abort button still renders for `running`).

- [ ] **Step 5: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx
git commit -m "feat(ui): run-detail immediate re-run + retry deep-link (A1)"
```

---

### Task 7: Docs — spec status, gotchas, memory

**Files:**
- Modify: `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md`
- Modify: `ui/CLAUDE.md`
- Modify: `/Users/sgj/.claude/projects/-Users-sgj-develop-handicap/memory/run-presets-area-a.md` and `MEMORY.md`

Docs-only commit (pre-commit hook skips cargo for `.md`-only staged sets). **Do not touch the root `CLAUDE.md` slice-status line** (9b owns it — avoids a merge conflict).

- [ ] **Step 1: Bump the spec status.** In `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md`, change the `* Status:` line (line 3) to note A1 is implemented:

```markdown
* Status: A1 (Retry) 구현 완료 (2026-05-31). A2 (프리셋 CRUD) 미착수. (brainstorming + spec-plan-review 반영)
```

And add a one-line pointer to the plan at the end of §8 A1's bullet list:

```markdown
- **구현 계획**: `docs/superpowers/plans/2026-05-31-area-a1-run-retry.md` (7 tasks, DB 무변경).
```

- [ ] **Step 2: Add the new UI gotchas to `ui/CLAUDE.md`.** Append to the "폼·입력 UX / 진단 표시 (RunDialog, RunDetail)" section:

```markdown
- **RunDialog/DataBindingPanel prefill 은 reseed-by-key** (Area A1): `initial`(RunDialog)·`initialBinding`(DataBindingPanel)은 `useState` 초기화에서만 읽는다 — reseed effect 없음. 프리필 소스가 바뀌면 부모(`ScenarioRunsPage`)가 `key={prefillRun?.id ?? "new"}`로 **컴포넌트를 remount** 해 새 초기값으로 다시 시드한다. effect로 reseed하면 사용자 편집을 덮어쓰는 race가 난다. 각 필드를 `initial?.… ?? <default>`로 시드하면 Zod 중첩 `.default()` input 누출(`number | undefined`)도 자연히 collapse된다.
- **run env 는 API 경계에서 map<string,string>** (Area A1): controller `CreateRunRequest.env`가 `HashMap<String,String>`이라 비문자열 env 값은 422로 거부된다. 저장/읽기(`RunSchema.env`)는 여전히 관대한 `z.unknown()` — 과거 행 호환. prefill 디코드는 `ui/src/api/runPrefill.ts::envValueToRecord`(비문자열 drop). 새 env 입력 경로는 항상 문자열만 보낼 것.
```

- [ ] **Step 3: Update the area-A memory.** Overwrite `/Users/sgj/.claude/projects/-Users-sgj-develop-handicap/memory/run-presets-area-a.md` body to reflect A1 done:

```markdown
---
name: run-presets-area-a
description: Run 프리셋+Retry QoL 기능 (영역 A) 진행 상태 — A1 Retry 구현됨, A2 프리셋 CRUD 다음
metadata:
  type: project
---

Run 프리셋 + Retry (영역 A) — RunDialog 설정 재사용 QoL 기능. spec = `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md` (작성+리뷰 완료 6685aef). 슬라이스-9(Conditional 노드)와 독립이며 파일 무충돌.

**A1 (Retry) — 구현 완료 2026-05-31.** plan = `docs/superpowers/plans/2026-05-31-area-a1-run-retry.md`. DB 무변경. controller가 run 응답에 `scenario_yaml` 노출 + create env를 map<string,string>로 제약. UI에 RunDialog `initial` prefill 시seam(reseed-by-key) + DataBindingPanel `initialBinding` 재수화 + ScenarioRunsPage/RunDetailPage "다시 실행"/"즉시 재실행" 진입점 + `?retry=` deep-link.

**다음 = A2 (프리셋 CRUD)**: migration 0005 `run_presets` + `validate_run_config` 추출 + `api/presets.rs` + 데이터셋 DELETE soft 가드 + RunDialog 프리셋 드롭다운/저장/rename. plan 미작성. (영역 B 글로벌 변수는 연기.)
```

Update the matching line in `MEMORY.md`:

```markdown
- [Run 프리셋+Retry (영역 A)](run-presets-area-a.md) — A1 Retry 구현 완료(2026-05-31, plan 2026-05-31-area-a1-run-retry.md). 다음 = A2 프리셋 CRUD(plan 미작성). 영역 B 연기
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-30-run-presets-retry-design.md ui/CLAUDE.md
git commit -m "docs: A1 retry status + prefill/env gotchas (A1)"
```

(The two memory files live outside the repo — `Write` them but they are not part of the git commit.)

---

## Self-Review

**1. Spec coverage (§4 Retry, §5 UI, §7 tests, §8 A1):**
- §4 "GET /api/runs/{id} 에 scenario_yaml 추가" → Task 1. ✅
- §4 "다시 실행"(prefill) + "동일 설정 즉시 재실행"(immediate), run 목록 + run 상세 두 진입점 → Tasks 5 (list) + 6 (detail). ✅
- §4 시나리오 변경 경고 (snapshot ≠ live) → Task 4 badge + Task 5 compute. ✅
- §5 RunDialog `initial` prop, 각 useState 시드, initial 변경 시 재시드 → Task 4 (reseed via key, Task 5 supplies key). ✅
- §5 env Value→entries 디코드, 비문자열 drop → Task 2 `envValueToRecord`. ✅
- §5 env API 경계 map<string,string> 제약 + UI 타입 좁힘 → Task 1 (Rust) + Task 2 (client/hooks). ✅
- §5 DataBindingPanel 재수화 (`initialBinding`) + stale 매핑 재검증 → Task 3 (existing stale-column logic re-runs against the live dataset on mount). ✅
- §5 `data_binding` null/undefined/missing 삼분기 → seeded via `initial?.profile.data_binding ?? null`; `ProfileSchema.data_binding` stays `.nullish()`. ✅
- §7 A1 Rust test (scenario_yaml in response) → Task 1. ✅
- §7 A1 UI tests (initial seeds fields, env decode, RunDetail 다시 실행, drift badge) → Tasks 2/4/5/6. ✅
- §8 A1 scope (scenario_yaml, prefill seam, env constraint, RunDetail buttons + warning) → all covered; A2 (migration/presets) explicitly deferred. ✅

**2. Placeholder scan:** no "TBD"/"add validation"/"similar to Task N" — every code step shows full code. ✅

**3. Type consistency:** `RunPrefill = { profile: Profile; env: Record<string,string> }` defined once (Task 2) and consumed identically in Tasks 4/5. `envValueToRecord` signature `(unknown) => Record<string,string>` used in Tasks 2/5/6. `normalizeProfile` `(unknown) => Profile` (Task 2) wraps every `run.profile → Profile` crossing (Tasks 5/6) to collapse the Zod nested-default leak — the one guaranteed `tsc` failure point. `initialBinding?: DataBinding | null` (Task 3) matches `initial?.profile.data_binding ?? null` passed in Task 4. RunDialog props `initial?: RunPrefill` + `scenarioChangedWarning?: boolean` (Task 4) match the call site in Task 5. ✅

**4. Conflict check vs 9b:** no file touched by both plans; A1 stays out of `ui/src/scenario/*` and `ui/src/components/scenario/*` and out of the root CLAUDE.md slice line. The only shared file is `ui/CLAUDE.md` (both append, different subsections → accept-both on conflict), plus the post-merge `pnpm build` gate covers the `flattenHttpSteps` body-rewrite coupling. ✅

---

## Spec-plan-review incorporation (2026-05-31)

This plan was reviewed by `spec-plan-reviewer` (verdict: APPROVED WITH CHANGES). All findings folded in:

- **[BLOCKER] `PendingAssignment` env edit** — Task 1 Step 5 now states explicitly to pass `body.env.clone()` (the `HashMap`), not `env_value`.
- **[BLOCKER] `?retry=` re-open-after-cancel** — Task 5 adds a `consumedRetry` ref guard (fires once per id) + a cancel-then-refetch test that drives `qc.refetchQueries`.
- **[SHOULD-FIX] Profile `| undefined` leak (the reviewer under-rated this — it's a *guaranteed* `tsc` error, per `ui/CLAUDE.md`)** — new `normalizeProfile` helper (Task 2) wraps `run.profile` at every immediate-rerun/prefill boundary (Tasks 5/6); corrected the Task 6 note that wrongly called it "fine".
- **[SHOULD-FIX] DataBindingPanel seed × merge-effect** — Task 3 adds a no-duplicate test for an unscanned mapping var, plus a ready `seededRef` fallback if it ever regresses.
- **[SHOULD-FIX] immediate-rerun error surface (spec §4)** — Tasks 5/6 render a `createRun.error` `role="alert"` banner; Task 5 adds a 400-path test.
- **[NICE] stale-mapping on prefill (spec §6)** — Task 3 adds a stale-column highlight test.
- **[NICE] in-place `RunSchema` edit / preserve `message`** — Task 2 Step 5 reworded to edit in place.
- **Conflict robustness** — added the accept-both-hunks rule for `ui/CLAUDE.md` and the post-merge `pnpm build` gate.
