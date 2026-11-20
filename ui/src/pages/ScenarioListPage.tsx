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
 * 첫 열 = 체크 칸. 수정 열 13rem(208px): ko-KR `2026. 12. 31. 오후 12:59:59`가 macOS(14px)에서
 * 180.8px로 실측됨. Windows 글꼴에서는 재지 않았다.
 */
const GRID_COLS = "grid-cols-[1.75rem_minmax(0,1fr)_3.25rem_13rem_11rem]";
const TRACKS = GRID_COLS.slice("grid-cols-[".length, -1).split("_");
const COLUMN_COUNT = TRACKS.length;
const CHECK_SLOT_STYLE = { width: TRACKS[0] };
/** 열 머리·묶음 안·묶음 밖 모든 행이 쓰는 한 벌의 열 템플릿. */
const GRID = `grid ${GRID_COLS} items-center gap-x-2`;
/** 묶음 상자 테두리(1px)만큼 안쪽으로 들여, 묶음 밖 행·열 머리의 구분선과 열 x 좌표를 묶음 안과 맞춘다. */
const OUTSIDE_INSET = "mx-px";
/** 묶음 안 이름 칸 들여쓰기 = 머리의 삼각형(1em) + 간격(0.5rem) — 행 이름이 그룹 이름 글자와 같은 x에서 시작한다. */
const IN_BOX_NAME_INDENT = "pl-[1.375rem]";

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

  const searchRef = useRef<HTMLInputElement>(null);
  const toggleRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusSearchRef = useRef(false);
  const focusGroupRef = useRef<string | null>(null);

  const [seenData, setSeenData] = useState(data);
  if (data !== seenData) {
    setSeenData(data);
    if (data) {
      const live = new Set(data.scenarios.map((s) => s.id));
      const kept = [...selected].filter((id) => live.has(id));
      if (kept.length !== selected.size) {
        setSelected(new Set(kept));
        if (kept.length === 0) setAssignOpen(false);
      }
    }
  }

  // 적용 성공 뒤 한 번만: 그 렌더에서 대상이 없으면(다시 읽기 실패 등) 그대로 버린다.
  useEffect(() => {
    if (focusSearchRef.current) {
      focusSearchRef.current = false;
      searchRef.current?.focus();
    }
    const target = focusGroupRef.current;
    if (target !== null) {
      focusGroupRef.current = null;
      toggleRefs.current.get(target)?.focus();
    }
  });

  // 목록이 도착하면 이제 없는 그룹 이름을 접힘 기억에서 뺀다(빈 것을 본 뒤 같은 이름이 다시 생기면
  // 펼친 채 나온다). 그룹 변경 처리 중에 도착한 목록으로는 정리하지 않는다 — 이름 바꾸기는 성공 처리가
  // 옛 이름의 접힘을 새 이름으로 옮긴 뒤에 정리한다. 다시 읽기가 실패한 옛 목록으로도 정리하지 않는다.
  const listFailed = error != null;
  const groupChangeBusy = assign.isPending || rename.isPending;
  useEffect(() => {
    if (!data || listFailed || groupChangeBusy) return;
    const live = new Set(groupNames(data.scenarios));
    const kept = collapsed.filter((n) => live.has(n));
    if (kept.length === collapsed.length) return;
    setCollapsed(kept);
    saveCollapsedGroups(kept);
  }, [data, listFailed, groupChangeBusy, collapsed]);

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

  function storeCollapsed(next: string[]) {
    setCollapsed(next);
    saveCollapsedGroups(next);
  }

  function toggleGroup(name: string) {
    if (searching) return;
    storeCollapsed(
      collapsed.includes(name) ? collapsed.filter((n) => n !== name) : [...collapsed, name],
    );
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
        // 훅이 다시 읽기를 기다리므로 여기서는 새 목록이 이미 들어 있다.
        onSuccess: () => {
          const moved = collapsed.map((n) => (n === from ? to : n));
          storeCollapsed(moved.filter((n, i) => moved.indexOf(n) === i));
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
      className={`${GRID} px-3 py-2.5 ${inBox && isLast ? "" : "border-b border-slate-100"}`}
    >
      <div role="cell">
        <SelectBox
          tall="row"
          label={ko.scenarioGroups.selectRow(s.name)}
          checked={selected.has(s.id)}
          onChange={() => toggleOne(s.id)}
        />
      </div>
      <div role="cell" className={`min-w-0 font-medium ${inBox ? IN_BOX_NAME_INDENT : ""}`}>
        <Link to={`/scenarios/${s.id}`} title={s.name} className="block truncate hover:underline">
          {s.name}
        </Link>
      </div>
      <div role="cell" className="tabular-nums text-slate-500">
        v{s.version}
      </div>
      <div role="cell" className="whitespace-nowrap tabular-nums text-slate-500">
        {new Date(s.updated_at).toLocaleString()}
      </div>
      <div role="cell" className="flex justify-end gap-3 whitespace-nowrap">
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

      {hasScenarios && (
        <div className="rounded-[10px] border border-slate-200 bg-white p-5">
          <div
            data-testid="scenario-toolbar"
            className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2"
          >
            <div className="w-80 max-w-full shrink-0">
              <Input
                ref={searchRef}
                type="search"
                aria-label={ko.scenarioGroups.searchPlaceholder}
                placeholder={ko.scenarioGroups.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div
              data-testid="scenario-action-slot"
              className="flex min-h-[3.125rem] min-w-0 flex-1 basis-72 items-center text-sm"
            >
              {names.length === 0 && selectedCount === 0 && (
                <p className="text-slate-600">{ko.scenarioGroups.createHint}</p>
              )}
              <div
                data-testid="scenario-selection-band"
                data-selected={selectedCount > 0}
                className={
                  selectedCount > 0
                    ? "flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2"
                    : "contents"
                }
              >
                <span role="status" className="font-semibold text-slate-900">
                  {selectedCount > 0 ? ko.scenarioGroups.selectedCount(selectedCount) : ""}
                </span>
                {selectedCount > 0 && (
                  <>
                    <Button size="sm" onClick={openAssign} disabled={tooMany || assignOpen}>
                      {ko.scenarioGroups.assign}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="text-accent-600 hover:text-accent-700 hover:underline"
                    >
                      {ko.scenarioGroups.clearSelection}
                    </button>
                    {tooMany && <span className="text-red-600">{ko.scenarioGroups.tooMany}</span>}
                  </>
                )}
              </div>
            </div>
          </div>

          {visible.length === 0 && (
            <p className="px-3 py-4 text-slate-500">{ko.scenarioGroups.searchEmpty}</p>
          )}

          {visible.length > 0 && (
            <div role="table" aria-label={ko.nav.scenarios} className="text-sm">
              <div
                role="row"
                data-testid="scenario-columns"
                className={`${GRID} ${OUTSIDE_INSET} border-b border-slate-200 px-3 py-1.5 text-left text-slate-500`}
              >
                <div role="columnheader">
                  <SelectBox
                    tall="columns"
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
                    className="mt-2.5 overflow-hidden rounded-lg border border-slate-300"
                  >
                    <div
                      role="row"
                      data-testid="scenario-group-header"
                      className="flex items-center bg-slate-100 px-3 py-2"
                    >
                      <div
                        role="cell"
                        aria-colspan={COLUMN_COUNT}
                        className="flex min-w-0 flex-1 items-center gap-x-2"
                      >
                        <div className="shrink-0" style={CHECK_SLOT_STYLE}>
                          <SelectBox
                            tall="group"
                            label={ko.scenarioGroups.selectGroup(g.name)}
                            checked={picked === g.items.length}
                            indeterminate={picked > 0}
                            onChange={() => toggleMany(g.items)}
                          />
                        </div>
                        <button
                          ref={(el) => {
                            if (el) toggleRefs.current.set(g.name, el);
                            else toggleRefs.current.delete(g.name);
                          }}
                          type="button"
                          aria-expanded={!isCollapsed}
                          aria-disabled={searching ? true : undefined}
                          title={g.name}
                          onClick={() => toggleGroup(g.name)}
                          className={`flex min-w-0 items-center gap-2 py-0.5 text-left font-semibold text-slate-900 ${
                            searching ? "cursor-default" : "cursor-pointer hover:underline"
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className="inline-block w-[1em] shrink-0 text-center text-slate-500"
                          >
                            {isCollapsed ? "▸" : "▾"}
                          </span>
                          <span className="truncate">{g.name}</span>
                          <span className="shrink-0 font-normal text-slate-500">
                            {ko.scenarioGroups.groupCount(g.items.length)}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={ko.scenarioGroups.renameGroupLabel(g.name)}
                          onClick={() => openRename(g.name)}
                          className="ml-auto shrink-0 text-accent-600 hover:text-accent-700 hover:underline"
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
                  className={`${OUTSIDE_INSET} ${
                    grouped.groups.length > 0 ? "mt-[1.375rem] border-t border-slate-200" : ""
                  }`}
                >
                  {grouped.ungrouped.map((s) => renderRow(s, false, false))}
                </div>
              )}
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
