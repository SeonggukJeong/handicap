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

export const BindingPolicyEnum = z.enum(["per_vu", "iter_sequential", "iter_random", "unique"]);
export type BindingPolicy = z.infer<typeof BindingPolicyEnum>;

// Matches Rust `Mapping` (#[serde(tag = "kind", rename_all = "snake_case")]).
export const MappingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), var: z.string().min(1), column: z.string().min(1) }),
  z.object({ kind: z.literal("literal"), var: z.string().min(1), value: z.string() }),
]);
export type Mapping = z.infer<typeof MappingSchema>;

export const DataBindingSchema = z.object({
  dataset_id: z.string().min(1),
  policy: BindingPolicyEnum,
  mappings: z.array(MappingSchema),
});
export type DataBinding = z.infer<typeof DataBindingSchema>;

export const CriteriaSchema = z.object({
  max_p50_ms: z.number().int().nonnegative().optional(),
  max_p95_ms: z.number().int().nonnegative().optional(),
  max_p99_ms: z.number().int().nonnegative().optional(),
  max_error_rate: z.number().min(0).max(1).optional(), // 분수 (UI 입출력은 %)
  min_rps: z.number().nonnegative().optional(),
});
export type Criteria = z.infer<typeof CriteriaSchema>;

export const StageSchema = z.object({
  target: z.number().int().min(0).max(1_000_000),
  duration_seconds: z.number().int().min(1),
});
export type Stage = z.infer<typeof StageSchema>;

export const ProfileSchema = z.object({
  vus: z.number().int().nonnegative(),
  ramp_up_seconds: z.number().int().nonnegative().default(0),
  duration_seconds: z.number().int().nonnegative(),
  loop_breakdown_cap: z.number().int().min(0).max(10000).default(256),
  http_timeout_seconds: z.number().int().min(1).max(600).default(30),
  think_time: z
    .object({ min_ms: z.number().int().nonnegative(), max_ms: z.number().int().nonnegative() })
    .optional(),
  think_seed: z.number().int().nonnegative().optional(),
  data_binding: DataBindingSchema.nullish(),
  criteria: CriteriaSchema.nullish(),
  target_rps: z.number().int().positive().max(1_000_000).optional(),
  max_in_flight: z.number().int().positive().max(10_000).optional(),
  stages: z.array(StageSchema).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const RunSchema = z.object({
  id: z.string(),
  scenario_id: z.string(),
  // Immutable scenario snapshot the run executed against (retry drift warning).
  scenario_yaml: z.string(),
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

export const IfBranchBucketSchema = z
  .object({
    branch: z.string(),
    count: z.number(),
  })
  .strict();

export const IfBreakdownSchema = z
  .object({
    step_id: z.string(),
    branches: z.array(IfBranchBucketSchema),
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

export const CriterionResultSchema = z.object({
  metric: z.string(),
  direction: z.enum(["max", "min"]),
  threshold: z.number(),
  actual: z.number(),
  passed: z.boolean(),
});
export const VerdictSchema = z.object({
  passed: z.boolean(),
  criteria: z.array(CriterionResultSchema),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const InsightSchema = z.object({
  kind: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  step_id: z.string().optional(),
  metric: z.string().optional(),
  value: z.number().optional(),
  pct: z.number().optional(),
  count: z.number().int().nonnegative().optional(),
  status_class: z.string().optional(),
  window_seconds: z.number().int().optional(),
});
export type Insight = z.infer<typeof InsightSchema>;

export const ReportSchema = z
  .object({
    run: ReportRunSchema,
    scenario_yaml: z.string(),
    summary: ReportSummarySchema,
    windows: z.array(ReportWindowSchema),
    steps: z.array(ReportStepSchema),
    status_distribution: StatusDistributionSchema,
    if_breakdown: z.array(IfBreakdownSchema).optional(),
    verdict: VerdictSchema.nullish(),
    insights: z.array(InsightSchema).optional(),
    dropped: z.number(),
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;
export type ReportWindow = z.infer<typeof ReportWindowSchema>;
export type ReportStep = z.infer<typeof ReportStepSchema>;
export type ReportSummary = z.infer<typeof ReportSummarySchema>;
export type IfBreakdown = z.infer<typeof IfBreakdownSchema>;

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

export const StepKindSchema = z.enum(["http", "if"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const TracedRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
});
export type TracedRequest = z.infer<typeof TracedRequestSchema>;

export const TracedResponseSchema = z.object({
  status: z.number().int(),
  latency_ms: z.number().int(),
  headers: z.record(z.string(), z.string()),
  set_cookies: z.array(z.string()),
  body: z.string(),
  body_truncated: z.boolean(),
});
export type TracedResponse = z.infer<typeof TracedResponseSchema>;

export const StepTraceSchema = z.object({
  step_id: z.string(),
  kind: StepKindSchema,
  loop_index: z.number().int().nullable(),
  branch: z.string().nullable(),
  request: TracedRequestSchema.nullable(),
  response: TracedResponseSchema.nullable(),
  extracted: z.record(z.string(), z.string()),
  unbound_vars: z.array(z.string()),
  error: z.string().nullable(),
});
export type StepTrace = z.infer<typeof StepTraceSchema>;

export const ScenarioTraceSchema = z.object({
  ok: z.boolean(),
  total_ms: z.number().int(),
  steps: z.array(StepTraceSchema),
  final_vars: z.record(z.string(), z.string()),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type ScenarioTrace = z.infer<typeof ScenarioTraceSchema>;
