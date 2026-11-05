import { describe, expect, it } from "vitest";
import {
  EPS_MM,
  PAGE_BODY_MM,
  PX_PER_MM,
  chooseSummaryLevel,
  paginate,
  pxToMm,
  totalHeight,
  type Block,
  type LadderLevel,
} from "../paginate";

const atom = (id: string, heightMm: number): Block => ({ kind: "atomic", id, heightMm });
const table = (id: string, titleMm: number, headerMm: number, rowsMm: number[]): Block => ({
  kind: "table",
  id,
  titleMm,
  headerMm,
  rowsMm,
});

describe("paginate", () => {
  it("constants", () => {
    expect(PAGE_BODY_MM).toBe(259);
    expect(pxToMm(96)).toBeCloseTo(25.4, 6);
    expect(PX_PER_MM).toBeCloseTo(3.7795, 3);
  });

  it("atomic_flow", () => {
    const r = paginate([atom("a", 100), atom("b", 100), atom("c", 100)], 259);
    expect(r.pages).toEqual([
      [
        { kind: "atomic", id: "a" },
        { kind: "atomic", id: "b" },
      ],
      [{ kind: "atomic", id: "c" }],
    ]);
    expect(r.oversized).toEqual([]);
  });

  it("table_split_repeats_header", () => {
    const r = paginate([atom("a", 200), table("t", 8, 6, Array(10).fill(10))], 259);
    expect(r.pages).toEqual([
      [
        { kind: "atomic", id: "a" },
        { kind: "tableSlice", id: "t", from: 0, to: 4, continued: false },
      ],
      [{ kind: "tableSlice", id: "t", from: 4, to: 10, continued: true }],
    ]);
  });

  it("table_slice_fits_exactly_259", () => {
    // 200 + 8 + 6 + 3*15 = 259 exactly -> 3 rows stay on page 1
    const r = paginate([atom("a", 200), table("t", 8, 6, Array(5).fill(15))], 259);
    expect(r.pages[0]).toEqual([
      { kind: "atomic", id: "a" },
      { kind: "tableSlice", id: "t", from: 0, to: 3, continued: false },
    ]);
    expect(r.pages[1]).toEqual([{ kind: "tableSlice", id: "t", from: 3, to: 5, continued: true }]);
  });

  it("table_needs_title_header_and_one_row", () => {
    // used 240, remaining 19 < 8+6+10=24 -> whole table starts on next page
    const r = paginate([atom("a", 240), table("t", 8, 6, [10, 10])], 259);
    expect(r.pages).toEqual([
      [{ kind: "atomic", id: "a" }],
      [{ kind: "tableSlice", id: "t", from: 0, to: 2, continued: false }],
    ]);
  });

  it("oversized_atomic_alone", () => {
    const r = paginate([atom("p", 50), atom("x", 300), atom("q", 50)], 259);
    expect(r.pages).toEqual([
      [{ kind: "atomic", id: "p" }],
      [{ kind: "atomic", id: "x" }],
      [{ kind: "atomic", id: "q" }],
    ]);
    expect(r.oversized).toEqual(["x"]);
  });

  it("oversized_row_alone", () => {
    // body - title - header = 245; a 250 row is oversized
    const r = paginate([table("t", 8, 6, [10, 250, 10])], 259);
    expect(r.pages).toEqual([
      [{ kind: "tableSlice", id: "t", from: 0, to: 1, continued: false }],
      [{ kind: "tableSlice", id: "t", from: 1, to: 2, continued: true }],
      [{ kind: "tableSlice", id: "t", from: 2, to: 3, continued: true }],
    ]);
    expect(r.oversized).toEqual(["t"]);
  });

  it("oversized_table_id_deduped", () => {
    const r = paginate([table("t", 8, 6, [250, 250, 10])], 259);
    expect(r.oversized).toEqual(["t"]);
  });

  it("float_noise_fits", () => {
    expect(EPS_MM).toBe(1e-6);
    // rows sum to 259 + 1e-9 incl. head: 200 + 14 + 45.000000001
    const r = paginate([atom("a", 200), table("t", 8, 6, [15, 15, 15.000000001, 15])], 259);
    expect(r.pages[0]![1]).toEqual({
      kind: "tableSlice",
      id: "t",
      from: 0,
      to: 3,
      continued: false,
    });
    const r2 = paginate([atom("a", 259.000000001)], 259);
    expect(r2.oversized).toEqual([]);
    // a real overflow still counts
    expect(paginate([atom("a", 259.01)], 259).oversized).toEqual(["a"]);
  });

  it("empty_blocks", () => {
    expect(paginate([], 259)).toEqual({ pages: [[]], oversized: [] });
  });

  it("empty_table", () => {
    const r = paginate([atom("a", 250), table("t", 8, 6, [])], 259);
    expect(r.pages).toEqual([
      [{ kind: "atomic", id: "a" }],
      [{ kind: "tableSlice", id: "t", from: 0, to: 0, continued: false }],
    ]);
    const r2 = paginate([table("t", 8, 6, [])], 259);
    expect(r2.pages).toEqual([[{ kind: "tableSlice", id: "t", from: 0, to: 0, continued: false }]]);
    expect(r2.oversized).toEqual([]);
  });
});

describe("totalHeight / ladder", () => {
  it("total_height", () => {
    expect(totalHeight([atom("a", 10), table("t", 8, 6, [5, 5])])).toBe(34);
  });

  it("ladder_first_fit", () => {
    const calls: LadderLevel[] = [];
    const blocksAt = (l: LadderLevel): Block[] => {
      calls.push(l);
      return l < 3 ? [atom("a", 200), atom("b", 200)] : [atom("a", 100)];
    };
    const r = chooseSummaryLevel(blocksAt, 259);
    expect(r.level).toBe(3);
    expect(r.fits).toBe(true);
    expect(r.pages).toHaveLength(1);
    expect(calls).toEqual([0, 1, 2, 3]);
  });

  it("ladder_never_fits", () => {
    const calls: LadderLevel[] = [];
    const r = chooseSummaryLevel((l) => {
      calls.push(l);
      return [atom(`a${l}`, 200), atom(`b${l}`, 200)];
    }, 259);
    expect(calls).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.level).toBe(8);
    expect(r.fits).toBe(false);
    expect(r.pages).toEqual([[{ kind: "atomic", id: "a8" }], [{ kind: "atomic", id: "b8" }]]);
  });

  it("ladder_oversized_single_page_is_not_fit", () => {
    const calls: LadderLevel[] = [];
    const r = chooseSummaryLevel((l) => {
      calls.push(l);
      return [atom("x", l < 2 ? 300 : 100)];
    }, 259);
    expect(calls).toEqual([0, 1, 2]);
    expect(r).toMatchObject({ level: 2, fits: true, oversized: [] });
    const r2 = chooseSummaryLevel(() => [atom("x", 300)], 259);
    expect(r2.level).toBe(8);
    expect(r2.fits).toBe(false);
    expect(r2.oversized).toEqual(["x"]);
  });
});
