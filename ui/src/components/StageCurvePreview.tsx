import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { Stage } from "../api/schemas";

/** Cumulative control points for the piecewise-linear rate curve: starts at
 *  (0, 0), then one point per stage at (sum of durations so far, stage target).
 *  Mirrors the engine's rate_at start-rate-0 semantics. */
// eslint-disable-next-line react-refresh/only-export-components
export function toControlPoints(stages: Stage[]): { t: number; rate: number }[] {
  const pts = [{ t: 0, rate: 0 }];
  let t = 0;
  for (const s of stages) {
    t += s.duration_seconds;
    pts.push({ t, rate: s.target });
  }
  return pts;
}

export function StageCurvePreview({
  stages,
  width,
  height,
}: {
  stages: Stage[];
  width?: number;
  height?: number;
}) {
  const data = toControlPoints(stages);
  // Compact inline sparkline: no CartesianGrid/Tooltip (the stage rows are the
  // accessible source of truth; this is a decorative preview). `type="linear"`
  // is deliberate — the rate curve is piecewise-linear (engine `rate_at`), NOT
  // smoothed; do not switch to "monotone". stroke matches TimeSeriesChart (blue-600).
  const chart = (
    <LineChart data={data} width={width} height={height}>
      <XAxis dataKey="t" type="number" unit="s" />
      <YAxis dataKey="rate" type="number" unit=" rps" />
      <Line type="linear" dataKey="rate" stroke="#2563eb" dot={false} isAnimationActive={false} />
    </LineChart>
  );
  // Tests pass explicit width/height (jsdom has no layout); production uses
  // ResponsiveContainer to fill the dialog column.
  return width != null && height != null ? (
    chart
  ) : (
    <ResponsiveContainer width="100%" height={120}>
      {chart}
    </ResponsiveContainer>
  );
}
