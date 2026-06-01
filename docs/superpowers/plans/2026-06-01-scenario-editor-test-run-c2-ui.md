# Scenario Editor Test-Run — C-2 (UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Test run" feature to the scenario editor — a button that POSTs the current editor YAML buffer + merged env + `max_requests` to the already-merged `POST /api/test-runs`, and a collapsible `TestRunPanel` that renders the returned `ScenarioTrace` (per-request trace) inline, reusing the existing `<EnvironmentPicker>` + `resolveEnv`.

**Architecture:** Four thin layers, each its own task: (1) a Zod schema `ScenarioTraceSchema` mirroring the C-1 wire contract; (2) an `api.createTestRun` client method + `useTestRun` React Query mutation (no cache invalidation — ephemeral); (3) a pure presentational `TestRunPanel` that renders a `ScenarioTrace` (http rows, if decision rows, loop-index labels, unbound-var amber, truncated banner); (4) wiring into `ScenarioEditPage` (the buffer owner) — Test-run controls (`<EnvironmentPicker>` + `max_requests` input + button) + result panel. No backend changes (C-1 is merged).

**Tech Stack:** TypeScript, React, React Query v5, Zod, Tailwind, Vite. Tests: vitest + React Testing Library (jsdom), `fetch` stub (no MSW). Gate: `pnpm build` (`tsc -b && vite build`).

**Scope note:** This is the **C-2 UI** half of spec `docs/superpowers/specs/2026-06-01-scenario-editor-test-run-design.md` (§5, §7, §9 "C-2"). Backend (C-1) + the condition-unbound follow-up are merged to master (ADR-0026). Out of scope (spec §8/§10): response-driven extract authoring, manual var overrides, worker-path runner, sensitive-value masking, trace history.

**The wire contract (C-1, `crates/engine/src/trace.rs` — UI must match these JSON keys exactly):**
- `ScenarioTrace { ok: bool, total_ms: u64, steps: StepTrace[], final_vars: map<string,string>, truncated: bool, error: string|null }`
- `StepTrace { step_id: string, kind: "http"|"if", loop_index: number|null, branch: string|null, request: TracedRequest|null, response: TracedResponse|null, extracted: map<string,string>, unbound_vars: string[], error: string|null }`
- `TracedRequest { method: string, url: string, headers: map<string,string>, body: string|null }`
- `TracedResponse { status: number, latency_ms: number, headers: map<string,string>, set_cookies: string[], body: string, body_truncated: bool }`
- Serde emits all fields (no `skip_serializing_if`): `Option` → JSON `null` (always present), empty map → `{}`, empty vec → `[]`. So in Zod, `Option<T>` = `.nullable()` (NOT `.optional()`), and `extracted`/`unbound_vars` are **required** (always emitted) — making them required avoids the `ui/CLAUDE.md` Zod-default-leak gotcha.

**Pre-flight (run once before Task 1):**
```bash
cd /Users/sgj/develop/handicap/ui
pnpm install            # worktree may lack node_modules
pnpm test -- --run      # baseline green (note count)
pnpm build              # baseline green (tsc -b && vite build)
```

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `ui/src/api/schemas.ts` | Modify | Add `StepKindSchema`/`TracedRequestSchema`/`TracedResponseSchema`/`StepTraceSchema`/`ScenarioTraceSchema` + `z.infer` types. |
| `ui/src/api/__tests__/scenarioTrace.test.ts` | Create | Schema parse/round-trip + null/empty-default coverage. |
| `ui/src/api/client.ts` | Modify | Add `createTestRun` method to the `api` object. |
| `ui/src/api/hooks.ts` | Modify | Add `useTestRun()` mutation hook (no invalidation). |
| `ui/src/api/__tests__/useTestRun.test.tsx` | Create | Mutation posts correct body, parses response. |
| `ui/src/components/scenario/TestRunPanel.tsx` | Create | Presentational: render a `ScenarioTrace` (rows, badges, expand, banners). |
| `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx` | Create | Renders http/if/loop rows, unbound amber, truncated banner. |
| `ui/src/pages/ScenarioEditPage.tsx` | Modify | Test-run controls (`<EnvironmentPicker>` + `max_requests` + button) + `<TestRunPanel>` + `useTestRun` wiring. |
| `ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx` | Create | Click → POST payload (yaml+env+max_requests); render trace; 422 banner. |

**Constants:** `DEFAULT_MAX_REQUESTS = 50` (UI default, mirrors controller), input `min=1 max=10000`.

**TDD-guard note:** every UI task writes its **test file first** (a `__tests__/*` or `*.test.tsx` path the guard always allows), which also creates the pending test that unblocks the production `.ts`/`.tsx` edit. No keepalive needed (self-unblock, like C-1 Tasks 5/7).

**Process note:** `pnpm test` (esbuild) does NOT catch TS strict errors — **run `pnpm build` before each commit** (`ui/CLAUDE.md` gate). The pre-commit hook only runs cargo, not UI, so UI verification is manual.

---

## Task 1: `ScenarioTraceSchema` Zod schema + types

**Files:**
- Modify: `ui/src/api/schemas.ts`
- Create: `ui/src/api/__tests__/scenarioTrace.test.ts`

Mirror the C-1 wire contract. `Option<T>` → `.nullable()`; always-emitted collections (`extracted`/`unbound_vars`/`headers`/`set_cookies`/`steps`/`final_vars`) → required (no `.default()` — avoids the Zod-default-leak gotcha in `ui/CLAUDE.md`).

- [ ] **Step 1: Write the failing test** — create `ui/src/api/__tests__/scenarioTrace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ScenarioTraceSchema } from "../schemas";

const SAMPLE = {
  ok: false,
  total_ms: 12,
  truncated: true,
  error: null,
  final_vars: { token: "abc" },
  steps: [
    {
      step_id: "01HX0000000000000000000010",
      kind: "if",
      loop_index: null,
      branch: "then",
      request: null,
      response: null,
      extracted: {},
      unbound_vars: ["missing_cond"],
      error: null,
    },
    {
      step_id: "01HX0000000000000000000011",
      kind: "http",
      loop_index: 0,
      branch: null,
      request: {
        method: "GET",
        url: "http://x/ping",
        headers: { "x-token": "" },
        body: null,
      },
      response: {
        status: 201,
        latency_ms: 3,
        headers: { "x-trace": "yes" },
        set_cookies: ["sid=1"],
        body: "pong",
        body_truncated: false,
      },
      extracted: { id: "42" },
      unbound_vars: [],
      error: null,
    },
  ],
};

describe("ScenarioTraceSchema", () => {
  it("parses a full trace and infers fields", () => {
    const t = ScenarioTraceSchema.parse(SAMPLE);
    expect(t.ok).toBe(false);
    expect(t.truncated).toBe(true);
    expect(t.steps).toHaveLength(2);
    expect(t.steps[0].kind).toBe("if");
    expect(t.steps[0].branch).toBe("then");
    expect(t.steps[0].request).toBeNull();
    expect(t.steps[1].kind).toBe("http");
    expect(t.steps[1].loop_index).toBe(0);
    expect(t.steps[1].response?.status).toBe(201);
    expect(t.steps[1].extracted).toEqual({ id: "42" });
  });

  it("rejects an unknown kind", () => {
    const bad = { ...SAMPLE, steps: [{ ...SAMPLE.steps[1], kind: "loop" }] };
    expect(() => ScenarioTraceSchema.parse(bad)).toThrow();
  });

  it("requires always-emitted collection fields", () => {
    const missing = { ...SAMPLE, steps: [{ ...SAMPLE.steps[1] }] };
    // backend always emits these; a missing one is a contract violation -> throw.
    delete (missing.steps[0] as Record<string, unknown>).unbound_vars;
    expect(() => ScenarioTraceSchema.parse(missing)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && pnpm test -- --run scenarioTrace`
Expected: FAIL — `ScenarioTraceSchema` is not exported.

- [ ] **Step 3: Add the schemas** — in `ui/src/api/schemas.ts`, append (the file already imports `z` and defines `*Schema` + `z.infer` types in this exact style):

```ts
export const StepKindSchema = z.enum(["http", "if"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const TracedRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
});
export type TracedRequest = z.infer<typeof TracedRequestSchema>;

export const TracedResponseSchema = z.object({
  status: z.number().int(),
  latency_ms: z.number().int(),
  headers: z.record(z.string(), z.string()),
  set_cookies: z.array(z.string()),
  body: z.string(),
  body_truncated: z.boolean(),
});
export type TracedResponse = z.infer<typeof TracedResponseSchema>;

export const StepTraceSchema = z.object({
  step_id: z.string(),
  kind: StepKindSchema,
  loop_index: z.number().int().nullable(),
  branch: z.string().nullable(),
  request: TracedRequestSchema.nullable(),
  response: TracedResponseSchema.nullable(),
  extracted: z.record(z.string(), z.string()),
  unbound_vars: z.array(z.string()),
  error: z.string().nullable(),
});
export type StepTrace = z.infer<typeof StepTraceSchema>;

export const ScenarioTraceSchema = z.object({
  ok: z.boolean(),
  total_ms: z.number().int(),
  steps: z.array(StepTraceSchema),
  final_vars: z.record(z.string(), z.string()),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type ScenarioTrace = z.infer<typeof ScenarioTraceSchema>;
```

> NOTE: `z.record(z.string(), z.string())` = `Record<string,string>` (matches Rust `BTreeMap<String,String>`). Do NOT use `.default(...)` on `extracted`/`unbound_vars` — the backend always emits them, and `.default()` triggers the input-type-leak gotcha that only surfaces in `pnpm build`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && pnpm test -- --run scenarioTrace`
Expected: PASS (all 3).

- [ ] **Step 5: Type-check gate**

Run: `cd ui && pnpm build`
Expected: PASS — `tsc -b` clean (catches any `z.infer` strictness issue the esbuild test runner misses).

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/schemas.ts ui/src/api/__tests__/scenarioTrace.test.ts
git commit -m "feat(ui): ScenarioTrace Zod schema mirroring test-run wire contract (C-2)"
```

---

## Task 2: `api.createTestRun` + `useTestRun` mutation hook

**Files:**
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/api/hooks.ts`
- Create: `ui/src/api/__tests__/useTestRun.test.tsx`

`request<T>` is module-private; the public surface is the `api` object — add `createTestRun` there (same pattern as `createScenario`/`createRun`). The hook is a bare `useMutation` (ephemeral → no `invalidateQueries`).

- [ ] **Step 1: Write the failing test** — create `ui/src/api/__tests__/useTestRun.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestRun } from "../hooks";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const TRACE = {
  ok: true,
  total_ms: 5,
  truncated: false,
  error: null,
  final_vars: {},
  steps: [],
};

describe("useTestRun", () => {
  it("POSTs scenario_yaml + env + max_requests to /api/test-runs and parses the trace", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(TRACE)));
    const { result } = renderHook(() => useTestRun(), { wrapper });

    result.current.mutate({
      scenario_yaml: "version: 1\nname: s\nsteps: []\n",
      env: { BASE_URL: "http://x" },
      max_requests: 25,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/test-runs$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      scenario_yaml: "version: 1\nname: s\nsteps: []\n",
      env: { BASE_URL: "http://x" },
      max_requests: 25,
    });
  });

  it("surfaces a 422 as an error", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: "scenario parse: bad" }, 422)));
    const { result } = renderHook(() => useTestRun(), { wrapper });
    result.current.mutate({ scenario_yaml: "nonsense", env: {} });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && pnpm test -- --run useTestRun`
Expected: FAIL — `useTestRun` is not exported.

- [ ] **Step 3: Add the client method** — in `ui/src/api/client.ts`, import `ScenarioTraceSchema` (extend the existing `from "./schemas"` import) and add a method to the `api` object (place it near `createRun`/`createScenario`, matching their arrow-method style):

```ts
  createTestRun: (body: {
    scenario_yaml: string;
    env: Record<string, string>;
    max_requests?: number;
  }) =>
    request("/test-runs", { method: "POST", body: JSON.stringify(body) }, ScenarioTraceSchema),
```

> `request(path, init, parser)` prepends `/api`, sets `content-type: application/json`, throws `ApiError(status, message)` on non-2xx (the 422 path), and `parser.parse(JSON.parse(text))` on success. `ScenarioTrace` is the inferred return type — no extra typing needed.

- [ ] **Step 4: Add the hook** — in `ui/src/api/hooks.ts`, add (it already imports `useMutation` and `api`):

```ts
export function useTestRun() {
  return useMutation({
    mutationFn: (body: {
      scenario_yaml: string;
      env: Record<string, string>;
      max_requests?: number;
    }) => api.createTestRun(body),
  });
}
```

> No `useQueryClient`/`invalidateQueries` — test-runs are ephemeral (nothing persisted), so there is no cache to invalidate.

- [ ] **Step 5: Run to verify it passes**

Run: `cd ui && pnpm test -- --run useTestRun`
Expected: PASS (both).

- [ ] **Step 6: Type-check gate**

Run: `cd ui && pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/api/client.ts ui/src/api/hooks.ts ui/src/api/__tests__/useTestRun.test.tsx
git commit -m "feat(ui): api.createTestRun + useTestRun mutation (C-2)"
```

---

## Task 3: `TestRunPanel` presentational component

**Files:**
- Create: `ui/src/components/scenario/TestRunPanel.tsx`
- Create: `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx`

A pure function of a `ScenarioTrace` (no hooks, no fetch). Renders: a summary line (ok/error badge + `total_ms`), a truncated banner, then one row per `StepTrace` in order — http rows (method badge · resolved url · status badge · `latency_ms` · extracted chips · expandable request/response headers+body), if rows (branch label), loop children tagged `#index`, and an amber chip list for `unbound_vars`. Mirrors the Tailwind conventions of `StepStatsTable`/`StatusBadge`.

- [ ] **Step 1: Write the failing test** — create `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScenarioTrace } from "../../../api/schemas";
import { TestRunPanel } from "../TestRunPanel";

const TRACE: ScenarioTrace = {
  ok: false,
  total_ms: 42,
  truncated: true,
  error: null,
  final_vars: { token: "abc" },
  steps: [
    {
      step_id: "01HX0000000000000000000010",
      kind: "if",
      loop_index: null,
      branch: "none",
      request: null,
      response: null,
      extracted: {},
      unbound_vars: ["missing_cond"],
      error: null,
    },
    {
      step_id: "01HX0000000000000000000011",
      kind: "http",
      loop_index: 2,
      branch: null,
      request: { method: "GET", url: "http://api/ping", headers: { a: "1" }, body: null },
      response: {
        status: 500,
        latency_ms: 9,
        headers: {},
        set_cookies: [],
        body: "boom",
        body_truncated: false,
      },
      extracted: { id: "42" },
      unbound_vars: [],
      error: "status 500 != 200",
    },
  ],
};

describe("TestRunPanel", () => {
  it("renders the truncated banner and a per-step summary", () => {
    render(<TestRunPanel trace={TRACE} />);
    // truncated banner
    expect(screen.getByText(/상한 도달/)).toBeInTheDocument();
    // http row: method + url + status
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("http://api/ping")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    // if row: branch label (none -> "(미매치)")
    expect(screen.getByText(/\(미매치\)/)).toBeInTheDocument();
    // loop_index tag
    expect(screen.getByText("#2")).toBeInTheDocument();
    // unbound var amber chip
    expect(screen.getByText("missing_cond")).toBeInTheDocument();
    // extracted chip
    expect(screen.getByText(/id=42/)).toBeInTheDocument();
    // step error
    expect(screen.getByText(/status 500 != 200/)).toBeInTheDocument();
  });

  it("shows an ok summary when the trace succeeded and is not truncated", () => {
    render(
      <TestRunPanel trace={{ ...TRACE, ok: true, truncated: false, steps: [] }} />,
    );
    expect(screen.queryByText(/상한 도달/)).not.toBeInTheDocument();
    expect(screen.getByText(/OK/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && pnpm test -- --run TestRunPanel`
Expected: FAIL — cannot find `../TestRunPanel`.

- [ ] **Step 3: Implement the component** — create `ui/src/components/scenario/TestRunPanel.tsx`:

```tsx
import { useState } from "react";
import type { ScenarioTrace, StepTrace } from "../../api/schemas";

const BRANCH_LABEL: Record<string, string> = {
  none: "(미매치)",
  then: "then",
  else: "else",
};

function branchText(branch: string): string {
  if (BRANCH_LABEL[branch]) return BRANCH_LABEL[branch];
  const m = /^elif_(\d+)$/.exec(branch);
  return m ? `elif ${m[1]}` : branch;
}

function statusClass(status: number, error: string | null): string {
  if (error || status >= 400) return "bg-red-200 text-red-900";
  if (status >= 200 && status < 300) return "bg-emerald-200 text-emerald-900";
  return "bg-slate-200 text-slate-700";
}

function chip(text: string, cls: string) {
  return (
    <span key={text} className={["inline-block rounded px-2 py-0.5 text-xs font-medium", cls].join(" ")}>
      {text}
    </span>
  );
}

function HeaderTable({ title, rows }: { title: string; rows: [string, string][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <table className="min-w-full text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="py-0.5 pr-3 font-mono text-slate-600 align-top">{k}</td>
              <td className="py-0.5 font-mono break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HttpRow({ step }: { step: StepTrace }) {
  const [open, setOpen] = useState(false);
  const req = step.request;
  const resp = step.response;
  const extracted = Object.entries(step.extracted);
  return (
    <li className="border-b border-slate-100 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-2 text-left"
      >
        <span className="font-mono text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        {step.loop_index !== null && chip(`#${step.loop_index}`, "bg-slate-100 text-slate-600")}
        {chip(req?.method ?? "—", "bg-slate-800 text-white")}
        <span className="font-mono text-xs break-all">{req?.url ?? "(no request)"}</span>
        {resp && chip(String(resp.status), statusClass(resp.status, step.error))}
        {resp && <span className="text-xs text-slate-500">{resp.latency_ms}ms</span>}
        {extracted.map(([k, v]) => chip(`${k}=${v}`, "bg-indigo-100 text-indigo-800"))}
      </button>
      {step.error && <div className="mt-1 text-xs text-red-700">{step.error}</div>}
      {step.unbound_vars.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-xs text-amber-700">unbound:</span>
          {step.unbound_vars.map((v) => chip(v, "bg-amber-100 text-amber-800"))}
        </div>
      )}
      {open && (
        <div className="mt-2 rounded bg-slate-50 p-3">
          {req && (
            <>
              <HeaderTable title="Request headers" rows={Object.entries(req.headers)} />
              {req.body && (
                <pre className="mb-2 whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">{req.body}</pre>
              )}
            </>
          )}
          {resp && (
            <>
              <HeaderTable title="Response headers" rows={Object.entries(resp.headers)} />
              {resp.set_cookies.length > 0 && (
                <HeaderTable title="Set-Cookie" rows={resp.set_cookies.map((c, i) => [String(i), c])} />
              )}
              <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">
                {resp.body}
                {resp.body_truncated ? "\n… (truncated)" : ""}
              </pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function IfRow({ step }: { step: StepTrace }) {
  return (
    <li className="border-b border-slate-100 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {step.loop_index !== null && chip(`#${step.loop_index}`, "bg-slate-100 text-slate-600")}
        {chip("if", "bg-violet-200 text-violet-900")}
        <span className="text-xs text-slate-600">→</span>
        {chip(branchText(step.branch ?? "none"), "bg-violet-100 text-violet-800")}
        <span className="font-mono text-xs text-slate-400 break-all">{step.step_id}</span>
      </div>
      {step.unbound_vars.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-xs text-amber-700">조건 unbound:</span>
          {step.unbound_vars.map((v) => chip(v, "bg-amber-100 text-amber-800"))}
        </div>
      )}
    </li>
  );
}

export function TestRunPanel({ trace }: { trace: ScenarioTrace }) {
  return (
    <section aria-label="Test run result" className="rounded border border-slate-200 p-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold">Test run</h3>
        {chip(trace.ok ? "OK" : "FAIL", trace.ok ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900")}
        <span className="text-xs text-slate-500">{trace.total_ms}ms · {trace.steps.length} steps</span>
      </div>
      {trace.error && <div className="mb-2 text-sm text-red-700">{trace.error}</div>}
      {trace.truncated && (
        <div className="mb-2 rounded bg-amber-100 px-3 py-2 text-sm text-amber-800">
          상한 도달 — 일부만 실행됨 (max_requests 또는 시간 천장)
        </div>
      )}
      {trace.steps.length === 0 ? (
        <p className="text-sm text-slate-500">실행할 스텝이 없습니다.</p>
      ) : (
        <ul>
          {trace.steps.map((step, i) =>
            step.kind === "if" ? (
              <IfRow key={`${step.step_id}-${i}`} step={step} />
            ) : (
              <HttpRow key={`${step.step_id}-${i}`} step={step} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}
```

> `key` uses `${step_id}-${i}` because a step inside a loop appears multiple times with the same `step_id` (distinct `loop_index`), so `step_id` alone is not unique.

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && pnpm test -- --run TestRunPanel`
Expected: PASS (both). Fix the test's `});` closure if you copied the `};` typo noted in Step 1.

- [ ] **Step 5: Type-check gate**

Run: `cd ui && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/scenario/TestRunPanel.tsx ui/src/components/scenario/__tests__/TestRunPanel.test.tsx
git commit -m "feat(ui): TestRunPanel renders a ScenarioTrace (C-2)"
```

---

## Task 4: Wire Test-run into `ScenarioEditPage`

**Files:**
- Modify: `ui/src/pages/ScenarioEditPage.tsx`
- Create: `ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx`

Add the Test-run control area (reuse `<EnvironmentPicker>` exactly as `RunDialog` does + a `max_requests` number input + a "Test run" button) and render `<TestRunPanel>` from the `useTestRun` mutation result. The button sends the **current `yamlText` buffer** (works while dirty), the merged env (`resolveEnv(baseVars, overrides)`), and `max_requests`.

- [ ] **Step 1: Write the failing test** — create `ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioEditPage } from "../ScenarioEditPage";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SCENARIO = {
  id: "S1",
  name: "demo",
  yaml: "version: 1\nname: demo\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};
const TRACE = { ok: true, total_ms: 4, truncated: false, error: null, final_vars: {}, steps: [] };

// Route fetch by URL: scenario GET, environments list GET, test-run POST.
function routeFetch(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(SCENARIO);
  // listEnvironments parses EnvironmentListSchema = { environments: [...] } — a bare []
  // would fail .parse and error the useEnvironments query (page still renders; picker
  // guards with `?.map`). Return the real DTO shape.
  if (url.endsWith("/api/environments")) return jsonResponse({ environments: [] });
  if (url.endsWith("/api/test-runs") && init?.method === "POST") return jsonResponse(TRACE);
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderPage() {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/S1/edit"]}>
        <Routes>
          <Route path="/scenarios/:id/edit" element={<ScenarioEditPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioEditPage test-run", () => {
  it("POSTs the current buffer + env + max_requests and renders the trace", async () => {
    const user = userEvent.setup();
    renderPage();

    // wait for the scenario to load (Save button appears)
    await screen.findByRole("button", { name: /Save/ });

    const runBtn = await screen.findByRole("button", { name: /Test run/ });
    await user.click(runBtn);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/test-runs") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/test-runs") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.scenario_yaml).toContain("name: demo");
    expect(body.env).toEqual({});
    expect(body.max_requests).toBe(50);

    // panel rendered
    await screen.findByRole("region", { name: /Test run result/ });
  });
});
```

> NOTE (first full-page mount in the suite): no existing test mounts `ScenarioEditPage`/`EditorShell` (they're `it.todo`/pure-function tests). This works because the editor store's default tab is `"canvas"`, so `EditorShell` renders `CanvasView` (React Flow) — **not** `MonacoYamlView` — so **no Monaco worker mock is needed** (Monaco is only imported by the YAML view). `CanvasView` mounts in jsdom via the existing `ResizeObserver` polyfill in `ui/src/test/setup.ts`. The `await screen.findByRole("button", { name: /Save/ })` gate waits for the scenario to load + `EditorShell`'s first `onChange` to seed `yamlText`. **The editor Zustand store is module-scoped/shared** — this single-case test is self-contained, but if you add a second `it` (e.g. a page-level 422-banner case), reset the store in `beforeEach` per the documented pattern in `ui/CLAUDE.md` ("store reset 패턴"). The 422-as-error path is already covered at the hook level in Task 2.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && pnpm test -- --run ScenarioEditPage.testrun`
Expected: FAIL — no "Test run" button (and/or no "Test run result" region).

- [ ] **Step 3: Edit `ScenarioEditPage.tsx`** — extend the imports:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScenario, useTestRun, useUpdateScenario, useEnvironment } from "../api/hooks";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
import { Button } from "../components/Button";
import { EnvironmentPicker } from "../components/EnvironmentPicker";
import { EditorShell } from "../components/scenario/EditorShell";
import { TestRunPanel } from "../components/scenario/TestRunPanel";
```

Add Test-run state next to the existing `useState` hooks (after `baselineSeededRef`):

```tsx
  const testRun = useTestRun();
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [maxRequests, setMaxRequests] = useState<number>(50);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};
```

Add the Test-run control block + result panel into the JSX. Place it after `<EditorShell .../>` and before the `{update.error && …}` line:

```tsx
      <section aria-label="Test run controls" className="flex flex-col gap-3 rounded border border-slate-200 p-4">
        <h3 className="text-lg font-semibold">Test run</h3>
        <EnvironmentPicker
          selectedEnvId={selectedEnvId}
          onSelect={setSelectedEnvId}
          baseVars={baseVars}
          overrides={envEntries}
          onOverridesChange={setEnvEntries}
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Max requests</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={maxRequests}
            onChange={(e) => setMaxRequests(Number(e.target.value))}
            className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <div>
          <Button
            onClick={() =>
              testRun.mutate({
                scenario_yaml: yamlText,
                env: resolveEnv(baseVars, envEntries),
                max_requests: maxRequests,
              })
            }
            disabled={testRun.isPending}
          >
            {testRun.isPending ? "Running…" : "Test run"}
          </Button>
        </div>
        {testRun.error && (
          <p className="text-sm text-red-700">{(testRun.error as Error).message}</p>
        )}
      </section>

      {testRun.data && <TestRunPanel trace={testRun.data} />}
```

> `yamlText` is the live buffer (updated on every `EditorShell` `onChange`), so Test-run works while dirty/unsaved — exactly the spec intent. `resolveEnv(baseVars, envEntries)` produces the flat env map (no env selected → `baseVars = {}` → override-only). `testRun.data` is typed `ScenarioTrace` (from the hook).

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && pnpm test -- --run ScenarioEditPage.testrun`
Expected: PASS. (If `findByRole("button", { name: /Test run/ })` is ambiguous with "Test run controls"/"Test run result" headings, the role filter `button` already excludes the headings — but if the panel's "Test run" heading collides, the test queries the button role specifically.)

- [ ] **Step 5: Run the whole UI suite + type gate**

Run:
```bash
cd ui && pnpm test -- --run
pnpm build
```
Expected: PASS — all tests (including the pre-existing suite) green, `tsc -b && vite build` clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/ScenarioEditPage.tsx ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx
git commit -m "feat(ui): wire Test-run into ScenarioEditPage (EnvironmentPicker + max_requests + TestRunPanel) (C-2)"
```

---

## Task 5: Full UI gate + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Full gate**

Run:
```bash
cd ui
pnpm test -- --run     # all suites green
pnpm build             # tsc -b && vite build clean
```
Expected: PASS — no failing tests, no TS errors. This is the merge gate (the cargo pre-commit hook does NOT cover UI).

- [ ] **Step 2: Manual smoke (optional but recommended)** — see `docs/dev/` runbooks for starting the stack; in short:

```bash
# Terminal 1: controller (no worker needed for test-run)
just run-controller-with-ui     # serves SPA + API on :8080
# Terminal 2 (dev UI, optional): cd ui && pnpm dev   # :5173 proxying to :8080
```
Then in the editor for any scenario: edit the YAML (e.g. a step hitting a reachable URL), pick/skip an environment, set Max requests, click **Test run**. Verify: http rows show method/url/status/latency, an unreachable URL shows a red error row, an `if` node shows its branch label, and an unbound `${VAR}` shows an amber chip. A scenario with a big loop + low Max requests shows the truncated banner.

- [ ] **Step 3: (No commit)** — verification task only.

---

## C-2 Completion Checklist

- [ ] `ScenarioTraceSchema` mirrors the C-1 wire contract exactly (snake_case keys, `kind` `"http"|"if"`, `Option`→`.nullable()`, collections required); parse test green.
- [ ] `api.createTestRun` added to the `api` object; `useTestRun` mutation (no invalidation); posts `{scenario_yaml, env, max_requests}`, parses `ScenarioTrace`, surfaces 422 as error.
- [ ] `TestRunPanel` renders http rows (method/url/status/latency/extracted/expand req+resp), if rows (branch label, `none`→`(미매치)`), loop `#index`, `unbound_vars` amber, truncated banner, empty-steps message.
- [ ] `ScenarioEditPage` Test-run controls reuse `<EnvironmentPicker>` + `resolveEnv` + `max_requests` input; sends the live `yamlText` buffer (works while dirty); renders `<TestRunPanel>` from the result + error banner.
- [ ] `pnpm test -- --run` all green; `pnpm build` (`tsc -b && vite build`) clean.

**Out of scope (spec §8/§10, future slices):** response-driven extract authoring (§8-1), manual var overrides (§8-2), worker-path runner (§8-3), sensitive-value masking, step-name resolution from the YAML buffer (panel shows `step_id`), test-run history/persistence.
