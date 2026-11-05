import { ko } from "../../i18n/ko";
import { limitOtherRows, otherCriteriaOneLine, type OtherRow } from "../verdict";
import { MEASURE_IDS } from "../buildPrintDoc";

const K = ko.print.criteria;

const JUDGEMENT: Record<OtherRow["judgement"], { text: string; cls: string }> = {
  pass: { text: K.pass, cls: "p-ok" },
  fail: { text: K.fail, cls: "p-bad" },
  notJudged: { text: K.notJudged, cls: "p-muted" },
  notEvaluable: { text: K.notEvaluable, cls: "p-muted" },
};

/** 기준·목표·측정값·판정 4열(mm). 합 = 본문 폭 180mm. */
const WIDTHS = [93, 35, 30, 22];

function CriteriaTable(props: {
  rows: OtherRow[];
  offset?: number;
  measure?: boolean;
  headMeasure?: string;
}) {
  const { rows, offset = 0, measure, headMeasure } = props;
  return (
    <table className="p-table p-criteria">
      <colgroup>
        {WIDTHS.map((w, i) => (
          <col key={i} style={{ width: `${w}mm` }} />
        ))}
      </colgroup>
      <thead data-measure={headMeasure}>
        <tr>
          <th className="p-l">{K.colCriterion}</th>
          <th>{K.colTarget}</th>
          <th>{K.colActual}</th>
          <th>{K.colJudgement}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={offset + i}
            className={r.judgement === "fail" ? "p-row--bad" : undefined}
            data-measure={measure ? MEASURE_IDS.appendixRowId(offset + i) : undefined}
          >
            <td className="p-l">{r.name}</td>
            <td>{r.target}</td>
            <td>{r.actual}</td>
            <td className={JUDGEMENT[r.judgement].cls}>{JUDGEMENT[r.judgement].text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type OtherMode = "standard" | "summary3" | "summary1" | "line";

/** 1절 안의 "그 밖의 기준" — 표준판은 최대 6행, 요약판은 미달만(3·1행) 또는 한 줄. */
export function OtherCriteria({ rows, mode }: { rows: OtherRow[]; mode: OtherMode }) {
  if (mode === "line") {
    const line = otherCriteriaOneLine(rows);
    return line === null ? null : <div className="p-note p-bad">{line}</div>;
  }
  const { shown, restLine } = limitOtherRows(rows, mode);
  return (
    <section>
      <h3 className="p-h3">{K.title}</h3>
      <CriteriaTable rows={shown} />
      {restLine !== null && <div className="p-note">{restLine}</div>}
    </section>
  );
}

export function AppendixTitle({ continued, measure }: { continued: boolean; measure?: boolean }) {
  const s = ko.print.section;
  return (
    <div className="p-block p-block--title" data-measure={measure ? MEASURE_IDS.appendixTitle : undefined}>
      <h2 className="p-h2">{continued ? `${s.appendix}${s.continued}` : s.appendix}</h2>
    </div>
  );
}

/** 부록 표 조각: `rows`는 전체, [from, to)만 그린다(측정 id = 전체 인덱스). */
export function AppendixTable(props: {
  rows: OtherRow[];
  from: number;
  to: number;
  measure?: boolean;
}) {
  const { rows, from, to, measure } = props;
  return (
    <CriteriaTable
      rows={rows.slice(from, to)}
      offset={from}
      measure={measure}
      headMeasure={measure ? MEASURE_IDS.appendixHeader : undefined}
    />
  );
}
