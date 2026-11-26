import { reportSample } from "../../api/schemas";
import { hasLatency } from "../../report/hasLatency";
import { ko } from "../../i18n/ko";
import { niceTicks } from "../chartModel";
import { fmtBoundary, fmtMeanMs, fmtMs, fmtMsExact } from "../format";
import { requestsSent } from "../stepTable";
import { classifyChange, cutDirection, FLOOR } from "./change";
import type { StepPair } from "./errorCells";
import type { RunModel } from "./runModel";

const t = ko.print.cmp.db;

/** 그림 칸 SVG 사용자 단위(시안 값). 그림 칸 폭 = PAD + PLOT_W + PAD. */
export const DB = {
  PLOT_W: 320,
  PAD: 16,
  ROW_H: 28,
  AXIS_H: 26,
  RAD: 5,
  NARROW: 22,
  MERGE: 4,
  TRI_GAP: 9,
  TRI_LEN: 7,
  TIP_GAP: 6,
  LINE_GAP: 6,
  HEAD_HALF: 4.5,
} as const;

export type DbClass = "better" | "worse" | "similar";
/** arrow = 선 + 화살촉 · tri = 이후 점 바깥 삼각형 · dots = 점 둘 · merged = 겹친 점 하나 · single = 한쪽 점만 · none = 점 없음 */
export type DbShape = "arrow" | "tri" | "dots" | "merged" | "single" | "none";

export type DumbbellRow = {
  stepId: string;
  label: string;
  note: string | null;
  beforeMs: number | null;
  afterMs: number | null;
  xBefore: number | null;
  xAfter: number | null;
  cls: DbClass | null;
  shape: DbShape;
  dir: -1 | 0 | 1;
  /** 이전 값 글자 */
  beforeText: string;
  /** 이후 값 글자(있으면 퍼센트 괄호 포함) */
  afterText: string;
  /** `beforeText → afterText` */
  valueText: string;
  wordText: string;
  crossText: string | null;
};

export type DumbbellModel = {
  rows: DumbbellRow[];
  axisMaxMs: number;
  ticks: Array<{ ms: number; x: number; label: string }>;
  baseline: { ms: number; x: number; label: string } | null;
  legend: string;
};

const MINUS = "−";

export type DbMetric = "p95" | "mean";

/** 한 쪽의 한 단계 값(ms)과 그 값이 60초 칸(하한)인지. 잰 적이 없으면 null. */
type Measured = { ms: number; cut: boolean };

function measuredOf(model: RunModel, stepId: string, metric: DbMetric): Measured | null {
  const row = model.table.rows.find((r) => r.stepId === stepId);
  // 하나도 보내지 않은 쪽은 잰 시간이 없다(보냈지만 응답을 못 받은 요청은 걸린 시간이 표본에 있다)
  if (!row || !row.executed || requestsSent(row) <= 0 || !Number.isFinite(row.p95Ms)) {
    return null;
  }
  if (
    reportSample(model.report).default === "passed" &&
    !hasLatency({ count: row.count, errors: row.errorCount, notSent: row.notSent }, "passed")
  ) {
    return null;
  }
  if (metric === "mean") {
    return row.stats ? { ms: row.stats.mean_us / 1000, cut: row.stats.capped } : null;
  }
  return { ms: row.p95Ms, cut: row.p95Ms >= 60000 };
}

function stepCriterion(model: RunModel, metric: DbMetric): boolean {
  const name = metric === "mean" ? "mean_ms" : "p95_ms";
  return (model.criteria?.step_criteria ?? []).some((c) => c.metric === name);
}

function valueTexts(
  b: number | null,
  a: number | null,
  cls: DbClass | null,
  cutB: boolean,
  cutA: boolean,
) {
  // 60초 칸 값은 하한이라 「이상」 — 이미 「60초 이상」이면 그대로 둔다(fmtMeanMs)
  let bt = b === null ? ko.print.cmp.none : cutB ? fmtMeanMs(b, true) : fmtMs(b);
  let at = a === null ? ko.print.cmp.none : cutA ? fmtMeanMs(a, true) : fmtMs(a);
  if (cutB || cutA) return { bt, at };
  if (b !== null && a !== null && cls !== "similar" && bt === at) {
    bt = fmtMsExact(b);
    at = fmtMsExact(a);
  }
  return { bt, at };
}

export function buildDumbbell(
  before: RunModel,
  after: RunModel,
  pairs: StepPair[],
  metric: DbMetric = "p95",
): DumbbellModel {
  const measured = pairs.map((p) => {
    const mb = measuredOf(before, p.stepId, metric);
    const ma = measuredOf(after, p.stepId, metric);
    return {
      p,
      b: mb?.ms ?? null,
      a: ma?.ms ?? null,
      cutB: mb?.cut ?? false,
      cutA: ma?.cut ?? false,
    };
  });

  let maxMs = 0;
  for (const m of measured) {
    if (m.b !== null) maxMs = Math.max(maxMs, m.b);
    if (m.a !== null) maxMs = Math.max(maxMs, m.a);
  }
  const useSec = maxMs >= 1000;
  const rawTicks = useSec ? niceTicks(maxMs / 1000, 7) : niceTicks(maxMs, 7);
  const tickMs = rawTicks.map((n) => (useSec ? Math.round(n * 1000) : n));
  const axisMaxMs = tickMs[tickMs.length - 1]!;
  const xOf = (ms: number) => DB.PAD + (DB.PLOT_W * ms) / axisMaxMs;
  const ticks = rawTicks.map((n, i) => ({
    ms: tickMs[i]!,
    x: xOf(tickMs[i]!),
    label: useSec ? t.tickSec(n) : t.tickMs(n),
  }));

  const bMax = metric === "mean" ? before.criteria?.max_mean_ms : before.criteria?.max_p95_ms;
  const aMax = metric === "mean" ? after.criteria?.max_mean_ms : after.criteria?.max_p95_ms;
  const limit =
    typeof bMax === "number" &&
    bMax === aMax &&
    !stepCriterion(before, metric) &&
    !stepCriterion(after, metric) &&
    bMax <= axisMaxMs
      ? bMax
      : null;
  const baseline =
    limit === null ? null : { ms: limit, x: xOf(limit), label: t.baseline(fmtBoundary(limit)) };

  const rows: DumbbellRow[] = measured.map(({ p, b, a, cutB, cutA }) => {
    const xBefore = b === null ? null : xOf(b);
    const xAfter = a === null ? null : xOf(a);
    const both = b !== null && a !== null;
    // 한쪽이라도 60초 칸(하한)이면 변화율은 모르고, 방향이 확정일 때만 분류한다.
    const cut = both && (cutB || cutA);
    const cls: DbClass | null = !both
      ? null
      : cut
        ? cutDirection(b, a, cutB, cutA)
        : (classifyChange("lower", b, a, FLOOR.ms) as DbClass);

    let shape: DbShape = "none";
    if (both && xBefore !== null && xAfter !== null) {
      const gap = Math.abs(xAfter - xBefore);
      if (cls === "similar" || cls === null) shape = gap < DB.MERGE ? "merged" : "dots";
      else shape = gap >= DB.NARROW ? "arrow" : "tri";
    } else if (b !== null || a !== null) {
      shape = "single";
    }

    const dir: -1 | 0 | 1 = !both
      ? 0
      : cut
        ? cls === "worse"
          ? 1
          : cls === "better"
            ? -1
            : 0
        : a > b
          ? 1
          : a < b
            ? -1
            : 0;
    const { bt, at } = valueTexts(b, a, cls, cutB, cutA);
    let afterText = at;
    if (both && !cut && cls !== "similar" && b > 0) {
      const pct = Math.round((Math.abs(a - b) / b) * 100);
      afterText += ` ${t.pct(a > b ? "+" : MINUS, pct)}`;
    }
    const valueText = t.value(bt, afterText);
    const wordText =
      cls === "better" ? t.faster : cls === "worse" ? t.slower : cls === "similar" ? t.similar : "";

    let crossText: string | null = null;
    if (limit !== null && both) {
      // 잘린 값은 하한이라 기준 안쪽에 놓인 값이 잘렸으면 넘나듦을 말하지 않는다
      if (b > limit && a <= limit) crossText = cutA ? null : t.crossIn;
      else if (b <= limit && a > limit) crossText = cutB ? null : t.crossOver;
    }

    const note =
      p.presence === "beforeOnly" ? t.onlyBefore : p.presence === "afterOnly" ? t.onlyAfter : null;

    return {
      stepId: p.stepId,
      label: p.label,
      note,
      beforeMs: b,
      afterMs: a,
      xBefore,
      xAfter,
      cls,
      shape,
      dir,
      beforeText: bt,
      afterText,
      valueText,
      wordText,
      crossText,
    };
  });

  const legend = [
    t.ariaBefore,
    t.ariaAfter,
    ...(baseline ? [t.ariaBase(baseline.label)] : []),
    t.legendArrow,
  ];
  return { rows, axisMaxMs, ticks, baseline, legend: legend.join(" · ") };
}
