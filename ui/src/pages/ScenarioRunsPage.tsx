import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCreateRun, useScenario, useScenarioRuns } from "../api/hooks";
import { envValueToRecord, normalizeProfile, type RunPrefill } from "../api/runPrefill";
import { Button } from "../components/Button";
import { RunDialog } from "../components/RunDialog";
import { StatusBadge } from "../components/StatusBadge";
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
  }, [retryId, runs.data]);

  function openBlank() {
    createRun.reset();
    setPrefillState(null);
    setShowDialog(true);
  }

  if (scenario.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (scenario.error) return <p className="text-red-600">{(scenario.error as Error).message}</p>;
  if (!scenario.data) return <p className="text-slate-500">Not found.</p>;

  const scenarioChanged = !!prefillState && prefillState.runScenarioYaml !== scenario.data.yaml;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Runs · {scenario.data.name}</h2>
          <Link
            to={`/scenarios/${scenario.data.id}`}
            className="text-sm text-slate-600 hover:underline"
          >
            ← Edit scenario
          </Link>
        </div>
        {!showDialog && <Button onClick={openBlank}>Run scenario</Button>}
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

      {runs.isLoading && <p className="text-slate-500">Loading runs…</p>}
      {runs.data && runs.data.runs.length === 0 && <p className="text-slate-500">No runs yet.</p>}
      {runs.data && runs.data.runs.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">VUs</th>
              <th className="py-2 pr-4 font-medium">Duration</th>
              <th className="py-2 pr-4 font-medium">Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.data.runs.map((r) => {
              const normalised = normalizeProfile(r.profile);
              const env = envValueToRecord(r.env);
              return (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-3 pr-4">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="py-3 pr-4">{r.profile.vus}</td>
                  <td className="py-3 pr-4">{r.profile.duration_seconds}s</td>
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
      )}
    </div>
  );
}
