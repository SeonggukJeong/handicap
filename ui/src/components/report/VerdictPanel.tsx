import type { Verdict } from "../../api/schemas";
import { METRIC_LABEL, fmt } from "./verdictFormat";

export function VerdictPanel({ verdict }: { verdict: Verdict }) {
  return (
    <section aria-label="SLO verdict" className="mb-6 rounded border p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold mb-2">SLO</h3>
        <span
          className={[
            "inline-block rounded px-2 py-0.5 text-xs font-medium",
            verdict.passed ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900",
          ].join(" ")}
        >
          {verdict.passed ? "PASS" : "FAIL"}
        </span>
      </div>
      <table className="text-sm">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="pr-4">Metric</th>
            <th className="pr-4">Threshold</th>
            <th className="pr-4">Actual</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {verdict.criteria.map((r) => (
            <tr key={r.metric}>
              <td className="pr-4">{METRIC_LABEL[r.metric] ?? r.metric}</td>
              <td className="pr-4">
                {r.direction === "max" ? "≤" : "≥"} {fmt(r.metric, r.threshold)}
              </td>
              <td className="pr-4">{fmt(r.metric, r.actual)}</td>
              <td
                className={r.passed ? "text-emerald-700" : "text-red-700"}
                title={r.passed ? "pass" : "fail"}
              >
                {r.passed ? "✓" : "✗"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
