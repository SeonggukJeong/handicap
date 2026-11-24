// 「단계별 응답 속도 구간」 절 뷰 모델 (순수). spec §7.3–§7.5.
// 통과/미달 낱말·전체 행의 붉은 표시는 서버 판정 행(matched)에서만 가져온다.

import { ko } from "../i18n/ko";
import type { Criteria, Report, SpeedBands } from "../api/schemas";
import { fmtBoundary, fmtMsExact, fmtPct, fmtPctPair } from "./format";
import { stepThresholds, type RankedRow } from "./stepStatus";
import type { Matched } from "./verdict";

const K = ko.print.speed;

/** 굵게/붉게 칠할 조각을 가진 글 한 줄(시안의 <b>·<b class="bad">). */
export type Seg = { text: string; strong?: boolean; bad?: boolean };
export type Mark = "none" | "warn" | "bad";
export type SpeedCell = {
  text: string;
  mark: Mark;
  glyph: "" | "▲" | "✕";
  muted: boolean;
  star: boolean;
};
export type BandName = "fast" | "within" | "over";
export type SpeedRow = {
  key: string;
  total: boolean;
  label: string;
  rowBad: boolean;
  ownNote: string | null;
  bar: Array<{ band: BandName; pct: number }> | null;
  merged: boolean;
  fast: SpeedCell | null;
  within: SpeedCell;
  over: SpeedCell;
  fail: SpeedCell;
};
export type SpeedModel = {
  twoBand: boolean;
  head: { fast: string | null; within: string; over: string; overSub: string | null };
  legend: Array<{ band: BandName; text: string }>;
  rows: SpeedRow[];
  rule: { segs: Seg[]; fail: boolean } | null;
  stepRules: Seg[][];
  stepRulesRest: string | null;
  ruleBoxFail: boolean;
  notes: Seg[][];
};

/** 안내 줄·쌍 표기에 찍는 허용 몫(글자용). */
export const ALLOWED: Record<"p95" | "p99" | "p50", number> = { p95: 0.05, p99: 0.01, p50: 0.5 };

type Basis = SpeedBands["overall"]["basis"];
type BandRow = SpeedBands["overall"];

/** 경계(ms): 규칙 2 run은 `slow_us`(µs)를 ms로, 규칙 1 run은 `slow_ms`. */
export function boundaryMs(row: { slow_ms: number; slow_us?: number }): number {
  return row.slow_us != null ? row.slow_us / 1000 : row.slow_ms;
}

/** 판정용 — 컨트롤러 `exceeds_allowance`와 같은 정수식. */
export function exceedsAllowance(basis: Basis, over: number, total: number): boolean {
  switch (basis) {
    case "p95":
      return 20 * over > total;
    case "p99":
      return 100 * over > total;
    case "p50":
      return 2 * over > total;
    default:
      return false;
  }
}

const MAX_STEP_RULES = 5;
const NAMED_MIN_RATE = 0.1;

const cell = (
  text: string,
  o: Partial<Pick<SpeedCell, "mark" | "glyph" | "muted" | "star">> = {},
): SpeedCell => ({
  text,
  mark: o.mark ?? "none",
  glyph: o.glyph ?? "",
  muted: o.muted ?? false,
  star: o.star ?? false,
});
const dash = (): SpeedCell => cell(K.dash, { muted: true });

export const rowTotal = (r: BandRow): number => (r.fast ?? 0) + r.within + r.over;
const share = (n: number, tot: number): number => (n * 100) / tot;
const pctCell = (n: number, tot: number): SpeedCell => cell(fmtPct(n / tot), { muted: n === 0 });

function metricOf(basis: Basis): string {
  return `${basis}_ms`;
}

function runMatch(matched: Matched[], metric: string): Matched | undefined {
  return matched.find((m) => m.spec.metric === metric && m.spec.target === null);
}

/** 허용 몫(글자·비교값용). 기준이 없는 default는 null. */
function allowedOf(basis: Basis): number | null {
  return basis === "default" ? null : ALLOWED[basis];
}

function overCell(row: BandRow, isTotal: boolean, matched: Matched[]): SpeedCell {
  const tot = rowTotal(row);
  if (tot === 0) return dash();
  const frac = row.over / tot;
  const allow = allowedOf(row.basis);
  const judged = allow !== null;
  const pair = allow !== null ? fmtPctPair(frac, allow, 1) : null;
  const text = pair ? pair.actual : fmtPct(frac);
  const star = pair ? pair.tiny : false;
  const muted = row.over === 0;
  if (isTotal) {
    const failed = judged && runMatch(matched, metricOf(row.basis))?.row?.passed === false;
    return cell(text, { mark: failed ? "bad" : "none", muted, star });
  }
  if (judged && exceedsAllowance(row.basis, row.over, tot))
    return cell(text, { mark: "warn", glyph: "▲", muted, star });
  return cell(text, { muted, star });
}

/** 실제값 글자. 기준과 글자로 구분이 안 되면 꼬리를 붙인다. */
function pairText(p: { actual: string; tiny: boolean }): string {
  return p.tiny ? `${p.actual} ${ko.print.fmt.tiny}` : p.actual;
}

function failCell(rate: number, threshold: number | null, mark: Mark, glyph: SpeedCell["glyph"]) {
  const pair = threshold !== null ? fmtPctPair(rate, threshold, 1) : null;
  return cell(pair ? pair.actual : fmtPct(rate), {
    mark,
    glyph,
    muted: rate === 0 && mark === "none",
    star: pair ? pair.tiny : false,
  });
}

function barOf(row: BandRow, tot: number): SpeedRow["bar"] {
  if (tot === 0) return null;
  const parts: Array<{ band: BandName; n: number }> =
    row.fast === null
      ? [
          { band: "fast", n: row.within },
          { band: "over", n: row.over },
        ]
      : [
          { band: "fast", n: row.fast },
          { band: "within", n: row.within },
          { band: "over", n: row.over },
        ];
  return parts.filter((p) => p.n > 0).map((p) => ({ band: p.band, pct: share(p.n, tot) }));
}

function bandCells(row: BandRow, twoBand: boolean, matched: Matched[], isTotal: boolean) {
  const tot = rowTotal(row);
  const merged = !twoBand && row.fast === null;
  if (tot === 0) {
    return {
      merged: false,
      fast: twoBand ? null : dash(),
      within: dash(),
      over: dash(),
    };
  }
  const within = merged
    ? cell(K.withinMerged(fmtBoundary(boundaryMs(row)), fmtPct(row.within / tot)), {
        muted: row.within === 0,
      })
    : pctCell(row.within, tot);
  return {
    merged,
    fast: twoBand || merged ? null : pctCell(row.fast ?? 0, tot),
    within,
    over: overCell(row, isTotal, matched),
  };
}

type OwnLine = { idx: number; fail: boolean; segs: Seg[] };

function ownLine(r: BandRow, id: string, ranked: RankedRow[], matched: Matched[]): OwnLine {
  const idx = ranked.findIndex((x) => x.stepId === id);
  const rr = idx >= 0 ? ranked[idx] : null;
  const label = rr ? `${rr.no} ${rr.name}` : id;
  const metric = metricOf(r.basis);
  let pick: Matched | null = null;
  for (const m of matched) {
    if (m.spec.target !== id || m.spec.metric !== metric || m.spec.op !== "max") continue;
    if (pick === null || m.spec.threshold < pick.spec.threshold) pick = m;
  }
  const threshold = pick ? pick.spec.threshold : boundaryMs(r);
  const critName = ko.print.criteria.names[metric]?.name ?? metric;
  const tot = rowTotal(r);
  let pct: string = K.dash;
  if (tot !== 0) {
    if (r.basis === "default") pct = fmtPct(r.over / tot);
    else pct = pairText(fmtPctPair(r.over / tot, ALLOWED[r.basis], 2));
  }
  const verdict = pick?.row ? (pick.row.passed ? "pass" : "fail") : null;
  return {
    idx: idx < 0 ? Number.MAX_SAFE_INTEGER : idx,
    fail: verdict === "fail",
    segs: K.stepRule(
      `${label} ${critName} ${ko.print.criteria.targetMax(fmtMsExact(threshold))}`,
      fmtBoundary(boundaryMs(r)),
      pct,
      verdict,
    ),
  };
}

/** 판정 표시(빨강·✕·▲·별) 없이 전체 요청 한 줄 — 비교 보고서 전용. */
export type OverallBand = {
  twoBand: boolean;
  /** 요청이 0건이면 null */
  bar: SpeedRow["bar"];
  /** 두 구간이면 null */
  fast: SpeedCell | null;
  within: SpeedCell;
  over: SpeedCell;
  /** errors / count, count 0이면 "—" */
  fail: SpeedCell;
};

export function buildOverallBand(
  overall: SpeedBands["overall"],
  summary: Pick<Report["summary"], "count" | "errors">,
): OverallBand {
  const tot = rowTotal(overall);
  const twoBand = overall.fast === null;
  const fail =
    summary.count === 0
      ? dash()
      : cell(fmtPct(summary.errors / summary.count), { muted: summary.errors === 0 });
  if (tot === 0) {
    return {
      twoBand,
      bar: null,
      fast: twoBand ? null : dash(),
      within: dash(),
      over: dash(),
      fail,
    };
  }
  return {
    twoBand,
    bar: barOf(overall, tot),
    fast: twoBand ? null : pctCell(overall.fast ?? 0, tot),
    within: pctCell(overall.within, tot),
    over: pctCell(overall.over, tot),
    fail,
  };
}

export function buildSpeedModel(a: {
  bands: SpeedBands;
  ranked: RankedRow[];
  summary: Report["summary"];
  matched: Matched[];
  criteria: Criteria | null;
  anyNotSent: boolean;
  /** 응답 시간 표본이 「통과한 요청」인 run(실패한 요청의 시간이 막대에 없다). 기본 거짓. */
  split?: boolean;
}): SpeedModel {
  const { bands, ranked, summary, matched, criteria } = a;
  const overall = bands.overall;
  const stepBands = new Map(bands.steps.map((s) => [s.step_id, s]));
  const twoBand = overall.fast === null && bands.steps.every((s) => s.fast === null);
  const uniform = bands.steps.every((s) => boundaryMs(s) === boundaryMs(overall));
  const B = fmtBoundary(boundaryMs(overall));
  const runJudged = overall.basis !== "default";

  const overSub = uniform
    ? runJudged
      ? K.overSubOver
      : null
    : runJudged
      ? K.overSubMixed(B)
      : K.overSubNoCriteria;
  const head: SpeedModel["head"] = twoBand
    ? {
        fast: null,
        within: uniform ? K.headIn(B) : K.headInMixed,
        over: uniform ? K.headOver(B) : K.headOverMixed,
        overSub,
      }
    : {
        fast: K.headFast,
        within: uniform ? K.headWithin(B) : K.headWithinMixed,
        over: uniform ? K.headOver(B) : K.headOverMixed,
        overSub,
      };
  const legendOver = uniform && runJudged ? K.legendOver(head.over) : head.over;
  const legend: SpeedModel["legend"] = twoBand
    ? [
        { band: "fast", text: head.within },
        { band: "over", text: legendOver },
      ]
    : [
        { band: "fast", text: K.headFast },
        { band: "within", text: head.within },
        { band: "over", text: legendOver },
      ];

  const rows: SpeedRow[] = [];
  const named: Array<{ glyph: string; label: string; rate: number; text: string }> = [];
  for (const r of ranked) {
    const label = `${r.no} ${r.name}`;
    const sb = r.executed ? stepBands.get(r.stepId) : undefined;
    let failC: SpeedCell;
    let rowBad = false;
    if (!r.executed) {
      failC = dash();
    } else {
      const rate = r.status.errorRate;
      const t = stepThresholds(r.stepId, criteria).errorRate;
      if (r.status.tags.includes("error")) {
        rowBad = true;
        failC = failCell(rate, t, "bad", "✕");
      } else if (r.status.tags.includes("hasErrors")) {
        failC = failCell(rate, t, "warn", "▲");
      } else {
        failC = failCell(rate, t, "none", "");
      }
    }
    if (!sb) {
      rows.push({
        key: r.stepId,
        total: false,
        label,
        rowBad,
        ownNote: null,
        bar: null,
        merged: false,
        fast: twoBand ? null : dash(),
        within: dash(),
        over: dash(),
        fail: failC,
      });
      continue;
    }
    const tot = rowTotal(sb);
    const c = bandCells(sb, twoBand, matched, false);
    const bar = barOf(sb, tot);
    rows.push({
      key: r.stepId,
      total: false,
      label,
      rowBad,
      ownNote: sb.own ? K.ownNote(fmtBoundary(boundaryMs(sb))) : null,
      bar,
      ...c,
      fail: failC,
    });
    if (failC.mark !== "none" && bar !== null && r.status.errorRate >= NAMED_MIN_RATE)
      named.push({
        glyph: failC.glyph,
        label,
        rate: r.status.errorRate,
        text: `${failC.text}${failC.star ? "*" : ""}`,
      });
  }

  const totalCount = summary.count;
  const errRow = runMatch(matched, "error_rate");
  const totalFail =
    totalCount === 0
      ? dash()
      : failCell(
          summary.errors / totalCount,
          criteria?.max_error_rate ?? null,
          errRow?.row?.passed === false ? "bad" : "none",
          "",
        );
  const totalTot = rowTotal(overall);
  rows.push({
    key: "total",
    total: true,
    label: K.totalRow,
    rowBad: false,
    ownNote: null,
    bar: barOf(overall, totalTot),
    ...bandCells(overall, twoBand, matched, true),
    fail: totalFail,
  });

  let rule: SpeedModel["rule"] = null;
  const allow = allowedOf(overall.basis);
  if (allow !== null) {
    const verdictRow = runMatch(matched, metricOf(overall.basis))?.row ?? null;
    const verdict = verdictRow ? (verdictRow.passed ? "pass" : "fail") : null;
    const pct = totalTot === 0 ? K.dash : pairText(fmtPctPair(overall.over / totalTot, allow, 2));
    const crit = ko.print.criteria.names[metricOf(overall.basis)]?.name ?? metricOf(overall.basis);
    rule = {
      segs: K.rule(
        `${crit} ${ko.print.criteria.targetMax(fmtMsExact(boundaryMs(overall)))}`,
        B,
        `${Math.round(allow * 100)}%`,
        pct,
        verdict,
      ),
      fail: verdict === "fail",
    };
  }

  const lines = bands.steps
    .filter((s) => s.own)
    .map((s) => ownLine(s, s.step_id, ranked, matched))
    .sort((x, y) => Number(y.fail) - Number(x.fail) || x.idx - y.idx);
  const stepRules = lines.slice(0, MAX_STEP_RULES).map((l) => l.segs);
  const stepRulesRest =
    lines.length > MAX_STEP_RULES ? K.stepRulesRest(lines.length - MAX_STEP_RULES) : null;

  const notes: Seg[][] = [];
  if (!runJudged) {
    const anyOwn = bands.steps.some((s) => s.own);
    notes.push([{ text: anyOwn ? K.noteDefaultMixed : K.noteDefault }]);
  }
  const bars: Seg[] = [{ text: a.split ? K.noteBarsPassed : K.noteBars }];
  if (!a.split && named.length > 0) {
    let best = named[0];
    for (const n of named) if (n.rate > best.rate) best = n;
    bars.push({ text: " " }, ...K.noteNamed(best.glyph, best.label, best.text));
    if (named.length > 1) bars.push({ text: ` ${K.noteNamedMore(named.length - 1)}` });
  }
  notes.push(bars);
  if (a.anyNotSent) notes.push([{ text: K.noteNotSent }]);
  if (rows.some((r) => r.over.star || r.fail.star)) notes.push([{ text: K.noteStar }]);

  return {
    twoBand,
    head,
    legend,
    rows,
    rule,
    stepRules,
    stepRulesRest,
    ruleBoxFail: rule?.fail === true,
    notes,
  };
}
