import { useState } from "react";
import { ko } from "../../i18n/ko";
import { Button } from "../Button";
import { GroupDialog } from "./GroupDialog";

export function GroupButton({
  group,
  names,
  pending,
  error,
  onPick,
  onOpenChange,
}: {
  group: string | null;
  names: string[];
  pending?: boolean;
  error?: string | null;
  onPick: (group: string | null) => boolean | Promise<boolean>;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <Button variant="secondary" onClick={() => change(true)}>
        {group != null ? ko.scenarioGroups.chip(group) : ko.scenarioGroups.assign}
      </Button>
      <GroupDialog
        open={open}
        title={ko.scenarioGroups.assign}
        text={ko.scenarioGroups.assignOneText}
        initial={group}
        names={names}
        pending={pending}
        error={error}
        onSubmit={(g) => {
          void Promise.resolve(onPick(g)).then((ok) => {
            if (ok) change(false);
          });
        }}
        onClose={() => change(false)}
      />
    </>
  );
}
