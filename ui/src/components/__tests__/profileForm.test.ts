import { describe, it, expect } from "vitest";
import {
  buildCriteria,
  buildProfile,
  criteriaHasValue,
  criteriaActiveCount,
  criteriaStateFrom,
  EMPTY_CRITERIA,
  type CriteriaState,
} from "../profileForm";
import type { LoadModelState } from "../loadModel";

const closedLoad: LoadModelState = {
  loadModel: "closed",
  rateMode: "fixed",
  vus: 4,
  duration: 30,
  rampUp: 0,
  targetRps: "",
  maxInFlight: "",
  stages: [],
  thinkMin: "",
  thinkMax: "",
  thinkSeed: "",
  rampDown: "graceful",
  workerCount: "1",
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
      binding: null,
      loadState: closedLoad,
      criteria: EMPTY_CRITERIA,
      measurePhases: false,
    });
    expect(p).toMatchObject({
      loop_breakdown_cap: 0, // hasLoop=false → 0
      http_timeout_seconds: 30,
      data_binding: undefined,
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
      binding: null,
      loadState: closedLoad,
      criteria: EMPTY_CRITERIA,
      measurePhases: false,
    });
    expect(p.loop_breakdown_cap).toBe(99);
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
      { target: "A", metric: "5xx_rate", op: "max", threshold: "2" },
      { target: "B", metric: "p95_ms", op: "max", threshold: "300" },
    ]);
  });
});

describe("step criteria", () => {
  it("step-only criteria builds with % conversion and step_criteria key", () => {
    const s = {
      ...EMPTY_CRITERIA,
      stepCriteria: [
        { target: "A", metric: "p95_ms", op: "max" as const, threshold: "300" },
        { target: "B", metric: "5xx_rate", op: "max" as const, threshold: "2" }, // 2% → 0.02
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
      stepCriteria: [{ target: "", metric: "p95_ms", op: "max" as const, threshold: "" }],
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
      binding: null,
      loadState: closedLoad,
      criteria: EMPTY_CRITERIA,
    };
    expect(buildProfile({ ...base, measurePhases: true }).measure_phases).toBe(true);
    expect(buildProfile({ ...base, measurePhases: false }).measure_phases).toBe(false);
  });
});
