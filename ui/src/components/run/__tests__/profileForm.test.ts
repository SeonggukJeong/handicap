import { STAIR_DEFAULTS } from "../stair";
import { describe, it, expect } from "vitest";
import {
  buildCriteria,
  buildProfile,
  criteriaHasValue,
  criteriaActiveCount,
  criteriaStateFrom,
  criteriaErrors,
  hasCriteriaErrors,
  isConnectTimeoutDraftInvalid,
  EMPTY_CRITERIA,
  type CriteriaState,
  type ProfileFormInput,
} from "../profileForm";
import type { LoadModelState } from "../loadModel";
import type { Criteria, DataBinding } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";

const closedLoad: LoadModelState = {
  loadModel: "closed",
  rateMode: "fixed",
  vus: 4,
  duration: 30,
  rampUp: 0,
  rampOpen: 0,
  discard: 0,
  targetRps: "",
  maxInFlight: "",
  stages: [],
  thinkMin: "",
  thinkMax: "",
  thinkSeed: "",
  rampDown: "graceful",
  workerCount: "1",
  gracefulCap: "",
  stair: STAIR_DEFAULTS,
};

describe("buildCriteria", () => {
  it("returns undefined when all inputs empty", () => {
    expect(buildCriteria(EMPTY_CRITERIA)).toBeUndefined();
  });
  it("maps filled inputs and converts pct → fraction", () => {
    const s: CriteriaState = { ...EMPTY_CRITERIA, maxP95: "200", maxErrPct: "5", max4xxPct: "2.5" };
    expect(buildCriteria(s)).toEqual({
      max_p95_ms: 200,
      max_error_rate: 0.05,
      max_4xx_rate: 0.025,
    });
  });
});

describe("buildProfile", () => {
  it("composes load profile + criteria + loop/http/binding", () => {
    const p = buildProfile({
      hasLoop: false,
      loopCap: 256,
      httpTimeout: 30,
      bindings: [],
      loadState: closedLoad,
      criteria: EMPTY_CRITERIA,
      measurePhases: false,
    });
    expect(p).toMatchObject({
      loop_breakdown_cap: 0, // hasLoop=false → 0
      http_timeout_seconds: 30,
      data_bindings: undefined,
      criteria: undefined,
      vus: 4,
      duration_seconds: 30, // from buildLoadProfile
    });
  });
  it("uses loopCap only when hasLoop", () => {
    const p = buildProfile({
      hasLoop: true,
      loopCap: 99,
      httpTimeout: 30,
      bindings: [],
      loadState: closedLoad,
      criteria: EMPTY_CRITERIA,
      measurePhases: false,
    });
    expect(p.loop_breakdown_cap).toBe(99);
  });
});

describe("buildProfile data_bindings (multi)", () => {
  const bA: DataBinding = {
    dataset_id: "DS1",
    policy: "per_vu",
    mappings: [{ kind: "column", var: "username", column: "username" }],
  };
  const bB: DataBinding = {
    dataset_id: "DS2",
    policy: "iter_random",
    mappings: [{ kind: "column", var: "email", column: "email" }],
  };

  it("emits data_bindings array and omits the legacy data_binding key", () => {
    const p = buildProfile({
      hasLoop: false,
      loopCap: 256,
      httpTimeout: 30,
      bindings: [bA, bB],
      loadState: closedLoad,
      criteria: EMPTY_CRITERIA,
      measurePhases: false,
    });
    expect(p.data_bindings).toHaveLength(2);
    expect(p.data_bindings).toEqual([bA, bB]);
    // Legacy single-binding key must never be written by the new builder.
    expect("data_binding" in p).toBe(false);
  });

  it("omits data_bindings entirely when bindings is empty", () => {
    const p = buildProfile({
      hasLoop: false,
      loopCap: 256,
      httpTimeout: 30,
      bindings: [],
      loadState: closedLoad,
      criteria: EMPTY_CRITERIA,
      measurePhases: false,
    });
    expect(p.data_bindings).toBeUndefined();
    expect("data_binding" in p).toBe(false);
  });
});

describe("criteria helpers", () => {
  it("criteriaHasValue / criteriaActiveCount count filled inputs", () => {
    const s: CriteriaState = { ...EMPTY_CRITERIA, maxP50: "100", rpsWarmup: "3" };
    expect(criteriaHasValue(s)).toBe(true);
    // activeCount excludes rps_warmup_seconds (modifier, not a criterion) — 1
    expect(criteriaActiveCount(s)).toBe(1);
    expect(criteriaHasValue(EMPTY_CRITERIA)).toBe(false);
  });
});

describe("criteriaStateFrom", () => {
  it("maps wire Criteria (fraction) back to string draft (%)", () => {
    const s = criteriaStateFrom({ max_p95_ms: 200, max_error_rate: 0.05, max_4xx_rate: 0.025 });
    expect(s.maxP95).toBe("200");
    expect(s.maxErrPct).toBe("5");
    expect(s.max4xxPct).toBe("2.5");
    expect(s.maxP50).toBe(""); // unset → empty
  });
  it("returns all-empty for undefined", () => {
    expect(criteriaStateFrom(undefined).maxP95).toBe("");
  });
  it("maps step_criteria back to drafts with rate ×100, non-rate unchanged", () => {
    const state = criteriaStateFrom({
      step_criteria: [
        { metric: "5xx_rate", op: "max" as const, threshold: 0.02, target: "A" },
        { metric: "p95_ms", op: "max" as const, threshold: 300, target: "B" },
      ],
    });
    expect(state.stepCriteria).toEqual([
      { target: "A", metric: "5xx_rate", op: "max", threshold: "2", p: "" },
      { target: "B", metric: "p95_ms", op: "max", threshold: "300", p: "" },
    ]);
  });
});

describe("step criteria", () => {
  it("step-only criteria builds with % conversion and step_criteria key", () => {
    const s = {
      ...EMPTY_CRITERIA,
      stepCriteria: [
        { target: "A", metric: "p95_ms", op: "max" as const, threshold: "300", p: "" },
        { target: "B", metric: "5xx_rate", op: "max" as const, threshold: "2", p: "" }, // 2% → 0.02
      ],
    };
    const c = buildCriteria(s);
    expect(c).toBeDefined();
    expect(c!.step_criteria).toEqual([
      { target: "A", metric: "p95_ms", op: "max", threshold: 300 },
      { target: "B", metric: "5xx_rate", op: "max", threshold: 0.02 },
    ]);
    expect(criteriaHasValue(s)).toBe(true);
    expect(criteriaActiveCount(s)).toBe(2);
  });

  it("empty rows are dropped from build", () => {
    const s = {
      ...EMPTY_CRITERIA,
      stepCriteria: [{ target: "", metric: "p95_ms", op: "max" as const, threshold: "", p: "" }],
    };
    expect(buildCriteria(s)).toBeUndefined();
  });
});

describe("buildProfile measure_phases", () => {
  it("buildProfile emits measure_phases from input", () => {
    const base = {
      hasLoop: false,
      loopCap: 256,
      httpTimeout: 30,
      bindings: [],
      loadState: closedLoad,
      criteria: EMPTY_CRITERIA,
    };
    expect(buildProfile({ ...base, measurePhases: true }).measure_phases).toBe(true);
    expect(buildProfile({ ...base, measurePhases: false }).measure_phases).toBe(false);
  });
});

const openFixedLoad: LoadModelState = {
  loadModel: "open",
  rateMode: "fixed",
  vus: 0,
  duration: 30,
  rampUp: 0,
  rampOpen: 0,
  discard: 0,
  targetRps: "100",
  maxInFlight: "50",
  stages: [],
  thinkMin: "",
  thinkMax: "",
  thinkSeed: "",
  rampDown: "graceful",
  workerCount: "1",
  gracefulCap: "",
  stair: STAIR_DEFAULTS,
};

function base(loadState: LoadModelState, extra: Partial<ProfileFormInput> = {}) {
  return buildProfile({
    hasLoop: false,
    loopCap: 256,
    httpTimeout: 30,
    bindings: [],
    loadState,
    criteria: EMPTY_CRITERIA,
    measurePhases: false,
    ...extra,
  });
}

describe("buildProfile apply_scenario_think_time", () => {
  it("includes false when open-loop + scenarioHasThink + toggle off", () => {
    const p = base(openFixedLoad, { scenarioHasThink: true, applyScenarioThink: false });
    expect(p.apply_scenario_think_time).toBe(false);
  });
  it("includes true when open-loop + scenarioHasThink + toggle on", () => {
    const p = base(openFixedLoad, { scenarioHasThink: true, applyScenarioThink: true });
    expect(p.apply_scenario_think_time).toBe(true);
  });
  it("omits when open-loop but scenario has NO think (byte-identical)", () => {
    const p = base(openFixedLoad, { scenarioHasThink: false, applyScenarioThink: false });
    expect(p).not.toHaveProperty("apply_scenario_think_time");
  });
  it("omits for closed-loop (byte-identical)", () => {
    const p = base(closedLoad, { scenarioHasThink: true, applyScenarioThink: true });
    expect(p).not.toHaveProperty("apply_scenario_think_time");
  });
});

describe("buildProfile connectTimeout (E3)", () => {
  it("connectTimeout 미전달이면 connect_timeout_seconds 키를 생략한다", () => {
    const p = base(closedLoad);
    expect(p).not.toHaveProperty("connect_timeout_seconds");
  });

  it("connectTimeout 빈 문자열이면 키를 생략한다", () => {
    const p = base(closedLoad, { connectTimeout: "  " });
    expect(p).not.toHaveProperty("connect_timeout_seconds");
  });

  it("connectTimeout 값이 있으면 숫자로 싣는다", () => {
    const p = base(closedLoad, { connectTimeout: "3" });
    expect(p.connect_timeout_seconds).toBe(3);
  });
});

describe("isConnectTimeoutDraftInvalid (timeout-knob-ui — RunDialog·ScheduleForm 공유 술어)", () => {
  it("빈/공백 draft는 유효(미설정)", () => {
    expect(isConnectTimeoutDraftInvalid("", 30)).toBe(false);
    expect(isConnectTimeoutDraftInvalid("  ", 30)).toBe(false);
  });
  it("1..=600 정수이면서 http보다 작으면 유효", () => {
    expect(isConnectTimeoutDraftInvalid("5", 30)).toBe(false);
    expect(isConnectTimeoutDraftInvalid("1", 2)).toBe(false);
    expect(isConnectTimeoutDraftInvalid("600", 601)).toBe(false);
  });
  it("http 이상·범위 밖·비정수는 invalid", () => {
    expect(isConnectTimeoutDraftInvalid("30", 30)).toBe(true); // == http도 invalid (< 강제)
    expect(isConnectTimeoutDraftInvalid("0", 30)).toBe(true);
    expect(isConnectTimeoutDraftInvalid("601", 700)).toBe(true);
    expect(isConnectTimeoutDraftInvalid("1.5", 30)).toBe(true);
  });
});

describe("새 판정 항목", () => {
  const full: Criteria = {
    max_mean_ms: 3000,
    max_max_ms: 10000.5,
    max_percentiles_ms: [
      { percentile: 90, max_ms: 2500 },
      { percentile: 99.9, max_ms: 8000 },
    ],
    step_criteria: [
      { target: "A", metric: "mean_ms", op: "max", threshold: 500 },
      { target: "A", metric: "p99.9_ms", op: "max", threshold: 900 },
      { target: "A", metric: "p95_ms", op: "max", threshold: 700 },
    ],
  };
  const row = (p: string, ms: string) => ({ p, ms });

  it("buildCriteria: 평균·최대·백분위 행", () => {
    const c = buildCriteria({
      ...EMPTY_CRITERIA,
      maxMean: "3000",
      maxMax: "10000.5",
      percentiles: [row("90", "2500"), row("99.9", "8000"), row("90", "")],
    });
    expect(c).toEqual({
      max_mean_ms: 3000,
      max_max_ms: 10000.5,
      max_percentiles_ms: [
        { percentile: 90, max_ms: 2500 },
        { percentile: 99.9, max_ms: 8000 },
      ],
    });
  });
  it("buildCriteria: ms 빈 행뿐이면 키 없음", () => {
    const c = buildCriteria({ ...EMPTY_CRITERIA, maxMean: "1", percentiles: [row("90", "")] });
    expect("max_percentiles_ms" in c!).toBe(false);
  });
  it("buildCriteria: 스텝 mean/max/백분위 행", () => {
    const mk = (metric: string, p: string) => ({
      target: "A",
      metric,
      op: "max" as const,
      threshold: "5",
      p,
    });
    const c = buildCriteria({
      ...EMPTY_CRITERIA,
      stepCriteria: [
        mk("mean_ms", ""),
        mk("max_ms", ""),
        mk("percentile", "90"),
        mk("percentile", "95"),
        mk("percentile", "99.90"),
      ],
    });
    expect(c!.step_criteria!.map((r) => r.metric)).toEqual([
      "mean_ms",
      "max_ms",
      "p90_ms",
      "p95_ms",
      "p99.9_ms",
    ]);
  });
  it("criteriaStateFrom: 새 칸·스텝 표지", () => {
    const st = criteriaStateFrom(full);
    expect(st.maxMean).toBe("3000");
    expect(st.maxMax).toBe("10000.5");
    expect(st.percentiles).toEqual([row("90", "2500"), row("99.9", "8000")]);
    expect(st.stepCriteria.map((r) => [r.metric, r.p])).toEqual([
      ["mean_ms", ""],
      ["percentile", "99.9"],
      ["p95_ms", ""],
    ]);
    expect(
      criteriaStateFrom({
        step_criteria: [{ target: "A", metric: "p90_ms", op: "max", threshold: 1 }],
      }).stepCriteria[0],
    ).toMatchObject({ metric: "percentile", p: "90" });
  });
  it("왕복", () => {
    expect(buildCriteria(criteriaStateFrom(full))).toEqual(full);
  });
  it("criteriaHasValue·criteriaActiveCount", () => {
    expect(criteriaHasValue({ ...EMPTY_CRITERIA, maxMean: "1" })).toBe(true);
    expect(criteriaHasValue({ ...EMPTY_CRITERIA, percentiles: [row("90", "")] })).toBe(false);
    expect(criteriaHasValue({ ...EMPTY_CRITERIA, percentiles: [row("90", "1")] })).toBe(true);
    expect(
      criteriaActiveCount({
        ...EMPTY_CRITERIA,
        maxMean: "1",
        maxMax: "2",
        percentiles: [row("90", "1"), row("99", "2"), row("80", "")],
      }),
    ).toBe(4);
  });

  describe("criteriaErrors", () => {
    const err = (patch: Partial<CriteriaState>) => criteriaErrors({ ...EMPTY_CRITERIA, ...patch });
    it("시간 값", () => {
      for (const v of ["60000.001", "-1", "1.0005", "abc"]) {
        expect(err({ maxMean: v }).maxMean).toBe(ko.criteria.errTime);
      }
      for (const v of ["", "60000", "1.005"]) expect(err({ maxMean: v }).maxMean).toBeUndefined();
      expect(err({ maxMax: "70000" }).maxMax).toBe(ko.criteria.errTime);
    });
    it("백분위 행", () => {
      expect(err({ percentiles: [row("50", "1")] }).percentiles[0].p).toBe(
        ko.criteria.errPercentileFixed("50"),
      );
      expect(ko.criteria.errPercentileFixed("50")).toContain("p50은");
      expect(ko.criteria.errPercentileFixed("95")).toContain("p95는");
      expect(err({ percentiles: [row("95", "1")] }).percentiles[0].p).toBe(
        ko.criteria.errPercentileFixed("95"),
      );
      for (const p of ["100", "90.0001"]) {
        expect(err({ percentiles: [row(p, "1")] }).percentiles[0].p).toBe(
          ko.criteria.errPercentileRange,
        );
      }
      expect(err({ percentiles: [row("", "1")] }).percentiles[0].p).toBe(
        ko.criteria.errPercentileMissing,
      );
      const dup = err({ percentiles: [row("90", "1"), row("90.0", "2")] }).percentiles;
      expect(dup[0].p).toBeUndefined();
      expect(dup[1].p).toBe(ko.criteria.errPercentileDuplicate("90"));
      expect(hasCriteriaErrors(err({ percentiles: [row("90", ""), row("90", "5")] }))).toBe(false);
      expect(err({ percentiles: [row("90", "70000")] }).percentiles[0].ms).toBe(
        ko.criteria.errTime,
      );
      expect(hasCriteriaErrors(err({ percentiles: [row("150", "")] }))).toBe(false);
    });
    it("10개 초과", () => {
      const rows = Array.from({ length: 11 }, (_, i) => row(String(i + 1), "1"));
      expect(err({ percentiles: rows }).percentilesList).toBe(ko.criteria.errPercentilesMax);
    });
    it("스텝 행", () => {
      const st = (metric: string, p: string, threshold: string) => ({
        target: "A",
        metric,
        op: "max" as const,
        threshold,
        p,
      });
      const e = (r: ReturnType<typeof st>) => err({ stepCriteria: [r] }).steps[0];
      expect(e(st("percentile", "", "5")).p).toBe(ko.criteria.errPercentileMissing);
      expect(e(st("percentile", "100", "5")).p).toBe(ko.criteria.errPercentileRange);
      expect(e(st("percentile", "95", "70000")).threshold).toBeUndefined();
      expect(e(st("percentile", "95.0", "70000")).threshold).toBeUndefined();
      expect(e(st("percentile", "90", "70000")).threshold).toBe(ko.criteria.errTime);
      expect(e(st("mean_ms", "", "0.0005")).threshold).toBe(ko.criteria.errTime);
      expect(e(st("p95_ms", "", "70000")).threshold).toBeUndefined();
      expect(e(st("max_ms", "", "")).threshold).toBeUndefined();
    });
    it("hasCriteriaErrors", () => {
      expect(hasCriteriaErrors(criteriaErrors(EMPTY_CRITERIA))).toBe(false);
      expect(hasCriteriaErrors(err({ maxMax: "-1" }))).toBe(true);
    });
  });
});
