import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../Modal";
import { Badge } from "../ui/Badge";
import { HelpTip } from "../HelpTip";
import { Input } from "../ui/Input";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import {
  buildThinkRows,
  formatThink,
  resolveThinkDraft,
  type ThinkRow,
  type ThinkState,
} from "../../scenario/thinkTime";
import { METHOD_BADGE } from "./methodBadge";
import type { ThinkTime } from "../../scenario/model";

const STATE_LABEL: Record<ThinkState, string> = {
  inherited: ko.editor.thinkStateInherited,
  inherited_none: ko.editor.thinkStateInheritedNone,
  override: ko.editor.thinkStateOverride,
  no_wait: ko.editor.thinkStateNoWait,
  parallel_unset: ko.editor.thinkStateParallelUnset,
};

const STATE_TONE: Record<ThinkState, "neutral" | "accent" | "optional" | "warn"> = {
  inherited: "neutral",
  inherited_none: "optional",
  override: "accent",
  no_wait: "optional",
  parallel_unset: "warn",
};

function defaultSummary(def: ThinkTime | undefined): string {
  if (def === undefined) return ko.editor.thinkBoardDefaultNone;
  if (def.min_ms === 0 && def.max_ms === 0) return ko.editor.thinkBoardDefaultZero;
  return ko.editor.thinkBoardDefaultSummary(def.min_ms, def.max_ms);
}

function BoardRow({
  row,
  selected,
  onToggle,
  disabled,
}: {
  row: ThinkRow;
  selected: boolean;
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const [minDraft, setMinDraft] = useState(row.configured ? String(row.configured.min_ms) : "");
  const [maxDraft, setMaxDraft] = useState(row.configured ? String(row.configured.max_ms) : "");

  // dep은 원시값이어야 한다. `row.configured`(객체)를 쓰면 buildThinkRows가 useMemo([model])라
  // 표 어디서든 한 번 커밋될 때마다 모든 행이 재시드되어, 다른 행에 반쯤 친 값이 사라진다.
  const cfgMin = row.configured?.min_ms;
  const cfgMax = row.configured?.max_ms;
  useEffect(() => {
    setMinDraft(cfgMin === undefined ? "" : String(cfgMin));
    setMaxDraft(cfgMax === undefined ? "" : String(cfgMax));
  }, [row.stepId, cfgMin, cfgMax]);

  // 4분기 커밋 규칙은 thinkTime.ts::resolveThinkDraft가 단일 소스(R3) — Inspector의
  // commitThinkTime과 규칙을 공유한다. 여기선 outcome에 따른 setState/store 호출만.
  const commit = () => {
    const outcome = resolveThinkDraft(minDraft, maxDraft);
    switch (outcome.kind) {
      case "clear":
        setStepField(row.stepId, ["think_time"], undefined);
        return;
      case "noop":
        return; // 미완성 쌍 — draft 보존
      case "commit":
        setStepField(row.stepId, ["think_time"], outcome.value);
        return;
      case "revert":
        setMinDraft(cfgMin === undefined ? "" : String(cfgMin));
        setMaxDraft(cfgMax === undefined ? "" : String(cfgMax));
        return;
    }
  };

  return (
    <tr className="border-t border-slate-100">
      <td className="w-8 px-2 py-1">
        <input
          type="checkbox"
          aria-label={ko.editor.thinkBoardSelectRowAria(row.name)}
          checked={selected}
          disabled={disabled}
          onChange={() => onToggle(row.stepId)}
        />
      </td>
      <td className="min-w-0 px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${
              METHOD_BADGE[row.method] ?? METHOD_BADGE.HEAD
            }`}
          >
            {row.method}
          </span>
          <span
            className="min-w-0 truncate"
            title={`${row.path ? `${row.path} / ` : ""}${row.name}`}
          >
            {row.path && (
              <span data-testid="step-path" className="text-slate-400">
                {row.path}
                {" / "}
              </span>
            )}
            <span data-testid="step-name">{row.name}</span>
          </span>
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-1">
        <span data-testid="state-badge" className="inline-flex items-center gap-1">
          <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
          {row.state === "parallel_unset" && (
            <HelpTip label={ko.editor.defaultThinkParallelHelpLabel}>
              {ko.editor.defaultThinkParallelHelp}
            </HelpTip>
          )}
        </span>
      </td>
      <td className="w-20 px-1 py-1">
        <Input
          numeric
          compact
          size="sm"
          type="number"
          min={0}
          max={600000}
          aria-label={ko.editor.thinkBoardRowMinAria}
          value={minDraft}
          disabled={disabled}
          onChange={(e) => setMinDraft(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="w-20 px-1 py-1">
        <Input
          numeric
          compact
          size="sm"
          type="number"
          min={0}
          max={600000}
          aria-label={ko.editor.thinkBoardRowMaxAria}
          value={maxDraft}
          disabled={disabled}
          onChange={(e) => setMaxDraft(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="w-8 px-1 py-1">
        {row.configured !== undefined && (
          <button
            type="button"
            aria-label={ko.editor.thinkBoardResetAria}
            disabled={disabled}
            onClick={() => setStepField(row.stepId, ["think_time"], undefined)}
            className="rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
          >
            ×
          </button>
        )}
      </td>
      <td
        data-testid="effective"
        className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-600"
      >
        {formatThink(row.effective)}
      </td>
    </tr>
  );
}

/** 스텝별 think-time 현황판(모달). 판정은 전부 `thinkTime.ts`가 소유한다 —
 *  이 컴포넌트는 표시·편집·일괄 액션 배선만 한다. */
export function ThinkTimeBoard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setStepsThinkTime = useScenarioEditor((s) => s.setStepsThinkTime);
  const rows = useMemo(() => (model ? buildThinkRows(model) : []), [model]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkMin, setBulkMin] = useState("");
  const [bulkMax, setBulkMax] = useState("");

  const disabled = yamlError !== null;
  const selectedIds = rows.filter((r) => selected.has(r.stepId)).map((r) => r.stepId);
  const allChecked = rows.length > 0 && selectedIds.length === rows.length;

  // 부분 선택은 indeterminate(R4) — DOM 프로퍼티라 JSX 속성으로는 못 준다.
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedIds.length > 0 && !allChecked;
    }
  }, [selectedIds.length, allChecked]);

  // 선택·일괄 입력은 모달을 닫으면 버린다(R4). ThinkTimeBoard 자신은 EditorShell이
  // 항상 마운트하므로(Modal만 null을 반환) 이 리셋이 없으면 재오픈 시 이전 선택이 살아 있다.
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setBulkMin("");
      setBulkMax("");
    }
  }, [open]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.stepId)),
    );

  // n = 분기 안이면서 현재 think_time이 있는 선택 행 수. 이미 parallel_unset인 행은
  // [상속으로]가 no-op이라 세지 않는다(안내가 안 바뀌는 행까지 세면 원칙이 무뎌진다).
  // 판정은 ThinkRow.insideParallel(thinkTime.ts 소유) — 경로 문자열로 유추 금지.
  const parallelWithValue = rows.filter(
    (r) => selected.has(r.stepId) && r.insideParallel && r.configured !== undefined,
  ).length;

  const mn = Number(bulkMin.trim());
  const mx = Number(bulkMax.trim());
  const bulkValid =
    bulkMin.trim() !== "" &&
    bulkMax.trim() !== "" &&
    Number.isInteger(mn) &&
    Number.isInteger(mx) &&
    mn >= 0 &&
    mx >= mn &&
    mx <= 600_000;

  const runBulk = (value: ThinkTime | undefined) => {
    setStepsThinkTime(selectedIds, value);
  };

  return (
    <Modal open={open} onClose={onClose} title={ko.editor.thinkBoardTitle}>
      <p data-testid="default-summary" className="mb-2 text-sm text-slate-600">
        {defaultSummary(model?.default_think_time)}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{ko.editor.thinkBoardEmpty}</p>
      ) : (
        <>
          <table aria-label={ko.editor.thinkBoardTableAria} className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-slate-500">
                <th className="w-8 px-2 py-1">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label={ko.editor.thinkBoardSelectAllAria}
                    checked={allChecked}
                    disabled={disabled}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-2 py-1">{ko.editor.thinkBoardColStep}</th>
                <th className="w-32 px-2 py-1">{ko.editor.thinkBoardColState}</th>
                <th className="w-20 px-1 py-1">{ko.editor.thinkBoardColMin}</th>
                <th className="w-20 px-1 py-1">{ko.editor.thinkBoardColMax}</th>
                <th className="w-8 px-1 py-1">
                  <span className="sr-only">{ko.editor.thinkBoardColReset}</span>
                </th>
                <th className="w-28 px-2 py-1 text-right">{ko.editor.thinkBoardColEffective}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <BoardRow
                  key={r.stepId}
                  row={r}
                  selected={selected.has(r.stepId)}
                  onToggle={toggle}
                  disabled={disabled}
                />
              ))}
            </tbody>
          </table>
          {selectedIds.length > 0 && (
            <div
              role="group"
              aria-label={ko.editor.thinkBoardBulkAria}
              className="mt-3 border-t border-slate-200 pt-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-slate-600">
                  {ko.editor.thinkBoardSelectedCount(selectedIds.length)}
                </span>
                <Input
                  numeric
                  compact
                  size="sm"
                  type="number"
                  min={0}
                  max={600000}
                  aria-label={ko.editor.thinkBoardBulkMinAria}
                  value={bulkMin}
                  disabled={disabled}
                  onChange={(e) => setBulkMin(e.target.value)}
                  className="w-20"
                />
                <span aria-hidden="true">–</span>
                <Input
                  numeric
                  compact
                  size="sm"
                  type="number"
                  min={0}
                  max={600000}
                  aria-label={ko.editor.thinkBoardBulkMaxAria}
                  value={bulkMax}
                  disabled={disabled}
                  onChange={(e) => setBulkMax(e.target.value)}
                  className="w-20"
                />
                <button
                  type="button"
                  disabled={disabled || !bulkValid}
                  onClick={() => runBulk({ min_ms: mn, max_ms: mx })}
                  className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
                >
                  {ko.editor.thinkBoardBulkApply}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => runBulk(undefined)}
                  className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
                >
                  {ko.editor.thinkBoardBulkInherit}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => runBulk({ min_ms: 0, max_ms: 0 })}
                  className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
                >
                  {ko.editor.thinkBoardBulkNoWait}
                </button>
              </div>
              {parallelWithValue > 0 && (
                <p role="status" className="mt-2 text-xs text-amber-700">
                  {ko.editor.thinkBoardParallelWarn(parallelWithValue)}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
