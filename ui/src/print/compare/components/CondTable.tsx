import { ko } from "../../../i18n/ko";
import type { CondRow } from "../fairness";
import { CMP_IDS } from "../buildCompareDoc";
import { SectionHeading } from "./SectionHeading";

const V = ko.print.cmp.view;
const WIDTHS = [60, 60, 60];

export function CondTitle({
  no,
  continued,
  measure,
}: {
  no: string;
  continued: boolean;
  measure?: boolean;
}) {
  return (
    <div className="p-block p-block--title" data-measure={measure ? CMP_IDS.condTitle : undefined}>
      <SectionHeading no={no} title={V.titles.cond} continued={continued} />
    </div>
  );
}

/** `rows`는 전체, [from, to)만 그린다(측정 id = 전체 인덱스). */
export function CondTable(props: { rows: CondRow[]; from: number; to: number; measure?: boolean }) {
  const { rows, from, to, measure } = props;
  return (
    <table className="p-table p-cmp-cond">
      <colgroup>
        {WIDTHS.map((w, i) => (
          <col key={i} style={{ width: `${w}mm` }} />
        ))}
      </colgroup>
      <thead data-measure={measure ? CMP_IDS.condHeader : undefined}>
        <tr>
          <th className="p-l">{V.condColItem}</th>
          <th>{V.condColBefore}</th>
          <th>{V.condColAfter}</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(from, to).map((r, i) => (
          <tr
            key={from + i}
            className={r.differs ? "p-cmp-row--diff" : undefined}
            data-measure={measure ? CMP_IDS.condRowId(from + i) : undefined}
          >
            <td className="p-l">
              {r.differs && <span className="p-cmp-warn">{V.fairDiffGlyph} </span>}
              {r.label}
            </td>
            <td>{r.before}</td>
            <td className={r.differs ? "p-cmp-warn" : undefined}>{r.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
