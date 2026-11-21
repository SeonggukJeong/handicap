import { STAIR_DEFAULTS } from "../stair";
import { runSummary } from "../runSummary";
import type { LoadModelState } from "../loadModel";

// base 에 loadModel 없음 — 각 테스트에서 명시적으로 spread
const base: Omit<LoadModelState, "loadModel"> = {
  rateMode: "fixed",
  vus: 100,
  duration: 300,
  rampUp: 0,
  rampOpen: 0,
  discard: 0,
  targetRps: "100",
  maxInFlight: "200",
  stages: [],
  thinkMin: "",
  thinkMax: "",
  thinkSeed: "",
  rampDown: "graceful",
  workerCount: "1",
  gracefulCap: "",
  stair: STAIR_DEFAULTS,
};

it("closed+fixed: main 세그먼트에 굵은 vus·time, sub=램프업", () => {
  const r = runSummary({ ...base, loadModel: "closed" });
  expect(r.curve).toBe(false);
  expect(r.tone).toBe("ok");
  expect(r.main.map((s) => s.text).join("")).toBe("동시 사용자 100명 · 5분");
  expect(r.main.filter((s) => s.bold).map((s) => s.text)).toEqual(["100", "5분"]);
  expect(r.sub).toBe("램프업 없음");
});

it("open+fixed: 굵은 rate·total·time, sub=동시 요청 상한", () => {
  const r = runSummary({ ...base, loadModel: "open" });
  expect(r.main.map((s) => s.text).join("")).toBe("도착률 초당 100회 · 반복 약 30,000회 · 5분");
  expect(r.sub).toBe("동시 요청 상한 200");
});

it("open+fixed 상승: 반복 수는 상승 구간을 절반으로 센다", () => {
  const withRamp = runSummary({
    ...base,
    loadModel: "open",
    targetRps: "40",
    duration: 60,
    rampOpen: 20,
  });
  const text = withRamp.main.map((s) => s.text).join("");
  expect(text).toContain("2,000");
  expect(text).not.toContain("2,400");
  const noRamp = runSummary({ ...base, loadModel: "open", targetRps: "40", duration: 60 });
  expect(noRamp.main.map((s) => s.text).join("")).toContain("2,400");
});

it("invalid(closed vus=0): main='설정을 확인하세요'(굵음 없음) + warn sub", () => {
  const r = runSummary({ ...base, loadModel: "closed", vus: 0 });
  expect(r.tone).toBe("warn");
  expect(r.main).toEqual([{ text: "설정을 확인하세요" }]);
  expect(r.sub).toBe("동시 사용자·시간을 입력");
});

it("closed+curve: main 굵은 peak, curve=true", () => {
  const r = runSummary({
    ...base,
    loadModel: "closed",
    rateMode: "curve",
    stages: [{ target: "50", duration_seconds: "30" }],
  });
  expect(r.curve).toBe(true);
  expect(r.main.map((s) => s.text).join("")).toBe("최대 50명 (곡선)");
  expect(r.main.filter((s) => s.bold).map((s) => s.text)).toEqual(["50"]);
});

it("open+curve: summaryCurveRps 변형, curve=true", () => {
  const r = runSummary({
    ...base,
    loadModel: "open",
    rateMode: "curve",
    stages: [
      { target: "50", duration_seconds: "30" },
      { target: "100", duration_seconds: "60" },
      { target: "80", duration_seconds: "0" },
    ],
  });
  expect(r.curve).toBe(true);
  expect(r.main.map((s) => s.text).join("")).toBe("최대 초당 100회 반복 (곡선)");
  // 0-duration 제외 → 2단계
  expect(r.sub).toContain("2단계");
  expect(r.sub).not.toContain("3단계");
});

it("curve with no valid stages → warn + curve:true", () => {
  const r = runSummary({ ...base, loadModel: "closed", rateMode: "curve", stages: [] });
  expect(r.tone).toBe("warn");
  expect(r.curve).toBe(true);
});

it("open+stair: N계단 · 총 · 계단마다 측정 K초", () => {
  const r = runSummary({
    ...base,
    loadModel: "open",
    rateMode: "stair",
    stair: { ...STAIR_DEFAULTS, targets: "100,200,300" },
  });
  expect(r.main.map((s) => s.text).join("")).toBe("3계단 · 총 3분 15초 · 계단마다 측정 45초");
  expect(r.main.filter((s) => s.bold).map((s) => s.text)).toEqual(["3계단"]);
  expect(r.tone).toBe("ok");
  expect(r.curve).toBe(true);
});

it("open+stair 입력 오류면 warn", () => {
  const r = runSummary({
    ...base,
    loadModel: "open",
    rateMode: "stair",
    stair: { ...STAIR_DEFAULTS, targets: "" },
  });
  expect(r.tone).toBe("warn");
  expect(r.main).toEqual([{ text: "설정을 확인하세요" }]);
});
