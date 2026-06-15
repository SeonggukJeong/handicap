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

// step-level SLO 한 항목 (spec). 서버 `Criterion`과 와이어 1:1. metric/op는
// 임의 문자열·max|min, threshold는 rate면 분수(UI 입출력은 %), target=스텝 id.
export const CriterionSchema = z.object({
  metric: z.string(),
  op: z.enum(["max", "min"]),
  threshold: z.number(),
  target: z.string().min(1),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export const CriteriaSchema = z.object({
  max_p50_ms: z.number().int().nonnegative().optional(),
  max_p95_ms: z.number().int().nonnegative().optional(),
  max_p99_ms: z.number().int().nonnegative().optional(),
  max_error_rate: z.number().min(0).max(1).optional(), // 분수 (UI 입출력은 %)
  min_rps: z.number().nonnegative().optional(),
  max_4xx_rate: z.number().min(0).max(1).optional(),
  max_5xx_rate: z.number().min(0).max(1).optional(),
  max_4xx_count: z.number().int().nonnegative().optional(),
  max_5xx_count: z.number().int().nonnegative().optional(),
  min_window_rps: z.number().nonnegative().optional(),
  rps_warmup_seconds: z.number().int().nonnegative().optional(),
  // step-level SLO 기준. 서버 #[serde(skip_serializing_if="Vec::is_empty")] → absent → .optional()
  step_criteria: z.array(CriterionSchema).optional(),
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
  // These Option fields are serialized as `null` (not omitted) in run responses —
  // the controller store Profile uses #[serde(default)] without skip_serializing_if.
  // So they must accept null (.nullish), like data_binding/criteria below. (`stages`
  // DOES use skip_serializing_if server-side → omitted when absent → .optional is fine.)
  think_time: z
    .object({ min_ms: z.number().int().nonnegative(), max_ms: z.number().int().nonnegative() })
    .nullish(),
  think_seed: z.number().int().nonnegative().nullish(),
  data_binding: DataBindingSchema.nullish(),
  criteria: CriteriaSchema.nullish(),
  target_rps: z.number().int().positive().max(1_000_000).nullish(),
  max_in_flight: z.number().int().positive().max(10_000).nullish(),
  stages: z.array(StageSchema).optional(),
  // closed-loop VU 곡선 (spec §3.1). 서버 #[serde(skip_serializing_if)] → absent → .optional()
  vu_stages: z.array(StageSchema).optional(),
  ramp_down: z.enum(["graceful", "immediate"]).optional(),
  // open-loop 멀티워커 fan-out 노브. 서버 #[serde(skip_serializing_if)] → absent → .optional()
  worker_count: z.number().int().min(1).max(64).optional(),
  measure_phases: z.boolean().default(false),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const CriterionResultSchema = z.object({
  metric: z.string(),
  direction: z.enum(["max", "min"]),
  threshold: z.number(),
  actual: z.number(),
  passed: z.boolean(),
  // step-level criterion이면 대상 스텝 id(서버 #[serde(skip_serializing_if="Option::is_none")]).
  // run-level row는 omit → absent. null로 오지 않으므로 .nullish()(absent | string).
  target: z.string().nullish(),
});
export const VerdictSchema = z.object({
  passed: z.boolean(),
  criteria: z.array(CriterionResultSchema),
});
export type Verdict = z.infer<typeof VerdictSchema>;

// ── Run 스케줄러 (34c) ────────────────────────────────────────────────────────
// Mirrors crates/controller/src/api/schedules.rs TriggerResponse / ScheduleResponse /
// ScheduleSummary / EventResponse. Internally-tagged kind discriminant.
// ALL Option<T> fields use .nullish() (Rust None → JSON null, not absent — S-D trap).

export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), run_at: z.number() }),
  z.object({ kind: z.literal("cron"), cron_expr: z.string() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

// List endpoint: GET /api/schedules → {schedules: ScheduleSummary[]}
// No profile/env/last_run_id/last_error — lightweight summary only.
export const ScheduleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  scenario_id: z.string(),
  trigger: TriggerSchema,
  enabled: z.boolean(),
  next_run_at: z.number().nullish(),
  last_status: z.string().nullish(),
  last_fired_at: z.number().nullish(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

// Full schedule: GET /api/schedules/{id}, POST /api/schedules, PUT /api/schedules/{id}
export const ScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  scenario_id: z.string(),
  profile: ProfileSchema,
  env: z.record(z.string(), z.string()),
  trigger: TriggerSchema,
  enabled: z.boolean(),
  next_run_at: z.number().nullish(),
  last_run_id: z.string().nullish(),
  last_fired_at: z.number().nullish(),
  last_status: z.string().nullish(),
  last_error: z.string().nullish(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ScheduleEventSchema = z.object({
  id: z.string(),
  at: z.number(),
  kind: z.string(),
  run_id: z.string().nullish(),
  detail: z.string().nullish(),
  // B6 verdict 배지: 스케줄 이벤트 타임라인에 pass/fail 배지. 서버 None→null이라 .nullish().
  verdict: VerdictSchema.nullish(),
});
export type ScheduleEvent = z.infer<typeof ScheduleEventSchema>;

export const ScheduleListSchema = z.object({ schedules: z.array(ScheduleSummarySchema) });
export const ScheduleEventsSchema = z.object({ events: z.array(ScheduleEventSchema) });
export const PreviewNextSchema = z.object({ next: z.array(z.number()) });

// ── End Run 스케줄러 ─────────────────────────────────────────────────────────

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
  // A4a SLO verdict, 완료 시 영속(목록 배지). 서버 None→null이라 .nullish().
  verdict: VerdictSchema.nullish(),
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

export const PhaseStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
    max_ms: z.number().int().nonnegative(),
  })
  .strict();
export type PhaseStats = z.infer<typeof PhaseStatsSchema>;

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
    download: PhaseStatsSchema.optional(),
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

export const BranchLatencySchema = z
  .object({
    branch: z.string(),
    count: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
    max_ms: z.number().int().nonnegative(),
  })
  .strict();
export type BranchLatency = z.infer<typeof BranchLatencySchema>;

export const GroupLatencySchema = z
  .object({
    step_id: z.string(),
    count: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
    max_ms: z.number().int().nonnegative(),
    branches: z.array(BranchLatencySchema),
  })
  .strict();
export type GroupLatency = z.infer<typeof GroupLatencySchema>;

export const PercentilePointSchema = z
  .object({
    quantile: z.number(),
    value_us: z.number().int().nonnegative(),
  })
  .strict();

export const HistogramBucketSchema = z
  .object({
    lower_us: z.number().int().nonnegative(),
    upper_us: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const LatencyDistributionSchema = z
  .object({
    percentile_curve: z.array(PercentilePointSchema),
    histogram: z.array(HistogramBucketSchema),
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
  recommended: z.number().optional(),
  cause: z.string().optional(),
  // Rust 필드는 skip_serializing_if = "Option::is_none" → None이면 OMIT(null 아님) → .optional()
  recommended_workers: z.number().optional(),
});
export type Insight = z.infer<typeof InsightSchema>;

export const ActiveVuSampleSchema = z
  .object({
    ts_second: z.number().int(),
    desired: z.number().int().nonnegative(),
    actual: z.number().int().nonnegative(),
  })
  .strict();
export type ActiveVuSample = z.infer<typeof ActiveVuSampleSchema>;

export const ReportSchema = z
  .object({
    run: ReportRunSchema,
    scenario_yaml: z.string(),
    summary: ReportSummarySchema,
    windows: z.array(ReportWindowSchema),
    steps: z.array(ReportStepSchema),
    status_distribution: StatusDistributionSchema,
    if_breakdown: z.array(IfBreakdownSchema).optional(),
    group_latency: z.array(GroupLatencySchema).optional(),
    active_vu_series: z.array(ActiveVuSampleSchema).optional(),
    verdict: VerdictSchema.nullish(),
    insights: z.array(InsightSchema).optional(),
    dropped: z.number(),
    latency: LatencyDistributionSchema.nullish(),
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;
export type LatencyDistribution = z.infer<typeof LatencyDistributionSchema>;
export type HistogramBucket = z.infer<typeof HistogramBucketSchema>;
export type PercentilePoint = z.infer<typeof PercentilePointSchema>;
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
  download_ms: z.number().int().nullable(),
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
