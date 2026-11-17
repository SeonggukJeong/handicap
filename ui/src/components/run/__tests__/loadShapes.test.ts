import { describe, expect, it } from "vitest";
import { LOAD_SHAPES } from "../loadShapes";

describe("LOAD_SHAPES", () => {
  it("step 라벨은 「점증 스트레스」(계단 run 모드와 구분)", () => {
    expect(LOAD_SHAPES.find((s) => s.id === "step")?.label).toBe("점증 스트레스");
  });
});
