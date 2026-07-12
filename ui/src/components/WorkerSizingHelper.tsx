import { useMemo } from "react";
import { useScenarioRuns, useRunReport } from "../api/hooks";
import type { Run } from "../api/schemas";
import { pickLatestFixedOpenRun, recommendWorkers } from "./sizing";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";

/** validate_run_config worker_count 하드캡(api/runs.rs / schemas.ts:93 `.max(64)`)과 동기. */
const WORKER_COUNT_CAP = 64;

type WorkerAnchor = {
  achievedPerSec: number;
  priorTarget: number;
  dropped: number;
  priorWorkerCount: number;
};

/** 최근 종료 '고정 rate' open-loop run에서 달성 도착률 앵커 도출(ADR-0046 R10).
 *  achieved = prior_target − dropped/duration. 곡선 prior는 제외(pickLatestFixedOpenRun).
 *  duration<=0 또는 achieved<=0이면 null. */
function usePriorOpenRunWorkerAnchor(scenarioId: string | undefined): WorkerAnchor | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees a
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(
    () => pickLatestFixedOpenRun((runs.data?.runs ?? []) as Run[]),
    [runs.data],
  );
  const report = useRunReport(latest?.id, Boolean(latest));
  const dropped = report.data?.dropped ?? 0;
  const duration = report.data?.summary.duration_seconds ?? 0;
  const priorTarget = latest?.profile.target_rps ?? 0;
  const priorWorkerCount = latest?.profile.worker_count ?? 1;
  return useMemo(() => {
    if (duration <= 0 || priorTarget <= 0) return null;
    const achievedPerSec = Math.max(0, priorTarget - dropped / duration);
    if (achievedPerSec <= 0) return null;
    return { achievedPerSec, priorTarget, dropped, priorWorkerCount };
  }, [duration, priorTarget, dropped, priorWorkerCount]);
}

type Props = {
  scenarioId: string;
  /** 유효 목표 도착률 문자열(읽기 전용 — 자체 입력칸 없음). fixed=폼 목표 도착률, curve=stages 피크(상위 도출). */
  targetRps: string;
  /** true면 곡선 문구(최고 단계 목표) — open+curve에서 LoadModelFields가 전달. */
  peakBased?: boolean;
  /** 폼의 max_in_flight 문자열 — cross-field 경고(worker_count <= max_in_flight, runs.rs:346)용. */
  maxInFlight: string;
  /** 적용 → RunDialog의 setWorkerCount(String(n)). */
  onApply: (n: number) => void;
};

export function WorkerSizingHelper({
  scenarioId,
  targetRps,
  peakBased = false,
  maxInFlight,
  onApply,
}: Props) {
  const anchor = usePriorOpenRunWorkerAnchor(scenarioId);
  const result = anchor
    ? recommendWorkers(Number(targetRps), anchor.achievedPerSec, anchor.priorWorkerCount)
    : null;
  const rawN = result?.recommendedWorkers ?? 0;
  const applyN = Math.min(rawN, WORKER_COUNT_CAP);

  const mifNum = Number(maxInFlight);
  const mifValid = maxInFlight.trim() !== "" && Number.isInteger(mifNum) && mifNum >= 1;
  const needMif = result != null && mifValid && applyN > mifNum;

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-sm font-medium text-slate-700">{ko.workerSizing.title}</span>
        <HelpTip label={ko.workerSizing.helpLabel}>{ko.workerSizing.help}</HelpTip>
      </div>

      {anchor == null ? (
        <p className="text-xs text-slate-500">{ko.workerSizing.noBasis}</p>
      ) : (
        <>
          {anchor.dropped > 0 ? (
            <p className="text-xs text-slate-500 mb-2">
              {ko.workerSizing.strongBasis(
                anchor.priorWorkerCount,
                Math.round(anchor.achievedPerSec),
                anchor.dropped,
              )}
            </p>
          ) : (
            <p className="text-xs text-slate-500 mb-2">
              {ko.workerSizing.weakBasis(anchor.priorWorkerCount, anchor.priorTarget)}
            </p>
          )}

          {result && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-700">
                  {anchor.dropped > 0
                    ? peakBased
                      ? ko.workerSizing.recommendPeak(rawN)
                      : ko.workerSizing.recommend(rawN)
                    : ko.workerSizing.weakRecommend(rawN)}
                </span>
                <button
                  type="button"
                  onClick={() => onApply(applyN)}
                  className="rounded bg-accent-600 px-2 py-1 text-sm text-white hover:bg-accent-700"
                >
                  {ko.workerSizing.apply}
                </button>
              </div>
              {anchor.dropped === 0 && (
                <p className="text-xs text-slate-500 mt-1">{ko.workerSizing.weakHint}</p>
              )}
              {rawN > WORKER_COUNT_CAP && (
                <p className="text-xs text-amber-700 mt-1">{ko.workerSizing.overCap(rawN)}</p>
              )}
              {needMif && (
                <p className="text-xs text-amber-700 mt-1">
                  {ko.workerSizing.needMaxInFlight(applyN, mifNum)}
                </p>
              )}
              <p className="text-xs text-slate-500 mt-1">{ko.workerSizing.slotSplitNote}</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
