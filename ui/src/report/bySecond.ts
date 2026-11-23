import { reportSample, type Report } from "../api/schemas";
import { hasLatency, windowNotSent } from "./hasLatency";

export type Sec = { ts_second: number; count: number; errors: number; p95_ms: number | null };

export function bySecond(report: Report): Sec[] {
  const sample = reportSample(report).selected;
  const buckets = new Map<number, Sec>();
  for (const w of report.windows) {
    const cur = buckets.get(w.ts_second) ?? {
      ts_second: w.ts_second,
      count: 0,
      errors: 0,
      p95_ms: null,
    };
    cur.count += w.count;
    cur.errors += w.error_count;
    // For p95 time series, use the max across steps in the same second as a coarse signal.
    // Per-second per-step p95 charts are deferred (ADR-0017 OUT: percentile histogram view).
    // 값이 있는 창이 하나도 없는 초는 null로 남아 그래프 선이 끊긴다.
    const measured = hasLatency(
      { count: w.count, errors: w.error_count, notSent: windowNotSent(w) },
      sample,
    );
    if (measured && (cur.p95_ms === null || w.p95_ms > cur.p95_ms)) cur.p95_ms = w.p95_ms;
    buckets.set(w.ts_second, cur);
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts_second - b.ts_second);
}
