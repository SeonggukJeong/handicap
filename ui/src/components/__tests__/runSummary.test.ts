import { runSummary } from "../runSummary";
import type { LoadModelState } from "../loadModel";

const base: LoadModelState = {
  loadModel: "closed",
  rateMode: "fixed",
  vus: 100,
  duration: 300,
  rampUp: 0,
  targetRps: "100",
  maxInFlight: "200",
  stages: [{ target: "100", duration_seconds: "30" }],
  thinkMin: "",
  thinkMax: "",
  thinkSeed: "",
  rampDown: "graceful",
  workerCount: "1",
};

it("closed+fixed → 동시 사용자 N명 · 시간, no request estimate", () => {
  const r = runSummary({ ...base, vus: 100, duration: 300 });
  expect(r.text).toContain("동시 사용자 100명");
  expect(r.text).toContain("5분");
  expect(r.text).not.toMatch(/건/);
  expect(r.tone).toBe("ok");
  expect(r.curve).toBe(false);
});
it("open+fixed → 목표 RPS · 약 rps×duration건", () => {
  const r = runSummary({ ...base, loadModel: "open", targetRps: "100", duration: 300 });
  expect(r.text).toContain("목표 100 RPS");
  expect(r.text).toContain("30,000건");
});
it("curve → 최대 P (곡선) + curve:true", () => {
  const r = runSummary({
    ...base,
    rateMode: "curve",
    stages: [
      { target: "50", duration_seconds: "30" },
      { target: "100", duration_seconds: "60" },
    ],
  });
  expect(r.curve).toBe(true);
  expect(r.text).toContain("최대 100");
});
it("invalid (vus<1) → 설정을 확인하세요, tone warn", () => {
  const r = runSummary({ ...base, vus: 0 });
  expect(r.text).toBe("설정을 확인하세요");
  expect(r.tone).toBe("warn");
});
it("curve with no valid stages → warn + curve:true", () => {
  const r = runSummary({ ...base, rateMode: "curve", stages: [] });
  expect(r.tone).toBe("warn");
  expect(r.curve).toBe(true);
});
it("open+curve → 최대 N RPS (곡선); 단계 count reflects only valid stages", () => {
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
  expect(r.text).toContain("RPS"); // summaryCurveRps head (not the VU head)
  expect(r.text).toContain("2단계"); // 0-duration stage excluded from the count (Fix 1)
  expect(r.text).not.toContain("3단계");
});
