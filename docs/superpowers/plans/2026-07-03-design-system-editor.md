# 디자인 시스템 확산 3차 — 에디터/Inspector 토큰 이주 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 에디터(`ui/src/components/scenario/` + 에디터 페이지)의 raw Tailwind `<input>`/`<select>`/경고 박스를 기존 프리미티브 `Input`/`Select`/`Callout`로 이주하되, 에디터 조밀 밀도를 지키기 위해 `Input`/`Select`에 additive `size?: 'sm'` 변형을 추가한다.

**Architecture:** C-2(프리미티브)→spread(폼)→results-screens(결과)의 세 번째 확산. 유일한 토대 변경 = `Input`/`Select`에 `size?: 'sm'`(additive, 기본 무변경). 나머지는 JSX className 교체만 — 핸들러·onBlur-commit draft·combobox role·ref·전송 payload byte-identical. 데이터-식별 색·카드 구조·Button-accent 드리프트는 동결.

**Tech Stack:** TypeScript + React + Tailwind 3.4 + Vitest/RTL. 게이트 = `pnpm lint && pnpm test && pnpm build`(cargo 비대상 — UI-only).

**설계 출처:** `docs/superpowers/specs/2026-07-03-design-system-editor-design.md` (spec-plan-reviewer clean APPROVE). 각 task의 exhaustive 입력/셀렉트/Callout 매핑은 spec §4.N을 권위로 참조(아래는 그 요지 + TDD 절차). **file:line은 탐색 시점 기준 — 구현 시 실제 파일에서 재확인**(규칙[R4/R6/R7]이 라인보다 권위).

## Global Constraints

- **UI-only 0-diff 경계(R11)**: 백엔드·proto·migration·`ui/src/api/*`·`schemas.ts`·`ui/src/scenario/model.ts`·`yamlDoc.ts`·`store.ts`·`reorder.ts`·`dropRules`·`tailwind.config.ts`·`Button.tsx`·`Callout/Field/Badge/Section/Segmented.tsx` = **절대 편집 금지**. diff는 `ui/src/components/ui/{Input,Select}.tsx`·`ui/src/components/scenario/*`·`ui/src/pages/Scenario{Edit,New}Page.tsx`·`ui/src/i18n/ko.ts`(필요 시)·`docs/`·`__tests__/`만.
- **size prop 타입(R1)**: `Input`/`Select` Props는 반드시 `Omit<…HTMLAttributes, "size">` — native `size?: number`와 교집합하면 `never`로 collapse돼 `tsc -b` 실패.
- **기본 size 렌더 클래스 집합 동등(R2)**: `size` 미전달 소비처(RunDialog·폼·결과·ScheduleForm)는 `text-sm` 유지·`text-xs` 없음.
- **동작 byte-identical(R5)**: 핸들러·onBlur-commit draft(`commitTimeout`/`commitThinkTime` 짝-가드·`commitRepeat`·`commitFromBlur`·branch `commitName`·`StepNameField` 하이브리드·KeyValueGrid `commitRows`·ScenarioEditPage `commitName`+`nameEscapedRef` Escape 트랩)·react-query·도출·combobox role·ref·전송 payload 0-diff. JSX 마크업만.
- **이주 기계 규칙(R4)**: ① `text-xs`→`size="sm"`; canon→기본 ② `font-mono`→`className` append ③ 고정폭(`w-24`/`w-28`/`w-32`/`w-56`)→래퍼 `<div className="w-NN">` ④ `flex-1 min-w-0`→래퍼 `<div className="flex-1 min-w-0">` ⑤ `min-w-0`은 입력 `className`에도 유지(래퍼 *와* 입력, 무해) ⑥ auto-width `<select>`→`w-fit` 래퍼(`w-auto` 금지).
- **동결(R7/R8/R9/R10)**: 입력-옆 인라인 경고·데이터-식별 색(`methodBadge.ts`·FlowOutline accent-500·TestFlowChips/TestRunPanel 칩 색)·로컬 `Field`·`InspectorSection`·카드 fieldset·checkbox/radio/textarea/Monaco/dnd-kit/file·Button-accent 드리프트(indigo/blue) = 손대지 않음. 신규 blue/indigo 0.
- **URL 입력 빈 값 허용(R12)**: Inspector URL 입력에 `aria-invalid`/`.min(1)` 신규 추가 금지.
- **문구(R14)**: 사용자-노출 문구는 `ko.ts` 경유(ADR-0035), 신규 인라인 영어 0. 이번 슬라이스는 신규 문구 불필요 예상(기존 ko 키·문구 유지).
- **tdd-guard 순서**: 각 task는 그 파일의 `__tests__/*.test.tsx`를 **먼저** 편집(pending RED/lockstep diff)한 뒤 src 편집. test-path 편집은 항상 허용. 단언 불요 파일엔 keepalive `it.todo` 선-배치 후 task 끝 `rm`(커밋 금지).
- **⚠ Callout 변환 lockstep은 조건부 금지 — 항상 *구체적 구별 단언*을 추가**(plan-reviewer must-fix): 기존 `getByRole("alert")`/`getByText`가 이미 있으면 role/text 보존이라 그대로 green → **테스트 diff 0 → tdd-guard가 src 편집을 막고, 변환이 무가드**가 된다. 그러므로 "없으면 추가"류 조건부 대신, 변환 대상 박스에 **RED-before/GREEN-after로 갈리는 구체 클래스 단언**을 항상 추가한다: 호박 박스→`toHaveClass("rounded-md")`+`toHaveClass("bg-amber-50")`(raw는 `rounded`/`bg-amber-100` 또는 `p-3`), 빨강 박스→`toHaveClass("rounded-md")`+`toHaveClass("bg-red-50")`(roleless 문단은 raw가 박스조차 아님 → 변환 후 이 클래스가 새로 생김). 이 단언이 pending diff(tdd-guard) *와* 변환 회귀 가드를 겸한다. role 보존 단언(`getByRole`)은 유지하되 그것만으론 부족.
- **커밋**: 각 task 독립 green 커밋. commit은 `run_in_background:false` + timeout 600000ms 단일 호출(폴링 금지). `git add`는 명시 경로만(`-A` 금지). 커밋 메시지 끝에 Co-Authored-By/Claude-Session 트레일러(루트 CLAUDE.md).
- **파일별 게이트**: 각 task 끝 `cd ui && pnpm test <파일명>`(단일 파일; `--` 안 붙임) green. 슬라이스 종료 시 전체 `pnpm lint && pnpm test && pnpm build`.

---

## Task 1: 토대 — Input/Select `size?: 'sm'` 변형

**Files:**
- Modify: `ui/src/components/ui/Input.tsx`
- Modify: `ui/src/components/ui/Select.tsx`
- Test: `ui/src/components/ui/__tests__/Input.test.tsx` (Select도 커버 — 기존 파일 구조 확인 후 append)

**Interfaces:**
- Produces: `<Input size?: "sm">`·`<Select size?: "sm">` (기본 미전달=`text-sm`, `"sm"`=`text-xs`). Task 2~9가 조밀 입력에 `size="sm"`을 소비.

- [ ] **Step 1: 락인 테스트 먼저 추가 (tdd-guard pending)**

`ui/src/components/ui/__tests__/Input.test.tsx`에 append(기존 import/`render`/`screen` 재사용; 없으면 `import { render, screen } from "@testing-library/react"` + `import { Input } from "../Input"` + `import { Select } from "../Select"`):

```tsx
describe("size variant", () => {
  it("Input default size renders text-sm, not text-xs", () => {
    render(<Input aria-label="i" />);
    const el = screen.getByLabelText("i");
    expect(el).toHaveClass("text-sm");
    expect(el).not.toHaveClass("text-xs");
  });
  it("Input size='sm' renders text-xs, not text-sm", () => {
    render(<Input aria-label="i" size="sm" />);
    const el = screen.getByLabelText("i");
    expect(el).toHaveClass("text-xs");
    expect(el).not.toHaveClass("text-sm");
  });
  it("Select default size renders text-sm, not text-xs", () => {
    render(<Select aria-label="s"><option>a</option></Select>);
    const el = screen.getByLabelText("s");
    expect(el).toHaveClass("text-sm");
    expect(el).not.toHaveClass("text-xs");
  });
  it("Select size='sm' renders text-xs, not text-sm", () => {
    render(<Select aria-label="s" size="sm"><option>a</option></Select>);
    const el = screen.getByLabelText("s");
    expect(el).toHaveClass("text-xs");
    expect(el).not.toHaveClass("text-sm");
  });
});
```

- [ ] **Step 2: 테스트 실행 → size='sm' 케이스 FAIL 확인**

Run: `cd ui && pnpm test Input`
Expected: 새 size='sm' 케이스 FAIL(아직 `size` prop 없음 → `text-xs` 미적용). default 케이스는 PASS.

- [ ] **Step 3: `Input.tsx` 구현**

`ui/src/components/ui/Input.tsx` 전체를:

```tsx
import { forwardRef, type InputHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

const SIZE = { md: "text-sm", sm: "text-xs" } as const;

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  numeric?: boolean;
  size?: "sm";
};

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, numeric, size, ...rest },
  ref,
) {
  const base = `${BASE} ${SIZE[size ?? "md"]}${numeric ? " tabular-nums" : ""}`;
  return <input ref={ref} className={`${base} ${className ?? ""}`} {...rest} />;
});
```

(`text-sm`을 BASE에서 빼고 `SIZE[size ?? "md"]`로 append — 기본은 여전히 `text-sm` 포함=클래스 집합 동등. `numeric`·forwardRef·`{...rest}` 무변경.)

- [ ] **Step 4: `Select.tsx` 구현**

`ui/src/components/ui/Select.tsx` 전체를:

```tsx
import { forwardRef, type SelectHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

const SIZE = { md: "text-sm", sm: "text-xs" } as const;

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: "sm" };

export const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { className, children, size, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={`${BASE} ${SIZE[size ?? "md"]} ${className ?? ""}`} {...rest}>
      {children}
    </select>
  );
});
```

- [ ] **Step 5: 테스트 실행 → 전부 PASS**

Run: `cd ui && pnpm test Input`
Expected: 4개 size 케이스 전부 PASS.

- [ ] **Step 6: 소비처 회귀 확인 (R2 byte-identical)**

Run: `cd ui && pnpm test RunDialog ScheduleForm`
Expected: 기존 소비처 테스트 PASS(기본 size 클래스 집합 동등). 이어 `cd ui && pnpm build`로 `tsc -b` green 확인(Omit 타입 정합·`size="sm"` 유효).
Expected: build 성공(TS 에러 0).

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/ui/Input.tsx ui/src/components/ui/Select.tsx ui/src/components/ui/__tests__/Input.test.tsx
git commit -m "feat(ui): Input/Select size='sm' 변형 — 에디터 조밀 밀도 보존 (additive·기본 byte-identical)"
```

---

## Task 2: Inspector.tsx — 입력/셀렉트 이주 (HEAVY)

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx`
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx`, `.../Inspector.sections.test.tsx`

**Interfaces:**
- Consumes: `Input`/`Select` from `../ui/Input`·`../ui/Select` (Task 1). Import 추가.

**이주 목록(spec §4.1 권위 — 실제 파일에서 재확인):**
- **입력→Input**: URL(`font-mono text-xs w-full` → `Input size="sm" className="font-mono"`, **R12 검증 무추가**)·timeout(number w-full → `Input numeric`, `commitTimeout` onBlur 보존)·thinkMin/Max(number w-full → `Input numeric`, `commitThinkTime` 짝-가드 보존)·assert code 기존행(`w-24` → 래퍼 `w-24`+`Input numeric`)·assert 신규(`w-24 text-xs` → 래퍼+`Input numeric size="sm"`)·extract var(`font-mono w-24` → 래퍼 `w-24`+`Input className="font-mono"`, `commitFromBlur` 보존)·extract body path(`font-mono flex-1 min-w-[120px]` → 래퍼 `flex-1 min-w-[120px]`+`Input className="font-mono"`)·extract header/cookie name(동형)·parallel branch name(`w-full text-xs` in `flex-1 min-w-0` → `Input size="sm"`, `commitName` 보존)·loop repeat(`w-24` number → 래퍼+`Input numeric`, `commitRepeat` 보존)·cond left/right(`font-mono text-xs w-28 min-w-0` → 래퍼 `w-28 min-w-0`+`Input size="sm" className="min-w-0 font-mono"`, `commitText` 보존)·StepNameField(`w-full` → `Input` 기본, 하이브리드 커밋 verbatim).
- **셀렉트→Select**: method(auto-width → `<div className="w-fit"><Select></div>`)·body kind(`text-sm mb-2` auto → `<div className="w-fit"><Select className="mb-2"></div>`)·extract from(auto → `w-fit` 래퍼+`Select`)·cond group all/any(`text-xs w-32` → `w-32` 래퍼+`Select size="sm"`)·cond op(`text-xs` auto → `w-fit` 래퍼+`Select size="sm"`).
- **동결(만지지 말 것)**: 인라인 경고(URL-empty `<p role="alert" text-amber-600>`·dup-branch `<span role="alert">`·invalid-regex `<span>`·JSON `<p text-red-600>`)·로컬 `function Field`·카드 fieldset(`border … rounded p-3 min-w-0`)·`InspectorSection`·`<textarea>`·`SmallButton`·ConditionNode `border-indigo-200`(R10).

**⚠ 라벨 연결 주의:** URL·method 등 일부 입력은 **aria-label이 없고** 로컬 `function Field`의 암시적 `<label>` 래퍼로 라벨링된다(`getByLabelText(라벨텍스트)`로 찾음). 폭 래퍼 `<div>`를 씌울 땐 그 div를 **`<label>` *안***에 둬 마이그레이션된 `<Input>`이 여전히 그 label의 유일 labelable 자손이 되게 할 것(밖에 두면 라벨 연결이 끊겨 `getByLabelText`가 깨진다). URL은 w-full이라 래퍼 자체가 없어 무관하지만, method(auto-width `w-fit` 래퍼)는 로컬 `Field` label 안에 래퍼를 둔다.

**변환 패턴(대표 예):**

```tsx
// 조밀 mono 입력 (URL 예 — aria-label 없이 로컬 Field <label>로 라벨링, 있던 prop만 그대로 옮김):
// before:
<input className="w-full border border-slate-300 rounded px-2 py-1 font-mono text-xs"
       value={url} onChange={(e) => setStepField(["request","url"], e.target.value)} />
// after:
<Input size="sm" className="font-mono"
       value={url} onChange={(e) => setStepField(["request","url"], e.target.value)} />

// 고정폭 숫자 입력 (loop repeat 예 — 핸들러 verbatim):
// before: <input type="number" className="w-24 border … px-2 py-1" value={repeatDraft} onChange={…} onBlur={commitRepeat} aria-label={...} />
// after:  <div className="w-24"><Input numeric type="number" value={repeatDraft} onChange={…} onBlur={commitRepeat} aria-label={...} /></div>

// auto-width select (method 예):
// before: <select className="border … px-2 py-1" value={method} onChange={…}>{…}</select>
// after:  <div className="w-fit"><Select value={method} onChange={…}>{…}</Select></div>
```

- [ ] **Step 1: 테스트 lockstep 먼저 (tdd-guard pending)**

`Inspector.test.tsx`에 URL 입력이 마이그레이션 후에도 정상임을 고정하는 단언 1개 추가(기존 URL 입력을 집는 테스트가 있으면 그 자리에 focus-ring 클래스 단언 추가, 없으면 신규):

```tsx
it("URL input uses primitive Input with accent focus-ring class", () => {
  // ...render Inspector with an http step selected (기존 테스트의 렌더 헬퍼 재사용)...
  const url = screen.getByLabelText(/* 로컬 Field label 텍스트 — 예: "URL" */);
  expect(url).toHaveClass("focus:ring-accent-500/30"); // Input BASE 획득 증거
  expect(url).toHaveClass("font-mono");                 // mono 보존
  expect(url).toHaveClass("text-xs");                   // size="sm" 밀도 보존
});
```

(기존 `Inspector.test.tsx`·`Inspector.sections.test.tsx`의 min-w-0 단언[header/row 입력]·섹션 토글·localStorage clear 패턴은 **수정 없이** green 유지 — R4⑤로 입력에 min-w-0 유지.)

- [ ] **Step 2: 테스트 실행 → 새 단언 FAIL 확인**

Run: `cd ui && pnpm test Inspector`
Expected: 새 focus-ring 단언 FAIL(아직 raw input), 기존 단언은 PASS.

- [ ] **Step 3: `Inspector.tsx` 이주 구현**

`import { Input } from "../ui/Input";`·`import { Select } from "../ui/Select";` 추가. 위 이주 목록의 각 입력/셀렉트를 변환 패턴대로 교체 — **핸들러·value·onChange/onBlur·aria-label·type·list·ref·min/max prop은 그대로 옮기고**, className만 규칙대로(조밀→`size="sm"`·mono→className·폭→래퍼·min-w-0 유지·auto-select→`w-fit`). 동결 목록은 손대지 않음.

- [ ] **Step 4: 테스트 실행 → 전부 PASS**

Run: `cd ui && pnpm test Inspector`
Expected: 새 단언 + 기존 `Inspector.test`·`Inspector.sections.test`(min-w-0·combobox `Inspector.test:530`·섹션 토글) 전부 PASS.

- [ ] **Step 5: 타입·빌드 확인**

Run: `cd ui && pnpm build`
Expected: `tsc -b` green(size='sm'·numeric·Omit 정합).

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): Inspector 입력/셀렉트 프리미티브 이주 — size='sm' 밀도 보존·핸들러 verbatim"
```

---

## Task 3: KeyValueGrid.tsx — combobox·flex-1 이주 (RISKY)

**Files:**
- Modify: `ui/src/components/scenario/KeyValueGrid.tsx`
- Test: `ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx`

**이주 목록(spec §4.2):**
- row key(`w-32 min-w-0 text-xs font-mono` + **`list=` combobox**) → 래퍼 `w-32 min-w-0`+`Input size="sm" className="min-w-0 font-mono" list={…}`(combobox role 보존·`commitRows` onBlur 보존)·row value(`flex-1 min-w-0 text-xs` + `ref`) → 래퍼 `flex-1 min-w-0`+`Input size="sm" className="min-w-0"` ref 패스스루·newKey(combobox 동형)·newValue(동형).
- **동결**: enabled checkbox·CommonHeaderMenu listbox 팝오버·datalist.

**핵심 주의:** `list={datalistId}`를 `Input`에 그대로 넘겨야 combobox role 유지(`{...rest}` 패스스루). value 입력의 callback ref도 그대로.

- [ ] **Step 1: 테스트 lockstep 먼저**

`KeyValueGrid.test.tsx`의 기존 `toHaveClass("min-w-0")`(`:94` 부근)·`getAllByRole("textbox")`(`:92`) 단언이 **수정 없이 green 유지**됨을 확인(R4⑤·`list=` 패스스루). 마이그레이션 후 focus-ring 획득 단언 1개 추가:

```tsx
it("value input adopts primitive Input focus-ring", () => {
  // ...기존 render 헬퍼로 KeyValueGrid 마운트...
  const inputs = screen.getAllByRole("textbox");
  expect(inputs[0]).toHaveClass("focus:ring-accent-500/30");
});
```

- [ ] **Step 2: 실행 → 새 단언 FAIL**

Run: `cd ui && pnpm test KeyValueGrid`
Expected: 새 focus-ring 단언 FAIL, 기존 min-w-0·textbox 단언 PASS.

- [ ] **Step 3: 구현**

`import { Input } from "../ui/Input";` 추가. 4개 입력을 위 목록대로 교체(래퍼 폭 + 입력 `min-w-0` 유지 + `list=`/ref 패스스루). checkbox·팝오버 동결.

- [ ] **Step 4: 실행 → PASS**

Run: `cd ui && pnpm test KeyValueGrid`
Expected: 전부 PASS(min-w-0·textbox·focus-ring). **추가로** `cd ui && pnpm test Inspector` — combobox-union 가드(`Inspector.test:530`, HeadersEditor+commonKeys) PASS 확인(KeyValueGrid를 렌더하는 상위 테스트).

- [ ] **Step 5: 빌드**

Run: `cd ui && pnpm build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/scenario/KeyValueGrid.tsx ui/src/components/scenario/__tests__/KeyValueGrid.test.tsx
git commit -m "feat(ui): KeyValueGrid 입력 Input 이주 — combobox role·min-w-0·ref 보존"
```

---

## Task 4: InsertTemplateModal.tsx — 입력 + 독립 오류 Callout

**Files:**
- Modify: `ui/src/components/scenario/InsertTemplateModal.tsx`
- Test: `ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx`

**이주 목록(spec §4.3):**
- **입력**: rename(`w-56 text-sm font-mono` + **`list=` combobox**) → 래퍼 `w-56`+`Input className="font-mono" list={…}`(canon size·combobox·`aria-label` 보존)·literal(`w-56 text-sm`) → 래퍼 `w-56`+`Input`.
- **Callout(독립 오류만)**: `<p role="alert" text-red-600>` **독립** 오류 3(top-level 모달 오류·del-mutation 오류·list-load 오류) → `Callout variant="error" role="alert"`. `import { Callout } from "../ui/Callout";`.
- **동결·인라인 유지(R7)**: rename 입력 **바로 아래 per-token** `<p role="alert" text-xs>{badRename}</p>`는 **인라인 유지**(Callout 아님 — compact 행 시프트 방지).
- **동결**: keep/rename/literal radios·datalists·`Button`/`Modal`·ParamForm plain fieldset.

- [ ] **Step 1: 테스트 lockstep 먼저 (구체 구별 단언 — 조건부 금지)**

기존 `InsertTemplateModal.test.tsx:109` `findByRole("alert")`는 Callout role 보존이라 그대로 green → 그것만으론 tdd-guard pending diff도 변환 가드도 안 됨. **독립 오류 하나를 유도해 변환 대상 박스에 구체 클래스 단언 추가**:

```tsx
it("independent error renders as an error Callout box", async () => {
  // ...top-level 모달 오류 상태 유도 (기존 오류 유도 fixture 재사용)...
  const box = await screen.findByRole("alert");
  expect(box).toHaveClass("rounded-md");  // Callout 캐넌 (raw <p>는 박스 아님)
  expect(box).toHaveClass("bg-red-50");    // error variant
});
```

- [ ] **Step 2: 실행 → 새 구체 단언 FAIL 확인**

Run: `cd ui && pnpm test InsertTemplateModal`
Expected: 새 `rounded-md`/`bg-red-50` 단언 FAIL(raw `<p>`는 박스 클래스 없음), 기존 alert 텍스트 단언 PASS.

- [ ] **Step 3: 구현**

`Input`·`Callout` import 추가. rename/literal 입력 래퍼+Input, 독립 오류 3 → Callout error(role=alert). per-token badRename `:325` 인라인 유지, radios/datalists 동결.

- [ ] **Step 4: 실행 → PASS**

Run: `cd ui && pnpm test InsertTemplateModal`
Expected: alert role 단언·combobox rename 입력 PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/scenario/InsertTemplateModal.tsx ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx
git commit -m "feat(ui): InsertTemplateModal 입력 Input·독립 오류 Callout 이주 (per-token 인라인 유지)"
```

---

## Task 5: SaveTemplateDialog.tsx — 입력 + warn/error Callout

**Files:**
- Modify: `ui/src/components/scenario/SaveTemplateDialog.tsx`
- Test: `ui/src/components/scenario/__tests__/SaveTemplateDialog.test.tsx`

**이주 목록(spec §4.4):**
- **입력**: name(`px-3 py-2 text-sm focus:ring-slate-400`) → `Input`(패딩 `px-3 py-2`→캐넌 `px-2 py-1`·포커스 slate→accent 정규화, `handleNameChange` 보존)·description(동형).
- **Callout**: overwrite 확인(roleless amber 박스 `rounded-md bg-amber-50 px-3 py-2`) → `Callout variant="warn"`(roleless)·error(`<p role="alert" text-red-600>` 독립) → `Callout variant="error" role="alert"`.
- **동결**: step checkboxes·plain fieldset·`Button`/`Modal`.

- [ ] **Step 1: 테스트 lockstep 먼저 (구체 구별 단언 — 조건부 금지)**

기존 `SaveTemplateDialog.test.tsx:197` `findByRole("alert")`는 보존이라 green → 변환 가드 부족. overwrite warn 박스(roleless)와 error 박스에 구체 클래스 단언 추가:

```tsx
it("overwrite confirm renders as warn Callout box", () => {
  // ...overwrite 상태 유도(이름 충돌)...
  const box = screen.getByText(/* overwrite 문구 */).closest("div");
  expect(box).toHaveClass("rounded-md");
  expect(box).toHaveClass("bg-amber-50");   // raw는 rounded-md bg-amber-50 px-3 py-2 → p-2 정규화 확인은 아래
  expect(box).toHaveClass("p-2");           // Callout 캐넌 (raw는 px-3 py-2)
});
```

(name 입력 focus-ring·error `findByRole("alert")`는 유지. overwrite raw 박스가 이미 `rounded-md bg-amber-50`라 **구별 단언은 `p-2`**가 RED-before[raw `px-3 py-2`]/GREEN-after 핵심.)

- [ ] **Step 2: 실행 → 새 `p-2` 단언 FAIL 확인**

Run: `cd ui && pnpm test SaveTemplateDialog`
Expected: `p-2` 단언 FAIL(raw는 `px-3 py-2`), 기존 name·error PASS.

- [ ] **Step 3: 구현**

`Input`·`Callout` import. name/description → Input, overwrite → warn Callout(roleless), error → error Callout(role=alert). checkbox 동결.

- [ ] **Step 4: 실행 → PASS**

Run: `cd ui && pnpm test SaveTemplateDialog`
Expected: name 입력·overwrite 텍스트·error alert 단언 PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/scenario/SaveTemplateDialog.tsx ui/src/components/scenario/__tests__/SaveTemplateDialog.test.tsx
git commit -m "feat(ui): SaveTemplateDialog 입력 Input·경고/오류 Callout 이주"
```

---

## Task 6: TestRunPanel.tsx — 호박 박스 → warn Callout

**Files:**
- Modify: `ui/src/components/scenario/TestRunPanel.tsx`
- Test: `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx`, `.../TestRunPanel.extract.test.tsx`

**이주 목록(spec §4.5):**
- **Callout(warn·roleless)**: BodyViewer truncated(`bg-amber-100 px-3 py-2`)·non-JSON/truncated extract 안내(`bg-amber-50 px-2 py-1`)·limit-reached(`bg-amber-100 px-3 py-2`) → `Callout variant="warn"`(roleless, `bg-amber-100`→`bg-amber-50` 정규화).
- **동결(R8)**: statusClass pill·verdict 칩·method/loop-index/extracted/unbound/if/branch 칩 색(데이터 식별). 인라인 red `{step.error}`·`{trace.error}` 유지(R7). 입력/셀렉트 0.

- [ ] **Step 1: 테스트 lockstep 먼저 (구체 구별 단언 — 조건부 금지)**

limit-reached 경고를 유도해 변환 대상 박스에 구체 클래스 단언 추가(roleless라 텍스트로 박스 찾기):

```tsx
it("limit-reached notice renders as warn Callout", () => {
  // ...limit 도달 상태 유도...
  const box = screen.getByText(/* 상한 도달 문구 */).closest("div");
  expect(box).toHaveClass("rounded-md");   // Callout (raw는 rounded)
  expect(box).toHaveClass("bg-amber-50");   // warn (raw는 bg-amber-100)
});
```

- [ ] **Step 2: 실행 → 새 단언 FAIL 확인**

Run: `cd ui && pnpm test TestRunPanel`
Expected: `rounded-md`/`bg-amber-50` 단언 FAIL(raw `rounded bg-amber-100`), 기존 칩·extract PASS.

- [ ] **Step 3: 구현**

`import { Callout } from "../ui/Callout";`. 3 호박 박스 → `Callout variant="warn"`(roleless, 문구 children). 칩 색·인라인 red 동결.

- [ ] **Step 4: 실행 → PASS**

Run: `cd ui && pnpm test TestRunPanel`
Expected: `.test`·`.extract.test` 경고 텍스트·칩·extract 단언 PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/scenario/TestRunPanel.tsx ui/src/components/scenario/__tests__/TestRunPanel.test.tsx
git commit -m "feat(ui): TestRunPanel 호박 경고 박스 → warn Callout (칩 색 동결)"
```

---

## Task 7: TestRunSection + ExtractConfirmRow + VariablesPanel — 소형 입력 + Callout

**Files:**
- Modify: `ui/src/components/scenario/TestRunSection.tsx`, `.../ExtractConfirmRow.tsx`, `.../VariablesPanel.tsx`
- Test: `.../__tests__/TestRunSection.test.tsx`, `.../VariablesPanel.test.tsx` (ExtractConfirmRow 전용 테스트 없음 → 신규 or 간접)

**이주 목록(spec §4.6/§4.7/§4.8):**
- **TestRunSection**: maxRequests(`w-28 text-sm` number in `<label>` row) → 래퍼 `w-28`+`Input numeric`. error(`<p text-sm text-red-700>` 독립) → `Callout variant="error"`(roleless). 성공 emerald `role="status"` 인라인 유지(R7). checkbox 동결.
- **ExtractConfirmRow**: varName(`w-32 px-1 py-0.5 font-mono` onChange 즉시) → 래퍼 `w-32`+`Input className="font-mono"`(패딩 정규화·`aria-label` 보존). 행 `bg-indigo-50`·confirm 버튼 `bg-indigo-600` 동결(R10).
- **VariablesPanel**: newKey(`flex-1 min-w-0 text-sm font-mono`) → 래퍼 `flex-1 min-w-0`+`Input className="min-w-0 font-mono"`. `AutoGrowTextarea` 동결.

**주의(VariablesPanel):** getSnapshot 핀 테스트가 **첫 마운트**에 민감(EMPTY_VARS 모듈 상수 함정) — 셀렉터·마운트 순서 건드리지 말 것.

- [ ] **Step 1: 테스트 lockstep 먼저**

- `VariablesPanel.test.tsx`: 기존 newKey 입력·getSnapshot 핀 단언 green 유지 확인. focus-ring 획득 단언 1개 추가.
- `TestRunSection.test.tsx`: maxRequests 입력 focus-ring 단언 + **error→Callout 구체 단언**(오류 상태 유도 → 박스 `toHaveClass("rounded-md")`+`toHaveClass("bg-red-50")`; raw `<p text-red-700>`는 박스 아님 → RED-before). 성공 emerald `role="status"` 인라인은 동결(단언 불변).
- **ExtractConfirmRow**: 전용 테스트가 없으므로 `ui/src/components/scenario/__tests__/ExtractConfirmRow.test.tsx` **신규 생성** — varName 입력 렌더 + `Input` focus-ring 클래스 단언(F1 tdd-guard pending + 회귀 가드):

```tsx
import { render, screen } from "@testing-library/react";
import { ExtractConfirmRow } from "../ExtractConfirmRow";
// (props는 실제 시그니처에 맞춰 최소 fixture 구성)
it("varName input uses primitive Input", () => {
  render(<ExtractConfirmRow /* ...최소 props... */ />);
  const el = screen.getByLabelText(/* varName aria-label */);
  expect(el).toHaveClass("focus:ring-accent-500/30");
  expect(el).toHaveClass("font-mono");
});
```

- [ ] **Step 2: 실행 → 새 focus-ring 단언 FAIL**

Run: `cd ui && pnpm test VariablesPanel TestRunSection ExtractConfirmRow`
Expected: 새 focus-ring 단언 FAIL, 기존 PASS.

- [ ] **Step 3: 구현 (3 파일)**

각 파일에 `Input`(TestRunSection은 `Callout`도) import. 위 목록대로 교체. 동결(checkbox·textarea·indigo affordance) 손대지 않음.

- [ ] **Step 4: 실행 → PASS**

Run: `cd ui && pnpm test VariablesPanel TestRunSection ExtractConfirmRow`
Expected: 전부 PASS(getSnapshot 핀 포함).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/scenario/TestRunSection.tsx ui/src/components/scenario/ExtractConfirmRow.tsx ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/__tests__/TestRunSection.test.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx ui/src/components/scenario/__tests__/ExtractConfirmRow.test.tsx
git commit -m "feat(ui): TestRunSection·ExtractConfirmRow·VariablesPanel 입력 Input·error Callout 이주"
```

---

## Task 8: ValidationBanner.tsx — 통째 warn Callout

**Files:**
- Modify: `ui/src/components/scenario/ValidationBanner.tsx`
- Test: `ui/src/components/scenario/__tests__/ValidationBanner.test.tsx`

**이주(spec §4.9):** 배너 전체(`role="status" aria-label rounded border-amber-300 bg-amber-50 p-3 text-amber-800`) → `<Callout variant="warn" role="status" aria-label={…}>`(warn 색이 정확 일치). title-row/클릭 행 리스트를 children으로 중첩(`p-3`→`p-2`·`rounded`→`rounded-md` 정규화). **aria-label·role="status"·클릭→스텝선택 동작 보존.**

- [ ] **Step 1: 테스트 lockstep 먼저 (positive-role 가드 신규 — must-fix)**

⚠ 기존 `ValidationBanner.test.tsx`엔 **negative role 단언만**(`queryByRole("status").not.toBeInTheDocument()` = 0-problem early-return 케이스) 있고 **positive `getByRole("status")`·aria-label 가드가 없다** → 변환이 role/aria를 떨궈도 기존 테스트가 못 잡는다. 그러므로 문제 ≥1개로 렌더하는 **positive 가드를 신규 추가**:

```tsx
it("renders problems banner as a warn Callout with role=status + aria-label", () => {
  // ...문제 ≥1개인 model/props로 ValidationBanner 렌더 (기존 테스트의 문제-유도 fixture 재사용)...
  const banner = screen.getByRole("status", { name: /* ko.editor.problemsBannerAria — 실제 aria-label */ });
  expect(banner).toHaveClass("rounded-md");   // Callout 캐넌 (raw는 rounded)
  expect(banner).toHaveClass("bg-amber-50");   // warn variant
});
```

(기존 negative role 케이스 + 클릭 행 `getByRole("button")` 단언은 수정 없이 green 유지 — Callout children 패스스루.)

- [ ] **Step 2: 실행**

Run: `cd ui && pnpm test ValidationBanner` — 기존 PASS.

- [ ] **Step 3: 구현**

`import { Callout } from "../ui/Callout";`. 외곽 `<div role="status" …>`을 `<Callout variant="warn" role="status" aria-label={…} className={레이아웃-잔여}>`로 교체, 내부 title/list children 유지. 핸들러(클릭→스텝선택) 그대로.

- [ ] **Step 4: 실행 → PASS**

Run: `cd ui && pnpm test ValidationBanner`
Expected: role=status·aria-label·클릭 행 단언 PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/scenario/ValidationBanner.tsx ui/src/components/scenario/__tests__/ValidationBanner.test.tsx
git commit -m "feat(ui): ValidationBanner 통째 warn Callout 이주 (role/aria/클릭 보존)"
```

---

## Task 9: ScenarioEditPage + ScenarioNewPage — 이름 입력 + 오류 Callout

**Files:**
- Modify: `ui/src/pages/ScenarioEditPage.tsx`, `ui/src/pages/ScenarioNewPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioEditPage.{clone,dirty,name,save}.test.tsx`, `.../ScenarioNewPage.*.test.tsx`

**이주 목록(spec §4.10/§4.11):**
- **ScenarioEditPage 이름 입력(R13 플래그)**: name-rename(`text-xl font-semibold px-2 py-1`, onBlur `commitName`+`nameEscapedRef` Escape 트랩) → `Input className="text-xl font-semibold"`(text-xl override 이김·**Escape-ref+commitName verbatim**). ⚠ full-width(`block w-full`)·rounded-md·accent 링이 얹힘 — 라이브검증에서 헤더 룩 어색하면 동결 후퇴(이 한 입력만, 근거 기록).
- **Callout**: ScenarioEditPage 로드 오류(roleless `<p text-red-600>`)·update 오류(roleless) → `Callout variant="error"`·복제 오류(`<p role="alert">`) → `Callout variant="error" role="alert"`. ScenarioNewPage 생성 오류(roleless) → `Callout variant="error"`.
- **동결**: 템플릿 갤러리 버튼(plain, 범위밖).

- [ ] **Step 1: 테스트 lockstep 먼저**

- `ScenarioEditPage.name.test.tsx`: 기존 이름 입력·Escape·commitName·blur 단언이 **수정 없이 green 유지**됨을 확인(핸들러 verbatim). **`Input` focus-ring 획득 단언 추가**(구체 pending diff). **StrictMode 래핑 유지**(scenario-delete-name-sync — 페이지 테스트는 `<React.StrictMode>` 래핑).
- `ScenarioEditPage.clone.test.tsx`: 복제 오류 `findByRole("alert")`는 green 유지 + **구체 구별 단언**(alert 박스 `toHaveClass("rounded-md")`+`toHaveClass("bg-red-50")` — raw `<p role=alert>`는 박스 아님, RED-before).
- 로드/업데이트 오류(roleless) 변환은 `ScenarioEditPage.{dirty,save}.test.tsx` 중 오류 유도 케이스에 roleless 박스 `toHaveClass("rounded-md")`+`bg-red-50` 단언(없으면 신규 유도).
- `ScenarioNewPage.*.test.tsx`: 생성 오류(roleless) → Callout 박스 `toHaveClass("rounded-md")`+`bg-red-50` 구체 단언(오류 유도).

- [ ] **Step 2: 실행**

Run: `cd ui && pnpm test ScenarioEditPage ScenarioNewPage` — 기존 PASS.

- [ ] **Step 3: 구현**

`Input`·`Callout` import. 이름 입력 → `<Input className="text-xl font-semibold">`(Escape-ref/commitName/onBlur/onChange verbatim). 오류 `<p>` → Callout(role 1:1). 갤러리 버튼 동결.

- [ ] **Step 4: 실행 → PASS**

Run: `cd ui && pnpm test ScenarioEditPage ScenarioNewPage`
Expected: name(Escape/blur/commit)·clone alert·생성 오류 단언 PASS.

- [ ] **Step 5: 빌드**

Run: `cd ui && pnpm build`
Expected: green(text-xl override·Input 타입 정합).

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/ScenarioEditPage.tsx ui/src/pages/ScenarioNewPage.tsx ui/src/pages/__tests__/ScenarioEditPage.name.test.tsx ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx ui/src/pages/__tests__/ScenarioNewPage.gallery.test.tsx
git commit -m "feat(ui): 에디터 페이지 이름 입력 Input·로드/복제/생성 오류 Callout 이주 (Escape-ref 보존)"
```

(실제 편집한 test 파일만 add — 파일명은 구현 시 확인.)

---

## Task 10: 전체 게이트 + grep 불변식 + 최종 리뷰 준비

**Files:** 없음(검증·grep only — 코드 편집 시 해당 task로 되돌아감).

- [ ] **Step 1: 전체 UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warning(`--max-warnings=0`)·전체 test green·`tsc -b`+vite build green.

- [ ] **Step 2: grep 불변식 확인 (직접 실행 — self-report 불신)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/design-system-editor
# R11: diff 경로가 허용 범위만인지
git diff --name-only master.. | grep -vE '^(ui/src/components/ui/(Input|Select)\.tsx|ui/src/components/scenario/|ui/src/pages/Scenario(Edit|New)Page\.tsx|ui/src/i18n/ko\.ts|docs/)' || echo "R11 OK: 범위 밖 파일 없음"
# R10: 만진 파일에 신규 blue/indigo 컨트롤 색 (기존 드리프트는 §5 목록 — 신규만 금지)
git diff master.. -- ui/src/components/scenario ui/src/pages | grep -E '^\+.*(bg-blue-|text-blue-|bg-indigo-|text-indigo-|border-indigo-)' || echo "R10 OK: 신규 blue/indigo 0"
# R14: diff에 *추가된* 줄에 신규 인라인 하드코딩 문자열(한글/영어 리터럴 JSX 텍스트·aria-label/placeholder/title)이 없는지 — 이주는 기존 children/문구 verbatim이라 신규 0이어야
git diff master.. -- ui/src/components/scenario ui/src/pages | grep -E '^\+' | grep -E '(aria-label|placeholder|title)=["'"'"'][A-Za-z가-힣]' && echo "!!! R14: 신규 하드코딩 라벨 의심 — ko.ts 경유인지 확인" || echo "R14 OK: 신규 하드코딩 라벨 0"
# R8/R9: 동결 파일 0-diff
git diff --name-only master.. | grep -E 'methodBadge|FlowOutline|TestFlowChips|Callout\.tsx|Field\.tsx|Badge\.tsx|Section\.tsx|tailwind\.config' && echo "!!! 동결 파일 변경됨 — 확인 필요" || echo "R8/R9/토대 OK: 동결 파일 0-diff"
```
Expected: 각 라인 "OK" 출력(동결 파일 변경 라인이 나오면 되돌림).

- [ ] **Step 3: 최종 리뷰 (whole-branch)**

`handicap-reviewer`(1M 세션이므로 명시 `model: opus`)로 전체 브랜치 리뷰 — cross-file 일관성(인라인-vs-박스 경계·같은 패턴 누락 없나)·wire 1:1·데이터-식별 색 동결·size 변형 byte-identical. 리뷰 BASE = 이 슬라이스 첫 커밋 직전(= spec/plan docs 커밋 위). findings는 `receiving-code-review`로 판정 후 반영/기각. APPROVE까지.

(코드 편집이 필요하면 해당 Task로 돌아가 fix→그 파일 재게이트.)

---

## Task 11: 마무리 문서 (finish-slice가 수행 — 라이브 검증 후)

**Files:**
- Modify: `docs/build-log.md`, `docs/roadmap-status.md`, `docs/roadmap.md`(§B12), 루트 `CLAUDE.md`(상태줄), 메모리.

- [ ] **Step 1: 라이브 검증(R16)** — `/live-verify` 스택(워크트리 자체 바이너리) + Playwright: `/scenarios/new` 및 저장된 시나리오 에디터에서 console 0·입력 accent 포커스 링·KeyValueGrid combobox·dnd-kit 드래그(`browser_drag`)·YAML/스텝 편집 모달 스모크·이름 입력(R13) 헤더 룩 실측(어색하면 Task 9 동결 후퇴). 상세 = `ui/CLAUDE.md`·`docs/dev/live-verify-playwright.md`.
- [ ] **Step 2: `/finish-slice`** — build-log 단락(파이프라인·함정·라이브)·roadmap-status frontier 전진(§B12 에디터 완료)·roadmap.md §B12 완료 이동 + 새 연기(Button-accent 이주·Section 카드 variant·InspectorSection 통합)·루트 CLAUDE.md 상태줄 교체·메모리·ff-merge·`ExitWorktree`.

---

## Self-Review (작성자 체크)

**1. Spec coverage:** R1(Task1)·R2(Task1 Step6)·R3/R4(Task2~9)·R5(전 task 핸들러 verbatim)·R6(Task4/5/6/7/8/9 Callout)·R7(전 task 인라인 동결)·R8/R9(Task10 grep + 전 task 동결)·R10(Task10 grep)·R11(Task10 grep)·R12(Task2 URL)·R13(Task9 이름)·R14(Task 문구 유지)·R15(Task2/3 combobox·ref)·R16(Task11 라이브) — 전 요구사항에 task 매핑됨.

**2. Placeholder scan:** 이주가 기계적이라 대표 패턴 + spec §4 권위 참조 구조. "실제 파일에서 재확인"은 file:line 드리프트 대비(placeholder 아님 — 규칙이 권위). Task 7의 ExtractConfirmRow 테스트 fixture는 실제 props 시그니처 확인 후 최소 구성(구현 시).

**3. Type consistency:** `size?: "sm"`·`Omit<…,"size">`·`SIZE[size ?? "md"]`가 Task1 전체에서 일관. `Input`/`Select` import 경로 `../ui/Input`·`../ui/Select`(scenario/)·`../ui/Callout`. 페이지는 `../components/ui/…`(경로는 구현 시 상대깊이 확인 — `ui/CLAUDE.md` import-깊이 함정).

---

<!-- REVIEW-GATE: APPROVED -->
spec + plan 둘 다 `spec-plan-reviewer` clean APPROVE (2026-07-03, 2라운드 각각). 구현은 fresh 컨텍스트에서 subagent-driven-development로.
