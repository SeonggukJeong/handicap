import { ko } from "../../i18n/ko";
import { sparkPath } from "../../report/sparkPath";
import { fmtElapsed, type ChartModel } from "../chartModel";
import { MEASURE_IDS } from "../buildPrintDoc";
import type { StepLatCard, StepLatModel } from "../stepLatencyAppendix";

const K = ko.print.stepLat;
const X0 = 6;
const X1 = 84;
const Y_TOP = 2;
const Y_BOTTOM = 22;
const tickText = (v: number): string => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const r2 = (n: number): number => Math.round(n * 100) / 100;

const yMaxOf = (m: StepLatModel): number => Math.max(m.yTicks[m.yTicks.length - 1] ?? 1, 1e-9);

/** 부록 제목 + 캡션. 이어지는 쪽엔 제목만. */
export function StepLatencyTitle(props: {
  model: StepLatModel;
  title: string;
  continued: boolean;
  measure?: boolean;
}) {
  const { model, title, continued, measure } = props;
  return (
    <div
      className="p-block p-block--title"
      data-measure={measure ? MEASURE_IDS.stepLatTitle : undefined}
    >
      <h2 className="p-h2">{continued ? `${title}${ko.print.section.continued}` : title}</h2>
      {!continued && (
        <div className="p-note">
          {K.caption(tickText(yMaxOf(model)))}
          {model.capped && ` ${ko.print.latencyChart.capped}`}
        </div>
      )}
    </div>
  );
}

function Card({
  card,
  model,
  chart,
}: {
  card: StepLatCard;
  model: StepLatModel;
  chart: ChartModel;
}) {
  const yMax = yMaxOf(model);
  const box = {
    xMax: chart.durationSec,
    yMax,
    x0: X0,
    x1: X1,
    yTop: Y_TOP,
    yBottom: Y_BOTTOM,
  };
  return (
    <div className="p-steplat-card" data-steplat-card="">
      <div className="p-steplat-name" title={card.title}>
        {card.title}
      </div>
      <svg viewBox="0 0 88 26" width="88mm" height="26mm" role="img" aria-label={card.title}>
        <line x1={X0} x2={X1} y1={Y_BOTTOM} y2={Y_BOTTOM} stroke="#999" strokeWidth={0.3} />
        <g fontSize={2.2} fill="#5b6170">
          <text x={5} y={3} textAnchor="end">
            {tickText(yMax)}
          </text>
          <text x={5} y={22.5} textAnchor="end">
            0
          </text>
          {chart.timeTicks.map((t) => (
            <text
              key={t}
              x={r2(X0 + (t / Math.max(chart.durationSec, 1)) * (X1 - X0))}
              y={25}
              textAnchor="middle"
            >
              {fmtElapsed(t)}
            </text>
          ))}
        </g>
        {card.hasData ? (
          <path
            data-steplat-line=""
            d={sparkPath(
              card.bins.map((y, i) => ({ x: model.points[i], y })),
              box,
            )}
            fill="none"
            stroke="#000"
            strokeWidth={0.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <text x={45} y={13} textAnchor="middle" fontSize={3} fill="#5b6170">
            {K.noData}
          </text>
        )}
      </svg>
    </div>
  );
}

/** 카드 쌍 행 [from, to) — 측정 id는 전체 행 번호. */
export function StepLatencyRows(props: {
  model: StepLatModel;
  chart: ChartModel;
  from: number;
  to: number;
  measure?: boolean;
}) {
  const { model, chart, from, to, measure } = props;
  return (
    <div>
      {model.pairs.slice(from, to).map(([a, b], i) => (
        <div
          key={from + i}
          className="p-steplat-row"
          data-measure={measure ? MEASURE_IDS.stepLatRowId(from + i) : undefined}
        >
          <Card card={a} model={model} chart={chart} />
          {b !== null ? <Card card={b} model={model} chart={chart} /> : <div />}
        </div>
      ))}
    </div>
  );
}
