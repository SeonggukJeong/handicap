import { describe, expect, it } from "vitest";
import { binLatency, buildLatencyChart, latencyLinePoints } from "../latencyChart";
import type { LatencyBin } from "../latencyChart";
import type { ChartModel } from "../chartModel";
import { ko } from "../../i18n/ko";

const chartOf = (binSeconds: number, durationSec: number): ChartModel => {
  const n = Math.ceil(durationSec / binSeconds);
  return {
    durationSec,
    binSeconds,
    bins: Array.from({ length: n }, (_, i) => ({
      startSec: i * binSeconds,
      seconds: Math.min(binSeconds, durationSec - i * binSeconds),
      rps: 0,
      topErr: 0,
      otherErr: 0,
    })),
    topStepId: null,
    hasErrors: false,
    rpsTicks: [0, 1],
    errTicks: [],
    timeTicks: [0],
    markers: [],
  };
};

describe("binLatency", () => {
  it("칸 평균은 n 가중, p95는 칸 안 최댓값", () => {
    const bins = binLatency(
      [
        { ts_second: 100, n: 1, mean_us: 10000, p95_us: 10000 },
        { ts_second: 101, n: 3, mean_us: 20000, p95_us: 30000 },
      ],
      100,
      chartOf(2, 6),
    );
    expect(bins[0]).toMatchObject({
      startSec: 0,
      seconds: 2,
      meanMs: 17.5,
      p95Ms: 30,
      capped: false,
    });
  });
  it("n 0인 초만 있는 칸은 observed true + null, 초 없는 칸은 observed false", () => {
    const bins = binLatency([{ ts_second: 102, n: 0 }], 100, chartOf(2, 6));
    expect(bins[1]).toMatchObject({ meanMs: null, p95Ms: null, capped: false, observed: true });
    expect(bins[0]).toMatchObject({ meanMs: null, p95Ms: null, capped: false, observed: false });
  });
  it("capped 초가 든 칸은 capped", () => {
    const bins = binLatency(
      [{ ts_second: 104, n: 4, mean_us: 30007796, p95_us: 60000000, capped: true }],
      100,
      chartOf(2, 6),
    );
    expect(bins[2]).toMatchObject({ meanMs: 30007.796, p95Ms: 60000, capped: true });
  });
});

describe("latencyLinePoints", () => {
  const bin = (startSec: number, meanMs: number | null, observed: boolean): LatencyBin => ({
    startSec,
    seconds: 2,
    meanMs,
    p95Ms: meanMs,
    capped: false,
    observed,
  });
  it("홀로 남은 묶음은 선분, 값 없는 묶음은 끊김, 초 없는 묶음은 건너뜀", () => {
    const bins = [
      bin(0, 5, true),
      bin(2, null, true),
      bin(4, 7, true),
      bin(6, null, false),
      bin(8, 9, true),
      bin(10, 11, true),
    ];
    expect(latencyLinePoints(bins, (b) => b.meanMs)).toEqual([
      { x: 0, y: 5 },
      { x: 2, y: 5 },
      { x: 3, y: null },
      { x: 5, y: 7 },
      { x: 9, y: 9 },
      { x: 11, y: 11 },
    ]);
  });
  it("묶음 하나뿐이면 묶음 폭 선분", () => {
    expect(
      latencyLinePoints(
        [{ startSec: 0, seconds: 1, meanMs: 4, p95Ms: 4, capped: false, observed: true }],
        (b) => b.meanMs,
      ),
    ).toEqual([
      { x: 0, y: 4 },
      { x: 1, y: 4 },
    ]);
  });
  it("빈 배열은 빈 배열", () => {
    expect(latencyLinePoints([], (b) => b.meanMs)).toEqual([]);
  });
});

describe("buildLatencyChart", () => {
  const one = [{ ts_second: 100, n: 1, mean_us: 287300, p95_us: 287300 }];
  it("빈 series·t0 null이면 null", () => {
    expect(buildLatencyChart([], 100, chartOf(1, 5))).toBeNull();
    expect(buildLatencyChart(one, null, chartOf(1, 5))).toBeNull();
  });
  it("범례 글은 칸 길이를 따른다", () => {
    expect(buildLatencyChart(one, 100, chartOf(1, 5))?.p95Label).toBe(ko.print.latencyChart.p95);
    expect(buildLatencyChart(one, 100, chartOf(2, 6))?.p95Label).toBe(ko.print.latencyChart.p95Bin);
  });
  it("세로 눈금은 최댓값 287.3ms에서 [0,100,200,300]", () => {
    const m = buildLatencyChart(one, 100, chartOf(1, 5));
    expect(m?.yTicks).toEqual([0, 100, 200, 300]);
    expect(m?.capped).toBe(false);
  });
});
