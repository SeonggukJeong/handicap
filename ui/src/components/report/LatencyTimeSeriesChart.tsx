import type { ReactElement } from "react";
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
import { isLonePoint, latencyTooltipText } from "../../report/latencyText";
import type { SteadyMarks } from "./steadyMarks";
import { PageSection } from "../ui/PageSection";
import { SampleTag } from "./SampleTag";

type Point = { ts_second: number; mean: number | null; p95: number | null; capped: boolean };

type Props = {
  data: Point[];
  marks?: SteadyMarks | null;
  sampleTag?: string | null;
  width?: number;
  height?: number;
};

const MEAN_COLOR = "#2563eb";
const P95_COLOR = "#9333ea";
const CAP_MS = 60000;

type DotProps = { cx?: number; cy?: number; index?: number; key?: string };

/** 앞뒤가 빈 초는 선이 못 그리므로 점으로. 그 밖에는 빈 그룹(recharts 2 dot 함수는 element를 돌려야 한다). */
function loneDot(values: (number | null)[], color: string) {
  const LoneDot = (props: DotProps): ReactElement<SVGElement> => {
    const { cx, cy, index, key } = props;
    if (index !== undefined && cx !== undefined && cy !== undefined && isLonePoint(values, index)) {
      return <circle key={key} cx={cx} cy={cy} r={2} fill={color} stroke="none" />;
    }
    return <g key={key} />;
  };
  return LoneDot;
}

export function LatencyTimeSeriesChart({ data, marks, sampleTag, width, height }: Props) {
  const t0 = data.length > 0 ? data[0].ts_second : 0;
  const series = data.map((p) => ({
    x: p.ts_second - t0,
    mean: p.mean === null ? null : Math.min(p.mean, CAP_MS),
    p95: p.p95 === null ? null : Math.min(p.p95, CAP_MS),
    capped: p.capped,
  }));
  const xMax = marks
    ? Math.max(
        series.length > 0 ? series[series.length - 1].x : 0,
        ...marks.bands.map((b) => b.x2),
        ...marks.lines.map((l) => l.x),
      )
    : 0;
  const meanValues = series.map((s) => s.mean);
  const p95Values = series.map((s) => s.p95);
  const anyCapped = data.some((p) => p.capped);
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
      {/* 축 폭은 위아래 TimeSeriesChart와 같은 기본값(60)이어야 같은 초가 같은 x에 선다. 단위는 제목
          「응답 시간 (ms)」에 있어 회전 글자를 두지 않는다(「60,000」은 60 안에 든다). */}
      <YAxis tickFormatter={(v: number) => v.toLocaleString("en-US")} />
      <Tooltip
        formatter={(value, name, item) => {
          const v = typeof value === "number" ? value : Number(value);
          const capped = name === "mean" ? Boolean(item?.payload?.capped) : false;
          return [
            latencyTooltipText(v, capped),
            name === "mean" ? ko.report.latencyChart.mean : ko.report.latencyChart.p95,
          ];
        }}
      />
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
      <Line
        type="monotone"
        dataKey="p95"
        name="p95"
        stroke={P95_COLOR}
        strokeWidth={1.6}
        strokeDasharray="6 4"
        dot={loneDot(p95Values, P95_COLOR)}
        isAnimationActive={false}
      />
      <Line
        type="monotone"
        dataKey="mean"
        name="mean"
        className="mean-line"
        stroke={MEAN_COLOR}
        strokeWidth={2}
        dot={loneDot(meanValues, MEAN_COLOR)}
        isAnimationActive={false}
      />
    </LineChart>
  );
  const legend = (
    <span className="ml-auto flex items-center gap-3.5 text-xs text-slate-600">
      <span className="inline-flex items-center">
        <i
          aria-hidden="true"
          className="mr-1 inline-block w-[18px] border-t-2"
          style={{ borderTopColor: MEAN_COLOR, borderTopStyle: "solid" }}
        />
        {ko.report.latencyChart.mean}
      </span>
      <span className="inline-flex items-center">
        <i
          aria-hidden="true"
          className="mr-1 inline-block w-[18px] border-t-2"
          style={{ borderTopColor: P95_COLOR, borderTopStyle: "dashed" }}
        />
        {ko.report.latencyChart.p95}
      </span>
    </span>
  );
  return (
    <PageSection
      sub
      ariaLabel={ko.report.timeSeriesAria(ko.report.latencyChart.title)}
      title={ko.report.latencyChart.title}
      titleAside={
        <>
          {sampleTag ? <SampleTag name={sampleTag} /> : null}
          {legend}
        </>
      }
    >
      {width != null && height != null ? (
        chart
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          {chart}
        </ResponsiveContainer>
      )}
      <p className="mt-1.5 text-xs text-slate-500">{ko.report.latencyChart.hint}</p>
      {anyCapped ? (
        <p className="mt-1 text-xs text-slate-500">{ko.report.latencyChart.hintCapped}</p>
      ) : null}
    </PageSection>
  );
}
