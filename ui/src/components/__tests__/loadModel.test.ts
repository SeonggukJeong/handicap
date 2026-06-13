import { describe, expect, it } from "vitest";
import {
  buildLoadProfile,
  deriveLoadMode,
  loadModelErrors,
  type LoadModelState,
} from "../loadModel";

// 유효한 기준 state — 각 테스트가 모드만 바꿔 쓴다.
function base(): LoadModelState {
  return {
    loadModel: "closed",
    rateMode: "fixed",
    vus: 5,
    duration: 30,
    rampUp: 0,
    targetRps: "100",
    maxInFlight: "200",
    stages: [{ target: "100", duration_seconds: "30" }],
    thinkMin: "",
    thinkMax: "",
    thinkSeed: "",
    rampDown: "graceful",
  };
}

describe("buildLoadProfile — 필드-형태 불변식 (§7.1)", () => {
  it("closed: target_rps/stages/max_in_flight 부재", () => {
    const p = buildLoadProfile({ ...base(), loadModel: "closed" });
    expect(p.target_rps).toBeUndefined();
    expect(p.stages).toBeUndefined();
    expect(p.max_in_flight).toBeUndefined();
    expect(p.vus).toBe(5);
    expect(p.duration_seconds).toBe(30);
    expect(p).not.toHaveProperty("vu_stages");
    expect(p).not.toHaveProperty("ramp_down");
  });

  it("closed: think_time은 허용(open만 금지) — 둘 다 채우면 emit", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "closed",
      thinkMin: "100",
      thinkMax: "200",
    });
    expect(p.think_time).toEqual({ min_ms: 100, max_ms: 200 });
  });

  it("open+fixed: stages/think_time 부재, ramp_up===0, target_rps·max_in_flight 존재", () => {
    const p = buildLoadProfile({ ...base(), loadModel: "open", rateMode: "fixed" });
    expect(p.stages).toBeUndefined();
    expect(p.think_time).toBeUndefined();
    expect(p.ramp_up_seconds).toBe(0);
    expect(p.target_rps).toBe(100);
    expect(p.max_in_flight).toBe(200);
    expect(p.vus).toBe(0);
    expect(p).not.toHaveProperty("vu_stages");
    expect(p).not.toHaveProperty("ramp_down");
  });

  it("open+curve: target_rps/think_time 부재, ramp_up===0, duration===0, stages·max_in_flight 존재", () => {
    const p = buildLoadProfile({ ...base(), loadModel: "open", rateMode: "curve" });
    expect(p.target_rps).toBeUndefined();
    expect(p.think_time).toBeUndefined();
    expect(p.ramp_up_seconds).toBe(0);
    expect(p.duration_seconds).toBe(0);
    expect(p.max_in_flight).toBe(200);
    expect(p.stages).toEqual([{ target: 100, duration_seconds: 30 }]);
    expect(p.vus).toBe(0);
    expect(p).not.toHaveProperty("vu_stages");
    expect(p).not.toHaveProperty("ramp_down");
  });

  it("closed+curve: vu_stages·think_time 존재, vus===0, duration===0, ramp_up===0, target_rps/max_in_flight/stages 부재", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "closed",
      rateMode: "curve",
      stages: [{ target: "50", duration_seconds: "60" }],
      thinkMin: "100",
      thinkMax: "300",
      rampDown: "graceful",
    });
    expect(p.vus).toBe(0);
    expect(p.duration_seconds).toBe(0);
    expect(p.ramp_up_seconds).toBe(0);
    expect(p.vu_stages).toEqual([{ target: 50, duration_seconds: 60 }]);
    expect(p.think_time).toEqual({ min_ms: 100, max_ms: 300 });
    expect(p).not.toHaveProperty("target_rps");
    expect(p).not.toHaveProperty("max_in_flight");
    expect(p).not.toHaveProperty("stages");
    expect(p).not.toHaveProperty("ramp_down"); // graceful = absent (byte-minimal)
  });

  it("closed+curve: rampDown=immediate일 때만 ramp_down emit", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "closed",
      rateMode: "curve",
      stages: [{ target: "50", duration_seconds: "60" }],
      rampDown: "immediate",
    });
    expect(p.ramp_down).toBe("immediate");
  });
});

describe("loadModelErrors — 모드별 범위 검증", () => {
  it("closed: rampUp > duration이면 rampInvalid", () => {
    expect(loadModelErrors({ ...base(), rampUp: 31, duration: 30 }).rampInvalid).toBe(true);
    expect(loadModelErrors({ ...base(), rampUp: 0, duration: 30 }).rampInvalid).toBe(false);
  });

  it("open+fixed: 빈/범위초과 target_rps는 targetRpsInvalid", () => {
    expect(
      loadModelErrors({ ...base(), loadModel: "open", rateMode: "fixed", targetRps: "" })
        .targetRpsInvalid,
    ).toBe(true);
    expect(
      loadModelErrors({ ...base(), loadModel: "open", rateMode: "fixed", targetRps: "100" })
        .targetRpsInvalid,
    ).toBe(false);
  });

  it("open: max_in_flight 범위초과는 maxInFlightInvalid", () => {
    expect(
      loadModelErrors({ ...base(), loadModel: "open", maxInFlight: "0" }).maxInFlightInvalid,
    ).toBe(true);
    expect(
      loadModelErrors({ ...base(), loadModel: "open", maxInFlight: "10001" }).maxInFlightInvalid,
    ).toBe(true);
  });

  it("open+curve: 모든 target=0이면 stagesInvalid", () => {
    expect(
      loadModelErrors({
        ...base(),
        loadModel: "open",
        rateMode: "curve",
        stages: [{ target: "0", duration_seconds: "30" }],
      }).stagesInvalid,
    ).toBe(true);
  });

  it("closed+fixed에선 stagesInvalid false (curve 공통 일반화 반영)", () => {
    expect(
      loadModelErrors({ ...base(), loadModel: "closed", rateMode: "fixed" }).stagesInvalid,
    ).toBe(false);
  });

  it("closed+curve에서도 stagesInvalid가 작동 (curve 공통 일반화)", () => {
    const e = loadModelErrors({
      ...base(),
      loadModel: "closed",
      rateMode: "curve",
      stages: [{ target: "0", duration_seconds: "30" }],
    });
    expect(e.stagesInvalid).toBe(true);
  });
});

describe("deriveLoadMode", () => {
  it("vu_stages → closed+curve / stages → open+curve / target_rps → open+fixed / 그 외 closed+fixed", () => {
    expect(deriveLoadMode({ vu_stages: [{ target: 5, duration_seconds: 10 }] })).toEqual({
      loadModel: "closed",
      rateMode: "curve",
    });
    expect(deriveLoadMode({ stages: [{ target: 5, duration_seconds: 10 }] })).toEqual({
      loadModel: "open",
      rateMode: "curve",
    });
    expect(deriveLoadMode({ target_rps: 100 })).toEqual({ loadModel: "open", rateMode: "fixed" });
    expect(deriveLoadMode({})).toEqual({ loadModel: "closed", rateMode: "fixed" });
    expect(deriveLoadMode({ vu_stages: [] })).toEqual({ loadModel: "closed", rateMode: "fixed" });
  });
});
