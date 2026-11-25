// 보고서 뷰 모델 · 블록 목록 (순수). spec §5·§5.1·§5.2·§9.

import { ko } from "../i18n/ko";
import {
  ProfileSchema,
  reportSample,
  reportStatusRule,
  type Criteria,
  type Report,
  type ReportSampleName,
  type Run,
  type StairReport,
} from "../api/schemas";
import { hasLatency, summaryCounts } from "../report/hasLatency";
import { envValueToRecord } from "../api/runPrefill";
import { runShortLabel } from "../compare/runLabel";
import { fmtDate } from "./format";
import { readScenarioFacts } from "./scenarioFacts";
import { targetSystems } from "./redact";
import { discardWarningSteps } from "./stairTable";
import { suspendedLineText } from "../components/report/stair/stairFormat";
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
import {
  buildChartModel,
  chartReadingLine,
  elapsedText,
  runT0,
  type ChartModel,
} from "./chartModel";
import { basisLine, basisOtherLine } from "../components/report/basisText";
import { summaryLines, type SummaryLine } from "./sentences";
import { buildSpeedModel, type SpeedModel } from "./speedBands";
import { buildSetupModel, type SetupPrintModel } from "./setupTable";
import { buildLatencyChart, type LatencyChartModel } from "./latencyChart";
import { deriveLoadMode } from "../components/run/loadModel";
import type { Block, LadderLevel } from "./paginate";

const D = ko.print.doc;
const V = ko.print.verdict;

export type PrintKind = "standard" | "summary";

export type PrintDoc = {
  title: string;
  shortId: string;
  createdDate: string;
  meta: {
    targets: string;
    window: string;
    load: string;
    ident: string;
    basis?: string;
    basisOther?: string;
    /** 준비 스텝이 있는 run의 머리 한 줄 안내. */
    setupNote?: string;
    /** 응답 시간 표본 한 줄 — 리포트에 창이 없으면 없다. */
    sampleNote?: string;
  };
  sample: ReportSampleName;
  box: BoxState;
  boxText: { big: string; sub: string };
  lines: SummaryLine[];
  kpis: KpiCard[];
  otherRows: OtherRow[];
  table: StepTableModel;
  ranked: RankedRow[];
  legend: string[];
  callouts: ReturnType<typeof buildCallouts>;
  /** 상태 코드 규칙 번호 — 범례·콜아웃 글이 이것을 따른다. */
  statusRule: 1 | 2;
  chart: ChartModel;
  latencyChart: LatencyChartModel | null;
  readingLine: string;
  conditions: ReturnType<typeof conditionsBox>;
  claims: { can: string[]; cannot: string[] } | null;
  glossary: ReturnType<typeof buildGlossary>;
  stair: StairReport | null;
  speed: SpeedModel | null;
  setup: SetupPrintModel | null;
  sectionNo: SectionNo;
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
  run: Pick<Run, "id" | "status" | "started_at" | "ended_at" | "label" | "message">;
  report: Report;
  fallbackScenarioName: string | null;
  now: number;
}): PrintDoc {
  const { run, report } = a;
  const facts = readScenarioFacts(report.scenario_yaml);
  const statusRule = reportStatusRule(report);
  const env = envValueToRecord(report.run.env);
  const parsed = ProfileSchema.safeParse(report.run.profile);
  const criteria: Criteria | null = parsed.success ? (parsed.data.criteria ?? null) : null;

  const table = buildStepTable(report.steps, facts, statusRule);
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
  const basis = report.basis;
  const bw = basis?.window ?? null;
  const steadyMarks =
    basis && bw && t0 !== null
      ? { startSec: bw.start_ms / 1000 - t0, endSec: bw.end_ms / 1000 - t0 }
      : undefined;
  const chart = buildChartModel(report.windows, t0, table.rows, steadyMarks);
  const scoped = basis?.selected === "steady" && bw !== null && t0 !== null;
  const summaryWindows = scoped
    ? report.windows.filter(
        (w) => w.ts_second >= bw.start_ms / 1000 && w.ts_second < bw.end_ms / 1000,
      )
    : report.windows;
  const scopeEndSec = scoped ? bw.end_ms / 1000 - t0 : undefined;
  const sample = reportSample(report).default;
  const hasTime = hasLatency(summaryCounts(report), sample);
  const sampleNote =
    report.windows.length === 0 ? null : sample === "passed" ? D.sampleNotePassed : D.sampleNoteAll;
  const basisOther = basis ? basisOtherLine(basis, reportSample(report).selected) : null;
  const readingBase = chartReadingLine(chart);
  const readingLine =
    basis && chart.steady
      ? `${readingBase.endsWith(".") ? readingBase : `${readingBase}.`} ${ko.print.chart.readingSteady(
          elapsedText(chart.steady.startSec),
          elapsedText(chart.steady.endSec),
          basis.selected,
        )}`
      : readingBase;

  const speed = report.speed_bands
    ? buildSpeedModel({
        bands: report.speed_bands,
        ranked,
        summary: report.summary,
        matched,
        criteria,
        anyNotSent: table.rows.some((r) => r.notSent > 0),
        split: sample === "passed",
      })
    : null;

  const setup = report.setup
    ? buildSetupModel({
        setup: report.setup,
        facts: facts.ok ? facts.setupSteps : [],
        open: parsed.success ? deriveLoadMode(parsed.data).loadModel === "open" : false,
      })
    : null;

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
      targets: targetSystems(facts.ok ? [...facts.setupSteps, ...facts.steps] : [], env),
      window: measuredWindow(run.started_at, run.ended_at, run.status),
      load: parsed.success ? loadConditionLine(parsed.data) : ko.print.fmt.noTarget,
      ident: label ? D.identLabeled(shortId, label) : shortId,
      ...(basis ? { basis: basisLine(basis) } : {}),
      ...(basisOther !== null ? { basisOther } : {}),
      ...(report.setup ? { setupNote: ko.report.setup.summaryLine } : {}),
      ...(sampleNote !== null ? { sampleNote } : {}),
    },
    sample,
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
      windows: summaryWindows,
      t0,
      ...(scopeEndSec !== undefined ? { scopeEndSec } : {}),
      chart,
      stepName,
      statusRule,
      criteria,
      latency: hasTime,
    }),
    kpis: kpiCards(report.summary, matched, box, { latency: hasTime }),
    otherRows: otherCriteriaRows(matched, box, stepName),
    table,
    ranked,
    legend: legendItems(table, ranked, statusRule),
    statusRule,
    callouts: buildCallouts(ranked, report.summary, statusRule),
    chart,
    latencyChart: buildLatencyChart(report.latency_by_second ?? [], t0, chart),
    readingLine,
    conditions: conditionsBox({
      profileRaw: report.run.profile,
      workerBreakdownLen: report.worker_breakdown?.length ?? 0,
      envCount: Object.keys(env).length,
    }),
    claims: can.length === 0 && cannot.length === 0 ? null : { can, cannot },
    glossary: buildGlossary(table, ranked, report.error_kinds, statusRule),
    stair: report.stair ?? null,
    speed,
    setup,
    sectionNo: sectionNumbers({ setup: setup !== null, speed: speed !== null }),
  };
}

export type SectionNo = {
  setup: string | null;
  speed: string | null;
  chart: string;
  conditions: string;
  glossary: string;
};

/** 있는 절만 준비 → 속도 구간 → 그림 → 조건 → 용어 순서로 3부터 센다. */
export function sectionNumbers(a: { setup: boolean; speed: boolean }): SectionNo {
  const s = ko.print.section;
  let n = 3;
  const setup = a.setup ? s.setup(n++) : null;
  const speed = a.speed ? s.speed(n++) : null;
  return {
    setup,
    speed,
    chart: s.chart(n++),
    conditions: s.conditions(n++),
    glossary: s.glossary(n),
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
  stairTitle: "stair:title",
  stairHeader: "stair:header",
  stairRowId: (i: number): string => `stair:row:${i}`,
  speedTitle: "speed:title",
  speedHeader: "speed:header",
  speedRowId: (key: string): string => `speed:row:${key}`,
  setupTitle: "setup:title",
  setupHeader: "setup:header",
  setupRowId: (stepId: string): string => `setup:row:${stepId}`,
} as const;

const atom = (h: Heights, id: string): Block => ({
  kind: "atomic",
  id,
  heightMm: h.get(id) ?? 0,
});

const hasCallouts = (doc: PrintDoc): boolean =>
  doc.callouts.uncounted !== null || doc.callouts.unknown !== null;

/** 정지 줄(노랑) 또는 보류 줄(회색)이 있으면 `stair:stop` 블록 — 기록이 없으면 블록 없음. */
const hasStairStop = (doc: PrintDoc): boolean =>
  doc.stair !== null &&
  (doc.stair.auto_stop?.stop != null || suspendedLineText(doc.stair) !== null);

export function standardBlocks(doc: PrintDoc, h: Heights): Block[] {
  const out: Block[] = [atom(h, "header"), atom(h, "verdict:full"), atom(h, "kpis")];
  if (doc.stair !== null) {
    if (hasStairStop(doc)) out.push(atom(h, "stair:stop"));
    out.push(atom(h, "stair:headline"), {
      kind: "table",
      id: "stair",
      titleMm: h.get(MEASURE_IDS.stairTitle) ?? 0,
      headerMm: h.get(MEASURE_IDS.stairHeader) ?? 0,
      rowsMm: doc.stair.steps.map((_, i) => h.get(MEASURE_IDS.stairRowId(i)) ?? 0),
    });
    if (discardWarningSteps(doc.stair).length > 0) {
      out.push(atom(h, "stair:warnings"));
    }
    out.push(atom(h, "stair:units"));
  }
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
  if (doc.setup !== null) {
    out.push({
      kind: "table",
      id: "setup",
      titleMm: h.get(MEASURE_IDS.setupTitle) ?? 0,
      headerMm: h.get(MEASURE_IDS.setupHeader) ?? 0,
      rowsMm: doc.setup.rows.map((r) => h.get(MEASURE_IDS.setupRowId(r.stepId)) ?? 0),
    });
    if (doc.setup.kindsLine !== null) out.push(atom(h, "setup:kinds"));
  }
  if (doc.speed !== null) {
    out.push(
      {
        kind: "table",
        id: "speed",
        titleMm: h.get(MEASURE_IDS.speedTitle) ?? 0,
        headerMm: h.get(MEASURE_IDS.speedHeader) ?? 0,
        rowsMm: doc.speed.rows.map((r) => h.get(MEASURE_IDS.speedRowId(r.key)) ?? 0),
      },
      atom(h, "speed:notes"),
    );
  }
  out.push(atom(h, "chart"));
  if (doc.latencyChart !== null) out.push(atom(h, "chart:latency"));
  out.push(atom(h, "conditions"), atom(h, "glossary"));
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
  if (doc.stair !== null) {
    if (hasStairStop(doc)) out.push(atom(h, "stair:stop"));
    out.push(atom(h, "stair:headline:short"));
  }
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
