import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

type Point = { ts_second: number; value: number };

type Props = {
  title: string;
  data: Point[];
  yLabel: string;
  width?: number;
  height?: number;
};

export function TimeSeriesChart({ title, data, yLabel, width = 720, height = 220 }: Props) {
  // ts_second is unix epoch. Subtract the first one so the X axis reads as elapsed seconds.
  const t0 = data.length > 0 ? data[0].ts_second : 0;
  const series = data.map((p) => ({ x: p.ts_second - t0, y: p.value }));
  return (
    <section aria-label={`Time series — ${title}`} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{title}</h4>
      <LineChart width={width} height={height} data={series}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
        <YAxis label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
        <Tooltip />
        <Line type="monotone" dataKey="y" stroke="#2563eb" dot={false} isAnimationActive={false} />
      </LineChart>
    </section>
  );
}
