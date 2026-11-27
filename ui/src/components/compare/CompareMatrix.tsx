import { Fragment, useState } from "react";
import type { Cell, CompareResult, CompareRow } from "../../compare/compareReports";
import { verdictPolarity } from "../../compare/compareReports";
import { runColor } from "../../compare/runLabel";
import { ko } from "../../i18n/ko";
import { floorPct, statMs3Text } from "../report/format";
import { Callout } from "../ui/Callout";

type Props = {
  result: CompareResult;
  labels: Record<string, string>;
  onBaselineChange: (runId: string) => void;
  /** Additive optional (run-identity Task 9) — per-run header subline (예: 시각·설정
   *  요약). 미전달=미렌더, 기존 소비처(InsightCompareMatrix 등)는 무churn. */
  sublines?: Record<string, string>;
};

function formatPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${(pct * 100).toFixed(1)}%`;
}

// 극성 → 색·읽어 주는 글. 글리프는 일반 칩에선 값이 움직인 방향(아래 `directionGlyph`), 「60초 칸」 칩에선 극성.
const POLARITY_CHIP = {
  bad: { cls: "text-red-600", glyph: "▲", aria: ko.compare.worseAria },
  good: { cls: "text-green-600", glyph: "▼", aria: ko.compare.betterAria },
  neutral: { cls: "text-slate-500", glyph: "", aria: ko.compare.neutralAria },
} as const;

/** 값이 움직인 방향 글리프 — 색(좋고 나쁨)과 무관. 서버 `delta_cell_text`와 같은 규칙. */
function directionGlyph(pct: number | null, value: number | null): string {
  if (pct === null) return value !== null && value > 0 ? "▲" : "";
  return pct > 0 ? "▲" : pct < 0 ? "▼" : "";
}

function DeltaChip({ cell }: { cell: Cell }) {
  if (cell.delta === null) return null;
  const { pct, polarity, capped } = cell.delta;
  const chip = POLARITY_CHIP[polarity];

  if (capped) {
    // 한쪽이 60초 칸 — 변화율 대신 「—」(신규·동일이 아니다). 시간 지표는 낮을수록 좋아 극성이 곧 방향.
    const title = ko.compare.cappedDeltaTitle;
    return (
      <span
        className={`ml-1 ${chip.cls} text-xs`}
        title={title}
        aria-label={polarity === "neutral" ? title : chip.aria(title)}
      >
        {chip.glyph}—
      </span>
    );
  }

  let text: string;
  if (pct === null) {
    // baseline was 0 — never show ∞%
    text = cell.value !== null && cell.value > 0 ? "신규" : "동일";
  } else {
    text = formatPct(pct);
  }

  return (
    <span className={`ml-1 ${chip.cls} text-xs`} aria-label={chip.aria(text)}>
      {directionGlyph(pct, cell.value)}
      {text}
    </span>
  );
}

function CellContent({ cell, metric }: { cell: Cell; metric: string }) {
  const display =
    cell.value === null
      ? "—"
      : cell.time
        ? statMs3Text(cell.time.us)
        : metric === "rps"
          ? cell.value.toFixed(2)
          : metric === "error_rate"
            ? floorPct(cell.value * 100)
            : String(cell.value);
  return (
    <>
      {display}
      <DeltaChip cell={cell} />
    </>
  );
}

// 새 통계 지표의 한국어 이름 — 상속 속성 이름(`constructor` 등)은 label로 떨어진다.
function statName(row: CompareRow): string {
  return Object.hasOwn(ko.compare.statLabel, row.metric)
    ? ko.compare.statLabel[row.metric as keyof typeof ko.compare.statLabel]
    : row.label;
}

function SectionRows({
  title,
  rows,
  runCount,
  labelOf,
  stepStats,
}: {
  title: string;
  rows: CompareRow[];
  runCount: number;
  /** 행 이름 — 없으면 `row.label`. */
  labelOf?: (row: CompareRow) => string;
  /** 스텝 절에서만 — 있으면 제목 칸 오른쪽에 「응답 시간 통계 더 보기」 단추를 둔다. */
  stepStats?: CompareRow[];
}) {
  // 대량 부가 표 — 기본 접힘.
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const hasStats = stepStats !== undefined && stepStats.length > 0;
  return (
    <>
      <tr>
        <th
          colSpan={runCount + 1}
          className="py-2 px-3 text-left text-sm font-semibold text-slate-600 bg-slate-50 dark:bg-slate-800 dark:text-slate-300 border-t border-slate-200 dark:border-slate-700"
        >
          <div className="inline-flex items-center gap-2 sticky left-3">
            <span>{title}</span>
            {hasStats && (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 rounded px-2.5 py-0.5 text-[13px] font-normal text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {open ? ko.report.stats.toggleLess : ko.report.stats.toggleMore}
              </button>
            )}
          </div>
        </th>
      </tr>
      {rows.map((row) => (
        <Fragment key={row.metric + (row.id ?? row.label)}>
          <tr className="border-b border-slate-100 dark:border-slate-800">
            <td
              className="py-2 pl-0 pr-4 font-medium text-slate-700 dark:text-slate-300 sticky left-0 bg-slate-50 shadow-[1px_0_0_#e2e8f0]"
              title={labelOf ? labelOf(row) : row.label}
            >
              <span className="block truncate w-28 lg:w-44">
                {labelOf ? labelOf(row) : row.label}
              </span>
            </td>
            {row.cells.slice(0, runCount).map((cell, i) => (
              <td key={i} className="py-2 pr-4 text-sm whitespace-nowrap">
                <CellContent cell={cell} metric={row.metric} />
              </td>
            ))}
          </tr>
          {open &&
            hasStats &&
            row.id !== undefined &&
            stepStats
              .filter((stat) => stat.id === row.id)
              .map((stat) => {
                const text = ko.compare.stepStatLabel(statName(stat));
                return (
                  <tr
                    key={`${row.id}:${stat.metric}`}
                    className="border-b border-slate-100 dark:border-slate-800"
                  >
                    <td
                      className="py-2 pl-4 pr-4 font-medium text-slate-700 dark:text-slate-300 sticky left-0 bg-slate-50 shadow-[1px_0_0_#e2e8f0]"
                      title={text}
                    >
                      <span className="block truncate w-24 lg:w-40">{text}</span>
                    </td>
                    {stat.cells.slice(0, runCount).map((cell, i) => (
                      <td key={i} className="py-2 pr-4 text-sm whitespace-nowrap">
                        <CellContent cell={cell} metric={stat.metric} />
                      </td>
                    ))}
                  </tr>
                );
              })}
        </Fragment>
      ))}
    </>
  );
}

export function CompareMatrix({ result, labels, onBaselineChange, sublines }: Props) {
  const { runIds, baselineIdx, summary, steps, status, verdict, stepMismatch } = result;
  const colCount = runIds.length;

  return (
    <div>
      {/* Step mismatch banner — stays above the table */}
      {stepMismatch && (
        <Callout variant="warn" role="status" className="mb-4">
          스텝 구성이 달라 일부만 비교됩니다
        </Callout>
      )}

      {/*
       * Single table: one colgroup drives all column widths so that every
       * section's value cells sit directly under the run-header buttons.
       */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <colgroup>
            {/* label column */}
            <col className="lg:w-48" />
            {/* one column per run */}
            {runIds.map((id) => (
              <col key={id} />
            ))}
          </colgroup>

          {/* Column headers — clickable to switch baseline */}
          <thead className="border-b border-slate-200 dark:border-slate-700 text-left text-slate-600 dark:text-slate-400">
            <tr>
              <th className="py-2 pl-0 pr-4 font-medium sticky left-0 bg-slate-50 shadow-[1px_0_0_#e2e8f0]" />
              {runIds.map((runId, i) => (
                <th key={runId} className="py-2 pr-4 font-medium whitespace-nowrap">
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
                    <span className="truncate max-w-[12rem]" title={labels[runId] ?? runId}>
                      {labels[runId] ?? runId}
                    </span>
                    {i === baselineIdx && (
                      <span className="ml-1 text-xs text-slate-500 font-normal">(base)</span>
                    )}
                  </button>
                  {sublines?.[runId] && (
                    <div className="mt-0.5 text-xs font-normal text-slate-500">
                      {sublines[runId]}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {/* Verdict row */}
            <tr className="border-b border-slate-100 dark:border-slate-800">
              <td className="py-2 pl-0 pr-4 font-medium text-slate-700 dark:text-slate-300 sticky left-0 bg-slate-50 shadow-[1px_0_0_#e2e8f0]">
                판정
              </td>
              {verdict.passed.map((p, i) => {
                const pol =
                  i === baselineIdx ? "neutral" : verdictPolarity(verdict.passed[baselineIdx], p);
                return (
                  <td key={i} className="py-2 pr-4 whitespace-nowrap">
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
            <SectionRows
              title={ko.report.summaryTitle}
              rows={summary}
              runCount={colCount}
              labelOf={statName}
            />

            {/* Steps section rows with spanning sub-header */}
            <SectionRows
              title={ko.report.stepsHeading}
              rows={steps}
              runCount={colCount}
              stepStats={result.stepStats}
            />

            <SectionRows title={ko.report.setup.title} rows={result.setup} runCount={colCount} />

            {/* Status section rows with spanning sub-header */}
            <SectionRows title={ko.report.colStatus} rows={status} runCount={colCount} />
          </tbody>
        </table>
      </div>
    </div>
  );
}
