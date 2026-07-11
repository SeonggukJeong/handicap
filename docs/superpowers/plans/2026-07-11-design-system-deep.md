# design-system-deep 구현 계획 (디자인 시스템 확산 4차 — PageSection·Badge 깊은 토큰 이주)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 신설 `PageSection` 프리미티브(표시 섹션 h3/h4 두 캐넌) + `Badge` additive 확장(weight·className)으로 결과·표시 화면군의 섹션 12곳·차트 5곳·워커 배지 3곳을 byte-identical 이주한다.

**Architecture:** spec = `docs/superpowers/specs/2026-07-11-design-system-deep-design.md` (spec-plan-reviewer 3라운드 clean APPROVE). 토대는 additive만(`PageSection.tsx` 신설·`Badge.tsx` prop 2종), 화면 이주는 전부 JSX 래퍼 교체(로직/상태/핸들러 0-diff). 유일한 재구조는 ActiveVuChart(공유 `<section>`을 ternary로 호이스트 — spec §4.2).

**Tech Stack:** React + TS + Tailwind, vitest + RTL. UI-only(cargo 게이트 비대상).

## Global Constraints (전 task 공통 — spec §2 서두·R6/R7/R9/R12)

- **byte-identical 정의**: 렌더 DOM의 태그·aria·클래스 *집합*·computed style 동일. 허용되는 유일한 문자열 차이 2종 = ① Badge `className` append로 `ml-2`가 클래스 문자열 *끝*으로 이동(집합 동일) ② ReportView 레이턴시 섹션의 "클래스 부재 → `class=""`".
- **R6 토대 동결**: `ui/src/components/ui/{Section,Input,Select,Callout,Field,Segmented,Textarea}.tsx`·`tailwind.config.ts`·`Button.tsx`·`Modal.tsx` 0-diff. 이 슬라이스의 토대 diff는 `PageSection.tsx` 신설 + `Badge.tsx` additive뿐.
- **R7 동결 사이트 무접촉**(사이트 단위): StepPhaseBreakdown 헤더·CompareOverlaySection·ConnectionCostCard·ScenarioSnapshot·ReportHeadline·VerdictPanel·ActiveVuChart **멀티워커 분기**·RunDetail `metricWindowsTitle` bare h3·RunListControls·RunDetail 버튼 열·WorkerDashboard 다이얼로그/드롭다운·데이터 식별/severity/verdict/Δ 색.
- **R9**: `git diff --name-only`가 `ui/src/components|pages|i18n` + `docs/`만. `crates/`·proto·`ui/src/api/**` 0-diff.
- **R10 lockstep**: 기존 테스트 **무수정 GREEN** = byte-identical 1차 증거. 이주로 기존 단언이 깨지면 **단언을 고치지 말고 이주를 고친다**.
- **R12**: 신규 하드코딩 한글 0(Task 3의 `insightsTitle`은 이주)·신규 `blue-*`/`indigo-*` 리터럴 0.
- **tdd-guard**: 각 task는 **테스트 파일 편집을 가장 먼저**(pending diff 생성 후 src 편집). byte-identical 리팩터라 RED가 아니라 **GREEN-사전-단언**(src 변경 전에도 통과, 변경 후에도 통과 = lockstep) — 2차 spec §8 F1 패턴.
- **테스트 명령**: 단일 파일은 `pnpm test <이름>` (**`--` 붙이면 전체 스위트가 도는 함정** — ui/CLAUDE.md). 커밋 시 pre-commit이 UI 게이트(`pnpm lint && pnpm test && pnpm build`) 전체를 돌리므로 커밋은 수 분 소요.
- **커밋**: 명시 경로 `git add`(`-A` 금지)·**단일 FOREGROUND 호출**(timeout 600000ms, background+poll 금지)·`git commit … | tail` 파이프 금지. task 리포트 `.md`는 워크트리 루트에 쓰지 말고(커밋 오염) `.superpowers/sdd/` 경로만.
- **import 경로**: `components/report/`·`components/compare/` 내부 → `../ui/PageSection` · `pages/` → `../components/ui/PageSection`(Badge 동일). 각 파일의 기존 ui 프리미티브 import 블록 옆에 추가.

---

### Task 1: `PageSection` 프리미티브 신설 + 단위 테스트

**Files:**
- Test(먼저): `ui/src/components/ui/__tests__/PageSection.test.tsx` (신규)
- Create: `ui/src/components/ui/PageSection.tsx`

**Interfaces:**
- Produces: `PageSection({ ariaLabel: string; title: ReactNode; sub?: boolean; className?: string; children?: ReactNode })` — Task 3·4·5가 소비. 렌더: `<section aria-label={ariaLabel} className={className ?? "mb-6"}>` + (sub? `<h4 className="text-sm font-semibold text-slate-700 mb-2">` : `<h3 className="text-lg font-semibold mb-2">`) + children. `className`은 **통째 교체**(`??` 필수 — `||`는 `""`에 mb-6 오주입, spec §3).

- [ ] **Step 1: 테스트 파일 작성 (tdd-guard pending diff — import 미해결 RED 무방)**

```tsx
// ui/src/components/ui/__tests__/PageSection.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PageSection } from "../PageSection";

describe("PageSection", () => {
  it("메인 캐넌: region aria-label + 기본 mb-6 + h3 정확 클래스 + children", () => {
    render(
      <PageSection ariaLabel="요약 섹션" title="요약">
        <p>내용</p>
      </PageSection>,
    );
    const section = screen.getByRole("region", { name: "요약 섹션" });
    expect(section.tagName).toBe("SECTION");
    expect(section.className).toBe("mb-6");
    const h = screen.getByRole("heading", { level: 3, name: "요약" });
    expect(h.className).toBe("text-lg font-semibold mb-2");
    expect(screen.getByText("내용")).toBeInTheDocument();
  });

  it("sub 캐넌: h4 + 정확 클래스 (h3 부재)", () => {
    render(<PageSection sub ariaLabel="차트 섹션" title="RPS" />);
    const h = screen.getByRole("heading", { level: 4, name: "RPS" });
    expect(h.className).toBe("text-sm font-semibold text-slate-700 mb-2");
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it("className은 통째 교체 — mt-8 전달 시 mb-6 부재", () => {
    render(<PageSection ariaLabel="비교" title="비교" className="mt-8" />);
    expect(screen.getByRole("region", { name: "비교" }).className).toBe("mt-8");
  });

  it('className=""는 빈 class로 렌더 (mb-6 오주입 금지 — ?? 시맨틱)', () => {
    render(<PageSection ariaLabel="레이턴시" title="레이턴시" className="" />);
    expect(screen.getByRole("region", { name: "레이턴시" }).className).toBe("");
  });

  it("title은 ReactNode 수용 (함수형 ko 키 호출 결과 등)", () => {
    render(<PageSection ariaLabel="워커" title={<>워커별 분해 (2개 워커)</>} />);
    expect(
      screen.getByRole("heading", { level: 3, name: "워커별 분해 (2개 워커)" }),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: `pnpm test PageSection` — FAIL 확인** (모듈 부재)

- [ ] **Step 3: 구현**

```tsx
// ui/src/components/ui/PageSection.tsx
import type { ReactNode } from "react";

// 표시(결과·리포트) 화면 섹션 캐넌 — 폼 fieldset용 Section과 별개 프리미티브 (spec 2026-07-11 design-system-deep).
export function PageSection({
  ariaLabel,
  title,
  sub = false,
  className,
  children,
}: {
  ariaLabel: string;
  title: ReactNode;
  sub?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section aria-label={ariaLabel} className={className ?? "mb-6"}>
      {sub ? (
        <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
      ) : (
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
      )}
      {children}
    </section>
  );
}
```

- [ ] **Step 4: `pnpm test PageSection` — 5 PASS 확인**

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/ui/PageSection.tsx ui/src/components/ui/__tests__/PageSection.test.tsx
git commit -m "feat(ui): PageSection 프리미티브 — 표시 섹션 h3/h4 두 캐넌 인코딩 (R1)"
```

---

### Task 2: `Badge` additive 확장 (weight·className) + 정확-문자열 락

**Files:**
- Test(먼저): `ui/src/components/ui/__tests__/Badge.test.tsx` (수정 — 기존 2 케이스 무수정 유지, 신규 3 케이스 추가)
- Modify: `ui/src/components/ui/Badge.tsx`

**Interfaces:**
- Produces: `Badge({ tone?, weight?: "semibold"|"medium", className?: string, children })` — 기본값 경로 클래스 문자열은 기존과 **정확히 동일**(trailing space 금지). weight는 리터럴 맵(`font-${weight}` 템플릿 금지 — JIT 함정, spec R2). Task 6이 소비.

- [ ] **Step 1: 테스트 추가 (기존 케이스 무수정 — 신규 정확-문자열 단언은 src 변경 전 기준으로도 통과해야 함: 기본경로 문자열이 현재 렌더와 동일하기 때문. weight/className 케이스만 신규 prop이라 RED)**

```tsx
// Badge.test.tsx describe 안에 추가
  it("기본 경로(무 weight·무 className) 클래스 문자열 정확 동일 — byte-identical 락 (spec R2/리뷰 F1)", () => {
    render(<Badge>선택</Badge>);
    expect(screen.getByText("선택").className).toBe(
      "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold bg-slate-100 text-slate-600",
    );
  });
  it("weight=medium은 font-medium 렌더 + font-semibold 부재", () => {
    render(
      <Badge tone="warn" weight="medium">
        드레인 중
      </Badge>,
    );
    const el = screen.getByText("드레인 중");
    expect(el.className).toContain("font-medium");
    expect(el.className).not.toContain("font-semibold");
    expect(el.className).toContain("bg-amber-100");
  });
  it("className은 끝에 append (trailing space 없이)", () => {
    render(
      <Badge weight="medium" className="ml-2">
        임시
      </Badge>,
    );
    expect(screen.getByText("임시").className).toBe(
      "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-600 ml-2",
    );
  });
```

- [ ] **Step 2: `pnpm test Badge` — 기본경로 케이스 PASS(현행과 동일 문자열)·weight/className 2 케이스 FAIL 확인**

- [ ] **Step 3: 구현 — `Badge.tsx` 전체 교체**

```tsx
import type { ReactNode } from "react";

const TONES = {
  neutral: "bg-slate-100 text-slate-600",
  accent: "bg-accent-50 text-accent-700",
  required: "bg-slate-800 text-white",
  optional: "bg-slate-100 text-slate-500",
  warn: "bg-amber-100 text-amber-800",
} as const;

// 리터럴 맵 필수 — `font-${weight}` 템플릿은 Tailwind JIT가 클래스를 못 봄 (spec R2).
const WEIGHTS = {
  semibold: "font-semibold",
  medium: "font-medium",
} as const;

export function Badge({
  tone = "neutral",
  weight = "semibold",
  className,
  children,
}: {
  tone?: keyof typeof TONES;
  weight?: keyof typeof WEIGHTS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${WEIGHTS[weight]} ${TONES[tone]}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 4: `pnpm test Badge` — 5 PASS (기존 2 + 신규 3)**

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/ui/Badge.tsx ui/src/components/ui/__tests__/Badge.test.tsx
git commit -m "feat(ui): Badge additive 확장 — weight 리터럴 맵·className append, 기본경로 정확-문자열 락 (R2)"
```

---

### Task 3: report/ 메인 캐넌 8곳 → PageSection (+ InsightPanel ko 키 이주)

**Files:**
- Test(먼저): `ui/src/components/report/__tests__/Summary.test.tsx`·`ui/src/components/report/__tests__/ReportView.test.tsx` (lockstep 단언 추가)
- Modify: `ui/src/components/report/{Summary,StepStatsTable,StatusDistribution,BranchStatsTable,WorkerBreakdownTable,GroupLatencyTable,InsightPanel,ReportView}.tsx`, `ui/src/i18n/ko.ts`

**Interfaces:**
- Consumes: Task 1 `PageSection`.
- Produces: 없음(리프 변경). `ko.report.insightsTitle` 신규 키.

- [ ] **Step 1: lockstep 단언 추가 (GREEN-사전-단언 — src 변경 전에도 통과·후에도 통과해야 byte-identical 증명. 각 파일의 기존 describe/render 픽스처를 재사용해 케이스만 추가)**

```tsx
// Summary.test.tsx에 추가 (기존 render 픽스처 재사용)
  it("섹션·헤딩 캐넌 클래스 lockstep (byte-identical 가드)", () => {
    render(<Summary {...기존_케이스와_동일한_props} />);
    expect(screen.getByRole("region", { name: ko.report.summaryLabel }).className).toBe("mb-6");
    expect(
      screen.getByRole("heading", { level: 3, name: ko.report.summaryTitle }).className,
    ).toBe("text-lg font-semibold mb-2");
  });
```

```tsx
// ReportView.test.tsx에 추가 (latency 있는 기존 report 픽스처 재사용)
  it("레이턴시 섹션은 클래스 없음(class='') 보존 — spec §2 허용 편차 ②", () => {
    // 기존 렌더 후:
    expect(screen.getByRole("region", { name: ko.report.latencyTitle }).className).toBe("");
  });
```

주의: `ko` import가 그 테스트 파일에 없으면 형제 테스트의 import 깊이를 기준으로 추가(`import { ko } from "../../../i18n/ko";` — __tests__는 한 단계 깊음, ui/CLAUDE.md import-depth 함정).

- [ ] **Step 2: `pnpm test Summary` · `pnpm test ReportView` — 신규 단언 포함 전부 PASS 확인** (ReportView 단언은 src 변경 전 기준: section에 클래스 attr가 없으므로 `className`은 `""` — 동일하게 통과)

- [ ] **Step 3: 6개 단순 사이트 교체.** 각 파일에 `import { PageSection } from "../ui/PageSection";` 추가 후:

`Summary.tsx`:
```tsx
// BEFORE
    <section aria-label={ko.report.summaryLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">{ko.report.summaryTitle}</h3>
// AFTER
    <PageSection ariaLabel={ko.report.summaryLabel} title={ko.report.summaryTitle}>
```
+ 그 컴포넌트 return의 대응 `</section>` → `</PageSection>`. (children JSX는 무변경 — 들여쓰기 포함 그대로 둔다.)

`StepStatsTable.tsx`:
```tsx
// BEFORE
    <section aria-label={ko.report.perStepStatsLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">{ko.report.stepsHeading}</h3>
// AFTER
    <PageSection ariaLabel={ko.report.perStepStatsLabel} title={ko.report.stepsHeading}>
```

`StatusDistribution.tsx`:
```tsx
// BEFORE
    <section aria-label={ko.report.statusDistributionLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">{ko.report.statusCodesTitle}</h3>
// AFTER
    <PageSection ariaLabel={ko.report.statusDistributionLabel} title={ko.report.statusCodesTitle}>
```

`BranchStatsTable.tsx`:
```tsx
// BEFORE
    <section aria-label={ko.report.branchDecisionsLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">{ko.report.branchDecisionsTitle}</h3>
// AFTER
    <PageSection ariaLabel={ko.report.branchDecisionsLabel} title={ko.report.branchDecisionsTitle}>
```

`WorkerBreakdownTable.tsx` (멀티라인 title — 함수형 ko 키 호출 결과를 그대로 prop으로):
```tsx
// BEFORE
    <section aria-label={ko.report.workerBreakdownLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">
        {ko.report.workerBreakdownTitle(breakdown.length)}
      </h3>
// AFTER
    <PageSection
      ariaLabel={ko.report.workerBreakdownLabel}
      title={ko.report.workerBreakdownTitle(breakdown.length)}
    >
```

`GroupLatencyTable.tsx`:
```tsx
// BEFORE
    <section aria-label={ko.report.pageLoadLatencyLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">{ko.report.pageLoadLatencyTitle}</h3>
// AFTER
    <PageSection ariaLabel={ko.report.pageLoadLatencyLabel} title={ko.report.pageLoadLatencyTitle}>
```

- [ ] **Step 4: InsightPanel + ko 키 이주 (R8).** `ko.ts`의 `insightsLabel: "인사이트",` 바로 다음 줄에 추가:
```ts
    insightsTitle: "핵심 인사이트",
```
`InsightPanel.tsx`:
```tsx
// BEFORE
    <section aria-label={ko.report.insightsLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">핵심 인사이트</h3>
// AFTER
    <PageSection ariaLabel={ko.report.insightsLabel} title={ko.report.insightsTitle}>
```

- [ ] **Step 5: ReportView 레이턴시 섹션 (className="" — 유일한 클래스-없음 사이트):**
```tsx
// BEFORE
        <section aria-label={ko.report.latencyTitle}>
          <h3 className="text-lg font-semibold mb-2">{ko.report.latencyTitle}</h3>
          <PercentileCurveChart curve={report.latency.percentile_curve} />
          <LatencyHistogramChart buckets={report.latency.histogram} />
        </section>
// AFTER
        <PageSection ariaLabel={ko.report.latencyTitle} title={ko.report.latencyTitle} className="">
          <PercentileCurveChart curve={report.latency.percentile_curve} />
          <LatencyHistogramChart buckets={report.latency.histogram} />
        </PageSection>
```

- [ ] **Step 6: `pnpm test src/components/report` 전체 — 무수정-기존 + 신규 단언 전부 PASS.** 깨지는 기존 단언이 있으면 이주 쪽 오류(R10).

- [ ] **Step 7: 커밋**
```bash
git add ui/src/components/report/Summary.tsx ui/src/components/report/StepStatsTable.tsx ui/src/components/report/StatusDistribution.tsx ui/src/components/report/BranchStatsTable.tsx ui/src/components/report/WorkerBreakdownTable.tsx ui/src/components/report/GroupLatencyTable.tsx ui/src/components/report/InsightPanel.tsx ui/src/components/report/ReportView.tsx ui/src/i18n/ko.ts ui/src/components/report/__tests__/Summary.test.tsx ui/src/components/report/__tests__/ReportView.test.tsx
git commit -m "refactor(ui): report/ 메인 캐넌 8곳 PageSection 이주 + insightsTitle ko 키 (R3·R8)"
```

---

### Task 4: 차트 서브 캐넌 5곳 → `PageSection sub` (ActiveVuChart ternary 호이스트 포함)

**Files:**
- Test(먼저): `ui/src/components/report/__tests__/TimeSeriesChart.test.tsx`·`ui/src/components/report/__tests__/ActiveVuChart.test.tsx` (lockstep 단언 추가)
- Modify: `ui/src/components/report/{TimeSeriesChart,PercentileCurveChart,LatencyHistogramChart,ActiveVuChart}.tsx`, `ui/src/components/compare/CompareTimeSeriesChart.tsx`

**Interfaces:**
- Consumes: Task 1 `PageSection`(sub).

- [ ] **Step 1: lockstep 단언 추가 (기존 픽스처 재사용)**

```tsx
// TimeSeriesChart.test.tsx에 추가
  it("서브 캐넌 클래스 lockstep", () => {
    render(<TimeSeriesChart {...기존_케이스_props} />);
    expect(screen.getByRole("heading", { level: 4 }).className).toBe(
      "text-sm font-semibold text-slate-700 mb-2",
    );
  });
```

```tsx
// ActiveVuChart.test.tsx에 추가 — 두 분기 각각
  it("단일워커: 서브 캐넌 h4 lockstep", () => {
    render(<ActiveVuChart {...단일워커_기존_픽스처} />);
    expect(
      screen.getByRole("heading", { level: 4, name: ko.report.activeVuTitle }).className,
    ).toBe("text-sm font-semibold text-slate-700 mb-2");
    expect(screen.getByRole("region", { name: ko.report.activeVuTitle }).className).toBe("mb-6");
  });
  it("멀티워커: bespoke 헤더 동결 — h4는 mb-2 없는 변형 + 토글 존속 (R7)", () => {
    render(<ActiveVuChart {...멀티워커_기존_픽스처} />);
    expect(
      screen.getByRole("heading", { level: 4, name: ko.report.activeVuTitle }).className,
    ).toBe("text-sm font-semibold text-slate-700");
    expect(
      screen.getByRole("group", { name: ko.report.activeVuViewToggleLabel }),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 2: `pnpm test TimeSeriesChart` · `pnpm test ActiveVuChart` — 신규 포함 PASS 확인**

- [ ] **Step 3: 단순 3곳 교체** (import `../ui/PageSection`):

`TimeSeriesChart.tsx`:
```tsx
// BEFORE
    <section aria-label={ko.report.timeSeriesAria(title)} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
// AFTER
    <PageSection sub ariaLabel={ko.report.timeSeriesAria(title)} title={title}>
```

`PercentileCurveChart.tsx` (멀티라인 h4):
```tsx
// BEFORE
    <section aria-label={ko.report.latencyPercentileCurveLabel} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">
        {ko.report.latencyPercentileCurveLabel}
      </h4>
// AFTER
    <PageSection
      sub
      ariaLabel={ko.report.latencyPercentileCurveLabel}
      title={ko.report.latencyPercentileCurveLabel}
    >
```

`LatencyHistogramChart.tsx` (aria와 title이 **다른 키**):
```tsx
// BEFORE
    <section aria-label={ko.report.latencyHistogramLabel} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{ko.report.latencyDistTitle}</h4>
// AFTER
    <PageSection sub ariaLabel={ko.report.latencyHistogramLabel} title={ko.report.latencyDistTitle}>
```

`compare/CompareTimeSeriesChart.tsx` (import는 같은 `../ui/PageSection`):
```tsx
// BEFORE
    <section aria-label={ko.report.timeSeriesAria(title)} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
// AFTER
    <PageSection sub ariaLabel={ko.report.timeSeriesAria(title)} title={title}>
```
(각각 대응 `</section>` → `</PageSection>`.)

- [ ] **Step 4: ActiveVuChart ternary 호이스트 (spec §4.2 — 래핑 불가, 재구조).** 현재 return 블록(단일 `<section>`이 조건부 헤더+공유 본문을 감쌈)을 다음 구조로 교체 — **본문을 `body` fragment로 추출**(fragment는 DOM 무추가 = byte-identical), 멀티워커 분기는 기존 `<section>`+flex 헤더 **한 글자도 안 바꿈**:

```tsx
  const body = (
    <>
      {multiWorker ? (
        <p className="text-xs text-slate-500 mb-1">{ko.report.activeVuFanout(byWorker.length)}</p>
      ) : null}
      {width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          {chart}
        </ResponsiveContainer>
      )}
      {showByWorker ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 mt-1">
          {/* …기존 byWorker.map 리스트 그대로 이동(무수정)… */}
        </ul>
      ) : null}
    </>
  );

  return multiWorker ? (
    <section aria-label={ko.report.activeVuTitle} className="mb-6">
      <div className="flex items-center justify-between mb-2">
        {/* …기존 h4(mb-2 없는 변형)+토글 role="group" 블록 그대로(무수정)… */}
      </div>
      {body}
    </section>
  ) : (
    <PageSection sub ariaLabel={ko.report.activeVuTitle} title={ko.report.activeVuTitle}>
      {body}
    </PageSection>
  );
```
(단일워커 경로에서 `multiWorker` 캡션 `<p>`·`showByWorker` `<ul>`은 null이라 children=차트 블록만 — spec Fe1 검증대로 byte-identical.)

- [ ] **Step 5: `pnpm test src/components/report` + `pnpm test CompareTimeSeriesChart` — 전부 PASS**

- [ ] **Step 6: 커밋**
```bash
git add ui/src/components/report/TimeSeriesChart.tsx ui/src/components/report/PercentileCurveChart.tsx ui/src/components/report/LatencyHistogramChart.tsx ui/src/components/report/ActiveVuChart.tsx ui/src/components/compare/CompareTimeSeriesChart.tsx ui/src/components/report/__tests__/TimeSeriesChart.test.tsx ui/src/components/report/__tests__/ActiveVuChart.test.tsx
git commit -m "refactor(ui): 차트 서브 캐넌 5곳 PageSection sub 이주 — ActiveVuChart ternary 호이스트 (R4)"
```

---

### Task 5: RunDetail 3곳 + InsightCompareMatrix → PageSection

**Files:**
- Test(먼저): `ui/src/pages/__tests__/RunDetailPage.test.tsx`·`ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx` (lockstep 단언 추가)
- Modify: `ui/src/pages/RunDetailPage.tsx`, `ui/src/components/compare/InsightCompareMatrix.tsx`

**Interfaces:**
- Consumes: Task 1 `PageSection`.

- [ ] **Step 1: lockstep 단언 추가.** RunDetail 3섹션은 `terminal && report.data`의 **else 분기에만 렌더**(spec R11 ②) — 기존 테스트 중 **비-terminal(running) 픽스처** 케이스를 재사용:

```tsx
// RunDetailPage.test.tsx에 추가
  it("프로파일 섹션 클래스 통째-교체 lockstep (mb-6 text-sm)", async () => {
    /* 기존 running-run 케이스와 동일 셋업 */
    expect((await screen.findByRole("region", { name: ko.runDetail.profileLabel })).className).toBe(
      "mb-6 text-sm",
    );
    expect(
      screen.getByRole("heading", { level: 3, name: ko.runDetail.profileTitle }).className,
    ).toBe("text-lg font-semibold mb-2");
  });
```

```tsx
// InsightCompareMatrix.test.tsx에 추가
  it("섹션 mt-8 통째-교체 lockstep", () => {
    render(<InsightCompareMatrix {...기존_케이스_props} />);
    expect(screen.getByRole("region", { name: ko.insightCompare.title }).className).toBe("mt-8");
  });
```

- [ ] **Step 2: `pnpm test RunDetailPage` · `pnpm test InsightCompareMatrix` — PASS 확인**

- [ ] **Step 3: 교체.** `RunDetailPage.tsx`(import `../components/ui/PageSection`) — 3곳:

```tsx
// ① BEFORE
          <section aria-label={ko.runDetail.profileLabel} className="mb-6 text-sm">
            <h3 className="text-lg font-semibold mb-2">{ko.runDetail.profileTitle}</h3>
// ① AFTER
          <PageSection
            ariaLabel={ko.runDetail.profileLabel}
            title={ko.runDetail.profileTitle}
            className="mb-6 text-sm"
          >
// ② BEFORE
            <section aria-label={ko.runDetail.stepsLabel} className="mb-6">
              <h3 className="text-lg font-semibold mb-2">{ko.runDetail.stepsTitle}</h3>
// ② AFTER
            <PageSection ariaLabel={ko.runDetail.stepsLabel} title={ko.runDetail.stepsTitle}>
// ③ BEFORE (하단 EnvSection 헬퍼 컴포넌트 내부)
    <section aria-label={ko.runDetail.envLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">{ko.runDetail.envTitle}</h3>
// ③ AFTER
    <PageSection ariaLabel={ko.runDetail.envLabel} title={ko.runDetail.envTitle}>
```
(각 대응 `</section>` → `</PageSection>`. **금지**: 같은 파일의 `metricWindowsTitle` bare h3(`text-lg font-semibold mb-2`)는 동결 — 건드리면 R7 위반.)

`InsightCompareMatrix.tsx`(import `../ui/PageSection`):
```tsx
// BEFORE
    <section aria-label={ko.insightCompare.title} className="mt-8">
      <h3 className="text-lg font-semibold mb-2">{ko.insightCompare.title}</h3>
// AFTER
    <PageSection ariaLabel={ko.insightCompare.title} title={ko.insightCompare.title} className="mt-8">
```

- [ ] **Step 4: `pnpm test RunDetailPage` · `pnpm test InsightCompareMatrix` — 전부 PASS**

- [ ] **Step 5: 커밋**
```bash
git add ui/src/pages/RunDetailPage.tsx ui/src/components/compare/InsightCompareMatrix.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx
git commit -m "refactor(ui): RunDetail 3섹션·InsightCompareMatrix PageSection 이주 (R3)"
```

---

### Task 6: 워커 배지 3곳 → Badge (weight=medium)

**Files:**
- Test(먼저): `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx` (lockstep 단언 추가)
- Modify: `ui/src/pages/WorkerDashboardPage.tsx`

**Interfaces:**
- Consumes: Task 2 `Badge`(weight·className).

- [ ] **Step 1: lockstep 단언 추가 — 클래스 **집합** 비교(sort 후 toEqual). 문자열 `toBe`는 금지: 이주로 `ml-2`가 끝으로 이동(spec §2 허용 편차 ①)하므로 사전-단언이 전후 모두 통과하려면 집합 비교여야 한다. drained/ephemeral/stale 워커가 들어 있는 기존 pool-mode 픽스처 재사용(없는 상태는 픽스처에 워커 1행 추가 — `drained: true`·`stable: false`·`last_seen_secs_ago`를 stale 임계 초과로):**

```tsx
// WorkerDashboardPage.test.tsx에 추가
  const badgeClasses = (text: string) =>
    screen.getByText(text).className.trim().split(/\s+/).sort();

  it("워커 배지 3종 클래스 집합 lockstep (드레인·임시·응답없음)", async () => {
    /* 기존 pool-mode 렌더 셋업 재사용 */
    expect(badgeClasses(ko.workers.drainedBadge)).toEqual(
      ["ml-2", "inline-flex", "items-center", "rounded", "px-1.5", "py-0.5", "text-xs", "font-medium", "bg-amber-100", "text-amber-800"].sort(),
    );
    expect(badgeClasses(ko.workers.ephemeralBadge)).toEqual(
      ["ml-2", "inline-flex", "items-center", "rounded", "px-1.5", "py-0.5", "text-xs", "font-medium", "bg-slate-100", "text-slate-600"].sort(),
    );
    expect(badgeClasses(ko.workers.stale)).toEqual(
      ["ml-2", "inline-flex", "items-center", "rounded", "px-1.5", "py-0.5", "text-xs", "font-medium", "bg-amber-100", "text-amber-800"].sort(),
    );
  });
```

- [ ] **Step 2: `pnpm test WorkerDashboardPage` — PASS 확인** (사전-단언: raw span 기준으로도 집합 동일)

- [ ] **Step 3: 교체.** import는 파일의 기존 ui import 옆에 `import { Badge } from "../components/ui/Badge";` 추가:

```tsx
// ① drained — BEFORE
                    {w.drained ? (
                      <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                        {ko.workers.drainedBadge}
                      </span>
                    ) : null}
// ① AFTER
                    {w.drained ? (
                      <Badge tone="warn" weight="medium" className="ml-2">
                        {ko.workers.drainedBadge}
                      </Badge>
                    ) : null}
// ② ephemeral — BEFORE
                    {!w.stable ? (
                      <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-600">
                        {ko.workers.ephemeralBadge}
                      </span>
                    ) : null}
// ② AFTER
                    {!w.stable ? (
                      <Badge tone="neutral" weight="medium" className="ml-2">
                        {ko.workers.ephemeralBadge}
                      </Badge>
                    ) : null}
// ③ stale — BEFORE
                    {isStale ? (
                      <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                        {ko.workers.stale}
                      </span>
                    ) : null}
// ③ AFTER
                    {isStale ? (
                      <Badge tone="warn" weight="medium" className="ml-2">
                        {ko.workers.stale}
                      </Badge>
                    ) : null}
```
(**금지**: 같은 파일의 다이얼로그 카드·드롭다운·busy/idle 텍스트·`bg-blue-*` 버튼은 동결 — R7.)

- [ ] **Step 4: `pnpm test WorkerDashboardPage` — 전부 PASS**

- [ ] **Step 5: 커밋**
```bash
git add ui/src/pages/WorkerDashboardPage.tsx ui/src/pages/__tests__/WorkerDashboardPage.test.tsx
git commit -m "refactor(ui): 워커 배지 3곳 Badge 이주 — tone warn/neutral·weight medium (R5)"
```

---

## 마무리 (orchestrator 직접 수행 — subagent 디스패치 아님)

- [ ] **A. 전체 게이트**: `cd ui && pnpm lint && pnpm test && pnpm build` (전체 스위트 — targeted green ≠ full green).
- [ ] **B. §6 규칙 grep 직접 재실행** (대상군 = `ui/src/components/report ui/src/components/compare ui/src/pages/{RunDetailPage,ScenarioComparePage,ScenarioRunsPage,ScenarioListPage,WorkerDashboardPage}.tsx`):
  1. `grep -rn 'text-lg font-semibold mb-2' <대상군>` → 잔존 = `VerdictPanel.tsx` + `RunDetailPage.tsx`(metricWindows bare h3) **정확히 2건**
  2. `grep -rn '<h4 className="text-sm font-semibold text-slate-700' <대상군>` → 잔존 = `ActiveVuChart.tsx` 멀티워커 분기 **1건** (h4-앵커 필수 — bare 서브스트링은 ScenarioSnapshot 버튼 오탐)
  3. `grep -rn 'rounded px-1.5 py-0.5 text-xs font-medium' <대상군>` → **0건**
  4. `grep -rn '핵심 인사이트' ui/src --include='*.tsx'` → **0건** (ko.ts만 잔존)
- [ ] **C. R6/R7/R9 diff 확인**: `git diff --name-only master..HEAD` — `ui/src/components|pages|i18n`+`docs/`만, 동결 토대 파일 부재.
- [ ] **D. 라이브 검증 (R11, `/live-verify`)**: ① 완료 run 리포트에서 이주 섹션 `getComputedStyle` 실측 — h3 `fontSize 18px·fontWeight 600`·h4 `14px·color rgb(51,65,85)`·섹션 `marginBottom 24px` ② **실행 중(비-terminal) run**(duration 60s+) mid-flight `/runs/{id}`에서 RunDetail 3섹션 동일 실측(report.data 결정적 부재 — failed run은 report 200이라 부적합) ③ pool-mode + drain 액션으로 "드레인 중" 배지 `fontWeight 500` 실측(stale/ephemeral은 RTL 갈음) ④ 전/후 스크린샷.
- [ ] **E. 최종 리뷰**: `handicap-reviewer`(명시 `model: opus`) — cross-page 캐넌 일관성·와이어 0-diff·R-표 전수. 보안 게이트는 path-gate grep 예상 N/A(요청실행/템플릿/env/업로드/trace 무접촉)·finish-slice §0에서 재확인.
- [ ] **F. 문서**: roadmap §B12 완료 이동+연기 적재(spec §7)·roadmap-status frontier 갱신(**"토대 이미 존재" 전제 반증 교정 포함**)·build-log 단락·루트 CLAUDE.md 상태줄 교체(Python 스플라이스)·`ui/src/components/ui/CLAUDE.md`에 PageSection 용도 한 줄(폼 `Section`과 구분 — "표시 섹션은 PageSection, 폼 fieldset은 Section").
