// 비교 보고서 문서 모델 · 블록 목록 (순수). spec §6·§8·§10.

import { ko } from "../../i18n/ko";
import { runShortLabel } from "../../compare/runLabel";
import { summaryLatencyMissing } from "../../compare/latencyMissing";
import { measuredWindow } from "../conditions";
import { fmtDate } from "../format";
import type { Block } from "../paginate";
import type { BoxState } from "../verdict";
import type { Heights } from "../buildPrintDoc";
import { buildDumbbell, type DumbbellModel } from "./dumbbell";
import { buildOverlay, type OverlayModel } from "./overlay";
import { buildSpeedCompare, type SpeedCompare } from "./speedCompare";
import { buildErrorTable, type ErrorTableModel } from "./errorTable";
import { metricRows, type MetricRow } from "./change";
import { biggestCodeChange, hasStar, remainingIssues, starFootnote, stepPairs } from "./errorCells";
import { buildFairness, type Fairness } from "./fairness";
import {
  buildHeadline,
  cmpSummaryLines,
  verdictWord,
  type Headline,
  type CmpSummaryLine,
} from "./headline";
import type { RunModel } from "./runModel";

const D = ko.print.cmp.doc;

export type SideHead = {
  role: string;
  label: string | null;
  shortId: string;
  window: string;
  verdictText: string;
  verdictKind: BoxState["kind"];
};

export type CompareDoc = {
  title: string;
  footerTitle: string;
  footerIds: string;
  createdDate: string;
  before: SideHead;
  after: SideHead;
  headline: Headline;
  lines: CmpSummaryLine[];
  fairness: Fairness;
  rows: MetricRow[];
  starNote: string | null;
  issues: string[];
  incomparable: boolean;
  dumbbell: DumbbellModel;
  /** 단계별 평균 응답 시간 덤벨(표준판) */
  meanDumbbell: DumbbellModel;
  errors: ErrorTableModel;
  overlay: OverlayModel;
  /** 양쪽 리포트에 speed_bands가 있을 때만 */
  speed: SpeedCompare | null;
  /** stepPairs가 1개 이상 */
  hasSteps: boolean;
};

function scenarioName(run: RunModel): string | null {
  const n = run.facts.ok ? run.facts.name : null;
  return n && n.trim() ? n.trim() : null;
}

function sideHead(role: string, run: RunModel): SideHead {
  const { meta } = run;
  return {
    role,
    label: meta.label?.trim() || null,
    shortId: runShortLabel(meta.id),
    window: measuredWindow(meta.started_at, meta.ended_at, meta.status),
    verdictText: verdictWord(run.box),
    verdictKind: run.box.kind,
  };
}

export function buildCompareDoc(a: {
  before: RunModel;
  after: RunModel;
  fallbackScenarioName: string | null;
  now: number;
}): CompareDoc {
  const { before, after } = a;
  const shownName =
    scenarioName(after) ??
    scenarioName(before) ??
    (a.fallbackScenarioName?.trim() || ko.print.doc.titleFallbackName);

  const incomparable = before.report.summary.count === 0 || after.report.summary.count === 0;
  const pairs = stepPairs(before, after);
  const star = hasStar(pairs);
  const rows = metricRows(before.report.summary, after.report.summary, {
    errorRateReference: star,
    incomparable,
    latencyMissing: {
      before: summaryLatencyMissing(before.report),
      after: summaryLatencyMissing(after.report),
    },
  });
  const fairness = buildFairness(before, after);
  const headline = buildHeadline({
    rows,
    beforeBox: before.box,
    afterBox: after.box,
    criteriaSame: fairness.criteriaSame,
    anyDiff: fairness.anyDiff,
    incomparable,
  });
  const lines = cmpSummaryLines({
    headline,
    rows,
    before,
    after,
    fairness,
    codeChange: biggestCodeChange(pairs),
  });

  return {
    title: D.title(shownName),
    footerTitle: D.footerTitle(shownName),
    footerIds: D.footerIds(runShortLabel(before.meta.id), runShortLabel(after.meta.id)),
    createdDate: fmtDate(a.now),
    before: sideHead(D.roleBefore, before),
    after: sideHead(D.roleAfter, after),
    headline,
    lines,
    fairness,
    rows,
    starNote: star && !incomparable ? starFootnote(pairs) : null,
    issues: incomparable ? [] : remainingIssues(after, pairs),
    incomparable,
    dumbbell: buildDumbbell(before, after, pairs),
    meanDumbbell: buildDumbbell(before, after, pairs, "mean"),
    errors: buildErrorTable({ before, after, pairs, incomparable }),
    overlay: buildOverlay(before, after, incomparable),
    speed: buildSpeedCompare(before, after),
    hasSteps: pairs.length > 0,
  };
}

// ── 블록 ──────────────────────────────────────────────────────────────────

export const CMP_LAST_LEVEL = 5;

export type CmpTableId = "cmp:cond" | "cmp:db" | "cmp:dbm" | "cmp:err";

export const tableIds = (id: CmpTableId) => ({
  title: `${id}:title`,
  header: `${id}:header`,
  row: (i: number): string => `${id}:row:${i}`,
});

const CMP_COND_IDS = tableIds("cmp:cond");
export const CMP_IDS = {
  condTitle: CMP_COND_IDS.title,
  condHeader: CMP_COND_IDS.header,
  condRowId: CMP_COND_IDS.row,
} as const;

const atom = (h: Heights, id: string): Block => ({
  kind: "atomic",
  id,
  heightMm: h.get(id) ?? 0,
});

function tableBlock(id: CmpTableId, rowCount: number, h: Heights): Block {
  const ids = tableIds(id);
  return {
    kind: "table",
    id,
    titleMm: h.get(ids.title) ?? 0,
    headerMm: h.get(ids.header) ?? 0,
    rowsMm: Array.from({ length: rowCount }, (_, i) => h.get(ids.row(i)) ?? 0),
  };
}

export function compareStandardBlocks(doc: CompareDoc, h: Heights): Block[] {
  return [
    atom(h, "cmp:header"),
    atom(h, "cmp:headline"),
    atom(h, "cmp:lines:full"),
    atom(h, "cmp:cards"),
    atom(h, "cmp:kpi:bars:std"),
    atom(h, "cmp:kpi:note"),
    ...(doc.hasSteps
      ? [
          tableBlock("cmp:db", doc.dumbbell.rows.length, h),
          atom(h, "cmp:db:legend"),
          tableBlock("cmp:dbm", doc.meanDumbbell.rows.length, h),
          atom(h, "cmp:dbm:legend"),
          tableBlock("cmp:err", doc.errors.rows.length, h),
          ...(doc.errors.notes.length > 0 ? [atom(h, "cmp:err:notes")] : []),
        ]
      : []),
    atom(h, "cmp:overlay"),
    ...(doc.speed !== null ? [atom(h, "cmp:speed")] : []),
    tableBlock("cmp:cond", doc.fairness.condRows.length, h),
    atom(h, "cmp:issues:8"),
    atom(h, "signature"),
  ];
}

export function compareSummaryBlocks(_doc: CompareDoc, h: Heights, level: number): Block[] {
  const issues = level >= 5 ? "cmp:issues:1" : level >= 2 ? "cmp:issues:3" : "cmp:issues:5";
  return [
    atom(h, "cmp:header"),
    atom(h, "cmp:headline"),
    atom(h, level >= 3 ? "cmp:lines:short" : "cmp:lines:full"),
    atom(h, level >= 4 ? "cmp:cards:line" : "cmp:cards"),
    atom(h, level >= 1 ? "cmp:kpi:plain" : "cmp:kpi:bars"),
    atom(h, "cmp:kpi:note"),
    atom(h, issues),
  ];
}

export function issuesShown(doc: CompareDoc, max: number): { shown: string[]; more: number } {
  return { shown: doc.issues.slice(0, max), more: Math.max(0, doc.issues.length - max) };
}

export type SectionNos = {
  overview: string;
  kpi: string;
  dumbbell: string | null;
  meanDumbbell: string | null;
  errors: string | null;
  overlay: string | null;
  speed: string | null;
  cond: string | null;
  issues: string;
};
type SectionKey = keyof SectionNos;

/** 표준판 절 순서. 뒤 task가 제 키를 끼운다. */
const STANDARD_SECTIONS: SectionKey[] = [
  "overview",
  "kpi",
  "dumbbell",
  "meanDumbbell",
  "errors",
  "overlay",
  "speed",
  "cond",
  "issues",
];

/** 절 번호 — 그 판에 있는 절만 차례로 센다. */
export function sectionNo(
  kind: "standard" | "summary",
  present: { steps: boolean; speed: boolean },
): SectionNos {
  const out: SectionNos = {
    overview: "1",
    kpi: "2",
    dumbbell: null,
    meanDumbbell: null,
    errors: null,
    overlay: null,
    speed: null,
    cond: null,
    issues: "3",
  };
  if (kind === "summary") return out;
  const has: Record<SectionKey, boolean> = {
    overview: true,
    kpi: true,
    dumbbell: present.steps,
    meanDumbbell: present.steps,
    errors: present.steps,
    overlay: true,
    speed: present.speed,
    cond: true,
    issues: true,
  };
  let n = 0;
  for (const k of STANDARD_SECTIONS) {
    if (!has[k]) continue;
    n += 1;
    out[k] = String(n);
  }
  return out;
}

export const sectionNoFor = (doc: CompareDoc, kind: "standard" | "summary"): SectionNos =>
  sectionNo(kind, { steps: doc.hasSteps, speed: doc.speed !== null });

/** 측정 시트에 그릴 블록. summary는 칸 0..CMP_LAST_LEVEL에서 나오는 블록의 합집합(id 중복 제거). */
export function compareSheetBlocks(doc: CompareDoc, kind: "standard" | "summary"): Block[] {
  const none: Heights = new Map();
  if (kind === "standard") return compareStandardBlocks(doc, none);
  const seen = new Set<string>();
  const out: Block[] = [];
  for (let l = 0; l <= CMP_LAST_LEVEL; l++) {
    for (const b of compareSummaryBlocks(doc, none, l)) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
  }
  return out;
}
