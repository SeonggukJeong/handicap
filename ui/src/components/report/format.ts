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
