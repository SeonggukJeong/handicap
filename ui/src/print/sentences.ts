import { ko } from "../i18n/ko";
import { formatDurationKo } from "../i18n/duration";
import type { Criteria, Report } from "../api/schemas";
import { fmtCount, fmtMs, fmtCriterionPair } from "./format";
import type { ChartModel } from "./chartModel";
import {
  p95ExceedsLimit,
  rankRows,
  statUs,
  stepThresholds,
  type RankedRow,
  type StatusTag,
} from "./stepStatus";
import type { StepRow } from "./stepTable";
import { criterionName, type BoxState, type Matched } from "./verdict";

const S = ko.print.sentence;
const MAX_LINES = 5;

export type SummaryLine = {
  kind: "special" | "verdict" | "problemSteps" | "errorIdentity" | "hidden" | "slow" | "fallback";
  text: string;
};

export type SummaryInput = {
  status: string;
  message: string | null;
  startedMs: number | null;
  endedMs: number | null;
  summary: Report["summary"];
  box: BoxState;
  matched: Matched[];
  ranked: RankedRow[];
  rows: StepRow[];
  windows: Report["windows"];
  t0: number | null;
  /** 유지 구간 기준일 때 창의 끝(경과 초, 그 초 자체는 창 밖). 없으면 run 전체. */
  scopeEndSec?: number;
  chart: ChartModel;
  stepName: (id: string) => string;
  /** 느림 줄의 "기준 Y" 출처(`stepThresholds`). */
  criteria: Criteria | null | undefined;
  /** 요약의 응답 시간이 값을 가졌는가 — 없으면 응답 시간 문장을 내지 않는다. 기본 참. */
  latency?: boolean;
  /** 상태 코드 규칙 번호 — 「제외됐습니다」 문장이 따른다. */
  statusRule: 1 | 2;
};

const elapsed = (sec: number): string => formatDurationKo(Math.max(0, sec));

function specialLines(i: SummaryInput): SummaryLine[] {
  const out: SummaryLine[] = [];
  // run.message는 외부 공유 문서에 실린다 — 엔진 safe_cause 허용목록(crates/engine/src/error.rs)과 값 없는 컨트롤러 문구에 기댄다
  const reason = i.message ? S.reason(i.message) : "";
  if (i.summary.count === 0) out.push({ kind: "special", text: S.zero + reason });
  if (i.status === "aborted") {
    let text: string | null = S.abortedNoElapsed;
    if (i.startedMs === null) {
      // 시작 시각이 없고 요청이 0건이면 0건 줄에 붙은 사유가 이미 중단 이유를 말하므로 중단 줄을 반복하지 않는다
      if (i.summary.count === 0) text = reason ? null : S.abortedBeforeStart;
    } else if (i.endedMs !== null) text = S.abortedAt(elapsed((i.endedMs - i.startedMs) / 1000));
    if (text !== null) out.push({ kind: "special", text });
  } else if (i.status === "failed") {
    out.push({
      kind: "special",
      text: S.failedRun + (i.summary.count === 0 ? "" : reason),
    });
  }
  return out;
}

function verdictLine(i: SummaryInput): string | null {
  const b = i.box;
  if (b.kind === "pass") return S.allMet(b.evaluated);
  if (b.kind === "notEvaluable") return S.notEvaluable;
  if (b.kind === "notJudged") {
    if (b.reason === "aborted") return S.notJudgedAborted;
    if (b.reason === "failed") return S.notJudgedFailed;
    return null;
  }
  if (b.kind !== "fail") return null;
  const missed = i.matched.filter((m) => m.row !== null && !m.row.passed);
  if (missed.length === 0) return null;
  const { spec, row } = missed[0];
  if (row === null) return null;
  const { name, subj } = criterionName(spec.metric);
  const subject =
    spec.target === null ? name : ko.print.criteria.stepName(i.stepName(spec.target), name);
  const pair = fmtCriterionPair(spec.metric, row.actual, spec.threshold, row.capped ?? false);
  const thr = pair.threshold;
  const act = pair.tiny ? `${pair.actual} ${ko.print.fmt.tiny}` : pair.actual;
  const head = row.no_sample
    ? S.verdictNoSample(subject, subj, ko.report.sample.noSample, thr, spec.op)
    : spec.op === "max"
      ? S.verdictOver(subject, subj, act, thr)
      : S.verdictUnder(subject, subj, act, thr);
  return head + (missed.length > 1 ? S.more(missed.length - 1) : "");
}

const TAG_LABEL: Record<StatusTag, string> = {
  ...ko.print.status.short,
  ok: ko.print.status.remainder.ok,
  notRun: ko.print.status.remainder.notRun,
};

function problemLine(i: SummaryInput): string | null {
  const probs = rankRows(i.ranked).filter((r) => r.status.grade >= 2);
  if (probs.length === 0) return null;
  const items = probs
    .slice(0, 3)
    .map((r) => S.problemItem(r.no, r.name, TAG_LABEL[r.status.tags[0]]));
  return S.problemHead + items.join(", ") + (probs.length > 3 ? S.more(probs.length - 3) : "");
}

function identityLine(i: SummaryInput): string | null {
  const total = i.summary.errors;
  if (!(total > 0)) return null;
  let T: StepRow | null = null;
  for (const r of i.rows)
    if (r.errorCount > 0 && (T === null || r.errorCount > T.errorCount)) T = r;
  if (T === null) return null;
  const share = Math.min(1, T.errorCount / total);
  const pct = Math.round(share * 100);
  if (pct < 50) return S.scattered(T.name, pct);

  let c: { code: number; count: number } | null = null;
  for (const p of T.perCode) if (p.cls === "counted" && (c === null || p.count > c.count)) c = p;

  const t0 = i.t0;
  const own = i.windows.filter((w) => w.step_id === T.stepId);
  const rel = (w: { ts_second: number }) => (t0 === null ? 0 : Math.max(0, w.ts_second - t0));

  const notSentTail =
    T.notSent > 0 && (c === null || T.notSent >= c.count) && T.notSent >= T.residual;
  if (c === null || notSentTail) {
    const first = own.filter((w) => w.error_count > 0).map(rel);
    const when = t0 !== null && first.length > 0 ? S.firstSeen(elapsed(Math.min(...first))) : "";
    return S.identityMain(pct, T.name, notSentTail ? S.identityNotSent : S.identityResidual) + when;
  }

  const key = String(c.code);
  const codeText =
    c.code === 0
      ? ko.print.table.none + `(${ko.print.table.noneSub})`
      : ko.print.table.codeNames[c.code]
        ? S.codeWithName(c.code, ko.print.table.codeNames[c.code])
        : String(c.code);
  const head = S.identityMain(pct, T.name, S.identityMostly(codeText));
  const hits = own.filter((w) => (w.status_counts[key] ?? 0) > 0);
  if (t0 === null || hits.length === 0 || i.chart.bins.length === 0) return head;
  const first = Math.min(...hits.map(rel));
  const bin = i.chart.binSeconds;
  const i0 = Math.floor(first / bin);
  const hitBins = new Set(hits.map((w) => Math.floor(rel(w) / bin)));
  const binEnd =
    i.scopeEndSec === undefined
      ? i.chart.bins.length
      : i.chart.bins.filter((b) => b.startSec < i.scopeEndSec!).length;
  const span = binEnd - i0;
  let n = 0;
  for (let b = i0; b < binEnd; b++) if (hitBins.has(b)) n++;
  const continuing = span > 0 && n / span >= 0.5;
  return head + (continuing ? S.continuing(elapsed(first)) : S.firstSeen(elapsed(first)));
}

function hiddenLine(i: SummaryInput): string | null {
  type Item = { row: StepRow; code: number; count: number };
  const pick = (cls: "uncounted" | "unknown"): Item | null => {
    let best: Item | null = null;
    for (const row of i.rows)
      for (const p of row.perCode)
        if (p.cls === cls && (best === null || p.count > best.count))
          best = { row, code: p.code, count: p.count };
    return best;
  };
  const un = pick("uncounted");
  if (un) {
    const text = i.statusRule === 2 ? S.hiddenUncountedRule2 : S.hiddenUncounted;
    return text(un.row.name, un.code, fmtCount(un.count));
  }
  const unk = pick("unknown");
  if (unk) return S.hiddenUnknown(unk.row.name, unk.code, fmtCount(unk.count));
  return null;
}

function slowLine(i: SummaryInput): string | null {
  const slow = i.ranked.filter((r) => r.status.tags.includes("slow"));
  if (slow.length === 0) return null;
  // 느림 표지는 평균·최대·다른 백분위 때문일 수도 있다 — 95% 문장은 p95가 실제로 기준을 넘은 단계만 인용한다.
  const cited = slow.flatMap((r) => {
    const thr = stepThresholds(r.stepId, i.criteria).p95Ms;
    return thr !== null && p95ExceedsLimit(r, thr) ? [{ r, thr }] : [];
  });
  if (cited.length === 0) return null;
  const msOf = (r: RankedRow): number => (r.stats ? r.stats.p95_us / 1000 : r.p95Ms);
  let worst = cited[0];
  for (const c of cited) if (msOf(c.r) > msOf(worst.r)) worst = c;
  // 60초 칸에 잘린 실측은 하한이라 판정 문장과 같은 길(`fmtCriterionPair`)로 「≥」를 붙인다.
  const cut = worst.r.stats
    ? (statUs(worst.r.stats, "p95_ms")?.cut ?? false)
    : worst.r.p95Ms >= 60000;
  const pair = fmtCriterionPair("p95_ms", msOf(worst.r), worst.thr, cut);
  const act = pair.tiny ? `${pair.actual} ${ko.print.fmt.tiny}` : pair.actual;
  return (
    S.slow(worst.r.name, act, pair.threshold) + (slow.length > 1 ? S.more(slow.length - 1) : "")
  );
}

export function summaryLines(i: SummaryInput): SummaryLine[] {
  const lines: SummaryLine[] = [...specialLines(i)];
  const add = (kind: SummaryLine["kind"], text: string | null) => {
    if (text !== null) lines.push({ kind, text });
  };
  add("verdict", verdictLine(i));
  add("problemSteps", problemLine(i));
  add("errorIdentity", identityLine(i));
  add("hidden", hiddenLine(i));
  add("slow", slowLine(i));
  if (lines.length === 0) {
    const text = i.latency === false ? S.fallbackNoLatency : S.fallback(fmtMs(i.summary.p95_ms));
    return [{ kind: "fallback", text }];
  }
  return lines.slice(0, MAX_LINES);
}

export function shortSummary(lines: SummaryLine[]): SummaryLine[] {
  const kept = lines.filter(
    (l) => l.kind === "special" || l.kind === "verdict" || l.kind === "problemSteps",
  );
  // 깨끗한 무기준 run은 fallback 한 줄뿐 — 걸러 비우면 "(자동 작성)" 상자가 빈다
  if (kept.length === 0) return lines.filter((l) => l.kind === "fallback");
  return kept;
}
