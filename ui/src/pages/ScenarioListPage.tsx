import { useState } from "react";
import { Link } from "react-router-dom";
import { useCloneScenario, useDeleteScenario, useScenarios } from "../api/hooks";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { OnboardingGuide } from "../components/OnboardingGuide";
import { Callout } from "../components/ui/Callout";
import { ko } from "../i18n/ko";

export function ScenarioListPage() {
  const { data, isLoading, error } = useScenarios();
  const clone = useCloneScenario();
  const del = useDeleteScenario();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function onClone(scenario: { yaml: string; name: string }) {
    const existingNames = data?.scenarios.map((s) => s.name) ?? [];
    clone.reset();
    clone.mutate({ sourceYaml: scenario.yaml, sourceName: scenario.name, existingNames });
  }

  const onDelete = async (s: { id: string; name: string }) => {
    setDeleteError(null);
    if (!window.confirm(ko.pages.deleteConfirm(s.name))) return;
    try {
      const result = await del.mutateAsync({ id: s.id, force: false });
      if (result.deleted) return;
      const { runs, presets, schedules } = result.refs;
      if (!window.confirm(ko.pages.deleteCascadeConfirm(s.name, runs, presets, schedules))) return;
      await del.mutateAsync({ id: s.id, force: true });
    } catch (e) {
      setDeleteError((e as Error).message);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">{ko.nav.scenarios}</h2>
        <div className="flex items-center gap-2">
          <Link to="/scenarios/import">
            <Button variant="secondary">{ko.import.title}</Button>
          </Link>
          <Link to="/scenarios/new">
            <Button>{ko.pages.newScenario}</Button>
          </Link>
        </div>
      </div>

      {data && <OnboardingGuide firstScenarioId={data.scenarios[0]?.id ?? null} />}

      {isLoading && <p className="text-slate-500">{ko.common.loading}</p>}
      {error && (
        <Callout variant="error" className="mb-3">
          {ko.common.failedToLoad((error as Error).message)}
        </Callout>
      )}
      {clone.error && (
        <Callout variant="error" role="alert" className="mb-3">
          {ko.pages.cloneFailed((clone.error as Error).message)}
        </Callout>
      )}
      {deleteError && (
        <Callout variant="error" role="alert" className="mb-3">
          {ko.pages.deleteFailed(deleteError)}
        </Callout>
      )}

      {data && data.scenarios.length === 0 && (
        <EmptyState
          body={ko.empty.scenarios}
          action={
            <Link to="/scenarios/new" className="text-slate-700 underline hover:text-slate-900">
              {ko.empty.scenariosCta} →
            </Link>
          }
        />
      )}

      {data && data.scenarios.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">{ko.pages.nameCol}</th>
              <th className="py-2 pr-4 font-medium">{ko.pages.versionCol}</th>
              <th className="py-2 pr-4 font-medium">{ko.pages.updatedCol}</th>
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
                      {ko.pages.duplicate}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(s)}
                      disabled={del.isPending}
                      className="text-red-600 hover:underline disabled:text-slate-400"
                    >
                      {ko.pages.deleteBtn}
                    </button>
                    <Link to={`/scenarios/${s.id}/runs`} className="text-slate-700 hover:underline">
                      {ko.pages.runsLink}
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
