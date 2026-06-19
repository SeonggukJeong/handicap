import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import type { PercentilePoint } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { formatLatency } from "./format";

type Props = {
  curve: PercentilePoint[];
  width?: number;
  height?: number;
};

const QUANTILE_LABEL: Record<string, string> = {
  "0": "min",
  "0.1": "p10",
  "0.25": "p25",
  "0.5": "p50",
  "0.75": "p75",
  "0.9": "p90",
  "0.95": "p95",
  "0.99": "p99",
  "0.999": "p99.9",
  "0.9999": "p99.99",
  "1": "max",
};

function labelFor(q: number): string {
  return QUANTILE_LABEL[String(q)] ?? `p${(q * 100).toFixed(2)}`;
}

export function PercentileCurveChart({ curve, width = 720, height = 220 }: Props) {
  // Categorical, evenly-spaced quantile axis so the tail (p99 → p99.99) reads
  // clearly. type="linear" — monotone smoothing would misrepresent the tail
  // (ui/CLAUDE.md repo trap, same as StageCurvePreview). y in milliseconds.
  const data = curve.map((p) => ({ label: labelFor(p.quantile), ms: p.value_us / 1_000 }));
  return (
    <section aria-label={ko.report.latencyPercentileCurveLabel} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{ko.report.latencyDistTitle}</h4>
      <LineChart width={width} height={height} data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="label" type="category" />
        <YAxis label={{ value: "ms", angle: -90, position: "insideLeft" }} />
        <Tooltip
          formatter={(value) => [formatLatency(Math.round(Number(value) * 1_000)), "latency"]}
        />
        <Line type="linear" dataKey="ms" stroke="#2563eb" dot isAnimationActive={false} />
      </LineChart>
    </section>
  );
}
