import { ko } from "../../i18n/ko";
import { fmtCount, fmtPct } from "../format";
import type { ScenarioFacts, StepFacts } from "../scenarioFacts";
import { rankRows, type RankedRow } from "../stepStatus";
import { classifyCell, type CellClass, type StepRow } from "../stepTable";
import type { RunModel } from "./runModel";

const c = ko.print.cmp;

export type Counts = "yes" | "no" | "maybe";

export function countsAsError(cls: CellClass): Counts {
  if (cls === "counted") return "yes";
  if (cls === "unknown") return "maybe";
  return "no";
}

export type CodeKey = number | "notSent" | "residual";

export type StepPair = {
  stepId: string;
  label: string;
  presence: "both" | "beforeOnly" | "afterOnly";
  executedBefore: boolean;
  executedAfter: boolean;
  codes: Array<{
    code: CodeKey;
    before: number;
    after: number;
    starBefore: boolean;
    starAfter: boolean;
    countsBefore: Counts | null;
    countsAfter: Counts | null;
    classBefore: CellClass | null;
    classAfter: CellClass | null;
  }>;
};

function factsOf(facts: ScenarioFacts, stepId: string): StepFacts | null {
  return facts.ok ? (facts.steps.find((f) => f.id === stepId) ?? null) : null;
}

const countOf = (row: StepRow | undefined, code: number): number =>
  row?.perCode.find((p) => p.code === code)?.count ?? 0;

/** 실행되지 않은 쪽(행이 없거나 리포트에 그 단계가 없음)은 분류하지 않는다(spec §9.1). */
const classOn = (model: RunModel, row: StepRow | undefined, code: number): CellClass | null =>
  row?.executed ? classifyCell(code, factsOf(model.facts, row.stepId)) : null;

const toCounts = (cls: CellClass | null): Counts | null => (cls ? countsAsError(cls) : null);

function pairOf(before: RunModel, after: RunModel, stepId: string): StepPair {
  const bRow = before.table.rows.find((r) => r.stepId === stepId);
  const aRow = after.table.rows.find((r) => r.stepId === stepId);
  const presence = bRow && aRow ? "both" : aRow ? "afterOnly" : "beforeOnly";
  const executedBefore = bRow?.executed ?? false;
  const executedAfter = aRow?.executed ?? false;
  const label = aRow ? `${aRow.no} ${aRow.name}` : (bRow?.name ?? stepId);

  const real = new Set<number>();
  for (const r of [bRow, aRow]) for (const p of r?.perCode ?? []) real.add(p.code);
  const ordered = [...real].sort((x, y) => (x === 0 ? 1 : y === 0 ? -1 : x - y));

  const codes: StepPair["codes"] = [];
  for (const code of ordered) {
    const clsB = classOn(before, bRow, code);
    const clsA = classOn(after, aRow, code);
    const cb = toCounts(clsB);
    const ca = toCounts(clsA);
    const nb = countOf(bRow, code);
    const na = countOf(aRow, code);
    const differs = cb !== null && ca !== null && code !== 0 && cb !== ca;
    codes.push({
      code,
      before: nb,
      after: na,
      starBefore: differs && nb > 0,
      starAfter: differs && na > 0,
      countsBefore: cb,
      countsAfter: ca,
      classBefore: clsB,
      classAfter: clsA,
    });
  }
  const fixed = (key: "notSent" | "residual") => {
    const nb = bRow?.[key] ?? 0;
    const na = aRow?.[key] ?? 0;
    if (nb === 0 && na === 0) return;
    codes.push({
      code: key,
      before: nb,
      after: na,
      starBefore: false,
      starAfter: false,
      countsBefore: executedBefore ? "yes" : null,
      countsAfter: executedAfter ? "yes" : null,
      classBefore: null,
      classAfter: null,
    });
  };
  fixed("notSent");
  fixed("residual");
  return { stepId, label, presence, executedBefore, executedAfter, codes };
}

export function stepPairs(before: RunModel, after: RunModel): StepPair[] {
  const ids = after.table.rows.map((r) => r.stepId);
  const seen = new Set(ids);
  for (const r of before.table.rows) {
    if (!seen.has(r.stepId)) {
      seen.add(r.stepId);
      ids.push(r.stepId);
    }
  }
  return ids.map((id) => pairOf(before, after, id));
}

export function hasStar(pairs: StepPair[]): boolean {
  return pairs.some((p) => p.codes.some((x) => x.starBefore || x.starAfter));
}

export const codeText = (code: CodeKey): string => {
  if (code === "notSent") return c.issues.notSent;
  if (code === "residual") return ko.print.table.residual;
  if (code === 0) return c.issues.noResponse;
  const name = ko.print.table.codeNames[code];
  return name ? c.issues.codeLine(String(code), name) : String(code);
};

type StarSide = { side: "before" | "after"; n: number; counts: Counts };

type StarPlace = { n: number; text: string };

type StarArgs = { label: string; code: string; n: string; side: string; other: string };

/** 짚는 쪽 상태/상대 쪽 상태. 두 상태가 같은 짝은 별이 붙지 않으므로 키 자체가 없다. */
type Differing = { [P in Counts]: `${P}/${Exclude<Counts, P>}` }[Counts];

const starSentence: Record<Differing, (a: StarArgs) => string> = {
  "no/yes": (a) => c.star.notCountedOtherCounts(a.label, a.code, a.n, a.side),
  "no/maybe": (a) => c.star.notCountedOtherUnknown(a.label, a.code, a.n, a.side, a.other),
  "maybe/yes": (a) => c.star.unknown(a.label, a.code, a.n, a.side),
  "maybe/no": (a) => c.star.unknown(a.label, a.code, a.n, a.side),
  "yes/no": (a) => c.star.countedOnly(a.label, a.code, a.n, a.side),
  "yes/maybe": (a) => c.star.countedOtherUnknown(a.label, a.code, a.n, a.side, a.other),
};

function starPlace(label: string, x: StepPair["codes"][number], code: number): StarPlace | null {
  const { countsBefore, countsAfter } = x;
  if (!countsBefore || !countsAfter || countsBefore === countsAfter) return null;
  const sides: StarSide[] = [];
  if (x.starBefore) sides.push({ side: "before", n: x.before, counts: countsBefore });
  if (x.starAfter) sides.push({ side: "after", n: x.after, counts: countsAfter });
  const pick =
    sides.find((s) => s.counts === "no") ?? sides.find((s) => s.counts === "maybe") ?? sides[0];
  if (!pick) return null;
  const otherSide = pick.side === "before" ? "after" : "before";
  const otherCounts = pick.side === "before" ? countsAfter : countsBefore;
  const text = starSentence[`${pick.counts}/${otherCounts}` as Differing]({
    label,
    code: String(code),
    n: fmtCount(pick.n),
    side: c.star[pick.side],
    other: c.star[otherSide],
  });
  return { n: pick.n, text: `${text}${c.star.tail}` };
}

export function starFootnote(pairs: StepPair[]): string | null {
  const places: StarPlace[] = [];
  for (const p of pairs) {
    for (const x of p.codes) {
      if ((!x.starBefore && !x.starAfter) || typeof x.code !== "number") continue;
      const place = starPlace(p.label, x, x.code);
      if (place) places.push(place);
    }
  }
  if (places.length === 0) return null;
  places.sort((x, y) => y.n - x.n);
  const shown = places.slice(0, 2).map((f) => f.text);
  if (places.length > 2) shown.push(c.star.more(places.length - 2));
  return shown.join(c.star.join);
}

const isTargetClass = (cls: CellClass | null): boolean =>
  cls === "counted" || cls === "uncounted" || cls === "unknown";

const notReduced = (before: number, after: number): boolean => after * 100 >= before * 95;

export function remainingIssues(after: RunModel, pairs: StepPair[]): string[] {
  const heads = new Map<string, string>();
  const order: string[] = [];

  const bad: RankedRow[] = rankRows(after.ranked.filter((r) => r.status.grade >= 2));
  for (const r of bad) {
    const words = r.status.tags
      .filter((t): t is keyof typeof ko.print.status.short => t !== "ok" && t !== "notRun")
      .map((t) => ko.print.status.short[t])
      .join(c.issues.wordJoin);
    const rate = r.status.errorRate > 0 ? fmtPct(r.status.errorRate) : null;
    heads.set(r.stepId, c.issues.stepStatus(`${r.no} ${r.name}`, words, rate));
    order.push(r.stepId);
  }

  // sentence는 단계 이름 없는 문장 — 문제 단계 항목 뒤에 붙일 땐 그대로, 홀로 설 땐 단계 이름을 앞에 둔다.
  type Extra = { stepId: string; label: string; n: number; sentence: string; fresh: boolean };
  const extras: Extra[] = [];
  for (const p of pairs) {
    for (const x of p.codes) {
      if (x.code === "residual" || x.after <= 0) continue;
      if (typeof x.code === "number" && !isTargetClass(x.classAfter)) continue;
      const code = codeText(x.code);
      const add = (sentence: string, fresh: boolean) =>
        extras.push({ stepId: p.stepId, label: p.label, n: x.after, sentence, fresh });
      if (x.before === 0) {
        add(c.issues.appeared(code, fmtCount(x.after)), true);
      } else if (x.after > x.before) {
        add(c.issues.increased(code, fmtCount(x.before), fmtCount(x.after)), false);
      } else if (notReduced(x.before, x.after)) {
        add(c.issues.unchanged(code, fmtCount(x.after)), false);
      }
    }
  }
  extras.sort((x, y) => Number(x.fresh) - Number(y.fresh) || y.n - x.n);

  const out: string[] = [];
  for (const id of order) {
    const head = heads.get(id) ?? id;
    const own = extras.filter((e) => e.stepId === id).map((e) => e.sentence);
    out.push(own.length > 0 ? c.issues.merge(head, own.join(c.issues.sentenceJoin)) : head);
  }
  for (const e of extras) {
    if (!heads.has(e.stepId)) out.push(c.issues.ofStep(e.label, e.sentence));
  }
  return out;
}

const isErrorCell = (x: StepPair["codes"][number]): boolean =>
  x.code === "notSent" ||
  (typeof x.code === "number" &&
    ((x.before > 0 && isTargetClass(x.classBefore)) ||
      (x.after > 0 && isTargetClass(x.classAfter))));

export function biggestCodeChange(
  pairs: StepPair[],
): { label: string; code: CodeKey; before: number; after: number } | null {
  let best: { label: string; code: CodeKey; before: number; after: number } | null = null;
  let bestDiff = 0;
  for (const p of pairs) {
    // 한쪽에서 없어졌거나(그쪽은 executed가 false) 실행되지 않은 단계의 건수 차이는 오류 변화가 아니다.
    if (!p.executedBefore || !p.executedAfter) continue;
    for (const x of p.codes) {
      if (!isErrorCell(x)) continue;
      const diff = Math.abs(x.after - x.before);
      if (diff > bestDiff) {
        bestDiff = diff;
        best = { label: p.label, code: x.code, before: x.before, after: x.after };
      }
    }
  }
  return best;
}
