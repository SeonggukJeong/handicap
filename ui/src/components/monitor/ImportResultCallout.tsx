import { Link } from "react-router-dom";
import type { ImportResult } from "../../api/monitorTransfer";
import { Callout } from "../ui/Callout";
import { ko } from "../../i18n/ko";

const KIND: Record<string, string> = {
  board: ko.monitor.transfer.kindBoard,
  environment: ko.monitor.transfer.kindEnv,
  scenario: ko.monitor.transfer.kindScenario,
};

export function ImportResultCallout({ result }: { result: ImportResult }) {
  const t = ko.monitor.transfer;
  const added = result.boards.filter((b) => b.action === "added").length;
  const sc = result.scenarios;
  const en = result.environments;
  return (
    <Callout variant="info" role="status" className="mb-4 space-y-1">
      <p className="font-medium">
        {t.resultHead(
          result.boards.length,
          [added > 0 ? t.resultAdded(added) : ""].filter(Boolean).join(" · "),
        )}
      </p>
      {(sc.added > 0 || sc.unchanged > 0) && <p>{t.resultScenarios(sc.added, sc.unchanged)}</p>}
      {(en.added > 0 || en.unchanged > 0) && <p>{t.resultEnvs(en.added, en.unchanged)}</p>}
      {result.renamed.map((r, i) => (
        <p key={i}>{t.renamed(r.to, KIND[r.kind] ?? r.kind, r.from)}</p>
      ))}
      <ul className="list-disc pl-5">
        {result.boards.map((b) => (
          <li key={b.id}>
            <Link to={`/monitors/${b.id}`} className="text-accent-700 hover:underline">
              {b.name}
            </Link>
            {b.warnings.length > 0 && (
              <div className="text-amber-800">
                <p>{t.warningHead(b.name)}</p>
                <ul className="list-disc pl-5">
                  {b.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
