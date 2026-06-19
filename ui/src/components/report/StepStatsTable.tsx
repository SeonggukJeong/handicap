import { Fragment, useState } from "react";
import type { ReportStep } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";

type StepMeta = { id: string; name: string; method: string; url: string };

type Props = { steps: ReportStep[]; meta: Map<string, StepMeta> };

export function StepStatsTable({ steps, meta }: Props) {
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

  // Base: Step, Method, URL, Requests, Errors, p50 ms, p95 ms, p99 ms = 8
  // With download: +3 (다운로드 p50, p95, p99) = 11
  const colSpan = anyDownload ? 11 : 8;

  return (
    <section aria-label={ko.report.perStepStatsLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">{ko.report.stepsHeading}</h3>
      {anyDownload && (
        <p className="mb-2 text-xs text-slate-500">
          응답(TTFB)=요청~헤더, 다운로드=본문 수신. 합 ≠ 전체(퍼센타일 비가산).
        </p>
      )}
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
            {anyDownload && (
              <>
                <th className="py-2 pr-4 font-medium">다운로드 p50 ms</th>
                <th className="py-2 pr-4 font-medium">다운로드 p95 ms</th>
                <th className="py-2 pr-4 font-medium">다운로드 p99 ms</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const m = meta.get(s.step_id);
            const breakdown = s.loop_breakdown ?? [];
            const hasBreakdown = breakdown.length > 0;
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
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{m?.method ?? ""}</td>
                  <td className="py-2 pr-4 font-mono text-xs break-all">{m?.url ?? ""}</td>
                  <td className="py-2 pr-4">{s.count}</td>
                  <td className="py-2 pr-4">{s.error_count}</td>
                  <td className="py-2 pr-4">{s.p50_ms}</td>
                  <td className="py-2 pr-4">{s.p95_ms}</td>
                  <td className="py-2 pr-4">{s.p99_ms}</td>
                  {anyDownload && (
                    <>
                      <td className="py-2 pr-4">{s.download?.p50_ms ?? "—"}</td>
                      <td className="py-2 pr-4">{s.download?.p95_ms ?? "—"}</td>
                      <td className="py-2 pr-4">{s.download?.p99_ms ?? "—"}</td>
                    </>
                  )}
                </tr>
                {hasBreakdown && isOpen && (
                  <tr className="bg-slate-50">
                    <td colSpan={colSpan} className="px-6 py-2">
                      <table className="text-xs">
                        <thead className="text-slate-500">
                          <tr>
                            <th className="pr-4 text-left">loop_index</th>
                            <th className="pr-4 text-left">requests</th>
                            <th className="pr-4 text-left">errors</th>
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
    </section>
  );
}
