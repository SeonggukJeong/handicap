import { ko } from "../../i18n/ko";
import {
  CHART_H_MM,
  CHART_W_MM,
  PLOT_X0_MM,
  PLOT_X1_MM,
  fmtElapsed,
  markerX,
} from "../chartModel";
import type { PrintDoc } from "../buildPrintDoc";

const K = ko.print.chart;

/** 세로 기하(mm, SVG 사용자 단위 = mm). 위쪽 두 줄은 표시선 라벨 자리. */
const PLOT_TOP = 8;
const PLOT_BOTTOM = 47;
const TIME_LABEL_Y = 51.5;
const FONT = 2.3;
const LABEL_Y = [2.8, 5.6];

const COLOR_LINE = "#3b4bc8";
const COLOR_TOP = "#b42318";
const COLOR_OTHER = "#f6c9c4";
const COLOR_GRID = "#e4e6ea";
const COLOR_SUB = "#5b6170";

const r2 = (n: number): number => Math.round(n * 100) / 100;
const tickText = (v: number): string => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

function ChartSvg({ doc }: { doc: PrintDoc }) {
  const c = doc.chart;
  const d = c.durationSec;
  const plotH = PLOT_BOTTOM - PLOT_TOP;
  const rpsMax = Math.max(c.rpsTicks[c.rpsTicks.length - 1] ?? 1, 1e-9);
  const errMax = Math.max(c.errTicks[c.errTicks.length - 1] ?? 1, 1e-9);
  const yRps = (v: number) => r2(PLOT_BOTTOM - (v / rpsMax) * plotH);
  const yErr = (v: number) => r2(PLOT_BOTTOM - (v / errMax) * plotH);
  const points = c.bins
    .map((b) => `${r2(markerX(b.startSec + b.seconds / 2, d))},${yRps(b.rps)}`)
    .join(" ");

  return (
    <svg
      role="img"
      aria-label={K.aria}
      width={`${CHART_W_MM}mm`}
      height={`${CHART_H_MM}mm`}
      viewBox={`0 0 ${CHART_W_MM} ${CHART_H_MM}`}
      fontSize={FONT}
    >
      {c.rpsTicks.map((t) => (
        <g key={`r${t}`}>
          <line
            x1={PLOT_X0_MM}
            x2={PLOT_X1_MM}
            y1={yRps(t)}
            y2={yRps(t)}
            stroke={COLOR_GRID}
            strokeWidth={0.2}
          />
          <text x={PLOT_X0_MM - 1} y={r2(yRps(t) + 0.8)} textAnchor="end" fill={COLOR_SUB}>
            {tickText(t)}
          </text>
        </g>
      ))}
      {c.errTicks.map((t) => (
        <text
          key={`e${t}`}
          x={PLOT_X1_MM + 1}
          y={r2(yErr(t) + 0.8)}
          textAnchor="start"
          fill={COLOR_TOP}
        >
          {tickText(t)}
        </text>
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
      {c.hasErrors &&
        c.bins.map((b, i) => {
          const x0 = markerX(b.startSec, d);
          const x1 = markerX(b.startSec + b.seconds, d);
          const w = r2((x1 - x0) * 0.8);
          const x = r2(x0 + (x1 - x0) * 0.1);
          const topY = yErr(b.topErr);
          const allY = yErr(b.topErr + b.otherErr);
          return (
            <g key={`b${i}`}>
              {b.topErr > 0 && (
                <rect x={x} y={topY} width={w} height={r2(PLOT_BOTTOM - topY)} fill={COLOR_TOP} />
              )}
              {b.otherErr > 0 && (
                <rect x={x} y={allY} width={w} height={r2(topY - allY)} fill={COLOR_OTHER} />
              )}
            </g>
          );
        })}
      {c.bins.length > 0 && (
        <polyline points={points} fill="none" stroke={COLOR_LINE} strokeWidth={0.5} />
      )}
      <line
        x1={PLOT_X0_MM}
        x2={PLOT_X1_MM}
        y1={PLOT_BOTTOM}
        y2={PLOT_BOTTOM}
        stroke={COLOR_SUB}
        strokeWidth={0.2}
      />
      {c.markers.map((m) => {
        const x = r2(markerX(m.sec, d));
        return (
          <g key={`m${m.sec}:${m.label}`}>
            <line
              x1={x}
              x2={x}
              y1={PLOT_TOP}
              y2={PLOT_BOTTOM}
              stroke={COLOR_TOP}
              strokeWidth={0.3}
              strokeDasharray="1 1"
            />
            <text
              className="p-chart-marker-label"
              x={r2(m.labelX)}
              y={LABEL_Y[m.level]}
              textAnchor={m.anchor}
              fill={COLOR_TOP}
              fontWeight={700}
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function ErrorChart({ doc }: { doc: PrintDoc }) {
  const c = doc.chart;
  const top = c.topStepId === null ? null : doc.table.rows.find((r) => r.stepId === c.topStepId);
  const hasOther = c.bins.some((b) => b.otherErr > 0);
  return (
    <section>
      <h2 className="p-h2">{ko.print.section.chart}</h2>
      <div className="p-chart">
        <ChartSvg doc={doc} />
        <div className="p-legend">
          <span>
            <i className="p-sw p-sw--line" aria-hidden="true" />
            {K.legendRps}
          </span>
          {c.hasErrors ? (
            <>
              <span>
                <i className="p-sw p-sw--top" aria-hidden="true" />
                {top ? K.legendTop(top.no, top.name) : K.legendTop(c.topStepId ?? "", "").trimEnd()}
              </span>
              {hasOther && (
                <span>
                  <i className="p-sw p-sw--other" aria-hidden="true" />
                  {K.legendOther}
                </span>
              )}
            </>
          ) : (
            <span>{K.legendNone}</span>
          )}
        </div>
        <div className="p-note">{doc.readingLine}</div>
      </div>
    </section>
  );
}
