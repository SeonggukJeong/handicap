import type { SequentialTrace } from "../../api/schemas";
import type { Extract, Step } from "../../scenario/model";
import { Callout } from "../ui/Callout";
import { TraceStepList } from "./TestRunPanel";
import { ko } from "../../i18n/ko";

/** 순차 검증 기본 펼침 행: 첫 실패 행(없으면 첫 행)의 row_index (R13). */
// eslint-disable-next-line react-refresh/only-export-components
export function defaultExpandedRow(seq: SequentialTrace): number | null {
  if (seq.rows.length === 0) return null;
  const failed = seq.rows.find((r) => !r.trace.ok);
  return (failed ?? seq.rows[0]).row_index;
}

export function SequentialRunPanel({
  seq,
  steps,
  requestedRows,
  expandedRow,
  onExpandRow,
  onAddExtract,
}: {
  seq: SequentialTrace;
  steps?: ReadonlyArray<Step>;
  requestedRows: number;
  expandedRow: number | null;
  onExpandRow: (rowIndex: number | null) => void;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}) {
  const completed = seq.rows.filter((r) => !r.trace.truncated).length;
  return (
    <section aria-label={ko.editor.seqResultAria} className="rounded border border-slate-200 p-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold">{ko.editor.seqResultTitle}</h3>
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ${
            seq.ok ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900"
          }`}
        >
          {seq.ok ? ko.editor.testRunOk : ko.editor.testRunFail}
        </span>
        <span className="text-xs text-slate-500">
          {seq.total_ms}ms · {ko.editor.seqRowCount(seq.rows.length)}
        </span>
      </div>
      {seq.truncated && (
        <Callout variant="warn" className="mb-2">
          {ko.editor.seqTruncated(requestedRows, completed)}
        </Callout>
      )}
      <ul>
        {seq.rows.map((r) => {
          const open = expandedRow === r.row_index;
          return (
            <li key={r.row_index} className="border-b border-slate-100 py-1">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onExpandRow(open ? null : r.row_index)}
                className="flex w-full items-center gap-2 text-left text-sm"
              >
                <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                <span className="font-medium">{ko.editor.seqRowLabel(r.row_index + 1)}</span>
                <span
                  title={r.trace.ok ? ko.editor.testRunOk : ko.editor.testRunFail}
                  className={r.trace.ok ? "text-emerald-600" : "text-red-600"}
                >
                  {r.trace.ok ? "✓" : "✗"}
                </span>
                <span className="text-xs text-slate-500">{r.trace.total_ms}ms</span>
              </button>
              {open && (
                <div className="mt-1 pl-5">
                  {r.trace.truncated && (
                    <Callout variant="warn" className="mb-1">
                      {ko.editor.seqRowTruncated}
                    </Callout>
                  )}
                  <TraceStepList trace={r.trace} steps={steps} onAddExtract={onAddExtract} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
