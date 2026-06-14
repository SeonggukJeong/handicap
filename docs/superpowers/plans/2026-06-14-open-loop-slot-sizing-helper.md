# Open-Loop Slot (max_in_flight) Sizing Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure-UI helper in RunDialog's open+fixed mode that recommends `max_in_flight` from the user's target RPS via Little's Law (`ceil(target_rps × latency_sec)`), matching the post-hoc `load_gen_saturated` insight formula — the mirror of the shipped closed-loop VU sizing helper.

**Architecture:** Three latency sources (prior open-loop run `summary.p50_ms` → manual estimate → no-load test-run `total_ms/R`), a pure `recommendSlots`/`pickLatestOpenRun` in the existing `sizing.ts`, a self-contained `SlotSizingHelper.tsx` (co-located anchor hook), and an `onApplyMaxInFlight` optional prop on the shared `LoadModelFields` (AND-gated → RunDialog only, absent in ScheduleForm). **No engine/worker/proto/controller/migration/Zod-wire change; run-create payload byte-identical; merge diff = `ui/` only.**

**Tech Stack:** TypeScript, React, Zustand, React Query, Zod, vitest + React Testing Library + user-event. Catalog strings in `ui/src/i18n/ko.ts` (ADR-0035).

**Spec:** `docs/superpowers/specs/2026-06-14-open-loop-slot-sizing-helper-design.md`

---

## Repo-specific constraints (read before starting)

- **Every commit must be GREEN.** The pre-commit hook runs the UI gate (`pnpm lint && pnpm test && pnpm build`) for any `ui/` (non-`.md`) staged file (node_modules present → gate runs). A RED-only commit is rejected. So each task folds write-test → implement → verify-green into **one commit** (do RED→GREEN locally, commit once).
- **tdd-guard**: editing a `ui/src/*.{ts,tsx}` source file requires a pending test file in the worktree. Each task edits/creates its test file FIRST, which unblocks the source edits in the same turn.
- **`pnpm test <name>`** runs one file; **`pnpm test -- <name>`** (with `--`) runs the WHOLE suite. Use no-`--` for fast single-file iteration; run the full `pnpm test` (no args) once before declaring done.
- **`pnpm build` (`tsc -b`)** is the real type gate — `pnpm test` (esbuild) misses Zod nested-`.default()` input leaks and discriminated-union mismatches. Run `pnpm lint && pnpm test && pnpm build` before each commit.
- **`ko.ts` 조사 병기**: variable-substituted nouns use `(으)로`/`(은)는` forms (받침 가변). RTL regexes escape the parens: `/\(으\)로/`.
- Commit subagent step: run `git commit` as a single FOREGROUND blocking call (`run_in_background: false`, timeout 600000ms). No piping (`| tail`) — it masks exit codes. After commit, `git log -1 --oneline` to confirm it landed.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `ui/src/components/sizing.ts` (modify) | add pure `recommendSlots` + `pickLatestOpenRun` + types | 1 |
| `ui/src/components/__tests__/sizing.test.ts` (modify) | unit tests for the two new pure fns | 1 |
| `ui/src/i18n/ko.ts` (modify) | `ko.slotSizing.*` catalog | 2 |
| `ui/src/components/SlotSizingHelper.tsx` (create) | self-contained helper: anchor hook + sources + render | 2 |
| `ui/src/components/__tests__/SlotSizingHelper.test.tsx` (create) | component tests (3-tier sources, truncated, over-cap, apply) | 2 |
| `ui/src/components/LoadModelFields.tsx` (modify) | `onApplyMaxInFlight?` prop + render in open+fixed | 3 |
| `ui/src/components/__tests__/LoadModelFields.test.tsx` (modify) | render-gate lock-in for the slot helper | 3 |
| `ui/src/components/RunDialog.tsx` (modify) | pass `onApplyMaxInFlight={(n)=>setMaxInFlight(String(n))}` | 4 |
| `ui/src/components/__tests__/RunDialog.test.tsx` (modify) | integration: apply → max_in_flight input updated | 4 |

---

## Task 1: Pure functions in `sizing.ts` (`recommendSlots`, `pickLatestOpenRun`)

**Files:**
- Modify: `ui/src/components/sizing.ts`
- Test: `ui/src/components/__tests__/sizing.test.ts`

- [ ] **Step 1: Add the failing tests** (append to `ui/src/components/__tests__/sizing.test.ts`)

Append these blocks (keep existing imports; add the new symbols to the import on line 2):

```ts
// line 2 becomes:
import { recommendVus, pickLatestClosedRun, recommendSlots, pickLatestOpenRun } from "../sizing";
```

```ts
describe("recommendSlots", () => {
  it("단일-스텝 정확값: 1000 RPS × 50ms = 50슬롯", () => {
    expect(recommendSlots(1000, 50)).toEqual({ recommendedSlots: 50 });
  });

  it("200 RPS × 250ms = 50슬롯", () => {
    expect(recommendSlots(200, 250)?.recommendedSlots).toBe(50);
  });

  it("insight 수식 동치: ceil(target × p50/1000), 최소 1", () => {
    // 2000 RPS × 53ms = 106 (= insights.rs:224 required)
    expect(recommendSlots(2000, 53)?.recommendedSlots).toBe(106);
    // floor: 아주 작은 곱도 최소 1
    expect(recommendSlots(1, 1)?.recommendedSlots).toBe(1);
    expect(recommendSlots(1, 0.4)?.recommendedSlots).toBe(1);
  });

  it("가드 → null", () => {
    expect(recommendSlots(0, 50)).toBeNull(); // target < 1
    expect(recommendSlots(1_000_001, 50)).toBeNull(); // target > max
    expect(recommendSlots(1.5, 50)).toBeNull(); // 비정수 target
    expect(recommendSlots(1000, 0)).toBeNull(); // latency 0
    expect(recommendSlots(1000, -5)).toBeNull(); // latency 음수
    expect(recommendSlots(1000, NaN)).toBeNull(); // latency NaN
    expect(recommendSlots(1000, Infinity)).toBeNull(); // latency Inf
  });
});

describe("pickLatestOpenRun", () => {
  // pickLatestOpenRun이 읽는 필드(status/profile.target_rps/profile.stages/created_at)만 가진 최소 fixture.
  const mk = (
    profile: Record<string, unknown>,
    created_at: number,
    status = "completed",
  ): Run => ({ id: `r${created_at}`, status, profile, created_at }) as unknown as Run;

  it("open-loop(target_rps) completed 중 최신 선택", () => {
    const runs = [
      mk({ target_rps: 100, max_in_flight: 50 }, 100),
      mk({ target_rps: 200, max_in_flight: 80 }, 300), // 최신 open
      mk({ vus: 5 }, 400), // closed+fixed → 제외
      mk({ target_rps: 50, max_in_flight: 10 }, 500, "running"), // 비완료 → 제외
    ];
    expect(pickLatestOpenRun(runs)?.created_at).toBe(300);
  });

  it("open-loop(stages, target_rps 없음)도 포함", () => {
    const runs = [mk({ stages: [{ target: 100, duration_seconds: 10 }], max_in_flight: 50 }, 200)];
    expect(pickLatestOpenRun(runs)?.created_at).toBe(200);
  });

  it("closed+fixed가 stray max_in_flight를 달고 있어도 제외(양성 식)", () => {
    // is_open_loop는 max_in_flight를 안 보고 target_rps/stages만 본다.
    const runs = [mk({ vus: 5, max_in_flight: 999 }, 100)];
    expect(pickLatestOpenRun(runs)).toBeNull();
  });

  it("VU곡선(vu_stages, target_rps/stages 없음) 제외", () => {
    const runs = [mk({ vus: 0, vu_stages: [{ target: 10, duration_seconds: 5 }] }, 100)];
    expect(pickLatestOpenRun(runs)).toBeNull();
  });

  it("해당 run 없으면 null", () => {
    expect(pickLatestOpenRun([mk({ vus: 5 }, 1), mk({ target_rps: 10 }, 2, "failed")])).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm test sizing`
Expected: FAIL — `recommendSlots`/`pickLatestOpenRun` are not exported (`recommendSlots is not a function`).

- [ ] **Step 3: Implement the pure functions** (append to `ui/src/components/sizing.ts`)

```ts
/** 열린 루프 슬롯(max_in_flight) 사이징의 순수 계산. Little's Law: 동시 슬롯 ≈ 도착률 × 지연.
 *  post-hoc `load_gen_saturated` 인사이트의 `required = ceil(target_rps × p50_ms/1000)`와
 *  같은 수식·프록시(요청당 p50). 컨트롤러: crates/controller/src/insights.rs:222-227. */

export type SlotSizingResult = { recommendedSlots: number };

/** 목표 RPS + 지연(ms) → 권장 max_in_flight(하한). 계산 불가(목표 무효 / 지연 0·음수·NaN·Inf)면 null. */
export function recommendSlots(targetRps: number, latencyMs: number): SlotSizingResult | null {
  if (!targetRpsValid(targetRps)) return null;
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return null;
  // insights.rs:224 grouping: ceil(target * (latency/1000)), 최소 1.
  const recommendedSlots = Math.max(1, Math.ceil(targetRps * (latencyMs / 1000)));
  return { recommendedSlots };
}

/** 가장 최근 종료(completed)된 open-loop run.
 *  open-loop 판별 = is_open_loop 양성 식(target_rps 있음 OR stages 비어있지 않음) —
 *  컨트롤러 Profile::is_open_loop()(store/runs.rs:149-151)와 1:1. max_in_flight는 판별자로
 *  쓰지 않는다(closed+fixed가 stray max_in_flight를 달 수 있음 — spec §5.1). closed+fixed(vus>0)·
 *  VU곡선(vu_stages)을 모두 제외. 없으면 null. */
export function pickLatestOpenRun(runs: Run[]): Run | null {
  let best: Run | null = null;
  for (const r of runs) {
    if (r.status !== "completed") continue;
    const p = r.profile;
    const isOpen = p.target_rps != null || (p.stages != null && p.stages.length > 0);
    if (!isOpen) continue;
    if (best === null || r.created_at > best.created_at) best = r;
  }
  return best;
}
```

Note: `targetRpsValid` already exists in `sizing.ts` (used by `recommendVus`) — reuse it, do not redefine. The `Run` type is already imported at the top of `sizing.ts` (`import type { Run } from "../api/schemas";`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm test sizing`
Expected: PASS (existing `recommendVus`/`pickLatestClosedRun` tests + new `recommendSlots`/`pickLatestOpenRun` tests).

- [ ] **Step 5: Lint + build gate**

Run: `cd ui && pnpm lint && pnpm build`
Expected: both PASS (no eslint warnings, `tsc -b` clean).

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/sizing.ts ui/src/components/__tests__/sizing.test.ts
git commit -m "feat(ui): recommendSlots + pickLatestOpenRun 순수 함수 (open-loop 슬롯 사이징)"
```
Then confirm: `git log -1 --oneline`

---

## Task 2: `ko.slotSizing` catalog + `SlotSizingHelper.tsx` component

**Files:**
- Modify: `ui/src/i18n/ko.ts`
- Create: `ui/src/components/SlotSizingHelper.tsx`
- Test: `ui/src/components/__tests__/SlotSizingHelper.test.tsx`

- [ ] **Step 1: Write the failing component test** (create `ui/src/components/__tests__/SlotSizingHelper.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SlotSizingHelper } from "../SlotSizingHelper";

vi.mock("../../api/hooks", () => ({
  useScenarioRuns: vi.fn(),
  useRunReport: vi.fn(),
  useScenario: vi.fn(),
  useTestRun: vi.fn(),
}));
import { useScenarioRuns, useRunReport, useScenario, useTestRun } from "../../api/hooks";

const openRun = (created_at: number) =>
  ({
    id: `r${created_at}`,
    status: "completed",
    profile: { vus: 0, target_rps: 100, max_in_flight: 50 },
    created_at,
  }) as unknown as never;

function setHooks(opts: {
  runs?: unknown[];
  p50?: number | null;
  yaml?: string;
  testRun?: unknown;
}) {
  (useScenarioRuns as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { runs: opts.runs ?? [] },
  });
  (useRunReport as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: opts.p50 != null ? { summary: { p50_ms: opts.p50 } } : undefined,
  });
  (useScenario as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { yaml: opts.yaml ?? "version: 1\nsteps: []\n" },
  });
  (useTestRun as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    opts.testRun ?? { mutate: vi.fn(), isPending: false, isError: false, data: undefined },
  );
}

beforeEach(() => vi.clearAllMocks());

describe("SlotSizingHelper", () => {
  it("앵커(p50): 권장 슬롯 + p50 출처 문구 + 계산식", () => {
    setHooks({ runs: [openRun(100)], p50: 50 });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="1000" onApply={vi.fn()} />);
    expect(screen.getByText(/최소 ~50\(으\)로/)).toBeInTheDocument();
    expect(screen.getByText(/p50 50ms/)).toBeInTheDocument();
    // 계산식 투명성 줄 lock-in: 목표 1000 RPS × 지연 50ms ≈ 동시 50슬롯
    expect(screen.getByText(/≈ 동시 50슬롯/)).toBeInTheDocument();
  });

  it("적용 → onApply(권장)", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    setHooks({ runs: [openRun(100)], p50: 250 });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={onApply} />);
    expect(screen.getByText(/최소 ~50\(으\)로/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(50);
  });

  it("앵커 없음: 예상 응답시간 입력으로 권장 + 한계 문구", async () => {
    const user = userEvent.setup();
    setHooks({ runs: [], p50: null });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={vi.fn()} />);
    await user.type(screen.getByLabelText("예상 평균 응답시간(ms)"), "250");
    expect(screen.getByText(/최소 ~50\(으\)로/)).toBeInTheDocument();
    expect(screen.getByText(/부하 없는 1회 실행/)).toBeInTheDocument();
  });

  it("측정 버튼 → test-run 발사; truncated면 측정 거부", async () => {
    const mutate = vi.fn();
    const user = userEvent.setup();
    setHooks({
      runs: [],
      p50: null,
      testRun: {
        mutate,
        isPending: false,
        isError: false,
        data: { truncated: true, total_ms: 10, steps: [] },
      },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "test-run으로 측정" }));
    expect(mutate).toHaveBeenCalled();
    expect(screen.getByText(/측정이 잘렸어요/)).toBeInTheDocument();
    expect(screen.queryByText(/최소 ~/)).not.toBeInTheDocument();
  });

  it("측정(비-truncated) → R/T로 권장", () => {
    setHooks({
      runs: [],
      p50: null,
      testRun: {
        mutate: vi.fn(),
        isPending: false,
        isError: false,
        data: { truncated: false, total_ms: 250, steps: [{ response: { status: 200 } }] },
      },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={vi.fn()} />);
    expect(screen.getByText(/요청 1개 · 평균 250ms/)).toBeInTheDocument();
    expect(screen.getByText(/최소 ~50\(으\)로/)).toBeInTheDocument();
  });

  it("권장값이 상한(10,000) 초과 → 경고", () => {
    setHooks({ runs: [openRun(100)], p50: 1000 }); // 1s 지연
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20000" onApply={vi.fn()} />);
    // 20000 RPS × 1000ms = 20000 슬롯 > 10000
    expect(screen.getByText(/슬롯 상한\(10,000\)을 넘어요/)).toBeInTheDocument();
  });

  it("목표 RPS 비어있으면 안내(권장 미표시)", () => {
    setHooks({ runs: [openRun(100)], p50: 50 });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="" onApply={vi.fn()} />);
    expect(screen.getByText(/목표 RPS를 먼저 입력/)).toBeInTheDocument();
    expect(screen.queryByText(/최소 ~/)).not.toBeInTheDocument();
  });

  it("지연 출처 없음 → 계산 불가 안내", () => {
    setHooks({ runs: [], p50: null });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={vi.fn()} />);
    expect(screen.getByText(/응답시간 정보가 없어요/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test SlotSizingHelper`
Expected: FAIL — `Failed to resolve import "../SlotSizingHelper"`.

- [ ] **Step 3a: Add the `ko.slotSizing` catalog** (in `ui/src/i18n/ko.ts`, immediately after the existing `sizing: { … },` block ~line 329-350)

```ts
  slotSizing: {
    title: "동시 요청 수(슬롯) 도우미",
    helpLabel: "슬롯 사이징 도우미 설명",
    help: "목표 RPS를 내려면 동시 요청 상한(max_in_flight)을 몇으로 잡아야 하는지 추정해 드려요. 너무 낮으면 요청이 버려져요(drop). 권장값은 최소 출발점이에요.",
    estMs: "예상 평균 응답시간(ms)",
    measureBtn: "test-run으로 측정",
    measuring: "측정 중…",
    measureCaveat:
      "방금 측정은 부하 없는 1회 실행이라 실제보다 빨라요. 부하가 걸리면 더 느려져 슬롯이 더 필요할 수 있어, 이 권장값은 최소 출발점이에요.",
    truncated: "시나리오가 길어 측정이 잘렸어요 — 예상 응답시간을 직접 입력하세요.",
    measureError: "측정에 실패했어요. 환경 변수(${BASE_URL} 등)와 시나리오를 확인하세요.",
    fromPriorRun: (p50: number) => `지난 실행의 응답시간(p50 ${p50}ms) 기준 추정이에요.`,
    measured: (req: number, ms: number) => `측정됨: 요청 ${req}개 · 평균 ${ms}ms`,
    recommend: (n: number) => `max_in_flight를 최소 ~${n}(으)로 설정하세요`,
    formula: (targetRps: number, latencyMs: number, n: number) =>
      `목표 ${targetRps} RPS × 지연 ${latencyMs}ms ≈ 동시 ${n}슬롯`,
    apply: "적용",
    needTarget: "위에서 목표 RPS를 먼저 입력하세요.",
    cannotCompute: "응답시간 정보가 없어요 — 예상 응답시간을 입력하거나 test-run으로 측정하세요.",
    overCapacity: "권장값이 단일 워커 슬롯 상한(10,000)을 넘어요 — 목표 RPS를 낮추거나 워커를 늘려야 합니다.",
  },
```

- [ ] **Step 3b: Create the component** (`ui/src/components/SlotSizingHelper.tsx`)

```tsx
import { useMemo, useState } from "react";
import { useScenario, useScenarioRuns, useRunReport, useTestRun } from "../api/hooks";
import type { Run } from "../api/schemas";
import { pickLatestOpenRun, recommendSlots } from "./sizing";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";

const INPUT = "mt-1 block w-full rounded border border-slate-300 px-2 py-1";

/** validate_run_config의 max_in_flight 하드 상한(api/runs.rs:253 / schemas.ts:87 `.max(10_000)`)과 동기.
 *  초과 권장값은 적용해도 검증이 400으로 막으므로 비차단 경고를 띄운다(post-hoc capacity cause와 의미 연결). */
const MAX_IN_FLIGHT_CAP = 10000;

/** 최근 종료 open-loop run에서 지연 앵커(요청당 p50)를 도출. 없거나 p50==0이면 null.
 *  반환값은 useMemo로 안정화 — 소비처 분기가 값 변화에만 반응(닫힌 헬퍼 usePriorClosedRunAnchor 미러). */
function usePriorOpenRunAnchor(scenarioId: string | undefined): { p50Ms: number } | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees a
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(() => pickLatestOpenRun((runs.data?.runs ?? []) as Run[]), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const p50Ms = report.data?.summary.p50_ms ?? 0;
  // p50==0(localhost sub-ms run)이면 앵커 무효 → 추정/측정 UI 노출(spec §5.1 가드).
  return useMemo(() => (p50Ms > 0 ? { p50Ms } : null), [p50Ms]);
}

type Props = {
  scenarioId: string;
  env: Record<string, string>;
  /** 폼의 기존 목표 RPS 문자열(읽기 전용 — 자체 입력칸 없음, spec §2 항목 4). */
  targetRps: string;
  /** 적용 → RunDialog의 setMaxInFlight(String(n)). */
  onApply: (n: number) => void;
};

export function SlotSizingHelper({ scenarioId, env, targetRps, onApply }: Props) {
  const anchor = usePriorOpenRunAnchor(scenarioId);
  const scenarioQ = useScenario(scenarioId);
  const testRun = useTestRun();
  const [estMs, setEstMs] = useState("");

  // test-run 측정(비-truncated): trace에서 요청 수 R + 1회 패스 wall-clock total_ms → 요청당 평균 지연.
  const trace = testRun.data;
  const truncated = trace?.truncated ?? false;
  const measuredR =
    trace && !trace.truncated ? trace.steps.filter((s) => s.response !== null).length : 0;
  const measured =
    trace && !trace.truncated && measuredR > 0 && trace.total_ms > 0
      ? { latencyMs: trace.total_ms / measuredR, reqPerIter: measuredR }
      : null;

  const estMsNum = Number(estMs);
  // 지연 출처 precedence: prior > 수동 추정(estMs 입력) > 측정 (닫힌 헬퍼와 동형).
  const latencyMs: number | null = anchor
    ? anchor.p50Ms
    : estMs.trim() !== "" && Number.isFinite(estMsNum) && estMsNum > 0
      ? estMsNum
      : measured
        ? measured.latencyMs
        : null;

  const targetNum = Number(targetRps);
  const result = latencyMs != null ? recommendSlots(targetNum, latencyMs) : null;

  const runMeasure = () => {
    const yaml = scenarioQ.data?.yaml;
    if (!yaml) return;
    testRun.mutate({ scenario_yaml: yaml, env });
  };

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-sm font-medium text-slate-700">{ko.slotSizing.title}</span>
        <HelpTip label={ko.slotSizing.helpLabel}>{ko.slotSizing.help}</HelpTip>
      </div>

      {anchor ? (
        <p className="text-xs text-slate-500 mb-2">{ko.slotSizing.fromPriorRun(anchor.p50Ms)}</p>
      ) : (
        <div className="mb-2">
          <label className="block text-sm">
            <span className="text-slate-600">{ko.slotSizing.estMs}</span>
            <input
              type="number"
              min={1}
              value={estMs}
              onChange={(e) => setEstMs(e.target.value)}
              className={INPUT}
              aria-label={ko.slotSizing.estMs}
            />
          </label>
          <button
            type="button"
            onClick={runMeasure}
            disabled={testRun.isPending || !scenarioQ.data?.yaml}
            className="mt-1 text-sm text-blue-600 hover:underline disabled:opacity-40"
          >
            {testRun.isPending ? ko.slotSizing.measuring : ko.slotSizing.measureBtn}
          </button>
          <p className="text-xs text-amber-700 mt-1">{ko.slotSizing.measureCaveat}</p>
          {truncated && (
            <p role="alert" className="text-xs text-red-600 mt-1">
              {ko.slotSizing.truncated}
            </p>
          )}
          {testRun.isError && (
            <p role="alert" className="text-xs text-red-600 mt-1">
              {ko.slotSizing.measureError}
            </p>
          )}
          {measured && (
            <p className="text-xs text-slate-500 mt-1">
              {ko.slotSizing.measured(measured.reqPerIter, Math.round(measured.latencyMs))}
            </p>
          )}
        </div>
      )}

      {result ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-700">
              {ko.slotSizing.recommend(result.recommendedSlots)}
            </span>
            <button
              type="button"
              onClick={() => onApply(result.recommendedSlots)}
              className="rounded bg-indigo-600 px-2 py-1 text-sm text-white hover:bg-indigo-700"
            >
              {ko.slotSizing.apply}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {ko.slotSizing.formula(
              targetNum,
              Math.round(latencyMs as number),
              result.recommendedSlots,
            )}
          </p>
          {result.recommendedSlots > MAX_IN_FLIGHT_CAP && (
            <p className="text-xs text-amber-700 mt-1">{ko.slotSizing.overCapacity}</p>
          )}
        </>
      ) : latencyMs == null ? (
        // 지연 출처 없음 — 단, truncated일 땐 위에서 자체 안내가 떠 중복 표시 방지.
        !truncated && <p className="text-xs text-slate-500">{ko.slotSizing.cannotCompute}</p>
      ) : targetRps.trim() === "" ? (
        <p className="text-xs text-slate-500">{ko.slotSizing.needTarget}</p>
      ) : // 지연은 있으나 targetRps가 non-empty-but-invalid(예: "1.5"/"2000000") → recommendSlots null.
      // 폼 자체의 targetRpsInvalid 에러가 이미 그 사유를 표시하므로 여기선 침묵(중복 방지).
      null}
    </div>
  );
}
```

Note: `useScenario`/`useScenarioRuns`/`useRunReport`/`useTestRun` signatures — see `ui/src/api/hooks.ts` (`useScenario(id)`, `useScenarioRuns(scenarioId)`, `useRunReport(id, terminal)`, `useTestRun()`). `HelpTip` is at `ui/src/components/HelpTip.tsx`. The `useTestRun().mutate({ scenario_yaml, env })` shape matches the closed helper (`VuSizingHelper.tsx:84`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm test SlotSizingHelper`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint + build gate**

Run: `cd ui && pnpm lint && pnpm build`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/i18n/ko.ts ui/src/components/SlotSizingHelper.tsx ui/src/components/__tests__/SlotSizingHelper.test.tsx
git commit -m "feat(ui): SlotSizingHelper + ko.slotSizing 카탈로그 (open-loop 슬롯 힌트)"
```
Then confirm: `git log -1 --oneline`

---

## Task 3: Wire `SlotSizingHelper` into `LoadModelFields` (open+fixed, AND-gated)

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx`
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`

- [ ] **Step 1: Add the failing render-gate tests** (in `ui/src/components/__tests__/LoadModelFields.test.tsx`)

Add a second mock next to the existing `VuSizingHelper` mock (line 7-9):

```tsx
vi.mock("../SlotSizingHelper", () => ({
  SlotSizingHelper: () => <div data-testid="slot-sizing-helper" />,
}));
```

Append these tests inside the top-level `describe("LoadModelFields", …)` block (before its closing `});`):

```tsx
  it("open+fixed + onApplyMaxInFlight 주어지면 슬롯 헬퍼 렌더", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      sizingScenarioId: "s1",
      sizingEnv: {},
      onApplyMaxInFlight: vi.fn(),
    });
    expect(screen.getByTestId("slot-sizing-helper")).toBeInTheDocument();
  });

  it("onApplyMaxInFlight 없으면(스케줄 편집기 경로) 슬롯 헬퍼 미렌더", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.queryByTestId("slot-sizing-helper")).toBeNull();
  });

  it("onApplyMaxInFlight 있어도 sizingScenarioId 없으면 슬롯 헬퍼 미렌더 (가드 && 반쪽)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed", onApplyMaxInFlight: vi.fn() });
    expect(screen.queryByTestId("slot-sizing-helper")).toBeNull();
  });

  // 슬롯 헬퍼는 open+fixed 전용 — prop이 다 있어도 다른 3모드에선 미렌더.
  it.each([
    { loadModel: "open", rateMode: "curve" },
    { loadModel: "closed", rateMode: "fixed" },
    { loadModel: "closed", rateMode: "curve" },
  ] as const)("$loadModel+$rateMode 모드에선 슬롯 헬퍼 미렌더 (prop 있어도)", (mode) => {
    renderFields({
      ...mode,
      sizingScenarioId: "s1",
      sizingEnv: {},
      onApplyMaxInFlight: vi.fn(),
    });
    expect(screen.queryByTestId("slot-sizing-helper")).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test LoadModelFields`
Expected: FAIL — `onApplyMaxInFlight` is not a known prop (TS via esbuild may pass, but the helper never renders so `getByTestId("slot-sizing-helper")` throws "Unable to find element").

- [ ] **Step 3a: Add the prop + import** (`ui/src/components/LoadModelFields.tsx`)

Add the import near the existing `VuSizingHelper` import (line 7):

```ts
import { SlotSizingHelper } from "./SlotSizingHelper";
```

Add to the `Props` type (after `onApplyVus?: (n: number) => void;`, line 37):

```ts
  // 열린 루프 슬롯 사이징 힌트(RunDialog 전용 — ScheduleForm 미전달). open+fixed에서만.
  onApplyMaxInFlight?: (n: number) => void;
```

Add `onApplyMaxInFlight` to the destructured params list (after `onApplyVus,` at line 65):

```ts
  onApplyMaxInFlight,
```

- [ ] **Step 3b: Render the helper in the open+fixed arm** (`ui/src/components/LoadModelFields.tsx`)

In the open branch's `rateMode === "fixed"` block, after the `{errs.targetRpsInvalid && (…)}` error paragraph (around line 473-477) and before the closing `</>`, add:

```tsx
              {onApplyMaxInFlight && sizingScenarioId !== undefined && (
                <SlotSizingHelper
                  scenarioId={sizingScenarioId}
                  env={sizingEnv ?? {}}
                  targetRps={targetRps}
                  onApply={onApplyMaxInFlight}
                />
              )}
```

(This sits inside the `<>…</>` that wraps the target_rps/duration grid + error, i.e. the open+fixed fragment — NOT the open+curve `curveEditor` branch.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm test LoadModelFields`
Expected: PASS — new slot-helper gate tests pass; all existing tests (including the closed-helper `it.each` and the open+fixed field tests) still pass.

- [ ] **Step 5: Lint + build gate**

Run: `cd ui && pnpm lint && pnpm build`
Expected: both PASS (`tsc -b` clean — new optional prop, no widening).

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx
git commit -m "feat(ui): LoadModelFields open+fixed에 SlotSizingHelper 게이트 렌더"
```
Then confirm: `git log -1 --oneline`

---

## Task 4: Wire `onApplyMaxInFlight` in `RunDialog` (apply → max_in_flight)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

- [ ] **Step 1: Add the failing integration test** (`ui/src/components/__tests__/RunDialog.test.tsx`)

Add a mock next to the existing `VuSizingHelper` mock (line 8). This mock renders an apply button so the wiring (onApply → setMaxInFlight) is observable, while still blocking the helper's real hook fetches:

```tsx
vi.mock("../SlotSizingHelper", () => ({
  SlotSizingHelper: ({ onApply }: { onApply: (n: number) => void }) => (
    <button type="button" onClick={() => onApply(123)}>
      mock-apply-slots
    </button>
  ),
}));
```

Append a test inside the `describe("RunDialog — open-loop mode (S-C)", …)` block (before its closing `});`):

```tsx
  it("open+fixed: 슬롯 헬퍼 적용 → 동시 요청 상한 입력에 반영", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    await user.click(screen.getByRole("button", { name: "mock-apply-slots" }));
    expect(screen.getByLabelText(/동시 요청 상한/)).toHaveValue(123);
  });
```

(The open-loop radio name `/요청 속도 기준/` and `동시 요청 상한` label match the existing S-C tests, e.g. RunDialog.test.tsx:818,833.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test RunDialog`
Expected: FAIL — RunDialog does not pass `onApplyMaxInFlight`, so the (mocked) `SlotSizingHelper` never renders and `getByRole("button", { name: "mock-apply-slots" })` throws.

- [ ] **Step 3: Pass the callback** (`ui/src/components/RunDialog.tsx`)

In the `<LoadModelFields … />` call (RunDialog.tsx ~507-510, where `onApplyVus={setVus}` already is), add one line:

```tsx
          onApplyMaxInFlight={(n) => setMaxInFlight(String(n))}
```

(`maxInFlight`/`setMaxInFlight` already exist as RunDialog state — RunDialog.tsx:76,221,501. `setMaxInFlight` takes a string, hence `String(n)`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm test RunDialog`
Expected: PASS — the new wiring test + all existing RunDialog tests (53+) pass.

- [ ] **Step 5: Full suite + lint + build gate**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: all PASS. (Full `pnpm test` with no args catches any cross-file red — S-D trap.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog가 슬롯 헬퍼 적용을 max_in_flight에 배선"
```
Then confirm: `git log -1 --oneline`

---

## Post-implementation: whole-feature review + live verification

These are NOT commit tasks — run after Task 4 lands, before merge.

- [ ] **Whole-feature review (`handicap-reviewer`)**: dispatch the repo-trap-aware reviewer on the full diff (`git diff master…HEAD`). Focus: spec↔code 1:1 (formula matches `insights.rs:224`; `pickLatestOpenRun` = `is_open_loop` positive form, not `max_in_flight`); byte-identical run payload (no Zod/wire change); gate correctness (open+fixed only, RunDialog only, ScheduleForm absent); ko.ts 조사 병기. Address findings with fresh fix-subagents, re-review the focused diff.

- [ ] **Live verification (`/live-verify` + Playwright)** — open+fixed RunDialog against a real backend (worktree-relative `./target/debug/controller` + `cargo build -p handicap-worker --bin worker` first; isolated `/tmp/<slug>.db`; **≥50ms-latency responder** so prior runs get `p50_ms > 0`):
  1. Scenario with a prior open-loop run (≥50ms responder) → open+fixed shows the slot helper anchored on p50; change `target_rps` → recommendation recomputes; click 적용 → `동시 요청 상한` input reflects N. (If the responder is sub-ms, `p50_ms==0` → anchor null and you'd silently test the test-run path — use the latency knob.)
  2. Scenario with no prior run → test-run "측정" button → recommendation + 최소-출발점 caveat.
  3. Create an open-loop run with the recommended `max_in_flight` → report `dropped == 0` (helper's core value: prevented post-hoc saturation).
  4. Create a run with `max_in_flight` deliberately below the recommendation → `load_gen_saturated` insight appears, and its `required` is computed by the SAME formula `ceil(target × p50/1000)` (formula consistency, not strict value equality — the new run's actual p50 may differ from the anchor's).
  5. Console: 0 Zod errors. React controlled inputs set via native setter; click and assertion in separate `browser_evaluate` calls (ui root CLAUDE.md). Clean up `.playwright-mcp/` + root pngs before merge.

---

## Self-review (done while writing — recorded for the executor)

- **Spec coverage:** §3 scope (open+fixed only, RunDialog only) → Task 3 gate + Task 3 `it.each` lock-in + Task 4 ScheduleForm-unchanged. §4.2 3-tier sources → Task 2 component precedence + tests. §5.1 anchor (`is_open_loop` positive, p50>0 guard) → Task 1 `pickLatestOpenRun` tests + Task 2 `usePriorOpenRunAnchor`. §5.2 formula + guards + 10000 cap → Task 1 `recommendSlots` tests + Task 2 over-cap test. §7.4 copy → Task 2 `ko.slotSizing` + render-text assertions. §8 file list → Tasks 1-4 file map. §9 test strategy → per-task tests + post-impl review/live. §6 byte-identical → no engine/proto/controller/migration/Zod touched (verify in review).
- **Placeholder scan:** none — every step has complete code.
- **Type consistency:** `recommendSlots(targetRps, latencyMs): { recommendedSlots } | null` used identically in Task 1 (def/tests) and Task 2 (call). `pickLatestOpenRun(runs): Run | null` same. `onApplyMaxInFlight?: (n: number) => void` prop name identical in LoadModelFields Props (Task 3), its render call (Task 3), and RunDialog wiring (Task 4). `SlotSizingHelper` props `{ scenarioId, env, targetRps, onApply }` identical across component (Task 2), LoadModelFields render (Task 3), and RunDialog mock (Task 4 `onApply`).
