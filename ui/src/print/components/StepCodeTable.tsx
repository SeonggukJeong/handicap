import { ko } from "../../i18n/ko";
import { fmtCount, fmtMs, fmtPct } from "../format";
import { middleEllipsis, requestLineBudget } from "../redact";
import type { RankedRow, StatusTag } from "../stepStatus";
import type { Column } from "../stepTable";
import { MEASURE_IDS } from "../buildPrintDoc";

const C = ko.print.columns;
const S = ko.print.status;
const DASH = ko.print.fmt.noTarget;

/** 본문 폭 180mm 안의 열 폭(mm). 숫자 열은 고정, 이름 열이 나머지. */
const COL_MM = { count: 15, p95: 13, code: 12, residual: 16, status: 20 } as const;
const BODY_W_MM = 180;

function columnWidths(columns: Column[]): { nameMm: number; widths: number[] } {
  const codeMm = columns.map((c) => (c.kind === "residual" ? COL_MM.residual : COL_MM.code));
  const fixed = COL_MM.count + COL_MM.p95 + COL_MM.status + codeMm.reduce((a, b) => a + b, 0);
  const nameMm = BODY_W_MM - fixed;
  return { nameMm, widths: [nameMm, COL_MM.count, COL_MM.p95, ...codeMm, COL_MM.status] };
}

export type TableItem =
  | { kind: "step"; row: RankedRow }
  | { kind: "remainder"; line: string; shown: number };

const TONE: Record<StatusTag, string> = {
  error: "p-bad",
  slow: "p-warn",
  hasErrors: "p-warn",
  uncounted: "p-warn",
  unknown: "p-warn",
  ok: "p-ok",
  notRun: "p-muted",
};

export function StepTableTitle({ continued, measure }: { continued: boolean; measure?: boolean }) {
  const title = continued
    ? `${ko.print.section.steps}${ko.print.section.continued}`
    : ko.print.section.steps;
  return (
    <div
      className="p-block p-block--title"
      data-measure={measure ? MEASURE_IDS.tableTitle : undefined}
    >
      <h2 className="p-h2">{title}</h2>
    </div>
  );
}

function CodeCell({ row, col }: { row: RankedRow; col: Column }) {
  if (col.kind === "residual") {
    if (!row.executed || row.residual <= 0) {
      return <td className="p-col-residual p-muted">{DASH}</td>;
    }
    return (
      <td className="p-col-residual">
        {fmtCount(row.residual)}
        {row.residualUncertain && <small>{C.residualUncertain}</small>}
      </td>
    );
  }
  const cell = row.cells[col.key];
  if (!row.executed || !cell || cell.count === 0) return <td className="p-muted">{DASH}</td>;
  const n = fmtCount(cell.count);
  if (cell.cls === "counted") {
    const cls = cell.strongest ? "p-cell--counted p-cell--strongest" : "p-cell--counted";
    return <td className={cls}>{n}</td>;
  }
  if (cell.cls === "uncounted") {
    return (
      <td className="p-cell--uncounted">
        {n}
        <small className="p-cell-tag">{C.cellUncounted}</small>
      </td>
    );
  }
  if (cell.cls === "unknown") {
    return (
      <td className="p-cell--unknown">
        {n}
        <small className="p-cell-tag">{C.cellUnknown}</small>
      </td>
    );
  }
  return <td>{n}</td>;
}

function StepRowView(props: {
  row: RankedRow;
  columns: Column[];
  budget: number;
  measure?: boolean;
}) {
  const { row, columns, budget, measure } = props;
  const grade = row.status.grade;
  const rowCls = grade === 3 ? "p-row--bad" : grade === 2 ? "p-row--warn" : undefined;
  return (
    <tr className={rowCls} data-measure={measure ? MEASURE_IDS.rowId(row.stepId) : undefined}>
      <td className="p-l">
        <div className="p-name">{`${row.no} ${row.name}`}</div>
        {row.requestLine !== null && (
          <div className="p-req">{middleEllipsis(row.requestLine, budget)}</div>
        )}
      </td>
      <td>{fmtCount(row.count)}</td>
      <td>{row.executed ? fmtMs(row.p95Ms) : DASH}</td>
      {columns.map((col) => (
        <CodeCell key={col.key} row={row} col={col} />
      ))}
      <td className="p-status">
        {row.status.tags.map((t) => (
          <div key={t} className={TONE[t]}>
            {S[t]}
          </div>
        ))}
        {row.executed && row.status.errorRate > 0 && (
          <small>{S.errorSmall(fmtPct(row.status.errorRate))}</small>
        )}
      </td>
    </tr>
  );
}

export function StepTable(props: { columns: Column[]; items: TableItem[]; measure?: boolean }) {
  const { columns, items, measure } = props;
  const { nameMm, widths } = columnWidths(columns);
  const budget = requestLineBudget(nameMm);
  const total = widths.length;
  return (
    <table className="p-table p-steps">
      <colgroup>
        {widths.map((w, i) => (
          <col key={i} style={{ width: `${w}mm` }} />
        ))}
      </colgroup>
      <thead data-measure={measure ? MEASURE_IDS.tableHeader : undefined}>
        {columns.length > 0 ? (
          <>
            <tr>
              <th className="p-l" rowSpan={2}>
                {C.step}
              </th>
              <th rowSpan={2}>{C.count}</th>
              <th rowSpan={2}>{C.p95}</th>
              <th colSpan={columns.length}>{C.group}</th>
              <th rowSpan={2}>{C.status}</th>
            </tr>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.kind === "residual" ? "p-col-residual" : undefined}>
                  {c.label}
                  {c.sub && <small>{c.sub}</small>}
                </th>
              ))}
            </tr>
          </>
        ) : (
          <tr>
            <th className="p-l">{C.step}</th>
            <th>{C.count}</th>
            <th>{C.p95}</th>
            <th>{C.status}</th>
          </tr>
        )}
      </thead>
      <tbody>
        {items.map((it) =>
          it.kind === "step" ? (
            <StepRowView
              key={it.row.stepId}
              row={it.row}
              columns={columns}
              budget={budget}
              measure={measure}
            />
          ) : (
            <tr
              key={`remainder:${it.shown}`}
              className="p-remainder"
              data-measure={measure ? MEASURE_IDS.remainderId(it.shown) : undefined}
            >
              <td className="p-l" colSpan={total}>
                {it.line}
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}
