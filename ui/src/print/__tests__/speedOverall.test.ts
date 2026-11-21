import { describe, expect, it } from "vitest";
import { buildOverallBand } from "../speedBands";
import { band } from "./speedFixtures";

const three = band({ slow_ms: 3000, basis: "p95", fast: 580, within: 330, over: 90 });
const two = band({ slow_ms: 3000, basis: "p95", fast: null, within: 910, over: 90 });
const zero = band({ slow_ms: 3000, basis: "p95", fast: 0, within: 0, over: 0 });

describe("buildOverallBand — 판정 표시 없는 전체 요청 한 줄", () => {
  it("세 구간: 막대 58·33·9, 칸 글자, 실패 2.6%, 어떤 칸에도 판정 표시가 없다", () => {
    const b = buildOverallBand(three, { count: 1000, errors: 26 });
    expect(b.twoBand).toBe(false);
    expect(b.bar?.map((s) => s.band)).toEqual(["fast", "within", "over"]);
    expect(b.bar?.[0].pct).toBeCloseTo(58, 6);
    expect(b.bar?.[1].pct).toBeCloseTo(33, 6);
    expect(b.bar?.[2].pct).toBeCloseTo(9, 6);
    expect(b.fast?.text).toBe("58.0%");
    expect(b.within.text).toBe("33.0%");
    expect(b.over.text).toBe("9.0%");
    expect(b.fail.text).toBe("2.6%");
    for (const c of [b.fast!, b.within, b.over, b.fail]) {
      expect(c.mark).toBe("none");
      expect(c.glyph).toBe("");
      expect(c.star).toBe(false);
    }
  });

  it("두 구간(fast null): twoBand · fast null · 막대 조각 2개", () => {
    const b = buildOverallBand(two, { count: 1000, errors: 0 });
    expect(b.twoBand).toBe(true);
    expect(b.fast).toBeNull();
    expect(b.bar?.map((s) => s.band)).toEqual(["fast", "over"]);
    expect(b.within.text).toBe("91.0%");
    expect(b.fail.muted).toBe(true);
  });

  it("구간 합 0 → 막대 null, 구간 칸 전부 대시", () => {
    const b = buildOverallBand(zero, { count: 0, errors: 0 });
    expect(b.bar).toBeNull();
    expect(b.fast?.text).toBe("—");
    expect(b.within.text).toBe("—");
    expect(b.over.text).toBe("—");
  });

  it("요청 0건이면 실패 칸이 대시(0으로 나누지 않는다)", () => {
    const b = buildOverallBand(three, { count: 0, errors: 0 });
    expect(b.fail.text).toBe("—");
    expect(b.fail.muted).toBe(true);
  });
});
