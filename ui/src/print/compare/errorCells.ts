import { ko } from "../../i18n/ko";
import { fmtPct } from "../format";
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
  codes: Array<{
    code: CodeKey;
    before: number;
    after: number;
    starBefore: boolean;
    starAfter: boolean;
    countsBefore: Counts | null;
    countsAfter: Counts | null;
  }>;
};

function factsOf(facts: ScenarioFacts, stepId: string): StepFacts | null {
  return facts.ok ? (facts.steps.find((f) => f.id === stepId) ?? null) : null;
}

const countOf = (row: StepRow | undefined, code: number): number =>
  row?.perCode.find((p) => p.code === code)?.count ?? 0;

const classOn = (model: RunModel, row: StepRow | undefined, code: number): CellClass | null =>
  row ? classifyCell(code, factsOf(model.facts, row.stepId)) : null;

const toCounts = (cls: CellClass | null): Counts | null => (cls ? countsAsError(cls) : null);

function pairOf(before: RunModel, after: RunModel, stepId: string): StepPair {
  const bRow = before.table.rows.find((r) => r.stepId === stepId);
  const aRow = after.table.rows.find((r) => r.stepId === stepId);
  const presence = bRow && aRow ? "both" : aRow ? "afterOnly" : "beforeOnly";
  const label = aRow ? `${aRow.no} ${aRow.name}` : (bRow?.name ?? stepId);

  const real = new Set<number>();
  for (const r of [bRow, aRow]) for (const p of r?.perCode ?? []) real.add(p.code);
  const ordered = [...real].sort((x, y) => (x === 0 ? 1 : y === 0 ? -1 : x - y));

  const codes: StepPair["codes"] = [];
  for (const code of ordered) {
    const cb = toCounts(classOn(before, bRow, code));
    const ca = toCounts(classOn(after, aRow, code));
    const nb = countOf(bRow, code);
    const na = countOf(aRow, code);
    const differs = presence === "both" && code !== 0 && cb !== ca;
    codes.push({
      code,
      before: nb,
      after: na,
      starBefore: differs && nb > 0,
      starAfter: differs && na > 0,
      countsBefore: cb,
      countsAfter: ca,
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
      countsBefore: bRow ? "yes" : null,
      countsAfter: aRow ? "yes" : null,
    });
  };
  fixed("notSent");
  fixed("residual");
  return { stepId, label, presence, codes };
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

const codeText = (code: CodeKey): string => {
  if (code === "notSent") return c.issues.notSent;
  if (code === "residual") return ko.print.table.residual;
  if (code === 0) return c.issues.noResponse;
  const name = ko.print.table.codeNames[code];
  return name ? c.issues.codeLine(String(code), name) : String(code);
};

type StarSide = { side: "before" | "after"; n: number; counts: Counts | null };

function starSentence(
  label: string,
  code: CodeKey,
  sides: StarSide[],
): { n: number; text: string } {
  const pick =
    sides.find((s) => s.counts === "no") ?? sides.find((s) => s.counts === "maybe") ?? sides[0];
  const side = c.star[pick.side];
  const n = pick.n.toLocaleString("en-US");
  const text =
    pick.counts === "no"
      ? c.star.notCounted(label, String(code), n, side)
      : pick.counts === "maybe"
        ? c.star.unknown(label, String(code), n, side)
        : c.star.countedOnly(label, String(code), n, side);
  return { n: pick.n, text };
}

export function starFootnote(pairs: StepPair[]): string | null {
  const found: Array<{ n: number; text: string }> = [];
  for (const p of pairs) {
    let best: { n: number; text: string } | null = null;
    for (const x of p.codes) {
      if ((!x.starBefore && !x.starAfter) || typeof x.code !== "number") continue;
      const sides: StarSide[] = [];
      if (x.starBefore) sides.push({ side: "before", n: x.before, counts: x.countsBefore });
      if (x.starAfter) sides.push({ side: "after", n: x.after, counts: x.countsAfter });
      const s = starSentence(p.label, x.code, sides);
      if (best === null || s.n > best.n) best = s;
    }
    if (best) found.push(best);
  }
  if (found.length === 0) return null;
  found.sort((x, y) => y.n - x.n);
  const shown = found.slice(0, 2).map((f) => f.text);
  if (found.length > 2) shown.push(c.star.more(found.length - 2));
  return shown.join(" ");
}

const isTargetClass = (cls: CellClass | null): boolean =>
  cls === "counted" || cls === "uncounted" || cls === "unknown";

const notReduced = (before: number, after: number): boolean => after * 100 >= before * 95;

export function remainingIssues(before: RunModel, after: RunModel, pairs: StepPair[]): string[] {
  const heads = new Map<string, string>();
  const order: string[] = [];
  const labelOf = new Map(pairs.map((p) => [p.stepId, p.label]));

  const bad: RankedRow[] = rankRows(after.ranked.filter((r) => r.status.grade >= 2));
  for (const r of bad) {
    const words = r.status.tags
      .filter((t): t is keyof typeof ko.print.status.short => t !== "ok" && t !== "notRun")
      .map((t) => ko.print.status.short[t])
      .join(" · ");
    const rate = r.status.errorRate > 0 ? ` ${c.issues.rate(fmtPct(r.status.errorRate))}` : "";
    heads.set(r.stepId, c.issues.stepStatus(`${r.no} ${r.name}`, `${words}${rate}`));
    order.push(r.stepId);
  }

  const extras: Array<{ stepId: string; n: number; text: string; fresh: boolean }> = [];
  for (const p of pairs) {
    const bRow = before.table.rows.find((r) => r.stepId === p.stepId);
    const aRow = after.table.rows.find((r) => r.stepId === p.stepId);
    const label = labelOf.get(p.stepId) ?? p.stepId;
    for (const x of p.codes) {
      if (x.code === "residual") continue;
      const target =
        typeof x.code !== "number" ||
        x.code === 0 ||
        isTargetClass(classOn(before, bRow, x.code)) ||
        isTargetClass(classOn(after, aRow, x.code));
      if (!target || x.after <= 0) continue;
      const code = codeText(x.code);
      const n = (v: number) => v.toLocaleString("en-US");
      if (x.before === 0) {
        extras.push({
          stepId: p.stepId,
          n: x.after,
          text: c.issues.appeared(label, code, n(x.after)),
          fresh: true,
        });
      } else if (x.after > x.before) {
        extras.push({
          stepId: p.stepId,
          n: x.after,
          text: c.issues.increased(label, code, n(x.before), n(x.after)),
          fresh: false,
        });
      } else if (notReduced(x.before, x.after)) {
        extras.push({
          stepId: p.stepId,
          n: x.after,
          text: c.issues.unchanged(label, code, n(x.after)),
          fresh: false,
        });
      }
    }
  }
  extras.sort((x, y) => Number(x.fresh) - Number(y.fresh) || y.n - x.n);

  const out: string[] = [];
  const merged = new Set<string>();
  for (const id of order) {
    const head = heads.get(id) ?? id;
    const own = extras.filter((e) => e.stepId === id).map((e) => e.text);
    if (own.length > 0) merged.add(id);
    out.push(own.length > 0 ? c.issues.merge(head, own.join(" ")) : head);
  }
  for (const e of extras) if (!merged.has(e.stepId) && !heads.has(e.stepId)) out.push(e.text);
  return out;
}

export function biggestCodeChange(
  pairs: StepPair[],
): { label: string; code: CodeKey; before: number; after: number } | null {
  let best: { label: string; code: CodeKey; before: number; after: number } | null = null;
  let bestDiff = -1;
  for (const p of pairs) {
    for (const x of p.codes) {
      const diff = Math.abs(x.after - x.before);
      if (diff > bestDiff) {
        bestDiff = diff;
        best = { label: p.label, code: x.code, before: x.before, after: x.after };
      }
    }
  }
  return best;
}
