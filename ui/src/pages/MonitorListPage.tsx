import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listBoards } from "../api/monitors";
import { Callout } from "../components/ui/Callout";
import { EmptyState } from "../components/EmptyState";
import { ko } from "../i18n/ko";
import { MONITOR_LIST_KEY } from "../monitor/keys";

export function MonitorListPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: MONITOR_LIST_KEY,
    queryFn: listBoards,
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{ko.monitor.listTitle}</h2>
        <Link
          to="/monitors/new"
          className="inline-flex items-center justify-center rounded-md bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
        >
          {ko.monitor.newBoard}
        </Link>
      </div>

      {isLoading && <p className="text-sm text-slate-500">{ko.monitor.loading}</p>}
      {error && (
        <Callout variant="error" role="alert">
          {ko.monitor.loadError((error as Error).message)}
        </Callout>
      )}
      {data && data.length === 0 && <EmptyState body={ko.monitor.emptyList} />}
      {data && data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4 font-medium">{ko.monitor.colName}</th>
              <th className="py-2 pr-4 font-medium">{ko.monitor.colPanels}</th>
              <th className="py-2 pr-4 font-medium">{ko.monitor.colState}</th>
              <th className="py-2 font-medium">
                <span className="sr-only">{ko.monitor.openDisplay}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.id} className="border-b border-slate-100">
                <td className="py-2 pr-4">
                  <Link to={`/monitors/${b.id}`} className="text-accent-700 hover:underline">
                    {b.name}
                  </Link>
                </td>
                <td className="py-2 pr-4">{ko.monitor.panelCount(b.config.panels.length)}</td>
                <td className="py-2 pr-4">
                  {b.enabled ? ko.monitor.enabledOn : ko.monitor.enabledOff}
                </td>
                <td className="py-2 text-right">
                  <Link
                    to={`/monitors/${b.id}/display`}
                    className="text-accent-700 hover:underline"
                  >
                    {ko.monitor.openDisplay}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
