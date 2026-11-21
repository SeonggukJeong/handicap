// 비교 보고서 문서 모델 · 블록 목록 (순수). spec §6·§8·§10.

import { ko } from "../../i18n/ko";
import { runShortLabel } from "../../compare/runLabel";
import { measuredWindow } from "../conditions";
import { fmtDate } from "../format";
import type { Block } from "../paginate";
import type { BoxState } from "../verdict";
import type { Heights } from "../buildPrintDoc";
import { metricRows, type MetricRow } from "./change";
import { biggestCodeChange, hasStar, remainingIssues, starFootnote, stepPairs } from "./errorCells";
import { buildFairness, type Fairness } from "./fairness";
import {
  buildHeadline,
  summaryLines,
  verdictWord,
  type Headline,
  type SummaryLine,
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
  footerLeft: string;
  createdDate: string;
  before: SideHead;
  after: SideHead;
  headline: Headline;
  lines: SummaryLine[];
  fairness: Fairness;
  rows: MetricRow[];
  starNote: string | null;
  issues: string[];
  incomparable: boolean;
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
  const lines = summaryLines({
    headline,
    rows,
    before,
    after,
    fairness,
    codeChange: biggestCodeChange(pairs),
  });

  return {
    title: D.title(shownName),
    footerLeft: D.footerLeft(
      shownName,
      runShortLabel(before.meta.id),
      runShortLabel(after.meta.id),
    ),
    createdDate: fmtDate(a.now),
    before: sideHead(D.roleBefore, before),
    after: sideHead(D.roleAfter, after),
    headline,
    lines,
    fairness,
    rows,
    starNote: star ? starFootnote(pairs) : null,
    issues: incomparable ? [] : remainingIssues(after, pairs),
    incomparable,
  };
}

// ── 블록 ──────────────────────────────────────────────────────────────────

export const CMP_LAST_LEVEL = 5;

export const CMP_IDS = {
  condTitle: "cmp:cond:title",
  condHeader: "cmp:cond:header",
  condRowId: (i: number): string => `cmp:cond:row:${i}`,
} as const;

const atom = (h: Heights, id: string): Block => ({
  kind: "atomic",
  id,
  heightMm: h.get(id) ?? 0,
});

function condTable(doc: CompareDoc, h: Heights): Block {
  return {
    kind: "table",
    id: "cmp:cond",
    titleMm: h.get(CMP_IDS.condTitle) ?? 0,
    headerMm: h.get(CMP_IDS.condHeader) ?? 0,
    rowsMm: doc.fairness.condRows.map((_, i) => h.get(CMP_IDS.condRowId(i)) ?? 0),
  };
}

export function compareStandardBlocks(doc: CompareDoc, h: Heights): Block[] {
  return [
    atom(h, "cmp:header"),
    atom(h, "cmp:headline"),
    atom(h, "cmp:lines:full"),
    atom(h, "cmp:cards"),
    atom(h, "cmp:kpi:bars"),
    atom(h, "cmp:kpi:note"),
    condTable(doc, h),
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

/** 절 번호 — 그 판에 있는 절만 차례로. 슬라이스 B가 절을 끼우면 이 함수만 고친다. */
export function sectionNo(kind: "standard" | "summary"): {
  overview: string;
  kpi: string;
  cond: string | null;
  issues: string;
} {
  return kind === "standard"
    ? { overview: "1", kpi: "2", cond: "3", issues: "4" }
    : { overview: "1", kpi: "2", cond: null, issues: "3" };
}

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
