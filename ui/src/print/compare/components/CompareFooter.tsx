import { ko } from "../../../i18n/ko";
import type { CompareDoc } from "../buildCompareDoc";

const D = ko.print.doc;

/** 긴 제목은 제목 칸만 말줄임한다 — 측정 번호(문서를 가리키는 값)·가운데 글·쪽 번호는 줄지 않는다. */
export function CompareFooter({ doc, n, total }: { doc: CompareDoc; n: number; total: number }) {
  return (
    <div className="p-foot">
      <span className="p-cmp-foot-left">
        <span className="p-cmp-foot-title">{doc.footerTitle}</span>
        <span className="p-cmp-foot-ids">{doc.footerIds}</span>
      </span>
      <span className="p-cmp-foot-fixed">{D.footerTool}</span>
      <span className="p-cmp-foot-fixed">{D.footerPage(n, total)}</span>
    </div>
  );
}
