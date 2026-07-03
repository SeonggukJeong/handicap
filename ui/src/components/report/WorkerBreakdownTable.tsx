import type { WorkerBreakdown } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { formatErrPct } from "./format";

type Props = { breakdown: WorkerBreakdown[] };

export function WorkerBreakdownTable({ breakdown }: Props) {
  // Server emits only when >=2 distinct workers; mirror that gate defensively.
  if (breakdown.length < 2) return null;
  return (
    <section aria-label={ko.report.workerBreakdownLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">
        {ko.report.workerBreakdownTitle(breakdown.length)}
      </h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">{ko.report.colWorker}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colRequests}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colErrors}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colErrorRate}</th>
            <th className="py-2 pr-4 font-medium">
              p50 ms<HelpTip label="p50 설명">{ko.glossary.p50}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p95 ms<HelpTip label="p95 설명">{ko.glossary.p95}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p99 ms<HelpTip label="p99 설명">{ko.glossary.p99}</HelpTip>
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((w, i) => (
            <tr key={w.worker_id} className="border-b border-slate-100">
              <td className="py-2 pr-4 font-medium" title={w.worker_id}>
                {ko.report.workerLabel(i + 1)}
              </td>
              <td className="py-2 pr-4">{w.count}</td>
              <td className="py-2 pr-4">{w.errors}</td>
              <td className="py-2 pr-4">{formatErrPct(w.errors, w.count)}</td>
              <td className="py-2 pr-4">{w.p50_ms}</td>
              <td className="py-2 pr-4">{w.p95_ms}</td>
              <td className="py-2 pr-4">{w.p99_ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
