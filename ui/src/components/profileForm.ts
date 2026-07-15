import type { Criteria, DataBinding, Profile } from "../api/schemas";
import { buildLoadProfile, type LoadModelState } from "./loadModel";

/** step-level SLO 한 행의 draft 상태(threshold는 rate metric이면 % 표시, 저장은 분수). */
export type StepCriterionDraft = {
  target: string;
  metric: string;
  op: "max" | "min";
  threshold: string; // rate metric은 % 표시(저장은 분수)
};

const RATE_METRICS = new Set(["error_rate", "4xx_rate", "5xx_rate"]);

/** 11개 SLO 입력의 string draft 상태 + step-level 행들(RunDialog/ScheduleForm 공유). */
export type CriteriaState = {
  maxP50: string;
  maxP95: string;
  maxP99: string;
  maxErrPct: string; // % (wire는 분수)
  minRps: string;
  max4xxPct: string; // %
  max5xxPct: string; // %
  max4xxCount: string;
  max5xxCount: string;
  minWindowRps: string;
  rpsWarmup: string; // 수식자(criterion 아님)
  stepCriteria: StepCriterionDraft[];
};

export const EMPTY_CRITERIA: CriteriaState = {
  maxP50: "",
  maxP95: "",
  maxP99: "",
  maxErrPct: "",
  minRps: "",
  max4xxPct: "",
  max5xxPct: "",
  max4xxCount: "",
  max5xxCount: "",
  minWindowRps: "",
  rpsWarmup: "",
  stepCriteria: [],
};

const numToStr = (n?: number | null) => (n == null ? "" : String(n));

/** 저장된 Criteria(분수) → 입력 string 상태(%). prefill/edit용. */
export function criteriaStateFrom(c?: Criteria | null): CriteriaState {
  return {
    maxP50: numToStr(c?.max_p50_ms),
    maxP95: numToStr(c?.max_p95_ms),
    maxP99: numToStr(c?.max_p99_ms),
    maxErrPct: c?.max_error_rate != null ? String(c.max_error_rate * 100) : "",
    minRps: numToStr(c?.min_rps),
    max4xxPct: c?.max_4xx_rate != null ? String(c.max_4xx_rate * 100) : "",
    max5xxPct: c?.max_5xx_rate != null ? String(c.max_5xx_rate * 100) : "",
    max4xxCount: numToStr(c?.max_4xx_count),
    max5xxCount: numToStr(c?.max_5xx_count),
    minWindowRps: numToStr(c?.min_window_rps),
    rpsWarmup: numToStr(c?.rps_warmup_seconds),
    stepCriteria: (c?.step_criteria ?? []).map((r) => ({
      target: r.target,
      metric: r.metric,
      op: r.op,
      threshold: RATE_METRICS.has(r.metric) ? String(r.threshold * 100) : String(r.threshold),
    })),
  };
}

export function criteriaHasValue(s: CriteriaState): boolean {
  const { stepCriteria, ...rest } = s;
  if (stepCriteria.length > 0) return true;
  return Object.values(rest).some((v) => v.trim() !== "");
}

/** 토글 hint용 — rps_warmup_seconds(수식자)는 제외, 실제 기준 10개만 카운트. */
export function criteriaActiveCount(s: CriteriaState): number {
  return (
    [
      s.maxP50,
      s.maxP95,
      s.maxP99,
      s.maxErrPct,
      s.minRps,
      s.max4xxPct,
      s.max5xxPct,
      s.max4xxCount,
      s.max5xxCount,
      s.minWindowRps,
    ].filter((v) => v.trim() !== "").length + s.stepCriteria.length
  );
}

export function buildCriteria(s: CriteriaState): Criteria | undefined {
  const c: Criteria = {};
  if (s.maxP50.trim() !== "") c.max_p50_ms = Number(s.maxP50);
  if (s.maxP95.trim() !== "") c.max_p95_ms = Number(s.maxP95);
  if (s.maxP99.trim() !== "") c.max_p99_ms = Number(s.maxP99);
  if (s.maxErrPct.trim() !== "") c.max_error_rate = Number(s.maxErrPct) / 100;
  if (s.minRps.trim() !== "") c.min_rps = Number(s.minRps);
  if (s.max4xxPct.trim() !== "") c.max_4xx_rate = Number(s.max4xxPct) / 100;
  if (s.max5xxPct.trim() !== "") c.max_5xx_rate = Number(s.max5xxPct) / 100;
  if (s.max4xxCount.trim() !== "") c.max_4xx_count = Number(s.max4xxCount);
  if (s.max5xxCount.trim() !== "") c.max_5xx_count = Number(s.max5xxCount);
  if (s.minWindowRps.trim() !== "") c.min_window_rps = Number(s.minWindowRps);
  if (s.rpsWarmup.trim() !== "") c.rps_warmup_seconds = Number(s.rpsWarmup);
  const steps = s.stepCriteria
    .filter((r) => r.target.trim() !== "" && r.threshold.trim() !== "")
    .map((r) => ({
      metric: r.metric,
      op: r.op,
      target: r.target,
      threshold: RATE_METRICS.has(r.metric) ? Number(r.threshold) / 100 : Number(r.threshold),
    }));
  if (steps.length > 0) c.step_criteria = steps;
  return Object.keys(c).length > 0 ? c : undefined;
}

export type ProfileFormInput = {
  hasLoop: boolean;
  loopCap: number;
  httpTimeout: number;
  /** 다중 독립 데이터 바인딩 (binding_index 순서). 빈 배열이면 data_bindings 키를 생략. */
  bindings: DataBinding[];
  loadState: LoadModelState;
  criteria: CriteriaState;
  measurePhases: boolean;
  /** open-loop 무시 토글 값(RunDialog 전용). 아래 scenarioHasThink와 함께 게이트. */
  applyScenarioThink?: boolean;
  /** 시나리오에 think가 있는가(RunDialog가 scenarioHasThink로 계산). 없으면 필드 생략. */
  scenarioHasThink?: boolean;
};

export function buildProfile(i: ProfileFormInput): Profile {
  return {
    loop_breakdown_cap: i.hasLoop ? i.loopCap : 0,
    http_timeout_seconds: i.httpTimeout,
    // 신규 다중 바인딩만 WRITE한다 — 레거시 data_binding 키는 더 이상 쓰지 않는다(읽기 호환만).
    // 빈 배열이면 키 자체를 생략(byte-identical to 바인딩 없는 제출).
    data_bindings: i.bindings.length ? i.bindings : undefined,
    criteria: buildCriteria(i.criteria),
    measure_phases: i.measurePhases,
    ...buildLoadProfile(i.loadState),
    // open-loop이고 시나리오에 think가 있을 때만 필드를 실는다 → closed·no-think open은
    // byte-identical(필드 부재). 미전달(ScheduleForm)이면 scenarioHasThink=undefined→생략.
    ...(i.loadState.loadModel === "open" && i.scenarioHasThink
      ? { apply_scenario_think_time: !!i.applyScenarioThink }
      : {}),
  };
}
