import { describe, expect, it } from "vitest";
import { ReportSchema } from "../schemas";

describe("ReportSchema", () => {
  it("parses a minimal valid bundle", () => {
    const sample = {
      run: {
        id: "R1",
        scenario_id: "S1",
        status: "completed",
        profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
        env: {},
        started_at: 100,
        ended_at: 102,
        created_at: 99,
      },
      scenario_yaml: "version: 1\nname: x\nsteps: []\n",
      summary: {
        count: 10,
        errors: 1,
        rps: 5.0,
        duration_seconds: 2,
        p50_ms: 10,
        p95_ms: 50,
        p99_ms: 90,
      },
      windows: [
        {
          ts_second: 100,
          step_id: "stepA",
          count: 5,
          error_count: 0,
          status_counts: { "200": 5 },
          p50_ms: 10,
          p95_ms: 20,
          p99_ms: 30,
        },
      ],
      steps: [
        {
          step_id: "stepA",
          count: 5,
          error_count: 0,
          status_counts: { "200": 5 },
          p50_ms: 10,
          p95_ms: 20,
          p99_ms: 30,
        },
      ],
      status_distribution: { "200": 9, "500": 1 },
    };
    expect(() => ReportSchema.parse(sample)).not.toThrow();
  });

  it("rejects extra top-level keys (strict)", () => {
    const sample = { foo: 1 };
    expect(() => ReportSchema.parse(sample)).toThrow();
  });
});
