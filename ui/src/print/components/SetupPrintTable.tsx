import { ko } from "../../i18n/ko";
import type { LinePart } from "../../i18n/lineParts";
import { fmtCount } from "../format";
import { middleEllipsis, requestLineBudget } from "../redact";
import { MEASURE_IDS } from "../buildPrintDoc";
import type { SetupPrintModel, SetupRow } from "../setupTable";

const K = ko.print.setup;
const DASH = ko.print.fmt.noTarget;

/** 열 폭(mm): 이름 = 나머지, 숫자 열 고정, 코드 열 36. */
const COL_MM = { count: 15, errors: 13, p50: 15, p95: 15, max: 15, codes: 36 } as const;
const BODY_W_MM = 180;
const NAME_MM =
  BODY_W_MM - (COL_MM.count + COL_MM.errors + COL_MM.p50 + COL_MM.p95 + COL_MM.max + COL_MM.codes);

function LeadLine({ parts }: { parts: LinePart[] }) {
  return (
    <p className="p-setup-lead">
      {parts.map((p, i) =>
        p.strong ? (
          <b key={i} className={p.tone === "bad" ? "p-bad" : undefined}>
            {p.text}
          </b>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

export function SetupTableTitle({
  title,
  lead,
  continued,
  measure,
}: {
  title: string;
  lead: LinePart[];
  continued: boolean;
  measure?: boolean;
}) {
  return (
    <div
      className="p-block p-block--title"
      data-measure={measure ? MEASURE_IDS.setupTitle : undefined}
    >
      <h2 className="p-h2">{continued ? `${title}${ko.print.section.continued}` : title}</h2>
      {!continued && <LeadLine parts={lead} />}
    </div>
  );
}

const ms = (v: number | null): string => (v === null ? DASH : fmtCount(v));

function SetupRowView({ row, measure }: { row: SetupRow; measure?: boolean }) {
  const bad = row.errors > 0;
  return (
    <tr
      className={bad ? "p-row--bad" : undefined}
      data-measure={measure ? MEASURE_IDS.setupRowId(row.stepId) : undefined}
    >
      <td className="p-l">
        <div className="p-name">{`${row.no} ${row.name}`}</div>
        {row.requestLine !== null && (
          <div className="p-req">{middleEllipsis(row.requestLine, requestLineBudget(NAME_MM))}</div>
        )}
      </td>
      <td>{fmtCount(row.count)}</td>
      <td className={bad ? "p-bad" : undefined}>{fmtCount(row.errors)}</td>
      <td>{ms(row.p50Ms)}</td>
      <td>{ms(row.p95Ms)}</td>
      <td>{ms(row.maxMs)}</td>
      <td>{row.codes.map((c) => K.codeCount(c.label, fmtCount(c.count))).join(K.codeSep)}</td>
    </tr>
  );
}

/** [from, to) 행만 그린다. 머리줄은 쪽마다 다시 그린다. */
export function SetupPrintTable(props: {
  model: SetupPrintModel;
  from: number;
  to: number;
  title?: string;
  measure?: boolean;
}) {
  const { model, from, to, title, measure } = props;
  return (
    <table className="p-table p-setup" aria-label={title}>
      <colgroup>
        <col />
        <col style={{ width: `${COL_MM.count}mm` }} />
        <col style={{ width: `${COL_MM.errors}mm` }} />
        <col style={{ width: `${COL_MM.p50}mm` }} />
        <col style={{ width: `${COL_MM.p95}mm` }} />
        <col style={{ width: `${COL_MM.max}mm` }} />
        <col style={{ width: `${COL_MM.codes}mm` }} />
      </colgroup>
      <thead data-measure={measure ? MEASURE_IDS.setupHeader : undefined}>
        <tr>
          <th className="p-l">{K.colStep}</th>
          <th>{K.colCount}</th>
          <th>{K.colErrors}</th>
          <th>
            {K.colP50}
            <small>{K.unitMs}</small>
          </th>
          <th>
            {K.colP95}
            <small>{K.unitMs}</small>
          </th>
          <th>
            {K.colMax}
            <small>{K.unitMs}</small>
          </th>
          <th>{K.colCodes}</th>
        </tr>
      </thead>
      <tbody>
        {model.rows.slice(from, to).map((r) => (
          <SetupRowView key={r.stepId} row={r} measure={measure} />
        ))}
      </tbody>
    </table>
  );
}
