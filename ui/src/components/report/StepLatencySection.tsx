import { useMemo, useState } from "react";
import type { Report } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { sharedYMax, stepLatencySeries } from "../../report/stepLatencySeries";
import type { SteadyMarks } from "./steadyMarks";
import { STEP_LATENCY_VIEWS, type StepLatencyView } from "./stepLatencyViews";

type Props = {
  report: Report;
  stepNames: Map<string, string>;
  marks: SteadyMarks | null;
  firstTs: number | null;
};

export function StepLatencySection({ report, stepNames, marks, firstTs }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<StepLatencyView>("grid");
  const series = useMemo(
    () => stepLatencySeries(report, stepNames, firstTs),
    [report, stepNames, firstTs],
  );
  const yMax = useMemo(() => sharedYMax(series), [series]);
  const xMax = useMemo(() => {
    let m = 0;
    for (const s of series) for (const p of s.points) if (p.x > m) m = p.x;
    if (marks) {
      for (const b of marks.bands) if (b.x2 > m) m = b.x2;
      for (const l of marks.lines) if (l.x > m) m = l.x;
    }
    return m;
  }, [series, marks]);
  const views = Object.keys(STEP_LATENCY_VIEWS) as StepLatencyView[];
  const { Component } = STEP_LATENCY_VIEWS[view];
  const t = ko.report.stepLatency;
  return (
    <div className="mt-3 mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded border border-slate-300 bg-white px-2.5 py-0.5 text-[13px] text-slate-600 hover:bg-slate-50"
        >
          <span aria-hidden="true">{open ? "▾" : "▸"} </span>
          {t.toggle}
        </button>
        {open && views.length > 1 ? (
          <span className="ml-auto flex gap-1">
            {views.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={v === view}
                onClick={() => setView(v)}
                className="rounded border border-slate-300 px-2 py-0.5 text-[13px]"
              >
                {STEP_LATENCY_VIEWS[v].label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {open ? (
        <div>
          <p className="mt-1.5 text-xs text-slate-500">{t.hint(String(yMax))}</p>
          {series.some((s) => s.capped) ? (
            <p className="mt-1 text-xs text-slate-500">{t.hintCapped}</p>
          ) : null}
          <Component series={series} yMax={yMax} xMax={xMax} marks={marks} />
        </div>
      ) : null}
    </div>
  );
}
