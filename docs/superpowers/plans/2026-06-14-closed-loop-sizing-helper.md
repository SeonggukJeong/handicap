# 닫힌 루프 생성 시점 VU 사이징 헬퍼 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog 닫힌 루프 **균등 VU** 모드에 "목표 RPS → 권장 VU" 사이징 헬퍼를 추가한다(Little's Law 역산, 기존 test-run·최근 run 재사용, 권장값=하한).

**Architecture:** 순수 UI 슬라이스. 순수 계산(`sizing.ts`) + 자족 컴포넌트(`VuSizingHelper.tsx`, 최근-run 앵커 훅 co-located) + `LoadModelFields`에 optional prop 4종(공유 컴포넌트라 RunDialog만 전달→스케줄 편집기 부재) + `ko.sizing` 문구. **엔진·워커·proto·controller·migration 무변경, run 생성 페이로드 byte-identical.**

**Tech Stack:** React + TypeScript + Zod + React Query + Vitest/RTL. 기존 훅(`useScenarioRuns`/`useRunReport`/`useScenario`/`useTestRun`)·`flattenHttpSteps`·`resolveEnv`·`ko.ts`(ADR-0035) 재사용.

**Spec:** `docs/superpowers/specs/2026-06-14-closed-loop-sizing-helper-design.md` (spec-plan-reviewer 2라운드 APPROVE).

---

## 파일 구조

| 파일 | 책임 | 액션 |
|---|---|---|
| `ui/src/components/sizing.ts` | 순수 계산: `recommendVus`(Little's Law)·`pickLatestClosedRun`(앵커 후보 선택)·타입 | Create |
| `ui/src/components/__tests__/sizing.test.ts` | 순수 함수 단위 테스트 | Create |
| `ui/src/components/VuSizingHelper.tsx` | 프레젠테이션 + 자족 fetch(`usePriorClosedRunAnchor` co-located) + `recommendVus` 호출 | Create |
| `ui/src/components/__tests__/VuSizingHelper.test.tsx` | 컴포넌트 테스트(앵커/추정/측정/적용/race/폴백) | Create |
| `ui/src/i18n/ko.ts` | `ko.sizing` 네임스페이스 추가 | Modify |
| `ui/src/components/LoadModelFields.tsx` | optional prop 4종 + closed+fixed에 헬퍼 조건부 렌더 | Modify |
| `ui/src/components/RunDialog.tsx` | `LoadModelFields`에 sizing prop 4종 전달 | Modify |
| `ui/src/components/__tests__/LoadModelFields.test.tsx` | 헬퍼 게이트(onApplyVus 있을 때만 렌더) | Modify |

**커밋 경계**: 4 task = 4 커밋(전부 UI-only). 각 커밋은 pre-commit UI 게이트(`pnpm lint && pnpm test && pnpm build`)를 통과해야 한다. TDD-guard 회피: 각 task의 Step 1이 *테스트 파일*을 먼저 만들어(또는 기존 테스트 수정) 같은 task의 src 편집을 unblock한다.

---

### Task 1: 순수 계산 `sizing.ts`

**Files:**
- Create: `ui/src/components/sizing.ts`
- Test: `ui/src/components/__tests__/sizing.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/components/__tests__/sizing.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { recommendVus, pickLatestClosedRun } from "../sizing";
import type { Run } from "../../api/schemas";

describe("recommendVus", () => {
  it("prior: 선형 스케일 (VU 50→200 RPS, 목표 400 → 100)", () => {
    expect(recommendVus(400, { kind: "prior", priorVus: 50, priorRps: 200 })).toEqual({
      recommendedVus: 100,
      rpsPerVu: 4,
      basis: "prior",
    });
  });

  it("measured: 1요청/250ms → 4 rps/vu, 목표 400 → 100", () => {
    const r = recommendVus(400, { kind: "measured", reqPerIter: 1, iterMs: 250 });
    expect(r?.recommendedVus).toBe(100);
    expect(r?.basis).toBe("measured");
  });

  it("ceil + 최소 1", () => {
    expect(recommendVus(1, { kind: "prior", priorVus: 50, priorRps: 200 })?.recommendedVus).toBe(1);
    expect(recommendVus(401, { kind: "prior", priorVus: 50, priorRps: 200 })?.recommendedVus).toBe(101);
  });

  it("가드 → null", () => {
    expect(recommendVus(0, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // target<1
    expect(recommendVus(1_000_001, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // target>max
    expect(recommendVus(1.5, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // 비정수
    expect(recommendVus(400, { kind: "estimate", reqPerIter: 0, iterMs: 250 })).toBeNull(); // rpsPerVu 0
    expect(recommendVus(400, { kind: "measured", reqPerIter: 1, iterMs: 0 })).toBeNull(); // iterMs 0 → Inf
    expect(recommendVus(400, { kind: "prior", priorVus: 0, priorRps: 200 })).toBeNull(); // div0 → Inf
  });
});

describe("pickLatestClosedRun", () => {
  // pickLatestClosedRun이 읽는 필드(status/profile.vus/created_at)만 가진 최소 fixture를 cast.
  const mk = (vus: number, created_at: number, status = "completed"): Run =>
    ({ id: `r${created_at}`, status, profile: { vus }, created_at } as unknown as Run);

  it("vus>0인 completed 중 최신 선택 (vus==0=open/curve, 비완료 제외)", () => {
    const runs = [
      mk(10, 100),
      mk(50, 300),
      mk(0, 400), // open-loop 또는 VU곡선 → 제외
      mk(20, 500, "running"), // 비완료 → 제외
    ];
    expect(pickLatestClosedRun(runs)?.profile.vus).toBe(50);
  });

  it("해당 run 없으면 null", () => {
    expect(pickLatestClosedRun([mk(0, 1), mk(5, 2, "failed")])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test sizing`
Expected: FAIL — `Failed to resolve import "../sizing"`.

- [ ] **Step 3: Write the implementation**

`ui/src/components/sizing.ts`:
```ts
import type { Run } from "../api/schemas";

/** RunDialog 닫힌 루프 사이징 헬퍼의 순수 계산. React 의존 없음 — 단위 테스트 대상.
 *  Little's Law: closed-loop에서 목표 RPS를 내려면 VU ≈ 목표RPS ÷ (VU당 RPS). */

export type ThroughputSource =
  | { kind: "prior"; priorVus: number; priorRps: number }
  | { kind: "measured"; reqPerIter: number; iterMs: number }
  | { kind: "estimate"; reqPerIter: number; iterMs: number };

export type SizingResult = {
  recommendedVus: number;
  rpsPerVu: number;
  basis: ThroughputSource["kind"];
};

/** 목표 RPS 유효 범위 = loadModelErrors의 targetRps와 동일(정수 1..=1_000_000). */
function targetRpsValid(targetRps: number): boolean {
  return Number.isInteger(targetRps) && targetRps >= 1 && targetRps <= 1_000_000;
}

function rpsPerVuOf(src: ThroughputSource): number {
  if (src.kind === "prior") return src.priorRps / src.priorVus;
  return src.reqPerIter / (src.iterMs / 1000);
}

/** 목표 RPS + 처리량 출처 → 권장 VU(하한). 계산 불가(목표 무효/처리량 0·NaN·Inf)면 null. */
export function recommendVus(targetRps: number, src: ThroughputSource): SizingResult | null {
  if (!targetRpsValid(targetRps)) return null;
  const rpsPerVu = rpsPerVuOf(src);
  if (!Number.isFinite(rpsPerVu) || rpsPerVu <= 0) return null;
  const recommendedVus = Math.max(1, Math.ceil(targetRps / rpsPerVu));
  return { recommendedVus, rpsPerVu, basis: src.kind };
}

/** 가장 최근 종료(completed)된 균등-VU(closed+fixed) run.
 *  open-loop·VU곡선은 profile.vus==0이라(loadModel.ts:54 build, api/runs.rs:215 validate)
 *  vus>0 한 조건이 둘 다 제외해 단일-VU 권장에 적합한 앵커만 남긴다. 없으면 null. */
export function pickLatestClosedRun(runs: Run[]): Run | null {
  let best: Run | null = null;
  for (const r of runs) {
    if (r.status !== "completed") continue;
    if (r.profile.vus <= 0) continue;
    if (best === null || r.created_at > best.created_at) best = r;
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm test sizing`
Expected: PASS (모든 케이스).

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/closed-loop-sizing-helper
git add ui/src/components/sizing.ts ui/src/components/__tests__/sizing.test.ts
git commit -m "feat(ui): VU 사이징 순수 계산 recommendVus + pickLatestClosedRun

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```
Expected: pre-commit UI 게이트(lint/test/build) green, 커밋 landed.

---

### Task 2: `VuSizingHelper.tsx` 컴포넌트 + `ko.sizing` 문구

**Files:**
- Create: `ui/src/components/VuSizingHelper.tsx`
- Modify: `ui/src/i18n/ko.ts` (`ko.sizing` 추가)
- Test: `ui/src/components/__tests__/VuSizingHelper.test.tsx`

> **TDD-guard 노트**: Step 1이 테스트 파일을 먼저 만들어 이 task의 `ko.ts`·`VuSizingHelper.tsx` 편집을 unblock한다.

- [ ] **Step 1: Write the failing test**

`ui/src/components/__tests__/VuSizingHelper.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VuSizingHelper } from "../VuSizingHelper";
import type { Scenario } from "../../scenario/model";

vi.mock("../../api/hooks", () => ({
  useScenarioRuns: vi.fn(),
  useRunReport: vi.fn(),
  useScenario: vi.fn(),
  useTestRun: vi.fn(),
}));
import { useScenarioRuns, useRunReport, useScenario, useTestRun } from "../../api/hooks";

// http step 1개짜리 최소 시나리오 모델(flattenHttpSteps → reqPerIter 1).
const scenario = {
  version: 1,
  steps: [
    { id: "0123456789ABCDEFGHJKMNPQRS", type: "http", name: "a", request: { method: "GET", url: "http://x/a", headers: {} } },
  ],
} as unknown as Scenario;

const completedRun = (vus: number, created_at: number) =>
  ({ id: `r${created_at}`, status: "completed", profile: { vus }, created_at }) as unknown as never;

function setHooks(opts: { runs?: unknown[]; reportRps?: number | null; yaml?: string; testRun?: unknown }) {
  (useScenarioRuns as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ data: { runs: opts.runs ?? [] } });
  (useRunReport as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: opts.reportRps != null ? { summary: { rps: opts.reportRps } } : undefined,
  });
  (useScenario as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ data: { yaml: opts.yaml ?? "version: 1\nsteps: []\n" } });
  (useTestRun as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    opts.testRun ?? { mutate: vi.fn(), isPending: false, isError: false, data: undefined },
  );
}

beforeEach(() => vi.clearAllMocks());

describe("VuSizingHelper", () => {
  it("최근 run 앵커: 목표 RPS 프리필 + 권장 VU(선형)", async () => {
    setHooks({ runs: [completedRun(50, 100)], reportRps: 200 });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    const input = (await screen.findByLabelText("목표 RPS")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("200"));
    expect(screen.getByText(/권장 VU: 최소 ~50개부터/)).toBeInTheDocument();
  });

  it("목표를 올리면 권장이 스케일, 적용→onApply", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    setHooks({ runs: [completedRun(50, 100)], reportRps: 200 });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={onApply} />);
    const input = (await screen.findByLabelText("목표 RPS")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("200"));
    await user.clear(input);
    await user.type(input, "400");
    expect(screen.getByText(/권장 VU: 최소 ~100개부터/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(100);
  });

  it("사용자가 먼저 입력하면 비동기 앵커가 덮어쓰지 않음", async () => {
    const user = userEvent.setup();
    setHooks({ runs: [completedRun(50, 100)], reportRps: null }); // 앵커 아직 없음(report 미도착)
    const { rerender } = render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    const input = screen.getByLabelText("목표 RPS") as HTMLInputElement;
    await user.type(input, "999");
    setHooks({ runs: [completedRun(50, 100)], reportRps: 200 }); // 이제 앵커 도착
    rerender(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    expect(input.value).toBe("999"); // 시드 스킵
  });

  it("앵커 없음: 추정 지연 입력으로 권장 + 한계 문구", async () => {
    const user = userEvent.setup();
    setHooks({ runs: [], reportRps: null });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    await user.type(screen.getByLabelText("목표 RPS"), "400");
    await user.type(screen.getByLabelText("1회 반복 예상 지연(ms)"), "250");
    expect(screen.getByText(/권장 VU: 최소 ~100개부터/)).toBeInTheDocument();
    expect(screen.getByText(/부하 없는 1회 실행/)).toBeInTheDocument();
  });

  it("측정 버튼 → test-run 발사; truncated면 측정 거부", async () => {
    const mutate = vi.fn();
    const user = userEvent.setup();
    setHooks({
      runs: [],
      reportRps: null,
      testRun: { mutate, isPending: false, isError: false, data: { truncated: true, total_ms: 10, steps: [] } },
    });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "test-run으로 측정" }));
    expect(mutate).toHaveBeenCalled();
    expect(screen.getByText(/측정이 잘렸어요/)).toBeInTheDocument();
  });

  it("측정(비-truncated) → R/T로 권장", async () => {
    const user = userEvent.setup();
    setHooks({
      runs: [],
      reportRps: null,
      testRun: {
        mutate: vi.fn(),
        isPending: false,
        isError: false,
        data: { truncated: false, total_ms: 250, steps: [{ response: { status: 200 } }] },
      },
    });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    await user.type(screen.getByLabelText("목표 RPS"), "400");
    expect(screen.getByText(/요청 1개 · 250ms/)).toBeInTheDocument();
    expect(screen.getByText(/권장 VU: 최소 ~100개부터/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test VuSizingHelper`
Expected: FAIL — `Failed to resolve import "../VuSizingHelper"`.

- [ ] **Step 3: Add `ko.sizing` 문구**

`ui/src/i18n/ko.ts` — `saturation: {...}` 블록 바로 뒤(닫는 `} as const;` 직전)에 추가:
```ts
  // 닫힌 루프 생성 시점 VU 사이징 헬퍼. 조사 병기((으)로 등) — 변수 뒤 조사 고정 금지(ADR-0035).
  sizing: {
    title: "VU 사이징 도우미",
    helpLabel: "VU 사이징 도우미 설명",
    help: "목표 RPS를 입력하면 필요한 동시 사용자(VU) 수를 추정해 드려요. 권장값은 최소 출발점이에요.",
    targetRps: "목표 RPS",
    estMs: "1회 반복 예상 지연(ms)",
    measureBtn: "test-run으로 측정",
    measuring: "측정 중…",
    measureCaveat:
      "방금 측정은 부하 없는 1회 실행이라 실제보다 빨라요. 부하가 걸리면 더 느려질 수 있어, 이 권장값은 최소 출발점이에요.",
    truncated: "시나리오가 길어 측정이 잘렸어요 — 1회 반복 지연을 직접 입력하세요.",
    measureError: "측정에 실패했어요. 환경 변수(${BASE_URL} 등)와 시나리오를 확인하세요.",
    fromPriorRun: (vus: number, rps: number) =>
      `지난 실행(VU ${vus}개 → ${rps} RPS) 기준 추정이에요. 목표를 바꾸면 권장 VU가 함께 바뀌어요.`,
    measured: (req: number, ms: number) => `측정됨: 1회 반복에 요청 ${req}개 · ${ms}ms`,
    recommend: (n: number) => `권장 VU: 최소 ~${n}개부터`,
    apply: "적용",
    cannotCompute: "측정값이 0이라 계산할 수 없어요 — 1회 반복 지연을 직접 입력하세요.",
    overCapacity: "이 값은 워커 용량(기본 2,000)을 넘을 수 있어요.",
  },
```

- [ ] **Step 4: Write `VuSizingHelper.tsx`**

`ui/src/components/VuSizingHelper.tsx`:
```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useScenario, useScenarioRuns, useRunReport, useTestRun } from "../api/hooks";
import type { Scenario } from "../scenario/model";
import { flattenHttpSteps } from "../scenario/model";
import { pickLatestClosedRun, recommendVus, type ThroughputSource } from "./sizing";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";

const INPUT = "mt-1 block w-full rounded border border-slate-300 px-2 py-1";

/** 최근 종료 균등-VU run에서 처리량 앵커(VU·달성RPS)를 도출. 없으면 null.
 *  반환값은 useMemo로 안정화 — 소비처 useEffect([anchor])가 값 변화에만 발화. */
export function usePriorClosedRunAnchor(
  scenarioId: string | undefined,
): { vus: number; rps: number } | null {
  const runs = useScenarioRuns(scenarioId);
  const latest = useMemo(() => pickLatestClosedRun(runs.data?.runs ?? []), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const vus = latest?.profile.vus ?? 0;
  const rps = report.data?.summary.rps ?? 0;
  return useMemo(() => (vus > 0 && rps > 0 ? { vus, rps } : null), [vus, rps]);
}

type Props = {
  scenarioId: string;
  scenario: Scenario | null;
  env: Record<string, string>;
  onApply: (vus: number) => void;
};

export function VuSizingHelper({ scenarioId, scenario, env, onApply }: Props) {
  const anchor = usePriorClosedRunAnchor(scenarioId);
  const scenarioQ = useScenario(scenarioId);
  const testRun = useTestRun();

  const [targetRps, setTargetRps] = useState("");
  const [estMs, setEstMs] = useState("");
  const touchedRef = useRef(false);
  const seededRef = useRef(false);

  // 비동기 1회 시드: 앵커가 늦게 도착 + 사용자가 목표칸을 안 건드렸을 때만 1회(덮어쓰기 race 회피).
  useEffect(() => {
    if (anchor && !touchedRef.current && !seededRef.current) {
      seededRef.current = true;
      setTargetRps(String(Math.round(anchor.rps)));
    }
  }, [anchor]);

  // test-run 측정(비-truncated): trace에서 정확한 요청수 R + 반복지연 T.
  const trace = testRun.data;
  const measured =
    trace && !trace.truncated
      ? { reqPerIter: trace.steps.filter((s) => s.response !== null).length, iterMs: trace.total_ms }
      : null;
  const truncated = trace?.truncated ?? false;

  const staticReqPerIter = scenario ? flattenHttpSteps(scenario.steps).length : 0;
  const estMsNum = Number(estMs);

  // 처리량 출처 우선순위: prior > 수동 추정(estMs 입력) > 측정.
  const src: ThroughputSource | null = anchor
    ? { kind: "prior", priorVus: anchor.vus, priorRps: anchor.rps }
    : estMs.trim() !== "" && Number.isFinite(estMsNum) && estMsNum > 0
      ? { kind: "estimate", reqPerIter: staticReqPerIter, iterMs: estMsNum }
      : measured
        ? { kind: "measured", reqPerIter: measured.reqPerIter, iterMs: measured.iterMs }
        : null;

  const result = src ? recommendVus(Number(targetRps), src) : null;

  const runMeasure = () => {
    const yaml = scenarioQ.data?.yaml;
    if (!yaml) return;
    testRun.mutate({ scenario_yaml: yaml, env });
  };

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-sm font-medium text-slate-700">{ko.sizing.title}</span>
        <HelpTip label={ko.sizing.helpLabel}>{ko.sizing.help}</HelpTip>
      </div>

      <label className="block text-sm mb-2">
        <span className="text-slate-600">{ko.sizing.targetRps}</span>
        <input
          type="number"
          min={1}
          max={1000000}
          value={targetRps}
          onChange={(e) => {
            touchedRef.current = true;
            setTargetRps(e.target.value);
          }}
          className={INPUT}
          aria-label={ko.sizing.targetRps}
        />
      </label>

      {anchor ? (
        <p className="text-xs text-slate-500 mb-2">
          {ko.sizing.fromPriorRun(anchor.vus, Math.round(anchor.rps))}
        </p>
      ) : (
        <div className="mb-2">
          <label className="block text-sm">
            <span className="text-slate-600">{ko.sizing.estMs}</span>
            <input
              type="number"
              min={1}
              value={estMs}
              onChange={(e) => setEstMs(e.target.value)}
              className={INPUT}
              aria-label={ko.sizing.estMs}
            />
          </label>
          <button
            type="button"
            onClick={runMeasure}
            disabled={testRun.isPending || !scenarioQ.data?.yaml}
            className="mt-1 text-sm text-blue-600 hover:underline disabled:opacity-40"
          >
            {testRun.isPending ? ko.sizing.measuring : ko.sizing.measureBtn}
          </button>
          <p className="text-xs text-amber-700 mt-1">{ko.sizing.measureCaveat}</p>
          {truncated && (
            <p role="alert" className="text-xs text-red-600 mt-1">
              {ko.sizing.truncated}
            </p>
          )}
          {testRun.isError && (
            <p role="alert" className="text-xs text-red-600 mt-1">
              {ko.sizing.measureError}
            </p>
          )}
          {measured && (
            <p className="text-xs text-slate-500 mt-1">
              {ko.sizing.measured(measured.reqPerIter, measured.iterMs)}
            </p>
          )}
        </div>
      )}

      {result ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-700">{ko.sizing.recommend(result.recommendedVus)}</span>
          <button
            type="button"
            onClick={() => onApply(result.recommendedVus)}
            className="rounded bg-indigo-600 px-2 py-1 text-sm text-white hover:bg-indigo-700"
          >
            {ko.sizing.apply}
          </button>
        </div>
      ) : (
        targetRps.trim() !== "" && <p className="text-xs text-slate-500">{ko.sizing.cannotCompute}</p>
      )}
      {result && result.recommendedVus > 2000 && (
        <p className="text-xs text-amber-700 mt-1">{ko.sizing.overCapacity}</p>
      )}
    </div>
  );
}
```

> **타입 노트**: `Scenario`는 `../scenario/model`(steps 보유, `flattenHttpSteps`용) — `../api/schemas`의 `Scenario`(yaml만) 아님. `trace.steps[].response`는 `.nullable()`(schemas.ts:457)이라 `=== null` 비교는 안전(undefined 아님). `useTestRun().mutate` body는 `{ scenario_yaml, env }`(client.ts:144, `max_requests`/`apply_think_time` 생략 = 서버 기본).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && pnpm test VuSizingHelper`
Expected: PASS (6 케이스).

- [ ] **Step 6: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/closed-loop-sizing-helper
git add ui/src/components/VuSizingHelper.tsx ui/src/components/__tests__/VuSizingHelper.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): VuSizingHelper 컴포넌트 + ko.sizing 문구

최근 closed run 앵커(usePriorClosedRunAnchor)·test-run 측정·수동 추정 3계층,
비동기 1회 시드(touchedRef) race 가드, truncated 거부, 권장값=하한.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```
Expected: UI 게이트 green, 커밋 landed.

---

### Task 3: `LoadModelFields` optional prop + 조건부 렌더, `RunDialog` 배선

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx` (Props 4종 + 렌더)
- Modify: `ui/src/components/RunDialog.tsx` (`<LoadModelFields>` call site `errs={loadErrs}` 줄 :506에 4 prop 전달)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx` (게이트), `ui/src/components/__tests__/RunDialog.test.tsx` (헬퍼 inert 모킹)

> **TDD-guard 노트**: Step 1이 기존 `LoadModelFields.test.tsx`를 *수정*(새 it 추가)해 pending diff를 만든 뒤 src 편집 → unblock.

- [ ] **Step 1: Write the failing test (게이트)**

**(a)** `ui/src/components/__tests__/LoadModelFields.test.tsx` — 파일 맨 위 import 직후에 `VuSizingHelper` 모킹 추가(실 헬퍼는 hook fetch가 있어 단위테스트 경계 오염):
```tsx
vi.mock("../VuSizingHelper", () => ({
  VuSizingHelper: () => <div data-testid="sizing-helper" />,
}));
```
그리고 `describe("LoadModelFields", ...)` 안에 **기존 `renderFields(overrides)` 헬퍼**(파일 :18 `setup`의 alias :46, 기본 closed+fixed)를 재사용해 두 케이스 추가:
```tsx
it("closed+fixed + onApplyVus 주어지면 사이징 헬퍼 렌더", () => {
  renderFields({ sizingScenarioId: "s1", sizingScenario: null, sizingEnv: {}, onApplyVus: vi.fn() });
  expect(screen.getByTestId("sizing-helper")).toBeInTheDocument();
});

it("onApplyVus 없으면(스케줄 편집기 경로) 헬퍼 미렌더", () => {
  renderFields(); // 기본 closed+fixed, sizing prop 없음 → ScheduleForm 경로와 동일
  expect(screen.queryByTestId("sizing-helper")).toBeNull();
});
```
> `render`/`screen`/`vi`는 이미 import돼 있으니 중복 추가 금지. `renderFields`는 `setup`의 alias(둘 다 사용 가능).

**(b)** `ui/src/components/__tests__/RunDialog.test.tsx` — **must-fix(reviewer)**: Task 3 배선 후 RunDialog 기본 모드가 closed+fixed(`deriveLoadMode({})`)라 모든 RunDialog 테스트가 **실 `VuSizingHelper`를 마운트** → `useScenarioRuns`/`useScenario`가 테스트 fetch mock에 Zod 파싱 실패로 떨어져 비결정적 노이즈. 파일 맨 위 import 직후에 inert 모킹 추가(단위 경계 유지):
```tsx
vi.mock("../VuSizingHelper", () => ({ VuSizingHelper: () => null }));
```
> 이 모킹은 헬퍼 자체 동작(Task 2 테스트가 검증)이 아니라 RunDialog **단위** 경계를 깨끗이 유지하기 위함. RunDialog↔헬퍼 실제 배선(적용→VU)은 Task 4 라이브에서 검증.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test LoadModelFields`
Expected: 첫 케이스 FAIL — `sizing-helper` testid 없음(아직 렌더 안 함). 둘째는 우연히 통과 가능.

- [ ] **Step 3: `LoadModelFields`에 optional prop 추가**

`ui/src/components/LoadModelFields.tsx`:
1) import 추가(파일 상단):
```tsx
import { VuSizingHelper } from "./VuSizingHelper";
import type { Scenario } from "../scenario/model";
```
2) `Props` 타입에 4 optional 필드 추가(`errs: LoadModelErrors;` 다음):
```tsx
  errs: LoadModelErrors;
  // 닫힌 루프 사이징 헬퍼(RunDialog 전용 — ScheduleForm은 미전달, §3.1).
  // model Scenario(steps 보유)지 api Scenario 아님.
  sizingScenarioId?: string;
  sizingScenario?: Scenario | null;
  sizingEnv?: Record<string, string>;
  onApplyVus?: (n: number) => void;
```
3) 구조분해 인자에 추가(`errs,` 다음):
```tsx
  errs,
  sizingScenarioId,
  sizingScenario,
  sizingEnv,
  onApplyVus,
}: Props) {
```

- [ ] **Step 4: closed+fixed 분기에 헬퍼 조건부 렌더**

`ui/src/components/LoadModelFields.tsx`의 closed+fixed 분기 — `{errs.rampInvalid && (...)}` 블록(현재 ~380–384줄) 바로 **다음**, 그 분기의 닫는 `</>` **앞**에 삽입:
```tsx
            {errs.rampInvalid && (
              <p id="ramp-up-error" className="mb-3 text-red-600 text-sm">
                {ko.validation.rampUp}
              </p>
            )}
            {onApplyVus && sizingScenarioId !== undefined && (
              <VuSizingHelper
                scenarioId={sizingScenarioId}
                scenario={sizingScenario ?? null}
                env={sizingEnv ?? {}}
                onApply={onApplyVus}
              />
            )}
          </>
        )
```

- [ ] **Step 5: `RunDialog` call site에 4 prop 전달**

`ui/src/components/RunDialog.tsx:506` — `errs={loadErrs}` 다음 줄에 추가(닫는 `/>` 앞):
```tsx
          errs={loadErrs}
          sizingScenarioId={scenarioId}
          sizingScenario={scenario}
          sizingEnv={env}
          onApplyVus={setVus}
        />
```
> `env`는 RunDialog.tsx:336에서 이미 `resolveEnv(baseVars, envEntries)`로 산출돼 스코프에 있다. `scenarioId`/`scenario`/`setVus`도 기존 prop·state.

- [ ] **Step 6: Run targeted tests**

Run: `cd ui && pnpm test LoadModelFields`
Expected: 두 케이스 PASS(헬퍼 렌더/미렌더).

- [ ] **Step 7: 전체 게이트 + commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/closed-loop-sizing-helper
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
git add ui/src/components/LoadModelFields.tsx ui/src/components/RunDialog.tsx ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog 닫힌 루프 균등 VU에 사이징 헬퍼 배선

LoadModelFields에 optional sizing prop 4종(RunDialog만 전달 → 공유 ScheduleForm엔
헬퍼 부재). run 생성 페이로드·다른 모드 렌더 무변경.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```
Expected: 전체 게이트 green(인자 없는 `pnpm test`로 RunDialog 등 다른 파일 회귀 0 — S-D 함정), 커밋 landed.

---

### Task 4: 라이브 검증 (Playwright, 커밋 없음)

> 머지 전 필수(S-D 갭: RTL fixture는 서버 `null`/응답경로를 못 잡음). 컨트롤러+워커를 **이 워크트리 자체 바이너리**로 띄운다.

- [ ] **Step 1: 워크트리 바이너리 빌드 + 기동**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/closed-loop-sizing-helper
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
cd ui && pnpm build && cd ..
# 50ms 지연 responder(p50>0 보장 — localhost sub-ms면 측정 폴백). 별도 터미널/백그라운드:
#   python3 -c "import time;from http.server import *;
#   class H(BaseHTTPRequestHandler):
#     def do_GET(s): time.sleep(0.05); s.send_response(200); s.end_headers(); s.wfile.write(b'ok')
#   ThreadingHTTPServer(('127.0.0.1',9999),H).serve_forever()" &
./target/debug/controller --db /tmp/sizing.db --ui-dir ui/dist &
```

- [ ] **Step 2: 시나리오 + 최근 run 준비**

`http://127.0.0.1:9999/` 한 스텝 시나리오를 만들고(`POST /api/scenarios`), closed+fixed run을 1개 완료시켜(`POST /api/runs {profile:{vus:5,duration_seconds:5}}`) 앵커 소스를 만든다. (curl 함정: 생성 응답 파싱 말고 `GET /api/scenarios/{id}/runs`로 재조회 — 루트 CLAUDE.md.)

- [ ] **Step 3: Playwright 검증 (인라인 evaluate, 저장-경로 의존 회피)**

`http://127.0.0.1:8080` → 시나리오 → 실행(RunDialog) → 닫힌 루프·고정. 확인:
- (a) **앵커 시나리오**: "목표 RPS"가 최근 run 달성 RPS로 프리필 + "지난 실행(VU 5개 → N RPS)" 문구. 목표를 2배로 올리면 "권장 VU: 최소 ~M개부터"가 ~2배. "적용" 클릭 → VU 입력칸 값이 권장값으로 바뀜(별도 evaluate로 click과 단언 분리 — React 배치).
- (b) **run 없는 새 시나리오**: 추정칸 + "test-run으로 측정" + 한계 문구. 측정 클릭 → "측정됨: 요청 1개 · ~50ms" + 권장값 표시.
- (c) **run 생성 무회귀**: 적용 후 Run 생성 → completed → 리포트 정상. 콘솔 Zod 에러 0(`browser_console_messages`).
- React controlled input은 native setter로(루트 CLAUDE.md). 정리: `rm -rf .playwright-mcp` + 루트 png.

- [ ] **Step 4: 정리**

controller/responder 종료(`kill`), `/tmp/sizing.db` 삭제, `.playwright-mcp`/png 정리.

---

## Self-Review (작성자 체크)

**Spec coverage**: §3(범위 closed+fixed·RunDialog 전용=Task 3 게이트)·§3.1(공유 컴포넌트 optional prop=Task 3)·§4(목표RPS 임시입력·3계층 출처=Task 2)·§5(recommendVus·pickLatestClosedRun·가드=Task 1)·§5.1(앵커 훅 무조건 호출=Task 2 usePriorClosedRunAnchor)·§7.2(비동기 1회 시드 touchedRef/seededRef=Task 2)·§7.3(적용 버튼=Task 2)·§7.4(한계/floor 문구 ko.sizing=Task 2)·§4.2 truncated 가드(Task 2)·§9 테스트·라이브(Task 1–4). 모든 요구에 task 매핑됨.

**Placeholder scan**: TBD/TODO 없음. 모든 step에 실제 코드·명령·기대출력.

**Type consistency**: `recommendVus`/`pickLatestClosedRun`/`ThroughputSource`/`SizingResult`(Task 1) ↔ `VuSizingHelper`/`usePriorClosedRunAnchor`(Task 2)에서 동일 시그니처 사용. `onApplyVus`/`sizingScenarioId`/`sizingScenario`/`sizingEnv`(Task 3 Props) ↔ RunDialog call site 일치. ko.sizing 키(title/help/targetRps/estMs/measureBtn/measuring/measureCaveat/truncated/measureError/fromPriorRun/measured/recommend/apply/cannotCompute/overCapacity) ↔ 컴포넌트 참조 1:1.
