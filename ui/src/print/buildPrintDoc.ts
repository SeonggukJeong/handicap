// 보고서 뷰 모델 · 블록 목록 (순수). spec §5·§5.1·§5.2·§9.

import { ko } from "../i18n/ko";
import { ProfileSchema, type Criteria, type Report, type Run } from "../api/schemas";
import { envValueToRecord } from "../api/runPrefill";
import { runShortLabel } from "../compare/runLabel";
import { fmtDate } from "./format";
import { readScenarioFacts } from "./scenarioFacts";
import { targetSystems } from "./redact";
import { buildStepTable, type StepTableModel } from "./stepTable";
import {
  calloutOneLine,
  callouts as buildCallouts,
  glossary as buildGlossary,
  legendItems,
  selectTopRows,
  stepStatus,
  type RankedRow,
} from "./stepStatus";
import { conditionsBox, loadConditionLine, measuredWindow } from "./conditions";
import {
  expandCriteria,
  kpiCards,
  limitOtherRows,
  matchVerdict,
  otherCriteriaOneLine,
  otherCriteriaRows,
  verdictBox,
  type BoxState,
  type KpiCard,
  type OtherRow,
} from "./verdict";
import { buildChartModel, chartReadingLine, runT0, type ChartModel } from "./chartModel";
import { summaryLines, type SummaryLine } from "./sentences";
import type { Block, LadderLevel } from "./paginate";

const D = ko.print.doc;
const V = ko.print.verdict;

export type PrintKind = "standard" | "summary";

export type PrintDoc = {
  title: string;
  shortId: string;
  createdDate: string;
  meta: { targets: string; window: string; load: string; ident: string };
  box: BoxState;
  boxText: { big: string; sub: string };
  lines: SummaryLine[];
  kpis: KpiCard[];
  otherRows: OtherRow[];
  table: StepTableModel;
  ranked: RankedRow[];
  legend: string[];
  callouts: ReturnType<typeof buildCallouts>;
  chart: ChartModel;
  readingLine: string;
  conditions: ReturnType<typeof conditionsBox>;
  claims: { can: string[]; cannot: string[] } | null;
  glossary: ReturnType<typeof buildGlossary>;
};

function boxText(box: BoxState): { big: string; sub: string } {
  switch (box.kind) {
    case "fail":
      return { big: V.fail, sub: V.subFail(box.evaluated, box.failed) };
    case "pass":
      return { big: V.pass, sub: V.subPass(box.evaluated) };
    case "notJudged":
      return {
        big: V.notJudged,
        sub:
          box.reason === "zero" ? V.subZero : box.reason === "aborted" ? V.subAborted : V.subFailed,
      };
    case "notEvaluable":
      return { big: V.notEvaluable, sub: V.subNotEvaluable };
    case "noCriteria":
      return { big: V.noCriteria, sub: V.subNoCriteria };
  }
}

const claimText = (map: Record<string, string>, code: string): string => map[code] ?? code;

export function buildPrintDoc(a: {
  run: Run;
  report: Report;
  fallbackScenarioName: string | null;
  now: number;
}): PrintDoc {
  const { run, report } = a;
  const facts = readScenarioFacts(report.scenario_yaml);
  const env = envValueToRecord(report.run.env);
  const parsed = ProfileSchema.safeParse(report.run.profile);
  const criteria: Criteria | null = parsed.success ? (parsed.data.criteria ?? null) : null;

  const table = buildStepTable(report.steps, facts);
  const nameById = new Map(table.rows.map((r) => [r.stepId, r.name]));
  const stepName = (id: string): string => nameById.get(id) || id;
  const ranked: RankedRow[] = table.rows.map((r) => ({ ...r, status: stepStatus(r, criteria) }));

  const matched = matchVerdict(expandCriteria(criteria), report.verdict);
  const box = verdictBox({
    count: report.summary.count,
    status: run.status,
    criteria,
    verdict: report.verdict,
  });
  const t0 = runT0(run.started_at, report.windows);
  const chart = buildChartModel(report.windows, t0, table.rows);

  const rawName = facts.ok ? facts.name : null;
  const name =
    (rawName && rawName.trim()) ||
    (a.fallbackScenarioName && a.fallbackScenarioName.trim()) ||
    D.titleFallbackName;
  const shortId = runShortLabel(run.id);
  const label = run.label?.trim() ? run.label : null;

  const nar = report.narrative;
  const can = (nar?.can_claim ?? []).map((c) => claimText(ko.narrative.can, c));
  const cannot = (nar?.cannot_claim ?? []).map((c) => claimText(ko.narrative.cannot, c));

  return {
    title: D.title(name),
    shortId,
    createdDate: fmtDate(a.now),
    meta: {
      targets: targetSystems(facts.ok ? facts.steps : [], env),
      window: measuredWindow(run.started_at, run.ended_at, run.status),
      load: parsed.success ? loadConditionLine(parsed.data) : ko.print.fmt.noTarget,
      ident: label ? D.identLabeled(shortId, label) : shortId,
    },
    box,
    boxText: boxText(box),
    lines: summaryLines({
      status: run.status,
      message: run.message ?? null,
      startedMs: run.started_at,
      endedMs: run.ended_at,
      summary: report.summary,
      box,
      matched,
      ranked,
      rows: table.rows,
      windows: report.windows,
      t0,
      chart,
      stepName,
      criteria,
    }),
    kpis: kpiCards(report.summary, matched, box),
    otherRows: otherCriteriaRows(matched, box, stepName),
    table,
    ranked,
    legend: legendItems(table, ranked),
    callouts: buildCallouts(ranked, report.summary),
    chart,
    readingLine: chartReadingLine(chart),
    conditions: conditionsBox({
      profileRaw: report.run.profile,
      workerBreakdownLen: report.worker_breakdown?.length ?? 0,
      envCount: Object.keys(env).length,
    }),
    claims: can.length === 0 && cannot.length === 0 ? null : { can, cannot },
    glossary: buildGlossary(table, ranked, report.error_kinds),
  };
}

// ── 블록 ──────────────────────────────────────────────────────────────────

export type Heights = Map<string, number>;

export const MEASURE_IDS = {
  tableTitle: "table:title",
  tableHeader: "table:header",
  appendixTitle: "appendix:title",
  appendixHeader: "appendix:header",
  rowId: (stepId: string): string => `row:${stepId}`,
  remainderId: (n: number): string => `table:remainder:${n}`,
  appendixRowId: (i: number): string => `appendix:row:${i}`,
} as const;

const atom = (h: Heights, id: string): Block => ({
  kind: "atomic",
  id,
  heightMm: h.get(id) ?? 0,
});

const hasCallouts = (doc: PrintDoc): boolean =>
  doc.callouts.uncounted !== null || doc.callouts.unknown !== null;

export function standardBlocks(doc: PrintDoc, h: Heights): Block[] {
  const out: Block[] = [atom(h, "header"), atom(h, "verdict:full"), atom(h, "kpis")];
  if (doc.otherRows.length > 0) out.push(atom(h, "other:standard"));
  out.push({
    kind: "table",
    id: "table",
    titleMm: h.get(MEASURE_IDS.tableTitle) ?? 0,
    headerMm: h.get(MEASURE_IDS.tableHeader) ?? 0,
    rowsMm: doc.table.rows.map((r) => h.get(MEASURE_IDS.rowId(r.stepId)) ?? 0),
  });
  out.push(atom(h, "legend:full"));
  if (hasCallouts(doc)) out.push(atom(h, "callouts:full"));
  if (doc.table.foldNotes.length > 0) out.push(atom(h, "notes:fold"));
  if (doc.table.scenarioUnreadable) out.push(atom(h, "notes:unreadable"));
  out.push(atom(h, "chart"), atom(h, "conditions"), atom(h, "glossary"));
  if (limitOtherRows(doc.otherRows, "standard").truncated) {
    out.push({
      kind: "table",
      id: "appendix",
      titleMm: h.get(MEASURE_IDS.appendixTitle) ?? 0,
      headerMm: h.get(MEASURE_IDS.appendixHeader) ?? 0,
      rowsMm: doc.otherRows.map((_, i) => h.get(MEASURE_IDS.appendixRowId(i)) ?? 0),
    });
  }
  out.push(atom(h, "signature"));
  return out;
}

export function summaryRows(
  doc: PrintDoc,
  level: LadderLevel,
): { shown: RankedRow[]; remainderLine: string | null } {
  return selectTopRows(doc.ranked, summaryN(level));
}

const summaryN = (level: LadderLevel): number => (level >= 8 ? 4 : level >= 7 ? 6 : 8);

export function summaryBlocks(doc: PrintDoc, h: Heights, level: LadderLevel): Block[] {
  const out: Block[] = [
    atom(h, "header"),
    atom(h, level >= 6 ? "verdict:short" : "verdict:full"),
    atom(h, "kpis"),
  ];
  if (doc.otherRows.some((r) => r.judgement === "fail")) {
    out.push(atom(h, level >= 5 ? "other:line" : level >= 4 ? "other:summary1" : "other:summary3"));
  }
  const { shown, remainderLine } = summaryRows(doc, level);
  const rowsMm = shown.map((r) => h.get(MEASURE_IDS.rowId(r.stepId)) ?? 0);
  if (remainderLine !== null) rowsMm.push(h.get(MEASURE_IDS.remainderId(summaryN(level))) ?? 0);
  out.push({
    kind: "table",
    id: "table",
    titleMm: h.get(MEASURE_IDS.tableTitle) ?? 0,
    headerMm: h.get(MEASURE_IDS.tableHeader) ?? 0,
    rowsMm,
  });
  out.push(atom(h, level >= 2 ? "legend:short" : "legend:full"));
  if (hasCallouts(doc)) out.push(atom(h, level >= 3 ? "callouts:line" : "callouts:full"));
  if (level < 1 && doc.table.foldNotes.length > 0) out.push(atom(h, "notes:fold"));
  if (doc.table.scenarioUnreadable) out.push(atom(h, "notes:unreadable"));
  return out;
}

// 렌더러가 쓰는 재수출(한 줄 문구 단일 소스).
export { calloutOneLine, otherCriteriaOneLine };
