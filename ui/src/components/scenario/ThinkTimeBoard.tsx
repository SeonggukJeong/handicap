import { useMemo } from "react";
import { Modal } from "../Modal";
import { Badge } from "../ui/Badge";
import { HelpTip } from "../HelpTip";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { buildThinkRows, type ThinkRow, type ThinkState } from "../../scenario/thinkTime";
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

function effectiveText(t: ThinkTime | undefined): string {
  return t === undefined ? ko.editor.thinkNoWait : ko.editor.thinkRange(t.min_ms, t.max_ms);
}

function defaultSummary(def: ThinkTime | undefined): string {
  if (def === undefined) return ko.editor.thinkBoardDefaultNone;
  if (def.min_ms === 0 && def.max_ms === 0) return ko.editor.thinkBoardDefaultZero;
  return ko.editor.thinkBoardDefaultSummary(def.min_ms, def.max_ms);
}

function BoardRow({ row }: { row: ThinkRow }) {
  return (
    <tr className="border-t border-slate-100">
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
      <td
        data-testid="effective"
        className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-600"
      >
        {effectiveText(row.effective)}
      </td>
    </tr>
  );
}

/** 스텝별 think-time 현황판(모달). 판정은 전부 `thinkTime.ts`가 소유한다 —
 *  이 컴포넌트는 표시만 한다. */
export function ThinkTimeBoard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const model = useScenarioEditor((s) => s.model);
  const rows = useMemo(() => (model ? buildThinkRows(model) : []), [model]);

  return (
    <Modal open={open} onClose={onClose} title={ko.editor.thinkBoardTitle}>
      <p data-testid="default-summary" className="mb-2 text-sm text-slate-600">
        {defaultSummary(model?.default_think_time)}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{ko.editor.thinkBoardEmpty}</p>
      ) : (
        <table aria-label={ko.editor.thinkBoardTableAria} className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold text-slate-500">
              <th className="px-2 py-1">{ko.editor.thinkBoardColStep}</th>
              <th className="w-32 px-2 py-1">{ko.editor.thinkBoardColState}</th>
              <th className="w-28 px-2 py-1 text-right">{ko.editor.thinkBoardColEffective}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <BoardRow key={r.stepId} row={r} />
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
