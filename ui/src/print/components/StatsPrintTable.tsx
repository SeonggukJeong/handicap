import { ko } from "../../i18n/ko";
import { MEASURE_IDS } from "../buildPrintDoc";
import type { StatsModel, StatsRow } from "../statsTable";

const K = ko.print.stats;

/** 숫자 열 폭(mm, 최소·평균·p50·p90·p95·p99·최대·표준편차). 이름 = 나머지(180 − 120 = 60). 최대·표준편차는 「≥ 60,000」과 「표준편차」 머리가 들어가게 넓다. */
const NUM_MM = [14, 14, 14, 14, 14, 14, 18, 18] as const;

export function StatsTableTitle({
  title,
  caption,
  continued,
  measure,
}: {
  title: string;
  caption: string;
  continued: boolean;
  measure?: boolean;
}) {
  return (
    <div
      className="p-block p-block--title"
      data-measure={measure ? MEASURE_IDS.statsTitle : undefined}
    >
      <h2 className="p-h2">{continued ? `${title}${ko.print.section.continued}` : title}</h2>
      {!continued && <p className="p-stats-caption">{caption}</p>}
    </div>
  );
}

export function StatsNote({ text }: { text: string }) {
  return <p className="p-stats-note">{text}</p>;
}

function StatsRowView({
  row,
  total,
  index,
  measure,
}: {
  row: StatsRow;
  total: boolean;
  index: number;
  measure?: boolean;
}) {
  return (
    <tr
      className={total ? "p-stats-row--total" : undefined}
      data-measure={measure ? MEASURE_IDS.statsRowId(index) : undefined}
    >
      <td className="p-l">
        <div className="p-name">{row.label}</div>
      </td>
      {row.cells.map((c, i) => (
        <td key={i} className="p-stats-num">
          {c}
        </td>
      ))}
    </tr>
  );
}

/** 단계 행들 + 마지막 「모든 단계」 행을 한 줄로 이은 목록의 [from, to) 조각만 그린다. 머리줄은 쪽마다 다시 그린다. */
export function StatsPrintTable(props: {
  model: StatsModel;
  from: number;
  to: number;
  title: string;
  measure?: boolean;
}) {
  const { model, from, to, title, measure } = props;
  const all = [...model.rows, model.total];
  return (
    <table className="p-table p-stats" aria-label={title}>
      <colgroup>
        <col />
        {NUM_MM.map((w, i) => (
          <col key={i} style={{ width: `${w}mm` }} />
        ))}
      </colgroup>
      <thead data-measure={measure ? MEASURE_IDS.statsHeader : undefined}>
        <tr>
          {K.cols.map((c, i) => (
            <th key={c} className={i === 0 ? "p-l" : "p-stats-num"}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {all.slice(from, to).map((r, i) => (
          <StatsRowView
            key={from + i}
            row={r}
            total={from + i === all.length - 1}
            index={from + i}
            measure={measure}
          />
        ))}
      </tbody>
    </table>
  );
}
