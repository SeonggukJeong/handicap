import { useId, useState } from "react";
import type { Condition, ConditionOp } from "../../api/monitors";
import { Button } from "../Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { ko } from "../../i18n/ko";
import {
  OPS_BY_SOURCE,
  conditionError,
  hasFlags,
  needsValue,
  normalizeCondition,
  targetLabel,
} from "../../monitor/conditions";

type Props = {
  initial: Condition;
  mode: "create" | "edit";
  volatileHint?: boolean;
  blockedReason?: string;
  onSubmit: (c: Condition) => void;
  onCancel: () => void;
};

/** Inline condition editor (plain JSX, NO <Modal>: it also renders inside the body-viewer
 *  modal, where a nested modal's ESC would close the outer one). Text color is explicit
 *  because the dark JSON-tree container would otherwise be inherited. */
export function ConditionRow({
  initial,
  mode,
  volatileHint,
  blockedReason,
  onSubmit,
  onCancel,
}: Props) {
  const k = ko.monitor;
  const uid = useId();
  const [draft, setDraft] = useState<Condition>(initial);
  const patch = (p: Partial<Condition>) => setDraft((d) => ({ ...d, ...p }));
  const error = conditionError(normalizeCondition(draft)) ?? blockedReason ?? null;
  const errId = `${uid}-err`;
  const editablePath = mode === "edit" && (draft.source === "body" || draft.source === "header");

  return (
    <div className="my-1 flex flex-wrap items-center gap-2 rounded bg-accent-50 px-2 py-1 font-sans text-xs text-slate-700">
      {editablePath ? (
        <div className="w-48">
          <Input
            aria-label={k.condPath}
            size="sm"
            value={draft.path}
            onChange={(e) => patch({ path: e.target.value })}
            className="font-mono"
          />
        </div>
      ) : (
        <span className="font-medium">{targetLabel(draft)}</span>
      )}
      <div className="w-36">
        <Select
          aria-label={k.condOp}
          size="sm"
          value={draft.op}
          onChange={(e) => patch({ op: e.target.value as ConditionOp })}
        >
          {OPS_BY_SOURCE[draft.source].map((op) => (
            <option key={op} value={op}>
              {k.condOpOptions[op]}
            </option>
          ))}
        </Select>
      </div>
      {needsValue(draft.op) && (
        <div className="w-40">
          <Input
            aria-label={k.condValue}
            size="sm"
            value={draft.value}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => patch({ value: e.target.value })}
          />
        </div>
      )}
      {hasFlags(draft.op) && (
        <>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={draft.ignore_case}
              onChange={(e) => patch({ ignore_case: e.target.checked })}
            />
            {k.condIgnoreCase}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={draft.trim}
              onChange={(e) => patch({ trim: e.target.checked })}
            />
            {k.condTrim}
          </label>
        </>
      )}
      <Button
        variant="secondary"
        type="button"
        disabled={error !== null}
        aria-describedby={error ? errId : undefined}
        onClick={() => onSubmit(normalizeCondition(draft))}
      >
        {mode === "create" ? k.condConfirm : k.condSave}
      </Button>
      <Button variant="secondary" type="button" onClick={onCancel}>
        {k.condCancel}
      </Button>
      {volatileHint && <p className="w-full text-slate-500">{k.condVolatileHint}</p>}
      {error && (
        <p id={errId} className="w-full text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
