import { describe, it, expect } from "vitest";
import { ko } from "../../../i18n/ko";
import {
  formatLatency,
  floorPct,
  formatErrPct,
  msNumberText,
  latencyShown,
  latencyCellText,
  latencyUnitText,
  meanShown,
  splitLatencyText,
  statMsText,
  statMs3Text,
} from "../format";

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

const st = (o: Partial<Record<string, number | boolean>>) => ({
  min_us: 0,
  mean_us: 0,
  max_us: 0,
  stdev_us: 0,
  p50_us: 0,
  p90_us: 0,
  p95_us: 0,
  p99_us: 0,
  capped: false,
  ...o,
});

describe("latencyShown·셀·단위 글자", () => {
  it("분기", () => {
    expect(latencyShown(43, undefined)).toEqual({ kind: "ms", ms: 43 });
    expect(latencyShown(0, 350)).toEqual({ kind: "us", text: "350 µs" });
    expect(latencyShown(0, 999)).toEqual({ kind: "us", text: "999 µs" });
    expect(latencyShown(1, 1000)).toEqual({ kind: "ms", ms: 1 });
    expect(latencyShown(59999, 59_999_999)).toEqual({ kind: "ms", ms: 59999 });
    expect(latencyShown(60030, 60_000_000)).toEqual({ kind: "capped" });
  });
  it("60초 칸 글자는 ≥ 뒤가 줄바꿈 없는 공백(U+00A0)", () => {
    expect(ko.report.stats.capped).toBe("≥\u00a060,000");
    const t = latencyCellText({ kind: "capped" } as never);
    expect(t).toContain("\u00a0");
    expect(t).not.toContain(" ");
  });

  it("latencyCellText", () => {
    expect(latencyCellText(latencyShown(43, undefined))).toBe("43");
    expect(latencyCellText(latencyShown(0, 350))).toBe("350 µs");
    expect(latencyCellText(latencyShown(60030, 60_000_000))).toBe("≥\u00a060,000");
  });
  it("latencyUnitText", () => {
    expect(latencyUnitText(latencyShown(43, undefined))).toBe("43 ms");
    expect(latencyUnitText(latencyShown(0, 350))).toBe("350 µs");
    expect(latencyUnitText(latencyShown(60030, 60_000_000))).toBe("≥\u00a060,000 ms");
  });
});

describe("meanShown", () => {
  it("ms·capped·µs·null", () => {
    expect(meanShown({ mean_ms: 1843, stats: st({ mean_us: 1_842_613 }) })).toEqual({
      kind: "ms",
      ms: 1843,
    });
    expect(meanShown({ mean_ms: 60015, stats: st({ mean_us: 60_000_000, capped: true }) })).toEqual(
      { kind: "capped" },
    );
    expect(meanShown({ mean_ms: 0, stats: st({ mean_us: 350 }) })).toEqual({
      kind: "us",
      text: "350 µs",
    });
    expect(meanShown({ mean_ms: 5, stats: undefined })).toBeNull();
  });
});

describe("splitLatencyText — 나눈 줄은 정수 ms, 60,000 초과는 60초 칸", () => {
  it("60030 → 「≥ 60,000」, 60000·44는 그대로", () => {
    expect(splitLatencyText(60030)).toBe(ko.report.stats.capped);
    expect(splitLatencyText(60000)).toBe("60000");
    expect(splitLatencyText(44)).toBe("44");
  });
});

describe("statMsText — 통계 한 칸의 시간 글자(내림/반올림·µs·60초 칸)", () => {
  it("내림·반올림·µs·60초 칸", () => {
    expect(statMsText(1499, "floor")).toBe("1");
    expect(statMsText(1500, "round")).toBe("2");
    expect(statMsText(1499, "round")).toBe("1");
    expect(statMsText(350, "floor")).toBe("350 µs");
    expect(statMsText(999, "round")).toBe("999 µs");
    expect(statMsText(60_000_000, "floor")).toBe(ko.report.stats.capped);
    expect(statMsText(59_998_207, "floor")).toBe("59998");
  });
});

describe("statMs3Text — 비교 화면 시간 칸(CSV ms3 글자, 소수 3자리)", () => {
  it("표", () => {
    expect(statMs3Text(999)).toBe(statMsText(999, "floor"));
    expect(statMs3Text(350)).toBe("350 µs");
    expect(statMs3Text(1000)).toBe("1.000");
    expect(statMs3Text(115_204)).toBe("115.204");
    expect(statMs3Text(52_118)).toBe("52.118");
    expect(statMs3Text(59_999_999)).toBe("59999.999");
    expect(statMs3Text(60_000_000)).toBe(ko.report.stats.capped);
  });
});
