import { describe, expect, it } from "vitest";
import { ReportSchema, SpeedBandsSchema } from "../../api/schemas";

const threeBand = {
  slow_ms: 3000,
  basis: "p95",
  own: false,
  fast: 10,
  within: 5,
  over: 2,
};
const twoBand = { ...threeBand, slow_ms: 800, fast: null };

const base = {
  run: {
    id: "R",
    scenario_id: "S",
    status: "completed",
    profile: {},
    env: {},
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: "version: 1\nname: x\nsteps: []\n",
  summary: {
    count: 5,
    errors: 0,
    rps: 2.5,
    duration_seconds: 2,
    mean_ms: 22,
    p50_ms: 20,
    p95_ms: 30,
    p99_ms: 30,
  },
  windows: [],
  steps: [],
  status_distribution: { "200": 5 },
  dropped: 0,
};

describe("SpeedBandsSchema", () => {
  it("fast: null 행과 단계 행(step_id 포함)을 통과시킨다", () => {
    const r = SpeedBandsSchema.safeParse({
      overall: twoBand,
      steps: [{ step_id: "A", ...threeBand, own: true }],
    });
    expect(r.success).toBe(true);
  });

  it("모르는 키·모르는 basis·fast 누락을 거부한다", () => {
    expect(
      SpeedBandsSchema.safeParse({ overall: { ...threeBand, extra: 1 }, steps: [] }).success,
    ).toBe(false);
    expect(
      SpeedBandsSchema.safeParse({ overall: { ...threeBand, basis: "p90" }, steps: [] }).success,
    ).toBe(false);
    const noFast: Record<string, unknown> = { ...threeBand };
    delete noFast.fast;
    expect(SpeedBandsSchema.safeParse({ overall: noFast, steps: [] }).success).toBe(false);
    expect(
      SpeedBandsSchema.safeParse({
        overall: threeBand,
        steps: [{ step_id: "A", ...threeBand, extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it("ReportSchema는 speed_bands 부재·존재 모두 통과", () => {
    expect(ReportSchema.safeParse(base).success).toBe(true);
    const withBands = { ...base, speed_bands: { overall: threeBand, steps: [] } };
    const r = ReportSchema.safeParse(withBands);
    expect(r.success).toBe(true);
    expect(r.success && r.data.speed_bands?.overall.over).toBe(2);
  });
});
