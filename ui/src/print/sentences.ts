import { ko } from "../i18n/ko";
import { formatDurationKo } from "../i18n/duration";
import type { Criteria, Report } from "../api/schemas";
import { fmtCount, fmtMs } from "./format";
import type { ChartModel } from "./chartModel";
import { rankRows, stepThresholds, type RankedRow, type StatusTag } from "./stepStatus";
import type { StepRow } from "./stepTable";
import { criterionName, criterionValue, type BoxState, type Matched } from "./verdict";

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
  chart: ChartModel;
  stepName: (id: string) => string;
  /** 느림 줄의 "기준 Y" 출처(`stepThresholds`). */
  criteria: Criteria | null | undefined;
};

const elapsed = (sec: number): string => formatDurationKo(Math.max(0, sec));

function specialLines(i: SummaryInput): SummaryLine[] {
  const out: SummaryLine[] = [];
  const reason = i.message ? S.reason(i.message) : "";
  if (i.summary.count === 0) out.push({ kind: "special", text: S.zero + reason });
  if (i.status === "aborted") {
    let text: string = S.abortedNoElapsed;
    if (i.startedMs === null) text = S.abortedBeforeStart;
    else if (i.endedMs !== null) text = S.abortedAt(elapsed((i.endedMs - i.startedMs) / 1000));
    out.push({ kind: "special", text });
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
  const thr = criterionValue(spec.metric, spec.threshold);
  const act = criterionValue(spec.metric, row.actual);
  const head =
    spec.op === "max"
      ? S.verdictOver(subject, subj, act, thr)
      : S.verdictUnder(subject, subj, act, thr);
  return head + (missed.length > 1 ? S.more(missed.length - 1) : "");
}

const TAG_LABEL: Partial<Record<StatusTag, string>> = ko.print.status.short;

function problemLine(i: SummaryInput): string | null {
  const probs = rankRows(i.ranked).filter((r) => r.status.grade >= 2);
  if (probs.length === 0) return null;
  const items = probs
    .slice(0, 3)
    .map((r) => S.problemItem(r.no, r.name, TAG_LABEL[r.status.tags[0]] ?? ""));
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
  if (share < 0.5) return S.scattered(T.name, pct);

  let c: { code: number; count: number } | null = null;
  for (const p of T.perCode) if (p.cls === "counted" && (c === null || p.count > c.count)) c = p;

  const t0 = i.t0;
  const own = i.windows.filter((w) => w.step_id === T.stepId);
  const rel = (w: { ts_second: number }) => (t0 === null ? 0 : Math.max(0, w.ts_second - t0));

  if (c === null) {
    const first = own.filter((w) => w.error_count > 0).map(rel);
    const when = t0 !== null && first.length > 0 ? S.firstSeen(elapsed(Math.min(...first))) : "";
    return S.identityMain(pct, T.name, S.identityResidual) + when;
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
  const span = i.chart.bins.length - i0;
  let n = 0;
  for (let b = i0; b < i.chart.bins.length; b++) if (hitBins.has(b)) n++;
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
  if (un) return S.hiddenUncounted(un.row.name, un.code, fmtCount(un.count));
  const unk = pick("unknown");
  if (unk) return S.hiddenUnknown(unk.row.name, unk.code, fmtCount(unk.count));
  return null;
}

function slowLine(i: SummaryInput): string | null {
  const slow = i.ranked.filter((r) => r.status.tags.includes("slow"));
  if (slow.length === 0) return null;
  let worst = slow[0];
  for (const r of slow) if (r.p95Ms > worst.p95Ms) worst = r;
  const thr = stepThresholds(worst.stepId, i.criteria).p95Ms;
  if (thr === null) return null;
  return (
    S.slow(worst.name, fmtMs(worst.p95Ms), fmtMs(thr)) +
    (slow.length > 1 ? S.more(slow.length - 1) : "")
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
    return [{ kind: "fallback", text: S.fallback(fmtMs(i.summary.p95_ms)) }];
  }
  return lines.slice(0, MAX_LINES);
}

export function shortSummary(lines: SummaryLine[]): SummaryLine[] {
  return lines.filter(
    (l) => l.kind === "special" || l.kind === "verdict" || l.kind === "problemSteps",
  );
}
