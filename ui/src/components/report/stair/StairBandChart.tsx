import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import type { StairBandProps } from "./stairBandTypes";
import { buildBandSeries } from "./stairBandSeries";
import { ko } from "../../../i18n/ko";
import { linearDomain, logDomain } from "./stairChartDomain";
import { STAIR_STATE_COLOR } from "./stairColors";

const c = ko.report.stair.chart;

type DotProps = { cx?: number; cy?: number; index?: number; value?: unknown };

function p99Dot({ cx, cy, index, value }: DotProps) {
  if (value == null || cx == null || cy == null) return <g key={`p${index}`} />;
  return (
    <circle key={`p${index}`} data-testid="stair-p99-dot" cx={cx} cy={cy} r={1.8} fill="#334155" />
  );
}

export function StairBandChart({
  seconds,
  bands,
  targetLine,
  steps,
  width,
  height,
}: StairBandProps) {
  const data = buildBandSeries(seconds);
  const starts = bands.map((b) => b.start_s);
  const ends = bands.map((b) => b.end_s);
  const x0 = starts.length ? Math.min(...starts) : 0;
  const x1 = ends.length ? Math.max(...ends) : data.length ? data[data.length - 1].offset_s : 1;
  const p99Domain = logDomain(data.map((d) => d.p99_ms));
  const rpsDomain = linearDomain([
    ...targetLine.map((t) => t.target),
    ...data.map((d) => d.launched),
  ]);
  const stateOf = (i: number) => steps.find((s) => s.index === i)?.state ?? "not_measured";
  const chart = (
    <ComposedChart
      width={width}
      height={height}
      data={data}
      margin={{ top: 8, right: 8, bottom: 14 }}
    >
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis
        dataKey="offset_s"
        type="number"
        domain={[x0, x1]}
        allowDataOverflow
        label={{ value: c.axisSeconds, position: "insideBottom", offset: -2 }}
        height={36}
      />
      <YAxis
        yAxisId="l"
        domain={rpsDomain}
        allowDataOverflow
        label={{ value: c.axisRps, angle: -90, position: "insideLeft" }}
      />
      <YAxis
        yAxisId="r"
        orientation="right"
        scale="log"
        domain={p99Domain}
        allowDataOverflow
        label={{ value: c.axisP99, angle: 90, position: "insideRight" }}
      />
      {bands.map((b, i) => (
        <ReferenceArea
          key={`${b.index}-${b.kind}-${i}`}
          yAxisId="l"
          x1={b.start_s}
          x2={b.end_s}
          fill={b.kind === "measure" ? STAIR_STATE_COLOR[stateOf(b.index)] : "#94a3b8"}
          fillOpacity={b.kind === "measure" ? 0.18 : 0.22}
          ifOverflow="hidden"
        />
      ))}
      <Line
        className="stair-target-line"
        yAxisId="l"
        data={targetLine}
        dataKey="target"
        type="linear"
        stroke="#64748b"
        strokeDasharray="5 4"
        dot={false}
        activeDot={false}
        isAnimationActive={false}
      />
      <Line
        yAxisId="l"
        dataKey="launched"
        type="linear"
        stroke="#2563eb"
        strokeWidth={2}
        dot={false}
        activeDot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
      <Line
        yAxisId="r"
        dataKey="p99_ms"
        type="linear"
        stroke="#334155"
        strokeWidth={1}
        dot={p99Dot}
        activeDot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
    </ComposedChart>
  );
  return (
    <div>
      <div role="img" aria-label={c.bandLabel}>
        {width != null && height != null ? (
          chart
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            {chart}
          </ResponsiveContainer>
        )}
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        <li>
          <span className="inline-block w-5 border-t-2 border-dashed border-slate-500 align-middle mr-1" />
          <span>{c.legendTarget}</span>
        </li>
        <li>
          <span className="inline-block w-5 border-t-2 border-blue-600 align-middle mr-1" />
          <span>{c.legendLaunched}</span>
        </li>
        <li>
          <span className="inline-block w-5 border-t-2 border-slate-700 align-middle mr-1" />
          <span>{c.legendP99Right}</span>
        </li>
        <li>
          <span className="inline-block w-3 h-3 bg-slate-300 align-middle mr-1" />
          <span>{c.legendBandRamp}</span>
        </li>
        <li>
          <span className="inline-block w-3 h-3 bg-emerald-200 align-middle mr-1" />
          <span>{c.legendBandMeasure}</span>
        </li>
      </ul>
    </div>
  );
}
