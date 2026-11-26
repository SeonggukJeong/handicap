import { ko } from "../../../i18n/ko";
import type { CompareDoc } from "../buildCompareDoc";
import type { MetricRow, RowClass } from "../change";
import { SectionHeading } from "./SectionHeading";

const V = ko.print.cmp.view;

const CELL: Record<RowClass, string> = {
  better: "p-cmp-chg--better",
  worse: "p-cmp-chg--worse",
  similar: "p-cmp-chg--similar",
  up: "p-cmp-chg--flat",
  down: "p-cmp-chg--flat",
  reference: "p-cmp-chg--flat",
  none: "p-cmp-chg--flat",
};

const TEXT: Record<RowClass, string> = {
  better: "p-cmp-ok",
  worse: "p-cmp-bad",
  similar: "p-cmp-same",
  up: "p-cmp-same",
  down: "p-cmp-same",
  reference: "p-cmp-same",
  none: "p-cmp-same",
};

const pctWidth = (v: number): string => `${Math.round(v * 1000) / 10}%`;

// 변화 칸 36mm = 「▲ 변화율 계산 불가」 ≈ 9.98em × 2.928mm(8.3pt) = 29.2mm + 패딩 3.6mm + 테두리 0.26mm
// (글자 1em 폭 + letter-spacing 0.12em 가정). 이전·이후 25mm = 굵은 「30.0초 이상」 ≈ 20.2mm + 3.9mm.
const WIDTHS_BARS = [34, 25, 25, 36, 60];
const WIDTHS_PLAIN = [60, 36, 36, 48];

function Row({ r, bars }: { r: MetricRow; bars: boolean }) {
  const lead = r.changeText === "" ? r.arrow : `${r.arrow} ${r.changeText}`;
  return (
    <tr>
      <td className="p-l">
        {r.name}
        {r.hint !== "" && <small>{r.hint}</small>}
      </td>
      <td>{r.beforeText}</td>
      <td>
        <b>{r.afterText}</b>
      </td>
      <td className={CELL[r.cls]}>
        <span className={`${TEXT[r.cls]} p-nowrap`}>{lead}</span>
        <br />
        <small>{r.wordText}</small>
      </td>
      {bars && (
        <td>
          <div className="p-cmp-bars" aria-hidden="true">
            <i className="p-cmp-bar p-cmp-bar--before" style={{ width: pctWidth(r.barBefore) }} />
            <i className="p-cmp-bar p-cmp-bar--after" style={{ width: pctWidth(r.barAfter) }} />
          </div>
        </td>
      )}
    </tr>
  );
}

export function KpiCompareTable({
  doc,
  no,
  bars,
  standard,
}: {
  doc: CompareDoc;
  no: string;
  bars: boolean;
  /** 표준판 블록만 표준판 전용 행(90%·최대)을 그린다. */
  standard: boolean;
}) {
  const widths = bars ? WIDTHS_BARS : WIDTHS_PLAIN;
  return (
    <section>
      <SectionHeading no={no} title={V.titles.kpi} />
      <table className="p-table p-cmp-kpi">
        <colgroup>
          {widths.map((w, i) => (
            <col key={i} style={{ width: `${w}mm` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="p-l">{V.kpiColMetric}</th>
            <th>{V.kpiColBefore}</th>
            <th>{V.kpiColAfter}</th>
            <th>{V.kpiColChange}</th>
            {bars && (
              <th>
                {V.kpiColBars} <small>{V.kpiBarsLegend}</small>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {doc.rows
            .filter((r) => standard || !r.standardOnly)
            .map((r) => (
              <Row key={r.key} r={r} bars={bars} />
            ))}
        </tbody>
      </table>
    </section>
  );
}

export function KpiNote({ doc, clamp }: { doc: CompareDoc; clamp: boolean }) {
  return (
    <div>
      <div className="p-cmp-note">{V.kpiNote}</div>
      {doc.starNote !== null && (
        <div
          className={clamp ? "p-cmp-note p-cmp-starnote p-cmp-clamp1" : "p-cmp-note p-cmp-starnote"}
        >
          {doc.starNote}
        </div>
      )}
    </div>
  );
}
