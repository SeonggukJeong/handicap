# RunDialog 디자인 시스템 + 초보자 친화 재구성 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog의 4중 초보자 pain(정보 과부하·전문 용어·안내 부재·시각 평탄)을, 재사용 디자인 토대(시맨틱 토큰 + 6 프리미티브)를 세우고 그 위에 RunDialog를 **동작 byte-identical**로 재구성해 해소한다.

**Architecture:** 2단계. **Phase A(파운데이션)** — `tailwind.config.ts`에 `accent`(=indigo) 토큰 + `ui/src/components/ui/`에 Field/Input/Select/Section/Callout/Badge 프리미티브(각 단위 테스트) + 공유 `Button.primary`를 accent로. RunDialog 무위험·독립 검증. **Phase B(소비)** — RunDialog와 공유 `LoadModelFields`의 마크업만 프리미티브로 교체(로직·페이로드·검증 0-diff), 번호 섹션·추천 프레이밍·duration HelpTip·Callout. `ScheduleForm`은 입력 룩만 상속.

**Tech Stack:** Vite + React 18 + TypeScript(strict) + Tailwind 3.4 + vitest/RTL(jsdom). 게이트: `pnpm lint && pnpm test && pnpm build`(cargo 무관 — UI-only).

## Global Constraints

(spec `2026-06-27-rundialog-design-system-design.md`의 normative 요구사항 — 모든 task에 암묵 적용)

- **R4/R10/R14 byte-identical(불변식):** `buildProfile()` 출력·`loadModelErrors`/`canSubmit`/`*Invalid` 게이트·cross-field 효과·`profileForm.ts`/`loadModel.ts`/`sizing.ts`/`openLoopChecks.ts` 로직·`ui/src/api/schemas.ts`·백엔드·proto·migration **0-diff**. diff는 `ui/`(+`tailwind.config.ts`)·`docs/`만.
- **R10:** `LoadModelFields`/`ScheduleForm` 동작 byte-identical. ScheduleForm은 추천/"바로 실행" 프레이밍 **미렌더**(R6 게이트).
- **R12 (ADR-0035):** 모든 사용자 노출 문구(라벨·배지·안내·`aria-label`)는 `ko.ts` 경유. 인라인 영어/하드코딩 한국어 0.
- **accent 토큰:** `accent-*` = indigo(`accent-600`=`#4f46e5`). 차트 stroke `#2563eb`·`StageCurvePreview` 곡선선·`runLabel.ts` 팔레트·`StatusBadge` running은 **데이터-식별 색 도메인 → 0-diff**.
- **테스트 셀렉터 lockstep:** 라벨/role/aria를 바꾸면 그 RTL 테스트를 같은 task에서 수정. 은퇴 라벨은 *부재* 단언 금지 → *살아있는 라벨의 유일성*으로(`getAllByRole(...).toHaveLength(1)`). (ui/CLAUDE.md editor-ux-polish 함정)
- **tdd-guard:** `ui/src/**`(non-test) 편집 전 pending test 파일 필요 → 각 task는 **테스트 파일을 먼저** 작성(RED)한 뒤 src. (`ui/tailwind.config.ts`는 `ui/src` 밖이라 가드 무관.)
- **green-fold:** UI 게이트가 `pnpm test`를 돌리므로 **RED 커밋 금지** — 각 task는 테스트+구현을 한 GREEN 커밋으로.
- **커밋:** 파이프(`| tail`) 없이. `git -C` 불필요(워크트리 안에서 작업). subagent commit은 `run_in_background:false` 단일 호출.

---

# Phase A — 파운데이션 (RunDialog 무위험)

### Task A1: accent 토큰 (tailwind.config.ts)

**Files:**
- Modify: `ui/tailwind.config.ts`

**Interfaces:**
- Produces: Tailwind 유틸 `accent-{50..950}`(=indigo). 이후 모든 프리미티브·Button이 `bg-accent-600`/`text-accent-700`/`border-accent-500`/`ring-accent-500`/`bg-accent-50` 사용.

- [ ] **Step 1: 토큰 추가** — `theme.extend.colors.accent`를 indigo 스케일로 별칭.

```ts
import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

// Offline-runtime constraint: do not add font family overrides that reference
// remote URLs (e.g. Google Fonts). Bundle locally via @fontsource/* if needed.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // 시맨틱 디자인 토큰 (ADR-0043). accent = 앱 액센트(indigo). neutral(slate)·
      // semantic(amber/red/green)은 Tailwind 기본을 직접 사용(별칭 불필요).
      colors: { accent: colors.indigo },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 2: 빌드로 토큰 컴파일 확인**

Run: `cd ui && pnpm build`
Expected: 빌드 성공(타입/컴파일 에러 0). (`accent-*` 유틸은 다음 task에서 소비될 때 CSS에 포함 — 단독 빌드는 트리셰이크라 무해.)

- [ ] **Step 3: Commit**

```bash
git add ui/tailwind.config.ts
git commit -m "feat(ui-ds): accent 시맨틱 토큰(=indigo) — 디자인 시스템 토대 (ADR-0043)"
```

---

### Task A2: Input · Select 프리미티브

**Files:**
- Create: `ui/src/components/ui/Input.tsx`, `ui/src/components/ui/Select.tsx`
- Test: `ui/src/components/ui/__tests__/Input.test.tsx`

**Interfaces:**
- Produces:
  - `Input: React.ForwardRefExoticComponent<InputHTMLAttributes<HTMLInputElement> & RefAttributes<HTMLInputElement>>`
  - `Select: React.ForwardRefExoticComponent<SelectHTMLAttributes<HTMLSelectElement> & RefAttributes<HTMLSelectElement>>`
  - 둘 다 토큰화된 base 클래스 + 호출자 `className` 병합. `aria-invalid="true"`면 red 테두리/링. 모든 표준 HTML 속성·`id`/`aria-*` 패스스루.

- [ ] **Step 1: 테스트 작성 (RED)** — `ui/src/components/ui/__tests__/Input.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Input } from "../Input";
import { Select } from "../Select";

describe("Input/Select primitives", () => {
  it("Input은 base 토큰 클래스 + 호출자 className을 병합한다", () => {
    render(<Input aria-label="x" className="w-48" />);
    const el = screen.getByLabelText("x");
    expect(el.tagName).toBe("INPUT");
    expect(el.className).toContain("w-48");
    expect(el.className).toContain("rounded-md");
  });

  it("Input은 id/표준 속성을 패스스루한다", () => {
    render(<Input id="vu" aria-invalid="true" defaultValue="2" aria-label="vu" />);
    const el = screen.getByLabelText("vu") as HTMLInputElement;
    expect(el.id).toBe("vu");
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(el.value).toBe("2");
  });

  it("Select는 옵션을 렌더하고 className을 병합한다", () => {
    render(
      <Select aria-label="mode" className="text-sm">
        <option value="a">A</option>
      </Select>,
    );
    const el = screen.getByLabelText("mode");
    expect(el.tagName).toBe("SELECT");
    expect(el.className).toContain("rounded-md");
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test ui/__tests__/Input`  Expected: FAIL("Cannot find module ../Input").

- [ ] **Step 3: 구현** — `ui/src/components/ui/Input.tsx`

```tsx
import { forwardRef, type InputHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-400/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={`${BASE} ${className ?? ""}`} {...rest} />;
  },
);
```

`ui/src/components/ui/Select.tsx`:

```tsx
import { forwardRef, type SelectHTMLAttributes } from "react";

const BASE =
  "block w-full rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 " +
  "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 " +
  "disabled:bg-slate-50 disabled:text-slate-400";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={`${BASE} ${className ?? ""}`} {...rest}>
        {children}
      </select>
    );
  },
);
```

- [ ] **Step 4: GREEN 확인** — Run: `cd ui && pnpm test ui/__tests__/Input`  Expected: PASS(3).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ui/Input.tsx ui/src/components/ui/Select.tsx ui/src/components/ui/__tests__/Input.test.tsx
git commit -m "feat(ui-ds): Input·Select 프리미티브(토큰 포커스 링·aria-invalid)"
```

---

### Task A3: Badge 프리미티브

**Files:**
- Create: `ui/src/components/ui/Badge.tsx`
- Test: `ui/src/components/ui/__tests__/Badge.test.tsx`

**Interfaces:**
- Produces: `Badge({ tone?, children }): JSX.Element` — `tone: "neutral"|"accent"|"required"|"optional"|"warn"`(기본 `neutral`). 색 단독 금지 → 항상 텍스트 children 동반(R15). 텍스트(`children`)는 호출자가 ko로 전달.

- [ ] **Step 1: 테스트 (RED)** — `ui/src/components/ui/__tests__/Badge.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Badge } from "../Badge";

describe("Badge", () => {
  it("텍스트를 렌더하고 tone 클래스를 적용한다", () => {
    render(<Badge tone="accent">추천</Badge>);
    const el = screen.getByText("추천");
    expect(el.className).toContain("bg-accent-50");
  });
  it("기본 tone은 neutral", () => {
    render(<Badge>선택</Badge>);
    expect(screen.getByText("선택").className).toContain("bg-slate-100");
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test ui/__tests__/Badge`  Expected: FAIL.

- [ ] **Step 3: 구현** — `ui/src/components/ui/Badge.tsx`

```tsx
import type { ReactNode } from "react";

const TONES = {
  neutral: "bg-slate-100 text-slate-600",
  accent: "bg-accent-50 text-accent-700",
  required: "bg-slate-800 text-white",
  optional: "bg-slate-100 text-slate-500",
  warn: "bg-amber-100 text-amber-800",
} as const;

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 4: GREEN** — Run: `cd ui && pnpm test ui/__tests__/Badge`  Expected: PASS(2).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ui/Badge.tsx ui/src/components/ui/__tests__/Badge.test.tsx
git commit -m "feat(ui-ds): Badge 프리미티브(tone 5종·색+텍스트)"
```

---

### Task A4: Callout 프리미티브

**Files:**
- Create: `ui/src/components/ui/Callout.tsx`
- Test: `ui/src/components/ui/__tests__/Callout.test.tsx`

**Interfaces:**
- Produces: `Callout({ variant?, role?, title?, className?, children }): JSX.Element` — `variant: "info"|"warn"|"error"`(기본 `info`). `role`은 **호출자가 지정**(alert/status/alertdialog 보존 — Callout이 강제하지 않음). `title`은 선택 헤더(`font-medium`).

- [ ] **Step 1: 테스트 (RED)** — `ui/src/components/ui/__tests__/Callout.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Callout } from "../Callout";

describe("Callout", () => {
  it("호출자가 지정한 role을 그대로 단다", () => {
    render(<Callout variant="warn" role="status">경고</Callout>);
    const el = screen.getByRole("status");
    expect(el.textContent).toContain("경고");
    expect(el.className).toContain("bg-amber-50");
  });
  it("role 미지정이면 roleless", () => {
    const { container } = render(<Callout variant="error">오류</Callout>);
    expect(container.querySelector("[role]")).toBeNull();
    expect(screen.getByText("오류").closest("div")!.className).toContain("bg-red-50");
  });
  it("title을 헤더로 렌더한다", () => {
    render(<Callout variant="warn" role="status" title="제목">본문</Callout>);
    expect(screen.getByText("제목").className).toContain("font-medium");
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test ui/__tests__/Callout`  Expected: FAIL.

- [ ] **Step 3: 구현** — `ui/src/components/ui/Callout.tsx`

```tsx
import type { ReactNode } from "react";

const VARIANTS = {
  info: "border-accent-200 bg-accent-50 text-accent-800",
  warn: "border-amber-300 bg-amber-50 text-amber-800",
  error: "border-red-200 bg-red-50 text-red-700",
} as const;

export function Callout({
  variant = "info",
  role,
  title,
  className,
  children,
}: {
  variant?: keyof typeof VARIANTS;
  role?: string;
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role={role} className={`rounded-md border p-2 text-sm ${VARIANTS[variant]} ${className ?? ""}`}>
      {title != null && <p className="mb-1 font-medium">{title}</p>}
      {children}
    </div>
  );
}
```

- [ ] **Step 4: GREEN** — Run: `cd ui && pnpm test ui/__tests__/Callout`  Expected: PASS(3).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ui/Callout.tsx ui/src/components/ui/__tests__/Callout.test.tsx
git commit -m "feat(ui-ds): Callout 프리미티브(info/warn/error·role 호출자 지정)"
```

---

### Task A5: Field 프리미티브

**Files:**
- Create: `ui/src/components/ui/Field.tsx`
- Test: `ui/src/components/ui/__tests__/Field.test.tsx`

**Interfaces:**
- Produces: `Field(props): JSX.Element` (순수 레이아웃 래퍼 — id/aria/에러는 **호출자 소유**, 외부 에러 id 보존을 위해)

```ts
type FieldProps = {
  label: ReactNode;
  htmlFor: string;            // 컨트롤의 id (label↔control 연결)
  recommended?: ReactNode;    // 있으면 라벨 옆 <Badge tone="accent"> (호출자가 ko 텍스트 전달)
  help?: ReactNode;           // 있으면 라벨 옆 <HelpTip> (호출자가 구성)
  hint?: ReactNode;           // 컨트롤 아래 보조 텍스트(text-xs slate)
  error?: ReactNode;          // 인라인 에러(단일 입력 편의용)
  errorId?: string;           // error <p>의 id (컨트롤 aria-describedby가 참조)
  children: ReactNode;        // 컨트롤 — 호출자가 id={htmlFor}+aria-* 배선
};
```
- **계약(R11):** Field는 컨트롤(children)에 aria를 *주입하지 않는다*. 호출자가 `id={htmlFor}`·`aria-invalid`·`aria-describedby`를 직접 단다. 그래서 think-time min/max가 공유하는 단일 외부 `<p id="think-time-error">` 같은 케이스는 호출자가 `error`를 안 넘기고 외부 `<p>`를 유지하면 그대로 보존된다.
- **계약(accname 오염 금지, U3):** `recommended` Badge와 `help` HelpTip은 `<label htmlFor>` *밖*(헤더 행의 형제)에 렌더한다 — `<label htmlFor>` 안에 넣으면 그 텍스트가 연결된 컨트롤의 accessible name에 합쳐져(예: "VU 추천 ?") 스크린리더·exact `getByLabelText` 셀렉터를 깬다. `<label>`은 텍스트만.

- [ ] **Step 1: 테스트 (RED)** — `ui/src/components/ui/__tests__/Field.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Field } from "../Field";
import { Input } from "../Input";

describe("Field", () => {
  it("label↔control을 htmlFor로 연결해 getByLabelText가 해소된다", () => {
    render(
      <Field label="동시 사용자(VU)" htmlFor="vu">
        <Input id="vu" defaultValue="2" />
      </Field>,
    );
    const el = screen.getByLabelText("동시 사용자(VU)") as HTMLInputElement;
    expect(el.value).toBe("2");
  });
  it("recommended Badge·help·hint를 렌더하되 accname을 오염시키지 않는다 (U3)", () => {
    render(
      <Field
        label="VU"
        htmlFor="v"
        recommended="추천 2"
        help={<span>도움말</span>}
        hint="이 값으로 바로 실행해도 됩니다"
      >
        <Input id="v" />
      </Field>,
    );
    expect(screen.getByText("추천 2")).toBeInTheDocument();
    expect(screen.getByText("이 값으로 바로 실행해도 됩니다")).toBeInTheDocument();
    // Badge/help가 <label> 밖이라 컨트롤 accname은 정확히 라벨 텍스트("VU")만 — exact 매치 성공
    // (오염됐으면 "VU 추천 도움말"이 되어 exact "VU"가 throw). teeth: Field가 help/badge를
    // label 안에 넣으면 이 줄이 FAIL.
    expect(screen.getByLabelText("VU")).toBeInTheDocument();
  });
  it("error/errorId를 외부 컨트롤과 연결 가능하게 렌더한다", () => {
    render(
      <Field label="타임아웃" htmlFor="t" error="범위 밖" errorId="t-err">
        <Input id="t" aria-invalid="true" aria-describedby="t-err" />
      </Field>,
    );
    const err = screen.getByText("범위 밖");
    expect(err.id).toBe("t-err");
    expect(screen.getByLabelText("타임아웃").getAttribute("aria-describedby")).toBe("t-err");
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test ui/__tests__/Field`  Expected: FAIL.

- [ ] **Step 3: 구현** — `ui/src/components/ui/Field.tsx`

```tsx
import type { ReactNode } from "react";
import { Badge } from "./Badge";

export function Field({
  label,
  htmlFor,
  recommended,
  help,
  hint,
  error,
  errorId,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  recommended?: ReactNode;
  help?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      {/* Badge/HelpTip은 <label htmlFor> *밖* 형제 — label 안에 넣으면 컨트롤 accname 오염(U3). */}
      <div className="mb-1 flex items-center gap-1.5 text-sm text-slate-700">
        <label htmlFor={htmlFor}>{label}</label>
        {recommended != null && <Badge tone="accent">{recommended}</Badge>}
        {help}
      </div>
      {children}
      {hint != null && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error != null && (
        <p id={errorId} className="mt-1 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: GREEN** — Run: `cd ui && pnpm test ui/__tests__/Field`  Expected: PASS(3).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ui/Field.tsx ui/src/components/ui/__tests__/Field.test.tsx
git commit -m "feat(ui-ds): Field 프리미티브(label↔control·추천 Badge·외부 errorId 보존)"
```

---

### Task A6: Section 프리미티브

**Files:**
- Create: `ui/src/components/ui/Section.tsx`
- Test: `ui/src/components/ui/__tests__/Section.test.tsx`

**Interfaces:**
- Produces: `Section(props): JSX.Element`

```ts
type SectionProps = {
  index?: number;            // 번호 배지 (1,2,3…)
  title: ReactNode;
  badge?: ReactNode;         // 필수/선택 — 호출자가 <Badge>{ko}</Badge> 전달(ko 분리)
  help?: ReactNode;          // 제목 옆 <HelpTip>
  divider?: boolean;         // 위쪽 구분선(border-t). 첫 섹션은 false (기존 group1=구분선 없음)
  collapsible?: boolean;
  open?: boolean;            // collapsible일 때만 의미
  onToggle?: () => void;
  hint?: ReactNode;          // 접힘 시 제목 옆 힌트(예: "3개 설정됨")
  children?: ReactNode;
};
```
- **계약(R5):** non-collapsible(`collapsible` 미전달)이면 항상 children 렌더. collapsible이면 `<button aria-expanded={open}>`로 토글, `open===false`면 children 미렌더 + `hint` 노출. `<fieldset><legend>` 구조 유지(기존 RunDialog 그룹과 동형). `divider`는 위쪽 구분선 — RunDialog가 group2/3에만 전달(group1=구분선 없음, 기존 시각 보존). `first:border-t-0`는 Section이 DOM 첫 자식이 아니라 안 먹으니 **쓰지 않는다**.

- [ ] **Step 1: 테스트 (RED)** — `ui/src/components/ui/__tests__/Section.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Section } from "../Section";

describe("Section", () => {
  it("번호·제목·badge를 렌더하고 non-collapsible이면 children을 항상 보인다", () => {
    render(
      <Section index={1} title="부하 정의" badge={<span>필수</span>}>
        <input aria-label="vu" />
      </Section>,
    );
    expect(screen.getByText("부하 정의")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByLabelText("vu")).toBeInTheDocument();
  });

  it("collapsible: open=false면 children 미렌더 + hint 노출, 토글 호출", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <Section title="판정·고급" collapsible open={false} onToggle={onToggle} hint="3개 설정됨">
        <input aria-label="slo" />
      </Section>,
    );
    expect(screen.queryByLabelText("slo")).not.toBeInTheDocument();
    expect(screen.getByText("3개 설정됨")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /판정·고급/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <Section title="판정·고급" collapsible open onToggle={onToggle} hint="3개 설정됨">
        <input aria-label="slo" />
      </Section>,
    );
    expect(screen.getByLabelText("slo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /판정·고급/ }).getAttribute("aria-expanded")).toBe("true");
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test ui/__tests__/Section`  Expected: FAIL.

- [ ] **Step 3: 구현** — `ui/src/components/ui/Section.tsx`

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
  children?: ReactNode;
}) {
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
    <fieldset className={`mb-4 ${divider ? "border-t border-slate-200 pt-3" : ""}`}>
      <legend className="text-sm font-medium">
        {collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex items-center gap-2 text-slate-700 hover:underline"
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            {titleRow}
            {!open && hint != null ? (
              <span className="text-xs font-normal text-slate-500">{hint}</span>
            ) : null}
          </button>
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
(주: collapsible 헤더의 `help`는 RunDialog 그룹3엔 불필요 — non-collapsible 분기에만 배치. 필요 시 호출자가 children 안에서 HelpTip 사용.)

- [ ] **Step 4: GREEN** — Run: `cd ui && pnpm test ui/__tests__/Section`  Expected: PASS(2).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ui/Section.tsx ui/src/components/ui/__tests__/Section.test.tsx
git commit -m "feat(ui-ds): Section 프리미티브(번호 배지·필수/선택 슬롯·접힘 aria-expanded)"
```

---

### Task A7: Button accent 전환 + Button.test (신규)

**Files:**
- Modify: `ui/src/components/Button.tsx:9`
- Test: `ui/src/components/__tests__/Button.test.tsx` (신규 — 현재 없음)

**Interfaces:**
- Consumes: A1 `accent` 토큰.
- Produces: `Button` 시그니처 무변경. `primary` variant만 accent로.

- [ ] **Step 1: 테스트 (RED)** — `ui/src/components/__tests__/Button.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Button } from "../Button";

describe("Button", () => {
  it("primary는 accent 배경(앱 전역 액센트)", () => {
    render(<Button>실행</Button>);
    expect(screen.getByRole("button", { name: "실행" }).className).toContain("bg-accent-600");
  });
  it("secondary는 흰 배경·테두리 유지(0-diff)", () => {
    render(<Button variant="secondary">취소</Button>);
    const c = screen.getByRole("button", { name: "취소" }).className;
    expect(c).toContain("bg-white");
    expect(c).toContain("border-slate-300");
  });
  it("danger는 red 유지(0-diff)", () => {
    render(<Button variant="danger">삭제</Button>);
    expect(screen.getByRole("button", { name: "삭제" }).className).toContain("bg-red-600");
  });
});
```

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test Button`  Expected: FAIL("primary는 accent" — 현재 `bg-slate-900`).

- [ ] **Step 3: 구현** — `ui/src/components/Button.tsx`의 `STYLES.primary`만 교체:

```tsx
const STYLES: Record<NonNullable<Props["variant"]>, string> = {
  primary: "bg-accent-600 text-white hover:bg-accent-700 disabled:bg-accent-300",
  secondary:
    "bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300",
};
```
(`secondary`/`danger`/레이아웃 클래스/시그니처는 **건드리지 않는다** — R3.)

- [ ] **Step 4: GREEN** — Run: `cd ui && pnpm test Button`  Expected: PASS(3).

- [ ] **Step 5: 전체 게이트 (Phase A 종료)** — Run: `cd ui && pnpm lint && pnpm test && pnpm build`  Expected: 전부 GREEN(기존 테스트 회귀 0 — primary 버튼 색만 시각 변경).

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/Button.tsx ui/src/components/__tests__/Button.test.tsx
git commit -m "feat(ui-ds): Button primary→accent (앱 전역 액센트 통일) + Button.test 신규"
```

---

# Phase B — 소비 (byte-identical · lockstep)

> **Phase B 공통 안전 규율:** RunDialog/LoadModelFields는 **JSX 마크업만** 교체한다. `useState`/핸들러/`buildProfile`/`loadState`/`canSubmit`/`loadModelErrors`/cross-field 효과는 **단 한 줄도 바꾸지 않는다**. 각 task 끝에 `cd ui && pnpm test RunDialog && pnpm test LoadModelFields && pnpm test ScheduleForm`로 회귀 0 확인. 마크업 교체로 라벨/role/aria가 바뀌면 그 테스트만 lockstep 수정(로직 단언은 불변).

### Task B1: RunDialog 3그룹 → Section 프리미티브 (구조)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` (`:511-544` 그룹1, `:583-602` 그룹2, `:604-749` 그룹3 `<fieldset><legend>`)
- Modify: `ui/src/i18n/ko.ts` (`ko.runDialog` 섹션 라벨 + `ko.common` 필수/선택)
- Modify: `ui/src/components/__tests__/RunDialog.test.tsx` (lockstep)

**Interfaces:**
- Consumes: `Section`(A6), `Badge`(A3).
- Produces: RunDialog 3섹션이 `<Section>`으로 렌더. 그룹3 접힘 동작·`advancedActiveCount` 힌트·자동 펼침 보존.

- [ ] **Step 1: 테스트 먼저(lockstep RED)** — `RunDialog.test.tsx`에 섹션 구조 단언 추가/수정 (tdd-guard: src/ko 편집 *전*에 pending test 생성):

```tsx
it("3개 번호 섹션 + 필수/선택 배지로 렌더한다", () => {
  renderRunDialog(); // 기존 헬퍼
  expect(screen.getByText("부하 정의")).toBeInTheDocument();
  expect(screen.getByText("대상 설정")).toBeInTheDocument();
  // 필수/선택 배지 (Badge 텍스트)
  expect(screen.getAllByText("필수").length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByText("선택").length).toBeGreaterThanOrEqual(1);
});
```
기존 `groupAdvanced` 텍스트("판정·고급 (선택)")를 셀렉트하던 테스트가 있으면 `{ name: /판정·고급/ }` 정규식으로 유지(배지로 "(선택)" 분리되어도 매치).

- [ ] **Step 2: ko 키 추가** — `ui/src/i18n/ko.ts`. `ko.runDialog`에:

```ts
    sectionLoadTitle: "부하 정의",
    sectionTargetTitle: "대상 설정",
    // groupAdvanced(기존 "판정·고급 (선택)")는 배지로 "(선택)" 이관 → 새 키:
    sectionAdvancedTitle: "판정·고급",
    advancedSetHint: (n: number) => `${n}개 설정됨`,   // 접힘 힌트 ko-route (R12)
```
`ko.common`에(없으면 블록 생성, 있으면 추가):

```ts
    required: "필수",
    optional: "선택",
```
(기존 `ko.runDialog.groupLoad`/`groupTarget`/`groupAdvanced`는 `grep -rn "runDialog.group" ui/src`로 소비처 확인. RunDialog뿐이면 새 키로 교체하고 구 키 제거, 아니면 잔존.)

- [ ] **Step 3: RED 확인** — Run: `cd ui && pnpm test RunDialog`  Expected: 새 단언 FAIL.

- [ ] **Step 4: 구현** — 3개 `<fieldset>`를 `<Section>`으로 교체.

그룹1(`:511`) `<fieldset className="mb-4"><legend>{ko.runDialog.groupLoad}</legend>…</fieldset>` →
```tsx
<Section
  index={1}
  title={ko.runDialog.sectionLoadTitle}
  badge={<Badge tone="required">{ko.common.required}</Badge>}
>  {/* group1은 divider 없음 — 기존 시각 보존 */}
  <LoadModelFields … />  {/* props 그대로 */}
</Section>
```
그룹2(`:584`) → `index={2}` · `divider` · `title={ko.runDialog.sectionTargetTitle}` · `badge={<Badge tone="optional">{ko.common.optional}</Badge>}`. 내부 `<EnvironmentPicker>`+`<DataBindingPanel>` 그대로.

그룹3(`:605`) 접힘 그룹 → `collapsible`(R5: **`index={3}` 포함**):
```tsx
<Section
  index={3}
  divider
  title={ko.runDialog.sectionAdvancedTitle}
  badge={<Badge tone="optional">{ko.common.optional}</Badge>}
  collapsible
  open={advancedOpen}
  onToggle={() => setAdvancedOpen((v) => !v)}
  hint={advancedActiveCount > 0 ? ko.runDialog.advancedSetHint(advancedActiveCount) : undefined}
>
  {/* 기존 advancedOpen && (<>…</>) 내부 JSX 그대로 — Section이 open 게이트를 소유하므로
      바깥 advancedOpen && 조건은 제거하고 children을 그대로 둔다 */}
</Section>
```
**주의:** 기존 `{advancedOpen && (…)}` 게이트는 Section의 `open` 게이트로 이관 → 이중 게이트 금지(children에서 `advancedOpen &&` 제거). `advancedActiveCount`·`setAdvancedOpen`·자동 펼침 `useState` 로직은 **불변**.

- [ ] **Step 5: GREEN + 회귀** — Run: `cd ui && pnpm test RunDialog`  Expected: PASS(신규 + 기존 전부). 접힘 토글·"N개 설정됨"·자동 펼침 단언 통과.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(run-dialog): 3그룹→번호 Section 프리미티브(필수/선택 배지·접힘 보존)"
```

---

### Task B2: RunDialog ad-hoc 경고/오류 → Callout

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` (드리프트 `:474-481`, preset 오류 `:505-509`, blockedReasons `:804-818`, pool over-hint `:563-578`, mutation 오류 `:789-791`, capacity 다이얼로그 `:826-915`)
- Modify: `ui/src/components/__tests__/RunDialog.test.tsx` (lockstep)

**Interfaces:**
- Consumes: `Callout`(A4).
- Produces: 모든 경고/오류 박스가 `<Callout>`. **role 보존** — 드리프트=`alert`, preset 오류=`alert`(기존 `:506` 유지), blockedReasons=`status`, pool over-hint=`status`, capacity=`alertdialog`; **mutation 오류만 roleless→`alert` 신규 부여**(R8).

- [ ] **Step 1: 테스트 (lockstep)** — 기존 role 단언이 있으면 유지. mutation 오류 role=alert 신규 단언 추가:

```tsx
it("run 생성 mutation 오류를 role=alert Callout으로 보인다", async () => {
  // 기존 'createRun 실패' 시나리오 헬퍼 재사용 — mutation.error 세팅 후
  // expect(screen.getByRole("alert")) 안에 에러 메시지 포함
});
```
(기존 preset 오류/드리프트/capacity 다이얼로그 role 단언은 그대로 통과해야 함.) **주의(다중 alert):** mutation 오류가 `role="alert"`가 되면 드리프트·preset과 함께 최대 3개의 `role="alert"`가 공존 가능 — mutation 시나리오가 다른 alert와 겹치는 테스트면 `getByRole("alert")`(단수) 대신 메시지 텍스트로 스코프(`getByText(에러메시지)` 또는 `within`)할 것(ui/CLAUDE.md "같은 라벨 여럿" 함정).

- [ ] **Step 2: RED 확인** — Run: `cd ui && pnpm test RunDialog`  Expected: mutation role 단언 FAIL.

- [ ] **Step 3: 구현** — 각 박스를 `<Callout>`로. 예:

드리프트(`:474`):
```tsx
{scenarioChangedWarning && (
  <Callout variant="warn" role="alert" className="mb-3">
    이 시나리오는 이 run 이후 수정됨 — 설정이 안 맞을 수 있습니다.
  </Callout>
)}
```
preset 오류(`:505`): `<Callout variant="error" role="alert" className="mb-3">프리셋 오류: {presetError}</Callout>` (role=alert **유지**).
blockedReasons(`:804`): 바깥 `<div role="status" className="…amber…">`를 `<Callout variant="warn" role="status" className="mb-3" title={ko.runDialog.blockedReasonsIntro}>` + `<ul>` children.
pool over-hint(`:570`): `<Callout variant="warn" role="status">…</Callout>` (텍스트/조건 불변).
mutation 오류(`:789`): `<Callout variant="error" role="alert" className="mb-3">{(mutation.error as Error).message}</Callout>` — **role=alert 신규**. 조건 `!(mutation.error instanceof PoolCapacityError)` 불변.
capacity 다이얼로그(`:826`): 바깥 `<div role="alertdialog" aria-label=…>`를 `<Callout variant="warn" role="alertdialog" …>`로(내부 버튼/clamp/force 로직 **전부 불변** — `buildProfile`/`scaleVuStages`/`mutation.mutate` 그대로).

- [ ] **Step 4: GREEN + 회귀** — Run: `cd ui && pnpm test RunDialog`  Expected: PASS(신규 mutation alert + 기존 role/clamp/force 전부).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(run-dialog): ad-hoc 경고/오류→Callout(role 보존·mutation role=alert 신규)"
```

---

### Task B3: RunDialog 자체 입력 → Field/Input + 추천 안내 + blue→accent + ko

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` (think-time `:640-683`, http_timeout `:688-703`, loop_cap `:705-725`, preset 이름 입력 `:751-758`, preset/load 링크·`select` `:482-503`)
- Modify: `ui/src/i18n/ko.ts` (추천 안내 키)
- Modify: `ui/src/components/__tests__/RunDialog.test.tsx` (lockstep)

**Interfaces:**
- Consumes: `Field`(A5), `Input`(A2), `Select`(A2).
- Produces: RunDialog 자체 입력이 `Field`+`Input`/`Select`. **think-time min/max는 단일 외부 `<p id="think-time-error">` 공유 유지**(각 `Input`에 `aria-describedby="think-time-error"`·`aria-invalid={thinkInvalid}`, Field엔 `error` 미전달). 부하 섹션 상단에 추천 안내 한 줄.

- [ ] **Step 1: 테스트 (lockstep RED)** — 추천 안내 렌더 + think-time aria 보존 (tdd-guard: ko/src 편집 *전* pending test):
```tsx
it("부하 섹션 상단에 추천 안내를 보인다", () => {
  renderRunDialog();
  expect(screen.getByText("추천값으로 채워져 있어 바로 실행할 수 있습니다.")).toBeInTheDocument();
});
```
기존 think-time/timeout/loop-cap의 `aria-describedby`·invalid 단언이 있으면 유지(id 불변: `think-time-error`/`http-timeout-error`/`loop-cap-error`). `getByLabelText`로 입력을 찾던 기존 단언은 Field의 `htmlFor` 연결로 계속 해소(라벨 텍스트 불변이면 그대로).

- [ ] **Step 2: ko 키** — `ko.runDialog`에:
```ts
    recommendedNotice: "추천값으로 채워져 있어 바로 실행할 수 있습니다.",
```

- [ ] **Step 3: RED 확인** — Run: `cd ui && pnpm test RunDialog`  Expected: 추천 안내 FAIL.

- [ ] **Step 4: 구현**
  - 추천 안내: 그룹1 `<Section>` children 맨 위(또는 `LoadModelFields` *앞*, RunDialog 소유 마크업)에 `<p className="mb-2 text-xs text-accent-700">{ko.runDialog.recommendedNotice}</p>`. **`LoadModelFields` 안에 넣지 말 것**(R6 — ScheduleForm 누출 방지).
  - think-time 3입력(`:640-674`): 각 `<label className="block text-sm"><span>…</span><input className="…border-slate-300…"/></label>`를 `<Field label={ko.loadModel.thinkMin} htmlFor={id}><Input id={id} type="number" min="0" value={thinkMin} onChange=… aria-invalid={thinkInvalid} aria-describedby={thinkInvalid ? "think-time-error" : undefined}/></Field>`로. **min/max는 같은 `aria-describedby="think-time-error"`** 유지하고 외부 `<p id="think-time-error">`(`:677`)는 그대로 둔다(Field `error` 미사용). `useId`로 각 입력 id 생성.
  - http_timeout(`:688`)·loop_cap(`:705`): `Field`+`Input`, 외부 에러 `<p id="http-timeout-error">`/`<p id="loop-cap-error">`는 기존 위치 유지(blockedReasons 경로 보존), 입력 `aria-describedby` 불변.
  - preset 이름 입력(`:752` `<input className="…border-slate-300…">`)→`<Input className="w-48" aria-label={ko.runDialog.presetNameAria} … />`. preset load `<select>`(`:487`)→`<Select aria-label={ko.runDialog.loadPresetAria} …>`. **aria-label 불변**.
  - blue→accent: **RunDialog.tsx엔 `text-blue-600`가 없다**(`grep -n text-blue-600 ui/src/components/RunDialog.tsx` = 0 — 확인만). 떠도는 control-link blue는 `LoadModelFields`에 있으니 B4에서 처리(R13). preset 액션 버튼(`이름 변경`/`프리셋 삭제` `:769-785`)의 `text-slate-700`/`text-red-600 hover:underline`은 유지(링크형 — 삭제는 의미상 red 유지).
  - 인라인 영어/하드코딩: 이 task에서 만진 영역에 잔존 영어 라벨 0(전부 ko).

- [ ] **Step 5: GREEN + 회귀** — Run: `cd ui && pnpm test RunDialog`  Expected: PASS(추천 안내 + think-time/timeout/loop-cap aria/invalid + 프리셋 전부).

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(run-dialog): 자체 입력→Field/Input(외부 errorId 보존)+추천 안내"
```

---

### Task B4: LoadModelFields 입력 토큰화 + duration HelpTip + 추천 Badge 게이트

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx` (`INPUT` 상수 `:56`, 입력들, duration 필드, VU/RPS 필드)
- Modify: `ui/src/i18n/ko.ts` (`ko.glossary.duration` 신규)
- Modify: `ui/src/components/__tests__/LoadModelFields.test.tsx` · `__tests__/ScheduleForm.test.tsx` (lockstep)

**Interfaces:**
- Consumes: `Field`(A5), `Input`(A2), `Select`(A2), `Badge`(A3), `HelpTip`(기존).
- Produces: `LoadModelFields`에 **신규 optional prop** `showRecommended?: boolean`(RunDialog만 `true`; ScheduleForm 미전달=`undefined`=미렌더). duration 필드에 HelpTip 1개 신규. `INPUT` 상수가 `rounded-md` 토큰.

- [ ] **Step 1: 테스트 (lockstep RED)** (tdd-guard: ko/src 편집 *전* pending test)
  - `LoadModelFields.test.tsx`: ① duration HelpTip 존재(`getByRole("button",{name:"지속 시간 설명"})`) ② `showRecommended` 게이트 — 미전달이면 "추천" Badge 미렌더, `showRecommended`면 렌더(`it.each`로 closed+fixed 등; 라벨 텍스트 충돌 시 `within(부하 섹션)` 스코프).
  - `ScheduleForm.test.tsx`: ScheduleForm 마운트 시 **"추천" Badge·"바로 실행" 문구 미렌더**(R6/R10):
    ```tsx
    it("ScheduleForm은 추천/바로실행 프레이밍을 안 보인다", () => {
      renderScheduleForm();
      expect(screen.queryByText("추천값으로 채워져 있어 바로 실행할 수 있습니다.")).not.toBeInTheDocument();
      expect(screen.queryByText("추천")).not.toBeInTheDocument(); // '추천' Badge 게이트 미렌더
    });
    ```

- [ ] **Step 2: ko 키** — `ui/src/i18n/ko.ts`:
```ts
    // glossary 블록(32–59)에:
    duration: "지속 시간 — 부하를 주는 총 시간(초)입니다. 짧게 시작해 점차 늘려보세요.",
    // ko.common 블록에(B1에서 required/optional 추가됨 — 그 옆):
    recommended: "추천",
```

- [ ] **Step 3: RED 확인** — Run: `cd ui && pnpm test LoadModelFields`  Expected: duration/게이트 FAIL.

- [ ] **Step 4: 구현**
  - `INPUT` 상수(`:56`): `"mt-1 block w-full rounded border border-slate-300 px-2 py-1"` → `"mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30"`. (모든 소비 입력이 radius/포커스 통일. 구조 무재작성 — 상수만 교체.)
  - VU/duration/targetRps 등 개별 `<label><input className={INPUT}/></label>`를 `<Field label htmlFor help={<HelpTip…>} recommended={showRecommended ? ko.common.recommended : undefined}><Input id …/></Field>`로 점진 교체(외부 에러 id `ramp-up-error`/`target-rps-error`/`max-in-flight-error`/`worker-count-error` 보존 — Field `error` 미사용, 외부 `<p>` 유지). **HelpTip/Badge는 Field가 `<label>` 밖 형제로 렌더하므로 accname 오염 없음**(A5 계약).
  - **추천 Badge 게이트:** 필수 입력(closed: VU·duration / open: 목표 RPS·duration)의 `Field`에 `recommended={showRecommended ? ko.common.recommended : undefined}`. `showRecommended`는 새 prop(기본 `undefined` → 미렌더). HelpTip `label` aria(예: "VU 설명")는 기존 하드코딩 유지(byte-identical — §7 연기).
  - **duration HelpTip 신규:** duration `Field`의 `help`에 `<HelpTip label="지속 시간 설명">{ko.glossary.duration}</HelpTip>`(Field가 label 밖 형제로 렌더).
  - **blue→accent(R13):** `LoadModelFields.tsx:226`("+ 단계 추가")·`:570`("적용")의 `text-blue-600`→`text-accent-600`. **`StageCurvePreview` 곡선선 stroke `#2563eb`는 0-diff**(데이터 색).
  - **모드 라디오·stage 편집기·사이징 헬퍼:** 구조 무변경(INPUT 상수 토큰화로 자동 정합). accname/게이트/payload 불변(R10).

- [ ] **Step 5: RunDialog가 prop 전달** — `ui/src/components/RunDialog.tsx`의 `<LoadModelFields … />`에 `showRecommended` 추가(closed/open 무관 상시 `true` — RunDialog 전용):
```tsx
<LoadModelFields … showRecommended />
```
(ScheduleForm의 `<LoadModelFields>`는 **건드리지 않는다** → prop 부재 → Badge 미렌더.)

- [ ] **Step 6: GREEN + 회귀** — Run: `cd ui && pnpm test LoadModelFields && pnpm test ScheduleForm && pnpm test RunDialog`  Expected: 전부 PASS(duration HelpTip·게이트·ScheduleForm 미렌더·RunDialog 추천 Badge 렌더).

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/LoadModelFields.tsx ui/src/components/RunDialog.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/components/__tests__/ScheduleForm.test.tsx
git commit -m "feat(run-dialog): LoadModelFields INPUT 토큰화+duration HelpTip+추천 Badge RunDialog 전용 게이트"
```

---

### Task B5: 전체 게이트 + grep 불변식 + 라이브 검증

**Files:** (검증만 — 코드 변경 시 해당 task로 회귀)

- [ ] **Step 1: 전체 UI 게이트** — Run: `cd ui && pnpm lint && pnpm test && pnpm build`  Expected: 전부 GREEN(lint 0 warn).

- [ ] **Step 2: grep 불변식**
  - R14(0-diff): `git diff --name-only master` → `ui/`·`docs/`·`ui/tailwind.config.ts`만. `crates/`·`*.proto`·`*.sql`·`ui/src/api/schemas.ts` 부재.
  - R13(색 도메인 0-diff): `git diff master -- ui/src/components/report/ ui/src/compare/ ui/src/components/StageCurvePreview.tsx ui/src/components/StatusBadge.tsx` → 0(차트/compare/StatusBadge stroke 불변). **+ control-link 수렴 확인:** `grep -n text-blue-600 ui/src/components/RunDialog.tsx ui/src/components/LoadModelFields.tsx` → 0(`:226`/`:570` accent로 전환됨).
  - R9: `grep -nE "border-slate-300" ui/src/components/RunDialog.tsx ui/src/components/LoadModelFields.tsx` → `<input>`/`<select>` 요소엔 0(INPUT 상수·size-preset pill·preset 버튼만 잔존).
  - R12: 만진 파일에 인라인 영어 라벨 0(`grep -nE '"[A-Za-z]' ui/src/components/RunDialog.tsx` 검토 — ko 키/식별자 제외).

- [ ] **Step 3: 라이브 검증 (R16)** — `/live-verify` 또는 수동 스택. 워크트리 자체 바이너리(`cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`) + `./target/debug/controller --db /tmp/c2.db --ui-dir ui/dist`(먼저 `pnpm build`로 dist) + Playwright 헤드리스:
  - RunDialog 진입(`/scenarios/{id}/runs` → `실행하기`).
  - 추천값 그대로 `실행하기` → 실 run 1회 생성 → `/runs/{id}` 리포트 진입.
  - **console Zod 에러 0**(현재 navigation만, `all` 없이).
  - accent 포커스 링·번호 섹션·추천 안내·접힘 토글 시각 확인(스크린샷).
  - 검증 후 `rm -rf .playwright-mcp` + 루트 png 정리.

- [ ] **Step 4: (변경 없으면) 커밋 불필요** — 검증 전용. 정리 잔재만 확인.

---

### Task B6: ADR-0043 + roadmap §B12

**Files:**
- Create: `docs/adr/0043-ui-design-system.md`
- Modify: `docs/roadmap.md` (§B12 신규 절)

**Interfaces:** 문서만.

- [ ] **Step 1: ADR-0043** — `docs/adr/0043-ui-design-system.md` (MADR 포맷): "UI 디자인 시스템(시맨틱 토큰 + 프리미티브 컴포넌트 레이어)을 점진 채택, RunDialog를 첫 채택처로. accent=indigo 토큰·`ui/src/components/ui/` 프리미티브 홈·byte-identical 재구성 원칙. 대안(전면 리라이트·CSS-in-JS·UI 라이브러리 도입) 기각 사유."

- [ ] **Step 2: roadmap §B12** — `docs/roadmap.md`에 `### B12. 디자인 시스템 확장 (2026-06-27, C-2) 연기 항목` 절: 다른 화면 토큰 이주·차트/compare 색 토큰화·간단/상세 토글·마법사·기존 프리미티브(`Button`/`Modal`/`HelpTip`) `ui/` 폴더 통합·기존 HelpTip label aria ko 이주·기본값 숫자 재검토.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0043-ui-design-system.md docs/roadmap.md
git commit -m "docs(ui-ds): ADR-0043 디자인 시스템 점진 채택 + roadmap §B12 연기"
```

> 루트 CLAUDE.md ADR 인덱스 한 줄·build-log·상태줄·메모리는 `/finish-slice`가 처리(이 plan 범위 밖).

---

## Self-Review (작성자 체크)

**Spec coverage (R1–R16):**
- R1 토큰=A1. R2 프리미티브 6종+테스트=A2–A6. R3 Button accent+test=A7. R4 byte-identical=Phase B 공통 규율+회귀 테스트. R5 번호 섹션=B1. R6 추천 프레이밍(안내=B3 RunDialog 소유·Badge 게이트=B4)+ScheduleForm 미렌더=B4 Step2. R7 HelpTip 보존+duration 신규=B4. R8 Callout role 보존+mutation alert=B2. R9 INPUT 토큰화+grep=B4+B5. R10 LoadModelFields/ScheduleForm byte-identical=B4 회귀. R11 외부 errorId 보존=A5 계약(help/badge label 밖)+B3 think-time. R12 ko=B1/B3/B4(advancedSetHint·recommended·recommendedNotice·glossary.duration). R13 blue→accent(LoadModelFields :226/:570)=B4·색 도메인 0-diff=B5 grep. R14 0-diff=B5 grep. R15 a11y=프리미티브 테스트+B 보존. R16 라이브=B5 Step3. → **모든 R에 task 매핑됨.**
- **Placeholder scan:** 코드 스텝 전부 실제 코드. RunDialog/LoadModelFields 대형 파일은 라인 범위 + 패턴 + 불변식으로 지정(전체 재현 대신 — 기존 테스트가 byte-identical 가드). "적절히 처리" 류 없음.
- **Type consistency:** `Section` badge=slot(ReactNode)·`Field` htmlFor 필수·`Callout` role=호출자·`showRecommended?:boolean` prop — A 정의와 B 소비 시그니처 일치. `accent-*` 토큰 A1 정의 후 A2+ 전부 소비.
- **tdd-guard 순서:** 각 task가 테스트 파일 먼저(RED) → src. ko.ts 편집은 같은 task의 테스트 pending diff로 unblock(B1/B3/B4).
- **green-fold:** 각 task 단일 GREEN 커밋(RED-only·미사용-헬퍼-only 커밋 없음).

---

REVIEW-GATE: APPROVED
