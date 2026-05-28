import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

type Props = {
  distribution: Record<string, number>;
  width?: number;
  height?: number;
};

export function StatusDistribution({ distribution, width = 480, height = 240 }: Props) {
  const data = Object.entries(distribution)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const isEmpty = data.length === 0;
  return (
    <section aria-label="Status distribution" className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Status codes</h3>
      {isEmpty ? (
        <p className="text-slate-500 text-sm italic">No status data.</p>
      ) : (
        <BarChart width={width} height={height} data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="code" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="count" fill="#16a34a" isAnimationActive={false} />
        </BarChart>
      )}
    </section>
  );
}
