import { describe, expect, it } from "vitest";
import { computeTipPos, TIP_WIDTH_PX } from "../helpTipPos";

const VP = { width: 1280, height: 900 };
const rect = (left: number, top: number, w = 16, h = 16) => ({
  left,
  right: left + w,
  top,
  bottom: top + h,
});

describe("computeTipPos", () => {
  it("기본: 앵커 아래 4px, 앵커 좌단 정렬", () => {
    expect(computeTipPos(rect(100, 100), 120, VP)).toEqual({ top: 120, left: 100 });
  });

  it("우단을 넘치면 앵커 우단 정렬(edge-flip)", () => {
    // left 1200 + 224 > 1280 - 8 → left = right(1216) - 224
    expect(computeTipPos(rect(1200, 100), 120, VP).left).toBe(1216 - TIP_WIDTH_PX);
  });

  it("좌측은 8px 여백으로 clamp", () => {
    expect(computeTipPos(rect(2, 100), 120, VP).left).toBe(8);
  });

  it("아래 공간이 부족하고 위 공간이 있으면 위로 뒤집힌다", () => {
    // below = 816+4 = 820, 820+200 > 892 → above = 800-4-200 = 596
    expect(computeTipPos(rect(100, 800), 200, VP).top).toBe(596);
  });

  it("위아래 모두 부족하면 뷰포트 하단 8px에 맞춘다", () => {
    const vp = { width: 1280, height: 300 };
    // below 120+250 > 292, above 100-4-250 < 8 → 300-250-8 = 42
    expect(computeTipPos(rect(100, 100), 250, vp).top).toBe(42);
  });

  it("top은 최소 8", () => {
    const vp = { width: 1280, height: 200 };
    expect(computeTipPos(rect(100, 100), 400, vp).top).toBe(8);
  });
});
