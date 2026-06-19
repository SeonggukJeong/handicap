import { Fragment } from "react";
import type { GroupLatency } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";

type GroupMeta = { name: string };
type Props = { breakdown: GroupLatency[]; meta: Map<string, GroupMeta> };

/** Page-load latency per `parallel` node = wall-clock of the concurrent block
 *  (≈ max of branches), aggregated run-total, with a sub-row per branch
 *  (branch's own wall-clock) so the bottleneck concurrent call is visible. Separate
 *  from StepStatsTable because the parallel node's id is not an http-leaf metric row. */
export function GroupLatencyTable({ breakdown, meta }: Props) {
  if (breakdown.length === 0) return null;
  return (
    <section aria-label={ko.report.pageLoadLatencyLabel} className="mb-6">
      <h3 className="text-lg font-semibold mb-2">{ko.report.pageLoadLatencyTitle}</h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">{ko.report.colParallelNode}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colCount}</th>
            <th className="py-2 pr-4 font-medium">
              p50 ms<HelpTip label="p50 설명">{ko.glossary.p50}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p95 ms<HelpTip label="p95 설명">{ko.glossary.p95}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p99 ms<HelpTip label="p99 설명">{ko.glossary.p99}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">{ko.report.colMaxMs}</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((g) => {
            const m = meta.get(g.step_id);
            return (
              <Fragment key={g.step_id}>
                <tr className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">
                    {m?.name ?? g.step_id} <span className="text-slate-400">(parallel)</span>
                  </td>
                  <td className="py-2 pr-4">{g.count}</td>
                  <td className="py-2 pr-4">{g.p50_ms}</td>
                  <td className="py-2 pr-4">{g.p95_ms}</td>
                  <td className="py-2 pr-4">{g.p99_ms}</td>
                  <td className="py-2 pr-4">{g.max_ms}</td>
                </tr>
                {g.branches.map((b) => (
                  <tr
                    key={`${g.step_id}:${b.branch}`}
                    className="border-b border-slate-100 text-slate-600"
                  >
                    <td className="py-2 pr-4 pl-6">
                      <span aria-hidden="true">↳ </span>
                      {b.branch}
                    </td>
                    <td className="py-2 pr-4">{b.count}</td>
                    <td className="py-2 pr-4">{b.p50_ms}</td>
                    <td className="py-2 pr-4">{b.p95_ms}</td>
                    <td className="py-2 pr-4">{b.p99_ms}</td>
                    <td className="py-2 pr-4">{b.max_ms}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
