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
import { labeledIndices } from "./stairPointLabels";
import { logDomain } from "./stairChartDomain";
import { STAIR_STATE_COLOR } from "./stairColors";
import { floorPct1, formatMs, stateLabel } from "./stairFormat";

const c = ko.report.stair.chart;

type Row = {
  idx: number;
  label: string;
  p99: number | null;
  p50: number | null;
  state: StairStep["state"];
  knee: boolean;
  labeled: boolean;
};

type DotProps = { cx?: number; cy?: number; payload?: Row; index?: number };

/** 확인 못 한 실패는 표 pill처럼 속 빈 점 — 같은 주황인 튄 계단과 모양으로 구별한다. */
function dotPaint(state: StairStep["state"]) {
  return state === "unconfirmed"
    ? { fill: "#ffffff", stroke: STAIR_STATE_COLOR.unconfirmed, strokeWidth: 2 }
    : { fill: STAIR_STATE_COLOR[state] };
}

const LEGEND_STATES = ["ok", "spike", "saturated", "unconfirmed"] as const;

function pointLabel(row: Row): string[] {
  const out: string[] = [];
  if (row.state === "spike") out.push(c.labelSpike);
  if (row.state === "saturated") out.push(c.labelSaturated);
  if (row.state === "unconfirmed") out.push(c.labelUnconfirmed);
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
        {...dotPaint(payload.state)}
      />
      {payload.labeled ? (
        <text
          x={cx}
          y={cy - 14}
          textAnchor="middle"
          fontSize={11}
          fill="#334155"
          stroke="#ffffff"
          strokeWidth={3}
          paintOrder="stroke"
        >
          {text}
        </text>
      ) : null}
    </g>
  );
}

type Props = { steps: StairStep[]; width?: number; height?: number };

export function StairCurveChart({ steps, width, height }: Props) {
  const base = steps.map((s) => {
    const measured = s.state !== "not_measured" && s.p99_us > 0;
    return {
      p99: measured ? s.p99_us / 1000 : null,
      p50: measured && s.p50_us > 0 ? s.p50_us / 1000 : null,
      state: s.state,
      knee: s.knee,
    };
  });
  const labeled = labeledIndices(base);
  const rows: Row[] = base.map((b, idx) => ({
    ...b,
    idx,
    label: String(steps[idx].target),
    labeled: labeled.has(idx),
  }));
  const yDomain = logDomain(rows.flatMap((r) => [r.p99, r.p50]));
  const sat = steps.find((s) => s.state === "saturated" || s.state === "unconfirmed");
  const chart = (
    <ComposedChart
      width={width}
      height={height}
      data={rows}
      margin={{ top: 28, right: 16, bottom: 18 }}
    >
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis
        dataKey="idx"
        type="number"
        domain={[-0.5, steps.length - 0.5]}
        ticks={steps.map((_, i) => i)}
        tickFormatter={(i: number) => String(steps[i]?.target ?? "")}
        allowDecimals={false}
        label={{ value: c.axisTarget, position: "insideBottom", offset: -12 }}
      />
      <YAxis scale="log" width={72} domain={yDomain} allowDataOverflow />
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
      <div className="text-xs text-slate-600">{c.axisMs}</div>
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
      <ul
        aria-label={c.legendStatesLabel}
        className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600"
      >
        {LEGEND_STATES.map((s) => (
          <li key={s}>
            <span
              aria-hidden="true"
              className="inline-block w-3 h-3 rounded-full align-middle mr-1 border-2"
              style={
                s === "unconfirmed"
                  ? { backgroundColor: "#ffffff", borderColor: STAIR_STATE_COLOR[s] }
                  : { backgroundColor: STAIR_STATE_COLOR[s], borderColor: STAIR_STATE_COLOR[s] }
              }
            />
            <span>{stateLabel(s)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
