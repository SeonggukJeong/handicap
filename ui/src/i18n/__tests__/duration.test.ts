import { describe, it, expect } from "vitest";
import { formatDurationKo, formatLatencyKo, formatSecondsKo } from "../duration";

describe("formatDurationKo", () => {
  it("초 단위", () => expect(formatDurationKo(30)).toBe("30초"));
  it("정확히 1분", () => expect(formatDurationKo(60)).toBe("1분"));
  it("분+초 조합", () => expect(formatDurationKo(90)).toBe("1분 30초"));
  it("시간+분", () => expect(formatDurationKo(3900)).toBe("1시간 5분"));
  it("0초", () => expect(formatDurationKo(0)).toBe("0초"));
  it("음수는 0초로 clamp", () => expect(formatDurationKo(-5)).toBe("0초"));
  it("소수 입력은 floor", () => expect(formatDurationKo(90.9)).toBe("1분 30초"));
});

describe("formatSecondsKo", () => {
  it("1초 미만은 소수 2자리", () => expect(formatSecondsKo(210)).toBe("0.21초"));
  it("1~10초는 소수 1자리", () => expect(formatSecondsKo(1234)).toBe("1.2초"));
  it("10초 이상은 정수", () => expect(formatSecondsKo(12345)).toBe("12초"));
  it("0ms", () => expect(formatSecondsKo(0)).toBe("0.00초"));
});

describe("formatLatencyKo", () => {
  it("1초 미만은 ms 그대로", () => {
    expect(formatLatencyKo(0)).toBe("0ms");
    expect(formatLatencyKo(1)).toBe("1ms");
    expect(formatLatencyKo(999)).toBe("999ms");
  });
  it("1초 이상은 초 표기", () => {
    expect(formatLatencyKo(1000)).toBe("1.0초");
    expect(formatLatencyKo(12_000)).toBe("12초");
  });
});
