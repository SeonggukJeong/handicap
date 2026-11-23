import { deriveLoadMode } from "../../components/run/loadModel";
import { ko } from "../../i18n/ko";
import { fmtCount } from "../format";
import type { BoxState } from "../verdict";
import type { MetricRow } from "./change";
import { codeText, type biggestCodeChange } from "./errorCells";
import type { Fairness } from "./fairness";
import {
  joinParts,
  partsText,
  plain,
  strong,
  type LinePart,
  type LineTone,
} from "../../i18n/lineParts";
import type { RunModel } from "./runModel";

const H = ko.print.cmp.headline;
const L = ko.print.cmp.lines;
const V = ko.print.verdict;

export type Answer = "improved" | "worsened" | "mixed" | "similar" | "incomparable";
export type Headline = {
  answer: Answer;
  glyph: "▼" | "▲" | "◆" | "=" | "–" | "※";
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
    glyph: a.anyDiff ? "※" : GLYPH[answer],
    word: a.anyDiff ? H.words.reference : H.words[answer],
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

const toneOf = (box: BoxState): LineTone | undefined =>
  box.kind === "pass" ? "ok" : box.kind === "fail" ? "bad" : undefined;

const verdictPart = (box: BoxState): LinePart => strong(verdictWord(box), toneOf(box));

function verdictLine(before: RunModel, after: RunModel): LinePart[] {
  const bw = verdictPart(before.box);
  const aw = verdictPart(after.box);
  const judged = (k: BoxState["kind"]) => k === "fail" || k === "pass";
  if (bw.text === aw.text) return L.verdictSame(aw);
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

function codeSentence(c: NonNullable<ReturnType<typeof biggestCodeChange>>): LinePart[] {
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
/** text는 언제나 parts를 이어 붙인 글이다 — line()으로만 만든다. */
export type CmpSummaryLine = {
  id: 1 | 2 | 3 | 4 | 5;
  text: string;
  parts: LinePart[];
  reasons?: CmpSummaryReason[];
};

function line(id: CmpSummaryLine["id"], ...lists: LinePart[][]): CmpSummaryLine {
  const parts = joinParts(...lists);
  return { id, text: partsText(parts), parts };
}

const SEP = [plain(L.sentenceJoin)];

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
    const first = line(1, [plain(L.incomparable)]);
    out.push(reasons.length > 0 ? { ...first, reasons } : first);
  } else {
    const met = a.after.box.kind === "pass" ? [...SEP, plain(L.allMet(a.after.box.evaluated))] : [];
    out.push(line(1, verdictLine(a.before, a.after), met));

    const lead =
      answer === "improved" || answer === "mixed"
        ? topRow(a.rows, "better")
        : answer === "worsened"
          ? topRow(a.rows, "worse")
          : null;
    if (lead) {
      const code =
        lead.key === "error_rate" && a.codeChange ? [...SEP, ...codeSentence(a.codeChange)] : [];
      out.push(
        line(2, L.biggest(lead.name, lead.beforeText, lead.afterText, lead.changeText), code),
      );
    }
    const down = answer === "mixed" ? topRow(a.rows, "worse") : null;
    if (down) {
      out.push(
        line(3, L.opposite(down.name, down.beforeText, down.afterText, down.after > down.before)),
      );
    }
  }
  if (a.fairness.anyDiff) {
    const names = a.fairness.diffNames;
    out.push(
      line(4, L.reference(names.slice(0, 2).join(L.nameJoin), Math.max(0, names.length - 2))),
    );
  }
  const bs = a.before.report.setup;
  const afterSetup = a.after.report.setup;
  if (answer !== "incomparable" && bs && afterSetup && bs.failed !== afterSetup.failed) {
    const kinds = [a.before, a.after].map((r) =>
      r.profile ? deriveLoadMode(r.profile).loadModel : null,
    );
    const unit =
      kinds[0] === "closed" && kinds[1] === "closed"
        ? "user"
        : kinds[0] === "open" && kinds[1] === "open"
          ? "slot"
          : null;
    out.push(
      line(
        5,
        L.setupFailed(
          unit,
          fmtCount(bs.failed),
          fmtCount(afterSetup.failed),
          afterSetup.failed > bs.failed,
        ),
      ),
    );
  }
  return out;
}
