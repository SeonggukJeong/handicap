import { ko } from "../i18n/ko";
import { formatLatency } from "../components/report/format";

/** 응답 시간 그래프 툴팁 글자. ms는 소수 가능(초별 합계). 60초 칸은 고정 문구. */
export function latencyTooltipText(ms: number, capped: boolean): string {
  if (ms >= 60000) return ko.report.latencyChart.cappedValue;
  // ms 소수 × 1000의 부동소수 오차를 반올림으로 없앤다.
  return (capped ? "≥ " : "") + formatLatency(Math.round(ms * 1000));
}

/** 값이 있고 앞·뒤(양 끝 밖은 null로 침)가 모두 null이면 선이 못 그리는 외톨이 점. */
export function isLonePoint(values: (number | null)[], i: number): boolean {
  if (values[i] === null || values[i] === undefined) return false;
  const prev = i > 0 ? values[i - 1] : null;
  const next = i + 1 < values.length ? values[i + 1] : null;
  return prev === null && next === null;
}
