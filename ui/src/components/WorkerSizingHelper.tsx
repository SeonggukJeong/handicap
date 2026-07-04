import { useMemo } from "react";
import { useScenarioRuns, useRunReport } from "../api/hooks";
import type { Run } from "../api/schemas";
import { pickLatestOpenRun, peakThroughput, recommendWorkers } from "./sizing";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";

/** validate_run_config worker_count 하드캡(api/runs.rs / schemas.ts:93 `.max(64)`)과 동기. */
const WORKER_COUNT_CAP = 64;

type WorkerAnchor = { peak: number; dropped: number; priorWorkerCount: number };

/** 최근 종료 open-loop run에서 워커당 천장 앵커 도출. peak(초별 count 합 최대)·dropped·prior_wc.
 *  요청 0건(peak==0)이면 null. count 기반이라 localhost sub-ms run도 앵커가 산다(p50 기반 슬롯
 *  헬퍼 usePriorOpenRunAnchor와 대비 — 그건 p50==0이면 null). 슬롯 헬퍼 앵커 훅 미러. */
function usePriorOpenRunWorkerAnchor(scenarioId: string | undefined): WorkerAnchor | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees a
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(() => pickLatestOpenRun((runs.data?.runs ?? []) as Run[]), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const peak = report.data ? peakThroughput(report.data.windows) : 0;
  const dropped = report.data?.dropped ?? 0;
  const priorWorkerCount = latest?.profile.worker_count ?? 1;
  return useMemo(
    () => (peak > 0 ? { peak, dropped, priorWorkerCount } : null),
    [peak, dropped, priorWorkerCount],
  );
}

type Props = {
  scenarioId: string;
  /** 유효 목표 RPS 문자열(읽기 전용 — 자체 입력칸 없음). fixed=폼 목표 RPS, curve=stages 피크(상위 도출). */
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
    ? recommendWorkers(Number(targetRps), anchor.peak, anchor.priorWorkerCount)
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
              {ko.workerSizing.strongBasis(anchor.priorWorkerCount, anchor.peak, anchor.dropped)}
            </p>
          ) : (
            <p className="text-xs text-slate-500 mb-2">
              {ko.workerSizing.weakBasis(anchor.priorWorkerCount, anchor.peak)}
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
            </>
          )}
        </>
      )}
    </div>
  );
}
