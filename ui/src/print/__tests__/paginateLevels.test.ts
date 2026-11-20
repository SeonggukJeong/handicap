import { describe, expect, it } from "vitest";
import { chooseSummaryLevel, type Block } from "../paginate";

// 칸마다 높이가 10씩 줄어드는 블록: level L → 높이 300 - 10*L
const at = (l: number): Block[] => [{ kind: "atomic", id: `b${l}`, heightMm: 300 - 10 * l }];

describe("chooseSummaryLevel 마지막 칸", () => {
  it("세 번째 인자가 마지막 칸을 정한다", () => {
    expect(chooseSummaryLevel(at, 259, 5)).toMatchObject({ level: 5, fits: true });
    expect(chooseSummaryLevel(at, 259, 3)).toMatchObject({ level: 3, fits: false });
  });
  it("인자 2개면 기본 8", () => {
    expect(chooseSummaryLevel(at, 259).level).toBe(5);
  });
});
