# Button-accent 드리프트 이주 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱에 흩어진 컨트롤 affordance 색(raw `indigo-*`/`blue-*`)을 `accent` 토큰으로 통일하고, 신규 `Textarea` 프리미티브로 5개 textarea에 Input/Select와 동일한 accent 포커스 링을 입힌다.

**Architecture:** UI-only. (1) `Input`을 미러한 `Textarea` 프리미티브 신설 → (2) 5개 raw `<textarea>`를 프리미티브로 교체(높이·패딩·`font-mono`·텍스트 크기는 className으로 보존) → (3) 18개 컨트롤 색 리터럴을 `accent-*`로 스왑. `accent = colors.indigo`(빌드타임 별칭)라 indigo→accent는 픽셀 동일, blue→accent만 가시적 색 변경. 데이터 식별 색(차트·배지·범례 점)은 동결.

**Tech Stack:** React 18 + TypeScript + Tailwind v3 + Vitest/RTL. 프리미티브는 `ui/src/components/ui/`.

**Spec:** `docs/superpowers/specs/2026-07-04-button-accent-migration-design.md` (spec-plan-reviewer clean APPROVE, commit `addef9a`).

## Global Constraints

- **UI-only 0-diff 불변식**: backend/proto/migration/`schemas.ts`/scenario `model.ts`/`yamlDoc.ts`/engine/`tailwind.config.ts`/`ko.ts` **전부 0-diff**. 페이로드/wire/동작 byte-identical.
- **`accent = colors.indigo`** (`ui/tailwind.config.ts:12`): `accent-{50,200,500,600,700}`은 소스에 리터럴로 이미 등장 → Tailwind JIT가 이미 생성. `bg-accent-600` === `bg-indigo-600` 렌더.
- **filled 버튼은 색 클래스만 교체** — `Button` 프리미티브로 대체 금지(프리미티브 `px-4 py-2 rounded-md`가 컴팩트 버튼 geometry를 깨뜨림). 컴팩트 padding/rounded 보존.
- **데이터 식별 색 동결** (미변경): `StatusBadge`(running), `methodBadge`(POST 등), `ConnectionCostCard` 범례 점(`bg-indigo-500`), `TestRunPanel` 추출 변수 칩(`bg-indigo-100 text-indigo-800`), `StageCurvePreview` stroke.
- **밀도 트랩** (ui/CLAUDE.md): `text-xs` 코드 필드는 `size="sm"`으로 12px 유지(기본 md는 14px). 상속 `text-xs` 형제와 어긋나면 회귀.
- **게이트**: 매 task 커밋 전 `pnpm lint && pnpm test && pnpm build`(전체). `pnpm lint`는 `--max-warnings=0`.
- **tdd-guard**: `ui/src/**`(non-test) 편집 전 작업트리에 pending(modified/untracked) test 파일이 있어야 한다 → **각 task는 test 파일 편집을 먼저**.
- **커밋 트레일러**: 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz`. `git commit`을 `| tail`/`| head`로 파이프 금지, `--no-verify` 금지.

---

### Task 1: `Textarea` 프리미티브 신설

`ui/src/components/ui/Input.tsx`를 미러한 textarea 프리미티브. 아직 아무도 채택하지 않으므로 시각 변경 0 — 독립 리뷰 가능한 단위.

**Files:**
- Create: `ui/src/components/ui/Textarea.tsx`
- Test: `ui/src/components/ui/__tests__/Textarea.test.tsx`

**Interfaces:**
- Produces: `Textarea` — `forwardRef<HTMLTextAreaElement, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> & { size?: "sm" }>`. BASE는 `Input`과 동일한 accent 포커스/aria-invalid/disabled + `rounded-md`. `size` 미지정=`md`(text-sm), `"sm"`=text-xs. 높이·`font-mono`는 호출자 className.

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/ui/__tests__/Textarea.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { Textarea } from "../Textarea";

describe("Textarea 프리미티브", () => {
  it("base 토큰(accent 포커스·rounded-md·text-slate-900) + 호출자 className 병합", () => {
    render(<Textarea aria-label="ta" className="h-32 font-mono" />);
    const el = screen.getByLabelText("ta");
    expect(el.tagName).toBe("TEXTAREA");
    expect(el.className).toContain("h-32");
    expect(el.className).toContain("font-mono");
    expect(el).toHaveClass("rounded-md");
    expect(el).toHaveClass("text-slate-900");
    expect(el).toHaveClass("focus:ring-accent-500/30");
    expect(el).toHaveClass("focus:border-accent-500");
  });

  it("표준 속성/aria/value 패스스루", () => {
    render(<Textarea aria-label="t" aria-invalid="true" readOnly rows={4} defaultValue="hi" />);
    const el = screen.getByLabelText("t") as HTMLTextAreaElement;
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(el.readOnly).toBe(true);
    expect(el.value).toBe("hi");
  });

  it("ref를 실제 textarea DOM 노드로 전달", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea aria-label="t" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("기본 size는 text-sm(text-xs 아님)", () => {
    render(<Textarea aria-label="t" />);
    const el = screen.getByLabelText("t");
    expect(el).toHaveClass("text-sm");
    expect(el).not.toHaveClass("text-xs");
  });

  it("size='sm'은 text-xs(text-sm 아님)", () => {
    render(<Textarea aria-label="t" size="sm" />);
    const el = screen.getByLabelText("t");
    expect(el).toHaveClass("text-xs");
    expect(el).not.toHaveClass("text-sm");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test Textarea`
Expected: FAIL — `Cannot find module "../Textarea"`.

- [ ] **Step 3: 프리미티브 구현** — `ui/src/components/ui/Textarea.tsx`

```tsx
import { forwardRef, type TextareaHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

const SIZE = { md: "text-sm", sm: "text-xs" } as const;

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> & { size?: "sm" };

export const Textarea = forwardRef<HTMLTextAreaElement, Props>(function Textarea(
  { className, size, ...rest },
  ref,
) {
  return (
    <textarea ref={ref} className={`${BASE} ${SIZE[size ?? "md"]} ${className ?? ""}`} {...rest} />
  );
});
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test Textarea`
Expected: PASS (5 tests).

- [ ] **Step 5: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

```bash
git add ui/src/components/ui/Textarea.tsx ui/src/components/ui/__tests__/Textarea.test.tsx
git commit -m "feat(ui): Textarea 프리미티브 — Input 미러(accent 포커스·size)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz"
```

---

### Task 2: 5개 textarea를 `Textarea` 프리미티브로 채택

raw `<textarea>` 5곳을 프리미티브로 교체. 높이·패딩·`font-mono`·텍스트 크기 보존, 실제 변경은 accent 포커스 링 + `rounded`→`rounded-md`(+ inert `text-slate-900`)뿐.

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx` (JsonBodyField ~:539, RawBodyField ~:592)
- Modify: `ui/src/components/scenario/BulkEditPanel.tsx` (~:22)
- Modify: `ui/src/pages/ScenarioImportPage.tsx` (~:376)
- Modify: `ui/src/components/AutoGrowTextarea.tsx` (~:23, 프리미티브 합성)
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (~:54, className 축소)
- Test: `ui/src/components/scenario/__tests__/BulkEditPanel.test.tsx` (accent-focus 회귀 추가)

**Interfaces:**
- Consumes: `Textarea` (Task 1).

- [ ] **Step 1: 회귀 테스트 먼저(tdd-guard 언블록)** — `ui/src/components/scenario/__tests__/BulkEditPanel.test.tsx`의 `describe("BulkEditPanel", …)` 안에 새 `it` 추가:

```tsx
  it("일괄편집 textarea는 accent 포커스 링(프리미티브)을 쓴다", () => {
    render(
      <BulkEditPanel entries={{}} format="header" onApply={vi.fn()} onCancel={vi.fn()} />,
    );
    const ta = screen.getByLabelText("일괄 편집 텍스트");
    expect(ta).toHaveClass("focus:ring-accent-500/30"); // 이주 전 RED
    expect(ta).toHaveClass("rounded-md");
    expect(ta).toHaveClass("text-xs"); // size='sm' 밀도 보존
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test BulkEditPanel`
Expected: 새 `it` FAIL(raw textarea엔 `focus:ring-accent-500/30`·`rounded-md` 없음).

- [ ] **Step 3a: JsonBodyField 교체** — `Inspector.tsx`. `<textarea>`(현 `w-full h-32 border border-slate-300 rounded px-2 py-1 text-xs font-mono`)를 다음으로:

```tsx
      <Textarea
        size="sm"
        aria-label={ko.editor.jsonBodyAria}
        className="h-32 font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        spellCheck={false}
      />
```

- [ ] **Step 3b: RawBodyField 교체** — `Inspector.tsx`. `<textarea>`(현 `w-full h-24 border border-slate-300 rounded px-2 py-1 text-xs font-mono`)를:

```tsx
    <Textarea
      size="sm"
      className="h-24 font-mono"
      value={value}
      onChange={(e) => setStepField(step.id, ["request", "body"], { raw: e.target.value })}
      spellCheck={false}
    />
```

- [ ] **Step 3c: Inspector import 추가** — `Inspector.tsx` 상단 import 블록에 `import { Textarea } from "../ui/Textarea";` 추가(기존 `../ui/Input`·`../ui/Select` import와 같은 경로 관례; 정확 상대경로는 형제 import 확인).

- [ ] **Step 3d: BulkEditPanel 교체** — `BulkEditPanel.tsx`. 상단에 `import { Textarea } from "../ui/Textarea";`. `<textarea>`(현 `w-full min-w-0 h-32 border border-slate-300 rounded px-2 py-1 text-xs font-mono`)를:

```tsx
      <Textarea
        size="sm"
        aria-label={ko.bulkEdit.textAria}
        className="min-w-0 h-32 font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
```

- [ ] **Step 3e: ScenarioImportPage 교체** — `ScenarioImportPage.tsx`. 상단에 `import { Textarea } from "../components/ui/Textarea";`(정확 상대경로는 형제 import 확인). `<textarea>`(현 `rounded border border-slate-300 p-2 font-mono text-xs`, readOnly, rows=16)를:

```tsx
            <Textarea
              size="sm"
              aria-label={ko.import.preview}
              readOnly
              value={yaml}
              rows={16}
              className="py-2 font-mono"
            />
```

주의: 현 `p-2`=`px-2 py-2`인데 BASE는 `py-1`이라 `py-2`로 세로 패딩 복원(가로 px-2는 BASE 제공, spec §3.1).

- [ ] **Step 3f: AutoGrowTextarea 합성** — `AutoGrowTextarea.tsx` 전체를:

```tsx
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";
import { Textarea } from "./ui/Textarea";

/**
 * Controlled textarea that grows to fit its content (1 row when short, taller as
 * the value wraps) so long values — JWT tokens, URLs, JSON — are fully visible.
 * Caps at `max-h-40` then scrolls internally. jsdom reports scrollHeight 0, so the
 * auto-grow is a no-op in tests (value/onChange still work); the visual height is
 * verified live. Composes the `Textarea` primitive (accent focus ring).
 */
export function AutoGrowTextarea({
  value,
  className,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "size"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <Textarea
      ref={ref}
      value={value}
      rows={1}
      className={`resize-none overflow-y-auto max-h-40 ${className ?? ""}`}
      {...rest}
    />
  );
}
```

주의: prop 타입에서 `size`를 Omit(프리미티브 `size`와 native 미충돌이지만 명시 안전). `block w-full`은 프리미티브 BASE가 제공하므로 제거(기존 test `toHaveClass("w-full")`는 BASE `block w-full`로 유지).

- [ ] **Step 3g: VariablesPanel className 축소** — `VariablesPanel.tsx:54` `AutoGrowTextarea`의 `className`을 `"border border-slate-300 rounded px-2 py-1 text-sm font-mono"`에서 **`"font-mono"`**로 축소(border/rounded-md/px-2/py-1/text-sm은 프리미티브 제공, 기본 size md=text-sm 유지).

- [ ] **Step 4: 통과 + 완전성 확인**

Run: `cd ui && pnpm test BulkEditPanel AutoGrowTextarea Inspector ScenarioImportPage VariablesPanel`
Expected: 전부 PASS.

Run(완전성 — raw `<textarea>` 잔존 0, 단 프리미티브 자신의 leaf는 제외): `grep -rn "<textarea" ui/src --include="*.tsx" | grep -v "\.test\." | grep -v "components/ui/Textarea.tsx"`
Expected: **출력 없음**(5개 소비처 전부 `<Textarea>`로 이주; `ui/components/ui/Textarea.tsx`의 leaf `<textarea ref={ref}>`는 프리미티브 정의라 제외 — grep은 대소문자 구분이라 소비처 `<Textarea>`는 미매치).

- [ ] **Step 5: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/BulkEditPanel.tsx \
  ui/src/pages/ScenarioImportPage.tsx ui/src/components/AutoGrowTextarea.tsx \
  ui/src/components/scenario/VariablesPanel.tsx \
  ui/src/components/scenario/__tests__/BulkEditPanel.test.tsx
git commit -m "feat(ui): 5개 textarea를 Textarea 프리미티브로 채택(accent 포커스)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz"
```

---

### Task 3: 컨트롤 색 리터럴 → `accent` 토큰 스왑 (18 사이트)

색 클래스 문자열만 교체(주변 코드 무변경). indigo→accent 픽셀 동일, blue→accent 색 변경. 대표 3곳에 teeth 회귀 테스트, 나머지는 완전성 grep으로 acceptance.

**Files (Modify — className 문자열만):**
- `ui/src/pages/WorkerDashboardPage.tsx` (:67 삼항, :136, :491)
- `ui/src/components/SlotSizingHelper.tsx` (:105, :137)
- `ui/src/components/VuSizingHelper.tsx` (:131, :162)
- `ui/src/components/WorkerSizingHelper.tsx` (:95)
- `ui/src/components/StepCriteriaFields.tsx` (:106)
- `ui/src/components/ScheduleEventTimeline.tsx` (:43)
- `ui/src/components/scenario/ExtractConfirmRow.tsx` (:45, :66)
- `ui/src/components/scenario/ResponseBodyTree.tsx` (:67)
- `ui/src/pages/ScenarioRunsPage.tsx` (:267, :456)
- `ui/src/components/LoadModelFields.tsx` (:524)
- `ui/src/components/RunListControls.tsx` (:142)
- `ui/src/components/scenario/Inspector.tsx` (:1189 조건 그룹 레일)

**Test (teeth 회귀):**
- `ui/src/components/scenario/__tests__/ExtractConfirmRow.test.tsx`
- `ui/src/components/__tests__/StepCriteriaFields.test.tsx`
- `ui/src/components/scenario/__tests__/ResponseBodyTree.test.tsx`

- [ ] **Step 1: teeth 회귀 테스트 먼저(tdd-guard 언블록)**

**(a) ExtractConfirmRow.test.tsx** — 새 `describe` 블록 추가. 확인 버튼(**정확 라벨 `"추가"`** — 리터럴, ko 키 아님; :68) + 행 배경 단언. `render`/`screen`/`vi`는 기존 파일에서 이미 import됨:

```tsx
describe("ExtractConfirmRow — accent 색 (button-accent-migration)", () => {
  it("확인(추가) 버튼과 행 배경은 accent 토큰(indigo→accent)", () => {
    render(
      <ExtractConfirmRow
        proposed={{ var: "token", from: "body", path: "$.token" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const addBtn = screen.getByRole("button", { name: "추가" }); // 유일(다른 버튼="취소")
    expect(addBtn).toHaveClass("bg-accent-600"); // 이주 전 RED (현 bg-indigo-600)
    const row = addBtn.closest("div"); // 버튼의 직속 부모 = bg-*-50 행
    expect(row?.className).toContain("bg-accent-50"); // 이주 전 RED (현 bg-indigo-50)
  });
});
```

**(b) StepCriteriaFields.test.tsx** — 추가 버튼(link-style, blue→accent)에 teeth. 파일은 `test(...)` 관례(describe 없음)·모듈 스코프 `const opts = [{id:"A",label:...},{id:"B",label:...}]`가 이미 있음. 정확 라벨 `"+ 스텝 기준 추가"`:

```tsx
test("스텝 기준 추가 버튼은 accent 링크색(blue→accent)", () => {
  render(<StepCriteriaFields value={[]} options={opts} onChange={() => {}} />);
  const addBtn = screen.getByRole("button", { name: "+ 스텝 기준 추가" });
  expect(addBtn).toHaveClass("text-accent-600"); // 이주 전 RED (현 text-blue-600)
});
```

**(c) ResponseBodyTree.test.tsx** — +추출 버튼(indigo→accent)에 teeth. **단일 스칼라 값**으로 렌더해 "+추출" 버튼이 정확히 1개(멀티 스칼라면 `getByRole` 다중매치 throw). 정확 라벨 `"+추출"`. `render`/`screen`/`vi` 기존 import:

```tsx
  it("+추출 버튼은 accent 토큰(indigo→accent)", () => {
    render(<ResponseBodyTree value={{ data: { token: "abc" } }} onCreate={vi.fn()} />);
    const extractBtn = screen.getByRole("button", { name: "+추출" }); // 단일 스칼라=1개
    expect(extractBtn).toHaveClass("bg-accent-600"); // 이주 전 RED (현 bg-indigo-600)
  });
```
(이 `it`은 기존 `describe("ResponseBodyTree", …)` 안에 추가.)

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ExtractConfirmRow StepCriteriaFields ResponseBodyTree`
Expected: 3개 새 `it` FAIL(현재 indigo-600/blue-600).

- [ ] **Step 3: 색 스왑(find → replace, className 문자열만)**

| 파일 | old (부분) | new |
|---|---|---|
| `WorkerDashboardPage.tsx:67` | `: "bg-blue-600 hover:bg-blue-700"` | `: "bg-accent-600 hover:bg-accent-700"` (`destructive ? "bg-red-600 …"` 그대로) |
| `WorkerDashboardPage.tsx:136` | `bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700` (:136은 두 토큰이 **비인접** — 중간 클래스 포함해야 매치) | `bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700` |
| `WorkerDashboardPage.tsx:491` | `text-blue-600 hover:underline` | `text-accent-600 hover:underline` |
| `SlotSizingHelper.tsx:105` | `text-blue-600 hover:underline` | `text-accent-600 hover:underline` |
| `SlotSizingHelper.tsx:137` | `bg-indigo-600 px-2 py-1 text-sm text-white hover:bg-indigo-700` | `bg-accent-600 px-2 py-1 text-sm text-white hover:bg-accent-700` |
| `VuSizingHelper.tsx:131` | `text-blue-600 hover:underline` | `text-accent-600 hover:underline` |
| `VuSizingHelper.tsx:162` | `bg-indigo-600 px-2 py-1 text-sm text-white hover:bg-indigo-700` | `bg-accent-600 px-2 py-1 text-sm text-white hover:bg-accent-700` |
| `WorkerSizingHelper.tsx:95` | `bg-indigo-600 px-2 py-1 text-sm text-white hover:bg-indigo-700` | `bg-accent-600 px-2 py-1 text-sm text-white hover:bg-accent-700` |
| `StepCriteriaFields.tsx:106` | `text-blue-600 hover:underline` | `text-accent-600 hover:underline` |
| `ScheduleEventTimeline.tsx:43` | `text-blue-600 hover:underline` | `text-accent-600 hover:underline` |
| `ExtractConfirmRow.tsx:45` | `rounded bg-indigo-50 px-2 py-1 text-xs` | `rounded bg-accent-50 px-2 py-1 text-xs` |
| `ExtractConfirmRow.tsx:66` | `rounded bg-indigo-600 px-2 py-0.5 text-white` | `rounded bg-accent-600 px-2 py-0.5 text-white` |
| `ResponseBodyTree.tsx:67` | `rounded bg-indigo-600 px-1.5 py-0.5 text-[11px] text-white` | `rounded bg-accent-600 px-1.5 py-0.5 text-[11px] text-white` |
| `ScenarioRunsPage.tsx:267` | `rounded bg-indigo-600 px-3 py-1 text-white hover:bg-indigo-700` | `rounded bg-accent-600 px-3 py-1 text-white hover:bg-accent-700` |
| `ScenarioRunsPage.tsx:456` | `text-xs text-indigo-600` | `text-xs text-accent-600` |
| `LoadModelFields.tsx:524` | `border-indigo-500 bg-indigo-50 text-indigo-700` | `border-accent-500 bg-accent-50 text-accent-700` |
| `RunListControls.tsx:142` | `border-indigo-500 bg-indigo-50 text-indigo-700` | `border-accent-500 bg-accent-50 text-accent-700` |
| `Inspector.tsx:1189` | `border-l-2 border-indigo-200 pl-2` | `border-l-2 border-accent-200 pl-2` |

> 라인 번호는 드리프트 가능 — 각 파일에서 old 문자열로 검색해 교체. 각 old 문자열은 파일 내 유일(중복이면 해당 컨텍스트 라인 사용).

- [ ] **Step 4: teeth 통과 + 완전성 grep**

Run: `cd ui && pnpm test ExtractConfirmRow StepCriteriaFields ResponseBodyTree`
Expected: 3개 새 `it` PASS.

Run(완전성 — 컨트롤 색 잔존 0, **동결 5곳만 남아야 함**):
```bash
grep -rn "indigo-\|blue-[0-9]" ui/src --include="*.tsx" --include="*.ts" | grep -v "\.test\."
```
Expected: 정확히 다음 5곳(동결)만 — `StatusBadge.tsx`(running), `methodBadge.ts`(POST 등), `ConnectionCostCard.tsx`(범례 점 `bg-indigo-500`), `TestRunPanel.tsx`(추출 칩 `bg-indigo-100 text-indigo-800`), `StageCurvePreview.tsx`(주석의 blue-600). **그 외 매치가 있으면 미이주 잔존.**

- [ ] **Step 5: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

```bash
git add ui/src/pages/WorkerDashboardPage.tsx ui/src/components/SlotSizingHelper.tsx \
  ui/src/components/VuSizingHelper.tsx ui/src/components/WorkerSizingHelper.tsx \
  ui/src/components/StepCriteriaFields.tsx ui/src/components/ScheduleEventTimeline.tsx \
  ui/src/components/scenario/ExtractConfirmRow.tsx ui/src/components/scenario/ResponseBodyTree.tsx \
  ui/src/pages/ScenarioRunsPage.tsx ui/src/components/LoadModelFields.tsx \
  ui/src/components/RunListControls.tsx ui/src/components/scenario/Inspector.tsx \
  ui/src/components/scenario/__tests__/ExtractConfirmRow.test.tsx \
  ui/src/components/__tests__/StepCriteriaFields.test.tsx \
  ui/src/components/scenario/__tests__/ResponseBodyTree.test.tsx
git commit -m "feat(ui): 컨트롤 색 리터럴 → accent 토큰(indigo/blue 드리프트 통일)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz"
```

---

## 최종 검증 (전 task 후, orchestrator)

- [ ] **완전성 grep 재실행**(self-report 불신): 위 Task 2 Step 4 `<textarea>` grep(프리미티브 `components/ui/Textarea.tsx` 제외 후) = 0, Task 3 Step 4 `indigo-/blue-` grep = 동결 5곳만. orchestrator가 직접 재실행.
- [ ] **`handicap-reviewer`** APPROVE(크로스커팅·wire 1:1·0-diff 불변식 재확인). 보안 표면 게이트는 diff가 요청실행/템플릿/env·dataset 바인딩/업로드/trace 뷰어를 안 건드리므로 N/A(finish-slice §0 grep으로 확인).
- [ ] **라이브 시각 검증(경량, Playwright)**: production diff가 UI-only(run-생성/report-파싱/엔진 무접촉)라 full live-verify 스택 불요. (1) `/scenarios/new` 에디터에서 http 스텝 JSON 바디 textarea 포커스 → accent 링(border-color `#6366f1` + box-shadow) 실측, (2) WorkerDashboard 버튼이 indigo(#4f46e5)인지 실측. 순수 UI·백엔드 불필요(vite dev는 IPv6 `[::1]`만 바인드 → `localhost`로 navigate, ui/CLAUDE.md).
- [ ] **`/finish-slice`** — build-log·roadmap-status·CLAUDE 상태줄·메모리 기록 → ff-merge → ExitWorktree.

## Self-Review (writing-plans)

- **Spec 커버리지**: §3 Textarea 프리미티브→Task 1. §3.1/§3.2 채택 5곳→Task 2. §4.1/§4.2 색 스왑 18곳→Task 3. §5 동결→Task 3 완전성 grep의 허용 목록. §6 불변식→Global Constraints + 각 task grep. §7 테스트/검증→각 task teeth + 최종 검증. §8 파일 인벤토리→Task 2/3 Files. 갭 없음.
- **Placeholder**: 모든 step에 실제 코드/명령/예상 출력. TBD 없음.
- **타입 일관성**: `Textarea` 시그니처(Task 1 Produces)가 Task 2 채택부(size="sm"·className·ref)와 일치. `bg-accent-600`/`text-accent-600`/`border-accent-*` 클래스명이 Task 3 전반 일관.

<!-- REVIEW-GATE: APPROVED -->
