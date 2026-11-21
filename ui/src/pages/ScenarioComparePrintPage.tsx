import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useReports, useScenario, useScenarioRuns } from "../api/hooks";
import { runDisplayLabel } from "../compare/runLabel";
import { ko } from "../i18n/ko";
import type { PrintKind } from "../print/buildPrintDoc";
import { buildCompareDoc } from "../print/compare/buildCompareDoc";
import { CompareDocument } from "../print/compare/CompareDocument";
import { resolvePair, toRunMeta, type RunMeta } from "../print/compare/pair";
import { buildRunModel } from "../print/compare/runModel";
import { fmtDateTime } from "../print/format";
import { PAGE_RULE } from "./RunPrintPage";

const BTN = "px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100";
const BTN_ON = "px-3 py-1.5 text-sm border border-slate-700 rounded bg-slate-700 text-white";

const EMPTY_META: RunMeta = {
  id: "",
  status: "completed",
  started_at: null,
  ended_at: null,
  created_at: 0,
  label: null,
  message: null,
};

// 값이 같으면 같은 객체를 돌려줘, 목록을 다시 읽어 와도 문서를 다시 만들지 않게 한다.
function useStableMeta(m: RunMeta | null): RunMeta | null {
  const present = m !== null;
  const { id, status, label, message, started_at, ended_at, created_at } = m ?? EMPTY_META;
  return useMemo(
    () => (present ? { id, status, label, message, started_at, ended_at, created_at } : null),
    [present, id, status, label, message, started_at, ended_at, created_at],
  );
}

export function ScenarioComparePrintPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const runs = useScenarioRuns(id);
  const scenario = useScenario(id);
  const [now] = useState(() => Date.now());
  const [ladder, setLadder] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const runsParam = searchParams.get("runs") ?? "";
  const baselineParam = searchParams.get("baseline");
  const pairParam = searchParams.get("pair");
  const kind: PrintKind = searchParams.get("kind") === "summary" ? "summary" : "standard";

  const runIds = useMemo(
    () =>
      runsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [runsParam],
  );

  const pair = useMemo(
    () =>
      runs.data
        ? resolvePair({
            runIds,
            pairParam,
            baseline: baselineParam,
            scenarioRuns: runs.data.runs.map(toRunMeta),
          })
        : null,
    [runs.data, runIds, pairParam, baselineParam],
  );

  const beforeMeta = useStableMeta(pair?.kind === "ok" ? pair.before : null);
  const afterMeta = useStableMeta(pair?.kind === "ok" ? pair.after : null);

  const reports = useReports(beforeMeta && afterMeta ? [beforeMeta.id, afterMeta.id] : []);
  const beforeReport = reports[0]?.data;
  const afterReport = reports[1]?.data;
  const reportError = reports.find((r) => r.error)?.error;
  const scenarioName = scenario.data?.name ?? null;

  const doc = useMemo(
    () =>
      beforeMeta && afterMeta && beforeReport && afterReport
        ? buildCompareDoc({
            before: buildRunModel(beforeMeta, beforeReport),
            after: buildRunModel(afterMeta, afterReport),
            fallbackScenarioName: scenarioName,
            now,
          })
        : null,
    [beforeMeta, afterMeta, beforeReport, afterReport, scenarioName, now],
  );

  const candidates = pair?.kind === "ok" ? pair.candidates : [];
  const shown: [string, string] | null = (() => {
    if (pair?.kind !== "ok") return null;
    const [p, q] = (pairParam ?? "").split(",");
    const ids = new Set(candidates.map((c) => c.id));
    if (p && q && p !== q && ids.has(p) && ids.has(q)) return [p, q];
    return [pair.before.id, pair.after.id];
  })();

  const choose = (slot: 0 | 1, value: string) => {
    if (!shown) return;
    const next: [string, string] = slot === 0 ? [value, shown[1]] : [shown[0], value];
    const params = new URLSearchParams(searchParams);
    params.set("pair", next.join(","));
    setSearchParams(params, { replace: true });
  };

  const setKind = (k: PrintKind) => {
    setLadder(0);
    const params = new URLSearchParams(searchParams);
    params.set("kind", k);
    setSearchParams(params, { replace: true });
  };

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

  const backTo =
    `/scenarios/${id ?? ""}/compare?runs=${runsParam}` +
    (baselineParam !== null ? `&baseline=${baselineParam}` : "");

  let body: JSX.Element;
  if (runs.isLoading) {
    body = <p role="status">{ko.print.page.loading}</p>;
  } else if (runs.error) {
    body = <p role="alert">{ko.print.page.loadFailed((runs.error as Error).message)}</p>;
  } else if (!pair || pair.kind === "tooFew") {
    body = <p>{ko.print.cmp.page.tooFew}</p>;
  } else if (pair.kind === "foreign") {
    body = <p>{ko.print.cmp.page.foreign}</p>;
  } else if (pair.kind === "notTerminal") {
    body = <p>{ko.print.page.notTerminal}</p>;
  } else if (reportError) {
    body = <p role="alert">{ko.print.page.loadFailed((reportError as Error).message)}</p>;
  } else if (!doc || scenario.isLoading) {
    body = <p role="status">{ko.print.page.loading}</p>;
  } else {
    body = <CompareDocument key={kind} doc={doc} kind={kind} onLadder={setLadder} />;
  }

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
        {shown && candidates.length > 2 && (
          <div role="group" aria-label={ko.print.cmp.page.pairGroup} className="flex gap-1">
            {([0, 1] as const).map((slot) => (
              <select
                key={slot}
                aria-label={ko.print.cmp.page.pairSelect(slot + 1)}
                className="px-2 py-1.5 text-sm border border-slate-300 rounded"
                value={shown[slot]}
                onChange={(e) => choose(slot, e.target.value)}
              >
                {candidates.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.id === shown[1 - slot]}>
                    {`${runDisplayLabel(c.id, c.label)} · ${
                      c.started_at === null ? ko.print.cmp.page.noStart : fmtDateTime(c.started_at)
                    }`}
                  </option>
                ))}
              </select>
            ))}
          </div>
        )}
        <button type="button" className={BTN} onClick={() => window.print()}>
          {ko.print.page.print}
        </button>
        <Link to={backTo} className={BTN}>
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
