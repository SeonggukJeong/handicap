import { ko } from "../i18n/ko";
import type { Criteria, Report } from "../api/schemas";
import { fmtCount, fmtPct } from "./format";
import type { StepRow, StepTableModel } from "./stepTable";

const S = ko.print.status;
const C = ko.print.callout;
const G = ko.print.glossary;
const L = ko.print.legend;

export type StatusTag = "error" | "slow" | "hasErrors" | "uncounted" | "unknown" | "ok" | "notRun";
export type RowStatus = { tags: StatusTag[]; grade: 0 | 1 | 2 | 3; errorRate: number };
export type RankedRow = StepRow & { status: RowStatus };

export const LEGEND_SHORT: string = L.short;

export function stepThresholds(
  stepId: string,
  criteria: Criteria | null | undefined,
): { errorRate: number | null; p95Ms: number | null } {
  const pick = (metric: string, runLevel: number | undefined): number | null => {
    const vals = (criteria?.step_criteria ?? [])
      .filter((c) => c.target === stepId && c.metric === metric && c.op === "max")
      .map((c) => c.threshold);
    if (vals.length > 0) return Math.min(...vals);
    return runLevel ?? null;
  };
  return {
    errorRate: pick("error_rate", criteria?.max_error_rate),
    p95Ms: pick("p95_ms", criteria?.max_p95_ms),
  };
}

export function stepStatus(row: StepRow, criteria: Criteria | null | undefined): RowStatus {
  if (!row.executed) return { tags: ["notRun"], grade: 0, errorRate: 0 };
  const errorRate = row.count > 0 ? row.errorCount / row.count : 0;
  const t = stepThresholds(row.stepId, criteria);
  const tags: StatusTag[] = [];
  if (t.errorRate !== null && errorRate > t.errorRate) tags.push("error");
  if (t.p95Ms !== null && row.p95Ms > t.p95Ms) tags.push("slow");
  if (t.errorRate === null && errorRate > 0) tags.push("hasErrors");
  if (row.perCode.some((p) => p.cls === "uncounted")) tags.push("uncounted");
  if (row.perCode.some((p) => p.cls === "unknown")) tags.push("unknown");
  if (tags.length === 0) return { tags: ["ok"], grade: 1, errorRate };
  return { tags, grade: tags.includes("error") ? 3 : 2, errorRate };
}

const uncertainCount = (r: StepRow): number =>
  r.perCode
    .filter((p) => p.cls === "uncounted" || p.cls === "unknown")
    .reduce((a, p) => a + p.count, 0);

export function rankRows(rows: RankedRow[]): RankedRow[] {
  return [...rows].sort(
    (a, b) =>
      b.status.grade - a.status.grade ||
      b.errorCount - a.errorCount ||
      uncertainCount(b) - uncertainCount(a) ||
      b.p95Ms - a.p95Ms ||
      a.index - b.index,
  );
}

export function selectTopRows(
  rows: RankedRow[],
  n: number,
): { shown: RankedRow[]; remainderLine: string | null } {
  const byIndex = (a: RankedRow, b: RankedRow) => a.index - b.index;
  if (rows.length <= n) return { shown: [...rows].sort(byIndex), remainderLine: null };
  const ranked = rankRows(rows);
  const shown = ranked.slice(0, n).sort(byIndex);
  const rest = ranked.slice(n);
  const cnt = (g: number) => rest.filter((r) => r.status.grade === g).length;
  const R = S.remainder;
  const parts = (
    [
      [R.error, cnt(3)],
      [R.caution, cnt(2)],
      [R.ok, cnt(1)],
      [R.notRun, cnt(0)],
    ] as const
  )
    .filter(([, c]) => c > 0)
    .map(([l, c]) => `${l} ${c}`);
  const allOk = rest.every((r) => r.status.grade === 1);
  return {
    shown,
    remainderLine: allOk ? R.allOk(rest.length) : R.line(rest.length, parts.join(" · ")),
  };
}

type Item = { row: RankedRow; code: number; count: number };

function collect(rows: RankedRow[], cls: "uncounted" | "unknown"): Item[] {
  const items: Item[] = [];
  for (const row of rows)
    for (const p of row.perCode)
      if (p.cls === cls) items.push({ row, code: p.code, count: p.count });
  return items.sort((a, b) => b.count - a.count || a.row.index - b.row.index || a.code - b.code);
}

function itemsText(items: Item[]): string {
  // items are sorted count desc / scenario order: first occurrence per step = its largest cell.
  const perStep: Item[] = [];
  const seen = new Set<number>();
  for (const i of items) {
    if (seen.has(i.row.index)) continue;
    seen.add(i.row.index);
    perStep.push(i);
  }
  const head = perStep
    .slice(0, 2)
    .map((i) => C.item(i.row.name, i.code, fmtCount(i.count)))
    .join(", ");
  return perStep.length > 2 ? head + C.more(perStep.length - 2) : head;
}

export function callouts(
  rows: RankedRow[],
  summary: Report["summary"],
): { uncounted: string | null; unknown: string | null; affectedSteps: number } {
  const un = collect(rows, "uncounted");
  const unk = collect(rows, "unknown");
  const affected = new Set([...un, ...unk].map((i) => i.row.index));
  const total = summary.count;
  const extra = un.reduce((a, i) => a + i.count, 0);
  const a = total > 0 ? summary.errors / total : 0;
  const b = total > 0 ? (summary.errors + extra) / total : 0;
  return {
    uncounted: un.length ? C.uncounted(itemsText(un), fmtPct(a), fmtPct(b)) : null,
    unknown: unk.length ? C.unknown(itemsText(unk)) : null,
    affectedSteps: affected.size,
  };
}

export function calloutOneLine(affectedSteps: number): string {
  return C.oneLine(affectedSteps);
}

export type GlossaryEntry = { term: string; text: string };

export function glossary(
  model: StepTableModel,
  rows: RankedRow[],
  errorKinds: Report["error_kinds"],
): { entries: GlossaryEntry[]; errorKindLine: string | null } {
  const entries: GlossaryEntry[] = [G.throughput, G.mean, G.p95, G.errorRate].map((e) => ({
    ...e,
  }));
  const kinds = new Set(model.columns.map((c) => c.kind));
  const has2 = kinds.has("class2xx");
  const has3 = kinds.has("class3xx");
  if (has2 || has3) {
    const term = [has2 ? G.class2xx : null, has3 ? G.class3xx : null].filter(Boolean).join("·");
    entries.push({ term, text: G.classText });
  }
  const codes = new Set<number>();
  for (const c of model.columns)
    if (c.kind === "code" || c.kind === "folded") for (const k of c.codes) codes.add(k);
  for (const code of [...codes].sort((a, b) => a - b))
    entries.push({
      term: String(code),
      text: ko.print.table.codeNames[code] ?? G.codeFallback,
    });
  const hasNone = kinds.has("none");
  if (hasNone) entries.push({ ...G.none });
  if (kinds.has("residual")) entries.push({ ...G.residual });
  const anyCls = (cls: string) => rows.some((r) => r.perCode.some((p) => p.cls === cls));
  if (anyCls("uncounted")) entries.push({ ...G.uncounted });
  if (anyCls("unknown")) entries.push({ ...G.unknown });
  const kl = (errorKinds ?? []).filter((k) => k.count > 0);
  const errorKindLine =
    hasNone && kl.length > 0
      ? G.errorKindLine(
          kl
            .map((k) => `${ko.report.errorKinds.labels[k.kind] ?? k.kind} ${fmtCount(k.count)}`)
            .join(" · "),
        )
      : null;
  return { entries, errorKindLine };
}

export function legendItems(model: StepTableModel, rows: RankedRow[]): string[] {
  const out: string[] = [];
  if (rows.some((r) => r.status.grade === 3)) out.push(L.error);
  // ▲는 오류(grade 3) 줄의 보조 태그로만 나타나도 범례에 싣는다(§6.3 "나타난 분류만")
  const cautionTags: StatusTag[] = ["slow", "hasErrors", "uncounted", "unknown"];
  if (rows.some((r) => r.status.tags.some((t) => cautionTags.includes(t)))) out.push(L.caution);
  if (rows.some((r) => r.status.grade === 1)) out.push(L.ok);
  const cells = rows.flatMap((r) => Object.values(r.cells));
  if (cells.some((c) => c.cls === "counted" && c.count > 0)) out.push(L.counted);
  if (cells.some((c) => c.strongest)) out.push(L.strongest);
  if (cells.some((c) => c.cls === "uncounted" && c.count > 0)) out.push(L.uncounted);
  if (cells.some((c) => c.cls === "unknown" && c.count > 0)) out.push(L.unknown);
  if (model.columns.some((c) => c.kind === "residual")) out.push(L.residual);
  return out;
}
