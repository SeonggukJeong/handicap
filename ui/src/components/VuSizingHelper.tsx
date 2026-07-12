import { useEffect, useMemo, useRef, useState } from "react";
import { useScenario, useScenarioRuns, useRunReport, useTestRun } from "../api/hooks";
import type { Run } from "../api/schemas";
import type { Scenario } from "../scenario/model";
import { flattenHttpSteps } from "../scenario/model";
import { pickLatestClosedRun, recommendVus, type ThroughputSource } from "./sizing";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";

const INPUT = "mt-1 block w-full rounded border border-slate-300 px-2 py-1";

/** 서버 워커 용량 기본값(DEFAULT_WORKER_CAPACITY_VUS=2000, crates/controller/src/grpc/coordinator.rs)과 동기화한 soft 임계.
 *  초과해도 멀티워커 fan-out(ADR-0027)으로 워커를 더 띄울 뿐 차단은 아니다 — 비현실적 권장값 안내(비차단). */
const VU_SOFT_WARN_THRESHOLD = 2000;

/** RunDialog의 크기 프리셋 상대배수 사이징(Option C, sizing.ts::sizePresetsFor)에도
 *  재사용하는 앵커 타입. */
export type ClosedRunAnchor = { vus: number; rps: number; durationSeconds: number };

/** 최근 종료 균등-VU run에서 처리량 앵커(VU·달성RPS·duration)를 도출. 없으면 null.
 *  반환값은 useMemo로 안정화 — 소비처 useEffect([anchor])가 값 변화에만 발화. */
// eslint-disable-next-line react-refresh/only-export-components
export function usePriorClosedRunAnchor(scenarioId: string | undefined): ClosedRunAnchor | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(() => pickLatestClosedRun((runs.data?.runs ?? []) as Run[]), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const vus = latest?.profile.vus ?? 0;
  const rps = report.data?.summary.rps ?? 0;
  const durationSeconds = latest?.profile.duration_seconds ?? 0;
  return useMemo(
    () => (vus > 0 && rps > 0 ? { vus, rps, durationSeconds } : null),
    [vus, rps, durationSeconds],
  );
}

type Props = {
  scenarioId: string;
  scenario: Scenario | null;
  env: Record<string, string>;
  onApply: (vus: number) => void;
};

export function VuSizingHelper({ scenarioId, scenario, env, onApply }: Props) {
  const anchor = usePriorClosedRunAnchor(scenarioId);
  const scenarioQ = useScenario(scenarioId);
  const testRun = useTestRun();

  const [targetRps, setTargetRps] = useState("");
  const [estMs, setEstMs] = useState("");
  const touchedRef = useRef(false);
  const seededRef = useRef(false);

  // 비동기 1회 시드: 앵커가 늦게 도착 + 사용자가 목표칸을 안 건드렸을 때만 1회(덮어쓰기 race 회피).
  useEffect(() => {
    if (anchor && !touchedRef.current && !seededRef.current) {
      seededRef.current = true;
      setTargetRps(String(Math.round(anchor.rps)));
    }
  }, [anchor]);

  // test-run 측정(비-truncated): trace에서 정확한 요청수 R + 반복지연 T.
  const trace = testRun.data;
  const measured =
    trace && !trace.truncated
      ? {
          reqPerIter: trace.steps.filter((s) => s.response !== null).length,
          iterMs: trace.total_ms,
        }
      : null;
  const truncated = trace?.truncated ?? false;

  const staticReqPerIter = scenario ? flattenHttpSteps(scenario.steps).length : 0;
  const estMsNum = Number(estMs);

  // 처리량 출처 우선순위: prior > 수동 추정(estMs 입력) > 측정.
  const src: ThroughputSource | null = anchor
    ? { kind: "prior", priorVus: anchor.vus, priorRps: anchor.rps }
    : estMs.trim() !== "" && Number.isFinite(estMsNum) && estMsNum > 0
      ? { kind: "estimate", reqPerIter: staticReqPerIter, iterMs: estMsNum }
      : measured
        ? { kind: "measured", reqPerIter: measured.reqPerIter, iterMs: measured.iterMs }
        : null;

  const result = src ? recommendVus(Number(targetRps), src) : null;

  const runMeasure = () => {
    const yaml = scenarioQ.data?.yaml;
    if (!yaml) return;
    // SlotSizingHelper와 같은 앵커 정의: 반복 점유시간에는 think time이 포함된다.
    testRun.mutate({ scenario_yaml: yaml, env, apply_think_time: true });
  };

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-sm font-medium text-slate-700">{ko.sizing.title}</span>
        <HelpTip label={ko.sizing.helpLabel}>{ko.sizing.help}</HelpTip>
      </div>

      <label className="block text-sm mb-2">
        <span className="text-slate-600">{ko.sizing.targetRps}</span>
        <input
          type="number"
          min={1}
          max={1000000}
          value={targetRps}
          onChange={(e) => {
            touchedRef.current = true;
            setTargetRps(e.target.value);
          }}
          className={INPUT}
          aria-label={ko.sizing.targetRps}
        />
      </label>

      {anchor ? (
        <p className="text-xs text-slate-500 mb-2">
          {ko.sizing.fromPriorRun(anchor.vus, Math.round(anchor.rps))}
        </p>
      ) : (
        <div className="mb-2">
          <label className="block text-sm">
            <span className="text-slate-600">{ko.sizing.estMs}</span>
            <input
              type="number"
              min={1}
              value={estMs}
              onChange={(e) => setEstMs(e.target.value)}
              className={INPUT}
              aria-label={ko.sizing.estMs}
            />
          </label>
          <button
            type="button"
            onClick={runMeasure}
            disabled={testRun.isPending || !scenarioQ.data?.yaml}
            className="mt-1 text-sm text-accent-600 hover:underline disabled:opacity-40"
          >
            {testRun.isPending ? ko.sizing.measuring : ko.sizing.measureBtn}
          </button>
          <p className="text-xs text-amber-700 mt-1">{ko.sizing.measureCaveat}</p>
          {truncated && (
            <p role="alert" className="text-xs text-red-600 mt-1">
              {ko.sizing.truncated}
            </p>
          )}
          {testRun.isError && (
            <p role="alert" className="text-xs text-red-600 mt-1">
              {ko.sizing.measureError}
            </p>
          )}
          {measured && (
            <p className="text-xs text-slate-500 mt-1">
              {ko.sizing.measured(measured.reqPerIter, measured.iterMs)}
            </p>
          )}
        </div>
      )}

      {result ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-700">
            {ko.sizing.recommend(result.recommendedVus)}
          </span>
          <button
            type="button"
            onClick={() => onApply(result.recommendedVus)}
            className="rounded bg-accent-600 px-2 py-1 text-sm text-white hover:bg-accent-700"
          >
            {ko.sizing.apply}
          </button>
        </div>
      ) : (
        targetRps.trim() !== "" &&
        !truncated && <p className="text-xs text-slate-500">{ko.sizing.cannotCompute}</p>
      )}
      {result && result.recommendedVus > VU_SOFT_WARN_THRESHOLD && (
        <p className="text-xs text-amber-700 mt-1">{ko.sizing.overCapacity}</p>
      )}
    </div>
  );
}
