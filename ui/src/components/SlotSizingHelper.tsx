import { useMemo, useState } from "react";
import { useScenario, useScenarioRuns, useRunReport, useTestRun } from "../api/hooks";
import type { Run } from "../api/schemas";
import type { Scenario } from "../scenario/model";
import { pickLatestOpenRun, recommendSlots, iterationHoldMs } from "./sizing";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";

const INPUT = "mt-1 block w-full rounded border border-slate-300 px-2 py-1";

/** validate_run_config의 max_in_flight 하드 상한(api/runs.rs:253 / schemas.ts:87 `.max(10_000)`)과 동기.
 *  초과 권장값은 적용해도 검증이 400으로 막으므로 비차단 경고를 띄운다(post-hoc capacity cause와 의미 연결). */
const MAX_IN_FLIGHT_CAP = 10000;

type SlotAnchor =
  | { kind: "insight"; holdMs: number } // ⓐ 직전 포화 run 실측 hold 복원
  | { kind: "walk"; holdMs: number }; // ⓑ per-step p50 + think 평균 walk

/** 최근 종료 open-loop run에서 반복 점유시간(hold) 앵커 도출(ADR-0046 R8).
 *  ⓐ 포화(cause=slots) 인사이트의 실측 achieved_per_sec + prior max_in_flight로
 *  hold = M ÷ achieved 복원(목표-독립 — 현재 목표가 달라도 정확, R9 parity).
 *  ⓑ 아니면 scenario walk(iterationHoldMs, p50 ?? mean_ms). hold<=0이면 null. */
function usePriorOpenRunAnchor(
  scenarioId: string | undefined,
  scenario: Scenario | null | undefined,
): SlotAnchor | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees a
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(() => pickLatestOpenRun((runs.data?.runs ?? []) as Run[]), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const priorMif = latest?.profile.max_in_flight ?? null;
  return useMemo(() => {
    const rep = report.data;
    if (!rep) return null;
    const sat = rep.insights?.find((i) => i.kind === "load_gen_saturated");
    if (
      sat?.cause === "slots" &&
      sat.achieved_per_sec != null &&
      sat.achieved_per_sec > 0 &&
      priorMif != null &&
      priorMif > 0
    ) {
      return { kind: "insight", holdMs: (priorMif / sat.achieved_per_sec) * 1000 };
    }
    if (scenario) {
      const p50 = new Map(rep.steps.map((s) => [s.step_id, s.p50_ms] as const));
      const hold = iterationHoldMs(scenario.steps, p50, rep.summary.mean_ms);
      if (hold > 0) return { kind: "walk", holdMs: hold };
    }
    return null;
  }, [report.data, priorMif, scenario]);
}

type Props = {
  scenarioId: string;
  /** model Scenario(steps 보유) — hold walk 앵커(ⓑ)용. 미전달(하위호환) → ⓑ skip. */
  scenario?: Scenario | null;
  env: Record<string, string>;
  /** 유효 목표 도착률 문자열(읽기 전용 — 자체 입력칸 없음). fixed=폼 목표 도착률, curve=stages 피크(상위 도출). */
  targetRps: string;
  /** true면 곡선 변형 문구(formulaPeak/needTargetCurve) 사용 — open+curve에서 LoadModelFields가 전달. */
  peakBased?: boolean;
  /** 적용 → RunDialog의 setMaxInFlight(String(n)). */
  onApply: (n: number) => void;
};

export function SlotSizingHelper({
  scenarioId,
  scenario,
  env,
  targetRps,
  peakBased = false,
  onApply,
}: Props) {
  const anchor = usePriorOpenRunAnchor(scenarioId, scenario);
  const scenarioQ = useScenario(scenarioId);
  const testRun = useTestRun();
  const [estMs, setEstMs] = useState("");

  // test-run 측정(비-truncated): 1회 패스 wall-clock total_ms를 반복 점유시간(hold)로 직접 사용
  // (÷R 없음 — apply_think_time:true로 발사해 think time까지 포함된 전체 반복 시간).
  const trace = testRun.data;
  const truncated = trace?.truncated ?? false;
  const measuredR =
    trace && !trace.truncated ? trace.steps.filter((s) => s.response !== null).length : 0;
  const measuredHold = trace && !trace.truncated && trace.total_ms > 0 ? trace.total_ms : null;

  const estMsNum = Number(estMs);
  // hold 출처 precedence: prior 앵커(ⓐ/ⓑ) > 수동 추정(estMs 입력, ⓒ) > 측정(ⓓ).
  const holdMs: number | null =
    anchor?.holdMs ??
    (estMs.trim() !== "" && Number.isFinite(estMsNum) && estMsNum > 0 ? estMsNum : measuredHold);

  const targetNum = Number(targetRps);
  const result = holdMs != null ? recommendSlots(targetNum, holdMs) : null;

  const runMeasure = () => {
    const yaml = scenarioQ.data?.yaml;
    if (!yaml) return;
    testRun.mutate({ scenario_yaml: yaml, env, apply_think_time: true });
  };

  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-sm font-medium text-slate-700">{ko.slotSizing.title}</span>
        <HelpTip label={ko.slotSizing.helpLabel}>{ko.slotSizing.help}</HelpTip>
      </div>

      {anchor ? (
        <p className="text-xs text-slate-500 mb-2">
          {anchor.kind === "insight"
            ? ko.slotSizing.fromSaturatedRun
            : ko.slotSizing.fromPriorRunWalk(Math.round(anchor.holdMs))}
        </p>
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
            className="mt-1 text-sm text-accent-600 hover:underline disabled:opacity-40"
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
          {measuredR > 0 && measuredHold != null && (
            <p className="text-xs text-slate-500 mt-1">
              {ko.slotSizing.measured(measuredR, Math.round(measuredHold))}
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
              className="rounded bg-accent-600 px-2 py-1 text-sm text-white hover:bg-accent-700"
            >
              {ko.slotSizing.apply}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {(peakBased ? ko.slotSizing.formulaPeak : ko.slotSizing.formula)(
              targetNum,
              Math.round(holdMs as number),
              result.recommendedSlots,
            )}
          </p>
          {result.recommendedSlots > MAX_IN_FLIGHT_CAP && (
            <p className="text-xs text-amber-700 mt-1">{ko.slotSizing.overCapacity}</p>
          )}
        </>
      ) : holdMs == null ? (
        // hold 출처 없음 — 단, truncated일 땐 위에서 자체 안내가 떠 중복 표시 방지.
        !truncated && <p className="text-xs text-slate-500">{ko.slotSizing.cannotCompute}</p>
      ) : targetRps.trim() === "" ? (
        <p className="text-xs text-slate-500">
          {peakBased ? ko.slotSizing.needTargetCurve : ko.slotSizing.needTarget}
        </p>
      ) : // hold는 있으나 targetRps가 non-empty-but-invalid(예: "1.5"/"2000000") → recommendSlots null.
      // 폼 자체의 targetRpsInvalid 에러가 이미 그 사유를 표시하므로 여기선 침묵(중복 방지).
      null}
    </div>
  );
}
