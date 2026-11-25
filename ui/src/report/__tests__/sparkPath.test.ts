import { describe, it, expect } from "vitest";
import { sparkPath } from "../sparkPath";

const box = { xMax: 3, yMax: 100, x0: 0, x1: 300, yTop: 0, yBottom: 80 };

describe("sparkPath", () => {
  it("끊긴 묶음은 M으로 다시 시작하고 점 하나는 M L 같은 점", () => {
    expect(
      sparkPath(
        [
          { x: 0, y: 0 },
          { x: 1, y: 50 },
          { x: 2, y: null },
          { x: 3, y: 100 },
        ],
        box,
      ),
    ).toBe("M0,80 L100,40 M300,0 L300,0");
  });
  it("모든 y가 null이면 빈 글", () => {
    expect(sparkPath([{ x: 0, y: null }], box)).toBe("");
  });
  it("yMax를 넘는 값은 윗변에 붙는다", () => {
    expect(sparkPath([{ x: 0, y: 150 }], box)).toBe("M0,0 L0,0");
  });
  it("xMax 0이면 분모 1", () => {
    expect(sparkPath([{ x: 0, y: 0 }], { ...box, xMax: 0 })).toBe("M0,80 L0,80");
  });
});
