import { describe, it, expect } from "vitest";
import { actualText } from "../verdictFormat";

describe("actualText", () => {
  it("60초 칸에 걸린 최대 시간 기준은 「≥」 + 줄바꿈 없는 공백(NBSP)", () => {
    expect(actualText({ metric: "max_ms", actual: 60000, capped: true })).toBe("≥\u00a060,000 ms");
  });
});
