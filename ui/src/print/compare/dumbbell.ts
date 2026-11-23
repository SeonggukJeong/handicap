import { ko } from "../../i18n/ko";
import { niceTicks } from "../chartModel";
import { fmtBoundary, fmtMs, fmtMsExact } from "../format";
import { requestsSent } from "../stepTable";
import { classifyChange, FLOOR } from "./change";
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

function msOf(model: RunModel, stepId: string): number | null {
  const row = model.table.rows.find((r) => r.stepId === stepId);
  // 하나도 보내지 않은 쪽은 잰 시간이 없다(보냈지만 응답을 못 받은 요청은 걸린 시간이 표본에 있다)
  if (!row || !row.executed || requestsSent(row) <= 0 || !Number.isFinite(row.p95Ms)) {
    return null;
  }
  return row.p95Ms;
}

function stepP95Criterion(model: RunModel): boolean {
  return (model.criteria?.step_criteria ?? []).some((c) => c.metric === "p95_ms");
}

function valueTexts(b: number | null, a: number | null, cls: DbClass | null) {
  let bt = b === null ? ko.print.cmp.none : fmtMs(b);
  let at = a === null ? ko.print.cmp.none : fmtMs(a);
  if (b !== null && a !== null && cls !== "similar" && bt === at) {
    bt = fmtMsExact(b);
    at = fmtMsExact(a);
  }
  return { bt, at };
}

export function buildDumbbell(before: RunModel, after: RunModel, pairs: StepPair[]): DumbbellModel {
  const measured = pairs.map((p) => ({
    p,
    b: msOf(before, p.stepId),
    a: msOf(after, p.stepId),
  }));

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

  const bMax = before.criteria?.max_p95_ms;
  const aMax = after.criteria?.max_p95_ms;
  const limit =
    typeof bMax === "number" &&
    bMax === aMax &&
    !stepP95Criterion(before) &&
    !stepP95Criterion(after) &&
    bMax <= axisMaxMs
      ? bMax
      : null;
  const baseline =
    limit === null ? null : { ms: limit, x: xOf(limit), label: t.baseline(fmtBoundary(limit)) };

  const rows: DumbbellRow[] = measured.map(({ p, b, a }) => {
    const xBefore = b === null ? null : xOf(b);
    const xAfter = a === null ? null : xOf(a);
    const both = b !== null && a !== null;
    const cls: DbClass | null = both ? (classifyChange("lower", b, a, FLOOR.ms) as DbClass) : null;

    let shape: DbShape = "none";
    if (both && xBefore !== null && xAfter !== null) {
      const gap = Math.abs(xAfter - xBefore);
      if (cls === "similar") shape = gap < DB.MERGE ? "merged" : "dots";
      else shape = gap >= DB.NARROW ? "arrow" : "tri";
    } else if (b !== null || a !== null) {
      shape = "single";
    }

    const dir: -1 | 0 | 1 = both ? (a > b ? 1 : a < b ? -1 : 0) : 0;
    const { bt, at } = valueTexts(b, a, cls);
    let afterText = at;
    if (both && cls !== "similar" && b > 0) {
      const pct = Math.round((Math.abs(a - b) / b) * 100);
      afterText += ` ${t.pct(a > b ? "+" : MINUS, pct)}`;
    }
    const valueText = t.value(bt, afterText);
    const wordText =
      cls === "better" ? t.faster : cls === "worse" ? t.slower : cls === "similar" ? t.similar : "";

    let crossText: string | null = null;
    if (limit !== null && both) {
      if (b > limit && a <= limit) crossText = t.crossIn;
      else if (b <= limit && a > limit) crossText = t.crossOver;
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
