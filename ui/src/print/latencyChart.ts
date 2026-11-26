import { ko } from "../i18n/ko";
import type { SecondLatency } from "../api/schemas";
import { elapsedText, niceTicks, type ChartModel } from "./chartModel";

const K = ko.print.latencyChart;

export type LatencyBin = {
  startSec: number;
  seconds: number;
  meanMs: number | null;
  p95Ms: number | null;
  capped: boolean;
  /** 그 칸에 초별 값이 하나라도 있었는지. false면 「관측 없음」이라 선을 건너뛴다. */
  observed: boolean;
};
export type LatencyChartModel = {
  bins: LatencyBin[];
  yTicks: number[];
  capped: boolean;
  p95Label: string;
  binText: string;
};

/** 초별 응답 시간을 `chart.bins`와 같은 칸으로 묶는다. 칸 평균은 n 가중, p95는 칸 안 최댓값. */
export function binLatency(series: SecondLatency[], t0: number, chart: ChartModel): LatencyBin[] {
  const nBins = chart.bins.length;
  const acc = chart.bins.map(() => ({
    n: 0,
    sum: 0,
    p95: null as number | null,
    capped: false,
    observed: false,
  }));
  for (const s of series) {
    if (nBins === 0) break;
    const i = Math.max(0, Math.min(nBins - 1, Math.floor((s.ts_second - t0) / chart.binSeconds)));
    const a = acc[i];
    a.observed = true;
    if (s.capped) a.capped = true;
    if (s.n > 0 && s.mean_us !== undefined) {
      a.n += s.n;
      a.sum += s.n * s.mean_us;
      if (s.p95_us !== undefined) a.p95 = Math.max(a.p95 ?? 0, s.p95_us);
    }
  }
  return chart.bins.map((b, i) => ({
    startSec: b.startSec,
    seconds: b.seconds,
    meanMs: acc[i].n > 0 ? acc[i].sum / acc[i].n / 1000 : null,
    p95Ms: acc[i].p95 === null ? null : acc[i].p95 / 1000,
    capped: acc[i].capped,
    observed: acc[i].observed,
  }));
}

export function buildLatencyChart(
  series: SecondLatency[],
  t0: number | null,
  chart: ChartModel,
): LatencyChartModel | null {
  if (t0 === null) return null;
  const bins = binLatency(series, t0, chart);
  if (!bins.some((b) => b.meanMs !== null)) return null;
  const max = Math.max(0, ...bins.flatMap((b) => [b.meanMs ?? 0, b.p95Ms ?? 0]));
  return {
    bins,
    yTicks: niceTicks(max, 5),
    capped: bins.some((b) => b.capped),
    p95Label: chart.binSeconds === 1 ? K.p95 : K.p95Bin,
    binText: elapsedText(chart.binSeconds),
  };
}
