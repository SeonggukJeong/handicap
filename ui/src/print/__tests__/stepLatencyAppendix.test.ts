import { describe, expect, it } from "vitest";
import { buildStepLatAppendix } from "../stepLatencyAppendix";
import type { ChartModel } from "../chartModel";
import type { StepRow } from "../stepTable";
import type { Report } from "../../api/schemas";

const chartOf = (
  bins: { startSec: number; seconds: number }[],
  binSeconds: number,
  durationSec: number,
): ChartModel => ({
  durationSec,
  binSeconds,
  bins: bins.map((b) => ({ ...b, rps: 0, topErr: 0, otherErr: 0 })),
  topStepId: null,
  hasErrors: false,
  rpsTicks: [0, 1],
  errTicks: [],
  timeTicks: [0],
  markers: [],
});
const even = (binSeconds: number, durationSec: number): ChartModel =>
  chartOf(
    Array.from({ length: Math.ceil(durationSec / binSeconds) }, (_, i) => ({
      startSec: i * binSeconds,
      seconds: Math.min(binSeconds, durationSec - i * binSeconds),
    })),
    binSeconds,
    durationSec,
  );

const rows = (n: number): StepRow[] =>
  Array.from({ length: n }, (_, i) => ({
    no: `${"①②③④⑤"[i]}`,
    stepId: `s${i}`,
    name: `단계${i}`,
  })) as unknown as StepRow[];

type W = Report["windows"][number];
const w = (step: string, ts: number, over: { n: number; mean_us?: number; capped?: boolean }): W =>
  ({
    ts_second: ts,
    step_id: step,
    count: over.n,
    error_count: 0,
    status_counts: {},
    p50_ms: 0,
    p95_ms: 0,
    p99_ms: 0,
    ...over,
  }) as W;

describe("buildStepLatAppendix", () => {
  it("단계 다섯 → 쌍 셋, 마지막 쌍은 [카드, null]", () => {
    const m = buildStepLatAppendix(
      [0, 1, 2, 3, 4].map((i) => w(`s${i}`, 100, { n: 1, mean_us: 5000 })),
      rows(5),
      100,
      even(2, 6),
    )!;
    expect(m.cards.map((c) => c.title)).toEqual([
      "① 단계0",
      "② 단계1",
      "③ 단계2",
      "④ 단계3",
      "⑤ 단계4",
    ]);
    expect(m.pairs.length).toBe(3);
    expect(m.pairs[2]).toEqual([m.cards[4], null]);
  });
  it("같은 칸의 두 창은 n 가중 평균 17.5", () => {
    const m = buildStepLatAppendix(
      [w("s0", 100, { n: 1, mean_us: 10000 }), w("s0", 101, { n: 3, mean_us: 20000 })],
      rows(1),
      100,
      even(2, 6),
    )!;
    expect(m.cards[0].bins).toEqual([17.5, null, null]);
    expect(m.cards[0].hasData).toBe(true);
  });
  it("창이 없는 단계는 hasData false, 모두 없으면 null", () => {
    const m = buildStepLatAppendix(
      [w("s0", 100, { n: 1, mean_us: 10000 })],
      rows(2),
      100,
      even(2, 6),
    )!;
    expect(m.cards[1].hasData).toBe(false);
    expect(m.cards[1].bins).toEqual([null, null, null]);
    expect(buildStepLatAppendix([], rows(2), 100, even(2, 6))).toBeNull();
    expect(buildStepLatAppendix([w("s0", 100, { n: 0 })], rows(2), 100, even(2, 6))).toBeNull();
    expect(
      buildStepLatAppendix([w("s0", 100, { n: 1, mean_us: 1 })], rows(2), null, even(2, 6)),
    ).toBeNull();
  });
  it("최댓값 287.3 → 눈금 [0,100,200,300]", () => {
    const m = buildStepLatAppendix(
      [w("s0", 100, { n: 1, mean_us: 287300 })],
      rows(1),
      100,
      even(2, 6),
    )!;
    expect(m.yTicks).toEqual([0, 100, 200, 300]);
  });
  it("capped 창이 하나라도 있으면 capped", () => {
    const a = buildStepLatAppendix(
      [w("s0", 100, { n: 1, mean_us: 1000 })],
      rows(1),
      100,
      even(2, 6),
    )!;
    expect(a.capped).toBe(false);
    const b = buildStepLatAppendix(
      [
        w("s0", 100, { n: 1, mean_us: 1000 }),
        w("s0", 102, { n: 1, mean_us: 60000000, capped: true }),
      ],
      rows(1),
      100,
      even(2, 6),
    )!;
    expect(b.capped).toBe(true);
  });
  it("마지막 칸이 짧으면 점은 칸 가운데 [1,3,4.5]", () => {
    const chart = chartOf(
      [
        { startSec: 0, seconds: 2 },
        { startSec: 2, seconds: 2 },
        { startSec: 4, seconds: 1 },
      ],
      2,
      5,
    );
    const m = buildStepLatAppendix([w("s0", 100, { n: 1, mean_us: 1000 })], rows(1), 100, chart)!;
    expect(m.points).toEqual([1, 3, 4.5]);
  });
});
