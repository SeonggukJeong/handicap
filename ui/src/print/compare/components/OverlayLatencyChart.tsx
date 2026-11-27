import { ko } from "../../../i18n/ko";
import { sparkPath } from "../../../report/sparkPath";
import {
  CHART_H_MM,
  CHART_W_MM,
  PLOT_X0_MM,
  PLOT_X1_MM,
  fmtElapsed,
  markerX,
} from "../../chartModel";
import type { OverlayLatencyModel, OverlayLatencySide } from "../overlayLatency";

const K = ko.print.cmp.overlay.latency;

// 세로 기하·글자·색은 같은 절의 OverlayChart와 같은 숫자
const PLOT_TOP = 8;
const PLOT_BOTTOM = 47;
const TIME_LABEL_Y = 51.5;
const FONT = 2.3;
const COLOR_BEFORE = "#9aa1ad";
const COLOR_AFTER = "#3b4bc8";
const COLOR_GRID = "#e4e6ea";
const COLOR_SUB = "#5b6170";

const r2 = (n: number): number => Math.round(n * 100) / 100;
const tickText = (v: number): string => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

function Line(props: {
  side: OverlayLatencySide;
  which: "before" | "after";
  durationSec: number;
  yMax: number;
  color: string;
  dash?: string;
}) {
  const { side, which, durationSec, yMax, color, dash } = props;
  if (!side.has) return null;
  const points = side.bins
    .filter((b) => b.observed)
    .map((b) => ({ x: b.startSec + b.seconds / 2, y: b.meanMs }));
  return (
    <path
      data-ovlat-line={which}
      d={sparkPath(points, {
        xMax: durationSec,
        yMax,
        x0: PLOT_X0_MM,
        x1: PLOT_X1_MM,
        yTop: PLOT_TOP,
        yBottom: PLOT_BOTTOM,
      })}
      fill="none"
      stroke={color}
      strokeWidth={0.5}
      strokeDasharray={dash}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function Svg({ model }: { model: OverlayLatencyModel }) {
  const d = model.durationSec;
  const yMax = Math.max(model.yTicks[model.yTicks.length - 1] ?? 1, 1e-9);
  const y = (v: number) => r2(PLOT_BOTTOM - (v / yMax) * (PLOT_BOTTOM - PLOT_TOP));
  return (
    <svg
      className="p-cmp-ovlat"
      role="img"
      aria-label={K.aria}
      width="100%"
      viewBox={`0 0 ${CHART_W_MM} ${CHART_H_MM}`}
      fontSize={FONT}
      style={{ display: "block" }}
    >
      {model.yTicks.map((t) => (
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
      {model.timeTicks.map((t) => (
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
      <Line
        side={model.before}
        which="before"
        durationSec={d}
        yMax={yMax}
        color={COLOR_BEFORE}
        dash="1.5 1"
      />
      <Line side={model.after} which="after" durationSec={d} yMax={yMax} color={COLOR_AFTER} />
    </svg>
  );
}

function Legend({ model }: { model: OverlayLatencyModel }) {
  return (
    <div className="p-cmp-db-legend p-cmp-ov-legend">
      {model.before.has && (
        <span>
          <i
            className="p-cmp-db-sw p-cmp-ov-sw--line p-cmp-ov-sw--dash"
            style={{ borderTopColor: COLOR_BEFORE }}
            aria-hidden="true"
          />
          {K.legendBefore}
        </span>
      )}
      {model.after.has && (
        <span>
          <i
            className="p-cmp-db-sw p-cmp-ov-sw--line"
            style={{ borderTopColor: COLOR_AFTER }}
            aria-hidden="true"
          />
          {K.legendAfter}
        </span>
      )}
      {model.missingNote && <span>{model.missingNote}</span>}
    </div>
  );
}

/** 겹쳐 보기 그림 아래의 같은 크기 그림: 제목 + 그림 + 범례 + 읽는 법. */
export function OverlayLatencyChart({ model }: { model: OverlayLatencyModel }) {
  const caption = model.capped
    ? `${K.caption(model.binText)} ${ko.print.latencyChart.capped}`
    : K.caption(model.binText);
  return (
    <div className="p-cmp-box p-cmp-ov-box">
      <div className="p-bold">{K.title}</div>
      <Svg model={model} />
      <Legend model={model} />
      <div className="p-cmp-note p-cmp-ov-reading">{caption}</div>
    </div>
  );
}
