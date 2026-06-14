import { useMemo, useState } from "react";
import { useScenario, useScenarioRuns, useRunReport, useTestRun } from "../api/hooks";
import type { Run } from "../api/schemas";
import { pickLatestOpenRun, recommendSlots } from "./sizing";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";

const INPUT = "mt-1 block w-full rounded border border-slate-300 px-2 py-1";

/** validate_run_config의 max_in_flight 하드 상한(api/runs.rs:253 / schemas.ts:87 `.max(10_000)`)과 동기.
 *  초과 권장값은 적용해도 검증이 400으로 막으므로 비차단 경고를 띄운다(post-hoc capacity cause와 의미 연결). */
const MAX_IN_FLIGHT_CAP = 10000;

/** 최근 종료 open-loop run에서 지연 앵커(요청당 p50)를 도출. 없거나 p50==0이면 null.
 *  반환값은 useMemo로 안정화 — 소비처 분기가 값 변화에만 반응(닫힌 헬퍼 usePriorClosedRunAnchor 미러). */
function usePriorOpenRunAnchor(scenarioId: string | undefined): { p50Ms: number } | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees a
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(() => pickLatestOpenRun((runs.data?.runs ?? []) as Run[]), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const p50Ms = report.data?.summary.p50_ms ?? 0;
  // p50==0(localhost sub-ms run)이면 앵커 무효 → 추정/측정 UI 노출(spec §5.1 가드).
  return useMemo(() => (p50Ms > 0 ? { p50Ms } : null), [p50Ms]);
}

type Props = {
  scenarioId: string;
  env: Record<string, string>;
  /** 폼의 기존 목표 RPS 문자열(읽기 전용 — 자체 입력칸 없음, spec §2 항목 4). */
  targetRps: string;
  /** 적용 → RunDialog의 setMaxInFlight(String(n)). */
  onApply: (n: number) => void;
};

export function SlotSizingHelper({ scenarioId, env, targetRps, onApply }: Props) {
  const anchor = usePriorOpenRunAnchor(scenarioId);
  const scenarioQ = useScenario(scenarioId);
  const testRun = useTestRun();
  const [estMs, setEstMs] = useState("");

  // test-run 측정(비-truncated): trace에서 요청 수 R + 1회 패스 wall-clock total_ms → 요청당 평균 지연.
  const trace = testRun.data;
  const truncated = trace?.truncated ?? false;
  const measuredR =
    trace && !trace.truncated ? trace.steps.filter((s) => s.response !== null).length : 0;
  const measured =
    trace && !trace.truncated && measuredR > 0 && trace.total_ms > 0
      ? { latencyMs: trace.total_ms / measuredR, reqPerIter: measuredR }
      : null;

  const estMsNum = Number(estMs);
  // 지연 출처 precedence: prior > 수동 추정(estMs 입력) > 측정 (닫힌 헬퍼와 동형).
  const latencyMs: number | null = anchor
    ? anchor.p50Ms
    : estMs.trim() !== "" && Number.isFinite(estMsNum) && estMsNum > 0
      ? estMsNum
      : measured
        ? measured.latencyMs
        : null;

  const targetNum = Number(targetRps);
  const result = latencyMs != null ? recommendSlots(targetNum, latencyMs) : null;

  const runMeasure = () => {
    const yaml = scenarioQ.data?.yaml;
    if (!yaml) return;
    testRun.mutate({ scenario_yaml: yaml, env });
  };

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-sm font-medium text-slate-700">{ko.slotSizing.title}</span>
        <HelpTip label={ko.slotSizing.helpLabel}>{ko.slotSizing.help}</HelpTip>
      </div>

      {anchor ? (
        <p className="text-xs text-slate-500 mb-2">{ko.slotSizing.fromPriorRun(anchor.p50Ms)}</p>
      ) : (
        <div className="mb-2">
          <label className="block text-sm">
            <span className="text-slate-600">{ko.slotSizing.estMs}</span>
            <input
              type="number"
              min={1}
              value={estMs}
              onChange={(e) => setEstMs(e.target.value)}
              className={INPUT}
              aria-label={ko.slotSizing.estMs}
            />
          </label>
          <button
            type="button"
            onClick={runMeasure}
            disabled={testRun.isPending || !scenarioQ.data?.yaml}
            className="mt-1 text-sm text-blue-600 hover:underline disabled:opacity-40"
          >
            {testRun.isPending ? ko.slotSizing.measuring : ko.slotSizing.measureBtn}
          </button>
          <p className="text-xs text-amber-700 mt-1">{ko.slotSizing.measureCaveat}</p>
          {truncated && (
            <p role="alert" className="text-xs text-red-600 mt-1">
              {ko.slotSizing.truncated}
            </p>
          )}
          {testRun.isError && (
            <p role="alert" className="text-xs text-red-600 mt-1">
              {ko.slotSizing.measureError}
            </p>
          )}
          {measured && (
            <p className="text-xs text-slate-500 mt-1">
              {ko.slotSizing.measured(measured.reqPerIter, Math.round(measured.latencyMs))}
            </p>
          )}
        </div>
      )}

      {result ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-700">
              {ko.slotSizing.recommend(result.recommendedSlots)}
            </span>
            <button
              type="button"
              onClick={() => onApply(result.recommendedSlots)}
              className="rounded bg-indigo-600 px-2 py-1 text-sm text-white hover:bg-indigo-700"
            >
              {ko.slotSizing.apply}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {ko.slotSizing.formula(
              targetNum,
              Math.round(latencyMs as number),
              result.recommendedSlots,
            )}
          </p>
          {result.recommendedSlots > MAX_IN_FLIGHT_CAP && (
            <p className="text-xs text-amber-700 mt-1">{ko.slotSizing.overCapacity}</p>
          )}
        </>
      ) : latencyMs == null ? (
        // 지연 출처 없음 — 단, truncated일 땐 위에서 자체 안내가 떠 중복 표시 방지.
        !truncated && <p className="text-xs text-slate-500">{ko.slotSizing.cannotCompute}</p>
      ) : targetRps.trim() === "" ? (
        <p className="text-xs text-slate-500">{ko.slotSizing.needTarget}</p>
      ) : // 지연은 있으나 targetRps가 non-empty-but-invalid(예: "1.5"/"2000000") → recommendSlots null.
      // 폼 자체의 targetRpsInvalid 에러가 이미 그 사유를 표시하므로 여기선 침묵(중복 방지).
      null}
    </div>
  );
}
