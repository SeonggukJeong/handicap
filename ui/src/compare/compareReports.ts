import type { LatencyStats, Report } from "../api/schemas";
import { CAP_US } from "../components/report/format";
import { stepLatencyMissing, summaryLatencyMissing } from "./latencyMissing";

export type Polarity = "good" | "bad" | "neutral";
/** `capped`: 한쪽이라도 60초 칸이라 변화율을 낼 수 없다(`pct`는 null). */
export type Delta = { pct: number | null; polarity: Polarity; capped: boolean };
/** `time`: 시간 지표 칸의 원래 µs(비교 화면이 ms 소수 3자리 글자로 보인다). */
export type Cell = {
  value: number | null;
  delta: Delta | null;
  time?: { us: number };
};
export type CompareRow = { label: string; id?: string; metric: string; cells: Cell[] };
export type CompareResult = {
  runIds: string[];
  baselineIdx: number;
  summary: CompareRow[];
  steps: CompareRow[];
  /** 스텝 통계 행: 스텝 id 정렬 순 × `STEP_METRICS`에서 p95를 뺀 다섯. `id` = 스텝 id. */
  stepStats: CompareRow[];
  status: CompareRow[];
  setup: CompareRow[];
  verdict: { passed: (boolean | null)[] };
  stepMismatch: boolean;
};

/** 응답 시간 지표 여덟(모두 낮을수록 좋음) — `stats`의 µs 칸 이름. 서버 `stat_val`과 같은 표. */
const TIME_KEY = {
  p50_ms: "p50_us",
  p90_ms: "p90_us",
  p95_ms: "p95_us",
  p99_ms: "p99_us",
  mean_ms: "mean_us",
  min_ms: "min_us",
  max_ms: "max_us",
  stdev_ms: "stdev_us",
} as const satisfies Record<string, keyof LatencyStats>;
type TimeMetric = keyof typeof TIME_KEY;

const LOWER_IS_BETTER = new Set<string>([
  ...Object.keys(TIME_KEY),
  "error_rate",
  "setup_failed",
  "setup_errors",
]);
/** 비교 요약의 지표 순서(서버 `SUMMARY_METRICS`와 같다). */
export const SUMMARY_METRICS = [
  "p50_ms",
  "p90_ms",
  "p95_ms",
  "p99_ms",
  "mean_ms",
  "min_ms",
  "max_ms",
  "stdev_ms",
  "rps",
  "error_rate",
] as const;
/** 스텝별 비교 지표 순서(서버 `STEP_METRICS`와 같다). */
export const STEP_METRICS = [
  "p95_ms",
  "mean_ms",
  "min_ms",
  "max_ms",
  "stdev_ms",
  "p90_ms",
] as const;

function isTimeMetric(metric: string): metric is TimeMetric {
  return Object.hasOwn(TIME_KEY, metric);
}

export function computeDelta(metric: string, base: number, val: number): Delta {
  const pct = base === 0 ? null : (val - base) / base;
  let polarity: Polarity;
  if (val === base) polarity = "neutral";
  else polarity = val < base === LOWER_IS_BETTER.has(metric) ? "good" : "bad";
  return { pct, polarity, capped: false };
}

/**
 * 60초 칸 규칙을 얹은 변화율(서버 `delta_of`와 같은 식). 둘 다 안 잘렸으면 `computeDelta`.
 * 한쪽만 잘렸으면 `pct: null`·`capped`, 방향은 비교 쪽이 잘렸고 값 ≥ 기준이면 bad,
 * 기준 쪽이 잘렸고 값 ≥ 비교면 good, 아니면 neutral. 둘 다 잘렸으면 neutral.
 */
export function computeDeltaCapped(
  metric: string,
  base: { v: number; cut: boolean },
  val: { v: number; cut: boolean },
): Delta {
  if (!base.cut && !val.cut) return computeDelta(metric, base.v, val.v);
  let polarity: Polarity = "neutral";
  if (!base.cut && val.cut && val.v >= base.v) polarity = "bad";
  else if (base.cut && !val.cut && base.v >= val.v) polarity = "good";
  return { pct: null, polarity, capped: true };
}

/** 비교에 쓰는 값 하나: ms 값, 60초 칸 여부, (시간 지표면) 원래 µs. */
type Pt = { v: number; cut: boolean; time?: { us: number } };

/** `stats`에서 시간 지표 하나를 꺼낸다. 평균·표준편차의 「잘림」은 `stats.capped`, 나머지는 µs ≥ `CAP_US`. */
function statPt(stats: LatencyStats | undefined, metric: TimeMetric): Pt | null {
  if (!stats) return null;
  const us = stats[TIME_KEY[metric]];
  const mean = metric === "mean_ms" || metric === "stdev_ms";
  return {
    v: us / 1000,
    cut: mean ? stats.capped : us >= CAP_US,
    time: { us },
  };
}

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

function summaryPt(r: Report, metric: (typeof SUMMARY_METRICS)[number]): Pt | null {
  if (isTimeMetric(metric)) {
    return summaryLatencyMissing(r) ? null : statPt(r.summary.stats, metric);
  }
  const s = r.summary;
  return {
    v: metric === "error_rate" ? (s.count === 0 ? 0 : s.errors / s.count) : s.rps,
    cut: false,
  };
}

/** 칸 하나: 값 없음이거나 기준 칸이면 Δ 없음. */
function cellOf(pt: Pt | null, base: Pt | null, isBase: boolean, metric: string): Cell {
  if (pt === null) return { value: null, delta: null };
  const cell: Cell = { value: pt.v, delta: null };
  if (pt.time) cell.time = pt.time;
  if (!isBase && base !== null) cell.delta = computeDeltaCapped(metric, base, pt);
  return cell;
}

function pickRow(
  reports: Report[],
  baselineIdx: number,
  label: string,
  metric: string,
  pick: (r: Report) => Pt | null,
  id?: string,
): CompareRow {
  const base = pick(reports[baselineIdx]);
  return {
    label,
    ...(id === undefined ? {} : { id }),
    metric,
    cells: reports.map((r, i) => cellOf(pick(r), base, i === baselineIdx, metric)),
  };
}

function setupStepOrder(reports: Report[], baselineIdx: number): string[] {
  const order: string[] = [];
  const ordered = [reports[baselineIdx], ...reports.filter((_, i) => i !== baselineIdx)];
  for (const r of ordered) {
    for (const st of r.setup?.steps ?? []) {
      if (!order.includes(st.step_id)) order.push(st.step_id);
    }
  }
  return order;
}

function setupRows(reports: Report[], baselineIdx: number): CompareRow[] {
  if (!reports.some((r) => r.setup)) return [];
  const row = (
    label: string,
    metric: string,
    pick: (r: Report) => number | null,
    id?: string,
  ): CompareRow => {
    const base = pick(reports[baselineIdx]);
    // 준비 스텝 p95만 60초 칸 규칙을 따른다(본 스텝 p95와 같은 식).
    const capRule = metric === "p95_ms";
    const ptOf = (v: number): Pt =>
      capRule && v >= CAP_US / 1000
        ? { v: CAP_US / 1000, cut: true, time: { us: CAP_US } }
        : { v, cut: false };
    return {
      label,
      ...(id === undefined ? {} : { id }),
      metric,
      cells: reports.map((r, i) => {
        const value = pick(r);
        if (value === null) return { value, delta: null };
        const pt = ptOf(value);
        const cell: Cell = { value: pt.v, delta: null };
        if (pt.time) cell.time = pt.time;
        if (i !== baselineIdx && base !== null) {
          cell.delta = computeDeltaCapped(metric, ptOf(base), pt);
        }
        return cell;
      }),
    };
  };
  const stepOf = (r: Report, id: string) => r.setup?.steps.find((s) => s.step_id === id);
  const rows: CompareRow[] = [
    row("setup_ok", "setup_ok", (r) => r.setup?.ok ?? null),
    row("setup_failed", "setup_failed", (r) => r.setup?.failed ?? null),
  ];
  for (const id of setupStepOrder(reports, baselineIdx)) {
    rows.push(row(id, "p95_ms", (r) => stepOf(r, id)?.p95_ms ?? null, id));
    rows.push(row(id, "setup_errors", (r) => stepOf(r, id)?.errors ?? null, id));
  }
  return rows;
}

export function compareReports(reports: Report[], baselineId: string): CompareResult {
  const runIds = reports.map((r) => r.run.id);
  const baselineIdx = Math.max(0, runIds.indexOf(baselineId));

  const summary: CompareRow[] = SUMMARY_METRICS.map((metric) =>
    pickRow(reports, baselineIdx, metric, metric, (r) => summaryPt(r, metric)),
  );

  const stepIds = Array.from(new Set(reports.flatMap((r) => r.steps.map((s) => s.step_id)))).sort();
  const stepPt = (r: Report, sid: string, metric: TimeMetric): Pt | null => {
    const st = r.steps.find((s) => s.step_id === sid);
    return st && !stepLatencyMissing(r, st) ? statPt(st.stats, metric) : null;
  };
  const steps: CompareRow[] = stepIds.map((sid) =>
    pickRow(reports, baselineIdx, sid, "p95_ms", (r) => stepPt(r, sid, "p95_ms"), sid),
  );
  const stepStats: CompareRow[] = stepIds.flatMap((sid) =>
    STEP_METRICS.filter((m) => m !== "p95_ms").map((metric) =>
      pickRow(reports, baselineIdx, metric, metric, (r) => stepPt(r, sid, metric), sid),
    ),
  );

  const statusKeys = Array.from(
    new Set(reports.flatMap((r) => Object.keys(r.status_distribution))),
  ).sort();
  const status: CompareRow[] = statusKeys.map((k) => ({
    label: k,
    metric: "status",
    cells: reports.map((r) => ({ value: r.status_distribution[k] ?? 0, delta: null })),
  }));

  const verdict = { passed: reports.map((r) => (r.verdict ? r.verdict.passed : null)) };

  const sets = reports.map((r) => new Set(r.steps.map((s) => s.step_id)));
  const union = new Set(sets.flatMap((s) => [...s]));
  const intersection = [...union].filter((id) => sets.every((s) => s.has(id)));
  const stepMismatch = intersection.length !== union.size;

  const setup = setupRows(reports, baselineIdx);

  return { runIds, baselineIdx, summary, steps, stepStats, status, setup, verdict, stepMismatch };
}
