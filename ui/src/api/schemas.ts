import { z } from "zod";

export const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  yaml: z.string(),
  version: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioListSchema = z.object({
  scenarios: z.array(ScenarioSchema),
});

export const RunStatusEnum = z.enum(["pending", "running", "completed", "failed", "aborted"]);
export type RunStatus = z.infer<typeof RunStatusEnum>;

export const ProfileSchema = z.object({
  vus: z.number().int().nonnegative(),
  ramp_up_seconds: z.number().int().nonnegative().default(0),
  duration_seconds: z.number().int().nonnegative(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const RunSchema = z.object({
  id: z.string(),
  scenario_id: z.string(),
  status: RunStatusEnum,
  profile: ProfileSchema,
  // Backend stores env as serde_json::Value (could be null, object, or anything).
  // Accept any JSON value here; the run dialog only sends objects in Slice 2.
  env: z.unknown(),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
  created_at: z.number().int(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunListSchema = z.object({
  runs: z.array(RunSchema),
});

export const WindowSummarySchema = z.object({
  ts_second: z.number().int(),
  step_id: z.string(),
  count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  status_counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type WindowSummary = z.infer<typeof WindowSummarySchema>;

export const MetricSummarySchema = z.object({
  run_id: z.string(),
  windows: z.array(WindowSummarySchema),
});
export type MetricSummary = z.infer<typeof MetricSummarySchema>;

export const ApiErrorSchema = z.object({ error: z.string() });

export const StatusDistributionSchema = z.record(z.string(), z.number().int().nonnegative());

export const ReportWindowSchema = z
  .object({
    ts_second: z.number().int(),
    step_id: z.string(),
    count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    status_counts: StatusDistributionSchema,
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
  })
  .strict();

export const ReportStepSchema = z
  .object({
    step_id: z.string(),
    count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    status_counts: StatusDistributionSchema,
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
  })
  .strict();

export const ReportSummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    rps: z.number().nonnegative(),
    duration_seconds: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
  })
  .strict();

export const ReportRunSchema = z
  .object({
    id: z.string(),
    scenario_id: z.string(),
    status: z.string(),
    profile: z.unknown(),
    env: z.unknown(),
    started_at: z.number().int().nullable(),
    ended_at: z.number().int().nullable(),
    created_at: z.number().int(),
  })
  .strict();

export const ReportSchema = z
  .object({
    run: ReportRunSchema,
    scenario_yaml: z.string(),
    summary: ReportSummarySchema,
    windows: z.array(ReportWindowSchema),
    steps: z.array(ReportStepSchema),
    status_distribution: StatusDistributionSchema,
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;
export type ReportWindow = z.infer<typeof ReportWindowSchema>;
export type ReportStep = z.infer<typeof ReportStepSchema>;
export type ReportSummary = z.infer<typeof ReportSummarySchema>;
