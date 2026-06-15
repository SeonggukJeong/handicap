import type { Insight } from "../../api/schemas";
import { ko } from "../../i18n/ko";

type MatrixReport = { run: { id: string }; insights?: Insight[] };
type Props = {
  reports: MatrixReport[];
  stepLabelMap: Map<string, string>;
  // CompareMatrix와 열 헤더를 lockstep으로 — 부모가 runLabels를 내려준다. 미주입이면 slice 폴백.
  labels?: Record<string, string>;
};

// 음영은 canonical InsightPanel(`report/InsightPanel.tsx`)의 SEV_CLASS와 일치(-50 배경).
const SEV_CLASS: Record<string, string> = {
  critical: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  info: "border-slate-300 bg-slate-50 text-slate-700",
};
const LABELS: Record<string, string | undefined> = ko.insightLabels;

function identity(i: Insight): string {
  return `${i.kind}|${i.step_id ?? i.status_class ?? ""}`;
}

function repNumber(i: Insight): string | null {
  if (i.value != null) return i.value.toLocaleString("en-US");
  if (i.pct != null) return `${(i.pct * 100).toFixed(1)}%`;
  if (i.count != null) return i.count.toLocaleString("en-US");
  if (i.window_seconds != null) return `${i.window_seconds}s`;
  return null;
}

function rowLabel(i: Insight, stepLabelMap: Map<string, string>): string {
  const base = LABELS[i.kind] ?? i.kind;
  if (i.step_id) return `${base} · ${stepLabelMap.get(i.step_id) ?? i.step_id}`;
  if (i.status_class) return `${base} · ${i.status_class}`;
  return base;
}

export function InsightCompareMatrix({ reports, stepLabelMap, labels }: Props) {
  const rows: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  const byRun = new Map<string, Map<string, Insight>>();
  for (const r of reports) {
    const m = new Map<string, Insight>();
    for (const i of r.insights ?? []) {
      const k = identity(i);
      m.set(k, i);
      if (!seen.has(k)) {
        seen.add(k);
        rows.push({ key: k, label: rowLabel(i, stepLabelMap) });
      }
    }
    byRun.set(r.run.id, m);
  }

  return (
    <section aria-label={ko.insightCompare.title} className="mt-8">
      <h3 className="text-lg font-semibold mb-2">{ko.insightCompare.title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{ko.insightCompare.empty}</p>
      ) : (
        <table className="text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left px-2 py-1 border-b border-slate-200 dark:border-slate-700">
                {ko.insightCompare.colInsight}
              </th>
              {reports.map((r) => (
                <th
                  key={r.run.id}
                  className="px-2 py-1 border-b border-slate-200 dark:border-slate-700 text-center"
                >
                  {labels?.[r.run.id] ?? `#${r.run.id.slice(-6)}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="px-2 py-1 border-b border-slate-100 dark:border-slate-800">
                  {row.label}
                </td>
                {reports.map((r) => {
                  const i = byRun.get(r.run.id)?.get(row.key);
                  if (!i) {
                    return (
                      <td
                        key={r.run.id}
                        className="px-2 py-1 border-b border-slate-100 dark:border-slate-800 text-center text-slate-400"
                      >
                        —
                      </td>
                    );
                  }
                  const num = repNumber(i);
                  return (
                    <td
                      key={r.run.id}
                      className="px-2 py-1 border-b border-slate-100 dark:border-slate-800 text-center"
                    >
                      <span
                        className={[
                          "inline-block rounded border px-1.5 py-0.5 text-xs",
                          SEV_CLASS[i.severity] ?? SEV_CLASS.info,
                        ].join(" ")}
                      >
                        {i.severity}
                        {num != null ? ` ${num}` : ""}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
