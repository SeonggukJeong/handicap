import type { LatencyStats, Report } from "../api/schemas";
import { latencyShown, latencyUnitText } from "../components/report/format";
import { ko } from "../i18n/ko";
import { niceTicks } from "../print/chartModel";

export type StepLatencySeries = {
  stepId: string;
  name: string;
  stats: LatencyStats | undefined;
  capped: boolean;
  points: { x: number; meanMs: number | null }[];
};

/** 스텝마다 초별 평균(ms) 계열. 순서는 `report.steps`(스텝 표와 같음). */
export function stepLatencySeries(
  report: Report,
  names: Map<string, string>,
  firstTs: number | null,
): StepLatencySeries[] {
  return report.steps.map((s) => {
    const wins = report.windows.filter((w) => w.step_id === s.step_id);
    return {
      stepId: s.step_id,
      name: names.get(s.step_id) ?? s.step_id,
      stats: s.stats,
      capped: wins.some((w) => w.capped === true),
      points: wins.map((w) => ({
        x: w.ts_second - (firstTs ?? w.ts_second),
        meanMs: w.mean_us === undefined ? null : w.mean_us / 1000,
      })),
    };
  });
}

/** 모든 카드가 함께 쓰는 세로 눈금 상한. */
export function sharedYMax(series: StepLatencySeries[]): number {
  let max = 0;
  for (const s of series)
    for (const p of s.points) if (p.meanMs !== null && p.meanMs > max) max = p.meanMs;
  const ticks = niceTicks(max, 5);
  return ticks[ticks.length - 1];
}

/** 카드의 「평균 N ms」 글(③c 평균 카드 규칙과 같다). */
export function stepMeanText(stats: LatencyStats | undefined): string {
  if (stats === undefined) return ko.report.stepLatency.noData;
  const x = latencyShown(Math.min(Math.round(stats.mean_us / 1000), 60000), stats.mean_us);
  return ko.report.stepLatency.mean(
    (x.kind !== "capped" && stats.capped ? "≥ " : "") + latencyUnitText(x),
  );
}
