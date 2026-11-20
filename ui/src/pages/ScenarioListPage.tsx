import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  useAssignScenarioGroup,
  useCloneScenario,
  useDeleteScenario,
  useRenameScenarioGroup,
  useScenarios,
} from "../api/hooks";
import type { Scenario } from "../api/schemas";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { OnboardingGuide } from "../components/OnboardingGuide";
import { GroupDialog } from "../components/scenario-groups/GroupDialog";
import { RenameGroupDialog } from "../components/scenario-groups/RenameGroupDialog";
import { SelectBox } from "../components/scenario-groups/SelectBox";
import { Callout } from "../components/ui/Callout";
import { Input } from "../components/ui/Input";
import { ko } from "../i18n/ko";
import { filterScenarios, groupNames, groupScenarios, MAX_ASSIGN } from "../scenario/grouping";
import { loadCollapsedGroups, saveCollapsedGroups } from "../scenario/groupPrefs";

/**
 * 열 정의의 단일 소스. Tailwind가 클래스를 찾을 수 있게 리터럴로 쓰고, 열 수·체크 칸 폭은 거기서 뽑는다.
 * 첫 열 = 체크 칸.
 */
const GRID_COLS = "grid-cols-[2rem_minmax(0,1fr)_4rem_13rem_13rem]";
const TRACKS = GRID_COLS.slice("grid-cols-[".length, -1).split("_");
const COLUMN_COUNT = TRACKS.length;
const CHECK_SLOT_STYLE = { width: TRACKS[0] };
/** 열 머리·묶음 안·묶음 밖 모든 행이 쓰는 한 벌의 열 템플릿. */
const GRID = `grid ${GRID_COLS} items-center gap-x-4`;
/** 묶음 상자 테두리(1px)만큼 안쪽으로 들여, 묶음 밖 행·열 머리의 구분선과 열 x 좌표를 묶음 안과 맞춘다. */
const OUTSIDE_INSET = "mx-px";

export function ScenarioListPage() {
  const { data, isLoading, error } = useScenarios();
  const clone = useCloneScenario();
  const del = useDeleteScenario();
  const assign = useAssignScenarioGroup();
  const rename = useRenameScenarioGroup();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsedGroups);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [assignOpen, setAssignOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  /** 이름을 바꾼 직후 새 목록이 오기 전까지의 옛·새 이름. 그 사이 옛 이름 상자도 접힌 채 두고 새 이름의 접힘이 정리에서 빠지지 않게 한다. */
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearchRef = useRef(false);
  const focusGroupRef = useRef<string | null>(null);

  const [seenData, setSeenData] = useState(data);
  if (data !== seenData) {
    setSeenData(data);
    if (data) {
      const live = new Set(data.scenarios.map((s) => s.id));
      setSelected((prev) => {
        const kept = [...prev].filter((id) => live.has(id));
        return kept.length === prev.size ? prev : new Set(kept);
      });
      if (renamed && !data.scenarios.some((s) => s.group === renamed.from)) {
        const oldName = renamed.from;
        setRenamed(null);
        setCollapsed((c) => c.filter((n) => n !== oldName));
      }
    }
  }

  useEffect(() => {
    if (focusSearchRef.current) {
      focusSearchRef.current = false;
      searchRef.current?.focus();
    }
    const target = focusGroupRef.current;
    if (target === null) return;
    const box = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[data-testid="scenario-group"]') ?? [],
    ).find((b) => b.dataset.groupName === target);
    const toggle = box?.querySelector<HTMLElement>("button[aria-expanded]");
    if (toggle) toggle.focus();
    if (toggle || renamed === null) focusGroupRef.current = null;
  });

  const all = data?.scenarios ?? [];
  const searching = query.trim() !== "";
  const visible = filterScenarios(all, query);
  const grouped = groupScenarios(visible);
  const collapsedSet = new Set(collapsed);
  const names = groupNames(all);
  const counts: Record<string, number> = {};
  for (const s of all) if (s.group) counts[s.group] = (counts[s.group] ?? 0) + 1;

  const selectedCount = selected.size;
  const tooMany = selectedCount > MAX_ASSIGN;
  const visibleSelected = visible.filter((s) => selected.has(s.id)).length;

  function setMany(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function toggleOne(id: string) {
    setMany([id], !selected.has(id));
  }

  function toggleMany(items: Scenario[]) {
    const ids = items.map((s) => s.id);
    setMany(ids, !ids.every((id) => selected.has(id)));
  }

  function toggleGroup(name: string) {
    if (searching) return;
    const live = new Set(renamed ? [...names, renamed.from, renamed.to] : names);
    const next = collapsed.includes(name)
      ? collapsed.filter((n) => n !== name)
      : [...collapsed, name];
    const cleaned = next.filter((n) => live.has(n));
    setCollapsed(cleaned);
    saveCollapsedGroups(cleaned.filter((n) => n !== renamed?.from));
  }

  function openAssign() {
    assign.reset();
    setAssignOpen(true);
  }

  function closeAssign() {
    assign.reset();
    setAssignOpen(false);
  }

  function submitAssign(group: string | null) {
    assign.mutate(
      { ids: [...selected], group },
      {
        onSuccess: () => {
          focusSearchRef.current = true;
          setAssignOpen(false);
          setSelected(new Set());
        },
      },
    );
  }

  function openRename(name: string) {
    rename.reset();
    setRenameTarget(name);
  }

  function closeRename() {
    rename.reset();
    setRenameTarget(null);
  }

  function submitRename(from: string, to: string) {
    rename.mutate(
      { from, to },
      {
        onSuccess: () => {
          const moved = collapsed.map((n) => (n === from ? to : n));
          const next = moved.filter((n, i) => moved.indexOf(n) === i);
          saveCollapsedGroups(next);
          setCollapsed(collapsed.includes(from) ? [...next, from] : next);
          setRenamed({ from, to });
          focusGroupRef.current = to;
          setRenameTarget(null);
        },
      },
    );
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
      <div role="cell">
        <SelectBox
          tall="row"
          label={ko.scenarioGroups.selectRow(s.name)}
          checked={selected.has(s.id)}
          onChange={() => toggleOne(s.id)}
        />
      </div>
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

  const hasScenarios = data !== undefined && data.scenarios.length > 0;

  return (
    <div ref={rootRef}>
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

      {hasScenarios && (
        <>
          <div className="mb-3">
            <Input
              ref={searchRef}
              type="search"
              aria-label={ko.scenarioGroups.searchPlaceholder}
              placeholder={ko.scenarioGroups.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="max-w-xs"
            />
          </div>
          <div
            data-testid="scenario-action-slot"
            className="mb-3 flex min-h-14 items-center text-sm"
          >
            {names.length === 0 && selectedCount === 0 && (
              <p className="text-slate-500">{ko.scenarioGroups.createHint}</p>
            )}
            <div
              data-testid="scenario-selection-band"
              data-selected={selectedCount > 0}
              className={
                selectedCount > 0
                  ? "flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-accent-200 bg-accent-50 px-3 py-1.5"
                  : "contents"
              }
            >
              <span role="status" className="font-medium text-slate-800">
                {selectedCount > 0 ? ko.scenarioGroups.selectedCount(selectedCount) : ""}
              </span>
              {selectedCount > 0 && (
                <>
                  <Button onClick={openAssign} disabled={tooMany || assignOpen}>
                    {ko.scenarioGroups.assign}
                  </Button>
                  <Button variant="secondary" onClick={() => setSelected(new Set())}>
                    {ko.scenarioGroups.clearSelection}
                  </Button>
                  {tooMany && <span className="text-red-600">{ko.scenarioGroups.tooMany}</span>}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {hasScenarios && visible.length === 0 && (
        <p className="text-slate-500">{ko.scenarioGroups.searchEmpty}</p>
      )}

      {hasScenarios && visible.length > 0 && (
        <div role="table" aria-label={ko.nav.scenarios} className="text-sm">
          <div
            role="row"
            data-testid="scenario-columns"
            className={`${GRID} ${OUTSIDE_INSET} border-b border-slate-200 px-3 py-2 text-left text-slate-600`}
          >
            <div role="columnheader">
              <SelectBox
                tall="head"
                label={ko.scenarioGroups.selectAll}
                checked={visibleSelected === visible.length}
                indeterminate={visibleSelected > 0}
                onChange={() => toggleMany(visible)}
              />
            </div>
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
            const isCollapsed = !searching && collapsedSet.has(g.name);
            const picked = g.items.filter((s) => selected.has(s.id)).length;
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
                  className="flex items-center bg-slate-50 px-3 py-2"
                >
                  <div
                    role="cell"
                    aria-colspan={COLUMN_COUNT}
                    className="flex min-w-0 flex-1 items-center gap-x-4"
                  >
                    <div className="shrink-0" style={CHECK_SLOT_STYLE}>
                      <SelectBox
                        tall="head"
                        label={ko.scenarioGroups.selectGroup(g.name)}
                        checked={picked === g.items.length}
                        indeterminate={picked > 0}
                        onChange={() => toggleMany(g.items)}
                      />
                    </div>
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      aria-disabled={searching ? true : undefined}
                      title={g.name}
                      onClick={() => toggleGroup(g.name)}
                      className={`flex min-w-0 items-center gap-2 font-medium text-slate-800 ${
                        searching ? "cursor-default" : "cursor-pointer hover:underline"
                      }`}
                    >
                      <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                      <span className="truncate">{g.name}</span>
                      <span className="shrink-0 text-slate-500">
                        {ko.scenarioGroups.groupCount(g.items.length)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={ko.scenarioGroups.renameGroupLabel(g.name)}
                      onClick={() => openRename(g.name)}
                      className="ml-auto shrink-0 text-slate-700 hover:underline"
                    >
                      {ko.scenarioGroups.rename}
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

      <GroupDialog
        open={assignOpen}
        title={ko.scenarioGroups.assign}
        text={ko.scenarioGroups.assignManyText(selectedCount)}
        initial={null}
        names={names}
        pending={assign.isPending}
        error={assign.error ? assign.error.message : null}
        onSubmit={submitAssign}
        onClose={closeAssign}
      />
      <RenameGroupDialog
        open={renameTarget !== null}
        name={renameTarget ?? ""}
        counts={counts}
        pending={rename.isPending}
        error={rename.error ? rename.error.message : null}
        onSubmit={(to) => {
          if (renameTarget !== null) submitRename(renameTarget, to);
        }}
        onClose={closeRename}
      />
    </div>
  );
}
