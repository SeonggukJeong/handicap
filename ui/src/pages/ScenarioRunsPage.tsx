import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScenario, useScenarioRuns } from "../api/hooks";
import { Button } from "../components/Button";
import { RunDialog } from "../components/RunDialog";
import { StatusBadge } from "../components/StatusBadge";
import { parseScenarioDoc } from "../scenario/yamlDoc";
import { isLoopStep } from "../scenario/model";

export function ScenarioRunsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const scenario = useScenario(id);
  const runs = useScenarioRuns(id);
  const [showDialog, setShowDialog] = useState(false);

  // Whether the scenario has a loop step — drives the loop-breakdown cap control
  // in the run dialog. Parse failures fall back to false (no loop → no cap UI).
  const hasLoop = useMemo(() => {
    const yaml = scenario.data?.yaml;
    if (!yaml) return false;
    const parsed = parseScenarioDoc(yaml);
    return "model" in parsed && parsed.model.steps.some(isLoopStep);
  }, [scenario.data?.yaml]);

  if (scenario.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (scenario.error) return <p className="text-red-600">{(scenario.error as Error).message}</p>;
  if (!scenario.data) return <p className="text-slate-500">Not found.</p>;

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
        {!showDialog && <Button onClick={() => setShowDialog(true)}>Run scenario</Button>}
      </div>

      {showDialog && (
        <div className="mb-6">
          <RunDialog
            scenarioId={scenario.data.id}
            hasLoop={hasLoop}
            onCreated={(runId) => {
              setShowDialog(false);
              navigate(`/runs/${runId}`);
            }}
            onCancel={() => setShowDialog(false)}
          />
        </div>
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
            {runs.data.runs.map((r) => (
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
                  <Link to={`/runs/${r.id}`} className="text-slate-700 hover:underline">
                    view →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
