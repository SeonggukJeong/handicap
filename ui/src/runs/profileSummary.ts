import type { Profile } from "../api/schemas";
import { deriveLoadMode, fixedTarget } from "../components/run/loadModel";
import { profileDurationSeconds } from "../api/runPrefill";
import { ko } from "../i18n/ko";

/** 압축 설정 요약(spec §8). 모드 판정은 deriveLoadMode 단일 소스, 강도 값은 모드별
 *  허용 직접 읽기(open rate는 profileVuDisplay가 안 준다 — spec C27). Math.max가
 *  안전한 근거: deriveLoadMode는 curve를 비어있지 않은 배열에서만 반환(loadModel.ts
 *  :179-180 — vuSortValue와 같은 불변식). */
export function profileSummary(
  p: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages" | "duration_seconds"> &
    Partial<Pick<Profile, "stair" | "steady">>,
): string {
  const base = baseSummary(p);
  if (!p.steady) return base;
  const suffix = ko.runSummary.steadySuffix(p.steady.ramp_seconds, p.steady.discard_seconds);
  return suffix === "" ? base : `${base} · ${suffix}`;
}

function baseSummary(
  p: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages" | "duration_seconds"> &
    Partial<Pick<Profile, "stair" | "steady">>,
): string {
  const { loadModel, rateMode } = deriveLoadMode(p);
  const dur = profileDurationSeconds(p);
  if (loadModel === "open") {
    if (rateMode === "stair" && p.stair)
      return ko.runSummary.openStair(p.stair.targets.length, Math.max(...p.stair.targets));
    if (rateMode === "curve")
      return ko.runSummary.openCurve(Math.max(...(p.stages ?? []).map((s) => s.target)), dur);
    return ko.runSummary.openFixed(fixedTarget(p) ?? 0, dur);
  }
  if (rateMode === "curve")
    return ko.runSummary.closedCurve(Math.max(...(p.vu_stages ?? []).map((s) => s.target)), dur);
  return ko.runSummary.closedFixed(p.vus, dur);
}
