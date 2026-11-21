import { ko } from "../../../i18n/ko";
import type { CompareDoc } from "../buildCompareDoc";

const V = ko.print.cmp.view;

function StatusLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((s, i) => (
        <div key={i} className="p-cmp-status">
          {s}
        </div>
      ))}
    </>
  );
}

export function FairCards({
  doc,
  line,
  clamp,
}: {
  doc: CompareDoc;
  line: boolean;
  clamp: boolean;
}) {
  const { fairness } = doc;
  if (line) {
    return (
      <section>
        <div className={clamp ? "p-cmp-fairline p-cmp-clamp1" : "p-cmp-fairline"}>
          {fairness.oneLine}
        </div>
        <StatusLines lines={fairness.statusLines} />
      </section>
    );
  }
  return (
    <section>
      <div className="p-cmp-fair">
        {fairness.cards.map((c) => (
          <div key={c.key} className={c.same ? undefined : "p-cmp-fair--diff"}>
            <span className={c.same ? "p-cmp-ok" : "p-cmp-warn"}>
              {c.same ? V.fairSameGlyph : V.fairDiffGlyph}
            </span>{" "}
            {c.title} {c.same ? V.fairSame : V.fairDiff}
            <small className={c.same ? undefined : "p-cmp-warn-text"}>{c.line}</small>
          </div>
        ))}
      </div>
      <StatusLines lines={fairness.statusLines} />
    </section>
  );
}
