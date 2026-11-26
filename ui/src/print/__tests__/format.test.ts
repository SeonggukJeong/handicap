import { describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import {
  fmtBoundary,
  fmtCount,
  fmtCriterionPair,
  fmtCriterionThreshold,
  fmtDate,
  fmtDateTime,
  fmtDurMs,
  fmtMeanMs,
  fmtMs,
  fmtMsExact,
  fmtMsPair,
  fmtPct,
  fmtPctPair,
  fmtRps,
  fmtRpsPair,
  fmtTime,
  stepNo,
} from "../format";

describe("fmtMs", () => {
  it.each([
    [0, "1ms 미만"],
    [-5, "1ms 미만"],
    [7, "7ms"],
    [9, "9ms"],
    [10, "0.01초"],
    [845, "0.85초"],
    [994, "0.99초"],
    [999, "1.0초"],
    [1000, "1.0초"],
    [2400, "2.4초"],
    [59950, "60.0초"],
  ])("%s -> %s", (ms, out) => {
    expect(fmtMs(ms)).toBe(out);
  });
});

describe("fmtMs 60초 칸 / fmtDurMs / fmtMeanMs", () => {
  it("응답 시간은 60,000 이상이면 60초 칸 글자", () => {
    expect(fmtMs(60000)).toBe(ko.print.fmt.capSec);
    expect(fmtMs(60030)).toBe("60초 이상");
    expect(fmtMs(59998)).toBe("60.0초");
    expect(fmtMs(59998.207)).toBe("60.0초");
  });
  it("길이 글자는 그대로", () => {
    expect(fmtDurMs(120000)).toBe("120.0초");
    expect(fmtDurMs(60000)).toBe("60.0초");
  });
  it("평균은 잘렸으면 이상을 붙이되 60초 칸이면 한 번만", () => {
    expect(fmtMeanMs(30000, true)).toBe(ko.print.fmt.orMore("30.0초"));
    expect(fmtMeanMs(30000, true)).toBe("30.0초 이상");
    expect(fmtMeanMs(30000, false)).toBe("30.0초");
    expect(fmtMeanMs(60030, true)).toBe("60초 이상");
  });
});

describe("fmtPct", () => {
  it.each([
    [0, "0.0%"],
    [0.0004, "0.1% 미만"],
    [0.001, "0.1%"],
    [0.026, "2.6%"],
  ])("%s -> %s", (f, out) => {
    expect(fmtPct(f)).toBe(out);
  });
});

describe("counts / rps / step numbers / dates", () => {
  it("fmtCount", () => {
    expect(fmtCount(2880)).toBe("2,880");
  });
  it("fmtRps", () => {
    expect(fmtRps(1234.56)).toBe("1,234.6건/초");
    expect(fmtRps(200)).toBe("200건/초");
    expect(fmtRps(0)).toBe("0건/초");
    expect(fmtRps(12.5)).toBe("12.5건/초");
  });
  it("stepNo", () => {
    expect(stepNo(0)).toBe("①");
    expect(stepNo(19)).toBe("⑳");
    expect(stepNo(20)).toBe("21.");
  });
  it("dates are local", () => {
    const t = new Date(2026, 10, 4, 14, 3).getTime();
    expect(fmtDateTime(t)).toBe("2026-11-04 14:03");
    expect(fmtDate(t)).toBe("2026-11-04");
    expect(fmtTime(t)).toBe("14:03");
  });
});

describe("pair formatting", () => {
  it("ms는 반올림 없이, 소수 기준은 3자리까지", () => {
    expect(fmtMsExact(3040)).toBe("3,040ms");
    expect(fmtMsExact(0)).toBe("0ms");
    expect(fmtMsExact(2999.5)).toBe("2,999.5ms");
    expect(fmtMsPair(3040, 3000)).toEqual({ actual: "3,040ms", threshold: "3,000ms", tiny: false });
    expect(fmtMsPair(3000, 2999.9999).tiny).toBe(true);
  });
  it("경계값 글자", () => {
    expect(fmtBoundary(0)).toBe("0ms");
    expect(fmtBoundary(3000)).toBe("3초");
    expect(fmtBoundary(800)).toBe("800ms");
    expect(fmtBoundary(2500)).toBe("2,500ms");
  });
  it("비율 쌍은 글자가 달라질 때까지 자릿수를 늘린다", () => {
    expect(fmtPctPair(0.0104, 0.01, 2)).toEqual({
      actual: "1.04%",
      threshold: "1.00%",
      tiny: false,
    });
    expect(fmtPctPair(0.0504, 0.05, 1)).toEqual({
      actual: "5.04%",
      threshold: "5.00%",
      tiny: false,
    });
    expect(fmtPctPair(0.0496, 0.05, 1)).toEqual({
      actual: "4.96%",
      threshold: "5.00%",
      tiny: false,
    });
    expect(fmtPctPair(0.32, 0.05, 1)).toEqual({ actual: "32.0%", threshold: "5.0%", tiny: false });
    expect(fmtPctPair(0.05, 0.05, 2)).toEqual({ actual: "5.00%", threshold: "5.00%", tiny: false });
  });
  it("6자리에서도 같으면 기본 자릿수 + tiny", () => {
    const thr = Number("0.7") / 100; // 0.006999999999999999
    expect(fmtPctPair(0.007, thr, 2)).toEqual({ actual: "0.70%", threshold: "0.70%", tiny: true });
  });
  it("0이 아닌 값이 0으로 찍히면 그 자릿수의 미만 표기", () => {
    expect(fmtPctPair(0.0004, 0.5, 1).actual).toBe("0.1% 미만");
    expect(fmtPctPair(0, 0.05, 1).actual).toBe("0.0%");
  });
  it("rps 쌍", () => {
    expect(fmtRpsPair(412.64, 400)).toEqual({
      actual: "412.6건/초",
      threshold: "400.0건/초",
      tiny: false,
    });
    expect(fmtRpsPair(400.04, 400)).toMatchObject({
      actual: "400.04건/초",
      threshold: "400.00건/초",
    });
  });
  it("metric 진입점", () => {
    expect(fmtCriterionPair("p95_ms", 3040, 3000).actual).toBe("3,040ms");
    expect(fmtCriterionPair("error_rate", 0.0104, 0.01).actual).toBe("1.04%");
    expect(fmtCriterionPair("rps", 412.64, 400)).toMatchObject({
      actual: "412.6건/초",
      threshold: "400.0건/초",
    });
    expect(fmtCriterionThreshold("p95_ms", 3000)).toBe("3,000ms");
    expect(fmtCriterionThreshold("5xx_count", 1234)).toBe("1,234건");
    expect(fmtCriterionPair("5xx_count", 1234, 1000)).toEqual({
      actual: "1,234건",
      threshold: "1,000건",
      tiny: false,
    });
    expect(fmtCriterionPair("weird", 7, 9)).toEqual({ actual: "7", threshold: "9", tiny: false });
    expect(fmtCriterionThreshold("weird", 7)).toBe("7");
  });
  it("불변식: 값이 다르면 글자가 다르거나 tiny", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 500; i++) {
      const t = rnd();
      const a = i % 3 === 0 ? t + (i % 2 === 0 ? 1e-9 : -1e-9) : rnd();
      for (const base of [1, 2]) {
        const r = fmtPctPair(a, t, base);
        expect(a === t || r.actual !== r.threshold || r.tiny).toBe(true);
      }
    }
  });
});

describe("fmtCriterionPair capped", () => {
  it("capped 시간 쌍은 ≥ 가 붙고 tiny가 아니다", () => {
    const p = fmtCriterionPair("max_ms", 60000, 10000, true);
    expect(p.actual).toBe("≥ 60,000ms");
    expect(p.tiny).toBe(false);
  });
  it("capped 생략 시 그대로", () => {
    expect(fmtCriterionPair("max_ms", 60000, 10000).actual).toBe("60,000ms");
  });
  it("시간이 아니면 ≥ 없음", () => {
    expect(fmtCriterionPair("error_rate", 0.1, 0.05, true).actual).not.toContain("≥");
  });
});

describe("ko.print 띄어쓰기", () => {
  it("응답시간(붙여쓰기)이 인쇄 문구에 없다", () => {
    const json = JSON.stringify(ko.print, (_, v) => (typeof v === "function" ? undefined : v));
    expect(json).not.toContain("응답시간");
    expect(ko.print.sentence.fallback("1ms")).toContain("응답 시간");
    expect(ko.print.sentence.fallback("1ms")).not.toContain("응답시간");
    expect(ko.print.criteria.percentileName(95)).toBe("95% 응답 시간");
  });
});
