import { ko } from "../../i18n/ko";
import { fmtCount } from "../format";
import { calloutOneLine, type PrintDoc } from "../buildPrintDoc";
import type { FoldNote } from "../stepTable";

const L = ko.print.legend;
const C = ko.print.columns;

/** 범례 문구 → 견본 칸 클래스(흑백에서도 테두리로 구분). 상태 기호 항목은 견본 없음. */
const SWATCH: Record<string, string> = {
  [L.counted]: "p-sw p-cell--counted",
  [L.strongest]: "p-sw p-cell--counted p-cell--strongest",
  [L.uncounted]: "p-sw p-cell--uncounted",
  [L.unknown]: "p-sw p-cell--unknown",
};

/** 상태 기호 항목 → 표 상태 칸(StepCodeTable `TONE`)과 같은 색 클래스. 기호(첫 글자)에만 입힌다. */
const SYMBOL_TONE: Record<string, string> = {
  [L.error]: "p-bad",
  [L.caution]: "p-warn",
  [L.ok]: "p-ok",
};

export function Legend({ items }: { items: string[] }) {
  return (
    <div className="p-legend">
      {items.map((item) => (
        <span key={item}>
          {SWATCH[item] && <i className={SWATCH[item]} aria-hidden="true" />}
          {SYMBOL_TONE[item] ? (
            <>
              <b className={SYMBOL_TONE[item]}>{item.slice(0, 1)}</b>
              {item.slice(1)}
            </>
          ) : (
            item
          )}
        </span>
      ))}
    </div>
  );
}

export function Callouts({ doc }: { doc: PrintDoc }) {
  const { uncounted, unknown } = doc.callouts;
  return (
    <>
      {uncounted !== null && <div className="p-callout">{uncounted}</div>}
      {unknown !== null && <div className="p-callout">{unknown}</div>}
    </>
  );
}

export function CalloutLine({ doc }: { doc: PrintDoc }) {
  return <div className="p-callout">{calloutOneLine(doc.callouts.affectedSteps)}</div>;
}

export function FoldNotes({ notes }: { notes: FoldNote[] }) {
  return (
    <div className="p-note">
      {notes.map((n) => (
        <div key={n.columnLabel}>
          {C.foldNote(
            n.columnLabel,
            n.parts.map((p) => C.foldPart(p.code, fmtCount(p.count))).join(" · "),
          )}
        </div>
      ))}
    </div>
  );
}

export function UnreadableNote() {
  return <div className="p-note">{C.unreadable}</div>;
}
