import type { StairReport, StairState } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { headlineText } from "../../components/report/stair/stairFormat";
import { MEASURE_IDS } from "../buildPrintDoc";
import { buildStairRows } from "../stairTable";

/** 본문 폭 180mm 안의 열 폭(mm): # · 목표 · 달성 · 처리량 · p50 · p95 · p99 · 오류율 · dropped · 측정 구간 · 판정. */
const WIDTHS = [7, 18, 18, 18, 13, 13, 13, 13, 14, 28, 25];

const TONE: Record<StairState, string> = {
  ok: "p-ok",
  spike: "p-warn",
  saturated: "p-bad",
  unconfirmed: "p-warn",
  after: "p-muted",
  not_measured: "p-muted",
};

export function StairHeadline({ stair, short }: { stair: StairReport; short?: boolean }) {
  const lines = headlineText(stair);
  if (short) {
    return (
      <section>
        <div className="p-note p-bold">{lines[0]}</div>
        <div className="p-note">{ko.print.stair.summaryNote}</div>
      </section>
    );
  }
  return (
    <section>
      {lines.map((l, i) => (
        <div key={i} className={i === 0 ? "p-note p-bold" : "p-note"}>
          {l}
        </div>
      ))}
    </section>
  );
}

export function StairTableTitle({ continued, measure }: { continued: boolean; measure?: boolean }) {
  const s = ko.print.stair;
  return (
    <div
      className="p-block p-block--title"
      data-measure={measure ? MEASURE_IDS.stairTitle : undefined}
    >
      <h2 className="p-h2">{continued ? `${s.title}${s.continued}` : s.title}</h2>
    </div>
  );
}

/** [from, to) 행만 그린다(측정 id = 전체 인덱스). */
export function StairPrintTable(props: {
  stair: StairReport;
  from: number;
  to: number;
  measure?: boolean;
}) {
  const { stair, from, to, measure } = props;
  const model = buildStairRows(stair);
  return (
    <table className="p-table p-stair" aria-label={ko.report.stair.tableLabel}>
      <colgroup>
        {WIDTHS.map((w, i) => (
          <col key={i} style={{ width: `${w}mm` }} />
        ))}
      </colgroup>
      <thead data-measure={measure ? MEASURE_IDS.stairHeader : undefined}>
        <tr>
          {model.columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {model.rows.slice(from, to).map((r) => (
          <tr key={r.index} data-measure={measure ? MEASURE_IDS.stairRowId(r.index) : undefined}>
            {r.cells.slice(0, 10).map((v, i) => (
              <td key={i}>{v}</td>
            ))}
            <td className={TONE[r.state]}>
              <div className="p-status">{r.cells[10]}</div>
              {r.reasons.length > 0 && <small>{r.reasons.join(" · ")}</small>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
