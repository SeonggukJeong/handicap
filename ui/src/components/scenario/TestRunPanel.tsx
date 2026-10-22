import { useState } from "react";
import type { ScenarioTrace, StepTrace } from "../../api/schemas";
import { findStepById, isIfStep, summarizeCondition, type Step } from "../../scenario/model";
import { suggestVarName } from "../../scenario/jsonPath";
import type { Extract } from "../../scenario/model";
import { branchText } from "../../scenario/chipResults";
import { Callout } from "../ui/Callout";
import { BodyBlock } from "../response/BodyBlock";
import { HeaderTable } from "../response/HeaderTable";
import { ResponseBodyTree } from "./ResponseBodyTree";
import { ExtractConfirmRow } from "./ExtractConfirmRow";
import { ko } from "../../i18n/ko";

function statusClass(status: number, error: string | null): string {
  if (error || status >= 400) return "bg-red-200 text-red-900";
  if (status >= 200 && status < 300) return "bg-emerald-200 text-emerald-900";
  return "bg-slate-200 text-slate-700";
}

function chip(text: string, cls: string) {
  return (
    <span
      key={text}
      className={["inline-block rounded px-2 py-0.5 text-xs font-medium break-all", cls].join(" ")}
    >
      {text}
    </span>
  );
}

function HttpRow({
  step,
  onAddExtract,
}: {
  step: StepTrace;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}) {
  const [open, setOpen] = useState(false);
  // Pending extract shown in an ExtractConfirmRow (header, cookie, or status).
  const [pendingExtract, setPendingExtract] = useState<Extract | null>(null);
  const req = step.request;
  const resp = step.response;
  const extracted = Object.entries(step.extracted);
  const onCreate = onAddExtract
    ? (extract: Extract) => onAddExtract(step.step_id, extract)
    : undefined;
  return (
    <li className="border-b border-slate-100 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-2 text-left"
      >
        <span className="font-mono text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        {step.loop_index !== null && chip(`#${step.loop_index}`, "bg-slate-100 text-slate-600")}
        {chip(req?.method ?? "—", "bg-slate-800 text-white")}
        <span className="font-mono text-xs break-all">{req?.url ?? "(no request)"}</span>
        {resp && chip(String(resp.status), statusClass(resp.status, step.error))}
        {resp && (
          <span className="text-xs text-slate-500">
            TTFB {resp.latency_ms}ms / 다운로드 {resp.download_ms ?? "—"}ms
          </span>
        )}
        {extracted.map(([k, v]) => chip(`${k}=${v}`, "bg-indigo-100 text-indigo-800"))}
      </button>
      {step.error && <div className="mt-1 text-xs text-red-700">{step.error}</div>}
      {step.unbound_vars.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-xs text-amber-700">unbound:</span>
          {step.unbound_vars.map((v) => chip(v, "bg-amber-100 text-amber-800"))}
        </div>
      )}
      {open && (
        <div className="mt-2 rounded bg-slate-50 p-3">
          {req && (
            <>
              <HeaderTable
                title={ko.report.requestHeadersTitle}
                rows={Object.entries(req.headers)}
              />
              {req.body && <BodyBlock body={req.body} label="요청 본문" />}
            </>
          )}
          {resp && (
            <>
              <HeaderTable
                title={ko.report.responseHeadersTitle}
                rows={Object.entries(resp.headers)}
                action={
                  onCreate
                    ? {
                        label: "추출",
                        ariaLabelFor: (k) => `${k} 추출`,
                        onClick: (name) =>
                          setPendingExtract({ var: suggestVarName(name), from: "header", name }),
                      }
                    : undefined
                }
              />
              {resp.set_cookies.length > 0 && (
                <HeaderTable
                  title="Set-Cookie"
                  rows={resp.set_cookies.map((c, i) => [String(i), c])}
                  action={
                    onCreate
                      ? {
                          label: "추출",
                          ariaLabelFor: (rowKey) => {
                            const cookie = resp.set_cookies[Number(rowKey)];
                            return `${cookie.split("=")[0].trim()} 추출`;
                          },
                          // HeaderTable passes the ROW KEY ("0","1"); resolve the cookie by index.
                          onClick: (rowKey) => {
                            const cookie = resp.set_cookies[Number(rowKey)];
                            const name = cookie.split("=")[0].trim();
                            setPendingExtract({ var: suggestVarName(name), from: "cookie", name });
                          },
                        }
                      : undefined
                  }
                />
              )}
              {onCreate && (
                <div className="mb-2">
                  <button
                    type="button"
                    onClick={() => setPendingExtract({ var: "status", from: "status" })}
                    className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
                  >
                    상태 추출
                  </button>
                </div>
              )}
              {pendingExtract && onCreate && (
                <ExtractConfirmRow
                  proposed={pendingExtract}
                  preview={pendingExtract.from === "status" ? String(resp.status) : undefined}
                  onConfirm={(ex) => {
                    onCreate(ex);
                    setPendingExtract(null);
                  }}
                  onCancel={() => setPendingExtract(null)}
                />
              )}
              <BodyBlock
                body={resp.body}
                truncated={resp.body_truncated}
                label="응답 본문"
                tree={
                  onCreate
                    ? {
                        render: (v) => <ResponseBodyTree value={v} onCreate={onCreate} />,
                        openLabel: "전체 보기·추출",
                        fallbackNotice: (t) => (
                          <Callout variant="warn" className="mb-1">
                            {t ? "본문이 잘려" : "본문이 JSON이 아니라"} 본문 필드 추출 불가 —
                            Inspector에서 수동 입력 (헤더·쿠키·상태는 가능)
                          </Callout>
                        ),
                      }
                    : undefined
                }
              />
            </>
          )}
        </div>
      )}
    </li>
  );
}

function IfRow({ step, steps }: { step: StepTrace; steps?: ReadonlyArray<Step> }) {
  const node = steps ? findStepById(steps, step.step_id) : null;
  const condSummary = node && isIfStep(node) ? summarizeCondition(node.cond) : null;
  return (
    <li className="border-b border-slate-100 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {step.loop_index !== null && chip(`#${step.loop_index}`, "bg-slate-100 text-slate-600")}
        {chip("if", "bg-violet-200 text-violet-900")}
        {condSummary && <span className="font-mono text-xs text-slate-700">{condSummary}</span>}
        <span className="text-xs text-slate-600">→</span>
        {chip(branchText(step.branch ?? "none"), "bg-violet-100 text-violet-800")}
        <span className="font-mono text-xs text-slate-400 break-all">{step.step_id}</span>
      </div>
      {step.unbound_vars.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-xs text-amber-700">조건 unbound:</span>
          {step.unbound_vars.map((v) => chip(v, "bg-amber-100 text-amber-800"))}
        </div>
      )}
    </li>
  );
}

/** trace.steps 행 리스트 — TestRunPanel 본문이자 순차 결과 행 펼침 공유 (R13). */
export function TraceStepList({
  trace,
  steps,
  onAddExtract,
}: {
  trace: ScenarioTrace;
  steps?: ReadonlyArray<Step>;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}) {
  if (trace.steps.length === 0) {
    return <p className="text-sm text-slate-500">실행할 스텝이 없습니다.</p>;
  }
  return (
    <ul>
      {trace.steps.map((step, i) =>
        step.kind === "if" ? (
          <IfRow key={`${step.step_id}-${i}`} step={step} steps={steps} />
        ) : (
          <HttpRow key={`${step.step_id}-${i}`} step={step} onAddExtract={onAddExtract} />
        ),
      )}
    </ul>
  );
}

export function TestRunPanel({
  trace,
  steps,
  onAddExtract,
}: {
  trace: ScenarioTrace;
  steps?: ReadonlyArray<Step>;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}) {
  return (
    <section
      aria-label={ko.editor.testRunResultAria}
      className="rounded border border-slate-200 p-4"
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold">{ko.editor.testRunResultTitle}</h3>
        {chip(
          trace.ok ? ko.editor.testRunOk : ko.editor.testRunFail,
          trace.ok ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900",
        )}
        <span className="text-xs text-slate-500">
          {trace.total_ms}ms · {trace.steps.length} steps
        </span>
      </div>
      {trace.error && <div className="mb-2 text-sm text-red-700">{trace.error}</div>}
      {trace.truncated && (
        <Callout variant="warn" className="mb-2">
          상한 도달 — 일부만 실행됨 (max_requests 또는 시간 천장)
        </Callout>
      )}
      <TraceStepList trace={trace} steps={steps} onAddExtract={onAddExtract} />
    </section>
  );
}
