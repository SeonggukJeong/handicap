import { useEffect, useId, useRef, useState } from "react";
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
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(initial ?? "");
  }
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // 자식 Modal의 effect(패널 포커스·닫을 때 되돌릴 곳 기억)가 먼저 돈 뒤 입력칸으로 옮긴다.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const check = validateGroupName(draft);
  const submit = () => {
    if (check.ok && !pending) onSubmit(check.value);
  };

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" dismissible={!pending}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="mb-3 text-sm text-slate-600">{text}</p>
        <GroupField
          id={fieldId}
          value={draft}
          onChange={setDraft}
          names={names}
          inputRef={inputRef}
          failure={error}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
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
