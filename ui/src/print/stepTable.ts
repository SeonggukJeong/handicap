import { ko } from "../i18n/ko";
import type { Report } from "../api/schemas";
import { stepNo } from "./format";
import { requestLine } from "./redact";
import type { ScenarioFacts, StepFacts } from "./scenarioFacts";

const T = ko.print.table;

export type CellClass = "counted" | "unknown" | "uncounted" | "expected" | "plain";
const STRENGTH: CellClass[] = ["counted", "unknown", "uncounted", "expected", "plain"];

type Family = "2xx" | "3xx" | "4xx" | "5xx" | "other" | "none";

export function codeFamily(code: number): Family {
  if (code === 0) return "none";
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  return "other";
}

export function classifyCell(
  code: number,
  facts: Pick<StepFacts, "statusCodes" | "fallibleExtract"> | null,
): CellClass {
  if (code === 0) return "counted";
  const fam = codeFamily(code);
  const mild = fam === "2xx" || fam === "3xx";
  if (facts === null) return mild ? "plain" : "unknown";
  const S = facts.statusCodes;
  if (S.length > 0) return S.some((w) => w !== code) ? "counted" : "expected";
  if (mild) return "plain";
  return facts.fallibleExtract ? "unknown" : "uncounted";
}

function strongestOf(classes: CellClass[]): CellClass {
  let best = STRENGTH.length - 1;
  for (const c of classes) best = Math.min(best, STRENGTH.indexOf(c));
  return STRENGTH[best];
}

export type Column = {
  key: string;
  kind: "class2xx" | "class3xx" | "code" | "folded" | "none" | "residual";
  label: string;
  sub: string | null;
  codes: number[];
};

const MAX_COLS = 7;

export function buildColumns(codeTotals: Map<number, number>, hasResidual: boolean): Column[] {
  const present = [...codeTotals.entries()].filter(([, n]) => n > 0).map(([c]) => c);
  const in2 = present.filter((c) => codeFamily(c) === "2xx").sort((a, b) => a - b);
  const in3 = present.filter((c) => codeFamily(c) === "3xx").sort((a, b) => a - b);
  const has0 = present.includes(0);
  const fixedCount =
    (in2.length ? 1 : 0) + (in3.length ? 1 : 0) + (has0 ? 1 : 0) + (hasResidual ? 1 : 0);
  const K = present.filter((c) => ["4xx", "5xx", "other"].includes(codeFamily(c)));
  const B = Math.max(MAX_COLS - fixedCount, 3);

  const individual = new Set<number>(K);
  const foldedByFam: Record<"4xx" | "5xx" | "other", number[]> = {
    "4xx": [],
    "5xx": [],
    other: [],
  };
  if (K.length > B) {
    const sorted = [...K].sort(
      (a, b) => (codeTotals.get(b) ?? 0) - (codeTotals.get(a) ?? 0) || a - b,
    );
    const split = (f: number) => {
      const keep = Math.max(B - f, 0);
      return { keep: sorted.slice(0, keep), rest: sorted.slice(keep) };
    };
    const famCount = (codes: number[]) => new Set(codes.map(codeFamily)).size;
    let f = 1;
    for (let i = 0; i < 3; i++) {
      const fp = famCount(split(f).rest);
      if (fp <= f) break;
      f = fp;
    }
    const { rest } = split(f);
    for (const c of rest) {
      const fam = codeFamily(c) as "4xx" | "5xx" | "other";
      foldedByFam[fam].push(c);
    }
    for (const fam of ["4xx", "5xx", "other"] as const) {
      if (foldedByFam[fam].length >= 2) {
        for (const c of foldedByFam[fam]) individual.delete(c);
        foldedByFam[fam].sort((a, b) => a - b);
      } else {
        foldedByFam[fam] = [];
      }
    }
  }

  const codeCol = (c: number): Column => ({
    key: `c${c}`,
    kind: "code",
    label: String(c),
    sub: T.codeNames[c] ?? null,
    codes: [c],
  });
  const foldCol = (fam: "4xx" | "5xx" | "other"): Column[] => {
    const codes = foldedByFam[fam];
    if (codes.length === 0) return [];
    const label = fam === "4xx" ? T.folded4xx : fam === "5xx" ? T.folded5xx : T.foldedOther;
    return [{ key: `f${fam}`, kind: "folded", label, sub: null, codes }];
  };
  const indiv = (fam: "4xx" | "5xx" | "other") =>
    K.filter((c) => codeFamily(c) === fam && individual.has(c))
      .sort((a, b) => a - b)
      .map(codeCol);

  const cols: Column[] = [];
  if (in2.length)
    cols.push({ key: "2xx", kind: "class2xx", label: T.class2xx, sub: T.class2xxSub, codes: in2 });
  if (in3.length)
    cols.push({ key: "3xx", kind: "class3xx", label: T.class3xx, sub: T.class3xxSub, codes: in3 });
  cols.push(...indiv("4xx"), ...foldCol("4xx"), ...indiv("5xx"), ...foldCol("5xx"));
  cols.push(...indiv("other"), ...foldCol("other"));
  if (has0) cols.push({ key: "none", kind: "none", label: T.none, sub: T.noneSub, codes: [0] });
  if (hasResidual)
    cols.push({
      key: "residual",
      kind: "residual",
      label: T.residual,
      sub: T.residualSub,
      codes: [],
    });
  return cols;
}

export type Cell = { count: number; cls: CellClass; strongest: boolean };

export type StepRow = {
  index: number;
  no: string;
  stepId: string;
  name: string;
  requestLine: string | null;
  executed: boolean;
  count: number;
  errorCount: number;
  p95Ms: number;
  perCode: Array<{ code: number; count: number; cls: CellClass }>;
  cells: Record<string, Cell>;
  residual: number;
  residualUncertain: boolean;
  factsKnown: boolean;
};

export type FoldNote = { columnLabel: string; parts: Array<{ code: number; count: number }> };

export type StepTableModel = {
  columns: Column[];
  rows: StepRow[];
  foldNotes: FoldNote[];
  scenarioUnreadable: boolean;
};

type RStep = Report["steps"][number];

export function buildStepTable(steps: Report["steps"], facts: ScenarioFacts): StepTableModel {
  const byId = new Map<string, RStep>();
  for (const s of steps) if (!byId.has(s.step_id)) byId.set(s.step_id, s);
  const factList: StepFacts[] = facts.ok ? facts.steps : [];
  const factIds = new Set(factList.map((f) => f.id));

  type Src = { id: string; f: StepFacts | null; r: RStep | undefined };
  const srcs: Src[] = factList.map((f) => ({ id: f.id, f, r: byId.get(f.id) }));
  const seen = new Set<string>();
  for (const s of steps) {
    if (factIds.has(s.step_id) || seen.has(s.step_id)) continue;
    seen.add(s.step_id);
    srcs.push({ id: s.step_id, f: null, r: s });
  }

  const rows: StepRow[] = srcs.map(({ id, f, r }, index) => {
    const perCode: StepRow["perCode"] = [];
    if (r) {
      for (const [k, v] of Object.entries(r.status_counts)) {
        if (!/^\d+$/.test(k) || v <= 0) continue;
        const code = Number(k);
        perCode.push({ code, count: v, cls: classifyCell(code, f) });
      }
      perCode.sort((a, b) => a.code - b.code);
    }
    const errorCount = r?.error_count ?? 0;
    const countedSum = perCode.filter((p) => p.cls === "counted").reduce((a, p) => a + p.count, 0);
    const residual = Math.max(0, errorCount - countedSum);
    return {
      index,
      no: stepNo(index),
      stepId: id,
      name: f ? f.name || id : id,
      requestLine: f ? requestLine(f.method, f.url) : null,
      executed: r !== undefined,
      count: r?.count ?? 0,
      errorCount,
      p95Ms: r?.p95_ms ?? 0,
      perCode,
      cells: {},
      residual,
      residualUncertain: residual > 0 && perCode.some((p) => p.cls === "unknown"),
      factsKnown: f !== null,
    };
  });

  const codeTotals = new Map<number, number>();
  for (const row of rows)
    for (const p of row.perCode) codeTotals.set(p.code, (codeTotals.get(p.code) ?? 0) + p.count);
  const columns = buildColumns(
    codeTotals,
    rows.some((r) => r.residual > 0),
  );

  for (const row of rows) {
    let best: { key: string; count: number } | null = null;
    for (const col of columns) {
      if (col.kind === "residual") continue;
      const parts = row.perCode.filter((p) => col.codes.includes(p.code));
      const cell: Cell = {
        count: parts.reduce((a, p) => a + p.count, 0),
        cls: parts.length ? strongestOf(parts.map((p) => p.cls)) : "plain",
        strongest: false,
      };
      row.cells[col.key] = cell;
      if (cell.cls === "counted" && cell.count > 0 && (best === null || cell.count > best.count))
        best = { key: col.key, count: cell.count };
    }
    if (best) row.cells[best.key].strongest = true;
  }

  const foldNotes: FoldNote[] = [];
  for (const col of columns) {
    const multi =
      col.kind === "folded" ||
      ((col.kind === "class2xx" || col.kind === "class3xx") && col.codes.length >= 2);
    if (!multi) continue;
    foldNotes.push({
      columnLabel: col.label,
      parts: [...col.codes]
        .sort((a, b) => a - b)
        .map((code) => ({ code, count: codeTotals.get(code) ?? 0 })),
    });
  }

  return { columns, rows, foldNotes, scenarioUnreadable: !facts.ok };
}
