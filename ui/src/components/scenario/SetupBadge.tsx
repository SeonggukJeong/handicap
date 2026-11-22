import { ko } from "../../i18n/ko";

export function SetupBadge() {
  return (
    <span className="shrink-0 rounded bg-accent-100 px-1.5 py-px text-[11px] font-semibold text-accent-800">
      {ko.editor.setupBadge}
    </span>
  );
}
