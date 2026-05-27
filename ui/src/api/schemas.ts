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
