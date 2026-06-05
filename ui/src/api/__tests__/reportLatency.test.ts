import { describe, it, expect } from "vitest";
import { ReportSchema } from "../schemas";

// Minimal valid ReportSchema fixture — mirrors the existing schemas.test.ts pattern.
// ReportRunSchema is .strict() with profile: z.unknown(), no scenario_yaml field.
// ReportSummarySchema is .strict() and requires all 7 fields.
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
    p50_ms: 20,
    p95_ms: 30,
    p99_ms: 30,
  },
  windows: [],
  steps: [],
  status_distribution: { "200": 5 },
  dropped: 0,
};

describe("ReportSchema latency", () => {
  it("parses a latency distribution object", () => {
    const r = ReportSchema.parse({
      ...base,
      latency: {
        percentile_curve: [{ quantile: 0.5, value_us: 20_000 }],
        histogram: [{ lower_us: 1_000, upper_us: 2_000, count: 5 }],
      },
    });
    expect(r.latency?.histogram[0].count).toBe(5);
    expect(r.latency?.percentile_curve[0].value_us).toBe(20_000);
  });
  it("accepts null latency (server None)", () => {
    const r = ReportSchema.parse({ ...base, latency: null });
    expect(r.latency ?? null).toBeNull();
  });
  it("accepts absent latency", () => {
    const r = ReportSchema.parse(base);
    expect(r.latency ?? null).toBeNull();
  });
});
