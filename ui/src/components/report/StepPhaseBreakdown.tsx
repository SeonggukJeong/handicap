import { Fragment, useState } from "react";
import type { LoopSplit, ReportSampleName, ReportStep, ReportSummary } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { RetryBadge } from "./LoopExitSummary";
import { StepStatsTable } from "./StepStatsTable";
import { MixedSampleBadge } from "./MixedSampleBadge";
import { WholeRunBadge } from "./WholeRunBadge";

type StepMeta = { id: string; name: string; method: string; url: string };
type Props = {
  steps: ReportStep[];
  meta: Map<string, StepMeta>;
  retriedStepIds?: ReadonlySet<string>;
  /** 대기·다운로드·반복·응답 분리 줄이 run 전체 값일 때 「전체 구간」 표지를 단다. */
  wholeRunBadge?: boolean;
  /** 응답 시간 표본 — 표(StepStatsTable)에 그대로 넘긴다. */
  sample?: ReportSampleName;
  /** 표본을 나눈 run이면 대기·다운로드·분리 줄에 「실패 포함」 표지를 단다. */
  mixedSample?: boolean;
  /** 표본을 바꿔 보는 동안의 표본 이름 — 표 제목 곁에 달고, 막대 보기에선 안내 줄로 바꾼다. */
  sampleTag?: string | null;
  /** 보여 주는 summary — 표(StepStatsTable)의 「모든 스텝」 행에 그대로 넘긴다. */
  summary?: ReportSummary;
};
type View = "waterfall" | "chips";

const WAIT = "#f59e0b";
const DL = "#22c55e";

const fmt = (n: number) => n.toLocaleString("en-US");

function SplitLine({
  label,
  stats,
  badge,
  mixed,
}: {
  label: string;
  stats: LoopSplit["final"];
  badge?: boolean;
  mixed?: boolean;
}) {
  const pct = (v: number) => (stats.count === 0 ? "—" : fmt(v));
  return (
    <div className="break-words text-xs text-slate-600">
      <span aria-hidden="true">└ </span>
      {ko.report.loopExit.splitBarLine(
        label,
        fmt(stats.count),
        fmt(stats.error_count),
        pct(stats.p50_ms),
        pct(stats.p95_ms),
        pct(stats.p99_ms),
      )}
      {badge && <WholeRunBadge className="ml-1" />}
      {mixed && <MixedSampleBadge className="ml-1" />}
    </div>
  );
}

export function StepPhaseBreakdown({
  steps,
  meta,
  retriedStepIds,
  wholeRunBadge,
  sample,
  mixedSample,
  sampleTag,
  summary,
}: Props) {
  const [view, setView] = useState<View>("waterfall");
  const anyPhase = steps.some((s) => s.wait != null || s.download != null);
  if (!anyPhase) {
    // no phase data (measure_phases off) → fall back to the plain table
    return (
      <StepStatsTable
        steps={steps}
        meta={meta}
        retriedStepIds={retriedStepIds}
        wholeRunBadge={wholeRunBadge}
        sample={sample}
        mixedSample={mixedSample}
        sampleTag={sampleTag}
        summary={summary}
      />
    );
  }
  return (
    <section aria-label={ko.report.perStepStatsLabel} className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        {/* HelpTip is a sibling of <h3>, NOT a child (ui/CLAUDE.md U3 heading-accname trap). */}
        <div className="flex items-center">
          <h3 className="text-lg font-semibold">{ko.report.stepsHeading}</h3>
          <HelpTip label={ko.report.phaseWait}>{ko.report.phaseWaitHelp}</HelpTip>
        </div>
        <div
          role="group"
          aria-label={ko.report.phaseViewToggleLabel}
          className="flex gap-1 text-xs"
        >
          <button
            type="button"
            aria-pressed={view === "waterfall"}
            onClick={() => setView("waterfall")}
            className={`rounded px-2 py-1 ${view === "waterfall" ? "bg-slate-800 text-white" : "bg-slate-100"}`}
          >
            {ko.report.phaseViewWaterfall}
          </button>
          <button
            type="button"
            aria-pressed={view === "chips"}
            onClick={() => setView("chips")}
            className={`rounded px-2 py-1 ${view === "chips" ? "bg-slate-800 text-white" : "bg-slate-100"}`}
          >
            {ko.report.phaseViewChips}
          </button>
        </div>
      </div>
      {view === "chips" ? (
        <StepStatsTable
          embedded
          steps={steps}
          meta={meta}
          retriedStepIds={retriedStepIds}
          wholeRunBadge={wholeRunBadge}
          sample={sample}
          mixedSample={mixedSample}
          sampleTag={sampleTag}
          summary={summary}
        />
      ) : (
        <div>
          {sampleTag != null && (
            <p className="mb-2 text-xs text-slate-500">
              {ko.report.sample.waterfallNote(ko.report.phaseViewChips)}
            </p>
          )}
          {steps.map((s) => {
            const m = meta.get(s.step_id);
            const wait = s.wait?.p50_ms ?? 0;
            const dl = s.download?.p50_ms ?? 0;
            const total = wait + dl || 1;
            return (
              <Fragment key={s.step_id}>
                <div className="flex items-center gap-3 border-t border-slate-100 py-2">
                  {retriedStepIds?.has(s.step_id) ? (
                    <div className="flex w-40 shrink-0 items-center text-sm font-medium">
                      <span className="min-w-0 truncate" title={m?.name ?? s.step_id}>
                        {m?.name ?? s.step_id}
                      </span>
                      <RetryBadge />
                    </div>
                  ) : (
                    <div
                      className="w-40 shrink-0 truncate text-sm font-medium"
                      title={m?.name ?? s.step_id}
                    >
                      {m?.name ?? s.step_id}
                    </div>
                  )}
                  <div
                    role="img"
                    aria-label={`${m?.name ?? s.step_id} ${ko.report.phaseWait} ${wait}ms ${ko.report.phaseDownload} ${dl}ms${wholeRunBadge ? ` · ${ko.report.basis.wholeBadge}` : ""}`}
                    className="flex h-5 flex-1 overflow-hidden rounded bg-slate-100"
                  >
                    <span style={{ width: `${(wait / total) * 100}%`, background: WAIT }} />
                    <span style={{ width: `${(dl / total) * 100}%`, background: DL }} />
                  </div>
                  <div className="w-16 text-right text-sm font-bold tabular-nums">
                    {wait + dl}ms
                  </div>
                </div>
                {s.loop_split ? (
                  <div className="pb-2">
                    <SplitLine
                      label={ko.report.loopExit.splitFinal}
                      stats={s.loop_split.final}
                      badge={wholeRunBadge}
                      mixed={mixedSample}
                    />
                    <SplitLine label={ko.report.loopExit.splitRetry} stats={s.loop_split.retry} />
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          <div className="mt-2 flex gap-4 text-xs text-slate-500">
            <span>
              <i
                className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]"
                style={{ background: WAIT }}
              />
              {ko.report.phaseWait}
            </span>
            <span>
              <i
                className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]"
                style={{ background: DL }}
              />
              {ko.report.phaseDownload}
            </span>
            {wholeRunBadge && <WholeRunBadge />}
            {mixedSample && <MixedSampleBadge />}
          </div>
        </div>
      )}
    </section>
  );
}
