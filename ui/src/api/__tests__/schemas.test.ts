import { describe, expect, it } from "vitest";
import {
  CriteriaSchema,
  IfBreakdownSchema,
  InsightSchema,
  NarrativeSchema,
  ProfileSchema,
  ReportSchema,
  ReportSummarySchema,
  RunSchema,
  ScheduleEventSchema,
  StageSchema,
  ValidityReasonSchema,
  ValiditySchema,
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
        mean_ms: 30,
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
        mean_ms: 0,
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

describe("ProfileSchema null tolerance (server serializes None as null)", () => {
  it("accepts null for target_rps/max_in_flight/think_time/think_seed", () => {
    // The controller store Profile uses #[serde(default)] WITHOUT skip_serializing_if
    // on these Option fields, so None serializes to null in run-create / get-run
    // responses. ProfileSchema must accept null (.nullish()), else every run's
    // response fails to parse. (Regression: closed-loop + open-loop both hit this.)
    const p = ProfileSchema.parse({
      vus: 1,
      duration_seconds: 1,
      ramp_up_seconds: 0,
      loop_breakdown_cap: 0,
      http_timeout_seconds: 30,
      data_binding: null,
      criteria: null,
      think_time: null,
      think_seed: null,
      target_rps: null,
      max_in_flight: null,
    });
    expect(p.target_rps).toBeNull();
    expect(p.max_in_flight).toBeNull();
    expect(p.think_time).toBeNull();
    expect(p.think_seed).toBeNull();
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
    expect(p.stages?.[1].target).toBe(0);
    expect(p.stages?.[1].duration_seconds).toBe(30);
    const p2 = ProfileSchema.parse({ vus: 1, duration_seconds: 10 });
    expect(p2.stages).toBeUndefined();
  });

  it("StageSchema rejects out-of-range target and zero duration", () => {
    expect(() => StageSchema.parse({ target: -1, duration_seconds: 1 })).toThrow();
    expect(() => StageSchema.parse({ target: 1_000_001, duration_seconds: 1 })).toThrow();
    expect(() => StageSchema.parse({ target: 200, duration_seconds: 0 })).toThrow();
    expect(StageSchema.parse({ target: 0, duration_seconds: 1 }).target).toBe(0);
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
      mean_ms: 0,
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

describe("CriteriaSchema status-class + window fields", () => {
  it("parses the 6 new fields", () => {
    const r = CriteriaSchema.safeParse({
      max_4xx_rate: 0.1,
      max_5xx_rate: 0,
      max_4xx_count: 3,
      max_5xx_count: 0,
      min_window_rps: 50,
      rps_warmup_seconds: 5,
    });
    expect(r.success).toBe(true);
  });
  it("rejects out-of-range rate", () => {
    expect(CriteriaSchema.safeParse({ max_5xx_rate: 1.5 }).success).toBe(false);
  });
  it("rejects non-integer count", () => {
    expect(CriteriaSchema.safeParse({ max_5xx_count: 1.5 }).success).toBe(false);
  });
});

describe("step_criteria wire (step-level SLO)", () => {
  it("CriteriaSchema parses step_criteria array", () => {
    const r = CriteriaSchema.safeParse({
      step_criteria: [
        { metric: "p95_ms", op: "max", threshold: 300, target: "stepA" },
        { metric: "5xx_rate", op: "max", threshold: 0.02, target: "stepB" },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.step_criteria?.[0].target).toBe("stepA");
      expect(r.data.step_criteria?.[1].op).toBe("max");
    }
  });
  it("treats absent step_criteria as undefined", () => {
    const r = CriteriaSchema.safeParse({ max_p95_ms: 100 });
    expect(r.success && r.data.step_criteria).toBeUndefined();
  });
  it("CriterionResultSchema carries an optional target (step name)", () => {
    const withTarget = VerdictSchema.parse({
      passed: false,
      criteria: [
        {
          metric: "p95_ms",
          direction: "max",
          threshold: 300,
          actual: 420,
          passed: false,
          target: "stepA",
        },
      ],
    });
    expect(withTarget.criteria[0].target).toBe("stepA");
    // run-level rows omit target → absent
    const noTarget = VerdictSchema.parse({
      passed: true,
      criteria: [{ metric: "rps", direction: "min", threshold: 100, actual: 200, passed: true }],
    });
    expect(noTarget.criteria[0].target).toBeUndefined();
  });
});

describe("ReportSummarySchema.mean_ms", () => {
  // R3: ReportSummarySchema must accept mean_ms (server always emits it, non-optional).
  // Schema is .strict() so adding the field is mandatory for existing parsing to keep working.
  it("parses a summary fixture containing mean_ms", () => {
    const result = ReportSummarySchema.safeParse({
      count: 100,
      errors: 2,
      rps: 50.0,
      duration_seconds: 2,
      mean_ms: 25,
      p50_ms: 20,
      p95_ms: 80,
      p99_ms: 120,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mean_ms).toBe(25);
    }
  });

  it("rejects a negative mean_ms (nonnegative constraint)", () => {
    const result = ReportSummarySchema.safeParse({
      count: 0,
      errors: 0,
      rps: 0,
      duration_seconds: 1,
      mean_ms: -1,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a summary missing mean_ms (strict schema)", () => {
    const result = ReportSummarySchema.safeParse({
      count: 0,
      errors: 0,
      rps: 0,
      duration_seconds: 1,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("InsightSchema achieved/target_per_sec (ADR-0046 R5)", () => {
  const base = { kind: "load_gen_saturated", severity: "warning" as const };

  it("parses achieved_per_sec/target_per_sec when present", () => {
    const parsed = InsightSchema.parse({
      ...base,
      achieved_per_sec: 2.5,
      target_per_sec: 20.0,
    });
    expect(parsed.achieved_per_sec).toBe(2.5);
    expect(parsed.target_per_sec).toBe(20.0);
  });

  it("treats absent achieved_per_sec/target_per_sec as undefined (server omits None)", () => {
    const parsed = InsightSchema.parse(base);
    expect(parsed.achieved_per_sec).toBeUndefined();
    expect(parsed.target_per_sec).toBeUndefined();
  });
});

describe("verdict wire", () => {
  const baseRun = {
    id: "r1",
    scenario_id: "s1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "completed" as const,
    profile: { vus: 1, duration_seconds: 1 },
    env: {},
    started_at: null,
    ended_at: null,
    created_at: 1,
  };
  const verdict = {
    passed: false,
    criteria: [
      { metric: "p95_ms", direction: "max" as const, threshold: 300, actual: 420, passed: false },
    ],
  };

  it("RunSchema accepts a verdict object", () => {
    expect(RunSchema.parse({ ...baseRun, verdict }).verdict?.passed).toBe(false);
  });
  it("RunSchema accepts verdict null (server None)", () => {
    expect(RunSchema.parse({ ...baseRun, verdict: null }).verdict).toBeNull();
  });
  it("RunSchema accepts absent verdict (backward compat)", () => {
    expect(RunSchema.parse(baseRun).verdict).toBeUndefined();
  });
  it("ScheduleEventSchema accepts verdict + null", () => {
    const ev = { id: "e1", at: 1, kind: "fired", run_id: "r1" };
    expect(ScheduleEventSchema.parse({ ...ev, verdict }).verdict?.passed).toBe(false);
    expect(ScheduleEventSchema.parse({ ...ev, verdict: null }).verdict).toBeNull();
  });
});

describe("ReportSchema.validity / narrative (A11)", () => {
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
      count: 10,
      errors: 1,
      rps: 5,
      duration_seconds: 2,
      mean_ms: 30,
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    },
    windows: [],
    steps: [],
    status_distribution: { "200": 9, "0": 1 },
    dropped: 0,
  };

  const validity = {
    level: "suspect" as const,
    reasons: [
      {
        kind: "transport_heavy",
        severity: "critical" as const,
        pct: 0.8,
        count: 80,
      },
    ],
  };

  const narrative = {
    events: ["validity:transport_heavy", "insight:slo_pass"],
    can_claim: ["client_reachability_issue"],
    cannot_claim: ["sut_capacity", "slo_as_capacity", "production_identity"],
  };

  it("parses a report carrying validity and narrative", () => {
    const parsed = ReportSchema.parse({ ...base, validity, narrative });
    expect(parsed.validity?.level).toBe("suspect");
    expect(parsed.validity?.reasons[0].kind).toBe("transport_heavy");
    expect(parsed.validity?.reasons[0].pct).toBe(0.8);
    expect(parsed.validity?.reasons[0].count).toBe(80);
    expect(parsed.narrative?.events).toEqual([
      "validity:transport_heavy",
      "insight:slo_pass",
    ]);
    expect(parsed.narrative?.can_claim).toEqual(["client_reachability_issue"]);
    expect(parsed.narrative?.cannot_claim).toContain("production_identity");
  });

  it("treats absent validity/narrative as undefined (old servers omit)", () => {
    const parsed = ReportSchema.parse(base);
    expect(parsed.validity).toBeUndefined();
    expect(parsed.narrative).toBeUndefined();
  });

  it("rejects unknown severity on ValidityReason", () => {
    expect(
      ValidityReasonSchema.safeParse({
        kind: "zero_requests",
        severity: "fatal",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown validity.level", () => {
    expect(
      ValiditySchema.safeParse({ level: "good", reasons: [] }).success,
    ).toBe(false);
  });

  it("ValiditySchema / NarrativeSchema parse standalone", () => {
    expect(ValiditySchema.parse({ level: "ok", reasons: [] }).level).toBe("ok");
    expect(
      NarrativeSchema.parse({ events: [], can_claim: [], cannot_claim: [] }).events,
    ).toEqual([]);
  });

  it("ReportSchema.strict rejects unknown top-level keys", () => {
    expect(() => ReportSchema.parse({ ...base, validity, extra_field: 1 })).toThrow();
  });

  it("rejects negative reason count", () => {
    expect(
      ValidityReasonSchema.safeParse({
        kind: "transport_heavy",
        severity: "warning",
        count: -1,
      }).success,
    ).toBe(false);
  });
});
