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
