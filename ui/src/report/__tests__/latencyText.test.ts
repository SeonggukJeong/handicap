import { describe, it, expect } from "vitest";
import { ko } from "../../i18n/ko";
import { formatLatency } from "../../components/report/format";
import { isLonePoint, latencyTooltipText } from "../latencyText";

describe("latencyTooltipText", () => {
  it("60초 칸은 고정 문구", () => {
    expect(latencyTooltipText(60000, false)).toBe(`${ko.report.stats.capped} ms`);
    expect(latencyTooltipText(60000, false)).toBe(ko.report.latencyChart.cappedValue);
  });
  it("1ms 미만은 µs", () => {
    expect(latencyTooltipText(0.5, false)).toBe("500 µs");
  });
  it("소수 ms는 µs 반올림 뒤 서식", () => {
    expect(latencyTooltipText(43.903, false)).toBe(formatLatency(43903));
  });
  it("capped이면 ≥ 접두", () => {
    expect(latencyTooltipText(30007.796, true)).toBe("≥ " + formatLatency(30007796));
  });
});

describe("isLonePoint", () => {
  it("앞뒤가 모두 null이면 true", () => {
    expect(isLonePoint([null, 5, null], 1)).toBe(true);
  });
  it("이웃이 있으면 false", () => {
    expect(isLonePoint([3, 5, null], 1)).toBe(false);
  });
  it("하나뿐이면 true", () => {
    expect(isLonePoint([5], 0)).toBe(true);
  });
  it("값이 null이면 false", () => {
    expect(isLonePoint([null, null, null], 1)).toBe(false);
  });
});
