import { useState } from "react";
import type { ReportStep } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { StepStatsTable } from "./StepStatsTable";

type StepMeta = { id: string; name: string; method: string; url: string };
type Props = { steps: ReportStep[]; meta: Map<string, StepMeta> };
type View = "waterfall" | "chips";

const WAIT = "#f59e0b";
const DL = "#22c55e";

export function StepPhaseBreakdown({ steps, meta }: Props) {
  const [view, setView] = useState<View>("waterfall");
  const anyPhase = steps.some((s) => s.wait != null || s.download != null);
  if (!anyPhase) {
    // no phase data (measure_phases off) → fall back to the plain table
    return <StepStatsTable steps={steps} meta={meta} />;
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
        <StepStatsTable steps={steps} meta={meta} />
      ) : (
        <div>
          {steps.map((s) => {
            const m = meta.get(s.step_id);
            const wait = s.wait?.p50_ms ?? 0;
            const dl = s.download?.p50_ms ?? 0;
            const total = wait + dl || 1;
            return (
              <div
                key={s.step_id}
                className="flex items-center gap-3 border-t border-slate-100 py-2"
              >
                <div className="w-40 text-sm font-medium">{m?.name ?? s.step_id}</div>
                <div
                  role="img"
                  aria-label={`${m?.name ?? s.step_id} 대기 ${wait}ms 다운로드 ${dl}ms`}
                  className="flex h-5 flex-1 overflow-hidden rounded bg-slate-100"
                >
                  <span style={{ width: `${(wait / total) * 100}%`, background: WAIT }} />
                  <span style={{ width: `${(dl / total) * 100}%`, background: DL }} />
                </div>
                <div className="w-16 text-right text-sm font-bold tabular-nums">{wait + dl}ms</div>
              </div>
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
          </div>
        </div>
      )}
    </section>
  );
}
