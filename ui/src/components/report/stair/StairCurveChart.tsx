import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import type { StairStep } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { STAIR_STATE_COLOR } from "./stairColors";
import { floorPct1, formatMs } from "./stairFormat";

const c = ko.report.stair.chart;

type Row = {
  idx: number;
  label: string;
  p99: number | null;
  p50: number | null;
  state: StairStep["state"];
  knee: boolean;
};

type DotProps = { cx?: number; cy?: number; payload?: Row; index?: number };

function pointLabel(row: Row): string[] {
  const out: string[] = [];
  if (row.state === "spike") out.push(c.labelSpike);
  if (row.state === "saturated") out.push(c.labelSaturated);
  if (row.knee) out.push(c.labelKnee);
  return out;
}

function renderDot({ cx, cy, payload, index }: DotProps) {
  if (payload == null || payload.p99 == null || cx == null || cy == null) {
    return <g key={`d${index}`} />;
  }
  const extra = pointLabel(payload);
  const text = [`${formatMs(payload.p99 * 1000)}`, ...extra].join(" ");
  return (
    <g key={`d${index}`}>
      {payload.knee ? (
        <circle
          data-testid="stair-knee"
          cx={cx}
          cy={cy}
          r={10}
          fill="none"
          stroke="#2563eb"
          strokeWidth={2}
        />
      ) : null}
      <circle
        data-testid="stair-dot"
        data-state={payload.state}
        cx={cx}
        cy={cy}
        r={5}
        fill={STAIR_STATE_COLOR[payload.state]}
      />
      <text x={cx} y={cy - 14} textAnchor="middle" fontSize={11} fill="#334155">
        {text}
      </text>
    </g>
  );
}

type Props = { steps: StairStep[]; width?: number; height?: number };

export function StairCurveChart({ steps, width, height }: Props) {
  const rows: Row[] = steps.map((s, idx) => {
    const measured = s.state !== "not_measured" && s.p99_us > 0;
    return {
      idx,
      label: String(s.target),
      p99: measured ? s.p99_us / 1000 : null,
      p50: measured && s.p50_us > 0 ? s.p50_us / 1000 : null,
      state: s.state,
      knee: s.knee,
    };
  });
  const sat = steps.find((s) => s.state === "saturated" || s.state === "unconfirmed");
  const chart = (
    <ComposedChart width={width} height={height} data={rows} margin={{ top: 28, right: 16 }}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis
        dataKey="idx"
        type="number"
        domain={[-0.5, steps.length - 0.5]}
        ticks={steps.map((_, i) => i)}
        tickFormatter={(i: number) => String(steps[i]?.target ?? "")}
        allowDecimals={false}
      />
      <YAxis
        scale="log"
        domain={["auto", "auto"]}
        allowDataOverflow
        label={{ value: c.axisMs, angle: -90, position: "insideLeft" }}
      />
      <YAxis yAxisId="bg" hide domain={[0, 1]} />
      {sat ? (
        <ReferenceArea
          yAxisId="bg"
          y1={0}
          y2={1}
          x1={sat.index - 0.5}
          x2={steps.length - 0.5}
          fill="#ef4444"
          fillOpacity={0.08}
          ifOverflow="visible"
        />
      ) : null}
      <Line
        yAxisId={0}
        type="linear"
        dataKey="p99"
        stroke="#334155"
        strokeWidth={2}
        dot={renderDot}
        activeDot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
      <Line
        yAxisId={0}
        type="linear"
        dataKey="p50"
        stroke="#64748b"
        strokeDasharray="5 4"
        dot={false}
        activeDot={false}
        connectNulls={false}
        isAnimationActive={false}
      />
    </ComposedChart>
  );
  return (
    <div>
      <div role="img" aria-label={c.curveLabel}>
        {width != null && height != null ? (
          chart
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            {chart}
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-1 text-xs text-slate-600" aria-label={c.achievedHint}>
        <span className="mr-2 font-medium">{c.achievedRow}</span>
        <ul className="inline-flex flex-wrap gap-x-4 gap-y-1">
          {steps.map((s) => {
            const has = s.achieved != null && s.target > 0 && s.state !== "not_measured";
            const ratio = has ? (s.achieved as number) / s.target : null;
            return (
              <li key={s.index}>
                <span className="text-slate-500">{s.target}: </span>
                <span
                  className={
                    ratio != null && ratio < 0.95 ? "text-red-600 font-medium" : "text-emerald-700"
                  }
                >
                  {ratio == null ? "—" : floorPct1(ratio)}
                </span>
              </li>
            );
          })}
        </ul>
        <span className="ml-2 text-slate-500">{c.achievedHint}</span>
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        <li>
          <span className="inline-block w-5 border-t-2 border-slate-700 align-middle mr-1" />
          <span>{c.legendP99}</span>
        </li>
        <li>
          <span className="inline-block w-5 border-t-2 border-dashed border-slate-500 align-middle mr-1" />
          <span>{c.legendP50}</span>
        </li>
        <li>
          <span className="inline-block w-3 h-3 rounded-full border-2 border-blue-600 align-middle mr-1" />
          <span>{c.legendKnee}</span>
        </li>
        <li>
          <span className="inline-block w-3 h-3 bg-red-100 align-middle mr-1" />
          <span>{c.legendAfter}</span>
        </li>
      </ul>
    </div>
  );
}
