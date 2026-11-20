import { useEffect, useState } from "react";
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
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (open) setDraft("");
  }, [open, name]);

  const check = validateGroupName(draft);
  const target = check.ok ? check.value : null;
  const merges = target != null && target !== name && target in counts;
  const canSubmit = target != null && target !== name && !pending;

  return (
    <Modal open={open} onClose={onClose} title={ko.scenarioGroups.renameTitle}>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(target);
        }}
      >
        <p className="text-sm text-slate-700">{ko.scenarioGroups.renameText(name)}</p>
        <GroupField
          id="rename-group-field"
          value={draft}
          onChange={setDraft}
          names={Object.keys(counts).filter((n) => n !== name)}
          placeholder=""
        />
        {merges && (
          <p className="text-sm text-amber-700">
            {ko.scenarioGroups.mergeHint(counts[name] ?? 0, counts[target])}
          </p>
        )}
        {error != null && (
          <p role="alert" className="text-sm text-red-600">
            {ko.scenarioGroups.failed(error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
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
