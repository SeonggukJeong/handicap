import { describe, expect, it } from "vitest";
import { loopCountLabel } from "../loopLabel";

const WHILE = { left: "{{code}}", op: "eq" as const, right: "200" };

describe("loopCountLabel", () => {
  it("while 없음 → × N (지금 글자 그대로)", () => {
    expect(loopCountLabel({ repeat: 5 })).toBe("× 5");
  });
  it("while + repeat → 조건 반복 · 최대 N", () => {
    expect(loopCountLabel({ repeat: 5, while: WHILE })).toBe("조건 반복 · 최대 5");
  });
  it("while만 → 조건 반복 · 무제한", () => {
    expect(loopCountLabel({ while: WHILE })).toBe("조건 반복 · 무제한");
  });
});
