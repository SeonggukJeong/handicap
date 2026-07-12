import type { Run } from "../api/schemas";
import type { Step } from "../scenario/model";
import { formatDurationKo } from "../i18n/duration";
import { ko } from "../i18n/ko";

/** RunDialog 닫힌 루프 사이징 헬퍼의 순수 계산. React 의존 없음 — 단위 테스트 대상.
 *  Little's Law: closed-loop에서 목표 RPS를 내려면 VU ≈ 목표RPS ÷ (VU당 RPS). */

export type ThroughputSource =
  | { kind: "prior"; priorVus: number; priorRps: number }
  | { kind: "measured"; reqPerIter: number; iterMs: number }
  | { kind: "estimate"; reqPerIter: number; iterMs: number };

export type SizingResult = {
  recommendedVus: number;
  rpsPerVu: number;
  basis: ThroughputSource["kind"];
};

/** 목표 도착률(초당 반복) 유효 범위 = loadModelErrors의 targetRps와 동일(정수 1..=1_000_000). */
export function targetRpsValid(targetRps: number): boolean {
  return Number.isInteger(targetRps) && targetRps >= 1 && targetRps <= 1_000_000;
}

function rpsPerVuOf(src: ThroughputSource): number {
  if (src.kind === "prior") return src.priorRps / src.priorVus;
  return src.reqPerIter / (src.iterMs / 1000);
}

/** 목표 RPS + 처리량 출처 → 권장 VU(하한). 계산 불가(목표 무효/처리량 0·NaN·Inf)면 null. */
export function recommendVus(targetRps: number, src: ThroughputSource): SizingResult | null {
  if (!targetRpsValid(targetRps)) return null;
  const rpsPerVu = rpsPerVuOf(src);
  if (!Number.isFinite(rpsPerVu) || rpsPerVu <= 0) return null;
  const recommendedVus = Math.max(1, Math.ceil(targetRps / rpsPerVu));
  return { recommendedVus, rpsPerVu, basis: src.kind };
}

/** 가장 최근 종료(completed)된 균등-VU(closed+fixed) run.
 *  open-loop·VU곡선은 profile.vus==0이라(loadModel.ts:54 build, api/runs.rs:215 validate)
 *  vus>0 한 조건이 둘 다 제외해 단일-VU 권장에 적합한 앵커만 남긴다. 없으면 null. */
export function pickLatestClosedRun(runs: Run[]): Run | null {
  let best: Run | null = null;
  for (const r of runs) {
    if (r.status !== "completed") continue;
    if (r.profile.vus <= 0) continue;
    if (best === null || r.created_at > best.created_at) best = r;
  }
  return best;
}

const SIZE_PRESET_MULTIPLIERS = [0.5, 1, 2] as const;

/** "빠른 입력" 크기 칩 3개. anchor 있으면 그 VU·duration의 0.5×/1×/2×(최소 1 클램프,
 *  반올림)로 계산 — 계산된 (vus,durationSeconds) 쌍이 배수 순서상 이전 항목과 완전히
 *  같으면 그 칩은 건너뛴다(예: anchor.vus=1이면 0.5×/1× 모두 1로 collapse). anchor
 *  없으면 ko.ts 고정 3개(spread 복사 — `ko`가 `as const`라 원본은 readonly tuple,
 *  그대로 반환하면 mutable 반환타입과 안 맞아 tsc -b가 거부한다). */
export function sizePresetsFor(
  anchor: { vus: number; durationSeconds: number } | null,
): { label: string; vus: number; durationSeconds: number }[] {
  if (anchor === null) return [...ko.loadModel.sizePresets];
  const seen = new Set<string>();
  const presets: { label: string; vus: number; durationSeconds: number }[] = [];
  for (const m of SIZE_PRESET_MULTIPLIERS) {
    const vus = Math.max(1, Math.round(anchor.vus * m));
    const durationSeconds = Math.max(1, Math.round(anchor.durationSeconds * m));
    const key = `${vus}:${durationSeconds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({
      label: `${vus}명 · ${formatDurationKo(durationSeconds)}`,
      vus,
      durationSeconds,
    });
  }
  return presets;
}

/** 열린 루프 슬롯(max_in_flight) 사이징의 순수 계산. Little's Law: 동시 슬롯 ≈ 도착률 × **반복 1회
 *  점유시간**. post-hoc `load_gen_saturated` 인사이트의 `recommended = ceil(target_eff × M ÷
 *  achieved_arrival_rate)`(M=max_in_flight)와 같은 Little's law — 사후는 실측(hold = M ÷ achieved),
 *  사전(이 함수)은 `iterationHoldMs` 추정. 컨트롤러: crates/controller/src/insights.rs. */

/** 반복 1회 점유시간(ms) 추정 — iterationTimeUpperBoundSeconds(openLoopChecks.ts:27) 구조 미러.
 *  용도가 다르다: 그쪽은 상한(스텝 timeout·think max, inert_slots 경고용), 이쪽은 추정
 *  (관측 p50 ?? fallback + think 평균 (min+max)/2, 슬롯 권장용). http leaf 0개면 0(호출부 skip).
 *  ADR-0046 R7. */
export function iterationHoldMs(
  steps: ReadonlyArray<Step>,
  perStepP50: ReadonlyMap<string, number>,
  fallbackMs: number,
): number {
  let total = 0;
  for (const s of steps) {
    if (s.type === "http") {
      const lat = perStepP50.get(s.id) ?? fallbackMs;
      const think = s.think_time ? (s.think_time.min_ms + s.think_time.max_ms) / 2 : 0;
      total += lat + think;
    } else if (s.type === "loop") {
      total += s.repeat * iterationHoldMs(s.do, perStepP50, fallbackMs);
    } else if (s.type === "parallel") {
      let mx = 0;
      for (const b of s.branches) {
        mx = Math.max(mx, iterationHoldMs(b.steps, perStepP50, fallbackMs));
      }
      total += mx;
    } else {
      // if — 단일 분기만 실행 → max 분기 (iterationTimeUpperBoundSeconds와 동일 정책)
      let mx = iterationHoldMs(s.then, perStepP50, fallbackMs);
      for (const e of s.elif) {
        mx = Math.max(mx, iterationHoldMs(e.then, perStepP50, fallbackMs));
      }
      mx = Math.max(mx, iterationHoldMs(s.else, perStepP50, fallbackMs));
      total += mx;
    }
  }
  return total;
}

export type RequestRange = { min: number; max: number };

/** 반복 1회가 발사하는 HTTP 요청 수 범위 — iterationHoldMs(위)와 동형 재귀지만 집계 축이 다르다:
 *  시간은 parallel=분기 max(동시 실행)지만 **요청 수는 parallel=분기 합**(전 분기 모두 실행).
 *  if는 정확히 한 분기만 실행 → [분기별 min의 최소, 분기별 max의 최대](else 부재=빈 배열=0건).
 *  loop = repeat ×. http leaf 0개면 {min:0,max:0} → 호출부 skip(환산 힌트 미표시).
 *  ADR-0046 슬라이스 ② — "≈ 초당 요청 N건" 환산의 반복당 요청 수. */
export function iterationRequestRange(steps: ReadonlyArray<Step>): RequestRange {
  let min = 0;
  let max = 0;
  for (const s of steps) {
    if (s.type === "http") {
      min += 1;
      max += 1;
    } else if (s.type === "loop") {
      const r = iterationRequestRange(s.do);
      min += s.repeat * r.min;
      max += s.repeat * r.max;
    } else if (s.type === "parallel") {
      for (const b of s.branches) {
        const r = iterationRequestRange(b.steps);
        min += r.min;
        max += r.max;
      }
    } else {
      // if — 단일 분기 실행: then / elif[].then / else 전체에서 min/max
      const branches = [s.then, ...s.elif.map((e) => e.then), s.else];
      let bmin = Infinity;
      let bmax = 0;
      for (const b of branches) {
        const r = iterationRequestRange(b);
        bmin = Math.min(bmin, r.min);
        bmax = Math.max(bmax, r.max);
      }
      min += bmin;
      max += bmax;
    }
  }
  return { min, max };
}

export type SlotSizingResult = { recommendedSlots: number };

/** 목표 도착률 + 반복 1회 점유시간(ms, `iterationHoldMs`/실측/수동입력) → 권장 max_in_flight(하한).
 *  구현식은 무변경(`ceil(target × ms/1000)`) — 2번째 인자의 *의미*만 "요청당 지연"에서 "반복
 *  점유시간"으로 바뀐다(ADR-0046 R6). 계산 불가(목표 무효 / 점유시간 0·음수·NaN·Inf)면 null. */
export function recommendSlots(targetRps: number, holdMs: number): SlotSizingResult | null {
  if (!targetRpsValid(targetRps)) return null;
  if (!Number.isFinite(holdMs) || holdMs <= 0) return null;
  // ceil(target * (hold/1000)), 최소 1 — insights.rs 사후 recommended와 같은 Little's law.
  const recommendedSlots = Math.max(1, Math.ceil(targetRps * (holdMs / 1000)));
  return { recommendedSlots };
}

/** 가장 최근 종료(completed)된 open-loop run.
 *  open-loop 판별 = is_open_loop 양성 식(target_rps 있음 OR stages 비어있지 않음) —
 *  컨트롤러 Profile::is_open_loop()(store/runs.rs:149-151)와 1:1. max_in_flight는 판별자로
 *  쓰지 않는다(closed+fixed가 stray max_in_flight를 달 수 있음 — spec §5.1). closed+fixed(vus>0)·
 *  VU곡선(vu_stages)을 모두 제외. 없으면 null. */
export function pickLatestOpenRun(runs: Run[]): Run | null {
  let best: Run | null = null;
  for (const r of runs) {
    if (r.status !== "completed") continue;
    const p = r.profile;
    const isOpen = p.target_rps != null || (p.stages != null && p.stages.length > 0);
    if (!isOpen) continue;
    if (best === null || r.created_at > best.created_at) best = r;
  }
  return best;
}

/** 워커 앵커용: 가장 최근 종료된 '고정 rate' open-loop run(target_rps 있음)만.
 *  곡선 prior는 달성 도착률 산출에 stages 적분이 필요해 제외(ADR-0046 §7 연기). */
export function pickLatestFixedOpenRun(runs: Run[]): Run | null {
  let best: Run | null = null;
  for (const r of runs) {
    if (r.status !== "completed") continue;
    if (r.profile.target_rps == null) continue;
    if (best === null || r.created_at > best.created_at) best = r;
  }
  return best;
}

/** open+curve(stages)에서 권장 슬롯 기준이 되는 '최고 단계 목표'(peak).
 *  max_in_flight는 run 전체 단일값이라 도착률이 가장 높은 단계 기준으로 사이징해야
 *  어느 단계에서도 drop이 없다. 사후 load_gen_saturated의 곡선 유효목표 도출
 *  (controller report.rs:616-621 `stages.iter().map(|st| st.target).max()`)과 동일 수식.
 *  stages는 문자열 드래프트라 유효 정수(targetRpsValid, 1..=1_000_000)만 후보; 없으면 null. */
export function peakStageTarget(stages: { target: string }[]): number | null {
  let peak: number | null = null;
  for (const s of stages) {
    const n = Number(s.target);
    if (!targetRpsValid(n)) continue;
    if (peak === null || n > peak) peak = n;
  }
  return peak;
}

/** Proportionally scale a VU curve so its peak == achievable (capacity clamp).
 * Each stage.target *= achievable/peak, rounded; the largest stage is floored at
 * >=1 so the curve never collapses to all-zero (engine rejects no-positive-stage).
 * Strings in/out (RunDialog stage rows are string-draft). */
export function scaleVuStages(
  stages: { target: string; duration_seconds: string }[],
  achievable: number,
  peak: number,
): { target: string; duration_seconds: string }[] {
  const factor = peak > 0 ? achievable / peak : 0;
  return stages.map((s) => {
    const t = Number(s.target);
    const scaled = Number.isFinite(t) ? Math.round(t * factor) : 0;
    // peak stage floor: the stage equal to peak must stay >=1.
    const floored = t === peak ? Math.max(scaled, 1) : scaled;
    return { target: String(floored), duration_seconds: s.duration_seconds };
  });
}

/** 열린 루프 워커 수(worker_count) create-time 사이징의 순수 계산. (ADR-0038 멀티워커 fan-out,
 *  ADR-0046 R10 단위 통일) 워커당 도착률 천장은 워커를 포화시켰을 때만 관측되므로, prior 고정
 *  rate open-loop run의 **달성 도착률**(관측 요청-peak 아님 — 구 request-peak 혼용 제거)/워커수로
 *  외삽한다. `pickLatestFixedOpenRun`로 곡선 prior는 앵커에서 제외(§7 연기). */

export type WorkerSizingResult = { recommendedWorkers: number };

/** report.windows(초별 (ts,step) count 행 — A3b 워커 머지 후)에서 초별 throughput(요청/초) 천장.
 *  초별 Σcount의 최대. ADR-0046(R10)으로 워커 앵커가 달성 도착률 기반이 되며 소비처가 없어졌지만
 *  표시용 관측 peak 후보로 유지(슬라이스 ① 결정 — 삭제 아님).
 *  insights.rs load_gen_saturated arm의 by_sec와 동형(라인 고정 참조는 두지 않는다 — drift). */
export function peakThroughput(windows: { ts_second: number; count: number }[]): number {
  const bySec = new Map<number, number>();
  for (const w of windows) {
    bySec.set(w.ts_second, (bySec.get(w.ts_second) ?? 0) + w.count);
  }
  let peak = 0;
  for (const v of bySec.values()) if (v > peak) peak = v;
  return peak;
}

/** 목표 도착률(반복/초) + prior run **달성 도착률**·워커수 → 권장 worker_count(하한). (ADR-0046 R10
 *  — 2번째 인자 의미 교체: 구 관측 요청-peak → 달성 도착률, 단위 혼용 제거)
 *  N = max(1, ceil(target × prior_wc / achieved)). 각 워커에 prior가 증명한 속도(achieved/wc)
 *  이하만 요구하므로 엔진 drop 측면 항상 안전(포화면 tight, 비포화면 보수적 상한). m>wc 발사
 *  가드는 사후 전용(현재 wc 대비 증설 제안)이라 create-time엔 없다 — 복원 금지.
 *  무효(목표 무효 / achieved<=0·NaN·Inf / wc<1·비정수)면 null. */
export function recommendWorkers(
  target: number,
  priorAchievedPerSec: number,
  priorWorkerCount: number,
): WorkerSizingResult | null {
  if (!targetRpsValid(target)) return null;
  if (!Number.isFinite(priorAchievedPerSec) || priorAchievedPerSec <= 0) return null;
  if (!Number.isInteger(priorWorkerCount) || priorWorkerCount < 1) return null;
  const recommendedWorkers = Math.max(
    1,
    Math.ceil((target * priorWorkerCount) / priorAchievedPerSec),
  );
  return { recommendedWorkers };
}
