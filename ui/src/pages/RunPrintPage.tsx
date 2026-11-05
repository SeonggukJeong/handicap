import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useRun, useRunReport, useScenario } from "../api/hooks";
import type { RunStatus } from "../api/schemas";
import { ko } from "../i18n/ko";
import { buildPrintDoc, type PrintKind } from "../print/buildPrintDoc";
import { PrintDocument } from "../print/PrintDocument";

const TERMINAL: ReadonlyArray<RunStatus> = ["completed", "failed", "aborted"];

const PAGE_RULE =
  "@page { size: A4; margin: 0 } @media print { html, body { margin: 0; background: #fff } }";

const BTN = "px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100";
const BTN_ON = "px-3 py-1.5 text-sm border border-slate-700 rounded bg-slate-700 text-white";

export function RunPrintPage() {
  const { id } = useParams<{ id: string }>();
  const run = useRun(id);
  const terminal = run.data ? TERMINAL.includes(run.data.status) : false;
  const report = useRunReport(id, terminal);
  const scenario = useScenario(run.data?.scenario_id);
  const [now] = useState(() => Date.now());
  const [searchParams, setSearchParams] = useSearchParams();
  const [ladder, setLadder] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const kind: PrintKind = searchParams.get("kind") === "summary" ? "summary" : "standard";
  const scenarioName = scenario.data?.name ?? null;
  const doc = useMemo(
    () =>
      run.data && report.data
        ? buildPrintDoc({
            run: run.data,
            report: report.data,
            fallbackScenarioName: scenarioName,
            now,
          })
        : null,
    [run.data, report.data, scenarioName, now],
  );

  const canCopy =
    typeof navigator !== "undefined" &&
    Boolean(navigator.clipboard) &&
    window.isSecureContext &&
    copyState !== "failed";

  const copy = () => {
    navigator.clipboard.writeText(window.location.href).then(
      () => setCopyState("copied"),
      () => setCopyState("failed"),
    );
  };

  let body: JSX.Element;
  if (run.isLoading) {
    body = <p role="status">{ko.print.page.loading}</p>;
  } else if (run.error) {
    body = <p role="alert">{ko.print.page.loadFailed((run.error as Error).message)}</p>;
  } else if (!terminal) {
    body = <p>{ko.print.page.notTerminal}</p>;
  } else if (report.error) {
    body = <p role="alert">{ko.print.page.loadFailed((report.error as Error).message)}</p>;
  } else if (!doc || scenario.isLoading) {
    body = <p role="status">{ko.print.page.loading}</p>;
  } else {
    body = <PrintDocument key={kind} doc={doc} kind={kind} onLadder={setLadder} />;
  }

  const setKind = (k: PrintKind) => {
    setLadder(0);
    setSearchParams({ kind: k }, { replace: true });
  };

  return (
    <div className="p-root">
      <style>{PAGE_RULE}</style>
      <div className="p-noprint flex flex-wrap items-center gap-2 p-3 border-b border-slate-200">
        <div role="group" aria-label={ko.print.page.kindGroup} className="flex gap-1">
          <button
            type="button"
            aria-pressed={kind === "standard"}
            className={kind === "standard" ? BTN_ON : BTN}
            onClick={() => setKind("standard")}
          >
            {ko.print.page.standard}
          </button>
          <button
            type="button"
            aria-pressed={kind === "summary"}
            className={kind === "summary" ? BTN_ON : BTN}
            onClick={() => setKind("summary")}
          >
            {ko.print.page.summary}
          </button>
        </div>
        <button type="button" className={BTN} onClick={() => window.print()}>
          {ko.print.page.print}
        </button>
        <Link to={`/runs/${id ?? ""}`} className={BTN}>
          {ko.print.page.back}
        </Link>
        <span className="text-xs text-slate-600">
          {ko.print.page.urlHint} <code>{window.location.href}</code>
        </span>
        {canCopy && (
          <button type="button" className={BTN} onClick={copy}>
            {ko.print.page.copy}
          </button>
        )}
        {copyState === "copied" && <span className="text-xs">{ko.print.page.copied}</span>}
        {kind === "summary" && ladder > 0 && (
          <p className="w-full text-xs text-slate-600">{ko.print.page.ladderNotice}</p>
        )}
      </div>
      {body}
    </div>
  );
}
