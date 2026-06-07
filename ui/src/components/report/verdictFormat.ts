// SLO verdict metric label/value 포맷 — VerdictPanel(리포트 표)과 VerdictBadge(FAIL
// tooltip)가 공유하는 단일 소스. 같은 run의 두 표면이 값을 다르게 보이지 않게 한다
// (예: error_rate 0.05 → "5.00%", latency → "420 ms").

export const METRIC_LABEL: Record<string, string> = {
  p50_ms: "p50",
  p95_ms: "p95",
  p99_ms: "p99",
  error_rate: "Error rate",
  rps: "RPS",
  "4xx_rate": "4xx 비율",
  "5xx_rate": "5xx 비율",
  "4xx_count": "4xx 수",
  "5xx_count": "5xx 수",
  min_window_rps: "최소 구간 RPS",
};

export function fmt(metric: string, v: number): string {
  if (metric === "error_rate" || metric === "4xx_rate" || metric === "5xx_rate")
    return `${(v * 100).toFixed(2)}%`;
  if (metric === "rps" || metric === "min_window_rps") return v.toFixed(1);
  if (metric === "4xx_count" || metric === "5xx_count") return String(v);
  return `${v} ms`; // p50/p95/p99
}
