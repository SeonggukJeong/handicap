import type { Report } from "../api/schemas";

export type Polarity = "good" | "bad" | "neutral";
export type Delta = { pct: number | null; polarity: Polarity };
export type Cell = { value: number | null; delta: Delta | null };
export type CompareRow = { label: string; metric: string; cells: Cell[] };
export type CompareResult = {
  runIds: string[];
  baselineIdx: number;
  summary: CompareRow[];
  steps: CompareRow[];
  status: CompareRow[];
  verdict: { passed: (boolean | null)[] };
  stepMismatch: boolean;
};

const LOWER_IS_BETTER = new Set(["p50_ms", "p95_ms", "p99_ms", "error_rate"]);
const SUMMARY_METRICS = ["p50_ms", "p95_ms", "p99_ms", "rps", "error_rate"] as const;

export function computeDelta(metric: string, base: number, val: number): Delta {
  const pct = base === 0 ? null : (val - base) / base;
  let polarity: Polarity;
  if (val === base) polarity = "neutral";
  else polarity = val < base === LOWER_IS_BETTER.has(metric) ? "good" : "bad";
  return { pct, polarity };
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

function summaryValue(r: Report, metric: string): number {
  const s = r.summary;
  if (metric === "error_rate") return s.count === 0 ? 0 : s.errors / s.count;
  return (s as unknown as Record<string, number>)[metric];
}

export function compareReports(reports: Report[], baselineId: string): CompareResult {
  const runIds = reports.map((r) => r.run.id);
  const baselineIdx = Math.max(0, runIds.indexOf(baselineId));

  const summary: CompareRow[] = SUMMARY_METRICS.map((metric) => {
    const base = summaryValue(reports[baselineIdx], metric);
    return {
      label: metric,
      metric,
      cells: reports.map((r, i) => {
        const value = summaryValue(r, metric);
        return { value, delta: i === baselineIdx ? null : computeDelta(metric, base, value) };
      }),
    };
  });

  const stepIds = Array.from(new Set(reports.flatMap((r) => r.steps.map((s) => s.step_id)))).sort();
  const steps: CompareRow[] = stepIds.map((sid) => {
    const baseStep = reports[baselineIdx].steps.find((s) => s.step_id === sid);
    const base = baseStep ? baseStep.p95_ms : null;
    return {
      label: sid,
      metric: "p95_ms",
      cells: reports.map((r, i) => {
        const st = r.steps.find((s) => s.step_id === sid);
        const value = st ? st.p95_ms : null;
        if (i === baselineIdx || value === null || base === null) return { value, delta: null };
        return { value, delta: computeDelta("p95_ms", base, value) };
      }),
    };
  });

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

  return { runIds, baselineIdx, summary, steps, status, verdict, stepMismatch };
}
