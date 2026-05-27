import { Link, useParams } from "react-router-dom";
import { useAbortRun, useRun, useRunMetrics } from "../api/hooks";
import { StatusBadge } from "../components/StatusBadge";
import type { RunStatus } from "../api/schemas";

const TERMINAL: ReadonlyArray<RunStatus> = ["completed", "failed", "aborted"];

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const run = useRun(id);
  const abort = useAbortRun(id ?? "");
  const terminal = run.data ? TERMINAL.includes(run.data.status) : false;
  const metrics = useRunMetrics(id, terminal);

  if (run.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (run.error) return <p className="text-red-600">{(run.error as Error).message}</p>;
  if (!run.data) return <p className="text-slate-500">Not found.</p>;

  const r = run.data;
  const totalCount = metrics.data?.windows.reduce((acc, w) => acc + w.count, 0) ?? 0;
  const totalErrors = metrics.data?.windows.reduce((acc, w) => acc + w.error_count, 0) ?? 0;
  const rps =
    r.profile.duration_seconds > 0
      ? Math.round((totalCount / r.profile.duration_seconds) * 10) / 10
      : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-3">
            Run <span className="font-mono text-base text-slate-600">{r.id.slice(0, 8)}</span>
            <StatusBadge status={r.status} />
          </h2>
          <p className="text-sm text-slate-600">
            <Link to={`/scenarios/${r.scenario_id}/runs`} className="hover:underline">
              ← Scenario runs
            </Link>
          </p>
        </div>
        {r.status === "running" && (
          <button
            type="button"
            onClick={() => abort.mutate()}
            disabled={abort.isPending}
            className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            {abort.isPending ? "Aborting…" : "Abort"}
          </button>
        )}
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6 text-sm">
        <Card label="VUs">{r.profile.vus}</Card>
        <Card label="Duration">{r.profile.duration_seconds}s</Card>
        <Card label="Total requests">{totalCount}</Card>
        <Card label="Errors">{totalErrors}</Card>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
        <Card label="Avg RPS">{rps}</Card>
        <Card label="Created">{new Date(r.created_at).toLocaleString()}</Card>
      </div>

      <h3 className="text-lg font-semibold mb-2">Metric windows</h3>
      {!metrics.data || metrics.data.windows.length === 0 ? (
        <p className="text-slate-500 text-sm">
          {terminal ? "No metrics recorded." : "Waiting for first batch…"}
        </p>
      ) : (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Second</th>
              <th className="py-2 pr-4 font-medium">Step</th>
              <th className="py-2 pr-4 font-medium">Count</th>
              <th className="py-2 pr-4 font-medium">Errors</th>
              <th className="py-2 pr-4 font-medium">Status codes</th>
            </tr>
          </thead>
          <tbody>
            {metrics.data.windows.map((w) => (
              <tr key={`${w.ts_second}-${w.step_id}`} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-mono">{w.ts_second}</td>
                <td className="py-2 pr-4">{w.step_id}</td>
                <td className="py-2 pr-4">{w.count}</td>
                <td className="py-2 pr-4">{w.error_count}</td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {Object.entries(w.status_counts)
                    .map(([s, c]) => `${s}:${c}`)
                    .join(" ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-slate-200 rounded-md p-3 bg-white">
      <div className="text-slate-500 text-xs">{label}</div>
      <div className="text-lg font-semibold">{children}</div>
    </div>
  );
}
