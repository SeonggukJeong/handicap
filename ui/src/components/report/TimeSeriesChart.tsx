import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ko } from "../../i18n/ko";
import type { SteadyMarks } from "./steadyMarks";
import { PageSection } from "../ui/PageSection";

type Point = { ts_second: number; value: number };

type Props = {
  title: string;
  data: Point[];
  yLabel: string;
  width?: number;
  height?: number;
  marks?: SteadyMarks | null;
};

export function TimeSeriesChart({ title, data, yLabel, width, height, marks }: Props) {
  // ts_second is unix epoch. Subtract the first one so the X axis reads as elapsed seconds.
  const t0 = data.length > 0 ? data[0].ts_second : 0;
  const series = data.map((p) => ({ x: p.ts_second - t0, y: p.value }));
  const xMax = marks
    ? Math.max(
        series.length > 0 ? series[series.length - 1].x : 0,
        ...marks.bands.map((b) => b.x2),
        ...marks.lines.map((l) => l.x),
      )
    : 0;
  const chart = (
    <LineChart width={width} height={height} data={series}>
      <CartesianGrid strokeDasharray="3 3" />
      {marks ? (
        <XAxis
          dataKey="x"
          type="number"
          domain={[0, xMax]}
          allowDecimals={false}
          label={{ value: "seconds", position: "insideBottom", offset: -4 }}
        />
      ) : (
        <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
      )}
      <YAxis label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
      <Tooltip />
      {marks?.bands.map((b) => (
        <ReferenceArea
          key={b.kind}
          x1={b.x1}
          x2={b.x2}
          fill={b.kind === "ramp" ? "#94a3b8" : "#f59e0b"}
          fillOpacity={b.kind === "ramp" ? 0.22 : 0.16}
          stroke="none"
        />
      ))}
      {marks?.lines.map((l) => (
        <ReferenceLine key={l.kind} x={l.x} stroke="#475569" strokeDasharray="4 3" />
      ))}
      <Line type="monotone" dataKey="y" stroke="#2563eb" dot={false} isAnimationActive={false} />
    </LineChart>
  );
  return (
    <PageSection sub ariaLabel={ko.report.timeSeriesAria(title)} title={title}>
      {width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          {chart}
        </ResponsiveContainer>
      )}
    </PageSection>
  );
}
