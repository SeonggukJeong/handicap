import type { Scenario, Step, ThinkTime } from "../scenario/model";
import { peakStageTarget, targetRpsValid } from "./sizing";

/** create-time open-loop 구조 경고(순수·결정적·측정 없음). spec 2026-06-25-open-loop-misconfig-warning.
 *  ① 곡선 fan-out 유휴 워커, ② inert max_in_flight. false-positive 0(아래 주석). */

export type OpenLoopWarning =
  | { kind: "idle_workers"; workers: number; peak: number; idle: number }
  | { kind: "inert_slots"; maxInFlight: number; threshold: number };

export type OpenLoopInput = {
  loadModel: "closed" | "open";
  rateMode: "fixed" | "curve";
  targetRps: string;
  maxInFlight: string;
  stages: { target: string; duration_seconds: string }[];
  workerCount?: string; // string draft, 미설정/"" → 1
  httpTimeoutSeconds?: number; // RunDialog http_timeout; undefined → ② skip
  scenario: Scenario | null; // typed model; null → ② skip
  poolMode?: boolean; // true → 둘 다 skip (R13: pool은 worker_count 무시·per-worker 분할)
};

/** 한 반복(전체 시나리오)의 월-타임 *상한*(초). 과대추정이라 ②가 over-warn하지 않는다(R3):
 *  http leaf = (step timeout ?? httpTimeout) + per-step think max; 순차=합; loop=repeat×;
 *  if=분기 max(한 분기만 실행); parallel=분기 max(한 슬롯서 동시). flattenHttpSteps와 동형 재귀.
 *  http leaf 없으면 0 → 호출부가 ② skip(fail-safe). */
export function iterationTimeUpperBoundSeconds(
  steps: ReadonlyArray<Step>,
  httpTimeoutSec: number,
  /** 시나리오 기본 think time(상속 스텝의 상한에 max_ms를 더한다). parallel 분기 재귀엔 미전달 — 엔진 R4 미러. */
  defaultThink?: ThinkTime,
): number {
  let total = 0;
  for (const s of steps) {
    if (s.type === "http") {
      const stepTimeout = s.timeout_seconds ?? httpTimeoutSec;
      const thinkMs = (s.think_time ?? defaultThink)?.max_ms ?? 0;
      total += stepTimeout + thinkMs / 1000;
    } else if (s.type === "loop") {
      total += s.repeat * iterationTimeUpperBoundSeconds(s.do, httpTimeoutSec, defaultThink);
    } else if (s.type === "parallel") {
      let mx = 0;
      for (const b of s.branches) {
        mx = Math.max(mx, iterationTimeUpperBoundSeconds(b.steps, httpTimeoutSec)); // 분기엔 기본값 미적용
      }
      total += mx;
    } else {
      // if — 단일 분기만 실행 → 상한 = then/elif[].then/else 중 max
      let mx = iterationTimeUpperBoundSeconds(s.then, httpTimeoutSec, defaultThink);
      for (const e of s.elif) {
        mx = Math.max(mx, iterationTimeUpperBoundSeconds(e.then, httpTimeoutSec, defaultThink));
      }
      mx = Math.max(mx, iterationTimeUpperBoundSeconds(s.else, httpTimeoutSec, defaultThink));
      total += mx;
    }
  }
  return total;
}

export function openLoopWarnings(input: OpenLoopInput): OpenLoopWarning[] {
  const {
    loadModel,
    rateMode,
    targetRps,
    maxInFlight,
    stages,
    workerCount,
    httpTimeoutSeconds,
    scenario,
    poolMode,
  } = input;
  if (loadModel !== "open") return [];
  if (poolMode === true) return []; // R13

  const out: OpenLoopWarning[] = [];
  const peak = peakStageTarget(stages); // number | null (string-draft, 유효 정수만)
  const W = Number(workerCount || "1"); // 빈 draft("")는 1로 취급(spec §4.1)

  // ① 곡선 fan-out 유휴 워커 — W > peak면 (W-peak)개 워커가 0-share로 유휴.
  //    고정 모드는 worker_count>target_rps가 이미 400이라 발생 불가 → 곡선 한정.
  if (rateMode === "curve" && peak != null && Number.isInteger(W) && W > peak) {
    out.push({ kind: "idle_workers", workers: W, peak, idle: W - peak });
  }

  // ② inert max_in_flight — 단일 워커(W≤1)·비-pool에서만(per-worker==aggregate, 분할 없음 → false-positive 0).
  //    R = 유효 도착률(고정 target_rps / 곡선 peak), T = 반복-시간 상한.
  //    M ≥ ceil(R×T)면 슬롯이 절대 고갈 불가 → max_in_flight 무의미.
  const R =
    rateMode === "curve" ? peak : targetRpsValid(Number(targetRps)) ? Number(targetRps) : null;
  if (scenario != null && httpTimeoutSeconds != null && W <= 1 && R != null && R > 0) {
    const T = iterationTimeUpperBoundSeconds(
      scenario.steps,
      httpTimeoutSeconds,
      scenario.default_think_time,
    );
    const M = Number(maxInFlight);
    if (T > 0 && Number.isFinite(M) && M >= 1 && M >= Math.ceil(R * T)) {
      out.push({ kind: "inert_slots", maxInFlight: M, threshold: Math.ceil(R * T) });
    }
  }
  return out;
}
