import { useMemo, useState } from "react";
import type { Profile, Report } from "../../api/schemas";
import { downloadFile } from "../../api/download";
import { api } from "../../api/client";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import { flattenHttpSteps, findStepById } from "../../scenario/model";
import { resolveForDisplay } from "../../scenario/template";
import { Summary } from "./Summary";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { ActiveVuChart } from "./ActiveVuChart";
import { StatusDistribution } from "./StatusDistribution";
import { StepStatsTable } from "./StepStatsTable";
import { BranchStatsTable } from "./BranchStatsTable";
import { GroupLatencyTable } from "./GroupLatencyTable";
import { ScenarioSnapshot } from "./ScenarioSnapshot";
import { DownloadJsonButton } from "./DownloadJsonButton";
import { VerdictPanel } from "./VerdictPanel";
import { InsightPanel } from "./InsightPanel";
import { PercentileCurveChart } from "./PercentileCurveChart";
import { LatencyHistogramChart } from "./LatencyHistogramChart";
import { ReportHeadline } from "./ReportHeadline";

type Props = { report: Report; profile: Profile };

type Sec = { ts_second: number; count: number; errors: number; p95_ms: number };

function bySecond(report: Report): Sec[] {
  const buckets = new Map<number, Sec>();
  for (const w of report.windows) {
    const cur = buckets.get(w.ts_second) ?? {
      ts_second: w.ts_second,
      count: 0,
      errors: 0,
      p95_ms: 0,
    };
    cur.count += w.count;
    cur.errors += w.error_count;
    // For p95 time series, use the max across steps in the same second as a coarse signal.
    // Per-second per-step p95 charts are deferred (ADR-0017 OUT: percentile histogram view).
    if (w.p95_ms > cur.p95_ms) cur.p95_ms = w.p95_ms;
    buckets.set(w.ts_second, cur);
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts_second - b.ts_second);
}

export function ReportView({ report, profile }: Props) {
  const seconds = useMemo(() => bySecond(report), [report]);
  const envMap = useMemo<Record<string, string>>(() => {
    const env = report.run.env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    return {};
  }, [report.run.env]);

  const stepMeta = useMemo(() => {
    const m = new Map<string, { id: string; name: string; method: string; url: string }>();
    const parsed = parseScenarioDoc(report.scenario_yaml);
    if ("model" in parsed) {
      for (const s of flattenHttpSteps(parsed.model.steps)) {
        m.set(s.id, {
          id: s.id,
          name: s.name,
          method: s.request.method,
          url: resolveForDisplay(s.request.url, envMap),
        });
      }
    }
    return m;
  }, [report.scenario_yaml, envMap]);

  const ifMeta = useMemo(() => {
    const m = new Map<string, { name: string }>();
    const parsed = parseScenarioDoc(report.scenario_yaml);
    if ("model" in parsed) {
      for (const b of report.if_breakdown ?? []) {
        const step = findStepById(parsed.model.steps, b.step_id);
        m.set(b.step_id, { name: step?.name ?? b.step_id });
      }
    }
    return m;
  }, [report.scenario_yaml, report.if_breakdown]);

  const groupMeta = useMemo(() => {
    const m = new Map<string, { name: string }>();
    const parsed = parseScenarioDoc(report.scenario_yaml);
    if ("model" in parsed) {
      for (const g of report.group_latency ?? []) {
        const step = findStepById(parsed.model.steps, g.step_id);
        m.set(g.step_id, { name: step?.name ?? g.step_id });
      }
    }
    return m;
  }, [report.scenario_yaml, report.group_latency]);

  const [dlErr, setDlErr] = useState<string | null>(null);

  return (
    <div>
      <ReportHeadline summary={report.summary} profile={profile} verdict={report.verdict} />
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold">Report</h3>
        <div className="flex items-center gap-2">
          <DownloadJsonButton filename={`run-${report.run.id}.json`} data={report} />
          <button
            type="button"
            onClick={() =>
              downloadFile(
                api.reportCsvUrl(report.run.id),
                `run-${report.run.id}-report.csv`,
                "text/csv",
              ).catch((e) => setDlErr((e as Error).message))
            }
            className="inline-block px-3 py-1.5 text-sm bg-slate-700 text-white rounded hover:bg-slate-800"
          >
            Download CSV
          </button>
          <button
            type="button"
            onClick={() =>
              downloadFile(
                api.reportXlsxUrl(report.run.id),
                `run-${report.run.id}-report.xlsx`,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              ).catch((e) => setDlErr((e as Error).message))
            }
            className="inline-block px-3 py-1.5 text-sm bg-slate-700 text-white rounded hover:bg-slate-800"
          >
            Download XLSX
          </button>
        </div>
      </div>
      {dlErr && (
        <p
          role="alert"
          className="mb-4 p-2 rounded border border-red-200 bg-red-50 text-sm text-red-700"
        >
          다운로드 실패: {dlErr}
        </p>
      )}
      <InsightPanel insights={report.insights ?? []} meta={stepMeta} />
      {report.verdict ? <VerdictPanel verdict={report.verdict} steps={stepMeta} /> : null}
      <Summary
        summary={report.summary}
        dropped={report.dropped}
        targetRps={(report.run.profile as { target_rps?: number } | null)?.target_rps ?? null}
      />
      <TimeSeriesChart
        title="Requests / second"
        yLabel="req/s"
        data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.count }))}
      />
      <TimeSeriesChart
        title="p95 response time"
        yLabel="ms"
        data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.p95_ms }))}
      />
      <TimeSeriesChart
        title="Errors / second"
        yLabel="errors"
        data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.errors }))}
      />
      {report.active_vu_series && report.active_vu_series.length > 0 ? (
        <ActiveVuChart series={report.active_vu_series} />
      ) : null}
      {report.latency ? (
        <section aria-label="Latency">
          <h3 className="text-lg font-semibold mb-2">Latency</h3>
          <PercentileCurveChart curve={report.latency.percentile_curve} />
          <LatencyHistogramChart buckets={report.latency.histogram} />
        </section>
      ) : null}
      <StatusDistribution distribution={report.status_distribution} />
      <StepStatsTable steps={report.steps} meta={stepMeta} />
      <BranchStatsTable breakdown={report.if_breakdown ?? []} meta={ifMeta} />
      <GroupLatencyTable breakdown={report.group_latency ?? []} meta={groupMeta} />
      <ScenarioSnapshot yaml={report.scenario_yaml} />
    </div>
  );
}
