import { describe, it, expect } from "vitest";
import { linearDomain, logDomain } from "../stairChartDomain";

describe("logDomain", () => {
  it("최댓값 위·최솟값 아래로 1.5배 이상 여유", () => {
    const [lo, hi] = logDomain([5, 120, 4993]);
    expect(hi).toBeGreaterThanOrEqual(4993 * 1.5);
    expect(lo).toBeLessThanOrEqual(5 / 1.5);
    expect(lo).toBeGreaterThan(0);
  });
  it("값이 전부 같아도 위아래 여유가 생긴다", () => {
    const [lo, hi] = logDomain([71, 71, 71]);
    expect(hi).toBeGreaterThanOrEqual(71 * 1.5);
    expect(lo).toBeLessThanOrEqual(71 / 1.5);
  });
  it("0·null·음수는 무시한다", () => {
    const [lo, hi] = logDomain([0, null, -3, 10, 100]);
    expect(lo).toBeLessThanOrEqual(10 / 1.5);
    expect(lo).toBeGreaterThan(1);
    expect(hi).toBeGreaterThanOrEqual(150);
  });
  it("값이 없으면 로그축이 깨지지 않는 기본 범위", () => {
    const [lo, hi] = logDomain([0, null]);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("linearDomain", () => {
  it("0부터 최댓값보다 높게(최댓값 선이 위 테두리에 붙지 않게)", () => {
    const [lo, hi] = linearDomain([10, 40, null]);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThanOrEqual(44);
  });
  it("값이 없으면 [0, 1]", () => {
    expect(linearDomain([null])).toEqual([0, 1]);
  });
});
