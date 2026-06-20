import { Link } from "react-router-dom";
import { usePoolWorkers } from "../api/hooks";
import { ko } from "../i18n/ko";

export function WorkerDashboardPage() {
  const { data, isLoading, isError } = usePoolWorkers();

  if (isLoading)
    return (
      <p role="status" className="text-slate-500">
        {ko.common.loading}
      </p>
    );
  if (isError) return <p role="alert">{ko.workers.loadError}</p>;
  if (!data) return null;

  if (!data.pool_mode)
    return (
      <section>
        <h1 className="text-lg font-semibold mb-4">{ko.workers.title}</h1>
        <p className="text-slate-600">{ko.workers.emptyNotPool}</p>
        <p className="mt-2 text-sm text-slate-500">{ko.workers.runbookHint}</p>
      </section>
    );

  const idle = data.workers.filter((w) => !w.busy).length;
  const busy = data.workers.length - idle;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">{ko.workers.title}</h1>
      </div>
      <p className="text-sm text-slate-500 mb-1">{ko.workers.subtitle}</p>
      <p className="text-sm text-slate-700 mb-4">{ko.workers.countSummary(idle, busy)}</p>
      {data.workers.length === 0 ? (
        <p className="text-slate-600">{ko.workers.emptyNoWorkers}</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4">{ko.workers.colHostname}</th>
              <th className="py-2 pr-4">{ko.workers.colWorkerId}</th>
              <th className="py-2 pr-4">{ko.workers.colStatus}</th>
              <th className="py-2 pr-4">{ko.workers.colCapacity}</th>
            </tr>
          </thead>
          <tbody>
            {data.workers.map((w) => (
              <tr key={w.worker_id} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-medium">{w.hostname || "—"}</td>
                <td className="py-2 pr-4 font-mono text-xs" title={w.worker_id}>
                  {w.worker_id}
                </td>
                <td className="py-2 pr-4">
                  {w.busy ? (
                    <>
                      {ko.workers.statusBusy}
                      {w.run_id ? (
                        <Link
                          to={`/runs/${w.run_id}`}
                          className="ml-1 text-blue-600 hover:underline"
                        >
                          ({w.run_id})
                        </Link>
                      ) : null}
                    </>
                  ) : (
                    ko.workers.statusIdle
                  )}
                </td>
                <td className="py-2 pr-4">{w.capacity_vus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
