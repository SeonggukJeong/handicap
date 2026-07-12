import { describe, expect, it } from "vitest";
import { openLoopRates } from "../openLoopRates";
import type { Insight } from "../../../api/schemas";

const sat = (achieved: number): Insight[] => [
  { kind: "load_gen_saturated", severity: "warning", achieved_per_sec: achieved } as Insight,
];

describe("openLoopRates", () => {
  it("closed-loop(profile에 target_rps·stages 없음) → null", () => {
    expect(openLoopRates({ vus: 10 }, 0, 15, [])).toBeNull();
  });
  it("고정 rate·dropped 0 → 달성=목표", () => {
    expect(openLoopRates({ target_rps: 20 }, 0, 15, [])).toEqual({
      target: 20,
      curve: false,
      achieved: 20,
    });
  });
  it("고정 rate·dropped 260·15s → 달성 = 20 − 260/15 ≈ 2.667 (서버 R2 공식과 동형)", () => {
    const r = openLoopRates({ target_rps: 20 }, 260, 15, []);
    expect(r?.achieved).toBeCloseTo(20 - 260 / 15, 5);
  });
  it("인사이트 achieved_per_sec가 있으면 그 값 우선(고정 rate도)", () => {
    expect(openLoopRates({ target_rps: 20 }, 260, 15, sat(2.7))?.achieved).toBe(2.7);
  });
  it("곡선 → target=피크·curve=true·인사이트 없으면 달성 null(적분 복제 연기 §7)", () => {
    expect(
      openLoopRates({ stages: [{ target: 10 }, { target: 30 }, { target: 5 }] }, 100, 20, []),
    ).toEqual({ target: 30, curve: true, achieved: null });
  });
  it("곡선 + 인사이트 → 달성 = achieved_per_sec passthrough", () => {
    expect(openLoopRates({ stages: [{ target: 30 }] }, 100, 20, sat(7.5))?.achieved).toBe(7.5);
  });
  it("달성 음수는 0으로 클램프·duration 0 가드 → null", () => {
    expect(openLoopRates({ target_rps: 1 }, 1000, 15, [])?.achieved).toBe(0);
    expect(openLoopRates({ target_rps: 20 }, 10, 0, [])?.achieved).toBeNull();
  });
  it("profile null/unknown 형태 관대 처리 → null", () => {
    expect(openLoopRates(null, 0, 15, [])).toBeNull();
  });
});
