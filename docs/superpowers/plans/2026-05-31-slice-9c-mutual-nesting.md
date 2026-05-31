# Slice 9c — Mutual 1-Level Nesting (`if`↔`loop`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow exactly one level of *cross-type* container nesting in the scenario authoring UI — an `if` inside a `loop`'s `do`, and a `loop` inside an `if` branch (`then`/`elif[].then`/`else`) — while still forbidding same-type nesting (`loop`-in-`loop`, `if`-in-`if`) and any deeper nesting, with full canvas render + GUI authoring + bidirectional YAML sync.

**Architecture:** The engine already supports arbitrary nesting (`Vec<Step>` recursion, `Box::pin` in the `Step::Loop`/`Step::If` arms — Slice 9a), so 9c is **UI-only plus one engine guard test**. The exact gate (1-level, asymmetric, no-same-type) is enforced by a **two-tier Zod model**: http-only `Nested*` container models that may appear one level down, and top-level `LoopStep`/`IfStep` whose bodies accept `http | the other Nested* type`. This is a deliberate, stronger alternative to the spec's `z.lazy` mutual-recursion hint (which would allow *unbounded same-type* nesting and trip the documented Zod-default `tsc` footgun). Canvas rendering becomes a recursive subflow emitter (React Flow `parentId` chains, depth ≤ 2). Authoring adds two `yaml` Document-API edits + store actions + two gated inspector buttons. The metrics-flattening helpers (`flattenHttpSteps`, `findStepSiblings`) become truly recursive; a new `findStepById` lets the inspector select nested *containers*.

**Tech Stack:** TypeScript, React, Zod, `@xyflow/react` v12, `yaml` (Document API), Zustand, Vitest + React Testing Library + fast-check; Rust + wiremock (one engine test).

---

## Key Constraints (read before starting)

1. **The gate (spec §5).** Allowed: `if`-in-`loop`, `loop`-in-`if` (mutual, exactly 1 level). Forbidden: `if`-in-`if`, `loop`-in-`loop`, and anything 2+ levels deep. Leaves are always `http`.

   | Location | Allowed children | Forbidden |
   |---|---|---|
   | top-level `steps` | http, loop, if | — |
   | `loop.do` | http, **if** (http-only branches) | loop |
   | `if` branch (`then`/`elif[].then`/`else`) | http, **loop** (http-only `do`) | if |

2. **Engine is already done.** `crates/engine/src/scenario.rs` types are `Vec<Step>` (free), `crates/engine/src/runner.rs::execute_steps` recurses through both arms and passes `loop_index` through the `If` arm unchanged. `if`-in-`loop` is already tested (`crates/engine/tests/if_node.rs::if_in_loop_loop_index_visible_in_cond_and_url`); `loop`-in-`if` is **not** — Task 1 closes that gap. **Do not change engine production code.**

3. **Deviation from spec implementation hint — document it.** Spec §6.1/§8 suggest making `StepModel` a `z.lazy` mutual recursion. We instead use explicit two-tier models (no new `z.lazy`). Rationale: a self-referential `StepModel` would validate `loop`-in-`loop`-in-`loop…` (unbounded, same-type), violating §5; the two-tier model enforces §5's exact invariant *by construction* and sidesteps the `ui/CLAUDE.md` "nested `.default()` input-leak" footgun. `ConditionModel`'s existing `z.lazy` is untouched. The spec-compliance reviewer will be told this is intentional.

4. **`pnpm build` is the real gate.** `pnpm test` (esbuild) misses `tsc -b` strict errors. After every model/consumer change run **`cd ui && pnpm test && pnpm build`**. Watch for the Zod nested-`.default()` input-leak surfacing only under `tsc -b` (`ui/CLAUDE.md`).

5. **TDD-guard.** Write the failing test file (or extend an existing one) before touching production `.ts/.tsx`/`.rs`. Pre-commit hook runs the full cargo suite on any non-`.md` commit (so UI commits also build+test Rust — expect slow commits).

6. **Reuse, do not re-derive.** `yamlDoc.ts::findStepPath`/`searchSeq`, `normalizeStep`, `normalizeElif`, `cleanCond` are *already fully recursive* (Slice 9b "9c 포석"). `addStepInLoop`/`addStepInBranch`/`removeStep`/`moveStep`/`setStepField` already operate at any depth via `findStepPath`. Only **creating** a nested container needs new edits.

---

## File Map

| File | Change |
|---|---|
| `crates/engine/tests/if_node.rs` | **Modify** — add `loop_in_if_then_repeats_body` guard test (Task 1) |
| `ui/src/scenario/model.ts` | **Modify** — two-tier models; `flattenHttpSteps`/`findStepSiblings` → recursive; add `findStepById` (Task 2) |
| `ui/src/scenario/__tests__/model.test.ts` | **Modify** — flip loop-in-branch gate; add accept/reject + flatten nesting tests (Task 2) |
| `ui/src/components/scenario/CanvasView.tsx` | **Modify** — recursive `measureStep`/`emitStep` nested layout (Task 2) |
| `ui/src/components/scenario/Inspector.tsx` | **Modify** — `findStepById` resolution; `ChildStepButton`; gated nesting add-buttons (Tasks 2, 4) |
| `ui/src/components/scenario/__tests__/CanvasView.test.tsx` | **Modify** — nested render RTL (Task 2) |
| `ui/src/scenario/yamlDoc.ts` | **Modify** — `addIfInLoop` / `addLoopInBranch` Edit variants (Task 3) |
| `ui/src/scenario/store.ts` | **Modify** — `addIfInLoop` / `addLoopInBranch` actions (Task 3) |
| `ui/src/scenario/__tests__/yamlDoc.test.ts` | **Modify** — nested-create round-trip tests (Task 3) |
| `ui/src/components/scenario/__tests__/Inspector.test.tsx` | **Modify** — gated add-button tests (Task 4) |
| `ui/src/scenario/__tests__/proptests.test.ts` | **Modify** — nested arbitraries + round-trip (Task 5) |
| `ui/src/scenario/__tests__/scanVars.test.ts` | **Modify** — nested-var scan test (Task 5) |
| `docs/adr/0023-conditional-node.md`, root `CLAUDE.md`, `ui/CLAUDE.md`, `docs/roadmap.md`, spec status header | **Modify** — docs (Task 6) |

---

## Task 1: Engine guard test — `loop`-in-`if` body executes

Closes the 9a coverage gap that 9c makes reachable from the product. The engine already supports this (generic `Box::pin` recursion), so the test is expected to **pass on first run** — it is a characterization/regression guard, not red→green.

**Files:**
- Modify/Test: `crates/engine/tests/if_node.rs`

- [ ] **Step 1: Read the existing harness — use the real helpers (do not invent)**

Read `crates/engine/tests/if_node.rs`: the `run_and_count(yaml: &str) -> HashMap<String, u64>` helper (≈ lines 32–56 — it builds a `RunPlan`, spawns `run_scenario`, drains the `MetricFlush` channel into per-step counts, and **asserts `errors == 0` internally**), the imports (`use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};`), and the sibling test `if_in_loop_loop_index_visible_in_cond_and_url` (≈ line 211). Our test reuses `run_and_count` — it already asserts no HTTP errors and returns counts keyed by `step_id`, which is all we need. There is **no** `run_one_vu_one_iteration` / `report.error_count()` in this file — do not reference them.

- [ ] **Step 2: Add the guard test**

Append to `crates/engine/tests/if_node.rs` (Crockford ULIDs avoid I/L/O/U; `{{{{base}}}}` is a literal `{{base}}` flow-var after `format!`):

```rust
// A `loop` nested inside an `if`'s THEN branch must execute its body `repeat`
// times per `if` pass. Engine already supports this (generic Box::pin recursion
// in the Loop/If arms); this guards the path Slice 9c first exposes via the UI.
const LOOP_IN_IF_PING_ID: &str = "01HX00000000000000000000A3";

#[tokio::test]
async fn loop_in_if_then_repeats_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ping"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let base = server.uri();
    // if (1 == 1) { loop repeat=3 { GET /ping } }  — condition always true.
    let yaml = format!(
        r#"
version: 1
name: loop-in-if
variables:
  base: "{base}"
steps:
  - id: "01HX00000000000000000000A1"
    name: gate
    type: if
    cond: {{ left: "1", op: eq, right: "1" }}
    then:
      - id: "01HX00000000000000000000A2"
        name: rep
        type: loop
        repeat: 3
        do:
          - id: "{LOOP_IN_IF_PING_ID}"
            name: ping
            type: http
            request: {{ method: GET, url: "{{{{base}}}}/ping" }}
            assert: [ {{ status: 200 }} ]
"#
    );

    // run_and_count asserts errors == 0 internally and returns per-step counts.
    // The if-condition is always true, so every iteration runs then→loop×3→ping.
    // Assert the nested loop body REPEATED (>= 3 over the run), proving the loop
    // arm executed inside the if branch. We deliberately do NOT assert
    // `pings % 3 == 0`: per crates/engine/CLAUDE.md, a window/deadline can land
    // between loop body steps, so counts are not guaranteed exact `repeat`
    // multiples — `loop_node.rs` uses the same `tick_count >= 3` lower-bound
    // pattern (not an exact-multiple check) for exactly this reason.
    let counts = run_and_count(&yaml).await;
    let pings = counts.get(LOOP_IN_IF_PING_ID).copied().unwrap_or(0);
    assert!(
        pings >= 3,
        "nested loop body must run repeatedly (repeat=3) inside the if-then; got {pings}; counts={counts:?}"
    );
}
```

- [ ] **Step 3: Run the test — expect PASS**

```bash
cargo test -p handicap-engine --test if_node loop_in_if_then_repeats_body -- --nocapture
```
Expected: **PASS** (engine already recurses). If it FAILS, stop — that is a real engine bug surfaced by 9c; switch to `superpowers:systematic-debugging` before continuing.

- [ ] **Step 4: Run the full engine test suite**

```bash
cargo test -p handicap-engine
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/engine/tests/if_node.rs
git commit -m "test(engine): guard loop-in-if-then body execution (9c)"
```

---

## Task 2: Zod model gate + recursive helpers + canvas render (build-green checkpoint)

This is the width change: `loop.do` and `if` branches stop being `HttpStep[]`. Every consumer that read `.request` off a body element must narrow. We fix the model, the two flatten/sibling helpers, add `findStepById`, then restore `tsc -b` by updating the Inspector list-rendering and the CanvasView layout (which also delivers nested rendering). After this task you can author nesting **in YAML** and see it render/select/edit; GUI add-buttons come in Task 4.

**Files:**
- Test: `ui/src/scenario/__tests__/model.test.ts`, `ui/src/components/scenario/__tests__/CanvasView.test.tsx`
- Modify: `ui/src/scenario/model.ts`, `ui/src/components/scenario/CanvasView.tsx`, `ui/src/components/scenario/Inspector.tsx`

- [ ] **Step 1: Write the failing model gate tests**

In `ui/src/scenario/__tests__/model.test.ts`: **(a)** flip the existing http-only rejection of a loop in a branch to an acceptance, and **(b)** add the new accept/reject matrix + flatten-through-nesting test. Reuse the file's existing `IF_JS` / `LOOP_YAML_JS` fixtures and `structuredClone` style.

Replace the existing test `"rejects a loop nested in a branch (http-only gate)"` (≈ lines 334–344) with:

```typescript
it("accepts a loop nested in an if branch (9c mutual nesting)", () => {
  const v = structuredClone(IF_JS) as Record<string, unknown>;
  ((v.steps as Record<string, unknown>[])[0].then as unknown[]).push({
    id: "01HX0000000000000000000014",
    name: "inner-loop",
    type: "loop",
    repeat: 2,
    do: [
      {
        id: "01HX0000000000000000000015",
        name: "h",
        type: "http",
        request: { method: "GET", url: "/x", headers: {} },
        assert: [],
        extract: [],
      },
    ],
  });
  expect(ScenarioModel.safeParse(v).success).toBe(true);
});

it("accepts an if nested in a loop body (9c mutual nesting)", () => {
  const v = structuredClone(LOOP_YAML_JS) as Record<string, unknown>;
  ((v.steps as Record<string, unknown>[])[0].do as unknown[]).push({
    id: "01HX0000000000000000000016",
    name: "inner-if",
    type: "if",
    cond: { left: "{{c}}", op: "eq", right: "1" },
    then: [
      {
        id: "01HX0000000000000000000017",
        name: "h",
        type: "http",
        request: { method: "GET", url: "/y", headers: {} },
        assert: [],
        extract: [],
      },
    ],
  });
  expect(ScenarioModel.safeParse(v).success).toBe(true);
});

it("rejects an if nested in an if branch (same-type forbidden)", () => {
  const v = structuredClone(IF_JS) as Record<string, unknown>;
  ((v.steps as Record<string, unknown>[])[0].then as unknown[]).push({
    id: "01HX0000000000000000000018",
    name: "inner-if",
    type: "if",
    cond: { left: "{{c}}", op: "eq", right: "1" },
    then: [
      {
        id: "01HX0000000000000000000019",
        name: "h",
        type: "http",
        request: { method: "GET", url: "/z", headers: {} },
        assert: [],
        extract: [],
      },
    ],
  });
  expect(ScenarioModel.safeParse(v).success).toBe(false);
});

it("rejects two-level nesting: loop > if > loop", () => {
  const v = structuredClone(LOOP_YAML_JS) as Record<string, unknown>;
  ((v.steps as Record<string, unknown>[])[0].do as unknown[]).push({
    id: "01HX000000000000000000001A",
    name: "inner-if",
    type: "if",
    cond: { left: "{{c}}", op: "eq", right: "1" },
    then: [
      {
        id: "01HX000000000000000000001B",
        name: "deep-loop",
        type: "loop",
        repeat: 2,
        do: [
          {
            id: "01HX000000000000000000001C",
            name: "h",
            type: "http",
            request: { method: "GET", url: "/d", headers: {} },
            assert: [],
            extract: [],
          },
        ],
      },
    ],
  });
  expect(ScenarioModel.safeParse(v).success).toBe(false);
});
```

Keep the existing `"rejects a nested loop inside do (single-level)"` test as-is (loop-in-loop must still be rejected).

Add a flatten-through-nesting test next to the existing `flattenHttpSteps` tests:

```typescript
it("flattenHttpSteps recurses through loop-in-if and if-in-loop", () => {
  const v = structuredClone(IF_JS) as Record<string, unknown>;
  // then = [ existing http (…011), loop{ http(…22) } ]
  ((v.steps as Record<string, unknown>[])[0].then as unknown[]).push({
    id: "01HX0000000000000000000021",
    name: "lp",
    type: "loop",
    repeat: 2,
    do: [
      {
        id: "01HX0000000000000000000022",
        name: "h",
        type: "http",
        request: { method: "GET", url: "/x", headers: {} },
        assert: [],
        extract: [],
      },
    ],
  });
  const r = ScenarioModel.safeParse(v);
  expect(r.success).toBe(true);
  if (r.success) {
    expect(flattenHttpSteps(r.data.steps).map((s) => s.id)).toEqual([
      "01HX0000000000000000000011",
      "01HX0000000000000000000022",
    ]);
  }
});
```

- [ ] **Step 2: Run the new tests — verify the right ones fail**

```bash
cd ui && pnpm test -- model.test.ts
```
Expected red: the two `accepts …` tests FAIL (current model rejects any non-http in a branch/`do`) and the flatten-through-nesting test FAILS/errors. The `rejects an if nested in an if branch` and `rejects two-level: loop > if > loop` tests will **already pass** against the current model (everything non-http in a branch is rejected today) — they are regression guards, not red→green, so do not expect them to fail. The point of Step 2 is to confirm the `accepts`/flatten tests are genuinely red before the model change.

- [ ] **Step 3: Rewrite the model (two-tier gate + recursive helpers + `findStepById`)**

In `ui/src/scenario/model.ts`, replace the current `LoopStepModel`/`LoopStep`, `ElifBranchModel`/`ElifBranch`, `IfStepModel`/`IfStep`, `StepModel`/`Step` block (lines 73–138) **and** the `flattenHttpSteps`/`findStepSiblings` helpers (lines 150–182) with:

```typescript
// ── Nested (one-level-down) container forms: bodies are http-only, so they
//    cannot nest further. These are exactly the pre-9c Loop/If shapes. ──
export const NestedLoopStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("loop"),
    repeat: z.number().int().min(1, "repeat must be >= 1"),
    do: z.array(HttpStepModel).min(1, "loop body needs at least one step"),
  })
  .strict();
export type NestedLoopStep = z.infer<typeof NestedLoopStepModel>;

export const NestedElifBranchModel = z
  .object({
    cond: ConditionModel,
    then: z.array(HttpStepModel).min(1, "elif branch needs at least one step"),
  })
  .strict();

export const NestedIfStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("if"),
    cond: ConditionModel,
    then: z.array(HttpStepModel).min(1, "if branch needs at least one step"),
    elif: z.array(NestedElifBranchModel).default([]),
    else: z.array(HttpStepModel).default([]),
  })
  .strict();
export type NestedIfStep = z.infer<typeof NestedIfStepModel>;

// Body-element unions enforcing the §5 gate by construction:
//   loop.do      = http | nested-if   (NEVER a loop → no loop-in-loop)
//   if.branches  = http | nested-loop (NEVER an if  → no if-in-if)
const LoopBodyStep = z.discriminatedUnion("type", [HttpStepModel, NestedIfStepModel]);
const IfBranchStep = z.discriminatedUnion("type", [HttpStepModel, NestedLoopStepModel]);

// ── Top-level container forms: accept exactly one level of the OTHER type. ──
export const LoopStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("loop"),
    repeat: z.number().int().min(1, "repeat must be >= 1"),
    // do: http | if (single-level mutual nesting, Slice 9c). Loop-in-loop rejected.
    do: z.array(LoopBodyStep).min(1, "loop body needs at least one step"),
  })
  .strict();
export type LoopStep = z.infer<typeof LoopStepModel>;

export const ElifBranchModel = z
  .object({
    cond: ConditionModel,
    then: z.array(IfBranchStep).min(1, "elif branch needs at least one step"),
  })
  .strict();
export type ElifBranch = z.infer<typeof ElifBranchModel>;

export const IfStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("if"),
    cond: ConditionModel,
    // branches: http | loop (single-level mutual nesting, Slice 9c). If-in-if rejected.
    then: z.array(IfBranchStep).min(1, "if branch needs at least one step"),
    elif: z.array(ElifBranchModel).default([]),
    else: z.array(IfBranchStep).default([]),
  })
  .strict();
export type IfStep = z.infer<typeof IfStepModel>;

export const StepModel = z.discriminatedUnion("type", [HttpStepModel, LoopStepModel, IfStepModel]);
export type Step = z.infer<typeof StepModel>;

export function isLoopStep(s: Step): s is LoopStep {
  return s.type === "loop";
}
export function isHttpStep(s: Step): s is HttpStep {
  return s.type === "http";
}
export function isIfStep(s: Step): s is IfStep {
  return s.type === "if";
}

/** Depth-first list of every http leaf, recursing through both container types
 *  to any depth (9c: bodies/branches are now Step[]). Return type unchanged. */
export function flattenHttpSteps(steps: ReadonlyArray<Step>): HttpStep[] {
  const out: HttpStep[] = [];
  for (const s of steps) {
    if (s.type === "http") out.push(s);
    else if (s.type === "loop") out.push(...flattenHttpSteps(s.do));
    else {
      out.push(...flattenHttpSteps(s.then));
      for (const e of s.elif) out.push(...flattenHttpSteps(e.then));
      out.push(...flattenHttpSteps(s.else));
    }
  }
  return out;
}

/** The sequence a step actually lives in — used by the inspector to clamp move
 *  up/down. Fully recursive (9c). Falls back to the top-level list if not found. */
export function findStepSiblings(steps: ReadonlyArray<Step>, stepId: string): ReadonlyArray<Step> {
  return siblingsOrNull(steps, stepId) ?? steps;
}

function siblingsOrNull(
  steps: ReadonlyArray<Step>,
  stepId: string,
): ReadonlyArray<Step> | null {
  if (steps.some((s) => s.id === stepId)) return steps;
  for (const s of steps) {
    if (s.type === "loop") {
      const r = siblingsOrNull(s.do, stepId);
      if (r) return r;
    } else if (s.type === "if") {
      let r = siblingsOrNull(s.then, stepId);
      if (r) return r;
      for (const e of s.elif) {
        r = siblingsOrNull(e.then, stepId);
        if (r) return r;
      }
      r = siblingsOrNull(s.else, stepId);
      if (r) return r;
    }
  }
  return null;
}

/** Find a step of ANY type by id, descending into both container types (9c).
 *  Needed so the inspector can select a nested loop/if container, not just an
 *  http leaf (flattenHttpSteps only returns leaves). */
export function findStepById(steps: ReadonlyArray<Step>, stepId: string | null): Step | null {
  if (stepId === null) return null;
  for (const s of steps) {
    if (s.id === stepId) return s;
    if (s.type === "loop") {
      const r = findStepById(s.do, stepId);
      if (r) return r;
    } else if (s.type === "if") {
      let r = findStepById(s.then, stepId);
      if (r) return r;
      for (const e of s.elif) {
        r = findStepById(e.then, stepId);
        if (r) return r;
      }
      r = findStepById(s.else, stepId);
      if (r) return r;
    }
  }
  return null;
}
```

> Note: `CompareOpModel`, `ConditionModel`, and `HttpStepModel` above this block are unchanged. `NestedLoopStep`/`NestedIfStep` are structural subtypes of `LoopStep`/`IfStep` (narrower bodies), so `loop.do` / `if.then` (typed `(HttpStep | Nested*)[]`) pass cleanly to the `ReadonlyArray<Step>` helpers via array covariance — no casts.

- [ ] **Step 4: Run model tests — verify green**

```bash
cd ui && pnpm test -- model.test.ts
```
Expected: all model tests pass (accepts/rejects/flatten).

- [ ] **Step 5: Fix the Inspector to compile + select nested containers**

In `ui/src/components/scenario/Inspector.tsx`:

(a) Update the import to add `findStepById` and `Step` usage already present:
```typescript
import { flattenHttpSteps, findStepSiblings, findStepById, isLoopStep, isIfStep } from "../../scenario/model";
```
(`flattenHttpSteps` stays imported — still used elsewhere in the file; verify with the editor.)

(b) Replace the selected-step resolution (lines 26–31) so containers resolve too:
```typescript
  const step = useMemo<Step | null>(() => findStepById(steps, selectedStepId), [steps, selectedStepId]);
```

(c) Add a shared child-row button that renders any step type (place near the other small components, e.g. just above `LoopInspector`):
```typescript
function ChildStepButton({ step, onClick }: { step: Step; onClick: () => void }) {
  const meta =
    step.type === "http"
      ? `${step.request.method} ${step.request.url}`
      : step.type === "loop"
        ? `loop ×${step.repeat}`
        : "if";
  return (
    <button
      type="button"
      title={`${step.name} — ${meta}`}
      className="block w-full truncate text-left px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-100"
      onClick={onClick}
    >
      <span className="font-medium">{step.name}</span>{" "}
      <span className="font-mono text-slate-500">{meta}</span>
    </button>
  );
}
```

(d) In `LoopInspector`, replace the `step.do.map(...)` `<li>` body (lines 678–691) with:
```typescript
          {step.do.map((c) => (
            <li key={c.id}>
              <ChildStepButton step={c} onClick={() => select(c.id)} />
            </li>
          ))}
```

(e) In `BranchPanel`, change the prop type and the list rendering. Update the signature `steps: ReadonlyArray<HttpStep>` → `steps: ReadonlyArray<Step>`, add `Step` to the type import if needed, and replace its `steps.map(...)` `<li>` body with the same `<ChildStepButton step={c} onClick={() => select(c.id)} />`. Leave the existing `"+ Add step"` button unchanged for now (Task 4 adds the gated `"+ Add loop"`).

> `IfInspector` already passes `steps={step.then}` / `e.then` / `step.else` — now `(HttpStep | NestedLoopStep)[]`, assignable to `ReadonlyArray<Step>`. No change there in this task.

- [ ] **Step 6: Rewrite CanvasView node layout as a recursive emitter**

In `ui/src/components/scenario/CanvasView.tsx`:

(a) Update the model import to drop the now-unused `HttpStep` if the editor flags it, and keep `isLoopStep, isIfStep, type Condition`; add `type Step`:
```typescript
import { isLoopStep, isIfStep, type Condition, type Step } from "../../scenario/model";
```
(`isLoopStep` is still used by `selectedLoopId`. `summarizeCondition` stays at the bottom.)

**Also delete the now-unused `CHILD_WIDTH` constant** (currently line 29: `const CHILD_WIDTH = NODE_WIDTH - LOOP_PAD * 2;`). The recursive emitter computes the inner width inline as `const inner = width - LOOP_PAD * 2;`, so `CHILD_WIDTH` becomes dead — `tsconfig.json` has `noUnusedLocals: true`, so leaving it fails `tsc -b`. Verify every other constant (`NODE_WIDTH`, `NODE_GAP`, `CHILD_H`, `CHILD_GAP`, `LOOP_HEADER_H`, `LOOP_PAD`, `IF_HEADER_H`, `BAND_LABEL_H`, `BAND_PAD`) is still referenced by `measureStep`/`emitStep` (they are).

(b) Replace the entire `nodes` `useMemo` body (lines 47–152) with a recursive emitter:
```typescript
  const nodes = useMemo<Array<Node<AnyData>>>(() => {
    const out: Array<Node<AnyData>> = [];
    let x = 0;
    for (const step of steps) {
      emitStep(step, x, 0, NODE_WIDTH, undefined, out, selectedStepId);
      x += NODE_WIDTH + NODE_GAP;
    }
    return out;
  }, [steps, selectedStepId]);
```

(c) Add module-scope helpers (place them next to `summarizeCondition` at the bottom of the file):
```typescript
function ifBands(step: Extract<Step, { type: "if" }>): Array<{ label: string; children: Step[] }> {
  return [
    { label: "THEN", children: step.then },
    ...step.elif.map((e, i) => ({ label: `ELIF ${i + 1}`, children: e.then })),
    ...(step.else.length > 0 ? [{ label: "ELSE", children: step.else }] : []),
  ];
}

// Rendered pixel height of a step's node (recursive — a nested container's height
// drives its parent's height).
function measureStep(step: Step): number {
  if (step.type === "http") return CHILD_H;
  if (step.type === "loop") {
    const body = step.do.reduce((h, c) => h + measureStep(c) + CHILD_GAP, 0);
    return LOOP_HEADER_H + LOOP_PAD + Math.max(body, CHILD_H + CHILD_GAP);
  }
  let h = IF_HEADER_H;
  for (const b of ifBands(step)) {
    h += BAND_LABEL_H;
    for (const c of b.children) h += measureStep(c) + CHILD_GAP;
    h += BAND_PAD;
  }
  return h;
}

// Emit a step (and, recursively, its children) as React Flow nodes. Children get
// parentId + extent:"parent"; positions are relative to the immediate parent.
function emitStep(
  step: Step,
  x: number,
  y: number,
  width: number,
  parentId: string | undefined,
  out: Array<Node<AnyData>>,
  selectedStepId: string | null,
): void {
  const base = {
    position: { x, y },
    draggable: false as const,
    selectable: false as const,
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
  };
  if (step.type === "http") {
    out.push({
      id: step.id,
      type: "http",
      data: {
        name: step.name,
        method: step.request.method,
        url: step.request.url,
        selected: step.id === selectedStepId,
      },
      style: { width },
      ...base,
    });
    return;
  }
  const inner = width - LOOP_PAD * 2;
  if (step.type === "loop") {
    out.push({
      id: step.id,
      type: "loop",
      data: { name: step.name, repeat: step.repeat, selected: step.id === selectedStepId },
      style: { width, height: measureStep(step) },
      ...base,
    });
    let cy = LOOP_HEADER_H;
    for (const child of step.do) {
      emitStep(child, LOOP_PAD, cy, inner, step.id, out, selectedStepId);
      cy += measureStep(child) + CHILD_GAP;
    }
    return;
  }
  // if
  const bandMeta: Array<{ label: string; y: number }> = [];
  const placements: Array<{ child: Step; y: number }> = [];
  let cy = IF_HEADER_H;
  for (const b of ifBands(step)) {
    bandMeta.push({ label: b.label, y: cy });
    cy += BAND_LABEL_H;
    for (const child of b.children) {
      placements.push({ child, y: cy });
      cy += measureStep(child) + CHILD_GAP;
    }
    cy += BAND_PAD;
  }
  out.push({
    id: step.id,
    type: "if",
    data: {
      name: step.name,
      condSummary: summarizeCondition(step.cond),
      bands: bandMeta,
      selected: step.id === selectedStepId,
    },
    style: { width, height: cy },
    ...base,
  });
  for (const { child, y: cyy } of placements) {
    emitStep(child, LOOP_PAD, cyy, inner, step.id, out, selectedStepId);
  }
}
```
> The nested-container child width shrinks by `LOOP_PAD*2` per depth (220 → 196 → 172 at depth 2) so inner URLs still truncate inside their container (`ui/CLAUDE.md` truncate-needs-bounded-width footgun). Add `Extract` to the `@xyflow/react`? No — `Extract` is a TS built-in utility type, no import needed.

- [ ] **Step 7: Write the nested canvas RTL test**

In `ui/src/components/scenario/__tests__/CanvasView.test.tsx`, add a test that loads a `loop`-in-`if` scenario and asserts the nested nodes render (reuse the file's existing `reset()` + `loadFromString` harness):
```typescript
it("renders a loop nested inside an if THEN branch (9c)", () => {
  useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: gate
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000020"
        name: inner-loop
        type: loop
        repeat: 3
        do:
          - id: "01HX0000000000000000000021"
            name: ping
            type: http
            request:
              method: GET
              url: "/ping"
            assert:
              - status: 200
`);
  render(<CanvasView />);
  expect(screen.getByText("gate")).toBeInTheDocument();
  expect(screen.getByText("THEN")).toBeInTheDocument();
  expect(screen.getByText("inner-loop")).toBeInTheDocument(); // nested loop container
  expect(screen.getByText(/×\s*3/)).toBeInTheDocument(); // nested loop repeat badge
  expect(screen.getByText("ping")).toBeInTheDocument(); // depth-2 http leaf
});
```

- [ ] **Step 8: Run UI tests + the build gate**

```bash
cd ui && pnpm test && pnpm build
```
Expected: all tests pass AND `tsc -b` is clean.

**The most likely `tsc -b` failure here is the Zod nested-`.default()` input-leak** (`ui/CLAUDE.md`): the new `LoopBodyStep`/`IfBranchStep` `discriminatedUnion`s wrap `NestedIfStepModel`/`NestedLoopStepModel`, which carry `.default([])` on `elif`/`else` — one nesting level deeper than 9b exercised. 9b's identical `.default([])`-in-`discriminatedUnion` shape types cleanly today, so a leak is *unlikely but possible* at the new depth. If `tsc -b` reports a `… | undefined` on `LoopStepModel.do` / `IfStepModel` / a branch element, fix it the way `ConditionModel` already does — **hand-write the type and annotate the schema with it**:
```typescript
// Cannot use `z.infer` here (it would be circular with the annotation). Write the
// type explicitly, then annotate — mirrors ConditionModel: z.ZodType<Condition>.
export type NestedIfStep = { id: string; name: string; type: "if"; cond: Condition;
  then: HttpStep[]; elif: { cond: Condition; then: HttpStep[] }[]; else: HttpStep[] };
export const NestedIfStepModel: z.ZodType<NestedIfStep> = z.object({ /* …as above… */ }).strict();
```
Do the same for `IfStepModel: z.ZodType<IfStep>` if it also leaks. **Keep the `model.test.ts` `.elif`/`.else` default assertions** (an explicit `z.ZodType<…>` annotation can mask genuine shape drift, so those tests are what guard the defaults). Re-run `pnpm build` until clean. (If nothing leaks — the likely outcome — leave the `z.infer` types as written in Step 3; do not add annotations speculatively.)

- [ ] **Step 9: Commit**

```bash
git add ui/src/scenario/model.ts ui/src/scenario/__tests__/model.test.ts \
        ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/Inspector.tsx \
        ui/src/components/scenario/__tests__/CanvasView.test.tsx
git commit -m "feat(ui): allow if↔loop 1-level nesting in model + canvas render (9c)"
```

---

## Task 3: YAML edits + store actions to create nested containers

Existing edits already add *http leaves* into nested containers (via `findStepPath`). This task adds the two edits that **create a nested container**: an `if` into a `loop.do`, and a `loop` into an `if` branch.

**Files:**
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts`
- Modify: `ui/src/scenario/yamlDoc.ts`, `ui/src/scenario/store.ts`

- [ ] **Step 1: Write failing round-trip tests**

In `ui/src/scenario/__tests__/yamlDoc.test.ts`, reuse the existing `IF_YAML` fixture (a top-level `if`, id `…0010`) for `addLoopInBranch`, and the `parseScenarioDoc`/`applyEdit`/`serializeDoc` harness. **Note:** the existing `LOOP_BASE` fixture is a single top-level **http** step (not a loop), so it cannot be the `addIfInLoop` target — author a new `LOOP_WITH_BODY` constant (see the note after the code). Tests:
```typescript
it("addLoopInBranch nests a loop in the then branch (9c)", () => {
  const out = parseScenarioDoc(IF_YAML);
  if ("error" in out) throw new Error(out.error);
  applyEdit(out.doc, {
    type: "addLoopInBranch",
    ifId: "01HX0000000000000000000010",
    branch: { kind: "then" },
    id: "01HX0000000000000000000030",
    name: "inner loop",
    childId: "01HX0000000000000000000031",
  });
  const re = parseScenarioDoc(serializeDoc(out.doc));
  if ("error" in re) throw new Error(re.error);
  const s = re.model.steps[0];
  expect(s.type).toBe("if");
  if (s.type === "if") {
    const nested = s.then.find((c) => c.id === "01HX0000000000000000000030");
    expect(nested?.type).toBe("loop");
    if (nested?.type === "loop") {
      expect(nested.repeat).toBe(1);
      expect(nested.do.map((c) => c.id)).toEqual(["01HX0000000000000000000031"]);
    }
  }
});

it("addIfInLoop nests an if in the loop body (9c)", () => {
  const out = parseScenarioDoc(LOOP_WITH_BODY); // a loop fixture; build inline if not present
  if ("error" in out) throw new Error(out.error);
  applyEdit(out.doc, {
    type: "addIfInLoop",
    loopId: "01HX0000000000000000000040",
    id: "01HX0000000000000000000041",
    name: "inner if",
    childId: "01HX0000000000000000000042",
  });
  const re = parseScenarioDoc(serializeDoc(out.doc));
  if ("error" in re) throw new Error(re.error);
  const loop = re.model.steps.find((s) => s.id === "01HX0000000000000000000040");
  expect(loop?.type).toBe("loop");
  if (loop?.type === "loop") {
    const nested = loop.do.find((c) => c.id === "01HX0000000000000000000041");
    expect(nested?.type).toBe("if");
    if (nested?.type === "if") {
      expect(nested.then.map((c) => c.id)).toEqual(["01HX0000000000000000000042"]);
    }
  }
});
```
> `LOOP_BASE` is http-only, so add a new `LOOP_WITH_BODY` constant at the top of the test file (mirror `IF_YAML`'s string style) — a single top-level loop the `addIfInLoop` test targets by id `…0040`:
> ```typescript
> const LOOP_WITH_BODY = `version: 1
> name: x
> cookie_jar: auto
> variables: {}
> steps:
>   - id: "01HX0000000000000000000040"
>     name: outer-loop
>     type: loop
>     repeat: 1
>     do:
>       - id: "01HX0000000000000000000043"
>         name: seed
>         type: http
>         request:
>           method: GET
>           url: "/seed"
>         assert:
>           - status: 200
> `;
> ```

- [ ] **Step 2: Run — verify failure**

```bash
cd ui && pnpm test -- yamlDoc.test.ts
```
Expected: both new tests fail (`addLoopInBranch`/`addIfInLoop` not in the `Edit` union → no-op, nested step absent).

- [ ] **Step 3: Add the Edit variants + apply arms**

In `ui/src/scenario/yamlDoc.ts`, add to the `Edit` union (after `addStepInBranch`, line 22):
```typescript
  | { type: "addLoopInBranch"; ifId: string; branch: BranchSel; id: string; name: string; childId: string }
  | { type: "addIfInLoop"; loopId: string; id: string; name: string; childId: string }
```
Add to the `applyEdit` switch (after the `addStepInBranch` case, before `addElif`):
```typescript
    case "addLoopInBranch": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      const bp = branchPath(edit.branch);
      ensureSeq(doc, [...ifPath, ...bp]);
      const body = doc.getIn([...ifPath, ...bp]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id,
        name: edit.name,
        type: "loop",
        repeat: 1,
        do: [
          {
            id: edit.childId,
            name: "Step 1",
            type: "http",
            request: { method: "GET", url: "/" },
            assert: [{ status: 200 }],
          },
        ],
      });
      body.add(node);
      return;
    }
    case "addIfInLoop": {
      const loopPath = findStepPath(doc, edit.loopId);
      if (loopPath === null) return;
      ensureSeq(doc, [...loopPath, "do"]);
      const body = doc.getIn([...loopPath, "do"]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id,
        name: edit.name,
        type: "if",
        cond: { left: "", op: "eq", right: "" },
        then: [
          {
            id: edit.childId,
            name: "Step 1",
            type: "http",
            request: { method: "GET", url: "/" },
            assert: [{ status: 200 }],
          },
        ],
      });
      body.add(node);
      return;
    }
```

- [ ] **Step 4: Add store actions**

In `ui/src/scenario/store.ts`:

(a) Declare in the `ScenarioEditorState` interface (after `addStepInBranch`, line 42):
```typescript
  addLoopInBranch(ifId: string, branch: BranchSel, name: string): string; // returns new loop id
  addIfInLoop(loopId: string, name: string): string; // returns new if id
```
(b) Implement (after the `addStepInBranch` action, line 151):
```typescript
  addLoopInBranch(ifId, branch, name) {
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addLoopInBranch", ifId, branch, id, name, childId });
    return id;
  },
  addIfInLoop(loopId, name) {
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addIfInLoop", loopId, id, name, childId });
    return id;
  },
```
(c) Add both to the `actions` capture object at the bottom (after `addStepInBranch: s.addStepInBranch,`):
```typescript
    addLoopInBranch: s.addLoopInBranch,
    addIfInLoop: s.addIfInLoop,
```

- [ ] **Step 5: Run tests + build gate**

```bash
cd ui && pnpm test -- yamlDoc.test.ts && pnpm build
```
Expected: both new tests pass; `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git commit -m "feat(ui): yaml edits + store actions to nest if-in-loop / loop-in-if (9c)"
```

---

## Task 4: Gated inspector add-buttons for nesting

Wire the GUI so QA can create the nesting without editing YAML. The gate predicate is "is this container a **top-level** step?" — only top-level loops may gain an `if`, only top-level ifs may gain a `loop` (a nested container's body is http-only). Adding *steps* to nested containers already works via the existing `addStepInLoop`/`addStepInBranch`.

**Files:**
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx`
- Modify: `ui/src/components/scenario/Inspector.tsx`

- [ ] **Step 1: Write failing inspector tests**

In `ui/src/components/scenario/__tests__/Inspector.test.tsx` (reuse the file's store-reset + render harness), add:
```typescript
it("offers '+ Add if' on a top-level loop and nests it (9c)", async () => {
  const user = userEvent.setup();
  const loopId = useScenarioEditor.getState().addLoopStep("Loop 1");
  useScenarioEditor.getState().select(loopId);
  render(<Inspector />);
  await user.click(screen.getByRole("button", { name: /add if/i }));
  const loop = useScenarioEditor
    .getState()
    .model!.steps.find((s) => s.id === loopId);
  expect(loop?.type).toBe("loop");
  if (loop?.type === "loop") {
    expect(loop.do.some((c) => c.type === "if")).toBe(true);
  }
});

it("offers '+ Add loop' on a top-level if THEN branch and nests it (9c)", async () => {
  const user = userEvent.setup();
  const ifId = useScenarioEditor.getState().addIfStep("If 1");
  useScenarioEditor.getState().select(ifId);
  render(<Inspector />);
  // BranchPanel for THEN exposes its own "+ Add loop"
  const addLoopButtons = screen.getAllByRole("button", { name: /add loop/i });
  await user.click(addLoopButtons[0]);
  const ifStep = useScenarioEditor.getState().model!.steps.find((s) => s.id === ifId);
  expect(ifStep?.type).toBe("if");
  if (ifStep?.type === "if") {
    expect(ifStep.then.some((c) => c.type === "loop")).toBe(true);
  }
});

it("does NOT offer nesting buttons on a nested container (depth gate, 9c)", async () => {
  // if { then: [ loop ] }  — select the nested loop; it must not offer '+ Add if'
  const ifId = useScenarioEditor.getState().addIfStep("If 1");
  const nestedLoopId = useScenarioEditor
    .getState()
    .addLoopInBranch(ifId, { kind: "then" }, "inner");
  useScenarioEditor.getState().select(nestedLoopId);
  render(<Inspector />);
  expect(screen.queryByRole("button", { name: /add if/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run — verify failure**

```bash
cd ui && pnpm test -- Inspector.test.tsx
```
Expected: the first two fail (no such buttons yet); the third may pass trivially — keep it as a regression guard.

- [ ] **Step 3: Thread `topLevel` and add the gated buttons**

In `ui/src/components/scenario/Inspector.tsx`:

(a) In the `Inspector` component, compute the gate and pass it down:
```typescript
  const topLevel = step !== null && steps.some((s) => s.id === step.id);
  ...
  if (isLoopStep(step)) return <LoopInspector step={step} topLevel={topLevel} />;
  if (isIfStep(step)) return <IfInspector step={step} topLevel={topLevel} />;
```

(b) `LoopInspector` — add `topLevel` to its props and an `addIfInLoop` action; render `"+ Add if"` only when `topLevel`, under the "Body steps" list:
```typescript
function LoopInspector({ step, topLevel }: { step: LoopStep; topLevel: boolean }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const setLoopRepeat = useScenarioEditor((s) => s.setLoopRepeat);
  const removeStep = useScenarioEditor((s) => s.removeStep);
  const select = useScenarioEditor((s) => s.select);
  const addStepInLoop = useScenarioEditor((s) => s.addStepInLoop);
  const addIfInLoop = useScenarioEditor((s) => s.addIfInLoop);
  // … existing repeat-draft code unchanged …
```
Replace the closing of the "Body steps" `<div>` (after the `<ul>`) with an add-button row:
```typescript
      <div>
        <div className="text-xs font-semibold text-slate-600 mb-1">Body steps</div>
        <ul className="flex flex-col gap-1">
          {step.do.map((c) => (
            <li key={c.id}>
              <ChildStepButton step={c} onClick={() => select(c.id)} />
            </li>
          ))}
          {step.do.length === 0 && <li className="text-xs text-slate-400 italic">No steps</li>}
        </ul>
        <div className="flex gap-2 mt-1">
          <button
            type="button"
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
            onClick={() => {
              const id = addStepInLoop(step.id, "Step");
              select(id);
            }}
          >
            + Add step
          </button>
          {topLevel && (
            <button
              type="button"
              className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
              onClick={() => {
                const id = addIfInLoop(step.id, "If");
                select(id);
              }}
            >
              + Add if
            </button>
          )}
        </div>
      </div>
```
> This adds an inspector `"+ Add step"` so **nested** loops (which the canvas toolbar's top-level-only `selectedLoopId` can't reach) can still get body steps. The toolbar's `"+ Add step in loop"` for top-level loops stays — minor, harmless redundancy at the top level.
>
> **Label-collision note:** this inspector `"+ Add if"` (nested `addIfInLoop`) shares its visible text with the CanvasView toolbar's top-level `"+ Add if"` (`addIfStep`). The Step 1 tests render `<Inspector />` in isolation (no CanvasView), so `getByRole("button", {name: /add if/i})` is unambiguous there. If any **future** test mounts both, scope the query (e.g. `within(inspector).getByRole(...)`) or use `getAllByRole` — do not rely on a single global match.

(c) `IfInspector` — accept `topLevel` and pass `loopAllowed={topLevel}` to each `BranchPanel`:
```typescript
function IfInspector({ step, topLevel }: { step: IfStep; topLevel: boolean }) {
  // … existing action hooks …
  // THEN:
  <BranchPanel label="Then" branch={{ kind: "then" }} steps={step.then} ifId={step.id} loopAllowed={topLevel} />
  // each ELIF:
  <BranchPanel label={`Elif ${i + 1}`} branch={{ kind: "elif", index: i }} steps={e.then} ifId={step.id} loopAllowed={topLevel} />
  // ELSE:
  <BranchPanel label="Else" branch={{ kind: "else" }} steps={step.else} ifId={step.id} loopAllowed={topLevel} />
```

(d) `BranchPanel` — add `loopAllowed` prop + `addLoopInBranch`; render `"+ Add loop"` next to `"+ Add step"` when allowed:
```typescript
function BranchPanel({
  label,
  branch,
  steps,
  ifId,
  loopAllowed,
}: {
  label: string;
  branch: BranchSel;
  steps: ReadonlyArray<Step>;
  ifId: string;
  loopAllowed: boolean;
}) {
  const addStepInBranch = useScenarioEditor((s) => s.addStepInBranch);
  const addLoopInBranch = useScenarioEditor((s) => s.addLoopInBranch);
  const select = useScenarioEditor((s) => s.select);
  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 mb-1">{label}</div>
      <ul className="flex flex-col gap-1">
        {steps.map((c) => (
          <li key={c.id}>
            <ChildStepButton step={c} onClick={() => select(c.id)} />
          </li>
        ))}
        {steps.length === 0 && <li className="text-xs text-slate-400 italic">No steps</li>}
      </ul>
      <div className="flex gap-2 mt-1">
        <button
          type="button"
          aria-label={`Add step to ${label}`}
          className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
          onClick={() => {
            const id = addStepInBranch(ifId, branch, "Step");
            select(id);
          }}
        >
          + Add step
        </button>
        {loopAllowed && (
          <button
            type="button"
            aria-label={`Add loop to ${label}`}
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
            onClick={() => {
              const id = addLoopInBranch(ifId, branch, "Loop");
              select(id);
            }}
          >
            + Add loop
          </button>
        )}
      </div>
    </div>
  );
}
```
> Add `type Step` to the Inspector's model type import if not already present.

- [ ] **Step 4: Run tests + build gate**

```bash
cd ui && pnpm test -- Inspector.test.tsx && pnpm build
```
Expected: all three pass; `tsc -b` clean. If the existing Inspector tests referenced `BranchPanel`/`LoopInspector` prop shapes directly, update those call sites — but they are internal components, so only `Inspector`-level tests should exist.

- [ ] **Step 5: Run the full UI suite**

```bash
cd ui && pnpm test && pnpm build
```
Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): gated inspector buttons to author if↔loop nesting (9c)"
```

---

## Task 5: Property-based + var-scan coverage for nesting

Extend the round-trip property test so generated scenarios actually contain nested containers, and confirm `scanFlowVars` reaches `{{var}}`s inside nested branches/bodies (it does, via the now-recursive `flattenHttpSteps` — guard it).

**Files:**
- Test: `ui/src/scenario/__tests__/proptests.test.ts`, `ui/src/scenario/__tests__/scanVars.test.ts`

- [ ] **Step 1: Extend the arbitraries to generate nested steps**

In `ui/src/scenario/__tests__/proptests.test.ts`, first add `NestedLoopStep, NestedIfStep` to the existing model type import (they are now exported from `model.ts` by Task 2). Then add **nested** (http-only) container arbitraries and feed them into the existing `loopStepArb`/`ifStepArb` bodies. Place the nested arbitraries **before** `loopStepArb`/`ifStepArb`. **The nested arbs MUST be typed `fc.Arbitrary<NestedLoopStep>` / `fc.Arbitrary<NestedIfStep>`** — NOT `LoopStep`/`IfStep`: the top-level types have *wider* (`Step[]`) bodies, so an `fc.Arbitrary<IfStep>` value is **not** assignable where the `LoopBodyStep = HttpStep | NestedIfStep` element is expected (`IfStep` is the supertype of `NestedIfStep`, not a subtype), which fails `tsc -b`.
```typescript
// Nested (http-only) container forms — what may appear one level down (9c gate).
const nestedLoopArb: fc.Arbitrary<NestedLoopStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("loop" as const),
  repeat: fc.integer({ min: 1, max: 20 }),
  do: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }),
});

const nestedIfArb: fc.Arbitrary<NestedIfStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("if" as const),
  cond: conditionArb,
  then: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }),
  elif: fc.array(
    fc.record({ cond: conditionArb, then: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }) }),
    { maxLength: 1 },
  ),
  else: fc.array(httpStepArb, { maxLength: 1 }),
});
```
Then widen `loopStepArb.do` to `http | nested-if` and `ifStepArb` branches to `http | nested-loop`:
```typescript
const loopStepArb: fc.Arbitrary<LoopStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("loop" as const),
  repeat: fc.integer({ min: 1, max: 20 }),
  do: fc.array(fc.oneof({ weight: 3, arbitrary: httpStepArb }, { weight: 1, arbitrary: nestedIfArb }), {
    minLength: 1,
    maxLength: 2,
  }),
});

const ifBranchArb = fc.oneof(
  { weight: 3, arbitrary: httpStepArb },
  { weight: 1, arbitrary: nestedLoopArb },
);
const ifStepArb: fc.Arbitrary<IfStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("if" as const),
  cond: conditionArb,
  then: fc.array(ifBranchArb, { minLength: 1, maxLength: 2 }),
  elif: fc.array(fc.record({ cond: conditionArb, then: fc.array(ifBranchArb, { minLength: 1, maxLength: 2 }) }), {
    maxLength: 2,
  }),
  else: fc.array(ifBranchArb, { maxLength: 2 }),
});
```
> With the nested arbs typed as `NestedLoopStep`/`NestedIfStep`, `fc.oneof({arbitrary: httpStepArb}, {arbitrary: nestedIfArb})` produces `fc.Arbitrary<HttpStep | NestedIfStep>` — exactly the `LoopBodyStep` element type — so no further annotation is needed. (`NestedLoopStep`/`NestedIfStep` only ever emit http-only bodies, keeping every generated scenario inside the §5 gate.)

- [ ] **Step 1b: Make the canonical serializers recurse (else the round-trip throws on nested shapes)**

The property test serializes via hand-written `*ToYaml` helpers. Currently `loopStepToYaml` (line 198) does `do: st.do.map(httpStepToYaml)` and `ifStepToYaml` (lines 219/222/224) maps branches through `httpStepToYaml`. Once `do`/branches can contain a nested container, calling `httpStepToYaml` on a `loop`/`if` reads `.request`/`.assert` off the wrong shape → malformed YAML → the round-trip property throws. Switch those four call sites to the already-recursive dispatcher `stepToYaml` (it's a hoisted `function` declared at line 228, so forward calls from `loopStepToYaml`/`ifStepToYaml` are fine):

```typescript
// loopStepToYaml:
    do: st.do.map(stepToYaml),
// ifStepToYaml:
    then: st.then.map(stepToYaml),
    // elif:
    out.elif = st.elif.map((e) => ({ cond: condToYaml(e.cond), then: e.then.map(stepToYaml) }));
    // else:
  if (st.else.length > 0) out.else = st.else.map(stepToYaml);
```
> `condToYaml` already recurses (all/any); leave it. Only the step-body maps change from `httpStepToYaml` → `stepToYaml`.

- [ ] **Step 2: Run the property test**

```bash
cd ui && pnpm test -- proptests.test.ts
```
Expected: the existing `scenario round-trip property` test still passes (now exercising nested shapes). If a shrink fails, a real round-trip bug exists — raise `numRuns` to reproduce and switch to `superpowers:systematic-debugging`.

- [ ] **Step 3: Add the nested var-scan test**

In `ui/src/scenario/__tests__/scanVars.test.ts`, add (reuse the file's `scenario(...)` / `ScenarioModel.parse` helper):
```typescript
it("scans {{vars}} inside nested loop-in-if and if-in-loop http steps (9c)", () => {
  const s = ScenarioModel.parse({
    version: 1,
    name: "x",
    cookie_jar: "auto",
    variables: {},
    steps: [
      {
        id: "01HX0000000000000000000010",
        name: "branch",
        type: "if",
        cond: { left: "{{code}}", op: "eq", right: "200" },
        then: [
          {
            id: "01HX0000000000000000000020",
            name: "lp",
            type: "loop",
            repeat: 2,
            do: [
              {
                id: "01HX0000000000000000000021",
                name: "h",
                type: "http",
                request: { method: "GET", url: "/{{deep}}", headers: {} },
                assert: [],
                extract: [],
              },
            ],
          },
        ],
        elif: [],
        else: [],
      },
    ],
  });
  expect([...scanFlowVars(s)]).toEqual(["deep"]);
});
```
> Condition operands (`{{code}}`) remain intentionally un-scanned (9b decision, preserved).

- [ ] **Step 4: Run scanVars tests + full build gate**

```bash
cd ui && pnpm test && pnpm build
```
Expected: all green; `tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/__tests__/proptests.test.ts ui/src/scenario/__tests__/scanVars.test.ts
git commit -m "test(ui): property + var-scan coverage for if↔loop nesting (9c)"
```

---

## Task 6: Documentation (ADR, CLAUDE, roadmap, spec status)

**Files:**
- Modify: `docs/adr/0023-conditional-node.md`, root `CLAUDE.md`, `ui/CLAUDE.md`, `docs/roadmap.md`, `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md`

- [ ] **Step 1: ADR-0023**

In `docs/adr/0023-conditional-node.md`, update the status/scope note to record that 9c (mutual 1-level nesting) is implemented. Add a short paragraph: the UI gate is a **two-tier Zod model** (http-only `Nested*` forms + top-level forms accepting `http | the other Nested* type`), chosen over `z.lazy` self-recursion because the latter would admit unbounded same-type nesting; the engine remains the loose `Vec<Step>` authority.

- [ ] **Step 2: Root `CLAUDE.md`**

(a) Update the status line near the top: change "다음 = Slice 9c …" to mark 9c done and point at **9d(분기별 메트릭)** as next. (b) Add a `**Slice 9c 결과:**` bullet to the slice-history block mirroring the 9a/9b entries: two-tier Zod gate (no new `z.lazy`), recursive canvas emitter, `findStepById`, `addIfInLoop`/`addLoopInBranch` edits+actions, gated inspector buttons, recursive `flattenHttpSteps`/`findStepSiblings`; **controller·proto·worker·metrics·runs 무변경**; engine unchanged (added one guard test). (c) In "알아둘 결정들", append 9c to the ADR-0023 line.

- [ ] **Step 3: `ui/CLAUDE.md`**

Add gotcha lines under the React Flow / model sections:
- The **two-tier model** pattern and *why not `z.lazy`* (would allow unbounded same-type nesting; explicit tiers enforce the exact §5 gate and dodge the nested-`.default()` `tsc` leak).
- `flattenHttpSteps`/`findStepSiblings` are now **fully recursive**; **`findStepById`** is the new resolver that selects nested *containers* (the inspector previously used `flattenHttpSteps` which returns only http leaves, so nested containers were unselectable).
- CanvasView uses a recursive `measureStep`/`emitStep` (height computed bottom-up; child width shrinks `LOOP_PAD*2` per depth so inner URLs still truncate).
- Nesting add-buttons are **gated on top-level** (`steps.some(id===…)`); nested containers are http-only, so they expose only `"+ Add step"`.

- [ ] **Step 4: `docs/roadmap.md`**

Move 9c from "남은 하위 슬라이스" to done; leave **9d = 분기별 메트릭 breakdown** as the next item.

- [ ] **Step 5: Spec status header**

In `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md` line 3, update status to "9a + 9b + 9c 구현·머지 완료; 9d 메트릭 미구현".

- [ ] **Step 6: Commit (docs-only — fast pre-commit path)**

```bash
git add docs/ CLAUDE.md ui/CLAUDE.md
git commit -m "docs: Slice 9c mutual nesting — ADR/CLAUDE/roadmap/spec status (9c)"
```

---

## Self-Review (run before handing off to execution)

**1. Spec coverage (§5/§6/§8 of the design doc):**
- §5 gate (http+if in `loop.do`, http+loop in `if` branches; no same-type; no deeper) → Task 2 model + Task 2 model tests (accept/reject matrix incl. 2-level). ✓
- §6.1 Zod gate relaxation → Task 2 (two-tier, deliberate deviation from the `z.lazy` hint, documented). ✓
- §6.2 canvas nested subflow depth (both directions) → Task 2 recursive emitter + RTL test. ✓
- §6.4 SF-1 `flattenHttpSteps` true recursion (return type `HttpStep[]` unchanged) → Task 2. ✓ `scanFlowVars` inherits recursion → Task 5 guard. ✓
- §8 9c test list (nesting round-trip, canvas nested render RTL) → Tasks 2/3/5. ✓
- **Beyond spec (found during planning, kept):** `findStepById` (nested-container selection), `findStepSiblings` recursion (depth-2 move clamp), `addIfInLoop`/`addLoopInBranch` authoring edits + gated buttons, engine `loop`-in-`if` guard test. These are required for the feature to be usable; noted for the spec reviewer.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Engine Task 1 intentionally says "adapt to the file's actual driver/accessor" — that is a *read-then-match* instruction with the exact assertion invariant given, not a placeholder.

**3. Type consistency:** `findStepById(steps, stepId)` (model.ts) ↔ Inspector usage; `addLoopInBranch(ifId, branch, name)` / `addIfInLoop(loopId, name)` consistent across `Edit` union (yamlDoc.ts), store interface, store impl, `actions` capture, and inspector call sites; `ChildStepButton({step, onClick})` consistent in LoopInspector + BranchPanel; `topLevel`/`loopAllowed` props threaded Inspector → LoopInspector/IfInspector → BranchPanel. ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-31-slice-9c-mutual-nesting.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review (spec-compliance → code-quality) between tasks, fast iteration; final whole-feature pass with the `handicap-reviewer` agent (per root `CLAUDE.md` process notes).

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
