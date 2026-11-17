import { describe, expect, it } from "vitest";
import {
  STAIR_DEFAULTS,
  expandStair,
  generateTargets,
  parseTargets,
  stairErrors,
  stairSummary,
  type StairDraft,
} from "../stair";

const fail = (s: string) => {
  const r = parseTargets(s);
  return r.ok ? null : r.error;
};

describe("parseTargets", () => {
  it("parseTargets_trailing_comma_and_spaces", () => {
    expect(parseTargets("100, 200,")).toEqual({ ok: true, values: [100, 200] });
    expect(parseTargets(" 100 ,200 , 300 ")).toEqual({ ok: true, values: [100, 200, 300] });
  });
  it("rejects empty", () => {
    expect(fail("")).toBe("empty");
    expect(fail("  ")).toBe("empty");
    expect(fail(",")).toBe("empty");
  });
  it("rejects decreasing / duplicate", () => {
    expect(fail("200,100")).toBe("notIncreasing");
    expect(fail("100,100")).toBe("notIncreasing");
  });
  it("rejects decimal / non-numeric / empty middle token", () => {
    expect(fail("100,200.5")).toBe("notInteger");
    expect(fail("100,abc")).toBe("notInteger");
    expect(fail("100,,200")).toBe("notInteger");
  });
  it("rejects zero / negative / above 1_000_000", () => {
    expect(fail("0,100")).toBe("outOfRange");
    expect(fail("-5,100")).toBe("outOfRange");
    expect(fail("100,1000001")).toBe("outOfRange");
    expect(parseTargets("100,1000000").ok).toBe(true);
  });
  it("too_many(51) / too_few(1)", () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => i + 1).join(",");
    expect(fail(n(51))).toBe("tooMany");
    expect(parseTargets(n(50)).ok).toBe(true);
    expect(fail("100")).toBe("tooFew");
  });
});

describe("generateTargets", () => {
  it("quarter steps up to max multiple", () => {
    expect(generateTargets(400, 2)).toEqual([100, 200, 300, 400, 500, 600, 700, 800]);
    expect(generateTargets(400, 1.5)).toEqual([100, 200, 300, 400, 500, 600]);
  });
  it("rounds and dedups", () => {
    expect(generateTargets(3, 1.5)).toEqual([1, 2, 3, 4, 5]);
    expect(generateTargets(1, 1.5)).toEqual([1, 2]);
  });
});

describe("expandStair", () => {
  it("[ramp t_i, hold t_i] x n, same as server expand_stair", () => {
    expect(
      expandStair({ targets: [100, 200], hold_seconds: 60, ramp_seconds: 5, discard_seconds: 15 }),
    ).toEqual([
      { target: 100, duration_seconds: 5 },
      { target: 100, duration_seconds: 60 },
      { target: 200, duration_seconds: 5 },
      { target: 200, duration_seconds: 60 },
    ]);
  });
});

describe("stairSummary", () => {
  it("steps, total, measure", () => {
    expect(
      stairSummary({
        targets: [1, 2, 3],
        hold_seconds: 60,
        ramp_seconds: 5,
        discard_seconds: 15,
      }),
    ).toEqual({ steps: 3, totalSeconds: 195, measureSeconds: 45 });
  });
});

describe("stairErrors", () => {
  const ok: StairDraft = { ...STAIR_DEFAULTS, targets: "100, 200" };
  it("defaults + valid targets -> no errors", () => {
    expect(stairErrors(ok)).toEqual({});
  });
  it("targets error carries a fix hint with an example", () => {
    const e = stairErrors({ ...ok, targets: "200, 100" });
    expect(e.targets).toContain("예:");
  });
  it("hold / ramp / discard / p99Cap bounds", () => {
    expect(stairErrors({ ...ok, hold: "19" }).hold).toBeTruthy();
    expect(stairErrors({ ...ok, hold: "3601" }).hold).toBeTruthy();
    expect(stairErrors({ ...ok, hold: "20", discard: "10" })).toEqual({});
    expect(stairErrors({ ...ok, hold: "20", discard: "11" }).discard).toBeTruthy();
    expect(stairErrors({ ...ok, ramp: "0" }).ramp).toBeTruthy();
    expect(stairErrors({ ...ok, ramp: "601" }).ramp).toBeTruthy();
    expect(stairErrors({ ...ok, discard: "-1" }).discard).toBeTruthy();
    expect(stairErrors({ ...ok, p99Cap: "" })).toEqual({});
    expect(stairErrors({ ...ok, p99Cap: "0" }).p99Cap).toBeTruthy();
    expect(stairErrors({ ...ok, p99Cap: "600001" }).p99Cap).toBeTruthy();
    expect(stairErrors({ ...ok, p99Cap: "500" })).toEqual({});
  });
  it("blank / decimal numeric fields are errors", () => {
    expect(stairErrors({ ...ok, hold: "" }).hold).toBeTruthy();
    expect(stairErrors({ ...ok, ramp: "1.5" }).ramp).toBeTruthy();
  });
});
