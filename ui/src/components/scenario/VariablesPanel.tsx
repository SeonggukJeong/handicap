import { useEffect, useMemo, useRef, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { VarCheatSheet } from "./VarCheatSheet";
import { VarUsagePopover } from "./VarUsagePopover";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Input } from "../ui/Input";
import { buildVarRows, type VarRow } from "../../scenario/varRows";
import {
  declSearchText,
  genParamsSummary,
  genTypeLabel,
  isGenSpec,
  type GenSpec,
} from "../../scenario/genVars";
import { GenSampleLine, GenVarEditor } from "./GenVarEditor";
import { DeleteVariableDialog } from "./DeleteVariableDialog";

type EditKey =
  | { kind: "flat"; name: string }
  | { kind: "parallel"; branchName: string; varName: string };

/** 미정의 행의 분기 미스코프 힌트 텍스트 — **후보가 있으면(≥1)** 뜬다(candidates=0이면 항상
 *  null=힌트 없음, 코드가 이 체크를 가장 먼저 함 — refKind==="sibling"도 예외 아님: 예를 들어
 *  parallel 분기 안 오탈자 bare 참조처럼 그 이름을 추출하는 분기가 실제로 하나도 없으면
 *  sibling+candidates:[]가 되어 힌트 없이 "선언 추가"만 보인다. 이 조합은 근접 오탈자만큼 흔히
 *  일어나는 **trivially reachable** 케이스이지 근접-불가능한 예외가 아니다 — 동작 자체는 맞다:
 *  진짜 미선언 변수는 "선언 추가"가 유일한 올바른 수정이라서다). candidates≥1일 때만: 형제 분기
 *  위반(refKind==="sibling")은 후보 개수와 무관하게 전용 문구 — 나머지(downstream)는 후보
 *  1개/2개+로 분기. */
function undefinedBranchHint(
  candidates: string[],
  refKind: "downstream" | "sibling",
  name: string,
): string | null {
  if (candidates.length === 0) return null;
  if (refKind === "sibling") return ko.editor.variableSiblingBranchHint;
  if (candidates.length === 1) return ko.editor.variableBranchCandidateHint(candidates[0], name);
  return ko.editor.variableBranchCandidatesHint(candidates, name);
}

/** 접힘 요약 줄의 배지 title(전문) — 파라미터가 없으면(uuid) 타입명 단독, 있으면
 *  "타입명 · 파라미터"(요약 줄 시각 표시와 동형, US5). */
function genRowTitle(spec: GenSpec): string {
  const params = genParamsSummary(spec);
  return params === "" ? genTypeLabel(spec) : `${genTypeLabel(spec)} · ${params}`;
}

export function VariablesPanel({ onJumpToStep }: { onJumpToStep?: (id: string) => void }) {
  // 셀렉터는 model 전체를 그대로 참조(스토어 필드 자체라 안정 참조) — 파생 행 분석은
  // 아래 useMemo([model])에서 1회만 수행하고, model===null이면 즉시 []를 반환한다
  // (getSnapshot 함정, ui/CLAUDE.md: 셀렉터 안 인라인 `?? {}` fallback 금지).
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const setVariable = useScenarioEditor((s) => s.setVariable);
  const setVariableGen = useScenarioEditor((s) => s.setVariableGen);
  const removeVariable = useScenarioEditor((s) => s.removeVariable);
  const renameVariable = useScenarioEditor((s) => s.renameVariable);
  const renameParallelVar = useScenarioEditor((s) => s.renameParallelVar);

  const [newKey, setNewKey] = useState("");
  const [query, setQuery] = useState("");
  // 펼침 상태(C안) — 컴포넌트 로컬, 영속화 비목표(B13 변수 접힘 선례). yamlError 동안에도
  // 활성(읽기 전용 크롬) — 안의 편집 어포던스만 GenVarEditor의 disabled prop으로 잠긴다.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const [editing, setEditing] = useState<EditKey | null>(null); // rename 중인 행 식별
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  // 예시 안정화(US2) — 변수명별 재추첨 틱. 검색/펼침/다른 변수 편집 같은 무관 재렌더에는
  // 안 바뀌고, GenVarEditor의 ↻(onSampleRefresh)로만 증가한다(genVars.samplePreview는
  // (name,spec,tick) 순수함수라 tick 불변=텍스트 불변).
  const [sampleTicks, setSampleTicks] = useState<Record<string, number>>({});
  // 사용처 팝오버 상태(한 번에 하나만 열림) — 앵커 엘리먼트를 들고 있어야
  // VarUsagePopover가 portal-fixed 위치를 계산한다(#3).
  const [usageNav, setUsageNav] = useState<{
    key: string;
    anchor: HTMLElement;
    refIds: string[];
  } | null>(null);

  // 사용중인 변수 삭제 확인(US1) — 열 때 refIds를 스냅샷으로 동결한다(행 객체를 들지 않음).
  const [pendingDelete, setPendingDelete] = useState<{ name: string; refIds: string[] } | null>(
    null,
  );
  // 확정 삭제일 때만 검색 입력으로 포커스를 옮기기 위한 1회성 플래그(Task 5에서 소비).
  // 취소는 Modal의 기본 복원(× 버튼)을 그대로 둬야 하므로 양 경로 공통 구현을 만들지 않는다.
  const refocusSearchRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const rows = useMemo<VarRow[]>(() => buildVarRows(model), [model]);

  // 확정 삭제로 × 가 언마운트되면 포커스가 <body>로 유실된다 → 검색 입력으로 옮긴다.
  // 플래그가 선 경우에만 돌므로 **취소 경로는 건드리지 않는다**(Modal이 × 로 복원).
  // React 18은 한 passive flush에서 unmount(Modal 복원)를 mount보다 먼저 돌리므로
  // 이 effect가 나중에 실행된다 — setTimeout/rAF 불필요.
  useEffect(() => {
    if (pendingDelete !== null || !refocusSearchRef.current) return;
    refocusSearchRef.current = false;
    searchRef.current?.focus();
  }, [pendingDelete]);

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
      return r.name.toLowerCase().includes(q) || declSearchText(r.value).toLowerCase().includes(q);
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
          ref={searchRef}
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
                {/* 밀집 행(토글+이름+연필+배지+×) — gap-x-1.5로 좁혀 배지 있는 이름에서 × 줄바꿈 여유 확보 */}
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(row.name)}
                    aria-expanded={expanded.has(row.name)}
                    aria-label={ko.editor.varExpandAria(row.name)}
                    className="-mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-base leading-none text-slate-400 hover:bg-slate-100 hover:text-accent-600"
                  >
                    <span aria-hidden="true">{expanded.has(row.name) ? "▾" : "▸"}</span>
                  </button>
                  {row.renamable ? (
                    nameCell(row.name)
                  ) : (
                    <span
                      className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                  )}
                  {/* ×는 한 묶음으로 wrap — 단독 줄바꿈 방지(타입 배지는 US5로 요약 줄 이동) */}
                  <span className="ml-auto flex shrink-0 items-center gap-x-2">
                    {row.overwritten && (
                      <span
                        className="shrink-0 rounded bg-amber-50 px-1.5 text-xs text-amber-700"
                        title={ko.editor.variableOverwrittenTitle}
                      >
                        {ko.editor.variableOverwritten}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (row.refIds.length === 0) {
                          removeVariable(row.name); // 미사용 — 현행 그대로 즉시 삭제(US3)
                          return;
                        }
                        setUsageNav(null); // 팝오버가 모달 뒤에 남지 않게(A1, 키보드 활성화 경로)
                        // 확정 경로만 이 플래그를 세운다 — 여는 시점에 반드시 내려서 이전 확정의
                        // 잔여 true가 다음 세션으로 새지 않게 한다(dangling-ref 가드).
                        refocusSearchRef.current = false;
                        setPendingDelete({ name: row.name, refIds: row.refIds });
                      }}
                      aria-label={ko.editor.removeVariableAria(row.name)}
                      disabled={yamlError !== null}
                      className="shrink-0 text-slate-500 hover:text-red-600 text-sm disabled:opacity-40"
                    >
                      ×
                    </button>
                  </span>
                </div>
                {expanded.has(row.name) ? (
                  <GenVarEditor
                    name={row.name}
                    value={row.value}
                    disabled={yamlError !== null}
                    sampleTick={sampleTicks[row.name] ?? 0}
                    onSampleRefresh={() =>
                      setSampleTicks((prev) => ({ ...prev, [row.name]: (prev[row.name] ?? 0) + 1 }))
                    }
                    onCommitGen={(spec) => setVariableGen(row.name, spec)}
                    onCommitStatic={(v) => setVariable(row.name, v)}
                  />
                ) : isGenSpec(row.value) ? (
                  <div className="flex min-w-0 flex-col gap-0.5 text-xs text-slate-500">
                    <div
                      className="flex min-w-0 items-center gap-x-1.5"
                      title={genRowTitle(row.value)}
                    >
                      <span className="shrink-0 rounded bg-indigo-50 px-1.5 text-xs text-indigo-600">
                        {genTypeLabel(row.value)}
                      </span>
                      {genParamsSummary(row.value) !== "" && (
                        <span className="min-w-0 truncate">{genParamsSummary(row.value)}</span>
                      )}
                    </div>
                    <GenSampleLine
                      spec={row.value}
                      name={row.name}
                      tick={sampleTicks[row.name] ?? 0}
                    />
                  </div>
                ) : (
                  <AutoGrowTextarea
                    aria-label={ko.editor.variableValueAria(row.name)}
                    className="font-mono"
                    value={row.value}
                    onChange={(e) => setVariable(row.name, e.target.value)}
                  />
                )}
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
          // undefined — candidates.length >= 1이면 parallel 분기 미스코프 힌트를 보여주고
          // "선언 추가"는 숨긴다(spec §2.4.1): 그 버튼은 variables[name]="" 로 ⚠를 지우고 run이
          // 빈 값을 성공적으로 보내게 만든다([[load-divergence-explain-confirm]] 조용한 부하 왜곡).
          // 형제 분기 위반(refKind==="sibling")은 후보 나열이 아니라 전용 문구.
          const hint = undefinedBranchHint(row.candidates, row.refKind, row.name);
          // 힌트 <span>과 이름 <span>의 programmatic 연결(nit 4) — SettingsPage의
          // `${prefix}-${key}` per-row 안정 id 관용구(useId 아님, 리스트 항목이라 key 파생).
          const hintId = `variable-undefined-hint-${row.name}`;
          return (
            <li key={`u:${row.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
                title={ko.editor.variableUndefinedAria(row.name)}
                aria-describedby={hint ? hintId : undefined}
              >
                {row.name}
              </span>
              <span className="shrink-0 text-xs text-amber-600">
                <span aria-hidden="true">⚠ </span>
                {ko.editor.variableUndefined}
              </span>
              {row.candidates.length === 0 && (
                <button
                  type="button"
                  aria-label={ko.editor.variableDeclareAddAria(row.name)}
                  disabled={yamlError !== null}
                  onClick={() => {
                    setUsageNav(null); // 행 u:→d: 전이로 anchor unmount — detached 팝오버 방지(R8)
                    setVariable(row.name, "");
                  }}
                  className="shrink-0 text-xs text-accent-600 hover:underline disabled:opacity-40"
                >
                  {ko.editor.variableDeclareAdd}
                </button>
              )}
              {usageCell(`u:${row.name}`, row.name, row.refIds)}
              {hint && (
                <span id={hintId} className="w-full shrink-0 text-xs text-slate-500">
                  {hint}
                </span>
              )}
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
          disabled={newKey.trim().length === 0 || yamlError !== null}
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
      {pendingDelete && model && (
        <DeleteVariableDialog
          open
          name={pendingDelete.name}
          refIds={pendingDelete.refIds}
          steps={model.steps}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            removeVariable(pendingDelete.name);
            setUsageNav(null); // 방어 전용 — R1 트리거가 이미 비웠고 모달 중엔 다시 열 경로가 없다
            refocusSearchRef.current = true;
            setPendingDelete(null);
          }}
        />
      )}
    </section>
  );
}
