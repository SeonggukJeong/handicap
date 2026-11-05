import { ko } from "../../i18n/ko";
import type { PrintDoc } from "../buildPrintDoc";

const D = ko.print.doc;

export function ReportHeader({ doc }: { doc: PrintDoc }) {
  const meta: Array<[string, string]> = [
    [D.metaTargets, doc.meta.targets],
    [D.metaWindow, doc.meta.window],
    [D.metaLoad, doc.meta.load],
    [D.metaIdent, doc.meta.ident],
  ];
  return (
    <header className="p-head">
      <div className="p-head-top">
        <div className="p-head-titles">
          <div className="p-kicker">{D.kicker}</div>
          <h1 className="p-h1">{doc.title}</h1>
        </div>
        <div className="p-head-right">
          <div>{D.docNo}</div>
          <div>{D.created(doc.createdDate)}</div>
        </div>
      </div>
      <div className="p-meta">
        {meta.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            {value}
          </div>
        ))}
      </div>
    </header>
  );
}
