import type { Report } from "../api/schemas";
import { bySecond, type Sec } from "../report/bySecond";
import { runColor, runShortLabel } from "./runLabel";

export type MetricKey = "rps" | "p95" | "errors";
export type OverlayRun = { key: string; label: string; color: string; baseline: boolean };
export type OverlayRow = { elapsed: number } & Record<string, number | null>;
export type OverlaySeries = { rows: OverlayRow[]; runs: OverlayRun[] };

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
    color: runColor(i),
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
