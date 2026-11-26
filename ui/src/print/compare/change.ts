import type { Report } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { CAP_US } from "../../components/report/format";
import {
  fmtCount,
  fmtMeanMs,
  fmtMs,
  fmtMsExact,
  fmtPct,
  fmtRps,
  pctText,
  rpsText,
} from "../format";

const c = ko.print.cmp;

export type Direction = "lower" | "higher" | "neutral";
export type BaseClass = "better" | "worse" | "similar" | "up" | "down";

export const FLOOR = { error_rate: 0.0005, ms: 5, rps: 0, count: 0 } as const;

const SIMILAR_RATIO = 0.05;
const MAX_DIGITS = 6;
const TOLERANCE = 1e-9; // 십진수로 딱 맞는 경계값이 부동소수 오차로 뒤집히지 않게 하는 여유

const belowFloor = (diff: number, floor: number) => diff < floor - TOLERANCE;
const withinSimilarRatio = (before: number, diff: number) =>
  before > 0 && diff / before <= SIMILAR_RATIO + TOLERANCE;

export function classifyChange(
  dir: Direction,
  before: number,
  after: number,
  floor: number,
): BaseClass {
  if (before === after) return "similar";
  const diff = Math.abs(after - before);
  if (belowFloor(diff, floor)) return "similar";
  if (withinSimilarRatio(before, diff)) return "similar";
  const rose = after > before;
  if (dir === "neutral") return rose ? "up" : "down";
  const good = dir === "higher" ? rose : !rose;
  return good ? "better" : "worse";
}

export type MetricKey =
  | "error_rate"
  | "p99_ms"
  | "p95_ms"
  | "p90_ms"
  | "mean_ms"
  | "max_ms"
  | "rps"
  | "count";

/**
 * 한쪽만 잘린(60초 칸) 응답 시간의 방향. 값은 잘린 쪽이 하한이라 방향이 확정일 때만 말한다
 * (잘린 이후가 이전 이상이면 나빠짐, 잘린 이전이 이후 이상이면 좋아짐). 그 밖은 모름.
 * 호출 전제: 적어도 한쪽이 잘렸다.
 */
export function cutDirection(
  before: number,
  after: number,
  beforeCut: boolean,
  afterCut: boolean,
): "worse" | "better" | null {
  if (beforeCut && afterCut) return null;
  if (afterCut && after >= before) return "worse";
  if (beforeCut && before >= after) return "better";
  return null;
}
export type RowClass = BaseClass | "reference" | "none";

export type MetricRow = {
  key: MetricKey;
  name: string;
  hint: string;
  before: number;
  after: number;
  beforeText: string;
  afterText: string;
  cls: RowClass;
  major: boolean;
  /** 표준판 핵심 지표 표에만 그린다(요약판은 거른다). */
  standardOnly: boolean;
  /** before가 0이고 after가 0보다 크며, 하한·5% 규칙으로 "비슷"이 아닌 변화. */
  isNew: boolean;
  pct: number | null;
  arrow: "▼" | "▲" | "=" | "–";
  changeText: string;
  wordText: string;
  barBefore: number;
  barAfter: number;
};

type Spec = {
  key: MetricKey;
  name: string;
  hint: string;
  dir: Direction;
  floor: number;
  major: boolean;
  kind: "pct" | "ms" | "rps" | "count";
  /** null = 잰 적 없음(통계 칸이 없다). */
  value: (s: Report["summary"]) => number | null;
  standardOnly?: true;
  /** 이 쪽 값이 60초 칸(하한값)인가 — 응답 시간 행만. */
  cut?: (s: Report["summary"]) => boolean;
};

const SPECS: Spec[] = [
  {
    key: "error_rate",
    name: c.metric.errorRate,
    hint: c.metric.errorRateHint,
    dir: "lower",
    floor: FLOOR.error_rate,
    major: true,
    kind: "pct",
    value: (s) => (s.count === 0 ? 0 : s.errors / s.count),
  },
  {
    key: "p99_ms",
    name: c.metric.p99,
    hint: c.metric.p99Hint,
    dir: "lower",
    floor: FLOOR.ms,
    major: true,
    kind: "ms",
    value: (s) => s.p99_ms,
    cut: (s) => s.p99_ms >= 60000,
  },
  {
    key: "p95_ms",
    name: c.metric.p95,
    hint: c.metric.p95Hint,
    dir: "lower",
    floor: FLOOR.ms,
    major: true,
    kind: "ms",
    value: (s) => s.p95_ms,
    cut: (s) => s.p95_ms >= 60000,
  },
  {
    key: "p90_ms",
    name: c.metric.p90,
    hint: c.metric.p90Hint,
    dir: "lower",
    floor: FLOOR.ms,
    major: false,
    kind: "ms",
    value: (s) => (s.stats ? s.stats.p90_us / 1000 : null),
    standardOnly: true,
    cut: (s) => (s.stats ? s.stats.p90_us >= CAP_US : false),
  },
  {
    key: "mean_ms",
    name: c.metric.mean,
    hint: c.metric.meanHint,
    dir: "lower",
    floor: FLOOR.ms,
    major: true,
    kind: "ms",
    value: (s) => s.mean_ms,
    cut: (s) => s.stats?.capped ?? s.mean_ms >= 60000,
  },
  {
    key: "max_ms",
    name: c.metric.max,
    hint: c.metric.maxHint,
    dir: "lower",
    floor: FLOOR.ms,
    major: false,
    kind: "ms",
    value: (s) => (s.stats ? s.stats.max_us / 1000 : null),
    standardOnly: true,
    cut: (s) => (s.stats ? s.stats.max_us >= CAP_US : false),
  },
  {
    key: "rps",
    name: c.metric.rps,
    hint: c.metric.rpsHint,
    dir: "higher",
    floor: FLOOR.rps,
    major: true,
    kind: "rps",
    value: (s) => s.rps,
  },
  {
    key: "count",
    name: c.metric.count,
    hint: c.metric.countHint,
    dir: "neutral",
    floor: FLOOR.count,
    major: false,
    kind: "count",
    value: (s) => s.count,
  },
];

export function valueTexts(kind: Spec["kind"], before: number, after: number, distinct: boolean) {
  const base = (v: number) => {
    if (kind === "pct") return fmtPct(v);
    if (kind === "ms") return fmtMs(v);
    if (kind === "rps") return fmtRps(v);
    return fmtCount(v);
  };
  const b = base(before);
  const a = base(after);
  if (!distinct || b !== a) return { b, a };
  if (kind === "ms") return { b: fmtMsExact(before), a: fmtMsExact(after) };
  if (kind === "pct" || kind === "rps") {
    const text = kind === "pct" ? pctText : rpsText;
    for (let d = 2; d <= MAX_DIGITS; d++) {
      const tb = text(before, d);
      const ta = text(after, d);
      if (tb !== ta) return { b: tb, a: ta };
    }
    return { b: text(before, MAX_DIGITS), a: text(after, MAX_DIGITS) };
  }
  return { b, a };
}

function changeWord(kind: Spec["kind"], fell: boolean): string {
  if (fell) return kind === "ms" ? c.change.shortened : c.change.decreased;
  return c.change.increased;
}

function wordOf(cls: RowClass): string {
  switch (cls) {
    case "better":
      return c.change.better;
    case "worse":
      return c.change.worse;
    case "similar":
      return c.change.similar;
    case "up":
      return c.change.up;
    case "down":
      return c.change.down;
    case "reference":
      return c.change.reference;
    case "none":
      return c.change.none;
  }
}

export function metricRows(
  before: Report["summary"],
  after: Report["summary"],
  opts: {
    errorRateReference: boolean;
    incomparable: boolean;
    /** 응답 시간 표본이 「통과한 요청」인데 통과한 요청이 없는 쪽. */
    latencyMissing?: { before: boolean; after: boolean };
  },
): MetricRow[] {
  return SPECS.map((spec) => {
    const rawB = spec.value(before);
    const rawA = spec.value(after);
    const bv = rawB ?? 0;
    const av = rawA ?? 0;
    const noLatB = spec.kind === "ms" && (opts.latencyMissing?.before ?? false);
    const noLatA = spec.kind === "ms" && (opts.latencyMissing?.after ?? false);
    // 요청이 0건인 쪽은 오류율·응답 시간을 잰 적이 없다. 건수·처리량은 0이 실제 값이다.
    const unmeasured = spec.kind === "pct" || spec.kind === "ms";
    const missB = (unmeasured && before.count === 0) || noLatB || rawB === null;
    const missA = (unmeasured && after.count === 0) || noLatA || rawA === null;
    const cutB = !missB && (spec.cut?.(before) ?? false);
    const cutA = !missA && (spec.cut?.(after) ?? false);
    const cut = cutB || cutA;
    const base = classifyChange(spec.dir, bv, av, spec.floor);
    const cutDir = cut ? cutDirection(bv, av, cutB, cutA) : null;
    let cls: RowClass = base;
    if (opts.incomparable || noLatB || noLatA || rawB === null || rawA === null) cls = "none";
    else if (spec.key === "error_rate" && opts.errorRateReference) cls = "reference";
    else if (cut) cls = cutDir ?? "none";

    const texts = valueTexts(
      spec.kind,
      bv,
      av,
      !cut && (cls === "better" || cls === "worse") && bv !== av,
    );
    let b = missB ? c.metric.notMeasured : texts.b;
    let a = missA ? c.metric.notMeasured : texts.a;
    // 평균은 분포가 잘렸으면 하한이라 「이상」(통계 칸이 있는 쪽만)
    if (spec.key === "mean_ms") {
      if (!missB && before.stats?.capped) b = fmtMeanMs(bv, true);
      if (!missA && after.stats?.capped) a = fmtMeanMs(av, true);
    }
    const cutShown = cut && (cls === "better" || cls === "worse");
    const isNew = !cut && bv === 0 && av > 0 && base !== "similar";
    const pct = !cut && bv > 0 ? Math.abs(av - bv) / bv : null;
    const fell = cutShown ? cls === "better" : av < bv;

    let arrow: MetricRow["arrow"] = "–";
    let changeText = "";
    if (cutShown) {
      arrow = fell ? "▼" : "▲";
      changeText = c.change.cutNoPct;
    } else if (cls !== "none" && cls !== "reference") {
      if (cls === "similar") {
        arrow = "=";
        changeText =
          bv === av || withinSimilarRatio(bv, Math.abs(av - bv))
            ? c.change.withinFive
            : c.change.smallDiff;
      } else {
        arrow = fell ? "▼" : "▲";
        const word = changeWord(spec.kind, fell);
        if (isNew) changeText = c.change.isNew;
        else if (pct !== null && Math.round(pct * 100) === 0) changeText = c.change.underOne(word);
        else if (pct !== null) changeText = c.change.pct(Math.round(pct * 100), word);
      }
    }

    const barB = before.count === 0 || noLatB || rawB === null ? 0 : bv;
    const barA = after.count === 0 || noLatA || rawA === null ? 0 : av;
    const top = Math.max(barB, barA);
    return {
      key: spec.key,
      name: spec.name,
      hint: spec.hint,
      before: bv,
      after: av,
      beforeText: b,
      afterText: a,
      cls,
      major: spec.major,
      standardOnly: spec.standardOnly === true,
      isNew,
      pct,
      arrow,
      changeText,
      wordText: wordOf(cls),
      barBefore: top > 0 ? barB / top : 0,
      barAfter: top > 0 ? barA / top : 0,
    };
  });
}
