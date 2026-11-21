import { STAIR_DEFAULTS } from "../stair";
import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../../../api/schemas";
import {
  buildLoadProfile,
  deriveLoadMode,
  fixedTarget,
  loadModelErrors,
  profileVuDisplay,
  steadyFormSeed,
  steadyPlan,
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
    rampOpen: 0,
    discard: 0,
    targetRps: "100",
    maxInFlight: "200",
    stages: [{ target: "100", duration_seconds: "30" }],
    thinkMin: "",
    thinkMax: "",
    thinkSeed: "",
    rampDown: "graceful",
    workerCount: "1",
    gracefulCap: "",
    stair: STAIR_DEFAULTS,
  };
}

// closed+curve/closed+fixed/open+fixed/open+curve 기준 state 헬퍼 —
// graceful cap 불변식 테스트가 4모드를 순회할 때 재사용.
function baseClosedCurveState(): LoadModelState {
  return { ...base(), loadModel: "closed", rateMode: "curve" };
}
function baseClosedFixedState(): LoadModelState {
  return { ...base(), loadModel: "closed", rateMode: "fixed" };
}
function baseOpenFixedState(): LoadModelState {
  return { ...base(), loadModel: "open", rateMode: "fixed" };
}
function baseOpenCurveState(): LoadModelState {
  return { ...base(), loadModel: "open", rateMode: "curve" };
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

  // graceful ramp-down 상한 (§B9) — closed+curve+graceful+비어있지-않은 cap일 때만 emit.
  it("closed+curve+graceful+cap emits graceful_ramp_down_seconds", () => {
    const s = { ...baseClosedCurveState(), rampDown: "graceful" as const, gracefulCap: "12" };
    expect(buildLoadProfile(s).graceful_ramp_down_seconds).toBe(12);
  });
  it("empty cap omits the field", () => {
    const s = { ...baseClosedCurveState(), rampDown: "graceful" as const, gracefulCap: "" };
    expect(buildLoadProfile(s)).not.toHaveProperty("graceful_ramp_down_seconds");
  });
  it("immediate omits cap even if set", () => {
    const s = { ...baseClosedCurveState(), rampDown: "immediate" as const, gracefulCap: "12" };
    expect(buildLoadProfile(s)).not.toHaveProperty("graceful_ramp_down_seconds");
  });
  it("non-curve modes never emit cap", () => {
    for (const s of [baseClosedFixedState(), baseOpenFixedState(), baseOpenCurveState()]) {
      expect(buildLoadProfile({ ...s, gracefulCap: "12" })).not.toHaveProperty(
        "graceful_ramp_down_seconds",
      );
    }
  });

  // worker_count — open 모드(고정·곡선)에서만, >1일 때만 emit (N=1/미설정 byte-identical).
  it("open+fixed: workerCount=2면 worker_count: 2 emit", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "open",
      rateMode: "fixed",
      workerCount: "2",
    });
    expect(p.worker_count).toBe(2);
  });

  it("open+curve: workerCount=3이면 worker_count: 3 emit", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "open",
      rateMode: "curve",
      workerCount: "3",
    });
    expect(p.worker_count).toBe(3);
  });

  it("open+fixed: workerCount=1이면 worker_count 부재 (byte-identical)", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "open",
      rateMode: "fixed",
      workerCount: "1",
    });
    expect(p).not.toHaveProperty("worker_count");
  });

  it("open+fixed: workerCount=빈칸이면 worker_count 부재", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "open",
      rateMode: "fixed",
      workerCount: "",
    });
    expect(p).not.toHaveProperty("worker_count");
  });

  it("closed+fixed: workerCount=2여도 worker_count 부재 (byte-identical)", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "closed",
      rateMode: "fixed",
      workerCount: "2",
    });
    expect(p).not.toHaveProperty("worker_count");
  });

  it("closed+curve: workerCount=2여도 worker_count 부재 (byte-identical)", () => {
    const p = buildLoadProfile({
      ...base(),
      loadModel: "closed",
      rateMode: "curve",
      stages: [{ target: "50", duration_seconds: "60" }],
      workerCount: "2",
    });
    expect(p).not.toHaveProperty("worker_count");
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

  it("workerCount: 0/65/비정수는 workerCountInvalid, 1/2/빈칸은 valid", () => {
    expect(loadModelErrors({ ...base(), workerCount: "0" }).workerCountInvalid).toBe(true);
    expect(loadModelErrors({ ...base(), workerCount: "65" }).workerCountInvalid).toBe(true);
    expect(loadModelErrors({ ...base(), workerCount: "abc" }).workerCountInvalid).toBe(true);
    expect(loadModelErrors({ ...base(), workerCount: "1" }).workerCountInvalid).toBe(false);
    expect(loadModelErrors({ ...base(), workerCount: "2" }).workerCountInvalid).toBe(false);
    expect(loadModelErrors({ ...base(), workerCount: "" }).workerCountInvalid).toBe(false);
  });

  it("gracefulCapInvalid on <1 or non-numeric", () => {
    expect(
      loadModelErrors({ ...baseClosedCurveState(), rampDown: "graceful", gracefulCap: "0" })
        .gracefulCapInvalid,
    ).toBe(true);
    expect(
      loadModelErrors({ ...baseClosedCurveState(), rampDown: "graceful", gracefulCap: "abc" })
        .gracefulCapInvalid,
    ).toBe(true);
    expect(
      loadModelErrors({ ...baseClosedCurveState(), rampDown: "graceful", gracefulCap: "5" })
        .gracefulCapInvalid,
    ).toBe(false);
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

describe("profileVuDisplay (§4.1)", () => {
  it("closed+fixed → {kind:'fixed', vus}", () => {
    expect(profileVuDisplay({ vus: 50 })).toEqual({ kind: "fixed", vus: 50 });
  });

  it("closed+curve(vu_stages) → {kind:'curve', peak = max target}", () => {
    expect(
      profileVuDisplay({
        vus: 0,
        vu_stages: [
          { target: 5, duration_seconds: 10 },
          { target: 50, duration_seconds: 20 },
          { target: 2, duration_seconds: 5 },
        ],
      }),
    ).toEqual({ kind: "curve", peak: 50 });
  });

  it("open+fixed(target_rps) → {kind:'open'}", () => {
    expect(profileVuDisplay({ vus: 0, target_rps: 100 })).toEqual({ kind: "open" });
  });

  it("open+curve(stages) → {kind:'open'}", () => {
    expect(profileVuDisplay({ vus: 0, stages: [{ target: 100, duration_seconds: 30 }] })).toEqual({
      kind: "open",
    });
  });
});

describe("stair (계단)", () => {
  const stairState = (): LoadModelState => ({
    ...base(),
    loadModel: "open",
    rateMode: "stair",
    maxInFlight: "300",
    workerCount: "2",
    stair: { ...STAIR_DEFAULTS, targets: "100, 200" },
  });
  it("buildLoadProfile stair: stair + max_in_flight + worker_count + vus 0 + duration 0, stages 키 없음", () => {
    const p = buildLoadProfile(stairState());
    expect(p).toEqual({
      stair: {
        targets: [100, 200],
        hold_seconds: 60,
        ramp_seconds: 5,
        discard_seconds: 15,
        auto_stop: {
          saturation: "two_fails",
          emergency: { error_rate_pct: 5, p99_ms: 2000, consecutive_seconds: 3, min_requests: 20 },
        },
      },
      max_in_flight: 300,
      worker_count: 2,
      vus: 0,
      duration_seconds: 0,
      ramp_up_seconds: 0,
    });
    expect(p).not.toHaveProperty("stages");
    expect(p).not.toHaveProperty("target_rps");
  });
  it("p99Cap이 있으면 p99_cap_ms로 실린다", () => {
    const s = stairState();
    s.stair = { ...s.stair, p99Cap: "500" };
    expect(buildLoadProfile(s).stair?.p99_cap_ms).toBe(500);
  });
  it("loadModelErrors stairInvalid", () => {
    expect(loadModelErrors(stairState()).stairInvalid).toBe(false);
    const s = stairState();
    s.stair = { ...s.stair, targets: "100" };
    expect(loadModelErrors(s).stairInvalid).toBe(true);
    expect(
      loadModelErrors({ ...stairState(), rateMode: "fixed", stair: s.stair }).stairInvalid,
    ).toBe(false);
  });
  it("deriveLoadMode: stair가 stages보다 우선(저장본에 공존)", () => {
    expect(
      deriveLoadMode({
        stair: {
          targets: [100, 200],
          hold_seconds: 60,
          ramp_seconds: 5,
          discard_seconds: 15,
          auto_stop: {
            saturation: "two_fails",
            emergency: {
              error_rate_pct: 5,
              p99_ms: 2000,
              consecutive_seconds: 3,
              min_requests: 20,
            },
          },
        },
        stages: [{ target: 100, duration_seconds: 5 }],
      }),
    ).toEqual({ loadModel: "open", rateMode: "stair" });
  });
});

describe("steady (상승·버림)", () => {
  const openState = (over: Partial<LoadModelState> = {}): LoadModelState => ({
    ...base(),
    loadModel: "open",
    rateMode: "fixed",
    duration: 60,
    targetRps: "40",
    maxInFlight: "200",
    ...over,
  });
  const closedState = (over: Partial<LoadModelState> = {}): LoadModelState => ({
    ...base(),
    loadModel: "closed",
    rateMode: "fixed",
    duration: 60,
    ...over,
  });

  it.each([
    ["open", openState()],
    ["closed", closedState()],
  ])("steadyPlan: 상승 0·버림 0 → none (%s)", (_n, s) => {
    expect(steadyPlan(s)).toEqual({ kind: "none" });
    expect(buildLoadProfile(s)).not.toHaveProperty("steady");
  });

  it("steadyPlan: 상승 0·버림 0의 프로필은 이전 모양 그대로", () => {
    expect(buildLoadProfile(openState())).toEqual({
      vus: 0,
      duration_seconds: 60,
      ramp_up_seconds: 0,
      target_rps: 40,
      max_in_flight: 200,
    });
    expect(buildLoadProfile(closedState())).toEqual({
      vus: 5,
      duration_seconds: 60,
      ramp_up_seconds: 0,
    });
  });

  it("steadyPlan: open 고정 상승 20·버림 5·실행 60·목표 40", () => {
    const s = openState({ rampOpen: 20, discard: 5 });
    const steady = { ramp_seconds: 20, hold_seconds: 40, discard_seconds: 5, target: 40 };
    expect(steadyPlan(s)).toEqual({ kind: "send", steady });
    const p = buildLoadProfile(s);
    expect(p).toEqual({
      vus: 0,
      duration_seconds: 0,
      ramp_up_seconds: 0,
      max_in_flight: 200,
      steady,
    });
    expect(p).not.toHaveProperty("target_rps");
    expect(p).not.toHaveProperty("stages");
  });

  it("steadyPlan: open 고정 버림만(상승 0·버림 5·실행 60)", () => {
    const s = openState({ discard: 5 });
    const plan = steadyPlan(s);
    expect(plan).toEqual({
      kind: "send",
      steady: { ramp_seconds: 0, hold_seconds: 60, discard_seconds: 5 },
    });
    if (plan.kind === "send") expect(plan.steady).not.toHaveProperty("target");
    expect(buildLoadProfile(s)).toEqual({
      vus: 0,
      duration_seconds: 60,
      ramp_up_seconds: 0,
      target_rps: 40,
      max_in_flight: 200,
      steady: { ramp_seconds: 0, hold_seconds: 60, discard_seconds: 5 },
    });
  });

  it("steadyPlan: closed 상승 10·버림 5·실행 60", () => {
    const s = closedState({ rampUp: 10, discard: 5 });
    expect(buildLoadProfile(s)).toEqual({
      vus: 5,
      duration_seconds: 60,
      ramp_up_seconds: 10,
      steady: { ramp_seconds: 10, hold_seconds: 50, discard_seconds: 5 },
    });
  });

  it.each([
    ["ramp_ge_duration", 60, 60],
    ["hold_too_short", 57, 60],
    ["ramp_too_long", 3601, 4000],
    ["hold_too_long", 60, 90000],
  ])("steadyPlan: closed 상승만인데 성립 안 함 → fallback %s", (reason, rampUp, duration) => {
    const s = closedState({ rampUp, duration });
    expect(steadyPlan(s)).toEqual({ kind: "fallback", reason });
    expect(buildLoadProfile(s)).toEqual({
      vus: 5,
      duration_seconds: duration,
      ramp_up_seconds: rampUp,
    });
    expect(buildLoadProfile(s)).not.toHaveProperty("steady");
    expect(loadModelErrors(s).steadyInvalid).toBe(false);
  });

  it("steadyPlan: 두 상승 칸은 섞이지 않는다", () => {
    const a = openState({ rampUp: 10, rampOpen: 0, discard: 0 });
    expect(steadyPlan(a)).toEqual({ kind: "none" });
    const pa = buildLoadProfile(a);
    expect(pa).not.toHaveProperty("steady");
    expect(pa).not.toHaveProperty("stages");
    const b = closedState({ rampUp: 0, rampOpen: 20, discard: 0 });
    expect(steadyPlan(b)).toEqual({ kind: "none" });
    expect(buildLoadProfile(b).ramp_up_seconds).toBe(0);
  });

  it("steadyPlan: 버림 > 0인데 성립 안 함 (closed) → error", () => {
    const s = closedState({ rampUp: 0, discard: 58 });
    expect(steadyPlan(s)).toEqual({ kind: "error", reason: "hold_too_short" });
    expect(loadModelErrors(s).steadyInvalid).toBe(true);
  });

  it("steadyPlan: open 상승이 성립 안 함 → error", () => {
    const s = openState({ rampOpen: 60 });
    expect(steadyPlan(s)).toEqual({ kind: "error", reason: "ramp_ge_duration" });
    expect(loadModelErrors(s).steadyInvalid).toBe(true);
  });

  it("steadyPlan: 곡선·계단 모드는 none", () => {
    for (const rateMode of ["curve", "stair"] as const) {
      expect(steadyPlan(openState({ rateMode, rampOpen: 20, discard: 5 }))).toEqual({
        kind: "none",
      });
      expect(steadyPlan(closedState({ rateMode, rampUp: 10, discard: 5 }))).toEqual({
        kind: "none",
      });
    }
  });

  const openRamp = {
    stages: [
      { target: 20, duration_seconds: 20 },
      { target: 40, duration_seconds: 40 },
    ],
    steady: { ramp_seconds: 20, hold_seconds: 40, discard_seconds: 5, target: 40 },
  };
  it.each([
    ["open-ramp", { target_rps: null, ...openRamp }, "open"],
    [
      "open 버림만",
      { target_rps: 40, steady: { ramp_seconds: 0, hold_seconds: 60, discard_seconds: 5 } },
      "open",
    ],
    ["closed", { steady: { ramp_seconds: 10, hold_seconds: 50, discard_seconds: 5 } }, "closed"],
  ])("deriveLoadMode: steady 저장본 %s", (_n, p, loadModel) => {
    expect(deriveLoadMode(p)).toEqual({ loadModel, rateMode: "fixed" });
  });

  it("fixedTarget", () => {
    expect(fixedTarget({ target_rps: 80 })).toBe(80);
    expect(fixedTarget({ steady: openRamp.steady })).toBe(40);
    expect(fixedTarget({})).toBeNull();
    expect(fixedTarget({ target_rps: null })).toBeNull();
  });

  it("steadyFormSeed", () => {
    expect(steadyFormSeed({ duration_seconds: 0, ...openRamp })).toEqual({
      rampUp: 0,
      rampOpen: 20,
      duration: 60,
      discard: 5,
    });
    expect(
      steadyFormSeed({
        duration_seconds: 60,
        steady: { ramp_seconds: 10, hold_seconds: 50, discard_seconds: 5 },
      }),
    ).toEqual({ rampUp: 10, rampOpen: 0, duration: 60, discard: 5 });
    expect(steadyFormSeed({ duration_seconds: 30, ramp_up_seconds: 7 })).toEqual({
      rampUp: 7,
      rampOpen: 0,
      duration: 30,
      discard: 0,
    });
    expect(steadyFormSeed({ duration_seconds: 30 })).toEqual({
      rampUp: 0,
      rampOpen: 0,
      duration: 30,
      discard: 0,
    });
  });

  // 서버가 정규화한 저장본을 ProfileSchema로 읽어 폼 칸으로 되돌린 뒤 다시 만들면 처음 보낸 모양이다.
  const roundtrip = (sent: ReturnType<typeof buildLoadProfile>, stored: object) => {
    const p = ProfileSchema.parse({ vus: 0, duration_seconds: 0, ...stored });
    expect(p.steady).toBeDefined();
    const t = fixedTarget(p);
    const s: LoadModelState = {
      ...base(),
      ...deriveLoadMode(p),
      ...steadyFormSeed(p),
      vus: p.vus,
      targetRps: t != null ? String(t) : "",
      maxInFlight: p.max_in_flight != null ? String(p.max_in_flight) : "",
    };
    expect(buildLoadProfile(s)).toEqual(sent);
  };
  it("prefill_roundtrip_keeps_steady: open 상승", () => {
    roundtrip(buildLoadProfile(openState({ rampOpen: 20, discard: 5 })), {
      vus: 0,
      duration_seconds: 0,
      ramp_up_seconds: 0,
      max_in_flight: 200,
      stages: openRamp.stages,
      steady: openRamp.steady,
    });
  });
  it("prefill_roundtrip_keeps_steady: open 버림만", () => {
    roundtrip(buildLoadProfile(openState({ discard: 5 })), {
      vus: 0,
      duration_seconds: 60,
      ramp_up_seconds: 0,
      target_rps: 40,
      max_in_flight: 200,
      steady: { ramp_seconds: 0, hold_seconds: 60, discard_seconds: 5 },
    });
  });
  it("prefill_roundtrip_keeps_steady: closed", () => {
    roundtrip(buildLoadProfile(closedState({ rampUp: 10, discard: 5 })), {
      vus: 5,
      duration_seconds: 60,
      ramp_up_seconds: 10,
      steady: { ramp_seconds: 10, hold_seconds: 50, discard_seconds: 5 },
    });
  });
});
