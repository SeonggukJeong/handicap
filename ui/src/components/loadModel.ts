import type { Profile } from "../api/schemas";

/** RunDialog가 소유하는 부하-모델 관련 state(정규화 전 — 숫자/문자열 혼재). */
export type LoadModelState = {
  loadModel: "closed" | "open";
  rateMode: "fixed" | "curve";
  vus: number;
  duration: number;
  rampUp: number;
  targetRps: string;
  maxInFlight: string;
  stages: { target: string; duration_seconds: string }[];
  thinkMin: string;
  thinkMax: string;
  thinkSeed: string;
  rampDown: "graceful" | "immediate";
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
      | "vu_stages"
      | "ramp_down"
    >
  >;

export type LoadModelErrors = {
  rampInvalid: boolean; // closed: rampUp > duration
  targetRpsInvalid: boolean; // open+fixed
  maxInFlightInvalid: boolean; // open (fixed·curve 공통)
  stagesInvalid: boolean; // curve (open+curve / closed+curve 공통)
};

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
      // NO target_rps, NO max_in_flight, NO stages
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
      // NO target_rps, NO think_time
    };
  }
  if (s.loadModel === "open") {
    return {
      vus: 0,
      duration_seconds: s.duration,
      ramp_up_seconds: 0,
      target_rps: Number(s.targetRps),
      max_in_flight: Number(s.maxInFlight),
      // NO think_time — open-loop은 run-level think time 금지
    };
  }
  return {
    vus: s.vus,
    duration_seconds: s.duration,
    ramp_up_seconds: s.rampUp,
    think_time: buildThinkTime(s),
    think_seed: s.thinkSeed.trim() !== "" ? Number(s.thinkSeed) : undefined,
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
  return { rampInvalid, targetRpsInvalid, maxInFlightInvalid, stagesInvalid };
}

export type LoadMode = { loadModel: "closed" | "open"; rateMode: "fixed" | "curve" };

/** profile → (loadModel, rateMode) 역도출 — RunDialog init / RunDialog loadPreset /
 *  ScheduleForm init 3사이트가 공유. 한 곳이라도 빠지면 vu_stages 든 프리셋이
 *  closed+fixed로 조용히 로드돼 곡선이 증발한다 (spec §6.3). */
export function deriveLoadMode(p: {
  target_rps?: number | null;
  stages?: { target: number; duration_seconds: number }[] | null;
  vu_stages?: { target: number; duration_seconds: number }[] | null;
}): LoadMode {
  if (p.vu_stages && p.vu_stages.length > 0) return { loadModel: "closed", rateMode: "curve" };
  if (p.stages && p.stages.length > 0) return { loadModel: "open", rateMode: "curve" };
  if (p.target_rps != null) return { loadModel: "open", rateMode: "fixed" };
  return { loadModel: "closed", rateMode: "fixed" };
}
