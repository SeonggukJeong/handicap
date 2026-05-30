# Slice 9b — UI Authoring for Conditional (`if`) Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full UI authoring for the `type: if` conditional node (Zod model, canvas container with THEN/ELIF/ELSE bands, recursive condition builder inspector, bidirectional YAML sync) on top of the already-shipped 9a engine, with branches restricted to http-only (nesting is 9c).

**Architecture:** Mirror the Slice 7 loop pattern. `IfStep` joins the `StepModel` discriminated union; `Condition` is a recursive `z.lazy` `z.union` matching the engine's manual serde 1:1. The canvas renders an `if` as a React-Flow parent container with vertically-stacked band labels and child http nodes. The inspector hosts a recursive condition-tree builder (commit-on-blur, `ExtractEditor` pattern) and per-branch step lists. All edits flow through `yaml` Document-API targeted edits, re-deriving the Zod-validated model after each change.

**Tech Stack:** TypeScript, React, Zod, `@xyflow/react` v12, `yaml` (Document API), Zustand, Vitest + React Testing Library + fast-check.

---

## Key Constraints (read before starting)

1. **The union flip is a wide change.** Adding `IfStep` to `StepModel` makes `s.type` a 3-way union; every place that does `if (s.type === "http") ... else ...` (CanvasView, Inspector, `flattenHttpSteps`) stops compiling until it narrows the `if` case. So **Task 1 must land model + `flattenHttpSteps` + `normalizeStep(if)` + recursive `findStepPath` + CanvasView if-rendering + an Inspector if-route together** — that is the first build-green checkpoint. (ui/CLAUDE.md: "Step을 discriminated union으로 바꾸면 모든 consumer가 union narrowing을 거쳐야 한다".)

2. **`pnpm build` is the real gate, not `pnpm test`.** `pnpm test` uses esbuild transpile and misses TS strict errors (Zod default-leak, union mismatch). **Every UI task ends with `cd ui && pnpm test && pnpm build`.** The pre-commit hook only runs `cargo`, never `pnpm` (root CLAUDE.md).

3. **TDD-guard hook:** writing/modifying a `*.test.ts(x)` file in the same change unblocks editing `ui/src/*.tsx`. Every task writes/extends its test file FIRST.

4. **Field names match the engine wire format exactly:** `cond`, `op`, `left`, `right`, `all`, `any`, `then`, `elif`, `else`. `then`/`else` are valid object keys (an array `.then` is not callable, so it is not a thenable — safe). Use member access `step.else` (reserved words are legal after `.`); never destructure `else` as a binding name.

5. **`right` is omitted (not `null`/`""`) for `exists`/`empty` ops** — the engine serializes `Compare` without `right` for those. The `cleanCond` helper enforces this when writing the doc.

6. **Branches are http-only in 9b.** `IfStepModel.then` / `elif[].then` / `else` are `z.array(HttpStepModel)`. A loop nested in a branch is rejected by Zod (gate relaxed in 9c). `flattenHttpSteps` stays non-recursive for the `if` case (9c rewrites it to true recursion — spec SF-1).

---

## File Map

| File | Change |
|---|---|
| `ui/src/scenario/model.ts` | + `CompareOpModel`, `Condition` type + `ConditionModel`, `ElifBranchModel`, `IfStepModel`; add `IfStep` to `StepModel`; `isIfStep`; extend `flattenHttpSteps`; new `findStepSiblings` |
| `ui/src/scenario/yamlDoc.ts` | `normalizeStep(if)` + `normalizeElif`; recursive `findStepPath`; (Task 2) new `Edit` variants + `applyEdit` cases + `cleanCond`/`branchPath`/`BranchSel` |
| `ui/src/scenario/store.ts` | (Task 3) `addIfStep`/`setIfCond`/`setElifCond`/`addStepInBranch`/`addElif`/`removeElif` actions + interface + `getInitialState` list |
| `ui/src/components/scenario/IfStepNode.tsx` | **new** — React-Flow container node (header + condition summary + band labels) |
| `ui/src/components/scenario/CanvasView.tsx` | if-layout (bands + children + `summarizeCondition`), `NODE_TYPES.if`; (Task 4) "+ Add if" button |
| `ui/src/components/scenario/Inspector.tsx` | if-route + `findStepSiblings` fix; (Task 1) read-only `IfInspectorStub`; (Task 5) full `IfInspector` + `ConditionEditor` + `BranchPanel` |
| `ui/src/scenario/__tests__/model.test.ts` | if/condition model cases |
| `ui/src/scenario/__tests__/yamlDoc.test.ts` | if edit cases |
| `ui/src/scenario/__tests__/store.test.ts` | if action cases |
| `ui/src/components/scenario/__tests__/CanvasView.test.tsx` | if container render + add-if button |
| `ui/src/components/scenario/__tests__/Inspector.test.tsx` | if condition builder + branch editing |
| `ui/src/scenario/__tests__/scanVars.test.ts` | branch-var scan case |
| `ui/src/scenario/__tests__/proptests.test.ts` | `conditionArb` + `ifStepArb` round-trip |
| docs (Task 7) | spec status, root + ui CLAUDE.md, MEMORY/roadmap |

---

The tasks are written in the following message sections. Each is independently committable and ends green.

---

### Task 1: Zod model, tree helpers, parsing, canvas rendering & inspector route (build-green checkpoint)

**Files:**
- Modify: `ui/src/scenario/model.ts`
- Modify: `ui/src/scenario/yamlDoc.ts` (`normalizeStep`, `normalizeElif`, recursive `findStepPath`)
- Create: `ui/src/components/scenario/IfStepNode.tsx`
- Modify: `ui/src/components/scenario/CanvasView.tsx`
- Modify: `ui/src/components/scenario/Inspector.tsx`
- Test: `ui/src/scenario/__tests__/model.test.ts`, `ui/src/components/scenario/__tests__/CanvasView.test.tsx`, `ui/src/components/scenario/__tests__/Inspector.test.tsx`

- [ ] **Step 1: Write failing model tests** — append to `ui/src/scenario/__tests__/model.test.ts`. Also add `isIfStep` and `type IfStep` to the existing import block at the top of the file.

```ts
// add to the top-of-file import from "../model":
//   isIfStep,
//   type IfStep,

describe("if step model (9b)", () => {
  const IF_JS = {
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
            id: "01HX0000000000000000000011",
            name: "ok",
            type: "http",
            request: { method: "GET", url: "/ok", headers: {} },
            assert: [],
            extract: [],
          },
        ],
      },
    ],
  };

  it("accepts a single-condition if; elif/else default to []", () => {
    const r = ScenarioModel.safeParse(IF_JS);
    expect(r.success).toBe(true);
    if (r.success) {
      const s = r.data.steps[0];
      expect(isIfStep(s)).toBe(true);
      if (isIfStep(s)) {
        expect(s.elif).toEqual([]);
        expect(s.else).toEqual([]);
      }
    }
  });

  it("accepts a nested all/any condition tree", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    (v.steps as Record<string, unknown>[])[0].cond = {
      all: [
        { left: "{{code}}", op: "eq", right: "200" },
        { any: [
          { left: "{{b}}", op: "contains", right: "ok" },
          { left: "{{r}}", op: "gte", right: "3" },
        ] },
      ],
    };
    expect(ScenarioModel.safeParse(v).success).toBe(true);
  });

  it("accepts an exists op leaf with no right", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    (v.steps as Record<string, unknown>[])[0].cond = { left: "{{t}}", op: "exists" };
    expect(ScenarioModel.safeParse(v).success).toBe(true);
  });

  it("accepts elif and else branches", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    const step = (v.steps as Record<string, unknown>[])[0];
    step.elif = [
      {
        cond: { left: "{{code}}", op: "eq", right: "404" },
        then: [
          { id: "01HX0000000000000000000012", name: "retry", type: "http",
            request: { method: "GET", url: "/retry", headers: {} }, assert: [], extract: [] },
        ],
      },
    ];
    step.else = [
      { id: "01HX0000000000000000000013", name: "report", type: "http",
        request: { method: "POST", url: "/err", headers: {} }, assert: [], extract: [] },
    ];
    expect(ScenarioModel.safeParse(v).success).toBe(true);
  });

  it("rejects an empty then branch (min 1)", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    (v.steps as Record<string, unknown>[])[0].then = [];
    expect(ScenarioModel.safeParse(v).success).toBe(false);
  });

  it("rejects a loop nested in a branch (http-only gate)", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    ((v.steps as Record<string, unknown>[])[0].then as unknown[]).push({
      id: "01HX0000000000000000000014", name: "l", type: "loop", repeat: 2, do: [],
    });
    expect(ScenarioModel.safeParse(v).success).toBe(false);
  });

  it("rejects a malformed condition (no left/all/any)", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    (v.steps as Record<string, unknown>[])[0].cond = { op: "eq", right: "x" };
    expect(ScenarioModel.safeParse(v).success).toBe(false);
  });

  it("flattenHttpSteps walks then/elif/else branches in order", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    const step = (v.steps as Record<string, unknown>[])[0];
    step.elif = [
      { cond: { left: "{{c}}", op: "eq", right: "1" },
        then: [{ id: "01HX0000000000000000000012", name: "e", type: "http",
          request: { method: "GET", url: "/e", headers: {} }, assert: [], extract: [] }] },
    ];
    step.else = [{ id: "01HX0000000000000000000013", name: "x", type: "http",
      request: { method: "GET", url: "/x", headers: {} }, assert: [], extract: [] }];
    const r = ScenarioModel.safeParse(v);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(flattenHttpSteps(r.data.steps).map((s) => s.id)).toEqual([
        "01HX0000000000000000000011",
        "01HX0000000000000000000012",
        "01HX0000000000000000000013",
      ]);
    }
  });
});
```

- [ ] **Step 2: Run model tests to confirm they fail**

Run: `cd ui && pnpm test -- model.test`
Expected: FAIL — `isIfStep` is not exported / `type: "if"` rejected by `StepModel`.

- [ ] **Step 3: Implement the Zod model.** In `ui/src/scenario/model.ts`, insert the following block immediately **after** `LoopStepModel`/`type LoopStep` (line ~91) and **before** the `export const StepModel = ...` line:

```ts
export const CompareOpModel = z.enum([
  "eq", "ne", "contains", "matches", "lt", "gt", "lte", "gte", "exists", "empty",
]);
export type CompareOp = z.infer<typeof CompareOpModel>;

// Recursive condition tree. The three shapes share no discriminant key, so this is
// a z.union (NOT discriminatedUnion), distinguished by key presence (left / all /
// any) — a 1:1 match for the engine's manual serde (scenario.rs::Condition). z.lazy
// because it self-references; this is the model's first use of z.lazy.
export type Condition =
  | { left: string; op: CompareOp; right?: string }
  | { all: Condition[] }
  | { any: Condition[] };

export const ConditionModel: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ left: z.string(), op: CompareOpModel, right: z.string().optional() }).strict(),
    z.object({ all: z.array(ConditionModel) }).strict(),
    z.object({ any: z.array(ConditionModel) }).strict(),
  ]),
);

export const ElifBranchModel = z
  .object({
    cond: ConditionModel,
    then: z.array(HttpStepModel).min(1, "elif branch needs at least one step"),
  })
  .strict();
export type ElifBranch = z.infer<typeof ElifBranchModel>;

export const IfStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("if"),
    cond: ConditionModel,
    then: z.array(HttpStepModel).min(1, "if branch needs at least one step"),
    elif: z.array(ElifBranchModel).default([]),
    else: z.array(HttpStepModel).default([]),
  })
  .strict();
export type IfStep = z.infer<typeof IfStepModel>;
```

Then change the `StepModel` line to include the third variant:

```ts
export const StepModel = z.discriminatedUnion("type", [HttpStepModel, LoopStepModel, IfStepModel]);
```

Add the type guard next to `isLoopStep`/`isHttpStep`:

```ts
export function isIfStep(s: Step): s is IfStep {
  return s.type === "if";
}
```

Replace `flattenHttpSteps` with the 3-way-narrowing version:

```ts
/** Depth-first list of every http step, recursing into loop bodies and walking
 *  if branches (then / elif[].then / else). Branches are http-only in 9b; 9c makes
 *  them Step[] and rewrites this into a true recursion (spec SF-1). */
export function flattenHttpSteps(steps: ReadonlyArray<Step>): HttpStep[] {
  const out: HttpStep[] = [];
  for (const s of steps) {
    if (s.type === "http") out.push(s);
    else if (s.type === "loop") out.push(...s.do);
    else {
      out.push(...s.then);
      for (const e of s.elif) out.push(...e.then);
      out.push(...s.else);
    }
  }
  return out;
}

/** The sequence a step actually lives in — top-level steps, a loop `do` body, or
 *  an if branch — used by the inspector to clamp move up/down. Falls back to the
 *  top-level list if the step is not found nested. */
export function findStepSiblings(
  steps: ReadonlyArray<Step>,
  stepId: string,
): ReadonlyArray<Step> {
  if (steps.some((s) => s.id === stepId)) return steps;
  for (const s of steps) {
    if (s.type === "loop") {
      if (s.do.some((c) => c.id === stepId)) return s.do;
    } else if (s.type === "if") {
      if (s.then.some((c) => c.id === stepId)) return s.then;
      for (const e of s.elif) if (e.then.some((c) => c.id === stepId)) return e.then;
      if (s.else.some((c) => c.id === stepId)) return s.else;
    }
  }
  return steps;
}
```

- [ ] **Step 4: Run model tests to verify they pass**

Run: `cd ui && pnpm test -- model.test`
Expected: PASS.

- [ ] **Step 5: Make if-scenarios parse — `normalizeStep`/`findStepPath` in `yamlDoc.ts`.** In `normalizeStep` (currently special-cases `loop`, else treats as http), add an `if` branch immediately after the `loop` block, and add a `normalizeElif` helper below `normalizeStep`:

```ts
  if (src.type === "if") {
    return {
      id: src.id,
      name: src.name,
      type: "if",
      cond: src.cond, // shape already matches ConditionModel — passthrough
      then: Array.isArray(src.then) ? src.then.map(normalizeStep) : [],
      elif: Array.isArray(src.elif) ? src.elif.map(normalizeElif) : [],
      else: Array.isArray(src.else) ? src.else.map(normalizeStep) : [],
    };
  }
```

```ts
function normalizeElif(e: unknown): unknown {
  if (typeof e !== "object" || e === null) return e;
  const src = e as Record<string, unknown>;
  return {
    cond: src.cond,
    then: Array.isArray(src.then) ? src.then.map(normalizeStep) : [],
  };
}
```

Replace `findStepPath` (and its single-level loop walk) with a fully recursive search that also descends if branches (future-proofs 9c; behavior-compatible for top-level + loop). Keep the existing null-return contract/comment:

```ts
// Tree-aware step locator: recursively searches top-level steps, loop `do` bodies,
// and if branches (then / elif[].then / else). Returns the full doc path or null.
// Callers no-op on null (stale stepIds can arrive after a step is removed).
function findStepPath(
  doc: Document,
  stepId: string,
): Array<string | number> | null {
  return searchSeq(doc.getIn(["steps"]), ["steps"], stepId);
}

function searchSeq(
  seq: unknown,
  basePath: ReadonlyArray<string | number>,
  stepId: string,
): Array<string | number> | null {
  if (!isSeq(seq)) return null;
  for (let i = 0; i < seq.items.length; i++) {
    const item = seq.items[i] as Node;
    if (!isMap(item)) continue;
    const path = [...basePath, i];
    if (item.get("id") === stepId) return path;
    const inLoop = searchSeq(item.get("do"), [...path, "do"], stepId);
    if (inLoop) return inLoop;
    const inThen = searchSeq(item.get("then"), [...path, "then"], stepId);
    if (inThen) return inThen;
    const inElse = searchSeq(item.get("else"), [...path, "else"], stepId);
    if (inElse) return inElse;
    const elif = item.get("elif");
    if (isSeq(elif)) {
      for (let j = 0; j < elif.items.length; j++) {
        const eb = elif.items[j] as Node;
        if (!isMap(eb)) continue;
        const inElif = searchSeq(eb.get("then"), [...path, "elif", j, "then"], stepId);
        if (inElif) return inElif;
      }
    }
  }
  return null;
}
```

- [ ] **Step 6: Run existing yamlDoc tests to confirm no regression**

Run: `cd ui && pnpm test -- yamlDoc`
Expected: PASS (loop/top-level behavior unchanged).

- [ ] **Step 7: Create `IfStepNode.tsx`** at `ui/src/components/scenario/IfStepNode.tsx`:

```tsx
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export interface IfStepNodeData extends Record<string, unknown> {
  name: string;
  condSummary: string;
  bands: Array<{ label: string; y: number }>;
  selected: boolean;
}

type IfStepNodeType = Node<IfStepNodeData, "if">;

function IfStepNodeImpl({ data }: NodeProps<IfStepNodeType>) {
  const { name, condSummary, bands, selected } = data;
  return (
    <div
      className={
        "relative box-border h-full w-full rounded-md border-2 border-dashed bg-indigo-50/50 " +
        (selected ? "border-indigo-700 ring-1 ring-indigo-700" : "border-indigo-400")
      }
    >
      <Handle type="target" position={Position.Left} className="!bg-indigo-400" />
      <div className="px-2 py-1">
        <div className="flex items-center justify-between">
          <span className="font-medium text-slate-900 truncate" title={name}>
            {name}
          </span>
          <span className="text-xs font-mono text-indigo-700">if</span>
        </div>
        <div
          className="text-[11px] font-mono text-slate-600 truncate"
          title={condSummary}
        >
          {condSummary}
        </div>
      </div>
      {bands.map((b) => (
        <div
          key={b.label}
          className="absolute left-0 right-0 px-2 text-[10px] font-semibold uppercase tracking-wide text-indigo-600 pointer-events-none"
          style={{ top: b.y }}
        >
          {b.label}
        </div>
      ))}
      <Handle type="source" position={Position.Right} className="!bg-indigo-400" />
    </div>
  );
}

export const IfStepNode = memo(IfStepNodeImpl);
```

- [ ] **Step 8: Write a failing CanvasView render test** — append to `ui/src/components/scenario/__tests__/CanvasView.test.tsx`. (Reuse the file's existing `reset` helper.)

```ts
describe("CanvasView if node", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: "branch"
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000011"
        name: "ok"
        type: http
        request:
          method: GET
          url: "/ok"
        assert:
          - status: 200
`);
  });

  it("renders an if container with its condition summary and a THEN band", () => {
    render(<CanvasView />);
    expect(screen.getByText("branch")).toBeInTheDocument();
    expect(screen.getByText("THEN")).toBeInTheDocument();
    expect(screen.getByText(/\{\{code\}\} eq 200/)).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument(); // inner http child node
  });
});
```

- [ ] **Step 9: Run the CanvasView test to confirm it fails**

Run: `cd ui && pnpm test -- CanvasView`
Expected: FAIL — `if` not in `NODE_TYPES`, no band/summary rendered (and `tsc`-level union error if run via build).

- [ ] **Step 10: Wire if-rendering into `CanvasView.tsx`.** Add imports, constants, the `NODE_TYPES.if` entry, a `summarizeCondition` helper, and the `else if (isIfStep(step))` layout branch.

Update imports at the top:

```ts
import { IfStepNode, type IfStepNodeData } from "./IfStepNode";
import { isLoopStep, isIfStep, type Condition, type HttpStep } from "../../scenario/model";
```

(Replace the existing `import { isLoopStep } from "../../scenario/model";` line.) Update `NODE_TYPES` and `AnyData`:

```ts
const NODE_TYPES = { http: HttpStepNode, loop: LoopStepNode, if: IfStepNode };
```

```ts
type AnyData = HttpStepNodeData | LoopStepNodeData | IfStepNodeData;
```

Add layout constants beside the loop ones:

```ts
const IF_HEADER_H = 44;
const BAND_LABEL_H = 18;
const BAND_PAD = 8;
```

Add the helper near the bottom of the file (module scope):

```ts
function summarizeCondition(c: Condition): string {
  if ("all" in c) return c.all.map(summarizeCondition).join(" AND ");
  if ("any" in c) return c.any.map(summarizeCondition).join(" OR ");
  const noRight = c.op === "exists" || c.op === "empty";
  return `${c.left || "?"} ${c.op}${noRight ? "" : ` ${c.right ?? ""}`}`;
}
```

In the `nodes` `useMemo`, insert an `else if (isIfStep(step))` branch **between** the `if (isLoopStep(step))` block and the final `else` (the http block), so the http `else` never sees an if step (which has no `.request`):

```ts
      } else if (isIfStep(step)) {
        const bands: Array<{ label: string; children: HttpStep[] }> = [
          { label: "THEN", children: step.then },
          ...step.elif.map((e, i) => ({ label: `ELIF ${i + 1}`, children: e.then })),
          ...(step.else.length > 0 ? [{ label: "ELSE", children: step.else }] : []),
        ];
        let yy = IF_HEADER_H;
        const bandMeta: Array<{ label: string; y: number }> = [];
        const childPlacements: Array<{ child: HttpStep; y: number }> = [];
        for (const band of bands) {
          bandMeta.push({ label: band.label, y: yy });
          yy += BAND_LABEL_H;
          for (const child of band.children) {
            childPlacements.push({ child, y: yy });
            yy += CHILD_H + CHILD_GAP;
          }
          yy += BAND_PAD;
        }
        out.push({
          id: step.id,
          type: "if",
          position: { x, y: 0 },
          data: {
            name: step.name,
            condSummary: summarizeCondition(step.cond),
            bands: bandMeta,
            selected: step.id === selectedStepId,
          },
          style: { width: NODE_WIDTH, height: yy },
          draggable: false,
          selectable: false,
        });
        for (const { child, y } of childPlacements) {
          out.push({
            id: child.id,
            type: "http",
            parentId: step.id,
            extent: "parent",
            position: { x: LOOP_PAD, y },
            data: {
              name: child.name,
              method: child.request.method,
              url: child.request.url,
              selected: child.id === selectedStepId,
            },
            style: { width: CHILD_WIDTH },
            draggable: false,
            selectable: false,
          });
        }
        x += NODE_WIDTH + NODE_GAP;
      } else {
```

(The trailing `} else {` replaces the existing `} else {` that opens the http block — i.e., the http block becomes the final `else`.)

- [ ] **Step 11: Run the CanvasView test to verify it passes**

Run: `cd ui && pnpm test -- CanvasView`
Expected: PASS.

- [ ] **Step 12: Write a failing Inspector route test** — append to `ui/src/components/scenario/__tests__/Inspector.test.tsx`:

```ts
const IF_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: "branch"
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000011"
        name: "ok"
        type: http
        request:
          method: GET
          url: "/ok"
        assert:
          - status: 200
`;

describe("Inspector — if route (stub)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(IF_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000010");
  });

  it("shows the If heading and the branch name", () => {
    render(<Inspector />);
    expect(screen.getByRole("heading", { name: "If" })).toBeInTheDocument();
    expect((screen.getByLabelText("Name") as HTMLInputElement) ?? null).toBeTruthy();
  });

  it("navigates to a then-branch step", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /ok — GET \/ok/i }));
    expect(useScenarioEditor.getState().selectedStepId).toBe(
      "01HX0000000000000000000011",
    );
  });
});
```

> Note: `getByLabelText("Name")` relies on the existing `Field` label wrapper. The branch-step button uses `title={\`${name} — ${method} ${url}\`}`; RTL matches accessible name from `title`.

- [ ] **Step 13: Run the Inspector test to confirm it fails**

Run: `cd ui && pnpm test -- Inspector`
Expected: FAIL — if step routed to `HttpStepInspector`, which throws/derefs `.request`.

- [ ] **Step 14: Add the if-route, `findStepSiblings` fix, and read-only `IfInspectorStub` to `Inspector.tsx`.**

Update the imports:

```ts
import type { Assertion, Extract, HttpMethod, HttpStep, IfStep, LoopStep, Step } from "../../scenario/model";
import { flattenHttpSteps, findStepSiblings, isLoopStep, isIfStep } from "../../scenario/model";
```

Change the top-level `Inspector` return to route the if case:

```ts
  if (isLoopStep(step)) return <LoopInspector step={step} />;
  if (isIfStep(step)) return <IfInspectorStub step={step} />;
  return <HttpStepInspector step={step} />;
```

In `HttpStepInspector`, replace the inline `siblings` `useMemo` body with the shared helper (a nested if-branch http step now clamps correctly):

```ts
  const siblings = useMemo<ReadonlyArray<Step>>(
    () => findStepSiblings(steps, step.id),
    [steps, step.id],
  );
```

Add the read-only stub component (full editor arrives in Task 5). Place it near `LoopInspector`:

```tsx
// Read-only stub: name editing + branch navigation. The recursive condition
// builder and per-branch mutation land in Task 5 (needs Task 3 store actions).
function IfInspectorStub({ step }: { step: IfStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const removeStep = useScenarioEditor((s) => s.removeStep);
  const select = useScenarioEditor((s) => s.select);

  const branches: Array<{ label: string; steps: ReadonlyArray<HttpStep> }> = [
    { label: "Then", steps: step.then },
    ...step.elif.map((e, i) => ({ label: `Elif ${i + 1}`, steps: e.then })),
    { label: "Else", steps: step.else },
  ];

  return (
    <aside aria-label="Inspector" className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">If</h3>
        <SmallButton
          onClick={() => removeStep(step.id)}
          label="Delete"
          title="Delete if"
          danger
        />
      </header>

      <Field label="Name">
        <input
          className="w-full border border-slate-300 rounded px-2 py-1"
          value={step.name}
          onChange={(e) => setStepField(step.id, ["name"], e.target.value || "Untitled")}
        />
      </Field>

      {branches.map((b) => (
        <div key={b.label}>
          <div className="text-xs font-semibold text-slate-600 mb-1">{b.label}</div>
          <ul className="flex flex-col gap-1">
            {b.steps.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  title={`${c.name} — ${c.request.method} ${c.request.url}`}
                  className="block w-full truncate text-left px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-100"
                  onClick={() => select(c.id)}
                >
                  <span className="font-medium">{c.name}</span>{" "}
                  <span className="font-mono text-slate-500">
                    {c.request.method} {c.request.url}
                  </span>
                </button>
              </li>
            ))}
            {b.steps.length === 0 && (
              <li className="text-xs text-slate-400 italic">No steps</li>
            )}
          </ul>
        </div>
      ))}
    </aside>
  );
}
```

- [ ] **Step 15: Run the Inspector test to verify it passes**

Run: `cd ui && pnpm test -- Inspector`
Expected: PASS.

- [ ] **Step 16: Full build gate** (this is the union-flip checkpoint — confirm every consumer compiles)

Run: `cd ui && pnpm test && pnpm build`
Expected: all tests PASS, `tsc -b && vite build` succeeds.
**If `tsc` complains** that the narrowed `IfStep` from the union has `elif`/`else` typed `... | undefined` (the Zod nested-`.default()` input-leak gotcha — ui/CLAUDE.md), the fix is local: keep `IfStep = z.infer<typeof IfStepModel>` and add an explicit annotation/cast at the one consumer boundary that errors (do **not** drop the `.default([])`, which authors rely on). Re-run the gate.

- [ ] **Step 17: Commit**

```bash
git add ui/src/scenario/model.ts ui/src/scenario/yamlDoc.ts \
  ui/src/components/scenario/IfStepNode.tsx \
  ui/src/components/scenario/CanvasView.tsx \
  ui/src/components/scenario/Inspector.tsx \
  ui/src/scenario/__tests__/model.test.ts \
  ui/src/components/scenario/__tests__/CanvasView.test.tsx \
  ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): if-node Zod model + canvas render + inspector route (9b)"
```

---

### Task 2: `yamlDoc.ts` — if-node Edit variants (`applyEdit`)

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts`
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts`

This task is purely additive to `applyEdit` — no consumer breaks, build stays green throughout.

- [ ] **Step 1: Write failing edit tests** — append to `ui/src/scenario/__tests__/yamlDoc.test.ts`:

```ts
const IF_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: "branch"
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000011"
        name: "ok"
        type: http
        request:
          method: GET
          url: "/ok"
        assert:
          - status: 200
`;

const EMPTY_YAML = `version: 1
name: x
cookie_jar: auto
variables: {}
steps: []
`;

describe("applyEdit — if node", () => {
  it("addIfStep appends a valid if with a seeded then child", () => {
    const out = parseScenarioDoc(EMPTY_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addIfStep",
      id: "01HX0000000000000000000010",
      name: "branch",
      childId: "01HX0000000000000000000011",
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    expect(s.type).toBe("if");
    if (s.type === "if") expect(s.then).toHaveLength(1);
  });

  it("setIfCond replaces the condition tree and drops the old right", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "setIfCond",
      ifId: "01HX0000000000000000000010",
      cond: { all: [
        { left: "{{a}}", op: "eq", right: "1" },
        { left: "{{b}}", op: "exists" },
      ] },
    });
    const txt = serializeDoc(out.doc);
    expect(txt).toContain("all:");
    const re = parseScenarioDoc(txt);
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if") expect("all" in s.cond).toBe(true);
  });

  it("setIfCond omits right for exists/empty ops", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "setIfCond",
      ifId: "01HX0000000000000000000010",
      cond: { left: "{{t}}", op: "exists", right: "ignored" },
    });
    expect(serializeDoc(out.doc)).not.toContain("right:");
  });

  it("addStepInBranch fills then / else / an elif branch", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addStepInBranch", ifId: "01HX0000000000000000000010",
      branch: { kind: "else" }, id: "01HX0000000000000000000020", name: "e1",
    });
    applyEdit(out.doc, {
      type: "addElif", ifId: "01HX0000000000000000000010",
      childId: "01HX0000000000000000000021",
    });
    applyEdit(out.doc, {
      type: "addStepInBranch", ifId: "01HX0000000000000000000010",
      branch: { kind: "elif", index: 0 }, id: "01HX0000000000000000000022", name: "e2",
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if") {
      expect(s.else).toHaveLength(1);
      expect(s.elif[0].then).toHaveLength(2); // seeded child + added
    }
  });

  it("setElifCond updates only the targeted elif condition", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addElif", ifId: "01HX0000000000000000000010",
      childId: "01HX0000000000000000000021",
    });
    applyEdit(out.doc, {
      type: "setElifCond", ifId: "01HX0000000000000000000010", index: 0,
      cond: { left: "{{code}}", op: "eq", right: "404" },
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if" && !("all" in s.elif[0].cond) && !("any" in s.elif[0].cond)) {
      expect(s.elif[0].cond.right).toBe("404");
    } else throw new Error("expected compare elif cond");
  });

  it("removeElif drops the branch", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addElif", ifId: "01HX0000000000000000000010",
      childId: "01HX0000000000000000000021",
    });
    applyEdit(out.doc, {
      type: "removeElif", ifId: "01HX0000000000000000000010", index: 0,
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if") expect(s.elif).toHaveLength(0);
  });

  it("removeStep deletes a step nested in an else branch (findStepPath recursion)", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addStepInBranch", ifId: "01HX0000000000000000000010",
      branch: { kind: "else" }, id: "01HX0000000000000000000020", name: "e1",
    });
    applyEdit(out.doc, {
      type: "addStepInBranch", ifId: "01HX0000000000000000000010",
      branch: { kind: "else" }, id: "01HX0000000000000000000021", name: "e2",
    });
    applyEdit(out.doc, { type: "removeStep", stepId: "01HX0000000000000000000020" });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if") expect(s.else.map((c) => c.id)).toEqual(["01HX0000000000000000000021"]);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd ui && pnpm test -- yamlDoc`
Expected: FAIL — `addIfStep`/`setIfCond`/etc. are not valid `Edit` types (TS errors at esbuild are surfaced as test failures because the new edit objects don't match `Edit`).

- [ ] **Step 3: Add the `BranchSel` type and import `Condition`.** At the top of `yamlDoc.ts`, extend the model import and export `BranchSel`:

```ts
import { ScenarioModel, type Scenario, type Condition } from "./model";
```

```ts
export type BranchSel =
  | { kind: "then" }
  | { kind: "else" }
  | { kind: "elif"; index: number };
```

- [ ] **Step 4: Extend the `Edit` union.** Add these variants to the `export type Edit = ...` union (e.g., after `setLoopRepeat`):

```ts
  | { type: "addIfStep"; id: string; name: string; childId: string }
  | { type: "setIfCond"; ifId: string; cond: Condition }
  | { type: "setElifCond"; ifId: string; index: number; cond: Condition }
  | { type: "addStepInBranch"; ifId: string; branch: BranchSel; id: string; name: string }
  | { type: "addElif"; ifId: string; childId: string }
  | { type: "removeElif"; ifId: string; index: number }
```

- [ ] **Step 5: Add the `applyEdit` cases.** Insert these cases into the `switch (edit.type)` in `applyEdit`, before the final closing brace:

```ts
    case "addIfStep": {
      ensureSeq(doc, ["steps"]);
      const steps = doc.getIn(["steps"]) as YAMLSeq;
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
      steps.add(node);
      return;
    }
    case "setIfCond": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      doc.setIn([...ifPath, "cond"], doc.createNode(cleanCond(edit.cond)));
      return;
    }
    case "setElifCond": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      doc.setIn(
        [...ifPath, "elif", edit.index, "cond"],
        doc.createNode(cleanCond(edit.cond)),
      );
      return;
    }
    case "addStepInBranch": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      const bp = branchPath(edit.branch);
      ensureSeq(doc, [...ifPath, ...bp]);
      const body = doc.getIn([...ifPath, ...bp]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id,
        name: edit.name,
        type: "http",
        request: { method: "GET", url: "/" },
        assert: [{ status: 200 }],
      });
      body.add(node);
      return;
    }
    case "addElif": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      ensureSeq(doc, [...ifPath, "elif"]);
      const elif = doc.getIn([...ifPath, "elif"]) as YAMLSeq;
      const node = doc.createNode({
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
      elif.add(node);
      return;
    }
    case "removeElif": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      doc.deleteIn([...ifPath, "elif", edit.index]);
      return;
    }
```

- [ ] **Step 6: Add the `branchPath` and `cleanCond` helpers** (module scope, near `plainScalar`):

```ts
function branchPath(branch: BranchSel): Array<string | number> {
  if (branch.kind === "then") return ["then"];
  if (branch.kind === "else") return ["else"];
  return ["elif", branch.index, "then"];
}

// Build a plain JS condition tree for doc.createNode, omitting `right` for the
// `exists`/`empty` ops (the engine serializes Compare without it for those) and
// keeping `right: ""` visible for the other ops so the field stays editable.
function cleanCond(c: Condition): unknown {
  if ("all" in c) return { all: c.all.map(cleanCond) };
  if ("any" in c) return { any: c.any.map(cleanCond) };
  const out: Record<string, unknown> = { left: c.left, op: c.op };
  if (c.op !== "exists" && c.op !== "empty") out.right = c.right ?? "";
  return out;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ui && pnpm test -- yamlDoc`
Expected: PASS.

- [ ] **Step 8: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 9: Commit**

```bash
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git commit -m "feat(ui): if-node yaml Document edits (add/setCond/branch/elif) (9b)"
```

---

### Task 3: `store.ts` — if-node actions

**Files:**
- Modify: `ui/src/scenario/store.ts`
- Test: `ui/src/scenario/__tests__/store.test.ts`

- [ ] **Step 1: Write failing store tests** — append to `ui/src/scenario/__tests__/store.test.ts`:

```ts
describe("useScenarioEditor — if actions", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(VALID_YAML);
  });

  it("addIfStep appends an if step and returns its id", () => {
    const id = useScenarioEditor.getState().addIfStep("Branch");
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    expect(step?.type).toBe("if");
  });

  it("setIfCond replaces the condition", () => {
    const id = useScenarioEditor.getState().addIfStep("Branch");
    useScenarioEditor.getState().setIfCond(id, { left: "{{x}}", op: "eq", right: "1" });
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    if (step?.type === "if") expect(step.cond).toEqual({ left: "{{x}}", op: "eq", right: "1" });
    else throw new Error("expected if step");
  });

  it("addStepInBranch adds an http step to else and returns its id", () => {
    const id = useScenarioEditor.getState().addIfStep("Branch");
    const childId = useScenarioEditor.getState().addStepInBranch(id, { kind: "else" }, "E");
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    if (step?.type === "if") {
      expect(step.else).toHaveLength(1);
      expect(step.else[0].id).toBe(childId);
    } else throw new Error("expected if step");
  });

  it("addElif then setElifCond then removeElif", () => {
    const id = useScenarioEditor.getState().addIfStep("Branch");
    useScenarioEditor.getState().addElif(id);
    useScenarioEditor.getState().setElifCond(id, 0, { left: "{{c}}", op: "eq", right: "2" });
    let step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    if (step?.type === "if") {
      expect(step.elif).toHaveLength(1);
      const ec = step.elif[0].cond;
      if (!("all" in ec) && !("any" in ec)) expect(ec.right).toBe("2");
    } else throw new Error("expected if step");
    useScenarioEditor.getState().removeElif(id, 0);
    step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    if (step?.type === "if") expect(step.elif).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd ui && pnpm test -- store`
Expected: FAIL — `addIfStep` etc. are not functions on the store.

- [ ] **Step 3: Extend the store interface.** Import `BranchSel` and `Condition`, and add the action signatures to `ScenarioEditorState` (after `setLoopRepeat`):

```ts
import {
  applyEdit,
  parseScenarioDoc,
  serializeDoc,
  type Edit,
  type BranchSel,
} from "./yamlDoc";
import { type Extract, type Scenario, type Condition } from "./model";
```

```ts
  addIfStep(name: string): string; // returns new if id
  setIfCond(ifId: string, cond: Condition): void;
  setElifCond(ifId: string, index: number, cond: Condition): void;
  addStepInBranch(ifId: string, branch: BranchSel, name: string): string; // returns child id
  addElif(ifId: string): void;
  removeElif(ifId: string, index: number): void;
```

- [ ] **Step 4: Implement the actions** in the `create<...>` body (after `setLoopRepeat`):

```ts
  addIfStep(name) {
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addIfStep", id, name, childId });
    return id;
  },
  setIfCond(ifId, cond) {
    dispatch(set, get, { type: "setIfCond", ifId, cond });
  },
  setElifCond(ifId, index, cond) {
    dispatch(set, get, { type: "setElifCond", ifId, index, cond });
  },
  addStepInBranch(ifId, branch, name) {
    const id = newStepId();
    dispatch(set, get, { type: "addStepInBranch", ifId, branch, id, name });
    return id;
  },
  addElif(ifId) {
    const childId = newStepId();
    dispatch(set, get, { type: "addElif", ifId, childId });
  },
  removeElif(ifId, index) {
    dispatch(set, get, { type: "removeElif", ifId, index });
  },
```

- [ ] **Step 5: Register the actions in the `getInitialState` shim.** Add them to the `actions` object literal (so test resets keep the references):

```ts
    addIfStep: s.addIfStep,
    setIfCond: s.setIfCond,
    setElifCond: s.setElifCond,
    addStepInBranch: s.addStepInBranch,
    addElif: s.addElif,
    removeElif: s.removeElif,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ui && pnpm test -- store`
Expected: PASS.

- [ ] **Step 7: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 8: Commit**

```bash
git add ui/src/scenario/store.ts ui/src/scenario/__tests__/store.test.ts
git commit -m "feat(ui): if-node store actions (add/cond/branch/elif) (9b)"
```

---

### Task 4: CanvasView "+ Add if" button

**Files:**
- Modify: `ui/src/components/scenario/CanvasView.tsx`
- Test: `ui/src/components/scenario/__tests__/CanvasView.test.tsx`

Small task — wires the Task 3 `addIfStep` action to a toolbar button.

- [ ] **Step 1: Write a failing test** — append to the `describe("CanvasView if node", ...)` block in `CanvasView.test.tsx` (or add a sibling `it`). It needs an empty canvas, so use a local reset that starts empty:

```ts
describe("CanvasView add if", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("has an Add if button that creates an if step and selects it", async () => {
    const user = userEvent.setup();
    render(<CanvasView />);
    await user.click(screen.getByRole("button", { name: /add if/i }));
    const state = useScenarioEditor.getState();
    expect(state.model!.steps.some((s) => s.type === "if")).toBe(true);
    expect(state.selectedStepId).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd ui && pnpm test -- CanvasView`
Expected: FAIL — no "Add if" button.

- [ ] **Step 3: Add the action selector and button.** In `CanvasView`, add the selector alongside the others:

```ts
  const addIfStep = useScenarioEditor((s) => s.addIfStep);
```

Add the button after the existing "+ Add loop" button in the toolbar `<div className="flex gap-2 mt-3">`:

```tsx
        <button
          type="button"
          onClick={() => {
            const id = addIfStep(`If ${steps.length + 1}`);
            select(id);
          }}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
        >
          + Add if
        </button>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && pnpm test -- CanvasView`
Expected: PASS.

- [ ] **Step 5: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/__tests__/CanvasView.test.tsx
git commit -m "feat(ui): canvas + Add if button (9b)"
```

---

### Task 5: Inspector — full `IfInspector` (recursive condition builder + branch management)

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx`
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx`

Replaces the Task-1 read-only `IfInspectorStub` with the real editor: a recursive
`ConditionEditor` (commit-on-blur, immediate-commit on structural change — the
`ExtractEditor` pattern), per-branch `BranchPanel`s with "+ Add step", and add/remove
elif. The condition builder edits an immutable `Condition` draft by path.

- [ ] **Step 1: Write failing tests** — append to `Inspector.test.tsx` (reuses `IF_YAML` from the Task-1 block; if not in scope, redeclare it):

```ts
describe("Inspector — IfInspector (builder)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(IF_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000010");
  });

  it("renders the condition leaf with current values", () => {
    render(<Inspector />);
    expect((screen.getByLabelText("left") as HTMLInputElement).value).toBe("{{code}}");
    expect((screen.getByLabelText("op") as HTMLSelectElement).value).toBe("eq");
    expect((screen.getByLabelText("right") as HTMLInputElement).value).toBe("200");
  });

  it("commits a changed right value on blur", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const right = screen.getByLabelText("right");
    await user.clear(right);
    await user.type(right, "404");
    await user.tab();
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && !("all" in s.cond) && !("any" in s.cond)) {
      expect(s.cond.right).toBe("404");
    } else throw new Error("expected compare cond");
  });

  it("hides the right input and drops right when op is exists", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByLabelText("op"), "exists");
    expect(screen.queryByLabelText("right")).toBeNull();
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && !("all" in s.cond) && !("any" in s.cond)) {
      expect(s.cond.op).toBe("exists");
      expect(s.cond.right).toBeUndefined();
    } else throw new Error("expected compare cond");
  });

  it("warns on an invalid regex for the matches op", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByLabelText("op"), "matches");
    const right = screen.getByLabelText("right");
    await user.clear(right);
    await user.type(right, "[");
    await user.tab();
    expect(screen.getByText(/invalid regex/i)).toBeInTheDocument();
  });

  it("wraps a leaf in a group and adds a condition", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /wrap in group/i }));
    await user.click(screen.getByRole("button", { name: /\+ condition/i }));
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && "all" in s.cond) expect(s.cond.all).toHaveLength(2);
    else throw new Error("expected all group");
  });

  it("adds a step to the else branch", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /add step to else/i }));
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.else).toHaveLength(1);
    else throw new Error("expected if step");
  });

  it("adds then removes an elif branch", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /add elif/i }));
    let s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.elif).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /remove elif 1/i }));
    s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.elif).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd ui && pnpm test -- Inspector`
Expected: FAIL — the stub has no condition leaf inputs / add-step / elif controls.

- [ ] **Step 3 follows in the next plan section (implementation).**

- [ ] **Step 3: Replace the if-route and remove the stub.** In `Inspector.tsx`, update the imports and route, and add the path-edit helpers.

Update imports (add `CompareOp`, `Condition`, `BranchSel`):

```ts
import type {
  Assertion, Extract, HttpMethod, HttpStep, IfStep, LoopStep, Step,
  Condition, CompareOp,
} from "../../scenario/model";
import { flattenHttpSteps, findStepSiblings, isLoopStep, isIfStep } from "../../scenario/model";
import type { BranchSel } from "../../scenario/yamlDoc";
```

Change the route to point at the real component and delete `IfInspectorStub`:

```ts
  if (isIfStep(step)) return <IfInspector step={step} />;
```

Add module-scope helpers (near `BODY_KINDS`):

```ts
const OPS: CompareOp[] = [
  "eq", "ne", "contains", "matches", "lt", "gt", "lte", "gte", "exists", "empty",
];

const NEW_LEAF = (): Condition => ({ left: "", op: "eq", right: "" });

function isValidRegex(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

// Immutable edit of a condition tree by a path of child indices. Each path element
// indexes into the current group's all/any children array.
function setAtPath(node: Condition, path: number[], sub: Condition): Condition {
  if (path.length === 0) return sub;
  const key = "all" in node ? "all" : "any";
  const children = (node as { all?: Condition[]; any?: Condition[] })[key]!;
  const next = children.slice();
  next[path[0]] = setAtPath(next[path[0]], path.slice(1), sub);
  return { [key]: next } as Condition;
}

function removeAtPath(node: Condition, path: number[]): Condition {
  const key = "all" in node ? "all" : "any";
  const children = (node as { all?: Condition[]; any?: Condition[] })[key]!;
  if (path.length === 1) {
    return { [key]: children.filter((_, i) => i !== path[0]) } as Condition;
  }
  const next = children.slice();
  next[path[0]] = removeAtPath(next[path[0]], path.slice(1));
  return { [key]: next } as Condition;
}
```

- [ ] **Step 4: Add the `ConditionEditor` + recursive `ConditionNode`.** Place these near `LoopInspector`:

```tsx
function ConditionEditor({
  cond,
  onCommit,
}: {
  cond: Condition;
  onCommit: (c: Condition) => void;
}) {
  // Local draft tree (ExtractEditor F5 pattern): text inputs update the draft and
  // commit on blur; structural changes update + commit immediately.
  const [draft, setDraft] = useState<Condition>(cond);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Reset when the selected step's committed cond changes (ref change). Commits set
  // draft == cond first, so this is a no-op on self-commit and only resets on switch.
  useEffect(() => {
    setDraft(cond);
  }, [cond]);

  const editLocal = (path: number[], sub: Condition) =>
    setDraft((d) => setAtPath(d, path, sub));
  const editCommit = (path: number[], sub: Condition) => {
    const next = setAtPath(draftRef.current, path, sub);
    setDraft(next);
    onCommit(next);
  };
  const removeChild = (path: number[]) => {
    const next = removeAtPath(draftRef.current, path);
    setDraft(next);
    onCommit(next);
  };
  const commitText = () => onCommit(draftRef.current);

  const isGroup = "all" in draft || "any" in draft;

  return (
    <div className="flex flex-col gap-2">
      <ConditionNode
        value={draft}
        path={[]}
        editLocal={editLocal}
        editCommit={editCommit}
        removeChild={removeChild}
        commitText={commitText}
      />
      {!isGroup && (
        <button
          type="button"
          className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
          onClick={() => {
            const next: Condition = { all: [draftRef.current] };
            setDraft(next);
            onCommit(next);
          }}
        >
          Wrap in group
        </button>
      )}
    </div>
  );
}

function ConditionNode({
  value,
  path,
  editLocal,
  editCommit,
  removeChild,
  commitText,
}: {
  value: Condition;
  path: number[];
  editLocal: (path: number[], sub: Condition) => void;
  editCommit: (path: number[], sub: Condition) => void;
  removeChild: (path: number[]) => void;
  commitText: () => void;
}) {
  if ("all" in value || "any" in value) {
    const kind: "all" | "any" = "all" in value ? "all" : "any";
    const children = "all" in value ? value.all : (value as { any: Condition[] }).any;
    const wrap = (next: Condition[]): Condition =>
      kind === "all" ? { all: next } : { any: next };
    return (
      <div className="flex flex-col gap-2 border-l-2 border-indigo-200 pl-2">
        <select
          aria-label="group-kind"
          className="border border-slate-300 rounded px-2 py-1 text-xs w-32"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as "all" | "any";
            editCommit(path, (k === "all" ? { all: children } : { any: children }) as Condition);
          }}
        >
          <option value="all">ALL (AND)</option>
          <option value="any">ANY (OR)</option>
        </select>
        {children.map((c, i) => (
          <div key={i} className="flex gap-1 items-start">
            <ConditionNode
              value={c}
              path={[...path, i]}
              editLocal={editLocal}
              editCommit={editCommit}
              removeChild={removeChild}
              commitText={commitText}
            />
            <button
              type="button"
              aria-label="remove condition"
              className="text-slate-500 hover:text-red-600 shrink-0"
              onClick={() => removeChild([...path, i])}
            >
              ×
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <button
            type="button"
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
            onClick={() => editCommit(path, wrap([...children, NEW_LEAF()]))}
          >
            + condition
          </button>
          <button
            type="button"
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
            onClick={() => editCommit(path, wrap([...children, { all: [NEW_LEAF()] } as Condition]))}
          >
            + group
          </button>
        </div>
      </div>
    );
  }

  const leaf = value as { left: string; op: CompareOp; right?: string };
  const noRight = leaf.op === "exists" || leaf.op === "empty";
  const regexBad = leaf.op === "matches" && !isValidRegex(leaf.right ?? "");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1 items-center">
        <input
          aria-label="left"
          placeholder="left"
          className="border border-slate-300 rounded px-2 py-1 font-mono text-xs w-28 min-w-0"
          value={leaf.left}
          onChange={(e) => editLocal(path, { ...leaf, left: e.target.value })}
          onBlur={commitText}
        />
        <select
          aria-label="op"
          className="border border-slate-300 rounded px-2 py-1 text-xs"
          value={leaf.op}
          onChange={(e) => {
            const op = e.target.value as CompareOp;
            const next: Condition =
              op === "exists" || op === "empty"
                ? { left: leaf.left, op }
                : { left: leaf.left, op, right: leaf.right ?? "" };
            editCommit(path, next);
          }}
        >
          {OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {!noRight && (
          <input
            aria-label="right"
            placeholder="right"
            className="border border-slate-300 rounded px-2 py-1 font-mono text-xs w-28 min-w-0"
            value={leaf.right ?? ""}
            onChange={(e) => editLocal(path, { ...leaf, right: e.target.value })}
            onBlur={commitText}
          />
        )}
      </div>
      {regexBad && <span className="text-[11px] text-amber-600">⚠ invalid regex</span>}
    </div>
  );
}
```

> **Required import change:** `Inspector.tsx` line 1 is `import { useEffect, useMemo, useState } from "react";` — it does NOT import `useRef`, which `ConditionEditor` needs. Change it to `import { useEffect, useMemo, useRef, useState } from "react";`.
>
> **Why "+ group" seeds a leaf (`{ all: [NEW_LEAF()] }`, not `{ all: [] }`):** the UI must never author an empty group — spec §3.2 ("UI는 빈 그룹을 만들지 못하게 막지만 엔진 의미는 위로 고정"). An empty `all` evaluates vacuous-true in the engine (`condition.rs`) and renders as a blank summary, so a stray click would silently flip branch semantics. Seeding one leaf keeps every authored group non-empty and visible.

- [ ] **Step 5: Add the `BranchPanel` and the full `IfInspector`.** Place after `ConditionNode`:

```tsx
function BranchPanel({
  label,
  branch,
  steps,
  ifId,
}: {
  label: string;
  branch: BranchSel;
  steps: ReadonlyArray<HttpStep>;
  ifId: string;
}) {
  const addStepInBranch = useScenarioEditor((s) => s.addStepInBranch);
  const select = useScenarioEditor((s) => s.select);
  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 mb-1">{label}</div>
      <ul className="flex flex-col gap-1">
        {steps.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              title={`${c.name} — ${c.request.method} ${c.request.url}`}
              className="block w-full truncate text-left px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-100"
              onClick={() => select(c.id)}
            >
              <span className="font-medium">{c.name}</span>{" "}
              <span className="font-mono text-slate-500">
                {c.request.method} {c.request.url}
              </span>
            </button>
          </li>
        ))}
        {steps.length === 0 && (
          <li className="text-xs text-slate-400 italic">No steps</li>
        )}
      </ul>
      <button
        type="button"
        aria-label={`Add step to ${label}`}
        className="mt-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
        onClick={() => {
          const id = addStepInBranch(ifId, branch, "Step");
          select(id);
        }}
      >
        + Add step
      </button>
    </div>
  );
}

function IfInspector({ step }: { step: IfStep }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const setIfCond = useScenarioEditor((s) => s.setIfCond);
  const setElifCond = useScenarioEditor((s) => s.setElifCond);
  const addElif = useScenarioEditor((s) => s.addElif);
  const removeElif = useScenarioEditor((s) => s.removeElif);
  const removeStep = useScenarioEditor((s) => s.removeStep);

  return (
    <aside aria-label="Inspector" className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">If</h3>
        <SmallButton
          onClick={() => removeStep(step.id)}
          label="Delete"
          title="Delete if"
          danger
        />
      </header>

      <Field label="Name">
        <input
          className="w-full border border-slate-300 rounded px-2 py-1"
          value={step.name}
          onChange={(e) => setStepField(step.id, ["name"], e.target.value || "Untitled")}
        />
      </Field>

      <fieldset
        className="flex flex-col gap-2 border border-slate-200 rounded p-3"
        aria-label="Condition"
      >
        <legend className="px-1 text-xs font-semibold text-slate-600">Condition</legend>
        <ConditionEditor cond={step.cond} onCommit={(c) => setIfCond(step.id, c)} />
      </fieldset>

      <BranchPanel label="Then" branch={{ kind: "then" }} steps={step.then} ifId={step.id} />

      {step.elif.map((e, i) => (
        <fieldset key={i} className="flex flex-col gap-2 border border-slate-200 rounded p-3">
          <legend className="px-1 text-xs font-semibold text-slate-600 flex items-center gap-2">
            <span>Elif {i + 1}</span>
            <button
              type="button"
              aria-label={`Remove elif ${i + 1}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => removeElif(step.id, i)}
            >
              ×
            </button>
          </legend>
          <ConditionEditor cond={e.cond} onCommit={(c) => setElifCond(step.id, i, c)} />
          <BranchPanel
            label={`Elif ${i + 1}`}
            branch={{ kind: "elif", index: i }}
            steps={e.then}
            ifId={step.id}
          />
        </fieldset>
      ))}

      <button
        type="button"
        className="self-start px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
        onClick={() => addElif(step.id)}
      >
        + Add elif
      </button>

      <BranchPanel label="Else" branch={{ kind: "else" }} steps={step.else} ifId={step.id} />
    </aside>
  );
}
```

> The "Add step to Elif N" buttons collide on the `aria-label` if two elifs exist; for 9b the tests only assert on Then/Else, so this is acceptable. If you later need per-elif disambiguation, suffix the index into the BranchPanel label (already `Elif N`).

- [ ] **Step 6: Run the Inspector tests to verify they pass**

Run: `cd ui && pnpm test -- Inspector`
Expected: PASS (all if-builder cases).

- [ ] **Step 7: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds. (If `tsc` flags the `{ [key]: ... } as Condition` computed-key casts, they are already cast — re-check you copied the `as Condition` assertions.)

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): if-node inspector — recursive condition builder + branches (9b)"
```

---

### Task 6: scanFlowVars branch coverage + round-trip property test

**Files:**
- Test: `ui/src/scenario/__tests__/scanVars.test.ts`
- Test: `ui/src/scenario/__tests__/proptests.test.ts`
- (no production change — `scanFlowVars` already reuses `flattenHttpSteps`, which Task 1 taught to walk branches)

- [ ] **Step 1: Write the scanVars branch test** — append to `scanVars.test.ts`:

```ts
it("scans {{vars}} inside if-branch http steps (via flattenHttpSteps)", () => {
  const s = ScenarioModel.parse({
    version: 1,
    name: "x",
    cookie_jar: "auto",
    variables: {},
    steps: [
      {
        id: "01HX0000000000000000000010",
        name: "b",
        type: "if",
        // NOTE: condition operands ({{code}}) are intentionally NOT scanned in 9b —
        // only branch http steps are. Condition vars are typically extract-derived.
        cond: { left: "{{code}}", op: "eq", right: "200" },
        then: [
          { id: "01HX0000000000000000000011", name: "t", type: "http",
            request: { method: "GET", url: "/{{path}}", headers: { "X-Tok": "{{tok}}" } },
            assert: [], extract: [] },
        ],
        else: [
          { id: "01HX0000000000000000000012", name: "e", type: "http",
            request: { method: "GET", url: "/{{other}}", headers: {} },
            assert: [], extract: [] },
        ],
      },
    ],
  });
  expect([...scanFlowVars(s)].sort()).toEqual(["other", "path", "tok"]);
});
```

> `scanVars.test.ts` line 2 is `import type { Scenario } from "../model";` — a **type-only** import. You cannot add the value `ScenarioModel` to it. Add a separate line: `import { ScenarioModel } from "../model";`.

- [ ] **Step 2: Run it to confirm it passes** (production already supports this from Task 1)

Run: `cd ui && pnpm test -- scanVars`
Expected: PASS. (If it FAILS with `code` present, Task 1's `flattenHttpSteps` walk is wrong; if it FAILS with branch vars missing, the walk isn't reaching `else`.)

- [ ] **Step 3: Extend the round-trip property test** — in `proptests.test.ts`, add condition/if arbitraries and feed them into `scenarioArb` + the canonical YAML builder.

Add the type imports (extend the existing `import { ... } from "../model"`):

```ts
import {
  type Condition,
  type IfStep,
  // existing: Extract, HttpStep, LoopStep, Scenario, Step
} from "../model";
```

Add the arbitraries after `loopStepArb`:

```ts
const leafWithRight: fc.Arbitrary<Condition> = fc.record({
  left: ident.map((v) => `{{${v}}}`),
  op: fc.constantFrom(
    "eq" as const, "ne" as const, "contains" as const, "matches" as const,
    "lt" as const, "gt" as const, "lte" as const, "gte" as const,
  ),
  right: fc.stringMatching(/^[a-z0-9]{1,8}$/),
});
const leafNoRight: fc.Arbitrary<Condition> = fc.record({
  left: ident.map((v) => `{{${v}}}`),
  op: fc.constantFrom("exists" as const, "empty" as const),
});
const leafArb: fc.Arbitrary<Condition> = fc.oneof(leafWithRight, leafNoRight);
const conditionArb: fc.Arbitrary<Condition> = fc.oneof(
  { weight: 3, arbitrary: leafArb },
  { weight: 1, arbitrary: fc.record({ all: fc.array(leafArb, { minLength: 1, maxLength: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ any: fc.array(leafArb, { minLength: 1, maxLength: 2 }) }) },
);

const ifStepArb: fc.Arbitrary<IfStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("if" as const),
  cond: conditionArb,
  then: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }),
  elif: fc.array(
    fc.record({ cond: conditionArb, then: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }) }),
    { maxLength: 2 },
  ),
  else: fc.array(httpStepArb, { maxLength: 2 }),
});
```

Update `stepArb` to include if (top-level only — branches stay http-only):

```ts
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: httpStepArb },
  { weight: 1, arbitrary: loopStepArb },
  { weight: 1, arbitrary: ifStepArb },
);
```

Add canonical-YAML builders and wire them into `stepToYaml`:

```ts
function condToYaml(c: Condition): Record<string, unknown> {
  if ("all" in c) return { all: c.all.map(condToYaml) };
  if ("any" in c) return { any: c.any.map(condToYaml) };
  const out: Record<string, unknown> = { left: c.left, op: c.op };
  if (c.op !== "exists" && c.op !== "empty") out.right = c.right;
  return out;
}

function ifStepToYaml(st: IfStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: st.id,
    name: st.name,
    type: st.type,
    cond: condToYaml(st.cond),
    then: st.then.map(httpStepToYaml),
  };
  if (st.elif.length > 0) {
    out.elif = st.elif.map((e) => ({ cond: condToYaml(e.cond), then: e.then.map(httpStepToYaml) }));
  }
  if (st.else.length > 0) out.else = st.else.map(httpStepToYaml);
  return out;
}
```

Replace `stepToYaml`:

```ts
function stepToYaml(st: Step): Record<string, unknown> {
  if (st.type === "loop") return loopStepToYaml(st);
  if (st.type === "if") return ifStepToYaml(st);
  return httpStepToYaml(st);
}
```

- [ ] **Step 4: Run the property test**

Run: `cd ui && pnpm test -- proptests`
Expected: PASS (40 runs). If it shrinks to a failing case, inspect the printed YAML — the most likely culprit is an all-digit `right` that `yaml.stringify` should auto-quote; confirm `scenarioToCanonicalYaml` uses `yamlStringify` (it does) so the string stays quoted.

- [ ] **Step 5: Full build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: all PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/scenario/__tests__/scanVars.test.ts ui/src/scenario/__tests__/proptests.test.ts
git commit -m "test(ui): if-branch scanFlowVars + condition/if round-trip property (9b)"
```

---

### Task 7: Docs — spec status, CLAUDE.md gotchas, roadmap/memory

**Files:**
- Modify: `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md` (status line)
- Modify: `CLAUDE.md` (root — status line + Slice 9 result line)
- Modify: `ui/CLAUDE.md` (new 9b gotchas)
- Modify: `docs/roadmap.md` (if it tracks slice status) and the auto-memory index pointer

This is a docs-only commit, so the pre-commit hook skips all `cargo` checks (root CLAUDE.md). No `pnpm` needed.

- [ ] **Step 1: Update the spec status.** In the spec's line 3 status, mark 9b done:

```
* Status: In progress (9a engine + 9b UI authoring 구현·머지 완료 — ADR-0023; 9c 중첩 / 9d 메트릭 미구현)
```

- [ ] **Step 2: Add the Slice 9b result line to the root `CLAUDE.md`.** After the Slice 9a status sentence (near the top status paragraph), add a one-paragraph 9b result summarizing: Zod `ConditionModel` (z.lazy union) + `IfStepModel` + discriminatedUnion 3rd variant; canvas if-container (THEN/ELIF/ELSE bands) + recursive condition builder inspector; yaml Document edits + recursive `findStepPath`; branches http-only; controller/proto/metrics unchanged (branch metrics = 9d). Bump the headline state line if it tracks the current slice.

- [ ] **Step 3: Add 9b gotchas to `ui/CLAUDE.md`.** Append entries capturing what this slice taught (each tagged `(Slice 9b)`):
  - `ConditionModel` is the model's **first `z.lazy`** — recursive `z.union` (NOT discriminatedUnion: the three shapes share no discriminant key, distinguished by `left`/`all`/`any` presence), must carry an explicit `z.ZodType<Condition>` annotation or `tsc` infers `any`.
  - `then`/`else` are valid object keys; `.then` as an **array** is not a thenable (safe), but never destructure `else` as a binding — use member access.
  - `IfStepModel.elif`/`else` use `.default([])`; watch the nested-default input-leak at the discriminatedUnion narrowing boundary (the Slice-4 gotcha) — caught only by `pnpm build`.
  - `right` must be **omitted** for `exists`/`empty` (engine drops it) — `cleanCond` in `yamlDoc.ts` enforces it before `createNode`.
  - Recursive condition builder uses the `ExtractEditor` commit pattern over an **immutable tree edited by index-path** (`setAtPath`/`removeAtPath`); text inputs commit on blur via a `draftRef`, structural changes commit immediately.
  - `findStepPath` is now fully recursive (loop `do` + if branches) — future-proofs 9c; `flattenHttpSteps` stays non-recursive for the if case until 9c (spec SF-1).

- [ ] **Step 4: Update `docs/roadmap.md` and the auto-memory index** to reflect 9b merged, next = 9c (nesting) then 9d (metrics). (Auto-memory: update `mvp1-roadmap.md` one-liner in `MEMORY.md` per the memory protocol — current session, optional but keeps the index honest.)

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md CLAUDE.md ui/CLAUDE.md docs/roadmap.md
git commit -m "docs: Slice 9b UI conditional authoring — status + gotchas (9b)"
```

---

## Self-Review (run after implementation)

**Spec coverage (§8 9b checklist):**
- ✅ Zod `ConditionModel` (z.lazy recursive) + `IfStepModel` + elif → Task 1.
- ✅ `StepModel` discriminatedUnion adds if → Task 1.
- ✅ `flattenHttpSteps` walks if branches (non-recursive, http-only) → Task 1.
- ✅ Canvas if container (vertical stacked zones) → Task 1 (render) + Task 4 (add button).
- ✅ Inspector recursive condition builder → Task 5.
- ✅ Bidirectional sync (condition/branch edits) → Task 2 (edits) + Task 3 (store) + Task 5 (UI).
- ✅ `scanFlowVars` if extension → Task 1 (`flattenHttpSteps` reuse) + Task 6 (test).
- ✅ Branches http-only → Task 1 Zod (`z.array(HttpStepModel)`).
- ✅ Tests: RTL (builder tree + canvas render), fast-check YAML round-trip, `pnpm build` gate → Tasks 1/4/5/6.
- ✅ `matches` op `new RegExp` authoring smoke check (spec §3.3) → Task 5.

**Deliberate non-goals carried from spec §10 / §8:** nested containers (if-in-loop / loop-in-if) → 9c; branch metrics breakdown → 9d; condition-operand scanning in `scanFlowVars` (only branch http vars in 9b — documented in the Task 6 test).

**Known limitations (match loop behavior, not new bugs):** removing the last `then` child makes the model fail Zod (`then` min 1) → `dispatch` sets `yamlError` and keeps the prior model (same as `loop.do` min 1). Two elifs share the "Add step to Elif N" `aria-label` family; only Then/Else are asserted in tests. A freshly-added if (`addIfStep`) and a freshly-added elif/group seed a placeholder leaf (`{ left: "", op: "eq", right: "" }`) that renders as `? eq` in the canvas summary until the user fills `left` — expected, not a bug.

**Review-applied fixes (from spec-plan-review):** "+ group" seeds one leaf so the UI never authors an empty group (spec §3.2, engine vacuous-true); `useRef` added to the `Inspector.tsx` React import explicitly; Task-6 `scanVars` test gets a separate value import (`import { ScenarioModel }`, since the existing import is `import type`). New module edge `Inspector.tsx → yamlDoc.ts` (for `BranchSel`) is acyclic — verified.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-31-slice-9b-ui-conditional-node.md`.

Recommended: create the worktree (`superpowers:using-git-worktrees`; this repo needs `worktree.baseRef: head` — root CLAUDE.md) and execute subagent-driven (fresh subagent per task + two-stage review: spec-compliance → code-quality), since the tasks are sequential with clear checkpoints.
