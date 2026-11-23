import { Fragment, useState } from "react";
import type { ReportSampleName, ReportStep } from "../../api/schemas";
import { hasLatency, stepCounts } from "../../report/hasLatency";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { PageSection } from "../ui/PageSection";
import { RetryBadge } from "./LoopExitSummary";
import { MixedSampleBadge } from "./MixedSampleBadge";
import { WholeRunBadge } from "./WholeRunBadge";

type StepMeta = { id: string; name: string; method: string; url: string };

type Props = {
  steps: ReportStep[];
  meta: Map<string, StepMeta>;
  retriedStepIds?: ReadonlySet<string>;
  /** 반복 횟수별 집계·응답 분리·대기/다운로드 열이 run 전체 값일 때 「전체 구간」 표지를 단다. */
  wholeRunBadge?: boolean;
  /** 응답 시간을 계산한 표본 — 그 표본에 요청이 없으면 「—」. */
  sample?: ReportSampleName;
  /** 응답 시간 표본을 나눈 run이면 아직 나누지 않은 열·행에 「실패 포함」 표지를 단다. */
  mixedSample?: boolean;
};

// 하나도 보내지 않은 스텝에는 잰 시간이 없다 — 0으로 찍지 않는다.
// 보냈지만 응답을 못 받은 요청(시간 초과·거부)은 실패까지 걸린 시간이 표본에 들어 있어 그대로 찍는다.
function latency(s: ReportStep, ms: number, sample: ReportSampleName): number | string {
  return hasLatency(stepCounts(s), sample) ? ms : "—";
}

export function StepStatsTable({
  steps,
  meta,
  retriedStepIds,
  wholeRunBadge,
  sample = "all",
  mixedSample,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const anyDownload = steps.some((s) => s.download != null);
  const anyWait = steps.some((s) => s.wait != null);

  // Base: Step, Method, URL, Requests, Errors, p50 ms, p95 ms, p99 ms = 8
  // With download: +3 (다운로드 p50, p95, p99)
  // With wait: +1 (대기 p50)
  const colSpan = 8 + (anyDownload ? 3 : 0) + (anyWait ? 1 : 0);

  return (
    <PageSection ariaLabel={ko.report.perStepStatsLabel} title={ko.report.stepsHeading}>
      {anyDownload && <p className="mb-2 text-xs text-slate-500">{ko.report.phaseCaveat}</p>}
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">{ko.report.colStep}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colMethod}</th>
            <th className="py-2 pr-4 font-medium">URL</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colRequests}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colErrors}</th>
            <th className="py-2 pr-4 font-medium">
              p50 ms<HelpTip label="p50 설명">{ko.glossary.p50}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p95 ms<HelpTip label="p95 설명">{ko.glossary.p95}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p99 ms<HelpTip label="p99 설명">{ko.glossary.p99}</HelpTip>
            </th>
            {anyWait && (
              <th className="py-2 pr-4 font-medium">
                {ko.report.phaseWait} p50
                <HelpTip label={ko.report.phaseWait}>{ko.report.phaseWaitHelp}</HelpTip>
                {wholeRunBadge && <WholeRunBadge className="ml-1" />}
                {mixedSample && <MixedSampleBadge className="ml-1" />}
              </th>
            )}
            {anyDownload && (
              <>
                <th className="py-2 pr-4 font-medium">
                  {ko.report.phaseDownload} p50 ms
                  {wholeRunBadge && <WholeRunBadge className="ml-1" />}
                  {mixedSample && <MixedSampleBadge className="ml-1" />}
                </th>
                <th className="py-2 pr-4 font-medium">{ko.report.phaseDownload} p95 ms</th>
                <th className="py-2 pr-4 font-medium">{ko.report.phaseDownload} p99 ms</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const m = meta.get(s.step_id);
            const breakdown = s.loop_breakdown ?? [];
            const hasBreakdown = breakdown.length > 0;
            const ls = s.loop_split;
            const isOpen = open.has(s.step_id);
            return (
              <Fragment key={s.step_id}>
                <tr className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">
                    {hasBreakdown && (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-label={ko.report.toggleLoopBreakdown(m?.name ?? s.step_id)}
                        onClick={() => toggle(s.step_id)}
                        className="mr-1 text-slate-500"
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                    )}
                    {m?.name ?? s.step_id}
                    {retriedStepIds?.has(s.step_id) && <RetryBadge />}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{m?.method ?? ""}</td>
                  <td className="py-2 pr-4 font-mono text-xs break-all">{m?.url ?? ""}</td>
                  <td className="py-2 pr-4">{s.count}</td>
                  <td className="py-2 pr-4">{s.error_count}</td>
                  <td className="py-2 pr-4">{latency(s, s.p50_ms, sample)}</td>
                  <td className="py-2 pr-4">{latency(s, s.p95_ms, sample)}</td>
                  <td className="py-2 pr-4">{latency(s, s.p99_ms, sample)}</td>
                  {anyWait && <td className="py-2 pr-4">{s.wait?.p50_ms ?? "—"}</td>}
                  {anyDownload && (
                    <>
                      <td className="py-2 pr-4">{s.download?.p50_ms ?? "—"}</td>
                      <td className="py-2 pr-4">{s.download?.p95_ms ?? "—"}</td>
                      <td className="py-2 pr-4">{s.download?.p99_ms ?? "—"}</td>
                    </>
                  )}
                </tr>
                {ls &&
                  (["final", "retry"] as const).map((k) => {
                    const part = ls[k];
                    const label =
                      k === "final" ? ko.report.loopExit.splitFinal : ko.report.loopExit.splitRetry;
                    const pct = (v: number) => (part.count === 0 ? "—" : v);
                    return (
                      <tr key={k} className="border-b border-slate-100 text-slate-600">
                        <td className="py-2 pr-4 pl-6">
                          <span aria-hidden="true">└ </span>
                          {label}
                          {k === "final" && (
                            <HelpTip
                              label={ko.report.loopExit.splitHelpLabel(m?.name ?? s.step_id)}
                            >
                              <span className="block">{ko.report.loopExit.splitHelpFinal}</span>
                              <span className="block">{ko.report.loopExit.splitHelpRetry}</span>
                            </HelpTip>
                          )}
                          {k === "final" && wholeRunBadge && <WholeRunBadge className="ml-1" />}
                          {k === "final" && mixedSample && <MixedSampleBadge className="ml-1" />}
                        </td>
                        <td className="py-2 pr-4" />
                        <td className="py-2 pr-4" />
                        <td className="py-2 pr-4">{part.count}</td>
                        <td className="py-2 pr-4">{part.error_count}</td>
                        <td className="py-2 pr-4">{pct(part.p50_ms)}</td>
                        <td className="py-2 pr-4">{pct(part.p95_ms)}</td>
                        <td className="py-2 pr-4">{pct(part.p99_ms)}</td>
                        {anyWait && <td className="py-2 pr-4" />}
                        {anyDownload && (
                          <>
                            <td className="py-2 pr-4" />
                            <td className="py-2 pr-4" />
                            <td className="py-2 pr-4" />
                          </>
                        )}
                      </tr>
                    );
                  })}
                {hasBreakdown && isOpen && (
                  <tr className="bg-slate-50">
                    <td colSpan={colSpan} className="px-6 py-2">
                      {wholeRunBadge && <WholeRunBadge className="mb-1" />}
                      <table className="text-xs">
                        <thead className="text-slate-500">
                          <tr>
                            <th className="pr-4 text-left">loop_index</th>
                            <th className="pr-4 text-left">{ko.report.colRequests}</th>
                            <th className="pr-4 text-left">{ko.report.colErrors}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {breakdown.map((b, i) => (
                            <tr key={i}>
                              <td className="pr-4 font-mono">
                                {b.loop_index === null ? "그 외 (상한 초과)" : b.loop_index}
                              </td>
                              <td className="pr-4">{b.count}</td>
                              <td className="pr-4">{b.error_count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </PageSection>
  );
}
