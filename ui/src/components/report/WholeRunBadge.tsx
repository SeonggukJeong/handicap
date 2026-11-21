import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { Badge } from "../ui/Badge";

/** 유지 구간 리포트 안에서 run 전체 값을 보이는 곳의 표지. 제목·라벨의 형제로 둔다. */
export function WholeRunBadge({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center ${className ?? ""}`}>
      <Badge tone="neutral">{ko.report.basis.wholeBadge}</Badge>
      <HelpTip label={ko.report.basis.wholeBadgeHelpLabel}>
        {ko.report.basis.wholeBadgeHelp}
      </HelpTip>
    </span>
  );
}
