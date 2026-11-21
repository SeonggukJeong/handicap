import { ko } from "../../../i18n/ko";
import type { CompareDoc } from "../buildCompareDoc";
import type { Answer } from "../headline";
import { SectionHeading } from "./SectionHeading";

const H = ko.print.cmp.headline;
const V = ko.print.cmp.view;

const TONE: Record<Answer, string> = {
  improved: "",
  worsened: " p-cmp-vbox--bad",
  mixed: " p-cmp-vbox--warn",
  similar: " p-cmp-vbox--neutral",
  incomparable: " p-cmp-vbox--neutral",
};

export function HeadlineHeading({ no }: { no: string }) {
  return <SectionHeading no={no} title={V.titles.overview} />;
}

function ResultBox({ doc }: { doc: CompareDoc }) {
  const { headline } = doc;
  const tone = headline.reference ? " p-cmp-vbox--ref" : TONE[headline.answer];
  return (
    <div className={`p-cmp-vbox${tone}`}>
      <div className="p-cmp-vbox-title">{H.title}</div>
      <div className="p-cmp-vbox-big">
        {headline.glyph} {headline.word}
      </div>
      <div className="p-cmp-vbox-small">{headline.countsLine}</div>
      {headline.reference && <div className="p-cmp-vbox-ref">{H.reference}</div>}
    </div>
  );
}

export function VerdictRow({
  doc,
  short,
  clamp,
}: {
  doc: CompareDoc;
  short: boolean;
  clamp: boolean;
}) {
  const lines = short ? doc.lines.filter((l) => l.id === 1 || l.id === 4) : doc.lines;
  return (
    <div className="p-cmp-verdict">
      <ResultBox doc={doc} />
      <div className="p-cmp-summary">
        <div className="p-cmp-summary-title">{ko.print.cmp.lines.title}</div>
        <ol>
          {lines.map((l) => (
            <li key={l.id}>
              {l.text}
              {l.reasons?.map((r, i) => (
                <div key={i} className={clamp ? "p-cmp-reason p-cmp-clamp1" : "p-cmp-reason"}>
                  <span className="p-cmp-reason-side">{V.reasonLabel(r.side)}</span>{" "}
                  <span>{r.text}</span>
                </div>
              ))}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
