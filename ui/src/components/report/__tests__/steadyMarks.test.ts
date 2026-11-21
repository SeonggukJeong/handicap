import { describe, expect, it } from "vitest";
import type { ReportBasis } from "../../../api/schemas";
import { steadyMarks } from "../steadyMarks";

const basis = (over: Partial<ReportBasis> = {}): ReportBasis => ({
  selected: "steady",
  default: "steady",
  state: "measured",
  config: { ramp_seconds: 20, hold_seconds: 40, discard_seconds: 5 },
  window: { start_ms: 1_025_000, end_ms: 1_060_000, measured_seconds: 35 },
  t0_estimated: false,
  dropped_whole_run: false,
  other: null,
  ...over,
});

describe("steadyMarks", () => {
  it("상승·버림 띠와 시작·끝 세로선", () => {
    expect(steadyMarks(basis(), 1000)).toEqual({
      bands: [
        { kind: "ramp", x1: 0, x2: 20 },
        { kind: "discard", x1: 20, x2: 25 },
      ],
      lines: [
        { kind: "start", x: 25 },
        { kind: "end", x: 59 },
      ],
    });
  });

  it("버림 0이면 버림 띠가 없다", () => {
    const m = steadyMarks(
      basis({
        config: { ramp_seconds: 20, hold_seconds: 40, discard_seconds: 0 },
        window: { start_ms: 1_020_000, end_ms: 1_060_000, measured_seconds: 40 },
      }),
      1000,
    );
    expect(m?.bands).toEqual([{ kind: "ramp", x1: 0, x2: 20 }]);
  });

  it("상승 0이면 상승 띠가 없다", () => {
    const m = steadyMarks(
      basis({ config: { ramp_seconds: 0, hold_seconds: 40, discard_seconds: 5 } }),
      1000,
    );
    expect(m?.bands).toEqual([{ kind: "discard", x1: 20, x2: 25 }]);
  });

  it("첫 메트릭 초가 run 시작보다 늦으면 띠를 0에서 자른다", () => {
    const m = steadyMarks(basis(), 1008);
    expect(m?.bands).toEqual([
      { kind: "ramp", x1: 0, x2: 12 },
      { kind: "discard", x1: 12, x2: 17 },
    ]);
    expect(m?.lines).toEqual([
      { kind: "start", x: 17 },
      { kind: "end", x: 51 },
    ]);
  });

  it("잘라서 길이가 0 이하가 된 띠는 내지 않는다", () => {
    const m = steadyMarks(basis(), 1020);
    expect(m?.bands).toEqual([{ kind: "discard", x1: 0, x2: 5 }]);
  });

  it("창이 없으면 null", () => {
    expect(steadyMarks(basis({ window: null, state: "not_reached" }), 1000)).toBeNull();
  });

  it("firstTs가 null이면 null", () => {
    expect(steadyMarks(basis(), null)).toBeNull();
  });

  it("basis가 없으면 null", () => {
    expect(steadyMarks(undefined, 1000)).toBeNull();
  });

  it("전체 구간을 보고 있어도 같은 띠", () => {
    expect(steadyMarks(basis({ selected: "whole" }), 1000)).toEqual(steadyMarks(basis(), 1000));
  });
});
