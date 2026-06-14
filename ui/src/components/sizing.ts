import type { Run } from "../api/schemas";

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

/** 목표 RPS 유효 범위 = loadModelErrors의 targetRps와 동일(정수 1..=1_000_000). */
function targetRpsValid(targetRps: number): boolean {
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

/** 열린 루프 슬롯(max_in_flight) 사이징의 순수 계산. Little's Law: 동시 슬롯 ≈ 도착률 × 지연.
 *  post-hoc `load_gen_saturated` 인사이트의 `required = ceil(target_rps × p50_ms/1000)`와
 *  같은 수식·프록시(요청당 p50). 컨트롤러: crates/controller/src/insights.rs:222-227. */

export type SlotSizingResult = { recommendedSlots: number };

/** 목표 RPS + 지연(ms) → 권장 max_in_flight(하한). 계산 불가(목표 무효 / 지연 0·음수·NaN·Inf)면 null. */
export function recommendSlots(targetRps: number, latencyMs: number): SlotSizingResult | null {
  if (!targetRpsValid(targetRps)) return null;
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return null;
  // insights.rs:224 grouping: ceil(target * (latency/1000)), 최소 1.
  const recommendedSlots = Math.max(1, Math.ceil(targetRps * (latencyMs / 1000)));
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
