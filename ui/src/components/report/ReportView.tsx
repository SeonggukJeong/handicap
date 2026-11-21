import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Profile, Report } from "../../api/schemas";
import { downloadFile } from "../../api/download";
import { api } from "../../api/client";
import { ko } from "../../i18n/ko";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import { flattenHttpSteps, findStepById } from "../../scenario/model";
import { resolveForDisplay } from "../../scenario/template";
import { Summary } from "./Summary";
import { TimeSeriesChart } from "./TimeSeriesChart";
import { ActiveVuChart } from "./ActiveVuChart";
import { StatusDistribution } from "./StatusDistribution";
import { ErrorKindTable } from "./ErrorKindTable";
import { ConnectionCostCard } from "./ConnectionCostCard";
import { StepPhaseBreakdown } from "./StepPhaseBreakdown";
import { BranchStatsTable } from "./BranchStatsTable";
import { GroupLatencyTable } from "./GroupLatencyTable";
import { ScenarioSnapshot } from "./ScenarioSnapshot";
import { AppliedTimeouts } from "./AppliedTimeouts";
import { DownloadMenu } from "../DownloadMenu";
import { downloadJson } from "../../api/downloadJson";
import { HelpTip } from "../HelpTip";
import { VerdictPanel } from "./VerdictPanel";
import { InsightPanel } from "./InsightPanel";
import { ValidityBanner } from "./ValidityBanner";
import { LoopRetryNotice } from "./LoopRetryNotice";
import { StairResultSection } from "./stair/StairResultSection";
import { LoopExitSummary } from "./LoopExitSummary";
import { LoopExitPanel } from "./LoopExitPanel";
import { buildLoopExitViews, retriedStepIdSet } from "./loopExitView";
import { WorkerBreakdownTable } from "./WorkerBreakdownTable";
import { PercentileCurveChart } from "./PercentileCurveChart";
import { LatencyHistogramChart } from "./LatencyHistogramChart";
import { ReportHeadline } from "./ReportHeadline";
import { openLoopRates } from "./openLoopRates";
import { bySecond } from "../../report/bySecond";
import { Callout } from "../ui/Callout";
import { PageSection } from "../ui/PageSection";
import { BasisBar } from "./BasisBar";
import { steadyMarks } from "./steadyMarks";
import { deriveLoadMode } from "../run/loadModel";

type Props = {
  report: Report;
  profile: Profile;
  onSelectBasis?: (b: "steady" | "whole") => void;
  pending?: boolean;
};

export function ReportView({ report, profile, onSelectBasis, pending }: Props) {
  const seconds = useMemo(() => bySecond(report), [report]);
  const marks = useMemo(
    () => steadyMarks(report.basis, seconds[0]?.ts_second ?? null),
    [report.basis, seconds],
  );
  const wholeRunBadge = report.basis?.selected === "steady";
  const rampLoad = deriveLoadMode(profile);
  const showRampOnlyLine =
    !report.basis &&
    rampLoad.loadModel === "closed" &&
    rampLoad.rateMode === "fixed" &&
    profile.ramp_up_seconds > 0;
  const dropOther =
    report.basis?.selected === "steady" && report.basis.dropped_whole_run
      ? report.basis.other
      : null;
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

  const loopExitViews = useMemo(() => {
    const parsed = parseScenarioDoc(report.scenario_yaml);
    return buildLoopExitViews(
      report.loop_exits,
      report.steps,
      "model" in parsed ? parsed.model.steps : null,
    );
  }, [report.scenario_yaml, report.loop_exits, report.steps]);
  const retriedStepIds = useMemo(() => retriedStepIdSet(loopExitViews), [loopExitViews]);

  const hasStepTimeoutOverride = useMemo(() => {
    const parsed = parseScenarioDoc(report.scenario_yaml);
    // flattenHttpSteps는 loop/parallel/if 완전 재귀 — 중첩 오버라이드 포함(scenarioHasThink 선례).
    return "model" in parsed
      ? flattenHttpSteps(parsed.model.steps).some((s) => s.timeout_seconds != null)
      : false; // 파싱 실패 = 꼬리 생략(fail-soft, spec §10)
  }, [report.scenario_yaml]);

  const [dlErr, setDlErr] = useState<string | null>(null);

  return (
    <div>
      {report.basis && (
        <BasisBar basis={report.basis} onSelect={(b) => onSelectBasis?.(b)} pending={pending} />
      )}
      <div className={pending ? "opacity-60 transition-opacity" : "transition-opacity"}>
        <ReportHeadline
          summary={report.summary}
          profile={profile}
          verdict={report.verdict}
          validity={report.validity}
        />
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-semibold">{ko.report.reportTitle}</h3>
          <div className="flex items-center gap-1">
            <Link
              to={`/runs/${report.run.id}/print`}
              className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
            >
              {ko.print.page.openPrint}
            </Link>
            <DownloadMenu
              label={ko.report.downloadMenu}
              items={[
                {
                  label: "JSON",
                  onSelect: () => void downloadJson(`run-${report.run.id}.json`, report),
                },
                {
                  label: "CSV",
                  onSelect: () =>
                    downloadFile(
                      api.reportCsvUrl(report.run.id),
                      `run-${report.run.id}-report.csv`,
                      "text/csv",
                    ).catch((e) => setDlErr((e as Error).message)),
                },
                {
                  label: "XLSX",
                  onSelect: () =>
                    downloadFile(
                      api.reportXlsxUrl(report.run.id),
                      `run-${report.run.id}-report.xlsx`,
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    ).catch((e) => setDlErr((e as Error).message)),
                },
                {
                  label: ko.report.downloadInsightsCsv,
                  onSelect: () =>
                    downloadFile(
                      api.reportInsightsCsvUrl(report.run.id),
                      `run-${report.run.id}-insights.csv`,
                      "text/csv",
                    ).catch((e) => setDlErr((e as Error).message)),
                },
                ...(report.stair
                  ? [
                      {
                        label: ko.report.downloadStairsCsv,
                        onSelect: () =>
                          downloadFile(
                            api.reportStairsCsvUrl(report.run.id),
                            `run-${report.run.id}-stairs.csv`,
                            "text/csv",
                          ).catch((e) => setDlErr((e as Error).message)),
                      },
                    ]
                  : []),
              ]}
            />
            <HelpTip label={ko.report.downloadHelpAria}>
              <span className="block">
                <b>JSON</b> — {ko.report.downloadHelp.json}
              </span>
              <span className="block">
                <b>CSV</b> — {ko.report.downloadHelp.csv}
              </span>
              <span className="block">
                <b>XLSX</b> — {ko.report.downloadHelp.xlsx}
              </span>
              <span className="block">
                <b>{ko.report.downloadInsightsCsv}</b> — {ko.report.downloadHelp.insights}
              </span>
              {report.stair && (
                <span className="block">
                  <b>{ko.report.downloadStairsCsv}</b> — {ko.report.downloadHelp.stairs}
                </span>
              )}
            </HelpTip>
          </div>
        </div>
        {dlErr && (
          <Callout variant="error" role="alert" className="mb-4">
            다운로드 실패: {dlErr}
          </Callout>
        )}
        {/* spec §5.1: 유효성+해석 병합 → Verdict → Insight */}
        <ValidityBanner validity={report.validity} narrative={report.narrative} />
        <LoopRetryNotice views={loopExitViews} />
        {report.stair ? <StairResultSection stair={report.stair} /> : null}
        {report.verdict ? <VerdictPanel verdict={report.verdict} steps={stepMeta} /> : null}
        <InsightPanel insights={report.insights ?? []} meta={stepMeta} />
        <AppliedTimeouts profile={profile} hasStepTimeoutOverride={hasStepTimeoutOverride} />
        {showRampOnlyLine && (
          <p className="mb-2 text-sm text-slate-500">
            {ko.report.basis.rampOnlyLine(profile.ramp_up_seconds)}
          </p>
        )}
        <Summary
          summary={report.summary}
          dropped={report.dropped}
          dropBase={dropOther ? { count: dropOther.count } : undefined}
          wholeRunBadge={dropOther != null}
          openLoop={openLoopRates(
            report.run.profile,
            report.dropped,
            dropOther ? dropOther.duration_seconds : report.summary.duration_seconds,
            report.insights ?? [],
            report.basis,
          )}
        />
        {marks ? (
          <p className="text-sm text-slate-500">
            {ko.report.basis.chartLegend(
              marks.bands.some((b) => b.kind === "ramp"),
              marks.bands.some((b) => b.kind === "discard"),
            )}
          </p>
        ) : null}
        <TimeSeriesChart
          title={ko.report.timeSeriesRequests}
          yLabel="req/s"
          data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.count }))}
          marks={marks}
        />
        <TimeSeriesChart
          title={ko.report.timeSeriesP95}
          yLabel="ms"
          data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.p95_ms }))}
          marks={marks}
        />
        <TimeSeriesChart
          title={ko.report.timeSeriesErrors}
          yLabel="errors"
          data={seconds.map((s) => ({ ts_second: s.ts_second, value: s.errors }))}
          marks={marks}
        />
        {report.active_vu_series && report.active_vu_series.length > 0 ? (
          <ActiveVuChart
            series={report.active_vu_series}
            byWorker={report.active_vu_by_worker ?? []}
          />
        ) : null}
        <WorkerBreakdownTable breakdown={report.worker_breakdown ?? []} />
        {report.latency ? (
          <PageSection
            ariaLabel={ko.report.latencyTitle}
            title={ko.report.latencyTitle}
            className=""
          >
            <PercentileCurveChart curve={report.latency.percentile_curve} />
            <LatencyHistogramChart buckets={report.latency.histogram} />
          </PageSection>
        ) : null}
        <StatusDistribution distribution={report.status_distribution} />
        <ErrorKindTable kinds={report.error_kinds ?? []} wholeRunBadge={wholeRunBadge} />
        {report.connection && (
          <ConnectionCostCard stats={report.connection} wholeRunBadge={wholeRunBadge} />
        )}
        <StepPhaseBreakdown
          steps={report.steps}
          meta={stepMeta}
          retriedStepIds={retriedStepIds}
          wholeRunBadge={wholeRunBadge}
        />
        <LoopExitSummary views={loopExitViews} wholeRunBadge={wholeRunBadge} />
        <BranchStatsTable
          breakdown={report.if_breakdown ?? []}
          meta={ifMeta}
          wholeRunBadge={wholeRunBadge}
        />
        <LoopExitPanel views={loopExitViews} wholeRunBadge={wholeRunBadge} />
        <GroupLatencyTable
          breakdown={report.group_latency ?? []}
          meta={groupMeta}
          wholeRunBadge={wholeRunBadge}
        />
        <ScenarioSnapshot yaml={report.scenario_yaml} />
      </div>
    </div>
  );
}
