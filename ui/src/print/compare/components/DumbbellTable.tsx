import { ko } from "../../../i18n/ko";
import { tableIds } from "../buildCompareDoc";
import { DB, type DumbbellModel, type DumbbellRow } from "../dumbbell";
import { SectionHeading } from "./SectionHeading";

const V = ko.print.cmp.view;
const T = ko.print.cmp.db;
const IDS = tableIds("cmp:db");
const WIDTHS = [34, 96, 50];
const VIEW_W = DB.PAD * 2 + DB.PLOT_W;
const BASE_LABEL_SIZE = 8.5;

const GRAY = "#9aa1ad";
const BLUE = "#3b4bc8";
const RED = "#b42318";

export function DumbbellTitle({
  no,
  continued,
  measure,
}: {
  no: string;
  continued: boolean;
  measure?: boolean;
}) {
  return (
    <div className="p-block p-block--title" data-measure={measure ? IDS.title : undefined}>
      <SectionHeading no={no} title={V.titles.dumbbell} continued={continued} />
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
  return <path d={`M${tip} ${y}L${base} ${y - 4.5}L${base} ${y + 4.5}z`} fill={color} />;
}

function RowSvg({ row }: { row: DumbbellRow }) {
  const y = DB.ROW_H / 2;
  const { xBefore, xAfter, dir, shape } = row;
  const afterColor = row.cls === "worse" ? RED : BLUE;
  const arrowColor = row.cls === "worse" ? RED : BLUE;
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
      const tip = xAfter - dir * (DB.RAD + 1);
      body = (
        <>
          <line
            x1={xBefore + dir * DB.RAD}
            x2={tip - dir * 6}
            y1={y}
            y2={y}
            stroke={arrowColor}
            strokeWidth={2}
          />
          {arrowHead(tip, y, dir, arrowColor)}
          <circle cx={xBefore} cy={y} r={DB.RAD} fill={GRAY} />
          <circle cx={xAfter} cy={y} r={DB.RAD} fill={afterColor} />
        </>
      );
    } else if (shape === "tri") {
      body = (
        <>
          <circle cx={xBefore} cy={y} r={DB.RAD} fill={GRAY} />
          <circle cx={xAfter} cy={y} r={DB.RAD} fill={afterColor} />
          {arrowHead(xAfter + dir * (DB.RAD + DB.TRI_GAP), y, dir, arrowColor)}
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

/** `model.rows`는 전체, [from, to)만 그린다(측정 id = 전체 인덱스). */
export function DumbbellTable(props: {
  model: DumbbellModel;
  from: number;
  to: number;
  measure?: boolean;
}) {
  const { model, from, to, measure } = props;
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
              <div>{r.valueText}</div>
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
