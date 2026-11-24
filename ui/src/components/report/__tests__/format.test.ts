import { describe, it, expect } from "vitest";
import { formatLatency, floorPct, formatErrPct, msNumberText } from "../format";

describe("msNumberText", () => {
  it("소수 3자리·뒤 0 생략·쉼표", () => {
    expect(msNumberText(43.903)).toBe("43.903");
    expect(msNumberText(4210)).toBe("4,210");
    expect(msNumberText(0.35)).toBe("0.35");
    expect(msNumberText(1842.6130000001)).toBe("1,842.613");
    expect(msNumberText(60000)).toBe("60,000");
  });
});

describe("formatLatency", () => {
  it("formats sub-millisecond as µs", () => {
    expect(formatLatency(850)).toBe("850 µs");
  });
  it("formats single-digit ms with one decimal", () => {
    expect(formatLatency(1_200)).toBe("1.2 ms");
  });
  it("formats larger ms as integer", () => {
    expect(formatLatency(45_000)).toBe("45 ms");
  });
  it("formats seconds with one decimal", () => {
    expect(formatLatency(2_000_000)).toBe("2.0 s");
  });
  it("rounds up to seconds instead of '1000 ms'", () => {
    expect(formatLatency(999_999)).toBe("1.0 s");
  });
  it("keeps decimals consistent at the 10 ms boundary", () => {
    expect(formatLatency(9_999)).toBe("10 ms");
    expect(formatLatency(10_000)).toBe("10 ms");
  });
  it("returns an em dash for non-finite or negative input", () => {
    expect(formatLatency(-1)).toBe("—");
    expect(formatLatency(Number.NaN)).toBe("—");
    expect(formatLatency(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("floorPct (R5)", () => {
  it("진짜 0은 0.0%", () => expect(floorPct(0)).toBe("0.0%"));
  it("nonzero<0.05는 <0.1%로 floor", () => expect(floorPct(0.03)).toBe("<0.1%"));
  it("표시 최소값 0.1%는 그대로", () => expect(floorPct(0.1)).toBe("0.1%"));
  it("정상값 불변", () => expect(floorPct(50)).toBe("50.0%"));
});
describe("formatErrPct (R5)", () => {
  it("count 0이면 —", () => expect(formatErrPct(0, 0)).toBe("—"));
  it("1/3000은 <0.1%", () => expect(formatErrPct(1, 3000)).toBe("<0.1%"));
  it("에러 0은 0.0%", () => expect(formatErrPct(0, 100)).toBe("0.0%"));
});
