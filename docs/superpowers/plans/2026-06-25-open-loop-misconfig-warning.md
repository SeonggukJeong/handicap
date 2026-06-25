# open-loop misconfig 경고 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog에서 *합법이지만 의심스러운* open-loop 설정 두 가지를 create-time 비차단 advisory로 경고한다 — ① 곡선 fan-out 유휴 워커, ② inert `max_in_flight`(슬롯이 절대 안 차서 무의미).

**Architecture:** 순수 모듈 `openLoopChecks.ts`(프로필 string-draft + 시나리오 트리만 보고 결정적으로 경고 산출, 측정·임계값 없음) + `LoadModelFields`가 그 결과를 `role="status"` 힌트로 렌더 + `RunDialog`가 `httpTimeout`/`poolMode` 두 prop을 배선. 백엔드/와이어 0-diff. false-positive 0은 ②의 시나리오-반복-시간 *상한* fold(과대추정→덜 경고)와 `worker_count ≤ 1` + 비-pool 스코프로 보장.

**Tech Stack:** TypeScript/React, Vitest + React Testing Library, Zod 모델(`ui/src/scenario/model.ts`), 기존 `sizing.ts` 순수 헬퍼.

## Global Constraints

(spec `docs/superpowers/specs/2026-06-25-open-loop-misconfig-warning-design.md` §2/§5에서 verbatim — 모든 task에 암묵 포함)

- **`ui/`-only.** `schemas.ts`·controller·proto·migration·engine·worker **0-diff**. run 제출 페이로드 byte-identical(경고는 표시-only). (R6)
- **`ScheduleForm.tsx` 0-diff** — 새 optional prop(`httpTimeout`/`poolMode`) 미전달이라 두 경고 모두 미발생. 표면 = RunDialog 전용. (R6/R8/R12/R13)
- **false-positive 0**: ②는 `worker_count ≤ 1` AND `poolMode !== true`일 때만. `T`는 반복-시간 *상한*(과대추정)이라 절대 over-warn 안 함. ①은 곡선·`poolMode !== true`에서만. (R2/R3/R13)
- **모든 신규 사용자-노출 문구**(본문·`aria-label`·버튼)는 `ko.ts` 경유(ADR-0035). 하드코딩 영어/인라인 한국어 금지. (R9)
- **단일 소스**: 곡선 peak·고정 rate 유효성은 `sizing.ts::peakStageTarget`·`targetRpsValid` 재사용(독립 `max`/범위검사 금지). (R11)
- **게이트 = `pnpm lint && pnpm test && pnpm build`** 셋 다 green(루트 CLAUDE.md). `pnpm lint`는 `--max-warnings=0`. `pnpm build`=`tsc -b`만 잡는 타입 에러 있음.
- **tdd-guard**: production(`ui/src/**` non-test) 편집 전 pending test-path diff 필요 → **각 task는 테스트 파일을 가장 먼저** 편집(ui/CLAUDE.md).

---

## Task 1: 순수 모듈 `openLoopChecks.ts` + `targetRpsValid` export

프로필 string-draft + 시나리오 트리를 받아 결정적 경고 배열을 내는 순수 함수. React 의존 0. 충족 R: **R1, R2, R3, R4, R11, R13**.

**Files:**
- Modify: `ui/src/components/sizing.ts:18` (`targetRpsValid` private → `export`)
- Create: `ui/src/components/openLoopChecks.ts`
- Test: `ui/src/components/__tests__/openLoopChecks.test.ts`

**Interfaces:**
- Consumes: `sizing.ts::peakStageTarget(stages: {target:string}[]): number | null` (이미 export), `sizing.ts::targetRpsValid(n: number): boolean` (이 task에서 export), `scenario/model.ts` 타입 `Step`/`Scenario`.
- Produces (Task 2가 의존):
  - `type OpenLoopWarning = { kind:"idle_workers"; workers:number; peak:number; idle:number } | { kind:"inert_slots"; maxInFlight:number; threshold:number }`
  - `type OpenLoopInput = { loadModel:"closed"|"open"; rateMode:"fixed"|"curve"; targetRps:string; maxInFlight:string; stages:{target:string;duration_seconds:string}[]; workerCount?:string; httpTimeoutSeconds?:number; scenario:Scenario|null; poolMode?:boolean }`
  - `function openLoopWarnings(input: OpenLoopInput): OpenLoopWarning[]`
  - `function iterationTimeUpperBoundSeconds(steps: ReadonlyArray<Step>, httpTimeoutSec: number): number`

- [ ] **Step 1: 단위 테스트 작성 (RED)** — `ui/src/components/__tests__/openLoopChecks.test.ts` 생성

```tsx
import { describe, expect, it } from "vitest";
import type { Scenario, Step } from "../../scenario/model";
import { iterationTimeUpperBoundSeconds, openLoopWarnings } from "../openLoopChecks";

// 폴드는 .type/.timeout_seconds/.think_time/.repeat/.do/.then/.elif/.else/.branches만 읽으므로
// 테스트 픽스처는 최소 구조 캐스트로 충분(Zod 검증 대상 아님).
const http = (over: Partial<Record<string, unknown>> = {}) =>
  ({ type: "http", ...over }) as unknown as Step;
const scenarioOf = (steps: Step[]) => ({ steps }) as unknown as Scenario;

const base = {
  loadModel: "open" as const,
  rateMode: "fixed" as const,
  targetRps: "10",
  maxInFlight: "10000",
  stages: [{ target: "1", duration_seconds: "10" }],
  workerCount: "1",
  httpTimeoutSeconds: 1,
  scenario: scenarioOf([http()]), // 1 http leaf, no per-step timeout → uses httpTimeoutSeconds
  poolMode: false,
};

describe("iterationTimeUpperBoundSeconds", () => {
  it("http leaf = step timeout(없으면 httpTimeout) + think max_ms/1000", () => {
    expect(iterationTimeUpperBoundSeconds([http()], 30)).toBe(30);
    expect(iterationTimeUpperBoundSeconds([http({ timeout_seconds: 5 })], 30)).toBe(5);
    expect(
      iterationTimeUpperBoundSeconds([http({ timeout_seconds: 2, think_time: { min_ms: 0, max_ms: 3000 } })], 30),
    ).toBe(5); // 2 + 3000/1000
  });

  it("순차 = 합", () => {
    expect(iterationTimeUpperBoundSeconds([http({ timeout_seconds: 2 }), http({ timeout_seconds: 3 })], 30)).toBe(5);
  });

  it("loop = repeat × body", () => {
    const loop = { type: "loop", repeat: 4, do: [http({ timeout_seconds: 2 })] } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([loop], 30)).toBe(8);
  });

  it("if = 분기 max (단일 분기만 실행)", () => {
    const ifStep = {
      type: "if",
      then: [http({ timeout_seconds: 2 })],
      elif: [{ then: [http({ timeout_seconds: 9 })] }],
      else: [http({ timeout_seconds: 3 })],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([ifStep], 30)).toBe(9);
  });

  it("parallel = 분기 max (동시 실행)", () => {
    const par = {
      type: "parallel",
      branches: [{ steps: [http({ timeout_seconds: 2 })] }, { steps: [http({ timeout_seconds: 7 })] }],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([par], 30)).toBe(7);
  });

  it("중첩: loop-in-if · if-in-loop 재귀", () => {
    const loopInIf = {
      type: "if",
      then: [{ type: "loop", repeat: 3, do: [http({ timeout_seconds: 2 })] }],
      elif: [],
      else: [],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([loopInIf], 30)).toBe(6); // 3×2
    const ifInLoop = {
      type: "loop",
      repeat: 2,
      do: [{ type: "if", then: [http({ timeout_seconds: 5 })], elif: [], else: [http({ timeout_seconds: 1 })] }],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([ifInLoop], 30)).toBe(10); // 2×max(5,1)
  });

  it("http leaf 없으면 0 (fail-safe)", () => {
    expect(iterationTimeUpperBoundSeconds([], 30)).toBe(0);
  });
});

describe("openLoopWarnings — ① 곡선 유휴 워커", () => {
  it("곡선 W>peak → idle_workers(idle=W-peak)", () => {
    const w = openLoopWarnings({ ...base, rateMode: "curve", workerCount: "3", stages: [{ target: "1", duration_seconds: "10" }] });
    expect(w).toContainEqual({ kind: "idle_workers", workers: 3, peak: 1, idle: 2 });
  });
  it("곡선 W≤peak → 없음", () => {
    const w = openLoopWarnings({ ...base, rateMode: "curve", workerCount: "1", stages: [{ target: "5", duration_seconds: "10" }] });
    expect(w.find((x) => x.kind === "idle_workers")).toBeUndefined();
  });
  it("고정 모드 → ① 없음(고정은 worker_count>target_rps가 이미 400)", () => {
    const w = openLoopWarnings({ ...base, rateMode: "fixed", workerCount: "3" });
    expect(w.find((x) => x.kind === "idle_workers")).toBeUndefined();
  });
});

describe("openLoopWarnings — ② inert max_in_flight", () => {
  it("W≤1 && M ≥ ceil(R×T) → inert_slots (고정: R=target_rps)", () => {
    const w = openLoopWarnings({ ...base, targetRps: "10", maxInFlight: "10000", httpTimeoutSeconds: 1 });
    expect(w).toContainEqual({ kind: "inert_slots", maxInFlight: 10000, threshold: 10 });
  });
  it("M < ceil(R×T) → 없음", () => {
    const w = openLoopWarnings({ ...base, targetRps: "100", maxInFlight: "5", httpTimeoutSeconds: 30 });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
  it("곡선: R=peak", () => {
    const w = openLoopWarnings({ ...base, rateMode: "curve", maxInFlight: "10000", httpTimeoutSeconds: 1, stages: [{ target: "20", duration_seconds: "10" }] });
    expect(w).toContainEqual({ kind: "inert_slots", maxInFlight: 10000, threshold: 20 });
  });
  it("W>1(fan-out) → ② 없음(false-positive 방지, §7 연기)", () => {
    const w = openLoopWarnings({ ...base, workerCount: "2", maxInFlight: "10000" });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
  it("scenario=null → 없음(fail-safe)", () => {
    const w = openLoopWarnings({ ...base, scenario: null, maxInFlight: "10000" });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
  it("httpTimeoutSeconds 미설정 → 없음(ScheduleForm 시나리오)", () => {
    const w = openLoopWarnings({ ...base, httpTimeoutSeconds: undefined, maxInFlight: "10000" });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
  it("http leaf 0(T=0) → 없음(fail-safe)", () => {
    const w = openLoopWarnings({ ...base, scenario: scenarioOf([]), maxInFlight: "10000" });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
});

describe("openLoopWarnings — 게이트(R13/R7)", () => {
  it("poolMode=true → 둘 다 없음([])", () => {
    const w = openLoopWarnings({ ...base, rateMode: "curve", workerCount: "3", maxInFlight: "10000", poolMode: true });
    expect(w).toEqual([]);
  });
  it("closed → 둘 다 없음([])", () => {
    const w = openLoopWarnings({ ...base, loadModel: "closed", rateMode: "curve", workerCount: "3", maxInFlight: "10000" });
    expect(w).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인 (RED)**

Run: `cd ui && pnpm test openLoopChecks`
Expected: FAIL — `Cannot find module "../openLoopChecks"`.

- [ ] **Step 3: `targetRpsValid` export** — `ui/src/components/sizing.ts:18`

기존:
```ts
function targetRpsValid(targetRps: number): boolean {
```
변경:
```ts
export function targetRpsValid(targetRps: number): boolean {
```
(로직 무변경 — 가시성만. R11 단일 소스.)

- [ ] **Step 4: 순수 모듈 작성** — `ui/src/components/openLoopChecks.ts` 생성

```ts
import type { Scenario, Step } from "../scenario/model";
import { peakStageTarget, targetRpsValid } from "./sizing";

/** create-time open-loop 구조 경고(순수·결정적·측정 없음). spec 2026-06-25-open-loop-misconfig-warning.
 *  ① 곡선 fan-out 유휴 워커, ② inert max_in_flight. false-positive 0(아래 주석). */

export type OpenLoopWarning =
  | { kind: "idle_workers"; workers: number; peak: number; idle: number }
  | { kind: "inert_slots"; maxInFlight: number; threshold: number };

export type OpenLoopInput = {
  loadModel: "closed" | "open";
  rateMode: "fixed" | "curve";
  targetRps: string;
  maxInFlight: string;
  stages: { target: string; duration_seconds: string }[];
  workerCount?: string; // string draft, 미설정/"" → 1
  httpTimeoutSeconds?: number; // RunDialog http_timeout; undefined → ② skip
  scenario: Scenario | null; // typed model; null → ② skip
  poolMode?: boolean; // true → 둘 다 skip (R13: pool은 worker_count 무시·per-worker 분할)
};

/** 한 반복(전체 시나리오)의 월-타임 *상한*(초). 과대추정이라 ②가 over-warn하지 않는다(R3):
 *  http leaf = (step timeout ?? httpTimeout) + per-step think max; 순차=합; loop=repeat×;
 *  if=분기 max(한 분기만 실행); parallel=분기 max(한 슬롯서 동시). flattenHttpSteps와 동형 재귀.
 *  http leaf 없으면 0 → 호출부가 ② skip(fail-safe). */
export function iterationTimeUpperBoundSeconds(
  steps: ReadonlyArray<Step>,
  httpTimeoutSec: number,
): number {
  let total = 0;
  for (const s of steps) {
    if (s.type === "http") {
      const stepTimeout = s.timeout_seconds ?? httpTimeoutSec;
      const thinkMs = s.think_time?.max_ms ?? 0;
      total += stepTimeout + thinkMs / 1000;
    } else if (s.type === "loop") {
      total += s.repeat * iterationTimeUpperBoundSeconds(s.do, httpTimeoutSec);
    } else if (s.type === "parallel") {
      let mx = 0;
      for (const b of s.branches) {
        mx = Math.max(mx, iterationTimeUpperBoundSeconds(b.steps, httpTimeoutSec));
      }
      total += mx;
    } else {
      // if — 단일 분기만 실행 → 상한 = then/elif[].then/else 중 max
      let mx = iterationTimeUpperBoundSeconds(s.then, httpTimeoutSec);
      for (const e of s.elif) {
        mx = Math.max(mx, iterationTimeUpperBoundSeconds(e.then, httpTimeoutSec));
      }
      mx = Math.max(mx, iterationTimeUpperBoundSeconds(s.else, httpTimeoutSec));
      total += mx;
    }
  }
  return total;
}

export function openLoopWarnings(input: OpenLoopInput): OpenLoopWarning[] {
  const {
    loadModel,
    rateMode,
    targetRps,
    maxInFlight,
    stages,
    workerCount,
    httpTimeoutSeconds,
    scenario,
    poolMode,
  } = input;
  if (loadModel !== "open") return [];
  if (poolMode === true) return []; // R13

  const out: OpenLoopWarning[] = [];
  const peak = peakStageTarget(stages); // number | null (string-draft, 유효 정수만)
  const W = Number(workerCount || "1"); // 빈 draft("")는 1로 취급(spec §4.1)

  // ① 곡선 fan-out 유휴 워커 — W > peak면 (W-peak)개 워커가 0-share로 유휴.
  //    고정 모드는 worker_count>target_rps가 이미 400이라 발생 불가 → 곡선 한정.
  if (rateMode === "curve" && peak != null && Number.isInteger(W) && W > peak) {
    out.push({ kind: "idle_workers", workers: W, peak, idle: W - peak });
  }

  // ② inert max_in_flight — 단일 워커(W≤1)·비-pool에서만(per-worker==aggregate, 분할 없음 → false-positive 0).
  //    R = 유효 도착률(고정 target_rps / 곡선 peak), T = 반복-시간 상한.
  //    M ≥ ceil(R×T)면 슬롯이 절대 고갈 불가 → max_in_flight 무의미.
  const R = rateMode === "curve" ? peak : targetRpsValid(Number(targetRps)) ? Number(targetRps) : null;
  if (scenario != null && httpTimeoutSeconds != null && W <= 1 && R != null && R > 0) {
    const T = iterationTimeUpperBoundSeconds(scenario.steps, httpTimeoutSeconds);
    const M = Number(maxInFlight);
    if (T > 0 && Number.isFinite(M) && M >= 1 && M >= Math.ceil(R * T)) {
      out.push({ kind: "inert_slots", maxInFlight: M, threshold: Math.ceil(R * T) });
    }
  }
  return out;
}
```

- [ ] **Step 5: 테스트 통과 확인 (GREEN)**

Run: `cd ui && pnpm test openLoopChecks`
Expected: PASS (모든 it).

- [ ] **Step 6: lint/build 게이트**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 둘 다 exit 0 (신규 export 미사용은 lint 에러 아님 — 테스트가 import).

- [ ] **Step 7: 커밋**

```bash
git add ui/src/components/openLoopChecks.ts ui/src/components/__tests__/openLoopChecks.test.ts ui/src/components/sizing.ts
git commit -m "feat(ui): open-loop 구조 경고 순수 모듈 openLoopChecks (① 유휴 워커 · ② inert max_in_flight)

R1–R4/R11/R13: 결정적·false-positive 0(반복-시간 상한 fold·worker_count<=1·비-pool). targetRpsValid export.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R3yxEaHpQeMVEp7AsKQabw"
```

---

## Task 2: `ko.ts` 문구 + `LoadModelFields`/`RunDialog` 배선 + RTL

순수 경고를 RunDialog UI에 advisory로 표시. 충족 R: **R1, R2, R5, R7, R8, R9, R10, R12, R13**.

**Files:**
- Modify: `ui/src/i18n/ko.ts` (신규 `openLoopCheck` 네임스페이스)
- Modify: `ui/src/components/LoadModelFields.tsx` (Props 2개·경고 산출·렌더·적용 버튼)
- Modify: `ui/src/components/RunDialog.tsx:541` 부근 (`httpTimeout`/`poolMode` prop 전달)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx` (케이스 추가)

**Interfaces:**
- Consumes: Task 1의 `openLoopWarnings`, `OpenLoopWarning`. RunDialog 기존 `httpTimeout`(state, `RunDialog.tsx:100`)·`pool`(`usePoolWorkers()`, `RunDialog.tsx:171`)·`scenario`(이미 `sizingScenario`로 전달).
- Produces: 사용자-노출 경고. ScheduleForm은 새 prop 미전달 → 경고 미발생(0-diff).

- [ ] **Step 1: RTL 케이스 추가 (RED)** — `ui/src/components/__tests__/LoadModelFields.test.tsx` 끝에 추가

기존 `setup`/`renderFields`(상단)를 재사용. **먼저 파일 상단 import 블록**(기존 import 1–5줄 옆)에 `import type { Scenario } from "../../scenario/model";`를 추가(mid-file import 금지 — 스타일). 그 다음 **파일 끝**(마지막 `});` 아래)에 아래 `oneHttp` 상수 + describe 블록을 추가:

```tsx
const oneHttp = { steps: [{ type: "http" }] } as unknown as Scenario;

describe("LoadModelFields — open-loop 구조 경고", () => {
  it("① 곡선 W>peak → 유휴 워커 경고 + 적용 버튼이 worker_count를 peak로", async () => {
    const user = userEvent.setup();
    const setWorkerCount = vi.fn();
    renderFields({
      loadModel: "open",
      rateMode: "curve",
      stages: [{ target: "1", duration_seconds: "10" }],
      workerCount: "3",
      setWorkerCount,
      onApplyWorkerCount: vi.fn(),
      sizingScenarioId: "s1",
    });
    expect(screen.getByText(/할 일이 없어요/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /맞추기/ }));
    expect(setWorkerCount).toHaveBeenCalledWith("1"); // peak=1
  });

  it("② 단일 워커·inert → max_in_flight 무효 경고", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      maxInFlight: "10000",
      httpTimeout: 1,
      sizingScenario: oneHttp,
      sizingScenarioId: "s1",
    });
    expect(screen.getByText(/영향을 주지 않아요/)).toBeInTheDocument();
  });

  it("② pool 모드면 미렌더 (R13)", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      maxInFlight: "10000",
      httpTimeout: 1,
      sizingScenario: oneHttp,
      sizingScenarioId: "s1",
      poolMode: true,
    });
    expect(screen.queryByText(/영향을 주지 않아요/)).not.toBeInTheDocument();
  });

  it("② httpTimeout 부재(ScheduleForm) → 미렌더", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      maxInFlight: "10000",
      sizingScenario: oneHttp,
      sizingScenarioId: "s1",
    });
    expect(screen.queryByText(/영향을 주지 않아요/)).not.toBeInTheDocument();
  });

  it("경고가 있어도 제출을 막지 않는다(비차단 advisory, R5)", () => {
    // LoadModelFields는 Run 버튼을 소유하지 않음 — 경고는 role=status, aria-invalid/disabled 미설정.
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      maxInFlight: "10000",
      httpTimeout: 1,
      sizingScenario: oneHttp,
      sizingScenarioId: "s1",
    });
    const warn = screen.getByText(/영향을 주지 않아요/);
    expect(warn.closest("[role='status']")).not.toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인 (RED)**

Run: `cd ui && pnpm test LoadModelFields`
Expected: FAIL — 경고 텍스트/버튼이 아직 없음 + `httpTimeout`/`poolMode` prop이 `Props`에 없어 `tsc` 거부(또는 런타임 미렌더).

- [ ] **Step 3: ko.ts 문구 추가** — `ui/src/i18n/ko.ts`의 `workerSizing` 네임스페이스 *뒤*(또는 `slotSizing` 부근, 객체 안 임의 위치)에 추가

```ts
  // open-loop 구조 경고(create-time advisory). 조사 병기((으)로) — 변수 뒤 조사 고정 금지(ADR-0035).
  openLoopCheck: {
    idleWorkers: (idle: number, peak: number) =>
      `워커 ${idle}대가 할 일이 없어요 — 곡선 최고점이 ${peak}라 워커 ${peak}대까지만 일하고 나머지는 유휴예요.`,
    apply: (peak: number) => `워커 수를 ${peak}(으)로 맞추기`,
    inertSlots:
      "지금 목표 속도·타임아웃에선 동시 요청이 동시 요청 상한(max_in_flight)에 절대 도달하지 않아 이 값이 부하에 영향을 주지 않아요 — 부하 세기는 max_in_flight가 아니라 목표 RPS로 정해져요.",
  },
```

- [ ] **Step 4: `LoadModelFields` Props 2개 + import 추가** — `ui/src/components/LoadModelFields.tsx`

import 추가(파일 상단 import 블록, `peakStageTarget` import 옆):
```ts
import { openLoopWarnings, type OpenLoopWarning } from "./openLoopChecks";
```
(주의: `ko`/`peakStageTarget`/`useMemo`는 이미 import돼 있다(LoadModelFields.tsx:1,5,10) — 중복 추가 금지. `OpenLoopWarning`은 Step 5의 `Extract<OpenLoopWarning, …>` 타입가드에 필요.)

`type Props`(15–49)의 `setWorkerCount?` 줄 뒤에 두 prop 추가:
```ts
  // ② inert max_in_flight 판정용(RunDialog http_timeout). 미전달(ScheduleForm) → ② 미발생.
  httpTimeout?: number;
  // pool 모드 신호(RunDialog pool.data?.pool_mode). true → 두 경고 모두 suppress(R13).
  poolMode?: boolean;
```

destructure(53–81)의 `setWorkerCount,` 뒤에 추가:
```ts
  httpTimeout,
  poolMode,
```

- [ ] **Step 5: 경고 산출 메모** — `peakStr` useMemo(97–100) *뒤*에 추가

```tsx
  // open-loop 구조 경고(순수·결정적). poolMode/closed/W>1 등 게이트는 openLoopWarnings 내부.
  const openLoopWarns = useMemo(
    () =>
      openLoopWarnings({
        loadModel,
        rateMode,
        targetRps,
        maxInFlight,
        stages,
        workerCount,
        httpTimeoutSeconds: httpTimeout,
        scenario: sizingScenario ?? null,
        poolMode,
      }),
    [loadModel, rateMode, targetRps, maxInFlight, stages, workerCount, httpTimeout, sizingScenario, poolMode],
  );
  // 판별 union 좁히기: 평범한 `=== ` 화살표는 `find`가 narrow 못 함(strict tsc) → 타입가드 술어 필수.
  const idleWarn = openLoopWarns.find(
    (w): w is Extract<OpenLoopWarning, { kind: "idle_workers" }> => w.kind === "idle_workers",
  );
  const inertWarn = openLoopWarns.find(
    (w): w is Extract<OpenLoopWarning, { kind: "inert_slots" }> => w.kind === "inert_slots",
  );
```

- [ ] **Step 6: ② 렌더(max_in_flight 밑)** — max_in_flight 에러 블록(459–463) *바로 뒤*에 추가

```tsx
          {errs.maxInFlightInvalid && (
            <p id="max-in-flight-error" className="mb-3 text-red-600 text-sm">
              {ko.validation.maxInFlight}
            </p>
          )}
          {inertWarn && (
            <p role="status" className="mb-3 max-w-xs text-amber-700 text-sm">
              {ko.openLoopCheck.inertSlots}
            </p>
          )}
```

- [ ] **Step 7: ① 렌더(worker_count disclosure 안)** — `WorkerSizingHelper` 블록(509–517) *뒤*, disclosure 안쪽 `</div>` 전에 추가

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
                  {idleWarn && (
                    <p role="status" className="mt-2 text-amber-700 text-sm">
                      {ko.openLoopCheck.idleWorkers(idleWarn.idle, idleWarn.peak)}{" "}
                      <button
                        type="button"
                        onClick={() => setWorkerCount?.(String(idleWarn.peak))}
                        className="text-blue-600 hover:underline"
                      >
                        {ko.openLoopCheck.apply(idleWarn.peak)}
                      </button>
                    </p>
                  )}
```

- [ ] **Step 8: RunDialog 배선** — `ui/src/components/RunDialog.tsx` `LoadModelFields` 호출(513–541)에 두 prop 추가

`onApplyWorkerCount={(n) => setWorkerCount(String(n))}` 줄 뒤(닫는 `/>` 전)에:
```tsx
          httpTimeout={httpTimeout}
          poolMode={pool.data?.pool_mode}
```
(둘 다 이미 존재: `httpTimeout` state `RunDialog.tsx:100`, `pool` 쿼리 `RunDialog.tsx:171`. 그 외 무변경.)

- [ ] **Step 9: 테스트 통과 확인 (GREEN)**

Run: `cd ui && pnpm test LoadModelFields`
Expected: PASS (신규 5 케이스 + 기존 케이스 무회귀).

- [ ] **Step 10: 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 셋 다 exit 0. (`pnpm test`=전체 스위트, S-D 갭 — 다른 파일 회귀 확인.)

- [ ] **Step 11: ScheduleForm 0-diff 확인**

Run: `git diff --name-only`
Expected: `ui/src/components/ScheduleForm.tsx` **미포함**. 변경 파일 = `ko.ts`·`LoadModelFields.tsx`·`RunDialog.tsx`·`openLoopChecks.ts`(+테스트)·`sizing.ts`만(전부 `ui/`).

- [ ] **Step 12: 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/components/LoadModelFields.tsx ui/src/components/RunDialog.tsx ui/src/components/__tests__/LoadModelFields.test.tsx
git commit -m "feat(ui): RunDialog open-loop 구조 경고 표시 (① 유휴 워커 적용버튼 · ② inert max_in_flight)

R1/R2/R5/R7/R8/R9/R10/R12/R13: role=status advisory·ko.openLoopCheck·RunDialog 전용(httpTimeout/poolMode prop)·ScheduleForm 0-diff.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R3yxEaHpQeMVEp7AsKQabw"
```

---

## 자기 검토 (작성자 체크리스트 결과)

- **Spec coverage**: R1(Task2 ① RTL+Task1 unit)·R2(Task1 ② unit+Task2 RTL)·R3(Task1 fold unit, 중첩 포함)·R4(Task1 fail-safe unit)·R5(Task2 비차단 RTL)·R6(Task2 Step11 git diff)·R7(Task1 closed/고정 unit+Task2)·R8(Task1 게이트 unit+Task2 prop 부재)·R9(Task2 ko.ts)·R10(Task2 적용 RTL)·R11(Task1 peakStageTarget/targetRpsValid 재사용)·R12(Task2 httpTimeout prop+RTL)·R13(Task1 poolMode unit+Task2 RTL) — 전부 task 매핑됨.
- **Placeholder scan**: 코드 블록 전부 실제 내용. TODO/TBD 없음.
- **Type consistency**: `OpenLoopWarning`/`OpenLoopInput`/`openLoopWarnings`/`iterationTimeUpperBoundSeconds` 이름·시그니처가 Task1 정의 ↔ Task2 사용에서 동일. `targetRpsValid`(number 인자)는 `Number(targetRps)`로 호출(N1). `setWorkerCount?.` optional chaining(Props optional).

## 검증 / 라이브

- 라이브 검증 **WAIVED**(spec §6): `schemas.ts` 0-diff·run-create/report-parse·엔진 경로 무관 → S-D 갭 구조적 부재. RTL이 결정적 커버. finish-slice에서 build-log에 waive 근거 기록.
- 최종 리뷰: `handicap-reviewer`(ui-only·와이어 0이라 seam 대조 최소·R 매핑/byte-identical/ScheduleForm 0-diff 확인). 보안 표면 게이트는 N/A 예상(요청실행/템플릿/캐스트/env-dataset/업로드/trace 무관 — finish-slice §0 grep으로 확인).

## 리뷰 게이트

spec-plan-reviewer 3라운드(spec) + 2라운드(plan) → clean APPROVE (M1 build-breaking find-narrowing·M2·M3 fix 반영).

REVIEW-GATE: APPROVED
