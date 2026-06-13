import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ko } from "../../i18n/ko";
import type { ActiveVuSample } from "../../api/schemas";

type Props = {
  series: ActiveVuSample[];
  width?: number;
  height?: number;
};

export function ActiveVuChart({ series, width = 720, height = 220 }: Props) {
  // ts_second is unix epoch — subtract the first so the X axis reads as elapsed seconds.
  const t0 = series.length > 0 ? series[0].ts_second : 0;
  const data = series.map((s) => ({ x: s.ts_second - t0, desired: s.desired, actual: s.actual }));
  return (
    <section aria-label={ko.report.activeVuTitle} className="mb-6">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{ko.report.activeVuTitle}</h4>
      <LineChart width={width} height={height} data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
        <YAxis label={{ value: "VU", angle: -90, position: "insideLeft" }} allowDecimals={false} />
        <Tooltip />
        <Legend />
        <Line
          type="linear"
          dataKey="desired"
          name={ko.report.activeVuDesired}
          stroke="#94a3b8"
          strokeDasharray="4 2"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="linear"
          dataKey="actual"
          name={ko.report.activeVuActual}
          stroke="#2563eb"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </section>
  );
}
