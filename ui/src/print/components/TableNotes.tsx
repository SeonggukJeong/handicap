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

export function Legend({ items }: { items: string[] }) {
  return (
    <div className="p-legend">
      {items.map((item) => (
        <span key={item}>
          {SWATCH[item] && <i className={SWATCH[item]} aria-hidden="true" />}
          {item}
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
