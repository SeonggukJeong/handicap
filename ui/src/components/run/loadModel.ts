import type { Profile, StairConfig, SteadyConfig } from "../../api/schemas";
import { draftToStairConfig, stairErrors, type StairDraft } from "./stair";

/** RunDialog가 소유하는 부하-모델 관련 state(정규화 전 — 숫자/문자열 혼재). */
export type LoadModelState = {
  loadModel: "closed" | "open";
  rateMode: "fixed" | "curve" | "stair";
  vus: number;
  duration: number;
  rampUp: number; // closed 고정의 상승
  rampOpen: number; // open 고정의 상승 — rampUp과 칸이 따로다
  discard: number; // 두 고정 모드 공용 앞부분 버림(초)
  targetRps: string;
  maxInFlight: string;
  stages: { target: string; duration_seconds: string }[];
  thinkMin: string;
  thinkMax: string;
  thinkSeed: string;
  rampDown: "graceful" | "immediate";
  workerCount: string; // open 전용 fan-out 노브 (string draft, 빈칸/1 = 미설정)
  // graceful ramp-down 상한(초, §B9). string draft — 빈칸 = 무제한(미설정). closed+curve+
  // graceful일 때만 유효.
  gracefulCap: string;
  stair: StairDraft; // rateMode "stair"(open 전용)일 때만 emit
};

/** buildLoadProfile이 채우는 Profile의 부분집합. 나머지(loop_breakdown_cap/
 *  http_timeout_seconds/data_binding/criteria)는 RunDialog의 `base`가 채운다. */
export type LoadProfileFields = Pick<Profile, "vus" | "duration_seconds" | "ramp_up_seconds"> &
  Partial<
    Pick<
      Profile,
      | "think_time"
      | "think_seed"
      | "target_rps"
      | "max_in_flight"
      | "stages"
      | "stair"
      | "vu_stages"
      | "ramp_down"
      | "graceful_ramp_down_seconds"
      | "worker_count"
      | "steady"
    >
  >;

export type LoadModelErrors = {
  rampInvalid: boolean; // closed: rampUp > duration
  targetRpsInvalid: boolean; // open+fixed
  maxInFlightInvalid: boolean; // open (fixed·curve 공통)
  stagesInvalid: boolean; // curve (open+curve / closed+curve 공통)
  workerCountInvalid: boolean; // open (fixed·curve 공통, optional — 빈칸=미설정 허용)
  gracefulCapInvalid: boolean; // closed+curve+graceful (optional — 빈칸=무제한 허용)
  stairInvalid: boolean; // open+stair (목표 목록·유지·상승·버림·상한)
  steadyInvalid: boolean; // 고정 모드의 상승·버림이 성립하지 않고 제출할 수 없음
};

export type SteadyReason =
  | "ramp_ge_duration"
  | "hold_too_short"
  | "ramp_too_long"
  | "discard_too_long"
  | "hold_too_long"
  | "not_whole_seconds";

export type SteadyPlan =
  | { kind: "none" } // 상승 0·버림 0 또는 고정 모드가 아님
  | { kind: "send"; steady: SteadyConfig }
  | { kind: "fallback"; reason: SteadyReason } // closed·버림 0: steady 없이 제출
  | { kind: "error"; reason: SteadyReason }; // 제출 막음

/** 0 이상의 정수 초(NaN 포함 거부). 서버 steady의 u32 칸이 받는 값. */
export function isWholeSeconds(x: number): boolean {
  return Number.isInteger(x) && x >= 0;
}

/** 고정 모드의 상승·버림을 서버 `steady`로 보낼지 정한다(spec D8). */
export function steadyPlan(
  s: Pick<
    LoadModelState,
    "loadModel" | "rateMode" | "duration" | "rampUp" | "rampOpen" | "discard" | "targetRps"
  >,
): SteadyPlan {
  if (s.rateMode !== "fixed") return { kind: "none" };
  const open = s.loadModel === "open";
  const ramp = open ? s.rampOpen : s.rampUp;
  if (!isWholeSeconds(ramp) || !isWholeSeconds(s.discard)) {
    return { kind: "error", reason: "not_whole_seconds" };
  }
  if (ramp === 0 && s.discard === 0) return { kind: "none" };
  const hold = s.duration - ramp;
  let reason: SteadyReason | null = null;
  if (ramp >= s.duration) reason = "ramp_ge_duration";
  else if (hold - s.discard < 5) reason = "hold_too_short";
  else if (ramp > 3600) reason = "ramp_too_long";
  else if (s.discard > 3600) reason = "discard_too_long";
  else if (hold > 86400) reason = "hold_too_long";
  if (reason) {
    return !open && s.discard === 0 ? { kind: "fallback", reason } : { kind: "error", reason };
  }
  return {
    kind: "send",
    steady: {
      ramp_seconds: ramp,
      hold_seconds: hold,
      discard_seconds: s.discard,
      ...(open && ramp > 0 ? { target: Number(s.targetRps) } : {}),
    },
  };
}

/** 고정 모드의 목표 도착률. open-loop가 아니면 null. */
export function fixedTarget(p: {
  target_rps?: number | null;
  steady?: SteadyConfig | null;
}): number | null {
  return p.steady?.target ?? p.target_rps ?? null;
}

/** 저장본 → 폼 칸. steady가 있으면 그 값이 이긴다. */
export function steadyFormSeed(p: {
  duration_seconds: number;
  ramp_up_seconds?: number;
  target_rps?: number | null;
  steady?: SteadyConfig | null;
}): { rampUp: number; rampOpen: number; duration: number; discard: number } {
  const st = p.steady;
  if (!st) {
    return {
      rampUp: p.ramp_up_seconds ?? 0,
      rampOpen: 0,
      duration: p.duration_seconds,
      discard: 0,
    };
  }
  const open = st.target != null || p.target_rps != null;
  return {
    rampUp: open ? 0 : st.ramp_seconds,
    rampOpen: open ? st.ramp_seconds : 0,
    duration: st.ramp_seconds + st.hold_seconds,
    discard: st.discard_seconds,
  };
}

/** closed-loop think time. 둘 다 채워야 emit(한 칸만 채우면 undefined = 미설정). */
function buildThinkTime(s: LoadModelState): { min_ms: number; max_ms: number } | undefined {
  if (s.thinkMin.trim() === "" || s.thinkMax.trim() === "") return undefined;
  return { min_ms: Number(s.thinkMin), max_ms: Number(s.thinkMax) };
}

/** 모드별 Profile 필드를 만든다. 각 모드는 자기 필드만 emit해 서버 400 조합
 *  (open+ramp_up>0 / open+think_time / stages+target_rps / stages+duration>0)을
 *  표현 불가능하게 한다. `RunDialog.tsx:310-343`에서 이관. */
export function buildLoadProfile(s: LoadModelState): LoadProfileFields {
  if (s.loadModel === "closed" && s.rateMode === "curve") {
    return {
      vus: 0,
      duration_seconds: 0, // curve: 총 길이 = sum(vu_stages); 서버는 >0 + vu_stages를 400
      ramp_up_seconds: 0,
      vu_stages: s.stages.map((x) => ({
        target: Number(x.target),
        duration_seconds: Number(x.duration_seconds),
      })),
      think_time: buildThinkTime(s), // closed-loop이므로 허용 (spec §3.2)
      think_seed: s.thinkSeed.trim() !== "" ? Number(s.thinkSeed) : undefined,
      ...(s.rampDown === "immediate" ? { ramp_down: "immediate" as const } : {}),
      ...(s.rampDown === "graceful" && s.gracefulCap.trim() !== ""
        ? { graceful_ramp_down_seconds: Number(s.gracefulCap) }
        : {}),
      // NO target_rps, NO max_in_flight, NO stages
    };
  }
  if (s.loadModel === "open" && s.rateMode === "stair") {
    const stair = draftToStairConfig(s.stair);
    return {
      vus: 0,
      duration_seconds: 0, // 서버가 stair를 stages로 펼쳐 저장한다 — stages·target_rps는 보내지 않는다
      ramp_up_seconds: 0,
      max_in_flight: Number(s.maxInFlight),
      ...(stair ? { stair } : {}),
      ...(Number(s.workerCount) > 1 ? { worker_count: Number(s.workerCount) } : {}),
    };
  }
  if (s.loadModel === "open" && s.rateMode === "curve") {
    return {
      vus: 0,
      duration_seconds: 0, // curve: 총 길이 = sum(stages); 서버는 >0 + stages를 400
      ramp_up_seconds: 0,
      max_in_flight: Number(s.maxInFlight),
      stages: s.stages.map((x) => ({
        target: Number(x.target),
        duration_seconds: Number(x.duration_seconds),
      })),
      ...(Number(s.workerCount) > 1 ? { worker_count: Number(s.workerCount) } : {}),
      // NO target_rps, NO think_time
    };
  }
  const plan = steadyPlan(s);
  if (s.loadModel === "open") {
    if (plan.kind === "send" && plan.steady.target != null) {
      return {
        vus: 0,
        duration_seconds: 0, // 서버가 steady를 stages로 펼쳐 저장한다 — target_rps는 보내지 않는다
        ramp_up_seconds: 0,
        max_in_flight: Number(s.maxInFlight),
        steady: plan.steady,
        ...(Number(s.workerCount) > 1 ? { worker_count: Number(s.workerCount) } : {}),
      };
    }
    return {
      vus: 0,
      duration_seconds: s.duration,
      ramp_up_seconds: 0,
      target_rps: Number(s.targetRps),
      max_in_flight: Number(s.maxInFlight),
      ...(plan.kind === "send" ? { steady: plan.steady } : {}),
      ...(Number(s.workerCount) > 1 ? { worker_count: Number(s.workerCount) } : {}),
      // NO think_time — open-loop은 run-level think time 금지
    };
  }
  return {
    vus: s.vus,
    duration_seconds: s.duration,
    ramp_up_seconds: s.rampUp,
    think_time: buildThinkTime(s),
    think_seed: s.thinkSeed.trim() !== "" ? Number(s.thinkSeed) : undefined,
    ...(plan.kind === "send" ? { steady: plan.steady } : {}),
    // target_rps / max_in_flight 생략 → closed-loop byte-identical
  };
}

/** 모드별 입력 범위 검증 플래그. `RunDialog.tsx:208-258`에서 이관. 숫자 게이트는
 *  여기 + canSubmit(RunDialog)이 담당(§7.2) — buildLoadProfile은 형태만. */
export function loadModelErrors(s: LoadModelState): LoadModelErrors {
  const rampInvalid = s.rampUp > s.duration;
  const targetRpsNum = Number(s.targetRps);
  const maxInFlightNum = Number(s.maxInFlight);
  const targetRpsInvalid =
    s.targetRps.trim() === "" ||
    !Number.isInteger(targetRpsNum) ||
    targetRpsNum < 1 ||
    targetRpsNum > 1_000_000;
  const maxInFlightInvalid =
    s.maxInFlight.trim() === "" ||
    !Number.isInteger(maxInFlightNum) ||
    maxInFlightNum < 1 ||
    maxInFlightNum > 10_000;
  // curve 공통 (open+curve / closed+curve): open 전용 가드 제거
  const stagesInvalid =
    s.rateMode === "curve" &&
    (s.stages.length === 0 ||
      s.stages.some((x) => {
        const t = Number(x.target);
        const d = Number(x.duration_seconds);
        return (
          x.target.trim() === "" ||
          x.duration_seconds.trim() === "" ||
          !Number.isInteger(t) ||
          t < 0 ||
          t > 1_000_000 ||
          !Number.isInteger(d) ||
          d < 1
        );
      }) ||
      !s.stages.some((x) => Number(x.target) > 0));
  // worker_count: open 전용·선택적. 빈칸 = 미설정(valid). 채우면 1~64 정수.
  const wcNum = Number(s.workerCount);
  const workerCountInvalid =
    s.workerCount.trim() !== "" && (!Number.isInteger(wcNum) || wcNum < 1 || wcNum > 64);
  // graceful ramp-down 상한: closed+curve+graceful에서만 의미가 있고, 채우면 1 이상 정수.
  // 빈칸은 언제나 valid(무제한 = 미설정).
  const gracefulCapInvalid =
    s.loadModel === "closed" &&
    s.rateMode === "curve" &&
    s.rampDown === "graceful" &&
    s.gracefulCap.trim() !== "" &&
    (!Number.isInteger(Number(s.gracefulCap)) || Number(s.gracefulCap) < 1);
  const stairInvalid =
    s.loadModel === "open" &&
    s.rateMode === "stair" &&
    Object.keys(stairErrors(s.stair)).length > 0;
  const steadyInvalid = steadyPlan(s).kind === "error";
  return {
    rampInvalid,
    targetRpsInvalid,
    maxInFlightInvalid,
    stagesInvalid,
    workerCountInvalid,
    gracefulCapInvalid,
    stairInvalid,
    steadyInvalid,
  };
}

export type LoadMode = { loadModel: "closed" | "open"; rateMode: "fixed" | "curve" | "stair" };

/** profile → (loadModel, rateMode) 역도출 — RunDialog init / RunDialog loadPreset /
 *  ScheduleForm init 3사이트가 공유. 한 곳이라도 빠지면 vu_stages 든 프리셋이
 *  closed+fixed로 조용히 로드돼 곡선이 증발한다 (spec §6.3). */
export function deriveLoadMode(p: {
  stair?: StairConfig | null;
  steady?: SteadyConfig | null;
  target_rps?: number | null;
  stages?: { target: number; duration_seconds: number }[] | null;
  vu_stages?: { target: number; duration_seconds: number }[] | null;
}): LoadMode {
  // 저장본엔 stair와 서버가 펼친 stages가 함께 있다 — stair를 가장 먼저 본다.
  if (p.stair) return { loadModel: "open", rateMode: "stair" };
  if (p.steady) {
    return {
      loadModel: p.steady.target != null || p.target_rps != null ? "open" : "closed",
      rateMode: "fixed",
    };
  }
  if (p.vu_stages && p.vu_stages.length > 0) return { loadModel: "closed", rateMode: "curve" };
  if (p.stages && p.stages.length > 0) return { loadModel: "open", rateMode: "curve" };
  if (p.target_rps != null) return { loadModel: "open", rateMode: "fixed" };
  return { loadModel: "closed", rateMode: "fixed" };
}

export type VuDisplay =
  | { kind: "fixed"; vus: number } // closed+fixed → 숫자 그대로
  | { kind: "curve"; peak: number } // closed+curve → "최대 N (곡선)"
  | { kind: "open" }; // open-loop(고정/곡선) → "—"

/** 한 run의 VU 표시 방식. closed+fixed→리터럴 `vus`; closed+curve(vu_stages)→곡선 최고점
 *  (max target)을 "최대 N (곡선)"으로; open-loop(target_rps/stages)는 VU 개념이 없어 "—".
 *  모드 역도출은 deriveLoadMode 단일 소스(곡선 증발 drift 방지). 읽는 필드만 Pick해
 *  RunSchema.profile(nested-default leak)을 normalizeProfile 없이 수용(profileDurationSeconds
 *  패턴 — 이 4필드는 .default()가 없어 leak-free). */
export function profileVuDisplay(
  profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages"> &
    Partial<Pick<Profile, "stair">>,
): VuDisplay {
  const { loadModel, rateMode } = deriveLoadMode(profile);
  if (loadModel === "open") return { kind: "open" };
  if (rateMode === "curve")
    return { kind: "curve", peak: Math.max(...(profile.vu_stages ?? []).map((s) => s.target)) };
  return { kind: "fixed", vus: profile.vus };
}
