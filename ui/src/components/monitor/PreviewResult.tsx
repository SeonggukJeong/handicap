import type { PreviewResult as Preview } from "../../api/monitors";
import { ko } from "../../i18n/ko";
import { formatMs } from "../../monitor/logic";

const VERDICT_LABEL = {
  ok: ko.monitor.stateOk,
  fail: ko.monitor.stateFail,
  config_error: ko.monitor.stateConfigError,
} as const;

/** Text-only preview of one check: per-step status/ms/error/body + the verdict. */
export function PreviewResult({
  preview,
  stepNames,
}: {
  preview: Preview;
  stepNames: Record<string, string>;
}) {
  const { trace, result } = preview;
  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">{ko.monitor.previewVerdict}</span>
        <span className="font-semibold">{VERDICT_LABEL[result.verdict]}</span>
        {result.latency_ms != null && <span>{formatMs(result.latency_ms)}</span>}
        {result.reason != null && <span className="text-slate-600">{result.reason}</span>}
      </p>
      {trace == null ? (
        <p className="mt-2 text-slate-600">{ko.monitor.previewNoTrace}</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-2">
          {trace.steps.map((s, i) => (
            <li key={`${s.step_id}-${i}`} className="rounded border border-slate-200 bg-white p-2">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-slate-500">{ko.monitor.previewStep}</dt>
                <dd>{stepNames[s.step_id] ?? s.step_id}</dd>
                <dt className="text-slate-500">{ko.monitor.previewStatus}</dt>
                <dd className="tabular-nums">
                  {s.response ? String(s.response.status) : ko.monitor.noValue}
                </dd>
                <dt className="text-slate-500">{ko.monitor.previewLatency}</dt>
                <dd className="tabular-nums">
                  {s.response ? formatMs(s.response.latency_ms) : ko.monitor.noValue}
                </dd>
                {s.error != null && (
                  <>
                    <dt className="text-slate-500">{ko.monitor.previewError}</dt>
                    <dd className="break-all text-red-700">{s.error}</dd>
                  </>
                )}
              </dl>
              {s.response && s.response.body !== "" && (
                <>
                  <p className="mt-2 text-xs font-medium text-slate-500">
                    {ko.monitor.previewBody}
                  </p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs">
                    {s.response.body}
                  </pre>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
