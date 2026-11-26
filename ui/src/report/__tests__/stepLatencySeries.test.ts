import { describe, it, expect } from "vitest";
import { ko } from "../../i18n/ko";
import type { LatencyStats, Report } from "../../api/schemas";
import { sharedYMax, stepLatencySeries, stepMeanText } from "../stepLatencySeries";

function stats(mean_us: number, capped: boolean): LatencyStats {
  return {
    min_us: 0,
    mean_us,
    max_us: mean_us,
    stdev_us: 0,
    p50_us: 0,
    p90_us: 0,
    p95_us: 0,
    p99_us: 0,
    capped,
  };
}

const report = {
  steps: [{ step_id: "B" }, { step_id: "A" }, { step_id: "C" }],
  windows: [
    { ts_second: 100, step_id: "A", n: 3, mean_us: 52118 },
    { ts_second: 102, step_id: "A", n: 0 },
    { ts_second: 103, step_id: "A", n: 1, mean_us: 60000000, capped: true },
  ],
} as unknown as Report;

describe("stepLatencySeries", () => {
  it("순서·이름 폴백·점·capped", () => {
    const out = stepLatencySeries(report, new Map([["A", "로그인"]]), 100);
    expect(out.map((s) => s.stepId)).toEqual(["B", "A", "C"]);
    expect(out[0]).toMatchObject({ name: "B", points: [], capped: false });
    expect(out[1].name).toBe("로그인");
    expect(out[1].points).toEqual([
      { x: 0, meanMs: 52.118 },
      { x: 2, meanMs: null },
      { x: 3, meanMs: 60000 },
    ]);
    expect(out[1].capped).toBe(true);
    expect(out[2].name).toBe("C");
  });
  it("세 스텝 창이 섞여 와도 스텝마다 제 창만 초 순서로", () => {
    const mixed = {
      steps: [{ step_id: "Z" }, { step_id: "X" }, { step_id: "Y" }],
      windows: [
        { ts_second: 10, step_id: "X", n: 1, mean_us: 1000 },
        { ts_second: 10, step_id: "Y", n: 1, mean_us: 2000 },
        { ts_second: 10, step_id: "Z", n: 1, mean_us: 3000 },
        { ts_second: 11, step_id: "Y", n: 1, mean_us: 4000 },
        { ts_second: 12, step_id: "X", n: 0 },
        { ts_second: 12, step_id: "Z", n: 1, mean_us: 5000, capped: true },
        { ts_second: 13, step_id: "X", n: 1, mean_us: 6000 },
      ],
    } as unknown as Report;
    const out = stepLatencySeries(mixed, new Map(), 10);
    expect(out.map((s) => s.stepId)).toEqual(["Z", "X", "Y"]);
    expect(out[0].points).toEqual([
      { x: 0, meanMs: 3 },
      { x: 2, meanMs: 5 },
    ]);
    expect(out[0].capped).toBe(true);
    expect(out[1].points).toEqual([
      { x: 0, meanMs: 1 },
      { x: 2, meanMs: null },
      { x: 3, meanMs: 6 },
    ]);
    expect(out[1].capped).toBe(false);
    expect(out[2].points).toEqual([
      { x: 0, meanMs: 2 },
      { x: 1, meanMs: 4 },
    ]);
    expect(out[2].capped).toBe(false);
  });
  it("firstTs가 null이어도 throw 없음", () => {
    expect(
      stepLatencySeries({ steps: [], windows: [] } as unknown as Report, new Map(), null),
    ).toEqual([]);
  });
});

describe("sharedYMax", () => {
  const mk = (v: (number | null)[]) => ({
    stepId: "a",
    name: "a",
    stats: undefined,
    capped: false,
    points: v.map((meanMs, x) => ({ x, meanMs })),
  });
  it("최댓값을 눈금으로 올린다", () => {
    expect(sharedYMax([mk([10, 287.3, null])])).toBe(300);
  });
  it("값이 없으면 1", () => {
    expect(sharedYMax([mk([null])])).toBe(1);
    expect(sharedYMax([])).toBe(1);
  });
});

describe("stepMeanText", () => {
  it("규칙", () => {
    expect(stepMeanText(stats(52118, false))).toBe(ko.report.stepLatency.mean("52 ms"));
    expect(stepMeanText(stats(350, false))).toBe(ko.report.stepLatency.mean("350 µs"));
    expect(stepMeanText(stats(60_000_000, true))).toBe(
      ko.report.stepLatency.mean(`${ko.report.stats.capped} ms`),
    );
    expect(stepMeanText(stats(17_178_000, true))).toBe(ko.report.stepLatency.mean("≥ 17178 ms"));
    expect(stepMeanText(undefined)).toBe(ko.report.stepLatency.noData);
  });
});
