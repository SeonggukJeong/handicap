import type { Profile } from "../api/schemas";
import { ko } from "../i18n/ko";
import { profileVuDisplay } from "./loadModel";

/** 한 run의 VU 표시 셀(RunDetailPage 카드 · ScenarioRunsPage 열 공유). closed+fixed→숫자,
 *  closed+curve→"최대 N (곡선)", open-loop→"—"(VU 해당 없음·RPS/슬롯 기반). 표시 분기 단일
 *  소스라 per-surface 복붙 drift와 a11y 누락(open의 aria-label)을 막는다. */
export function RunVuCell({
  profile,
}: {
  profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">;
}) {
  const vu = profileVuDisplay(profile);
  if (vu.kind === "curve") return <>{ko.report.vusCurvePeak(vu.peak)}</>;
  if (vu.kind === "open")
    return (
      <span title={ko.report.vusOpenHint} aria-label={ko.report.vusOpenHint}>
        —
      </span>
    );
  return <>{vu.vus}</>;
}
