import { ko } from "../../i18n/ko";

const D = ko.print.doc;

export function SignatureBlock() {
  return (
    <div className="p-sign">
      <div>{D.signTester}</div>
      <div>{D.signReviewer}</div>
      <div>{D.signApprover}</div>
    </div>
  );
}
