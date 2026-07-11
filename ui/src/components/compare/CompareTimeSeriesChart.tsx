import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ko } from "../../i18n/ko";
import type { OverlayRow, OverlayRun } from "../../compare/overlaySeries";
import { PageSection } from "../ui/PageSection";

type Props = {
  title: string;
  yLabel: string;
  rows: OverlayRow[];
  runs: OverlayRun[];
  width?: number;
  height?: number;
};

// Multi-run per-second overlay. Mirrors report/TimeSeriesChart (fixed-default
// width/height, NO ResponsiveContainer → avoids the jsdom size-0 trap).
export function CompareTimeSeriesChart({
  title,
  yLabel,
  rows,
  runs,
  width = 720,
  height = 220,
}: Props) {
  return (
    <PageSection sub ariaLabel={ko.report.timeSeriesAria(title)} title={title}>
      <LineChart width={width} height={height} data={rows}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="elapsed"
          label={{ value: "seconds", position: "insideBottom", offset: -4 }}
        />
        <YAxis label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
        <Tooltip />
        <Legend />
        {runs.map((run) => (
          <Line
            key={run.key}
            type="monotone"
            dataKey={run.key}
            name={run.baseline ? ko.compare.overlayBaselineLabel(run.label) : run.label}
            stroke={run.color}
            connectNulls={false}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </PageSection>
  );
}
