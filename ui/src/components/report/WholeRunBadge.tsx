import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { Badge } from "../ui/Badge";

/** 유지 구간 리포트 안에서 run 전체 값을 보이는 곳의 표지. 제목·라벨의 형제로 둔다. */
export function WholeRunBadge({
  className,
  help,
}: {
  className?: string;
  /** 표지 옆 도움말을 바꿀 때(run 상세 위쪽 카드). 없으면 리포트 표의 기본 설명. */
  help?: { label: string; text: string };
}) {
  return (
    <span className={`inline-flex items-center ${className ?? ""}`}>
      <Badge tone="neutral">{ko.report.basis.wholeBadge}</Badge>
      <HelpTip label={help?.label ?? ko.report.basis.wholeBadgeHelpLabel}>
        {help?.text ?? ko.report.basis.wholeBadgeHelp}
      </HelpTip>
    </span>
  );
}
