# 디자인 시스템 5차 (compact·card variant + RunListControls 해동·InspectorSection 통합) Implementation Plan

REVIEW-GATE: APPROVED

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Input`/`Select`에 밀도 축 `compact` prop, `Section`에 `variant="card"`+`aria-label`+접힘 hint accname 픽스를 additive로 추가하고, 동결 채택처 2곳(RunListControls raw 컨트롤·Inspector 로컬 InspectorSection/카드 fieldset)을 해동/통합한다.

**Architecture:** UI-only, 토대 3파일(`ui/src/components/ui/{Input,Select,Section}.tsx`) additive 변경 + 채택처 2파일(`RunListControls.tsx`·`scenario/Inspector.tsx`) JSX 교체. 서버/와이어/모델/`ko.ts` 전부 0-diff.

**Tech Stack:** React + TS + Tailwind(시맨틱 accent 토큰) / RTL + vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-design-system-variants-design.md` — R-id·US-id는 전부 그 spec §2·§3을 가리킨다.

## Global Constraints

- **byte-identical 정의(spec §3)**: 태그·aria·클래스 *집합*·computed style 동일(클래스 문자열 순서 차이만 허용). 의도된 delta는 R5의 3건(radius 4→6px·포커스 링 획득·date `px-1`→`px-2`)과 R4 hint DOM 이동뿐.
- **각 파일은 자기 BASE 유지**: `Select.tsx`엔 `aria-[invalid=true]:*` 두 줄·`numeric`이 **없다** — Input 것을 이식 금지(R1·spec §4.1 ⚠).
- 신규 사용자 문구 0 — `ko.ts` 0-diff(R11). 신규 `blue-*`/`indigo-*` 리터럴 0.
- `crates/`·proto·`ui/src/api/**`·`ui/src/runs/runFilterSort.ts`·`ui/src/scenario/**`(store/model) 0-diff(R9).
- **tdd-guard**: 각 task의 첫 편집은 반드시 테스트 파일(pending test 없이 src 편집 시 차단됨).
- UI 게이트: `cd ui && pnpm lint && pnpm test && pnpm build`(lint `--max-warnings=0`, build `tsc -b`가 최종). 단일 파일 반복은 `pnpm test <name>`(**`--` 붙이면 전체 스위트**).
- 커밋은 **단일 blocking 호출**(`run_in_background: false`, timeout 600000ms), `git commit … | tail` 파이프 금지, `--no-verify` 금지.
- 리포트 파일(`task-N-report.md` 등)은 `.superpowers/sdd/` 아래에만 — worktree 루트에 쓰지 말고 `git add` 금지.

---

### Task 1: `Input`/`Select` compact 밀도 variant (R1)

**Files:**
- Test: `ui/src/components/ui/__tests__/Input.test.tsx` (append — Input·Select 테스트가 이 한 파일에 같이 있다)
- Modify: `ui/src/components/ui/Input.tsx`
- Modify: `ui/src/components/ui/Select.tsx`

**Interfaces:**
- Consumes: 없음 (토대 leaf).
- Produces: `Input`/`Select`의 additive prop `compact?: boolean` — true면 세로 패딩 `py-0.5`, 미지정이면 `py-1`(기존). `size?: "sm"`(폰트 축)과 직교 조합 가능. Task 3이 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/components/ui/__tests__/Input.test.tsx` 파일 끝에 append (파일 상단 기존 import에 `render`/`screen`/`Input`/`Select` 이미 있음 — 새 import 불요):

```tsx
describe("compact 밀도 variant (디자인시스템 5차 R1)", () => {
  it("Input compact는 py-0.5를 쓰고 py-1은 없다", () => {
    render(<Input aria-label="c" compact />);
    const el = screen.getByLabelText("c");
    expect(el).toHaveClass("py-0.5");
    expect(el).not.toHaveClass("py-1");
  });

  it("Input 미지정은 py-1 유지 (기존 경로 클래스 집합 불변)", () => {
    render(<Input aria-label="n" />);
    const el = screen.getByLabelText("n");
    expect(el).toHaveClass("py-1");
    expect(el).not.toHaveClass("py-0.5");
  });

  it("compact는 size와 직교 — compact+size=sm 조합", () => {
    render(<Input aria-label="cs" compact size="sm" />);
    const el = screen.getByLabelText("cs");
    expect(el).toHaveClass("py-0.5");
    expect(el).toHaveClass("text-xs");
  });

  it("Select compact는 py-0.5를 쓰고 py-1은 없다 — aria-invalid 클래스는 여전히 없음 (Input BASE 이식 금지)", () => {
    render(
      <Select aria-label="cSel" compact>
        <option>a</option>
      </Select>,
    );
    const el = screen.getByLabelText("cSel");
    expect(el).toHaveClass("py-0.5");
    expect(el).not.toHaveClass("py-1");
    expect(el.className).not.toContain("aria-[invalid=true]");
  });

  it("Select 미지정은 py-1 유지", () => {
    render(
      <Select aria-label="nSel">
        <option>a</option>
      </Select>,
    );
    expect(screen.getByLabelText("nSel")).toHaveClass("py-1");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test Input`
Expected: 신규 5개 중 compact 케이스 3개(#1·#3·#4) FAIL (`compact` prop 미존재 → `py-0.5` 부재). #2·#5(미지정 py-1 락)는 pre-impl에도 PASS가 정상 — 5/5 RED를 기대하지 말 것. 기존 케이스 전부 PASS.

- [ ] **Step 3: `Input.tsx` 구현** — 파일 전체를 다음으로 교체 (변경점: BASE에서 `py-1`을 `PAD` 맵으로 분리 + `compact` prop):

```tsx
import { forwardRef, type InputHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

const PAD = { normal: "py-1", compact: "py-0.5" } as const;
const SIZE = { md: "text-sm", sm: "text-xs" } as const;

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  numeric?: boolean;
  size?: "sm";
  compact?: boolean;
};

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, numeric, size, compact, ...rest },
  ref,
) {
  const base = `${BASE} ${PAD[compact ? "compact" : "normal"]} ${SIZE[size ?? "md"]}${
    numeric ? " tabular-nums" : ""
  }`;
  return <input ref={ref} className={`${base} ${className ?? ""}`} {...rest} />;
});
```

- [ ] **Step 4: `Select.tsx` 구현** — 파일 전체를 다음으로 교체 (**Select의 자기 BASE 유지** — aria-invalid 줄·numeric 없음):

```tsx
import { forwardRef, type SelectHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

const PAD = { normal: "py-1", compact: "py-0.5" } as const;
const SIZE = { md: "text-sm", sm: "text-xs" } as const;

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: "sm";
  compact?: boolean;
};

export const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { className, children, size, compact, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={`${BASE} ${PAD[compact ? "compact" : "normal"]} ${SIZE[size ?? "md"]} ${
        className ?? ""
      }`}
      {...rest}
    >
      {children}
    </select>
  );
});
```

- [ ] **Step 5: GREEN 확인**

Run: `cd ui && pnpm test Input`
Expected: 기존 + 신규 전부 PASS.

- [ ] **Step 6: 커밋** (단일 blocking — pre-commit이 전체 UI 게이트 실행):

```bash
git add ui/src/components/ui/__tests__/Input.test.tsx ui/src/components/ui/Input.tsx ui/src/components/ui/Select.tsx
git commit -m "feat(ui): Input/Select compact 밀도 variant — py-0.5, size 축과 직교 (디자인시스템 5차 R1)"
```

---

### Task 2: `Section` card variant + aria-label passthrough + 접힘 hint accname 픽스 (R2·R3·R4)

**Files:**
- Test: `ui/src/components/ui/__tests__/Section.test.tsx` (append)
- Modify: `ui/src/components/ui/Section.tsx`

**Interfaces:**
- Consumes: 없음.
- Produces: `Section`의 additive props `variant?: "card"`·`"aria-label"?: string`. card 렌더 경로는 spec §4.2 표(리터럴 계약)와 1:1: fieldset `flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3`, legend `px-1 text-xs font-semibold text-slate-600`(+collapsible이면 ` flex items-center gap-1`), 접이 버튼 `hover:underline`+`<span aria-hidden>▾/▸</span> {title}`, hint는 버튼 밖 `<span className="font-normal text-slate-400">`, 본문은 `mt-2` 래퍼 없이 직접. card에서 `index`/`badge`/`help`/`divider`는 무시. **기본 variant의 hint도 버튼 밖으로 이동**(신설 `<span className="flex items-center gap-2">` 래퍼 — 유일한 승인된 기본-variant 구조 delta). Task 4가 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/components/ui/__tests__/Section.test.tsx` 파일 끝(기존 `describe` 닫힘 뒤)에 append:

```tsx
describe("Section — card variant (R2·R3) + 접힘 hint accname 픽스 (R4)", () => {
  it("card non-collapsible: 카드 fieldset·legend 클래스, children은 fieldset 직속(mt-2 래퍼 없음)", () => {
    render(
      <Section variant="card" title="요청">
        <input aria-label="url" />
      </Section>,
    );
    const fieldset = screen.getByRole("group", { name: "요청" });
    expect(fieldset).toHaveClass(
      "flex",
      "flex-col",
      "gap-2",
      "min-w-0",
      "border",
      "border-slate-200",
      "rounded",
      "p-3",
    );
    expect(fieldset).not.toHaveClass("mb-4");
    const legend = fieldset.querySelector("legend")!;
    expect(legend).toHaveClass("px-1", "text-xs", "font-semibold", "text-slate-600");
    expect(legend).not.toHaveClass("flex");
    expect(screen.getByLabelText("url").parentElement).toBe(fieldset);
  });

  it("card aria-label passthrough: 전달 시 fieldset 속성, 미전달 시 부재 (R3)", () => {
    const { rerender } = render(
      <Section variant="card" title="조건" aria-label="조건">
        <span>c</span>
      </Section>,
    );
    expect(screen.getByRole("group", { name: "조건" })).toHaveAttribute("aria-label", "조건");
    rerender(
      <Section variant="card" title="조건2">
        <span>c</span>
      </Section>,
    );
    expect(screen.getByRole("group", { name: "조건2" })).not.toHaveAttribute("aria-label");
  });

  it("card collapsible: 접힘 시 children 미렌더, legend는 flex, accname은 제목 정확매치, hint는 버튼 밖 (R2·R4)", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <Section
        variant="card"
        collapsible
        open={false}
        onToggle={onToggle}
        title="Headers"
        hint="2개 설정됨"
      >
        <input aria-label="hk" />
      </Section>,
    );
    expect(screen.queryByLabelText("hk")).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Headers" }); // 정확매치 — hint 미포함(US4)
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const hintEl = screen.getByText("2개 설정됨");
    expect(btn.contains(hintEl)).toBe(false);
    expect(btn.closest("legend")).toHaveClass("flex", "items-center", "gap-1");
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("card는 index/badge/divider를 무시한다 (R2)", () => {
    render(
      <Section variant="card" title="T" index={3} badge={<span>B</span>} divider>
        <span>x</span>
      </Section>,
    );
    expect(screen.queryByText("3")).not.toBeInTheDocument();
    expect(screen.queryByText("B")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "T" })).not.toHaveClass("border-t");
  });

  it("R4: 기본 variant도 접힘 hint가 버튼 밖 — accname 제목 정확매치", () => {
    render(
      <Section title="판정·고급" collapsible open={false} onToggle={() => {}} hint="3개 설정됨">
        <input aria-label="slo" />
      </Section>,
    );
    const btn = screen.getByRole("button", { name: "판정·고급" }); // 픽스 전 accname="판정·고급 3개 설정됨"이라 FAIL
    expect(btn.contains(screen.getByText("3개 설정됨"))).toBe(false);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test Section`
Expected: 신규 5개 FAIL(card variant 미존재·기본 variant hint가 버튼 안), 기존 전부 PASS. (`pnpm test Section` 필터는 이름 매치로 **4파일**을 돌린다 — `Section.test.tsx`·`PageSection.test.tsx`·`TestRunSection.test.tsx`·`CompareOverlaySection.test.tsx`. 나머지 3파일의 기존 ~10+ 테스트도 전부 PASS여야 정상.)

- [ ] **Step 3: `Section.tsx` 구현** — 파일 전체를 다음으로 교체:

```tsx
import type { ReactNode } from "react";

export function Section({
  index,
  title,
  badge,
  help,
  divider,
  collapsible,
  open,
  onToggle,
  hint,
  variant,
  "aria-label": ariaLabel,
  children,
}: {
  index?: number;
  title: ReactNode;
  badge?: ReactNode;
  help?: ReactNode;
  divider?: boolean;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  hint?: ReactNode;
  variant?: "card";
  "aria-label"?: string;
  children?: ReactNode;
}) {
  if (variant === "card") {
    // 에디터 카드 캐넌 — 구 Inspector InspectorSection과 1:1 (spec §4.2 리터럴 계약).
    // index/badge/help/divider는 카드 경로에서 무시(R2). 본문은 래퍼 없이 직접(fieldset flex gap이 간격 소유).
    return (
      <fieldset
        aria-label={ariaLabel}
        className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3"
      >
        <legend
          className={`px-1 text-xs font-semibold text-slate-600${
            collapsible ? " flex items-center gap-1" : ""
          }`}
        >
          {collapsible ? (
            <>
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="hover:underline"
              >
                <span aria-hidden="true">{open ? "▾" : "▸"}</span> {title}
              </button>
              {!open && hint != null && <span className="font-normal text-slate-400">{hint}</span>}
            </>
          ) : (
            title
          )}
        </legend>
        {(!collapsible || open) && children}
      </fieldset>
    );
  }

  const numberBadge =
    index != null ? (
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-600 text-xs font-bold text-white"
        aria-hidden="true"
      >
        {index}
      </span>
    ) : null;

  const titleRow = (
    <span className="flex items-center gap-2">
      {numberBadge}
      <span className="text-sm font-semibold text-slate-800">{title}</span>
      {badge}
    </span>
  );

  return (
    <fieldset
      aria-label={ariaLabel}
      className={`mb-4 ${divider ? "border-t border-slate-200 pt-3" : ""}`}
    >
      <legend className="text-sm font-medium">
        {collapsible ? (
          // R4: hint는 버튼 밖 형제 — accname은 제목만(값 따라 변하는 hint가 이름을 오염하지 않게).
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="flex items-center gap-2 text-slate-700 hover:underline"
            >
              <span aria-hidden="true">{open ? "▾" : "▸"}</span>
              {titleRow}
            </button>
            {!open && hint != null ? (
              <span className="text-xs font-normal text-slate-500">{hint}</span>
            ) : null}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            {titleRow}
            {help}
          </span>
        )}
      </legend>
      {(!collapsible || open) && <div className="mt-2">{children}</div>}
    </fieldset>
  );
}
```

- [ ] **Step 4: GREEN 확인 + 기본 variant 소비처 생존 확인 (R8)**

Run: `cd ui && pnpm test Section`
Expected: 전부 PASS.

Run: `cd ui && pnpm test RunDialog`
Expected: 전부 PASS (접힘 토글 단언이 정규식 `/판정·고급/` 등이라 생존).

Run: `cd ui && pnpm test ScheduleForm`
Expected: 전부 PASS.

- [ ] **Step 5: 커밋** (단일 blocking):

```bash
git add ui/src/components/ui/__tests__/Section.test.tsx ui/src/components/ui/Section.tsx
git commit -m "feat(ui): Section card variant + aria-label passthrough + 접힘 hint accname 픽스 (디자인시스템 5차 R2-R4)"
```

---

### Task 3: RunListControls 해동 — 날짜 컨트롤 3개 이주 (R5)

**Files:**
- Test: `ui/src/components/__tests__/RunListControls.test.tsx` (append)
- Modify: `ui/src/components/RunListControls.tsx` (`DateFilter` 함수 + import 2줄)

**Interfaces:**
- Consumes: Task 1의 `Input`/`Select` `compact` prop.
- Produces: 없음 (leaf 채택처). 필터/정렬 핸들러·직렬화(`runFilterSort.ts`) 무접촉.

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/components/__tests__/RunListControls.test.tsx` 파일 끝에 append (기존 `setup` 헬퍼·import 재사용):

```tsx
describe("RunListControls — 디자인시스템 compact 이주 (5차 R5)", () => {
  it("날짜 preset select가 Select 캐넌 compact를 쓴다 (rounded-md·포커스 링·py-0.5)", () => {
    setup();
    const sel = screen.getByLabelText(ko.runFilter.dateLabel);
    expect(sel).toHaveClass("rounded-md"); // 이주 전 "rounded"라 FAIL
    expect(sel).toHaveClass("py-0.5");
    expect(sel).toHaveClass("focus:ring-accent-500/30");
  });

  it("날짜 from/to input이 Input 캐넌 compact를 쓴다 (px-1→px-2 fold-in)", () => {
    setup();
    for (const label of [ko.runFilter.dateFromAria, ko.runFilter.dateToAria]) {
      const el = screen.getByLabelText(label);
      expect(el).toHaveClass("rounded-md", "py-0.5", "px-2");
      expect(el).not.toHaveClass("px-1");
    }
  });

  it("동결: 정렬 pill 내부 select는 투명 인라인 유지 (이주 대상 아님)", () => {
    setup(EMPTY_FILTER, [{ field: "created", dir: "desc" }]);
    expect(screen.getByLabelText(ko.runSort.fieldSelectAria(1))).toHaveClass("bg-transparent");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test RunListControls`
Expected: 신규 3개 중 앞 2개 FAIL(raw 클래스), 동결 단언·기존 전부 PASS.

- [ ] **Step 3: `RunListControls.tsx` 이주** — ① 파일 상단 import에 2줄 추가:

```tsx
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
```

② `DateFilter` 함수 전체를 다음으로 교체 (핸들러·값·aria-label 전부 그대로 — className/컴포넌트만 교체, raw `bg-white`는 승계하지 않음[spec §4.3]):

```tsx
function DateFilter({ filter, onChange }: { filter: RunFilter; onChange: (f: RunFilter) => void }) {
  const isCustom = !!(filter.dateFrom || filter.dateTo);
  return (
    <div className="flex items-center gap-1">
      <span className="text-slate-500">{ko.runFilter.dateLabel}:</span>
      <div className="w-fit">
        <Select
          compact
          aria-label={ko.runFilter.dateLabel}
          value={isCustom ? "custom" : filter.datePreset}
          onChange={(e) => {
            if (e.target.value === "custom") return;
            onChange({
              ...filter,
              datePreset: e.target.value as DatePreset,
              dateFrom: null,
              dateTo: null,
            });
          }}
        >
          {isCustom && <option value="custom">{ko.runFilter.dateCustom}</option>}
          {DATE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {DATE_LABEL[p]}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-fit">
        <Input
          compact
          type="date"
          aria-label={ko.runFilter.dateFromAria}
          value={filter.dateFrom ?? ""}
          onChange={(e) => onChange({ ...filter, dateFrom: e.target.value || null })}
        />
      </div>
      <span className="text-slate-400">~</span>
      <div className="w-fit">
        <Input
          compact
          type="date"
          aria-label={ko.runFilter.dateToAria}
          value={filter.dateTo ?? ""}
          onChange={(e) => onChange({ ...filter, dateTo: e.target.value || null })}
        />
      </div>
    </div>
  );
}
```

**이주 금지(동결, R7)**: 정렬 pill 내부 `bg-transparent` select·필터 칩(`aria-pressed` 버튼)·리셋/`+ 추가` 버튼 — 이 스텝에서 건드리지 않는다.

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test RunListControls`
Expected: 기존 + 신규 전부 PASS (기존 `selectOptions`/필터 emit 단언이 무수정 GREEN = 동작 byte-identical 증거).

Run: `cd ui && pnpm test ScenarioRunsPage`
Expected: 전부 PASS (툴바 소비 페이지 생존).

- [ ] **Step 5: 커밋** (단일 blocking):

```bash
git add ui/src/components/__tests__/RunListControls.test.tsx ui/src/components/RunListControls.tsx
git commit -m "feat(ui): RunListControls 날짜 컨트롤 디자인시스템 해동 — Select/Input compact 이주 (5차 R5)"
```

---

### Task 4: Inspector 통합 — InspectorSection 삭제 + 카드 fieldset 2곳 Section화 (R6)

**Files:**
- Test: `ui/src/components/scenario/__tests__/Inspector.sections.test.tsx` (append)
- Modify: `ui/src/components/scenario/Inspector.tsx`

**Interfaces:**
- Consumes: Task 2의 `Section variant="card"`(+`aria-label`).
- Produces: 없음 (leaf 채택처). `InspectorSection` 심볼 소멸.

- [ ] **Step 1: 구조 락 테스트 작성** — `ui/src/components/scenario/__tests__/Inspector.sections.test.tsx` 파일 끝에 append. **주의: 이 테스트들은 스왑 전에도 GREEN이다**(byte-identical 이주라 관측 가능한 차이가 없음) — 목적은 ① tdd-guard unblock(pending test 파일), ② 스왑의 최빈 실수(카드 경로 대신 기본 variant 사용 → `mt-2` 래퍼·`mb-4` 유입)를 잡는 회귀 락. 기존 `loadRich`/`SECTION_TITLES`/import 재사용:

```tsx
describe("Inspector 카드 fieldset — Section variant=card 통합 락 (디자인시스템 5차 R6)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadRich();
  });

  it("요청 카드: 카드 fieldset 클래스 + legend 제목 유지", () => {
    render(<Inspector />);
    const fieldset = screen.getByLabelText(ko.editor.urlLabel).closest("fieldset")!;
    expect(fieldset).toHaveClass("min-w-0", "border", "border-slate-200", "rounded", "p-3");
    expect(fieldset.querySelector("legend")!).toHaveTextContent(ko.editor.requestLegend);
  });

  it("접이식 섹션: 펼쳐도 mt-2 본문 래퍼가 없다 (카드 경로 사용 증거)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const btn = screen.getByRole("button", { name: ko.editor.assertionsLegend });
    await user.click(btn);
    const fieldset = btn.closest("fieldset")!;
    expect(fieldset).not.toHaveClass("mb-4");
    expect(fieldset.querySelector(":scope > div.mt-2")).toBeNull();
  });
});
```

- [ ] **Step 2: 사전 GREEN 확인** (위 명시대로 스왑 전에도 GREEN이어야 정상)

Run: `cd ui && pnpm test Inspector.sections`
Expected: 기존 + 신규 전부 PASS.

- [ ] **Step 3: `Inspector.tsx` 통합** — 편집 4종:

① import 추가 (기존 `import { Textarea } from "../ui/Textarea";` 옆):

```tsx
import { Section } from "../ui/Section";
```

② **`InspectorSection` 함수 정의(≈173–197행) 통째 삭제.**

③ 접이식 5섹션 호출부(headers·body·timing·assert·extract)의 여는 태그를 `<InspectorSection` → `<Section variant="card" collapsible`로, 닫는 태그를 `</InspectorSection>` → `</Section>`으로 교체. props(title/hint/open/onToggle)는 그대로. 예시 — headers 섹션 (나머지 4곳 동일 패턴):

```tsx
      <Section
        variant="card"
        collapsible
        title={ko.editor.headersLabel}
        hint={headerCount > 0 ? ko.editor.sectionCountHint(headerCount) : null}
        open={sectionPrefs.headers}
        onToggle={() => onToggleSection("headers")}
      >
        <HeadersEditor step={step} />
      </Section>
```

④ 비접이 카드 2곳 교체 — 요청 카드(≈316행):

```tsx
      <Section variant="card" title={ko.editor.requestLegend}>
        {/* 기존 children(VarCheatSheet 행·method/url Field·url 경고) 전부 그대로 */}
      </Section>
```

(위 주석은 설명용 — 실제 편집은 여는 `<fieldset className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3">`+`<legend …>{ko.editor.requestLegend}</legend>` 2요소를 `<Section variant="card" title={ko.editor.requestLegend}>` 한 줄로, 닫는 `</fieldset>`을 `</Section>`으로 바꾸고 내부 children은 무수정.)

조건 카드(≈1439행):

```tsx
      <Section
        variant="card"
        title={ko.editor.conditionLegend}
        aria-label={ko.editor.conditionLegend}
      >
        <ConditionEditor cond={step.cond} onCommit={(c) => setIfCond(step.id, c)} />
      </Section>
```

**동결(R7 — 건드리지 않는다)**: elif 카드(≈1459행 — legend 안 삭제 `×` 버튼 bespoke)·Inspector 내 `<div>` 카드(≈940행)·`ScenarioDefaults.tsx`.

- [ ] **Step 4: GREEN 확인 (무수정 GREEN = byte-identical 1차 증거, R8)**

Run: `cd ui && pnpm test Inspector`
Expected: `Inspector.test.tsx`·`Inspector.sections.test.tsx` 전부 PASS — 특히 섹션 토글 accname 정확매치·`closest("legend").textContent` hint·`min-w-0` 클래스·`getByRole("group",{name:"값 추출"})` 단언 무수정 GREEN.

Run: `cd ui && pnpm test EditorShell`
Expected: PASS (에디터 셸 통합 생존).

- [ ] **Step 5: 완성도 grep (스스로 확인 — orchestrator가 최종 단계에서 재실행한다)**

Run: `grep -rn "function InspectorSection\|<InspectorSection" ui/src`
Expected: **0건** (테스트 describe 문자열·주석의 `InspectorSection` 언급은 게이트 밖 — 개명 금지).

Run: `grep -c 'aria-label={ko.editor.conditionLegend}' ui/src/components/scenario/Inspector.tsx`
Expected: **1** (Section 호출부에 passthrough 유지).

- [ ] **Step 6: 전체 UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS (lint 경고 0, `tsc -b` 클린 — 삭제된 `InspectorSection` 잔존 참조가 있으면 여기서 터진다).

- [ ] **Step 7: 커밋** (단일 blocking):

```bash
git add ui/src/components/scenario/__tests__/Inspector.sections.test.tsx ui/src/components/scenario/Inspector.tsx
git commit -m "refactor(ui): Inspector InspectorSection→Section variant=card 통합 — 접이식 5섹션+요청/조건 카드 (5차 R6)"
```

---

## 최종 단계 (orchestrator — task 아님)

1. **최종 리뷰**: `handicap-reviewer` APPROVE (1M 세션이면 명시 `model: opus`). 중점: 기본 variant 클래스 집합 불변(R2)·카드 표 리터럴 계약(spec §4.2)·동결 사이트 무접촉(R7)·`runFilterSort.ts` 0-diff(R9). finish-slice §0 보안 게이트 grep — UI 표시-only diff라 무매치 예상이나 **grep이 지배, 예측 스킵 금지**.
2. **완성도 게이트 직접 재실행 (spec §6.3 + R9·R11)**: ① `grep -rn "function InspectorSection\|<InspectorSection" ui/src` → 0 ② RunListControls에서 `py-0\.5` raw `<select`/`<input` 잔존이 동결 명시(투명 select)만인지 ③ R7 동결 사이트 라인 무변경 diff ④ **R9**: `git diff --name-only master..HEAD`가 `ui/src/components/**`(+`__tests__`)·`docs/**`뿐인지(특히 `ui/src/api/**`·`ui/src/runs/**`·`ui/src/scenario/**`·`crates/**` 부재) ⑤ **R11**: production diff(테스트 파일 제외 — 신규 테스트의 단언용 한글 리터럴["판정·고급"·"3개 설정됨" 등]은 대상 아님)에 신규 하드코딩 한글 0·신규 `blue-*`/`indigo-*` 리터럴 0 — python sweep(`'"[가-힣]'` grep의 비한글-선두 누락 함정 회피): `git diff master..HEAD -- ':(glob)ui/src/components/**' ':(exclude,glob)ui/src/components/**/__tests__/**'`의 `+` 줄 대상(**`:(glob)` magic 필수** — default magic은 `/**/`가 0-디렉토리를 못 매치해 `components/__tests__/` 직속이 exclude에서 샌다, 리뷰어 실측).
3. **라이브 검증 (spec §6.2, `/live-verify`)**: `just ui-build` + `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 워크트리 상대경로 `./target/debug/controller --db /tmp/ds5.db --ui-dir ui/dist`. Playwright `browser_evaluate`로 computed-style 실측: ① run 목록 툴바 select/date input — `borderRadius` 6px·`borderColor` rgb(203,213,225)·`paddingTop/Bottom` 2px·`fontSize` 14px·`backgroundColor`(흰색 유지 — bg-white 제거 검증)·focus 후 `boxShadow`에 rgba(99,102,241,0.3) ② 에디터 Inspector — 카드 `borderRadius` 4px·`padding` 12px·legend `fontSize` 12px ③ RunDialog 판정·고급 접힘 토글 스크린샷(R4 hint 시각 무변화) ④ 전/후 스크린샷(run 목록·Inspector). RunDialog 진입은 `/scenarios/{id}/runs`의 `실행하기` 버튼(에디터 아님).
4. **finish**: `/finish-slice` — build-log·roadmap-status(§B12 frontier 전진: 컴팩트/카드 variant 완료)·roadmap §B12 연기 항목 갱신(해동 2건 완료 표시 + 신규 연기: 폼 카드 지오메트리·elif legend)·CLAUDE 상태줄·메모리 → ff-merge → ExitWorktree.
