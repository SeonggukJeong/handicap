import { useMemo, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { VarCheatSheet } from "./VarCheatSheet";
import { VarUsagePopover } from "./VarUsagePopover";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Input } from "../ui/Input";
import {
  collectProducedVars,
  parallelExtractNames,
  buildVarRefIndex,
  undefinedVars,
  parallelVarIdentities,
} from "../../scenario/scanVars";

type VarRow =
  | { kind: "declared"; name: string; value: string; renamable: boolean; refIds: string[] }
  | { kind: "flat-extract"; name: string; refIds: string[] }
  | {
      kind: "parallel-extract";
      branchName: string;
      varName: string;
      display: string;
      isShadow: boolean;
      refIds: string[];
    }
  | { kind: "undefined"; name: string; refIds: string[] };

type EditKey =
  | { kind: "flat"; name: string }
  | { kind: "parallel"; branchName: string; varName: string };

export function VariablesPanel({ onJumpToStep }: { onJumpToStep?: (id: string) => void }) {
  // 셀렉터는 model 전체를 그대로 참조(스토어 필드 자체라 안정 참조) — 파생 행 분석은
  // 아래 useMemo([model])에서 1회만 수행하고, model===null이면 즉시 []를 반환한다
  // (getSnapshot 함정, ui/CLAUDE.md: 셀렉터 안 인라인 `?? {}` fallback 금지).
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const setVariable = useScenarioEditor((s) => s.setVariable);
  const removeVariable = useScenarioEditor((s) => s.removeVariable);
  const renameVariable = useScenarioEditor((s) => s.renameVariable);
  const renameParallelVar = useScenarioEditor((s) => s.renameParallelVar);

  const [newKey, setNewKey] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditKey | null>(null); // rename 중인 행 식별
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  // 사용처 팝오버 상태(한 번에 하나만 열림) — 앵커 엘리먼트를 들고 있어야
  // VarUsagePopover가 portal-fixed 위치를 계산한다(#3).
  const [usageNav, setUsageNav] = useState<{
    key: string;
    anchor: HTMLElement;
    refIds: string[];
  } | null>(null);

  const rows = useMemo<VarRow[]>(() => {
    if (!model) return [];
    const declaredKeys = new Set(Object.keys(model.variables));
    const produced = collectProducedVars(model);
    const parallelNames = parallelExtractNames(model);
    const refIndex = buildVarRefIndex(model);
    const undef = undefinedVars(model);
    const out: VarRow[] = [];
    // 선언(연필은 flat non-shadow일 때만)
    for (const [name, value] of Object.entries(model.variables))
      out.push({
        kind: "declared",
        name,
        value,
        renamable: !parallelNames.has(name),
        refIds: refIndex.get(name) ?? [],
      });
    // flat-extract = produced − 선언 − parallel(shadow) — 비-parallel 스텝에서만 추출된 이름
    for (const name of produced)
      if (!declaredKeys.has(name) && !parallelNames.has(name))
        out.push({ kind: "flat-extract", name, refIds: refIndex.get(name) ?? [] });
    // parallel-extract(구조적 identity — non-shadow는 분기-내부∪다운스트림 refIds)
    for (const id of parallelVarIdentities(model)) {
      const refIds = id.isShadow
        ? id.namespacedRefIds
        : [...new Set([...id.branchRefIds, ...id.namespacedRefIds])];
      out.push({
        kind: "parallel-extract",
        branchName: id.branchName,
        varName: id.varName,
        display: id.display,
        isShadow: id.isShadow,
        refIds,
      });
    }
    // 미정의
    for (const name of undef)
      out.push({ kind: "undefined", name, refIds: refIndex.get(name) ?? [] });
    return out;
  }, [model]);

  const startRename = (name: string) => {
    setEditing({ kind: "flat", name });
    setDraft(name);
    setRenameError(null);
  };
  const startRenameParallel = (branchName: string, varName: string) => {
    setEditing({ kind: "parallel", branchName, varName });
    setDraft(varName);
    setRenameError(null);
  };
  const cancelRename = () => {
    setEditing(null);
    setRenameError(null);
  };
  const commitRename = (oldName: string) => {
    const nn = draft.trim();
    if (nn === "" || nn === oldName) return cancelRename(); // 변경 없음
    const err = renameVariable(oldName, nn); // store가 검증 단일소스 — 실패 시 no-op + 코드
    if (err === "collision") return setRenameError(ko.editor.variableRenameCollision(nn));
    if (err !== null) return setRenameError(ko.editor.variableRenameInvalid);
    cancelRename();
  };
  const commitRenameParallel = (branchName: string, oldVar: string) => {
    const nv = draft.trim();
    if (nv === "" || nv === oldVar) return cancelRename();
    const err = renameParallelVar(branchName, oldVar, nv);
    if (err === "collision") return setRenameError(ko.editor.variableRenameCollision(nv));
    if (err !== null) return setRenameError(ko.editor.variableRenameInvalid);
    cancelRename();
  };

  // 사용 카운트 렌더(버튼 vs "미사용") — 버튼 클릭이 사용처 팝오버를 토글(#3).
  const usageCell = (cycleKey: string, ariaName: string, refIds: string[]) =>
    refIds.length === 0 ? (
      <span className="text-xs text-slate-400">{ko.editor.variableUnused}</span>
    ) : (
      <button
        type="button"
        aria-label={ko.editor.variableUsageNavAria(ariaName)}
        aria-expanded={usageNav?.key === cycleKey}
        onClick={(e) => {
          const anchor = e.currentTarget;
          setUsageNav((prev) =>
            prev?.key === cycleKey ? null : { key: cycleKey, anchor, refIds },
          );
        }}
        className="text-left text-xs text-accent-600 hover:underline"
      >
        {ko.editor.variableUsage(refIds.length)}
      </button>
    );

  // rename 어퍼던스(연필 or 인라인 draft input) — declared/flat 공통
  const nameCell = (name: string) =>
    editing?.kind === "flat" && editing.name === name ? (
      <div className="flex-1 min-w-[72px]">
        <Input
          size="sm"
          autoFocus
          aria-label={ko.editor.variableRenameInputAria(name)}
          className="min-w-0 font-mono"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setRenameError(null);
          }}
          onBlur={() => commitRename(name)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(name);
            else if (e.key === "Escape") cancelRename();
          }}
        />
        {renameError && <p className="mt-0.5 text-xs text-red-600">{renameError}</p>}
      </div>
    ) : (
      <>
        <span
          className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
          title={name}
        >
          {name}
        </span>
        <button
          type="button"
          aria-label={ko.editor.renameVariableAria(name)}
          disabled={yamlError !== null}
          onClick={() => startRename(name)}
          className="shrink-0 text-slate-400 hover:text-accent-600 text-xs disabled:opacity-40"
        >
          <span aria-hidden="true">✎</span>
        </button>
      </>
    );

  const q = query.trim().toLowerCase();
  const matchesRow = (r: VarRow): boolean => {
    if (q === "") return true;
    if (r.kind === "declared")
      return r.name.toLowerCase().includes(q) || r.value.toLowerCase().includes(q);
    if (r.kind === "parallel-extract") return r.display.toLowerCase().includes(q);
    return r.name.toLowerCase().includes(q); // flat-extract, undefined
  };
  const visibleRows = rows.filter(matchesRow);

  return (
    <section aria-label={ko.editor.variablesTitle} className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0 flex flex-col gap-1">
        <div className="flex items-center">
          <h3 className="text-sm font-semibold text-slate-700">{ko.editor.variablesTitle}</h3>
          <VarCheatSheet />
        </div>
        <Input
          className="mt-1"
          placeholder={ko.editor.varSearchPlaceholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setUsageNav(null); // 검색으로 앵커 행이 필터링되면 detached-anchor 팝오버 방지
          }}
        />
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-1.5">
        {visibleRows.map((row) => {
          if (row.kind === "declared") {
            return (
              <li key={`d:${row.name}`} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  {row.renamable ? (
                    nameCell(row.name)
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeVariable(row.name)}
                    aria-label={ko.editor.removeVariableAria(row.name)}
                    className="shrink-0 text-slate-500 hover:text-red-600 text-sm"
                  >
                    ×
                  </button>
                </div>
                <AutoGrowTextarea
                  aria-label={ko.editor.variableValueAria(row.name)}
                  className="font-mono"
                  value={row.value}
                  onChange={(e) => setVariable(row.name, e.target.value)}
                />
                {usageCell(`d:${row.name}`, row.name, row.refIds)}
              </li>
            );
          }
          if (row.kind === "flat-extract") {
            return (
              <li key={`f:${row.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {nameCell(row.name)}
                <span className="shrink-0 text-xs text-slate-400">
                  {ko.editor.variableExtracted}
                </span>
                {usageCell(`f:${row.name}`, row.name, row.refIds)}
              </li>
            );
          }
          if (row.kind === "parallel-extract") {
            const isEditing =
              editing?.kind === "parallel" &&
              editing.branchName === row.branchName &&
              editing.varName === row.varName;
            return (
              <li key={`p:${row.display}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="shrink-0 font-mono text-xs text-slate-400">{row.branchName}.</span>
                {row.isShadow ? (
                  <span
                    className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
                    title={row.display}
                  >
                    {row.varName}
                  </span>
                ) : isEditing ? (
                  <div className="flex-1 min-w-[72px]">
                    <Input
                      size="sm"
                      autoFocus
                      aria-label={ko.editor.variableRenameInputAria(row.display)}
                      className="min-w-0 font-mono"
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setRenameError(null);
                      }}
                      onBlur={() => commitRenameParallel(row.branchName, row.varName)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRenameParallel(row.branchName, row.varName);
                        else if (e.key === "Escape") cancelRename();
                      }}
                    />
                    {renameError && <p className="mt-0.5 text-xs text-red-600">{renameError}</p>}
                  </div>
                ) : (
                  <>
                    <span
                      className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
                      title={row.display}
                    >
                      {row.varName}
                    </span>
                    <button
                      type="button"
                      aria-label={ko.editor.renameVariableAria(row.display)}
                      disabled={yamlError !== null}
                      onClick={() => startRenameParallel(row.branchName, row.varName)}
                      className="shrink-0 text-slate-400 hover:text-accent-600 text-xs disabled:opacity-40"
                    >
                      <span aria-hidden="true">✎</span>
                    </button>
                  </>
                )}
                <span
                  className="shrink-0 rounded bg-slate-100 px-1.5 text-xs text-slate-500"
                  title={
                    row.isShadow
                      ? ko.editor.variableBranchShadowTitle
                      : ko.editor.variableBranchInfoTitle
                  }
                >
                  {ko.editor.variableBranch}
                </span>
                {usageCell(`p:${row.display}`, row.display, row.refIds)}
              </li>
            );
          }
          // undefined
          return (
            <li key={`u:${row.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
                title={ko.editor.variableUndefinedAria(row.name)}
              >
                {row.name}
              </span>
              <span className="shrink-0 text-xs text-amber-600">
                <span aria-hidden="true">⚠ </span>
                {ko.editor.variableUndefined}
              </span>
              {usageCell(`u:${row.name}`, row.name, row.refIds)}
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.editor.variablesEmpty}</li>
        )}
        {rows.length > 0 && visibleRows.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.editor.varSearchEmpty}</li>
        )}
      </ul>

      <div className="flex shrink-0 gap-2">
        <div className="flex-1 min-w-0">
          <Input
            className="min-w-0 font-mono"
            placeholder="new_var"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            const k = newKey.trim();
            if (!k) return;
            setVariable(k, "");
            setNewKey("");
            setQuery("");
          }}
          disabled={newKey.trim().length === 0}
          className="shrink-0 px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
        >
          {ko.editor.variablesAdd}
        </button>
      </div>
      {usageNav && model && (
        <VarUsagePopover
          anchor={usageNav.anchor}
          refIds={usageNav.refIds}
          steps={model.steps}
          selectedStepId={selectedStepId}
          onJump={(id) => onJumpToStep?.(id)}
          onClose={() => setUsageNav(null)}
        />
      )}
    </section>
  );
}
