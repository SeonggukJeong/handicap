import type { GroupLatency } from "../../api/schemas";

type GroupMeta = { name: string };
type Props = { breakdown: GroupLatency[]; meta: Map<string, GroupMeta> };

/** Page-load latency per `parallel` node = wall-clock of the concurrent block
 *  (≈ max of branches), aggregated run-total. Separate from StepStatsTable because
 *  the parallel node's id is not an http-leaf metric row (A2-2). */
export function GroupLatencyTable({ breakdown, meta }: Props) {
  if (breakdown.length === 0) return null;
  return (
    <section aria-label="Page load latency" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">페이지 로드 레이턴시</h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">Parallel node</th>
            <th className="py-2 pr-4 font-medium">Pages</th>
            <th className="py-2 pr-4 font-medium">p50</th>
            <th className="py-2 pr-4 font-medium">p95</th>
            <th className="py-2 pr-4 font-medium">p99</th>
            <th className="py-2 pr-4 font-medium">max</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((g) => {
            const m = meta.get(g.step_id);
            return (
              <tr key={g.step_id} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-medium">
                  {m?.name ?? g.step_id} <span className="text-slate-400">(parallel)</span>
                </td>
                <td className="py-2 pr-4">{g.count}</td>
                <td className="py-2 pr-4">{g.p50_ms} ms</td>
                <td className="py-2 pr-4">{g.p95_ms} ms</td>
                <td className="py-2 pr-4">{g.p99_ms} ms</td>
                <td className="py-2 pr-4">{g.max_ms} ms</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
