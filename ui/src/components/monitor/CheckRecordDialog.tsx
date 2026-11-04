import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { getRecord } from "../../api/monitors";
import type { CheckRecord, CheckResult, PanelConfig } from "../../api/monitors";
import type { StepTrace } from "../../api/schemas";
import { useScenarios } from "../../api/hooks";
import { Modal } from "../Modal";
import { HeaderTable } from "../response/HeaderTable";
import { RecordBody } from "./RecordBody";
import { ko } from "../../i18n/ko";
import { formatDateHms } from "../../monitor/time";
import { branchText } from "../../scenario/chipResults";
import { flattenHttpSteps } from "../../scenario/model";
import { parseScenarioDoc } from "../../scenario/yamlDoc";

const MASK = "••••";

const VERDICT_LABEL: Record<CheckResult["verdict"], string> = {
  ok: ko.monitor.stateOk,
  fail: ko.monitor.stateFail,
  config_error: ko.monitor.stateConfigError,
  upstream_failed: ko.monitor.verdictUpstreamFailed,
  branch_skipped: ko.monitor.verdictBranchSkipped,
};
const VERDICT_CLASS: Record<CheckResult["verdict"], string> = {
  ok: "text-emerald-700",
  fail: "text-red-600",
  config_error: "text-amber-700",
  upstream_failed: "text-slate-500",
  branch_skipped: "text-slate-500",
};

/** Always rendered open — the parent mounts it conditionally, so closing unmounts it
 *  and the per-step "request body revealed" state resets (D7.10). */
export function CheckRecordDialog({
  boardId,
  panel,
  clicked,
  focusStepId,
  onClose,
}: {
  boardId: string;
  panel: PanelConfig;
  clicked: CheckResult;
  /** Step panel: open that step's (last) request row instead of the default rule. */
  focusStepId?: string;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["monitor-record", boardId, panel.id, clicked.at_ms],
    queryFn: () => getRecord(boardId, panel.id, clicked.at_ms),
    staleTime: Infinity,
    retry: false,
  });
  const scenarios = useScenarios().data?.scenarios;
  const stepNames = useMemo(() => {
    const sc = scenarios?.find((s) => s.id === panel.scenario_id);
    if (!sc) return {} as Record<string, string>;
    const parsed = parseScenarioDoc(sc.yaml);
    if ("error" in parsed) return {};
    return Object.fromEntries(flattenHttpSteps(parsed.model.steps).map((s) => [s.id, s.name]));
  }, [scenarios, panel.scenario_id]);

  // Reason/detail of non-latest bars are absent from /status → take them from the record.
  const result = q.data?.result ?? clicked;

  return (
    <Modal
      open
      onClose={onClose}
      title={ko.monitor.recordTitle(panel.title, formatDateHms(clicked.at_ms))}
    >
      <div className="space-y-3 text-sm">
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className={`font-semibold ${VERDICT_CLASS[clicked.verdict]}`}>
              {VERDICT_LABEL[clicked.verdict]}
            </span>
            {clicked.latency_ms !== null && (
              <span className="font-mono">{`${clicked.latency_ms.toLocaleString()} ms`}</span>
            )}
          </div>
          {result.reason && <div className="text-slate-700">{result.reason}</div>}
          {result.detail && <div className="text-xs text-slate-500">{result.detail}</div>}
        </div>
        {q.isPending && <div role="status">{ko.monitor.loading}</div>}
        {q.isError && (
          <div role="alert" className="text-red-600">
            {q.error instanceof ApiError && q.error.status === 404
              ? ko.monitor.recordMissing
              : ko.monitor.recordLoadError(
                  q.error instanceof Error ? q.error.message : String(q.error),
                )}
          </div>
        )}
        {q.data && (
          <RecordSteps
            record={q.data}
            clicked={clicked}
            stepNames={stepNames}
            focusStepId={focusStepId}
          />
        )}
      </div>
    </Modal>
  );
}

function RecordSteps({
  record,
  clicked,
  stepNames,
  focusStepId,
}: {
  record: CheckRecord;
  clicked: CheckResult;
  stepNames: Record<string, string>;
  focusStepId?: string;
}) {
  const trace = record.trace;
  if (trace === null) {
    return (
      <div className="text-slate-600">
        {clicked.verdict === "config_error"
          ? ko.monitor.recordNoTraceConfig
          : ko.monitor.recordNoTraceTimeout}
      </div>
    );
  }
  const only = trace.steps.length === 1;
  // Step panel: only the last http row of that step opens (a loop repeats it).
  let focusIdx = -1;
  if (focusStepId !== undefined) {
    trace.steps.forEach((s, i) => {
      if (s.kind !== "if" && s.step_id === focusStepId) focusIdx = i;
    });
  }
  return (
    <div className="space-y-2">
      {trace.error && (
        <div className="text-red-600">{ko.monitor.recordTraceError(trace.error)}</div>
      )}
      {trace.truncated && <div className="text-amber-700">{ko.monitor.recordTraceCut}</div>}
      {trace.steps.map((st, i) => {
        if (st.kind === "if") {
          return (
            <div key={i} className="text-xs text-slate-600">
              {ko.monitor.recordIfRow(branchText(st.branch ?? "none"))}
            </div>
          );
        }
        return (
          <StepRow
            key={i}
            step={st}
            name={stepNames[st.step_id] ?? st.step_id}
            defaultOpen={focusIdx >= 0 ? i === focusIdx : only}
            clippedReq={record.clipped.some((c) => c.step === i && c.side === "request")}
            clippedResp={record.clipped.some((c) => c.step === i && c.side === "response")}
            limitKb={record.limit_kb}
          />
        );
      })}
    </div>
  );
}

function StepRow({
  step,
  name,
  defaultOpen,
  clippedReq,
  clippedResp,
  limitKb,
}: {
  step: StepTrace;
  name: string;
  defaultOpen: boolean;
  clippedReq: boolean;
  clippedResp: boolean;
  limitKb: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [reveal, setReveal] = useState(false);
  const bodyId = useId();
  const req = step.request;
  const resp = step.response;
  const summary = [
    name,
    req ? `${req.method} ${req.url}` : null,
    resp ? String(resp.status) : null,
    resp ? `${resp.latency_ms} ms` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
  const reqHeaders = Object.entries(req?.headers ?? {});
  const respHeaders = Object.entries(resp?.headers ?? {});
  // The server masks URL userinfo too (`https://u:••••@h`), shown in the summary line.
  const masked =
    (req?.url.includes(MASK) ?? false) ||
    [...reqHeaders, ...respHeaders].some(([, v]) => v.includes(MASK));

  return (
    <div className="rounded border border-slate-200">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-2 px-2 py-1 text-left text-xs hover:bg-slate-50"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {step.loop_index !== null && (
          <span className="rounded bg-slate-200 px-1 font-mono">{`#${step.loop_index}`}</span>
        )}
        <span className="font-mono">{summary}</span>
      </button>
      {step.error && <div className="px-2 pb-1 text-xs text-red-600">{step.error}</div>}
      {open && (
        <div className="space-y-2 border-t border-slate-200 p-2">
          <HeaderTable title={ko.monitor.recordReqHeaders} rows={reqHeaders} />
          {req?.body != null && req.body !== "" && (
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                {ko.monitor.recordReqBody}
                <button
                  type="button"
                  aria-expanded={reveal}
                  aria-controls={bodyId}
                  aria-label={
                    reveal ? ko.monitor.recordHideAria(name) : ko.monitor.recordRevealAria(name)
                  }
                  onClick={() => setReveal((v) => !v)}
                  className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-normal hover:bg-slate-300"
                >
                  {reveal ? ko.monitor.recordHide : ko.monitor.recordReveal}
                </button>
              </div>
              <div id={bodyId}>
                {reveal ? (
                  <RecordBody
                    body={req.body}
                    clippedKb={clippedReq ? limitKb : null}
                    engineTruncated={false}
                  />
                ) : (
                  <div className="text-xs text-slate-500">
                    {ko.monitor.recordReqBodyHidden}
                    {clippedReq && (
                      <span className="ml-2 text-amber-700">
                        {ko.monitor.recordClipped(limitKb)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {resp && (
            <>
              <HeaderTable title={ko.monitor.recordRespHeaders} rows={respHeaders} />
              {resp.body !== "" && (
                <div>
                  <div className="text-xs font-medium text-slate-500">
                    {ko.monitor.recordRespBody}
                  </div>
                  <RecordBody
                    body={resp.body}
                    clippedKb={clippedResp ? limitKb : null}
                    engineTruncated={resp.body_truncated}
                  />
                </div>
              )}
            </>
          )}
          {masked && (
            <div className="text-[11px] text-slate-500">{ko.monitor.recordMaskedHint}</div>
          )}
        </div>
      )}
    </div>
  );
}
