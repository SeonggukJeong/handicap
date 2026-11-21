import type { Insight, ReportBasis } from "../../api/schemas";

export type OpenLoopRates = {
  /** 목표 도착률(반복/초) — 곡선이면 최고 단계(피크) */
  target: number;
  /** stages 기반(피크 표기)이면 true */
  curve: boolean;
  /** 달성 도착률 — 고정 rate는 클라 산출, 곡선은 인사이트 있을 때만. 산출 불가 null */
  achieved: number | null;
};

type LooseProfile = {
  target_rps?: number | null;
  stages?: { target: number }[] | null;
  steady?: { target?: number } | null;
} | null;

/** run.profile(ReportRunSchema가 z.unknown())에서 open-loop 목표/달성 도착률 도출.
 *  target 도출은 controller report.rs의 target_eff(target_rps.or_else(stages peak))와 동일 수식
 *  (peakStageTarget과 같은 max — 단 여기 profile.stages는 서버 직렬화 숫자라 draft 파싱 불요).
 *  achieved 우선순위: ① load_gen_saturated 인사이트의 achieved_per_sec(서버 실측 — 곡선 포함)
 *  ② 고정 rate면 max(0, target − dropped/duration) — 서버 R2 achieved_arrival_rate와 동형
 *    (scheduled=target×duration이므로 (scheduled−dropped)/duration과 등가)
 *  ③ 곡선 + 인사이트 없음 → null(scheduled 적분의 UI 복제는 ADR-0046 §7 연기).
 *  도착률 고정 + 상승 run(steady.target 있음)은 유지 구간 기준(basis.selected "steady")일 때만 고정 취급 —
 *  그 외엔 곡선 가지. 유지 구간 기준에서 dropped가 run 전체 값이면(전체 구간에 상승이 섞여 식이 안 맞는다) 인사이트 값만.
 *  closed-loop(둘 다 없음) → null → 소비처(Summary)가 카드 3종 통째 생략(기존 거동). */
export function openLoopRates(
  profile: unknown,
  dropped: number,
  durationSeconds: number,
  insights: Insight[],
  basis?: ReportBasis,
): OpenLoopRates | null {
  const p = profile as LooseProfile;
  const stages = p?.stages ?? [];
  let target: number | null = null;
  let curve = false;
  if (p?.target_rps != null) {
    target = p.target_rps;
  } else if (p?.steady?.target != null && basis?.selected === "steady") {
    target = p.steady.target;
  } else if (stages.length > 0) {
    target = Math.max(...stages.map((s) => s.target));
    curve = true;
  }
  if (target == null) return null;
  const fromInsight = insights.find(
    (i) => i.kind === "load_gen_saturated" && i.achieved_per_sec != null,
  )?.achieved_per_sec;
  let achieved: number | null = fromInsight ?? null;
  const rampRunWholeDropped =
    p?.target_rps == null && basis?.selected === "steady" && basis.dropped_whole_run;
  if (achieved == null && !curve && !rampRunWholeDropped && durationSeconds > 0) {
    achieved = Math.max(0, target - dropped / durationSeconds);
  }
  return { target, curve, achieved };
}
