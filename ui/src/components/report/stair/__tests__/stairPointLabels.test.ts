import { describe, it, expect } from "vitest";
import { labeledIndices, LABEL_ALL_MAX_STEPS, MIN_PX_PER_LABEL } from "../stairPointLabels";

type R = Parameters<typeof labeledIndices>[0][number];
const row = (p99: number | null, state: R["state"] = "ok", knee = false): R => ({
  p99,
  state,
  knee,
});

describe("labeledIndices", () => {
  it("계단 수가 임계값 이하면 측정된 모든 점에 라벨", () => {
    const rows = Array.from({ length: LABEL_ALL_MAX_STEPS }, (_, i) => row(10 + i));
    rows[2] = row(null, "not_measured");
    expect(labeledIndices(rows).size).toBe(LABEL_ALL_MAX_STEPS - 1);
  });

  it("좁은 차트(계단당 폭 < MIN_PX_PER_LABEL)면 계단이 적어도 의미 있는 점에만 라벨", () => {
    const rows: R[] = [row(30), row(31), row(59, "ok", true), row(4993, "saturated"), row(2644, "after"), row(2644, "after")];
    const narrow = [...labeledIndices(rows, (MIN_PX_PER_LABEL - 1) * rows.length)].sort((a, b) => a - b);
    expect(narrow).toEqual([2, 3]);
    expect(labeledIndices(rows, MIN_PX_PER_LABEL * rows.length).size).toBe(6);
    expect(labeledIndices(rows).size).toBe(6);
  });

  it("50계단: knee·상태가 바뀌는 첫 점·최대 p99만 라벨", () => {
    const rows: R[] = Array.from({ length: 50 }, (_, i) => row(10 + i));
    rows[10] = row(500, "spike");
    rows[20] = row(60, "ok", true);
    for (let i = 30; i < 50; i++) rows[i] = row(1000 + i, "saturated");
    rows[45] = row(99999, "saturated");
    const got = [...labeledIndices(rows)].sort((a, b) => a - b);
    expect(got).toEqual([10, 20, 30, 45]);
  });
});
