import { describe, expect, it } from "vitest";
import {
  IfBreakdownSchema,
  ProfileSchema,
  ReportSchema,
  RunSchema,
  VerdictSchema,
} from "../schemas";

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
      dropped: 0,
    };
    expect(() => ReportSchema.parse(sample)).not.toThrow();
  });

  it("rejects extra top-level keys (strict)", () => {
    const sample = { foo: 1 };
    expect(() => ReportSchema.parse(sample)).toThrow();
  });
});

describe("if_breakdown schema", () => {
  it("parses an IfBreakdown entry", () => {
    const parsed = IfBreakdownSchema.parse({
      step_id: "if1",
      branches: [
        { branch: "then", count: 930 },
        { branch: "none", count: 0 },
      ],
    });
    expect(parsed.branches).toHaveLength(2);
    expect(parsed.branches[0].branch).toBe("then");
  });

  it("accepts a report carrying if_breakdown", () => {
    const report = {
      run: {
        id: "r",
        scenario_id: "s",
        status: "completed",
        profile: {},
        env: {},
        started_at: 1,
        ended_at: 2,
        created_at: 0,
      },
      scenario_yaml: "version: 1\nname: x\nsteps: []\n",
      summary: {
        count: 0,
        errors: 0,
        rps: 0,
        duration_seconds: 0,
        p50_ms: 0,
        p95_ms: 0,
        p99_ms: 0,
      },
      windows: [],
      steps: [],
      status_distribution: {},
      dropped: 0,
      if_breakdown: [{ step_id: "if1", branches: [{ branch: "then", count: 1 }] }],
    };
    const parsed = ReportSchema.parse(report);
    expect(parsed.if_breakdown?.[0].step_id).toBe("if1");
  });
});

describe("RunSchema.message", () => {
  const base = {
    id: "R1",
    scenario_id: "S1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "failed" as const,
    profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
    env: {},
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  };

  it("accepts a non-empty message string", () => {
    const parsed = RunSchema.parse({ ...base, message: "boom" });
    expect(parsed.message).toBe("boom");
  });

  it("accepts an explicit null message", () => {
    const parsed = RunSchema.parse({ ...base, message: null });
    expect(parsed.message).toBeNull();
  });

  it("accepts an absent message field (backward compat)", () => {
    const parsed = RunSchema.parse(base);
    expect(parsed.message).toBeUndefined();
  });
});

describe("ProfileSchema.criteria", () => {
  it("carries criteria, undefined when absent", () => {
    const p = ProfileSchema.parse({
      vus: 1,
      duration_seconds: 2,
      criteria: { max_p95_ms: 500, max_error_rate: 0.01 },
    });
    expect(p.criteria?.max_p95_ms).toBe(500);
    expect(ProfileSchema.parse({ vus: 1, duration_seconds: 2 }).criteria).toBeUndefined();
  });
});

describe("ProfileSchema.stages", () => {
  it("ProfileSchema parses stages and treats absent as undefined", () => {
    const p = ProfileSchema.parse({
      vus: 0,
      duration_seconds: 0,
      max_in_flight: 50,
      stages: [
        { target: 200, duration_seconds: 30 },
        { target: 0, duration_seconds: 30 },
      ],
    });
    expect(p.stages).toHaveLength(2);
    expect(p.stages?.[0].target).toBe(200);
    const p2 = ProfileSchema.parse({ vus: 1, duration_seconds: 10 });
    expect(p2.stages).toBeUndefined();
  });
});

describe("ReportSchema.verdict", () => {
  const base = {
    run: {
      id: "r1",
      scenario_id: "s1",
      status: "completed",
      profile: {},
      env: {},
      started_at: 100,
      ended_at: 102,
      created_at: 99,
    },
    scenario_yaml: "version: 1\nname: x\nsteps: []\n",
    summary: {
      count: 0,
      errors: 0,
      rps: 0,
      duration_seconds: 0,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
    },
    windows: [],
    steps: [],
    status_distribution: {},
    dropped: 0,
  };

  it("tolerates absence of verdict", () => {
    expect(ReportSchema.parse(base).verdict).toBeUndefined();
  });

  it("accepts verdict and parses criteria array", () => {
    const withV = ReportSchema.parse({
      ...base,
      verdict: {
        passed: false,
        criteria: [
          { metric: "p95_ms", direction: "max", threshold: 500, actual: 800, passed: false },
        ],
      },
    });
    expect(withV.verdict?.passed).toBe(false);
    expect(withV.verdict?.criteria[0].metric).toBe("p95_ms");
  });

  it("VerdictSchema is exported and parses standalone", () => {
    const v = VerdictSchema.parse({
      passed: true,
      criteria: [{ metric: "rps", direction: "min", threshold: 100, actual: 200, passed: true }],
    });
    expect(v.passed).toBe(true);
  });
});
