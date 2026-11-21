import { ko } from "../../../i18n/ko";
import type { CompareDoc, SideHead } from "../buildCompareDoc";

const D = ko.print.doc;
const C = ko.print.cmp.doc;
const V = ko.print.cmp.view;

const VERDICT_TONE: Record<SideHead["verdictKind"], string> = {
  fail: "p-cmp-bad",
  pass: "p-cmp-ok",
  notJudged: "p-cmp-same",
  notEvaluable: "p-cmp-same",
  noCriteria: "p-cmp-same",
};

// "판정 안 함"은 낱말 자체가 "판정"으로 시작하므로 앞말을 붙이지 않는다.
const PREFIXED: Record<SideHead["verdictKind"], boolean> = {
  fail: true,
  pass: true,
  notJudged: false,
  notEvaluable: true,
  noCriteria: true,
};

function RunBox({ head, after, clamp }: { head: SideHead; after: boolean; clamp: boolean }) {
  return (
    <div className={after ? "p-cmp-run p-cmp-run--after" : "p-cmp-run"}>
      <span className="p-cmp-tag">{head.role}</span>{" "}
      {head.label !== null && (
        <b className={clamp ? "p-cmp-runlabel p-cmp-clamp1" : "p-cmp-runlabel"}>
          {V.quoted(head.label)}
        </b>
      )}{" "}
      {head.shortId}
      <br />
      {head.window}
      {V.sideSep}
      {PREFIXED[head.verdictKind] && <>{V.verdictPrefix} </>}
      <span className={VERDICT_TONE[head.verdictKind]}>{head.verdictText}</span>
    </div>
  );
}

export function CompareHeader({ doc, clamp }: { doc: CompareDoc; clamp: boolean }) {
  return (
    <header className="p-head">
      <div className="p-head-top">
        <div className="p-head-titles">
          <div className="p-kicker">{C.kicker}</div>
          <h1 className="p-h1">{doc.title}</h1>
        </div>
        <div className="p-head-right">
          <div>{D.docNo}</div>
          <div>{D.created(doc.createdDate)}</div>
        </div>
      </div>
      <div className="p-cmp-pair">
        <RunBox head={doc.before} after={false} clamp={clamp} />
        <div className="p-cmp-arrow" aria-hidden="true">
          {V.pairArrow}
        </div>
        <RunBox head={doc.after} after clamp={clamp} />
      </div>
    </header>
  );
}
