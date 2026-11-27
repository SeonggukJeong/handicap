import { ko } from "../../i18n/ko";
import { sparkPath } from "../../report/sparkPath";
import { CHART_H_MM, CHART_W_MM, PLOT_X0_MM, PLOT_X1_MM, fmtElapsed, markerX } from "../chartModel";
import type { PrintDoc } from "../buildPrintDoc";
import { latencyLinePoints } from "../latencyChart";

const K = ko.print.latencyChart;

const PLOT_TOP = 8;
const PLOT_BOTTOM = 47;
const TIME_LABEL_Y = 51.5;
const FONT = 2.3;
const COLOR_GRID = "#e4e6ea";
const COLOR_SUB = "#5b6170";

const r2 = (n: number): number => Math.round(n * 100) / 100;
const tickText = (v: number): string => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

function LatencySvg({ doc }: { doc: PrintDoc }) {
  const c = doc.chart;
  const m = doc.latencyChart;
  if (m === null) return null;
  const d = c.durationSec;
  const yMax = Math.max(m.yTicks[m.yTicks.length - 1] ?? 1, 1e-9);
  const plotH = PLOT_BOTTOM - PLOT_TOP;
  const y = (v: number) => r2(PLOT_BOTTOM - (v / yMax) * plotH);
  const box = {
    xMax: d,
    yMax,
    x0: PLOT_X0_MM,
    x1: PLOT_X1_MM,
    yTop: PLOT_TOP,
    yBottom: PLOT_BOTTOM,
  };
  const bins = m.bins;
  return (
    <svg
      viewBox={`0 0 ${CHART_W_MM} ${CHART_H_MM}`}
      width="100%"
      role="img"
      aria-label={K.aria}
      fontSize={FONT}
    >
      {m.yTicks.map((t) => (
        <g key={`y${t}`}>
          <line
            x1={PLOT_X0_MM}
            x2={PLOT_X1_MM}
            y1={y(t)}
            y2={y(t)}
            stroke={COLOR_GRID}
            strokeWidth={0.2}
          />
          <text x={PLOT_X0_MM - 1} y={r2(y(t) + 0.8)} textAnchor="end" fill={COLOR_SUB}>
            {tickText(t)}
          </text>
        </g>
      ))}
      {c.timeTicks.map((t) => (
        <text
          key={`t${t}`}
          x={r2(markerX(t, d))}
          y={TIME_LABEL_Y}
          textAnchor="middle"
          fill={COLOR_SUB}
        >
          {fmtElapsed(t)}
        </text>
      ))}
      <line
        x1={PLOT_X0_MM}
        x2={PLOT_X1_MM}
        y1={PLOT_BOTTOM}
        y2={PLOT_BOTTOM}
        stroke={COLOR_SUB}
        strokeWidth={0.2}
      />
      {c.steady &&
        (
          [
            ["steady-start", c.steady.startSec],
            ["steady-end", c.steady.endSec],
          ] as const
        ).map(([key, sec]) => {
          const x = r2(markerX(sec, d));
          return (
            <line
              key={key}
              data-steady-line=""
              x1={x}
              x2={x}
              y1={PLOT_TOP}
              y2={PLOT_BOTTOM}
              stroke="#475569"
              strokeWidth={0.3}
              strokeDasharray="3 1.5"
            />
          );
        })}
      <path
        data-latency-line="mean"
        d={sparkPath(
          latencyLinePoints(bins, (b) => b.meanMs),
          box,
        )}
        fill="none"
        stroke="#000"
        strokeWidth={0.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        data-latency-line="p95"
        d={sparkPath(
          latencyLinePoints(bins, (b) => b.p95Ms),
          box,
        )}
        fill="none"
        stroke="#000"
        strokeWidth={0.5}
        strokeDasharray="1.6 1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LatencyChart({ doc }: { doc: PrintDoc }) {
  const m = doc.latencyChart;
  if (m === null) return null;
  return (
    <section>
      <div className="p-chart">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <b className="p-bold">{K.title}</b>
          <div className="p-legend">
            <span>
              <i className="p-sw p-sw--solid" aria-hidden="true" />
              {K.mean}
            </span>
            <span>
              <i className="p-sw p-sw--dash" aria-hidden="true" />
              {m.p95Label}
            </span>
          </div>
        </div>
        <LatencySvg doc={doc} />
        <div className="p-note">
          {K.caption(m.binText)}
          {m.capped && ` ${K.capped}`}
        </div>
      </div>
    </section>
  );
}
