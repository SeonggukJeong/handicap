import { describe, it, expect } from "vitest";
import { labeledIndices, LABEL_ALL_MAX_STEPS } from "../stairPointLabels";

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
