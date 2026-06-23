import type { ConnectionStats } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";

type Props = { stats: ConnectionStats };

export function ConnectionCostCard({ stats }: Props) {
  const reusePct = (stats.reuse_ratio * 100).toFixed(1);
  return (
    <section
      aria-label={ko.report.connectionLabel}
      className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      {/* HelpTip is a sibling of <h3>, NOT a child — nesting pollutes the heading accname (ui/CLAUDE.md U3). */}
      <div className="mb-1 flex items-center">
        <h3 className="text-base font-semibold">{ko.report.connectionLabel}</h3>
        <HelpTip label={ko.report.connectionLabel}>{ko.report.connectionHelp}</HelpTip>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        {ko.report.connectionBeginner(stats.connections_opened)}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center text-xs uppercase tracking-wide text-slate-500">
            {ko.report.connectionReuse}
            <HelpTip label={ko.report.connectionReuse}>{ko.report.connectionReuseHelp}</HelpTip>
          </div>
          <div className="mt-1 text-2xl font-bold">{reusePct}%</div>
          <div className="mt-2 h-2 overflow-hidden rounded bg-slate-200">
            <div className="h-full bg-green-500" style={{ width: `${reusePct}%` }} />
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {ko.report.connectionsOpened}
          </div>
          <div className="mt-1 text-2xl font-bold">
            {stats.connections_opened}
            <span className="ml-1 text-sm font-medium text-slate-500">
              {ko.report.connectionUnitCount}
            </span>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center text-sm">
            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-indigo-500" />
            {ko.report.connectionDns}
            <HelpTip label={ko.report.connectionDns}>{ko.report.connectionDnsHelp}</HelpTip>
            <span className="ml-auto tabular-nums text-slate-500">
              {ko.report.connectionPercentiles(stats.dns.p50_ms, stats.dns.p95_ms)}
            </span>
          </div>
          <div className="mt-2 flex items-center text-sm">
            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-teal-500" />
            {ko.report.connectionConnect}
            <span className="ml-auto tabular-nums text-slate-500">
              {ko.report.connectionPercentiles(stats.connect.p50_ms, stats.connect.p95_ms)}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
