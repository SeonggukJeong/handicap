/** Format a microsecond latency into a compact human string (µs / ms / s). */
export function formatLatency(us: number): string {
  if (!Number.isFinite(us) || us < 0) return "—";
  if (us < 1_000) return `${Math.round(us)} µs`;
  const ms = us / 1_000;
  // Round-aware thresholds so adjacent labels stay consistent: values that round
  // up to 10 ms use the integer branch (not "10.0 ms"), and values that round up
  // to 1000 ms render as "1.0 s" (not "1000 ms").
  if (ms < 9.95) return `${ms.toFixed(1)} ms`;
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  return `${(us / 1_000_000).toFixed(1)} s`;
}

/** 백분율(0–100)을 표시 문자열로. nonzero인데 표시 최소값(0.1%) 미만이면 "<0.1%"로 floor
 *  — 에러/드롭이 실재하는데 "0.0%"로 보이는 오해 방지(R5). 진짜 0은 "0.0%". */
export function floorPct(pct: number): string {
  if (pct > 0 && pct < 0.05) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/** 에러율(errors/count) 표시 — count 0이면 "—". */
export function formatErrPct(errors: number, count: number): string {
  return count === 0 ? "—" : floorPct((errors / count) * 100);
}
