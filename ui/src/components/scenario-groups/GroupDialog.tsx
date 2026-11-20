import { useEffect, useState } from "react";
import { ko } from "../../i18n/ko";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { validateGroupName } from "../../scenario/grouping";
import { GroupField } from "./GroupField";

export function GroupDialog({
  open,
  title,
  text,
  initial,
  names,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  text: string;
  initial: string | null;
  names: string[];
  pending?: boolean;
  error?: string | null;
  onSubmit: (group: string | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial ?? "");
  useEffect(() => {
    if (open) setDraft(initial ?? "");
  }, [open, initial]);

  const check = validateGroupName(draft);
  const submit = () => {
    if (check.ok && !pending) onSubmit(check.value);
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="text-sm text-slate-700">{text}</p>
        <GroupField id="group-dialog-field" value={draft} onChange={setDraft} names={names} />
        {error != null && (
          <p role="alert" className="text-sm text-red-600">
            {ko.scenarioGroups.failed(error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {ko.common.cancel}
          </Button>
          <Button type="submit" disabled={!check.ok || pending}>
            {ko.scenarioGroups.apply}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
