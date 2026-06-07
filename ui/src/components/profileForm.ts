import type { Criteria, DataBinding, Profile } from "../api/schemas";
import { buildLoadProfile, type LoadModelState } from "./loadModel";

/** 11개 SLO 입력의 string draft 상태(RunDialog/ScheduleForm 공유). */
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
  };
}

export function criteriaHasValue(s: CriteriaState): boolean {
  return Object.values(s).some((v) => v.trim() !== "");
}

/** 토글 hint용 — rps_warmup_seconds(수식자)는 제외, 실제 기준 10개만 카운트. */
export function criteriaActiveCount(s: CriteriaState): number {
  return [
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
  ].filter((v) => v.trim() !== "").length;
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
  return Object.keys(c).length > 0 ? c : undefined;
}

export type ProfileFormInput = {
  hasLoop: boolean;
  loopCap: number;
  httpTimeout: number;
  binding: DataBinding | null;
  loadState: LoadModelState;
  criteria: CriteriaState;
  measurePhases: boolean;
};

export function buildProfile(i: ProfileFormInput): Profile {
  return {
    loop_breakdown_cap: i.hasLoop ? i.loopCap : 0,
    http_timeout_seconds: i.httpTimeout,
    data_binding: i.binding ?? undefined,
    criteria: buildCriteria(i.criteria),
    measure_phases: i.measurePhases,
    ...buildLoadProfile(i.loadState),
  };
}
