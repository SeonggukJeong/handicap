import { ko } from "../../../i18n/ko";
import { issuesShown, type CompareDoc } from "../buildCompareDoc";
import { SectionHeading } from "./SectionHeading";

const V = ko.print.cmp.view;

export function IssuesBox({
  doc,
  no,
  max,
  summary,
}: {
  doc: CompareDoc;
  no: string;
  max: number;
  summary: boolean;
}) {
  const { shown, more } = issuesShown(doc, max);
  const hasItems = !doc.incomparable && shown.length > 0;
  return (
    <section>
      <SectionHeading no={no} title={V.titles.issues} />
      <div
        className={
          hasItems ? "p-cmp-box p-cmp-issues p-cmp-issues--warn" : "p-cmp-box p-cmp-issues"
        }
      >
        {doc.incomparable ? (
          <p className="p-cmp-issues-body">{V.issuesIncomparable}</p>
        ) : shown.length === 0 ? (
          <>
            <h3 className="p-h3">{V.issuesNone}</h3>
            <p className="p-cmp-issues-body">{V.issuesNoneBody}</p>
          </>
        ) : (
          <>
            <ul>
              {shown.map((t, i) => (
                <li key={i}>
                  <span className={summary ? "p-cmp-clamp2" : undefined}>{t}</span>
                </li>
              ))}
            </ul>
            {more > 0 && (
              <div className="p-cmp-more">
                {summary ? V.issuesMoreSummary(more) : V.issuesMore(more)}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
