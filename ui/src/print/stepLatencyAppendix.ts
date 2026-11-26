// 인쇄 부록 「단계별 평균 응답 시간」 모델 (순수). 칸 경계는 본문 그래프와 같다.
import type { Report } from "../api/schemas";
import { niceTicks, type ChartModel } from "./chartModel";
import type { StepRow } from "./stepTable";

export type StepLatCard = {
  title: string;
  hasData: boolean;
  bins: (number | null)[];
  /** 그 칸에 그 단계 창이 하나라도 있었는지. false면 「관측 없음」이라 선을 건너뛴다. */
  seen: boolean[];
};
export type StepLatModel = {
  cards: StepLatCard[];
  pairs: [StepLatCard, StepLatCard | null][];
  yTicks: number[];
  capped: boolean;
  /** 칸 가운데의 경과 초(마지막 칸은 짧을 수 있다). */
  points: number[];
};

export function buildStepLatAppendix(
  windows: Report["windows"],
  rows: StepRow[],
  t0: number | null,
  chart: ChartModel,
): StepLatModel | null {
  if (t0 === null || rows.length === 0 || chart.bins.length === 0) return null;
  const nBins = chart.bins.length;
  const acc = new Map<string, { n: number; sum: number; seen: boolean }[]>(
    rows.map((r) => [r.stepId, chart.bins.map(() => ({ n: 0, sum: 0, seen: false }))]),
  );
  let capped = false;
  for (const w of windows) {
    const a = acc.get(w.step_id);
    if (a === undefined) continue;
    if (w.capped) capped = true;
    const i = Math.max(0, Math.min(nBins - 1, Math.floor((w.ts_second - t0) / chart.binSeconds)));
    a[i].seen = true;
    if (w.n > 0 && w.mean_us !== undefined) {
      a[i].n += w.n;
      a[i].sum += w.n * w.mean_us;
    }
  }
  const cards: StepLatCard[] = rows.map((r) => {
    const cells = acc.get(r.stepId) ?? [];
    const bins = cells.map((c) => (c.n > 0 ? c.sum / c.n / 1000 : null));
    const seen = cells.map((c) => c.seen);
    return { title: `${r.no} ${r.name}`, hasData: bins.some((b) => b !== null), bins, seen };
  });
  if (!cards.some((c) => c.hasData)) return null;
  const max = Math.max(0, ...cards.flatMap((c) => c.bins.map((b) => b ?? 0)));
  const pairs: StepLatModel["pairs"] = [];
  for (let i = 0; i < cards.length; i += 2) pairs.push([cards[i], cards[i + 1] ?? null]);
  return {
    cards,
    pairs,
    yTicks: niceTicks(max, 5),
    capped,
    points: chart.bins.map((b) => b.startSec + b.seconds / 2),
  };
}
