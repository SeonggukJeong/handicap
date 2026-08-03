import type { Profile } from "../../api/schemas";
import { DEFAULT_HTTP_TIMEOUT_SECONDS } from "../../api/schemas";
import { appliedTimeoutKnobs } from "../../api/runPrefill";
import { ko } from "../../i18n/ko";

type Props = { profile: Profile; hasStepTimeoutOverride: boolean };

/** 명시 설정된 run-level 타임아웃 노브 한 줄(spec §4). 기본값 run은 미렌더(0-diff).
 *  꼬리 "일부 스텝은 자체 타임아웃 사용"은 오도 방지(per-step 오버라이드 존재 신호만 —
 *  값 노출은 비목표, store/runs.rs:162-165의 상호작용 문서 참조). */
export function AppliedTimeouts({ profile, hasStepTimeoutOverride }: Props) {
  const k = appliedTimeoutKnobs(profile);
  if (!k.show) return null;
  const parts = [
    k.http === DEFAULT_HTTP_TIMEOUT_SECONDS
      ? ko.report.appliedTimeoutsHttpDefault(k.http)
      : ko.report.appliedTimeoutsHttp(k.http),
    ...(k.connect != null ? [ko.report.appliedTimeoutsConnect(k.connect)] : []),
    ...(hasStepTimeoutOverride ? [ko.report.appliedTimeoutsStepOverride] : []),
  ];
  return (
    <p className="mb-4 text-sm text-slate-600">
      {ko.report.appliedTimeoutsLead} — {parts.join(" · ")}
    </p>
  );
}
