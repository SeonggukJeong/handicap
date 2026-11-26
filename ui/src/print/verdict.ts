import { ko } from "../i18n/ko";
import { parsePercentileMetric, percentileMetricName } from "../api/percentileName";
import type { Criteria, Report, Verdict } from "../api/schemas";
import {
  fmtCount,
  fmtCriterionPair,
  fmtCriterionThreshold,
  fmtMeanMs,
  fmtMs,
  fmtPct,
  fmtRps,
} from "./format";

const k = ko.print;

/** 서버 `Criteria::has_any` 미러: `rps_warmup_seconds`는 제외, `step_criteria`는 비어있지 않을 때만. */
export function criteriaHasAny(c: Criteria | null | undefined): boolean {
  if (!c) return false;
  const keys = [
    c.max_mean_ms,
    c.max_max_ms,
    c.max_p50_ms,
    c.max_p95_ms,
    c.max_p99_ms,
    c.max_error_rate,
    c.min_rps,
    c.max_4xx_rate,
    c.max_5xx_rate,
    c.max_4xx_count,
    c.max_5xx_count,
    c.min_window_rps,
  ];
  if (keys.some((v) => v !== undefined && v !== null)) return true;
  if ((c.max_percentiles_ms?.length ?? 0) > 0) return true;
  return (c.step_criteria?.length ?? 0) > 0;
}

export type CriterionSpec = {
  metric: string;
  op: "max" | "min";
  threshold: number;
  target: string | null;
};

/** run 필드 순서 = 서버 evaluate_criteria 순 뒤에 step_criteria 입력 순. */
export function expandCriteria(c: Criteria | null | undefined): CriterionSpec[] {
  if (!c) return [];
  // 서버 time_rows 정렬: 평균(0) → 백분위(N×1000, 같은 키면 고정 먼저) → 최대
  const time: Array<{ key: number; spec: CriterionSpec }> = [];
  const addTime = (key: number, metric: string, v: number | undefined | null) => {
    if (v !== undefined && v !== null)
      time.push({ key, spec: { metric, op: "max", threshold: v, target: null } });
  };
  addTime(0, "mean_ms", c.max_mean_ms);
  addTime(50000, "p50_ms", c.max_p50_ms);
  addTime(95000, "p95_ms", c.max_p95_ms);
  addTime(99000, "p99_ms", c.max_p99_ms);
  for (const p of c.max_percentiles_ms ?? []) {
    const metric = percentileMetricName(String(p.percentile));
    if (metric !== null) addTime(Math.round(p.percentile * 1000), metric, p.max_ms);
  }
  addTime(Number.MAX_SAFE_INTEGER, "max_ms", c.max_max_ms);
  time.sort((a, b) => a.key - b.key); // 안정 정렬 — 같은 키는 넣은 순서(고정 먼저)
  const run: Array<[string, "max" | "min", number | undefined]> = [
    ["error_rate", "max", c.max_error_rate],
    ["4xx_rate", "max", c.max_4xx_rate],
    ["5xx_rate", "max", c.max_5xx_rate],
    ["4xx_count", "max", c.max_4xx_count],
    ["5xx_count", "max", c.max_5xx_count],
    ["rps", "min", c.min_rps],
    ["min_window_rps", "min", c.min_window_rps],
  ];
  const out: CriterionSpec[] = time.map((t) => t.spec);
  for (const [metric, op, v] of run) {
    if (v !== undefined && v !== null) out.push({ metric, op, threshold: v, target: null });
  }
  for (const s of c.step_criteria ?? []) {
    out.push({ metric: s.metric, op: s.op, threshold: s.threshold, target: s.target });
  }
  return out;
}

type VerdictRow = Verdict["criteria"][number];
export type Matched = { spec: CriterionSpec; row: VerdictRow | null };

/** 키 (metric, target ?? null, op===direction, threshold)로 verdict 행을 소비하며 매칭. */
export function matchVerdict(
  specs: CriterionSpec[],
  verdict: Verdict | null | undefined,
): Matched[] {
  const pool = [...(verdict?.criteria ?? [])];
  return specs.map((spec) => {
    const i = pool.findIndex(
      (r) =>
        r.metric === spec.metric &&
        (r.target ?? null) === spec.target &&
        r.direction === spec.op &&
        r.threshold === spec.threshold,
    );
    if (i < 0) return { spec, row: null };
    const [row] = pool.splice(i, 1);
    return { spec, row };
  });
}

export type BoxState =
  | { kind: "fail"; evaluated: number; failed: number }
  | { kind: "pass"; evaluated: number }
  | { kind: "notJudged"; reason: "zero" | "aborted" | "failed" }
  | { kind: "notEvaluable" }
  | { kind: "noCriteria" };

export function verdictBox(a: {
  count: number;
  status: string;
  criteria: Criteria | null | undefined;
  verdict: Verdict | null | undefined;
}): BoxState {
  if (a.count === 0) return { kind: "notJudged", reason: "zero" };
  if (a.verdict) {
    const evaluated = a.verdict.criteria.length;
    const failed = a.verdict.criteria.filter((r) => !r.passed).length;
    return failed > 0 ? { kind: "fail", evaluated, failed } : { kind: "pass", evaluated };
  }
  if (!criteriaHasAny(a.criteria)) return { kind: "noCriteria" };
  if (a.status === "aborted") return { kind: "notJudged", reason: "aborted" };
  if (a.status === "failed") return { kind: "notJudged", reason: "failed" };
  return { kind: "notEvaluable" };
}

export function criterionName(metric: string): { name: string; subj: string } {
  const known = k.criteria.names[metric];
  if (known) return known;
  const n = parsePercentileMetric(metric);
  if (n !== null) return { name: k.criteria.percentileName(n), subj: "이" };
  return { name: metric, subj: k.criteria.unknownSubj };
}

export type KpiCard = {
  key: "rps" | "mean" | "p95" | "errorRate";
  label: string;
  value: string;
  unit: string;
  explain: string;
  target: string;
  bad: boolean;
};

const CARD_METRIC: Record<string, string> = {
  rps: "rps",
  mean: "mean_ms",
  p95: "p95_ms",
  errorRate: "error_rate",
};

function cardMatchIndex(matched: Matched[], metric: string): number {
  return matched.findIndex((m) => m.spec.metric === metric && m.spec.target === null);
}

export function kpiCards(
  summary: Report["summary"],
  matched: Matched[],
  box: BoxState,
  opts: { latency: boolean } = { latency: true },
): KpiCard[] {
  const ms = (v: number): string => (opts.latency ? fmtMs(v) : k.fmt.noTarget);
  const targetFor = (key: string): { target: string; bad: boolean } => {
    const metric = CARD_METRIC[key];
    const i = metric ? cardMatchIndex(matched, metric) : -1;
    if (i < 0) return { target: k.kpi.noTarget, bad: false };
    const { spec, row } = matched[i];
    const withRow = box.kind !== "notJudged" && box.kind !== "notEvaluable" && row ? row : null;
    const pair = withRow
      ? fmtCriterionPair(spec.metric, withRow.actual, spec.threshold, withRow.capped ?? false)
      : null;
    const t = pair ? pair.threshold : fmtCriterionThreshold(spec.metric, spec.threshold);
    const head = spec.op === "max" ? k.kpi.targetMax(t) : k.kpi.targetMin(t);
    if (box.kind === "notJudged") return { target: `${head} ${k.kpi.notJudged}`, bad: false };
    if (!withRow || !pair) return { target: `${head} ${k.kpi.notEvaluable}`, bad: false };
    const measured = withRow.no_sample
      ? k.kpi.measuredNone(ko.report.sample.noSample)
      : pair.tiny
        ? k.kpi.measuredTiny(pair.actual)
        : k.kpi.measured(pair.actual);
    return withRow.passed
      ? { target: `${head} ${k.kpi.met} ${measured}`, bad: false }
      : { target: `${head} ${k.kpi.missed} ${measured}`, bad: true };
  };
  const rpsText = fmtRps(summary.rps).replace(k.fmt.rpsUnit, "");
  return [
    {
      key: "rps",
      label: k.kpi.rps.label,
      value: rpsText,
      unit: k.kpi.rps.unit,
      explain: k.kpi.rps.explain,
    },
    {
      key: "mean",
      label: k.kpi.mean.label,
      value: opts.latency
        ? fmtMeanMs(summary.mean_ms, summary.stats?.capped ?? false)
        : k.fmt.noTarget,
      unit: k.kpi.mean.unit,
      explain: k.kpi.mean.explain,
    },
    {
      key: "p95",
      label: k.kpi.p95.label,
      value: ms(summary.p95_ms),
      unit: k.kpi.p95.unit,
      explain: k.kpi.p95.explain,
    },
    {
      key: "errorRate",
      label: k.kpi.errorRate.label,
      value: fmtPct(summary.count > 0 ? summary.errors / summary.count : 0),
      unit: k.kpi.errorRate.unit,
      explain: k.kpi.errorRate.explain(fmtCount(summary.errors), fmtCount(summary.count)),
    },
  ].map((c) => ({ ...c, ...targetFor(c.key) })) as KpiCard[];
}

export type OtherRow = {
  name: string;
  target: string;
  actual: string;
  judgement: "pass" | "fail" | "notJudged" | "notEvaluable";
};

export function otherCriteriaRows(
  matched: Matched[],
  box: BoxState,
  stepName: (id: string) => string,
): OtherRow[] {
  const used = new Set(Object.values(CARD_METRIC).map((m) => cardMatchIndex(matched, m)));
  const out: OtherRow[] = [];
  matched.forEach(({ spec, row: serverRow }, i) => {
    if (used.has(i)) return;
    // 판정 안 함 상자(0건 등)에선 서버 행을 무시 — kpiCards와 같이 "–"·판정 안 함 (§5.1)
    const row = box.kind === "notJudged" ? null : serverRow;
    const base = criterionName(spec.metric).name;
    const name = spec.target === null ? base : k.criteria.stepName(stepName(spec.target), base);
    const pair = row
      ? fmtCriterionPair(spec.metric, row.actual, spec.threshold, row.capped ?? false)
      : null;
    const t = pair ? pair.threshold : fmtCriterionThreshold(spec.metric, spec.threshold);
    const target = spec.op === "max" ? k.criteria.targetMax(t) : k.criteria.targetMin(t);
    if (row && pair) {
      out.push({
        name,
        target,
        actual: row.no_sample
          ? ko.report.sample.noSample
          : pair.tiny
            ? `${pair.actual} ${k.fmt.tiny}`
            : pair.actual,
        judgement: row.passed ? "pass" : "fail",
      });
    } else {
      out.push({
        name,
        target,
        actual: k.fmt.noTarget,
        judgement: box.kind === "notJudged" ? "notJudged" : "notEvaluable",
      });
    }
  });
  return out;
}

const RANK: Record<OtherRow["judgement"], number> = {
  fail: 0,
  notEvaluable: 1,
  notJudged: 2,
  pass: 3,
};
const STANDARD_MAX = 6;

export function limitOtherRows(
  rows: OtherRow[],
  mode: "standard" | "summary3" | "summary1",
  appendixRef: string = ko.print.section.appendixRef(null),
): { shown: OtherRow[]; restLine: string | null; truncated: boolean } {
  if (mode !== "standard") {
    const n = mode === "summary3" ? 3 : 1;
    const fails = rows.filter((r) => r.judgement === "fail");
    const over = fails.length - n;
    return {
      shown: fails.slice(0, n),
      restLine: over > 0 ? k.criteria.restFailOnly(over) : null,
      truncated: over > 0,
    };
  }
  if (rows.length <= STANDARD_MAX) return { shown: rows, restLine: null, truncated: false };
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => RANK[a.r.judgement] - RANK[b.r.judgement] || a.i - b.i)
    .map((x) => x.r);
  const shown = sorted.slice(0, STANDARD_MAX);
  const rest = sorted.slice(STANDARD_MAX);
  const cnt = (j: OtherRow["judgement"]) => rest.filter((r) => r.judgement === j).length;
  let restLine: string;
  if (cnt("pass") === rest.length) {
    restLine = k.criteria.allMet(rest.length);
  } else {
    const parts: string[] = [];
    if (cnt("pass") > 0) parts.push(k.criteria.restPass(cnt("pass")));
    if (cnt("fail") > 0) parts.push(k.criteria.restFail(cnt("fail")));
    if (cnt("notEvaluable") > 0) parts.push(k.criteria.restNotEvaluable(cnt("notEvaluable")));
    if (cnt("notJudged") > 0) parts.push(k.criteria.restNotJudged(cnt("notJudged")));
    restLine = k.criteria.restMixed(rest.length, parts.join(" · "), appendixRef);
  }
  return { shown, restLine, truncated: true };
}

export function otherCriteriaOneLine(rows: OtherRow[]): string | null {
  const failed = rows.filter((r) => r.judgement === "fail").length;
  return failed === 0 ? null : k.criteria.oneLine(rows.length, failed);
}
