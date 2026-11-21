import { ko } from "../../i18n/ko";
import { fmtCount } from "../format";
import type { BoxState } from "../verdict";
import type { MetricRow } from "./change";
import { codeText, type biggestCodeChange } from "./errorCells";
import type { Fairness } from "./fairness";
import type { RunModel } from "./runModel";

const H = ko.print.cmp.headline;
const L = ko.print.cmp.lines;
const V = ko.print.verdict;

export type Answer = "improved" | "worsened" | "mixed" | "similar" | "incomparable";
export type Headline = {
  answer: Answer;
  glyph: "▼" | "▲" | "◆" | "=" | "–";
  word: string;
  countsLine: string;
  counts: { total: number; better: number; similar: number; worse: number } | null;
  verdictChange: { before: string; after: string } | null;
  reference: boolean;
  verdictSignal: "good" | "bad" | null;
};

const GLYPH: Record<Answer, Headline["glyph"]> = {
  improved: "▼",
  worsened: "▲",
  mixed: "◆",
  similar: "=",
  incomparable: "–",
};

function verdictSignalOf(before: BoxState, after: BoxState, criteriaSame: boolean) {
  if (!criteriaSame) return null;
  if (before.kind === "fail" && after.kind === "pass") return "good";
  if (before.kind === "pass" && after.kind === "fail") return "bad";
  return null;
}

export function buildHeadline(a: {
  rows: MetricRow[];
  beforeBox: BoxState;
  afterBox: BoxState;
  criteriaSame: boolean;
  anyDiff: boolean;
  incomparable: boolean;
}): Headline {
  if (a.incomparable) {
    return {
      answer: "incomparable",
      glyph: GLYPH.incomparable,
      word: H.words.incomparable,
      countsLine: H.incomparable,
      counts: null,
      verdictChange: null,
      reference: a.anyDiff,
      verdictSignal: null,
    };
  }
  let good = 0;
  let similar = 0;
  let bad = 0;
  for (const r of a.rows) {
    if (!r.major) continue;
    if (r.cls === "better") good += 1;
    else if (r.cls === "worse") bad += 1;
    else if (r.cls === "similar") similar += 1;
  }
  const total = good + similar + bad;
  const signal = verdictSignalOf(a.beforeBox, a.afterBox, a.criteriaSame);
  const g = good + (signal === "good" ? 1 : 0);
  const b = bad + (signal === "bad" ? 1 : 0);
  let answer: Answer = "similar";
  if (g >= 1 && b >= 1) answer = "mixed";
  else if (g >= 1) answer = "improved";
  else if (b >= 1) answer = "worsened";
  const verdictChange =
    signal === "good"
      ? { before: H.verdictFail, after: H.verdictPass }
      : signal === "bad"
        ? { before: H.verdictPass, after: H.verdictFail }
        : null;
  const counts = { total, better: good, similar, worse: bad };
  return {
    answer,
    glyph: GLYPH[answer],
    word: H.words[answer],
    countsLine:
      H.counts(total, good, similar, bad) +
      (verdictChange ? H.verdictTail(verdictChange.before, verdictChange.after) : ""),
    counts,
    verdictChange,
    reference: a.anyDiff,
    verdictSignal: signal,
  };
}

export function verdictWord(box: BoxState): string {
  switch (box.kind) {
    case "fail":
      return V.fail;
    case "pass":
      return V.pass;
    case "notJudged":
      return V.notJudged;
    case "notEvaluable":
      return V.notEvaluable;
    case "noCriteria":
      return V.noCriteria;
  }
}

function verdictLine(before: RunModel, after: RunModel): string {
  const bw = verdictWord(before.box);
  const aw = verdictWord(after.box);
  const judged = (k: BoxState["kind"]) => k === "fail" || k === "pass";
  if (bw === aw) return L.verdictSame(aw);
  if (judged(before.box.kind) && judged(after.box.kind)) return L.verdictChanged(bw, aw);
  return L.verdictWords(bw, aw);
}

function incomparableReasons(before: RunModel, after: RunModel): CmpSummaryReason[] {
  const out: CmpSummaryReason[] = [];
  for (const [side, run] of [
    [ko.print.cmp.doc.roleBefore, before],
    [ko.print.cmp.doc.roleAfter, after],
  ] as const) {
    if (run.report.summary.count !== 0) continue;
    const text = (run.meta.message ?? "").replace(/\s+/g, " ").trim();
    if (text !== "") out.push({ side, text });
  }
  return out;
}

/** "새로 생김"이 맨 위, 그다음 변화율 큰 순, 동률은 지표 표 순서. */
function topRow(rows: MetricRow[], cls: "better" | "worse"): MetricRow | null {
  const cands = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.major && r.cls === cls);
  cands.sort(
    (x, y) => Number(y.r.isNew) - Number(x.r.isNew) || (y.r.pct ?? 0) - (x.r.pct ?? 0) || x.i - y.i,
  );
  return cands[0]?.r ?? null;
}

function codeSentence(c: NonNullable<ReturnType<typeof biggestCodeChange>>): string {
  const code = codeText(c.code);
  const n = fmtCount(c.before);
  const m = fmtCount(c.after);
  if (c.after === 0) return L.codeZeroed(c.label, code, n);
  if (c.before === 0) return L.codeAppeared(c.label, code, m);
  return c.after < c.before
    ? L.codeReduced(c.label, code, n, m)
    : L.codeIncreased(c.label, code, n, m);
}

export type CmpSummaryReason = { side: string; text: string };
export type CmpSummaryLine = { id: 1 | 2 | 3 | 4; text: string; reasons?: CmpSummaryReason[] };

export function cmpSummaryLines(a: {
  headline: Headline;
  rows: MetricRow[];
  before: RunModel;
  after: RunModel;
  fairness: Fairness;
  codeChange: ReturnType<typeof biggestCodeChange>;
}): CmpSummaryLine[] {
  const out: CmpSummaryLine[] = [];
  const { answer } = a.headline;
  if (answer === "incomparable") {
    const reasons = incomparableReasons(a.before, a.after);
    out.push(
      reasons.length > 0
        ? { id: 1, text: L.incomparable, reasons }
        : { id: 1, text: L.incomparable },
    );
  } else {
    let text = verdictLine(a.before, a.after);
    if (a.after.box.kind === "pass") text += ` ${L.allMet(a.after.box.evaluated)}`;
    out.push({ id: 1, text });

    const lead =
      answer === "improved" || answer === "mixed"
        ? topRow(a.rows, "better")
        : answer === "worsened"
          ? topRow(a.rows, "worse")
          : null;
    if (lead) {
      let text2 = L.biggest(lead.name, lead.beforeText, lead.afterText, lead.changeText);
      if (lead.key === "error_rate" && a.codeChange) text2 += ` ${codeSentence(a.codeChange)}`;
      out.push({ id: 2, text: text2 });
    }
    const down = answer === "mixed" ? topRow(a.rows, "worse") : null;
    if (down) {
      out.push({
        id: 3,
        text: L.opposite(down.name, down.beforeText, down.afterText, down.after > down.before),
      });
    }
  }
  if (a.fairness.anyDiff) {
    const names = a.fairness.diffNames;
    out.push({
      id: 4,
      text: L.reference(names.slice(0, 2).join(L.nameJoin), Math.max(0, names.length - 2)),
    });
  }
  return out;
}
