import type { Run } from "../api/schemas";
import { ko } from "../i18n/ko";

const t = ko.report.stair;

/** 계단 run이 자동 정지로 끝났을 때만 상태 배지 옆에 붙는 작은 표지(보류만 = 없음). */
export function AutoStopBadge({
  run,
}: {
  run: Pick<Run, "status" | "auto_stop"> & { profile: { stair?: { targets: number[] } } };
}) {
  const stop = run.status === "completed" ? run.auto_stop?.stop : null;
  if (!stop) return null;
  const n = stop.decided_step;
  const target = run.profile.stair?.targets[n];
  const label = t.stopLabel(n + 1, target);
  const title =
    stop.kind === "saturation"
      ? t.stopSaturationHead(label)
      : t.stopEmergencyHead(
          label,
          t.stopPhaseName[
            stop.phase === "ramp" || stop.phase === "discard" ? stop.phase : "measure"
          ],
        );
  return (
    <span
      className="ml-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
      title={title}
    >
      {ko.runDetail.autoStopBadge}
    </span>
  );
}
