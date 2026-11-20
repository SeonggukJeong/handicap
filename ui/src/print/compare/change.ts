import type { Report } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { fmtCount, fmtMs, fmtMsExact, fmtPct, fmtRps, pctText, rpsText } from "../format";

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

export type MetricKey = "error_rate" | "p99_ms" | "p95_ms" | "mean_ms" | "rps" | "count";
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
  /** before가 0이고 after가 0보다 크면 true — cls가 "similar"인 행도 포함하므로 소비자는 cls도 함께 본다. */
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
  value: (s: Report["summary"]) => number;
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

function valueTexts(kind: Spec["kind"], before: number, after: number, distinct: boolean) {
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
  opts: { errorRateReference: boolean; incomparable: boolean },
): MetricRow[] {
  return SPECS.map((spec) => {
    const bv = spec.value(before);
    const av = spec.value(after);
    const base = classifyChange(spec.dir, bv, av, spec.floor);
    let cls: RowClass = base;
    if (opts.incomparable) cls = "none";
    else if (spec.key === "error_rate" && opts.errorRateReference) cls = "reference";

    const { b, a } = valueTexts(
      spec.kind,
      bv,
      av,
      (cls === "better" || cls === "worse") && bv !== av,
    );
    const isNew = bv === 0 && av > 0;
    const pct = bv > 0 ? Math.abs(av - bv) / bv : null;
    const fell = av < bv;

    let arrow: MetricRow["arrow"] = "–";
    let changeText = "";
    if (cls !== "none" && cls !== "reference") {
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

    const top = Math.max(bv, av);
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
      isNew,
      pct,
      arrow,
      changeText,
      wordText: wordOf(cls),
      barBefore: top > 0 ? bv / top : 0,
      barAfter: top > 0 ? av / top : 0,
    };
  });
}
