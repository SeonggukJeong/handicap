import type { Cell, CompareResult, CompareRow } from "../../compare/compareReports";
import { verdictPolarity } from "../../compare/compareReports";
import { runColor } from "../../compare/runLabel";
import { ko } from "../../i18n/ko";

type Props = {
  result: CompareResult;
  labels: Record<string, string>;
  onBaselineChange: (runId: string) => void;
};

function formatPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${(pct * 100).toFixed(1)}%`;
}

function DeltaChip({ cell }: { cell: Cell }) {
  if (cell.delta === null) return null;
  const { pct, polarity } = cell.delta;

  let text: string;
  if (pct === null) {
    // baseline was 0 — never show ∞%
    text = cell.value !== null && cell.value > 0 ? "신규" : "동일";
  } else {
    text = formatPct(pct);
  }

  if (polarity === "bad") {
    return (
      <span className="ml-1 text-red-600 text-xs" aria-label={ko.compare.worseAria(text)}>
        ▲{text}
      </span>
    );
  }
  if (polarity === "good") {
    return (
      <span className="ml-1 text-green-600 text-xs" aria-label={ko.compare.betterAria(text)}>
        ▼{text}
      </span>
    );
  }
  // neutral
  return (
    <span className="ml-1 text-slate-500 text-xs" aria-label={ko.compare.neutralAria(text)}>
      {text}
    </span>
  );
}

function CellContent({ cell }: { cell: Cell }) {
  const display = cell.value === null ? "—" : String(cell.value);
  return (
    <>
      {display}
      <DeltaChip cell={cell} />
    </>
  );
}

function SectionRows({
  title,
  rows,
  runCount,
}: {
  title: string;
  rows: CompareRow[];
  runCount: number;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <tr>
        <th
          colSpan={runCount + 1}
          className="py-2 px-3 text-left text-sm font-semibold text-slate-600 bg-slate-50 dark:bg-slate-800 dark:text-slate-300 border-t border-slate-200 dark:border-slate-700"
        >
          {title}
        </th>
      </tr>
      {rows.map((row) => (
        <tr
          key={row.metric + row.label}
          className="border-b border-slate-100 dark:border-slate-800"
        >
          <td
            className="py-2 pr-4 font-medium text-slate-700 dark:text-slate-300 break-all"
            title={row.label}
          >
            {row.label}
          </td>
          {row.cells.slice(0, runCount).map((cell, i) => (
            <td key={i} className="py-2 pr-4 text-sm">
              <CellContent cell={cell} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function CompareMatrix({ result, labels, onBaselineChange }: Props) {
  const { runIds, baselineIdx, summary, steps, status, verdict, stepMismatch } = result;
  const colCount = runIds.length;

  return (
    <div>
      {/* Step mismatch banner — stays above the table */}
      {stepMismatch && (
        <p
          role="status"
          className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2"
        >
          스텝 구성이 달라 일부만 비교됩니다
        </p>
      )}

      {/*
       * Single table: one colgroup drives all column widths so that every
       * section's value cells sit directly under the run-header buttons.
       */}
      <table className="min-w-full text-sm">
        <colgroup>
          {/* label column */}
          <col className="w-48" />
          {/* one column per run */}
          {runIds.map((id) => (
            <col key={id} />
          ))}
        </colgroup>

        {/* Column headers — clickable to switch baseline */}
        <thead className="border-b border-slate-200 dark:border-slate-700 text-left text-slate-600 dark:text-slate-400">
          <tr>
            <th className="py-2 pr-4 font-medium" />
            {runIds.map((runId, i) => (
              <th key={runId} className="py-2 pr-4 font-medium">
                <button
                  type="button"
                  onClick={() => onBaselineChange(runId)}
                  className="inline-flex items-center gap-1.5 hover:underline text-left"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block w-3 h-3 rounded-sm ring-1 ring-black/10 dark:ring-white/20 shrink-0"
                    style={{ backgroundColor: runColor(i) }}
                  />
                  {labels[runId] ?? runId}
                  {i === baselineIdx && (
                    <span className="ml-1 text-xs text-slate-500 font-normal">(base)</span>
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {/* Verdict row */}
          <tr className="border-b border-slate-100 dark:border-slate-800">
            <td className="py-2 pr-4 font-medium text-slate-700 dark:text-slate-300">판정</td>
            {verdict.passed.map((p, i) => {
              const pol =
                i === baselineIdx ? "neutral" : verdictPolarity(verdict.passed[baselineIdx], p);
              return (
                <td key={i} className="py-2 pr-4">
                  {p === null ? (
                    "—"
                  ) : p ? (
                    <span className="text-green-600 font-semibold">{ko.report.verdictPass}</span>
                  ) : (
                    <span className="text-red-600 font-semibold">{ko.report.verdictFail}</span>
                  )}
                  {pol === "bad" && (
                    <span className="ml-1 text-red-600 text-xs font-semibold">
                      ▲{ko.compare.verdictWorse}
                    </span>
                  )}
                  {pol === "good" && (
                    <span className="ml-1 text-green-600 text-xs font-semibold">
                      ▼{ko.compare.verdictBetter}
                    </span>
                  )}
                </td>
              );
            })}
          </tr>

          {/* Summary section rows with spanning sub-header */}
          <SectionRows title={ko.report.summaryTitle} rows={summary} runCount={colCount} />

          {/* Steps section rows with spanning sub-header */}
          <SectionRows title={ko.report.stepsHeading} rows={steps} runCount={colCount} />

          {/* Status section rows with spanning sub-header */}
          <SectionRows title={ko.report.colStatus} rows={status} runCount={colCount} />
        </tbody>
      </table>
    </div>
  );
}
