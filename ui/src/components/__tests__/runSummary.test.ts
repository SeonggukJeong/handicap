import { runSummary } from "../runSummary";
import type { LoadModelState } from "../loadModel";

// base 에 loadModel 없음 — 각 테스트에서 명시적으로 spread
const base: Omit<LoadModelState, "loadModel"> = {
  rateMode: "fixed",
  vus: 100,
  duration: 300,
  rampUp: 0,
  targetRps: "100",
  maxInFlight: "200",
  stages: [],
  thinkMin: "",
  thinkMax: "",
  thinkSeed: "",
  rampDown: "graceful",
  workerCount: "1",
};

it("closed+fixed: main 세그먼트에 굵은 vus·time, sub=램프업", () => {
  const r = runSummary({ ...base, loadModel: "closed" });
  expect(r.curve).toBe(false);
  expect(r.tone).toBe("ok");
  expect(r.main.map((s) => s.text).join("")).toBe("동시 사용자 100명 · 5분");
  expect(r.main.filter((s) => s.bold).map((s) => s.text)).toEqual(["100", "5분"]);
  expect(r.sub).toBe("램프업 없음");
});

it("open+fixed: 굵은 rps·total·time, sub=동시 요청 상한", () => {
  const r = runSummary({ ...base, loadModel: "open" });
  expect(r.main.map((s) => s.text).join("")).toBe("목표 100 RPS · 약 30,000건 · 5분");
  expect(r.sub).toBe("동시 요청 상한 200");
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
  expect(r.main.map((s) => s.text).join("")).toContain("RPS");
  // 0-duration 제외 → 2단계
  expect(r.sub).toContain("2단계");
  expect(r.sub).not.toContain("3단계");
});

it("curve with no valid stages → warn + curve:true", () => {
  const r = runSummary({ ...base, loadModel: "closed", rateMode: "curve", stages: [] });
  expect(r.tone).toBe("warn");
  expect(r.curve).toBe(true);
});
