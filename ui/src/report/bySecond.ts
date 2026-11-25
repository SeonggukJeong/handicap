import type { Report } from "../api/schemas";

// 응답 시간 값은 서버 latency_by_second의 µs ÷ 1000(반올림 없음). 값이 없는 초는 null.
export type Sec = {
  ts_second: number;
  count: number;
  errors: number;
  p95_ms: number | null;
  mean_ms: number | null;
  capped: boolean;
};

export function bySecond(report: Report): Sec[] {
  const latency = new Map((report.latency_by_second ?? []).map((l) => [l.ts_second, l]));
  const buckets = new Map<number, Sec>();
  for (const w of report.windows) {
    const cur = buckets.get(w.ts_second);
    if (cur) {
      cur.count += w.count;
      cur.errors += w.error_count;
      continue;
    }
    const l = latency.get(w.ts_second);
    buckets.set(w.ts_second, {
      ts_second: w.ts_second,
      count: w.count,
      errors: w.error_count,
      p95_ms: l?.p95_us === undefined ? null : l.p95_us / 1000,
      mean_ms: l?.mean_us === undefined ? null : l.mean_us / 1000,
      capped: l?.capped ?? false,
    });
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts_second - b.ts_second);
}
