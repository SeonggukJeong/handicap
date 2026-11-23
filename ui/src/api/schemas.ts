import { z } from "zod";

export const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  yaml: z.string(),
  version: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  group: z.string().nullable(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const GroupUpdatedSchema = z.object({ updated: z.number().int() });

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

/** run-level HTTP 타임아웃 기본값(초). 서버 store serde default와 lockstep
 *  (crates/controller/src/store/runs.rs Profile.http_timeout_seconds). */
export const DEFAULT_HTTP_TIMEOUT_SECONDS = 30;

// 자동 정지 설정. 서버가 saturation/emergency를 항상 직렬화(꺼짐=null)하므로 .nullable().
export const AutoStopConfigSchema = z
  .object({
    saturation: z.enum(["two_fails", "first_fail"]).nullable(),
    emergency: z
      .object({
        error_rate_pct: z.number(),
        p99_ms: z.number().int(),
        consecutive_seconds: z.number().int(),
        min_requests: z.number().int(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AutoStopConfig = z.infer<typeof AutoStopConfigSchema>;
export type EmergencyStopConfig = NonNullable<AutoStopConfig["emergency"]>;

export const StairConfigSchema = z
  .object({
    targets: z.array(z.number().int().positive()),
    hold_seconds: z.number().int().nonnegative(),
    ramp_seconds: z.number().int().nonnegative(),
    discard_seconds: z.number().int().nonnegative(),
    // 서버 skip_serializing_if = Option::is_none → absent (never null) → .optional()
    p99_cap_ms: z.number().int().positive().optional(),
    // 서버 skip_serializing_if = Option::is_none → absent → .optional()
    auto_stop: AutoStopConfigSchema.optional(),
  })
  .strict();
export type StairConfig = z.infer<typeof StairConfigSchema>;

export const StairStateSchema = z.enum([
  "ok",
  "spike",
  "saturated",
  "unconfirmed",
  "after",
  "not_measured",
  "emergency_stopped",
  "partial",
  "skipped",
]);
export type StairState = z.infer<typeof StairStateSchema>;

export const StairReasonSchema = z
  .object({
    kind: z.enum(["achieved", "dropped", "errors", "p99_cap", "p99_relative"]),
    value: z.number(),
  })
  .strict();

// 아래 Option 필드는 서버가 항상 직렬화(null)하므로 .nullish().
export const StairStepSchema = z
  .object({
    index: z.number().int().nonnegative(),
    target: z.number().int().nonnegative(),
    achieved: z.number().nullish(),
    launched_rate: z.number().nullish(),
    throughput_rps: z.number(),
    p50_us: z.number(),
    p95_us: z.number(),
    p99_us: z.number(),
    error_rate: z.number(),
    dropped: z.number().nullish(),
    measured_seconds: z.number(),
    measure_start_ms: z.number(),
    measure_end_ms: z.number(),
    state: StairStateSchema,
    reasons: z.array(StairReasonSchema),
    knee: z.boolean(),
    slot_limited: z.boolean(),
    head_p99_ratio: z.number().nullish(),
    discard_warning: z.boolean(),
    // 서버 skip_serializing_if → absent
    partial: z
      .object({ seconds: z.number(), phase: z.enum(["ramp", "discard", "measure"]) })
      .strict()
      .optional(),
  })
  .strict();
export type StairStep = z.infer<typeof StairStepSchema>;

export const StairHeadlineSchema = z
  .object({
    kind: z.enum(["saturated", "unconfirmed", "all_ok", "ok_then_unmeasured", "no_data"]),
    saturated_target: z.number().nullish(),
    last_ok_target: z.number().nullish(),
    through_target: z.number().nullish(),
    first_fail_hint: z.boolean(),
  })
  .strict();

export const StairSecondSchema = z
  .object({
    offset_s: z.number(),
    launched: z.number().nullish(),
    completed: z.number().nullish(),
    dropped: z.number().nullish(),
    count: z.number(),
    p99_us: z.number(),
  })
  .strict();

export const StairBandSchema = z
  .object({
    index: z.number(),
    kind: z.enum(["ramp", "discard", "measure"]),
    start_s: z.number(),
    end_s: z.number(),
  })
  .strict();

// 정지 기록 본문 — 리포트(auto_stop.stop)와 실행 중 요약(auto_stop_live.stop)이 공유.
export const StopInfoSchema = z
  .object({
    kind: z.enum(["saturation", "emergency"]),
    mode: z.enum(["two_fails", "first_fail"]).nullable(),
    failed_steps: z.array(z.number().int()),
    decided_step: z.number().int(),
    judged_through: z.number().int(),
    phase: z.enum(["ramp", "discard", "measure"]).nullable(),
    decided_at_ms: z.number(),
    stopped_at_ms: z.number(),
    emergency: z
      .object({
        max_error_rate: z.number(),
        max_p99_us: z.number(),
        seconds: z.number(),
        error_hit: z.boolean(),
        p99_hit: z.boolean(),
      })
      .strict()
      .nullable(),
    slot_limited: z.boolean(),
  })
  .strict();

// 자동 정지 기록. 내부 Option 필드는 항상 직렬화(null) → .nullable(); 기록 키 자체는 생략 가능.
export const AutoStopRecordSchema = z
  .object({
    stop: StopInfoSchema.nullable(),
    suspended_seconds: z.number(),
  })
  .strict();
export type AutoStopRecord = z.infer<typeof AutoStopRecordSchema>;

// 실행 중 계단별 실패 이유 — 서버가 세 키를 항상 직렬화한다.
export const StairLiveReasonsSchema = z
  .object({
    reasons: z.array(StairReasonSchema),
    slot_limited: z.boolean(),
    ref_fast: z.boolean(),
  })
  .strict();

// 실행 중 계단 요약(GET /api/runs/{id}, 계단 run일 때만). 안쪽 Option은 항상 null로 직렬화 → .nullable().
export const StairLiveSchema = z
  .object({
    current_step: z.number().int().nullable(),
    phase: z.enum(["ramp", "discard", "measure"]).nullable(),
    step_states: z.array(
      z.enum([
        "ok",
        "spike",
        "saturated",
        "unconfirmed",
        "after",
        "not_measured",
        "emergency_stopped",
        "partial",
        "skipped",
        "measuring",
        "pending",
        "frozen",
      ]),
    ),
    step_reasons: z.array(StairLiveReasonsSchema),
    last_ok_step: z.number().int().nullable(),
    next_fail_stops: z.boolean(),
    emergency_now: z
      .object({
        error_rate: z.number(),
        p99_us: z.number(),
        bad_streak: z.number().int(),
        held: z.boolean(),
      })
      .strict()
      .nullable(),
    suspended_seconds: z.number(),
    frozen: z.boolean(),
    stop: StopInfoSchema.nullable(),
  })
  .strict();
export type StairLive = z.infer<typeof StairLiveSchema>;

export const StairReportSchema = z
  .object({
    config: StairConfigSchema,
    steps: z.array(StairStepSchema),
    headline: StairHeadlineSchema,
    knee_target: z.number().nullish(),
    spike_targets: z.array(z.number()),
    max_in_flight: z.number().nullish(),
    dropped_total: z.number().nullish(),
    dropped_explained: z.boolean(),
    slot_limited_targets: z.array(z.number()),
    notes: z.object({ t0_estimated: z.boolean(), open_loop_unknown: z.boolean() }).strict(),
    seconds: z.array(StairSecondSchema),
    bands: z.array(StairBandSchema),
    target_line: z.array(z.object({ offset_s: z.number(), target: z.number() }).strict()),
    auto_stop: AutoStopRecordSchema.optional(),
  })
  .strict();
export type StairReport = z.infer<typeof StairReportSchema>;

export const SteadyConfigSchema = z
  .object({
    ramp_seconds: z.number().int().nonnegative(),
    hold_seconds: z.number().int().positive(),
    discard_seconds: z.number().int().nonnegative(),
    // 서버 skip_serializing_if → absent → .optional()
    target: z.number().int().positive().optional(),
  })
  .strict();
export type SteadyConfig = z.infer<typeof SteadyConfigSchema>;

export const ProfileSchema = z.object({
  vus: z.number().int().nonnegative(),
  ramp_up_seconds: z.number().int().nonnegative().default(0),
  duration_seconds: z.number().int().nonnegative(),
  loop_breakdown_cap: z.number().int().min(0).max(10000).default(256),
  http_timeout_seconds: z.number().int().min(1).max(600).default(DEFAULT_HTTP_TIMEOUT_SECONDS),
  // These Option fields are serialized as `null` (not omitted) in run responses —
  // the controller store Profile uses #[serde(default)] without skip_serializing_if.
  // So they must accept null (.nullish), like data_binding/criteria below. (`stages`
  // DOES use skip_serializing_if server-side → omitted when absent → .optional is fine.)
  think_time: z
    .object({ min_ms: z.number().int().nonnegative(), max_ms: z.number().int().nonnegative() })
    .nullish(),
  think_seed: z.number().int().nonnegative().nullish(),
  // 레거시 단일 바인딩 — 옛 run/preset이 `data_binding: null`을 보낼 수 있어 .nullish()
  // (.optional()만 쓰면 서버 null을 거부해 모든 run 생성 UI가 깨진다 — S-D 함정).
  // 읽기 호환 전용: 신 컨트롤러는 data_bindings를 쓰고, 빌더는 이 키를 더 이상 쓰지 않는다.
  data_binding: DataBindingSchema.nullish(),
  // 신규 다중 바인딩 (binding_index 순서). 우리가 WRITE만 하고 서버는 우리 배열을 echo
  // 하거나(있으면) omit하므로 .optional()이면 충분. 안전 위해 null도 허용(.nullish()).
  data_bindings: z.array(DataBindingSchema).nullish(),
  criteria: CriteriaSchema.nullish(),
  target_rps: z.number().int().positive().max(1_000_000).nullish(),
  max_in_flight: z.number().int().positive().max(10_000).nullish(),
  stages: z.array(StageSchema).optional(),
  // closed-loop VU 곡선 (spec §3.1). 서버 #[serde(skip_serializing_if)] → absent → .optional()
  vu_stages: z.array(StageSchema).optional(),
  ramp_down: z.enum(["graceful", "immediate"]).optional(),
  // graceful ramp-down 상한(초, §B9). 서버 #[serde(skip_serializing_if)] → absent → .optional()
  // (‼ .nullish() 아님 — null로는 오지 않음).
  graceful_ramp_down_seconds: z.number().int().positive().optional(),
  // connect 단계 전용 타임아웃(초, E3). 서버 #[serde(skip_serializing_if)] → absent → .optional()
  // (‼ .nullish() 아님 — null로는 오지 않는다). 상한은 서버 권위(1..=600) — 클라 복제는 드리프트.
  connect_timeout_seconds: z.number().int().positive().optional(),
  // open-loop 멀티워커 fan-out 노브. 서버 #[serde(skip_serializing_if)] → absent → .optional()
  worker_count: z.number().int().min(1).max(64).optional(),
  measure_phases: z.boolean().default(false),
  // open-loop think 무시 토글(§B21 ②). 서버 store는 skip_serializing_if(=true일 때 생략)라
  // false일 때만 직렬화되고 null로는 오지 않는다 → .optional()(‼ .nullish() 아님).
  apply_scenario_think_time: z.boolean().optional(),
  // 계단 시험 설정. 서버 skip_serializing_if → absent → .optional()
  stair: StairConfigSchema.optional(),
  // 상승·버림이 있는 고정 부하. 서버 skip_serializing_if → absent → .optional()
  steady: SteadyConfigSchema.optional(),
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
  // 통과한 요청이 없어 계산하지 못한 기준만 true. 서버가 false·null은 보내지 않고 키를 생략한다.
  no_sample: z.boolean().optional(),
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

export const SetupLiveSchema = z.object({
  ok: z.number().int(),
  failed: z.number().int(),
  interrupted: z.number().int(),
});
export type SetupLive = z.infer<typeof SetupLiveSchema>;

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
  // G1b 목록 stall 배지: 마지막 메트릭 윈도 wall-clock unix초. running list 경로만 number,
  // 그 외/메트릭0은 서버에서 null. 서버 항상-직렬화(skip_serializing_if 없음)라 .nullish().
  last_metric_ts: z.number().int().nullish(),
  // run-identity: 사람이 붙이는 짧은 식별 라벨. plain Option<String>(skip_serializing_if
  // 없음) → None이 null로 옴 → .nullish()(.optional()만 쓰면 무라벨 run 파싱이 깨진다).
  label: z.string().nullish(),
  // 계단 자동 정지 기록: 서버가 없으면 키 생략 → .optional().
  auto_stop: AutoStopRecordSchema.optional(),
  // 실행 중 계단 run의 요약: 서버가 없으면 키 생략 → .optional().
  auto_stop_live: StairLiveSchema.optional(),
  // 실행 중 준비 구간 VU 결과 합: 서버가 없으면 키 생략 → .optional().
  setup_live: SetupLiveSchema.optional(),
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

export const ConnectionStatsSchema = z
  .object({
    dns: PhaseStatsSchema,
    connect: PhaseStatsSchema,
    connections_opened: z.number().int().nonnegative(),
    requests_total: z.number().int().nonnegative(),
    reuse_ratio: z.number(),
  })
  .strict();
export type ConnectionStats = z.infer<typeof ConnectionStatsSchema>;

export const LoopSplitStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
  })
  .strict();
export const LoopSplitSchema = z
  .object({ final: LoopSplitStatsSchema, retry: LoopSplitStatsSchema })
  .strict();
export type LoopSplit = z.infer<typeof LoopSplitSchema>;

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
    wait: PhaseStatsSchema.optional(),
    loop_split: LoopSplitSchema.optional(),
    not_sent: z.number().int().optional(),
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

// E1: run-level rollup of a single transport error kind (kind literal — 8-way
// taxonomy, spec §3.1). Wire 1:1 with Rust ErrorKindCount.
export const ErrorKindCountSchema = z.object({ kind: z.string(), count: z.number() }).strict();
export type ErrorKindCount = z.infer<typeof ErrorKindCountSchema>;

// 조건 반복 진입 종료 집계 (loop-while-report). 서버 skip_serializing_if = Vec::is_empty
// → 조건 반복 집계가 없으면 키 부재 → .optional(). pass는 1부터, null = 21번째 이후.
export const LoopExitBucketSchema = z
  .object({
    pass: z.number().int().nullable(),
    completed: z.number().int().nonnegative(),
    exhausted: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
  })
  .strict();
export const LoopExitSchema = z
  .object({
    step_id: z.string(),
    entered: z.number().int().nonnegative(),
    passes: z.number().int().nonnegative(),
    exhausted: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
    buckets: z.array(LoopExitBucketSchema),
  })
  .strict();
export type LoopExit = z.infer<typeof LoopExitSchema>;

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
    mean_ms: z.number().int().nonnegative(),
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
    // run-identity: ReportRun.label is #[serde(default, skip_serializing_if)] —
    // omitted (not null) when unlabeled, so .optional() (not .nullish() —
    // asymmetric with RunSchema.label above, see shared-constraints Zod 2종 분기).
    label: z.string().optional(),
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
  onset_second: z.number().int().optional(),
  achieved_per_sec: z.number().optional(),
  target_per_sec: z.number().optional(),
  runner_up_ms: z.number().optional(),
  // E2: onset 인사이트의 지배 transport kind. 서버가 skip_serializing_if(absent,
  // null 아님)라 레포 규약대로 .optional()(.nullish() 아님).
  error_kind: z.string().optional(),
  // stall 진단(서버 skip_serializing_if → absent): 평소 점유·슬롯 상한·버림이 몰린 초·측정한 초.
  typical_in_flight: z.number().int().nonnegative().optional(),
  max_in_flight: z.number().int().nonnegative().optional(),
  drop_seconds: z.number().int().nonnegative().optional(),
  measured_seconds: z.number().int().nonnegative().optional(),
});
export type Insight = z.infer<typeof InsightSchema>;

// A11 trustworthy open test — soft validity + narrative (Rust Validity/Narrative 1:1).
// Optional fields use skip_serializing_if = "Option::is_none" → omit, not null → .optional().
export const ValidityReasonSchema = z.object({
  kind: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  pct: z.number().optional(),
  count: z.number().int().nonnegative().optional(),
  step_id: z.string().optional(),
  metric: z.string().optional(),
  value: z.number().optional(),
});
export type ValidityReason = z.infer<typeof ValidityReasonSchema>;

export const ValiditySchema = z.object({
  level: z.enum(["ok", "limited", "suspect"]),
  reasons: z.array(ValidityReasonSchema),
});
export type Validity = z.infer<typeof ValiditySchema>;

export const NarrativeSchema = z.object({
  can_claim: z.array(z.string()),
  cannot_claim: z.array(z.string()),
});
export type Narrative = z.infer<typeof NarrativeSchema>;

export const ActiveVuSampleSchema = z
  .object({
    ts_second: z.number().int(),
    desired: z.number().int().nonnegative(),
    actual: z.number().int().nonnegative(),
  })
  .strict();
export type ActiveVuSample = z.infer<typeof ActiveVuSampleSchema>;

export const WorkerActiveVuSeriesSchema = z
  .object({
    worker_id: z.string(),
    samples: z.array(ActiveVuSampleSchema),
  })
  .strict();
export type WorkerActiveVuSeries = z.infer<typeof WorkerActiveVuSeriesSchema>;

export const WorkerBreakdownSchema = z
  .object({
    worker_id: z.string(),
    count: z.number(),
    errors: z.number(),
    p50_ms: z.number(),
    p95_ms: z.number(),
    p99_ms: z.number(),
  })
  .strict();
export type WorkerBreakdown = z.infer<typeof WorkerBreakdownSchema>;

export const SpeedBandRowSchema = z
  .object({
    slow_ms: z.number(),
    basis: z.enum(["p95", "p99", "p50", "default"]),
    own: z.boolean(),
    // 서버 Option에 skip_serializing_if 없음 → null로 온다 (두 구간)
    fast: z.number().nullable(),
    within: z.number(),
    over: z.number(),
  })
  .strict();
export const SpeedBandsSchema = z
  .object({
    overall: SpeedBandRowSchema,
    steps: z.array(SpeedBandRowSchema.extend({ step_id: z.string() }).strict()),
  })
  .strict();
export type SpeedBands = z.infer<typeof SpeedBandsSchema>;

export const ReportBasisSchema = z
  .object({
    selected: z.enum(["steady", "whole"]),
    default: z.enum(["steady", "whole"]),
    state: z.enum(["measured", "partial", "not_reached", "no_common_window"]),
    config: SteadyConfigSchema,
    // window·other는 서버가 항상 직렬화(없으면 null)
    window: z
      .object({ start_ms: z.number(), end_ms: z.number(), measured_seconds: z.number() })
      .strict()
      .nullable(),
    t0_estimated: z.boolean(),
    dropped_whole_run: z.boolean(),
    other: z
      .object({
        rps: z.number(),
        p50_ms: z.number(),
        p95_ms: z.number(),
        p99_ms: z.number(),
        error_rate: z.number(),
        count: z.number(),
        duration_seconds: z.number(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ReportBasis = z.infer<typeof ReportBasisSchema>;

// 준비 스텝 구획. 준비 스텝이 없으면 서버가 키를 생략한다(null 아님).
export const ReportSetupSchema = z
  .object({
    ok: z.number(),
    failed: z.number(),
    interrupted: z.number(),
    steps: z.array(
      z
        .object({
          step_id: z.string(),
          count: z.number(),
          errors: z.number(),
          p50_ms: z.number(),
          p95_ms: z.number(),
          max_ms: z.number(),
          status_counts: z.record(z.string(), z.number()),
          failure_kinds: z.record(z.string(), z.number()),
        })
        .strict(),
    ),
  })
  .strict();
export type ReportSetup = z.infer<typeof ReportSetupSchema>;

export type ReportSampleName = "passed" | "failed" | "all";
const ReportSampleNameSchema = z.enum(["passed", "failed", "all"]);
export const ReportSampleSchema = z
  .object({
    selected: ReportSampleNameSchema,
    default: ReportSampleNameSchema,
    split: z.boolean(),
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
    if_breakdown: z.array(IfBreakdownSchema).optional(),
    // E1: server skip_serializing_if = Vec::is_empty → absent when no transport
    // errors → .optional() (never null, per schemas.ts:98-106 convention).
    error_kinds: z.array(ErrorKindCountSchema).optional(),
    loop_exits: z.array(LoopExitSchema).optional(),
    group_latency: z.array(GroupLatencySchema).optional(),
    active_vu_series: z.array(ActiveVuSampleSchema).optional(),
    active_vu_by_worker: z.array(WorkerActiveVuSeriesSchema).optional(),
    worker_breakdown: z.array(WorkerBreakdownSchema).optional(),
    verdict: VerdictSchema.nullish(),
    insights: z.array(InsightSchema).optional(),
    // A11: new servers always-emit; old servers/JSON omit → .optional() + UI hide (no fake ok)
    validity: ValiditySchema.optional(),
    narrative: NarrativeSchema.optional(),
    dropped: z.number(),
    latency: LatencyDistributionSchema.nullish(),
    connection: ConnectionStatsSchema.optional(),
    // 계단 run만. 서버 skip_serializing_if → absent → .optional()
    stair: StairReportSchema.optional(),
    // 표본이 없으면 서버가 키를 생략 → .optional()
    speed_bands: SpeedBandsSchema.optional(),
    // steady run만. 서버 skip_serializing_if → absent → .optional()
    basis: ReportBasisSchema.optional(),
    setup: ReportSetupSchema.optional(),
    // 새 서버는 항상 보낸다. 옛 JSON·캐시에는 없다 → .optional()
    sample: ReportSampleSchema.optional(),
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;

/** `sample`이 없는 옛 리포트는 나눌 수 없는 run과 같이 「모든 요청」으로 본다. */
export function reportSample(report: Report): {
  selected: ReportSampleName;
  default: ReportSampleName;
  split: boolean;
} {
  return report.sample ?? { selected: "all", default: "all", split: false };
}
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

// rows 페이징 응답 (GET /datasets/{id}/rows) — 전 필드 항상 직렬화라 plain 타입 (.nullish()/.default() 불요)
export const DatasetRowsSchema = z.object({
  rows: z.array(z.record(z.string(), z.string())),
  offset: z.number().int(),
  total: z.number().int(),
});
export type DatasetRows = z.infer<typeof DatasetRowsSchema>;

export const StepKindSchema = z.enum(["http", "if", "loop"]);
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
  // 앞 스텝이 비워 둔 값을 주소에 써서 보내지 않은 행 — 서버는 아니면 키를 생략한다(null 아님).
  blocked: z.object({ vars: z.array(z.string()), by_step: z.string() }).optional(),
  // 기본값이 들어간 추출 이름 — 서버는 비면 키를 생략한다(null 아님).
  defaulted: z.array(z.string()).optional(),
  // 준비 구간 행이면 "setup" — 서버는 본 행이면 키를 생략한다(null 아님). 모르는 구간 이름도 글자로 읽는다.
  section: z.string().optional(),
});
export type StepTrace = z.infer<typeof StepTraceSchema>;

export const ScenarioTraceSchema = z.object({
  ok: z.boolean(),
  total_ms: z.number().int(),
  steps: z.array(StepTraceSchema),
  final_vars: z.record(z.string(), z.string()),
  truncated: z.boolean(),
  error: z.string().nullable(),
  // 조건 반복이 최대 횟수까지 풀리지 않아 끝난 경우의 loop 이름 — 서버는 없으면 키를 생략한다.
  ended_by_loop: z.string().optional(),
  // 준비 구간이 있는 실행에서만 — 서버는 없으면 키를 생략한다.
  setup_failed: z.boolean().optional(),
  setup_ms: z.number().int().optional(),
});
export type ScenarioTrace = z.infer<typeof ScenarioTraceSchema>;

// ── 에디터 test-run 데이터셋 (ADR-0047) ─────────────────────────────
// 요청 방향(직렬화 전용)이라 Zod 불필수 — plain TS 타입 (spec §4.3).
// row_index/start_row는 0-based 와이어 값 — UI 표시는 1-based, 변환은 컴포넌트에서.
export type TestRunDatasetMode = "single_row" | "sequential";
export interface TestRunBinding {
  dataset_id: string;
  /** 생략 = 서버 자동 매핑(컬럼명=변수명, R3). 빈 배열 전송 금지(422). */
  mappings?: Mapping[];
  /** single_row 전용(필수). */
  row_index?: number;
}
export interface TestRunDatasetConfig {
  mode: TestRunDatasetMode;
  bindings: TestRunBinding[];
  start_row?: number;
  row_limit?: number;
}

// sequential 응답 — 엔진 RowsTrace 직렬화 1:1. ok/truncated/total_ms/rows는 항상 emit(plain 타입, R16),
// 준비 키 셋(setup_steps/setup_failed/setup_ms)은 준비 구간이 있을 때만 emit하는 생략형(.optional()).
export const RowTraceSchema = z.object({
  row_index: z.number().int(),
  trace: ScenarioTraceSchema,
});
export type RowTrace = z.infer<typeof RowTraceSchema>;

export const SequentialTraceSchema = z.object({
  ok: z.boolean(),
  truncated: z.boolean(),
  total_ms: z.number().int(),
  rows: z.array(RowTraceSchema),
  setup_steps: z.array(StepTraceSchema).optional(),
  setup_failed: z.boolean().optional(),
  setup_ms: z.number().int().optional(),
});
export type SequentialTrace = z.infer<typeof SequentialTraceSchema>;

// GET /api/version — 컨트롤러가 항상 직렬화하는 non-Option 필드 (plain z.string()).
export const VersionSchema = z.object({ version: z.string() }).strict();
export type Version = z.infer<typeof VersionSchema>;
