# Run 비교 뷰 깊이 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비교 뷰에 per-second 멀티-run 시계열 오버레이(다중-선택 메트릭 피커)와 verdict 행 baseline-상대 polarity(악화/개선)를 read-only로 추가한다.

**Architecture:** 순수 헬퍼(`bySecond` 추출·`overlaySeries`·`runShortLabel`·`verdictPolarity`) → 멀티-라인 차트(`CompareTimeSeriesChart`, `TimeSeriesChart` 패턴) → 배선(`CompareOverlaySection` 피커+스택을 `ScenarioComparePage`에 마운트·`CompareMatrix` verdict 행 polarity). 이미 파싱된 `report.windows`·`CompareResult.verdict.passed`만 소비 — 와이어/스키마 0-diff.

**Tech Stack:** TypeScript/React, Recharts(LineChart), Zustand 무관, vitest + @testing-library/react, `ko.ts` 메시지 카탈로그(ADR-0035).

**spec:** `docs/superpowers/specs/2026-06-25-compare-view-depth-design.md` (R1–R12).

## Global Constraints

- **UI-only·read-only**: `crates/**`(엔진·controller·proto·migration·`export.rs`)·`testdata/compare_golden.json`·`ui/src/api/schemas.ts`·`ui/src/api/client.ts`·`ui/src/api/hooks.ts` **0-diff**. run payload·report wire **byte-identical**(R10·R12). 매 커밋 `git diff --name-only`로 확인.
- **`ActiveVuChart.tsx` 0-diff** (R2 — 오버레이는 신규 `CompareTimeSeriesChart`).
- **모든 신규 사용자-노출 문구는 `ko.ts` 경유** (ADR-0035·R9). Δ% 전용 `ko.compare.worseAria/betterAria`는 verdict polarity에 **재사용 안 함**(가시 라벨 텍스트가 접근명).
- **TDD-guard 순서**(루트 C-1·ui/CLAUDE.md): 각 task의 **첫 편집은 test-path 파일**(`__tests__/*.test.ts(x)`)이어야 한다 — src(non-test) 편집 전 pending RED diff 필요. import 미해결로 RED여도 무방.
- **`pnpm build`(`tsc -b && vite build`)가 최종 게이트** — `pnpm test`(esbuild)는 TS strict 에러를 놓친다. 각 task 끝 `pnpm lint && pnpm test && pnpm build` 셋 다 green 후 커밋(`pnpm lint`=`--max-warnings=0`).
- **Recharts+jsdom 함정**: 차트는 **고정-기본 `width`/`height`**(ResponsiveContainer 없음=size-0 회피); `<Legend>` 항목은 **텍스트로** 식별(인덱스 금지); `<Tooltip>`은 hover라 jsdom 무관(formatter는 tsc/리뷰로).
- **단일 파일 빠른 반복**: `pnpm test <name>`(`--` 없이) = 그 1파일만. 머지 전 인자 없는 전체 `pnpm test` 1회.

---

## File Structure

| 파일 | 책임 | task |
|---|---|---|
| `ui/src/report/bySecond.ts` (신규) | `Report.windows` → 초당 `{ts_second,count,errors,p95_ms}` 도출(단일 소스) | 1 |
| `ui/src/compare/runLabel.ts` (신규) | `runShortLabel(id)` = `#`+마지막 6자(매트릭스·오버레이 공유) | 1 |
| `ui/src/compare/overlaySeries.ts` (신규) | run별 bySecond를 t=0 정규화·병합한 Recharts rows + run 메타 | 1 |
| `ui/src/compare/compareReports.ts` (수정) | `verdictPolarity(boolean\|null, boolean\|null)` 추가 | 1 |
| `ui/src/components/report/ReportView.tsx` (수정) | 내부 `bySecond`/`Sec` 삭제 → `report/bySecond` import | 1 |
| `ui/src/components/compare/CompareTimeSeriesChart.tsx` (신규) | 멀티-라인 시계열(run당 1라인·범례·`TimeSeriesChart` 패턴) | 2 |
| `ui/src/components/compare/CompareOverlaySection.tsx` (신규) | 메트릭 다중-선택 피커 + 선택 메트릭마다 차트 세로 스택 | 3 |
| `ui/src/pages/ScenarioComparePage.tsx` (수정) | 오버레이 섹션 마운트 + `runLabels`를 `runShortLabel`로 | 3 |
| `ui/src/components/compare/CompareMatrix.tsx` (수정) | verdict 행에 polarity 글리프+라벨 | 4 |
| `ui/src/i18n/ko.ts` (수정) | `ko.compare` 신규 키(오버레이=task3·verdict=task4) | 3,4 |

---

## Task 1: 순수 헬퍼 + verdict polarity — R: R4·R5·R6·R7

**Files:**
- Create: `ui/src/report/bySecond.ts`
- Create: `ui/src/compare/runLabel.ts`
- Create: `ui/src/compare/overlaySeries.ts`
- Modify: `ui/src/compare/compareReports.ts` (append `verdictPolarity`)
- Modify: `ui/src/components/report/ReportView.tsx:27-46` (remove inline `Sec`/`bySecond`) + import
- Test: `ui/src/report/__tests__/bySecond.test.ts` (new)
- Test: `ui/src/compare/__tests__/overlaySeries.test.ts` (new)
- Test: `ui/src/compare/__tests__/compareReports.test.ts` (append describe block)
- (Unchanged, must still pass) `ui/src/components/report/__tests__/ReportView.test.tsx`

**Interfaces:**
- Produces:
  - `bySecond(report: Report): Sec[]`, `type Sec = { ts_second: number; count: number; errors: number; p95_ms: number }`
  - `runShortLabel(id: string): string`
  - `overlaySeries(reports: Report[], baselineIdx: number, metric: MetricKey): OverlaySeries`; `type MetricKey = "rps" | "p95" | "errors"`; `type OverlayRun = { key: string; label: string; color: string; baseline: boolean }`; `type OverlayRow = { elapsed: number } & Record<string, number | null>`; `type OverlaySeries = { rows: OverlayRow[]; runs: OverlayRun[] }`
  - `verdictPolarity(baselinePassed: boolean | null, candidatePassed: boolean | null): Polarity` (`Polarity` = existing `"good"|"bad"|"neutral"` from compareReports.ts:3)

- [ ] **Step 1: Write failing tests for `bySecond` (test file first — TDD-guard)**

Create `ui/src/report/__tests__/bySecond.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { bySecond } from "../bySecond";
import type { Report } from "../../api/schemas";

function rep(
  windows: Array<{ ts_second: number; count: number; error_count: number; p95_ms: number }>,
): Report {
  return { windows } as unknown as Report;
}

describe("bySecond", () => {
  it("sums count/errors across steps in the same second and takes max p95", () => {
    const out = bySecond(
      rep([
        { ts_second: 100, count: 5, error_count: 1, p95_ms: 50 },
        { ts_second: 100, count: 3, error_count: 0, p95_ms: 80 },
        { ts_second: 101, count: 2, error_count: 2, p95_ms: 40 },
      ]),
    );
    expect(out).toEqual([
      { ts_second: 100, count: 8, errors: 1, p95_ms: 80 },
      { ts_second: 101, count: 2, errors: 2, p95_ms: 40 },
    ]);
  });

  it("returns empty for no windows and sorts ascending by second", () => {
    expect(bySecond(rep([]))).toEqual([]);
    const out = bySecond(
      rep([
        { ts_second: 200, count: 1, error_count: 0, p95_ms: 10 },
        { ts_second: 100, count: 1, error_count: 0, p95_ms: 10 },
      ]),
    );
    expect(out.map((s) => s.ts_second)).toEqual([100, 200]);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `pnpm test bySecond`
Expected: FAIL ("Cannot find module '../bySecond'").

- [ ] **Step 3: Create `ui/src/report/bySecond.ts` (verbatim move from ReportView.tsx:27-46)**

```ts
import type { Report } from "../api/schemas";

export type Sec = { ts_second: number; count: number; errors: number; p95_ms: number };

export function bySecond(report: Report): Sec[] {
  const buckets = new Map<number, Sec>();
  for (const w of report.windows) {
    const cur = buckets.get(w.ts_second) ?? {
      ts_second: w.ts_second,
      count: 0,
      errors: 0,
      p95_ms: 0,
    };
    cur.count += w.count;
    cur.errors += w.error_count;
    // For p95 time series, use the max across steps in the same second as a coarse signal.
    // Per-second per-step p95 charts are deferred (ADR-0017 OUT: percentile histogram view).
    if (w.p95_ms > cur.p95_ms) cur.p95_ms = w.p95_ms;
    buckets.set(w.ts_second, cur);
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts_second - b.ts_second);
}
```

- [ ] **Step 4: Point `ReportView.tsx` at the shared helper (byte-identical behavior, R6)**

In `ui/src/components/report/ReportView.tsx`: **delete** lines 27-46 (the `type Sec = …` and the whole `function bySecond(report) { … }`). Add to the import block (after line 10 `import { TimeSeriesChart } …`):

```ts
import { bySecond } from "../../report/bySecond";
```

(The `const seconds = useMemo(() => bySecond(report), [report]);` at line 49 now uses the imported `bySecond` — no other change.)

- [ ] **Step 5: Run `bySecond` test + existing ReportView test — both pass**

Run: `pnpm test bySecond` → PASS.
Run: `pnpm test ReportView` → PASS (unchanged — R6 byte-identical).

- [ ] **Step 6: Write failing test for `runShortLabel` + `overlaySeries` (test file first)**

Create `ui/src/compare/__tests__/overlaySeries.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { overlaySeries } from "../overlaySeries";
import { runShortLabel } from "../runLabel";
import type { Report } from "../../api/schemas";

function rep(
  id: string,
  windows: Array<{ ts_second: number; count: number; error_count: number; p95_ms: number }>,
): Report {
  return { run: { id }, windows } as unknown as Report;
}

describe("runShortLabel", () => {
  it("is the hash + last 6 chars of the id", () => {
    expect(runShortLabel("01HXXXXXXXXXXABCDEF")).toBe("#ABCDEF");
  });
});

describe("overlaySeries", () => {
  it("normalizes each run to its own t=0 and merges by elapsed with null gaps", () => {
    const a = rep("aaaaaa111111", [
      { ts_second: 1000, count: 10, error_count: 0, p95_ms: 5 },
      { ts_second: 1001, count: 12, error_count: 0, p95_ms: 6 },
    ]);
    const b = rep("bbbbbb222222", [{ ts_second: 5000, count: 20, error_count: 0, p95_ms: 9 }]);
    const { rows, runs } = overlaySeries([a, b], 0, "rps");
    expect(rows).toEqual([
      { elapsed: 0, run0: 10, run1: 20 },
      { elapsed: 1, run0: 12, run1: null },
    ]);
    expect(runs.map((r) => r.key)).toEqual(["run0", "run1"]);
    expect(runs[0].baseline).toBe(true);
    expect(runs[1].baseline).toBe(false);
    expect(runs[0].label).toBe("#111111");
    expect(runs[1].label).toBe("#222222");
    expect(runs[0].color).not.toBe(runs[1].color);
  });

  it("selects the requested metric", () => {
    const a = rep("aaaaaa111111", [{ ts_second: 1000, count: 10, error_count: 3, p95_ms: 7 }]);
    expect(overlaySeries([a], 0, "errors").rows[0].run0).toBe(3);
    expect(overlaySeries([a], 0, "p95").rows[0].run0).toBe(7);
    expect(overlaySeries([a], 0, "rps").rows[0].run0).toBe(10);
  });
});
```

- [ ] **Step 7: Run test — verify it fails**

Run: `pnpm test overlaySeries`
Expected: FAIL ("Cannot find module '../overlaySeries'").

- [ ] **Step 8: Create `ui/src/compare/runLabel.ts`**

```ts
// Short human-readable run label, shared by the compare matrix headers and the
// overlay legend so the two never drift (spec R5).
export function runShortLabel(id: string): string {
  return `#${id.slice(-6)}`;
}
```

- [ ] **Step 9: Create `ui/src/compare/overlaySeries.ts`**

```ts
import type { Report } from "../api/schemas";
import { bySecond, type Sec } from "../report/bySecond";
import { runShortLabel } from "./runLabel";

export type MetricKey = "rps" | "p95" | "errors";
export type OverlayRun = { key: string; label: string; color: string; baseline: boolean };
export type OverlayRow = { elapsed: number } & Record<string, number | null>;
export type OverlaySeries = { rows: OverlayRow[]; runs: OverlayRun[] };

// Stable per-index palette (compare view is capped at 5 runs upstream).
const RUN_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];

function metricValue(s: Sec, metric: MetricKey): number {
  if (metric === "rps") return s.count;
  if (metric === "errors") return s.errors;
  return s.p95_ms;
}

export function overlaySeries(
  reports: Report[],
  baselineIdx: number,
  metric: MetricKey,
): OverlaySeries {
  const runs: OverlayRun[] = reports.map((r, i) => ({
    key: `run${i}`,
    label: runShortLabel(r.run.id),
    color: RUN_COLORS[i % RUN_COLORS.length],
    baseline: i === baselineIdx,
  }));

  // Merge by elapsed-second (each run normalized to its own first window = t0).
  const byElapsed = new Map<number, Record<string, number>>();
  reports.forEach((r, i) => {
    const secs = bySecond(r);
    if (secs.length === 0) return;
    const t0 = secs[0].ts_second;
    for (const s of secs) {
      const elapsed = s.ts_second - t0;
      const row = byElapsed.get(elapsed) ?? {};
      row[`run${i}`] = metricValue(s, metric);
      byElapsed.set(elapsed, row);
    }
  });

  const rows: OverlayRow[] = Array.from(byElapsed.keys())
    .sort((a, b) => a - b)
    .map((elapsed) => {
      const filled = byElapsed.get(elapsed)!;
      const row: OverlayRow = { elapsed };
      for (const run of runs) row[run.key] = run.key in filled ? filled[run.key] : null;
      return row;
    });

  return { rows, runs };
}
```

- [ ] **Step 10: Run test — verify it passes**

Run: `pnpm test overlaySeries`
Expected: PASS.

- [ ] **Step 11: Append failing test for `verdictPolarity` (same existing test file)**

Append to `ui/src/compare/__tests__/compareReports.test.ts` (add the import to the top `import { compareReports, computeDelta } from "../compareReports";` → `import { compareReports, computeDelta, verdictPolarity } from "../compareReports";`, then add at end of file):

```ts
describe("verdictPolarity (baseline-relative, spec R7)", () => {
  it("baseline PASS & candidate FAIL → bad (악화)", () => {
    expect(verdictPolarity(true, false)).toBe("bad");
  });
  it("baseline FAIL & candidate PASS → good (개선)", () => {
    expect(verdictPolarity(false, true)).toBe("good");
  });
  it("equal verdicts → neutral", () => {
    expect(verdictPolarity(true, true)).toBe("neutral");
    expect(verdictPolarity(false, false)).toBe("neutral");
  });
  it("null on either side → neutral", () => {
    expect(verdictPolarity(null, false)).toBe("neutral");
    expect(verdictPolarity(true, null)).toBe("neutral");
    expect(verdictPolarity(null, null)).toBe("neutral");
  });
});
```

- [ ] **Step 12: Run test — verify it fails**

Run: `pnpm test compareReports`
Expected: FAIL ("verdictPolarity is not a function" / no export).

- [ ] **Step 13: Add `verdictPolarity` to `ui/src/compare/compareReports.ts` (append after `computeDelta`, before `summaryValue`)**

```ts
// Baseline-relative verdict polarity for the compare verdict row (spec R7).
// UI-only — NOT part of the computeDelta/export.rs golden parity (R12).
export function verdictPolarity(
  baselinePassed: boolean | null,
  candidatePassed: boolean | null,
): Polarity {
  if (baselinePassed === null || candidatePassed === null) return "neutral";
  if (baselinePassed === candidatePassed) return "neutral";
  // They differ: candidate passing while baseline failed = 개선; the reverse = 악화.
  return candidatePassed ? "good" : "bad";
}
```

- [ ] **Step 14: Run test — verify it passes**

Run: `pnpm test compareReports`
Expected: PASS (golden parity tests + new verdictPolarity describe).

- [ ] **Step 15: Full gate + diff guard**

Run: `pnpm lint && pnpm test && pnpm build` — all green.
Run: `git diff --name-only` — only `ui/src/report/bySecond.ts`, `ui/src/compare/{runLabel,overlaySeries,compareReports}.ts`, `ui/src/components/report/ReportView.tsx`, the three test files. **No** `schemas.ts`/`client.ts`/`crates/**`/`export.rs`/`compare_golden.json`.

- [ ] **Step 16: Commit**

```bash
git add ui/src/report/bySecond.ts ui/src/report/__tests__/bySecond.test.ts \
  ui/src/compare/runLabel.ts ui/src/compare/overlaySeries.ts ui/src/compare/compareReports.ts \
  ui/src/compare/__tests__/overlaySeries.test.ts ui/src/compare/__tests__/compareReports.test.ts \
  ui/src/components/report/ReportView.tsx
git commit -m "feat(ui): compare overlay pure helpers + verdict polarity (bySecond/overlaySeries/runShortLabel/verdictPolarity)"
```

---

## Task 2: `CompareTimeSeriesChart` 멀티-라인 차트 — R: R2·R11

**Files:**
- Create: `ui/src/components/compare/CompareTimeSeriesChart.tsx`
- Test: `ui/src/components/compare/__tests__/CompareTimeSeriesChart.test.tsx` (new)

**Interfaces:**
- Consumes: `OverlayRow`, `OverlayRun` (Task 1), `ko.compare.overlayBaselineLabel` / `ko.report.timeSeriesAria` (Task 3 adds `overlayBaselineLabel`; until then the test uses a literal — see note). 
- **Ordering note:** `ko.compare.overlayBaselineLabel` is added in Task 3 Step 1. To keep Task 2 self-contained and green, **add that one ko key as the first edit of Task 2** (Step 3 below) — it is consumed here. Task 3 then adds the remaining overlay keys.
- Produces: `CompareTimeSeriesChart({ title, yLabel, rows, runs, width?, height? })`.

- [ ] **Step 1: Write the failing test (test file first)**

Create `ui/src/components/compare/__tests__/CompareTimeSeriesChart.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompareTimeSeriesChart } from "../CompareTimeSeriesChart";
import type { OverlayRow, OverlayRun } from "../../../compare/overlaySeries";

const runs: OverlayRun[] = [
  { key: "run0", label: "#111111", color: "#2563eb", baseline: true },
  { key: "run1", label: "#222222", color: "#dc2626", baseline: false },
];
const rows: OverlayRow[] = [
  { elapsed: 0, run0: 10, run1: 20 },
  { elapsed: 1, run0: 12, run1: null },
];

describe("CompareTimeSeriesChart", () => {
  it("renders a labeled region with a legend entry per run, baseline tagged", () => {
    render(
      <CompareTimeSeriesChart
        title="초당 요청 수 (RPS)"
        yLabel="req/s"
        rows={rows}
        runs={runs}
        width={400}
        height={200}
      />,
    );
    // Region role from <section aria-label> wrapper.
    expect(screen.getByRole("region", { name: /초당 요청 수/ })).toBeInTheDocument();
    // Legend entries identified BY TEXT (not index — Recharts <li> trap, ui/CLAUDE.md).
    expect(screen.getByText("#111111 (기준)")).toBeInTheDocument();
    expect(screen.getByText("#222222")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `pnpm test CompareTimeSeriesChart`
Expected: FAIL ("Cannot find module '../CompareTimeSeriesChart'").

- [ ] **Step 3: Add the `overlayBaselineLabel` ko key (consumed by the chart)**

In `ui/src/i18n/ko.ts`, inside the `compare: { … }` object (currently ko.ts:951-955, ends with `neutralAria`), add after `neutralAria`:

```ts
    overlayBaselineLabel: (label: string) => `${label} (기준)`,
```

- [ ] **Step 4: Create `ui/src/components/compare/CompareTimeSeriesChart.tsx`**

```tsx
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ko } from "../../i18n/ko";
import type { OverlayRow, OverlayRun } from "../../compare/overlaySeries";

type Props = {
  title: string;
  yLabel: string;
  rows: OverlayRow[];
  runs: OverlayRun[];
  width?: number;
  height?: number;
};

// Multi-run per-second overlay. Mirrors report/TimeSeriesChart (fixed-default
// width/height, NO ResponsiveContainer → avoids the jsdom size-0 trap).
export function CompareTimeSeriesChart({
  title,
  yLabel,
  rows,
  runs,
  width = 720,
  height = 220,
}: Props) {
  return (
    <section aria-label={ko.report.timeSeriesAria(title)} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
      <LineChart width={width} height={height} data={rows}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="elapsed" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
        <YAxis label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
        <Tooltip />
        <Legend />
        {runs.map((run) => (
          <Line
            key={run.key}
            type="monotone"
            dataKey={run.key}
            name={run.baseline ? ko.compare.overlayBaselineLabel(run.label) : run.label}
            stroke={run.color}
            connectNulls={false}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </section>
  );
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `pnpm test CompareTimeSeriesChart`
Expected: PASS.

- [ ] **Step 6: Full gate + diff guard**

Run: `pnpm lint && pnpm test && pnpm build` — all green.
Run: `git diff --name-only` — only `CompareTimeSeriesChart.tsx`, its test, `ko.ts`. (No schemas/client/crates/ActiveVuChart.)

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/compare/CompareTimeSeriesChart.tsx \
  ui/src/components/compare/__tests__/CompareTimeSeriesChart.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): CompareTimeSeriesChart multi-run overlay chart (TimeSeriesChart pattern)"
```

---

## Task 3: 오버레이 섹션 + 페이지 배선 — R: R1·R3·R5·R9

**Files:**
- Create: `ui/src/components/compare/CompareOverlaySection.tsx`
- Modify: `ui/src/pages/ScenarioComparePage.tsx` (mount section + `runLabels`→`runShortLabel`)
- Modify: `ui/src/i18n/ko.ts` (`ko.compare`: overlay keys)
- Test: `ui/src/components/compare/__tests__/CompareOverlaySection.test.tsx` (new)
- Test: `ui/src/pages/__tests__/ScenarioComparePage.test.tsx` (append one assertion)

**Interfaces:**
- Consumes: `overlaySeries`, `MetricKey` (Task 1); `CompareTimeSeriesChart` (Task 2); `runShortLabel` (Task 1).
- Produces: `CompareOverlaySection({ reports, baselineIdx })`.

- [ ] **Step 1: Write the failing test for `CompareOverlaySection` (test file first — TDD-guard)**

Create `ui/src/components/compare/__tests__/CompareOverlaySection.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompareOverlaySection } from "../CompareOverlaySection";
import type { Report } from "../../../api/schemas";

function rep(id: string): Report {
  return {
    run: { id },
    windows: [
      { ts_second: 1000, step_id: "s", count: 10, error_count: 1, status_counts: {}, p50_ms: 4, p95_ms: 8, p99_ms: 9 },
      { ts_second: 1001, step_id: "s", count: 12, error_count: 0, status_counts: {}, p50_ms: 4, p95_ms: 9, p99_ms: 10 },
    ],
  } as unknown as Report;
}
const reports = [rep("aaaaaa111111"), rep("bbbbbb222222")];

describe("CompareOverlaySection", () => {
  it("defaults to req/s + p95 charts (errors off)", () => {
    render(<CompareOverlaySection reports={reports} baselineIdx={0} />);
    expect(screen.getByRole("region", { name: /초당 요청 수/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /p95/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /초당 에러/ })).not.toBeInTheDocument();
  });

  it("checking errors adds the errors chart; unchecking req/s removes it", async () => {
    const user = userEvent.setup();
    render(<CompareOverlaySection reports={reports} baselineIdx={0} />);
    await user.click(screen.getByRole("checkbox", { name: /초당 에러/ }));
    expect(screen.getByRole("region", { name: /초당 에러/ })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /초당 요청 수/ }));
    expect(screen.queryByRole("region", { name: /초당 요청 수/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `pnpm test CompareOverlaySection`
Expected: FAIL ("Cannot find module '../CompareOverlaySection'").

- [ ] **Step 3: Add overlay ko keys**

In `ui/src/i18n/ko.ts` `compare: { … }` (already has `overlayBaselineLabel` from Task 2), add:

```ts
    overlayTitle: "초당 시계열 비교",
    overlayMetricsAria: "오버레이 메트릭 선택",
    overlayNoData: "시계열 데이터가 없습니다.",
```

- [ ] **Step 4: Create `ui/src/components/compare/CompareOverlaySection.tsx`**

```tsx
import { useState } from "react";
import { ko } from "../../i18n/ko";
import type { Report } from "../../api/schemas";
import { overlaySeries, type MetricKey } from "../../compare/overlaySeries";
import { CompareTimeSeriesChart } from "./CompareTimeSeriesChart";

// Stable display order (independent of toggle order). Titles/yLabels reuse the
// single-run report chart catalog keys (DRY — same metric, same wording).
const OVERLAY_METRICS: { key: MetricKey; title: string; yLabel: string }[] = [
  { key: "rps", title: ko.report.timeSeriesRequests, yLabel: "req/s" },
  { key: "p95", title: ko.report.timeSeriesP95, yLabel: "ms" },
  { key: "errors", title: ko.report.timeSeriesErrors, yLabel: "errors" },
];

type Props = { reports: Report[]; baselineIdx: number };

export function CompareOverlaySection({ reports, baselineIdx }: Props) {
  const [metrics, setMetrics] = useState<MetricKey[]>(["rps", "p95"]);
  return (
    <section aria-label={ko.compare.overlayTitle} className="mt-8">
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <h3 className="text-lg font-semibold">{ko.compare.overlayTitle}</h3>
        <fieldset className="flex gap-3" aria-label={ko.compare.overlayMetricsAria}>
          {OVERLAY_METRICS.map((m) => (
            <label key={m.key} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={metrics.includes(m.key)}
                onChange={(e) =>
                  setMetrics((prev) =>
                    e.target.checked ? [...prev, m.key] : prev.filter((k) => k !== m.key),
                  )
                }
              />
              {m.title}
            </label>
          ))}
        </fieldset>
      </div>
      {OVERLAY_METRICS.filter((m) => metrics.includes(m.key)).map((m) => {
        const series = overlaySeries(reports, baselineIdx, m.key);
        return series.rows.length === 0 ? (
          <p key={m.key} role="status" className="text-sm text-slate-500 mb-4">
            {ko.compare.overlayNoData}
          </p>
        ) : (
          <CompareTimeSeriesChart
            key={m.key}
            title={m.title}
            yLabel={m.yLabel}
            rows={series.rows}
            runs={series.runs}
          />
        );
      })}
    </section>
  );
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `pnpm test CompareOverlaySection`
Expected: PASS.

- [ ] **Step 6: Wire the section + `runShortLabel` into `ScenarioComparePage.tsx`**

(a) Add imports (after line 9 `import { InsightCompareMatrix } …`):

```ts
import { CompareOverlaySection } from "../components/compare/CompareOverlaySection";
import { runShortLabel } from "../compare/runLabel";
```

(b) Replace the `runLabels` body (lines 146-152) — use the shared helper:

```tsx
  const runLabels = useMemo<Record<string, string>>(() => {
    const labels: Record<string, string> = {};
    for (const id of runIds) {
      labels[id] = runShortLabel(id);
    }
    return labels;
  }, [runIds]);
```

(c) Mount the section between `<CompareMatrix … />` and `<InsightCompareMatrix … />` (after line 233's `/>`):

```tsx
      <CompareOverlaySection reports={reports} baselineIdx={result.baselineIdx} />
```

- [ ] **Step 7: Append page-level assertion (overlay region present, R1)**

In `ui/src/pages/__tests__/ScenarioComparePage.test.tsx`, inside the existing `it("renders matrix and export buttons once reports load", …)` (it already awaits `findByText("p95_ms")`), add after that await:

```tsx
    expect(screen.getByRole("region", { name: ko.compare.overlayTitle })).toBeInTheDocument();
```

(`ko` is already imported at the top of that file.)

- [ ] **Step 8: Run tests — verify pass**

Run: `pnpm test CompareOverlaySection` → PASS.
Run: `pnpm test ScenarioComparePage` → PASS.

- [ ] **Step 9: Full gate + diff guard**

Run: `pnpm lint && pnpm test && pnpm build` — all green (watch `tsc -b`: `MetricKey` filter/`useState` types).
Run: `git diff --name-only` — only `CompareOverlaySection.tsx` + its test, `ScenarioComparePage.tsx` + its test, `ko.ts`. (No schemas/client/crates/ActiveVuChart.)

- [ ] **Step 10: Commit**

```bash
git add ui/src/components/compare/CompareOverlaySection.tsx \
  ui/src/components/compare/__tests__/CompareOverlaySection.test.tsx \
  ui/src/pages/ScenarioComparePage.tsx ui/src/pages/__tests__/ScenarioComparePage.test.tsx \
  ui/src/i18n/ko.ts
git commit -m "feat(ui): per-second overlay section + metric picker on compare page"
```

---

## Task 4: verdict 행 baseline-상대 polarity — R: R8·R9

**Files:**
- Modify: `ui/src/components/compare/CompareMatrix.tsx` (verdict `<tr>` 154-167)
- Modify: `ui/src/i18n/ko.ts` (`ko.compare.verdictWorse`/`verdictBetter`)
- Test: `ui/src/components/compare/__tests__/CompareMatrix.test.tsx` (append)

**Interfaces:**
- Consumes: `verdictPolarity` (Task 1); `ko.compare.verdictWorse`/`verdictBetter` (this task).

- [ ] **Step 1: Append failing test (test file first)**

Append to `ui/src/components/compare/__tests__/CompareMatrix.test.tsx` (a fresh `result` with verdicts). Add at the end of the file:

```tsx
describe("CompareMatrix verdict polarity (spec R8)", () => {
  const labels = { A: "#A", B: "#B" };
  function verdictResult(passed: (boolean | null)[]): CompareResult {
    return {
      runIds: ["A", "B"],
      baselineIdx: 0,
      summary: [],
      steps: [],
      status: [],
      verdict: { passed },
      stepMismatch: false,
    };
  }

  it("baseline PASS & candidate FAIL → ▲악화 on candidate, none on baseline", () => {
    render(<CompareMatrix result={verdictResult([true, false])} labels={labels} onBaselineChange={vi.fn()} />);
    expect(screen.getByText(/악화/)).toBeInTheDocument();
    expect(screen.queryByText(/개선/)).not.toBeInTheDocument();
  });

  it("baseline FAIL & candidate PASS → ▼개선", () => {
    render(<CompareMatrix result={verdictResult([false, true])} labels={labels} onBaselineChange={vi.fn()} />);
    expect(screen.getByText(/개선/)).toBeInTheDocument();
    expect(screen.queryByText(/악화/)).not.toBeInTheDocument();
  });

  it("equal verdicts → neutral (no glyph)", () => {
    render(<CompareMatrix result={verdictResult([true, true])} labels={labels} onBaselineChange={vi.fn()} />);
    expect(screen.queryByText(/악화/)).not.toBeInTheDocument();
    expect(screen.queryByText(/개선/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `pnpm test CompareMatrix`
Expected: FAIL (no 악화/개선 in DOM).

- [ ] **Step 3: Add verdict ko keys**

In `ui/src/i18n/ko.ts` `compare: { … }`, add:

```ts
    verdictWorse: "악화",
    verdictBetter: "개선",
```

- [ ] **Step 4: Render polarity in the verdict row of `CompareMatrix.tsx`**

(a) Add import at top (after line 1 `import type { Cell, CompareResult, CompareRow } …`):

```ts
import { verdictPolarity } from "../../compare/compareReports";
```

(b) Replace the verdict-row `.map` body (lines 156-166) with the polarity-aware version (`baselineIdx` is already destructured at line 102):

```tsx
            {verdict.passed.map((p, i) => {
              const pol =
                i === baselineIdx ? "neutral" : verdictPolarity(verdict.passed[baselineIdx], p);
              return (
                <td key={i} className="py-2 pr-4">
                  {p === null ? (
                    "—"
                  ) : p ? (
                    <span className="text-green-600 font-semibold">{ko.report.verdictPass}</span>
                  ) : (
                    <span className="text-red-600 font-semibold">{ko.report.verdictFail}</span>
                  )}
                  {pol === "bad" && (
                    <span className="ml-1 text-red-600 text-xs font-semibold">
                      ▲{ko.compare.verdictWorse}
                    </span>
                  )}
                  {pol === "good" && (
                    <span className="ml-1 text-green-600 text-xs font-semibold">
                      ▼{ko.compare.verdictBetter}
                    </span>
                  )}
                </td>
              );
            })}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `pnpm test CompareMatrix`
Expected: PASS (existing matrix tests + new polarity describe).

- [ ] **Step 6: Teeth-check (confirm the test has teeth)**

Temporarily change Step 4(b) `pol === "bad"` to `pol === "neutral"` and rerun `pnpm test CompareMatrix` → the 악화 test must now FAIL. Revert.

- [ ] **Step 7: Full gate + diff guard**

Run: `pnpm lint && pnpm test && pnpm build` — all green.
Run: `git diff --name-only` — only `CompareMatrix.tsx` + its test, `ko.ts`. (No schemas/client/crates/export/golden.)

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/compare/CompareMatrix.tsx \
  ui/src/components/compare/__tests__/CompareMatrix.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): baseline-relative verdict polarity (악화/개선) in compare matrix"
```

---

## Post-implementation (orchestrator)

- **최종 리뷰** `handicap-reviewer` (UI-only·wire 0-diff 확인). 보안 게이트는 N/A 예상(요청실행/템플릿/캐스트/env-dataset 바인딩/업로드/trace 무관 — `finish-slice` §0 grep이 결정).
- **라이브 검증 WAIVED** 예상(spec §6): `schemas.ts` 0-diff·run-생성/리포트-파싱 경로 무관(read-only) → S-D 갭 구조적 부재. RTL이 실 windows/verdict 배열 fixture로 결정적 커버. finish-slice에서 production diff가 ui-only·read-only임을 확인해 근거를 build-log에 기록.
- **병렬 `noncurve-fanout` 머지 조율**(spec §5): `ReportView.tsx`(bySecond import 변경)·`ko.ts`(append) 공유 — 둘째로 머지되는 쪽이 master에 rebase 후 `pnpm lint && pnpm test && pnpm build` 재실행.

<!-- REVIEW-GATE: APPROVED -->
