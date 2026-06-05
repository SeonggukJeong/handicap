import { describe, it, expect } from "vitest";
import { formatLatency } from "../format";

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
