// SLO verdict metric label/value 포맷 — VerdictPanel(리포트 표)과 VerdictBadge(FAIL
// tooltip)가 공유하는 단일 소스. 같은 run의 두 표면이 값을 다르게 보이지 않게 한다
// (예: error_rate 0.05 → "5.00%", latency → "420 ms").

import { ko } from "../../i18n/ko";
import { parsePercentileMetric } from "../../api/percentileName";
import { msNumberText } from "./format";

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

/** 기준 이름 — 고정 표 → 평균·최대 → 정본 백분위 이름(`p99.9`) → 모르는 이름은 그대로. */
export function metricLabel(metric: string): string {
  const fixed = METRIC_LABEL[metric];
  if (fixed !== undefined) return fixed;
  if (metric === "mean_ms") return ko.report.verdictMetricMean;
  if (metric === "max_ms") return ko.report.verdictMetricMax;
  const n = parsePercentileMetric(metric);
  return n !== null ? `p${n}` : metric;
}

/** 실측 글자 — 통과한 요청이 없어 계산하지 못한 기준은 0이 아니라 안내 문구,
 *  60초 칸에 걸린 행은 하한이라 「≥」. */
export function actualText(c: {
  metric: string;
  actual: number;
  no_sample?: boolean;
  capped?: boolean;
}): string {
  if (c.no_sample) return ko.report.sample.noSample;
  if (c.capped) return `≥\u00a0${fmt(c.metric, c.actual)}`;
  return fmt(c.metric, c.actual);
}

export function fmt(metric: string, v: number): string {
  if (metric === "error_rate" || metric === "4xx_rate" || metric === "5xx_rate")
    return `${(v * 100).toFixed(2)}%`;
  if (metric === "rps" || metric === "min_window_rps") return v.toFixed(1);
  if (metric === "4xx_count" || metric === "5xx_count") return String(v);
  if (metric.endsWith("_ms")) return `${msNumberText(v)} ms`;
  return `${v} ms`;
}
