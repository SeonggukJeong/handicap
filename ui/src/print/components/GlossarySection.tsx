import { ko } from "../../i18n/ko";
import type { PrintDoc } from "../buildPrintDoc";

export function GlossarySection({ doc }: { doc: PrintDoc }) {
  const { entries, errorKindLine } = doc.glossary;
  return (
    <section>
      <h2 className="p-h2">{ko.print.section.glossary}</h2>
      <ul className="p-gloss">
        {entries.map((e) => (
          <li key={e.term}>{`${e.term}: ${e.text}`}</li>
        ))}
      </ul>
      {errorKindLine !== null && <div className="p-note">{errorKindLine}</div>}
    </section>
  );
}
