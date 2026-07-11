import type { Insight } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { runColor, runShortLabel } from "../../compare/runLabel";
import { floorPct } from "../report/format";
import { PageSection } from "../ui/PageSection";

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
const SEV_LABELS: Record<string, string | undefined> = ko.insightCompare.severity;

function identity(i: Insight): string {
  return `${i.kind}|${i.step_id ?? i.status_class ?? ""}`;
}

function repNumber(i: Insight): string | null {
  if (i.value != null) return i.value.toLocaleString("en-US");
  if (i.pct != null) return floorPct(i.pct * 100);
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
    <PageSection
      ariaLabel={ko.insightCompare.title}
      title={ko.insightCompare.title}
      className="mt-8"
    >
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{ko.insightCompare.empty}</p>
      ) : (
        <table className="text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left px-2 py-1 border-b border-slate-200 dark:border-slate-700">
                {ko.insightCompare.colInsight}
              </th>
              {reports.map((r, i) => (
                <th
                  key={r.run.id}
                  className="px-2 py-1 border-b border-slate-200 dark:border-slate-700 text-center"
                >
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="inline-block w-3 h-3 rounded-sm ring-1 ring-black/10 dark:ring-white/20 shrink-0"
                      style={{ backgroundColor: runColor(i) }}
                    />
                    {labels?.[r.run.id] ?? runShortLabel(r.run.id)}
                  </span>
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
                        {SEV_LABELS[i.severity] ?? i.severity}
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
    </PageSection>
  );
}
