import { Link } from "react-router-dom";
import { useCloneScenario, useScenarios } from "../api/hooks";
import { Button } from "../components/Button";

export function ScenarioListPage() {
  const { data, isLoading, error } = useScenarios();
  const clone = useCloneScenario();

  function onClone(scenario: { yaml: string; name: string }) {
    const existingNames = data?.scenarios.map((s) => s.name) ?? [];
    clone.reset();
    clone.mutate({ sourceYaml: scenario.yaml, sourceName: scenario.name, existingNames });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Scenarios</h2>
        <Link to="/scenarios/new">
          <Button>New scenario</Button>
        </Link>
      </div>

      {isLoading && <p className="text-slate-500">Loading…</p>}
      {error && <p className="text-red-600">Failed to load: {(error as Error).message}</p>}
      {clone.error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          복제 실패: {(clone.error as Error).message}
        </p>
      )}

      {data && data.scenarios.length === 0 && (
        <p className="text-slate-500">No scenarios yet. Create one to get started.</p>
      )}

      {data && data.scenarios.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Version</th>
              <th className="py-2 pr-4 font-medium">Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.scenarios.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="py-3 pr-4 font-medium">
                  <Link to={`/scenarios/${s.id}`} className="hover:underline">
                    {s.name}
                  </Link>
                </td>
                <td className="py-3 pr-4 text-slate-600">v{s.version}</td>
                <td className="py-3 pr-4 text-slate-600">
                  {new Date(s.updated_at).toLocaleString()}
                </td>
                <td className="py-3 pr-4 text-right">
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => onClone(s)}
                      disabled={clone.isPending}
                      className="text-slate-700 hover:underline disabled:text-slate-400"
                    >
                      Duplicate
                    </button>
                    <Link to={`/scenarios/${s.id}/runs`} className="text-slate-700 hover:underline">
                      runs →
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
