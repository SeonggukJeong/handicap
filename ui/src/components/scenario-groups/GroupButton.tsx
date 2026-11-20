import { useState } from "react";
import { ko } from "../../i18n/ko";
import { GroupDialog } from "./GroupDialog";

const CHIP =
  "inline-flex max-w-[16rem] shrink-0 items-center rounded-full border px-2.5 py-[3px] text-sm " +
  "transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40";
const CHIP_SET = "border-slate-300 bg-white text-slate-900";
const CHIP_NONE = "border-dashed border-slate-300 bg-white text-slate-500";

/** 편집·새 시나리오 머리 줄의 그룹 칩. 그룹이 없으면 점선·흐린 「그룹 지정」. 긴 이름은 말줄임 + title. */
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
      <button
        type="button"
        title={group ?? undefined}
        onClick={() => change(true)}
        className={`${CHIP} ${group != null ? CHIP_SET : CHIP_NONE}`}
      >
        <span className="truncate">
          {group != null ? ko.scenarioGroups.chip(group) : ko.scenarioGroups.assign}
        </span>
      </button>
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
