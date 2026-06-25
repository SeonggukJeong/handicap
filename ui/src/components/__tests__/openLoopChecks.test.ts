import { describe, expect, it } from "vitest";
import type { Scenario, Step } from "../../scenario/model";
import { iterationTimeUpperBoundSeconds, openLoopWarnings } from "../openLoopChecks";

// 폴드는 .type/.timeout_seconds/.think_time/.repeat/.do/.then/.elif/.else/.branches만 읽으므로
// 테스트 픽스처는 최소 구조 캐스트로 충분(Zod 검증 대상 아님).
const http = (over: Partial<Record<string, unknown>> = {}) =>
  ({ type: "http", ...over }) as unknown as Step;
const scenarioOf = (steps: Step[]) => ({ steps }) as unknown as Scenario;

const base = {
  loadModel: "open" as const,
  rateMode: "fixed" as const,
  targetRps: "10",
  maxInFlight: "10000",
  stages: [{ target: "1", duration_seconds: "10" }],
  workerCount: "1",
  httpTimeoutSeconds: 1,
  scenario: scenarioOf([http()]), // 1 http leaf, no per-step timeout → uses httpTimeoutSeconds
  poolMode: false,
};

describe("iterationTimeUpperBoundSeconds", () => {
  it("http leaf = step timeout(없으면 httpTimeout) + think max_ms/1000", () => {
    expect(iterationTimeUpperBoundSeconds([http()], 30)).toBe(30);
    expect(iterationTimeUpperBoundSeconds([http({ timeout_seconds: 5 })], 30)).toBe(5);
    expect(
      iterationTimeUpperBoundSeconds(
        [http({ timeout_seconds: 2, think_time: { min_ms: 0, max_ms: 3000 } })],
        30,
      ),
    ).toBe(5); // 2 + 3000/1000
  });

  it("순차 = 합", () => {
    expect(
      iterationTimeUpperBoundSeconds(
        [http({ timeout_seconds: 2 }), http({ timeout_seconds: 3 })],
        30,
      ),
    ).toBe(5);
  });

  it("loop = repeat × body", () => {
    const loop = { type: "loop", repeat: 4, do: [http({ timeout_seconds: 2 })] } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([loop], 30)).toBe(8);
  });

  it("if = 분기 max (단일 분기만 실행)", () => {
    const ifStep = {
      type: "if",
      then: [http({ timeout_seconds: 2 })],
      elif: [{ then: [http({ timeout_seconds: 9 })] }],
      else: [http({ timeout_seconds: 3 })],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([ifStep], 30)).toBe(9);
  });

  it("parallel = 분기 max (동시 실행)", () => {
    const par = {
      type: "parallel",
      branches: [
        { steps: [http({ timeout_seconds: 2 })] },
        { steps: [http({ timeout_seconds: 7 })] },
      ],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([par], 30)).toBe(7);
  });

  it("중첩: loop-in-if · if-in-loop 재귀", () => {
    const loopInIf = {
      type: "if",
      then: [{ type: "loop", repeat: 3, do: [http({ timeout_seconds: 2 })] }],
      elif: [],
      else: [],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([loopInIf], 30)).toBe(6); // 3×2
    const ifInLoop = {
      type: "loop",
      repeat: 2,
      do: [
        {
          type: "if",
          then: [http({ timeout_seconds: 5 })],
          elif: [],
          else: [http({ timeout_seconds: 1 })],
        },
      ],
    } as unknown as Step;
    expect(iterationTimeUpperBoundSeconds([ifInLoop], 30)).toBe(10); // 2×max(5,1)
  });

  it("http leaf 없으면 0 (fail-safe)", () => {
    expect(iterationTimeUpperBoundSeconds([], 30)).toBe(0);
  });
});

describe("openLoopWarnings — ① 곡선 유휴 워커", () => {
  it("곡선 W>peak → idle_workers(idle=W-peak)", () => {
    const w = openLoopWarnings({
      ...base,
      rateMode: "curve",
      workerCount: "3",
      stages: [{ target: "1", duration_seconds: "10" }],
    });
    expect(w).toContainEqual({ kind: "idle_workers", workers: 3, peak: 1, idle: 2 });
  });
  it("곡선 W≤peak → 없음", () => {
    const w = openLoopWarnings({
      ...base,
      rateMode: "curve",
      workerCount: "1",
      stages: [{ target: "5", duration_seconds: "10" }],
    });
    expect(w.find((x) => x.kind === "idle_workers")).toBeUndefined();
  });
  it("고정 모드 → ① 없음(고정은 worker_count>target_rps가 이미 400)", () => {
    const w = openLoopWarnings({ ...base, rateMode: "fixed", workerCount: "3" });
    expect(w.find((x) => x.kind === "idle_workers")).toBeUndefined();
  });
});

describe("openLoopWarnings — ② inert max_in_flight", () => {
  it("W≤1 && M ≥ ceil(R×T) → inert_slots (고정: R=target_rps)", () => {
    const w = openLoopWarnings({
      ...base,
      targetRps: "10",
      maxInFlight: "10000",
      httpTimeoutSeconds: 1,
    });
    expect(w).toContainEqual({ kind: "inert_slots", maxInFlight: 10000, threshold: 10 });
  });
  it("M < ceil(R×T) → 없음", () => {
    const w = openLoopWarnings({
      ...base,
      targetRps: "100",
      maxInFlight: "5",
      httpTimeoutSeconds: 30,
    });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
  it("곡선: R=peak", () => {
    const w = openLoopWarnings({
      ...base,
      rateMode: "curve",
      maxInFlight: "10000",
      httpTimeoutSeconds: 1,
      stages: [{ target: "20", duration_seconds: "10" }],
    });
    expect(w).toContainEqual({ kind: "inert_slots", maxInFlight: 10000, threshold: 20 });
  });
  it("W>1(fan-out) → ② 없음(false-positive 방지, §7 연기)", () => {
    const w = openLoopWarnings({ ...base, workerCount: "2", maxInFlight: "10000" });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
  it("scenario=null → 없음(fail-safe)", () => {
    const w = openLoopWarnings({ ...base, scenario: null, maxInFlight: "10000" });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
  it("httpTimeoutSeconds 미설정 → 없음(ScheduleForm 시나리오)", () => {
    const w = openLoopWarnings({ ...base, httpTimeoutSeconds: undefined, maxInFlight: "10000" });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
  it("http leaf 0(T=0) → 없음(fail-safe)", () => {
    const w = openLoopWarnings({ ...base, scenario: scenarioOf([]), maxInFlight: "10000" });
    expect(w.find((x) => x.kind === "inert_slots")).toBeUndefined();
  });
});

describe("openLoopWarnings — 게이트(R13/R7)", () => {
  it("poolMode=true → 둘 다 없음([])", () => {
    const w = openLoopWarnings({
      ...base,
      rateMode: "curve",
      workerCount: "3",
      maxInFlight: "10000",
      poolMode: true,
    });
    expect(w).toEqual([]);
  });
  it("closed → 둘 다 없음([])", () => {
    const w = openLoopWarnings({
      ...base,
      loadModel: "closed",
      rateMode: "curve",
      workerCount: "3",
      maxInFlight: "10000",
    });
    expect(w).toEqual([]);
  });
});
