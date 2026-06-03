import { useEffect, useMemo, useState } from "react";
import type { ScenarioTrace, StepTrace } from "../../api/schemas";
import { findStepById, isIfStep, summarizeCondition, type Step } from "../../scenario/model";
import { Modal } from "../Modal";

// Future: expose via an options menu (docs/roadmap.md §B2''). JS string units (UTF-16
// code points), distinct from the engine's byte cap.
const INLINE_PREVIEW_CHARS = 500;

/** Modal content: full body + copy / JSON-format / word-wrap toolbar. Only mounts
 *  when the modal is open, so JSON.parse runs at most once per open (memoized). */
function BodyViewer({ body, truncated }: { body: string; truncated: boolean }) {
  const [formatted, setFormatted] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return null;
    }
  }, [body]);
  const text = formatted && pretty != null ? pretty : body;
  // Revert the "복사됨" confirmation after a moment; cleanup cancels a pending
  // revert on rapid re-copy or unmount (modal close).
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  // Only confirm on an actual successful write — a rejected/unavailable
  // clipboard must NOT show false success.
  function copy() {
    void (async () => {
      try {
        await navigator.clipboard?.writeText(text);
        setCopied(true);
      } catch {
        // clipboard unavailable or denied — leave the label as "복사"
      }
    })();
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {truncated && (
        <div className="rounded bg-amber-100 px-3 py-2 text-xs text-amber-800">
          1 MiB에서 잘림 — 실제 응답은 더 큼
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          aria-live="polite"
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          {copied ? "복사됨" : "복사"}
        </button>
        {pretty != null && (
          <button
            type="button"
            aria-pressed={formatted}
            onClick={() => setFormatted((f) => !f)}
            className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
          >
            {formatted ? "원본" : "JSON 포맷"}
          </button>
        )}
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          {wrap ? "줄바꿈: 켜짐" : "줄바꿈: 꺼짐"}
        </button>
      </div>
      <pre
        className={[
          "min-h-0 flex-1 overflow-auto rounded bg-slate-50 p-3 text-xs",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        ].join(" ")}
      >
        {text}
      </pre>
    </div>
  );
}

/** Request/response body block: inline-full when short, else a 500-char preview
 *  with a "전체 보기" button that opens the full body in a modal. */
function BodyBlock({
  body,
  truncated = false,
  label,
}: {
  body: string;
  truncated?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  if (!body) return null;
  const isLong = body.length > INLINE_PREVIEW_CHARS || truncated;
  if (!isLong) {
    return (
      <pre className="mb-2 whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">{body}</pre>
    );
  }
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-slate-500">
          {label} · {body.length.toLocaleString()}자{truncated ? " (잘림)" : ""}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          전체 보기
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">
        {body.slice(0, INLINE_PREVIEW_CHARS)}…
      </pre>
      <Modal open={open} onClose={() => setOpen(false)} title={label}>
        <BodyViewer body={body} truncated={truncated} />
      </Modal>
    </div>
  );
}

const BRANCH_LABEL: Record<string, string> = {
  none: "(미매치)",
  then: "then",
  else: "else",
};

function branchText(branch: string): string {
  if (BRANCH_LABEL[branch]) return BRANCH_LABEL[branch];
  const m = /^elif_(\d+)$/.exec(branch);
  return m ? `elif ${m[1]}` : branch;
}

function statusClass(status: number, error: string | null): string {
  if (error || status >= 400) return "bg-red-200 text-red-900";
  if (status >= 200 && status < 300) return "bg-emerald-200 text-emerald-900";
  return "bg-slate-200 text-slate-700";
}

function chip(text: string, cls: string) {
  return (
    <span
      key={text}
      className={["inline-block rounded px-2 py-0.5 text-xs font-medium", cls].join(" ")}
    >
      {text}
    </span>
  );
}

function HeaderTable({ title, rows }: { title: string; rows: [string, string][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <table className="min-w-full text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="py-0.5 pr-3 font-mono text-slate-600 align-top">{k}</td>
              <td className="py-0.5 font-mono break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HttpRow({ step }: { step: StepTrace }) {
  const [open, setOpen] = useState(false);
  const req = step.request;
  const resp = step.response;
  const extracted = Object.entries(step.extracted);
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
        {resp && <span className="text-xs text-slate-500">{resp.latency_ms}ms</span>}
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
              <HeaderTable title="Request headers" rows={Object.entries(req.headers)} />
              {req.body && <BodyBlock body={req.body} label="요청 본문" />}
            </>
          )}
          {resp && (
            <>
              <HeaderTable title="Response headers" rows={Object.entries(resp.headers)} />
              {resp.set_cookies.length > 0 && (
                <HeaderTable
                  title="Set-Cookie"
                  rows={resp.set_cookies.map((c, i) => [String(i), c])}
                />
              )}
              <BodyBlock body={resp.body} truncated={resp.body_truncated} label="응답 본문" />
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

export function TestRunPanel({
  trace,
  steps,
}: {
  trace: ScenarioTrace;
  steps?: ReadonlyArray<Step>;
}) {
  return (
    <section aria-label="Test run result" className="rounded border border-slate-200 p-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold">Test run</h3>
        {chip(
          trace.ok ? "OK" : "FAIL",
          trace.ok ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900",
        )}
        <span className="text-xs text-slate-500">
          {trace.total_ms}ms · {trace.steps.length} steps
        </span>
      </div>
      {trace.error && <div className="mb-2 text-sm text-red-700">{trace.error}</div>}
      {trace.truncated && (
        <div className="mb-2 rounded bg-amber-100 px-3 py-2 text-sm text-amber-800">
          상한 도달 — 일부만 실행됨 (max_requests 또는 시간 천장)
        </div>
      )}
      {trace.steps.length === 0 ? (
        <p className="text-sm text-slate-500">실행할 스텝이 없습니다.</p>
      ) : (
        <ul>
          {trace.steps.map((step, i) =>
            step.kind === "if" ? (
              <IfRow key={`${step.step_id}-${i}`} step={step} steps={steps} />
            ) : (
              <HttpRow key={`${step.step_id}-${i}`} step={step} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}
