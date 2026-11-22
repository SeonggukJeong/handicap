import { describe, expect, it } from "vitest";
import { ReportSchema } from "../schemas";

describe("ReportSchema.setup", () => {
  const base = {
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
      mean_ms: 30,
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    },
    windows: [],
    steps: [],
    status_distribution: {},
    dropped: 0,
  };
  const setup = {
    ok: 98,
    failed: 2,
    interrupted: 0,
    steps: [
      {
        step_id: "01J",
        count: 100,
        errors: 2,
        p50_ms: 41,
        p95_ms: 120,
        max_ms: 310,
        status_counts: { "200": 98, "401": 2 },
        failure_kinds: { status_assert: 2 },
      },
    ],
  };

  it("setup 블록이 있는 응답을 받는다", () => {
    expect(ReportSchema.parse({ ...base, setup }).setup?.ok).toBe(98);
  });

  it("setup 키가 없는 응답을 받는다", () => {
    expect(ReportSchema.parse(base).setup).toBeUndefined();
  });

  it("setup: null 은 받지 않는다(서버는 키를 생략한다)", () => {
    expect(ReportSchema.safeParse({ ...base, setup: null }).success).toBe(false);
  });
});
