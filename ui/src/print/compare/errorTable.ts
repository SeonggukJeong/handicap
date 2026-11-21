import { ko } from "../../i18n/ko";
import { fmtCount } from "../format";
import { classifyChange, FLOOR, valueTexts } from "./change";
import { hasStar, remainingStepIds, starFootnote, type CodeKey, type StepPair } from "./errorCells";
import type { RunModel } from "./runModel";

const c = ko.print.cmp;

export const ERR_MAX_COLS = 5;

export type ErrCol = {
  key: string;
  kind: "code" | "other" | "none" | "notSent" | "residual";
  label: string;
  sub: string | null;
  codes: number[];
};
export type ErrTone = "down" | "up" | "flat" | null;
export type ErrCell = {
  before: string;
  after: string;
  starBefore: boolean;
  starAfter: boolean;
  tone: ErrTone;
} | null;
export type ErrChange = {
  cls: "better" | "similar" | "worse" | "reference" | "none";
  glyph: "▼" | "=" | "▲" | "";
  word: string;
};
export type ErrRow = {
  stepId: string;
  label: string;
  note: string | null;
  rate: { before: string; after: string; starBefore: boolean; starAfter: boolean };
  cells: Record<string, ErrCell>;
  change: ErrChange;
  remaining: boolean;
};
export type ErrorTableModel = { cols: ErrCol[]; rows: ErrRow[]; notes: string[] };

type Cell = StepPair["codes"][number];

const isTarget = (cls: Cell["classBefore"]): boolean =>
  cls === "counted" || cls === "uncounted" || cls === "unknown";

/** 정상 응답으로 센 칸은 오류 표에 찍지 않는다. */
function visible(x: Cell): boolean {
  if (x.code === "notSent" || x.code === "residual" || x.code === 0) return true;
  return (
    x.starBefore ||
    x.starAfter ||
    (x.before > 0 && isTarget(x.classBefore)) ||
    (x.after > 0 && isTarget(x.classAfter))
  );
}

const colKey = (code: CodeKey): string => {
  if (code === 0) return "none";
  if (code === "notSent" || code === "residual") return code;
  return `c${code}`;
};

const tone = (before: number, after: number, star: boolean): ErrTone => {
  if (star) return null;
  if (after < before) return "down";
  if (after > before) return "up";
  return "flat";
};

function buildCols(pairs: StepPair[]): ErrCol[] {
  const sums = new Map<number, number>();
  const fixed = new Set<CodeKey>();
  for (const p of pairs) {
    for (const x of p.codes) {
      if (!visible(x)) continue;
      if (typeof x.code === "number" && x.code !== 0) {
        sums.set(x.code, (sums.get(x.code) ?? 0) + x.before + x.after);
      } else {
        fixed.add(x.code);
      }
    }
  }
  const fixedCols: ErrCol[] = [];
  if (fixed.has(0)) {
    fixedCols.push({
      key: "none",
      kind: "none",
      label: ko.print.table.none,
      sub: ko.print.table.noneSub,
      codes: [],
    });
  }
  if (fixed.has("notSent")) {
    fixedCols.push({
      key: "notSent",
      kind: "notSent",
      label: ko.print.table.notSent,
      sub: null,
      codes: [],
    });
  }
  if (fixed.has("residual")) {
    fixedCols.push({
      key: "residual",
      kind: "residual",
      label: c.err.residual,
      sub: ko.print.table.residualSub,
      codes: [],
    });
  }

  const slots = Math.max(ERR_MAX_COLS - fixedCols.length, 1);
  const ranked = [...sums.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([k]) => k);
  const kept = ranked.length > slots ? ranked.slice(0, slots - 1) : ranked;
  const folded = ranked.filter((k) => !kept.includes(k)).sort((a, b) => a - b);

  const cols: ErrCol[] = kept
    .sort((a, b) => a - b)
    .map((code) => ({
      key: `c${code}`,
      kind: "code",
      label: String(code),
      sub: ko.print.table.codeNames[code] ?? null,
      codes: [code],
    }));
  if (folded.length > 0) {
    cols.push({ key: "other", kind: "other", label: c.err.other, sub: null, codes: folded });
  }
  return [...cols, ...fixedCols];
}

function cellFor(col: ErrCol, pair: StepPair): ErrCell {
  const cells = pair.codes.filter((x) => {
    if (!visible(x)) return false;
    if (col.kind === "other") return typeof x.code === "number" && col.codes.includes(x.code);
    return colKey(x.code) === col.key;
  });
  if (cells.length === 0) return null;
  const before = cells.reduce((n, x) => n + x.before, 0);
  const after = cells.reduce((n, x) => n + x.after, 0);
  if (before === 0 && after === 0) return null;
  const starBefore = cells.some((x) => x.starBefore);
  const starAfter = cells.some((x) => x.starAfter);
  return {
    before: fmtCount(before),
    after: fmtCount(after),
    starBefore,
    starAfter,
    tone: tone(before, after, starBefore || starAfter),
  };
}

type Args = { before: RunModel; after: RunModel; pairs: StepPair[]; incomparable: boolean };

export function buildErrorTable(a: Args): ErrorTableModel {
  const cols = buildCols(a.pairs);
  const remainingIds = a.incomparable ? new Set<string>() : remainingStepIds(a.after, a.pairs);
  const none = c.db.none;

  const rows: ErrRow[] = a.pairs.map((p) => {
    const bRow = a.before.table.rows.find((r) => r.stepId === p.stepId);
    const aRow = a.after.table.rows.find((r) => r.stepId === p.stepId);
    const rateOf = (r: typeof bRow) => (!r || r.count === 0 ? 0 : r.errorCount / r.count);
    const rb = rateOf(bRow);
    const ra = rateOf(aRow);
    const both = p.executedBefore && p.executedAfter;
    const starBefore = p.codes.some((x) => x.starBefore);
    const starAfter = p.codes.some((x) => x.starAfter);

    let change: ErrChange;
    if (a.incomparable || !both) {
      change = { cls: "none", glyph: "", word: none };
    } else if (starBefore || starAfter) {
      change = { cls: "reference", glyph: "", word: c.change.reference };
    } else {
      const cls = classifyChange("lower", rb, ra, FLOOR.error_rate);
      change =
        cls === "better"
          ? { cls, glyph: "▼", word: c.change.better }
          : cls === "worse"
            ? { cls, glyph: "▲", word: c.change.worse }
            : { cls: "similar", glyph: "=", word: c.change.similar };
    }

    const distinct = (change.cls === "better" || change.cls === "worse") && rb !== ra;
    const texts = valueTexts("pct", rb, ra, distinct);
    const cells: Record<string, ErrCell> = {};
    for (const col of cols) cells[col.key] = cellFor(col, p);

    return {
      stepId: p.stepId,
      label: p.label,
      note:
        p.presence === "beforeOnly"
          ? c.db.onlyBefore
          : p.presence === "afterOnly"
            ? c.db.onlyAfter
            : null,
      rate: {
        before: p.executedBefore ? texts.b : none,
        after: p.executedAfter ? texts.a : none,
        starBefore,
        starAfter,
      },
      cells,
      change,
      remaining: remainingIds.has(p.stepId),
    };
  });

  const notes: string[] = [];
  if (!a.incomparable && hasStar(a.pairs)) {
    const star = starFootnote(a.pairs);
    if (star) notes.push(star);
  }
  const otherCol = cols.find((col) => col.kind === "other");
  if (otherCol) {
    const parts = otherCol.codes.map((code) => {
      let before = 0;
      let after = 0;
      for (const p of a.pairs) {
        for (const x of p.codes) {
          if (x.code !== code || !visible(x)) continue;
          before += x.before;
          after += x.after;
        }
      }
      return c.err.otherPart(code, fmtCount(before), fmtCount(after));
    });
    notes.push(c.err.otherNote(parts));
  }
  return { cols, rows, notes };
}
