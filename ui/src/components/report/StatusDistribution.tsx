import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ko } from "../../i18n/ko";
import { PageSection } from "../ui/PageSection";

type Props = {
  distribution: Record<string, number>;
  width?: number;
  height?: number;
};

export function StatusDistribution({ distribution, width, height }: Props) {
  const data = Object.entries(distribution)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const isEmpty = data.length === 0;
  const chart = (
    <BarChart width={width} height={height} data={data}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="code" />
      <YAxis />
      <Tooltip />
      <Bar dataKey="count" fill="#16a34a" isAnimationActive={false} />
    </BarChart>
  );
  return (
    <PageSection ariaLabel={ko.report.statusDistributionLabel} title={ko.report.statusCodesTitle}>
      {isEmpty ? (
        <p className="text-slate-500 text-sm italic">{ko.report.noStatusData}</p>
      ) : width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          {chart}
        </ResponsiveContainer>
      )}
    </PageSection>
  );
}
