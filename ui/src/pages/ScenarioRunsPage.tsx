import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { downloadFile } from "../api/download";
import { useCreateRun, useScenario, useScenarioRuns } from "../api/hooks";
import { formatDurationKo } from "../i18n/duration";
import { useNow } from "../hooks/useNow";
import {
  envValueToRecord,
  normalizeProfile,
  profileDurationSeconds,
  type RunPrefill,
} from "../api/runPrefill";
import { Breadcrumb } from "../components/Breadcrumb";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { RunDialog } from "../components/RunDialog";
import { StatusBadge } from "../components/StatusBadge";
import { VerdictBadge } from "../components/VerdictBadge";
import { ko } from "../i18n/ko";
import { isLoopStep } from "../scenario/model";
import { parseScenarioDoc } from "../scenario/yamlDoc";

/** Snapshot we keep in state for the open prefill dialog. */
type PrefillState = {
  /** Stable key for RunDialog `key=` prop (prevents stale form on row change). */
  runId: string;
  /** The scenario YAML snapshot the run was executed against (drift check). */
  runScenarioYaml: string;
  /** Already-normalised profile + decoded env for RunDialog `initial=`. */
  prefill: RunPrefill;
};

export function ScenarioRunsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const scenario = useScenario(id);
  const runs = useScenarioRuns(id);
  const createRun = useCreateRun();
  const [showDialog, setShowDialog] = useState(false);
  const [prefillState, setPrefillState] = useState<PrefillState | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exportErr, setExportErr] = useState<string | null>(null);

  const hasRunning = runs.data?.runs.some((r) => r.status === "running") ?? false;
  const now = useNow(hasRunning ? 1000 : null);

  // Parse the scenario YAML once for both hasLoop + DataBindingPanel.
  // Parse failures fall back to null (no binding panel, no cap UI).
  const parsedScenario = useMemo(() => {
    const yaml = scenario.data?.yaml;
    if (!yaml) return null;
    const parsed = parseScenarioDoc(yaml);
    return "model" in parsed ? parsed.model : null;
  }, [scenario.data?.yaml]);

  const hasLoop = parsedScenario?.steps.some(isLoopStep) ?? false;

  // ?retry=<runId> deep-link: open the dialog prefilled from that run.
  // consumedRetry guards against re-opening when the runs list refetches
  // (createRun invalidates the query → refetch → effect re-fires with fresh
  // runs.data reference → would re-open a dialog the user just cancelled).
  const retryId = searchParams.get("retry");
  const consumedRetry = useRef<string | null>(null);
  useEffect(() => {
    if (!retryId || !runs.data) return;
    if (consumedRetry.current === retryId) return;
    const target = runs.data.runs.find((r) => r.id === retryId);
    if (target) {
      // Re-navigating to the same ?retry=<id> URL within this component's
      // lifetime will NOT re-open the dialog (the ref already consumed that id);
      // use the row's 다시 실행 button to re-open.
      consumedRetry.current = retryId;
      createRun.reset();
      setPrefillState({
        runId: target.id,
        runScenarioYaml: target.scenario_yaml,
        prefill: {
          profile: normalizeProfile(target.profile),
          env: envValueToRecord(target.env),
        },
      });
      setShowDialog(true);
    }
    // createRun is in deps for exhaustive-deps; the consumedRetry guard above
    // makes re-fires (from createRun's identity changing) a no-op per retryId.
  }, [retryId, runs.data, createRun]);

  function openBlank() {
    createRun.reset();
    setPrefillState(null);
    setShowDialog(true);
  }

  const isTerminal = (s: string) => ["completed", "failed", "aborted"].includes(s);

  function toggleSelect(runId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }

  if (scenario.isLoading) return <p className="text-slate-500">{ko.common.loading}</p>;
  if (scenario.error) return <p className="text-red-600">{(scenario.error as Error).message}</p>;
  if (!scenario.data) return <p className="text-slate-500">{ko.common.notFound}</p>;

  const scenarioChanged = !!prefillState && prefillState.runScenarioYaml !== scenario.data.yaml;

  return (
    <div>
      <Breadcrumb
        items={[
          { label: ko.nav.scenarios, to: "/" },
          { label: scenario.data.name, to: `/scenarios/${scenario.data.id}` },
          { label: ko.breadcrumb.runs },
        ]}
      />
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">
          {ko.pages.runsTitle} · {scenario.data.name}
        </h2>
        {!showDialog && <Button onClick={openBlank}>{ko.pages.runScenario}</Button>}
      </div>

      {showDialog && (
        <div className="mb-6">
          <RunDialog
            key={prefillState ? prefillState.runId : "new"}
            scenarioId={scenario.data.id}
            hasLoop={hasLoop}
            scenario={parsedScenario}
            initial={prefillState?.prefill}
            scenarioChangedWarning={scenarioChanged}
            onCreated={(runId) => {
              setShowDialog(false);
              setPrefillState(null);
              navigate(`/runs/${runId}`);
            }}
            onCancel={() => {
              setShowDialog(false);
              setPrefillState(null);
            }}
          />
        </div>
      )}

      {createRun.error && (
        <p
          role="alert"
          className="mb-4 p-2 rounded border border-red-200 bg-red-50 text-sm text-red-700"
        >
          재실행 실패: {(createRun.error as Error).message}
        </p>
      )}

      {runs.isLoading && <p className="text-slate-500">{ko.common.loadingRuns}</p>}
      {runs.data && runs.data.runs.length === 0 && (
        <EmptyState
          body={ko.empty.runs}
          action={
            !showDialog ? (
              <button
                type="button"
                onClick={openBlank}
                className="text-slate-700 underline hover:text-slate-900"
              >
                {ko.empty.runsCta} →
              </button>
            ) : undefined
          }
        />
      )}
      {runs.data &&
        runs.data.runs.length > 0 &&
        (() => {
          const allRuns = runs.data!.runs;
          const selected = allRuns.filter((r) => selectedIds.has(r.id));
          const n = selected.length;
          const baseline =
            n > 0
              ? selected.reduce((oldest, r) => (r.created_at < oldest.created_at ? r : oldest)).id
              : "";
          return (
            <>
              {n >= 1 && (
                <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                  {n > 50 ? (
                    <span className="text-red-600">최대 50개까지 선택할 수 있습니다.</span>
                  ) : n > 5 ? (
                    <>
                      <span className="text-slate-600">
                        화면에선 5개까지 비교됩니다. 전체는 Export로 보세요.
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          downloadFile(
                            api.compareXlsxUrl(
                              id!,
                              selected.map((r) => r.id),
                              baseline,
                            ),
                            "comparison.xlsx",
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                          ).catch((e) => setExportErr((e as Error).message))
                        }
                        className="rounded border border-slate-300 bg-white px-3 py-1 hover:bg-slate-50"
                      >
                        Export XLSX
                      </button>
                      <button
                        type="button"
                        disabled
                        className="rounded bg-slate-100 px-3 py-1 text-slate-400 disabled:opacity-50"
                      >
                        {`비교 (${n})`}
                      </button>
                    </>
                  ) : n >= 2 ? (
                    <button
                      type="button"
                      onClick={() =>
                        navigate(
                          `/scenarios/${id}/compare?runs=${selected.map((r) => r.id).join(",")}&baseline=${baseline}`,
                        )
                      }
                      className="rounded bg-indigo-600 px-3 py-1 text-white hover:bg-indigo-700"
                    >
                      {`비교 (${n})`}
                    </button>
                  ) : (
                    <span className="text-slate-500">비교하려면 2개 이상 선택</span>
                  )}
                  {exportErr && (
                    <span role="alert" className="text-red-600">
                      {exportErr}
                    </span>
                  )}
                </div>
              )}
              <table className="min-w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-600">
                  <tr>
                    <th className="py-2 pr-2 font-medium">비교</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">결과</th>
                    <th className="py-2 pr-4 font-medium">VUs</th>
                    <th className="py-2 pr-4 font-medium">Duration</th>
                    <th className="py-2 pr-4 font-medium">Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {allRuns.map((r) => {
                    const normalised = normalizeProfile(r.profile);
                    const env = envValueToRecord(r.env);
                    return (
                      <tr key={r.id} className="border-b border-slate-100">
                        <td className="py-3 pr-2">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(r.id)}
                            disabled={!isTerminal(r.status)}
                            onChange={() => toggleSelect(r.id)}
                            aria-label={`select run ${r.id}`}
                          />
                        </td>
                        <td className="py-3 pr-4">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="py-3 pr-4">
                          <VerdictBadge verdict={r.verdict} />
                        </td>
                        <td className="py-3 pr-4">{r.profile.vus}</td>
                        <td className="py-3 pr-4">
                          {profileDurationSeconds(r.profile)}s
                          {r.status === "running" && (
                            <span className="ml-1 text-xs text-slate-500">
                              ·{" "}
                              {ko.runDetail.elapsed(
                                formatDurationKo((now - (r.started_at ?? r.created_at)) / 1000),
                              )}
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-slate-600">
                          {new Date(r.created_at).toLocaleString()}
                        </td>
                        <td className="py-3 pr-4 text-right">
                          <div className="flex justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                createRun.reset();
                                setPrefillState({
                                  runId: r.id,
                                  runScenarioYaml: r.scenario_yaml,
                                  prefill: { profile: normalised, env },
                                });
                                setShowDialog(true);
                              }}
                              className="text-slate-700 hover:underline"
                            >
                              다시 실행
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                createRun.mutate(
                                  {
                                    scenarioId: r.scenario_id,
                                    profile: normalised,
                                    env,
                                  },
                                  { onSuccess: (created) => navigate(`/runs/${created.id}`) },
                                );
                              }}
                              disabled={createRun.isPending}
                              className="text-slate-700 hover:underline disabled:opacity-50"
                            >
                              즉시 재실행
                            </button>
                            <Link to={`/runs/${r.id}`} className="text-slate-700 hover:underline">
                              view →
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          );
        })()}
    </div>
  );
}
