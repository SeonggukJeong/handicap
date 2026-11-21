import { ko } from "../../../i18n/ko";
import type { CompareDoc } from "../buildCompareDoc";

const D = ko.print.doc;

export function CompareFooter({ doc, n, total }: { doc: CompareDoc; n: number; total: number }) {
  return (
    <div className="p-foot">
      <span>{doc.footerLeft}</span>
      <span>{D.footerTool}</span>
      <span>{D.footerPage(n, total)}</span>
    </div>
  );
}
