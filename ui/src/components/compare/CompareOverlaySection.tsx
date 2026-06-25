import { useState } from "react";
import { ko } from "../../i18n/ko";
import type { Report } from "../../api/schemas";
import { overlaySeries, type MetricKey } from "../../compare/overlaySeries";
import { CompareTimeSeriesChart } from "./CompareTimeSeriesChart";

// Stable display order (independent of toggle order). Titles/yLabels reuse the
// single-run report chart catalog keys (DRY — same metric, same wording).
const OVERLAY_METRICS: { key: MetricKey; title: string; yLabel: string }[] = [
  { key: "rps", title: ko.report.timeSeriesRequests, yLabel: "req/s" },
  { key: "p95", title: ko.report.timeSeriesP95, yLabel: "ms" },
  { key: "errors", title: ko.report.timeSeriesErrors, yLabel: "errors" },
];

type Props = { reports: Report[]; baselineIdx: number };

export function CompareOverlaySection({ reports, baselineIdx }: Props) {
  const [metrics, setMetrics] = useState<MetricKey[]>(["rps", "p95"]);
  return (
    <section aria-label={ko.compare.overlayTitle} className="mt-8">
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <h3 className="text-lg font-semibold">{ko.compare.overlayTitle}</h3>
        <fieldset className="flex gap-3" aria-label={ko.compare.overlayMetricsAria}>
          {OVERLAY_METRICS.map((m) => (
            <label key={m.key} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={metrics.includes(m.key)}
                onChange={(e) =>
                  setMetrics((prev) =>
                    e.target.checked ? [...prev, m.key] : prev.filter((k) => k !== m.key),
                  )
                }
              />
              {m.title}
            </label>
          ))}
        </fieldset>
      </div>
      {OVERLAY_METRICS.filter((m) => metrics.includes(m.key)).map((m) => {
        const series = overlaySeries(reports, baselineIdx, m.key);
        return series.rows.length === 0 ? (
          <p key={m.key} role="status" className="text-sm text-slate-500 mb-4">
            {ko.compare.overlayNoData}
          </p>
        ) : (
          <CompareTimeSeriesChart
            key={m.key}
            title={m.title}
            yLabel={m.yLabel}
            rows={series.rows}
            runs={series.runs}
          />
        );
      })}
    </section>
  );
}
