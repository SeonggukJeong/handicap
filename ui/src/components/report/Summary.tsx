import type { ReportSummary } from "../../api/schemas";

type Props = { summary: ReportSummary };

export function Summary({ summary }: Props) {
  const cards: Array<{ label: string; value: string }> = [
    { label: "Total requests", value: summary.count.toLocaleString() },
    { label: "Errors", value: summary.errors.toLocaleString() },
    { label: "Avg RPS", value: summary.rps.toFixed(1) },
    { label: "Duration", value: `${summary.duration_seconds}s` },
    { label: "p50", value: `${summary.p50_ms} ms` },
    { label: "p95", value: `${summary.p95_ms} ms` },
    { label: "p99", value: `${summary.p99_ms} ms` },
  ];
  return (
    <section aria-label="Report summary" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Summary</h3>
      <div className="grid grid-cols-3 md:grid-cols-7 gap-3 text-sm">
        {cards.map((c) => (
          <div key={c.label} className="border border-slate-200 rounded-md p-3 bg-white">
            <div className="text-slate-500 text-xs">{c.label}</div>
            <div className="text-lg font-semibold">{c.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
