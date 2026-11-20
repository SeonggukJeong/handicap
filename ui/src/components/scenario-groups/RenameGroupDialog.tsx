import { useEffect, useId, useRef, useState } from "react";
import { ko } from "../../i18n/ko";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { validateGroupName } from "../../scenario/grouping";
import { GroupField } from "./GroupField";

export function RenameGroupDialog({
  open,
  name,
  counts,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  name: string;
  counts: Record<string, number>;
  pending?: boolean;
  error?: string | null;
  onSubmit: (to: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(open ? name : "");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(name);
  }
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // 자식 Modal의 effect가 먼저 돈 뒤 — 지금 이름을 통째로 골라 바로 덮어쓸 수 있게.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  const check = validateGroupName(draft);
  const target = check.ok ? check.value : null;
  const merges = target != null && target !== name && Object.hasOwn(counts, target);
  const canSubmit = target != null && target !== name && !pending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={ko.scenarioGroups.renameTitle}
      size="sm"
      dismissible={!pending}
    >
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(target);
        }}
      >
        <p className="mb-3 text-sm text-slate-600">{ko.scenarioGroups.renameText(name)}</p>
        <GroupField
          id={fieldId}
          value={draft}
          onChange={setDraft}
          names={Object.keys(counts).filter((n) => n !== name)}
          placeholder=""
          inputRef={inputRef}
          failure={error}
          note={merges ? ko.scenarioGroups.mergeHint(counts[name] ?? 0, counts[target]) : null}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {ko.common.cancel}
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {merges ? ko.scenarioGroups.mergeOk : ko.scenarioGroups.renameOk}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
