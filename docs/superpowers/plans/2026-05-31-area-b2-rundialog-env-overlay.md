# Area B-2 — RunDialog 환경 오버레이 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prereq:** **B-1 must be merged to master first** (`docs/superpowers/plans/2026-05-31-area-b1-environments-resource.md`). B-2 imports `useEnvironments`/`useEnvironment` from `hooks.ts` and the `Environment` type from `api/environments.ts`, both created in B-1.

**Goal:** Let a run pick a named **environment** in RunDialog and merge its vars with the existing per-run env inputs (client-side, override-wins), submitting the resolved flat `env` map — so `POST /api/runs` is unchanged and the run/preset stores a resolved snapshot.

**Architecture:** A pure `resolveEnv(base, overrides)` merge function + a **standalone, controlled `<EnvironmentPicker>`** (dropdown + read-only base list with per-row "override" buttons + the existing editable override list). RunDialog owns the state (`selectedEnvId`, `envEntries`), fetches the selected env's vars via `useEnvironment`, and computes `resolveEnv(baseVars, envEntries)` at submit. The picker and `resolveEnv` are **decoupled from RunDialog** so a future "scenario-editor → 1 test-run" feature (spec §7) can reuse them verbatim. Priority: **environment vars < per-run override**. No env selected ⇒ override-only ⇒ **byte-identical to today's submit** (back-compat + prefill).

**Tech Stack:** TypeScript/React (Vite + Zod + React Query v5 + vitest/RTL).

---

## Repo conventions the executor MUST know (read before Task 1)

See B-1's "Repo conventions" for the full list (git topology, worktree baseline `pnpm install`+`cargo build`, pre-commit hook does NOT run UI checks → run `cd ui && pnpm test && pnpm build` before committing, tdd-guard needs a pending test file, `.md`-only commits skip gates). B-2 touches **only `ui/`** — no Rust, no migrations.

- **`pnpm build` (`tsc -b`) is the real gate** — `pnpm test` (esbuild) misses TS strict errors. `tsc -b` checks the **whole project**, so widening a shared type breaks other files' tests at the same spot (ui/CLAUDE.md). Run `pnpm build` after every task.
- **`z.record(z.string())` → clean `Record<string,string>`** (no nested `.default()` leak) — `Environment["vars"]` is directly usable; you will NOT hit the `ProfileSchema` leak here.
- **RunDialog prefill is reseed-by-key, no reseed effect** (ui/CLAUDE.md, Area A1): `initial` is read only in `useState` initializers; the parent remounts via React `key`. Keep this — seed `selectedEnvId` from a `useState` initializer, never an effect.

### Conflict surface with in-flight Slice 9d: **none.**

9d touches `ui/src/api/schemas.ts`, `ui/src/components/report/*`. B-2 touches `ui/src/components/RunDialog.tsx` (+ new `envOverlay.ts`, `EnvironmentPicker.tsx`, and the RunDialog test). No overlap. The only cross-feature dependency is on **B-1** (must be merged), not 9d.

---

## File structure

**Create:**
- `ui/src/api/envOverlay.ts` — `EnvEntry` type + `resolveEnv` pure merge fn. (Reusable seam; the spec's §7 future test-run feature imports this.)
- `ui/src/api/__tests__/envOverlay.test.ts` — `resolveEnv` unit tests.
- `ui/src/components/EnvironmentPicker.tsx` — standalone controlled picker.
- `ui/src/components/__tests__/EnvironmentPicker.test.tsx` — its RTL tests.

**Modify:**
- `ui/src/components/RunDialog.tsx` — `selectedEnvId` state, `useEnvironment` base fetch, replace the inline Env `<section>` with `<EnvironmentPicker>`, change `env` build to `resolveEnv`. Import `EnvEntry` from `envOverlay`.
- `ui/src/components/__tests__/RunDialog.test.tsx` — mock `/api/environments` + add overlay tests.
- `ui/CLAUDE.md`, root `CLAUDE.md` status line, `docs/roadmap.md`, the spec status line, `MEMORY.md` — Task 4.

---

## Task 1: `resolveEnv` pure merge + `EnvEntry` type

**Files:**
- Create: `ui/src/api/envOverlay.ts`
- Create: `ui/src/api/__tests__/envOverlay.test.ts`

Write the test first (pending) so tdd-guard passes when you create `envOverlay.ts`.

- [ ] **Step 1: Write the failing unit test**

Create `ui/src/api/__tests__/envOverlay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveEnv, type EnvEntry } from "../envOverlay";

const ov = (pairs: [string, string][]): EnvEntry[] => pairs.map(([key, value]) => ({ key, value }));

describe("resolveEnv", () => {
  it("override-only (no base) is byte-identical to the old submit loop", () => {
    expect(resolveEnv({}, ov([["A", "1"], ["B", "2"]]))).toEqual({ A: "1", B: "2" });
  });

  it("base-only when there are no overrides", () => {
    expect(resolveEnv({ BASE_URL: "http://s" }, [])).toEqual({ BASE_URL: "http://s" });
  });

  it("override wins over a base key", () => {
    expect(resolveEnv({ BASE_URL: "http://s", API_KEY: "k" }, ov([["BASE_URL", "http://o"]]))).toEqual({
      BASE_URL: "http://o",
      API_KEY: "k",
    });
  });

  it("a new override key is added alongside base", () => {
    expect(resolveEnv({ BASE_URL: "http://s" }, ov([["EXTRA", "x"]]))).toEqual({
      BASE_URL: "http://s",
      EXTRA: "x",
    });
  });

  it("trims keys and drops empty-key overrides (matches RunDialog.tsx:122-125)", () => {
    expect(resolveEnv({}, ov([["  ", "ignored"], [" A ", "1"]]))).toEqual({ A: "1" });
  });

  it("last duplicate override key wins (matches env[k]=value loop)", () => {
    expect(resolveEnv({}, ov([["A", "1"], ["A", "2"]]))).toEqual({ A: "2" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test envOverlay`
Expected: FAIL — cannot resolve `../envOverlay`.

- [ ] **Step 3: Implement**

Create `ui/src/api/envOverlay.ts`:

```ts
/** One editable per-run env override row. Lifted out of RunDialog so the picker
 *  and the merge fn form a reusable unit (spec §7: future scenario-editor test-run). */
export type EnvEntry = { key: string; value: string };

/** Merge a selected environment's vars (base layer) with per-run override rows.
 *  Priority: base < override (override wins). Empty/whitespace override keys are
 *  dropped and keys are trimmed — identical to RunDialog's previous submit loop
 *  (`for {key,value} of envEntries { k=key.trim(); if(k) env[k]=value }`,
 *  RunDialog.tsx:121-125). With an empty `base` the result is byte-identical to
 *  that loop, so "no environment selected" stays back-compatible and prefill
 *  (resolved snapshot) re-submits unchanged. */
export function resolveEnv(base: Record<string, string>, overrides: EnvEntry[]): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const { key, value } of overrides) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}
```

- [ ] **Step 4: Run tests + type gate**

Run: `cd ui && pnpm test envOverlay && pnpm build`
Expected: tests PASS; `pnpm build` clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/envOverlay.ts ui/src/api/__tests__/envOverlay.test.ts
git commit -m "feat(ui): resolveEnv merge helper + EnvEntry type (B-2)"
```

---

## Task 2: `<EnvironmentPicker>` — standalone controlled picker

**Files:**
- Create: `ui/src/components/EnvironmentPicker.tsx`
- Create: `ui/src/components/__tests__/EnvironmentPicker.test.tsx`

The picker is **fully controlled**: the parent owns `selectedEnvId` + `overrides` + supplies `baseVars` (the selected env's vars, fetched by the parent). The picker only holds the transient add-row draft. This keeps `resolveEnv` (a pure fn) and the picker (UI) separate, exactly as spec §4 "재사용 이음새" requires.

- [ ] **Step 1: Write the failing component test**

Create `ui/src/components/__tests__/EnvironmentPicker.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { EnvironmentPicker } from "../EnvironmentPicker";
import type { EnvEntry } from "../../api/envOverlay";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A tiny controlled host so we can drive the picker like RunDialog will.
function Host({ baseVars, initialId = null }: { baseVars: Record<string, string>; initialId?: string | null }) {
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(initialId);
  const [overrides, setOverrides] = useState<EnvEntry[]>([]);
  return (
    <EnvironmentPicker
      selectedEnvId={selectedEnvId}
      onSelect={setSelectedEnvId}
      baseVars={baseVars}
      overrides={overrides}
      onOverridesChange={setOverrides}
    />
  );
}
function renderPicker(props: { baseVars: Record<string, string>; initialId?: string | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Host {...props} />
    </QueryClientProvider>,
  );
}
function region() {
  return screen.getByRole("region", { name: /Environment variables/i });
}

describe("EnvironmentPicker", () => {
  it("lists environments in the dropdown", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ environments: [{ id: "E1", name: "staging", var_count: 1, created_at: 1, updated_at: 1 }] }),
    );
    renderPicker({ baseVars: {} });
    expect(await screen.findByRole("option", { name: "staging" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "(없음)" })).toBeInTheDocument();
  });

  it("shows the selected env's vars as a read-only base list with override buttons", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ environments: [{ id: "E1", name: "staging", var_count: 1, created_at: 1, updated_at: 1 }] }),
    );
    const user = userEvent.setup();
    renderPicker({ baseVars: { BASE_URL: "http://s" }, initialId: "E1" });
    expect(await screen.findByText("BASE_URL")).toBeInTheDocument();
    expect(screen.getByText("http://s")).toBeInTheDocument();
    // clicking "override" seeds an editable override row pre-filled with the base value
    await user.click(screen.getByRole("button", { name: /override/i }));
    expect(await screen.findByLabelText("env key 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("env value 0")).toHaveValue("http://s");
  });

  it("marks a base key as overridden when an override row shadows it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ environments: [{ id: "E1", name: "staging", var_count: 1, created_at: 1, updated_at: 1 }] }),
    );
    const user = userEvent.setup();
    renderPicker({ baseVars: { BASE_URL: "http://s" }, initialId: "E1" });
    await screen.findByText("BASE_URL");
    await user.click(screen.getByRole("button", { name: /override/i }));
    // base row now labelled 재정의됨; override row labelled "BASE_URL 재정의"
    await waitFor(() => expect(screen.getByText(/재정의됨/)).toBeInTheDocument());
    expect(screen.getByText(/BASE_URL 재정의/)).toBeInTheDocument();
  });

  it("adds an arbitrary override via the add row", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ environments: [] }));
    const user = userEvent.setup();
    renderPicker({ baseVars: {} });
    await user.type(within(region()).getByPlaceholderText("BASE_URL"), "EXTRA");
    await user.click(within(region()).getByRole("button", { name: /^add$/i }));
    expect(await screen.findByLabelText("env key 0")).toHaveValue("EXTRA");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test EnvironmentPicker`
Expected: FAIL — cannot resolve `../EnvironmentPicker`.

- [ ] **Step 3: Implement the picker**

Create `ui/src/components/EnvironmentPicker.tsx`:

```tsx
import { useState } from "react";
import { useEnvironments } from "../api/hooks";
import type { EnvEntry } from "../api/envOverlay";

type Props = {
  /** Currently selected environment id, or null for "(없음)". Owned by the parent. */
  selectedEnvId: string | null;
  onSelect: (id: string | null) => void;
  /** The selected env's vars (base layer), fetched by the parent via useEnvironment.
   *  `{}` when no env is selected or while the fetch is in flight. */
  baseVars: Record<string, string>;
  /** Editable per-run override rows. Owned by the parent (so it can resolveEnv at submit). */
  overrides: EnvEntry[];
  onOverridesChange: (next: EnvEntry[]) => void;
};

export function EnvironmentPicker({
  selectedEnvId,
  onSelect,
  baseVars,
  overrides,
  onOverridesChange,
}: Props) {
  const environments = useEnvironments();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const selectedName = environments.data?.find((e) => e.id === selectedEnvId)?.name;
  const overrideKeys = new Set(overrides.map((o) => o.key.trim()).filter(Boolean));

  function seedOverride(key: string, value: string) {
    // Belt-and-suspenders: the "override" button is already hidden once a base key
    // is overridden (see the base-list render below), so this guard is effectively
    // unreachable from the UI — it just makes seedOverride idempotent if called
    // programmatically. The add-row can still append a duplicate key freely; that's
    // fine — resolveEnv is last-wins.
    if (overrideKeys.has(key)) return;
    onOverridesChange([...overrides, { key, value }]);
  }

  return (
    <section aria-label="Environment variables" className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <label className="text-sm text-slate-600" htmlFor="env-select">
          환경
        </label>
        <select
          id="env-select"
          aria-label="select environment"
          className="border border-slate-300 rounded px-2 py-1 text-sm"
          value={selectedEnvId ?? ""}
          onChange={(e) => onSelect(e.target.value || null)}
        >
          <option value="">(없음)</option>
          {environments.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      {selectedEnvId && (
        <div className="mb-2">
          <p className="text-xs text-slate-500 mb-1">from {selectedName ?? "환경"} (읽기 전용):</p>
          <ul className="flex flex-col gap-1">
            {Object.entries(baseVars).map(([k, v]) => {
              const overridden = overrideKeys.has(k);
              return (
                <li key={k} className="flex items-center gap-2 text-sm">
                  <span className={`w-40 font-mono ${overridden ? "line-through text-slate-400" : ""}`}>
                    {k}
                  </span>
                  <span className="text-slate-400">=</span>
                  <span
                    className={`flex-1 min-w-0 truncate ${overridden ? "line-through text-slate-400" : "text-slate-600"}`}
                  >
                    {v}
                  </span>
                  {overridden ? (
                    <span className="text-xs text-amber-700 shrink-0">재정의됨</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => seedOverride(k, v)}
                      className="text-xs text-slate-600 hover:text-slate-900 shrink-0 border border-slate-300 rounded px-1"
                    >
                      override
                    </button>
                  )}
                </li>
              );
            })}
            {Object.keys(baseVars).length === 0 && (
              <li className="text-xs text-slate-400 italic">이 환경엔 변수가 없습니다</li>
            )}
          </ul>
        </div>
      )}

      <h4 className="text-sm font-semibold text-slate-700 mb-2">
        {selectedEnvId ? "override (이 run 한정)" : "Env"}
      </h4>
      <ul className="flex flex-col gap-2">
        {overrides.map((entry, idx) => {
          const shadowsBase = selectedEnvId != null && entry.key.trim() in baseVars;
          return (
            <li key={idx} className="flex items-center gap-2">
              <input
                aria-label={`env key ${idx}`}
                className="w-40 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                value={entry.key}
                onChange={(e) =>
                  onOverridesChange(overrides.map((p, i) => (i === idx ? { ...p, key: e.target.value } : p)))
                }
              />
              <span className="text-slate-400 text-sm">=</span>
              <input
                aria-label={`env value ${idx}`}
                className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm"
                value={entry.value}
                onChange={(e) =>
                  onOverridesChange(overrides.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)))
                }
              />
              {shadowsBase && (
                <span className="text-xs text-amber-700 shrink-0">{entry.key.trim()} 재정의</span>
              )}
              <button
                type="button"
                onClick={() => onOverridesChange(overrides.filter((_, i) => i !== idx))}
                aria-label={`Remove env ${entry.key || idx}`}
                className="text-slate-500 hover:text-red-600 text-sm shrink-0"
              >
                ×
              </button>
            </li>
          );
        })}
        {overrides.length === 0 && <li className="text-xs text-slate-400 italic">No env vars</li>}
      </ul>

      <div className="flex items-center gap-2 mt-2">
        <input
          aria-label="new env key"
          className="w-40 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
          placeholder="BASE_URL"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <span className="text-slate-400 text-sm">=</span>
        <input
          aria-label="new env value"
          className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm"
          placeholder="http://localhost:9090"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            const k = newKey.trim();
            if (!k) return;
            onOverridesChange([...overrides, { key: k, value: newValue }]);
            setNewKey("");
            setNewValue("");
          }}
          disabled={newKey.trim().length === 0}
          className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50 shrink-0"
        >
          Add
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run tests + type gate**

Run: `cd ui && pnpm test EnvironmentPicker && pnpm build`
Expected: tests PASS; `pnpm build` clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/EnvironmentPicker.tsx ui/src/components/__tests__/EnvironmentPicker.test.tsx
git commit -m "feat(ui): standalone EnvironmentPicker (dropdown + base/override) (B-2)"
```

---

## Task 3: Wire RunDialog to the picker + resolveEnv

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` (state, base fetch, Env section, submit `env`, imports)
- Modify: `ui/src/components/__tests__/RunDialog.test.tsx` (mock `/api/environments` + overlay tests)

`RunDialog.test.tsx` is modified (pending) in this task → tdd-guard passes while editing `RunDialog.tsx`.

- [ ] **Step 1: Update the existing RunDialog tests to tolerate the new `/api/environments` fetch + add overlay tests**

The picker calls `useEnvironments()` (→ `/api/environments`) on mount, and RunDialog calls `useEnvironment(id)` (→ `/api/environments/{id}`) when an env is selected. The existing tests' `fetchMock` doesn't serve these — with `retry:false` an unmatched fetch just errors the query (the dropdown shows only "(없음)"), so the existing assertions still pass. To make the overlay tests deterministic, add a default-list mock and the overlay cases.

In `ui/src/components/__tests__/RunDialog.test.tsx`, append a new describe block (keep the existing ones):

```tsx
describe("RunDialog — environment overlay (B-2)", () => {
  function routeFetch(handlers: { run?: unknown; envList?: unknown; env?: Record<string, unknown> }) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/environments") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve(jsonResponse(handlers.envList ?? { environments: [] }));
      }
      if (u.includes("/api/environments/") && (!init || !init.method || init.method === "GET")) {
        const id = u.split("/api/environments/")[1];
        return Promise.resolve(jsonResponse(handlers.env?.[id] ?? {}, handlers.env?.[id] ? 200 : 404));
      }
      if (u.endsWith("/api/runs") && init?.method === "POST") {
        return Promise.resolve(jsonResponse(handlers.run, 201));
      }
      // presets list etc. — empty
      return Promise.resolve(jsonResponse({ presets: [] }));
    });
  }

  const RUN = {
    id: "R1",
    scenario_id: "S1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "pending",
    profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
    env: {},
    started_at: null,
    ended_at: null,
    created_at: 1,
  };

  it("merges env base + override and posts the resolved flat env", async () => {
    const captured: { body?: string } = {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/environments") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({ environments: [{ id: "E1", name: "staging", var_count: 2, created_at: 1, updated_at: 1 }] }),
        );
      }
      if (u.includes("/api/environments/E1")) {
        return Promise.resolve(jsonResponse({ id: "E1", name: "staging", vars: { BASE_URL: "http://s", API_KEY: "k" }, created_at: 1, updated_at: 1 }));
      }
      if (u.endsWith("/api/runs") && init?.method === "POST") {
        captured.body = String(init.body);
        return Promise.resolve(jsonResponse(RUN, 201));
      }
      return Promise.resolve(jsonResponse({ presets: [] }));
    });

    const user = userEvent.setup();
    renderDialog();
    // select the environment; wait for the base list to load
    await user.selectOptions(await screen.findByLabelText("select environment"), "E1");
    await screen.findByText("BASE_URL");
    // override BASE_URL via the add row
    await user.type(screen.getByLabelText("new env key"), "BASE_URL");
    await user.type(screen.getByLabelText("new env value"), "http://override");
    await user.click(within(screen.getByRole("region", { name: /Environment variables/i })).getByRole("button", { name: /^add$/i }));
    await user.click(screen.getByRole("button", { name: /^run$/i }));

    await waitFor(() => expect(captured.body).toBeTruthy());
    const posted = JSON.parse(captured.body!);
    // override wins over base; untouched base key carried through
    expect(posted.env).toEqual({ BASE_URL: "http://override", API_KEY: "k" });
  });

  it("keeps overrides when switching environments (no orphan)", async () => {
    routeFetch({
      run: RUN,
      envList: {
        environments: [
          { id: "E1", name: "staging", var_count: 1, created_at: 1, updated_at: 1 },
          { id: "E2", name: "prod", var_count: 1, created_at: 1, updated_at: 1 },
        ],
      },
      env: {
        E1: { id: "E1", name: "staging", vars: { BASE_URL: "http://s" }, created_at: 1, updated_at: 1 },
        E2: { id: "E2", name: "prod", vars: { BASE_URL: "http://p" }, created_at: 1, updated_at: 1 },
      },
    });
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(await screen.findByLabelText("select environment"), "E1");
    // add a standalone override
    await user.type(screen.getByLabelText("new env key"), "TOKEN");
    await user.type(screen.getByLabelText("new env value"), "t1");
    await user.click(within(screen.getByRole("region", { name: /Environment variables/i })).getByRole("button", { name: /^add$/i }));
    expect(await screen.findByLabelText("env key 0")).toHaveValue("TOKEN");
    // switch to E2 — override survives
    await user.selectOptions(screen.getByLabelText("select environment"), "E2");
    expect(screen.getByLabelText("env key 0")).toHaveValue("TOKEN");
  });
});
```

(`within` is already imported at the top of `RunDialog.test.tsx`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test RunDialog`
Expected: FAIL — `select environment` control doesn't exist yet (the overlay tests can't find the dropdown / merge doesn't happen).

- [ ] **Step 3: Edit RunDialog imports**

In `ui/src/components/RunDialog.tsx`, add imports (after the existing `runPrefill` import on line 16, and near the hooks import block):

```tsx
import { EnvironmentPicker } from "./EnvironmentPicker";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
```

Add `useEnvironment` to the `../api/hooks` import (lines 3-10):

```tsx
import {
  useCreatePreset,
  useCreateRun,
  useDeletePreset,
  useEnvironment,
  usePresets,
  useUpdatePreset,
  queryKeys,
} from "../api/hooks";
```

- [ ] **Step 4: Remove the local `EnvEntry` type (now imported)**

Delete line 40 of `RunDialog.tsx`:

```tsx
type EnvEntry = { key: string; value: string };
```

(`EnvEntry` is now imported from `envOverlay`. Its shape is identical, so `envEntries: EnvEntry[]` keeps type-checking.)

> **⚠️ DO NOT touch line 55** — the `envEntries` seed initializer:
> ```tsx
> const [envEntries, setEnvEntries] = useState<EnvEntry[]>(() =>
>   initial ? Object.entries(initial.env).map(([key, value]) => ({ key, value })) : [],
> );
> ```
> This is the prefill path (preset/retry → override-only, env none). It MUST survive verbatim. Steps 4 and 7 delete lines 40 and 58-59 which bracket it — make a targeted edit (match the exact `type EnvEntry…` / `newEnvKey`/`newEnvValue` text), do not delete a line range.

- [ ] **Step 5: Add `selectedEnvId` state + base fetch**

In `RunDialog.tsx`, after the `binding`/`bindingValid` state (around line 60-61), add:

```tsx
  // B-2 environment overlay. Prefill (preset/retry) is override-only (env = none):
  // the stored env is already a resolved snapshot, so it seeds envEntries with no base.
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};
```

- [ ] **Step 6: Change the submit `env` to the merged result**

Replace the `env` build block (lines 121-125):

```tsx
  const env: Record<string, string> = {};
  for (const { key, value } of envEntries) {
    const k = key.trim();
    if (k) env[k] = value;
  }
```

with:

```tsx
  // Merge selected environment (base) under the per-run override rows. With no env
  // selected, baseVars is {} and this is byte-identical to the old loop.
  const env: Record<string, string> = resolveEnv(baseVars, envEntries);
```

(`env` is consumed unchanged by both `currentInput()` (preset snapshot) and the Run submit — both now persist the resolved snapshot, per spec.)

- [ ] **Step 7: Replace the inline Env `<section>` with `<EnvironmentPicker>`**

Replace the entire `<section aria-label="Environment variables">…</section>` block (lines 305-377) — i.e. the env list `<ul>` **and** the add-row `<div>` — with:

```tsx
      <EnvironmentPicker
        selectedEnvId={selectedEnvId}
        onSelect={setSelectedEnvId}
        baseVars={baseVars}
        overrides={envEntries}
        onOverridesChange={setEnvEntries}
      />
```

Then delete the now-unused `newEnvKey`/`newEnvValue` state declarations (lines 58-59):

```tsx
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
```

(They moved into `EnvironmentPicker`. `envEntries`/`setEnvEntries` stay in RunDialog — they are the controlled `overrides` and the prefill target.)

- [ ] **Step 8: Run the full RunDialog suite + type gate**

Run: `cd ui && pnpm test RunDialog && pnpm build`
Expected: PASS — existing env tests (labels preserved: `env key N`/`env value N`/`new env key`/`new env value`/`Add`/`Remove env X`/`No env vars`) **and** the two new overlay tests. `pnpm build` clean (the deleted local `EnvEntry` and `newEnvKey`/`newEnvValue` leave no dangling refs).

- [ ] **Step 9: Run the whole UI suite** (tsc -b is whole-project; catch any unused-import/type regression)

Run: `cd ui && pnpm test && pnpm build`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog environment overlay (picker + resolveEnv merge) (B-2)"
```

---

## Task 4: Docs — status lines, gotchas, roadmap, memory

**Files:**
- Modify: `ui/CLAUDE.md` (gotcha for the controlled-picker/decoupled-resolveEnv pattern if non-obvious)
- Modify: root `CLAUDE.md` status line (영역 B 완료)
- Modify: `docs/roadmap.md` (§A6/영역 B → done)
- Modify: spec status line (`docs/superpowers/specs/2026-05-31-global-variables-environments-design.md:3` → 구현 완료)
- Modify: `MEMORY.md` + `memory/global-variables-area-b.md`

- [ ] **Step 1: Update docs**

- root `CLAUDE.md`: flip the B status line to "영역 B(글로벌 변수=환경) 완료: B-1 리소스+관리 UI + B-2 RunDialog 오버레이 머지". ADR-0025 should already be in the "알아둘 결정들" list from B-1 — `grep -n 0025 CLAUDE.md` to confirm; add it if (somehow) missing rather than assuming.
- `ui/CLAUDE.md`: add a gotcha if one bit you, e.g. "`<EnvironmentPicker>`는 controlled(상태는 RunDialog 소유) + `resolveEnv`는 순수 함수로 분리 — 시나리오 에디터 test-run(§7) 재사용 이음새. base는 부모가 `useEnvironment`로 fetch해 prop으로 내려줌(React Query dedup)." and "환경 미선택 = override-only = pre-B2 submit과 byte-identical(prefill 호환)."
- `docs/roadmap.md` §A6: mark 영역 B done.
- spec line 3: Draft → "구현 완료 (B-1 + B-2, master 머지)".
- `MEMORY.md` + `global-variables-area-b.md`: B-1 **and** B-2 merged; note the actual migration number used; link `[[run-presets-area-a]]`.

- [ ] **Step 2: Guard against conflict markers**

Run: `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ui/CLAUDE.md docs/roadmap.md docs/superpowers/specs/2026-05-31-global-variables-environments-design.md
git commit -m "docs: record Area B-2 (RunDialog env overlay) — area B complete"
```

(Memory files: write with the Write tool, not git.)

---

## Finishing B-2 (merge to master)

1. Full gates in the worktree: `cd ui && pnpm test && pnpm build` (B-2 is UI-only — no cargo changes, but the pre-commit hook still builds the workspace on the non-`.md` commits).
2. Rebase onto latest master (no remote — local ff-only). B-2 touches no migrations, so **no number-collision risk** with 9d; the only rebase concern is if B-1 wasn't yet on master (it must be — it's a prereq).
3. `git checkout master && git merge --ff-only <branch>`, then `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md`.
4. `ExitWorktree(discard_changes: true)` after confirming the merge.

---

## Self-review checklist (run before declaring B-2 complete)

- **Spec coverage (§4 + interaction table):**
  - dropdown "(없음)" + env names → Task 2 picker.
  - read-only base list "from {name}" + per-row override button → Task 2.
  - key-conflict display (base 재정의됨 / override "{KEY} 재정의") → Task 2.
  - merge/submit `resolveEnv(base, overrides)` override-wins → Task 1 + Task 3 Step 6.
  - env switch keeps overrides (no orphan) → Task 3 test "keeps overrides when switching".
  - prefill = override-only, env none → `selectedEnvId` seeded null in `useState` (Task 3 Step 5); the resolved-snapshot env seeds `envEntries` via the existing `initial` initializer (unchanged) → byte-identical to A1.
  - reusable seam (`resolveEnv` pure fn + standalone `<EnvironmentPicker>`) → Tasks 1-2, decoupled from RunDialog.
- **Back-compat:** no env selected ⇒ `resolveEnv({}, envEntries)` ⇒ identical to the old loop (Task 1 first test). `POST /api/runs` contract unchanged (still a flat `env` map).
- **Type consistency:** `EnvEntry` defined once in `envOverlay.ts`, imported by both `EnvironmentPicker` and `RunDialog`; the old local `RunDialog` definition removed (Task 3 Step 4).
- **Existing tests preserved:** Task 2/3 keep every env aria-label (`env key N`, `env value N`, `new env key`, `new env value`, `Add`, `Remove env X`, `No env vars`) so the pre-B2 RunDialog env tests still pass.
- **Placeholder scan:** no "TBD"/"similar to"/"add handling" — all code inline.
```
