import { describe, expect, it } from "vitest";
import {
  STAIR_DEFAULTS,
  autoStopSummary,
  draftToStairConfig,
  stairDraftFromConfig,
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

describe("자동 정지 draft", () => {
  const EM = { error_rate_pct: 5, p99_ms: 2000, consecutive_seconds: 3, min_requests: 20 };
  const aEra = { targets: [100, 200], hold_seconds: 60, ramp_seconds: 5, discard_seconds: 15 };
  const base: StairDraft = { ...STAIR_DEFAULTS, targets: "100, 200" };

  it("defaults_auto_stop_on", () => {
    expect(draftToStairConfig(base)?.auto_stop).toEqual({ saturation: "two_fails", emergency: EM });
  });
  it("draft_from_config_without_auto_stop_is_off", () => {
    const d = stairDraftFromConfig(aEra);
    expect(d.satOn).toBe(false);
    expect(d.emOn).toBe(false);
    expect(d.emErrorPct).toBe("5");
    const back = draftToStairConfig(d);
    expect(back).toEqual(aEra);
    expect(back).not.toHaveProperty("auto_stop");
    expect(JSON.stringify(back)).toBe(JSON.stringify(aEra));
  });
  it("round_trip_with_auto_stop", () => {
    for (const a of [
      { saturation: "first_fail" as const, emergency: { ...EM, error_rate_pct: 5.5 } },
      { saturation: "two_fails" as const, emergency: null },
      { saturation: null, emergency: EM },
    ]) {
      const c = { ...aEra, auto_stop: a };
      expect(draftToStairConfig(stairDraftFromConfig(c))).toEqual(c);
    }
  });
  it("both_off_omits_key", () => {
    const c = draftToStairConfig({ ...base, satOn: false, emOn: false });
    expect(c).not.toHaveProperty("auto_stop");
  });
  it("꺼진 칸이 저장된 satMode를 유지한다", () => {
    const d = stairDraftFromConfig({
      ...aEra,
      auto_stop: { saturation: null, emergency: EM },
    });
    expect(d.satOn).toBe(false);
    expect(d.satMode).toBe("two_fails");
  });
  it("emergency_errors_only_when_on", () => {
    for (const [k, v] of [
      ["emErrorPct", "0"],
      ["emErrorPct", "100.01"],
      ["emErrorPct", "abc"],
      ["emP99Ms", "1.5"],
      ["emP99Ms", "0"],
      ["emP99Ms", "600001"],
      ["emSeconds", "61"],
      ["emSeconds", "0"],
      ["emMinRequests", "0"],
      ["emMinRequests", "100001"],
    ] as const) {
      expect(stairErrors({ ...base, [k]: v })[k]).toBeTruthy();
      expect(stairErrors({ ...base, emOn: false, [k]: v })).toEqual({});
    }
  });
  it("decimal_error_rate_ok", () => {
    expect(stairErrors({ ...base, emErrorPct: "5.5" })).toEqual({});
    expect(stairErrors({ ...base, emErrorPct: "100" })).toEqual({});
    expect(
      draftToStairConfig({ ...base, emErrorPct: "5.5" })?.auto_stop?.emergency?.error_rate_pct,
    ).toBe(5.5);
  });
  it("autoStopSummary", () => {
    const c = { ...aEra };
    expect(autoStopSummary({ ...c, auto_stop: { saturation: "two_fails", emergency: EM } })).toBe(
      "자동 정지: 연속 두 계단 실패 · 즉시 정지 5%/2000 ms/3초",
    );
    expect(
      autoStopSummary({ ...c, auto_stop: { saturation: "first_fail", emergency: null } }),
    ).toBe("자동 정지: 첫 실패에서 바로 정지");
    expect(autoStopSummary({ ...c, auto_stop: { saturation: null, emergency: EM } })).toBe(
      "자동 정지: 즉시 정지 5%/2000 ms/3초",
    );
    expect(autoStopSummary(c)).toBe("자동 정지: 꺼짐");
    expect(autoStopSummary({ ...c, auto_stop: { saturation: null, emergency: null } })).toBe(
      "자동 정지: 꺼짐",
    );
  });
});
