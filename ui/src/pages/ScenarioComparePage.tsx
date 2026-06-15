import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useReports, useScenario } from "../api/hooks";
import { api } from "../api/client";
import { downloadFile } from "../api/download";
import { compareReports } from "../compare/compareReports";
import { Breadcrumb, type Crumb } from "../components/Breadcrumb";
import { CompareMatrix } from "../components/compare/CompareMatrix";
import { ko } from "../i18n/ko";
import { parseScenarioDoc } from "../scenario/yamlDoc";
import { flattenHttpSteps } from "../scenario/model";
import type { Report } from "../api/schemas";

export function ScenarioComparePage() {
  const { id: scenarioId } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const [err, setErr] = useState<string | null>(null);

  const runIds = useMemo(
    () =>
      (params.get("runs") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [params],
  );

  const baseline = params.get("baseline") ?? runIds[0] ?? "";

  const results = useReports(runIds);
  const scenario = useScenario(scenarioId);

  const crumbs: Crumb[] = [
    { label: ko.nav.scenarios, to: "/" },
    {
      label: scenario.data?.name ?? scenarioId?.slice(0, 8) ?? "",
      to: `/scenarios/${scenarioId}`,
    },
    { label: ko.breadcrumb.runs, to: `/scenarios/${scenarioId}/runs` },
    { label: ko.breadcrumb.compare },
  ];

  if (runIds.length < 2) {
    return (
      <div className="p-6">
        <Breadcrumb items={crumbs} />
        <p className="text-slate-600">비교하려면 런을 2개 이상 선택하세요</p>
      </div>
    );
  }

  const isLoading = results.some((r) => r.isLoading);
  const isError = results.some((r) => r.isError);

  if (isLoading) {
    return (
      <div className="p-6">
        <Breadcrumb items={crumbs} />
        <p role="status" className="text-slate-600">
          비교할 런 리포트를 불러오는 중…
        </p>
      </div>
    );
  }

  if (isError) {
    const errorResult = results.find((r) => r.isError);
    const msg = errorResult?.error instanceof Error ? errorResult.error.message : "알 수 없는 오류";
    return (
      <div className="p-6">
        <Breadcrumb items={crumbs} />
        <p role="alert" className="text-red-600">
          리포트 로드 실패: {msg}
        </p>
      </div>
    );
  }

  const reports = results.map((r) => r.data as Report);

  return (
    <ScenarioCompareInner
      scenarioId={scenarioId!}
      runIds={runIds}
      baseline={baseline}
      reports={reports}
      crumbs={crumbs}
      err={err}
      setErr={setErr}
      onBaselineChange={(rid) => setParams({ runs: runIds.join(","), baseline: rid })}
    />
  );
}

type InnerProps = {
  scenarioId: string;
  runIds: string[];
  baseline: string;
  reports: Report[];
  crumbs: Crumb[];
  err: string | null;
  setErr: (e: string | null) => void;
  onBaselineChange: (rid: string) => void;
};

function ScenarioCompareInner({
  scenarioId,
  runIds,
  baseline,
  reports,
  crumbs,
  err,
  setErr,
  onBaselineChange,
}: InnerProps) {
  const result = useMemo(() => compareReports(reports, baseline), [reports, baseline]);

  // Build step label map from baseline scenario_yaml
  const stepLabelMap = useMemo(() => {
    const m = new Map<string, string>();
    const baselineReport = reports.find((r) => r.run.id === baseline) ?? reports[0];
    const parsed = parseScenarioDoc(baselineReport.scenario_yaml);
    if ("model" in parsed) {
      for (const s of flattenHttpSteps(parsed.model.steps)) {
        const label = s.name?.trim() ? s.name.trim() : `${s.request.method} ${s.request.url}`;
        m.set(s.id, label);
      }
    }
    return m;
  }, [reports, baseline]);

  // Apply friendly labels to step rows
  const labeledResult = useMemo(
    () => ({
      ...result,
      steps: result.steps.map((row) => ({
        ...row,
        label: stepLabelMap.get(row.label) ?? row.label,
      })),
    }),
    [result, stepLabelMap],
  );

  // Run column labels: short human id
  const runLabels = useMemo<Record<string, string>>(() => {
    const labels: Record<string, string> = {};
    for (const id of runIds) {
      labels[id] = `#${id.slice(-6)}`;
    }
    return labels;
  }, [runIds]);

  const handleExportCsv = () => {
    downloadFile(
      api.compareCsvUrl(scenarioId, runIds, baseline),
      "comparison.csv",
      "text/csv",
    ).catch((e) => setErr((e as Error).message));
  };

  const handleExportXlsx = () => {
    downloadFile(
      api.compareXlsxUrl(scenarioId, runIds, baseline),
      "comparison.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ).catch((e) => setErr((e as Error).message));
  };

  const handleExportInsightsCsv = () => {
    downloadFile(
      api.compareInsightsCsvUrl(scenarioId, runIds, baseline),
      "comparison-insights.csv",
      "text/csv",
    ).catch((e) => setErr((e as Error).message));
  };

  return (
    <div className="p-6 max-w-6xl">
      <Breadcrumb items={crumbs} />
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">런 비교</h2>
          <span className="text-sm text-slate-500">{runIds.length}개 런</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleExportCsv}
            className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={handleExportXlsx}
            className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Export XLSX
          </button>
          <button
            type="button"
            onClick={handleExportInsightsCsv}
            className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Export 인사이트 CSV
          </button>
        </div>
      </div>

      {/* Error banner for export failures */}
      {err && (
        <div
          role="alert"
          className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2"
        >
          내보내기 실패: {err}
          <button
            type="button"
            onClick={() => setErr(null)}
            className="ml-2 underline text-red-600"
          >
            닫기
          </button>
        </div>
      )}

      <CompareMatrix
        result={labeledResult}
        labels={runLabels}
        onBaselineChange={onBaselineChange}
      />
    </div>
  );
}
