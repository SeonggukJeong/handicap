import type { Report, ReportSampleName, ReportStep } from "../api/schemas";

export type LatencyCounts = { count: number; errors: number; notSent: number };

/** passed → count − errors > 0 · failed → errors − notSent > 0 · all → count − notSent > 0 */
export function hasLatency(c: LatencyCounts, sample: ReportSampleName): boolean {
  if (sample === "passed") return c.count - c.errors > 0;
  if (sample === "failed") return c.errors - c.notSent > 0;
  return c.count - c.notSent > 0;
}

/** 창의 count에서 상태별 합을 뺀 값 — 하나도 보내지 않은 요청 수. */
export function windowNotSent(w: { count: number; status_counts: Record<string, number> }): number {
  const sum = Object.values(w.status_counts).reduce((a, b) => a + b, 0);
  return w.count - sum;
}

export function stepCounts(s: ReportStep): LatencyCounts {
  return { count: s.count, errors: s.error_count, notSent: s.not_sent ?? 0 };
}

export function summaryCounts(r: Report): LatencyCounts {
  return {
    count: r.summary.count,
    errors: r.summary.errors,
    notSent: r.steps.reduce((a, s) => a + (s.not_sent ?? 0), 0),
  };
}
