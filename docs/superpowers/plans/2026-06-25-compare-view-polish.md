# 비교 뷰 폴리시 묶음 (compare-view-polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비교 뷰의 두 매트릭스(CompareMatrix·InsightCompareMatrix) 헤더에 오버레이 라인 색과 동일한 per-run 색 스와치를 달고, InsightCompareMatrix의 인라인 `#slice(-6)`을 공유 `runShortLabel` 헬퍼로 수렴시킨다(공유 `runColor` 팔레트 단일소스 경유).

**Architecture:** `overlaySeries.ts`의 module-private `RUN_COLORS`(5색·위치 인덱스 팔레트)와 `runColor(index)` accessor를 `runLabel.ts`(run 표시 정체성 단일소스)로 추출. 두 매트릭스가 `runColor(i)`로 장식(`aria-hidden`) 스와치를 렌더. 매트릭스 열 `i`·오버레이 라인 `i`가 같은 `runIds` 순서라 색 매칭은 by-construction. UI-only·read-only.

**Tech Stack:** React + TypeScript + Tailwind, vitest + @testing-library/react + @testing-library/jest-dom.

## Global Constraints

이 섹션은 모든 task에 암묵적으로 적용된다(spec 불변식 R1–R7).

- **UI-only·read-only.** 다음은 **0-diff**: `ui/src/i18n/ko.ts`·`ui/src/api/schemas.ts`·`ui/src/api/client.ts`·`ui/src/api/hooks.ts`·`crates/**`·proto·migration. (이미 파싱된 `Report`/`CompareResult`만 소비.)
- **색 단일소스(R1):** 이 슬라이스 후 `RUN_COLORS` 배열은 `ui/src/compare/runLabel.ts`에만 존재한다(grep 불변식). 다른 곳에 팔레트 리터럴 복제 금지.
- **오버레이 라인 색 byte-identical(R2):** 팔레트 *이동*만, 값/순서 불변. 기존 `overlaySeries` 출력 색 동일.
- **스와치 a11y(R4):** 스와치는 `aria-hidden="true"` 장식 `<span>` — 텍스트·`title`·`aria-label` **없음**(있으면 accessible name 오염 + ADR-0035상 ko.ts 필요 → R6 깨짐). 의미는 텍스트 라벨이 전달(색 단독 금지).
- **tdd-guard 순서:** **각 task에서 test-path 파일(`__tests__/`·`*.test.tsx`)을 먼저 편집**해 pending RED diff를 만든 뒤 `ui/src`의 non-test 파일을 편집한다(`ui/CLAUDE.md` 빌드-게이트 함정 — src-먼저면 첫 src 편집이 `[tdd-guard] Blocked`). import 미해결로 RED여도 무방.
- **스와치 색 단언 = `toHaveStyle({ backgroundColor: runColor(i) })`** (실측 근거): 이 repo jsdom은 inline `style={{backgroundColor:"#2563eb"}}`를 `getAttribute("style")`에서 `"background-color: rgb(37, 99, 235);"`로 직렬화한다 → **`getAttribute("style").includes("#2563eb")`(hex contains)는 항상 실패하니 쓰지 말 것**. `toHaveStyle`은 jest-dom이 expected hex를 같은 CSSOM으로 `rgb()` 정규화해 like-for-like 비교(probe로 확인). `data-testid`/`title` 금지.
- **커밋:** 각 task는 독립 green 커밋. 커밋 전 **`cd ui && pnpm lint && pnpm test && pnpm build`** 전부 green(eslint `--max-warnings=0`·`tsc -b`까지). `git commit`은 `run_in_background:false` 단일 호출(폴링 금지). pre-commit이 UI 게이트를 재실행한다(cargo는 cargo-경로 미staged라 skip).
- **subagent 리포트 경로:** `.superpowers/sdd/` (worktree 루트에 `.md` 쓰지 말 것·명시 `git add`만).

---

## File Structure

| 파일 | 책임 | task |
|---|---|---|
| `ui/src/compare/runLabel.ts` | run 표시 정체성: `runShortLabel(id)` + `RUN_COLORS`/`runColor(index)` (단일소스) | 1 |
| `ui/src/compare/overlaySeries.ts` | 로컬 팔레트 제거 → `runColor` import (색 byte-identical) | 1 |
| `ui/src/compare/__tests__/runLabel.test.ts` | `runColor` 단위(팔레트 값 락인·modulo) | 1 |
| `ui/src/compare/__tests__/overlaySeries.test.ts` | 색 byte-identical 락인 추가 | 1 |
| `ui/src/components/compare/CompareMatrix.tsx` | 헤더 버튼에 `runColor(i)` 스와치 | 2 |
| `ui/src/components/compare/__tests__/CompareMatrix.test.tsx` | 스와치 존재·색 단언 | 2 |
| `ui/src/components/compare/InsightCompareMatrix.tsx` | 헤더 스와치 + 인라인 라벨 → `runShortLabel` | 3 |
| `ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx` | 수렴·스와치 단언 | 3 |

---

## Task 1: 색 팔레트 단일소스 추출 (`runColor`)

**Files:**
- Modify: `ui/src/compare/runLabel.ts`
- Modify: `ui/src/compare/overlaySeries.ts:3,10-11,27`
- Create: `ui/src/compare/__tests__/runLabel.test.ts`
- Modify: `ui/src/compare/__tests__/overlaySeries.test.ts:3,36`

**Interfaces:**
- Produces: `export function runColor(index: number): string` in `ui/src/compare/runLabel.ts` — returns `RUN_COLORS[index % RUN_COLORS.length]`, `RUN_COLORS = ["#2563eb","#dc2626","#16a34a","#d97706","#7c3aed"]`. (`runShortLabel(id)` unchanged.)
- Consumes: 없음(신규 의존성 없음).

- [ ] **Step 1: 실패 테스트 작성 (test-path 먼저 — tdd-guard)**

Create `ui/src/compare/__tests__/runLabel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runColor } from "../runLabel";

describe("runColor", () => {
  const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];

  it("maps each index to the stable per-index palette", () => {
    PALETTE.forEach((hex, i) => expect(runColor(i)).toBe(hex));
  });

  it("wraps modulo the palette length (defensive — compare caps at 5 runs)", () => {
    expect(runColor(5)).toBe(runColor(0));
    expect(runColor(6)).toBe(runColor(1));
  });
});
```

Modify `ui/src/compare/__tests__/overlaySeries.test.ts` — change the import on line 3:

```ts
import { runColor, runShortLabel } from "../runLabel";
```

and add the byte-identical color lockin immediately after line 36 (`expect(runs[0].color).not.toBe(runs[1].color);`), inside the same `it(...)`:

```ts
    expect(runs[0].color).toBe(runColor(0));
    expect(runs[1].color).toBe(runColor(1));
```

- [ ] **Step 2: 테스트 실행해 RED 확인**

Run: `cd ui && pnpm test src/compare/__tests__`
Expected: `runLabel.test.ts`·`overlaySeries.test.ts` FAIL — `runColor` is not exported from `../runLabel` (`compareReports.test.ts`는 통과).

- [ ] **Step 3: `runColor` 구현 — `runLabel.ts`**

Replace the entire contents of `ui/src/compare/runLabel.ts` with:

```ts
// runLabel.ts — run 표시 정체성(짧은 라벨 + 위치-인덱스 색)을 비교 매트릭스 헤더와
// 오버레이 범례가 공유해 두 표면이 절대 어긋나지 않게 하는 단일 소스(spec R1/R5).
export function runShortLabel(id: string): string {
  return `#${id.slice(-6)}`;
}

// 비교 뷰는 상류(ScenarioRunsPage)에서 5개 run으로 상한 → modulo는 실제로 순환 안 함(방어적).
const RUN_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];

export function runColor(index: number): string {
  return RUN_COLORS[index % RUN_COLORS.length];
}
```

- [ ] **Step 4: `overlaySeries.ts`가 `runColor`를 쓰게 변경 (색 byte-identical)**

In `ui/src/compare/overlaySeries.ts`:

1. Change the import on line 3 from:
```ts
import { runShortLabel } from "./runLabel";
```
to:
```ts
import { runColor, runShortLabel } from "./runLabel";
```

2. Delete the local palette (lines 10–11):
```ts
// Stable per-index palette (compare view is capped at 5 runs upstream).
const RUN_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];
```

3. Change the color assignment on line 27 from:
```ts
    color: RUN_COLORS[i % RUN_COLORS.length],
```
to:
```ts
    color: runColor(i),
```

- [ ] **Step 5: 테스트 실행해 GREEN 확인**

Run: `cd ui && pnpm test src/compare/__tests__`
Expected: PASS — `runLabel.test.ts`(2)·`overlaySeries.test.ts`(3, 색 락인 포함)·`compareReports.test.ts` 전부 green.

- [ ] **Step 6: 색 단일소스 grep 불변식 (R1)**

Run: `cd ui && grep -rn "RUN_COLORS" src`
Expected: **단 한 줄** — `src/compare/runLabel.ts`의 `const RUN_COLORS = ...`. `overlaySeries.ts`·다른 곳에 `RUN_COLORS` 없음. (매치가 1개가 아니면 잔존 복제가 있는 것.)

- [ ] **Step 7: 전체 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 green(lint 0 warning·`tsc -b`+vite build 성공).

```bash
git add ui/src/compare/runLabel.ts ui/src/compare/overlaySeries.ts ui/src/compare/__tests__/runLabel.test.ts ui/src/compare/__tests__/overlaySeries.test.ts
git commit -m "refactor(ui): runColor 팔레트 단일소스 추출(매트릭스↔오버레이 공유)"
```

---

## Task 2: CompareMatrix 헤더 색 스와치

**Files:**
- Modify: `ui/src/components/compare/CompareMatrix.tsx:3,136-149`
- Modify: `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`

**Interfaces:**
- Consumes: `runColor(index)` from `ui/src/compare/runLabel.ts` (Task 1).
- Produces: 없음(소비처 변경 없음 — 같은 props).

- [ ] **Step 1: 실패 테스트 작성 (test-path 먼저)**

In `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`, add an import near the top (after line 5 `import type { CompareResult } ...`):

```ts
import { runColor } from "../../../compare/runLabel";
```

Add this test inside the existing `describe("CompareMatrix", () => { ... })` block (after the last `it`, before the block's closing `});` on line 105):

```ts
  it("renders a per-run color swatch in each header matching the overlay palette (spec §3.2/R3)", () => {
    render(
      <CompareMatrix result={result} labels={{ A: "#A", B: "#B" }} onBaselineChange={() => {}} />,
    );
    const colA = screen.getByRole("button", { name: /#A/ });
    const colB = screen.getByRole("button", { name: /#B/ });
    const swatchA = colA.querySelector('span[aria-hidden="true"]');
    const swatchB = colB.querySelector('span[aria-hidden="true"]');
    expect(swatchA).not.toBeNull();
    expect(swatchB).not.toBeNull();
    expect(swatchA).toHaveStyle({ backgroundColor: runColor(0) });
    expect(swatchB).toHaveStyle({ backgroundColor: runColor(1) });
  });
```

> 참고: `result` fixture는 `baselineIdx: 0`이라 A열 버튼 accname = `"#A (base)"`(정규식 `/#A/` 매치). `(base)` `<span>`은 `aria-hidden`이 아니므로 `querySelector('span[aria-hidden="true"]')`는 스와치만 잡는다.

- [ ] **Step 2: 테스트 실행해 RED 확인**

Run: `cd ui && pnpm test CompareMatrix`
Expected: 새 스와치 테스트 FAIL(`swatchA`/`swatchB` = null — 아직 스와치 없음). 기존 테스트는 통과.

- [ ] **Step 3: 스와치 구현 — `CompareMatrix.tsx`**

Add an import after line 3 (`import { ko } from "../../i18n/ko";`):

```ts
import { runColor } from "../../compare/runLabel";
```

Replace the header column map (lines 136–149) with:

```tsx
            {runIds.map((runId, i) => (
              <th key={runId} className="py-2 pr-4 font-medium">
                <button
                  type="button"
                  onClick={() => onBaselineChange(runId)}
                  className="inline-flex items-center gap-1.5 hover:underline text-left"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block w-3 h-3 rounded-sm ring-1 ring-black/10 dark:ring-white/20 shrink-0"
                    style={{ backgroundColor: runColor(i) }}
                  />
                  {labels[runId] ?? runId}
                  {i === baselineIdx && (
                    <span className="ml-1 text-xs text-slate-500 font-normal">(base)</span>
                  )}
                </button>
              </th>
            ))}
```

- [ ] **Step 4: 테스트 실행해 GREEN 확인**

Run: `cd ui && pnpm test CompareMatrix`
Expected: PASS — 스와치 테스트 + 기존 verdict-polarity·colgroup·baseline-전환 테스트 전부 green.

- [ ] **Step 5: 전체 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 green.

```bash
git add ui/src/components/compare/CompareMatrix.tsx ui/src/components/compare/__tests__/CompareMatrix.test.tsx
git commit -m "feat(ui): 비교 매트릭스 헤더 색 스와치(열↔오버레이 라인 연동)"
```

---

## Task 3: InsightCompareMatrix 헤더 스와치 + 라벨 수렴

**Files:**
- Modify: `ui/src/components/compare/InsightCompareMatrix.tsx:2,69-76`
- Modify: `ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx`

**Interfaces:**
- Consumes: `runColor(index)`·`runShortLabel(id)` from `ui/src/compare/runLabel.ts` (Task 1).

> **수렴은 byte-identical 리팩터**: 인라인 `` `#${r.run.id.slice(-6)}` ``와 `runShortLabel(id)`는 같은 문자열을 만든다 → 라벨-렌더 테스트는 **변경 전후 모두 green**(characterization). 따라서 이 task의 RED→GREEN은 **스와치 테스트**가 구동하고, 수렴의 teeth는 Step 5의 **grep 불변식**(`slice(-6)` 제거)이 담당한다.

- [ ] **Step 1: 실패/특성화 테스트 작성 (test-path 먼저)**

In `ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx`, add an import after line 4 (`import type { Insight } ...`):

```ts
import { runColor, runShortLabel } from "../../../compare/runLabel";
```

Add these two tests inside the existing `describe("InsightCompareMatrix", () => { ... })` block (after the last `it`, before the block's closing `});` on line 73):

```ts
  it("헤더 라벨은 labels 미주입 시 runShortLabel로 수렴 (인라인 slice 제거, R5)", () => {
    const reports = [
      { run: { id: "RUNAAAAAA" }, insights: [] },
      { run: { id: "RUNBBBBBB" }, insights: [ins({ kind: "slo_pass", severity: "info" })] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByText(runShortLabel("RUNAAAAAA"))).toBeInTheDocument();
    expect(screen.getByText(runShortLabel("RUNBBBBBB"))).toBeInTheDocument();
  });

  it("각 run 헤더에 색 스와치(runColor[i])", () => {
    const reports = [
      { run: { id: "RUNAAAAAA" }, insights: [ins({ kind: "slo_pass", severity: "info" })] },
      { run: { id: "RUNBBBBBB" }, insights: [] },
    ];
    const { container } = render(
      <InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />,
    );
    const swatches = container.querySelectorAll('thead span[aria-hidden="true"]');
    expect(swatches).toHaveLength(2);
    expect(swatches[0]).toHaveStyle({ backgroundColor: runColor(0) });
    expect(swatches[1]).toHaveStyle({ backgroundColor: runColor(1) });
  });
```

- [ ] **Step 2: 테스트 실행해 RED 확인**

Run: `cd ui && pnpm test InsightCompareMatrix`
Expected: 스와치 테스트 FAIL(`thead span[aria-hidden]` = 0개). 라벨-수렴 테스트는 byte-identical이라 이미 PASS(특성화), 기존 3 테스트도 PASS.

- [ ] **Step 3: 스와치 + 수렴 구현 — `InsightCompareMatrix.tsx`**

Add an import after line 2 (`import { ko } from "../../i18n/ko";`):

```ts
import { runColor, runShortLabel } from "../../compare/runLabel";
```

Replace the header run-column map (lines 69–76) with:

```tsx
              {reports.map((r, i) => (
                <th
                  key={r.run.id}
                  className="px-2 py-1 border-b border-slate-200 dark:border-slate-700 text-center"
                >
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="inline-block w-3 h-3 rounded-sm ring-1 ring-black/10 dark:ring-white/20 shrink-0"
                      style={{ backgroundColor: runColor(i) }}
                    />
                    {labels?.[r.run.id] ?? runShortLabel(r.run.id)}
                  </span>
                </th>
              ))}
```

- [ ] **Step 4: 테스트 실행해 GREEN 확인**

Run: `cd ui && pnpm test InsightCompareMatrix`
Expected: PASS — 스와치·라벨-수렴 + 기존 3 테스트 전부 green.

- [ ] **Step 5: 수렴 grep 불변식 (R5)**

Run: `cd ui && grep -n "slice(-6)" src/components/compare/InsightCompareMatrix.tsx`
Expected: **매치 없음**(exit 1). 인라인 `#${id.slice(-6)}` 제거 확인. (코드베이스에서 `slice(-6)`은 이제 `src/compare/runLabel.ts`의 헬퍼 정의 한 곳만 — `grep -rn "slice(-6)" src` 로 교차 확인 시 그 한 줄.)

- [ ] **Step 6: 전체 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 green.

```bash
git add ui/src/components/compare/InsightCompareMatrix.tsx ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx
git commit -m "feat(ui): 인사이트 비교 매트릭스 헤더 색 스와치 + runShortLabel 수렴"
```

---

## 최종 검증 (전 task 후 orchestrator 직접 실행)

- [ ] 색 단일소스: `cd ui && grep -rn "RUN_COLORS" src` → `runLabel.ts` 1줄만.
- [ ] 수렴: `cd ui && grep -rn "slice(-6)" src` → `runLabel.ts` 1줄만(InsightCompareMatrix 0).
- [ ] 0-diff 확인: `git diff --name-only master..HEAD` → `ui/src/compare/*`·`ui/src/components/compare/*`·`docs/superpowers/*`만. `ko.ts`·`schemas.ts`·`client.ts`·`hooks.ts`·`crates/`·`*.sql`·`*.proto` **부재**.
- [ ] 전체 UI 게이트 1회: `cd ui && pnpm lint && pnpm test && pnpm build` green.
- [ ] handicap-reviewer(크로스커팅·repo 함정) APPROVE.
- [ ] 라이브 검증 **WAIVED**(spec §1/R6 — production diff가 비교 뷰 렌더에 한정, run-create/report-parse·schemas.ts 무관 = S-D 갭 구조적 부재). 근거를 build-log에.

## Self-review 결과 (작성자 점검)

- **Spec 커버리지**: §3.1→Task1(R1/R2), §3.2→Task2(R3/R4), §3.3→Task3(R5). R6(0-diff)=파일 목록+최종 grep, R7(오버레이 색 로직 불변)=Task1이 import 소스만 변경(`CompareTimeSeriesChart`/`CompareOverlaySection` 0-diff). §7 연기 항목은 task 없음(의도적).
- **Placeholder**: 없음(전 step 실제 코드/명령).
- **타입 일관성**: `runColor(index: number): string`·`runShortLabel(id: string): string` 세 task에서 동일 시그니처.

REVIEW-GATE: APPROVED

