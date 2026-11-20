import { useState } from "react";
import { Link } from "react-router-dom";
import { useCloneScenario, useDeleteScenario, useScenarios } from "../api/hooks";
import type { Scenario } from "../api/schemas";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { OnboardingGuide } from "../components/OnboardingGuide";
import { Callout } from "../components/ui/Callout";
import { ko } from "../i18n/ko";
import { groupScenarios } from "../scenario/grouping";
import { loadCollapsedGroups, saveCollapsedGroups } from "../scenario/groupPrefs";

/** 열 머리·묶음 안·묶음 밖 모든 행이 쓰는 한 벌의 열 템플릿. */
const GRID = "grid grid-cols-[minmax(0,1fr)_4rem_13rem_13rem] items-center gap-x-4";
const COLUMN_COUNT = 4;
/** 묶음 상자 테두리(1px)만큼 안쪽으로 들여, 묶음 밖 행·열 머리의 구분선과 열 x 좌표를 묶음 안과 맞춘다. */
const OUTSIDE_INSET = "mx-px";

export function ScenarioListPage() {
  const { data, isLoading, error } = useScenarios();
  const clone = useCloneScenario();
  const del = useDeleteScenario();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsedGroups);
  const collapsedSet = new Set(collapsed);
  const grouped = groupScenarios(data?.scenarios ?? []);

  function toggleGroup(name: string) {
    const live = new Set(grouped.groups.map((g) => g.name));
    const next = collapsed.includes(name)
      ? collapsed.filter((n) => n !== name)
      : [...collapsed, name];
    const cleaned = next.filter((n) => live.has(n));
    setCollapsed(cleaned);
    saveCollapsedGroups(cleaned);
  }

  function onClone(scenario: { yaml: string; name: string; group: string | null }) {
    const existingNames = data?.scenarios.map((s) => s.name) ?? [];
    clone.reset();
    clone.mutate({
      sourceYaml: scenario.yaml,
      sourceName: scenario.name,
      existingNames,
      sourceGroup: scenario.group,
    });
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

  const renderRow = (s: Scenario, inBox: boolean, isLast: boolean) => (
    <div
      key={s.id}
      role="row"
      data-testid="scenario-row"
      className={`${GRID} px-3 py-3 ${inBox && isLast ? "" : "border-b border-slate-100"}`}
    >
      <div role="cell" className={`min-w-0 font-medium ${inBox ? "pl-5" : ""}`}>
        <Link to={`/scenarios/${s.id}`} title={s.name} className="block truncate hover:underline">
          {s.name}
        </Link>
      </div>
      <div role="cell" className="text-slate-600">
        v{s.version}
      </div>
      <div role="cell" className="whitespace-nowrap text-slate-600">
        {new Date(s.updated_at).toLocaleString()}
      </div>
      <div role="cell" className="flex justify-end gap-3">
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
    </div>
  );

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
        <div role="table" aria-label={ko.nav.scenarios} className="text-sm">
          <div
            role="row"
            data-testid="scenario-columns"
            className={`${GRID} ${OUTSIDE_INSET} border-b border-slate-200 px-3 py-2 text-left text-slate-600`}
          >
            <div role="columnheader" className="font-medium">
              {ko.pages.nameCol}
            </div>
            <div role="columnheader" className="font-medium">
              {ko.pages.versionCol}
            </div>
            <div role="columnheader" className="whitespace-nowrap font-medium">
              {ko.pages.updatedCol}
            </div>
            <div role="columnheader" />
          </div>
          {grouped.groups.map((g) => {
            const isCollapsed = collapsedSet.has(g.name);
            return (
              <div
                key={g.name}
                role="rowgroup"
                data-testid="scenario-group"
                data-group-name={g.name}
                className="mt-3 overflow-hidden rounded-lg border border-slate-300"
              >
                <div
                  role="row"
                  data-testid="scenario-group-header"
                  className="flex items-center gap-2 bg-slate-50 px-3 py-2"
                >
                  <div
                    role="cell"
                    aria-colspan={COLUMN_COUNT}
                    className="flex min-w-0 flex-1 items-center"
                  >
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      title={g.name}
                      onClick={() => toggleGroup(g.name)}
                      className="flex min-w-0 items-center gap-2 font-medium text-slate-800 hover:underline"
                    >
                      <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                      <span className="truncate">{g.name}</span>
                      <span className="shrink-0 text-slate-500">
                        {ko.scenarioGroups.groupCount(g.items.length)}
                      </span>
                    </button>
                  </div>
                </div>
                {!isCollapsed &&
                  g.items.map((s, i) => renderRow(s, true, i === g.items.length - 1))}
              </div>
            );
          })}
          {grouped.ungrouped.length > 0 && (
            <div
              role="rowgroup"
              data-testid="scenario-ungrouped"
              className={`${OUTSIDE_INSET} ${grouped.groups.length > 0 ? "mt-6" : ""}`}
            >
              {grouped.ungrouped.map((s) => renderRow(s, false, false))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
