import type { ReactNode } from "react";
import { ko } from "../../i18n/ko";
import { MEASURE_IDS } from "../buildPrintDoc";
import type { Seg, SpeedCell, SpeedModel, SpeedRow } from "../speedBands";

const K = ko.print.speed;

/** 열 폭(mm): 단계 · 막대 · (구간 칸은 남는 폭 균등) · 실패. */
const STEP_MM = 36;
const BAR_MM = 62;
const FAIL_MM = 22;

export function SpeedTableTitle({ continued, measure }: { continued: boolean; measure?: boolean }) {
  const s = ko.print.section;
  return (
    <div
      className="p-block p-block--title"
      data-measure={measure ? MEASURE_IDS.speedTitle : undefined}
    >
      <h2 className="p-h2">{continued ? `${s.speed}${s.continued}` : s.speed}</h2>
    </div>
  );
}

function SegText({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((g, i) =>
        g.bad ? (
          <b key={i} className="p-bad">
            {g.text}
          </b>
        ) : g.strong ? (
          <b key={i}>{g.text}</b>
        ) : (
          <span key={i}>{g.text}</span>
        ),
      )}
    </>
  );
}

function cellClass(c: SpeedCell, extra?: string): string | undefined {
  const cls = [
    extra,
    c.mark === "warn" && "p-warn",
    c.mark === "bad" && "p-bad",
    c.muted && "p-muted",
  ]
    .filter(Boolean)
    .join(" ");
  return cls === "" ? undefined : cls;
}

const cellText = (c: SpeedCell): string =>
  `${c.glyph === "" ? "" : `${c.glyph} `}${c.text}${c.star ? "*" : ""}`;

function SpeedRowView({ row, measure }: { row: SpeedRow; measure?: boolean }) {
  const cls = [row.total && "p-speed-row--total", row.rowBad && "p-speed-row--bad"]
    .filter(Boolean)
    .join(" ");
  return (
    <tr
      className={cls === "" ? undefined : cls}
      data-measure={measure ? MEASURE_IDS.speedRowId(row.key) : undefined}
    >
      <td className="p-l">
        <div className="p-name">
          {row.rowBad && <span className="p-bad">✕ </span>}
          {row.label}
        </div>
        {row.ownNote !== null && <small className="p-speed-own">{row.ownNote}</small>}
      </td>
      {row.bar === null ? (
        <td className="p-muted p-speed-dash">{K.dash}</td>
      ) : (
        <td>
          <div className="p-speed-bar">
            {row.bar.map((s, i) => (
              <i
                key={i}
                className={`p-speed-seg p-speed-seg--${s.band}`}
                style={{ width: `${s.pct}%` }}
              />
            ))}
          </div>
        </td>
      )}
      {row.merged ? (
        <td colSpan={2} className={cellClass(row.within, "p-speed-merged")}>
          {cellText(row.within)}
        </td>
      ) : (
        <>
          {row.fast !== null && <td className={cellClass(row.fast)}>{cellText(row.fast)}</td>}
          <td className={cellClass(row.within)}>{cellText(row.within)}</td>
        </>
      )}
      <td className={cellClass(row.over)}>{cellText(row.over)}</td>
      <td className={cellClass(row.fail, "p-speed-fail")}>{cellText(row.fail)}</td>
    </tr>
  );
}

/** [from, to) 행만 그린다(측정 id = 행 키). 머리줄은 쪽마다 다시 그린다. */
export function SpeedBandTable(props: {
  model: SpeedModel;
  from: number;
  to: number;
  measure?: boolean;
}) {
  const { model, from, to, measure } = props;
  const { head } = model;
  return (
    <table className="p-table p-speed" aria-label={ko.print.section.speed}>
      <colgroup>
        <col style={{ width: `${STEP_MM}mm` }} />
        <col style={{ width: `${BAR_MM}mm` }} />
        {head.fast !== null && <col />}
        <col />
        <col />
        <col style={{ width: `${FAIL_MM}mm` }} />
      </colgroup>
      <thead data-measure={measure ? MEASURE_IDS.speedHeader : undefined}>
        <tr>
          <th className="p-l">{K.colStep}</th>
          <th>{K.colBar}</th>
          {head.fast !== null && <th>{head.fast}</th>}
          <th>{head.within}</th>
          <th>
            {head.over}
            {head.overSub !== null && <small>{head.overSub}</small>}
          </th>
          <th>
            {K.colFail}
            <small>{K.failSub}</small>
          </th>
        </tr>
      </thead>
      <tbody>
        {model.rows.slice(from, to).map((r) => (
          <SpeedRowView key={r.key} row={r} measure={measure} />
        ))}
      </tbody>
    </table>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <div className="p-speed-rule-line">{children}</div>;
}

/** 표 뒤 한 덩어리: 범례 + 안내 상자(run 줄·단계 줄) + 각주. */
export function SpeedNotes({ model }: { model: SpeedModel }) {
  const hasRule = model.rule !== null || model.stepRules.length > 0 || model.stepRulesRest !== null;
  return (
    <section>
      <div className="p-speed-legend">
        {model.legend.map((l) => (
          <span key={l.band}>
            <i className={`p-speed-sw p-speed-seg--${l.band}`} />
            {l.text}
          </span>
        ))}
      </div>
      {hasRule && (
        <div className={model.ruleBoxFail ? "p-speed-rule p-speed-rule--fail" : "p-speed-rule"}>
          {model.rule !== null && (
            <Line>
              <SegText segs={model.rule.segs} />
            </Line>
          )}
          {model.stepRules.map((segs, i) => (
            <Line key={i}>
              <SegText segs={segs} />
            </Line>
          ))}
          {model.stepRulesRest !== null && <Line>{model.stepRulesRest}</Line>}
        </div>
      )}
      {model.notes.length > 0 && (
        <div className="p-speed-note">
          {model.notes.map((segs, i) => (
            <span key={i} className="p-speed-note-item">
              {i > 0 && " "}
              <SegText segs={segs} />
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
