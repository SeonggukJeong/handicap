# 부하 모드 선택기 (2축 보존 RunDialog 리팩터) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog의 부하 모델 부분을 순수함수(`loadModel.ts`) + presentational 컴포넌트(`LoadModelFields.tsx`)로 추출하고, 숨어 있던 2차 축(고정/곡선)을 closed-loop에도 노출(closed+curve는 disabled "곧 지원")하며, `http_timeout`(3곳)·`max_in_flight`(2곳) 중복을 1개로 줄이고, "모드당 자기 필드만 emit" 불변식을 테스트로 락인한다.

**Architecture:** UI-only. 엔진·proto·컨트롤러·마이그레이션 무변경. 상태(state) 소유권은 RunDialog에 그대로 두고(`EnvironmentPicker` controlled 패턴 → reseed-by-key prefill 불변식 보존), 모드 분기 로직만 순수함수로, 모드 JSX만 presentational 컴포넌트로 뽑는다. 제출 payload는 현재와 byte-identical. 서버 `validate_run_config`는 권위 게이트로 유지(defense-in-depth).

**Tech Stack:** Vite + React + TypeScript + Tailwind + Zod, vitest + @testing-library/react. 게이트: `pnpm lint && pnpm test && pnpm build`(전체).

**Spec:** `docs/superpowers/specs/2026-06-05-load-model-mode-selector-design.md`

---

## 파일 구조

| 파일 | 책임 | Task |
|---|---|---|
| `ui/src/components/loadModel.ts` (신규) | 순수: `LoadModelState`/`LoadProfileFields`/`LoadModelErrors` 타입, `buildLoadProfile`(모드별 Profile 필드), `loadModelErrors`(모드별 검증 플래그) | 1 |
| `ui/src/components/__tests__/loadModel.test.ts` (신규) | 필드-형태 불변식(§7.1) + `loadModelErrors` 범위 검증 | 1 |
| `ui/src/components/LoadModelFields.tsx` (신규) | presentational: 2축 셀렉터 + 사분면별 필드 + stages 에디터 + 곡선 미리보기. controlled(props). | 2 |
| `ui/src/components/__tests__/LoadModelFields.test.tsx` (신규) | 셀렉터 렌더·closed+curve disabled·closed 선택 시 rateMode 리셋·모드별 필드·open에서 max_in_flight 1개 | 2 |
| `ui/src/components/RunDialog.tsx` (수정) | `<LoadModelFields/>` 배선 + 공유 http_timeout 1개 + `buildProfile`/`canSubmit`를 loadModel.ts로 위임 | 3 |
| `ui/src/components/__tests__/RunDialog.test.tsx` (수정) | 신규: 2차 legend "프로파일", closed에서 곡선 disabled, open+curve→closed 리셋, http_timeout 단일. 기존 테스트 전부 보존 | 3 |

**중요 — 사전 준비(첫 subagent 전 1회):** 새 `EnterWorktree` 워크트리면 `cd ui && pnpm install`로 deps 설치. UI-only지만 commit이 pre-commit cargo 훅(full workspace)을 돌리므로, 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm해 cold-build flake(`ui/CLAUDE.md`·루트 CLAUDE.md)를 피한다. UI 게이트(`pnpm lint && pnpm test && pnpm build`)는 훅이 안 돌리므로 매 task에서 수동.

---

## Task 1: `loadModel.ts` 순수함수 + 불변식 테스트

**Files:**
- Create: `ui/src/components/loadModel.ts`
- Test: `ui/src/components/__tests__/loadModel.test.ts`

이 task는 `buildProfile`의 모드 분기(`RunDialog.tsx:310-343`)와 모드 검증 플래그(`RunDialog.tsx:208-258`)를 순수함수로 추출한다. RunDialog는 Task 3에서 이 함수를 쓴다(이 task에선 RunDialog 무변경).

- [ ] **Step 1: 실패하는 테스트 작성**

Create `ui/src/components/__tests__/loadModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildLoadProfile, loadModelErrors, type LoadModelState } from "../loadModel";

// 유효한 기준 state — 각 테스트가 모드만 바꿔 쓴다.
function base(): LoadModelState {
  return {
    loadModel: "closed",
    rateMode: "fixed",
    vus: 5,
    duration: 30,
    rampUp: 0,
    targetRps: "100",
    maxInFlight: "200",
    stages: [{ target: "100", duration_seconds: "30" }],
    thinkMin: "",
    thinkMax: "",
    thinkSeed: "",
  };
}

describe("buildLoadProfile — 필드-형태 불변식 (§7.1)", () => {
  it("closed: target_rps/stages/max_in_flight 부재", () => {
    const p = buildLoadProfile({ ...base(), loadModel: "closed" });
    expect(p.target_rps).toBeUndefined();
    expect(p.stages).toBeUndefined();
    expect(p.max_in_flight).toBeUndefined();
    expect(p.vus).toBe(5);
    expect(p.duration_seconds).toBe(30);
  });

  it("closed: think_time은 허용(open만 금지) — 둘 다 채우면 emit", () => {
    const p = buildLoadProfile({ ...base(), loadModel: "closed", thinkMin: "100", thinkMax: "200" });
    expect(p.think_time).toEqual({ min_ms: 100, max_ms: 200 });
  });

  it("open+fixed: stages/think_time 부재, ramp_up===0, target_rps·max_in_flight 존재", () => {
    const p = buildLoadProfile({ ...base(), loadModel: "open", rateMode: "fixed" });
    expect(p.stages).toBeUndefined();
    expect(p.think_time).toBeUndefined();
    expect(p.ramp_up_seconds).toBe(0);
    expect(p.target_rps).toBe(100);
    expect(p.max_in_flight).toBe(200);
    expect(p.vus).toBe(0);
  });

  it("open+curve: target_rps/think_time 부재, ramp_up===0, duration===0, stages·max_in_flight 존재", () => {
    const p = buildLoadProfile({ ...base(), loadModel: "open", rateMode: "curve" });
    expect(p.target_rps).toBeUndefined();
    expect(p.think_time).toBeUndefined();
    expect(p.ramp_up_seconds).toBe(0);
    expect(p.duration_seconds).toBe(0);
    expect(p.max_in_flight).toBe(200);
    expect(p.stages).toEqual([{ target: 100, duration_seconds: 30 }]);
    expect(p.vus).toBe(0);
  });
});

describe("loadModelErrors — 모드별 범위 검증", () => {
  it("closed: rampUp > duration이면 rampInvalid", () => {
    expect(loadModelErrors({ ...base(), rampUp: 31, duration: 30 }).rampInvalid).toBe(true);
    expect(loadModelErrors({ ...base(), rampUp: 0, duration: 30 }).rampInvalid).toBe(false);
  });

  it("open+fixed: 빈/범위초과 target_rps는 targetRpsInvalid", () => {
    expect(
      loadModelErrors({ ...base(), loadModel: "open", rateMode: "fixed", targetRps: "" }).targetRpsInvalid,
    ).toBe(true);
    expect(
      loadModelErrors({ ...base(), loadModel: "open", rateMode: "fixed", targetRps: "100" }).targetRpsInvalid,
    ).toBe(false);
  });

  it("open: max_in_flight 범위초과는 maxInFlightInvalid", () => {
    expect(
      loadModelErrors({ ...base(), loadModel: "open", maxInFlight: "0" }).maxInFlightInvalid,
    ).toBe(true);
    expect(
      loadModelErrors({ ...base(), loadModel: "open", maxInFlight: "10001" }).maxInFlightInvalid,
    ).toBe(true);
  });

  it("open+curve: 모든 target=0이면 stagesInvalid", () => {
    expect(
      loadModelErrors({
        ...base(),
        loadModel: "open",
        rateMode: "curve",
        stages: [{ target: "0", duration_seconds: "30" }],
      }).stagesInvalid,
    ).toBe(true);
  });

  it("closed에선 stagesInvalid 항상 false (curve는 open 전용)", () => {
    expect(
      loadModelErrors({ ...base(), loadModel: "closed", rateMode: "curve" }).stagesInvalid,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test loadModel`
Expected: FAIL — `Failed to resolve import "../loadModel"` (모듈 없음).

- [ ] **Step 3: `loadModel.ts` 구현**

Create `ui/src/components/loadModel.ts`:

```ts
import type { Profile } from "../api/schemas";

/** RunDialog가 소유하는 부하-모델 관련 state(정규화 전 — 숫자/문자열 혼재). */
export type LoadModelState = {
  loadModel: "closed" | "open";
  rateMode: "fixed" | "curve";
  vus: number;
  duration: number;
  rampUp: number;
  targetRps: string;
  maxInFlight: string;
  stages: { target: string; duration_seconds: string }[];
  thinkMin: string;
  thinkMax: string;
  thinkSeed: string;
};

/** buildLoadProfile이 채우는 Profile의 부분집합. 나머지(loop_breakdown_cap/
 *  http_timeout_seconds/data_binding/criteria)는 RunDialog의 `base`가 채운다. */
export type LoadProfileFields = Pick<Profile, "vus" | "duration_seconds" | "ramp_up_seconds"> &
  Partial<Pick<Profile, "think_time" | "think_seed" | "target_rps" | "max_in_flight" | "stages">>;

export type LoadModelErrors = {
  rampInvalid: boolean; // closed: rampUp > duration
  targetRpsInvalid: boolean; // open+fixed
  maxInFlightInvalid: boolean; // open (fixed·curve 공통)
  stagesInvalid: boolean; // open+curve
};

/** closed-loop think time. 둘 다 채워야 emit(한 칸만 채우면 undefined = 미설정). */
function buildThinkTime(s: LoadModelState): { min_ms: number; max_ms: number } | undefined {
  if (s.thinkMin.trim() === "" || s.thinkMax.trim() === "") return undefined;
  return { min_ms: Number(s.thinkMin), max_ms: Number(s.thinkMax) };
}

/** 모드별 Profile 필드를 만든다. 각 모드는 자기 필드만 emit해 서버 400 조합
 *  (open+ramp_up>0 / open+think_time / stages+target_rps / stages+duration>0)을
 *  표현 불가능하게 한다. `RunDialog.tsx:310-343`에서 이관. */
export function buildLoadProfile(s: LoadModelState): LoadProfileFields {
  if (s.loadModel === "open" && s.rateMode === "curve") {
    return {
      vus: 0,
      duration_seconds: 0, // curve: 총 길이 = sum(stages); 서버는 >0 + stages를 400
      ramp_up_seconds: 0,
      max_in_flight: Number(s.maxInFlight),
      stages: s.stages.map((x) => ({
        target: Number(x.target),
        duration_seconds: Number(x.duration_seconds),
      })),
      // NO target_rps, NO think_time
    };
  }
  if (s.loadModel === "open") {
    return {
      vus: 0,
      duration_seconds: s.duration,
      ramp_up_seconds: 0,
      target_rps: Number(s.targetRps),
      max_in_flight: Number(s.maxInFlight),
      // NO think_time — open-loop은 run-level think time 금지
    };
  }
  return {
    vus: s.vus,
    duration_seconds: s.duration,
    ramp_up_seconds: s.rampUp,
    think_time: buildThinkTime(s),
    think_seed: s.thinkSeed.trim() !== "" ? Number(s.thinkSeed) : undefined,
    // target_rps / max_in_flight 생략 → closed-loop byte-identical
  };
}

/** 모드별 입력 범위 검증 플래그. `RunDialog.tsx:208-258`에서 이관. 숫자 게이트는
 *  여기 + canSubmit(RunDialog)이 담당(§7.2) — buildLoadProfile은 형태만. */
export function loadModelErrors(s: LoadModelState): LoadModelErrors {
  const rampInvalid = s.rampUp > s.duration;
  const targetRpsNum = Number(s.targetRps);
  const maxInFlightNum = Number(s.maxInFlight);
  const targetRpsInvalid =
    s.targetRps.trim() === "" ||
    !Number.isInteger(targetRpsNum) ||
    targetRpsNum < 1 ||
    targetRpsNum > 1_000_000;
  const maxInFlightInvalid =
    s.maxInFlight.trim() === "" ||
    !Number.isInteger(maxInFlightNum) ||
    maxInFlightNum < 1 ||
    maxInFlightNum > 10_000;
  const stagesInvalid =
    s.rateMode === "curve" &&
    s.loadModel === "open" &&
    (s.stages.length === 0 ||
      s.stages.some((x) => {
        const t = Number(x.target);
        const d = Number(x.duration_seconds);
        return (
          x.target.trim() === "" ||
          x.duration_seconds.trim() === "" ||
          !Number.isInteger(t) ||
          t < 0 ||
          t > 1_000_000 ||
          !Number.isInteger(d) ||
          d < 1
        );
      }) ||
      !s.stages.some((x) => Number(x.target) > 0));
  return { rampInvalid, targetRpsInvalid, maxInFlightInvalid, stagesInvalid };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test loadModel`
Expected: PASS (위 모든 it green).

- [ ] **Step 5: 타입·린트 확인 + 커밋**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 통과(`tsc -b` 에러 0 — `LoadProfileFields`가 `Profile`과 호환).

```bash
git add ui/src/components/loadModel.ts ui/src/components/__tests__/loadModel.test.ts
git commit -m "feat(ui): loadModel.ts 순수함수(buildLoadProfile+loadModelErrors) + 불변식 테스트"
```
(커밋은 pre-commit cargo 훅을 돌림 — 사전 warm 권장.)

---

## Task 2: `LoadModelFields.tsx` presentational 컴포넌트

**Files:**
- Create: `ui/src/components/LoadModelFields.tsx`
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`

모드 셀렉터(2축) + 사분면별 필드 + stages 에디터 + 곡선 미리보기. controlled(상태·setter는 props). `http_timeout`은 여기 없음(RunDialog 공유 입력). `max_in_flight`는 open일 때 **1개**만.

- [ ] **Step 1: 실패하는 테스트 작성**

Create `ui/src/components/__tests__/LoadModelFields.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoadModelFields } from "../LoadModelFields";
import type { LoadModelErrors } from "../loadModel";

const noErrs: LoadModelErrors = {
  rampInvalid: false,
  targetRpsInvalid: false,
  maxInFlightInvalid: false,
  stagesInvalid: false,
};

function setup(overrides: Partial<React.ComponentProps<typeof LoadModelFields>> = {}) {
  const props: React.ComponentProps<typeof LoadModelFields> = {
    loadModel: "closed",
    setLoadModel: vi.fn(),
    rateMode: "fixed",
    setRateMode: vi.fn(),
    vus: 5,
    setVus: vi.fn(),
    duration: 30,
    setDuration: vi.fn(),
    rampUp: 0,
    setRampUp: vi.fn(),
    targetRps: "100",
    setTargetRps: vi.fn(),
    maxInFlight: "200",
    setMaxInFlight: vi.fn(),
    stages: [{ target: "100", duration_seconds: "30" }],
    setStages: vi.fn(),
    errs: noErrs,
    ...overrides,
  };
  render(<LoadModelFields {...props} />);
  return props;
}

describe("LoadModelFields", () => {
  it("부하 모델 + 프로파일 두 fieldset을 렌더", () => {
    setup();
    expect(screen.getByRole("group", { name: /부하 모델/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
  });

  it("closed일 때 곡선 라디오는 disabled (곧 지원)", () => {
    setup({ loadModel: "closed" });
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeDisabled();
  });

  it("open일 때 곡선 라디오는 enabled", () => {
    setup({ loadModel: "open" });
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeEnabled();
  });

  it("closed 라디오 선택 시 setLoadModel('closed') + setRateMode('fixed')", async () => {
    const user = userEvent.setup();
    const props = setup({ loadModel: "open", rateMode: "curve" });
    await user.click(screen.getByRole("radio", { name: /closed-loop/i }));
    expect(props.setLoadModel).toHaveBeenCalledWith("closed");
    expect(props.setRateMode).toHaveBeenCalledWith("fixed");
  });

  it("closed 모드: VUs/Ramp-up 입력, target_rps·max_in_flight 입력 없음", () => {
    setup({ loadModel: "closed" });
    expect(screen.getByLabelText("VUs")).toBeInTheDocument();
    expect(screen.getByLabelText("Ramp-up (s)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Target RPS")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max in-flight")).not.toBeInTheDocument();
  });

  it("open+fixed 모드: Target RPS + Max in-flight 각 1개, VUs 없음", () => {
    setup({ loadModel: "open", rateMode: "fixed" });
    expect(screen.getByLabelText("Target RPS")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Max in-flight")).toHaveLength(1);
    expect(screen.queryByLabelText("VUs")).not.toBeInTheDocument();
  });

  it("open+curve 모드: Max in-flight 1개 + stage 입력 + 부하 모양 select", () => {
    setup({ loadModel: "open", rateMode: "curve" });
    expect(screen.getAllByLabelText("Max in-flight")).toHaveLength(1);
    expect(screen.getByLabelText("stage target 0")).toBeInTheDocument();
    expect(screen.getByLabelText("부하 모양")).toBeInTheDocument();
  });

  it("http_timeout 입력은 여기 없음 (RunDialog 공유)", () => {
    setup({ loadModel: "closed" });
    expect(screen.queryByLabelText(/HTTP timeout/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test LoadModelFields`
Expected: FAIL — `Failed to resolve import "../LoadModelFields"`.

- [ ] **Step 3: `LoadModelFields.tsx` 구현**

Create `ui/src/components/LoadModelFields.tsx` (모드 JSX를 `RunDialog.tsx:449-772`에서 이관 — `http_timeout` 제거, `max_in_flight`는 open 1개, 에러 `<p>`는 입력 옆으로, state 접근은 props):

```tsx
import type { Dispatch, SetStateAction } from "react";
import type { LoadModelErrors } from "./loadModel";
import { LOAD_SHAPES } from "./loadShapes";
import { StageCurvePreview } from "./StageCurvePreview";

type StageRow = { target: string; duration_seconds: string };

type Props = {
  loadModel: "closed" | "open";
  setLoadModel: (m: "closed" | "open") => void;
  rateMode: "fixed" | "curve";
  setRateMode: (m: "fixed" | "curve") => void;
  vus: number;
  setVus: (n: number) => void;
  duration: number;
  setDuration: (n: number) => void;
  rampUp: number;
  setRampUp: (n: number) => void;
  targetRps: string;
  setTargetRps: (s: string) => void;
  maxInFlight: string;
  setMaxInFlight: (s: string) => void;
  stages: StageRow[];
  setStages: Dispatch<SetStateAction<StageRow[]>>;
  errs: LoadModelErrors;
};

const INPUT = "mt-1 block w-full rounded border border-slate-300 px-2 py-1";

export function LoadModelFields({
  loadModel,
  setLoadModel,
  rateMode,
  setRateMode,
  vus,
  setVus,
  duration,
  setDuration,
  rampUp,
  setRampUp,
  targetRps,
  setTargetRps,
  maxInFlight,
  setMaxInFlight,
  stages,
  setStages,
  errs,
}: Props) {
  return (
    <>
      {/* 1차 축: 부하 모델 */}
      <fieldset className="mb-3">
        <legend className="text-sm text-slate-600 mb-1">부하 모델</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="load-model"
              value="closed"
              checked={loadModel === "closed"}
              onChange={() => {
                setLoadModel("closed");
                setRateMode("fixed"); // closed+curve(곧 지원)는 도달 불가
              }}
            />
            Closed-loop (VU)
          </label>
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="load-model"
              value="open"
              checked={loadModel === "open"}
              onChange={() => setLoadModel("open")}
            />
            Open-loop (rate)
          </label>
        </div>
      </fieldset>

      {/* 2차 축: 프로파일(고정/곡선) — closed에선 곡선 disabled */}
      <fieldset className="mb-3">
        <legend className="text-sm text-slate-600 mb-1">프로파일</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="rate-mode"
              value="fixed"
              checked={rateMode === "fixed"}
              onChange={() => setRateMode("fixed")}
            />
            고정
          </label>
          <label
            className={`flex items-center gap-1 text-sm ${
              loadModel === "closed" ? "cursor-not-allowed text-slate-400" : "cursor-pointer"
            }`}
          >
            <input
              type="radio"
              name="rate-mode"
              value="curve"
              checked={rateMode === "curve"}
              disabled={loadModel === "closed"}
              onChange={() => setRateMode("curve")}
            />
            곡선{loadModel === "closed" ? " (곧 지원)" : ""}
          </label>
        </div>
      </fieldset>

      {loadModel === "closed" ? (
        <>
          <div className="grid grid-cols-3 gap-4 mb-3">
            <label className="block text-sm">
              <span className="text-slate-600">VUs</span>
              <input
                type="number"
                min={1}
                aria-label="VUs"
                value={vus}
                onChange={(e) => setVus(Number(e.target.value))}
                className={INPUT}
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Duration (s)</span>
              <input
                type="number"
                min={1}
                aria-label="Duration (s)"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className={INPUT}
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Ramp-up (s)</span>
              <input
                type="number"
                min={0}
                aria-label="Ramp-up (s)"
                value={rampUp}
                onChange={(e) => setRampUp(Number(e.target.value))}
                className={INPUT}
                aria-invalid={errs.rampInvalid}
                aria-describedby={errs.rampInvalid ? "ramp-up-error" : undefined}
              />
            </label>
          </div>
          {errs.rampInvalid && (
            <p id="ramp-up-error" className="mb-3 text-red-600 text-sm">
              Ramp-up must be ≤ duration.
            </p>
          )}
        </>
      ) : (
        <>
          {/* Max in-flight — fixed/curve 공통, 1개 */}
          <div className="mb-3 max-w-xs">
            <label className="block text-sm">
              <span className="text-slate-600">Max in-flight</span>
              <input
                type="number"
                min={1}
                max={10000}
                aria-label="Max in-flight"
                value={maxInFlight}
                onChange={(e) => setMaxInFlight(e.target.value)}
                className={INPUT}
                aria-invalid={errs.maxInFlightInvalid}
                aria-describedby={errs.maxInFlightInvalid ? "max-in-flight-error" : undefined}
              />
              <span className="text-xs text-slate-500">
                동시 처리 상한 — 서비스가 목표 레이트를 못 따라가면 초과분은 drop되어 리포트에
                표시됩니다
              </span>
            </label>
          </div>
          {errs.maxInFlightInvalid && (
            <p id="max-in-flight-error" className="mb-3 text-red-600 text-sm">
              Max in-flight must be between 1 and 10,000.
            </p>
          )}

          {rateMode === "fixed" ? (
            <>
              <div className="grid grid-cols-2 gap-4 mb-3">
                <label className="block text-sm">
                  <span className="text-slate-600">Target RPS</span>
                  <input
                    type="number"
                    min={1}
                    max={1000000}
                    aria-label="Target RPS"
                    value={targetRps}
                    onChange={(e) => setTargetRps(e.target.value)}
                    className={INPUT}
                    aria-invalid={errs.targetRpsInvalid}
                    aria-describedby={errs.targetRpsInvalid ? "target-rps-error" : undefined}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-600">Duration (s)</span>
                  <input
                    type="number"
                    min={1}
                    aria-label="Duration (s)"
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                    className={INPUT}
                  />
                </label>
              </div>
              {errs.targetRpsInvalid && (
                <p id="target-rps-error" className="mb-3 text-red-600 text-sm">
                  Target RPS must be between 1 and 1,000,000.
                </p>
              )}
            </>
          ) : (
            <div className="mb-3">
              <label className="block text-sm mb-2">
                <span className="text-slate-600">부하 모양</span>
                <select
                  aria-label="부하 모양"
                  defaultValue=""
                  onChange={(e) => {
                    const shape = LOAD_SHAPES.find((s) => s.id === e.target.value);
                    if (shape) {
                      setStages(
                        shape.stages.map((s) => ({
                          target: String(s.target),
                          duration_seconds: String(s.duration_seconds),
                        })),
                      );
                    }
                  }}
                  className={INPUT}
                >
                  <option value="">직접 입력</option>
                  {LOAD_SHAPES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-slate-500 mb-1">
                각 단계가 끝날 때의 목표 초당 요청 수 (이전 값에서 선형 변화)
              </p>
              <p className="text-xs text-slate-500 mb-2">이 단계가 지속되는 시간(초)</p>
              {stages.map((s, i) => (
                <div key={i} className="flex items-end gap-2 mb-2">
                  <label className="block text-sm flex-1 min-w-0">
                    <span className="text-slate-600">목표 RPS</span>
                    <input
                      type="number"
                      min={0}
                      max={1000000}
                      aria-label={`stage target ${i}`}
                      value={s.target}
                      onChange={(e) =>
                        setStages((prev) =>
                          prev.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)),
                        )
                      }
                      className={INPUT}
                    />
                  </label>
                  <label className="block text-sm flex-1 min-w-0">
                    <span className="text-slate-600">지속(s)</span>
                    <input
                      type="number"
                      min={1}
                      aria-label={`stage duration ${i}`}
                      value={s.duration_seconds}
                      onChange={(e) =>
                        setStages((prev) =>
                          prev.map((r, j) =>
                            j === i ? { ...r, duration_seconds: e.target.value } : r,
                          ),
                        )
                      }
                      className={INPUT}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`remove stage ${i}`}
                    disabled={stages.length <= 1}
                    onClick={() => setStages((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 px-2 py-1 text-slate-500 hover:text-red-600 disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() =>
                    setStages((prev) => [...prev, { target: "100", duration_seconds: "30" }])
                  }
                  className="text-sm text-blue-600 hover:underline"
                >
                  + 단계 추가
                </button>
                <span className="ml-3 text-xs text-slate-500">
                  총 길이: {stages.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0)}s
                </span>
              </div>
              {errs.stagesInvalid && (
                <p role="alert" className="mt-2 text-red-600 text-sm">
                  각 단계는 목표 0–1,000,000 · 지속 ≥1초, 최소 한 단계의 목표 &gt; 0 이어야 합니다
                </p>
              )}
              {(() => {
                const previewStages = stages
                  .map((s) => ({
                    target: Number(s.target),
                    duration_seconds: Number(s.duration_seconds),
                  }))
                  .filter(
                    (s) =>
                      Number.isFinite(s.target) &&
                      Number.isFinite(s.duration_seconds) &&
                      s.duration_seconds > 0,
                  );
                return previewStages.length > 0 ? (
                  <div className="mt-2">
                    <span className="text-xs text-slate-500">미리보기</span>
                    <div
                      className="h-32"
                      role="img"
                      aria-label="레이트 곡선 미리보기 (x: 누적 초, y: RPS)"
                    >
                      <StageCurvePreview stages={previewStages} />
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          )}
        </>
      )}
    </>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test LoadModelFields`
Expected: PASS (8 it green).

- [ ] **Step 5: 타입·린트 확인 + 커밋**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 통과.

```bash
git add ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx
git commit -m "feat(ui): LoadModelFields presentational 컴포넌트(2축 셀렉터, closed+curve disabled, max_in_flight 1개)"
```

---

## Task 3: RunDialog 배선 — `<LoadModelFields/>` + 공유 http_timeout + 위임

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Modify: `ui/src/components/__tests__/RunDialog.test.tsx`

RunDialog의 인라인 모드 JSX·검증·buildProfile 분기를 Task 1·2 산출물로 교체. **상태(useState)는 그대로 둔다**(프리셋/prefill 무변경). 신규 동작: 2차 legend "프로파일", closed에서 곡선 disabled, open+curve→closed 리셋, http_timeout 단일 공유.

> **주(구현자):** 아래 `현 :NNN` 줄 번호는 **편집 전 현재 파일 기준**이다. Step 4·6의 편집이 위쪽 줄을 지우거나 줄여 그 아래 번호가 밀리므로, 각 편집 대상은 **줄 번호가 아니라 인용한 내용**(식별자·JSX 블록)으로 찾아라. 순서대로(Step 3→9) 적용하면 충돌 없음.

- [ ] **Step 1: 신규/조정 테스트 먼저 작성(RED)**

Edit `ui/src/components/__tests__/RunDialog.test.tsx` — describe 블록 끝에 추가(기존 it은 건드리지 않음 — 셀렉터 보존):

```tsx
  it("2차 축 '프로파일' fieldset이 항상 보인다", () => {
    renderDialog();
    expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
  });

  it("closed 모드에서 곡선 라디오는 disabled", () => {
    renderDialog();
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeDisabled();
  });

  it("open→곡선→closed 전환 시 rateMode가 fixed로 리셋된다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /closed-loop/i }));
    // 다시 open으로 가도 곡선이 아니라 고정이 선택돼 있어야 함(리셋됨)
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    expect(screen.getByRole("radio", { name: /고정/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /곡선/ })).not.toBeChecked();
  });

  it("각 모드에서 HTTP timeout 입력은 정확히 1개", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getAllByLabelText(/HTTP timeout/i)).toHaveLength(1); // closed
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    expect(screen.getAllByLabelText(/HTTP timeout/i)).toHaveLength(1); // open+fixed
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    expect(screen.getAllByLabelText(/HTTP timeout/i)).toHaveLength(1); // open+curve
  });
```

> **주(구현자):** `renderDialog(hasLoop = true)` 헬퍼는 `RunDialog.test.tsx` 상단(현 `:21-38`)에 이미 있다(QueryClientProvider + `scenarioId="S1"`/`hasLoop`/`scenario={null}`/`onCreated`/`onCancel`로 마운트, `{...utils, onCreated, onCancel}` 반환). 신규 it은 그대로 `renderDialog()` 호출하면 된다 — 새 헬퍼 불요. `screen`/`userEvent`도 상단에서 이미 import됨.

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test RunDialog`
Expected: FAIL — "프로파일" group 없음(현재 legend는 "레이트"·open 전용), closed에 곡선 라디오 없음(현재 closed엔 rate-mode 라디오 미렌더) → 신규 4 it RED. 기존 it은 GREEN 유지.

- [ ] **Step 3: RunDialog 임포트 추가**

Edit `ui/src/components/RunDialog.tsx` — 상단 import 블록(현 `:22-23` 부근, `LOAD_SHAPES`/`StageCurvePreview` import 옆)을 교체:

기존:
```tsx
import { LOAD_SHAPES } from "./loadShapes";
import { StageCurvePreview } from "./StageCurvePreview";
```
신규:
```tsx
import { LoadModelFields } from "./LoadModelFields";
import { buildLoadProfile, loadModelErrors, type LoadModelState } from "./loadModel";
```
(`LOAD_SHAPES`/`StageCurvePreview`는 이제 `LoadModelFields`만 쓰므로 RunDialog에서 제거.)

- [ ] **Step 4: 검증 플래그 → `loadModelErrors`로 교체**

Edit `RunDialog.tsx` — 현재 `:208-258`의 모드 검증 블록(`rampInvalid` … `stagesInvalid`까지)을 찾아 교체.

기존(요지):
```tsx
  const rampInvalid = rampUp > duration;
  // ...
  const targetRpsInvalid = ...;
  const maxInFlightInvalid = ...;
  const stagesInvalid = ...;
```
신규 — 이 4개 선언을 통째로 한 줄로:
```tsx
  // 모드 state를 모아 순수 헬퍼에 위임(필드 형태·검증). 나머지 state는 RunDialog 소유.
  const loadState: LoadModelState = {
    loadModel,
    rateMode,
    vus,
    duration,
    rampUp,
    targetRps,
    maxInFlight,
    stages,
    thinkMin,
    thinkMax,
    thinkSeed,
  };
  const loadErrs = loadModelErrors(loadState);
```
이후 같은 파일에서 `rampInvalid`·`targetRpsInvalid`·`maxInFlightInvalid`·`stagesInvalid`를 참조하던 곳을 `loadErrs.rampInvalid` 등으로 바꾼다(아래 Step 5의 canSubmit + Step 7에서 JSX 제거로 대부분 사라짐). `loopCapInvalid`/`httpTimeoutInvalid`/`thinkInvalid`/`sloActiveCount`/`pacingActiveCount`는 **그대로 둔다**.

- [ ] **Step 5: `canSubmit`를 `loadErrs`로**

Edit `RunDialog.tsx` — `canSubmit`(현 `:259-282`) 내부의 모드 플래그 참조를 `loadErrs.*`로:

신규:
```tsx
  const canSubmit =
    loadModel === "open"
      ? rateMode === "curve"
        ? !loadErrs.maxInFlightInvalid &&
          !loadErrs.stagesInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          bindingValid &&
          !mutation.isPending
        : duration >= 1 &&
          !loadErrs.targetRpsInvalid &&
          !loadErrs.maxInFlightInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          bindingValid &&
          !mutation.isPending
      : vus >= 1 &&
        duration >= 1 &&
        !loadErrs.rampInvalid &&
        !loopCapInvalid &&
        !httpTimeoutInvalid &&
        !thinkInvalid &&
        bindingValid &&
        !mutation.isPending;
```

- [ ] **Step 6: `buildProfile`을 `buildLoadProfile`로**

Edit `RunDialog.tsx` — `buildProfile`(현 `:303-344`)의 3개 모드 분기를 `base + buildLoadProfile`로 교체. 그리고 이제 안 쓰이는 `buildThinkTime`(현 `:298-301`)을 **삭제**(loadModel.ts로 이관됨).

기존 `buildProfile` 본문 전체:
```tsx
  function buildProfile(): Profile {
    const base = { ... };
    if (loadModel === "open" && rateMode === "curve") { return {...}; }
    if (loadModel === "open") { return {...}; }
    return { ... };
  }
```
신규:
```tsx
  function buildProfile(): Profile {
    return {
      loop_breakdown_cap: hasLoop ? loopCap : 0,
      http_timeout_seconds: httpTimeout,
      data_binding: binding ?? undefined,
      criteria: buildCriteria(),
      ...buildLoadProfile(loadState),
    };
  }
```
(`buildCriteria`는 그대로. `buildThinkTime` 함수 정의는 삭제 — `loadModel.ts`로 옮겨졌고 RunDialog에선 미사용.)

- [ ] **Step 7: 모드 JSX → `<LoadModelFields/>` + 공유 http_timeout**

Edit `RunDialog.tsx` — 현 `:449-824` 범위(부하 모델 toggle `<fieldset>`부터 `max-in-flight-error` `<p>`까지: load-model fieldset / closed·open 분기 / rate-mode fieldset / fixed·curve 필드 / stages 에디터 / ramp·target·max-in-flight 에러 `<p>`들)를 통째로 아래로 교체. **단 `hasLoop` loop-cap 블록(현 `:774-794`)과 `loop-cap-error`/`http-timeout-error` `<p>`(현 `:802-812`)는 보존**해야 하므로, 정확히는:

(a) `:449-772`(load model + 모드 필드 JSX 전체)를 다음으로 교체:
```tsx
      <LoadModelFields
        loadModel={loadModel}
        setLoadModel={setLoadModel}
        rateMode={rateMode}
        setRateMode={setRateMode}
        vus={vus}
        setVus={setVus}
        duration={duration}
        setDuration={setDuration}
        rampUp={rampUp}
        setRampUp={setRampUp}
        targetRps={targetRps}
        setTargetRps={setTargetRps}
        maxInFlight={maxInFlight}
        setMaxInFlight={setMaxInFlight}
        stages={stages}
        setStages={setStages}
        errs={loadErrs}
      />

      {/* HTTP timeout — 모든 모드 공통(transport 설정), 1개만 */}
      <div className="mb-3 max-w-xs">
        <label className="block text-sm">
          <span className="text-slate-600">HTTP timeout (s)</span>
          <input
            type="number"
            min={1}
            max={600}
            aria-label="HTTP timeout (s)"
            value={httpTimeout}
            onChange={(e) => setHttpTimeout(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            aria-invalid={httpTimeoutInvalid}
            aria-describedby={httpTimeoutInvalid ? "http-timeout-error" : undefined}
          />
        </label>
      </div>
```

(b) 이어지는 에러 `<p>` 블록 중 **모드 관련 3개만 제거**(LoadModelFields로 이관됨): `loadModel === "closed" && rampInvalid` 블록(현 `:796-800`), `target-rps-error` 블록(현 `:814-818`), `max-in-flight-error` 블록(현 `:820-824`). **`loop-cap-error`(현 `:802-806`)와 `http-timeout-error`(현 `:808-812`)는 그대로 둔다.** 결과적으로 loop-cap 블록(`hasLoop && (...)`)과 그 두 에러 `<p>`는 `<LoadModelFields/>`+http_timeout 입력 뒤에 그대로 남는다.

> **주(구현자):** 교체 후 RunDialog 안에 `LOAD_SHAPES`/`StageCurvePreview`/`buildThinkTime`/`rampInvalid` 등 **죽은 참조가 없어야** 한다. `cd ui && pnpm lint`의 `no-unused-vars`로 잡힌다(`--max-warnings=0`). 남은 `rampInvalid`/`targetRpsInvalid`/`maxInFlightInvalid`/`stagesInvalid` 식별자 참조는 전부 `loadErrs.*`로 바뀌었거나 JSX 제거로 사라졌어야 함.

- [ ] **Step 8: 전체 게이트 + RED 해소 확인**

Run: `cd ui && pnpm test RunDialog`
Expected: 신규 4 it PASS + 기존 it 전부 PASS.

Run (전체 — targeted green ≠ full green, `ui/CLAUDE.md`): `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warning, 전체 스위트 0 fail, `tsc -b` 0 error.

> 만약 기존 it 중 `getByLabelText(/HTTP timeout/i)` 또는 `Max in-flight`가 깨지면 — 단일화한 입력의 `aria-label`("HTTP timeout (s)"/"Max in-flight")·`aria-describedby` id("http-timeout-error"/"max-in-flight-error")가 정확한지 확인(스펙 §8 I-4).

- [ ] **Step 9: 커밋**

(커밋 전 cargo warm: `cargo build -p handicap-worker && cargo build --workspace`.)

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "refactor(ui): RunDialog 부하모드를 LoadModelFields+loadModel로 추출, 2축 명료화·http_timeout/max_in_flight 중복제거"
```

---

## Task 4: 라이브 검증 + 문서

**Files:**
- Modify: `ui/CLAUDE.md` (함정 노트 1줄)
- Modify: `docs/roadmap.md` (모드 선택기 완료 반영)

- [ ] **Step 1: 라이브 run 1회(머지 전 필수 — `ui/CLAUDE.md`)**

`dev-doctor` 스킬 또는 수동으로 controller+worker 띄우고(`cargo build -p handicap-worker --bin worker` 먼저), RunDialog로 **closed / open-fixed / open-curve 각 1회** run 생성 → 리포트까지 확인. (payload byte-identical이라 회귀 위험 낮지만 run 생성/응답-파싱 경로는 RTL·tsc로 안 잡힘.) closed에서 곡선 라디오 disabled, open+curve→closed 리셋도 브라우저에서 눈으로 확인.

- [ ] **Step 2: 함정 노트 + 로드맵 갱신**

`ui/CLAUDE.md`의 "다단계 ramp UI" 섹션에 1줄 추가(출처 태그 포함):
```
- **부하 모드 셀렉터는 2축(loadModel×rateMode) 유지 + `LoadModelFields`/`loadModel.ts` 추출** (모드 선택기): closed+curve는 disabled "곧 지원"(closed-loop VU 곡선=미래 슬라이스). `buildLoadProfile`(순수)이 모드별 필드 형태를, `canSubmit`이 숫자 범위를 막는다(§7.1/§7.2 분리). http_timeout은 모드 무관 공유 입력 1개(RunDialog), max_in_flight는 open 1개(LoadModelFields). 모드 추가 시 `loadModel.ts` 불변식 테스트가 격리 회귀를 잡는다.
```

`docs/roadmap.md` §D의 "연기: 부하모델 모드 선택기" 줄(line 127)을 **✅ 완료**로 갱신(2축 보존·closed+curve coming-soon·UI-only 요지).

- [ ] **Step 3: 커밋(docs-only, fast-path)**

```bash
git add ui/CLAUDE.md docs/roadmap.md
git commit -m "docs(roadmap,ui-claude): 부하 모드 선택기 완료 — 2축 보존 리팩터"
```

---

## 완료 기준 (전체 게이트)

- `cd ui && pnpm lint && pnpm test && pnpm build` 전부 통과(전체 스위트).
- 기존 RunDialog 테스트 0 회귀(라디오-role·라벨 단언 보존).
- 신규: 프로파일 legend / closed-곡선 disabled / open+curve→closed 리셋 / http_timeout·max_in_flight 단일 / buildLoadProfile 필드-형태 불변식.
- 라이브 closed/open-fixed/open-curve 각 1 run PASS.
- 엔진·proto·컨트롤러·마이그레이션 diff 0(`git diff --stat`이 `ui/` + 2 docs만).

## 마무리 (브랜치 통합)

`superpowers:finishing-a-development-branch` 또는 루트 CLAUDE.md git 토폴로지대로 master ff-merge(`git -C /Users/sgj/develop/handicap merge --ff-only <branch>` 또는 워크트리면 `ExitWorktree`). 최종 whole-feature 리뷰는 `handicap-reviewer` 에이전트(repo-trap-aware — 와이어 무변경·죽은 참조·prefill 불변식 재확인).
