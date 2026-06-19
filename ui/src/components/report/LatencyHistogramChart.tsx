import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { HistogramBucket } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { formatLatency } from "./format";

type Props = {
  buckets: HistogramBucket[];
  width?: number;
  height?: number;
};

export function LatencyHistogramChart({ buckets, width = 720, height = 240 }: Props) {
  // Buckets are already log-spaced from the backend; render as a categorical bar
  // chart (equal-width bars) labelled by the bucket's lower edge. The log scale
  // is baked into the boundaries — do NOT use a Recharts log axis (finicky for bars).
  type Datum = { label: string; range: string; count: number };
  const data: Datum[] = buckets.map((b) => ({
    label: formatLatency(b.lower_us),
    range: `${formatLatency(b.lower_us)} – ${formatLatency(b.upper_us)}`,
    count: b.count,
  }));
  const isEmpty = data.length === 0;
  return (
    <section aria-label={ko.report.latencyHistogramLabel} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{ko.report.latencyDistTitle}</h4>
      {isEmpty ? (
        <p className="text-slate-500 text-sm italic">{ko.report.noLatencyData}</p>
      ) : (
        <BarChart width={width} height={height} data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="label" interval="preserveStartEnd" />
          <YAxis label={{ value: "count", angle: -90, position: "insideLeft" }} />
          <Tooltip
            labelFormatter={(_label, payload) => {
              const datum = payload?.[0]?.payload as Datum | undefined;
              return datum?.range ?? "";
            }}
          />
          <Bar dataKey="count" fill="#16a34a" isAnimationActive={false} />
        </BarChart>
      )}
    </section>
  );
}
