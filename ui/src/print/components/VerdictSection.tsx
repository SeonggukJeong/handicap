import { ko } from "../../i18n/ko";
import { shortSummary } from "../sentences";
import type { PrintDoc } from "../buildPrintDoc";

const V = ko.print.verdict;

export function VerdictSection({ doc, short }: { doc: PrintDoc; short: boolean }) {
  const tone =
    doc.box.kind === "fail" ? "p-vbox--bad" : doc.box.kind === "pass" ? "p-vbox--ok" : "";
  const lines = short ? shortSummary(doc.lines) : doc.lines;
  return (
    <section>
      <h2 className="p-h2">{ko.print.section.overview}</h2>
      <div className="p-verdict">
        <div className={tone ? `p-vbox ${tone}` : "p-vbox"}>
          <div className="p-vbox-title">{V.title}</div>
          <div className="p-vbox-big">{doc.boxText.big}</div>
          <div className="p-vbox-sub">{doc.boxText.sub}</div>
        </div>
        <div className="p-summary">
          <div className="p-summary-title">{ko.print.section.summaryBox}</div>
          <ol>
            {lines.map((l, i) => (
              <li key={i}>{l.text}</li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
