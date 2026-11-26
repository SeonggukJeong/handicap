import { ko } from "../../../i18n/ko";
import { tableIds, type CmpTableId } from "../buildCompareDoc";
import { DB, type DumbbellModel, type DumbbellRow } from "../dumbbell";
import { SectionHeading } from "./SectionHeading";

const V = ko.print.cmp.view;
const T = ko.print.cmp.db;
const WIDTHS = [34, 96, 50];
const VIEW_W = DB.PAD * 2 + DB.PLOT_W;
const BASE_LABEL_SIZE = 8.5;

const GRAY = "#9aa1ad";
const BLUE = "#3b4bc8";
const RED = "#b42318";

/** 덤벨 표는 지표마다 하나(95%·평균) — 측정 id와 제목은 부른 쪽이 정한다. */
export function DumbbellTitle({
  id,
  title,
  no,
  continued,
  measure,
}: {
  id: CmpTableId;
  title: string;
  no: string;
  continued: boolean;
  measure?: boolean;
}) {
  return (
    <div className="p-block p-block--title" data-measure={measure ? tableIds(id).title : undefined}>
      <SectionHeading no={no} title={title} continued={continued} />
    </div>
  );
}

function AxisSvg({ model }: { model: DumbbellModel }) {
  const { baseline } = model;
  const anchor =
    baseline && baseline.x + baseline.label.length * BASE_LABEL_SIZE > VIEW_W ? "end" : "start";
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${DB.AXIS_H}`} width="100%" style={{ display: "block" }}>
      {baseline && (
        <text x={baseline.x} y={9} fontSize={BASE_LABEL_SIZE} textAnchor={anchor} fill={RED}>
          {baseline.label}
        </text>
      )}
      {model.ticks.map((t) => (
        <text key={t.ms} x={t.x} y={21} fontSize={9} textAnchor="middle" fill="#5b6170">
          {t.label}
        </text>
      ))}
    </svg>
  );
}

function arrowHead(tip: number, y: number, dir: number, color: string) {
  const base = tip - dir * DB.TRI_LEN;
  const h = DB.HEAD_HALF;
  return <path d={`M${tip} ${y}L${base} ${y - h}L${base} ${y + h}z`} fill={color} />;
}

function RowSvg({ row }: { row: DumbbellRow }) {
  const y = DB.ROW_H / 2;
  const { xBefore, xAfter, dir, shape } = row;
  const color = row.cls === "worse" ? RED : BLUE;
  const aria = T.ariaLabel(row.valueText, row.wordText);
  let body: React.ReactNode = null;
  if (shape === "single") {
    const only = xBefore ?? xAfter;
    if (only !== null) {
      body = <circle cx={only} cy={y} r={DB.RAD} fill={xBefore !== null ? GRAY : BLUE} />;
    }
  } else if (xBefore !== null && xAfter !== null) {
    if (shape === "merged") {
      body = <circle cx={xAfter} cy={y} r={DB.RAD} fill={BLUE} stroke={GRAY} strokeWidth={3} />;
    } else if (shape === "dots") {
      body = (
        <>
          <circle cx={xBefore} cy={y} r={DB.RAD} fill={GRAY} />
          <circle cx={xAfter} cy={y} r={DB.RAD} fill={BLUE} />
        </>
      );
    } else if (shape === "arrow") {
      const tip = xAfter - dir * DB.TIP_GAP;
      body = (
        <>
          <line
            x1={xBefore + dir * DB.RAD}
            x2={tip - dir * DB.LINE_GAP}
            y1={y}
            y2={y}
            stroke={color}
            strokeWidth={2}
          />
          {arrowHead(tip, y, dir, color)}
          <circle cx={xBefore} cy={y} r={DB.RAD} fill={GRAY} />
          <circle cx={xAfter} cy={y} r={DB.RAD} fill={color} />
        </>
      );
    } else if (shape === "tri") {
      body = (
        <>
          <circle cx={xBefore} cy={y} r={DB.RAD} fill={GRAY} />
          <circle cx={xAfter} cy={y} r={DB.RAD} fill={color} />
          {arrowHead(xAfter + dir * (DB.RAD + DB.TRI_GAP), y, dir, color)}
        </>
      );
    }
  }
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${DB.ROW_H}`}
      width="100%"
      role="img"
      aria-label={aria}
      style={{ display: "block" }}
    >
      {body}
    </svg>
  );
}

const WORD_CLASS = { better: "p-cmp-ok", worse: "p-cmp-bad", similar: "p-cmp-same" } as const;

const SWATCH = { before: GRAY, after: BLUE } as const;

/** 범례: 그림의 점과 같은 색 견본. 접근명은 모델의 범례 글. */
export function DumbbellLegend({ model }: { model: DumbbellModel }) {
  return (
    <div className="p-cmp-db-legend" role="img" aria-label={model.legend}>
      <span aria-hidden="true">
        <i className="p-cmp-db-sw" style={{ background: SWATCH.before }} />
        {T.legendBefore}
      </span>
      <span aria-hidden="true">
        <i className="p-cmp-db-sw" style={{ background: SWATCH.after }} />
        {T.legendAfter}
      </span>
      {model.baseline && (
        <span aria-hidden="true">
          <b style={{ color: RED }}>┊</b> {model.baseline.label}
        </span>
      )}
      <span aria-hidden="true">{T.legendArrow}</span>
    </div>
  );
}

/** `model.rows`는 전체, [from, to)만 그린다(측정 id = 전체 인덱스). */
export function DumbbellTable(props: {
  id: CmpTableId;
  model: DumbbellModel;
  from: number;
  to: number;
  measure?: boolean;
}) {
  const { id, model, from, to, measure } = props;
  const IDS = tableIds(id);
  const pct = (x: number) => `${(x / VIEW_W) * 100}%`;
  return (
    <table className="p-table p-cmp-db">
      <colgroup>
        {WIDTHS.map((w, i) => (
          <col key={i} style={{ width: `${w}mm` }} />
        ))}
      </colgroup>
      <thead data-measure={measure ? IDS.header : undefined}>
        <tr>
          <th className="p-l">{V.dbColStep}</th>
          <th className="p-cmp-db-axis">
            <AxisSvg model={model} />
          </th>
          <th className="p-l">{V.dbColValue}</th>
        </tr>
      </thead>
      <tbody>
        {model.rows.slice(from, to).map((r, i) => (
          <tr key={from + i} data-measure={measure ? IDS.row(from + i) : undefined}>
            <td className="p-l">
              <div className="p-cmp-clamp2">{r.label}</div>
              {r.note && <small>{r.note}</small>}
            </td>
            <td className="p-cmp-db-plot">
              {model.ticks.map((t) => (
                <i key={t.ms} className="p-cmp-db-grid" style={{ left: pct(t.x) }} />
              ))}
              {model.baseline && (
                <i className="p-cmp-db-base" style={{ left: pct(model.baseline.x) }} />
              )}
              <RowSvg row={r} />
            </td>
            <td className="p-l p-cmp-db-text">
              <div>
                {`${r.beforeText} → `}
                {r.cls === "similar" || r.cls === null ? (
                  r.afterText
                ) : (
                  <b className={WORD_CLASS[r.cls]}>{r.afterText}</b>
                )}
              </div>
              <div>
                {r.cls && <b className={WORD_CLASS[r.cls]}>{r.wordText}</b>}
                {r.crossText && (
                  <>
                    {" "}
                    <b className={r.crossText === T.crossIn ? "p-cmp-ok" : "p-cmp-bad"}>
                      {r.crossText}
                    </b>
                  </>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
