import { ko } from "../../../i18n/ko";
import { tableIds } from "../buildCompareDoc";
import type { ErrCell, ErrChange, ErrorTableModel } from "../errorTable";
import { SectionHeading } from "./SectionHeading";

const V = ko.print.cmp.view;
const IDS = tableIds("cmp:err");
const NO_VALUE = ko.print.cmp.db.none;

// 칸 폭(mm): 단계 · 오류율 · 코드 열들(남는 폭 균등) · 변화
const STEP_MM = 34;
const RATE_MM = 26;
const CHANGE_MM = 17;
const CODES_MM = 103;
const PAGE_MM = STEP_MM + RATE_MM + CODES_MM + CHANGE_MM;

const CHANGE_CLASS: Record<ErrChange["cls"], string> = {
  better: "p-cmp-ok",
  worse: "p-cmp-bad",
  similar: "p-cmp-same",
  reference: "p-cmp-same",
  none: "p-cmp-same",
};

export function ErrorTitle({
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
      <SectionHeading no={no} title={V.titles.errors} continued={continued} />
    </div>
  );
}

type Side = { before: string; after: string; starBefore: boolean; starAfter: boolean };

/** 「이전[*] → 이후[*]」 — 오류율 칸과 건수 칸이 같은 글자 조립을 쓴다. */
function BeforeAfter({ side, split }: { side: Side; split: boolean }) {
  const pre = `${side.before}${side.starBefore ? "*" : ""} →`;
  const post = `${side.after}${side.starAfter ? "*" : ""}`;
  // 오류율: 한 줄 고정. 건수: 두 조각이 각각 줄바꿈 없이, 조각 사이에서만 줄이 바뀌고 이후 값은 굵게.
  if (!split) return <span className="p-cmp-err-piece">{`${pre} ${post}`}</span>;
  return (
    <>
      <span className="p-cmp-err-piece">{pre}</span> <b className="p-cmp-err-piece">{post}</b>
    </>
  );
}

function CodeCell({ cell }: { cell: ErrCell }) {
  if (!cell) return <td>{NO_VALUE}</td>;
  return (
    <td className={cell.tone ? `p-cmp-err-cell--${cell.tone}` : undefined}>
      <BeforeAfter side={cell} split />
    </td>
  );
}

/** `model.rows`는 전체, [from, to)만 그린다(측정 id = 전체 인덱스). */
export function ErrorChangeTable(props: {
  model: ErrorTableModel;
  from: number;
  to: number;
  measure?: boolean;
}) {
  const { model, from, to, measure } = props;
  const { cols } = model;
  const grouped = cols.length > 0;
  const widths = grouped
    ? [STEP_MM, RATE_MM, ...cols.map(() => CODES_MM / cols.length), CHANGE_MM]
    : [STEP_MM, (PAGE_MM - STEP_MM) / 2, (PAGE_MM - STEP_MM) / 2];
  const rowSpan = grouped ? 2 : undefined;
  return (
    <table className="p-table p-cmp-err">
      <colgroup>
        {widths.map((w, i) => (
          <col key={i} style={{ width: `${w}mm` }} />
        ))}
      </colgroup>
      <thead data-measure={measure ? IDS.header : undefined}>
        <tr>
          <th className="p-l" rowSpan={rowSpan}>
            {V.errColStep}
          </th>
          <th rowSpan={rowSpan}>
            {V.errColRate}
            <small>{V.errColRateSub}</small>
          </th>
          {grouped && (
            <th colSpan={cols.length}>
              {V.errGroup} <small className="p-cmp-err-sub">{V.errGroupSub}</small>
            </th>
          )}
          <th rowSpan={rowSpan}>{V.errColChange}</th>
        </tr>
        {grouped && (
          <tr>
            {cols.map((c) => (
              <th key={c.key}>
                {c.label}
                {c.sub && <small>{c.sub}</small>}
              </th>
            ))}
          </tr>
        )}
      </thead>
      <tbody>
        {model.rows.slice(from, to).map((r, i) => (
          <tr key={from + i} data-measure={measure ? IDS.row(from + i) : undefined}>
            <td className="p-l">
              <div className="p-cmp-clamp2">{r.label}</div>
              {r.note && <small>{r.note}</small>}
            </td>
            <td>
              <BeforeAfter side={r.rate} split={false} />
            </td>
            {cols.map((c) => (
              <CodeCell key={c.key} cell={r.cells[c.key] ?? null} />
            ))}
            <td>
              <span className={CHANGE_CLASS[r.change.cls]}>
                {r.change.glyph ? `${r.change.glyph} ${r.change.word}` : r.change.word}
              </span>
              {r.remaining && <small>{V.errRemaining}</small>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ErrorNotes({ notes }: { notes: string[] }) {
  return (
    <>
      {notes.map((n, i) => (
        <div key={i} className="p-cmp-note">
          {n}
        </div>
      ))}
    </>
  );
}
