import type { ReportStep } from "../../api/schemas";

type StepMeta = { id: string; name: string; method: string; url: string };

type Props = { steps: ReportStep[]; meta: Map<string, StepMeta> };

export function StepStatsTable({ steps, meta }: Props) {
  return (
    <section aria-label="Per-step stats" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Steps</h3>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">Step</th>
            <th className="py-2 pr-4 font-medium">Method</th>
            <th className="py-2 pr-4 font-medium">URL</th>
            <th className="py-2 pr-4 font-medium">Requests</th>
            <th className="py-2 pr-4 font-medium">Errors</th>
            <th className="py-2 pr-4 font-medium">p50 ms</th>
            <th className="py-2 pr-4 font-medium">p95 ms</th>
            <th className="py-2 pr-4 font-medium">p99 ms</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const m = meta.get(s.step_id);
            return (
              <tr key={s.step_id} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-medium">{m?.name ?? s.step_id}</td>
                <td className="py-2 pr-4 font-mono text-xs">{m?.method ?? ""}</td>
                <td className="py-2 pr-4 font-mono text-xs break-all">{m?.url ?? ""}</td>
                <td className="py-2 pr-4">{s.count}</td>
                <td className="py-2 pr-4">{s.error_count}</td>
                <td className="py-2 pr-4">{s.p50_ms}</td>
                <td className="py-2 pr-4">{s.p95_ms}</td>
                <td className="py-2 pr-4">{s.p99_ms}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
