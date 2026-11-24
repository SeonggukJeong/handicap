import type { Criteria, DataBinding, Profile } from "../../api/schemas";
import { buildLoadProfile, type LoadModelState } from "./loadModel";
import { parsePercentileMetric, percentileMetricName } from "../../api/percentileName";
import { ko } from "../../i18n/ko";

/** step-level SLO 한 행의 draft 상태(threshold는 rate metric이면 % 표시, 저장은 분수). */
export type StepCriterionDraft = {
  target: string;
  metric: string;
  op: "max" | "min";
  threshold: string; // rate metric은 % 표시(저장은 분수)
  /** 「백분위」 행(metric === "percentile")의 N 글자. 다른 항목이면 "". */
  p: string;
};

/** run 백분위 기준 한 행의 draft(p = N 글자, ms = 기준값). ms가 빈 행은 보내지 않는다. */
export type PercentileDraft = { p: string; ms: string };

export const NEW_PERCENTILE_ROW: PercentileDraft = { p: "90", ms: "" };
export const MAX_PERCENTILE_ROWS = 10;

/** 스텝 「백분위」 행의 metric 표지. */
const PERCENTILE_MARK = "percentile";
const FIXED_PERCENTILE_NAMES = new Set(["p50_ms", "p95_ms", "p99_ms"]);

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
  maxMean: string; // ms(소수 가능)
  maxMax: string; // ms(소수 가능)
  percentiles: PercentileDraft[];
  stepCriteria: StepCriterionDraft[];
};

/** 문자열 한 칸으로 들어가는 기준 키(배열 칸 제외). */
export type StringCriteriaKey = Exclude<keyof CriteriaState, "stepCriteria" | "percentiles">;

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
  maxMean: "",
  maxMax: "",
  percentiles: [],
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
    maxMean: numToStr(c?.max_mean_ms),
    maxMax: numToStr(c?.max_max_ms),
    percentiles: (c?.max_percentiles_ms ?? []).map((r) => ({
      p: String(r.percentile),
      ms: String(r.max_ms),
    })),
    stepCriteria: (c?.step_criteria ?? []).map((r) => {
      // p50·p95·p99는 기존 항목으로 열고, 그 밖의 정본 이름만 「백분위」 행으로 연다.
      const n = FIXED_PERCENTILE_NAMES.has(r.metric) ? null : parsePercentileMetric(r.metric);
      return {
        target: r.target,
        metric: n === null ? r.metric : PERCENTILE_MARK,
        op: r.op,
        threshold: RATE_METRICS.has(r.metric) ? String(r.threshold * 100) : String(r.threshold),
        p: n === null ? "" : String(n),
      };
    }),
  };
}

export function criteriaHasValue(s: CriteriaState): boolean {
  const { stepCriteria, percentiles, ...rest } = s;
  if (stepCriteria.length > 0) return true;
  if (percentiles.some((r) => r.ms.trim() !== "")) return true;
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
      s.maxMean,
      s.maxMax,
    ].filter((v) => v.trim() !== "").length +
    s.percentiles.filter((r) => r.ms.trim() !== "").length +
    s.stepCriteria.length
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
  if (s.maxMean.trim() !== "") c.max_mean_ms = Number(s.maxMean);
  if (s.maxMax.trim() !== "") c.max_max_ms = Number(s.maxMax);
  const pcts: NonNullable<Criteria["max_percentiles_ms"]> = [];
  for (const r of s.percentiles) {
    if (r.ms.trim() === "") continue;
    const name = percentileMetricName(r.p);
    const n = name === null ? null : parsePercentileMetric(name);
    if (n === null) continue; // 검사가 막는다 — 방어
    pcts.push({ percentile: n, max_ms: Number(r.ms) });
  }
  if (pcts.length > 0) c.max_percentiles_ms = pcts;
  const steps = s.stepCriteria
    .filter((r) => r.target.trim() !== "" && r.threshold.trim() !== "")
    .flatMap((r) => {
      const metric = r.metric === PERCENTILE_MARK ? percentileMetricName(r.p) : r.metric;
      if (metric === null) return []; // 검사가 막는다 — 방어
      return [
        {
          metric,
          op: r.op,
          target: r.target,
          threshold: RATE_METRICS.has(metric) ? Number(r.threshold) / 100 : Number(r.threshold),
        },
      ];
    });
  if (steps.length > 0) c.step_criteria = steps;
  return Object.keys(c).length > 0 ? c : undefined;
}

/** 새 시간 값 칸의 검사 — 서버 validate_criteria와 같은 규칙(유한·0 이상·60,000 이하·소수 3자리). */
export function timeValueError(text: string): string | undefined {
  if (text.trim() === "") return undefined;
  const x = Number(text);
  if (!Number.isFinite(x) || x < 0 || x > 60000) return ko.criteria.errTime;
  if (Math.abs(x * 1000 - Math.round(x * 1000)) >= 1e-6) return ko.criteria.errTime;
  return undefined;
}

export type CriteriaErrors = {
  maxMean?: string;
  maxMax?: string;
  percentiles: Array<{ p?: string; ms?: string }>;
  percentilesList?: string;
  steps: Array<{ p?: string; threshold?: string }>;
};

/** 백분위 N 글자 → 오류 문구 또는 정본 이름. */
function percentileNameError(text: string): { error: string } | { name: string } {
  if (text.trim() === "") return { error: ko.criteria.errPercentileMissing };
  const name = percentileMetricName(text);
  if (name === null) return { error: ko.criteria.errPercentileRange };
  return { name };
}

const nOf = (name: string) => String(parsePercentileMetric(name));

export function criteriaErrors(s: CriteriaState): CriteriaErrors {
  const seen = new Set<string>();
  let sent = 0;
  const percentiles = s.percentiles.map((r) => {
    if (r.ms.trim() === "") return {}; // 보내지 않는 행 — 검사도 같은 N 비교도 하지 않는다
    sent += 1;
    const out: { p?: string; ms?: string } = {};
    const res = percentileNameError(r.p);
    if ("error" in res) out.p = res.error;
    else if (FIXED_PERCENTILE_NAMES.has(res.name))
      out.p = ko.criteria.errPercentileFixed(nOf(res.name));
    else if (seen.has(res.name)) out.p = ko.criteria.errPercentileDuplicate(nOf(res.name));
    else seen.add(res.name);
    const ms = timeValueError(r.ms);
    if (ms) out.ms = ms;
    return out;
  });
  const steps = s.stepCriteria.map((r) => {
    const out: { p?: string; threshold?: string } = {};
    if (r.threshold.trim() === "") return out; // 보내지 않는 행
    if (r.metric === PERCENTILE_MARK) {
      const res = percentileNameError(r.p);
      if ("error" in res) out.p = res.error;
      else if (!FIXED_PERCENTILE_NAMES.has(res.name)) {
        const t = timeValueError(r.threshold);
        if (t) out.threshold = t;
      }
    } else if (r.metric === "mean_ms" || r.metric === "max_ms") {
      const t = timeValueError(r.threshold);
      if (t) out.threshold = t;
    }
    return out;
  });
  return {
    maxMean: timeValueError(s.maxMean),
    maxMax: timeValueError(s.maxMax),
    percentiles,
    ...(sent > MAX_PERCENTILE_ROWS ? { percentilesList: ko.criteria.errPercentilesMax } : {}),
    steps,
  };
}

export function hasCriteriaErrors(e: CriteriaErrors): boolean {
  return (
    !!e.maxMean ||
    !!e.maxMax ||
    !!e.percentilesList ||
    e.percentiles.some((r) => !!r.p || !!r.ms) ||
    e.steps.some((r) => !!r.p || !!r.threshold)
  );
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
  /**
   * connect 단계 전용 타임아웃 draft(초). 빈 문자열/미전달 = 미설정 → 키 자체 생략.
   * RunDialog·ScheduleForm 둘 다 입력을 소유한다(timeout-knob-ui).
   */
  connectTimeout?: string;
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
    // 빈칸/미전달이면 키 자체가 없다(byte-identical). undefined 대입이 아니라 spread —
    // 대입하면 키가 present-but-undefined로 남아 toHaveProperty가 참이 된다.
    ...(i.connectTimeout && i.connectTimeout.trim() !== ""
      ? { connect_timeout_seconds: Number(i.connectTimeout) }
      : {}),
  };
}

/** connect timeout draft(문자열)의 폼-레벨 유효성 — RunDialog·ScheduleForm 공유(spec §3-2).
 *  빈/공백 문자열 = 미설정(유효 — buildProfile이 키를 생략한다). 서버
 *  validate_run_config(1..=600 ∧ < http_timeout)와 lockstep. true = invalid. */
export function isConnectTimeoutDraftInvalid(draft: string, httpTimeout: number): boolean {
  if (draft.trim() === "") return false;
  const n = Number(draft);
  return !Number.isInteger(n) || n < 1 || n > 600 || n >= httpTimeout;
}
