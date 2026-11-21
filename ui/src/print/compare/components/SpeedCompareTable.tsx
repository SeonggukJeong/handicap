import { ko } from "../../../i18n/ko";
import type { SpeedCell } from "../../speedBands";
import type { SpeedCompare, SpeedCompareRow } from "../speedCompare";

const K = ko.print.speed;
const C = ko.print.cmp.speed;

// 칸 폭(mm): 측정 · 막대 · (구간 칸은 남는 폭 균등) · 실패
const RUN_MM = 20;
const BAR_MM = 62;
const FAIL_MM = 22;

const cellClass = (c: SpeedCell, extra?: string): string | undefined => {
  const cls = [extra, c.muted && "p-muted"].filter(Boolean).join(" ");
  return cls === "" ? undefined : cls;
};

function BandCells({ row, threeCols }: { row: SpeedCompareRow; threeCols: boolean }) {
  const { band } = row;
  if (row.merged && row.mergedText !== null) {
    return (
      <td colSpan={2} className="p-speed-merged">
        {row.mergedText}
      </td>
    );
  }
  return (
    <>
      {threeCols &&
        (band.fast !== null ? (
          <td className={cellClass(band.fast)}>{band.fast.text}</td>
        ) : (
          <td className="p-muted p-speed-dash">{K.dash}</td>
        ))}
      <td className={cellClass(band.within)}>{band.within.text}</td>
    </>
  );
}

function RunRow({ row, threeCols }: { row: SpeedCompareRow; threeCols: boolean }) {
  const { band } = row;
  return (
    <tr>
      <td className="p-l">
        <div className="p-name">{row.role}</div>
        {row.boundary !== null && <small className="p-speed-own">{row.boundary}</small>}
      </td>
      {band.bar === null ? (
        <td className="p-muted p-speed-dash">{K.dash}</td>
      ) : (
        <td>
          <div className="p-speed-bar">
            {band.bar.map((s, i) => (
              <i
                key={i}
                className={`p-speed-seg p-speed-seg--${s.band}`}
                style={{ width: `${s.pct}%` }}
              />
            ))}
          </div>
        </td>
      )}
      <BandCells row={row} threeCols={threeCols} />
      <td className={cellClass(band.over)}>{band.over.text}</td>
      <td className={cellClass(band.fail, "p-speed-fail")}>{band.fail.text}</td>
    </tr>
  );
}

export function SpeedCompareTable({ model }: { model: SpeedCompare }) {
  const { head, threeCols } = model;
  return (
    <table className="p-table p-speed p-cmp-spd" aria-label={C.aria}>
      <colgroup>
        <col style={{ width: `${RUN_MM}mm` }} />
        <col style={{ width: `${BAR_MM}mm` }} />
        {threeCols && <col />}
        <col />
        <col />
        <col style={{ width: `${FAIL_MM}mm` }} />
      </colgroup>
      <thead>
        <tr>
          <th className="p-l">{C.colRun}</th>
          <th>{K.colBar}</th>
          {head.fast !== null && <th>{head.fast}</th>}
          <th>{head.within}</th>
          <th>{head.over}</th>
          <th>
            {K.colFail}
            <small>{K.failSub}</small>
          </th>
        </tr>
      </thead>
      <tbody>
        {model.rows.map((r) => (
          <RunRow key={r.role} row={r} threeCols={threeCols} />
        ))}
      </tbody>
    </table>
  );
}

/** 표 뒤: 구간 범례 + 기준이 다를 때의 경고 줄 */
export function SpeedCompareNotes({ model }: { model: SpeedCompare }) {
  return (
    <>
      <div className="p-speed-legend p-cmp-spd-legend">
        {model.legend.map((l) => (
          <span key={l.band}>
            <i className={`p-speed-sw p-speed-seg--${l.band}`} aria-hidden="true" />
            {l.text}
          </span>
        ))}
      </div>
      {model.warn !== null && (
        <div className="p-cmp-note p-cmp-spd-warn">
          <span className="p-cmp-warn">{model.warn}</span>
        </div>
      )}
    </>
  );
}
