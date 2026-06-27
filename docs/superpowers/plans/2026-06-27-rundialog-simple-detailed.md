# RunDialog 간단/상세 모드 + 정밀계기 재디자인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog에 `간단/상세` 세그먼트 모드 토글 + 실시간 요약 footer(시그니처) + 프리셋 동선(불러오기 위/저장 아래) + 측정 노출 + 정밀계기(라이트) 룩을 더해 초보 QA가 압도되지 않게 한다.

**Architecture:** 모드는 *가시성만* 게이트하고 모든 폼 state는 RunDialog 부모가 소유 → `profileForm.buildProfile`/`resolveEnv` 출력(POST 페이로드)은 같은 입력에 byte-identical(R11). 공유 컴포넌트(`LoadModelFields`·`EnvironmentPicker`)는 **additive optional prop**으로 게이트해 ScheduleForm은 미전달=byte-identical(R12). 새 표현은 additive 프리미티브 `Segmented` 하나 + `Input` `numeric` 옵션 + 순수 헬퍼 `runSummary` + RunDialog-국소 JSX.

**Tech Stack:** TypeScript/React, Tailwind, Vitest + React Testing Library. 오프라인 CSP(시스템 폰트만).

**스펙(정규 단일소스):** `docs/superpowers/specs/2026-06-27-rundialog-simple-detailed-design.md` — 각 task는 거기 R-id를 충족한다. 충돌 시 spec이 우선. (단 R17 곡선 읽기전용 카드는 spec §4.2 자구상 LoadModelFields이지만 **이 plan은 RunDialog가 렌더**한다 — 부모가 모드+`StageCurvePreview`를 보유; LoadModelFields는 simple+curve에서 *아무것도* 안 그린다. 두 곳에 카드가 생기지 않게 plan을 따른다.)

## Global Constraints

- **UI-only**: `crates/**`·`proto`·`migrations`·`ui/src/api/schemas.ts` **0-diff**(R13). `ko.ts`는 **추가-only**(기존 키 0-diff).
- **byte-identical 불변식(R11)**: `profileForm.buildProfile`·`buildLoadProfile`·`deriveLoadMode`·`loadModelErrors`·`canSubmit` *검증식*·`resolveEnv` 로직 **0-diff**. 같은 입력 → `profile`+`env` 페이로드 deep-equal.
- **ScheduleForm byte-identical(R12)**: `LoadModelFields`·`EnvironmentPicker` 신규 prop은 전부 optional, ScheduleForm 미전달(`ScheduleForm.tsx:307,403`). 공유 `INPUT` 상수(`LoadModelFields.tsx:60-61`) 0-diff.
- **기존 6 프리미티브(Field/Input 기본/Select/Section/Callout/Badge)·`accent` 토큰·차트 색 0-diff(R14)**. `Input`은 새 optional `numeric`만 추가(기본 렌더 동일 문자열).
- **모든 사용자-노출 문구(라벨·aria-label·요약·힌트) `ko.ts` 경유(ADR-0035·R16)** — 인라인 영어 0.
- **tdd-guard(ui/CLAUDE.md)**: watched `ui/src/**`(non-test) 편집 전 pending test-path 파일 필요 → **각 task에서 `*.test.ts(x)` 파일을 가장 먼저 편집**(RED diff). `ko.ts`도 watched production이라 **테스트 파일보다 먼저 편집하면 `[tdd-guard] Blocked`** — 순서 엄수.
- **pre-commit = UI 게이트**(`pnpm lint && pnpm test && pnpm build`). 단일 파일 반복은 `pnpm test <name>`(**`--` 금지**). 각 task **독립 green 커밋**. 머지 전 인자 없는 전체 `pnpm test` 1회.
- 커맨드는 `cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-redesign/ui`에서 `pnpm ...`.

---

### Task 1: `Segmented` 프리미티브 (간단/상세 토글)

**Files:**
- Create: `ui/src/components/ui/Segmented.tsx`
- Test: `ui/src/components/ui/__tests__/Segmented.test.tsx`

**Interfaces:**
- Produces: `Segmented<T extends string>({ value, onChange, options, ariaLabel, className? }): JSX` — `value: T`, `onChange: (v:T)=>void`, `options: ReadonlyArray<{ value: T; label: string }>`, `ariaLabel: string`. `role="radiogroup"`; 각 세그먼트는 `<button role="radio" aria-checked>`; active는 `bg-accent-600 text-white`. ←/→/↑/↓ 키로 선택 이동. 라벨 텍스트는 호출자가 ko로 주입(프리미티브는 generic).

- [ ] **Step 1: Write the failing test** — `ui/src/components/ui/__tests__/Segmented.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Segmented } from "../Segmented";

const opts = [
  { value: "simple", label: "간단" },
  { value: "detailed", label: "상세" },
] as const;

it("renders a radiogroup with one radio per option, checked reflects value", () => {
  render(<Segmented value="simple" onChange={() => {}} options={opts} ariaLabel="설정 모드" />);
  expect(screen.getByRole("radiogroup", { name: "설정 모드" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "false");
});

it("calls onChange with the option value on click", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Segmented value="simple" onChange={onChange} options={opts} ariaLabel="설정 모드" />);
  await user.click(screen.getByRole("radio", { name: "상세" }));
  expect(onChange).toHaveBeenCalledWith("detailed");
});

it("moves selection with arrow keys", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Segmented value="simple" onChange={onChange} options={opts} ariaLabel="설정 모드" />);
  screen.getByRole("radio", { name: "간단" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenCalledWith("detailed");
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test Segmented` → FAIL (`Cannot find module '../Segmented'`).

- [ ] **Step 3: Write minimal implementation** — `ui/src/components/ui/Segmented.tsx`

```tsx
import type { KeyboardEvent } from "react";

type Option<T extends string> = { value: T; label: string };

export function Segmented<T extends string>({
  value, onChange, options, ariaLabel, className = "",
}: {
  value: T; onChange: (v: T) => void;
  options: ReadonlyArray<Option<T>>; ariaLabel: string; className?: string;
}) {
  const idx = options.findIndex((o) => o.value === value);
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(options[(idx + 1) % options.length].value);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(options[(idx - 1 + options.length) % options.length].value);
    }
  }
  return (
    <div role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}
      className={`inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 ${className}`}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={active}
            tabIndex={active ? 0 : -1} onClick={() => onChange(o.value)}
            className={`rounded-md px-3.5 py-1 text-sm font-semibold transition-colors ${
              active ? "bg-accent-600 text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm test Segmented` → PASS (3 tests).
- [ ] **Step 5: Commit** — `git add ui/src/components/ui/Segmented.tsx ui/src/components/ui/__tests__/Segmented.test.tsx && git commit -m "feat(ui): Segmented 프리미티브 (radiogroup 토글)"` (run_in_background:false, no pipe).

---

### Task 2: `Input` `numeric` 옵션 (tabular-nums, 기본 off=byte-identical)

**Files:**
- Modify: `ui/src/components/ui/Input.tsx`
- Test: `ui/src/components/ui/__tests__/Input.test.tsx` (이미 존재 → **append**)

**Interfaces:**
- Produces: `Input` gains optional `numeric?: boolean`. off/absent → className 문자열이 기존과 **정확히 동일**(`${BASE} ${className ?? ""}`). on → `tabular-nums`를 BASE 뒤에 trailing-space 없이 삽입.

- [ ] **Step 1: Write the failing test** — append to `ui/src/components/ui/__tests__/Input.test.tsx`

```tsx
it("numeric off → no tabular-nums (default render unchanged)", () => {
  const { container } = render(<Input />);
  expect(container.querySelector("input")!.className).not.toContain("tabular-nums");
});
it("numeric on → adds tabular-nums", () => {
  const { container } = render(<Input numeric />);
  expect(container.querySelector("input")!.className).toContain("tabular-nums");
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test Input` → FAIL.
- [ ] **Step 3: Write minimal implementation** — `ui/src/components/ui/Input.tsx`

```tsx
import { forwardRef, type InputHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

type Props = InputHTMLAttributes<HTMLInputElement> & { numeric?: boolean };

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, numeric, ...rest }, ref,
) {
  const base = numeric ? `${BASE} tabular-nums` : BASE;
  return <input ref={ref} className={`${base} ${className ?? ""}`} {...rest} />;
});
```
> `numeric` off → `${BASE} ${className ?? ""}`로 **기존과 동일 문자열**. `numeric`은 구조분해로 `...rest`에서 분리(DOM 누출 방지).

- [ ] **Step 4: Run** — `pnpm test Input` → PASS.
- [ ] **Step 5: Commit** — `git add ui/src/components/ui/Input.tsx ui/src/components/ui/__tests__/Input.test.tsx && git commit -m "feat(ui): Input numeric 옵션 (tabular-nums, 기본 off byte-identical)"`.

---

### Task 3: `runSummary` 순수 헬퍼 + ko 요약 키 (R8)

**Files:**
- Create: `ui/src/components/runSummary.ts`
- Test: `ui/src/components/__tests__/runSummary.test.ts`
- Modify: `ui/src/i18n/ko.ts` (추가-only)

**Interfaces:**
- Consumes: `LoadModelState`(`loadModel.ts:4-18`), `peakStageTarget`(`sizing.ts:86`, `(stages:{target:string}[])=>number|null`), `ko`.
- Produces: `runSummary(s: LoadModelState): { text: string; tone: "ok" | "warn"; curve: boolean }`. 모드 분기(spec §3.3/R8). **wire 무접촉**.

> **tdd-guard 순서**: Step 1=테스트(test-path, 항상 허용) → Step 3=ko.ts(watched) → Step 4=구현. ko를 테스트보다 먼저 쓰면 Blocked.

- [ ] **Step 1: Write the failing test (먼저!)** — `ui/src/components/__tests__/runSummary.test.ts`

```ts
import { runSummary } from "../runSummary";
import type { LoadModelState } from "../loadModel";

const base: LoadModelState = {
  loadModel: "closed", rateMode: "fixed", vus: 100, duration: 300, rampUp: 0,
  targetRps: "100", maxInFlight: "200", stages: [{ target: "100", duration_seconds: "30" }],
  thinkMin: "", thinkMax: "", thinkSeed: "", rampDown: "graceful", workerCount: "1",
};

it("closed+fixed → 동시 사용자 N명 · 시간, no request estimate", () => {
  const r = runSummary({ ...base, vus: 100, duration: 300 });
  expect(r.text).toContain("동시 사용자 100명");
  expect(r.text).toContain("5분");
  expect(r.text).not.toMatch(/건/);
  expect(r.tone).toBe("ok"); expect(r.curve).toBe(false);
});
it("open+fixed → 목표 RPS · 약 rps×duration건", () => {
  const r = runSummary({ ...base, loadModel: "open", targetRps: "100", duration: 300 });
  expect(r.text).toContain("목표 100 RPS");
  expect(r.text).toContain("30,000건");
});
it("curve → 최대 P (곡선) + curve:true", () => {
  const r = runSummary({ ...base, rateMode: "curve",
    stages: [{ target: "50", duration_seconds: "30" }, { target: "100", duration_seconds: "60" }] });
  expect(r.curve).toBe(true); expect(r.text).toContain("최대 100");
});
it("invalid (vus<1) → 설정을 확인하세요, tone warn", () => {
  const r = runSummary({ ...base, vus: 0 });
  expect(r.text).toBe("설정을 확인하세요"); expect(r.tone).toBe("warn");
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm test runSummary` → FAIL (module missing).
- [ ] **Step 3: Add ko keys** — `ui/src/i18n/ko.ts` `runDialog` 블록에:

```ts
summaryClosed: (vus: number, time: string) => `동시 사용자 ${vus}명 · ${time}`,
summaryRampUp: (sec: number) => (sec > 0 ? `램프업 ${sec}초` : "램프업 없음"),
summaryOpen: (rps: number, total: string, time: string) => `목표 ${rps} RPS · 약 ${total}건 · ${time}`,
summaryOpenSub: (mif: string) => `동시 요청 상한 ${mif || "—"}`,
summaryCurveVu: (peak: number) => `최대 ${peak}명 (곡선)`,
summaryCurveRps: (peak: number) => `최대 ${peak} RPS (곡선)`,
summaryCurveSub: (totalSec: number, stages: number) => `총 ${totalSec}초 · ${stages}단계`,
summaryInvalid: "설정을 확인하세요",
```

- [ ] **Step 4: Implement** — `ui/src/components/runSummary.ts`

```ts
import type { LoadModelState } from "./loadModel";
import { peakStageTarget } from "./sizing";
import { ko } from "../i18n/ko";

function fmtTime(sec: number): string | null {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}분 ${r}초` : `${m}분`;
}

export function runSummary(s: LoadModelState): { text: string; tone: "ok" | "warn"; curve: boolean } {
  const warn = { text: ko.runDialog.summaryInvalid, tone: "warn" as const, curve: false };
  if (s.rateMode === "curve") {
    const valid = s.stages
      .map((x) => ({ t: Number(x.target), d: Number(x.duration_seconds) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.d) && x.d > 0);
    const peak = peakStageTarget(s.stages);
    if (valid.length === 0 || peak == null) return { ...warn, curve: true };
    const total = valid.reduce((a, x) => a + x.d, 0);
    const head = s.loadModel === "closed" ? ko.runDialog.summaryCurveVu(peak) : ko.runDialog.summaryCurveRps(peak);
    return { text: `${head} · ${ko.runDialog.summaryCurveSub(total, s.stages.length)}`, tone: "ok", curve: true };
  }
  if (s.loadModel === "closed") {
    const time = fmtTime(s.duration);
    if (!(s.vus >= 1) || !time) return warn;
    return { text: `${ko.runDialog.summaryClosed(s.vus, time)} (${ko.runDialog.summaryRampUp(s.rampUp)})`, tone: "ok", curve: false };
  }
  const rps = Number(s.targetRps), time = fmtTime(s.duration);
  if (!(rps >= 1) || !time) return warn;
  const total = (rps * Math.round(s.duration)).toLocaleString("ko");
  return { text: `${ko.runDialog.summaryOpen(rps, total, time)} · ${ko.runDialog.summaryOpenSub(s.maxInFlight)}`, tone: "ok", curve: false };
}
```

- [ ] **Step 5: Run** — `pnpm test runSummary` → PASS.
- [ ] **Step 6: Commit** — `git add ui/src/components/runSummary.ts ui/src/components/__tests__/runSummary.test.ts ui/src/i18n/ko.ts && git commit -m "feat(rundialog): runSummary 순수 헬퍼 + ko 요약 키 (R8)"`.

---

### Task 4: `EnvironmentPicker` `showOverrides` + 간단-모드 env 힌트 (R3·R12·R18)

**Files:**
- Modify: `ui/src/components/EnvironmentPicker.tsx`
- Test: `ui/src/components/__tests__/EnvironmentPicker.test.tsx` (이미 존재 → **append**, 기존 setup 재사용)
- Modify: `ui/src/i18n/ko.ts` (추가-only)

**Interfaces:**
- Produces: optional `showOverrides?: boolean`(기본 `true`). `false` → base-list·override `<ul>`·add-row 미렌더(셀렉터만). `overrides.filter(o=>o.key.trim()).length>0` → 셀렉터 옆 `ko.runDialog.envAppliedHint(N)` 렌더(R18). 미전달=true=기존 호출부 byte-identical.

> **tdd-guard 순서**: Step 1=테스트 → Step 2=ko → Step 3=구현.

- [ ] **Step 1: Write the failing test (먼저!)** — append to `EnvironmentPicker.test.tsx`. **aria-label은 한국어 실제값**(`ko.runDialog.envValueAria(0)` = `"환경 변수 값 0"`).

```tsx
it("showOverrides=false hides override editor and shows applied hint", () => {
  render(<EnvironmentPicker selectedEnvId={null} onSelect={() => {}} baseVars={{}}
    overrides={[{ key: "BASE_URL", value: "x" }]} onOverridesChange={() => {}} showOverrides={false} />);
  expect(screen.getByText("변수 1개 적용됨 (상세에서 편집)")).toBeInTheDocument();
  expect(screen.queryByLabelText("환경 변수 값 0")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox")).toBeInTheDocument();
});
it("default (showOverrides absent) shows override editor (byte-identical)", () => {
  render(<EnvironmentPicker selectedEnvId={null} onSelect={() => {}} baseVars={{}}
    overrides={[{ key: "BASE_URL", value: "x" }]} onOverridesChange={() => {}} />);
  expect(screen.getByDisplayValue("BASE_URL")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm test EnvironmentPicker` → FAIL.
- [ ] **Step 3: Add ko key** — `ko.runDialog`에 `envAppliedHint: (n: number) => \`변수 ${n}개 적용됨 (상세에서 편집)\`,`.
- [ ] **Step 4: Implement** — `EnvironmentPicker.tsx`: prop `showOverrides = true` 추가. 셀렉터 `<div>`(현 44-62) 직후:
```tsx
{!showOverrides && overrides.filter((o) => o.key.trim()).length > 0 && (
  <p className="text-xs text-slate-500">
    {ko.runDialog.envAppliedHint(overrides.filter((o) => o.key.trim()).length)}
  </p>
)}
```
base-list(64-106)·override `<h4>`+`<ul>`(108-156)·add-row(158-188)을 `{showOverrides && ( ... )}`로 감싼다. 셀렉터(44-62)는 항상 렌더.

- [ ] **Step 5: Run** — `pnpm test EnvironmentPicker` → PASS. (기존 RunDialog 테스트 `pnpm test RunDialog` 도 green — 미전달=true.)
- [ ] **Step 6: Commit** — `git add ui/src/components/EnvironmentPicker.tsx ui/src/components/__tests__/EnvironmentPicker.test.tsx ui/src/i18n/ko.ts && git commit -m "feat(rundialog): EnvironmentPicker showOverrides + env 적용 힌트 (R18)"`.

---

### Task 5: `LoadModelFields` `simpleMode`/타일/numeric 게이트 + it.each 락인 (R3·R4·R10·R12·R14·R17 일부)

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx`
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx` (헬퍼 = `setup`/`renderFields` at `:31,59`; mock testids `sizing-helper`/`slot-sizing-helper`/`worker-sizing-helper` at `:8-17`)
- Modify: `ui/src/i18n/ko.ts` (타일 설명·추가-only)

**Interfaces:**
- Produces: optional `simpleMode?: boolean`, `loadModelTiles?: boolean`, `numeric?: boolean`(모두 미전달=기존=R12).
  - `simpleMode` 숨김: 프로파일 fieldset(316-346), curveEditor 호출(351 closed-curve·634 open-curve), ramp_down(354-385), worker_count disclosure(516-581), open 구조 경고(idle/inert). **simple+curve면 LoadModelFields는 곡선 영역에 *아무것도* 안 그림**(빈 영역은 RunDialog R17 카드가 채움 — T8). 유지: 부하모델 선택(280-313), 크기 chips(389-419), 주 수치 그리드(420-464/585-617), VU/slot 사이징 도우미.
  - `loadModelTiles`: 부하모델을 **라디오→타일**로. **타일의 accessible name은 기존 `ko.loadModel.closedLoop`/`openLoop` 유지**(친절 문구는 *설명* 텍스트 `tileClosedDesc`/`tileOpenDesc`로) — 기존 `getByRole("radio",{name:/사용자 수 기준/|/요청 속도 기준/})` 셀렉터 보존. **기존 `<fieldset><legend>부하 모델</legend>` 래퍼 유지**(`:877` 그룹/fieldset 불변식 보존), 자식만 `<input type=radio>`→`<button role="radio" aria-checked>`.
  - `numeric`: 주 수치 `Input`에 `numeric` 전달 + raw curve/worker `<input>`(188·204·540) className을 `numeric ? \`${INPUT} tabular-nums\` : INPUT`(공유 `INPUT` 상수 0-diff·trailing space 없음).

- [ ] **Step 1: 테스트 먼저 (it.each 미렌더 락인 확장)** — `LoadModelFields.test.tsx` (헬퍼 `setup`/`renderFields` 재사용; `ko` import):

```tsx
it("simpleMode closed hides profile/curve/rampdown, keeps VU helper + numbers", () => {
  setup({ simpleMode: true, loadModel: "closed", rateMode: "fixed", onApplyVus: vi.fn(), sizingScenarioId: "s1" });
  expect(screen.queryByRole("group", { name: /프로파일/i })).not.toBeInTheDocument();
  expect(screen.getByTestId("sizing-helper")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /사용자 수 기준/ })).toBeInTheDocument(); // 타일/라디오 name 보존
});
it("simpleMode open hides worker disclosure, keeps slot helper", () => {
  setup({ simpleMode: true, loadModel: "open", rateMode: "fixed", onApplyMaxInFlight: vi.fn(), sizingScenarioId: "s1", setWorkerCount: vi.fn() });
  expect(screen.queryByRole("button", { name: /워커 수/ })).not.toBeInTheDocument();
  expect(screen.getByTestId("slot-sizing-helper")).toBeInTheDocument();
});
it("simpleMode + curve renders nothing for the curve area (RunDialog owns the R17 card)", () => {
  setup({ simpleMode: true, loadModel: "closed", rateMode: "curve" });
  expect(screen.queryByLabelText(/단계 1 목표/)).not.toBeInTheDocument(); // 곡선 stage 입력 부재
});
it("loadModelTiles renders load-model as role=radio tiles inside the fieldset, name preserved", () => {
  setup({ loadModelTiles: true, loadModel: "closed" });
  const group = screen.getByRole("group", { name: /부하 모델/i });
  expect(group.tagName).toBe("FIELDSET");
  expect(screen.getByRole("radio", { name: /사용자 수 기준/ })).toBeInTheDocument();
  expect(screen.getByText(ko.loadModel.tileClosedDesc)).toBeInTheDocument();
});
it("without new props, renders legacy radios + profile + worker (ScheduleForm parity)", () => {
  setup({ loadModel: "open", rateMode: "fixed", setWorkerCount: vi.fn() });
  expect(screen.getByRole("radio", { name: /요청 속도 기준/ })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
});
```
> `setup`의 정확한 인자 형태/기본 prop은 `LoadModelFields.test.tsx:31-58`에서 확인해 맞춘다. 곡선 stage 입력 aria-label은 `ko.loadModelFields.stageTargetAria(0)` 실제값으로 보정.

- [ ] **Step 2: Run to verify fail** — `pnpm test LoadModelFields` → FAIL.
- [ ] **Step 3: ko 타일 설명 추가** — `ko.loadModel`에 `tileClosedDesc: "N명이 동시에 반복 요청"`, `tileOpenDesc: "초당 N건씩 도착"`.
- [ ] **Step 4: Implement gating** — `LoadModelFields.tsx` Props에 optional 3종 추가·디스트럭처. 위 Interfaces대로:
  - 부하모델 fieldset(280-313): `loadModelTiles`면 `<legend>` 유지한 채 두 `<label><input radio>`를 `<button role="radio" aria-checked onClick>`로 교체(접근명=`ko.loadModel.closedLoop`/`openLoop` 텍스트 포함 + `tileClosedDesc`/`tileOpenDesc` 보조 텍스트). HelpTip은 타일 안 형제로 유지 가능. 미전달이면 기존 라디오.
  - `{!simpleMode && (프로파일 fieldset)}`·`{!simpleMode && (ramp_down)}`·`{!simpleMode && (worker disclosure)}`·`{!simpleMode && (idle/inert 경고)}`.
  - 곡선 arm: closed `rateMode==="curve" ? (simpleMode ? null : <>{curveEditor}{rampDownBlock}</>) : <fixedGrid>`; open 동형(`simpleMode ? null : curveEditor`). simple+curve = null.
  - 주 수치 `Input`에 `numeric={numeric}`; raw `<input className={INPUT}>`(188·204·540) → `className={numeric ? \`${INPUT} tabular-nums\` : INPUT}`.

- [ ] **Step 5: Run** — `pnpm test LoadModelFields` → PASS(신규 + 기존 `it.each` 미렌더 매트릭스 186/234/288/341 그대로).
- [ ] **Step 6: Commit** — `git add ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/i18n/ko.ts && git commit -m "feat(rundialog): LoadModelFields simpleMode/타일/numeric 게이트 (R3·R4·R10·R12)"`.

---

### Task 6: RunDialog — 모드 토글·섹션 게이트·기본모드 예측·**기존 테스트 마이그레이션** (R1·R2·R3·R4·R11)

> **이 task가 슬라이스의 무게중심이다.** 기본 모드를 `simple`로 바꾸면 `RunDialog.test.tsx`(82 `it`)의 *상세-전용 콘텐츠를 만지는* 테스트들이 깨진다 — 이전 plan의 "기존 green" 주장은 거짓이었다(리뷰 적발). 이 task는 모드 도입 + **명시적 마이그레이션**으로 전체 스위트를 다시 green으로 만든다.

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (모드 라벨·추가-only)

**Interfaces:**
- Consumes: `Segmented`(T1), `LoadModelFields simpleMode/loadModelTiles`(T5), `EnvironmentPicker showOverrides`(T4·여기선 상세=true 유지, 간단 게이트는 T7), `deriveLoadMode`(`loadModel.ts`).
- Produces: 없음. `buildProfile`/`env`/`canSubmit` 검증식 **0-diff**.

**마이그레이션 전략(저-churn, 검증됨):**
- 부하모델 타일 accessible name = 기존 `closedLoop`/`openLoop` 유지(T5) → `getByRole("radio",{name:/사용자 수 기준/|/요청 속도 기준/})` **29개 셀렉터 무변경**. fieldset 래퍼 유지 → `:877`("load-model … wrapped in a fieldset") **무변경**.
- 기본 `simple`이 숨기는 건 *상세-전용 섹션*뿐 → **상세 콘텐츠를 만지는 테스트만** 렌더 직후 `상세` 전환 1줄 추가. 부하모델 타일·프리셋 불러오기·env·Run/취소는 두 모드 공통이라 무변경.

- [ ] **Step 1: 테스트 — 헬퍼 + 신규 모드 케이스 + 마이그레이션** (test-path 먼저)
  - `RunDialog.test.tsx`에 헬퍼 추가: `async function toDetailed(user) { await user.click(screen.getByRole("radio", { name: "상세" })); }`.
  - **신규 케이스**(ko 라벨은 Step 2 후 매치):
```tsx
it("defaults to 간단; detailed-only sections absent", () => {
  renderDialog();
  expect(screen.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByRole("button", { name: /판정·고급/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: /프로파일/i })).not.toBeInTheDocument();
});
it("상세 reveals profile + 판정·고급 + binding", async () => {
  const user = userEvent.setup(); renderDialog(); await toDetailed(user);
  expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /판정·고급/ })).toBeInTheDocument();
});
it("SLO prefill opens 상세 (R2)", () => {
  renderWithInitial({ /* profile.criteria = { max_p95_ms: 500 }, env: {} */ } as RunPrefill);
  expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
});
it("env-override prefill opens 상세 (R2)", () => {
  renderWithInitial({ /* env: { BASE_URL: "x" } */ } as RunPrefill);
  expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
});
```
  - **byte-identical 골든(R11)**: 현 `RunDialog.test.tsx`의 `createRun` mock(`mutate` 인자 캡처) 패턴 재사용. 간단-기본 closed에서 Run 클릭 → `mutate`가 `{scenarioId, profile, env}`로 호출되고 `profile`이 현 기본값(`loop_breakdown_cap:0, http_timeout_seconds:30, measure_phases:false, vus:2, duration_seconds:5, ramp_up_seconds:0`)과 `toEqual`·`env` `toEqual {}`. (현 기본 payload는 리팩터 *전*에 한 번 캡처해 상수로 박는다.)
  - **마이그레이션(핵심)**: 기존 테스트 중 렌더 후 아래 selector를 쓰는 것에 `await toDetailed(user)`를 렌더 직후 삽입:
    - `/판정·고급/` (≈21곳: 226,254,277,609,629,637,…)
    - 프로파일/곡선/고정 radios·`group {name:/프로파일/}` (≈10곳: 942,968,980,990,1000,1027,1037,1110,1119,1132 부근)
    - `/워커 수/`, 프리셋 `저장`/`이름 변경`/`삭제`, `측정`/단계분해, SLO 입력(`/Max p95/` 등), 곡선 stage 입력.
    부하모델 타일·`/사용자 수 기준/`·`/요청 속도 기준/`·프리셋 *불러오기*·env·Run 셀렉터는 **건드리지 않는다**.
  - **무용해진 불변식 2개**: `:877`("wrapped in a fieldset")는 fieldset 보존이라 **그대로 통과**(변경 없음). `:1102`("2차 축 '프로파일' fieldset이 항상 보인다")는 이제 상세-전용 → **rework**: 이름을 "…상세에서 보인다"로 바꾸고 `await toDetailed(user)` 후 단언.

- [ ] **Step 2: Run to verify fail** — `pnpm test RunDialog` → 신규 케이스 FAIL + 일부 기존 케이스가 마이그레이션 전이라 FAIL(예상).
- [ ] **Step 3: ko 모드 라벨 추가** — `ko.runDialog`: `modeSimple: "간단"`, `modeDetail: "상세"`, `modeAria: "설정 모드"`.
- [ ] **Step 4: Implement (spec §4.1)** — `RunDialog.tsx`:
  1. **`advancedPrefill(initial)` 헬퍼 추출**: 현 `advancedOpen` 초기화 술어(134-145) 본문을 그대로 함수로. `advancedOpen` init이 이 헬퍼를 **그대로** 호출(동작 불변).
  2. **mode state**: `const [mode, setMode] = useState<"simple"|"detailed">(() => (advancedPrefill(initial) || deriveLoadMode(initial?.profile ?? {}).rateMode === "curve" || Number(initial?.profile.worker_count ?? 1) > 1 || (initial != null && Object.keys(initial.env).length > 0)) ? "detailed" : "simple")`.
  3. **헤더**: `<h3>` 행에 `<Segmented value={mode} onChange={setMode} options={[{value:"simple",label:ko.runDialog.modeSimple},{value:"detailed",label:ko.runDialog.modeDetail}]} ariaLabel={ko.runDialog.modeAria} />`(title 형제).
  4. **섹션 게이트**: 그룹 2(대상)의 DataBindingPanel·그룹 3(판정·고급) Section을 `{mode==="detailed" && ...}`로(env 셀렉터·LoadModelFields는 두 모드). LoadModelFields 호출에 `simpleMode={mode==="simple"} loadModelTiles` 추가.
  5. 프리셋 bookend·측정 승격·applied·blockedReasons·R17 카드·요약 footer·룩은 **T7~T9**에서. 이 task는 mode+게이트+예측+마이그레이션까지.

- [ ] **Step 5: Run until green** — `pnpm test RunDialog` → PASS. 남은 실패는 "상세 콘텐츠인데 toDetailed 누락"이 대부분 → 같은 규칙으로 `await toDetailed(user)` 추가(가드: 단언은 바꾸지 말고 `:1102`만 rework). 골든 green = byte-identical.
- [ ] **Step 6: Commit** — `git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx ui/src/i18n/ko.ts && git commit -m "feat(rundialog): 간단/상세 모드 토글·섹션 게이트·기본모드 예측 + 기존 테스트 마이그레이션 (R1·R2·R3·R4·R11)"`.

---

### Task 7: RunDialog — 프리셋 동선·측정 노출·진단 표면 (R5·R6·R7·R9·R18)

**Files:** Modify `ui/src/components/RunDialog.tsx`; Test `RunDialog.test.tsx`; Modify `ko.ts`(추가-only).

**Interfaces:** Consumes T6 mode state, `EnvironmentPicker showOverrides`(T4).

- [ ] **Step 1: 테스트 먼저** — `RunDialog.test.tsx` (헬퍼 `toDetailed` 재사용):
```tsx
it("preset load strip is above 부하 모델; save block is 상세-only at bottom (R7)", async () => {
  const user = userEvent.setup(); renderWithPresets(); // 프리셋 ≥1 fixture
  // 불러오기 select가 부하모델 fieldset보다 DOM 앞 (compareDocumentPosition)
  expect(screen.queryByRole("button", { name: /프리셋으로 저장/ })).not.toBeInTheDocument(); // 간단
  await toDetailed(user);
  expect(screen.getByRole("button", { name: /프리셋으로 저장/ })).toBeInTheDocument();
});
it("측정 토글 is a visible 상세 section outside 판정·고급 (R9)", async () => {
  const user = userEvent.setup(); renderDialog(); await toDetailed(user);
  expect(screen.getByText(/단계 분해/)).toBeInTheDocument(); // 판정·고급 펼치지 않아도 보임
});
it("간단 shows '상세 설정 N개 적용됨' when hidden detailed values set (R6)", () => {
  renderWithInitial({ /* profile.criteria={max_p95_ms:500}, env:{} */ } as RunPrefill); // → 상세로 열림
  // 간단 전환 후 카운트 — 또는 measure on 간단에서 카운트. ko.runDialog.appliedDetail(n) 매치.
});
it("hidden invalid http_timeout surfaces via blockedReasons in 간단 (R5)", async () => {
  // 상세 → http_timeout=0 → 간단 → Run disabled + getByText(ko.validation.httpTimeout)
});
it("env-override prefill + 간단 → '변수 N개 적용됨' 힌트 (R18)", () => {
  renderWithInitial({ /* env:{BASE_URL:"x"} */ } as RunPrefill); // 상세로 열림 → 간단 전환
  // ko.runDialog.envAppliedHint(1) 보임 (EnvironmentPicker showOverrides=false 경로)
});
```
- [ ] **Step 2: Run to verify fail** — `pnpm test RunDialog` → FAIL.
- [ ] **Step 3: ko 추가** — `ko.runDialog`: `measureTitle: "응답 시간 단계 분해"`, `measureDesc: "응답 시간을 DNS·연결·대기·다운로드로 나눠 측정 — 리포트에서 어디서 느린지 진단"`, `appliedDetail: (n: number) => \`상세 설정 ${n}개 적용됨\``.
- [ ] **Step 4: Implement (spec §4.1)** —
  - 프리셋 **불러오기 strip**(현 492-513)을 본문 *최상단*으로(두 모드, `presets.data?.length>0`). **저장/이름변경/삭제**(755-791)을 본문 *최하단·`{mode==="detailed" && ...}`*.
  - **측정**(744-751)을 판정·고급 Section *밖*, 별도 `{mode==="detailed" && <측정 섹션>}`(가치 라벨 `measureTitle`/`measureDesc` + HelpTip).
  - **고급 collapse 힌트 measure 제외**(631-633·리뷰 A): `advancedSetHint` 카운트를 `sloActiveCount + (loadModel==="closed"?pacingActiveCount:0)`로(measure 빠짐).
  - **EnvironmentPicker** 호출에 `showOverrides={mode==="detailed"}`.
  - **applied(R6)**: `mode==="simple" && detailedAppliedCount>0` → `ko.runDialog.appliedDetail(detailedAppliedCount)`. `detailedAppliedCount = advancedActiveCount + (rateMode==="curve"?1:0) + (Number(workerCount)>1?1:0) + (httpTimeout!==30?1:0) + (hasLoop && loopCap!==256?1:0) + (loadModel==="closed" && rateMode==="curve" && rampDown!=="graceful"?1:0)`.
  - **blockedReasons 일반화(R5)**: 조건 `!advancedOpen`→`(mode==="simple" || !advancedOpen)` + `...(mode==="simple" && loadModel==="open" && loadErrs.workerCountInvalid ? [ko.validation.workerCount] : [])`. `bindingBlock` 불변.
- [ ] **Step 5: Run** — `pnpm test RunDialog` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(rundialog): 프리셋 동선·측정 노출·진단 표면 (R5·R6·R7·R9·R18)"`.

---

### Task 8: RunDialog — 실시간 요약 footer(시그니처) + 곡선 읽기전용 카드 (R8·R17)

**Files:** Modify `ui/src/components/RunDialog.tsx`; Test `RunDialog.test.tsx`; Modify `ko.ts`(추가-only).

**Interfaces:** Consumes `runSummary`(T3), `StageCurvePreview`.

- [ ] **Step 1: 테스트 먼저** —
```tsx
it("renders live summary footer (closed/open/곡선/invalid)", async () => {
  // closed 100/300 → /동시 사용자 100명/ , /5분/
  // open 전환(상세→open 타일) → /약 30,000건/
  // vus 0 → "설정을 확인하세요"
});
it("간단 + 곡선 prefill → 읽기전용 곡선 카드 + Run 가능 + payload vu_stages 유지 (R17)", async () => {
  renderWithInitial({ /* profile.vu_stages=[{target:50,duration_seconds:30},{target:100,duration_seconds:60}] */ } as RunPrefill);
  // 곡선 prefill → 상세로 열림. 수동 간단 전환 → ko.runDialog.curveCardTitle 카드 + StageCurvePreview(role=img)
  // Run 클릭 → mutate profile.vu_stages 유지
});
```
- [ ] **Step 2: Run to verify fail** — FAIL.
- [ ] **Step 3: ko 추가** — `ko.runDialog`: `curveCardTitle: "곡선 부하 설정됨"`, `curveCardHint: "상세 모드에서 편집"`.
- [ ] **Step 4: Implement** —
  - **요약 footer**: Run/취소 버튼 행(926-941)을 sticky footer로 감싸고 좌측에 `const sum = runSummary(loadState);` 결과: `<div className="flex items-center gap-3"><span className="w-0.5 self-stretch rounded bg-accent-600" />{sum.curve && <div role="img" aria-label={...}><StageCurvePreview .../></div>}<span className={sum.tone==="warn"?"text-amber-700":"text-slate-900"}>{sum.text}</span></div>` + 기존 Run/취소.
  - **R17 곡선 카드**: LoadModelFields 아래, `mode==="simple" && rateMode==="curve"`이면 읽기전용 카드(`curveCardTitle`/`curveCardHint` + 소형 `StageCurvePreview`). 토글이 rateMode를 **안 건드림**(스냅 금지).
- [ ] **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(rundialog): 실시간 요약 footer + 곡선 읽기전용 카드 (R8·R17)"`.

---

### Task 9: 정밀계기(라이트) 룩 + 전체 검증 (R14·R13·R16·R15)

**Files:** Modify `ui/src/components/RunDialog.tsx`; Test `RunDialog.test.tsx`(구조 단언, 스냅샷 아님).

- [ ] **Step 1: 가벼운 구조 테스트 먼저** — eyebrow 섹션 라벨·`numeric` 전달 등 최소 단언(시각은 라이브). 기존 RTL이 라벨 텍스트 셀렉트라 깨지지 않는지 확인.
- [ ] **Step 2: Implement 룩** — RunDialog 섹션을 헤어라인 구분선(`border-t border-slate-100`)·ALL-CAPS tracked eyebrow(`text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500`)·8px 리듬. 주 수치에 `numeric`(LoadModelFields prop) 전달. dialog 컨테이너 단일 elevation(border + 약 shadow). **accent 토큰만**, 그라데이션/글래스/고스트 카드/과대 radius 금지(spec anti-slop).
- [ ] **Step 3: Run targeted** — `pnpm test RunDialog` → PASS.
- [ ] **Step 4: 전체 게이트** — `pnpm lint && pnpm test && pnpm build` → 0 warn / all green / build OK.
- [ ] **Step 5: grep 불변식(R13·R16)** — repo 루트에서:
  - `git diff --stat master -- ui/src/api/schemas.ts crates proto migrations` → **빈 출력**.
  - `git diff master -- ui/src/i18n/ko.ts` → 추가만(기존 키 변경 0).
  - 신규 인라인 영어 0(`grep -nE '"[A-Za-z][A-Za-z ]{2,}"' ui/src/components/RunDialog.tsx ui/src/components/runSummary.ts ui/src/components/ui/Segmented.tsx` → 사용자-노출 영어 없음; 전부 ko 경유).
- [ ] **Step 6: Commit** — `git commit -m "feat(rundialog): 정밀계기 룩 + 전체 검증 게이트 (R14·R13·R16)"`.

---

## 최종 검증 (머지 전 — finish-slice가 수행)

- **handicap-reviewer**(Opus) 전체 diff — R11 byte-identical(골든)·R12 ScheduleForm(미전달)·R13 0-diff·wire 1:1·기존 테스트 마이그레이션이 단언을 약화하지 않았는지(상세-전환만 추가, 단언 보존).
- **security-reviewer**(path-gate): RunDialog는 env 바인딩 표면을 *재배치*만 하므로 매치 시 게이트 — `showOverrides` 게이트가 env payload(resolveEnv)를 바꾸지 않는지 확인.
- **`/live-verify`(필수·R11·S-D 갭)**: 워크트리 자체 바이너리 + responder + 격리 DB로 ① 간단 closed run 생성→리포트 도달, ② 상세 open run 1회, console Zod 0.

## Self-review 메모(작성자)

- **Spec coverage**: R1(T6)·R2(T6 mode-init incl env)·R3/R4(T5+T6)·R5(T7 blockedReasons+workerCount)·R6(T7 detailedAppliedCount)·R7(T7 bookend)·R8(T3+T8)·R9(T7 측정)·R10(T5)·R11(T6 골든+live)·R12(T4/T5 미전달 락인)·R13/R16(T9 grep)·R14(T1/T2/T9)·R15(T1 a11y·T9)·R17(T5 null+T8 카드)·R18(T4 힌트+T7 wiring). 전 R 대응.
- **리뷰 NEEDS-REWORK 반영**: ① T6에 기존-테스트 마이그레이션 명시(저-churn 전략: 타일 name 보존+fieldset 보존 → 29 셀렉터·`:877` 무변경, 상세-전환만 추가, `:1102` rework) — 거짓 "PASS" 제거. ② T3/T4 ko를 테스트 *뒤*로(tdd-guard). ③ `setup`(not `renderLMF`)·EnvironmentPicker.test append·한국어 aria-label `환경 변수 값 0`. ④ R17 카드=RunDialog(중복 카드 방지 명시).
- **타입 일관성**: `Segmented`(T1)↔T6, `runSummary`(T3)↔T8, `showOverrides`(T4)↔T7, `simpleMode/loadModelTiles/numeric`(T5)↔T6 일치.
