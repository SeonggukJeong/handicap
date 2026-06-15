# 열린 루프 worker_count create-time 사이징 헬퍼 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog 열린 루프(open, 고정·곡선) `worker_count` 접이식 필드 옆에서 run을 돌리기 전에 "권장 워커 수"를 미리 답한다 — prior open-loop run의 관측 throughput 천장(`peak`)·워커 수로 외삽하는 하이브리드 3-tier(강한/약한/근거 없음) + cross-field 안전 경고.

**Architecture:** 순수 UI 슬라이스. 신규 자족 `WorkerSizingHelper`(슬롯 헬퍼 `SlotSizingHelper` 골격 미러, 단 measure/estMs 경로 없음) + `sizing.ts` 순수 함수 2개(`peakThroughput`/`recommendWorkers`) + `LoadModelFields`의 worker_count 단일 공유 disclosure에 렌더 + `ko.workerSizing` 카탈로그. 권장식 `N = ceil(target × prior_wc / peak)`은 사후 `load_gen_saturated`의 `recommended_workers`(`insights.rs:246-253`)와 수식 1:1. **엔진·워커·proto·controller·migration·Zod 와이어 무변경, run 페이로드 byte-identical — 머지 diff는 `ui/` 한정.**

**Tech Stack:** TypeScript/React, Vitest + React Testing Library, `ko.ts` 메시지 카탈로그(ADR-0035).

**Spec:** `docs/superpowers/specs/2026-06-15-worker-count-sizing-helper-design.md`

**커밋 경계 주의(루트 CLAUDE.md):** UI-only 커밋이라 pre-commit은 cargo 게이트를 skip하고 **UI 게이트(`pnpm lint && pnpm test && pnpm build`)** 만 돈다(`ui/node_modules` 있을 때). 각 Task는 **green 단일 커밋**으로 fold(RED 테스트만 단독 커밋하면 `pnpm test` 게이트가 막는다 — 로컬에서 RED→GREEN 확인하되 커밋은 1회). 커밋은 파이프(`| tail`) 없이 — git exit code 마스킹 방지, 직후 `git log -1`로 landed 확인. TDD-guard: src(`ui/src/*.ts(x)`) 편집 전 워크트리에 pending 테스트 파일이 있어야 하므로 **각 Task는 테스트 파일을 먼저 수정/생성**(test-path 파일이라 자동 unblock — Task 2의 ko.ts/컴포넌트는 신규 `WorkerSizingHelper.test.tsx`가, Task 3의 LoadModelFields/RunDialog는 `LoadModelFields.test.tsx` 편집이 unblock).

**작업 디렉터리:** `/Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper` (worktree — 구현 세션의 `/start-slice`가 생성). 모든 명령은 여기서. `cd ui && pnpm install` + `cargo build --workspace`(baseline) 선행(A1 함정 — 새 워크트리엔 node_modules/target 없음).

---

## File Structure

- **Modify** `ui/src/components/sizing.ts` — 순수 함수 `peakThroughput(windows)`·`recommendWorkers(target, priorPeak, priorWorkerCount)` + 타입 `WorkerSizingResult` 추가(끝에). 기존 `targetRpsValid`/`recommendSlots`/`pickLatestOpenRun`/`peakStageTarget` 무변경.
- **Modify** `ui/src/components/__tests__/sizing.test.ts` — `peakThroughput`·`recommendWorkers` describe 블록 추가.
- **Modify** `ui/src/i18n/ko.ts` — `ko.slotSizing` 블록 뒤에 `ko.workerSizing` 객체 추가.
- **Create** `ui/src/components/WorkerSizingHelper.tsx` — 자족 컴포넌트 + co-located `usePriorOpenRunWorkerAnchor` 훅.
- **Create** `ui/src/components/__tests__/WorkerSizingHelper.test.tsx` — 3 tier + cross-field + 하드캡 + peakBased + HelpTip 테스트.
- **Modify** `ui/src/components/LoadModelFields.tsx` — `onApplyWorkerCount?: (n:number)=>void` prop 추가 + worker_count 공유 disclosure에 `<WorkerSizingHelper>` 렌더.
- **Modify** `ui/src/components/__tests__/LoadModelFields.test.tsx` — worker 헬퍼 lock-in(open 두 모드 렌더 / closed·ScheduleForm 미렌더) 추가.
- **Modify** `ui/src/components/RunDialog.tsx` — `<LoadModelFields … onApplyWorkerCount={(n)=>setWorkerCount(String(n))} />` 1줄 추가.
- **Modify** `ui/src/components/__tests__/RunDialog.test.tsx` — `vi.mock("../WorkerSizingHelper", () => ({ WorkerSizingHelper: () => null }))` 추가(기존 Vu/Slot 헬퍼 mock 패턴 패리티).

**무변경(명시)**: `ScheduleForm.tsx`(미전달 → 헬퍼 부재), `sizing.ts`의 기존 함수, `schemas.ts`(worker_count `.max(64)` 이미 있음), `loadModel.ts`, 엔진/워커/proto/controller/migration.

---

## Task 1: `peakThroughput` + `recommendWorkers` 순수 함수 (`sizing.ts`)

**Files:**
- Modify: `ui/src/components/sizing.ts` (끝에 추가)
- Test: `ui/src/components/__tests__/sizing.test.ts` (import 줄 + 끝에 describe)

- [ ] **Step 1: 실패 테스트 작성**

`ui/src/components/__tests__/sizing.test.ts`의 import 줄(파일 상단)에 `peakThroughput`·`recommendWorkers`를 추가한다. 현재 import는:

```ts
import {
  recommendVus,
  pickLatestClosedRun,
  recommendSlots,
  pickLatestOpenRun,
  peakStageTarget,
} from "../sizing";
```

아래로 교체:

```ts
import {
  recommendVus,
  pickLatestClosedRun,
  recommendSlots,
  pickLatestOpenRun,
  peakStageTarget,
  peakThroughput,
  recommendWorkers,
} from "../sizing";
```

파일 끝(마지막 `});` 다음 줄)에 추가:

```ts
describe("peakThroughput", () => {
  it("빈 배열 → 0", () => {
    expect(peakThroughput([])).toBe(0);
  });

  it("초별 Σcount의 최대 (평균/총합 아님 — insights.rs by_sec와 동형)", () => {
    // ts1 합=4, ts2 합=5+4=9 (peak), ts3 합=3
    expect(
      peakThroughput([
        { ts_second: 1, count: 4 },
        { ts_second: 2, count: 5 },
        { ts_second: 2, count: 4 },
        { ts_second: 3, count: 3 },
      ]),
    ).toBe(9);
  });

  it("단일 초 여러 스텝 행 → 그 초 합", () => {
    expect(
      peakThroughput([
        { ts_second: 7, count: 100 },
        { ts_second: 7, count: 50 },
      ]),
    ).toBe(150);
  });

  it("정렬 무관", () => {
    expect(
      peakThroughput([
        { ts_second: 3, count: 3 },
        { ts_second: 1, count: 9 },
        { ts_second: 2, count: 5 },
      ]),
    ).toBe(9);
  });
});

describe("recommendWorkers", () => {
  it("기본: ceil(target × wc / peak) — ADR-0038 라이브 수치", () => {
    // target 2000, peak 790, wc 2 → ceil(4000/790)=ceil(5.06)=6
    expect(recommendWorkers(2000, 790, 2)?.recommendedWorkers).toBe(6);
  });

  it("단일 워커 prior", () => {
    // target 1000, peak 200, wc 1 → ceil(5)=5
    expect(recommendWorkers(1000, 200, 1)?.recommendedWorkers).toBe(5);
  });

  it("floor 1 (target 작아 0이 안 됨)", () => {
    expect(recommendWorkers(10, 1000, 1)?.recommendedWorkers).toBe(1);
  });

  it("무효: 목표 무효(0·비정수·범위 밖) → null", () => {
    expect(recommendWorkers(0, 200, 1)).toBeNull();
    expect(recommendWorkers(1.5, 200, 1)).toBeNull();
    expect(recommendWorkers(2_000_000, 200, 1)).toBeNull();
  });

  it("무효: peak <= 0 / NaN / Inf → null", () => {
    expect(recommendWorkers(1000, 0, 1)).toBeNull();
    expect(recommendWorkers(1000, -5, 1)).toBeNull();
    expect(recommendWorkers(1000, NaN, 1)).toBeNull();
    expect(recommendWorkers(1000, Infinity, 1)).toBeNull();
  });

  it("무효: prior_wc < 1 또는 비정수 → null", () => {
    expect(recommendWorkers(1000, 200, 0)).toBeNull();
    expect(recommendWorkers(1000, 200, 1.5)).toBeNull();
  });

  it("parity: recommendWorkers == insights.rs:250 산술 ceil(t/(peak/wc))", () => {
    // 대수적으로 ceil(t/(peak/wc)) == ceil(t*wc/peak)지만 IEEE-754에선 항상 bit-identical은
    // 아니다 — 이 값(2000/790/2 → 둘 다 6)에선 일치(값 특정 단언).
    const t = 2000;
    const peak = 790;
    const wc = 2;
    const insightsM = Math.ceil(t / (peak / wc));
    expect(recommendWorkers(t, peak, wc)?.recommendedWorkers).toBe(insightsM);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper/ui && pnpm test sizing`
Expected: FAIL — `peakThroughput`/`recommendWorkers` 미정의(import 에러 또는 `is not a function`).

- [ ] **Step 3: 구현**

`ui/src/components/sizing.ts` 파일 끝에 추가(기존 `peakStageTarget` 다음):

```ts
/** 열린 루프 워커 수(worker_count) create-time 사이징의 순수 계산. (ADR-0038 멀티워커 fan-out)
 *  워커당 RPS 천장은 워커를 포화시켰을 때만 관측되므로, prior open-loop run의 관측 peak/워커수로
 *  외삽한다. 사후 load_gen_saturated의 recommended_workers(insights.rs:246-253)와 수식 1:1. */

export type WorkerSizingResult = { recommendedWorkers: number };

/** report.windows(초별 (ts,step) count 행 — A3b 워커 머지 후)에서 초별 throughput 천장.
 *  초별 Σcount의 최대 = N워커 합산 초별 throughput peak. insights.rs:214-222 by_sec와 동형.
 *  빈 배열→0(앵커 peak>0 가드 뒤라 실제 도달 불가 — insights.rs는 summary.rps 폴백을 쓰지만
 *  이 헬퍼는 peak>0이 아니면 앵커가 null이라 그 분기로 안 간다). */
export function peakThroughput(windows: { ts_second: number; count: number }[]): number {
  const bySec = new Map<number, number>();
  for (const w of windows) {
    bySec.set(w.ts_second, (bySec.get(w.ts_second) ?? 0) + w.count);
  }
  let peak = 0;
  for (const v of bySec.values()) if (v > peak) peak = v;
  return peak;
}

/** 목표 RPS + prior run 관측 peak·워커수 → 권장 worker_count(하한).
 *  N = max(1, ceil(target × prior_wc / peak)). 각 워커에 prior가 증명한 속도(peak/wc) 이하만
 *  요구하므로 엔진 drop 측면 항상 안전(포화면 tight, 비포화면 보수적 상한). insights.rs:250
 *  ceil(t/(peak/wc))와 동일 산술. m>wc 발사 가드는 사후 전용(현재 wc 대비 증설 제안)이라
 *  create-time엔 없다 — 복원 금지. 무효(목표 무효 / peak<=0·NaN·Inf / wc<1·비정수)면 null. */
export function recommendWorkers(
  target: number,
  priorPeak: number,
  priorWorkerCount: number,
): WorkerSizingResult | null {
  if (!targetRpsValid(target)) return null;
  if (!Number.isFinite(priorPeak) || priorPeak <= 0) return null;
  if (!Number.isInteger(priorWorkerCount) || priorWorkerCount < 1) return null;
  const recommendedWorkers = Math.max(1, Math.ceil((target * priorWorkerCount) / priorPeak));
  return { recommendedWorkers };
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper/ui && pnpm test sizing`
Expected: PASS (기존 sizing 테스트 + 신규 11개).

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper/ui
pnpm lint && pnpm test sizing && pnpm build
cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper
git add ui/src/components/sizing.ts ui/src/components/__tests__/sizing.test.ts
git commit -m "feat(ui): peakThroughput + recommendWorkers 순수 함수 (worker_count 사이징)"
git log -1 --oneline
```
Expected: pre-commit UI 게이트 통과, 커밋 landed.

---

## Task 2: `ko.workerSizing` + `WorkerSizingHelper` 컴포넌트

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`ko.slotSizing` 뒤에 추가)
- Create: `ui/src/components/WorkerSizingHelper.tsx`
- Create (test 먼저): `ui/src/components/__tests__/WorkerSizingHelper.test.tsx`

- [ ] **Step 1: 실패 테스트 작성 (TDD-guard unblock — 이 파일이 pending test)**

`ui/src/components/__tests__/WorkerSizingHelper.test.tsx` 신규 생성:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkerSizingHelper } from "../WorkerSizingHelper";

// 앵커 훅이 쓰는 React Query 훅 스텁 — 슬롯 헬퍼 테스트 패턴.
vi.mock("../../api/hooks", () => ({
  useScenarioRuns: vi.fn(),
  useRunReport: vi.fn(),
}));
import { useScenarioRuns, useRunReport } from "../../api/hooks";

/** anchor=null이면 prior run 없음(빈 runs). 아니면 dropped/peak/wc를 가진 완료 open-loop run. */
function setHooks(anchor: { dropped: number; peak: number; priorWorkerCount: number } | null) {
  (useScenarioRuns as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: {
      runs:
        anchor == null
          ? []
          : [
              {
                id: "r1",
                status: "completed",
                created_at: 1,
                profile: { vus: 0, target_rps: 100, worker_count: anchor.priorWorkerCount },
              },
            ],
    },
  });
  (useRunReport as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data:
      anchor == null
        ? undefined
        : { windows: [{ ts_second: 0, count: anchor.peak }], dropped: anchor.dropped },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("WorkerSizingHelper", () => {
  it("강한 근거(dropped>0): 천장 문구 + 권장 N + 적용 + HelpTip", async () => {
    const user = userEvent.setup();
    setHooks({ dropped: 500, peak: 790, priorWorkerCount: 2 });
    const onApply = vi.fn();
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="2000" maxInFlight="100" onApply={onApply} />,
    );
    expect(screen.getByText(/요청이 밀렸어요/)).toBeInTheDocument();
    expect(screen.getByText(/워커 ~6대가 필요해요/)).toBeInTheDocument(); // ceil(2000*2/790)=6
    expect(screen.getByRole("button", { name: "워커 수 사이징 설명" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(6);
  });

  it("약한 근거(dropped==0): 보수적 문구 + 포화 안내 + 적용", async () => {
    const user = userEvent.setup();
    setHooks({ dropped: 0, peak: 400, priorWorkerCount: 4 });
    const onApply = vi.fn();
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="800" maxInFlight="1000" onApply={onApply} />,
    );
    expect(screen.getByText(/드롭 없이 냈어요/)).toBeInTheDocument();
    expect(screen.getByText(/보수적으로/)).toBeInTheDocument();
    expect(screen.getByText(/포화시켜 보세요/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(8); // ceil(800*4/400)=8
  });

  it("근거 없음(prior run 없음): 안내 + 적용 버튼 부재", () => {
    setHooks(null);
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="2000" maxInFlight="100" onApply={vi.fn()} />,
    );
    expect(screen.getByText(/1대로 시작하고/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "적용" })).toBeNull();
  });

  it("cross-field: 적용값 > max_in_flight → needMaxInFlight 경고", () => {
    setHooks({ dropped: 500, peak: 100, priorWorkerCount: 1 });
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="500" maxInFlight="3" onApply={vi.fn()} />,
    );
    // ceil(500*1/100)=5 > maxInFlight 3
    expect(screen.getByText(/max_in_flight도 최소 5/)).toBeInTheDocument();
  });

  it("max_in_flight 충분하면 cross-field 경고 미표시", () => {
    setHooks({ dropped: 500, peak: 100, priorWorkerCount: 1 });
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="500" maxInFlight="50" onApply={vi.fn()} />,
    );
    expect(screen.queryByText(/max_in_flight도 최소/)).toBeNull();
  });

  it("하드캡 초과(rawN>64) → overCap 경고 + 적용은 64", async () => {
    const user = userEvent.setup();
    setHooks({ dropped: 500, peak: 10, priorWorkerCount: 1 });
    const onApply = vi.fn();
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="1000" maxInFlight="10000" onApply={onApply} />,
    );
    // ceil(1000*1/10)=100 > 64
    expect(screen.getByText(/상한\(64\)을 넘어요/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(64);
  });

  it("peakBased(곡선): 최고 단계 목표 문구", () => {
    setHooks({ dropped: 500, peak: 790, priorWorkerCount: 2 });
    render(
      <WorkerSizingHelper
        scenarioId="s1"
        targetRps="2000"
        peakBased
        maxInFlight="3000"
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByText(/최고 단계 목표엔 워커 ~6대/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd …/ui && pnpm test WorkerSizingHelper`
Expected: FAIL — `WorkerSizingHelper`/`ko.workerSizing` 미정의.

- [ ] **Step 3: `ko.workerSizing` 추가**

`ui/src/i18n/ko.ts`의 `slotSizing: { … },` 블록 **닫는 `},` 바로 다음 줄**에 추가:

```ts
  // 열린 루프 create-time worker_count 사이징(ADR-0038). 조사 병기((으)로 등) — 변수 뒤 조사 고정 금지(ADR-0035).
  workerSizing: {
    title: "워커 수 도우미",
    helpLabel: "워커 수 사이징 설명",
    help: "워커 한 대가 낼 수 있는 최대 RPS는 요청 지연·페이로드·대상 서버에 따라 달라 고정값이 없어요. 그래서 한 번 돌려 워커가 한계에 부딪힐 때(드롭 발생) 비로소 정확히 알 수 있어요.",
    strongBasis: (wc: number, peak: number, dropped: number) =>
      `지난 run이 워커 ${wc}대로 최대 ${peak} RPS에서 요청이 밀렸어요(드롭 ${dropped}) → 워커당 ~${Math.round(
        peak / wc,
      )} RPS가 한계예요.`,
    weakBasis: (wc: number, peak: number) =>
      `지난 run은 워커 ${wc}대로 ${peak} RPS를 드롭 없이 냈어요 — 한계까진 안 밀어서 워커당 진짜 천장은 아직 몰라요.`,
    recommend: (n: number) => `목표엔 워커 ~${n}대가 필요해요.`,
    recommendPeak: (n: number) => `최고 단계 목표엔 워커 ~${n}대가 필요해요.`,
    weakRecommend: (n: number) => `보수적으로 ~${n}대를 제안해요 (여유가 있었다면 더 적어도 됩니다).`,
    weakHint: "정확히 줄이려면 더 높은 목표로 한 번 돌려 드롭이 날 때까지 포화시켜 보세요.",
    noBasis:
      "참고할 종료된 열린 루프 run이 없어요. 1대로 시작하고, 리포트에 드롭(밀린 요청)이 보이면 그 권장값만큼 늘리세요.",
    apply: "적용",
    overCap: (n: number) =>
      `권장 ${n}대가 상한(64)을 넘어요 — 64대로도 목표에 못 미칠 수 있어요. 목표를 낮추거나 워커당 부하(payload·지연)를 점검하세요.`,
    needMaxInFlight: (n: number, cur: number) =>
      `worker_count는 max_in_flight 이하여야 해요 — max_in_flight도 최소 ${n}(으)로 함께 올리세요 (현재 ${cur}).`,
  },
```

- [ ] **Step 4: `WorkerSizingHelper.tsx` 작성**

`ui/src/components/WorkerSizingHelper.tsx` 신규 생성:

```tsx
import { useMemo } from "react";
import { useScenarioRuns, useRunReport } from "../api/hooks";
import type { Run } from "../api/schemas";
import { pickLatestOpenRun, peakThroughput, recommendWorkers } from "./sizing";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";

/** validate_run_config worker_count 하드캡(api/runs.rs / schemas.ts:93 `.max(64)`)과 동기. */
const WORKER_COUNT_CAP = 64;

type WorkerAnchor = { peak: number; dropped: number; priorWorkerCount: number };

/** 최근 종료 open-loop run에서 워커당 천장 앵커 도출. peak(초별 count 합 최대)·dropped·prior_wc.
 *  요청 0건(peak==0)이면 null. count 기반이라 localhost sub-ms run도 앵커가 산다(p50 기반 슬롯
 *  헬퍼 usePriorOpenRunAnchor와 대비 — 그건 p50==0이면 null). 슬롯 헬퍼 앵커 훅 미러. */
function usePriorOpenRunWorkerAnchor(scenarioId: string | undefined): WorkerAnchor | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees a
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(() => pickLatestOpenRun((runs.data?.runs ?? []) as Run[]), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const peak = report.data ? peakThroughput(report.data.windows) : 0;
  const dropped = report.data?.dropped ?? 0;
  const priorWorkerCount = latest?.profile.worker_count ?? 1;
  return useMemo(
    () => (peak > 0 ? { peak, dropped, priorWorkerCount } : null),
    [peak, dropped, priorWorkerCount],
  );
}

type Props = {
  scenarioId: string;
  /** 유효 목표 RPS 문자열(읽기 전용 — 자체 입력칸 없음). fixed=폼 목표 RPS, curve=stages 피크(상위 도출). */
  targetRps: string;
  /** true면 곡선 문구(최고 단계 목표) — open+curve에서 LoadModelFields가 전달. */
  peakBased?: boolean;
  /** 폼의 max_in_flight 문자열 — cross-field 경고(worker_count <= max_in_flight, runs.rs:346)용. */
  maxInFlight: string;
  /** 적용 → RunDialog의 setWorkerCount(String(n)). */
  onApply: (n: number) => void;
};

export function WorkerSizingHelper({ scenarioId, targetRps, peakBased = false, maxInFlight, onApply }: Props) {
  const anchor = usePriorOpenRunWorkerAnchor(scenarioId);
  const result = anchor
    ? recommendWorkers(Number(targetRps), anchor.peak, anchor.priorWorkerCount)
    : null;
  const rawN = result?.recommendedWorkers ?? 0;
  const applyN = Math.min(rawN, WORKER_COUNT_CAP);

  const mifNum = Number(maxInFlight);
  const mifValid = maxInFlight.trim() !== "" && Number.isInteger(mifNum) && mifNum >= 1;
  const needMif = result != null && mifValid && applyN > mifNum;

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-sm font-medium text-slate-700">{ko.workerSizing.title}</span>
        <HelpTip label={ko.workerSizing.helpLabel}>{ko.workerSizing.help}</HelpTip>
      </div>

      {anchor == null ? (
        <p className="text-xs text-slate-500">{ko.workerSizing.noBasis}</p>
      ) : (
        <>
          {anchor.dropped > 0 ? (
            <p className="text-xs text-slate-500 mb-2">
              {ko.workerSizing.strongBasis(anchor.priorWorkerCount, anchor.peak, anchor.dropped)}
            </p>
          ) : (
            <p className="text-xs text-slate-500 mb-2">
              {ko.workerSizing.weakBasis(anchor.priorWorkerCount, anchor.peak)}
            </p>
          )}

          {result && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-700">
                  {anchor.dropped > 0
                    ? peakBased
                      ? ko.workerSizing.recommendPeak(rawN)
                      : ko.workerSizing.recommend(rawN)
                    : ko.workerSizing.weakRecommend(rawN)}
                </span>
                <button
                  type="button"
                  onClick={() => onApply(applyN)}
                  className="rounded bg-indigo-600 px-2 py-1 text-sm text-white hover:bg-indigo-700"
                >
                  {ko.workerSizing.apply}
                </button>
              </div>
              {anchor.dropped === 0 && (
                <p className="text-xs text-slate-500 mt-1">{ko.workerSizing.weakHint}</p>
              )}
              {rawN > WORKER_COUNT_CAP && (
                <p className="text-xs text-amber-700 mt-1">{ko.workerSizing.overCap(rawN)}</p>
              )}
              {needMif && (
                <p className="text-xs text-amber-700 mt-1">
                  {ko.workerSizing.needMaxInFlight(applyN, mifNum)}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
```

주의: `result`가 null(앵커는 있으나 `targetRps`가 non-empty-but-invalid → `recommendWorkers` null)이면 권장/적용/경고 모두 침묵 — 폼 자체의 `targetRpsInvalid` 에러가 사유를 표시하므로 중복 안내 방지(슬롯 헬퍼 `SlotSizingHelper.tsx:160-162`와 동형). `env` prop은 측정 경로가 없어 불요(슬롯 헬퍼와 의도적 비대칭 — measure 없음).

- [ ] **Step 5: GREEN 확인**

Run: `cd …/ui && pnpm test WorkerSizingHelper`
Expected: PASS (7개).

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper/ui
pnpm lint && pnpm test WorkerSizingHelper && pnpm build
cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper
git add ui/src/components/WorkerSizingHelper.tsx ui/src/components/__tests__/WorkerSizingHelper.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): WorkerSizingHelper 3-tier + ko.workerSizing 카탈로그"
git log -1 --oneline
```

---

## Task 3: `LoadModelFields` 배선 + RunDialog 1줄

**Files:**
- Modify: `ui/src/components/__tests__/LoadModelFields.test.tsx` (lock-in 추가 — TDD-guard unblock)
- Modify: `ui/src/components/LoadModelFields.tsx`
- Modify: `ui/src/components/RunDialog.tsx`

- [ ] **Step 1: lock-in 테스트 작성 (TDD-guard unblock)**

`ui/src/components/__tests__/LoadModelFields.test.tsx` 상단의 `vi.mock("../SlotSizingHelper", …)` 블록 **다음**에 worker 헬퍼 스텁 추가:

```tsx
vi.mock("../WorkerSizingHelper", () => ({
  WorkerSizingHelper: () => <div data-testid="worker-sizing-helper" />,
}));
```

그리고 슬롯 헬퍼 lock-in 블록(`open+curve + onApplyMaxInFlight …` 테스트 근처) 뒤에 worker 헬퍼 lock-in 추가. **주의**: worker_count disclosure는 기본 접힘(`workerOpen = Number(workerCount ?? "1") > 1`)이라, 렌더 단언 전 `workerCount: "2"`로 자동 펼침 + `setWorkerCount`(disclosure 자체 렌더 조건)·`sizingScenarioId`(가드)·`onApplyWorkerCount`(가드) 전부 전달해야 한다:

```tsx
it.each([
  { loadModel: "open", rateMode: "fixed" },
  { loadModel: "open", rateMode: "curve" },
] as const)("$loadModel+$rateMode + onApplyWorkerCount → 워커 헬퍼 렌더", ({ loadModel, rateMode }) => {
  renderFields({
    loadModel,
    rateMode,
    sizingScenarioId: "s1",
    onApplyWorkerCount: vi.fn(),
    setWorkerCount: vi.fn(),
    workerCount: "2", // disclosure 자동 펼침
  });
  expect(screen.getByTestId("worker-sizing-helper")).toBeInTheDocument();
});

it("onApplyWorkerCount 없으면(스케줄 편집기 경로) 워커 헬퍼 미렌더", () => {
  renderFields({
    loadModel: "open",
    rateMode: "fixed",
    sizingScenarioId: "s1",
    setWorkerCount: vi.fn(),
    workerCount: "2",
  });
  expect(screen.queryByTestId("worker-sizing-helper")).toBeNull();
});

it("onApplyWorkerCount 있어도 sizingScenarioId 없으면 워커 헬퍼 미렌더 (가드 && 반쪽)", () => {
  renderFields({
    loadModel: "open",
    rateMode: "fixed",
    onApplyWorkerCount: vi.fn(),
    setWorkerCount: vi.fn(),
    workerCount: "2",
  });
  expect(screen.queryByTestId("worker-sizing-helper")).toBeNull();
});

it.each([
  { loadModel: "closed", rateMode: "fixed" },
  { loadModel: "closed", rateMode: "curve" },
] as const)("$loadModel+$rateMode 에선 워커 헬퍼 미렌더(disclosure가 open 전용)", ({ loadModel, rateMode }) => {
  renderFields({
    loadModel,
    rateMode,
    sizingScenarioId: "s1",
    onApplyWorkerCount: vi.fn(),
    setWorkerCount: vi.fn(),
    workerCount: "2",
  });
  expect(screen.queryByTestId("worker-sizing-helper")).toBeNull();
});
```

(`renderFields`는 `LoadModelFields.test.tsx`의 기존 헬퍼 — baseProps에 override를 머지해 `render(<LoadModelFields {...props} />)`. `closed+curve`는 `vu_stages` 모드라 worker_count disclosure 가드 `loadModel==="open"`이 false → 미렌더. 기존 슬롯/VU lock-in은 별 testid라 무충돌.)

- [ ] **Step 2: RED 확인**

Run: `cd …/ui && pnpm test LoadModelFields`
Expected: FAIL — `worker-sizing-helper` testid 미존재(LoadModelFields가 아직 안 렌더), `onApplyWorkerCount` prop 미정의 타입 에러 가능.

- [ ] **Step 3: `LoadModelFields.tsx` — prop 추가**

Props 타입(`onApplyMaxInFlight?: (n: number) => void;` 줄 근처, line ~41)에 추가:

```tsx
  onApplyWorkerCount?: (n: number) => void;
```

destructure(컴포넌트 시그니처, `onApplyMaxInFlight,` 근처 line ~74)에 추가:

```tsx
  onApplyWorkerCount,
```

- [ ] **Step 4: `LoadModelFields.tsx` — import + 렌더**

상단 import(`import { SlotSizingHelper } from "./SlotSizingHelper";` 다음 줄)에 추가:

```tsx
import { WorkerSizingHelper } from "./WorkerSizingHelper";
```

worker_count disclosure의 `{workerOpen && ( … )}` 블록 안, 기존 input/error(`{errs.workerCountInvalid && ( … )}`) **다음**(닫는 `</div>` 직전)에 헬퍼 렌더 추가:

```tsx
                  {onApplyWorkerCount && sizingScenarioId !== undefined && (
                    <WorkerSizingHelper
                      scenarioId={sizingScenarioId}
                      targetRps={rateMode === "curve" ? peakStr : targetRps}
                      peakBased={rateMode === "curve"}
                      maxInFlight={maxInFlight}
                      onApply={onApplyWorkerCount}
                    />
                  )}
```

(이 disclosure는 rateMode 분기 *앞*의 **단일 공유 블록**이라 한 번만 렌더하고 `rateMode` 삼항으로 target/peakBased를 고른다 — 슬롯 헬퍼의 per-arm 렌더와 다르다. `peakStr`/`maxInFlight`/`rateMode`/`targetRps`/`sizingScenarioId` 모두 이 지점에서 in-scope.)

- [ ] **Step 5: `RunDialog.tsx` — 1줄**

`<LoadModelFields …>` 렌더의 `setWorkerCount={setWorkerCount}` 줄(`RunDialog.tsx:521` 근처) **다음**에 추가:

```tsx
          onApplyWorkerCount={(n) => setWorkerCount(String(n))}
```

- [ ] **Step 6: `RunDialog.test.tsx` — 헬퍼 mock 추가 (패턴 패리티)**

Task 3가 실제 `WorkerSizingHelper`를 RunDialog 렌더 경로에 배선하므로, RunDialog 단위 테스트가 진짜 query 훅(`useScenarioRuns`/`useRunReport`)을 stubbed `fetch`로 쏘지 않게 mock한다(기존 `VuSizingHelper`/`SlotSizingHelper` mock과 동형, `RunDialog.test.tsx:7-15`). `vi.mock("../SlotSizingHelper", …)` **다음**에 추가:

```tsx
vi.mock("../WorkerSizingHelper", () => ({
  WorkerSizingHelper: () => null,
}));
```

(기존 RunDialog 테스트는 closed 기본 + `workerCount:"1"`이라 disclosure 접힘 → 헬퍼 미마운트로 안 깨지지만, 미래 open+펼침 테스트 대비 defense-in-depth. `() => null`로 충분 — RunDialog는 헬퍼 렌더를 단언하지 않음.)

- [ ] **Step 7: GREEN 확인**

Run: `cd …/ui && pnpm test LoadModelFields && pnpm test RunDialog`
Expected: PASS (LoadModelFields 기존 + worker lock-in 6개 / RunDialog 기존 전부).

- [ ] **Step 8: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper/ui
pnpm lint && pnpm test LoadModelFields && pnpm test RunDialog && pnpm build
cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper
git add ui/src/components/LoadModelFields.tsx ui/src/components/RunDialog.tsx ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): worker_count disclosure에 WorkerSizingHelper 배선 (RunDialog open)"
git log -1 --oneline
```

---

## Task 4: 전체 게이트 · 라이브 검증 · 리뷰 · 문서 · 머지

- [ ] **Step 1: 전체 UI 스위트 (S-D 함정 — 인자 없는 전체 1회)**

Run: `cd …/ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS(`RunDialog`/`LoadModelFields` 외 파일 잠복 red 없음 — S-D 함정 차단). 콘솔 경고 0(`--max-warnings=0`).

- [ ] **Step 2: 라이브 검증 (`/live-verify` + Playwright)**

`/live-verify`로 워크트리 자체 바이너리 + ≥50ms responder + 격리 DB를 띄운다(루트 CLAUDE.md — 워크트리 root에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 상대경로 `./target/debug/controller`). RunDialog open+fixed worker_count disclosure 펼침에서:
  - **(a) 포화 prior run**: 워커 2대·낮은 max_in_flight로 over-run해 `dropped>0` 만든 시나리오 → 강한 tier("요청이 밀렸어요") + 권장 N(`ceil(target×wc/peak)`) + 적용→worker_count 칸 반영. target 바꿔 재계산.
  - **(b) 비포화 prior run**(드롭 0) → 보수적 tier("드롭 없이 냈어요"·"포화시켜") + 적용.
  - **(c) prior open-loop run 없는 시나리오** → "1대로 시작" 안내 + 적용 버튼 부재.
  - **(d) 곡선**: open+curve에서 stages 입력 → peak 기준 권장 + "최고 단계 목표" 문구.
  - **(e) cross-field**: max_in_flight를 권장 N보다 작게 둔 상태 → "max_in_flight도 최소 N" 경고. 적용 후 실제 run 생성이 400 없이 통과하는지(max_in_flight도 올린 뒤).
  - **(f) 수식 parity**: 헬퍼 권장 N으로 실제 run 생성 vs 부족하게 잡은 대조 run에서 사후 `load_gen_saturated.recommended_workers`가 같은 수식으로 나오는지(ADR-0038 "recommended_workers=6"의 create-time 확인).
  - React controlled input은 native setter(루트 CLAUDE.md), click과 단언은 별도 evaluate. `WorkerSizingHelper`엔 prod testid 없음 → 제목 텍스트(`워커 수 도우미`)·문구로 찾기. 입력은 `label[for]`로 resolve. 콘솔 Zod 0. 머지 전 `rm -rf .playwright-mcp` + 루트 png 정리.

- [ ] **Step 3: handicap-reviewer 최종 리뷰**

`handicap-reviewer` 에이전트로 whole-feature 리뷰(repo-trap-aware): 와이어 무변경 확인(엔진/proto/migration 0), 권장식 ↔ `insights.rs:250` parity, Zod `.optional()`/`.nullish()` 무영향(신규 응답 필드 0), disclosure 기본접힘 테스트 처리, `it.each` testid 무충돌, ko 조사 병기. READY-TO-MERGE까지 finding fold-in(fresh fix-subagent — 이 하니스엔 subagent resume 없음).

- [ ] **Step 4: 문서 갱신 (별도 docs 커밋)**

- `docs/build-log.md`: 한 단락 append(파이프라인·라이브 검증·함정 출처).
- `docs/roadmap.md` §A9/§B2'': 이 항목 ✅ 완료로, ADR-0038 §8 연기목록 "create-time worker_count 사이징 헬퍼"를 ✅로 정정.
- 루트 `CLAUDE.md` 상태 줄: 한 줄 *교체*(최신 = worker_count 사이징 헬퍼).
- `ui/CLAUDE.md`: 사이징 헬퍼 함정 노트에 "워커 헬퍼는 단일 공유 disclosure 렌더(슬롯 per-arm과 다름)·count 기반 앵커(localhost OK)·cross-field max_in_flight 경고" 한 줄.
- 자동메모리 `MEMORY-archive.md`에 한 줄.

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/worker-count-sizing-helper
git add docs/ CLAUDE.md ui/CLAUDE.md
git commit -m "docs: worker_count create-time 사이징 헬퍼 완료 기록"
git log -1 --oneline
```

- [ ] **Step 5: 머지 (루트 CLAUDE.md git 토폴로지)**

워크트리 안에서 마무리(메인에 master checkout). 사전 ff 가능 확인 후:

```bash
git -C /Users/sgj/develop/handicap merge-base --is-ancestor master HEAD && echo "ff ok"
git -C /Users/sgj/develop/handicap status --porcelain -uno   # 메인 클린 확인
git -C /Users/sgj/develop/handicap merge --ff-only worker-count-sizing-helper
git -C /Users/sgj/develop/handicap log -1 --oneline
```
세션이 길어 master가 전진했으면 ff 깨짐 → 브랜치를 master에 rebase 후 재시도. 머지 확인 후 `ExitWorktree(remove, discard_changes: true)`로 정리(커밋은 이미 master에 안전).

---

## Self-Review (작성자 체크 — 구현 전 마지막)

- **Spec 커버리지**: §5 순수함수 2개 → Task 1 / §7 컴포넌트 3-tier+경고+HelpTip → Task 2 / §6·§8 LoadModelFields·RunDialog 배선 → Task 3 / §9 테스트·라이브 → Task 1–4. cross-field(§7.3) → Task 2 컴포넌트 + Task 1 가드 없음(컴포넌트 책임). 누락 없음.
- **타입 일관성**: `peakThroughput(windows)`/`recommendWorkers(target, priorPeak, priorWorkerCount)`/`WorkerSizingResult`/`WorkerAnchor`/`usePriorOpenRunWorkerAnchor` — Task 1·2 정의와 Task 2·3 사용 일치. `onApplyWorkerCount?: (n:number)=>void` Task 3 정의·RunDialog 전달 일치. `ko.workerSizing` 키(strongBasis/weakBasis/recommend/recommendPeak/weakRecommend/weakHint/noBasis/apply/overCap/needMaxInFlight) — Task 2 카탈로그·컴포넌트·테스트 일치.
- **Placeholder 스캔**: 코드 블록 전부 실제 내용, "TBD/유사하게" 없음.
- **게이트 경계**: 각 Task = green 단일 커밋(RED-only 없음), 테스트 파일 먼저(TDD-guard unblock), 커밋 파이프 없음.
