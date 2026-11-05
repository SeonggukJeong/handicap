import { describe, expect, it } from "vitest";
import { fmtCount, fmtDate, fmtDateTime, fmtMs, fmtPct, fmtRps, fmtTime, stepNo } from "../format";

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
