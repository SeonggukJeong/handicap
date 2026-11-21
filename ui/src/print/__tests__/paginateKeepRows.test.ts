import { describe, expect, it } from "vitest";
import { KEEP_ROWS, paginate, type Block } from "../paginate";

const atom = (id: string, heightMm: number): Block => ({ kind: "atomic", id, heightMm });
const table = (rowsMm: number[]): Block => ({
  kind: "table",
  id: "t",
  titleMm: 8,
  headerMm: 6,
  rowsMm,
});
const slices = (r: ReturnType<typeof paginate>) =>
  r.pages.map((p) =>
    p
      .filter((i) => i.kind === "tableSlice")
      .map((i) => (i.kind === "tableSlice" ? [i.from, i.to] : [])),
  );

describe("표 조각 앞뒤 최소 2행", () => {
  it("KEEP_ROWS는 2", () => expect(KEEP_ROWS).toBe(2));
  it("뒤에 한 행만 남으면 앞 조각에서 한 행을 넘긴다", () => {
    // 200 + 14 + 4×10 = 254 → 기존: [0,4) [4,5)
    expect(slices(paginate([atom("a", 200), table(Array(5).fill(10))], 259))).toEqual([
      [[0, 3]],
      [[3, 5]],
    ]);
  });
  it("앞 조각이 2행을 못 지키면 표를 통째로 다음 쪽에", () => {
    // 210 + 14 + 2×15 = 254 → 기존: [0,2) [2,3)
    const r = paginate([atom("a", 210), table([15, 15, 15])], 259);
    expect(r.pages).toEqual([
      [{ kind: "atomic", id: "a" }],
      [{ kind: "tableSlice", id: "t", from: 0, to: 3, continued: false }],
    ]);
  });
  it("앞쪽에 한 행만 들어가면 표를 통째로 다음 쪽에", () => {
    // 230 + 14 + 10 = 254 → 기존: [0,1) [1,6)
    expect(slices(paginate([atom("a", 230), table(Array(6).fill(10))], 259))).toEqual([
      [],
      [[0, 6]],
    ]);
  });
  it("빈 쪽에서 시작한 긴 표도 꼬리 한 행을 남기지 않는다", () => {
    // 14 + 24×10 = 254 → 기존: [0,24) [24,25)
    expect(slices(paginate([table(Array(25).fill(10))], 259))).toEqual([[[0, 23]], [[23, 25]]]);
  });
  it("행이 2개인 표는 나뉘지 않는다", () => {
    expect(slices(paginate([atom("a", 225), table([15, 15])], 259))).toEqual([[], [[0, 2]]]);
  });
  it("행 1개짜리 표·한 쪽보다 큰 행은 그대로 끝난다", () => {
    expect(slices(paginate([atom("a", 250), table([10])], 259))).toEqual([[], [[0, 1]]]);
    expect(slices(paginate([table([10, 250, 10])], 259))).toEqual([[[0, 1]], [[1, 2]], [[2, 3]]]);
  });
  it("옮겨도 한 행 꼬리가 남으면 표를 옮기지 않는다(꼬리 규칙)", () => {
    // 10 + 14 + 200 = 224, 셋째 행은 안 들어간다. 새 쪽에서도 [0,2) [2,3)이라 옮겨 봐야 이득이 없다.
    const r = paginate([atom("a", 10), table([100, 100, 100])], 259);
    expect(r.pages).toHaveLength(2);
    expect(slices(r)).toEqual([[[0, 2]], [[2, 3]]]);
  });
  it("옮겨도 행 단위로 나뉘면 표를 옮기지 않는다(머리 규칙)", () => {
    const r = paginate([atom("a", 10), table([10, 250, 10])], 259);
    expect(r.pages).toHaveLength(3);
    expect(slices(r)).toEqual([[[0, 1]], [[1, 2]], [[2, 3]]]);
  });
  it("빈 조각을 내지 않고 이어 붙으며 한 행 조각이 없다", () => {
    for (let n = 1; n <= 30; n++)
      for (const used of [0, 100, 200, 230, 244]) {
        const r = paginate([atom("a", used), table(Array(n).fill(10))], 259);
        const all = r.pages.flat().filter((i) => i.kind === "tableSlice");
        expect(all.every((i) => i.kind === "tableSlice" && i.to > i.from)).toBe(true);
        expect(all.at(-1)).toMatchObject({ to: n });
        let prev = 0;
        for (const i of all) {
          if (i.kind !== "tableSlice") continue;
          expect(i.from).toBe(prev);
          if (n > 1) expect(i.to - i.from).toBeGreaterThanOrEqual(KEEP_ROWS);
          prev = i.to;
        }
      }
  });
});
