import { ko } from "../../i18n/ko";
import type { PrintDoc } from "../buildPrintDoc";

const D = ko.print.doc;

export function PageFooter({ doc, n, total }: { doc: PrintDoc; n: number; total: number }) {
  return (
    <div className="p-foot">
      <span>{D.footerTitle(doc.title, doc.shortId)}</span>
      <span>{D.footerTool}</span>
      <span>{D.footerPage(n, total)}</span>
    </div>
  );
}
