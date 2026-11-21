import { ko } from "../../../i18n/ko";
import {
  CHART_H_MM,
  CHART_W_MM,
  PLOT_X0_MM,
  PLOT_X1_MM,
  fmtElapsed,
  markerX,
} from "../../chartModel";
import type { OverlayModel, OverlaySide } from "../overlay";

const K = ko.print.cmp.overlay;

// 세로 기하·글자 크기는 측정 보고서 ErrorChart와 같은 숫자
const PLOT_TOP = 8;
const PLOT_BOTTOM = 47;
const TIME_LABEL_Y = 51.5;
const FONT = 2.3;

// 색·굵기·막대 비율은 시안(compare-report-v2.html 「겹쳐 보기」)
const COLOR_BEFORE = "#9aa1ad";
const COLOR_AFTER = "#3b4bc8";
const COLOR_ERR_AFTER = "#b42318";
const COLOR_ERR_BEFORE = "#f0a49b";
const COLOR_GRID = "#e4e6ea";
const COLOR_SUB = "#5b6170";
const BAR_BEFORE_AT = 0.1;
const BAR_AFTER_AT = 0.52;
const BAR_W = 0.38;
const HATCH_ID = "p-cmp-ov-hatch";

const r2 = (n: number): number => Math.round(n * 100) / 100;
const tickText = (v: number): string => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

function Bars(props: {
  side: OverlaySide;
  durationSec: number;
  errMax: number;
  at: number;
  fill: string;
}) {
  const { side, durationSec, errMax, at, fill } = props;
  const plotH = PLOT_BOTTOM - PLOT_TOP;
  return (
    <>
      {side.bins.map((b) => {
        if (!(b.err > 0)) return null;
        const x0 = markerX(b.startSec, durationSec);
        const w = markerX(b.startSec + b.seconds, durationSec) - x0;
        const h = r2((b.err / errMax) * plotH);
        if (!(h > 0)) return null;
        return (
          <rect
            key={b.startSec}
            className="p-cmp-ov-bar"
            x={r2(x0 + w * at)}
            y={r2(PLOT_BOTTOM - h)}
            width={r2(w * BAR_W)}
            height={h}
            fill={fill}
          />
        );
      })}
    </>
  );
}

function Svg({ model }: { model: OverlayModel }) {
  const d = model.durationSec;
  const plotH = PLOT_BOTTOM - PLOT_TOP;
  const rpsMax = Math.max(model.rpsTicks[model.rpsTicks.length - 1] ?? 1, 1e-9);
  const errMax = Math.max(model.errTicks[model.errTicks.length - 1] ?? 1, 1e-9);
  const yRps = (v: number) => r2(PLOT_BOTTOM - (v / rpsMax) * plotH);
  const yErr = (v: number) => r2(PLOT_BOTTOM - (v / errMax) * plotH);
  const points = (s: OverlaySide) =>
    s.bins.map((b) => `${r2(markerX(b.startSec + b.seconds / 2, d))},${yRps(b.rps)}`).join(" ");
  return (
    <svg
      className="p-cmp-ov"
      role="img"
      aria-label={K.aria}
      width="100%"
      viewBox={`0 0 ${CHART_W_MM} ${CHART_H_MM}`}
      fontSize={FONT}
      style={{ display: "block" }}
    >
      <defs>
        <pattern
          id={HATCH_ID}
          patternUnits="userSpaceOnUse"
          width={1.2}
          height={1.2}
          patternTransform="rotate(45)"
        >
          <rect width={1.2} height={1.2} fill={COLOR_ERR_BEFORE} />
          <line x1={0.3} x2={0.3} y1={0} y2={1.2} stroke={COLOR_ERR_AFTER} strokeWidth={0.2} />
        </pattern>
      </defs>
      {model.rpsTicks.map((t) => (
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
      {model.errTicks.map((t) => (
        <text
          key={`e${t}`}
          x={PLOT_X1_MM + 1}
          y={r2(yErr(t) + 0.8)}
          textAnchor="start"
          fill={COLOR_ERR_AFTER}
        >
          {tickText(t)}
        </text>
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
      {model.hasErrors && (
        <>
          <Bars
            side={model.before}
            durationSec={d}
            errMax={errMax}
            at={BAR_BEFORE_AT}
            fill={`url(#${HATCH_ID})`}
          />
          <Bars
            side={model.after}
            durationSec={d}
            errMax={errMax}
            at={BAR_AFTER_AT}
            fill={COLOR_ERR_AFTER}
          />
        </>
      )}
      {model.before.bins.length > 0 && (
        <polyline
          points={points(model.before)}
          fill="none"
          stroke={COLOR_BEFORE}
          strokeWidth={0.5}
          strokeDasharray="1.5 1"
        />
      )}
      {model.after.bins.length > 0 && (
        <polyline points={points(model.after)} fill="none" stroke={COLOR_AFTER} strokeWidth={0.5} />
      )}
    </svg>
  );
}

function Legend({ model }: { model: OverlayModel }) {
  return (
    <div className="p-cmp-db-legend p-cmp-ov-legend">
      <span>
        <i
          className="p-cmp-db-sw p-cmp-ov-sw--line p-cmp-ov-sw--dash"
          style={{ borderTopColor: COLOR_BEFORE }}
          aria-hidden="true"
        />
        {K.legendBeforeRps}
      </span>
      <span>
        <i
          className="p-cmp-db-sw p-cmp-ov-sw--line"
          style={{ borderTopColor: COLOR_AFTER }}
          aria-hidden="true"
        />
        {K.legendAfterRps}
      </span>
      {model.hasErrors ? (
        <>
          <span>
            <i className="p-cmp-db-sw p-cmp-ov-sw--box p-cmp-ov-sw--hatch" aria-hidden="true" />
            {K.legendBeforeErr}
          </span>
          <span>
            <i
              className="p-cmp-db-sw p-cmp-ov-sw--box"
              style={{ background: COLOR_ERR_AFTER }}
              aria-hidden="true"
            />
            {K.legendAfterErr}
          </span>
        </>
      ) : (
        <span>{K.legendNoErrors}</span>
      )}
      {model.durationNote && <span>{model.durationNote}</span>}
    </div>
  );
}

/** 시안 `.box`: 그림 + 범례 + 읽는 법. 절 제목은 부르는 쪽이 붙인다. */
export function OverlayChart({ model }: { model: OverlayModel }) {
  return (
    <div className="p-cmp-box p-cmp-ov-box">
      <Svg model={model} />
      <Legend model={model} />
      <div className="p-cmp-note p-cmp-ov-reading">{`${K.readingPrefix}${model.reading}`}</div>
    </div>
  );
}
