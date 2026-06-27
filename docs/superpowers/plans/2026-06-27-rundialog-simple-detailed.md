# RunDialog 간단/상세 모드 + 정밀계기 재디자인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog에 `간단/상세` 세그먼트 모드 토글 + 실시간 요약 footer(시그니처) + 프리셋 동선(불러오기 위/저장 아래) + 측정 노출 + 정밀계기(라이트) 룩을 더해 초보 QA가 압도되지 않게 한다.

**Architecture:** 모드는 *가시성만* 게이트하고 모든 폼 state는 RunDialog 부모가 소유 → `profileForm.buildProfile`/`resolveEnv` 출력(POST 페이로드)은 같은 입력에 byte-identical(R11). 공유 컴포넌트(`LoadModelFields`·`EnvironmentPicker`)는 **additive optional prop**으로 게이트해 ScheduleForm은 미전달=byte-identical(R12). 새 표현은 additive 프리미티브 `Segmented` 하나 + `Input` `numeric` 옵션 + 순수 헬퍼 `runSummary` + RunDialog-국소 JSX.

**Tech Stack:** TypeScript/React, Tailwind, Vitest + React Testing Library. 오프라인 CSP(시스템 폰트만).

**스펙(정규 단일소스):** `docs/superpowers/specs/2026-06-27-rundialog-simple-detailed-design.md` — 각 task는 거기 R-id를 충족한다. 충돌 시 spec이 우선.

## Global Constraints

- **UI-only**: `crates/**`·`proto`·`migrations`·`ui/src/api/schemas.ts` **0-diff**(R13). `ko.ts`는 **추가-only**(기존 키 0-diff).
- **byte-identical 불변식(R11)**: `profileForm.buildProfile`·`buildLoadProfile`·`deriveLoadMode`·`loadModelErrors`·`canSubmit` *검증식*·`resolveEnv` 로직 **0-diff**. 같은 입력 → `profile`+`env` 페이로드 deep-equal.
- **ScheduleForm byte-identical(R12)**: `LoadModelFields`·`EnvironmentPicker` 신규 prop은 전부 optional, ScheduleForm 미전달. 공유 `INPUT` 상수(`LoadModelFields.tsx:60-61`) 0-diff.
- **기존 6 프리미티브(Field/Input 기본/Select/Section/Callout/Badge)·`accent` 토큰·차트 색 0-diff(R14)**. `Input`은 새 optional `numeric`만 추가(기본 렌더 동일 문자열).
- **모든 사용자-노출 문구(라벨·aria-label·요약·힌트) `ko.ts` 경유(ADR-0035·R16)** — 인라인 영어 0.
- **tdd-guard(ui/CLAUDE.md)**: watched `ui/src/**`(non-test) 편집 전 pending test 필요 → **각 task에서 테스트 파일을 가장 먼저 편집**(RED diff). test-path(`__tests__/`·`*.test.tsx`)는 항상 허용.
- **pre-commit = UI 게이트**(`pnpm lint && pnpm test && pnpm build`). 단일 파일 반복은 `pnpm test <name>`(**`--` 금지**). 각 task **독립 green 커밋**. 머지 전 인자 없는 전체 `pnpm test` 1회.
- 커맨드는 `cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-redesign/ui`에서 `pnpm ...`.

---

### Task 1: `Segmented` 프리미티브 (간단/상세 토글)

**Files:**
- Create: `ui/src/components/ui/Segmented.tsx`
- Test: `ui/src/components/ui/__tests__/Segmented.test.tsx`

**Interfaces:**
- Produces: `Segmented<T extends string>({ value, onChange, options, ariaLabel, className? }): JSX` — `value: T`, `onChange: (v:T)=>void`, `options: ReadonlyArray<{ value: T; label: string }>`, `ariaLabel: string`. `role="radiogroup"`; 각 세그먼트는 `<button role="radio" aria-checked>`; active는 `bg-accent-600 text-white`. ←/→/↑/↓ 키로 선택 이동(roving). 라벨 텍스트는 호출자가 ko로 주입(프리미티브는 generic).

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
  const group = screen.getByRole("radiogroup", { name: "설정 모드" });
  expect(group).toBeInTheDocument();
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
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<Option<T>>;
  ariaLabel: string;
  className?: string;
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
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3.5 py-1 text-sm font-semibold transition-colors ${
              active
                ? "bg-accent-600 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
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
- Test: `ui/src/components/ui/__tests__/Input.test.tsx`

**Interfaces:**
- Produces: `Input` gains optional `numeric?: boolean`. `numeric` off/absent → className **문자열이 기존과 정확히 동일**(`${BASE} ${className ?? ""}`). `numeric` on → `tabular-nums`를 BASE 뒤에 trailing-space 없이 삽입.

- [ ] **Step 1: Write the failing test** — append to `ui/src/components/ui/__tests__/Input.test.tsx`

```tsx
it("numeric off → no tabular-nums (default render unchanged)", () => {
  const { container } = render(<Input data-testid="x" />);
  expect(container.querySelector("input")!.className).not.toContain("tabular-nums");
});
it("numeric on → adds tabular-nums", () => {
  const { container } = render(<Input data-testid="x" numeric />);
  expect(container.querySelector("input")!.className).toContain("tabular-nums");
});
```
(`import { Input } from "../Input";` — 이미 있으면 재사용.)

- [ ] **Step 2: Run test to verify it fails** — `pnpm test Input` → FAIL (numeric not a prop / tabular-nums absent).

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
  { className, numeric, ...rest },
  ref,
) {
  const base = numeric ? `${BASE} tabular-nums` : BASE;
  return <input ref={ref} className={`${base} ${className ?? ""}`} {...rest} />;
});
```
> 주의: `numeric` off일 때 `${BASE} ${className ?? ""}`로 **기존과 동일 문자열**(trailing 처리 동일). `numeric`은 `...rest`로 새지 않게 구조분해로 분리.

- [ ] **Step 4: Run** — `pnpm test Input` → PASS.
- [ ] **Step 5: Commit** — `git add ui/src/components/ui/Input.tsx ui/src/components/ui/__tests__/Input.test.tsx && git commit -m "feat(ui): Input numeric 옵션 (tabular-nums, 기본 off byte-identical)"`.

---

### Task 3: `runSummary` 순수 헬퍼 + ko 요약 키 (R8)

**Files:**
- Create: `ui/src/components/runSummary.ts`
- Test: `ui/src/components/__tests__/runSummary.test.ts`
- Modify: `ui/src/i18n/ko.ts` (추가-only)

**Interfaces:**
- Consumes: `LoadModelState`(`loadModel.ts:4-18`), `peakStageTarget`(`sizing.ts`), `ko`.
- Produces: `runSummary(s: LoadModelState): { text: string; tone: "ok" | "warn"; curve: boolean }`. 모드 분기(spec §3.3/R8): closed+fixed=`동시 사용자 N명 · 시간(+램프업)` / open+fixed=`목표 R RPS · 약 R×T건 · 시간` / 곡선=`최대 P (곡선)·총 M초`+`curve:true` / invalid·미완성=`설정을 확인하세요`(tone:"warn"). 내부 `fmtTime(sec)`→"5분"/"90초"/"1분 30초". **wire 무접촉**.

- [ ] **Step 1: ko 키 추가 (테스트가 참조하므로 먼저)** — `ui/src/i18n/ko.ts` `runDialog` 블록에 추가:

```ts
// ko.runDialog 안에 추가 (함수 키는 ADR-0035 변수치환 규약)
summaryClosed: (vus: number, time: string) => `동시 사용자 ${vus}명 · ${time}`,
summaryRampUp: (sec: number) => (sec > 0 ? `램프업 ${sec}초` : "램프업 없음"),
summaryOpen: (rps: number, total: string, time: string) =>
  `목표 ${rps} RPS · 약 ${total}건 · ${time}`,
summaryOpenSub: (mif: string) => `동시 요청 상한 ${mif || "—"}`,
summaryCurveVu: (peak: number) => `최대 ${peak}명 (곡선)`,
summaryCurveRps: (peak: number) => `최대 ${peak} RPS (곡선)`,
summaryCurveSub: (totalSec: number, stages: number) => `총 ${totalSec}초 · ${stages}단계`,
summaryInvalid: "설정을 확인하세요",
```

- [ ] **Step 2: Write the failing test** — `ui/src/components/__tests__/runSummary.test.ts`

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
  expect(r.text).not.toMatch(/건/); // 닫힌 루프는 요청 수 미추정(정직)
  expect(r.tone).toBe("ok");
  expect(r.curve).toBe(false);
});
it("open+fixed → 목표 RPS · 약 rps×duration건", () => {
  const r = runSummary({ ...base, loadModel: "open", targetRps: "100", duration: 300 });
  expect(r.text).toContain("목표 100 RPS");
  expect(r.text).toContain("30,000건"); // 100*300, toLocaleString('ko')
});
it("curve → 최대 P (곡선) + curve:true", () => {
  const r = runSummary({ ...base, rateMode: "curve",
    stages: [{ target: "50", duration_seconds: "30" }, { target: "100", duration_seconds: "60" }] });
  expect(r.curve).toBe(true);
  expect(r.text).toContain("최대 100");
});
it("invalid (vus<1) → 설정을 확인하세요, tone warn", () => {
  const r = runSummary({ ...base, vus: 0 });
  expect(r.text).toBe("설정을 확인하세요");
  expect(r.tone).toBe("warn");
});
```

- [ ] **Step 3: Run to verify fail** — `pnpm test runSummary` → FAIL (module missing).

- [ ] **Step 4: Implement** — `ui/src/components/runSummary.ts` (spec §3.3 표대로). closed/open은 `rateMode==="fixed"` 전제, 곡선은 `peakStageTarget(stages)`/유효 stage 합. `Number()` 변환·범위 가드로 invalid 판정. 모든 문구 `ko.runDialog.summary*`.

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
    const text =
      (s.loadModel === "closed"
        ? ko.runDialog.summaryCurveVu(peak)
        : ko.runDialog.summaryCurveRps(peak)) +
      " · " + ko.runDialog.summaryCurveSub(total, s.stages.length);
    return { text, tone: "ok", curve: true };
  }
  if (s.loadModel === "closed") {
    const time = fmtTime(s.duration);
    if (!(s.vus >= 1) || !time) return warn;
    return {
      text: `${ko.runDialog.summaryClosed(s.vus, time)} (${ko.runDialog.summaryRampUp(s.rampUp)})`,
      tone: "ok", curve: false,
    };
  }
  // open + fixed
  const rps = Number(s.targetRps), time = fmtTime(s.duration);
  if (!(rps >= 1) || !time) return warn;
  const total = (rps * Math.round(s.duration)).toLocaleString("ko");
  return {
    text: `${ko.runDialog.summaryOpen(rps, total, time)} · ${ko.runDialog.summaryOpenSub(s.maxInFlight)}`,
    tone: "ok", curve: false,
  };
}
```

- [ ] **Step 5: Run** — `pnpm test runSummary` → PASS.
- [ ] **Step 6: Commit** — `git add ui/src/components/runSummary.ts ui/src/components/__tests__/runSummary.test.ts ui/src/i18n/ko.ts && git commit -m "feat(rundialog): runSummary 순수 헬퍼 + ko 요약 키 (R8)"`.

---

### Task 4: `EnvironmentPicker` `showOverrides` + 간단-모드 env 힌트 (R3·R12·R18)

**Files:**
- Modify: `ui/src/components/EnvironmentPicker.tsx`
- Test: `ui/src/components/__tests__/EnvironmentPicker.test.tsx` (없으면 Create)
- Modify: `ui/src/i18n/ko.ts` (추가-only)

**Interfaces:**
- Produces: `EnvironmentPicker` gains optional `showOverrides?: boolean`(기본 `true`). `false` → base-list·override 행 ul·add-row를 미렌더(셀렉터만). `overrides.length>0`(빈-키 제외 카운트 `N=overrides.filter(o=>o.key.trim()).length`)이면 셀렉터 옆에 `ko.runDialog.envAppliedHint(N)`("변수 N개 적용됨 (상세에서 편집)") 렌더(R18). `showOverrides` 미전달=true=기존 호출부(RunDialog 상세·TestRunSection) byte-identical.

- [ ] **Step 1: ko 키 추가** — `ko.runDialog`에 `envAppliedHint: (n: number) => \`변수 ${n}개 적용됨 (상세에서 편집)\`,`.

- [ ] **Step 2: Write the failing test** — `EnvironmentPicker.test.tsx`

```tsx
// showOverrides=false + overrides 있음 → 셀렉터 + 힌트만, override 입력 부재
it("showOverrides=false hides override editor and shows applied hint", () => {
  render(<EnvironmentPicker selectedEnvId={null} onSelect={() => {}} baseVars={{}}
    overrides={[{ key: "BASE_URL", value: "x" }]} onOverridesChange={() => {}} showOverrides={false} />);
  expect(screen.getByText("변수 1개 적용됨 (상세에서 편집)")).toBeInTheDocument();
  expect(screen.queryByLabelText(/env value 0/i)).not.toBeInTheDocument(); // override 행 부재
  expect(screen.getByRole("combobox")).toBeInTheDocument(); // 셀렉터는 존재
});
// 기본(미전달=true) → 기존 동작(override 행 보임)
it("default shows override editor (byte-identical)", () => {
  render(<EnvironmentPicker selectedEnvId={null} onSelect={() => {}} baseVars={{}}
    overrides={[{ key: "BASE_URL", value: "x" }]} onOverridesChange={() => {}} />);
  expect(screen.getByDisplayValue("BASE_URL")).toBeInTheDocument();
});
```
(`aria-label`은 `ko.runDialog.envValueAria(idx)` 실제값으로 셀렉터 보정 — 실제 라벨 텍스트는 ko에서 확인 후 맞춤.)

- [ ] **Step 3: Run to verify fail** — `pnpm test EnvironmentPicker` → FAIL.

- [ ] **Step 4: Implement** — `EnvironmentPicker.tsx`: prop `showOverrides = true` 추가. 셀렉터 `<div>`(현 44-62) 다음에:
```tsx
{!showOverrides && overrides.filter((o) => o.key.trim()).length > 0 && (
  <p className="text-xs text-slate-500">
    {ko.runDialog.envAppliedHint(overrides.filter((o) => o.key.trim()).length)}
  </p>
)}
```
그리고 base-list 블록(64-106)·override `<h4>`+`<ul>`(108-156)·add-row(158-188)을 `{showOverrides && ( ... )}`로 감싼다. 셀렉터(44-62)는 항상 렌더.

- [ ] **Step 5: Run** — `pnpm test EnvironmentPicker` → PASS. (기존 RunDialog/TestRun 테스트도 `pnpm test RunDialog` green — 미전달=true.)
- [ ] **Step 6: Commit** — `git add ui/src/components/EnvironmentPicker.tsx ui/src/components/__tests__/EnvironmentPicker.test.tsx ui/src/i18n/ko.ts && git commit -m "feat(rundialog): EnvironmentPicker showOverrides + env 적용 힌트 (R18)"`.

---

### Task 5: `LoadModelFields` `simpleMode`/타일/numeric 게이트 + it.each 락인 (R3·R4·R10·R12·R14·R17 일부)

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx`
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (타일 라벨/설명·추가-only)

**Interfaces:**
- Produces: `LoadModelFields` gains optional `simpleMode?: boolean`, `loadModelTiles?: boolean`, `numeric?: boolean`(모두 미전달=기존=R12). `simpleMode`면 숨김: 프로파일(고정/곡선) fieldset(316-346), curveEditor 호출(351·634), ramp_down(354-385), worker_count disclosure(516-581), open 구조 경고(idle/inert). 유지: 부하모델 선택(280-313; `loadModelTiles`면 타일), 크기 chips(389-419), 주 수치 그리드(420-464/585-617), VU/slot 사이징 도우미. `numeric`이면 주 수치 입력에 `numeric`(Input)·raw curve/worker `<input>`에 `tabular-nums` className(공유 `INPUT` 상수는 0-diff, 분기에서 `${INPUT} tabular-nums`).
- Consumes: `Segmented`는 **여기선 안 씀**(부하모델 타일은 라디오-타일 커스텀; 모드 토글 Segmented는 Task 6 RunDialog).

- [ ] **Step 1: 테스트 먼저 — it.each 미렌더 락인 확장** — `LoadModelFields.test.tsx`에 `simpleMode` 축 추가. 핵심 락인:

```tsx
// simpleMode=true closed → 프로파일 선택·곡선·ramp_down·worker disclosure 부재, VU 도우미는 존재
it("simpleMode closed hides profile/curve/rampdown/worker, keeps VU helper + numbers", () => {
  renderLMF({ simpleMode: true, loadModel: "closed", rateMode: "fixed",
    onApplyVus: vi.fn(), sizingScenarioId: "s1" });
  expect(screen.queryByRole("radiogroup", { name: "프로파일" })).not.toBeInTheDocument();
  expect(screen.queryByText("줄이는 방식")).not.toBeInTheDocument(); // ramp_down (ko 실제값 확인)
  expect(screen.getByTestId("sizing-helper")).toBeInTheDocument(); // VU 도우미 유지(기존 mock)
  expect(screen.getByLabelText(/동시 사용자/)).toBeInTheDocument(); // 주 수치 유지
});
// simpleMode=true open → worker disclosure 부재, slot 도우미 유지
it("simpleMode open hides worker disclosure, keeps slot helper", () => {
  renderLMF({ simpleMode: true, loadModel: "open", rateMode: "fixed",
    onApplyMaxInFlight: vi.fn(), sizingScenarioId: "s1", setWorkerCount: vi.fn() });
  expect(screen.queryByRole("button", { name: /워커 수/ })).not.toBeInTheDocument();
  expect(screen.getByTestId("slot-sizing-helper")).toBeInTheDocument();
});
// loadModelTiles=true → 부하모델이 radiogroup 타일(설명 동반)
it("loadModelTiles renders load-model as tiles", () => {
  renderLMF({ loadModelTiles: true, loadModel: "closed" });
  expect(screen.getByRole("radiogroup", { name: "부하 모델" })).toBeInTheDocument();
  expect(screen.getByText(ko.loadModel.tileClosedDesc)).toBeInTheDocument();
});
// ScheduleForm 락인: 신규 prop 미전달 → 기존 라디오 + 모든 상세 표시
it("without new props, renders legacy radios + profile + worker (ScheduleForm parity)", () => {
  renderLMF({ loadModel: "open", rateMode: "fixed" });
  expect(screen.getByRole("radio", { name: ko.loadModel.closedLoop })).toBeInTheDocument();
  expect(screen.getByRole("radiogroup", { name: "프로파일" })).toBeInTheDocument();
});
```
> `renderLMF`/`ko` import·기존 mock(`vi.mock` sizing helpers `slot-sizing-helper`/`sizing-helper`)은 파일의 기존 패턴 재사용. ramp_down/프로파일 라벨의 ko 실제 문자열은 `ko.ts`에서 확인해 정확매치.

- [ ] **Step 2: Run to verify fail** — `pnpm test LoadModelFields` → FAIL(신규 분기 없음).

- [ ] **Step 3: ko 타일 라벨 추가** — `ko.loadModel`에 `tileClosed: "동시 사용자 (VU)"`, `tileClosedDesc: "N명이 동시에 반복 요청"`, `tileOpen: "목표 RPS"`, `tileOpenDesc: "초당 N건씩 도착"`.

- [ ] **Step 4: Implement gating** — `LoadModelFields.tsx`:
  - props 디스트럭처에 `simpleMode`, `loadModelTiles`, `numeric` 추가(Props 타입에 optional).
  - 부하모델 fieldset(280-313): `loadModelTiles`면 `role="radiogroup" aria-label="부하 모델"` + 두 타일 버튼(`role="radio" aria-checked`, `ko.loadModel.tileClosed/Desc`/`tileOpen/Desc`), 아니면 기존 라디오. HelpTip은 타일에서 생략 가능(설명이 대체).
  - 프로파일 fieldset(316-346)·ramp_down(354-385)·worker disclosure(516-581): `{!simpleMode && ( ... )}`.
  - curveEditor 호출(351 closed-curve arm·634 open-curve arm): `simpleMode`면 이 arm 자체가 R17(Task 6에서 RunDialog가 곡선 카드 처리)이지만, **LoadModelFields는 simpleMode+curve일 때 곡선 에디터를 렌더하지 않음** — 즉 `rateMode==="curve" && simpleMode`면 곡선 블록 미렌더(빈 영역은 Task 6의 RunDialog 곡선 카드가 채움; LoadModelFields는 아무것도 안 그림). 구현: closed arm `rateMode==="curve" ? (simpleMode ? null : <>{curveEditor}{rampDown}</>) : <fixedGrid>`; open arm 동형.
  - 주 수치 Input들(vus/duration/rampUp/targetRps/maxInFlight)에 `numeric={numeric}` 전달. raw curve stage·worker `<input className={INPUT}>`(188·204·540)는 `className={numeric ? \`${INPUT} tabular-nums\` : INPUT}`(공유 상수 0-diff·trailing space 없음).
  - open 구조 경고(idle/inert) 렌더는 `{!simpleMode && ...}`.

- [ ] **Step 5: Run** — `pnpm test LoadModelFields` → PASS(신규 + 기존 전부). 기존 `it.each` 미렌더 매트릭스(186/234/288/341) green 유지 — 신규 prop 미전달이라.
- [ ] **Step 6: Commit** — `git add ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/i18n/ko.ts && git commit -m "feat(rundialog): LoadModelFields simpleMode/타일/numeric 게이트 (R3·R4·R10·R12)"`.

---

### Task 6: RunDialog — 모드 토글·섹션 게이트·프리셋 동선·측정 노출·진단(R1-R7·R9·R5·R6·R17·R18)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (모드/측정/적용/곡선카드 라벨·추가-only)

**Interfaces:**
- Consumes: `Segmented`(T1), `EnvironmentPicker showOverrides`(T4), `LoadModelFields simpleMode/loadModelTiles`(T5), `deriveLoadMode`(`loadModel.ts`), `StageCurvePreview`.
- Produces: 없음(최상위 컴포넌트). `buildProfile`/`env`/`canSubmit` 검증식 **0-diff**.

- [ ] **Step 1: byte-identical 골든 + 모드 RTL 테스트 먼저** — `RunDialog.test.tsx`에 추가(기존 mutate-payload 단언 패턴 재사용):

```tsx
// (a) byte-identical: 간단-기본 closed → 기존과 동일 profile/env 페이로드
it("simple-mode default closed run posts byte-identical profile+env", async () => {
  // 기존 RunDialog 테스트의 createRun mock 패턴 재사용
  // Run 클릭 → mutate 인자 {scenarioId, profile, env} 캡처
  // profile === {loop_breakdown_cap:0, http_timeout_seconds:30, measure_phases:false,
  //   vus:2, duration_seconds:5, ramp_up_seconds:0}  (기존 기본값과 동일), env === {}
});
// (b) 모드 토글: 기본 간단 → 상세 섹션 부재
it("defaults to 간단; detailed-only sections absent", () => {
  // render RunDialog (no prefill)
  expect(screen.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByText(/측정/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /프리셋으로 저장/ })).not.toBeInTheDocument();
});
// (c) 상세 전환 → 측정/저장/바인딩/오버라이드 렌더
it("상세 reveals measure, save, binding, overrides", async () => {
  const user = userEvent.setup();
  // render → click 상세
  await user.click(screen.getByRole("radio", { name: "상세" }));
  expect(screen.getByText(/단계 분해/)).toBeInTheDocument(); // 측정
  expect(screen.getByRole("button", { name: /프리셋으로 저장/ })).toBeInTheDocument();
});
// (d) R2: SLO prefill → 상세로 열림
it("detailed-value prefill opens 상세", () => {
  // initial.profile.criteria = {max_p95_ms:500}
  expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
});
// (e) R2 env: env 오버라이드 prefill → 상세
it("env-override prefill opens 상세", () => {
  // initial.env = { BASE_URL: "x" }
  expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
});
// (f) R5: 상세서 invalid http_timeout 후 간단 전환 → Run disabled + blockedReasons 사유
it("hidden invalid surfaces via blockedReasons in 간단", async () => {
  // 상세 → http_timeout=0 입력 → 간단 전환
  // expect Run disabled + getByText(ko.validation.httpTimeout) within blockedReasons callout
});
// (g) R6: 상세값 set 후 간단 → "상세 설정 N개 적용됨"
// (h) R17: 곡선 prefill + 수동 간단 → 읽기전용 곡선 카드 + Run 가능 + payload vu_stages 유지
// (i) R18: env 오버라이드 prefill + 간단 → "변수 N개 적용됨" 힌트
// (j) R7: 프리셋 불러오기 strip이 부하모델 위, 저장은 아래(상세)
```
> 각 케이스는 기존 `RunDialog.test.tsx`의 render 헬퍼/`createRun` mock(URL-필터 call-count)을 재사용. (a) 골든은 현재 기본 payload를 먼저 캡처해 상수화 → 리팩터 후 동일 단언.

- [ ] **Step 2: Run to verify fail** — `pnpm test RunDialog` → 신규 케이스 FAIL.

- [ ] **Step 3: ko 키 추가** — `ko.runDialog`: `modeSimple: "간단"`, `modeDetail: "상세"`, `modeAria: "설정 모드"`, `measureTitle: "응답 시간 단계 분해"`, `measureDesc: "응답 시간을 DNS·연결·대기·다운로드로 나눠 측정 — 리포트에서 어디서 느린지 진단"`, `appliedDetail: (n: number) => \`상세 설정 ${n}개 적용됨\``, `curveCardTitle: "곡선 부하 설정됨"`, `curveCardHint: "상세 모드에서 편집"`.

- [ ] **Step 4: Implement (spec §4.1 충실)** — `RunDialog.tsx`:
  1. **advancedPrefill 헬퍼 추출**: 현 `advancedOpen` 초기화 술어(134-145)를 `function advancedPrefill(initial?: RunPrefill): boolean { ... }`(기존 6항 그대로)로 추출, `advancedOpen` init이 **그대로** 호출(unchanged). 단 collapse-hint 카운트는 measure 제외 — `advancedActiveCount`(319-320)를 그대로 두되 **고급 collapse hint(`advancedSetHint`, 631-633)는 measure를 뺀 `sloActiveCount + (loadModel==="closed"?pacingActiveCount:0)`**만 쓰게 인라인 수정(리뷰 A). (measure는 이제 collapse 밖이라.)
  2. **mode state**: `const [mode, setMode] = useState<"simple"|"detailed">(() => (advancedPrefill(initial) || deriveLoadMode(initial?.profile ?? {}).rateMode === "curve" || Number(initial?.profile.worker_count ?? 1) > 1 || (initial != null && Object.keys(initial.env).length > 0)) ? "detailed" : "simple")`.
  3. **헤더**: `<h3>` 행에 `<Segmented value={mode} onChange={setMode} options={[{value:"simple",label:ko.runDialog.modeSimple},{value:"detailed",label:ko.runDialog.modeDetail}]} ariaLabel={ko.runDialog.modeAria} />`(title 형제).
  4. **프리셋 불러오기 strip**(492-513)을 본문 *최상단*으로(두 모드, `presets.data?.length>0`). **저장/이름변경/삭제 블록**(755-791)을 본문 *최하단·`{mode==="detailed" && ...}`*로.
  5. **LoadModelFields 호출**(526-557)에 `simpleMode={mode==="simple"} loadModelTiles`(타일 항상) 추가.
  6. **R17 곡선 카드**: LoadModelFields 아래, `mode==="simple" && rateMode==="curve"`이면 읽기전용 카드(`ko.runDialog.curveCardTitle`/`curveCardHint` + `<StageCurvePreview>` 소형). 토글 스냅 없음(setMode는 rateMode 안 건드림).
  7. **그룹 2(대상)**: `EnvironmentPicker`에 `showOverrides={mode==="detailed"}`. DataBindingPanel은 `{mode==="detailed" && ...}`.
  8. **그룹 3(판정·고급)**: `{mode==="detailed" && <Section ...>}`. 측정 토글(744-751)을 이 Section *밖*, 별도 `{mode==="detailed" && <측정 섹션>}`으로 이동(R9·가치 라벨 `measureTitle`/`measureDesc` + HelpTip).
  9. **applied indicator(R6)**: `mode==="simple" && detailedAppliedCount>0`이면 `ko.runDialog.appliedDetail(detailedAppliedCount)`. `detailedAppliedCount = advancedActiveCount + (rateMode==="curve"?1:0) + (Number(workerCount)>1?1:0) + (httpTimeout!==30?1:0) + (hasLoop && loopCap!==256?1:0) + (loadModel==="closed" && rateMode==="curve" && rampDown!=="graceful"?1:0)`.
  10. **blockedReasons 일반화(R5)**: 조건 `!advancedOpen`→`(mode==="simple" || !advancedOpen)` + `...(mode==="simple" && loadModel==="open" && loadErrs.workerCountInvalid ? [ko.validation.workerCount] : [])` 추가. `bindingBlock`은 모드 무관 유지.
  11. `buildProfile`/`canSubmit`/풀가드/프리셋 로직 **불변**.

- [ ] **Step 5: Run** — `pnpm test RunDialog` → PASS(신규 + 기존). 골든 (a) green = byte-identical.
- [ ] **Step 6: Commit** — `git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx ui/src/i18n/ko.ts && git commit -m "feat(rundialog): 간단/상세 모드·프리셋 동선·측정 노출·진단 (R1-R7·R9·R5·R6·R17·R18)"`.

---

### Task 7: RunDialog — 실시간 요약 footer (시그니처, R8)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

**Interfaces:**
- Consumes: `runSummary`(T3), `StageCurvePreview`.

- [ ] **Step 1: 테스트 먼저** — `RunDialog.test.tsx`:
```tsx
it("renders live summary footer reflecting inputs (both modes)", async () => {
  // closed 100/300 → getByText(/동시 사용자 100명/), /5분/
  // open 전환(상세) → /약 30,000건/ (rps 100 * 300)
  // 곡선 → curve sparkline (role=img) 존재
});
it("invalid input → 설정을 확인하세요 in footer", () => {
  // vus 0 → getByText("설정을 확인하세요")
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm test RunDialog` → FAIL(footer 없음).
- [ ] **Step 3: Implement** — Run/취소 버튼 행(926-941)을 sticky footer로 감싸고 좌측에 요약 strip: `const sum = runSummary(loadState);` → `<div className="flex items-center gap-3 ..."><span className="w-0.5 self-stretch rounded bg-accent-600" />{sum.curve && <StageCurvePreview .../* 소형 */}/>}<span className={sum.tone==="warn"?"text-amber-700":"text-slate-900"}>{sum.text}</span></div>` + 기존 Run/취소 버튼. 곡선 스파크라인은 `role="img"` aria-label.
- [ ] **Step 4: Run** — `pnpm test RunDialog` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(rundialog): 실시간 요약 footer 시그니처 (R8)"`.

---

### Task 8: 정밀계기(라이트) 룩 + 전체 검증 (R14·R11·R13·R16)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` (eyebrow 라벨·헤어라인 섹션·numeric 전달·간격)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx` (스냅샷 아님 — 구조 단언)

**Interfaces:** (룩 적용 — 동작 무변경)

- [ ] **Step 1: 테스트 먼저(가벼운 구조 단언)** — eyebrow 섹션 라벨 존재·`numeric` 입력 클래스 등 최소 단언(시각은 라이브 검증). 기존 RTL이 라벨 텍스트로 셀렉트하므로 eyebrow 전환이 깨지 않는지 확인용.
- [ ] **Step 2: Implement 룩** — RunDialog 섹션을 헤어라인 구분선(`border-t border-slate-100`)·ALL-CAPS tracked eyebrow 라벨(`text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500`)·8px 리듬으로. 주 수치는 `numeric`(T5 prop) 전달. dialog 컨테이너는 단일 elevation(border + 약한 shadow). **accent 토큰만**, 그라데이션/글래스/고스트 카드 금지.
- [ ] **Step 3: Run targeted** — `pnpm test RunDialog` → PASS.
- [ ] **Step 4: 전체 게이트** — `pnpm lint && pnpm test && pnpm build` → 0 warn / all green / build OK.
- [ ] **Step 5: grep 불변식(R13·R16)** — repo 루트에서:
  - `git diff --stat master -- ui/src/api/schemas.ts crates proto migrations` → **빈 출력**(0-diff).
  - `git diff master -- ui/src/i18n/ko.ts` → 추가만(기존 키 변경 0).
  - 신규 인라인 영어 grep(`grep -nE '"[A-Za-z][A-Za-z ]{2,}"' ui/src/components/RunDialog.tsx ui/src/components/runSummary.ts` 등에서 사용자-노출 영어 0; ko 경유 확인).
- [ ] **Step 6: Commit** — `git commit -m "feat(rundialog): 정밀계기 룩 + 전체 검증 게이트 (R14·R13·R16)"`.

---

## 최종 검증 (머지 전 — finish-slice가 수행)

- **handicap-reviewer**(Opus) 전체 diff 리뷰 — R11 byte-identical·R12 ScheduleForm·R13 0-diff·wire 1:1.
- **security-reviewer**: path-gate(요청실행/템플릿/env 바인딩/업로드/trace) — RunDialog는 env 바인딩 표면을 *재배치*만 하므로 매치 시 게이트(`showOverrides` 게이트가 env payload를 안 바꾸는지 확인).
- **`/live-verify`(필수·R11·S-D 갭)**: 워크트리 자체 바이너리 + responder + 격리 DB로 ① 간단 모드 closed run 1회 생성→리포트 도달, ② 상세 모드 open run 1회, console Zod 0. RTL fixture는 absent-not-null이라 서버 응답경로를 못 잡음.

## Self-review 메모(작성자)

- **Spec coverage**: R1(T6 Segmented)·R2(T6 mode-init)·R3/R4(T5+T6 게이트)·R5(T6 blockedReasons+workerCount)·R6(T6 detailedAppliedCount)·R7(T6 bookend)·R8(T3+T7)·R9(T6 측정)·R10(T5 도우미)·R11(T6 골든+live)·R12(T4/T5 미전달 락인)·R13/R16(T8 grep)·R14(T1/T2/T8)·R15(T1 a11y)·R17(T5 미렌더+T6 카드)·R18(T4 힌트+T6 mode-init). 전 R에 task 대응.
- **타입 일관성**: `runSummary` 시그니처(T3)·`Segmented` props(T1)·`showOverrides`(T4)·`simpleMode/loadModelTiles/numeric`(T5)가 T6/T7 소비처와 일치.
- **byte-identical 가드**: T6 골든(a)이 첫 RunDialog 변경부터 페이로드 불변을 잠그고 T8 전체 게이트로 재확인.
