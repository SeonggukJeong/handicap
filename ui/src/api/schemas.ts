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
  loop_breakdown_cap: z.number().int().min(0).max(10000).default(256),
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
  // Crash-recovery message set by the controller when a pending/running run is
  // flipped to failed on startup (Slice 6). Optional + nullable for backward
  // compat with older controllers that don't include the column.
  message: z.string().nullable().optional(),
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
    loop_breakdown: z
      .array(
        z.object({
          loop_index: z.number().int().nullable(),
          count: z.number(),
          error_count: z.number(),
        }),
      )
      .optional(),
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

export const DatasetMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  columns: z.array(z.string()),
  row_count: z.number().int(),
  byte_size: z.number().int(),
  created_at: z.number().int(),
});
export type DatasetMeta = z.infer<typeof DatasetMetaSchema>;

// upload/get 응답: 메타 + sample(+ xlsx면 sheets)
export const DatasetSchema = DatasetMetaSchema.extend({
  sample: z.array(z.record(z.string(), z.string())),
  sheets: z.array(z.string()).optional(),
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const DatasetListSchema = z.object({ datasets: z.array(DatasetMetaSchema) });

// preview 응답: 저장 안 됨 → id/메타 없음
export const DatasetPreviewSchema = z.object({
  columns: z.array(z.string()),
  row_count: z.number().int(),
  sample: z.array(z.record(z.string(), z.string())),
  sheets: z.array(z.string()).optional(),
});
export type DatasetPreview = z.infer<typeof DatasetPreviewSchema>;
